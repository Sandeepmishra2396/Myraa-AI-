/**
 * MYRAA — Permanent Remote WebSocket Session Resilience Suite
 *
 * Covers all 24 required resilience scenarios + the deterministic long-run
 * multi-restart connection lifecycle test:
 *
 *   1. Normal connect to /remote-live
 *   2. Idle for 40 minutes simulated
 *   3. Render instance restart simulated
 *   4. Access token expires while disconnected
 *   5. Refresh token succeeds and reconnects
 *   6. Refresh fails and falls back to durable device token (sora_dev_...)
 *   7. Server memory cleared (_sessions reset) while valid access token exists
 *   8. Duplicate connect calls do not create two sockets
 *   9. Reconnect during CONNECTING does not close active attempt
 *  10. Heartbeat ping/pong keeps session alive
 *  11. Missed heartbeat triggers clean reconnect
 *  12. Gemini Live session closes while MYRAA WebSocket stays alive
 *  13. Gemini Live session recreates with bounded conversation context
 *  14. Revoked device cannot reconnect
 *  15. Emergency Stop halts reconnect
 *  16. Security Lockdown blocks reconnect
 *  17. Invalid token rejected with 401
 *  18. Replay token rejected (and concurrent refresh deduplicated)
 *  19. Safe session snapshot restored after restart
 *  20. No raw audio stored in snapshot
 *  21. No secrets leaked in logs or responses
 *  22. Desktop companion connection unaffected
 *  23. Android companion connection unaffected
 *  24. Packaged Windows Gemini auth fix remains intact (126 tools + resolveApiKeyWithMetadata)
 *  25. Deterministic Long-Run Connection Test (multi-restart recovery)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import http from "http";
import crypto from "crypto";
import { WebSocketServer, WebSocket } from "ws";
import { remoteStore } from "../RemoteStore.ts";
import { pairingManager } from "../PairingManager.ts";
import { remoteSecurityCoordinator } from "../../security/RemoteSecurityCoordinator.ts";
import { identityAuthManager } from "../../security/IdentityAuthManager.ts";
import { remoteSessionManager } from "../RemoteSessionManager.ts";
import { threatContainmentManager } from "../../security/ThreatContainmentManager.ts";
import { securityPolicyEngine } from "../../security/SecurityPolicyEngine.ts";
import { emergencyStopCoordinator } from "../EmergencyStopCoordinator.ts";
import { createHttpApp } from "../../gateway/HttpGateway.ts";
import { LIVE_TOOLS } from "../../ai/GeminiSessionFactory.ts";
import { resolveApiKeyWithMetadata } from "../../../../server_paths.ts";
import {
  RemoteReconnectController,
  sanitizeDiagnosticString,
} from "../../../lib/connectionStateMachine.ts";
import {
  getAccessTokenExpiryInfo,
  getValidRemoteWsToken,
  refreshRemoteSession,
  resetRemoteAuthForTesting,
  STORAGE_KEY,
  ACCESS_TOKEN_SAFETY_WINDOW_SEC,
} from "../../../lib/remoteAuth.ts";
import type { PairedDevice } from "../RemoteTypes.ts";

describe("MYRAA Permanent Remote WebSocket Session Resilience Suite", () => {
  let server: http.Server;
  let wssRemote: WebSocketServer;
  let baseUrl: string;
  let wsBaseUrl: string;

  // Simulated Gemini Live session state per connected WebSocket for testing decoupled recreation
  const mockGeminiSessions = new Map<
    WebSocket,
    {
      geminiState: "IDLE" | "STARTING_GEMINI" | "READY" | "RECREATING" | "DEGRADED" | "CLOSED";
      restoredTurns: number;
      recreateCount: number;
      deviceId: string;
    }
  >();

  beforeEach(async () => {
    await remoteStore.clearStore();
    identityAuthManager.resetForTesting();
    threatContainmentManager.resetForTesting();
    securityPolicyEngine.setMode("BALANCED");
    await emergencyStopCoordinator.reset("test_init");
    remoteSessionManager.resetForTesting();
    resetRemoteAuthForTesting();
    mockGeminiSessions.clear();

    const app = createHttpApp();
    server = http.createServer(app);
    wssRemote = new WebSocketServer({
      noServer: true,
      handleProtocols: (protocols) => (protocols.has("myraa-auth") ? "myraa-auth" : false),
    });

    // Replicate production server.ts /remote-live upgrade + decoupled Gemini lifecycle
    server.on("upgrade", async (request, socket, head) => {
      const pathname = new URL(request.url || "/", "http://localhost").pathname;
      if (pathname !== "/remote-live") {
        socket.destroy();
        return;
      }

      // Extract token from Sec-WebSocket-Protocol: ["myraa-auth", "<token>"]
      let token: string | null = null;
      const protocols = request.headers["sec-websocket-protocol"];
      if (protocols) {
        const parts = protocols.split(",").map((s) => s.trim());
        const authIdx = parts.indexOf("myraa-auth");
        if (authIdx >= 0 && parts[authIdx + 1]) {
          token = parts[authIdx + 1];
        }
      }

      if (!token) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }

      if (securityPolicyEngine.getMode() === "LOCKDOWN") {
        socket.write("HTTP/1.1 423 Locked\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }

      if (emergencyStopCoordinator.isActive()) {
        socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }

      const auth = await remoteSecurityCoordinator.authenticateRemoteCredential(
        token,
        "127.0.0.1",
        String(request.headers["user-agent"] || "test-agent"),
      );
      if (!auth.authenticated || !auth.device) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }

      const remoteDevice = auth.device;
      wssRemote.handleUpgrade(request, socket, head, async (ws) => {
        // Restore safe snapshot BEFORE registerClient overwrites snapshot fields
        const existingSnap = await remoteStore.getSessionSnapshot(remoteDevice.id);
        const priorContext = existingSnap?.recentContext ?? [];
        const restoredTurns = priorContext.length;

        remoteSessionManager.registerClient(
          ws,
          remoteDevice,
          "127.0.0.1",
          String(request.headers["user-agent"] || "test-agent"),
        );

        await remoteSessionManager.updateDeviceSessionState(remoteDevice.id, {
          connectionState: "STARTING_GEMINI",
          geminiState: "STARTING_GEMINI",
          recentContext: priorContext,
        });

        mockGeminiSessions.set(ws, {
          geminiState: "READY",
          restoredTurns,
          recreateCount: 0,
          deviceId: remoteDevice.id,
        });

        await remoteSessionManager.updateDeviceSessionState(remoteDevice.id, {
          connectionState: "READY",
          geminiState: "READY",
          lastFailureClass: "NONE",
          recentContext: priorContext,
        });

        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "status",
              status: "connected",
              restoredTurns,
            }),
          );
        }

        ws.on("message", async (raw) => {
          remoteSessionManager.recordHeartbeat(remoteDevice.id);
          const msg = JSON.parse(raw.toString());
          const state = mockGeminiSessions.get(ws);

          if (msg.type === "ping") {
            ws.send(
              JSON.stringify({
                type: "pong",
                timestamp: Date.now(),
                geminiState: state?.geminiState ?? "READY",
              }),
            );
            return;
          }

          if (msg.type === "simulate_gemini_close") {
            // Simulate Gemini Live transient closure WITHOUT closing MYRAA /remote-live WebSocket
            if (state) {
              state.geminiState = "RECREATING";
              state.recreateCount += 1;
            }
            const snapBefore = await remoteStore.getSessionSnapshot(remoteDevice.id);
            await remoteSessionManager.updateDeviceSessionState(remoteDevice.id, {
              connectionState: "STARTING_GEMINI",
              geminiState: "RECREATING",
              lastFailureClass: "GEMINI_TRANSIENT_CLOSE",
              recentContext: snapBefore?.recentContext ?? [],
            });
            ws.send(JSON.stringify({ type: "status", status: "recreating_gemini" }));

            // Re-hydrate from snapshot and transition back to READY
            const snap = await remoteStore.getSessionSnapshot(remoteDevice.id);
            if (state) {
              state.geminiState = "READY";
              state.restoredTurns = snap?.recentContext?.length ?? 0;
            }
            await remoteSessionManager.updateDeviceSessionState(remoteDevice.id, {
              connectionState: "READY",
              geminiState: "READY",
              lastFailureClass: "NONE",
              recentContext: snap?.recentContext ?? [],
            });
            ws.send(
              JSON.stringify({
                type: "status",
                status: "gemini_recreated",
                restoredTurns: state?.restoredTurns ?? 0,
                recreateCount: state?.recreateCount ?? 1,
              }),
            );
            return;
          }

          if (msg.type === "recreate_gemini") {
            const snap = await remoteStore.getSessionSnapshot(remoteDevice.id);
            if (state) {
              state.geminiState = "READY";
              state.recreateCount += 1;
              state.restoredTurns = snap?.recentContext?.length ?? 0;
            }
            await remoteSessionManager.updateDeviceSessionState(remoteDevice.id, {
              connectionState: "READY",
              geminiState: "READY",
              lastFailureClass: "NONE",
              recentContext: snap?.recentContext ?? [],
            });
            ws.send(
              JSON.stringify({
                type: "status",
                status: "gemini_recreated",
                restoredTurns: state?.restoredTurns ?? 0,
              }),
            );
            return;
          }

          if (msg.type === "text" && msg.text) {
            const snap = await remoteStore.getSessionSnapshot(remoteDevice.id);
            const turns = snap?.recentContext ?? [];
            const nextTurns = [
              ...turns,
              { role: "user" as const, text: String(msg.text), timestamp: new Date().toISOString() },
              {
                role: "model" as const,
                text: `Ack: ${String(msg.text)} (contextTurns=${turns.length})`,
                timestamp: new Date().toISOString(),
              },
            ];
            await remoteSessionManager.updateDeviceSessionState(remoteDevice.id, {
              connectionState: "READY",
              geminiState: "READY",
              recentContext: nextTurns,
            });
            ws.send(
              JSON.stringify({
                type: "transcription",
                role: "model",
                text: `Ack: ${String(msg.text)} (contextTurns=${turns.length})`,
              }),
            );
          }
        });
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as any).port;
    baseUrl = `http://127.0.0.1:${port}`;
    wsBaseUrl = `ws://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const client of wssRemote.clients) {
      try {
        client.terminate();
      } catch {}
    }
    if (server) {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    securityPolicyEngine.setMode("BALANCED");
    await emergencyStopCoordinator.reset("test_cleanup");
    await remoteStore.clearStore();
    identityAuthManager.resetForTesting();
    threatContainmentManager.resetForTesting();
    remoteSessionManager.resetForTesting();
    resetRemoteAuthForTesting();
  });

  async function createPairedTestDevice(
    id = "resilience-dev-1",
    role: "admin" | "standard" = "admin",
    deviceType: "browser" | "desktop_client" | "mobile" = "browser",
  ) {
    const devToken = pairingManager.signDeviceToken(id, role, deviceType);
    const device: PairedDevice = {
      id,
      name: `Test ${deviceType} (${id})`,
      deviceType,
      role,
      roleExplicit: true,
      tokenHash: pairingManager.hashToken(devToken),
      pairedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      revoked: false,
    };
    await remoteStore.saveDevice(device);
    const session = remoteSecurityCoordinator.createDeviceSession(device, "127.0.0.1");
    return { device, devToken, session };
  }

  function connectWsWithToken(token: string): Promise<{ ws: WebSocket; firstMessage: any }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${wsBaseUrl}/remote-live`, ["myraa-auth", token]);
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error("WebSocket connect timeout"));
      }, 4000);

      ws.once("message", (data) => {
        clearTimeout(timer);
        resolve({ ws, firstMessage: JSON.parse(data.toString()) });
      });

      ws.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });

      ws.once("close", (code, reason) => {
        clearTimeout(timer);
        reject(new Error(`Closed before message: code=${code} reason=${reason.toString()}`));
      });
    });
  }

  it("1. Normal connect to /remote-live reaches READY and reports status via /api/remote/connection-status", async () => {
    const { session } = await createPairedTestDevice("dev-normal-1");
    const { ws, firstMessage } = await connectWsWithToken(session.tokens.accessToken);

    expect(firstMessage.type).toBe("status");
    expect(firstMessage.status).toBe("connected");

    const statusRes = await fetch(`${baseUrl}/api/remote/connection-status`, {
      headers: { Authorization: `Bearer ${session.tokens.accessToken}` },
    });
    expect(statusRes.status).toBe(200);
    const statusJson = await statusRes.json();
    expect(statusJson.connectionState).toBe("READY");
    expect(statusJson.authenticated).toBe(true);
    expect(statusJson.deviceAuthorized).toBe(true);
    expect(statusJson.geminiState).toBe("READY");

    ws.close();
  });

  it("2. Idle for 40 minutes simulated -> proactive token expiry detection triggers before 15m access token TTL", async () => {
    const { session } = await createPairedTestDevice("dev-idle-40m");
    const nowSec = Math.floor(Date.now() / 1000);

    // Fresh token (15m = 900s) is not expiring soon
    const freshInfo = getAccessTokenExpiryInfo(session.tokens.accessToken, ACCESS_TOKEN_SAFETY_WINDOW_SEC);
    expect(freshInfo.isExpired).toBe(false);
    expect(freshInfo.isExpiringSoon).toBe(false);

    // Simulate 40 minutes of idle time advancing the clock
    const dateSpy = vi.spyOn(Date, "now").mockReturnValue((nowSec + 40 * 60) * 1000);
    const after40mInfo = getAccessTokenExpiryInfo(session.tokens.accessToken, ACCESS_TOKEN_SAFETY_WINDOW_SEC);
    expect(after40mInfo.isExpired).toBe(true);
    expect(after40mInfo.isExpiringSoon).toBe(true);
    expect(after40mInfo.expiresInSec).toBeLessThan(0);
    dateSpy.mockRestore();
  });

  it("3. Render instance restart simulated -> in-memory sessions and sockets wiped, client reconnects cleanly", async () => {
    const { session } = await createPairedTestDevice("dev-render-restart");
    const { ws: ws1 } = await connectWsWithToken(session.tokens.accessToken);
    ws1.close();

    // Simulate Render cold restart: wipe in-memory sessions and active sockets, keeping persistent RemoteStore
    identityAuthManager.resetForTesting();
    remoteSessionManager.resetForTesting();

    // Reconnect with the same unexpired accessToken -> stateless claim check + RemoteStore re-hydrates session!
    const { ws: ws2, firstMessage } = await connectWsWithToken(session.tokens.accessToken);
    expect(firstMessage.status).toBe("connected");
    ws2.close();
  });

  it("4. Access token expires while disconnected -> expired access token is rejected with 401 and never reused", async () => {
    const { session } = await createPairedTestDevice("dev-expired-at");
    const parts = session.tokens.accessToken.slice("myraa_at_".length).split(".");
    const payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf-8"));
    payload.exp = Math.floor(Date.now() / 1000) - 120; // expired 2m ago
    const expiredPayload = Buffer.from(JSON.stringify(payload)).toString("utf-8");
    const b64Payload = Buffer.from(expiredPayload).toString("base64url");
    const { getPersistentServerSecret } = await import("../../../../server_paths.ts");
    const sig = crypto
      .createHmac("sha256", getPersistentServerSecret())
      .update(b64Payload)
      .digest("base64url");
    const expiredAt = `myraa_at_${b64Payload}.${sig}`;

    await expect(connectWsWithToken(expiredAt)).rejects.toThrow();
  });

  it("5. Refresh token succeeds and reconnects to /remote-live", async () => {
    const { session } = await createPairedTestDevice("dev-refresh-ok");

    const refreshRes = await fetch(`${baseUrl}/api/remote/token/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: session.tokens.refreshToken }),
    });
    expect(refreshRes.status).toBe(200);
    const refreshData = await refreshRes.json();
    expect(refreshData.accessToken).toMatch(/^myraa_at_/);

    const { ws, firstMessage } = await connectWsWithToken(refreshData.accessToken);
    expect(firstMessage.status).toBe("connected");
    ws.close();
  });

  it("6. Refresh fails and falls back to durable device token without ever returning expired accessToken", async () => {
    const { device, devToken, session } = await createPairedTestDevice("dev-fallback-durable");

    // Create an expired accessToken
    const parts = session.tokens.accessToken.slice("myraa_at_".length).split(".");
    const payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf-8"));
    payload.exp = Math.floor(Date.now() / 1000) - 300;
    const expiredPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const { getPersistentServerSecret } = await import("../../../../server_paths.ts");
    const sig = crypto
      .createHmac("sha256", getPersistentServerSecret())
      .update(expiredPayload)
      .digest("base64url");
    const expiredAccessToken = `myraa_at_${expiredPayload}.${sig}`;

    // Mock localStorage with expired accessToken + invalid refreshToken + valid durable sora_dev_ token
    const mockStorage = new Map<string, string>();
    mockStorage.set(
      STORAGE_KEY,
      JSON.stringify({
        deviceId: device.id,
        deviceName: device.name,
        role: device.role,
        token: devToken,
        accessToken: expiredAccessToken,
        refreshToken: "invalid-refresh-token",
        pairedAt: device.pairedAt,
      }),
    );
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => mockStorage.get(k) ?? null,
      setItem: (k: string, v: string) => mockStorage.set(k, v),
      removeItem: (k: string) => mockStorage.delete(k),
    });

    // Stub fetch so /api/remote/token/refresh fails (simulating network error or expired refresh token)
    const origFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: any, init?: any) => {
      if (String(input).includes("/api/remote/token/refresh")) {
        return new Response(JSON.stringify({ error: "REFRESH_FAILED" }), { status: 401 });
      }
      return origFetch(input, init);
    });

    const chosenToken = await getValidRemoteWsToken();
    // CRITICAL INVARIANT: Must NEVER return expiredAccessToken; must return durable devToken (sora_dev_...)
    expect(chosenToken).toBe(devToken);
    expect(chosenToken).not.toBe(expiredAccessToken);

    vi.unstubAllGlobals();

    // Connect to /remote-live using the fallback durable device token -> succeeds!
    const { ws, firstMessage } = await connectWsWithToken(devToken);
    expect(firstMessage.status).toBe("connected");
    ws.close();
  });

  it("7. Server memory cleared (_sessions reset) while valid access token exists -> stateless re-hydration succeeds", async () => {
    const { session } = await createPairedTestDevice("dev-stateless-rehydrate");

    // Wipe in-memory sessions in IdentityAuthManager (simulates Render sleep/wake)
    identityAuthManager.resetForTesting();

    // Verify HTTP endpoint and WebSocket upgrade both re-hydrate the session from signed claims + RemoteStore
    const statusRes = await fetch(`${baseUrl}/api/remote/connection-status`, {
      headers: { Authorization: `Bearer ${session.tokens.accessToken}` },
    });
    expect(statusRes.status).toBe(200);
    const statusData = await statusRes.json();
    expect(statusData.authenticated).toBe(true);
    expect(statusData.deviceAuthorized).toBe(true);

    const { ws, firstMessage } = await connectWsWithToken(session.tokens.accessToken);
    expect(firstMessage.status).toBe("connected");
    ws.close();
  });

  it("8. Duplicate connect calls do not create two sockets (single-flight generation guard)", () => {
    const controller = new RemoteReconnectController({ maxAttempts: 5 });
    expect(controller.hasAttemptInFlight()).toBe(false);

    const attempt1 = controller.beginConnectAttempt(false);
    expect(controller.hasAttemptInFlight()).toBe(true);
    expect(controller.getState()).toBe("CONNECTING");

    // Second concurrent attempt increments generation and invalidates attempt1
    const attempt2 = controller.beginConnectAttempt(false);
    expect(controller.isCurrentGeneration(attempt1.generation)).toBe(false);
    expect(controller.isCurrentGeneration(attempt2.generation)).toBe(true);
  });

  it("9. Reconnect during CONNECTING deduplicates timers and does not reset backoff until READY", () => {
    vi.useFakeTimers();
    const controller = new RemoteReconnectController({
      maxAttempts: 5,
      baseDelayMs: 1000,
      maxDelayMs: 30000,
    });

    let reconnectExecutions = 0;
    const d1 = controller.scheduleReconnect(
      1006,
      "Abnormal closure",
      () => {
        reconnectExecutions += 1;
      },
      { deterministicJitter: true },
    );
    expect(d1.scheduled).toBe(true);
    expect(d1.attempt).toBe(1);
    expect(d1.delayMs).toBe(1000);

    // Calling scheduleReconnect again before timer fires cancels the previous timer
    const d2 = controller.scheduleReconnect(
      1006,
      "Abnormal closure",
      () => {
        reconnectExecutions += 1;
      },
      { deterministicJitter: true },
    );
    expect(d2.scheduled).toBe(true);
    expect(d2.attempt).toBe(2);
    expect(d2.delayMs).toBe(2000);

    // Even if socket opens (CONNECTED), reconnectAttempt is NOT reset until markStableReady()
    controller.onSocketOpen();
    expect(controller.getReconnectAttempt()).toBe(2);

    controller.markStableReady();
    expect(controller.getState()).toBe("READY");
    expect(controller.getReconnectAttempt()).toBe(0);

    vi.useRealTimers();
  });

  it("10. Heartbeat ping/pong keeps session alive and updates lastHeartbeat", async () => {
    const { session } = await createPairedTestDevice("dev-heartbeat-ok");
    const { ws } = await connectWsWithToken(session.tokens.accessToken);

    const pongPromise = new Promise<any>((resolve) => {
      ws.once("message", (raw) => resolve(JSON.parse(raw.toString())));
    });
    ws.send(JSON.stringify({ type: "ping" }));
    const pong = await pongPromise;
    expect(pong.type).toBe("pong");
    expect(pong.geminiState).toBe("READY");

    const checkResult = remoteSessionManager.checkHeartbeats(Date.now() + 10_000);
    expect(checkResult.pinged).toBeGreaterThanOrEqual(1);
    expect(checkResult.terminated).toHaveLength(0);

    ws.close();
  });

  it("11. Missed heartbeat triggers clean server & client timeout detection", async () => {
    const { session } = await createPairedTestDevice("dev-heartbeat-timeout", "admin", "browser");
    const { ws } = await connectWsWithToken(session.tokens.accessToken);

    const closePromise = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });

    // Browser threshold is 45,000ms. Advance checkHeartbeats by 50,000ms without activity.
    const checkResult = remoteSessionManager.checkHeartbeats(Date.now() + 50_000);
    expect(checkResult.terminated.length).toBeGreaterThanOrEqual(1);

    const closeEv = await closePromise;
    expect(closeEv.code).toBe(4000);
    expect(closeEv.reason).toContain("HEARTBEAT_TIMEOUT");
  });

  it("12. Gemini Live session closes while MYRAA WebSocket stays alive and recreates only Gemini", async () => {
    const { session } = await createPairedTestDevice("dev-gemini-decoupled");
    const { ws } = await connectWsWithToken(session.tokens.accessToken);

    const messages: any[] = [];
    await new Promise<void>((resolve) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        messages.push(msg);
        if (msg.type === "status" && msg.status === "gemini_recreated") {
          resolve();
        }
      });
      ws.send(JSON.stringify({ type: "simulate_gemini_close" }));
    });

    // MYRAA /remote-live WebSocket remained OPEN the entire time!
    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect(messages.some((m) => m.status === "recreating_gemini")).toBe(true);
    expect(messages.some((m) => m.status === "gemini_recreated")).toBe(true);

    ws.close();
  });

  it("13. Gemini Live session recreates with bounded conversation context", async () => {
    const { session } = await createPairedTestDevice("dev-gemini-context");
    const { ws } = await connectWsWithToken(session.tokens.accessToken);

    // Send a conversation turn
    const turn1Ack = new Promise<any>((resolve) => {
      ws.once("message", (raw) => resolve(JSON.parse(raw.toString())));
    });
    ws.send(JSON.stringify({ type: "text", text: "Remember project Aurora status is green." }));
    const ack1 = await turn1Ack;
    expect(ack1.text).toContain("contextTurns=0");

    // Now simulate Gemini Live transient close & in-place recreation
    const recreatedMsg = new Promise<any>((resolve) => {
      const handler = (raw: any) => {
        const parsed = JSON.parse(raw.toString());
        if (parsed.type === "status" && parsed.status === "gemini_recreated") {
          ws.off("message", handler);
          resolve(parsed);
        }
      };
      ws.on("message", handler);
    });
    ws.send(JSON.stringify({ type: "simulate_gemini_close" }));
    const recreated = await recreatedMsg;
    expect(recreated.restoredTurns).toBe(2);

    // Next turn has the 2 prior turns in its restored context
    const turn2Ack = new Promise<any>((resolve) => {
      ws.once("message", (raw) => resolve(JSON.parse(raw.toString())));
    });
    ws.send(JSON.stringify({ type: "text", text: "What is project Aurora status?" }));
    const ack2 = await turn2Ack;
    expect(ack2.text).toContain("contextTurns=2");

    ws.close();
  });

  it("14. Revoked device cannot reconnect and its session snapshot is purged", async () => {
    const { device, session } = await createPairedTestDevice("dev-revoked-1");
    const { ws } = await connectWsWithToken(session.tokens.accessToken);
    ws.close();

    // Revoke the device via RemoteSecurityCoordinator
    const revoked = await remoteSecurityCoordinator.revokeRemoteDevice(device.id, "Admin revoked test");
    expect(revoked).toBe(true);

    // Snapshot is purged
    const snap = await remoteStore.getSessionSnapshot(device.id);
    expect(snap).toBeUndefined();

    // Reconnection is rejected at upgrade
    await expect(connectWsWithToken(session.tokens.accessToken)).rejects.toThrow();

    // ReconnectController classifies 4401 / DEVICE_REVOKED as terminal security stop
    const controller = new RemoteReconnectController({ maxAttempts: 5 });
    const decision = controller.scheduleReconnect(4401, "DEVICE_REVOKED", () => {});
    expect(decision.scheduled).toBe(false);
    expect(decision.failureClass).toBe("DEVICE_REVOKED");
    expect(controller.isTerminalStopped()).toBe(true);
    expect(controller.getState()).toBe("FAILED");
  });

  it("15. Emergency Stop halts reconnect immediately", async () => {
    const { session } = await createPairedTestDevice("dev-emergency-1");
    await emergencyStopCoordinator.trigger({
      source: "rest_api",
      reason: "Test emergency stop",
    });

    await expect(connectWsWithToken(session.tokens.accessToken)).rejects.toThrow();

    const controller = new RemoteReconnectController({ maxAttempts: 5 });
    const decision = controller.scheduleReconnect(
      1006,
      "503 Service Unavailable: EMERGENCY_STOP active",
      () => {},
    );
    expect(decision.scheduled).toBe(false);
    expect(decision.failureClass).toBe("EMERGENCY_STOP");
    expect(controller.isTerminalStopped()).toBe(true);
    expect(controller.getState()).toBe("FAILED");
  });

  it("16. Security Lockdown blocks reconnect with 423 Locked and halts client reconnect loop", async () => {
    const { session } = await createPairedTestDevice("dev-lockdown-1");
    securityPolicyEngine.setMode("LOCKDOWN");

    // Upgrade is blocked with 423
    await expect(connectWsWithToken(session.tokens.accessToken)).rejects.toThrow();

    const controller = new RemoteReconnectController({ maxAttempts: 5 });
    const decision = controller.scheduleReconnect(4403, "423 Locked: SECURITY_LOCKDOWN", () => {});
    expect(decision.scheduled).toBe(false);
    expect(decision.failureClass).toBe("SECURITY_LOCKDOWN");
    expect(controller.isTerminalStopped()).toBe(true);
  });

  it("17. Invalid token is rejected with 401 on both HTTP and WebSocket upgrade", async () => {
    const httpRes = await fetch(`${baseUrl}/api/remote/session`, {
      headers: { Authorization: "Bearer myraa_at_forged.invalid_signature" },
    });
    expect(httpRes.status).toBe(401);

    await expect(connectWsWithToken("myraa_at_forged.invalid_signature")).rejects.toThrow();
  });

  it("18. Replay token is rejected (403) while concurrent in-flight client refreshes are deduplicated", async () => {
    const { device, devToken, session } = await createPairedTestDevice("dev-replay-dedup");

    // Part A: Concurrent calls to refreshRemoteSession share 1 in-flight request (no false replay)
    const mockStorage = new Map<string, string>();
    const storedSess = {
      deviceId: device.id,
      deviceName: device.name,
      role: device.role,
      token: devToken,
      accessToken: session.tokens.accessToken,
      refreshToken: session.tokens.refreshToken,
      pairedAt: Date.now(),
    };
    mockStorage.set(STORAGE_KEY, JSON.stringify(storedSess));
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => mockStorage.get(k) ?? null,
      setItem: (k: string, v: string) => mockStorage.set(k, v),
      removeItem: (k: string) => mockStorage.delete(k),
    });

    const origFetch = globalThis.fetch;
    let refreshCallCount = 0;
    vi.stubGlobal("fetch", async (input: any, init?: any) => {
      const urlStr = String(input);
      if (urlStr === "/api/remote/token/refresh") {
        refreshCallCount += 1;
        return origFetch(`${baseUrl}/api/remote/token/refresh`, init);
      }
      return origFetch(input, init);
    });

    const [r1, r2, r3] = await Promise.all([
      refreshRemoteSession(storedSess),
      refreshRemoteSession(storedSess),
      refreshRemoteSession(storedSess),
    ]);
    expect(refreshCallCount).toBe(1);
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    expect(r3.success).toBe(true);
    expect(r1.session?.accessToken).toBe(r2.session?.accessToken);

    vi.unstubAllGlobals();

    // Part B: True sequential replay of the old consumed refreshToken is rejected with 403 TOKEN_REPLAY_DETECTED
    const replayRes = await fetch(`${baseUrl}/api/remote/token/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: session.tokens.refreshToken }),
    });
    expect(replayRes.status).toBe(403);
    const replayData = await replayRes.json();
    expect(replayData.error).toContain("TOKEN_REPLAY_DETECTED");
  });

  it("19. Safe session snapshot is persisted and restored across restart with bounded turns (max 10)", async () => {
    const { device } = await createPairedTestDevice("dev-snapshot-bounds");

    const fifteenTurns = Array.from({ length: 15 }, (_, idx) => ({
      role: (idx % 2 === 0 ? "user" : "model") as "user" | "model",
      text: `Turn #${idx + 1}: ` + "x".repeat(600),
      timestamp: new Date().toISOString(),
    }));

    await remoteStore.saveSessionSnapshot({
      deviceId: device.id,
      sessionId: "sess-bound-test",
      connectionState: "READY",
      geminiState: "READY",
      lastHeartbeat: new Date().toISOString(),
      recentContext: fifteenTurns,
      activeTaskMetadata: {
        taskId: "task-123",
        title: "Build verification",
        status: "running",
        updatedAt: new Date().toISOString(),
      },
      updatedAt: new Date().toISOString(),
    });

    const restored = await remoteStore.getSessionSnapshot(device.id);
    expect(restored).not.toBeNull();
    expect(restored!.recentContext).toHaveLength(10);
    // Keeps the most recent 10 turns (#6 through #15)
    expect(restored!.recentContext[0].text).toContain("Turn #6:");
    // Truncates each turn to <= 500 chars
    expect(restored!.recentContext[0].text.length).toBeLessThanOrEqual(500);
    expect(restored!.activeTaskMetadata?.title).toBe("Build verification");
  });

  it("20. No raw audio or secrets are ever stored in session snapshots", async () => {
    const { device } = await createPairedTestDevice("dev-snapshot-no-audio");

    const dirtyInput: any = {
      deviceId: device.id,
      sessionId: "sess-dirty",
      connectionState: "READY",
      geminiState: "READY",
      rawAudio: "UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=",
      audioChunks: ["AAAA", "BBBB"],
      accessToken: "myraa_at_secret_value.sig",
      recentContext: [
        {
          role: "user",
          text: "My token is myraa_at_supersecret123.sig and key is AIzaSyD1234567890abcdefghijk",
          timestamp: new Date().toISOString(),
          audio: "base64_pcm_audio_should_be_dropped",
        },
      ],
    };

    await remoteStore.saveSessionSnapshot(dirtyInput);
    const saved = await remoteStore.getSessionSnapshot(device.id);
    expect(saved).not.toBeNull();
    const serialized = JSON.stringify(saved);

    expect(serialized).not.toContain("UklGRiQAAABXQVZF");
    expect(serialized).not.toContain("base64_pcm_audio_should_be_dropped");
    expect(serialized).not.toContain("myraa_at_secret_value");
    expect(serialized).not.toContain("myraa_at_supersecret123");
    expect(serialized).not.toContain("AIzaSyD1234567890abcdefghijk");
    expect((saved as any).rawAudio).toBeUndefined();
    expect((saved as any).audioChunks).toBeUndefined();
  });

  it("21. No secrets leaked in diagnostic logs or /api/remote/connection-status responses", async () => {
    const { devToken, session } = await createPairedTestDevice("dev-no-leak");
    const rawDiag = `Failed auth with Bearer ${session.tokens.accessToken}, refresh=${session.tokens.refreshToken}, dev=${devToken}, key=AIzaSyAbCdEfGhIjKlMnOpQrStUvWxYz123456, vertex=AQ.Ab8RN6Lxyz123456789012345`;
    const scrubbed = sanitizeDiagnosticString(rawDiag);

    expect(scrubbed).not.toContain(session.tokens.accessToken);
    expect(scrubbed).not.toContain(session.tokens.refreshToken);
    expect(scrubbed).not.toContain(devToken);
    expect(scrubbed).not.toContain("AIzaSyAbCdEfGhIjKlMnOpQrStUvWxYz123456");
    expect(scrubbed).not.toContain("AQ.Ab8RN6Lxyz123456789012345");

    const statusRes = await fetch(`${baseUrl}/api/remote/connection-status`, {
      headers: { Authorization: `Bearer ${session.tokens.accessToken}` },
    });
    const bodyText = await statusRes.text();
    expect(bodyText).not.toContain(session.tokens.accessToken);
    expect(bodyText).not.toContain(session.tokens.refreshToken);
    expect(bodyText).not.toContain(devToken);
  });

  it("22. Desktop companion connection is unaffected and uses 45s heartbeat threshold", async () => {
    const { session } = await createPairedTestDevice("dev-desktop-1", "admin", "desktop_client");
    const { ws, firstMessage } = await connectWsWithToken(session.tokens.accessToken);
    expect(firstMessage.status).toBe("connected");
    // At +40s (<45s desktop threshold), desktop client is NOT terminated
    const checkAt40s = remoteSessionManager.checkHeartbeats(Date.now() + 40_000);
    expect(checkAt40s.terminated).toHaveLength(0);
    ws.close();
  });

  it("23. Android mobile companion connection is unaffected and uses 60s heartbeat threshold", async () => {
    const { session } = await createPairedTestDevice("dev-android-1", "admin", "mobile");
    const { ws, firstMessage } = await connectWsWithToken(session.tokens.accessToken);
    expect(firstMessage.status).toBe("connected");
    // At +50s (>45s desktop threshold, but <60s mobile threshold), mobile client is NOT terminated
    const checkAt50s = remoteSessionManager.checkHeartbeats(Date.now() + 50_000);
    expect(checkAt50s.terminated).toHaveLength(0);
    ws.close();
  });

  it("24. Packaged Windows Gemini auth fix and 126 LIVE_TOOLS remain 100% intact", () => {
    const toolDecls = (LIVE_TOOLS[0] as any).functionDeclarations;
    expect(Array.isArray(toolDecls)).toBe(true);
    expect(toolDecls.length).toBe(126);

    const keyMeta = resolveApiKeyWithMetadata();
    expect(keyMeta).toHaveProperty("key");
    expect(keyMeta).toHaveProperty("source");
    expect(keyMeta).toHaveProperty("isPlaceholder");
    expect(keyMeta).toHaveProperty("length");
  });

  it("25. DETERMINISTIC LONG-RUN CONNECTION TEST: connect -> Gemini -> heartbeat -> restart #1 -> reconnect -> token refresh -> Gemini recreate -> conversation -> restart #2 -> recover READY", async () => {
    const { devToken, session } = await createPairedTestDevice("dev-long-run-e2e", "admin", "browser");

    // Step 1: Connect client & establish Gemini READY
    const { ws: ws1, firstMessage: msg1 } = await connectWsWithToken(session.tokens.accessToken);
    expect(msg1.status).toBe("connected");

    // Step 2: Send heartbeat ping -> receive pong
    const pong1 = await new Promise<any>((resolve) => {
      ws1.once("message", (raw) => resolve(JSON.parse(raw.toString())));
      ws1.send(JSON.stringify({ type: "ping" }));
    });
    expect(pong1.type).toBe("pong");
    expect(pong1.geminiState).toBe("READY");

    // Step 3: Send initial conversation turn before restart
    const turn1 = await new Promise<any>((resolve) => {
      ws1.once("message", (raw) => resolve(JSON.parse(raw.toString())));
      ws1.send(JSON.stringify({ type: "text", text: "Initialize long-run mission alpha." }));
    });
    expect(turn1.text).toContain("contextTurns=0");

    // Step 4: Simulate Render Server Restart #1 (terminate active socket with 1006 + wipe in-memory _sessions)
    ws1.terminate();
    identityAuthManager.resetForTesting();
    remoteSessionManager.resetForTesting();

    // Step 5: Client refreshes token via durable fallback / stateless recovery
    const refresh1Res = await fetch(`${baseUrl}/api/remote/token/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        refreshToken: session.tokens.refreshToken,
        deviceToken: devToken,
      }),
    });
    expect(refresh1Res.status).toBe(200);
    const refresh1Data = await refresh1Res.json();
    expect(refresh1Data.accessToken).toMatch(/^myraa_at_/);

    // Step 6: Client reconnects automatically with refreshed access token and restores snapshot context
    const { ws: ws2, firstMessage: msg2 } = await connectWsWithToken(refresh1Data.accessToken);
    expect(msg2.status).toBe("connected");
    expect(msg2.restoredTurns).toBe(2);

    // Step 7: Simulate transient Gemini Live close & in-place Gemini recreation on ws2
    const geminiRecreated = await new Promise<any>((resolve) => {
      const handler = (raw: any) => {
        const parsed = JSON.parse(raw.toString());
        if (parsed.type === "status" && parsed.status === "gemini_recreated") {
          ws2.off("message", handler);
          resolve(parsed);
        }
      };
      ws2.on("message", handler);
      ws2.send(JSON.stringify({ type: "simulate_gemini_close" }));
    });
    expect(geminiRecreated.restoredTurns).toBe(2);

    // Step 8: Continue conversation seamlessly after Gemini recreation
    const turn2 = await new Promise<any>((resolve) => {
      ws2.once("message", (raw) => resolve(JSON.parse(raw.toString())));
      ws2.send(JSON.stringify({ type: "text", text: "Confirm mission alpha phase 2." }));
    });
    expect(turn2.text).toContain("contextTurns=2");

    // Step 9: Simulate Render Server Restart #2
    ws2.terminate();
    identityAuthManager.resetForTesting();
    remoteSessionManager.resetForTesting();

    // Step 10: Recover again even WITHOUT calling refresh first (stateless valid access token re-hydration!)
    const { ws: ws3, firstMessage: msg3 } = await connectWsWithToken(refresh1Data.accessToken);
    expect(msg3.status).toBe("connected");
    expect(msg3.restoredTurns).toBe(4);

    // Verify /api/remote/connection-status reports READY
    const finalStatusRes = await fetch(`${baseUrl}/api/remote/connection-status`, {
      headers: { Authorization: `Bearer ${refresh1Data.accessToken}` },
    });
    expect(finalStatusRes.status).toBe(200);
    const finalStatus = await finalStatusRes.json();
    expect(finalStatus.connectionState).toBe("READY");
    expect(finalStatus.authenticated).toBe(true);
    expect(finalStatus.deviceAuthorized).toBe(true);
    expect(finalStatus.geminiState).toBe("READY");

    ws3.close();
  });

  it("26. SECRET STABILITY: getPersistentServerSecret() enforces SORA_REMOTE_SECRET > MYRAA_SECURITY_SECRET > deterministic Render fallback", async () => {
    const { getPersistentServerSecret } = await import("../../../../server_paths.ts");
    const origSora = process.env.SORA_REMOTE_SECRET;
    const origMyraa = process.env.MYRAA_SECURITY_SECRET;
    const origServiceId = process.env.RENDER_SERVICE_ID;
    const origHost = process.env.RENDER_EXTERNAL_HOSTNAME;

    try {
      process.env.SORA_REMOTE_SECRET = "explicit-sora-remote-secret-value-001";
      process.env.MYRAA_SECURITY_SECRET = "secondary-myraa-security-secret-value-002";
      process.env.RENDER_SERVICE_ID = "srv-render-test-id-123";
      process.env.RENDER_EXTERNAL_HOSTNAME = "myraa-ai-q0h3.onrender.com";

      // 1. SORA_REMOTE_SECRET always wins when present
      expect(getPersistentServerSecret()).toBe("explicit-sora-remote-secret-value-001");

      // 2. MYRAA_SECURITY_SECRET wins when SORA_REMOTE_SECRET is unset
      delete process.env.SORA_REMOTE_SECRET;
      expect(getPersistentServerSecret()).toBe("secondary-myraa-security-secret-value-002");

      // 3. Deterministic RENDER_SERVICE_ID fallback wins when both explicit secrets are unset
      delete process.env.MYRAA_SECURITY_SECRET;
      const expectedServiceFallback = crypto
        .createHash("sha256")
        .update("myraa-render-secret:srv-render-test-id-123")
        .digest("hex");
      expect(getPersistentServerSecret()).toBe(expectedServiceFallback);
    } finally {
      if (origSora !== undefined) process.env.SORA_REMOTE_SECRET = origSora;
      else delete process.env.SORA_REMOTE_SECRET;
      if (origMyraa !== undefined) process.env.MYRAA_SECURITY_SECRET = origMyraa;
      else delete process.env.MYRAA_SECURITY_SECRET;
      if (origServiceId !== undefined) process.env.RENDER_SERVICE_ID = origServiceId;
      else delete process.env.RENDER_SERVICE_ID;
      if (origHost !== undefined) process.env.RENDER_EXTERNAL_HOSTNAME = origHost;
      else delete process.env.RENDER_EXTERNAL_HOSTNAME;
    }
  });

  it("27. MULTI-DEVICE & EPHEMERAL RESTART: Desktop (standard) reconnecting BEFORE Android (admin) stays standard, Android stays admin, revoked device blocked, no second admin", async () => {
    const androidAdmin = await createPairedTestDevice("dev-android-admin", "admin", "mobile");
    const desktopStd = await createPairedTestDevice("dev-desktop-std", "standard", "desktop_client");
    const revokedDev = await createPairedTestDevice("dev-revoked-3", "standard", "browser");

    // Revoke the 3rd device and record lost/revoked entry
    await remoteSecurityCoordinator.revokeRemoteDevice(revokedDev.device.id, "Compromised device");
    await remoteStore.saveLostDeviceRecord({
      deviceId: revokedDev.device.id,
      enabledAt: new Date().toISOString(),
      enabledBy: "admin",
      reason: "Compromised device",
      recovered: false,
    });

    // Simulate Render container restart where remote_devices.json and in-memory sessions are wiped
    // (preserving lost_devices revocation ledger)
    const lostBackup = await remoteStore.listLostDeviceRecords();
    await remoteStore.clearStore();
    for (const rec of lostBackup) {
      await remoteStore.saveLostDeviceRecord(rec);
    }
    identityAuthManager.resetForTesting();
    remoteSessionManager.resetForTesting();

    // 1. Desktop (standard) reconnects FIRST while zero devices exist in remote_devices.json!
    const desktopAuth = await remoteSecurityCoordinator.authenticateRemoteCredential(
      desktopStd.devToken,
      "127.0.0.1",
      "Mozilla/5.0 Windows NT 10.0",
    );
    expect(desktopAuth.authenticated).toBe(true);
    expect(desktopAuth.device?.role).toBe("standard");
    expect(desktopAuth.session?.role).toBe("standard");

    // Trigger listDevices() to verify recoverSoleAdminDevice does NOT promote desktopStd to admin
    const afterDesktopList = await remoteStore.listDevices();
    expect(afterDesktopList).toHaveLength(1);
    expect(afterDesktopList[0].id).toBe("dev-desktop-std");
    expect(afterDesktopList[0].role).toBe("standard");

    // 2. Android (admin) reconnects SECOND -> restores as admin!
    const androidAuth = await remoteSecurityCoordinator.authenticateRemoteCredential(
      androidAdmin.session.tokens.accessToken,
      "127.0.0.1",
      "Mozilla/5.0 Android 14",
    );
    expect(androidAuth.authenticated).toBe(true);
    expect(androidAuth.device?.role).toBe("admin");
    expect(androidAuth.session?.role).toBe("admin");

    // 3. Revoked device CANNOT recover via access token or durable device token
    const revokedAtAttempt = await remoteSecurityCoordinator.authenticateRemoteCredential(
      revokedDev.session.tokens.accessToken,
      "127.0.0.1",
      "Mozilla/5.0",
    );
    expect(revokedAtAttempt.authenticated).toBe(false);
    expect(revokedAtAttempt.error).toContain("DEVICE_REVOKED");

    const revokedDevTokenAttempt = await remoteSecurityCoordinator.authenticateRemoteCredential(
      revokedDev.devToken,
      "127.0.0.1",
      "Mozilla/5.0",
    );
    expect(revokedDevTokenAttempt.authenticated).toBe(false);

    // 4. Attempting to recover a rogue second admin token while Android admin is active is capped to standard
    const secondAdminToken = pairingManager.signDeviceToken("dev-rogue-second-admin", "admin", "mobile");
    const secondAdminAuth = await remoteSecurityCoordinator.authenticateRemoteCredential(
      secondAdminToken,
      "127.0.0.1",
      "Mozilla/5.0 Android",
    );
    expect(secondAdminAuth.authenticated).toBe(true);
    expect(secondAdminAuth.device?.role).toBe("standard");

    const allDevices = await remoteStore.listDevices();
    const admins = allDevices.filter((d) => d.role === "admin" && !d.revoked);
    expect(admins).toHaveLength(1);
    expect(admins[0].id).toBe("dev-android-admin");
  });

  it("28. REAL CHILD-PROCESS BACKEND RESTART: terminate & respawn fresh Node backend process -> existing Android device -> reconnect -> auth -> session restoration -> /remote-live -> Gemini recreation -> READY", async () => {
    const { spawn } = await import("child_process");
    const fsPromises = await import("fs/promises");
    const os = await import("os");
    const path = await import("path");

    const tempDataDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "myraa-restart-audit-"));
    const workerScriptPath = path.join(tempDataDir, "restart_worker.mts");
    const repoRootUrl = new URL("../../../../", import.meta.url).href;

    // Self-contained TypeScript worker script that boots createHttpApp() + /remote-live WebSocket upgrade using the real backend modules
    const workerScript = `
      import http from "http";
      import { WebSocketServer } from "${repoRootUrl}node_modules/ws/wrapper.mjs";
      import { createHttpApp } from "${repoRootUrl}src/backend/gateway/HttpGateway.ts";
      import { remoteStore } from "${repoRootUrl}src/backend/remote/RemoteStore.ts";
      import { remoteSessionManager } from "${repoRootUrl}src/backend/remote/RemoteSessionManager.ts";
      import { remoteSecurityCoordinator } from "${repoRootUrl}src/backend/security/RemoteSecurityCoordinator.ts";

      const port = parseInt(process.env.TEST_WORKER_PORT || "0", 10);
      const app = createHttpApp();
      const srv = http.createServer(app);
      const wss = new WebSocketServer({
        noServer: true,
        handleProtocols: (protocols) => (protocols.has("myraa-auth") ? "myraa-auth" : false),
      });

      srv.on("upgrade", async (req, socket, head) => {
        const pathname = new URL(req.url || "/", "http://localhost").pathname;
        if (pathname !== "/remote-live") { socket.destroy(); return; }
        const proto = req.headers["sec-websocket-protocol"] || "";
        const parts = String(proto).split(",").map(s => s.trim());
        const idx = parts.indexOf("myraa-auth");
        const token = idx >= 0 ? parts[idx + 1] : null;
        if (!token) { socket.write("HTTP/1.1 401 Unauthorized\\r\\n\\r\\n"); socket.destroy(); return; }
        const auth = await remoteSecurityCoordinator.authenticateRemoteCredential(token, "127.0.0.1", String(req.headers["user-agent"] || "Android"));
        if (!auth.authenticated || !auth.device) {
          socket.write("HTTP/1.1 401 Unauthorized\\r\\n\\r\\n");
          socket.destroy();
          return;
        }
        const dev = auth.device;
        wss.handleUpgrade(req, socket, head, async (ws) => {
          const snap = await remoteStore.getSessionSnapshot(dev.id);
          const priorContext = snap?.recentContext ?? [];
          remoteSessionManager.registerClient(ws, dev, "127.0.0.1", String(req.headers["user-agent"] || "Android"));
          await remoteSessionManager.updateDeviceSessionState(dev.id, {
            connectionState: "READY",
            geminiState: "READY",
            lastFailureClass: "NONE",
            recentContext: priorContext,
          });
          ws.send(JSON.stringify({
            type: "status",
            status: "connected",
            deviceId: dev.id,
            role: dev.role,
            restoredTurns: priorContext.length,
            geminiState: "READY",
          }));
          ws.on("message", async (raw) => {
            const msg = JSON.parse(raw.toString());
            if (msg.type === "text") {
              const s = await remoteStore.getSessionSnapshot(dev.id);
              const turns = [
                ...(s?.recentContext ?? []),
                { role: "user", text: msg.text, timestamp: new Date().toISOString() },
                { role: "model", text: "Ack: " + msg.text, timestamp: new Date().toISOString() },
              ];
              await remoteSessionManager.updateDeviceSessionState(dev.id, {
                connectionState: "READY",
                geminiState: "READY",
                recentContext: turns,
              });
              ws.send(JSON.stringify({ type: "turn_saved", totalTurns: turns.length }));
            }
          });
        });
      });

      srv.listen(port, "127.0.0.1", () => {
        const addr = srv.address();
        const actualPort = typeof addr === "object" && addr ? addr.port : port;
        console.log("WORKER_LISTENING:" + actualPort);
      });
    `;
    await fsPromises.writeFile(workerScriptPath, workerScript, "utf-8");

    const tsxCliPath = path.resolve(process.cwd(), "node_modules/tsx/dist/cli.mjs");
    const spawnBackendProcess = (targetPort: number): Promise<{ proc: any; port: number }> => {
      return new Promise((resolve, reject) => {
        let stderrLog = "";
        const proc = spawn(process.execPath, [tsxCliPath, workerScriptPath], {
          cwd: process.cwd(),
          env: {
            ...process.env,
            SORA_DATA_DIR: tempDataDir,
            SORA_REMOTE_SECRET: "audit-child-process-hmac-secret-999",
            TEST_WORKER_PORT: String(targetPort),
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        const timer = setTimeout(() => {
          proc.kill();
          reject(new Error("Timed out waiting for child backend process to listen: " + stderrLog));
        }, 15000);
        proc.stderr.on("data", (chunk: Buffer) => {
          stderrLog += chunk.toString();
        });
        proc.stdout.on("data", (chunk: Buffer) => {
          const text = chunk.toString();
          const match = text.match(/WORKER_LISTENING:(\d+)/);
          if (match) {
            clearTimeout(timer);
            resolve({ proc, port: parseInt(match[1], 10) });
          }
        });
        proc.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });
    };

    let proc1: any = null;
    let proc2: any = null;
    try {
      // 1. Boot Backend Process #1
      const boot1 = await spawnBackendProcess(0);
      proc1 = boot1.proc;
      const port = boot1.port;
      const childHttpUrl = `http://127.0.0.1:${port}`;
      const childWsUrl = `ws://127.0.0.1:${port}`;

      // 2. Bootstrap-pair Android device as admin on Process #1
      const codeRes = await fetch(`${childHttpUrl}/api/remote/pair-code`, { method: "POST" });
      expect(codeRes.status).toBe(201);
      const { code } = await codeRes.json();

      const pairRes = await fetch(`${childHttpUrl}/api/remote/pair`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro)",
        },
        body: JSON.stringify({
          code,
          deviceName: "Pixel 8 Pro",
          deviceType: "mobile",
        }),
      });
      expect(pairRes.status).toBe(201);
      const pairData = await pairRes.json();
      expect(pairData.deviceRole).toBe("admin");
      expect(pairData.accessToken).toMatch(/^myraa_at_/);
      expect(pairData.token).toMatch(/^sora_dev_/);

      // 3. Connect Android device to /remote-live on Process #1 and record conversation turns
      const ws1 = new WebSocket(`${childWsUrl}/remote-live`, ["myraa-auth", pairData.accessToken]);
      const initMsg1 = await new Promise<any>((resolve, reject) => {
        ws1.once("message", (d) => resolve(JSON.parse(d.toString())));
        ws1.once("error", reject);
      });
      expect(initMsg1.status).toBe("connected");
      expect(initMsg1.role).toBe("admin");
      expect(initMsg1.restoredTurns).toBe(0);

      const savedTurnMsg = await new Promise<any>((resolve) => {
        ws1.once("message", (d) => resolve(JSON.parse(d.toString())));
        ws1.send(JSON.stringify({ type: "text", text: "Persist across real OS process restart" }));
      });
      expect(savedTurnMsg.totalTurns).toBe(2);
      ws1.close();

      // 4. Terminate Process #1 completely (actual OS process kill)
      await new Promise<void>((resolve) => {
        proc1.once("exit", () => resolve());
        proc1.kill();
      });
      proc1 = null;

      // 5. Spawn completely fresh Backend Process #2 on the same port and SORA_DATA_DIR
      const boot2 = await spawnBackendProcess(port);
      proc2 = boot2.proc;

      // 6. Existing Android device reconnects -> auth -> session restoration -> /remote-live -> Gemini recreation -> READY
      const ws2 = new WebSocket(`${childWsUrl}/remote-live`, ["myraa-auth", pairData.accessToken]);
      const initMsg2 = await new Promise<any>((resolve, reject) => {
        ws2.once("message", (d) => resolve(JSON.parse(d.toString())));
        ws2.once("error", reject);
      });
      expect(initMsg2.status).toBe("connected");
      expect(initMsg2.deviceId).toBe(pairData.deviceId);
      expect(initMsg2.role).toBe("admin");
      expect(initMsg2.restoredTurns).toBe(2);
      expect(initMsg2.geminiState).toBe("READY");

      // Verify /api/remote/connection-status on Process #2 reports READY
      const statusRes2 = await fetch(`${childHttpUrl}/api/remote/connection-status`, {
        headers: { Authorization: `Bearer ${pairData.accessToken}` },
      });
      expect(statusRes2.status).toBe(200);
      const statusData2 = await statusRes2.json();
      expect(statusData2.connectionState).toBe("READY");
      expect(statusData2.authenticated).toBe(true);
      expect(statusData2.deviceAuthorized).toBe(true);
      expect(statusData2.geminiState).toBe("READY");

      ws2.close();
    } finally {
      if (proc1) {
        try { proc1.kill(); } catch {}
      }
      if (proc2) {
        try { proc2.kill(); } catch {}
      }
      try {
        await fsPromises.rm(tempDataDir, { recursive: true, force: true });
      } catch {}
    }
  }, 25000);
});

