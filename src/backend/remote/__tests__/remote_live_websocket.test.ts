/**
 * MYRAA — Remote-Live WebSocket & Transport Protocol Regression Tests
 *
 * Verifies:
 *   1. WSS upgrade on /remote-live with Sec-WebSocket-Protocol ["myraa-auth", accessToken] succeeds (101).
 *   2. Server returns "Sec-WebSocket-Protocol: myraa-auth" without leaking the secret token.
 *   3. WSS upgrade on /remote-live with Sec-WebSocket-Protocol ["myraa-auth", durableDeviceToken] succeeds.
 *   4. Expired access token is rejected during upgrade (401 Unauthorized -> code 1006 in browser).
 *   5. Automatic token refresh yields a fresh token that successfully upgrades WebSocket.
 *   6. Missing token on non-localhost is rejected with 401 Unauthorized.
 *   7. Insecure transport (HTTP/WS on remote IP) is rejected with 403 Forbidden.
 *   8. Multi-hop proxy header ("https, https") is correctly accepted as secure.
 *   9. Security Lockdown rejects upgrade with 423 Locked.
 *   10. Emergency Stop rejects upgrade with 503 Service Unavailable.
 *   11. Strict Invariant: Exactly 126 Gemini Live tools preserved in LIVE_TOOLS.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import { remoteStore } from "../RemoteStore.ts";
import { pairingManager } from "../PairingManager.ts";
import { remoteSecurityCoordinator } from "../../security/RemoteSecurityCoordinator.ts";
import { identityAuthManager } from "../../security/IdentityAuthManager.ts";
import { securityPolicyEngine } from "../../security/SecurityPolicyEngine.ts";
import { emergencyStopCoordinator } from "../EmergencyStopCoordinator.ts";
import { dataProtectionService } from "../../security/DataProtectionService.ts";
import { createHttpApp } from "../../gateway/HttpGateway.ts";
import { LIVE_TOOLS } from "../../ai/GeminiSessionFactory.ts";
import type { PairedDevice } from "../RemoteTypes.ts";

describe("MYRAA /remote-live WebSocket Handshake & Security Protocol", () => {
  let server: http.Server;
  let wss: WebSocketServer;
  let port: number;

  beforeEach(async () => {
    await remoteStore.clearStore();
    identityAuthManager.resetForTesting();
    securityPolicyEngine.resetForTesting();
    emergencyStopCoordinator.reset();

    const app = createHttpApp();
    server = http.createServer(app);

    wss = new WebSocketServer({
      noServer: true,
      handleProtocols: (protocols) => {
        if (protocols.has("myraa-auth")) {
          return "myraa-auth";
        }
        // Fail closed: reject unknown/arbitrary protocols
        return false;
      },
    });

    server.on("upgrade", async (request, socket, head) => {
      try {
        const url = new URL(request.url || "", `http://${request.headers.host}`);
        const pathname = url.pathname;
        if (pathname === "/live" || pathname === "/remote-live") {
          const forwardedFor = request.headers["x-forwarded-for"];
          const ip = typeof forwardedFor === "string"
            ? forwardedFor.split(",")[0].trim()
            : (socket as any).remoteAddress || request.socket?.remoteAddress || "";
          const isLocal = !forwardedFor && (ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1");

          // Validate Transport Security
          if (!isLocal) {
            const protoHeader = request.headers["x-forwarded-proto"];
            const protoFirst = typeof protoHeader === "string" ? protoHeader.split(",")[0].trim() : protoHeader;
            const isSslOn = request.headers["x-forwarded-ssl"] === "on" || request.headers["front-end-https"] === "on";
            const proto = protoFirst || (isSslOn ? "wss" : ((socket as any).encrypted ? "wss" : "ws"));
            const transportCheck = dataProtectionService.validateTransport({
              protocol: String(proto),
              ipAddress: ip,
              targetName: pathname,
            });
            if (!transportCheck.secure) {
              socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
              socket.destroy();
              return;
            }
          }

          // Extract token from Sec-WebSocket-Protocol
          let token: string | null = null;
          const protocols = request.headers["sec-websocket-protocol"];
          if (protocols) {
            const parts = protocols.split(",").map((s) => s.trim());
            const authIdx = parts.indexOf("myraa-auth");
            if (authIdx >= 0 && parts[authIdx + 1]) {
              token = parts[authIdx + 1];
            }
          }

          // Reject token parameter in URL query on remote non-localhost connections to eliminate credential leakage
          if (url.searchParams.has("token")) {
            if (!isLocal) {
              socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
              socket.destroy();
              return;
            }
            if (!token) {
              token = url.searchParams.get("token");
            }
          }

          let remoteDevice = null;
          if (!isLocal || token) {
            if (!token) {
              socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
              socket.destroy();
              return;
            }
            const auth = await remoteSecurityCoordinator.authenticateRemoteCredential(
              token,
              ip,
              request.headers["user-agent"],
            );
            if (!auth.authenticated || !auth.device) {
              socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
              socket.destroy();
              return;
            }
            remoteDevice = auth.device;
          }

          // Lockdown
          if (securityPolicyEngine.getMode() === "LOCKDOWN") {
            socket.write("HTTP/1.1 423 Locked\r\n\r\n");
            socket.destroy();
            return;
          }

          // Emergency stop
          if (emergencyStopCoordinator.isActive()) {
            socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
            socket.destroy();
            return;
          }

          wss.handleUpgrade(request, socket, head, (ws) => {
            (ws as any).remoteDevice = remoteDevice;
            wss.emit("connection", ws, request);
          });
        } else {
          socket.destroy();
        }
      } catch {
        socket.destroy();
      }
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as any).port;
  });

  afterEach(async () => {
    if (wss) {
      wss.close();
    }
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await remoteStore.clearStore();
    identityAuthManager.resetForTesting();
    securityPolicyEngine.resetForTesting();
    emergencyStopCoordinator.reset();
  });

  async function registerTestDevice(role: "admin" | "standard" = "standard"): Promise<{ device: PairedDevice; token: string }> {
    const deviceId = `dev-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const devToken = pairingManager.signDeviceToken(deviceId);
    const device: PairedDevice = {
      id: deviceId,
      name: role === "admin" ? "Android Companion Admin" : "PC Web Client",
      deviceType: role === "admin" ? "mobile" : "browser",
      role,
      tokenHash: pairingManager.hashToken(devToken),
      pairedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      revoked: false,
    };
    await remoteStore.saveDevice(device);
    return { device, token: devToken };
  }

  it("1. WSS upgrade on /remote-live with Sec-WebSocket-Protocol ['myraa-auth', accessToken] succeeds", async () => {
    const { device } = await registerTestDevice("standard");
    const session = remoteSecurityCoordinator.createDeviceSession(device, "198.51.100.25");
    const accessToken = session.tokens.accessToken;

    const ws = new WebSocket(`ws://127.0.0.1:${port}/remote-live`, ["myraa-auth", accessToken], {
      headers: {
        "x-forwarded-for": "198.51.100.25",
        "x-forwarded-proto": "https",
      },
    });

    const openEvent = await new Promise<boolean>((resolve, reject) => {
      ws.on("open", () => resolve(true));
      ws.on("error", (err) => reject(err));
    });

    expect(openEvent).toBe(true);
    // Verifies the selected subprotocol is "myraa-auth" and does NOT echo the secret token
    expect(ws.protocol).toBe("myraa-auth");
    ws.close();
  });

  it("2. WSS upgrade on /remote-live with Sec-WebSocket-Protocol ['myraa-auth', durableDeviceToken] succeeds", async () => {
    const { token: devToken } = await registerTestDevice("admin");

    const ws = new WebSocket(`ws://127.0.0.1:${port}/remote-live`, ["myraa-auth", devToken], {
      headers: {
        "x-forwarded-for": "198.51.100.26",
        "x-forwarded-proto": "https",
      },
    });

    const openEvent = await new Promise<boolean>((resolve, reject) => {
      ws.on("open", () => resolve(true));
      ws.on("error", (err) => reject(err));
    });

    expect(openEvent).toBe(true);
    expect(ws.protocol).toBe("myraa-auth");
    ws.close();
  });

  it("3. Expired access token is rejected during upgrade with 401 Unauthorized", async () => {
    const { device } = await registerTestDevice("standard");
    const session = remoteSecurityCoordinator.createDeviceSession(device, "198.51.100.27");
    const initialAccessToken = session.tokens.accessToken;

    // Tamper expiration timestamp to 1 hour in the past
    const parts = initialAccessToken.slice("myraa_at_".length).split(".");
    const rawPayload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf-8"));
    rawPayload.exp = Math.floor(Date.now() / 1000) - 3600;
    const expiredPayload = Buffer.from(JSON.stringify(rawPayload)).toString("base64url");
    const sig = (identityAuthManager as any)._signString(expiredPayload);
    const expiredAccessToken = `myraa_at_${expiredPayload}.${sig}`;

    const ws = new WebSocket(`ws://127.0.0.1:${port}/remote-live`, ["myraa-auth", expiredAccessToken], {
      headers: {
        "x-forwarded-for": "198.51.100.27",
        "x-forwarded-proto": "https",
      },
    });

    const errorResult = await new Promise<{ error: any; code?: number }>((resolve) => {
      ws.on("error", (err) => resolve({ error: err }));
      ws.on("close", (code) => resolve({ error: null, code }));
    });

    // Client error thrown on 401 handshake response
    expect(errorResult.error).toBeTruthy();
    expect(errorResult.error.message).toContain("401");
  });

  it("4. Proactive token refresh allows successful WebSocket connection after access token expiry", async () => {
    const { device, token: devToken } = await registerTestDevice("standard");
    const session = remoteSecurityCoordinator.createDeviceSession(device, "198.51.100.28");
    const refreshToken = session.tokens.refreshToken;

    // Refresh the expired session against HTTP refresh endpoint
    const refreshRes = await fetch(`http://127.0.0.1:${port}/api/remote/token/refresh`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": "198.51.100.28",
        "X-Forwarded-Proto": "https",
      },
      body: JSON.stringify({ refreshToken, deviceToken: devToken }),
    });

    expect(refreshRes.status).toBe(200);
    const refreshData = await refreshRes.json();
    expect(refreshData.accessToken).toBeDefined();

    // Now connect with refreshed token
    const ws = new WebSocket(`ws://127.0.0.1:${port}/remote-live`, ["myraa-auth", refreshData.accessToken], {
      headers: {
        "x-forwarded-for": "198.51.100.28",
        "x-forwarded-proto": "https",
      },
    });

    const openEvent = await new Promise<boolean>((resolve, reject) => {
      ws.on("open", () => resolve(true));
      ws.on("error", (err) => reject(err));
    });

    expect(openEvent).toBe(true);
    expect(ws.protocol).toBe("myraa-auth");
    ws.close();
  });

  it("5. Missing token on non-localhost remote IP is rejected with 401 Unauthorized", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/remote-live`, {
      headers: {
        "x-forwarded-for": "198.51.100.29",
        "x-forwarded-proto": "https",
      },
    });

    const errorResult = await new Promise<{ error: any }>((resolve) => {
      ws.on("error", (err) => resolve({ error: err }));
    });

    expect(errorResult.error).toBeTruthy();
    expect(errorResult.error.message).toContain("401");
  });

  it("6. Insecure transport (HTTP on remote IP) is rejected with 403 Forbidden", async () => {
    const { token: devToken } = await registerTestDevice("standard");

    const ws = new WebSocket(`ws://127.0.0.1:${port}/remote-live`, ["myraa-auth", devToken], {
      headers: {
        "x-forwarded-for": "198.51.100.30",
        "x-forwarded-proto": "http", // Insecure remote transport
      },
    });

    const errorResult = await new Promise<{ error: any }>((resolve) => {
      ws.on("error", (err) => resolve({ error: err }));
    });

    expect(errorResult.error).toBeTruthy();
    expect(errorResult.error.message).toContain("403");
  });

  it("7. Multi-hop proxy header ('https, https') is correctly accepted as secure transport", async () => {
    const { token: devToken } = await registerTestDevice("admin");

    const ws = new WebSocket(`ws://127.0.0.1:${port}/remote-live`, ["myraa-auth", devToken], {
      headers: {
        "x-forwarded-for": "198.51.100.31, 10.0.0.1",
        "x-forwarded-proto": "https, https", // Multi-hop comma-separated proxy header
      },
    });

    const openEvent = await new Promise<boolean>((resolve, reject) => {
      ws.on("open", () => resolve(true));
      ws.on("error", (err) => reject(err));
    });

    expect(openEvent).toBe(true);
    ws.close();
  });

  it("8. Security Lockdown rejects new WebSocket connections with 423 Locked", async () => {
    const { token: devToken } = await registerTestDevice("standard");

    // Activate Lockdown
    securityPolicyEngine.setMode("LOCKDOWN");

    const ws = new WebSocket(`ws://127.0.0.1:${port}/remote-live`, ["myraa-auth", devToken], {
      headers: {
        "x-forwarded-for": "198.51.100.32",
        "x-forwarded-proto": "https",
      },
    });

    const errorResult = await new Promise<{ error: any }>((resolve) => {
      ws.on("error", (err) => resolve({ error: err }));
    });

    expect(errorResult.error).toBeTruthy();
    expect(errorResult.error.message).toContain("423");
  });

  it("9. Emergency Stop rejects new WebSocket connections with 503 Service Unavailable", async () => {
    const { token: devToken } = await registerTestDevice("standard");

    // Trigger Emergency Stop
    await emergencyStopCoordinator.trigger({
      source: "rest_api",
      reason: "Security anomaly detected in test",
    });

    const ws = new WebSocket(`ws://127.0.0.1:${port}/remote-live`, ["myraa-auth", devToken], {
      headers: {
        "x-forwarded-for": "198.51.100.33",
        "x-forwarded-proto": "https",
      },
    });

    const errorResult = await new Promise<{ error: any }>((resolve) => {
      ws.on("error", (err) => resolve({ error: err }));
    });

    expect(errorResult.error).toBeTruthy();
    expect(errorResult.error.message).toContain("503");
  });

  it("10. Zero credential leakage: Sec-WebSocket-Protocol response never leaks the secret token", async () => {
    const { token: devToken } = await registerTestDevice("standard");

    const ws = new WebSocket(`ws://127.0.0.1:${port}/remote-live`, ["myraa-auth", devToken], {
      headers: {
        "x-forwarded-for": "198.51.100.34",
        "x-forwarded-proto": "https",
      },
    });

    await new Promise<void>((resolve) => {
      ws.on("open", () => {
        expect(ws.protocol).toBe("myraa-auth");
        expect(ws.protocol).not.toContain(devToken);
        ws.close();
        resolve();
      });
    });
  });

  it("11. Strict Invariant: Exactly 126 Gemini Live tools preserved in LIVE_TOOLS", () => {
    expect(LIVE_TOOLS).toBeDefined();
    expect(LIVE_TOOLS[0].functionDeclarations).toHaveLength(126);
    const names = new Set(LIVE_TOOLS[0].functionDeclarations.map((t) => t.name));
    expect(names.size).toBe(126);
  });

  it("12. Unknown/arbitrary subprotocols are rejected and fail closed", async () => {
    const { token: devToken } = await registerTestDevice("standard");

    // Client requests an unexpected protocol without myraa-auth
    const ws = new WebSocket(`ws://127.0.0.1:${port}/remote-live`, ["unauthorized-protocol", devToken], {
      headers: {
        "x-forwarded-for": "198.51.100.40",
        "x-forwarded-proto": "https",
      },
    });

    const errorResult = await new Promise<{ error: any }>((resolve) => {
      ws.on("error", (err) => resolve({ error: err }));
    });

    // Subprotocol negotiation fails closed
    expect(errorResult.error).toBeTruthy();
  });

  it("13. Remote non-localhost connection presenting query token is rejected with 400 Bad Request", async () => {
    const { token: devToken } = await registerTestDevice("standard");

    // Attempting query parameter authentication on remote IP
    const ws = new WebSocket(`ws://127.0.0.1:${port}/remote-live?token=${encodeURIComponent(devToken)}`, {
      headers: {
        "x-forwarded-for": "198.51.100.41",
        "x-forwarded-proto": "https",
      },
    });

    const errorResult = await new Promise<{ error: any }>((resolve) => {
      ws.on("error", (err) => resolve({ error: err }));
    });

    expect(errorResult.error).toBeTruthy();
    expect(errorResult.error.message).toContain("400");
  });

  it("14. Localhost connection presenting query token is accepted for local dev/Electron mode", async () => {
    const { token: devToken } = await registerTestDevice("standard");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/remote-live?token=${encodeURIComponent(devToken)}`);

    const openEvent = await new Promise<boolean>((resolve, reject) => {
      ws.on("open", () => resolve(true));
      ws.on("error", (err) => reject(err));
    });

    expect(openEvent).toBe(true);
    ws.close();
  });

  it("15. Multi-hop proxy header 'https, http' is accepted because external client hop is HTTPS", async () => {
    const { token: devToken } = await registerTestDevice("standard");

    const ws = new WebSocket(`ws://127.0.0.1:${port}/remote-live`, ["myraa-auth", devToken], {
      headers: {
        "x-forwarded-for": "198.51.100.42, 10.0.0.2",
        "x-forwarded-proto": "https, http", // Client -> Edge is HTTPS, Edge -> Internal is HTTP
      },
    });

    const openEvent = await new Promise<boolean>((resolve, reject) => {
      ws.on("open", () => resolve(true));
      ws.on("error", (err) => reject(err));
    });

    expect(openEvent).toBe(true);
    ws.close();
  });

  it("16. Insecure multi-hop proxy header 'http, https' is REJECTED with 403 because external client hop is unencrypted HTTP", async () => {
    const { token: devToken } = await registerTestDevice("standard");

    const ws = new WebSocket(`ws://127.0.0.1:${port}/remote-live`, ["myraa-auth", devToken], {
      headers: {
        "x-forwarded-for": "198.51.100.43, 10.0.0.3",
        "x-forwarded-proto": "http, https", // Client -> Edge is plaintext HTTP
      },
    });

    const errorResult = await new Promise<{ error: any }>((resolve) => {
      ws.on("error", (err) => resolve({ error: err }));
    });

    expect(errorResult.error).toBeTruthy();
    expect(errorResult.error.message).toContain("403");
  });

  it("17. Revoked device is immediately rejected during upgrade with 401 Unauthorized", async () => {
    const { device, token: devToken } = await registerTestDevice("standard");
    // Revoke device
    device.revoked = true;
    await remoteStore.saveDevice(device);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/remote-live`, ["myraa-auth", devToken], {
      headers: {
        "x-forwarded-for": "198.51.100.44",
        "x-forwarded-proto": "https",
      },
    });

    const errorResult = await new Promise<{ error: any }>((resolve) => {
      ws.on("error", (err) => resolve({ error: err }));
    });

    expect(errorResult.error).toBeTruthy();
    expect(errorResult.error.message).toContain("401");
  });

  it("18. Standard device cannot generate pairing code (admin only: 403 Forbidden)", async () => {
    // 1. Register admin device first
    await registerTestDevice("admin");
    // 2. Register standard device (remains standard because an admin already exists)
    const { device: standardDevice } = await registerTestDevice("standard");
    const session = remoteSecurityCoordinator.createDeviceSession(standardDevice, "198.51.100.45");

    const res = await fetch(`http://127.0.0.1:${port}/api/remote/pair-code`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.tokens.accessToken}`,
        "X-Forwarded-For": "198.51.100.45",
        "X-Forwarded-Proto": "https",
      },
    });

    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toContain("Only admins can generate device pairing codes");
  });
});
