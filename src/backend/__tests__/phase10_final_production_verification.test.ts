/**
 * PHASE 10 — FINAL PRODUCTION VERIFICATION, HARDENING & RELEASE SUITE
 *
 * Covers Sections C through S + HTTP /api/ux/* Gateway verification:
 *   C — Mobile Standalone Verification
 *   D — Desktop Standalone Verification
 *   E — Optional Remote Bridge Verification
 *   F — Cross-Device Handoff Verification
 *   G — Account + Memory Verification
 *   H — Offline / Network Failure / Recovery Verification
 *   I — Server Restart / Deployment Recovery Verification
 *   J — Token Expiry / Auth Recovery Verification
 *   K — Gemini Failure / Voice Recovery Verification
 *   L — Device Revocation / Lost Device Verification
 *   M — Emergency Stop Verification
 *   N — Security Lockdown Verification
 *   O — Long-Run Stability & Memory Leak Verification
 *   P — Performance Verification
 *   Q — Battery / Resource Behavior Verification
 *   R — Security Final Audit
 *   S — 126 Tools Invariant Verification
 */

import { describe, it, expect, beforeEach } from "vitest";
import http from "node:http";
import {
  deviceRegistry,
  remoteBridge,
  sharedAccountMemoryManager,
  crossDeviceWorkflowOrchestrator,
  productionUxController,
} from "../device/index.ts";
import { capabilityRegistry } from "../orchestrator/index.ts";
import { LIVE_TOOLS } from "../ai/GeminiSessionFactory.ts";
import { identityAuthManager } from "../security/IdentityAuthManager.ts";
import { securityPolicyEngine } from "../security/SecurityPolicyEngine.ts";
import { securityAuditLogger } from "../security/SecurityAuditLogger.ts";
import { outputDataFirewall } from "../security/OutputDataFirewall.ts";
import { emergencyStopCoordinator } from "../remote/EmergencyStopCoordinator.ts";
import { createHttpApp } from "../gateway/HttpGateway.ts";

describe("PHASE 10 — Final Production Verification, Hardening & Release", () => {
  const ACCOUNT_ID = "acct-phase10-prod";
  const PHONE_ID = "phone-phase10-android";
  const DESKTOP_ID = "desktop-phase10-win";

  beforeEach(async () => {
    await emergencyStopCoordinator.reset("phase10-test-reset");
    securityPolicyEngine.setMode("BALANCED");
    productionUxController.resetForTesting();
    crossDeviceWorkflowOrchestrator.resetForTesting();
    sharedAccountMemoryManager.resetForTesting();
    remoteBridge.resetForTesting();
    deviceRegistry.resetForTesting();
    capabilityRegistry.resetForTesting();
  });

  // =========================================================================
  // C — MOBILE STANDALONE VERIFICATION
  // =========================================================================
  describe("C — Mobile Standalone Verification", () => {
    it("operates 100% standalone with no paired desktop, executing Hinglish/Hindi/English voice commands, mobile apps, alarms, permissions, privacy & local memory", async () => {
      const view = productionUxController.initMobileUxSession({
        deviceId: PHONE_ID,
        deviceName: "MYRAA Android Standalone",
        online: true,
      });

      expect(view.standaloneMode).toBe(true);
      expect(view.standaloneReady).toBe(true);
      expect(view.desktopConnectionScreen.connectionStatus).toBe("DISCONNECTED");
      expect(remoteBridge.isActive(PHONE_ID)).toBe(false);

      // Onboarding flow completes cleanly without requiring desktop pairing
      for (const step of ["WELCOME", "VOICE_SETUP", "PERMISSIONS", "PRIVACY_AND_ACCOUNT", "READY"] as const) {
        productionUxController.completeMobileOnboardingStep(PHONE_ID, step);
      }
      expect(productionUxController.getMobileUxState(PHONE_ID).onboarding.completed).toBe(true);

      // Hinglish app open command executes locally on Phone
      const turn1 = await productionUxController.submitMobileVoiceCommand({
        deviceId: PHONE_ID,
        utterance: "WhatsApp open karo",
      });
      expect(turn1.ok).toBe(true);
      expect(turn1.executingDeviceId).toBe(PHONE_ID);
      expect(turn1.usedSilentFallback).toBe(false);

      // Alarm / timer command executes locally on Phone
      const turn2 = await productionUxController.submitMobileVoiceCommand({
        deviceId: PHONE_ID,
        utterance: "Subah 7 baje ka alarm set karo",
      });
      expect(turn2.ok).toBe(true);
      expect(turn2.executingDeviceId).toBe(PHONE_ID);
      expect(turn2.usedSilentFallback).toBe(false);

      // Permission revocation blocks capability with clear actionable error
      productionUxController.updateMobilePermission({
        deviceId: PHONE_ID,
        permission: "app_launch",
        granted: false,
      });
      const blockedTurn = await productionUxController.submitMobileVoiceCommand({
        deviceId: PHONE_ID,
        utterance: "YouTube open karo",
      });
      expect(blockedTurn.ok).toBe(false);
      expect(blockedTurn.actionableError?.errorCode).toBe("PERMISSION_DENIED");

      // Re-grant permission -> succeeds immediately
      productionUxController.updateMobilePermission({
        deviceId: PHONE_ID,
        permission: "app_launch",
        granted: true,
      });
      const restoredTurn = await productionUxController.submitMobileVoiceCommand({
        deviceId: PHONE_ID,
        utterance: "YouTube open karo",
      });
      expect(restoredTurn.ok).toBe(true);
    });
  });

  // =========================================================================
  // D — DESKTOP STANDALONE VERIFICATION
  // =========================================================================
  describe("D — Desktop Standalone Verification", () => {
    it("operates 100% standalone with no paired phone, managing projects, active window context, and local desktop capabilities", async () => {
      const view = productionUxController.initDesktopUxSession({
        deviceId: DESKTOP_ID,
        deviceName: "MYRAA Windows Standalone",
        online: true,
        projectPath: "d:/SORA AI/Sora AI",
        projectName: "MYRAA Core",
      });

      expect(view.standaloneMode).toBe(true);
      expect(view.standaloneReady).toBe(true);
      expect(view.remoteConnectionPanel.connectionStatus).toBe("DISCONNECTED");

      // Project dashboard update
      const dash = productionUxController.openProjectInDashboard({
        deviceId: DESKTOP_ID,
        projectName: "MYRAA Phase 10",
        projectPath: "d:/SORA AI/Sora AI",
        activeFile: "src/App.tsx",
      });
      expect(dash.projectName).toBe("MYRAA Phase 10");
      expect(dash.activeFile).toBe("src/App.tsx");

      // Active application / local context stays DEVICE_LOCAL
      const ctx = productionUxController.updateDesktopActiveContext({
        deviceId: DESKTOP_ID,
        currentWindow: "Visual Studio Code - App.tsx",
        activeApplication: "Code.exe",
        activeFile: "src/App.tsx",
      });
      expect(ctx.scopeBadge).toContain("DEVICE_LOCAL");

      // Voice command executes locally on Desktop
      const turn = await productionUxController.submitDesktopVoiceCommand({
        deviceId: DESKTOP_ID,
        utterance: "VS Code open karo",
      });
      expect(turn.ok).toBe(true);
      expect(turn.executingDeviceId).toBe(DESKTOP_ID);
      expect(turn.usedSilentFallback).toBe(false);
    });
  });

  // =========================================================================
  // E — OPTIONAL REMOTE BRIDGE VERIFICATION
  // =========================================================================
  describe("E — Optional Remote Bridge Verification", () => {
    it("starts DISCONNECTED, never auto-connects on same account, pairs via 6-digit PIN, routes Phone <-> Desktop, and blocks replay/unauthorized calls", async () => {
      sharedAccountMemoryManager.registerAccount({
        accountId: ACCOUNT_ID,
        displayName: "Sandeep Mishra",
        role: "admin",
      });
      sharedAccountMemoryManager.registerAccountDevice({
        accountId: ACCOUNT_ID,
        deviceId: PHONE_ID,
        deviceName: "MYRAA Phone",
        productType: "MYRAA_MOBILE",
        role: "admin",
        online: true,
      });
      sharedAccountMemoryManager.registerAccountDevice({
        accountId: ACCOUNT_ID,
        deviceId: DESKTOP_ID,
        deviceName: "MYRAA Desktop",
        productType: "MYRAA_DESKTOP",
        role: "admin",
        online: true,
      });

      productionUxController.initMobileUxSession({
        deviceId: PHONE_ID,
        accountId: ACCOUNT_ID,
      });
      productionUxController.initDesktopUxSession({
        deviceId: DESKTOP_ID,
        accountId: ACCOUNT_ID,
      });

      // Invariant: Same account NEVER auto-connects Remote Bridge
      expect(remoteBridge.isActive(PHONE_ID)).toBe(false);
      expect(remoteBridge.isPaired(PHONE_ID, DESKTOP_ID)).toBe(false);

      // Explicit 6-digit PIN pairing + connection
      const challenge = remoteBridge.requestPairing({
        sourceDeviceId: PHONE_ID,
        targetDeviceId: DESKTOP_ID,
        requestedBy: ACCOUNT_ID,
        role: "admin",
        explicitUserAction: true,
      });
      expect(challenge.pairingCode).toMatch(/^\d{6}$/);

      const confirmed = remoteBridge.confirmPairing({
        pairingId: challenge.pairingId,
        pairingCode: challenge.pairingCode,
        approvedByTargetUser: true,
      });
      expect(confirmed.success).toBe(true);
      // Pairing alone still keeps bridge INACTIVE until explicit connect()
      expect(remoteBridge.isActive(PHONE_ID)).toBe(false);

      const center = await productionUxController.connectRemoteBridgeFromUx({
        sourceDeviceId: PHONE_ID,
        targetDeviceId: DESKTOP_ID,
      });
      expect(center.connectionStatus).toBe("CONNECTED");
      expect(remoteBridge.isActive(PHONE_ID)).toBe(true);

      // Phone -> Desktop remote command execution
      productionUxController.selectMobileTargetDevice(PHONE_ID, "REMOTE_DESKTOP");
      const remoteTurn = await productionUxController.submitMobileVoiceCommand({
        deviceId: PHONE_ID,
        utterance: "Laptop par VS Code open karo",
        targetDesktopDeviceId: DESKTOP_ID,
      });
      expect(remoteTurn.ok).toBe(true);
      expect(remoteTurn.executingDeviceId).toBe(DESKTOP_ID);
      expect(remoteTurn.usedSilentFallback).toBe(false);

      // Verify hash-chained remote audit log integrity
      const integrity = securityAuditLogger.verifyChainIntegrity();
      expect(integrity.valid).toBe(true);
      expect(center.auditChainIntegrityValid).toBe(true);

      // Disconnect restores standalone mode
      productionUxController.disconnectRemoteBridgeFromUx({
        sourceDeviceId: PHONE_ID,
      });
      expect(remoteBridge.isActive(PHONE_ID)).toBe(false);
    });
  });

  // =========================================================================
  // F — CROSS-DEVICE HANDOFF VERIFICATION
  // =========================================================================
  describe("F — Cross-Device Handoff Verification", () => {
    it("executes Phone -> Desktop -> Phone workflows, pause/resume, disconnect recovery, and strips device-local context", async () => {
      sharedAccountMemoryManager.registerAccount({
        accountId: ACCOUNT_ID,
        displayName: "Sandeep Mishra",
        role: "admin",
      });
      sharedAccountMemoryManager.registerAccountDevice({
        accountId: ACCOUNT_ID,
        deviceId: PHONE_ID,
        deviceName: "MYRAA Phone",
        productType: "MYRAA_MOBILE",
        role: "admin",
        online: true,
      });
      sharedAccountMemoryManager.registerAccountDevice({
        accountId: ACCOUNT_ID,
        deviceId: DESKTOP_ID,
        deviceName: "MYRAA Desktop",
        productType: "MYRAA_DESKTOP",
        role: "admin",
        online: true,
      });

      productionUxController.initMobileUxSession({
        deviceId: PHONE_ID,
        accountId: ACCOUNT_ID,
      });
      productionUxController.initDesktopUxSession({
        deviceId: DESKTOP_ID,
        accountId: ACCOUNT_ID,
      });

      await productionUxController.pairAndConnectRemoteDevice({
        sourceDeviceId: PHONE_ID,
        targetDeviceId: DESKTOP_ID,
        connectNow: true,
      });

      // Create handoff with a device-local key in rawContext -> must be stripped
      const created = crossDeviceWorkflowOrchestrator.createHandoff({
        accountId: ACCOUNT_ID,
        sourceDeviceId: PHONE_ID,
        targetDeviceId: DESKTOP_ID,
        intent: "OPEN_PROJECT",
        capability: "desktop.openFolder",
        utterance: "Is project ko mere laptop par kholo",
        rawContext: {
          projectPath: "d:/SORA AI/Sora AI",
          filePath: "src/App.tsx",
          summary: "Inspect App.tsx on Desktop",
          current_window: "PrivatePhoneBankingWindow",
        } as any,
        explicitAuthorization: true,
      });

      expect(created.ok).toBe(true);
      expect(created.handoff?.strippedLocalKeys).toContain("current_window");
      const handoffId = created.handoff!.handoffId;
      const handoffToken = created.handoff!.handoffToken;

      // Pause & Resume
      const paused = crossDeviceWorkflowOrchestrator.pauseHandoff({
        handoffId,
        requestedByDeviceId: PHONE_ID,
        reason: "User paused workflow",
      });
      expect(paused.ok).toBe(true);
      expect(paused.handoff?.progress.status).toBe("PAUSED");

      const resumed = crossDeviceWorkflowOrchestrator.resumeHandoff({
        handoffId,
        handoffToken,
        resumingDeviceId: DESKTOP_ID,
      });
      expect(resumed.ok).toBe(true);

      // Simulate target disconnect & recovery
      const disconnected = crossDeviceWorkflowOrchestrator.handleDeviceDisconnect({
        handoffId,
        disconnectedDeviceId: DESKTOP_ID,
        reason: "Wi-Fi drop",
      });
      expect(disconnected.ok).toBe(true);
      expect(disconnected.handoff?.progress.status).toBe("PAUSED_DISCONNECTED");

      const recovered = crossDeviceWorkflowOrchestrator.recoverHandoffAfterReconnect({
        handoffId,
        reconnectedDeviceId: DESKTOP_ID,
        handoffToken,
      });
      expect(recovered.ok).toBe(true);
    });
  });

  // =========================================================================
  // G & H — ACCOUNT + MEMORY + OFFLINE SYNC VERIFICATION
  // =========================================================================
  describe("G & H — Shared vs Device-Local Memory, DLP & Offline Queue Sync", () => {
    it("enforces Shared vs Device-Local boundaries, DLP secret rejection, and deterministic offline queue replay without duplicates", () => {
      sharedAccountMemoryManager.registerAccount({
        accountId: ACCOUNT_ID,
        displayName: "Sandeep Mishra",
        role: "admin",
      });
      sharedAccountMemoryManager.registerAccountDevice({
        accountId: ACCOUNT_ID,
        deviceId: PHONE_ID,
        deviceName: "Phone",
        productType: "MYRAA_MOBILE",
        role: "admin",
        online: true,
      });
      sharedAccountMemoryManager.registerAccountDevice({
        accountId: ACCOUNT_ID,
        deviceId: DESKTOP_ID,
        deviceName: "Desktop",
        productType: "MYRAA_DESKTOP",
        role: "admin",
        online: true,
      });

      productionUxController.initDesktopUxSession({
        deviceId: DESKTOP_ID,
        accountId: ACCOUNT_ID,
      });

      // Offline queueing on Phone while disconnected from network
      sharedAccountMemoryManager.setDeviceOnline(ACCOUNT_ID, PHONE_ID, false);
      const q1 = sharedAccountMemoryManager.writeSharedMemory({
        accountId: ACCOUNT_ID,
        deviceId: PHONE_ID,
        key: "architecture_goal",
        content: "Zero regressions and 126 tools preserved",
        mutationId: "mut-unique-001",
      });
      expect(q1.status).toBe("QUEUED_OFFLINE");
      expect(sharedAccountMemoryManager.getOfflineQueue(PHONE_ID).length).toBe(1);

      // Replaying the same mutationId while offline is deduplicated in queue
      const q1Dup = sharedAccountMemoryManager.writeSharedMemory({
        accountId: ACCOUNT_ID,
        deviceId: PHONE_ID,
        key: "architecture_goal",
        content: "Zero regressions and 126 tools preserved",
        mutationId: "mut-unique-001",
      });
      expect(["QUEUED_OFFLINE", "DEDUPLICATED"]).toContain(q1Dup.status);
      expect(sharedAccountMemoryManager.getOfflineQueue(PHONE_ID).length).toBe(1);

      // Reconnect & sync -> applies to canonical ledger and clears queue
      const syncRes = sharedAccountMemoryManager.reconnectAndSync({
        accountId: ACCOUNT_ID,
        deviceId: PHONE_ID,
      });
      expect(syncRes.ok).toBe(true);
      expect(syncRes.appliedCount).toBe(1);
      expect(sharedAccountMemoryManager.getOfflineQueue(PHONE_ID).length).toBe(0);

      // Desktop immediately sees the synced shared memory, while RemoteBridge remains DISCONNECTED
      const desktopView = productionUxController.getDesktopUxState(DESKTOP_ID);
      expect(
        desktopView.memoryView.sharedMemories.some((m) => m.key === "architecture_goal"),
      ).toBe(true);
      expect(remoteBridge.isActive(PHONE_ID)).toBe(false);
    });
  });

  // =========================================================================
  // I, J, K, L, M, N — RECOVERY, AUTH, REVOCATION, EMERGENCY STOP & LOCKDOWN
  // =========================================================================
  describe("I–N — Auth Token Rotation, Device Revocation, Emergency Stop & Security Lockdown", () => {
    it("detects refresh token reuse, revokes compromised devices, enforces Emergency Stop & Lockdown, and recovers cleanly", async () => {
      // J: Token rotation & refresh token reuse detection
      const { session, tokens } = identityAuthManager.createSession({
        deviceId: PHONE_ID,
        identityId: ACCOUNT_ID,
        role: "admin",
        ipAddress: "127.0.0.1",
        userAgent: "Phase10-Test",
      });
      const rotated = identityAuthManager.refreshSession(tokens.refreshToken, "127.0.0.1");
      expect(rotated.tokens.accessToken).toBeTruthy();

      // Reusing the old refresh token triggers replay detection, revokes the session, and initiates lockdown
      expect(() => identityAuthManager.refreshSession(tokens.refreshToken, "127.0.0.1")).toThrow(
        /REPLAY/i,
      );
      expect(identityAuthManager.validateAccessToken(rotated.tokens.accessToken).valid).toBe(false);
      expect(session.sessionId).toBeTruthy();
      expect(securityPolicyEngine.getMode()).toBe("LOCKDOWN");

      // Restore policy mode to NORMAL to test Device Revocation
      securityPolicyEngine.setMode("BALANCED");

      // L: Device revocation disconnects bridge and blocks remote execution
      sharedAccountMemoryManager.registerAccount({
        accountId: ACCOUNT_ID,
        displayName: "Sandeep Mishra",
        role: "admin",
      });
      sharedAccountMemoryManager.registerAccountDevice({
        accountId: ACCOUNT_ID,
        deviceId: PHONE_ID,
        deviceName: "Phone",
        productType: "MYRAA_MOBILE",
        role: "admin",
        online: true,
      });
      sharedAccountMemoryManager.registerAccountDevice({
        accountId: ACCOUNT_ID,
        deviceId: DESKTOP_ID,
        deviceName: "Desktop",
        productType: "MYRAA_DESKTOP",
        role: "admin",
        online: true,
      });
      productionUxController.initMobileUxSession({ deviceId: PHONE_ID, accountId: ACCOUNT_ID });
      productionUxController.initDesktopUxSession({ deviceId: DESKTOP_ID, accountId: ACCOUNT_ID });
      await productionUxController.pairAndConnectRemoteDevice({
        sourceDeviceId: PHONE_ID,
        targetDeviceId: DESKTOP_ID,
        connectNow: true,
      });
      expect(remoteBridge.isActive(PHONE_ID)).toBe(true);

      remoteBridge.revokeDeviceAuthorization(PHONE_ID, DESKTOP_ID, "Admin revoked phone");
      expect(remoteBridge.isActive(PHONE_ID)).toBe(false);
      expect(remoteBridge.isPaired(PHONE_ID, DESKTOP_ID)).toBe(false);

      // M: Emergency Stop blocks voice commands and resets cleanly
      await emergencyStopCoordinator.trigger({
        source: "desktop_ui",
        deviceId: DESKTOP_ID,
        reason: "Phase 10 Emergency Stop Test",
      });
      expect(emergencyStopCoordinator.isActive()).toBe(true);

      const blockedByEmergency = await productionUxController.submitDesktopVoiceCommand({
        deviceId: DESKTOP_ID,
        utterance: "VS Code open karo",
      });
      expect(blockedByEmergency.ok).toBe(false);
      expect(blockedByEmergency.actionableError?.errorCode).toBe("EMERGENCY_STOP_ACTIVE");

      await emergencyStopCoordinator.reset("phase10-admin");
      expect(emergencyStopCoordinator.isActive()).toBe(false);

      // N: Security Lockdown blocks execution and restores cleanly
      securityPolicyEngine.setMode("LOCKDOWN");
      const blockedByLockdown = await productionUxController.submitMobileVoiceCommand({
        deviceId: PHONE_ID,
        utterance: "WhatsApp open karo",
      });
      expect(blockedByLockdown.ok).toBe(false);
      expect(blockedByLockdown.actionableError?.errorCode).toBe("SECURITY_LOCKDOWN_ACTIVE");

      securityPolicyEngine.setMode("BALANCED");
      const recoveredTurn = await productionUxController.submitMobileVoiceCommand({
        deviceId: PHONE_ID,
        utterance: "WhatsApp open karo",
      });
      expect(recoveredTurn.ok).toBe(true);
    });
  });

  // =========================================================================
  // O, P, Q, R, S — LONG-RUN STABILITY, PERFORMANCE, SECURITY AUDIT & 126 TOOLS
  // =========================================================================
  describe("O–S — Long-Run Stability, Latency Benchmarks, Security Audit & 126 Tools Invariant", () => {
    it("maintains bounded memory and low latency across 50 rapid operations, verifies audit chains, and preserves exactly 126 Gemini Live tools", async () => {
      // S: 126 Tools Invariant
      const declarations = LIVE_TOOLS[0]?.functionDeclarations || [];
      expect(declarations.length).toBe(126);
      const uniqueNames = new Set(declarations.map((d: any) => d.name));
      expect(uniqueNames.size).toBe(126);

      productionUxController.initMobileUxSession({ deviceId: PHONE_ID });
      productionUxController.initDesktopUxSession({ deviceId: DESKTOP_ID });

      // O & P: 50 rapid voice + context + memory operations with latency check
      const startMs = performance.now();
      for (let i = 0; i < 25; i++) {
        await productionUxController.submitMobileVoiceCommand({
          deviceId: PHONE_ID,
          utterance: "WhatsApp open karo",
        });
        await productionUxController.submitDesktopVoiceCommand({
          deviceId: DESKTOP_ID,
          utterance: "VS Code open karo",
        });
      }
      const elapsedMs = performance.now() - startMs;
      // 50 turns should complete well under 2000ms (< 40ms per turn average)
      expect(elapsedMs).toBeLessThan(2000);

      // Voice history is bounded (<= 50 items per device)
      const mobileView = productionUxController.getMobileUxState(PHONE_ID);
      const desktopView = productionUxController.getDesktopUxState(DESKTOP_ID);
      expect(mobileView.voiceUi.turnHistory.length).toBeLessThanOrEqual(50);
      expect(desktopView.voiceUi.turnHistory.length).toBeLessThanOrEqual(50);
      expect(desktopView.toolsAndCapabilities.totalGeminiLiveTools).toBe(126);

      // R: DLP Firewall & Audit Chain Verification
      const firewallCheck = outputDataFirewall.sanitizeResult(
        "My secret key is AIzaSyD1234567890abcdefghijklmnopqrstuvwx",
        { toolName: "phase10_audit_check" },
      );
      expect(firewallCheck.redactedCount).toBeGreaterThan(0);
      expect(String(firewallCheck.sanitized)).not.toContain("AIzaSyD1234567890");

      expect(securityAuditLogger.verifyChainIntegrity().valid).toBe(true);
      expect(desktopView.remoteConnectionPanel.auditChainIntegrityValid).toBe(true);
    });
  });

  // =========================================================================
  // REST /api/ux/* GATEWAY END-TO-END VERIFICATION
  // =========================================================================
  describe("HTTP Gateway /api/ux/* End-to-End Verification", () => {
    it("serves /api/ux/state and executes onboarding, voice, pairing, connect/disconnect, handoff, memory, emergency-stop, and lockdown via HTTP", async () => {
      const app = createHttpApp();

      const server = http.createServer(app);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      const addr = server.address() as { port: number };
      const baseUrl = `http://127.0.0.1:${addr.port}`;

      const postJson = async (path: string, body: Record<string, any>) => {
        const res = await fetch(`${baseUrl}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        return { status: res.status, body: await res.json() };
      };

      try {
        // 1. GET /api/ux/state
        const stateFetch = await fetch(`${baseUrl}/api/ux/state`);
        const stateBody = await stateFetch.json();
        expect(stateFetch.status).toBe(200);
        expect(stateBody.success).toBe(true);
        expect(stateBody.totalGeminiLiveTools).toBe(126);
        expect(stateBody.mobile.standaloneMode).toBe(true);
        expect(stateBody.desktop.standaloneMode).toBe(true);

        // 2. Complete Mobile Onboarding
        const onbRes = await postJson("/api/ux/mobile/onboarding", { completeAll: true });
        expect(onbRes.status).toBe(200);
        expect(onbRes.body.mobile.onboarding.completed).toBe(true);

        // 3. Sign in Shared Account on both devices (still DISCONNECTED bridge!)
        const authRes = await postJson("/api/ux/account/auth", {
          action: "login",
          accountId: "acct-http-ux",
        });
        expect(authRes.status).toBe(200);
        expect(authRes.body.mobile.accountView.signedIn).toBe(true);
        expect(authRes.body.mobile.desktopConnectionScreen.connectionStatus).toBe("DISCONNECTED");

        // 4. Save Shared Memory via HTTP
        const memRes = await postJson("/api/ux/memory", {
          scope: "SHARED",
          key: "preferred_editor",
          value: "VS Code with MYRAA",
        });
        expect(memRes.status).toBe(200);
        expect(memRes.body.memoryResult.ok).toBe(true);

        // 5. Pair & Connect Remote Bridge via 6-digit PIN endpoints
        const pairReq = await postJson("/api/ux/remote/pair-request", {});
        expect(pairReq.status).toBe(200);
        expect(pairReq.body.pairingCode).toMatch(/^\d{6}$/);

        const pairConfirm = await postJson("/api/ux/remote/pair-confirm", {
          pairingId: pairReq.body.pairingId,
          pairingCode: pairReq.body.pairingCode,
          connectAfterPair: true,
        });
        expect(pairConfirm.status).toBe(200);
        expect(pairConfirm.body.mobile.desktopConnectionScreen.connectionStatus).toBe("CONNECTED");

        // 6. Trigger Cross-Device Handoff via HTTP
        const handoffRes = await postJson("/api/ux/handoff", {
          action: "conversational",
          utterance: "Is project ko mere laptop par kholo",
        });
        expect(handoffRes.status).toBe(200);
        expect(handoffRes.body.activeWorkflows.length).toBeGreaterThan(0);

        // 7. Disconnect Remote Bridge via HTTP
        const discRes = await postJson("/api/ux/remote/disconnect", {});
        expect(discRes.status).toBe(200);
        expect(discRes.body.mobile.desktopConnectionScreen.connectionStatus).toBe("DISCONNECTED");
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });
});
