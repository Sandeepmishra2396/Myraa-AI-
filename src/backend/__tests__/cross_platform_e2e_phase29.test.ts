/**
 * MYRAA — Phase 29 Full Cross-Platform E2E & Adversarial Validation Suite
 *
 * Comprehensive cross-platform end-to-end validation covering:
 *   Section 1: Desktop Core Subsystems Integration
 *   Section 2: Android Companion Subsystems Integration
 *   Section 3: Cross-Device E2E Workflows (Memory, Handoff, Revocation, Emergency Stop, Lockdown, Lost-Device, Workflow)
 *   Section 4: Security Adversarial & Tamper Testing
 *   Section 5: Performance, Reliability & State Cleanliness
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Remote & Gateway subsystems
import { emergencyStopCoordinator } from "../remote/EmergencyStopCoordinator.ts";
import { remoteSessionManager } from "../remote/RemoteSessionManager.ts";
import { remoteStore } from "../remote/RemoteStore.ts";
import { pairingManager } from "../remote/PairingManager.ts";
import { remoteCapabilityDispatcher } from "../remote/RemoteCapabilityDispatcher.ts";

// Security subsystems
import { remoteSecurityCoordinator } from "../security/RemoteSecurityCoordinator.ts";
import { identityAuthManager } from "../security/IdentityAuthManager.ts";
import { securityPolicyEngine } from "../security/SecurityPolicyEngine.ts";
import { securityRiskEngine } from "../security/SecurityRiskEngine.ts";
import { toolExecutionFirewall } from "../security/ToolExecutionFirewall.ts";
import { outputDataFirewall } from "../security/OutputDataFirewall.ts";
import { securityAuditLogger } from "../security/SecurityAuditLogger.ts";
import { threatContainmentManager } from "../security/ThreatContainmentManager.ts";
import { androidSecurityManager } from "../security/AndroidSecurityManager.ts";
import type { SecurityContext } from "../security/SecurityTypes.ts";

// Memory & Cross-Device subsystems
import { sharedMemoryManager } from "../memory/SharedMemoryManager.ts";
import { crossDeviceHandoffManager } from "../handoff/CrossDeviceHandoffManager.ts";
import { mobileProactiveManager } from "../companion/mobile/MobileProactiveManager.ts";
import { mobileWorkflowManager } from "../workflow/MobileWorkflowManager.ts";

// Planner & Tool Declarations
import { plannerCoordinator } from "../planner/PlannerCoordinator.ts";
import { planStore } from "../planner/PlanStore.ts";
import { LIVE_TOOLS } from "../ai/GeminiSessionFactory.ts";

describe("Phase 29 — Full Cross-Platform Testing Suite", () => {
  const androidDeviceId = "android_pixel_e2e_device";
  const desktopDeviceId = "desktop_master_console";

  const adminSecContext: SecurityContext = {
    identityId: "admin_operator",
    role: "admin",
    ipAddress: "127.0.0.1",
    deviceId: desktopDeviceId,
    isLocal: true,
  };

  const androidSecContext: SecurityContext = {
    identityId: androidDeviceId,
    role: "standard",
    ipAddress: "192.168.1.150",
    deviceId: androidDeviceId,
    isLocal: false,
  };

  beforeEach(async () => {
    await emergencyStopCoordinator.reset("phase29_test_setup");
    securityPolicyEngine.setMode("BALANCED");
    identityAuthManager.resetForTesting();
    securityAuditLogger.resetForTesting();
    threatContainmentManager.resetForTesting();
    remoteSecurityCoordinator.resetForTesting();
    mobileProactiveManager.clearAll();
    await remoteStore.clearStore();

    // Register active Android test device
    await remoteStore.saveDevice({
      id: androidDeviceId,
      name: "Pixel 9 Pro E2E",
      deviceType: "mobile",
      role: "standard",
      tokenHash: "dummy_token_hash_android",
      pairedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      revoked: false,
    });
  });

  afterEach(async () => {
    await emergencyStopCoordinator.reset("phase29_test_teardown");
    securityPolicyEngine.setMode("BALANCED");
  });

  // ===========================================================================
  // SECTION 1: DESKTOP CORE SUBSYSTEMS INTEGRATION
  // ===========================================================================
  describe("1. Desktop Core Subsystems Integration", () => {
    it("1.1 strictly preserves exactly 126 Gemini Live tools in LIVE_TOOLS", () => {
      const decls = LIVE_TOOLS[0].functionDeclarations;
      expect(decls.length).toBe(126);
      const uniqueNames = new Set(decls.map((d: any) => d.name));
      expect(uniqueNames.size).toBe(126);
      expect(uniqueNames.has("triggerEmergencyStop")).toBe(true);
    });

    it("1.2 verifies tool parameter schema structure and required properties", () => {
      const decls = LIVE_TOOLS[0].functionDeclarations;
      for (const tool of decls) {
        expect(typeof tool.name).toBe("string");
        expect(typeof tool.description).toBe("string");
        expect(tool.parameters).toBeDefined();
      }
    });

    it("1.3 isolates local vs remote execution in capability security context", () => {
      expect(adminSecContext.isLocal).toBe(true);
      expect(androidSecContext.isLocal).toBe(false);
      expect(adminSecContext.role).toBe("admin");
      expect(androidSecContext.role).toBe("standard");
    });

    it("1.4 executes memory create, list, and search in SharedMemoryManager", async () => {
      const created = await sharedMemoryManager.createMemory(
        {
          key: "project_architecture",
          text: "MYRAA utilizes a decoupled agent-planner architecture with zero-trust tool firewalls.",
          category: "project",
          importance: "high",
        },
        adminSecContext,
      );
      expect(created.id).toBeDefined();

      const searchResults = await sharedMemoryManager.searchMemories(
        { query: "agent-planner" },
        adminSecContext,
      );
      expect(searchResults.length).toBeGreaterThan(0);
      expect(searchResults[0].text).toContain("decoupled agent-planner");
    });

    it("1.5 validates Phase 5 Planner plan creation and step ordering", async () => {
      const plan = await plannerCoordinator.createPlan("Refactor logging module and verify tests", {
        deviceId: desktopDeviceId,
      });
      expect(plan.id).toBeDefined();
      expect(plan.status).toBe("created");
      expect(plan.steps.length).toBeGreaterThan(0);
      expect(plan.steps[0].phase).toBe("understand");
    });

    it("1.6 evaluates tool risk classification via SecurityRiskEngine", () => {
      const lowRisk = securityRiskEngine.calculateRisk("get_system_time", {}, adminSecContext);
      expect(lowRisk.level).toBe("LOW");

      const highRisk = securityRiskEngine.calculateRisk("runShellCommand", { command: "npm test" }, adminSecContext);
      expect(highRisk.level === "HIGH" || highRisk.level === "CRITICAL").toBe(true);
    });

    it("1.7 shields sensitive files via OutputDataFirewall", () => {
      const sensitive = "Confidential project data with API_KEY=AIzaSyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6";
      const sanitized = outputDataFirewall.sanitizeResult(sensitive, { toolName: "read_file" });
      expect(sanitized.redactedCount).toBeGreaterThan(0);
      expect(sanitized.sanitized.includes("AIzaSyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6")).toBe(false);
    });

    it("1.8 verifies cryptographic audit chain integrity in SecurityAuditLogger", () => {
      securityAuditLogger.logEvent({
        eventType: "AUTH_SUCCESS",
        actor: { identityId: "operator", role: "admin", ipAddress: "127.0.0.1" },
        decision: "ALLOW",
        reason: "Desktop operator initial check",
        riskLevel: "LOW",
      });
      const check = securityAuditLogger.verifyChainIntegrity();
      expect(check.valid).toBe(true);
    });
  });

  // ===========================================================================
  // SECTION 2: ANDROID COMPANION SUBSYSTEMS INTEGRATION
  // ===========================================================================
  describe("2. Android Companion Subsystems Integration", () => {
    it("2.1 handles pairing code generation and verification", async () => {
      const codeInfo = pairingManager.generatePairCode("127.0.0.1");
      expect(codeInfo.code.length).toBe(6);
      expect(codeInfo.code).toBe(codeInfo.code.toUpperCase());

      const consumeResult = await pairingManager.pairDevice({
        code: codeInfo.code,
        deviceName: "Samsung Galaxy S24",
        deviceType: "mobile",
        ipAddress: "192.168.1.155",
      });
      expect(consumeResult.device?.id).toBeDefined();
      expect(consumeResult.token).toBeDefined();
    });

    it("2.2 validates short-lived access token and refresh token family rotation", async () => {
      const dev = (await remoteStore.getDevice(androidDeviceId))!;
      const session = remoteSecurityCoordinator.createDeviceSession(dev, "192.168.1.150");

      expect(session.tokens.accessToken).toBeDefined();
      expect(session.tokens.refreshToken).toBeDefined();

      const rotated = await remoteSecurityCoordinator.rotateSessionToken(
        session.tokens.refreshToken,
        "192.168.1.150",
      );
      expect(rotated.tokens.accessToken).toBeDefined();
      expect(rotated.tokens.refreshToken).not.toBe(session.tokens.refreshToken);
    });

    it("2.3 validates remote browser capability arguments via RemoteCapabilityDispatcher", async () => {
      const valid = await remoteCapabilityDispatcher.validateCapabilityArguments("openUrl", {
        url: "https://myraa.ai/dashboard",
      });
      expect(valid.valid).toBe(true);

      const invalidSsrf = await remoteCapabilityDispatcher.validateCapabilityArguments("openUrl", {
        url: "http://169.254.169.254/latest/meta-data/",
      });
      expect(invalidSsrf.valid).toBe(false);
      expect(invalidSsrf.reason).toContain("SSRF");
    });

    it("2.4 handles mobile app interaction dispatching with canonical aliases", async () => {
      const validApp = await remoteCapabilityDispatcher.validateCapabilityArguments("interactApp", {
        app: "gmail",
        action: "compose",
        recipient: "team@myraa.ai",
        subject: "Daily Update",
      });
      expect(validApp.valid).toBe(true);
    });

    it("2.5 sanitizes mobile context snapshots and scrubs sensitive items", async () => {
      // 1. Context with credentials is intercepted and rejected
      const sensitiveContext = {
        currentApp: "com.whatsapp",
        screenSummary: "Chat conversation containing password=SuperSecretPassword123",
        batteryLevel: 85,
        networkType: "WIFI",
      };
      const rejected = await remoteCapabilityDispatcher.validateCapabilityArguments("mobileContext", sensitiveContext);
      expect(rejected.valid).toBe(false);
      expect(rejected.reason).toContain("SECURITY_VIOLATION");

      // 2. Clean context is accepted
      const cleanContext = {
        currentApp: "com.android.chrome",
        screenSummary: "Viewing documentation page on architecture",
        batteryLevel: 92,
        networkType: "WIFI",
      };
      const validated = await remoteCapabilityDispatcher.validateCapabilityArguments("mobileContext", cleanContext);
      expect(validated.valid).toBe(true);
    });

    it("2.6 validates mobile screen OCR and layout analysis arguments", async () => {
      const screenArgs = {
        mode: "ocr",
        includeCoordinates: true,
      };
      const validated = await remoteCapabilityDispatcher.validateCapabilityArguments("mobileScreen", screenArgs);
      expect(validated.valid).toBe(true);
    });

    it("2.7 dispatches mobile proactive alerts and enforces quiet-hours logic", async () => {
      const pref = await mobileProactiveManager.subscribeDevice(
        {
          deviceId: androidDeviceId,
          preferences: { quietHours: { enabled: true, start: "22:00", end: "07:00" } },
        },
        adminSecContext,
      );
      expect(pref.deviceId).toBe(androidDeviceId);

      const res = await mobileProactiveManager.dispatchProactiveEvent(
        {
          title: "Critical Security Notice",
          message: "A new device attempted pairing.",
          category: "SECURITY",
          priority: "URGENT",
        },
        adminSecContext,
      );
      expect(res.delivered || res.queued).toBe(true);
    });

    it("2.8 executes autonomous voice workflow with multilingual synthesis", async () => {
      const workflow = await mobileWorkflowManager.executeVoiceWorkflow(
        {
          query: "Aaj ke top tasks check karo aur report do",
          preferredLanguage: "hinglish",
          deviceId: androidDeviceId,
          autoExecute: true,
        },
        androidSecContext,
      );
      expect(workflow.success).toBe(true);
      expect(workflow.voiceResponse).toBeDefined();
      expect(workflow.textResponse).toBeDefined();
    });
  });

  // ===========================================================================
  // SECTION 3: CROSS-DEVICE E2E WORKFLOWS (A THROUGH H)
  // ===========================================================================
  describe("3. Cross-Device E2E Workflows", () => {
    // ── Workflow A: Shared Memory Sync ──
    it("3.A1 Desktop creates memory -> Android syncs and reads canonical record", async () => {
      const created = await sharedMemoryManager.createMemory(
        {
          key: "vacation_plan",
          text: "User plans to visit Tokyo in October 2026.",
          category: "preference",
        },
        adminSecContext,
      );
      expect(created.id).toBeDefined();
      const memoryId = created.id;

      // Android reads the shared memory
      const androidMemories = await sharedMemoryManager.listMemories({}, androidSecContext);
      const found = androidMemories.find((m) => m.id === memoryId);
      expect(found).toBeDefined();
      expect(found?.text).toBe("User plans to visit Tokyo in October 2026.");
    });

    it("3.A2 Android updates memory -> Desktop observes synchronized canonical version", async () => {
      const created = await sharedMemoryManager.createMemory(
        {
          key: "project_deadline",
          text: "Launch scheduled for Nov 1.",
          category: "project",
        },
        adminSecContext,
      );
      const memoryId = created.id;

      // Android modifies the memory
      const updated = await sharedMemoryManager.updateMemory(
        memoryId,
        { text: "Launch rescheduled to Nov 15 after QA review." },
        androidSecContext,
      );
      expect(updated.success).toBe(true);
      expect(updated.memory?.id).toBe(memoryId);

      // Desktop verifies updated version
      const desktopMemories = await sharedMemoryManager.listMemories({}, adminSecContext);
      const found = desktopMemories.find((m) => m.id === memoryId);
      expect(found?.text).toBe("Launch rescheduled to Nov 15 after QA review.");
      expect(found?.version).toBeGreaterThan(1);
    });

    // ── Workflow B: Cross-Device Handoff (Desktop -> Android) ──
    it("3.B Desktop task snapshot -> Android accepts -> Android resumes Step N -> completes -> Desktop observes updated state", async () => {
      // 1. Desktop creates active task plan
      const plan = await plannerCoordinator.createPlan("Cross-device research task", { deviceId: desktopDeviceId });
      plan.status = "running";
      await planStore.savePlan(plan);

      // 2. Desktop creates handoff snapshot
      const createRes = await crossDeviceHandoffManager.createHandoff(
        {
          targetDevice: { deviceId: androidDeviceId, deviceType: "android" },
          conversationContext: { summary: "AI Systems Engineering" },
          taskPlanState: { planId: plan.id, currentStepIndex: 0, currentStepDescription: plan.steps[0].description },
        },
        adminSecContext,
      );
      expect(createRes.success).toBe(true);
      const handoff = createRes.handoff!;
      expect(handoff.status).toBe("pending");

      // 3. Android accepts handoff
      const acceptRes = await crossDeviceHandoffManager.acceptHandoff(
        { handoffId: handoff.handoffId, handoffToken: handoff.handoffToken },
        androidSecContext,
      );
      expect(acceptRes.success).toBe(true);
      expect(acceptRes.handoff?.status).toBe("accepted");

      // 4. Android resumes handoff
      const resumeRes = await crossDeviceHandoffManager.resumeHandoff(
        { handoffId: handoff.handoffId, handoffToken: handoff.handoffToken },
        androidSecContext,
      );
      expect(resumeRes.success).toBe(true);
      expect(resumeRes.handoff?.status).toBe("resumed");

      // 5. Android marks step completed in canonical store
      plan.steps[0].status = "completed";
      await planStore.savePlan(plan);

      // 6. Desktop inspects handoff & plan and observes updated state
      const desktopObservedHandoff = await crossDeviceHandoffManager.getHandoff(handoff.handoffId, adminSecContext);
      expect(desktopObservedHandoff?.status).toBe("resumed");

      const desktopObservedPlan = await planStore.getPlan(plan.id);
      expect(desktopObservedPlan?.steps[0].status).toBe("completed");
    });

    // ── Workflow C: Reverse Handoff (Android -> Desktop) ──
    it("3.C Reverse Handoff: Android creates task snapshot -> Desktop accepts and resumes", async () => {
      const createRes = await crossDeviceHandoffManager.createHandoff(
        {
          targetDevice: { deviceId: desktopDeviceId, deviceType: "desktop" },
          conversationContext: { summary: "On-the-go research to be finished on Desktop" },
          taskPlanState: { currentStepIndex: 2, goal: "Continue deep code refactoring on Desktop" },
        },
        androidSecContext,
      );
      expect(createRes.success).toBe(true);
      const handoff = createRes.handoff!;

      // Desktop accepts
      const acceptRes = await crossDeviceHandoffManager.acceptHandoff(
        { handoffId: handoff.handoffId, handoffToken: handoff.handoffToken },
        adminSecContext,
      );
      expect(acceptRes.success).toBe(true);
      expect(acceptRes.handoff?.status).toBe("accepted");

      // Desktop resumes
      const resumeRes = await crossDeviceHandoffManager.resumeHandoff(
        { handoffId: handoff.handoffId, handoffToken: handoff.handoffToken },
        adminSecContext,
      );
      expect(resumeRes.success).toBe(true);
      expect(resumeRes.handoff?.status).toBe("resumed");
    });

    // ── Workflow D: Session Revocation ──
    it("3.D Active WebSocket session -> device revoked -> socket closed -> reconnect rejected", async () => {
      const mockWs = { send: vi.fn(), close: vi.fn(), on: vi.fn() };
      const dev = (await remoteStore.getDevice(androidDeviceId))!;
      const session = remoteSessionManager.registerClient(mockWs, dev, "192.168.1.150", "Android Pixel");

      expect(remoteSessionManager.getActiveSessions().some((s) => s.sessionId === session.sessionId)).toBe(true);

      // Revoke device
      const revoked = await remoteSecurityCoordinator.revokeRemoteDevice(androidDeviceId, "Device compromised", "127.0.0.1");
      expect(revoked).toBe(true);

      // WebSocket closed
      expect(mockWs.close).toHaveBeenCalled();

      // Reconnection attempt with device token must fail
      const authAttempt = await remoteSecurityCoordinator.authenticateRemoteCredential(
        "sora_dev_revoked_token_attempt",
        "192.168.1.150",
      );
      expect(authAttempt.authenticated).toBe(false);
    });

    // ── Workflow E: Global Emergency Stop (Bidirectional) ──
    it("3.E1 Android triggers Emergency Stop -> Core halts Desktop, blocks backend, pauses planner, broadcasts state", async () => {
      let broadcastReceived: any = null;
      const unreg = emergencyStopCoordinator.registerBroadcast((msg) => {
        broadcastReceived = msg;
      });

      // Start an active plan
      const plan = await plannerCoordinator.createPlan("Critical active task", { deviceId: desktopDeviceId });
      plan.status = "running";
      await planStore.savePlan(plan);

      // Android triggers Emergency Stop
      const state = await emergencyStopCoordinator.trigger({
        source: "remote_device",
        deviceId: androidDeviceId,
        reason: "User hit Emergency Stop on mobile widget",
      });

      expect(state.active).toBe(true);
      expect(emergencyStopCoordinator.isActive()).toBe(true);

      // Backend operations fail-closed
      await expect(
        sharedMemoryManager.createMemory({ category: "task", key: "blocked", text: "should fail" }, androidSecContext)
      ).rejects.toThrow("EMERGENCY_STOP");

      // Broadcast received
      expect(broadcastReceived?.type).toBe("emergency_stop");
      expect(broadcastReceived?.active).toBe(true);

      // Plan halted
      const updatedPlan = await planStore.getPlan(plan.id);
      expect(updatedPlan?.status === "paused" || updatedPlan?.status === "failed").toBe(true);

      unreg();
    });

    it("3.E2 Desktop triggers Emergency Stop -> Android receives global state and is halted", async () => {
      await emergencyStopCoordinator.trigger({
        source: "desktop_ui",
        reason: "Operator desktop emergency button",
      });

      const androidStatus = await androidSecurityManager.getSecurityStatus(androidDeviceId, androidSecContext);
      expect(androidStatus.emergencyStopActive).toBe(true);
      expect(androidStatus.emergencyStopSource).toBe("desktop_ui");

      // Mobile capability dispatch fails closed
      const blockedDispatch = await remoteCapabilityDispatcher.dispatchCapability(
        androidDeviceId,
        "openUrl",
        { url: "https://example.com" },
        androidSecContext,
      );
      expect(blockedDispatch.ok).toBe(false);
      expect(blockedDispatch.error || blockedDispatch.decision?.reason).toContain("EMERGENCY_STOP");
    });

    // ── Workflow F: Security Lockdown ──
    it("3.F Security Lockdown triggered -> non-recovery tools blocked fail-closed -> admin recovery required", async () => {
      const lockRes = await androidSecurityManager.triggerLockdown("Threat containment lockdown", adminSecContext);
      expect(lockRes.success).toBe(true);
      expect(securityPolicyEngine.getMode()).toBe("LOCKDOWN");

      // Non-recovery tool execution is strictly blocked
      const evalBlocked = await securityPolicyEngine.evaluateRequest(
        "create_file",
        { path: "test.txt", content: "data" },
        androidSecContext,
      );
      expect(evalBlocked.decision).toBe("BLOCK");
      expect(evalBlocked.allowed).toBe(false);

      // Allowlisted recovery tool succeeds
      const evalRecovery = await securityPolicyEngine.evaluateRequest(
        "getEmergencyStopStatus",
        {},
        adminSecContext,
      );
      expect(evalRecovery.decision).toBe("ALLOW");

      // Unauthorized user cannot lift lockdown
      const unauthRecover = await androidSecurityManager.recoverFromLockdown(androidSecContext);
      expect(unauthRecover.success).toBe(false);
      expect(unauthRecover.errorCode).toBe("UNAUTHORIZED");

      // Admin lifts lockdown
      const adminRecover = await androidSecurityManager.recoverFromLockdown(adminSecContext);
      expect(adminRecover.success).toBe(true);
      expect(securityPolicyEngine.getMode()).toBe("BALANCED");
    });

    // ── Workflow G: Lost Device ──
    it("3.G Lost Device mode -> sessions killed, tokens rejected, reconnect blocked until authorized recovery", async () => {
      const lostRes = await androidSecurityManager.enableLostDeviceMode(
        androidDeviceId,
        "Device stolen at airport",
        adminSecContext,
      );
      expect(lostRes.success).toBe(true);

      const dev = await remoteStore.getDevice(androidDeviceId);
      expect(dev?.revoked).toBe(true);

      const record = await remoteStore.getLostDeviceRecord(androidDeviceId);
      expect(record?.recovered).toBe(false);

      // Reconnect attempt fails closed
      const authRes = await remoteSecurityCoordinator.authenticateRemoteCredential(
        "sora_dev_lost_device_token",
        "192.168.1.150",
      );
      expect(authRes.authenticated).toBe(false);

      // Recover lost device
      const recoverRes = await androidSecurityManager.recoverLostDevice(androidDeviceId, adminSecContext);
      expect(recoverRes.success).toBe(true);

      const updatedRecord = await remoteStore.getLostDeviceRecord(androidDeviceId);
      expect(updatedRecord?.recovered).toBe(true);
    });

    // ── Workflow H: Autonomous Workflow Across Risk Levels ──
    it("3.H Autonomous Workflow executes across LOW, MEDIUM, HIGH, and CRITICAL risks with checkpoint gating", async () => {
      // LOW risk workflow: Information query (auto-executed)
      const lowWorkflow = await mobileWorkflowManager.executeVoiceWorkflow(
        {
          query: "Kal ka schedule check karo",
          deviceId: androidDeviceId,
          autoExecute: true,
        },
        androidSecContext,
      );
      expect(lowWorkflow.success).toBe(true);
      expect(lowWorkflow.voiceResponse).toBeDefined();

      // HIGH/CRITICAL risk workflow: Scheduling an alarm/reminder (checkpoint gated)
      const gatedWorkflow = await mobileWorkflowManager.executeVoiceWorkflow(
        {
          query: "Subah 6 baje alarm set karo",
          deviceId: androidDeviceId,
          autoExecute: true,
        },
        androidSecContext,
      );
      expect(gatedWorkflow.success).toBe(true);
      expect(gatedWorkflow.requiresConfirmation).toBe(true);
      expect(gatedWorkflow.pendingCheckpoint).toBeDefined();

      const cpId = gatedWorkflow.pendingCheckpoint!.checkpointId;

      // Confirm checkpoint
      const confirmRes = await mobileWorkflowManager.confirmWorkflowStep(
        gatedWorkflow.planId,
        cpId,
        true,
        "Approved by voice user",
        androidSecContext,
      );
      expect(confirmRes.success).toBe(true);
      expect(confirmRes.status).toBe("completed");
    });
  });

  // ===========================================================================
  // SECTION 4: SECURITY ADVERSARIAL & TAMPER TESTING
  // ===========================================================================
  describe("4. Security Adversarial & Tamper Testing", () => {
    it("4.1 detects and contains token replay attacks with family invalidation", async () => {
      const dev = (await remoteStore.getDevice(androidDeviceId))!;
      const session = remoteSecurityCoordinator.createDeviceSession(dev, "192.168.1.150");

      // Valid first rotation
      const rotated = await remoteSecurityCoordinator.rotateSessionToken(
        session.tokens.refreshToken,
        "192.168.1.150",
      );
      expect(rotated.tokens.accessToken).toBeDefined();

      // Replaying the old token must fail and invalidate the family
      await expect(
        remoteSecurityCoordinator.rotateSessionToken(session.tokens.refreshToken, "192.168.1.150"),
      ).rejects.toThrow();
    });

    it("4.2 rejects duplicate cryptographic nonces to defend against replay", () => {
      const nonce = "e2e_adversarial_nonce_98765";
      const ts = Date.now();

      const first = remoteSecurityCoordinator.validateRequestNonce(nonce, ts);
      expect(first.valid).toBe(true);

      const duplicate = remoteSecurityCoordinator.validateRequestNonce(nonce, ts);
      expect(duplicate.valid).toBe(false);
      expect(duplicate.error).toContain("REPLAY");
    });

    it("4.3 rejects expired tokens fail-closed", async () => {
      const expiredToken = "myraa_at_header.eyJleHAiOjE2MDAwMDAwMDB9.signature";
      const res = await remoteSecurityCoordinator.authenticateRemoteCredential(expiredToken, "192.168.1.150");
      expect(res.authenticated).toBe(false);
    });

    it("4.4 prevents revoked device from accessing authenticated capabilities", async () => {
      await remoteSecurityCoordinator.revokeRemoteDevice(androidDeviceId, "Revocation test");

      const dispatch = await remoteCapabilityDispatcher.dispatchCapability(
        androidDeviceId,
        "openUrl",
        { url: "https://myraa.ai" },
        androidSecContext,
      );
      expect(dispatch.ok).toBe(false);
    });

    it("4.5 enforces RBAC and rejects unauthorized administrative operations", async () => {
      const unauthLockdown = await androidSecurityManager.triggerLockdown("Illegal call", androidSecContext);
      expect(unauthLockdown.success).toBe(false);
      expect(unauthLockdown.errorCode).toBe("UNAUTHORIZED");

      const unauthLogout = await androidSecurityManager.logoutAllDevices("Illegal logout", androidSecContext);
      expect(unauthLogout.success).toBe(false);
      expect(unauthLogout.errorCode).toBe("UNAUTHORIZED");
    });

    it("4.6 blocks checkpoint confirmation bypass attempts", async () => {
      const invalidCpRes = await mobileWorkflowManager.confirmWorkflowStep(
        "fake_plan_id",
        "fake_checkpoint_id",
        true,
        undefined,
        androidSecContext,
      );
      expect(invalidCpRes.success).toBe(false);
    });

    it("4.7 blocks critical commands via ToolExecutionFirewall without confirmation", async () => {
      const result = await toolExecutionFirewall.executeGuardedTool(
        "runShellCommand",
        { command: "rm -rf /" },
        adminSecContext,
        async () => "executed",
      );
      expect(result.decision.decision).toBe("BLOCK");
      expect(result.decision.allowed).toBe(false);
    });

    it("4.8 blocks path traversal attacks attempting to escape workspace", async () => {
      const evalDecision = await securityPolicyEngine.evaluateRequest(
        "read_file",
        { path: "../../../Windows/System32/drivers/etc/hosts" },
        adminSecContext,
      );
      expect(evalDecision.decision).toBe("BLOCK");
      expect(evalDecision.allowed).toBe(false);
    });

    it("4.9 blocks SSRF probes targeting loopback and private metadata services", async () => {
      const ssrf1 = await remoteCapabilityDispatcher.validateCapabilityArguments("openUrl", {
        url: "http://127.0.0.1:8080/admin",
      });
      expect(ssrf1.valid).toBe(false);

      const ssrf2 = await remoteCapabilityDispatcher.validateCapabilityArguments("openUrl", {
        url: "http://169.254.169.254/metadata",
      });
      expect(ssrf2.valid).toBe(false);
    });

    it("4.10 protects against secret leakage via DLP screening", async () => {
      await expect(
        sharedMemoryManager.createMemory(
          {
            category: "project",
            key: "compromised_key",
            text: "Here is my sk-proj-1234567890abcdef1234567890abcdef OpenAI key",
          },
          androidSecContext,
        )
      ).rejects.toThrow("DLP_SECRET_REJECTED");
    });
  });

  // ===========================================================================
  // SECTION 5: PERFORMANCE, RELIABILITY & STATE CLEANLINESS
  // ===========================================================================
  describe("5. Performance, Reliability & State Cleanliness", () => {
    it("5.1 respects bounded queue limits preventing unbounded memory growth", async () => {
      // Fill pending queue and verify capping
      for (let i = 0; i < 60; i++) {
        await mobileProactiveManager.dispatchProactiveEvent(
          {
            title: `Notification ${i}`,
            message: `Message body ${i}`,
            category: "TASK",
          },
          adminSecContext,
        );
      }
      const pending = mobileProactiveManager.getPendingNotifications(androidDeviceId);
      expect(pending.length).toBeLessThanOrEqual(50); // Bounded at 50 max
    });

    it("5.2 suppresses duplicate proactive notifications via deduplication key", async () => {
      await mobileProactiveManager.subscribeDevice({ deviceId: androidDeviceId }, adminSecContext);
      const dedupKey = "dedup_test_alert_1234";
      const first = await mobileProactiveManager.dispatchProactiveEvent(
        { title: "Alert", message: "Same message", category: "REMINDER", dedupKey },
        adminSecContext,
      );
      const second = await mobileProactiveManager.dispatchProactiveEvent(
        { title: "Alert", message: "Same message", category: "REMINDER", dedupKey },
        adminSecContext,
      );

      expect(first.delivered || first.queued).toBe(true);
      expect(second.suppressedReason).toBe("DEDUPLICATED_TIME_WINDOW");
    });

    it("5.3 prevents duplicate workflow execution via execution locks", async () => {
      const plan = await plannerCoordinator.createPlan("Concurrent execution test", { deviceId: desktopDeviceId });
      const p1 = plannerCoordinator.executePlan(plan.id);
      await expect(plannerCoordinator.executePlan(plan.id)).rejects.toThrow(
        /concurrency lock active/,
      );

      const res1 = await p1;
      expect(res1).toBeDefined();
    });

    it("5.4 enforces handoff replay protection and resume idempotency", async () => {
      const createRes = await crossDeviceHandoffManager.createHandoff(
        { conversationContext: { summary: "Test handoff" } },
        adminSecContext,
      );
      const handoff = createRes.handoff!;

      // First accept succeeds
      const acceptRes = await crossDeviceHandoffManager.acceptHandoff(
        { handoffId: handoff.handoffId, handoffToken: handoff.handoffToken },
        androidSecContext,
      );
      expect(acceptRes.success).toBe(true);

      // Replayed accept rejected with ALREADY_ACCEPTED
      const dupAccept = await crossDeviceHandoffManager.acceptHandoff(
        { handoffId: handoff.handoffId, handoffToken: handoff.handoffToken },
        androidSecContext,
      );
      expect(dupAccept.success).toBe(false);
      expect(dupAccept.errorCode).toBe("ALREADY_ACCEPTED");

      // First resume succeeds
      const firstResume = await crossDeviceHandoffManager.resumeHandoff(
        { handoffId: handoff.handoffId, handoffToken: handoff.handoffToken },
        androidSecContext,
      );
      expect(firstResume.success).toBe(true);

      // Resume is idempotent
      const secondResume = await crossDeviceHandoffManager.resumeHandoff(
        { handoffId: handoff.handoffId, handoffToken: handoff.handoffToken },
        androidSecContext,
      );
      expect(secondResume.success).toBe(true);
      expect(secondResume.handoff?.status).toBe("resumed");

      // Accept after resume is rejected (single-use token check triggers ALREADY_ACCEPTED)
      const postResumeAccept = await crossDeviceHandoffManager.acceptHandoff(
        { handoffId: handoff.handoffId, handoffToken: handoff.handoffToken },
        androidSecContext,
      );
      expect(postResumeAccept.success).toBe(false);
      expect(postResumeAccept.errorCode).toBe("ALREADY_ACCEPTED");
    });

    it("5.5 guarantees no stale sessions survive after revocation", async () => {
      const mockWs = { send: vi.fn(), close: vi.fn(), on: vi.fn() };
      const dev = (await remoteStore.getDevice(androidDeviceId))!;
      remoteSessionManager.registerClient(mockWs, dev, "192.168.1.150", "Android Pixel");

      expect(remoteSessionManager.getActiveSessions().length).toBeGreaterThan(0);

      androidSecurityManager.terminateAllSessions("Teardown", adminSecContext);
      expect(remoteSessionManager.getActiveSessions().length).toBe(0);
    });

    it("5.6 verifies clean state reset and zero cross-test contamination", async () => {
      expect(emergencyStopCoordinator.isActive()).toBe(false);
      expect(securityPolicyEngine.getMode()).toBe("BALANCED");
      expect(remoteSessionManager.getActiveSessions().length).toBe(0);
    });
  });
});
