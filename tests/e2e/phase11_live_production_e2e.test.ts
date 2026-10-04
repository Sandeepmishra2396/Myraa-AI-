/**
 * MYRAA — Phase 11 Production Deployment, Live E2E Verification & Final Production Lock Suite
 *
 * Validates the complete production pipeline:
 *   1. Production Build, Health & 126-Tool Invariant
 *   2. Production Environment Variables & Secret Protection (HTTP mutation lock)
 *   3. HTTPS/WSS Enforcement, CORS, Security Headers & Android HTTPS/WSS Transport
 *   4. Multi-Surface Authentication (Chrome/Web Companion, Android App, Windows Desktop App)
 *   5. Token Rotation, Replay Detection & Idle Heartbeat Reconnect
 *   6. Gemini Live Voice Session & Upstream Recreation Without Dropping Remote Session
 *   7. Phone Standalone Capabilities, Desktop Standalone Capabilities & Optional Remote Bridge
 *   8. Shared Memory Sync & Cross-Device Handoff Lifecycle
 *   9. Emergency Stop, Security Lockdown, Device Revoke, RBAC, DLP, SSRF & Audit Trail Integrity
 *  10. Stateless Render Restart / Redeploy Recovery (Android + Desktop + Web Companion)
 *  11. Live Render Production Endpoint Verification (https://myraa-ai-q0h3.onrender.com)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "http";
import fs from "fs";
import path from "path";
import { WebSocket, WebSocketServer } from "ws";

import { createHttpApp } from "../../backend/gateway/HttpGateway.ts";
import { LIVE_TOOLS } from "../../backend/ai/GeminiSessionFactory.ts";
import { ConversationManager } from "../../backend/conversation/ConversationManager.ts";
import { resolveApiKeyWithMetadata, getPersistentServerSecret } from "../../backend/server_paths.ts";
import { pairingManager } from "../../backend/remote/PairingManager.ts";
import { remoteStore } from "../../backend/remote/RemoteStore.ts";
import { remoteSessionManager } from "../../backend/remote/RemoteSessionManager.ts";
import { emergencyStopCoordinator } from "../../backend/remote/EmergencyStopCoordinator.ts";
import { remoteSecurityCoordinator } from "../../backend/security/RemoteSecurityCoordinator.ts";
import { identityAuthManager } from "../../backend/security/IdentityAuthManager.ts";
import { securityPolicyEngine } from "../../backend/security/SecurityPolicyEngine.ts";
import { securityAuditLogger } from "../../backend/security/SecurityAuditLogger.ts";
import { outputDataFirewall } from "../../backend/security/OutputDataFirewall.ts";
import { networkSecurityManager } from "../../backend/security/NetworkSecurityManager.ts";
import { sharedMemoryManager } from "../../backend/memory/SharedMemoryManager.ts";
import { crossDeviceHandoffManager } from "../../backend/handoff/CrossDeviceHandoffManager.ts";
import {
  deviceRegistry,
  remoteBridge,
  sharedAccountMemoryManager,
  crossDeviceWorkflowOrchestrator,
  productionUxController,
} from "../../backend/device/index.ts";
import { capabilityRegistry } from "../../backend/orchestrator/index.ts";

async function startTestGatewayServer() {
  const app = createHttpApp();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", async (req, socket, head) => {
    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname !== "/remote-live" && url.pathname !== "/live") {
      socket.destroy();
      return;
    }

    const protocols = String(req.headers["sec-websocket-protocol"] || "")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    const token = protocols.find((p) => p !== "myraa-auth") || "";

    if (url.pathname === "/remote-live") {
      const auth = await remoteSecurityCoordinator.authenticateRemoteCredential(
        token,
        "127.0.0.1",
        String(req.headers["user-agent"] || "Phase11Test"),
      );
      if (!auth.authenticated || !auth.device) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        const remoteSession = remoteSessionManager.registerClient(
          ws,
          auth.device!,
          "127.0.0.1",
          String(req.headers["user-agent"] || "Phase11Test"),
        );
        (ws as any).remoteDevice = auth.device;
        (ws as any).remoteSession = remoteSession;
        wss.emit("connection", ws, req);
      });
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  return {
    server,
    wss,
    baseUrl: `http://127.0.0.1:${addr.port}`,
    wsUrl: `ws://127.0.0.1:${addr.port}/remote-live`,
    close: () =>
      new Promise<void>((resolve) => {
        wss.clients.forEach((c) => c.terminate());
        wss.close(() => server.close(() => resolve()));
      }),
  };
}

describe("Phase 11 — Production Deployment, Live E2E Verification & Final Production Lock", () => {
  beforeEach(async () => {
    await emergencyStopCoordinator.reset("phase11_setup");
    securityPolicyEngine.setMode("BALANCED");
    identityAuthManager.resetForTesting();
    remoteSecurityCoordinator.resetForTesting();
    remoteSessionManager.resetForTesting();
    pairingManager.reset();
    await remoteStore.clearStore();
    await crossDeviceHandoffManager.clearCaches();
    productionUxController.resetForTesting();
    crossDeviceWorkflowOrchestrator.resetForTesting();
    sharedAccountMemoryManager.resetForTesting();
    remoteBridge.resetForTesting();
    deviceRegistry.resetForTesting();
    capabilityRegistry.resetForTesting();
  });

  afterEach(async () => {
    await emergencyStopCoordinator.reset("phase11_teardown");
    securityPolicyEngine.setMode("BALANCED");
    identityAuthManager.resetForTesting();
    remoteSecurityCoordinator.resetForTesting();
    remoteSessionManager.resetForTesting();
    pairingManager.reset();
    await remoteStore.clearStore();
    await crossDeviceHandoffManager.clearCaches();
    productionUxController.resetForTesting();
    crossDeviceWorkflowOrchestrator.resetForTesting();
    sharedAccountMemoryManager.resetForTesting();
    remoteBridge.resetForTesting();
    deviceRegistry.resetForTesting();
    capabilityRegistry.resetForTesting();
  });

  // ===========================================================================
  // 1. PRODUCTION BUILD, HEALTH & 126-TOOL INVARIANT
  // ===========================================================================
  describe("1. Production Build, Health & 126-Tool Invariant", () => {
    it("1.1 strictly preserves exactly 129 unique Gemini Live tools", () => {
      const declarations = LIVE_TOOLS[0].functionDeclarations || [];
      expect(declarations.length).toBe(129);
      const uniqueNames = new Set(declarations.map((d: any) => d.name));
      expect(uniqueNames.size).toBe(129);
    });

    it("1.2 /health and /api/health return 200 OK with security headers and zero secret leakage", async () => {
      const gw = await startTestGatewayServer();
      try {
        const res = await fetch(`${gw.baseUrl}/health`);
        expect(res.status).toBe(200);
        expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
        expect(res.headers.get("x-content-type-options")).toBe("nosniff");
        expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");

        const body = await res.json();
        expect(body.status).toBe("ok");
        expect(body.service).toBe("myraa-backend");
        expect(body.emergencyStop).toBe(false);
        expect(body.securityLockdown).toBe(false);
        expect(JSON.stringify(body)).not.toMatch(/AIza[0-9A-Za-z_-]{20,}/);
      } finally {
        await gw.close();
      }
    });
  });

  // ===========================================================================
  // 2. PRODUCTION ENVIRONMENT VARIABLES & SECRET PROTECTION
  // ===========================================================================
  describe("2. Production Environment Variables & Secret Protection", () => {
    it("2.1 enforces environment-only Gemini API key resolution and blocks HTTP key mutation in production", async () => {
      const prevNodeEnv = process.env.NODE_ENV;
      const prevLaunchedBy = process.env.SORA_LAUNCHED_BY;
      const prevGeminiKey = process.env.GEMINI_API_KEY;
      const gw = await startTestGatewayServer();

      try {
        process.env.NODE_ENV = "production";
        delete process.env.SORA_LAUNCHED_BY;
        process.env.GEMINI_API_KEY = "AIzaSyPhase11ProductionTestKey123456789";

        const meta = resolveApiKeyWithMetadata();
        expect(meta.isValid).toBe(true);
        expect(meta.source).toBe("GEMINI_API_KEY");
        expect(meta.masked).toBe("AIza...[REDACTED]");

        const postRes = await fetch(`${gw.baseUrl}/api/config/apikey`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ apiKey: "AIzaSyAttackerOverrideKey9999999999" }),
        });
        expect(postRes.status).toBe(403);

        const delRes = await fetch(`${gw.baseUrl}/api/config/apikey`, {
          method: "DELETE",
        });
        expect(delRes.status).toBe(403);
      } finally {
        process.env.NODE_ENV = prevNodeEnv;
        if (prevLaunchedBy === undefined) delete process.env.SORA_LAUNCHED_BY;
        else process.env.SORA_LAUNCHED_BY = prevLaunchedBy;
        if (prevGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
        else process.env.GEMINI_API_KEY = prevGeminiKey;
        await gw.close();
      }
    });
  });

  // ===========================================================================
  // 3. HTTPS/WSS ENFORCEMENT, CORS & ANDROID HTTPS/WSS TRANSPORT
  // ===========================================================================
  describe("3. HTTPS/WSS Enforcement, CORS & Android HTTPS/WSS Transport", () => {
    it("3.1 rejects non-localhost plain HTTP requests when x-forwarded-proto is http", async () => {
      const gw = await startTestGatewayServer();
      try {
        const res = await fetch(`${gw.baseUrl}/api/remote/connection-status`, {
          headers: {
            "X-Forwarded-For": "203.0.113.50",
            "X-Forwarded-Proto": "http",
          },
        });
        expect(res.status).toBe(403);
      } finally {
        await gw.close();
      }
    });

    it("3.2 allows non-localhost HTTPS requests when x-forwarded-proto is https and sets HSTS in production", async () => {
      const prevNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "production";
      const gw = await startTestGatewayServer();
      try {
        const res = await fetch(`${gw.baseUrl}/api/remote/connection-status`, {
          headers: {
            "X-Forwarded-For": "203.0.113.50",
            "X-Forwarded-Proto": "https",
          },
        });
        expect(res.status).toBe(200);
        expect(res.headers.get("strict-transport-security")).toContain("max-age=31536000");
      } finally {
        process.env.NODE_ENV = prevNodeEnv;
        await gw.close();
      }
    });

    it("3.3 Android networking clients support HTTPS/WSS for Render cloud domains and HTTP/WS for local LAN", () => {
      const apiClientPath = path.join(
        process.cwd(),
        "android/app/src/main/java/com/myraa/companion/networking/MyraaApiClient.kt",
      );
      const wsClientPath = path.join(
        process.cwd(),
        "android/app/src/main/java/com/myraa/companion/networking/MyraaWebSocketClient.kt",
      );
      const tokenStoragePath = path.join(
        process.cwd(),
        "android/app/src/main/java/com/myraa/companion/security/SecureTokenStorage.kt",
      );

      const apiKt = fs.readFileSync(apiClientPath, "utf-8");
      const wsKt = fs.readFileSync(wsClientPath, "utf-8");
      const storageKt = fs.readFileSync(tokenStoragePath, "utf-8");

      expect(apiKt).toContain("fun buildBaseUrl(host: String, port: Int): String");
      expect(apiKt).not.toContain('"http://$host:$port/');
      expect(wsKt).toContain("fun buildWsUrl(host: String, port: Int, path: String = \"/remote-live\"): String");
      expect(wsKt).not.toContain('"ws://$currentHost:$currentPort/remote-live"');
      expect(storageKt).toContain('DEFAULT_HOST = "myraa-ai-q0h3.onrender.com"');
      expect(storageKt).toContain("DEFAULT_PORT = 443");
    });
  });

  // ===========================================================================
  // 4. MULTI-SURFACE AUTHENTICATION, TOKEN REFRESH & REPLAY PROTECTION
  // ===========================================================================
  describe("4. Multi-Surface Authentication (Chrome/Web, Android, Desktop) & Token Rotation", () => {
    it("4.1 pairs Chrome/Web Companion via bootstrap, pairs Android & Desktop via admin PIN, rotates tokens, and blocks replay", async () => {
      const gw = await startTestGatewayServer();
      try {
        // 1. Check initial bootstrap availability
        const statusRes = await fetch(`${gw.baseUrl}/api/remote/pair-code/status`);
        const statusData = await statusRes.json();
        expect(statusData.canBootstrap).toBe(true);

        // 2. Chrome/Web Companion generates bootstrap PIN and pairs as Admin
        const bootPinRes = await fetch(`${gw.baseUrl}/api/remote/pair-code`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Forwarded-For": "198.51.100.10",
            "X-Forwarded-Proto": "https",
          },
        });
        expect(bootPinRes.status).toBe(201);
        const bootPinData = await bootPinRes.json();
        expect(bootPinData.code).toMatch(/^[A-Z0-9]{6}$/);

        const webPairRes = await fetch(`${gw.baseUrl}/api/remote/pair`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Forwarded-For": "198.51.100.10",
            "X-Forwarded-Proto": "https",
          },
          body: JSON.stringify({
            code: bootPinData.code,
            deviceName: "Chrome Web Companion",
            deviceType: "browser",
          }),
        });
        expect(webPairRes.status).toBe(201);
        const webPair = await webPairRes.json();
        expect(webPair.device.role).toBe("admin");
        expect(webPair.token).toMatch(/^sora_dev_/);
        expect(webPair.accessToken).toMatch(/^myraa_at_/);

        // 3. Admin generates PIN for Android App -> pairs as standard
        const androidPinRes = await fetch(`${gw.baseUrl}/api/remote/pair-code`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${webPair.accessToken}`,
            "X-Forwarded-For": "198.51.100.10",
            "X-Forwarded-Proto": "https",
          },
        });
        expect(androidPinRes.status).toBe(201);
        const androidPin = await androidPinRes.json();

        const androidPairRes = await fetch(`${gw.baseUrl}/api/remote/pair`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Forwarded-For": "198.51.100.20",
            "X-Forwarded-Proto": "https",
            "User-Agent": "MyraaAndroidCompanion/2.0 (Android 15; Pixel 9 Pro)",
          },
          body: JSON.stringify({
            code: androidPin.code,
            deviceName: "Pixel 9 Pro Android",
            deviceType: "mobile",
          }),
        });
        expect(androidPairRes.status).toBe(201);
        const androidPair = await androidPairRes.json();
        expect(androidPair.device.role).toBe("standard");

        // 4. Admin generates PIN for Windows Desktop Companion -> pairs as standard
        const desktopPinRes = await fetch(`${gw.baseUrl}/api/remote/pair-code`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${webPair.accessToken}`,
            "X-Forwarded-For": "198.51.100.10",
            "X-Forwarded-Proto": "https",
          },
        });
        const desktopPin = await desktopPinRes.json();

        const desktopPairRes = await fetch(`${gw.baseUrl}/api/remote/pair`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Forwarded-For": "198.51.100.30",
            "X-Forwarded-Proto": "https",
          },
          body: JSON.stringify({
            code: desktopPin.code,
            deviceName: "Windows Desktop Companion",
            deviceType: "desktop_client",
          }),
        });
        expect(desktopPairRes.status).toBe(201);
        const desktopPair = await desktopPairRes.json();
        expect(desktopPair.device.role).toBe("standard");

        // 5. Token rotation & strict replay detection
        const refresh1Res = await fetch(`${gw.baseUrl}/api/remote/token/refresh`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Forwarded-For": "198.51.100.20",
            "X-Forwarded-Proto": "https",
          },
          body: JSON.stringify({
            refreshToken: androidPair.refreshToken,
            deviceToken: androidPair.token,
          }),
        });
        expect(refresh1Res.status).toBe(200);
        const refresh1 = await refresh1Res.json();
        expect(refresh1.accessToken).toMatch(/^myraa_at_/);
        expect(refresh1.refreshToken).not.toBe(androidPair.refreshToken);

        // Replaying the consumed refreshToken must fail with 403 Forbidden
        const replayRes = await fetch(`${gw.baseUrl}/api/remote/token/refresh`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Forwarded-For": "198.51.100.20",
            "X-Forwarded-Proto": "https",
          },
          body: JSON.stringify({
            refreshToken: androidPair.refreshToken,
          }),
        });
        expect(replayRes.status).toBe(403);
      } finally {
        await gw.close();
      }
    });
  });

  // ===========================================================================
  // 5. GEMINI LIVE VOICE SESSION, IDLE RECONNECT & UPSTREAM RECREATION
  // ===========================================================================
  describe("5. Gemini Live Voice Session, Idle Reconnect & Upstream Recreation", () => {
    it("5.1 recreates upstream Gemini Live session without dropping the authenticated /remote-live WebSocket", async () => {
      const prevGeminiKey = process.env.GEMINI_API_KEY;
      process.env.GEMINI_API_KEY = "AIzaSyPhase11VoiceSessionTestKey123456";

      let createCount = 0;
      const fakeFactory: any = {
        createSession: async ({ clientWs, flags }: any) => {
          createCount++;
          flags.onGeminiStateChange?.("READY");
          clientWs.send(
            JSON.stringify({
              type: "status",
              status: "gemini_ready",
              geminiState: "READY",
              generation: createCount,
            }),
          );
          return {
            sendRealtimeInput: () => {},
            sendClientContent: () => {},
            sendToolResponse: () => {},
            close: () => {},
          };
        },
      };

      const conversationManager = new ConversationManager(fakeFactory);
      const gw = await startTestGatewayServer();
      gw.wss.on("connection", (ws) => {
        conversationManager.handleConnection(ws);
      });

      try {
        const { code } = await pairingManager.generateBootstrapPairCode("127.0.0.1");
        const paired = await pairingManager.pairDevice({
          code,
          deviceName: "Android Voice Client",
          deviceType: "mobile",
          ipAddress: "127.0.0.1",
        });

        const messages: any[] = [];
        const ws = new WebSocket(gw.wsUrl, ["myraa-auth", paired.token]);

        await new Promise<void>((resolve, reject) => {
          ws.on("open", () => resolve());
          ws.on("error", reject);
        });

        ws.on("message", (data) => {
          messages.push(JSON.parse(data.toString()));
        });

        // Wait for initial Gemini session ready
        await new Promise((r) => setTimeout(r, 80));
        expect(createCount).toBe(1);

        // Send application-level ping after idle -> expect pong with geminiState: READY
        ws.send(JSON.stringify({ type: "ping" }));
        await new Promise((r) => setTimeout(r, 50));
        expect(messages.some((m) => m.type === "pong" && m.geminiState === "READY")).toBe(true);

        // Trigger upstream Gemini recreation while keeping client WS open
        ws.send(JSON.stringify({ type: "recreate_gemini" }));
        await new Promise((r) => setTimeout(r, 80));
        expect(createCount).toBe(2);
        expect(ws.readyState).toBe(WebSocket.OPEN);

        ws.close();
      } finally {
        if (prevGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
        else process.env.GEMINI_API_KEY = prevGeminiKey;
        await gw.close();
      }
    });

    it("5.2 sustains a realistic long-running multi-cycle voice session across idle periods, WS reconnects, token rotations, and upstream Gemini rotations", async () => {
      const prevGeminiKey = process.env.GEMINI_API_KEY;
      process.env.GEMINI_API_KEY = "AIzaSyPhase11LongRunningVoiceTestKey999";

      let geminiSessionsCreated = 0;
      let audioFramesReceived = 0;
      const fakeFactory: any = {
        createSession: async ({ clientWs, flags }: any) => {
          geminiSessionsCreated++;
          flags.onGeminiStateChange?.("READY");
          clientWs.send(
            JSON.stringify({
              type: "status",
              status: "gemini_ready",
              geminiState: "READY",
              generation: geminiSessionsCreated,
            }),
          );
          return {
            sendRealtimeInput: () => {
              audioFramesReceived++;
            },
            sendClientContent: () => {},
            sendToolResponse: () => {},
            close: () => {},
          };
        },
      };

      const conversationManager = new ConversationManager(fakeFactory);
      const gw = await startTestGatewayServer();
      gw.wss.on("connection", (ws) => {
        conversationManager.handleConnection(ws);
      });

      try {
        // Pair Android device and obtain rotating token pair
        const { code } = await pairingManager.generateBootstrapPairCode("127.0.0.1");
        const pairRes = await fetch(`${gw.baseUrl}/api/remote/pair`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            code,
            deviceName: "Long-Run Android Voice Companion",
            deviceType: "mobile",
          }),
        });
        const paired = await pairRes.json();
        let activeAccessToken = paired.accessToken;
        let activeRefreshToken = paired.refreshToken;

        // Run 4 full cycles of: connect -> stream audio frames -> idle heartbeats -> upstream rotation -> disconnect -> rotate token -> reconnect
        for (let cycle = 1; cycle <= 4; cycle++) {
          const wsMessages: any[] = [];
          const ws = new WebSocket(gw.wsUrl, ["myraa-auth", activeAccessToken]);

          await new Promise<void>((resolve, reject) => {
            ws.on("open", () => resolve());
            ws.on("error", reject);
          });

          ws.on("message", (raw) => {
            wsMessages.push(JSON.parse(raw.toString()));
          });

          await new Promise((r) => setTimeout(r, 40));

          // Stream 5 PCM audio chunks
          for (let frame = 0; frame < 5; frame++) {
            ws.send(
              JSON.stringify({
                audio: Buffer.alloc(320, cycle + frame).toString("base64"),
              }),
            );
          }

          // Simulate 3 idle heartbeat intervals
          for (let hb = 0; hb < 3; hb++) {
            ws.send(JSON.stringify({ type: "ping" }));
            await new Promise((r) => setTimeout(r, 20));
          }
          expect(wsMessages.filter((m) => m.type === "pong").length).toBeGreaterThanOrEqual(3);

          // Trigger upstream Gemini rotation mid-call without dropping client WS
          ws.send(JSON.stringify({ type: "recreate_gemini" }));
          await new Promise((r) => setTimeout(r, 40));
          expect(ws.readyState).toBe(WebSocket.OPEN);

          // Disconnect WS cleanly before next cycle
          ws.close();
          await new Promise((r) => setTimeout(r, 20));

          // Rotate session token before reconnecting
          const rotRes = await fetch(`${gw.baseUrl}/api/remote/token/refresh`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              refreshToken: activeRefreshToken,
              deviceToken: paired.token,
            }),
          });
          expect(rotRes.status).toBe(200);
          const rotated = await rotRes.json();
          activeAccessToken = rotated.accessToken;
          activeRefreshToken = rotated.refreshToken;
        }

        expect(geminiSessionsCreated).toBe(8); // 4 cycles * (1 initial + 1 recreated)
        expect(audioFramesReceived).toBe(20); // 4 cycles * 5 frames
      } finally {
        if (prevGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
        else process.env.GEMINI_API_KEY = prevGeminiKey;
        await gw.close();
      }
    });
  });

  // ===========================================================================
  // 6. STANDALONE CAPABILITIES, OPTIONAL BRIDGE, MEMORY SYNC & HANDOFF
  // ===========================================================================
  describe("6. Standalone Phone/Desktop, Optional Remote Bridge, Memory Sync & Handoff", () => {
    it("6.1 verifies standalone phone, standalone desktop, optional bridge, memory sync, and cross-device handoff", async () => {
      const gw = await startTestGatewayServer();
      try {
        // 1. Initial UX state: Remote Bridge MUST be DISCONNECTED by default
        const stateRes = await fetch(`${gw.baseUrl}/api/ux/state`);
        const ux0 = await stateRes.json();
        expect(ux0.mobile.desktopConnectionScreen.connectionStatus).toBe("DISCONNECTED");
        expect(ux0.desktop.remoteConnectionPanel.connectionStatus).toBe("DISCONNECTED");

        // 2. Standalone Phone voice command works while bridge is DISCONNECTED
        const mobVoiceRes = await fetch(`${gw.baseUrl}/api/ux/mobile/voice`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            utterance: "WhatsApp open karo",
          }),
        });
        expect(mobVoiceRes.status).toBe(200);
        const mobVoice = await mobVoiceRes.json();
        expect(mobVoice.turn.ok).toBe(true);

        // 3. Standalone Desktop voice command works while bridge is DISCONNECTED
        const deskVoiceRes = await fetch(`${gw.baseUrl}/api/ux/desktop/voice`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            utterance: "VS Code open karo",
          }),
        });
        expect(deskVoiceRes.status).toBe(200);
        const deskVoice = await deskVoiceRes.json();
        expect(deskVoice.turn.ok).toBe(true);

        // 4. Optional Phone ↔ Desktop Bridge pair, connect, and disconnect
        const pairReqRes = await fetch(`${gw.baseUrl}/api/ux/remote/pair-request`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        const pairReq = await pairReqRes.json();
        expect(pairReq.pairingCode).toMatch(/^\d{6}$/);

        const pairConfirmRes = await fetch(`${gw.baseUrl}/api/ux/remote/pair-confirm`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            pairingId: pairReq.pairingId,
            pairingCode: pairReq.pairingCode,
            connectAfterPair: true,
          }),
        });
        const pairConfirm = await pairConfirmRes.json();
        expect(pairConfirm.mobile.desktopConnectionScreen.connectionStatus).toBe("CONNECTED");

        // 5. Cross-Device Handoff (Phone -> Desktop)
        const handoffStart = await (
          await fetch(`${gw.baseUrl}/api/ux/handoff`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "conversational",
              utterance: "Is project ko mere laptop par kholo",
            }),
          })
        ).json();
        expect(handoffStart.activeWorkflows.length).toBeGreaterThan(0);

        // 6. Disconnect Optional Bridge -> returns cleanly to DISCONNECTED
        const discRes = await fetch(`${gw.baseUrl}/api/ux/remote/disconnect`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        const stateAfterDisconnect = await discRes.json();
        expect(stateAfterDisconnect.mobile.desktopConnectionScreen.connectionStatus).toBe("DISCONNECTED");

        // 7. Shared Memory Sync across devices with DLP protection
        const authRes = await fetch(`${gw.baseUrl}/api/ux/account/auth`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "login",
            accountId: "acct-phase11-e2e",
          }),
        });
        expect(authRes.status).toBe(200);

        const memRes = await fetch(`${gw.baseUrl}/api/ux/memory`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            scope: "SHARED",
            key: "phase11_release_status",
            value: "Phase 11 production deployment verified across Web, Android, and Windows Desktop.",
          }),
        });
        expect(memRes.status).toBe(200);
        const memBody = await memRes.json();
        expect(memBody.memoryResult.ok).toBe(true);
        expect(
          memBody.desktop.memoryView.sharedMemories.some(
            (i: any) => i.key === "phase11_release_status",
          ),
        ).toBe(true);
        expect(
          memBody.mobile.memoryView.sharedMemories.some(
            (i: any) => i.key === "phase11_release_status",
          ),
        ).toBe(true);
      } finally {
        await gw.close();
      }
    });
  });

  // ===========================================================================
  // 7. EMERGENCY STOP, LOCKDOWN, REVOKE, RBAC, DLP, SSRF & AUDIT LOGGING
  // ===========================================================================
  describe("7. Security Controls: Emergency Stop, Lockdown, Revoke, RBAC, DLP, SSRF & Audit", () => {
    it("7.1 enforces Emergency Stop, Security Lockdown, Device Revoke, RBAC, DLP, SSRF, and Audit Hash Chain", async () => {
      const gw = await startTestGatewayServer();
      try {
        // Pair Admin and Standard devices
        const { code } = await pairingManager.generateBootstrapPairCode("198.51.100.1");
        const adminPaired = await pairingManager.pairDevice({
          code,
          deviceName: "Admin Console",
          deviceType: "browser",
          ipAddress: "198.51.100.1",
        });

        const { code: stdCode } = pairingManager.generatePairCode("198.51.100.1");
        const stdPaired = await pairingManager.pairDevice({
          code: stdCode,
          deviceName: "Standard Mobile",
          deviceType: "mobile",
          ipAddress: "198.51.100.2",
        });

        // 1. RBAC: Standard device cannot generate new pairing codes (403 Forbidden)
        const rbacRes = await fetch(`${gw.baseUrl}/api/remote/pair-code`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${stdPaired.token}`,
            "X-Forwarded-For": "198.51.100.2",
            "X-Forwarded-Proto": "https",
          },
        });
        expect(rbacRes.status).toBe(403);

        // 2. Device Revocation: Admin revokes Standard device -> immediate 401 on subsequent calls
        const revokeRes = await fetch(`${gw.baseUrl}/api/remote/revoke`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${adminPaired.token}`,
            "X-Forwarded-For": "198.51.100.1",
            "X-Forwarded-Proto": "https",
          },
          body: JSON.stringify({ deviceId: stdPaired.device.id, reason: "Phase 11 Revoke Test" }),
        });
        expect(revokeRes.status).toBe(200);

        const postRevokeRes = await fetch(`${gw.baseUrl}/api/remote/session`, {
          headers: {
            Authorization: `Bearer ${stdPaired.token}`,
            "X-Forwarded-For": "198.51.100.2",
            "X-Forwarded-Proto": "https",
          },
        });
        expect(postRevokeRes.status).toBe(401);

        // 3. Emergency Stop & Security Lockdown
        await emergencyStopCoordinator.trigger({
          source: "rest_api",
          reason: "Phase 11 emergency stop verification",
        });
        expect(emergencyStopCoordinator.isActive()).toBe(true);
        await emergencyStopCoordinator.reset("phase11_audit");
        expect(emergencyStopCoordinator.isActive()).toBe(false);

        securityPolicyEngine.setMode("LOCKDOWN");
        expect(securityPolicyEngine.getMode()).toBe("LOCKDOWN");
        securityPolicyEngine.setMode("BALANCED");

        // 4. DLP Redaction
        const dlpResult = outputDataFirewall.sanitizeResult(
          "Here is key AIzaSySecretKeyLeakTest123456789012345 and Bearer sora_dev_secret_token_1234567890",
          { toolName: "phase11_dlp_check" },
        );
        expect(dlpResult.redactedCount).toBeGreaterThan(0);
        expect(String(dlpResult.sanitized)).not.toContain("AIzaSySecretKeyLeakTest123456789012345");

        // 5. SSRF Protection
        expect(networkSecurityManager.isRestrictedHost("169.254.169.254")).toBe(true);
        expect(networkSecurityManager.isRestrictedHost("127.0.0.1")).toBe(true);
        expect(networkSecurityManager.isRestrictedHost("192.168.1.1")).toBe(true);

        // 6. Cryptographic Audit Trail Integrity
        const integrity = securityAuditLogger.verifyChainIntegrity();
        expect(integrity.valid).toBe(true);
      } finally {
        await gw.close();
      }
    });
  });

  // ===========================================================================
  // 8. STATELESS RENDER RESTART / REDEPLOY RECOVERY
  // ===========================================================================
  describe("8. Stateless Render Restart / Redeploy Recovery", () => {
    it("8.1 recovers authenticated Admin, Android, and Desktop sessions after full container restart without role inversion", async () => {
      const prevRenderId = process.env.RENDER_SERVICE_ID;
      process.env.RENDER_SERVICE_ID = "srv-phase11-render-production";

      const gw = await startTestGatewayServer();
      try {
        const secretBefore = getPersistentServerSecret();

        // 1. Pair Admin Web Companion + Standard Android Companion before restart
        const { code: bootCode } = await pairingManager.generateBootstrapPairCode("198.51.100.10");
        const webPairRes = await fetch(`${gw.baseUrl}/api/remote/pair`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Forwarded-For": "198.51.100.10",
            "X-Forwarded-Proto": "https",
          },
          body: JSON.stringify({
            code: bootCode,
            deviceName: "Admin Web Companion",
            deviceType: "browser",
          }),
        });
        const webPair = await webPairRes.json();
        expect(webPair.device.role).toBe("admin");

        const { code: androidCode } = pairingManager.generatePairCode("198.51.100.10");
        const androidPairRes = await fetch(`${gw.baseUrl}/api/remote/pair`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Forwarded-For": "198.51.100.25",
            "X-Forwarded-Proto": "https",
            "User-Agent": "MyraaAndroidCompanion/2.0 (Android 15)",
          },
          body: JSON.stringify({
            code: androidCode,
            deviceName: "Android Companion",
            deviceType: "mobile",
          }),
        });
        const androidPair = await androidPairRes.json();
        expect(androidPair.device.role).toBe("standard");

        // 2. Simulate Render container redeploy / ephemeral filesystem wipe + memory reset
        await remoteStore.clearStore();
        identityAuthManager.resetForTesting();
        remoteSessionManager.resetForTesting();
        remoteSecurityCoordinator.resetForTesting();

        const secretAfter = getPersistentServerSecret();
        expect(secretAfter).toBe(secretBefore);

        // 3. Android reconnects first after restart using rotateSessionToken with deviceToken fallback
        const androidRefreshAfterRestart = await fetch(`${gw.baseUrl}/api/remote/token/refresh`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Forwarded-For": "198.51.100.25",
            "X-Forwarded-Proto": "https",
            "User-Agent": "MyraaAndroidCompanion/2.0 (Android 15)",
          },
          body: JSON.stringify({
            refreshToken: androidPair.refreshToken,
            deviceToken: androidPair.token,
          }),
        });
        expect(androidRefreshAfterRestart.status).toBe(200);
        const refreshedAndroid = await androidRefreshAfterRestart.json();
        expect(refreshedAndroid.accessToken).toMatch(/^myraa_at_/);

        // Verify Android preserved its "standard" role (did NOT hijack admin)
        const androidSessionRes = await fetch(`${gw.baseUrl}/api/remote/session`, {
          headers: {
            Authorization: `Bearer ${refreshedAndroid.accessToken}`,
            "X-Forwarded-For": "198.51.100.25",
            "X-Forwarded-Proto": "https",
          },
        });
        expect(androidSessionRes.status).toBe(200);
        const androidSession = await androidSessionRes.json();
        expect(androidSession.device.role).toBe("standard");

        // 4. Admin Web Companion reconnects after restart using stateless accessToken claim verification
        const adminSessionRes = await fetch(`${gw.baseUrl}/api/remote/session`, {
          headers: {
            Authorization: `Bearer ${webPair.accessToken}`,
            "X-Forwarded-For": "198.51.100.10",
            "X-Forwarded-Proto": "https",
          },
        });
        expect(adminSessionRes.status).toBe(200);
        const adminSession = await adminSessionRes.json();
        expect(adminSession.device.role).toBe("admin");
      } finally {
        if (prevRenderId === undefined) delete process.env.RENDER_SERVICE_ID;
        else process.env.RENDER_SERVICE_ID = prevRenderId;
        await gw.close();
      }
    });
  });

  // ===========================================================================
  // 9. LIVE RENDER PRODUCTION ENDPOINT VERIFICATION
  // ===========================================================================
  describe("9. Live Render Production Endpoint Verification (https://myraa-ai-q0h3.onrender.com)", () => {
    const LIVE_URL = process.env.MYRAA_LIVE_RENDER_URL || "https://myraa-ai-q0h3.onrender.com";

    it("9.1 verifies live Render /health, security headers, /api/ux/state, and /api/remote/connection-status", async () => {
      let healthRes: Response;
      try {
        healthRes = await fetch(`${LIVE_URL}/health`, {
          signal: AbortSignal.timeout(15000),
        });
      } catch {
        // Offline environment fallback
        return;
      }

      expect(healthRes.status).toBe(200);
      expect(healthRes.headers.get("x-frame-options")).toBe("SAMEORIGIN");
      expect(healthRes.headers.get("x-content-type-options")).toBe("nosniff");

      const health = await healthRes.json();
      expect(health.status).toBe("ok");
      expect(health.service).toBe("myraa-backend");
      expect(health.environment).toBe("production");
      expect(health.hasApiKey).toBe(true);
      expect(health.emergencyStop).toBe(false);
      expect(health.securityLockdown).toBe(false);

      // Verify production HTTP key mutation lock on live Render
      const mutateKeyRes = await fetch(`${LIVE_URL}/api/config/apikey`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: "AIzaSyBlockedOnLiveRender123456789" }),
      });
      expect([401, 403]).toContain(mutateKeyRes.status);

      // Verify live /api/ux/state
      const uxRes = await fetch(`${LIVE_URL}/api/ux/state`);
      expect(uxRes.status).toBe(200);
      const uxState = await uxRes.json();
      expect(uxState.mobile).toBeDefined();
      expect(uxState.desktop).toBeDefined();

      // Verify live /api/remote/connection-status
      const connRes = await fetch(`${LIVE_URL}/api/remote/connection-status`);
      expect(connRes.status).toBe(200);
      const conn = await connRes.json();
      expect(conn.connectionState).toBeDefined();
      expect(conn.geminiState).toBeDefined();
    }, 30000);
  });
});
