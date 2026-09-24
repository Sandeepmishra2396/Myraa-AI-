/**
 * MYRAA — Phase 17 Secure Android ↔ MYRAA Core Communication Test Suite
 *
 * Comprehensive validation of:
 *   1. Device Authentication & Session Binding (Short-lived tokens, device tokens, session binding)
 *   2. Session Lifecycle & Role Propagation (TTL, roles: admin, standard, read_only)
 *   3. Token Rotation & Replay Attack Defense (Rotating refresh tokens, token family invalidation)
 *   4. Device Revocation & Immediate Session Invalidation (Store, IdentityAuthManager, WebSockets)
 *   5. Reconnect Handling & Expiration Resilience
 *   6. Anti-Replay Protection (Cryptographic Nonces & Timestamps)
 *   7. Network Security & Transport Enforcement (TLS/WSS validation)
 *   8. Remote Anomaly Detection & Threat Containment Pipeline
 *   9. Zero Secret / Token Leakage in Audit Trails
 *   10. Security Lockdown Enforcement on Remote Connections
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  identityAuthManager,
  securityPolicyEngine,
  securityAuditLogger,
  threatContainmentManager,
  remoteSecurityCoordinator,
  type SecurityContext,
} from "../index.ts";
import { remoteStore } from "../../remote/RemoteStore.ts";
import { pairingManager } from "../../remote/PairingManager.ts";
import { remoteSessionManager } from "../../remote/RemoteSessionManager.ts";
import type { PairedDevice } from "../../remote/RemoteTypes.ts";

describe("Phase 17 — Secure Android ↔ MYRAA Core Communication", () => {
  beforeEach(async () => {
    identityAuthManager.resetForTesting();
    securityPolicyEngine.resetForTesting();
    securityAuditLogger.resetForTesting();
    threatContainmentManager.resetForTesting();
    remoteSecurityCoordinator.resetForTesting();
    await remoteStore.clearStore();
  });

  // Helper to create and persist a test device
  async function createTestDevice(overrides: Partial<PairedDevice> = {}): Promise<PairedDevice> {
    const device: PairedDevice = {
      id: overrides.id || `dev_${Math.random().toString(36).slice(2, 10)}`,
      name: overrides.name || "Pixel 9 Pro Companion",
      deviceType: overrides.deviceType || "mobile",
      role: overrides.role || "standard",
      tokenHash: overrides.tokenHash || "dummy_token_hash",
      pairedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      lastIp: "192.168.1.150",
      revoked: overrides.revoked ?? false,
      userAgent: "MYRAA-Android-Companion/1.0",
      ...overrides,
    };
    await remoteStore.saveDevice(device);
    return device;
  }

  // ── 1. Device Authentication & Session Binding ─────────────────────────────
  describe("1. Device Authentication & Session Binding", () => {
    it("authenticates a remote device using a valid short-lived access token", async () => {
      const device = await createTestDevice();
      const { session, tokens } = identityAuthManager.createSession({
        deviceId: device.id,
        identityId: `device:${device.id}`,
        role: "standard",
        ipAddress: "192.168.1.150",
      });

      const auth = await remoteSecurityCoordinator.authenticateRemoteCredential(
        tokens.accessToken,
        "192.168.1.150",
        "MYRAA-Android/1.0",
      );

      expect(auth.authenticated).toBe(true);
      expect(auth.device?.id).toBe(device.id);
      expect(auth.session?.sessionId).toBe(session.sessionId);
      expect(auth.session?.deviceId).toBe(device.id);
    });

    it("supports Bearer authorization header format", async () => {
      const device = await createTestDevice();
      const { tokens } = identityAuthManager.createSession({
        deviceId: device.id,
        identityId: `device:${device.id}`,
        role: "standard",
        ipAddress: "192.168.1.150",
      });

      const auth = await remoteSecurityCoordinator.authenticateRemoteCredential(
        `Bearer ${tokens.accessToken}`,
        "192.168.1.150",
      );

      expect(auth.authenticated).toBe(true);
      expect(auth.device?.id).toBe(device.id);
    });

    it("authenticates a remote device using signed pairing device token", async () => {
      const { code } = pairingManager.generatePairCode("127.0.0.1");
      const pairRes = await pairingManager.pairDevice({
        code,
        deviceName: "Samsung Galaxy S24",
        ipAddress: "192.168.1.155",
      });

      const auth = await remoteSecurityCoordinator.authenticateRemoteCredential(
        pairRes.token,
        "192.168.1.155",
      );

      expect(auth.authenticated).toBe(true);
      expect(auth.device?.id).toBe(pairRes.device.id);
      expect(auth.session).toBeDefined();
      expect(auth.session?.deviceId).toBe(pairRes.device.id);
    });

    it("rejects authentication with empty or missing token", async () => {
      const auth1 = await remoteSecurityCoordinator.authenticateRemoteCredential("");
      expect(auth1.authenticated).toBe(false);
      expect(auth1.error).toContain("INVALID_CREDENTIAL");

      const auth2 = await remoteSecurityCoordinator.authenticateRemoteCredential("   ");
      expect(auth2.authenticated).toBe(false);
    });

    it("rejects authentication with unrecognized token type", async () => {
      const auth = await remoteSecurityCoordinator.authenticateRemoteCredential("random_garbage_token");
      expect(auth.authenticated).toBe(false);
      expect(auth.error).toContain("UNSUPPORTED_TOKEN_TYPE");
    });

    it("rejects authentication when access token is forged or invalid HMAC", async () => {
      const device = await createTestDevice();
      const { tokens } = identityAuthManager.createSession({
        deviceId: device.id,
        identityId: `device:${device.id}`,
        role: "standard",
        ipAddress: "192.168.1.150",
      });

      const tampered = tokens.accessToken.slice(0, -6) + "xxxxxx";
      const auth = await remoteSecurityCoordinator.authenticateRemoteCredential(tampered);

      expect(auth.authenticated).toBe(false);
      expect(auth.error).toContain("INVALID_SIGNATURE");
    });

    it("rejects authentication when device has been marked revoked", async () => {
      const device = await createTestDevice({ revoked: true, revokedReason: "Stolen device" });
      const { tokens } = identityAuthManager.createSession({
        deviceId: device.id,
        identityId: `device:${device.id}`,
        role: "standard",
        ipAddress: "192.168.1.150",
      });

      const auth = await remoteSecurityCoordinator.authenticateRemoteCredential(tokens.accessToken);
      expect(auth.authenticated).toBe(false);
      expect(auth.error).toContain("DEVICE_REVOKED");
    });
  });

  // ── 2. Session Management & Role Propagation ──────────────────────────────
  describe("2. Session Management & Role Propagation", () => {
    it("creates a device session with proper role mapping and short TTL", async () => {
      const adminDevice = await createTestDevice({ role: "admin" });
      const devSession = remoteSecurityCoordinator.createDeviceSession(adminDevice, "192.168.1.160");

      expect(devSession.device.id).toBe(adminDevice.id);
      expect(devSession.session.role).toBe("admin");
      expect(devSession.tokens.accessToken.startsWith("myraa_at_")).toBe(true);
      expect(devSession.tokens.expiresInSeconds).toBe(900); // 15 minutes
    });

    it("propagates read_only and standard roles correctly", async () => {
      const roDevice = await createTestDevice({ role: "read_only" });
      const roSession = remoteSecurityCoordinator.createDeviceSession(roDevice, "192.168.1.161");
      expect(roSession.session.role).toBe("read_only");

      const stdDevice = await createTestDevice({ role: "standard" });
      const stdSession = remoteSecurityCoordinator.createDeviceSession(stdDevice, "192.168.1.162");
      expect(stdSession.session.role).toBe("standard");
    });

    it("prevents creating session for an already revoked device", async () => {
      const revokedDev = await createTestDevice({ revoked: true });
      expect(() => {
        remoteSecurityCoordinator.createDeviceSession(revokedDev, "192.168.1.163");
      }).toThrow("DEVICE_REVOKED");
    });
  });

  // ── 3. Token Rotation & Strict Replay Attack Defense ──────────────────────
  describe("3. Token Rotation & Strict Replay Attack Defense", () => {
    it("rotates session credentials and invalidates the previous refresh token", async () => {
      const device = await createTestDevice();
      const devSession = remoteSecurityCoordinator.createDeviceSession(device, "192.168.1.170");

      const rotated = await remoteSecurityCoordinator.rotateSessionToken(
        devSession.tokens.refreshToken,
        "192.168.1.170",
      );

      expect(rotated.tokens.accessToken).toBeDefined();
      expect(rotated.tokens.refreshToken).toBeDefined();
      expect(rotated.tokens.refreshToken).not.toBe(devSession.tokens.refreshToken);
      expect(rotated.session.sessionId).toBe(devSession.session.sessionId);

      // New access token validates successfully
      const val = identityAuthManager.validateAccessToken(rotated.tokens.accessToken, "192.168.1.170");
      expect(val.valid).toBe(true);
    });

    it("detects replay attack when old refresh token is reused, revoking family and reporting threat", async () => {
      const device = await createTestDevice();
      const devSession = remoteSecurityCoordinator.createDeviceSession(device, "192.168.1.171");
      const firstRefreshToken = devSession.tokens.refreshToken;

      // Legitimate rotation 1
      const rotated1 = await remoteSecurityCoordinator.rotateSessionToken(
        firstRefreshToken,
        "192.168.1.171",
      );
      expect(rotated1.tokens.refreshToken).toBeDefined();

      // Adversary replays firstRefreshToken
      let caughtError: any;
      try {
        await remoteSecurityCoordinator.rotateSessionToken(firstRefreshToken, "192.168.1.171");
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBeDefined();
      expect(caughtError.message).toMatch(/(REPLAY_ATTACK_DETECTED|TOKEN_REPLAY_DETECTED)/);

      // Verify the session has been revoked completely
      const val = identityAuthManager.validateAccessToken(rotated1.tokens.accessToken, "192.168.1.171");
      expect(val.valid).toBe(false);

      // Verify security audit logged the replay detection
      const logs = securityAuditLogger.getRecentEvents(50).filter((e) => e.eventType === "TOKEN_REPLAY_DETECTED");
      expect(logs.length).toBeGreaterThan(0);
      expect(logs[0].riskLevel).toBe("CRITICAL");
    });
  });

  // ── 4. Device Revocation & Immediate Session Invalidation ─────────────────
  describe("4. Device Revocation & Immediate Session Invalidation", () => {
    it("revokes device server-side, tearing down sessions and blocking further access", async () => {
      const device = await createTestDevice();
      const devSession = remoteSecurityCoordinator.createDeviceSession(device, "192.168.1.180");

      // Verify initial session works
      const authBefore = await remoteSecurityCoordinator.authenticateRemoteCredential(
        devSession.tokens.accessToken,
        "192.168.1.180",
      );
      expect(authBefore.authenticated).toBe(true);

      // Operator revokes device
      const revoked = await remoteSecurityCoordinator.revokeRemoteDevice(
        device.id,
        "User lost device in transit",
      );
      expect(revoked).toBe(true);

      // Device status in store is revoked
      const updatedDevice = await remoteStore.getDevice(device.id);
      expect(updatedDevice?.revoked).toBe(true);
      expect(updatedDevice?.revokedReason).toBe("User lost device in transit");

      // Subsequent authentication with access token is rejected
      const authAfter = await remoteSecurityCoordinator.authenticateRemoteCredential(
        devSession.tokens.accessToken,
        "192.168.1.180",
      );
      expect(authAfter.authenticated).toBe(false);
      expect(authAfter.error).toMatch(/(DEVICE_REVOKED|SESSION_REVOKED)/);

      // Token rotation attempt is also rejected
      await expect(
        remoteSecurityCoordinator.rotateSessionToken(devSession.tokens.refreshToken, "192.168.1.180"),
      ).rejects.toThrow();

      // Audit log records revocation
      const audit = securityAuditLogger.getRecentEvents(50).filter((e) => e.eventType === "DEVICE_REVOKED");
      expect(audit.length).toBeGreaterThan(0);
      expect(audit[0].decision).toBe("REVOKE");
      expect(audit[0].actor.deviceId).toBe(device.id);
    });

    it("returns false gracefully when revoking a non-existent device", async () => {
      const revoked = await remoteSecurityCoordinator.revokeRemoteDevice("non_existent_id");
      expect(revoked).toBe(false);
    });
  });

  // ── 5. Replay Protection: Nonce & Timestamp Validation ─────────────────────
  describe("5. Replay Protection: Nonce & Timestamp Validation", () => {
    it("accepts a fresh, unique cryptographic nonce within timestamp tolerance", () => {
      const nonce = "nonce_abc12345xyz";
      const now = Date.now();
      const result = remoteSecurityCoordinator.validateRequestNonce(nonce, now);
      expect(result.valid).toBe(true);
    });

    it("rejects duplicate nonce within the sliding window", () => {
      const nonce = "duplicate_nonce_999";
      const now = Date.now();

      const first = remoteSecurityCoordinator.validateRequestNonce(nonce, now);
      expect(first.valid).toBe(true);

      const second = remoteSecurityCoordinator.validateRequestNonce(nonce, now);
      expect(second.valid).toBe(false);
      expect(second.error).toContain("REPLAY_ATTACK_DETECTED");

      // Check audit log
      const audit = securityAuditLogger.getRecentEvents(50).filter((e) => e.eventType === "TOKEN_REPLAY_DETECTED");
      expect(audit.length).toBeGreaterThan(0);
      expect(audit[0].decision).toBe("BLOCK");
    });

    it("rejects requests with stale timestamps (>60s old)", () => {
      const nonce = "stale_nonce_123456";
      const staleTimestamp = Date.now() - 65_000; // 65 seconds old
      const result = remoteSecurityCoordinator.validateRequestNonce(nonce, staleTimestamp);

      expect(result.valid).toBe(false);
      expect(result.error).toContain("timestamp is stale");
    });

    it("rejects invalid or too short nonces", () => {
      const result1 = remoteSecurityCoordinator.validateRequestNonce("", Date.now());
      expect(result1.valid).toBe(false);

      const result2 = remoteSecurityCoordinator.validateRequestNonce("short", Date.now());
      expect(result2.valid).toBe(false);
      expect(result2.error).toContain("min 8 chars");
    });
  });

  // ── 6. Network Security & Transport Verification ───────────────────────────
  describe("6. Network Security & Transport Verification", () => {
    it("allows loopback / localhost connections on any protocol", () => {
      expect(remoteSecurityCoordinator.validateTransport("127.0.0.1", "http:")).toBe(true);
      expect(remoteSecurityCoordinator.validateTransport("::1", "ws:")).toBe(true);
      expect(remoteSecurityCoordinator.validateTransport("::ffff:127.0.0.1", "ws:")).toBe(true);
    });

    it("enforces TLS/WSS for remote non-loopback clients", () => {
      // Non-TLS on external IP
      const insecureHttp = remoteSecurityCoordinator.validateTransport("192.168.1.200", "http:");
      expect(insecureHttp).toBe(false);

      const insecureWs = remoteSecurityCoordinator.validateTransport("10.0.0.50", "ws:");
      expect(insecureWs).toBe(false);

      // TLS on external IP
      const secureHttps = remoteSecurityCoordinator.validateTransport("192.168.1.200", "https:");
      expect(secureHttps).toBe(true);

      const secureWss = remoteSecurityCoordinator.validateTransport("10.0.0.50", "wss:");
      expect(secureWss).toBe(true);
    });
  });

  // ── 7. Remote Anomaly Detection & Threat Containment ───────────────────────
  describe("7. Remote Anomaly Detection & Threat Containment", () => {
    it("allows normal message rate within threshold", () => {
      const actor = { ipAddress: "192.168.1.210", deviceId: "dev_normal" };
      for (let i = 0; i < 30; i++) {
        const allowed = remoteSecurityCoordinator.recordRemoteActivity("dev_normal", actor);
        expect(allowed).toBe(true);
      }
    });

    it("detects burst activity, exceeds rate threshold, and dispatches containment threat", () => {
      const actor = { ipAddress: "192.168.1.211", deviceId: "dev_spammer" };
      let blockedCount = 0;

      // Burst 60 requests in the same 10-second window (threshold is 50)
      for (let i = 0; i < 60; i++) {
        const allowed = remoteSecurityCoordinator.recordRemoteActivity("dev_spammer", actor);
        if (!allowed) blockedCount++;
      }

      expect(blockedCount).toBeGreaterThan(0);

      // Verify containment pipeline received the threat
      const containments = threatContainmentManager.getAllContainments();
      const anomalyContainment = containments.find((c) => c.threatName === "SUSPICIOUS_REMOTE_ACTIVITY");
      expect(anomalyContainment).toBeDefined();
    });
  });

  // ── 8. Zero Secret / Token Leakage in Audit Trails ─────────────────────────
  describe("8. Zero Secret / Token Leakage in Audit Trails", () => {
    it("ensures raw access tokens and refresh tokens never appear in audit log text", async () => {
      const device = await createTestDevice();
      const devSession = remoteSecurityCoordinator.createDeviceSession(device, "192.168.1.220");
      const accessToken = devSession.tokens.accessToken;
      const refreshToken = devSession.tokens.refreshToken;

      // Authenticate
      await remoteSecurityCoordinator.authenticateRemoteCredential(accessToken, "192.168.1.220");

      // Rotate
      const rotated = await remoteSecurityCoordinator.rotateSessionToken(refreshToken, "192.168.1.220");

      // Revoke
      await remoteSecurityCoordinator.revokeRemoteDevice(device.id, "Audit leakage check");

      // Scan all audit log entries
      const allEvents = securityAuditLogger.getRecentEvents(100);
      expect(allEvents.length).toBeGreaterThan(0);

      for (const event of allEvents) {
        const eventStr = JSON.stringify(event);
        expect(eventStr).not.toContain(accessToken);
        expect(eventStr).not.toContain(refreshToken);
        expect(eventStr).not.toContain(rotated.tokens.accessToken);
        expect(eventStr).not.toContain(rotated.tokens.refreshToken);
      }
    });
  });

  // ── 9. Security Policy Engine Lockdown Integration ─────────────────────────
  describe("9. Security Policy Engine Lockdown Integration", () => {
    it("fails closed when security policy engine is in LOCKDOWN mode", async () => {
      securityPolicyEngine.setMode("LOCKDOWN");
      expect(securityPolicyEngine.getMode()).toBe("LOCKDOWN");

      // When in lockdown, tool execution firewall rejects execution
      const secCtx: SecurityContext = {
        identityId: "user_operator",
        role: "admin",
        sessionId: "sess_lockdown_test",
        ipAddress: "127.0.0.1",
        isLocal: true,
      };

      const evalResult = await securityPolicyEngine.evaluateRequest("read_file", { path: "test.txt" }, secCtx);
      expect(evalResult.decision).toBe("BLOCK");
      expect(evalResult.reason).toContain("LOCKDOWN");
    });
  });
});
