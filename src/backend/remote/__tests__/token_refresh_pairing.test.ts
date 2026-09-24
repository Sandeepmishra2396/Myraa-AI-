/**
 * MYRAA — Token Refresh & Admin Multi-Device Pairing Regression Tests
 *
 * Verifies:
 *   1. Authenticated admin with valid access token -> pair-code succeeds (201).
 *   2. Expired admin access token + valid refresh token -> refresh succeeds -> pair-code succeeds.
 *   3. Durable admin device token (sora_dev_...) -> pair-code succeeds (201).
 *   4. Standard / read-only device -> 403 Forbidden.
 *   5. Invalid or revoked token -> 401 Unauthorized.
 *   6. Refresh token replay attack -> 403 Forbidden (containment triggered).
 *   7. Zero secret leakage in responses.
 *   8. Durable device token fallback in POST /api/remote/token/refresh when in-memory session is wiped.
 *   9. Device auto-recovery in RemoteSessionManager when store record was lost across container restart.
 *   10. Strict invariant: Exactly 126 Gemini Live tools preserved in LIVE_TOOLS.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "http";
import crypto from "crypto";
import { remoteStore } from "../RemoteStore.ts";
import { pairingManager } from "../PairingManager.ts";
import { remoteSecurityCoordinator } from "../../security/RemoteSecurityCoordinator.ts";
import { identityAuthManager } from "../../security/IdentityAuthManager.ts";
import { remoteSessionManager } from "../RemoteSessionManager.ts";
import { threatContainmentManager } from "../../security/ThreatContainmentManager.ts";
import { createHttpApp } from "../../gateway/HttpGateway.ts";
import { LIVE_TOOLS } from "../../ai/GeminiSessionFactory.ts";
import type { PairedDevice } from "../RemoteTypes.ts";

describe("MYRAA Remote Token Refresh & Admin Pairing Protocol", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    await remoteStore.clearStore();
    identityAuthManager.resetForTesting();
    threatContainmentManager.resetForTesting();

    const app = createHttpApp();
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as any).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await remoteStore.clearStore();
    identityAuthManager.resetForTesting();
    threatContainmentManager.resetForTesting();
  });

  it("1. Authenticated admin with valid access token generates pairing PIN", async () => {
    const deviceId = "admin-device-1";
    const devToken = pairingManager.signDeviceToken(deviceId);
    const device: PairedDevice = {
      id: deviceId,
      name: "Android Companion Admin",
      deviceType: "mobile",
      role: "admin",
      tokenHash: pairingManager.hashToken(devToken),
      pairedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      revoked: false,
    };
    await remoteStore.saveDevice(device);

    const session = remoteSecurityCoordinator.createDeviceSession(device, "198.51.100.1");
    const accessToken = session.tokens.accessToken;

    const res = await fetch(`${baseUrl}/api/remote/pair-code`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "X-Forwarded-For": "198.51.100.1",
        "X-Forwarded-Proto": "https",
      },
    });

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.code).toHaveLength(6);
    expect(data.ttlSeconds).toBe(300);
    expect(data.expiresAt).toBeDefined();
  });

  it("2. Expired admin access token + valid refresh token -> refresh succeeds -> pair-code succeeds", async () => {
    const deviceId = "admin-device-2";
    const devToken = pairingManager.signDeviceToken(deviceId);
    const device: PairedDevice = {
      id: deviceId,
      name: "Android Companion Admin",
      deviceType: "mobile",
      role: "admin",
      tokenHash: pairingManager.hashToken(devToken),
      pairedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      revoked: false,
    };
    await remoteStore.saveDevice(device);

    const session = remoteSecurityCoordinator.createDeviceSession(device, "198.51.100.2");
    const initialAccessToken = session.tokens.accessToken;
    const initialRefreshToken = session.tokens.refreshToken;

    // Craft an expired access token from the same session
    const parts = initialAccessToken.slice("myraa_at_".length).split(".");
    const payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf-8"));
    payload.exp = Math.floor(Date.now() / 1000) - 60; // 1 minute in the past
    const expiredPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
    // Sign the expired payload
    const { getPersistentServerSecret } = await import("../../../../server_paths.ts");
    const sig = crypto.createHmac("sha256", getPersistentServerSecret()).update(expiredPayload).digest("base64url");
    const expiredAccessToken = `myraa_at_${expiredPayload}.${sig}`;

    // Step A: Expired access token is rejected with 401
    const failRes = await fetch(`${baseUrl}/api/remote/pair-code`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${expiredAccessToken}`,
        "X-Forwarded-For": "198.51.100.2",
        "X-Forwarded-Proto": "https",
      },
    });
    expect(failRes.status).toBe(401);
    const failData = await failRes.json();
    expect(failData.error).toContain("TOKEN_EXPIRED");

    // Step B: Client calls POST /api/remote/token/refresh
    const refreshRes = await fetch(`${baseUrl}/api/remote/token/refresh`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": "198.51.100.2",
        "X-Forwarded-Proto": "https",
      },
      body: JSON.stringify({ refreshToken: initialRefreshToken }),
    });
    expect(refreshRes.status).toBe(200);
    const refreshData = await refreshRes.json();
    expect(refreshData.success).toBe(true);
    expect(refreshData.accessToken).toBeDefined();
    expect(refreshData.refreshToken).toBeDefined();
    expect(refreshData.accessToken).not.toBe(initialAccessToken);

    // Step C: Client retries with freshly rotated access token -> succeeds!
    const successRes = await fetch(`${baseUrl}/api/remote/pair-code`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${refreshData.accessToken}`,
        "X-Forwarded-For": "198.51.100.2",
        "X-Forwarded-Proto": "https",
      },
    });
    expect(successRes.status).toBe(201);
    const pinData = await successRes.json();
    expect(pinData.code).toHaveLength(6);
  });

  it("3. Durable admin device token (sora_dev_...) generates pairing PIN directly", async () => {
    const deviceId = "admin-device-3";
    const devToken = pairingManager.signDeviceToken(deviceId);
    const device: PairedDevice = {
      id: deviceId,
      name: "Android Companion Admin",
      deviceType: "mobile",
      role: "admin",
      tokenHash: pairingManager.hashToken(devToken),
      pairedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      revoked: false,
    };
    await remoteStore.saveDevice(device);

    const res = await fetch(`${baseUrl}/api/remote/pair-code`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${devToken}`,
        "X-Forwarded-For": "198.51.100.3",
        "X-Forwarded-Proto": "https",
      },
    });

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.code).toHaveLength(6);
    expect(data.ttlSeconds).toBe(300);
  });

  it("4. Non-admin (standard) device is forbidden from generating pair-codes (HTTP 403)", async () => {
    // 1. Register existing admin device so standard device is not sole device
    const adminDev: PairedDevice = {
      id: "admin-device-4-existing",
      name: "Admin Device",
      deviceType: "mobile",
      role: "admin",
      tokenHash: "admin-hash-4",
      pairedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      revoked: false,
    };
    await remoteStore.saveDevice(adminDev);

    // 2. Register secondary standard device
    const deviceId = "standard-device-4";
    const devToken = pairingManager.signDeviceToken(deviceId);
    const device: PairedDevice = {
      id: deviceId,
      name: "Standard Client",
      deviceType: "browser",
      role: "standard",
      tokenHash: pairingManager.hashToken(devToken),
      pairedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      revoked: false,
    };
    await remoteStore.saveDevice(device);

    // Test with device token
    const res = await fetch(`${baseUrl}/api/remote/pair-code`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${devToken}`,
        "X-Forwarded-For": "198.51.100.4",
        "X-Forwarded-Proto": "https",
      },
    });
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toContain("Forbidden: Only admins can generate device pairing codes.");

    // Test with access token for standard device
    const session = remoteSecurityCoordinator.createDeviceSession(device, "198.51.100.4");
    const resAt = await fetch(`${baseUrl}/api/remote/pair-code`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.tokens.accessToken}`,
        "X-Forwarded-For": "198.51.100.4",
        "X-Forwarded-Proto": "https",
      },
    });
    expect(resAt.status).toBe(403);
  });

  it("5. Invalid or revoked tokens return HTTP 401 Unauthorized", async () => {
    // Malformed token
    const resBad = await fetch(`${baseUrl}/api/remote/pair-code`, {
      method: "POST",
      headers: {
        Authorization: "Bearer completely_bogus_token",
        "X-Forwarded-For": "198.51.100.5",
        "X-Forwarded-Proto": "https",
      },
    });
    expect(resBad.status).toBe(401);

    // Revoked device
    const deviceId = "revoked-device-5";
    const devToken = pairingManager.signDeviceToken(deviceId);
    const device: PairedDevice = {
      id: deviceId,
      name: "Revoked Device",
      deviceType: "mobile",
      role: "admin",
      tokenHash: pairingManager.hashToken(devToken),
      pairedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      revoked: true,
    };
    await remoteStore.saveDevice(device);

    const resRevoked = await fetch(`${baseUrl}/api/remote/pair-code`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${devToken}`,
        "X-Forwarded-For": "198.51.100.5",
        "X-Forwarded-Proto": "https",
      },
    });
    expect(resRevoked.status).toBe(401);
  });

  it("6. Refresh token replay attack triggers threat containment and 403 Forbidden", async () => {
    const deviceId = "admin-device-6";
    const devToken = pairingManager.signDeviceToken(deviceId);
    const device: PairedDevice = {
      id: deviceId,
      name: "Admin Device",
      deviceType: "mobile",
      role: "admin",
      tokenHash: pairingManager.hashToken(devToken),
      pairedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      revoked: false,
    };
    await remoteStore.saveDevice(device);

    const session = remoteSecurityCoordinator.createDeviceSession(device, "198.51.100.6");
    const originalRefreshToken = session.tokens.refreshToken;

    // First rotation succeeds
    const rotate1 = await fetch(`${baseUrl}/api/remote/token/refresh`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": "198.51.100.6",
        "X-Forwarded-Proto": "https",
      },
      body: JSON.stringify({ refreshToken: originalRefreshToken }),
    });
    expect(rotate1.status).toBe(200);

    // Second rotation using the already consumed refresh token -> REPLAY ATTACK!
    const replayRes = await fetch(`${baseUrl}/api/remote/token/refresh`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": "198.51.100.6",
        "X-Forwarded-Proto": "https",
      },
      body: JSON.stringify({ refreshToken: originalRefreshToken }),
    });
    expect(replayRes.status).toBe(403);
    const replayData = await replayRes.json();
    expect(replayData.error).toContain("TOKEN_REPLAY_DETECTED");
  });

  it("7. Zero secret leakage across all endpoints", async () => {
    const deviceId = "admin-device-7";
    const devToken = pairingManager.signDeviceToken(deviceId);
    const device: PairedDevice = {
      id: deviceId,
      name: "Admin Device",
      deviceType: "mobile",
      role: "admin",
      tokenHash: pairingManager.hashToken(devToken),
      pairedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      revoked: false,
    };
    await remoteStore.saveDevice(device);

    const { getPersistentServerSecret } = await import("../../../../server_paths.ts");
    const serverSecret = getPersistentServerSecret();

    // POST /api/remote/pair-code
    const res1 = await fetch(`${baseUrl}/api/remote/pair-code`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${devToken}`,
        "X-Forwarded-For": "198.51.100.7",
        "X-Forwarded-Proto": "https",
      },
    });
    const body1 = await res1.text();
    expect(body1).not.toContain(serverSecret);

    // POST /api/remote/token/refresh
    const res2 = await fetch(`${baseUrl}/api/remote/token/refresh`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": "198.51.100.7",
        "X-Forwarded-Proto": "https",
      },
      body: JSON.stringify({ deviceToken: devToken }),
    });
    const body2 = await res2.text();
    expect(body2).not.toContain(serverSecret);
  });

  it("8. Durable device token fallback re-establishes session when in-memory session is wiped", async () => {
    const deviceId = "admin-device-8";
    const devToken = pairingManager.signDeviceToken(deviceId);
    const device: PairedDevice = {
      id: deviceId,
      name: "Android Companion Admin",
      deviceType: "mobile",
      role: "admin",
      tokenHash: pairingManager.hashToken(devToken),
      pairedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      revoked: false,
    };
    await remoteStore.saveDevice(device);

    // Establish initial session
    const session = remoteSecurityCoordinator.createDeviceSession(device, "198.51.100.8");
    const oldRefreshToken = session.tokens.refreshToken;

    // Simulate server restart: in-memory maps in IdentityAuthManager are wiped
    identityAuthManager.resetForTesting();

    // Attempting refresh with old in-memory refreshToken alone fails
    const failRefresh = await fetch(`${baseUrl}/api/remote/token/refresh`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": "198.51.100.8",
        "X-Forwarded-Proto": "https",
      },
      body: JSON.stringify({ refreshToken: oldRefreshToken }),
    });
    expect(failRefresh.status).toBe(401);

    // Refresh with both refreshToken and durable deviceToken succeeds via fallback re-establishment!
    const reestablished = await fetch(`${baseUrl}/api/remote/token/refresh`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": "198.51.100.8",
        "X-Forwarded-Proto": "https",
      },
      body: JSON.stringify({
        refreshToken: oldRefreshToken,
        deviceToken: devToken,
      }),
    });
    expect(reestablished.status).toBe(200);
    const data = await reestablished.json();
    expect(data.success).toBe(true);
    expect(data.accessToken).toBeDefined();
    expect(data.refreshToken).toBeDefined();

    // New access token works for pair-code
    const pairRes = await fetch(`${baseUrl}/api/remote/pair-code`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${data.accessToken}`,
        "X-Forwarded-For": "198.51.100.8",
        "X-Forwarded-Proto": "https",
      },
    });
    expect(pairRes.status).toBe(201);
  });

  it("9. Authentically signed device token auto-recovers device registration if store was wiped", async () => {
    const deviceId = "auto-recovered-device-9";
    const devToken = pairingManager.signDeviceToken(deviceId);

    // Notice: We do NOT put the device in remoteStore! Store is completely empty!
    expect((await remoteStore.listDevices()).length).toBe(0);

    // Calling authenticateToken restores the device
    const authedDevice = await remoteSessionManager.authenticateToken(devToken, "198.51.100.9", "Android Companion");
    expect(authedDevice).not.toBeNull();
    expect(authedDevice?.id).toBe(deviceId);
    expect(authedDevice?.role).toBe("admin");

    // The device is now safely persisted in remoteStore
    const stored = await remoteStore.getDevice(deviceId);
    expect(stored).toBeDefined();
    expect(stored?.id).toBe(deviceId);
    expect(stored?.role).toBe("admin");

    // Can generate pair-code via HTTP
    const res = await fetch(`${baseUrl}/api/remote/pair-code`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${devToken}`,
        "X-Forwarded-For": "198.51.100.9",
        "X-Forwarded-Proto": "https",
      },
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.code).toHaveLength(6);
  });

  it("10. Strict invariant: Exactly 126 Gemini Live tools preserved in LIVE_TOOLS", () => {
    expect(LIVE_TOOLS).toBeDefined();
    expect(LIVE_TOOLS[0].functionDeclarations).toHaveLength(126);
    const names = new Set(LIVE_TOOLS[0].functionDeclarations.map((t) => t.name));
    expect(names.size).toBe(126);
  });
});
