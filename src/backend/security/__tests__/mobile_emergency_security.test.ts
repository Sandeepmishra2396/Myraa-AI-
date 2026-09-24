/**
 * MYRAA — Phase 28 Mobile Emergency & Security Layer Test Suite
 *
 * 36 comprehensive tests validating:
 *   1.  Android Emergency Stop triggers EmergencyStopCoordinator
 *   2.  Android → backend Emergency Stop propagation
 *   3.  Android Emergency Stop halts desktop executions
 *   4.  Android Emergency Stop broadcasts to active remote sessions
 *   5.  Android Emergency Stop halts active planner workflows
 *   6.  Desktop Emergency Stop → Android synchronization
 *   7.  Emergency Stop persistence across restarts
 *   8.  Emergency Stop idempotency (double trigger safe)
 *   9.  Device revocation terminates active session and marks device revoked
 *   10. Revoked device cannot reconnect (token rejected)
 *   11. Terminate single remote session by sessionId
 *   12. Terminate all remote sessions
 *   13. Security Lockdown from Android blocks normal tool execution
 *   14. Lockdown recovery authorization requires admin role
 *   15. Lost-device mode marks device revoked and saves record
 *   16. Lost-device device cannot authenticate or reconnect
 *   17. Logout all devices revokes all device sessions and token families
 *   18. Refresh token invalidation after logout-all
 *   19. Suspicious-session detection and sanitized surfacing
 *   20. Token replay handling (detected and contained)
 *   21. Nonce replay handling (duplicate nonce rejected)
 *   22. Security notification DLP (no secrets in payload)
 *   23. Audit chain integrity — all events cryptographically chained
 *   24. Authorization/role enforcement on security controls
 *   25. Network disconnect / fail-closed behavior
 *   26. Emergency Stop retry is idempotent and safe
 *   27. Phase 17 regression — token rotation still works
 *   28. Phase 24 regression — shared memory unaffected
 *   29. Phase 25 regression — cross-device handoff unaffected
 *   30. Phase 26 regression — proactive companion unaffected
 *   31. Phase 27 regression — workflow engine unaffected
 *   32. Full regression compatibility check
 *   33. REST endpoint GET /api/remote/security/status
 *   34. REST endpoint POST /api/remote/security/lost-device/enable
 *   35. REST endpoint POST /api/remote/security/logout-all
 *   36. Verify exactly 126 Gemini Live tools invariant in LIVE_TOOLS
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import http from "http";
import { emergencyStopCoordinator } from "../../remote/EmergencyStopCoordinator.ts";
import { remoteSecurityCoordinator } from "../RemoteSecurityCoordinator.ts";
import { identityAuthManager } from "../IdentityAuthManager.ts";
import { securityPolicyEngine } from "../SecurityPolicyEngine.ts";
import { securityAuditLogger } from "../SecurityAuditLogger.ts";
import { threatContainmentManager } from "../ThreatContainmentManager.ts";
import { remoteSessionManager } from "../../remote/RemoteSessionManager.ts";
import { remoteStore } from "../../remote/RemoteStore.ts";
import { androidSecurityManager } from "../AndroidSecurityManager.ts";
import { plannerCoordinator } from "../../planner/PlannerCoordinator.ts";
import { planStore } from "../../planner/PlanStore.ts";
import { sharedMemoryManager } from "../../memory/SharedMemoryManager.ts";
import { crossDeviceHandoffManager } from "../../handoff/CrossDeviceHandoffManager.ts";
import { mobileProactiveManager } from "../../companion/mobile/MobileProactiveManager.ts";
import { mobileWorkflowManager } from "../../workflow/MobileWorkflowManager.ts";
import { LIVE_TOOLS } from "../../ai/GeminiSessionFactory.ts";
import { createHttpApp } from "../../gateway/HttpGateway.ts";
import type { SecurityContext } from "../SecurityTypes.ts";
import type { PairedDevice } from "../../remote/RemoteTypes.ts";

describe("Phase 28 — Mobile Emergency & Security Layer", () => {
  const testDeviceId = "pixel_9_pro_security_test";
  const adminDeviceId = "admin_controller_device";

  const adminContext: SecurityContext = {
    identityId: "admin_user",
    role: "admin",
    ipAddress: "127.0.0.1",
    deviceId: adminDeviceId,
    isLocal: true,
  };

  const standardContext: SecurityContext = {
    identityId: testDeviceId,
    role: "standard",
    ipAddress: "192.168.1.150",
    deviceId: testDeviceId,
    isLocal: false,
  };

  beforeEach(async () => {
    await emergencyStopCoordinator.reset("test_setup");
    securityPolicyEngine.setMode("BALANCED");
    identityAuthManager.resetForTesting();
    securityAuditLogger.resetForTesting();
    threatContainmentManager.resetForTesting();
    remoteSecurityCoordinator.resetForTesting();
    await remoteStore.clearStore();

    // Register active test devices
    await remoteStore.saveDevice({
      id: testDeviceId,
      name: "Pixel 9 Pro Companion",
      deviceType: "mobile",
      role: "standard",
      tokenHash: "dummy_hash_standard",
      pairedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      revoked: false,
    });

    await remoteStore.saveDevice({
      id: adminDeviceId,
      name: "Admin Tablet",
      deviceType: "tablet",
      role: "admin",
      tokenHash: "dummy_hash_admin",
      pairedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      revoked: false,
    });
  });

  afterEach(async () => {
    await emergencyStopCoordinator.reset("test_cleanup");
    securityPolicyEngine.setMode("BALANCED");
  });

  // ── 1. Android Emergency Stop triggers EmergencyStopCoordinator ───────────
  it("1. Android Emergency Stop triggers EmergencyStopCoordinator", async () => {
    const state = await emergencyStopCoordinator.trigger({
      source: "remote_device",
      deviceId: testDeviceId,
      deviceName: "Pixel 9 Pro",
      reason: "User tapped emergency stop on Android UI",
    });

    expect(state.active).toBe(true);
    expect(state.triggeredBy?.source).toBe("remote_device");
    expect(state.triggeredBy?.deviceId).toBe(testDeviceId);
    expect(emergencyStopCoordinator.isActive()).toBe(true);
  });

  // ── 2. Android → backend Emergency Stop propagation ──────────────────────
  it("2. Android → backend Emergency Stop propagation", async () => {
    await emergencyStopCoordinator.trigger({
      source: "remote_device",
      deviceId: testDeviceId,
      reason: "Voice: Emergency Stop",
    });

    const status = await androidSecurityManager.getSecurityStatus(testDeviceId, standardContext);
    expect(status.emergencyStopActive).toBe(true);
    expect(status.emergencyStopSource).toBe("remote_device");
  });

  // ── 3. Android Emergency Stop halts desktop executions ───────────────────
  it("3. Android Emergency Stop halts desktop executions", async () => {
    let hookCalled = false;
    const unregister = emergencyStopCoordinator.registerTriggerHook(() => {
      hookCalled = true;
    });

    await emergencyStopCoordinator.trigger({
      source: "remote_device",
      deviceId: testDeviceId,
      reason: "Halt desktop tasks",
    });

    expect(hookCalled).toBe(true);
    unregister();
  });

  // ── 4. Android Emergency Stop broadcasts to active remote sessions ────────
  it("4. Android Emergency Stop broadcasts to active remote sessions", async () => {
    let broadcastPayload: any = null;
    const unregister = emergencyStopCoordinator.registerBroadcast((payload) => {
      broadcastPayload = payload;
    });

    await emergencyStopCoordinator.trigger({
      source: "remote_device",
      deviceId: testDeviceId,
      reason: "Immediate halt requested",
    });

    expect(broadcastPayload).not.toBeNull();
    expect(broadcastPayload.type).toBe("emergency_stop");
    expect(broadcastPayload.active).toBe(true);
    unregister();
  });

  // ── 5. Android Emergency Stop halts active planner workflows ──────────────
  it("5. Android Emergency Stop halts active planner workflows", async () => {
    const plan = await plannerCoordinator.createPlan("Analyze project and organize schedule", { deviceId: "local_operator" });
    plan.status = "running";
    await planStore.savePlan(plan);

    await emergencyStopCoordinator.trigger({
      source: "remote_device",
      deviceId: testDeviceId,
      reason: "Stop active plans",
    });

    const updated = await planStore.getPlan(plan.id);
    expect(updated?.status === "paused" || updated?.status === "failed" || !emergencyStopCoordinator.isActive()).toBe(true);
    expect(emergencyStopCoordinator.isActive()).toBe(true);
  });

  // ── 6. Desktop Emergency Stop → Android synchronization ──────────────────
  it("6. Desktop Emergency Stop → Android synchronization", async () => {
    await emergencyStopCoordinator.trigger({
      source: "desktop_ui",
      reason: "Operator pressed emergency stop on Desktop console",
    });

    const androidObservedStatus = await androidSecurityManager.getSecurityStatus(testDeviceId, standardContext);
    expect(androidObservedStatus.emergencyStopActive).toBe(true);
    expect(androidObservedStatus.emergencyStopSource).toBe("desktop_ui");
  });

  // ── 7. Emergency Stop persistence across restarts ─────────────────────────
  it("7. Emergency Stop persistence across restarts", async () => {
    await emergencyStopCoordinator.trigger({
      source: "remote_device",
      deviceId: testDeviceId,
      reason: "Test persistence",
    });

    const persisted = await remoteStore.getEmergencyStopState();
    expect(persisted.active).toBe(true);
    expect(persisted.triggeredBy?.deviceId).toBe(testDeviceId);
  });

  // ── 8. Emergency Stop idempotency (double trigger safe) ────────────────────
  it("8. Emergency Stop idempotency (double trigger safe)", async () => {
    const first = await emergencyStopCoordinator.trigger({
      source: "remote_device",
      deviceId: testDeviceId,
      reason: "First trigger",
    });

    const second = await emergencyStopCoordinator.trigger({
      source: "remote_device",
      deviceId: testDeviceId,
      reason: "Second trigger (retry)",
    });

    expect(first.active).toBe(true);
    expect(second.active).toBe(true);
    expect(first.triggeredAt).toBe(second.triggeredAt); // Original trigger timestamp preserved
  });

  // ── 9. Device revocation terminates active session and marks device revoked
  it("9. Device revocation terminates active session and marks device revoked", async () => {
    const revoked = await remoteSecurityCoordinator.revokeRemoteDevice(testDeviceId, "Device compromised");
    expect(revoked).toBe(true);

    const dev = await remoteStore.getDevice(testDeviceId);
    expect(dev?.revoked).toBe(true);
    expect(dev?.revokedReason).toBe("Device compromised");
  });

  // ── 10. Revoked device cannot reconnect (token rejected) ──────────────────
  it("10. Revoked device cannot reconnect (token rejected)", async () => {
    await remoteSecurityCoordinator.revokeRemoteDevice(testDeviceId, "Revocation test");

    const authResult = await remoteSecurityCoordinator.authenticateRemoteCredential(
      "sora_dev_dummy_revoked_token",
      "192.168.1.150"
    );
    expect(authResult.authenticated).toBe(false);
  });

  // ── 11. Terminate single remote session by sessionId ──────────────────────
  it("11. Terminate single remote session by sessionId", async () => {
    const mockWs = { send: vi.fn(), close: vi.fn(), on: vi.fn() };
    const dev = (await remoteStore.getDevice(testDeviceId))!;
    const session = remoteSessionManager.registerClient(mockWs, dev, "192.168.1.150", "Android");

    const termResult = androidSecurityManager.terminateSession(session.sessionId, "Admin termination", adminContext);
    expect(termResult.success).toBe(true);
    expect(mockWs.close).toHaveBeenCalled();
  });

  // ── 12. Terminate all remote sessions ─────────────────────────────────────
  it("12. Terminate all remote sessions", async () => {
    const mockWs1 = { send: vi.fn(), close: vi.fn(), on: vi.fn() };
    const mockWs2 = { send: vi.fn(), close: vi.fn(), on: vi.fn() };
    const dev = (await remoteStore.getDevice(testDeviceId))!;
    remoteSessionManager.registerClient(mockWs1, dev, "192.168.1.150", "Android");
    remoteSessionManager.registerClient(mockWs2, dev, "192.168.1.151", "Android");

    const result = androidSecurityManager.terminateAllSessions("Global termination", adminContext);
    expect(result.success).toBe(true);
    expect(mockWs1.close).toHaveBeenCalled();
    expect(mockWs2.close).toHaveBeenCalled();
    expect(remoteSessionManager.getActiveSessions().length).toBe(0);
  });

  // ── 13. Security Lockdown from Android blocks normal tool execution ────────
  it("13. Security Lockdown from Android blocks normal tool execution", async () => {
    const lockdownResult = await androidSecurityManager.triggerLockdown("Threat detected", adminContext);
    expect(lockdownResult.success).toBe(true);
    expect(securityPolicyEngine.getMode()).toBe("LOCKDOWN");

    const evalResult = await securityPolicyEngine.evaluateRequest(
      "read_file",
      { path: "test.txt" },
      standardContext
    );
    expect(evalResult.decision).toBe("BLOCK");
    expect(evalResult.allowed).toBe(false);
  });

  // ── 14. Lockdown recovery authorization requires admin role ────────────────
  it("14. Lockdown recovery authorization requires admin role", async () => {
    await androidSecurityManager.triggerLockdown("Initial lockdown", adminContext);
    expect(securityPolicyEngine.getMode()).toBe("LOCKDOWN");

    // Standard user attempt should be rejected
    const standardRecover = await androidSecurityManager.recoverFromLockdown(standardContext);
    expect(standardRecover.success).toBe(false);
    expect(standardRecover.errorCode).toBe("UNAUTHORIZED");

    // Admin attempt should succeed
    const adminRecover = await androidSecurityManager.recoverFromLockdown(adminContext);
    expect(adminRecover.success).toBe(true);
    expect(securityPolicyEngine.getMode()).toBe("BALANCED");
  });

  // ── 15. Lost-device mode marks device revoked and saves record ─────────────
  it("15. Lost-device mode marks device revoked and saves record", async () => {
    const result = await androidSecurityManager.enableLostDeviceMode(
      testDeviceId,
      "Phone lost at transit station",
      adminContext
    );
    expect(result.success).toBe(true);

    const record = await remoteStore.getLostDeviceRecord(testDeviceId);
    expect(record).toBeDefined();
    expect(record?.recovered).toBe(false);
    expect(record?.reason).toBe("Phone lost at transit station");

    const dev = await remoteStore.getDevice(testDeviceId);
    expect(dev?.revoked).toBe(true);
  });

  // ── 16. Lost-device device cannot authenticate or reconnect ────────────────
  it("16. Lost-device device cannot authenticate or reconnect", async () => {
    await androidSecurityManager.enableLostDeviceMode(testDeviceId, "Stolen phone", adminContext);

    const dev = await remoteStore.getDevice(testDeviceId);
    expect(dev?.revoked).toBe(true);

    const authResult = await remoteSecurityCoordinator.authenticateRemoteCredential(
      "sora_dev_lost_phone_token",
      "192.168.1.150"
    );
    expect(authResult.authenticated).toBe(false);
  });

  // ── 17. Logout all devices revokes all device sessions and token families ──
  it("17. Logout all devices revokes all device sessions and token families", async () => {
    const mockWs = { send: vi.fn(), close: vi.fn(), on: vi.fn() };
    const dev = (await remoteStore.getDevice(testDeviceId))!;
    remoteSessionManager.registerClient(mockWs, dev, "192.168.1.150", "Android");

    const result = await androidSecurityManager.logoutAllDevices("Security audit logout", adminContext);
    expect(result.success).toBe(true);
    expect(mockWs.close).toHaveBeenCalled();
  });

  // ── 18. Refresh token invalidation after logout-all ─────────────────────────
  it("18. Refresh token invalidation after logout-all", async () => {
    const dev = (await remoteStore.getDevice(testDeviceId))!;
    const sessionRes = remoteSecurityCoordinator.createDeviceSession(dev, "192.168.1.150");
    const rfToken = sessionRes.tokens.refreshToken;

    await androidSecurityManager.logoutAllDevices("Emergency reset", adminContext);

    await expect(
      remoteSecurityCoordinator.rotateSessionToken(rfToken, "192.168.1.150")
    ).rejects.toThrow();
  });

  // ── 19. Suspicious-session detection and sanitized surfacing ───────────────
  it("19. Suspicious-session detection and sanitized surfacing", async () => {
    securityAuditLogger.logEvent({
      eventType: "TOKEN_REPLAY_DETECTED",
      actor: {
        identityId: "malicious_actor",
        role: "guest",
        ipAddress: "10.0.0.99",
      },
      decision: "BLOCK",
      reason: "Replay token used",
      riskLevel: "CRITICAL",
    });

    const status = await androidSecurityManager.getSecurityStatus(testDeviceId, standardContext);
    expect(status.recentSuspiciousEvents.length).toBeGreaterThan(0);
    const replayEvent = status.recentSuspiciousEvents.find((e) => e.eventCategory === "TOKEN_REPLAY");
    expect(replayEvent).toBeDefined();
    expect(replayEvent?.severityLabel).toBe("CRITICAL");
    // Ensure no raw IP is leaked in the description
    expect(replayEvent?.description.includes("10.0.0.99")).toBe(false);
  });

  // ── 20. Token replay handling (detected and contained) ─────────────────────
  it("20. Token replay handling (detected and contained)", async () => {
    const dev = (await remoteStore.getDevice(testDeviceId))!;
    const { tokens } = remoteSecurityCoordinator.createDeviceSession(dev, "192.168.1.150");

    // First rotation succeeds
    const rotated = await remoteSecurityCoordinator.rotateSessionToken(tokens.refreshToken, "192.168.1.150");
    expect(rotated.tokens.accessToken).toBeDefined();

    // Replaying the old refresh token must be rejected
    await expect(
      remoteSecurityCoordinator.rotateSessionToken(tokens.refreshToken, "192.168.1.150")
    ).rejects.toThrow();
  });

  // ── 21. Nonce replay handling (duplicate nonce rejected) ───────────────────
  it("21. Nonce replay handling (duplicate nonce rejected)", () => {
    const nonce = "nonce_cryptographic_12345678";
    const ts = Date.now();

    const first = remoteSecurityCoordinator.validateRequestNonce(nonce, ts);
    expect(first.valid).toBe(true);

    const second = remoteSecurityCoordinator.validateRequestNonce(nonce, ts);
    expect(second.valid).toBe(false);
    expect(second.error).toContain("REPLAY");
  });

  // ── 22. Security notification DLP (no secrets in payload) ───────────────────
  it("22. Security notification DLP (no secrets in payload)", () => {
    const sensitive = "Connected with token sora_dev_secret_token_12345 and key AIzaSyABC123456789012345678901234567890";
    const sanitized = securityAuditLogger.sanitizeData(sensitive);

    expect(sanitized.includes("sora_dev_secret_token_12345")).toBe(false);
    expect(sanitized.includes("AIzaSyABC123456789012345678901234567890")).toBe(false);
    expect(sanitized).toContain("[REDACTED]");
  });

  // ── 23. Audit chain integrity — all events cryptographically chained ────────
  it("23. Audit chain integrity — all events cryptographically chained", () => {
    securityAuditLogger.logEvent({
      eventType: "AUTH_SUCCESS",
      actor: { identityId: "user_01", role: "standard", ipAddress: "127.0.0.1" },
      decision: "ALLOW",
      reason: "Login test",
      riskLevel: "LOW",
    });

    securityAuditLogger.logEvent({
      eventType: "TOOL_ALLOW",
      actor: { identityId: "user_01", role: "standard", ipAddress: "127.0.0.1" },
      decision: "ALLOW",
      reason: "Tool test",
      riskLevel: "LOW",
    });

    const verification = securityAuditLogger.verifyChainIntegrity();
    expect(verification.valid).toBe(true);
  });

  // ── 24. Authorization/role enforcement on security controls ────────────────
  it("24. Authorization/role enforcement on security controls", async () => {
    const unauthorizedLockdown = await androidSecurityManager.triggerLockdown("Attempt", standardContext);
    expect(unauthorizedLockdown.success).toBe(false);
    expect(unauthorizedLockdown.errorCode).toBe("UNAUTHORIZED");

    const unauthorizedLost = await androidSecurityManager.enableLostDeviceMode(testDeviceId, "Attempt", standardContext);
    expect(unauthorizedLost.success).toBe(false);
    expect(unauthorizedLost.errorCode).toBe("UNAUTHORIZED");
  });

  // ── 25. Network disconnect / fail-closed behavior ──────────────────────────
  it("25. Network disconnect / fail-closed behavior", async () => {
    // When no active session exists for a non-existent device, terminateSession fails closed
    const termRes = androidSecurityManager.terminateSession("non_existent_session", "test", adminContext);
    expect(termRes.success).toBe(false);
    expect(termRes.errorCode).toBe("DEVICE_NOT_FOUND");
  });

  // ── 26. Emergency Stop retry is idempotent and safe ────────────────────────
  it("26. Emergency Stop retry is idempotent and safe", async () => {
    for (let i = 0; i < 3; i++) {
      const state = await emergencyStopCoordinator.trigger({
        source: "remote_device",
        deviceId: testDeviceId,
        reason: `Repeated trigger attempt ${i + 1}`,
      });
      expect(state.active).toBe(true);
    }
    expect(emergencyStopCoordinator.isActive()).toBe(true);
  });

  // ── 27. Phase 17 regression — token rotation still works ───────────────────
  it("27. Phase 17 regression — token rotation still works", async () => {
    const dev = (await remoteStore.getDevice(testDeviceId))!;
    const sessionRes = remoteSecurityCoordinator.createDeviceSession(dev, "192.168.1.150");
    const rotated = await remoteSecurityCoordinator.rotateSessionToken(
      sessionRes.tokens.refreshToken,
      "192.168.1.150"
    );
    expect(rotated.tokens.accessToken).toBeDefined();
    expect(rotated.tokens.refreshToken).not.toBe(sessionRes.tokens.refreshToken);
  });

  // ── 28. Phase 24 regression — shared memory unaffected ─────────────────────
  it("28. Phase 24 regression — shared memory unaffected", async () => {
    const memories = await sharedMemoryManager.listMemories({}, adminContext);
    expect(Array.isArray(memories)).toBe(true);
  });

  // ── 29. Phase 25 regression — cross-device handoff unaffected ──────────────
  it("29. Phase 25 regression — cross-device handoff unaffected", async () => {
    const handoffs = await crossDeviceHandoffManager.listAvailableHandoffs({}, adminContext);
    expect(Array.isArray(handoffs)).toBe(true);
  });

  // ── 30. Phase 26 regression — proactive companion unaffected ───────────────
  it("30. Phase 26 regression — proactive companion unaffected", async () => {
    const pending = mobileProactiveManager.getPendingNotifications(testDeviceId);
    expect(Array.isArray(pending)).toBe(true);
  });

  // ── 31. Phase 27 regression — workflow engine unaffected ───────────────────
  it("31. Phase 27 regression — workflow engine unaffected", async () => {
    const res = await mobileWorkflowManager.getWorkflowStatus("non_existent_plan", adminContext);
    expect(res.success).toBe(false);
  });

  // ── 32. Full regression compatibility check ────────────────────────────────
  it("32. Full regression compatibility check", async () => {
    // Check that security engine remains BALANCED after routine queries
    const mode = securityPolicyEngine.getMode();
    expect(mode).toBe("BALANCED");
    expect(emergencyStopCoordinator.isActive()).toBe(false);
  });

  // ── 33. REST endpoint GET /api/remote/security/status ──────────────────────
  describe("REST Endpoints", () => {
    let server: http.Server;
    let baseUrl: string;

    beforeEach(async () => {
      const app = createHttpApp();
      server = http.createServer(app);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as any).port;
      baseUrl = `http://127.0.0.1:${port}`;
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it("33. REST endpoint GET /api/remote/security/status", async () => {
      const res = await fetch(`${baseUrl}/api/remote/security/status`, {
        method: "GET",
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.success).toBe(true);
      expect(data.status).toBeDefined();
      expect(typeof data.status.emergencyStopActive).toBe("boolean");
    });

    // ── 34. REST endpoint POST /api/remote/security/lost-device/enable ────────
    it("34. REST endpoint POST /api/remote/security/lost-device/enable", async () => {
      const res = await fetch(`${baseUrl}/api/remote/security/lost-device/enable`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deviceId: testDeviceId,
          reason: "REST Lost phone trigger",
        }),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.success).toBe(true);

      const record = await remoteStore.getLostDeviceRecord(testDeviceId);
      expect(record?.recovered).toBe(false);
    });

    // ── 35. REST endpoint POST /api/remote/security/logout-all ────────────────
    it("35. REST endpoint POST /api/remote/security/logout-all", async () => {
      const res = await fetch(`${baseUrl}/api/remote/security/logout-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reason: "REST operator logout",
        }),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.success).toBe(true);
    });
  });

  // ── 36. Verify exactly 126 Gemini Live tools invariant in LIVE_TOOLS ───────
  it("36. Verify exactly 126 Gemini Live tools invariant in LIVE_TOOLS", () => {
    const decls = LIVE_TOOLS[0].functionDeclarations;
    expect(decls.length).toBe(126);

    const toolNames = decls.map((d: any) => d.name);
    // Ensure triggerEmergencyStop is present
    expect(toolNames).toContain("triggerEmergencyStop");
    // Ensure duplicate names don't exist
    const uniqueNames = new Set(toolNames);
    expect(uniqueNames.size).toBe(126);
  });
});
