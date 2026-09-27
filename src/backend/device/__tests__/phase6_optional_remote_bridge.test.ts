/**
 * MYRAA — Phase 6: Optional Remote Bridge Test Suite
 *
 * Scope Coverage (A–L):
 *   A. Device Discovery
 *   B. Explicit Pairing
 *   C. Connect / Disconnect
 *   D. Device Authorization
 *   E. Remote Capability Negotiation
 *   F. Remote Command Execution
 *   G. Remote Result Verification
 *   H. Timeout / Retry (Bounded)
 *   I. Emergency Stop
 *   J. Security Lockdown
 *   K. Remote Audit & DLP
 *   L. Automatic Disconnect Safety
 *
 * Mandatory End-to-End Flows Tested (1–11):
 *   1. Discover device → explicit pair → connect → negotiate → execute → verify.
 *   2. Disconnect → remote execution blocked.
 *   3. Same account without pairing → NOT connected.
 *   4. Desktop unavailable → deterministic TARGET_DEVICE_UNAVAILABLE.
 *   5. Remote capability unsupported → deterministic failure.
 *   6. Expired/revoked authorization → blocked.
 *   7. Emergency Stop → remote execution immediately blocked.
 *   8. Security Lockdown → remote execution blocked.
 *   9. Timeout → bounded retry → deterministic failure.
 *   10. Lost/revoked device → automatic disconnect.
 *   11. Explicit remote request → NEVER local fallback.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  deviceRegistry,
  androidCapabilityEngine,
  desktopCapabilityEngine,
  remoteBridge,
  type DeviceIdentity,
} from "../index.ts";
import {
  capabilityRegistry,
  intentCapabilityOrchestrator,
  deviceAwareIntelligence,
} from "../../orchestrator/index.ts";
import {
  identityAuthManager,
  securityPolicyEngine,
  securityAuditLogger,
  type SecurityContext,
} from "../../security/index.ts";
import { emergencyStopCoordinator } from "../../remote/EmergencyStopCoordinator.ts";
import { LIVE_TOOLS } from "../../ai/GeminiSessionFactory.ts";

// ---------------------------------------------------------------------------
// Test Fixtures
// ---------------------------------------------------------------------------

const PHONE_DEVICE: DeviceIdentity = {
  deviceId: "myraa-phone-01",
  deviceName: "Sandeep's Pixel 8 Pro",
  productType: "MYRAA_MOBILE",
  accountId: "user-sandeep-01",
  registered: true,
  registeredAt: "2026-09-26T10:00:00.000Z",
  lastSeenAt: "2026-09-26T12:00:00.000Z",
  bridgeConnected: false,
  bridgeTargetDeviceId: null,
  disabledCapabilities: [],
};

const DESKTOP_DEVICE: DeviceIdentity = {
  deviceId: "myraa-desktop-01",
  deviceName: "Sandeep's Windows Workstation",
  productType: "MYRAA_DESKTOP",
  accountId: "user-sandeep-01",
  registered: true,
  registeredAt: "2026-09-26T10:00:00.000Z",
  lastSeenAt: "2026-09-26T12:00:00.000Z",
  bridgeConnected: false,
  bridgeTargetDeviceId: null,
  disabledCapabilities: [],
};

const PHONE_SEC_CTX: SecurityContext = {
  identityId: "user-sandeep-01",
  role: "admin",
  ipAddress: "192.168.1.55",
  deviceId: "myraa-phone-01",
  isLocal: false,
};

describe("Phase 6 — Optional Remote Bridge", () => {
  beforeEach(async () => {
    deviceRegistry.resetForTesting();
    deviceRegistry.registerEngine(androidCapabilityEngine);
    deviceRegistry.registerEngine(desktopCapabilityEngine);
    remoteBridge.resetForTesting();
    intentCapabilityOrchestrator.resetForTesting();
    capabilityRegistry.resetForTesting();
    deviceAwareIntelligence.resetForTesting();
    identityAuthManager.resetForTesting();
    securityPolicyEngine.resetForTesting();
    securityAuditLogger.clearForTesting();
    if (emergencyStopCoordinator.isActive()) {
      await emergencyStopCoordinator.reset("user-sandeep-01");
    }

    deviceRegistry.registerDevice(PHONE_DEVICE);
    deviceRegistry.registerDevice(DESKTOP_DEVICE);
    capabilityRegistry.setDeviceAvailabilityOverrides({
      phoneAvailable: true,
      desktopAvailable: true,
      remoteDesktopAvailable: true,
    });
  });

  afterEach(async () => {
    remoteBridge.resetForTesting();
    deviceRegistry.resetForTesting();
    deviceRegistry.registerEngine(androidCapabilityEngine);
    deviceRegistry.registerEngine(desktopCapabilityEngine);
    capabilityRegistry.resetForTesting();
    securityPolicyEngine.resetForTesting();
    if (emergencyStopCoordinator.isActive()) {
      await emergencyStopCoordinator.reset("user-sandeep-01");
    }
  });

  // ===========================================================================
  // FLOW 1: Discover device → explicit pair → connect → negotiate → execute → verify
  // ===========================================================================
  describe("Flow 1: Discover → Explicit Pair → Connect → Negotiate → Execute → Verify", () => {
    it("completes the full end-to-end Remote Bridge lifecycle with deterministic verification", async () => {
      // 1. A. Discover candidate desktop devices from phone
      const discovered = remoteBridge.discoverDevices({
        requestingDeviceId: PHONE_DEVICE.deviceId,
        accountId: PHONE_DEVICE.accountId,
        productType: "MYRAA_DESKTOP",
      });
      expect(discovered).toHaveLength(1);
      expect(discovered[0].deviceId).toBe(DESKTOP_DEVICE.deviceId);
      expect(discovered[0].online).toBe(true);
      expect(discovered[0].paired).toBe(false);
      expect(discovered[0].bridgeState).toBe("INACTIVE");
      expect(discovered[0].autoConnected).toBe(false);

      // 2. B. Explicit Pairing (Request + Confirm)
      const pairReq = remoteBridge.requestPairing({
        sourceDeviceId: PHONE_DEVICE.deviceId,
        targetDeviceId: DESKTOP_DEVICE.deviceId,
        requestedBy: PHONE_DEVICE.accountId,
        role: "admin",
        explicitUserAction: true,
      });
      expect(pairReq.success).toBe(true);
      expect(pairReq.pairingId).toBeDefined();
      expect(pairReq.pairingCode).toMatch(/^\d{6}$/);

      const pairConfirm = remoteBridge.confirmPairing({
        pairingId: pairReq.pairingId!,
        pairingCode: pairReq.pairingCode!,
        approvedByTargetUser: true,
      });
      expect(pairConfirm.success).toBe(true);
      expect(remoteBridge.isPaired(PHONE_DEVICE.deviceId, DESKTOP_DEVICE.deviceId)).toBe(true);
      // Pairing alone MUST NOT activate the bridge connection yet
      expect(remoteBridge.isActive(PHONE_DEVICE.deviceId)).toBe(false);

      // 3. C & E. Explicit Connect + Capability Negotiation
      const conn = await remoteBridge.connect({
        sourceDeviceId: PHONE_DEVICE.deviceId,
        targetDeviceId: DESKTOP_DEVICE.deviceId,
        explicitUserAction: true,
      });
      expect(conn.success).toBe(true);
      expect(remoteBridge.isActive(PHONE_DEVICE.deviceId)).toBe(true);
      expect(conn.manifest).toBeDefined();
      expect(conn.manifest?.allowedCapabilities).toContain("desktop.openApplication");
      expect(conn.manifest?.deniedCapabilities).toContain("mobile.alarm");

      // 4. F & G. Remote Command Execution + Result Verification
      const execRes = await remoteBridge.executeRemoteCommand({
        sourceDeviceId: PHONE_DEVICE.deviceId,
        targetDeviceId: DESKTOP_DEVICE.deviceId,
        capability: "desktop.openApplication",
        args: { appName: "vscode" },
        targetProductType: "MYRAA_DESKTOP",
        secContext: PHONE_SEC_CTX,
      });

      expect(execRes.success).toBe(true);
      expect(execRes.ok).toBe(true);
      expect(execRes.verified).toBe(true);
      expect(execRes.verification.verified).toBe(true);
      expect(execRes.verification.capability).toBe("desktop.openApplication");
      expect(execRes.attempts).toBe(1);
      expect(execRes.usedLocalFallback).toBe(false);
    });
  });

  // ===========================================================================
  // FLOW 2: Disconnect → remote execution blocked
  // ===========================================================================
  describe("Flow 2: Disconnect → Remote Execution Blocked", () => {
    it("immediately blocks remote execution after explicit disconnect", async () => {
      await remoteBridge.activate(PHONE_DEVICE.deviceId, DESKTOP_DEVICE.deviceId);
      expect(remoteBridge.isActive(PHONE_DEVICE.deviceId)).toBe(true);

      const disc = remoteBridge.disconnect(PHONE_DEVICE.deviceId);
      expect(disc.disconnected).toBe(true);
      expect(remoteBridge.isActive(PHONE_DEVICE.deviceId)).toBe(false);

      const transportSpy = vi.fn();
      const execRes = await remoteBridge.executeRemoteCommand({
        sourceDeviceId: PHONE_DEVICE.deviceId,
        targetDeviceId: DESKTOP_DEVICE.deviceId,
        capability: "desktop.openApplication",
        args: { appName: "vscode" },
        transportExecutor: transportSpy,
      });

      expect(execRes.ok).toBe(false);
      expect(execRes.errorCode).toBe("BRIDGE_INACTIVE");
      expect(execRes.verified).toBe(false);
      expect(execRes.usedLocalFallback).toBe(false);
      expect(transportSpy).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // FLOW 3: Same account without pairing → NOT connected
  // ===========================================================================
  describe("Flow 3: Same Account Without Pairing → NOT Connected", () => {
    it("never auto-pairs or auto-connects devices sharing the same accountId", async () => {
      expect(PHONE_DEVICE.accountId).toBe(DESKTOP_DEVICE.accountId);
      expect(remoteBridge.isPaired(PHONE_DEVICE.deviceId, DESKTOP_DEVICE.deviceId)).toBe(false);
      expect(remoteBridge.isActive(PHONE_DEVICE.deviceId)).toBe(false);

      // Attempting to connect without pairing fails with DEVICE_NOT_PAIRED
      const conn = await remoteBridge.connect({
        sourceDeviceId: PHONE_DEVICE.deviceId,
        targetDeviceId: DESKTOP_DEVICE.deviceId,
        explicitUserAction: true,
      });
      expect(conn.success).toBe(false);
      expect(conn.errorCode).toBe("DEVICE_NOT_PAIRED");

      // Attempting background pairing (explicitUserAction: false) is rejected
      const bgPair = remoteBridge.requestPairing({
        sourceDeviceId: PHONE_DEVICE.deviceId,
        targetDeviceId: DESKTOP_DEVICE.deviceId,
        requestedBy: PHONE_DEVICE.accountId,
        explicitUserAction: false,
      });
      expect(bgPair.success).toBe(false);
      expect(bgPair.errorCode).toBe("EXPLICIT_USER_ACTION_REQUIRED");
    });
  });

  // ===========================================================================
  // FLOW 4: Desktop unavailable → deterministic TARGET_DEVICE_UNAVAILABLE
  // ===========================================================================
  describe("Flow 4: Desktop Unavailable → Deterministic TARGET_DEVICE_UNAVAILABLE", () => {
    it("returns TARGET_DEVICE_UNAVAILABLE when target desktop goes offline", async () => {
      await remoteBridge.activate(PHONE_DEVICE.deviceId, DESKTOP_DEVICE.deviceId);

      // Desktop goes offline
      capabilityRegistry.setDeviceAvailabilityOverrides({
        phoneAvailable: true,
        desktopAvailable: false,
        remoteDesktopAvailable: false,
      });

      const transportSpy = vi.fn();
      const execRes = await remoteBridge.executeRemoteCommand({
        sourceDeviceId: PHONE_DEVICE.deviceId,
        targetDeviceId: DESKTOP_DEVICE.deviceId,
        capability: "desktop.openApplication",
        args: { appName: "vscode" },
        transportExecutor: transportSpy,
      });

      expect(execRes.ok).toBe(false);
      expect(execRes.errorCode).toBe("TARGET_DEVICE_UNAVAILABLE");
      expect(execRes.usedLocalFallback).toBe(false);
      expect(transportSpy).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // FLOW 5: Remote capability unsupported → deterministic failure
  // ===========================================================================
  describe("Flow 5: Remote Capability Unsupported → Deterministic Failure", () => {
    it("rejects capabilities not supported or disabled on the remote target device", async () => {
      await remoteBridge.activate(PHONE_DEVICE.deviceId, DESKTOP_DEVICE.deviceId);

      // 1. Mobile-only capability ("mobile.alarm") sent to Desktop bridge target
      const res1 = await remoteBridge.executeRemoteCommand({
        sourceDeviceId: PHONE_DEVICE.deviceId,
        targetDeviceId: DESKTOP_DEVICE.deviceId,
        capability: "mobile.alarm",
        args: { time: "7:00 AM" },
        targetProductType: "MYRAA_DESKTOP",
      });
      expect(res1.ok).toBe(false);
      expect(res1.errorCode).toBe("CAPABILITY_NOT_SUPPORTED");

      // 2. Capability explicitly disabled on target device before negotiation
      deviceRegistry.registerDevice({
        ...DESKTOP_DEVICE,
        disabledCapabilities: ["desktop.screenshot"],
      });
      remoteBridge.negotiateCapabilities(PHONE_DEVICE.deviceId, DESKTOP_DEVICE.deviceId);

      const res2 = await remoteBridge.executeRemoteCommand({
        sourceDeviceId: PHONE_DEVICE.deviceId,
        targetDeviceId: DESKTOP_DEVICE.deviceId,
        capability: "desktop.screenshot",
        args: {},
        targetProductType: "MYRAA_DESKTOP",
      });
      expect(res2.ok).toBe(false);
      expect(res2.errorCode).toBe("CAPABILITY_NOT_SUPPORTED");
    });
  });

  // ===========================================================================
  // FLOW 6: Expired/revoked authorization → blocked
  // ===========================================================================
  describe("Flow 6: Expired or Revoked Authorization → Blocked & Auto-Disconnected", () => {
    it("blocks execution and auto-disconnects when authorization expires", async () => {
      await remoteBridge.activate(PHONE_DEVICE.deviceId, DESKTOP_DEVICE.deviceId);
      expect(remoteBridge.isActive(PHONE_DEVICE.deviceId)).toBe(true);

      // Expire pairing authorization
      remoteBridge.expireDeviceAuthorization(PHONE_DEVICE.deviceId, DESKTOP_DEVICE.deviceId);

      const execRes = await remoteBridge.executeRemoteCommand({
        sourceDeviceId: PHONE_DEVICE.deviceId,
        targetDeviceId: DESKTOP_DEVICE.deviceId,
        capability: "desktop.openApplication",
        args: { appName: "vscode" },
      });

      expect(execRes.ok).toBe(false);
      expect(execRes.errorCode).toBe("AUTHORIZATION_EXPIRED");
      expect(execRes.autoDisconnected).toBe(true);
      expect(execRes.disconnectReason).toBe("AUTHORIZATION_EXPIRED");
      expect(remoteBridge.isActive(PHONE_DEVICE.deviceId)).toBe(false);
    });

    it("blocks execution when IdentityAuthManager session is revoked", async () => {
      await remoteBridge.activate(PHONE_DEVICE.deviceId, DESKTOP_DEVICE.deviceId);
      const pairing = remoteBridge.getPairing(PHONE_DEVICE.deviceId, DESKTOP_DEVICE.deviceId);
      expect(pairing).toBeDefined();

      // Revoke the underlying cryptographic session in IdentityAuthManager
      identityAuthManager.revokeSession(pairing!.sessionId, "Admin revoked session");

      const execRes = await remoteBridge.executeRemoteCommand({
        sourceDeviceId: PHONE_DEVICE.deviceId,
        targetDeviceId: DESKTOP_DEVICE.deviceId,
        capability: "desktop.openApplication",
        args: { appName: "vscode" },
      });

      expect(execRes.ok).toBe(false);
      expect(execRes.errorCode).toBe("DEVICE_REVOKED");
      expect(execRes.autoDisconnected).toBe(true);
      expect(remoteBridge.isActive(PHONE_DEVICE.deviceId)).toBe(false);
    });
  });

  // ===========================================================================
  // FLOW 7: Emergency Stop → remote execution immediately blocked
  // ===========================================================================
  describe("Flow 7: Emergency Stop → Immediate Block & Auto-Disconnect", () => {
    it("immediately blocks remote execution and disconnects bridge on Emergency Stop", async () => {
      await remoteBridge.activate(PHONE_DEVICE.deviceId, DESKTOP_DEVICE.deviceId);
      expect(remoteBridge.isActive(PHONE_DEVICE.deviceId)).toBe(true);

      await emergencyStopCoordinator.trigger({
        source: "remote_device",
        deviceId: PHONE_DEVICE.deviceId,
        reason: "Phase 6 Emergency Stop test",
      });

      const transportSpy = vi.fn();
      const execRes = await remoteBridge.executeRemoteCommand({
        sourceDeviceId: PHONE_DEVICE.deviceId,
        targetDeviceId: DESKTOP_DEVICE.deviceId,
        capability: "desktop.openApplication",
        args: { appName: "vscode" },
        transportExecutor: transportSpy,
      });

      expect(execRes.ok).toBe(false);
      expect(execRes.errorCode).toBe("SECURITY_POLICY_DENIED");
      expect(execRes.message).toContain("EMERGENCY_STOP_ACTIVE");
      expect(execRes.autoDisconnected).toBe(true);
      expect(execRes.disconnectReason).toBe("EMERGENCY_STOP_ACTIVE");
      expect(transportSpy).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // FLOW 8: Security Lockdown → remote execution blocked
  // ===========================================================================
  describe("Flow 8: Security Lockdown → Remote Execution Blocked", () => {
    it("blocks remote execution and disconnects bridge when SecurityPolicyEngine is in LOCKDOWN mode", async () => {
      await remoteBridge.activate(PHONE_DEVICE.deviceId, DESKTOP_DEVICE.deviceId);
      securityPolicyEngine.setMode("LOCKDOWN");

      const transportSpy = vi.fn();
      const execRes = await remoteBridge.executeRemoteCommand({
        sourceDeviceId: PHONE_DEVICE.deviceId,
        targetDeviceId: DESKTOP_DEVICE.deviceId,
        capability: "desktop.openApplication",
        args: { appName: "vscode" },
        transportExecutor: transportSpy,
      });

      expect(execRes.ok).toBe(false);
      expect(execRes.errorCode).toBe("SECURITY_POLICY_DENIED");
      expect(execRes.message).toContain("SECURITY_LOCKDOWN");
      expect(execRes.autoDisconnected).toBe(true);
      expect(execRes.disconnectReason).toBe("SECURITY_LOCKDOWN");
      expect(transportSpy).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // FLOW 9: Timeout → bounded retry → deterministic failure
  // ===========================================================================
  describe("Flow 9: Timeout → Bounded Retry → Deterministic Failure", () => {
    it("retries exactly maxRetries times on timeout, never loops infinitely, and auto-disconnects", async () => {
      await remoteBridge.activate(PHONE_DEVICE.deviceId, DESKTOP_DEVICE.deviceId);

      let callCount = 0;
      const slowHangingTransport = vi.fn(async () => {
        callCount++;
        await new Promise((resolve) => setTimeout(resolve, 250));
        return { ok: true, result: { launched: true } };
      });

      const execRes = await remoteBridge.executeRemoteCommand({
        sourceDeviceId: PHONE_DEVICE.deviceId,
        targetDeviceId: DESKTOP_DEVICE.deviceId,
        capability: "desktop.openApplication",
        args: { appName: "vscode" },
        timeoutMs: 60,
        maxRetries: 2, // 1 initial + 2 retries = 3 bounded attempts total
        transportExecutor: slowHangingTransport,
      });

      expect(execRes.ok).toBe(false);
      expect(execRes.timedOut).toBe(true);
      expect(execRes.errorCode).toBe("REMOTE_TIMEOUT");
      expect(execRes.attempts).toBe(3);
      expect(callCount).toBe(3);
      expect(execRes.autoDisconnected).toBe(true);
      expect(execRes.disconnectReason).toBe("TRANSPORT_FAILURE");
      expect(remoteBridge.isActive(PHONE_DEVICE.deviceId)).toBe(false);
    });

    it("succeeds if a transient failure recovers within the bounded retry budget", async () => {
      await remoteBridge.activate(PHONE_DEVICE.deviceId, DESKTOP_DEVICE.deviceId);

      const flakyTransport = vi.fn(async (_cap: string, _tool: string, _args: any, attempt: number) => {
        if (attempt < 2) {
          throw new Error("Transient socket jitter");
        }
        return { ok: true, result: { launched: true, appName: "vscode", pid: 8888 } };
      });

      const execRes = await remoteBridge.executeRemoteCommand({
        sourceDeviceId: PHONE_DEVICE.deviceId,
        targetDeviceId: DESKTOP_DEVICE.deviceId,
        capability: "desktop.openApplication",
        args: { appName: "vscode" },
        timeoutMs: 500,
        maxRetries: 2,
        transportExecutor: flakyTransport,
      });

      expect(execRes.ok).toBe(true);
      expect(execRes.verified).toBe(true);
      expect(execRes.attempts).toBe(2);
    });
  });

  // ===========================================================================
  // FLOW 10: Lost/revoked device → automatic disconnect
  // ===========================================================================
  describe("Flow 10: Lost or Revoked Device → Automatic Disconnect", () => {
    it("automatically disconnects and blocks execution when a device is reported lost", async () => {
      await remoteBridge.activate(PHONE_DEVICE.deviceId, DESKTOP_DEVICE.deviceId);
      expect(remoteBridge.isActive(PHONE_DEVICE.deviceId)).toBe(true);

      remoteBridge.markDeviceLost(DESKTOP_DEVICE.deviceId, "Workstation reported lost");

      expect(remoteBridge.isActive(PHONE_DEVICE.deviceId)).toBe(false);
      expect(remoteBridge.getLastDisconnectReason(PHONE_DEVICE.deviceId)).toBe("DEVICE_LOST");

      const execRes = await remoteBridge.executeRemoteCommand({
        sourceDeviceId: PHONE_DEVICE.deviceId,
        targetDeviceId: DESKTOP_DEVICE.deviceId,
        capability: "desktop.openApplication",
        args: { appName: "vscode" },
      });
      expect(execRes.ok).toBe(false);
      expect(execRes.errorCode).toBe("DEVICE_LOST");
    });

    it("automatically disconnects and blocks execution when device authorization is revoked", async () => {
      await remoteBridge.activate(PHONE_DEVICE.deviceId, DESKTOP_DEVICE.deviceId);
      expect(remoteBridge.isActive(PHONE_DEVICE.deviceId)).toBe(true);

      remoteBridge.revokeDeviceAuthorization(
        PHONE_DEVICE.deviceId,
        DESKTOP_DEVICE.deviceId,
        "User revoked desktop pairing",
      );

      expect(remoteBridge.isActive(PHONE_DEVICE.deviceId)).toBe(false);
      expect(remoteBridge.getLastDisconnectReason(PHONE_DEVICE.deviceId)).toBe("DEVICE_REVOKED");

      const execRes = await remoteBridge.executeRemoteCommand({
        sourceDeviceId: PHONE_DEVICE.deviceId,
        targetDeviceId: DESKTOP_DEVICE.deviceId,
        capability: "desktop.openApplication",
        args: { appName: "vscode" },
      });
      expect(execRes.ok).toBe(false);
      expect(execRes.errorCode).toBe("DEVICE_REVOKED");
    });

    it("automatically disconnects on inactivity timeout and security violation", async () => {
      await remoteBridge.activate(PHONE_DEVICE.deviceId, DESKTOP_DEVICE.deviceId);
      // Backdate last activity by 45 minutes (> 30m default inactivity timeout)
      remoteBridge.setLastActivityForTesting(PHONE_DEVICE.deviceId, Date.now() - 45 * 60 * 1000);

      const execRes = await remoteBridge.executeRemoteCommand({
        sourceDeviceId: PHONE_DEVICE.deviceId,
        targetDeviceId: DESKTOP_DEVICE.deviceId,
        capability: "desktop.openApplication",
        args: { appName: "vscode" },
      });
      expect(execRes.ok).toBe(false);
      expect(execRes.errorCode).toBe("AUTHORIZATION_EXPIRED");
      expect(execRes.disconnectReason).toBe("INACTIVITY_TIMEOUT");
      expect(remoteBridge.isActive(PHONE_DEVICE.deviceId)).toBe(false);

      // Re-activate and trigger security violation
      await remoteBridge.activate(PHONE_DEVICE.deviceId, DESKTOP_DEVICE.deviceId);
      remoteBridge.triggerSecurityViolation(
        PHONE_DEVICE.deviceId,
        DESKTOP_DEVICE.deviceId,
        "Anomalous command burst",
      );
      expect(remoteBridge.isActive(PHONE_DEVICE.deviceId)).toBe(false);
      expect(remoteBridge.getLastDisconnectReason(PHONE_DEVICE.deviceId)).toBe("SECURITY_VIOLATION");
    });
  });

  // ===========================================================================
  // FLOW 11: Explicit remote request → NEVER local fallback
  // ===========================================================================
  describe("Flow 11: Explicit Remote Request → NEVER Local Fallback", () => {
    it("never executes on the local device when an explicit remote request fails for any reason", async () => {
      const localAndroidSpy = vi.spyOn(androidCapabilityEngine, "execute");

      // Case A: Bridge is INACTIVE, user on Phone asks "remote desktop par Chrome kholo"
      const resA = await intentCapabilityOrchestrator.orchestrateUtterance(
        "remote desktop par Chrome kholo",
        "phase6-no-fallback",
        PHONE_SEC_CTX,
      );
      expect(resA.ok).toBe(false);
      expect(resA.targetMode).toBe("REMOTE_DESKTOP");
      expect(resA.errorCode).toBe("BRIDGE_INACTIVE");
      expect(localAndroidSpy).not.toHaveBeenCalled();

      // Case B: Bridge is ACTIVE, but Desktop is offline
      await remoteBridge.activate(PHONE_DEVICE.deviceId, DESKTOP_DEVICE.deviceId);
      capabilityRegistry.setDeviceAvailabilityOverrides({
        phoneAvailable: true,
        desktopAvailable: false,
        remoteDesktopAvailable: false,
      });

      const resB = await remoteBridge.executeRemoteCommand({
        sourceDeviceId: PHONE_DEVICE.deviceId,
        targetDeviceId: DESKTOP_DEVICE.deviceId,
        capability: "desktop.openApplication",
        args: { appName: "chrome" },
      });
      expect(resB.ok).toBe(false);
      expect(resB.errorCode).toBe("TARGET_DEVICE_UNAVAILABLE");
      expect(resB.usedLocalFallback).toBe(false);
      expect(localAndroidSpy).not.toHaveBeenCalled();

      localAndroidSpy.mockRestore();
    });
  });

  // ===========================================================================
  // STANDALONE INDEPENDENCE, AUDIT & 126 TOOLS INVARIANTS
  // ===========================================================================
  describe("Standalone Product Independence, DLP/Audit & 126 Gemini Tools", () => {
    it("preserves full standalone operation of MYRAA Mobile and MYRAA Desktop when Bridge is INACTIVE", async () => {
      expect(remoteBridge.isActive(PHONE_DEVICE.deviceId)).toBe(false);
      expect(remoteBridge.isActive(DESKTOP_DEVICE.deviceId)).toBe(false);

      // MYRAA Mobile works standalone
      const mobileRes = await androidCapabilityEngine.execute(
        "mobile.alarm",
        { time: "6:30 AM", label: "Morning Run" },
        { deviceId: PHONE_DEVICE.deviceId, productType: "MYRAA_MOBILE", bridgeActive: false },
      );
      expect(mobileRes.success).toBe(true);

      // MYRAA Desktop works standalone
      const desktopRes = await desktopCapabilityEngine.execute(
        "desktop.openApplication",
        { appName: "vscode" },
        { deviceId: DESKTOP_DEVICE.deviceId, productType: "MYRAA_DESKTOP", bridgeActive: false },
      );
      expect(desktopRes.success).toBe(true);
    });

    it("records tamper-evident Remote Audit events and preserves 126 Gemini Live tools", async () => {
      await remoteBridge.activate(PHONE_DEVICE.deviceId, DESKTOP_DEVICE.deviceId);
      await remoteBridge.executeRemoteCommand({
        sourceDeviceId: PHONE_DEVICE.deviceId,
        targetDeviceId: DESKTOP_DEVICE.deviceId,
        capability: "desktop.openApplication",
        args: { appName: "vscode" },
      });

      const events = securityAuditLogger.getRecentEvents(50);
      expect(events.length).toBeGreaterThanOrEqual(3);
      expect(securityAuditLogger.verifyChainIntegrity().valid).toBe(true);
      expect(LIVE_TOOLS[0].functionDeclarations.length).toBe(126);
    });
  });
});
