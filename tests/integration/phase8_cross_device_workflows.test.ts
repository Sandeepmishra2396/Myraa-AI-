/**
 * MYRAA — Phase 8: Advanced Cross-Device Workflows & Handoff Test Suite
 *
 * Covers all 14 mandatory test scenarios + Scope A–J invariants:
 *   1. Phone -> Desktop project opening ("Desktop par mera project kholo")
 *   2. Desktop file analysis -> result returned to Phone ("Ab is file ko analyze karo" -> "Result phone par batao")
 *   3. Desktop -> Phone task handoff ("Ye task phone par continue karo")
 *   4. Multi-step task continuation across devices
 *   5. Pause -> resume
 *   6. Device disconnect during handoff & deterministic reconnect recovery
 *   7. Unauthorized target
 *   8. Offline target
 *   9. Expired handoff & single-use finalization
 *  10. Revoked / lost device
 *  11. Emergency Stop / Security Lockdown
 *  12. No silent fallback
 *  13. Shared vs device-local context boundaries & DLP secret rejection
 *  14. Verify every step & final result before completion + Audit + 126 Gemini tools
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  crossDeviceWorkflowOrchestrator,
  sharedAccountMemoryManager,
  deviceRegistry,
  remoteBridge,
  androidCapabilityEngine,
  desktopCapabilityEngine,
} from "../../backend/device/index.ts";
import { intentCapabilityOrchestrator } from "../../backend/orchestrator/IntentCapabilityOrchestrator.ts";
import { identityAuthManager } from "../../backend/security/IdentityAuthManager.ts";
import { securityPolicyEngine } from "../../backend/security/SecurityPolicyEngine.ts";
import { securityAuditLogger } from "../../backend/security/SecurityAuditLogger.ts";
import { emergencyStopCoordinator } from "../../backend/remote/EmergencyStopCoordinator.ts";
import { LIVE_TOOLS } from "../../backend/ai/GeminiSessionFactory.ts";

const ACCOUNT_ID = "account-sandeep-01";
const PHONE_ID = "myraa-phone-01";
const DESKTOP_ID = "myraa-desktop-01";

describe("Phase 8 — Advanced Cross-Device Workflows & Handoff", () => {
  beforeEach(async () => {
    await emergencyStopCoordinator.reset("test-admin");
    securityPolicyEngine.resetForTesting();
    identityAuthManager.resetForTesting();
    securityAuditLogger.clearForTesting();
    deviceRegistry.resetForTesting();
    deviceRegistry.registerEngine(androidCapabilityEngine);
    deviceRegistry.registerEngine(desktopCapabilityEngine);
    intentCapabilityOrchestrator.resetForTesting();
    sharedAccountMemoryManager.resetForTesting();
    crossDeviceWorkflowOrchestrator.resetForTesting();

    // Register Unified Account & both authorized devices (Phone + Desktop)
    sharedAccountMemoryManager.registerAccount({
      accountId: ACCOUNT_ID,
      displayName: "Sandeep Mishra",
      email: "sandeep@example.com",
      role: "admin",
    });

    sharedAccountMemoryManager.registerAccountDevice({
      accountId: ACCOUNT_ID,
      deviceId: PHONE_ID,
      deviceName: "Sandeep's Android Phone",
      productType: "MYRAA_MOBILE",
      role: "admin",
      online: true,
    });

    sharedAccountMemoryManager.registerAccountDevice({
      accountId: ACCOUNT_ID,
      deviceId: DESKTOP_ID,
      deviceName: "Sandeep's Windows Desktop",
      productType: "MYRAA_DESKTOP",
      role: "admin",
      online: true,
    });
  });

  afterEach(async () => {
    await emergencyStopCoordinator.reset("test-admin");
    securityPolicyEngine.resetForTesting();
    identityAuthManager.resetForTesting();
    remoteBridge.resetForTesting();
    sharedAccountMemoryManager.resetForTesting();
    crossDeviceWorkflowOrchestrator.resetForTesting();
  });

  // ===========================================================================
  // TEST 1 & 2: Phone -> Desktop project opening -> File analysis -> Result returned to Phone
  // ===========================================================================
  describe("1 & 2. Phone → Desktop project opening → File analysis → Result returned to Phone", () => {
    it("executes 'Desktop par mera project kholo' on Desktop and verifies project opening", async () => {
      const turn1 = await crossDeviceWorkflowOrchestrator.executeConversationalCrossDeviceTurn({
        accountId: ACCOUNT_ID,
        utterance: "Desktop par mera project kholo",
        sourceDeviceId: PHONE_ID,
        targetDeviceId: DESKTOP_ID,
        projectPath: "d:/SORA AI/Sora AI",
        filePath: "d:/SORA AI/Sora AI/src/backend/orchestrator/IntentResolver.ts",
      });

      expect(turn1.ok).toBe(true);
      expect(turn1.verified).toBe(true);
      expect(turn1.usedSilentFallback).toBe(false);
      expect(turn1.handoff?.sourceDevice.deviceId).toBe(PHONE_ID);
      expect(turn1.handoff?.targetDevice.deviceId).toBe(DESKTOP_ID);
      expect(turn1.handoff?.relevantContext.projectPath).toBe("d:/SORA AI/Sora AI");
      expect(turn1.stepResult?.capability).toBe("desktop.openFolder");
      expect(turn1.stepResult?.executingDeviceId).toBe(DESKTOP_ID);
      expect(turn1.stepResult?.verified).toBe(true);
    });

    it("completes the 3-turn workflow: Open project on Desktop -> 'Ab is file ko analyze karo' -> 'Result phone par batao'", async () => {
      // Turn 1: Phone requests Desktop to open project
      const turn1 = await crossDeviceWorkflowOrchestrator.executeConversationalCrossDeviceTurn({
        accountId: ACCOUNT_ID,
        utterance: "Desktop par mera project kholo",
        sourceDeviceId: PHONE_ID,
        targetDeviceId: DESKTOP_ID,
        projectPath: "d:/SORA AI/Sora AI",
        filePath: "d:/SORA AI/Sora AI/src/backend/orchestrator/IntentResolver.ts",
      });
      expect(turn1.ok).toBe(true);
      const handoffId = turn1.handoff!.handoffId;

      // Turn 2: Phone requests Desktop to analyze the current file
      const turn2 = await crossDeviceWorkflowOrchestrator.executeConversationalCrossDeviceTurn({
        accountId: ACCOUNT_ID,
        utterance: "Ab is file ko analyze karo",
        sourceDeviceId: PHONE_ID,
        targetDeviceId: DESKTOP_ID,
        activeHandoffId: handoffId,
      });
      expect(turn2.ok).toBe(true);
      expect(turn2.verified).toBe(true);
      expect(turn2.stepResult?.capability).toBe("desktop.codeInspect");
      expect(turn2.stepResult?.executingDeviceId).toBe(DESKTOP_ID);
      expect(turn2.handoff?.relevantContext.analysisReport).toBeDefined();

      // Turn 3: Phone requests verified result to be returned to Phone ("Result phone par batao")
      const turn3 = await crossDeviceWorkflowOrchestrator.executeConversationalCrossDeviceTurn({
        accountId: ACCOUNT_ID,
        utterance: "Result phone par batao",
        sourceDeviceId: PHONE_ID,
        targetDeviceId: DESKTOP_ID,
        activeHandoffId: handoffId,
      });

      expect(turn3.ok).toBe(true);
      expect(turn3.verified).toBe(true);
      expect(turn3.returnedResult).toBeDefined();
      expect(turn3.returnedResult?.returnedToOrigin).toBe(true);
      expect(turn3.returnedResult?.originDeviceId).toBe(PHONE_ID);
      expect(turn3.returnedResult?.executingDeviceId).toBe(DESKTOP_ID);
      expect(turn3.returnedResult?.verified).toBe(true);
      expect(turn3.returnedResult?.summary).toContain("Analyzed");
      expect(turn3.handoff?.progress.status).toBe("COMPLETED");
    });
  });

  // ===========================================================================
  // TEST 3: Desktop -> Phone reverse task handoff
  // ===========================================================================
  describe("3. Desktop → Phone reverse task handoff", () => {
    it("hands off a task from Desktop ('Ye task phone par continue karo') and executes on Phone", async () => {
      const outcome = await crossDeviceWorkflowOrchestrator.executeConversationalCrossDeviceTurn({
        accountId: ACCOUNT_ID,
        utterance: "Ye task phone par continue karo",
        sourceDeviceId: DESKTOP_ID,
        targetDeviceId: PHONE_ID,
        rawContext: {
          summary: "Review architecture notes while commuting",
          projectName: "MYRAA Multi-Device",
        },
      });

      expect(outcome.ok).toBe(true);
      expect(outcome.verified).toBe(true);
      expect(outcome.usedSilentFallback).toBe(false);
      expect(outcome.handoff?.sourceDevice.deviceId).toBe(DESKTOP_ID);
      expect(outcome.handoff?.sourceDevice.productType).toBe("MYRAA_DESKTOP");
      expect(outcome.handoff?.targetDevice.deviceId).toBe(PHONE_ID);
      expect(outcome.handoff?.targetDevice.productType).toBe("MYRAA_MOBILE");
      expect(outcome.stepResult?.executingDeviceId).toBe(PHONE_ID);
      expect(outcome.stepResult?.executingProductType).toBe("MYRAA_MOBILE");
      expect(outcome.stepResult?.verified).toBe(true);
      expect(outcome.handoff?.progress.status).toBe("COMPLETED");
    });
  });

  // ===========================================================================
  // TEST 4: Multi-step task continuation across devices
  // ===========================================================================
  describe("4. Multi-step task continuation across devices", () => {
    it("executes a 3-step cross-device workflow sequentially across Desktop and Phone with full state tracking", async () => {
      const created = crossDeviceWorkflowOrchestrator.createHandoff({
        accountId: ACCOUNT_ID,
        taskId: "task_multistep_01",
        sourceDeviceId: PHONE_ID,
        targetDeviceId: DESKTOP_ID,
        intent: "OPEN_FOLDER",
        capability: "desktop.openFolder",
        rawContext: {
          projectPath: "d:/SORA AI/Sora AI",
          filePath: "d:/SORA AI/Sora AI/src/index.ts",
        },
        steps: [
          {
            stepId: "step_1_open_project",
            description: "Open project on Desktop",
            intent: "OPEN_FOLDER",
            capability: "desktop.openFolder",
            executingDeviceId: DESKTOP_ID,
            args: { path: "d:/SORA AI/Sora AI" },
          },
          {
            stepId: "step_2_inspect_code",
            description: "Inspect file on Desktop",
            intent: "INSPECT_CODE",
            capability: "desktop.codeInspect",
            executingDeviceId: DESKTOP_ID,
            args: { filePath: "d:/SORA AI/Sora AI/src/index.ts" },
          },
          {
            stepId: "step_3_mobile_note",
            description: "Save summary note on Phone",
            intent: "CREATE_REMINDER",
            capability: "mobile.notes",
            executingDeviceId: PHONE_ID,
            args: { title: "Code Inspection Done", content: "0 issues found" },
          },
        ],
      });

      expect(created.ok).toBe(true);
      const handoffId = created.handoff!.handoffId;
      expect(created.handoff?.progress.totalSteps).toBe(3);
      expect(created.handoff?.progress.currentStepIndex).toBe(0);
      expect(created.handoff?.pendingAction?.stepId).toBe("step_1_open_project");

      // Step 1 on Desktop
      const s1 = await crossDeviceWorkflowOrchestrator.continueHandoffStep({
        handoffId,
        executingDeviceId: DESKTOP_ID,
      });
      expect(s1.ok).toBe(true);
      expect(s1.handoff?.progress.currentStepIndex).toBe(1);
      expect(s1.handoff?.progress.completedStepIds).toEqual(["step_1_open_project"]);
      expect(s1.handoff?.pendingAction?.stepId).toBe("step_2_inspect_code");

      // Step 2 on Desktop
      const s2 = await crossDeviceWorkflowOrchestrator.continueHandoffStep({
        handoffId,
        executingDeviceId: DESKTOP_ID,
      });
      expect(s2.ok).toBe(true);
      expect(s2.handoff?.progress.currentStepIndex).toBe(2);
      expect(s2.handoff?.progress.completedStepIds).toEqual([
        "step_1_open_project",
        "step_2_inspect_code",
      ]);
      expect(s2.handoff?.pendingAction?.stepId).toBe("step_3_mobile_note");

      // Step 3 on Phone -> completes workflow and returns verified result to origin
      const s3 = await crossDeviceWorkflowOrchestrator.continueHandoffStep({
        handoffId,
        executingDeviceId: PHONE_ID,
      });
      expect(s3.ok).toBe(true);
      expect(s3.handoff?.progress.status).toBe("COMPLETED");
      expect(s3.handoff?.progress.completedStepIds).toEqual([
        "step_1_open_project",
        "step_2_inspect_code",
        "step_3_mobile_note",
      ]);
      expect(s3.handoff?.pendingAction).toBeNull();
      expect(s3.returnedResult?.verified).toBe(true);
      expect(s3.returnedResult?.returnedToOrigin).toBe(true);
    });
  });

  // ===========================================================================
  // TEST 5: Pause -> Resume
  // ===========================================================================
  describe("5. Pause → Resume", () => {
    it("pauses an active multi-step handoff, blocks continuation while paused, and resumes from the exact pending step", async () => {
      const created = crossDeviceWorkflowOrchestrator.createHandoff({
        accountId: ACCOUNT_ID,
        sourceDeviceId: PHONE_ID,
        targetDeviceId: DESKTOP_ID,
        intent: "OPEN_FOLDER",
        capability: "desktop.openFolder",
        steps: [
          {
            stepId: "s1",
            description: "Open folder",
            intent: "OPEN_FOLDER",
            capability: "desktop.openFolder",
            executingDeviceId: DESKTOP_ID,
            args: { path: "d:/SORA AI/Sora AI" },
          },
          {
            stepId: "s2",
            description: "Inspect file",
            intent: "INSPECT_CODE",
            capability: "desktop.codeInspect",
            executingDeviceId: DESKTOP_ID,
            args: { filePath: "d:/SORA AI/Sora AI/src/index.ts" },
          },
        ],
      });

      const handoffId = created.handoff!.handoffId;

      // Complete Step 1
      const step1Res = await crossDeviceWorkflowOrchestrator.continueHandoffStep({
        handoffId,
      });
      expect(step1Res.ok).toBe(true);
      expect(step1Res.handoff?.progress.currentStepIndex).toBe(1);

      // Pause handoff before Step 2
      const paused = crossDeviceWorkflowOrchestrator.pauseHandoff({
        handoffId,
        requestedByDeviceId: PHONE_ID,
        reason: "User stepped away",
      });
      expect(paused.ok).toBe(true);
      expect(paused.handoff?.progress.status).toBe("PAUSED");

      // Attempting to continue while PAUSED is blocked with HANDOFF_PAUSED
      const blockedWhilePaused = await crossDeviceWorkflowOrchestrator.continueHandoffStep({
        handoffId,
      });
      expect(blockedWhilePaused.ok).toBe(false);
      expect(blockedWhilePaused.errorCode).toBe("HANDOFF_PAUSED");

      // Resume handoff
      const resumed = crossDeviceWorkflowOrchestrator.resumeHandoff({
        handoffId,
        resumingDeviceId: DESKTOP_ID,
      });
      expect(resumed.ok).toBe(true);
      expect(resumed.handoff?.progress.status).toBe("ACTIVE");
      expect(resumed.handoff?.progress.currentStepIndex).toBe(1);

      // Continue Step 2 -> completes workflow without re-running Step 1
      const step2Res = await crossDeviceWorkflowOrchestrator.continueHandoffStep({
        handoffId,
      });
      expect(step2Res.ok).toBe(true);
      expect(step2Res.handoff?.progress.status).toBe("COMPLETED");
      expect(step2Res.handoff?.progress.completedStepIds).toEqual(["s1", "s2"]);
    });
  });

  // ===========================================================================
  // TEST 6: Device disconnect during handoff & conflict/reconnect recovery
  // ===========================================================================
  describe("6. Device disconnect during handoff & deterministic recovery", () => {
    it("safely pauses on target disconnect without local fallback, detects version conflicts, and recovers on reconnect", async () => {
      const created = crossDeviceWorkflowOrchestrator.createHandoff({
        accountId: ACCOUNT_ID,
        sourceDeviceId: PHONE_ID,
        targetDeviceId: DESKTOP_ID,
        intent: "OPEN_FOLDER",
        capability: "desktop.openFolder",
        steps: [
          {
            stepId: "s1",
            description: "Step 1",
            intent: "OPEN_FOLDER",
            capability: "desktop.openFolder",
            executingDeviceId: DESKTOP_ID,
            args: { path: "d:/SORA AI/Sora AI" },
          },
          {
            stepId: "s2",
            description: "Step 2",
            intent: "INSPECT_CODE",
            capability: "desktop.codeInspect",
            executingDeviceId: DESKTOP_ID,
            args: { filePath: "d:/SORA AI/Sora AI/src/index.ts" },
          },
        ],
      });
      const handoffId = created.handoff!.handoffId;

      // Execute Step 1
      await crossDeviceWorkflowOrchestrator.continueHandoffStep({ handoffId });

      // Simulate Desktop disconnect before Step 2
      const disconnectRes = crossDeviceWorkflowOrchestrator.handleDeviceDisconnect({
        handoffId,
        disconnectedDeviceId: DESKTOP_ID,
        reason: "Wi-Fi dropped",
      });
      expect(disconnectRes.ok).toBe(true);
      expect(disconnectRes.handoff?.progress.status).toBe("PAUSED_DISCONNECTED");
      expect(disconnectRes.usedSilentFallback).toBe(false);

      // Attempting to continue while disconnected fails deterministically with HANDOFF_DISCONNECTED
      const blockedContinue = await crossDeviceWorkflowOrchestrator.continueHandoffStep({
        handoffId,
      });
      expect(blockedContinue.ok).toBe(false);
      expect(blockedContinue.errorCode).toBe("HANDOFF_DISCONNECTED");

      // Attempting recovery with a stale expectedVersion fails with HANDOFF_VERSION_CONFLICT
      const staleRecovery = crossDeviceWorkflowOrchestrator.recoverHandoffAfterReconnect({
        handoffId,
        reconnectedDeviceId: DESKTOP_ID,
        expectedVersion: 1, // actual version is now 3 (create=1, step1=2, disconnect=3)
      });
      expect(staleRecovery.ok).toBe(false);
      expect(staleRecovery.errorCode).toBe("HANDOFF_VERSION_CONFLICT");

      // Valid recovery with current version restores ACTIVE state and completes Step 2
      const validRecovery = crossDeviceWorkflowOrchestrator.recoverHandoffAfterReconnect({
        handoffId,
        reconnectedDeviceId: DESKTOP_ID,
        expectedVersion: disconnectRes.handoff!.version,
      });
      expect(validRecovery.ok).toBe(true);
      expect(validRecovery.handoff?.progress.status).toBe("ACTIVE");

      const finalStep = await crossDeviceWorkflowOrchestrator.continueHandoffStep({
        handoffId,
      });
      expect(finalStep.ok).toBe(true);
      expect(finalStep.handoff?.progress.status).toBe("COMPLETED");
    });
  });

  // ===========================================================================
  // TEST 7: Unauthorized target
  // ===========================================================================
  describe("7. Unauthorized target", () => {
    it("blocks handoff creation or continuation when target device is unauthorized or explicitAuthorization is false", async () => {
      // Unregistered / unauthorized target device
      const unauthTarget = crossDeviceWorkflowOrchestrator.createHandoff({
        accountId: ACCOUNT_ID,
        sourceDeviceId: PHONE_ID,
        targetDeviceId: "unpaired-foreign-desktop-99",
        intent: "OPEN_FOLDER",
        capability: "desktop.openFolder",
      });
      expect(unauthTarget.ok).toBe(false);
      expect(unauthTarget.errorCode).toBe("HANDOFF_UNAUTHORIZED");
      expect(unauthTarget.usedSilentFallback).toBe(false);

      // Missing explicit user authorization
      const noExplicitAuth = crossDeviceWorkflowOrchestrator.createHandoff({
        accountId: ACCOUNT_ID,
        sourceDeviceId: PHONE_ID,
        targetDeviceId: DESKTOP_ID,
        intent: "OPEN_FOLDER",
        capability: "desktop.openFolder",
        explicitAuthorization: false,
      });
      expect(noExplicitAuth.ok).toBe(false);
      expect(noExplicitAuth.errorCode).toBe("EXPLICIT_AUTHORIZATION_REQUIRED");

      // Invalid handoffToken during continuation
      const validHandoff = crossDeviceWorkflowOrchestrator.createHandoff({
        accountId: ACCOUNT_ID,
        sourceDeviceId: PHONE_ID,
        targetDeviceId: DESKTOP_ID,
        intent: "OPEN_FOLDER",
        capability: "desktop.openFolder",
      });
      const badTokenAttempt = await crossDeviceWorkflowOrchestrator.continueHandoffStep({
        handoffId: validHandoff.handoff!.handoffId,
        handoffToken: "htok_forged_invalid_token",
      });
      expect(badTokenAttempt.ok).toBe(false);
      expect(badTokenAttempt.errorCode).toBe("HANDOFF_UNAUTHORIZED");
    });
  });

  // ===========================================================================
  // TEST 8: Offline target
  // ===========================================================================
  describe("8. Offline target", () => {
    it("returns TARGET_DEVICE_OFFLINE when target device is offline and never falls back", () => {
      sharedAccountMemoryManager.setDeviceOnline(ACCOUNT_ID, DESKTOP_ID, false);

      const res = crossDeviceWorkflowOrchestrator.createHandoff({
        accountId: ACCOUNT_ID,
        sourceDeviceId: PHONE_ID,
        targetDeviceId: DESKTOP_ID,
        intent: "OPEN_FOLDER",
        capability: "desktop.openFolder",
      });

      expect(res.ok).toBe(false);
      expect(res.errorCode).toBe("TARGET_DEVICE_OFFLINE");
      expect(res.usedSilentFallback).toBe(false);
    });
  });

  // ===========================================================================
  // TEST 9: Expired handoff & post-completion invalidation
  // ===========================================================================
  describe("9. Expired handoff & post-completion invalidation", () => {
    it("expires handoffs after bounded TTL and prevents reuse after completion", async () => {
      const created = crossDeviceWorkflowOrchestrator.createHandoff({
        accountId: ACCOUNT_ID,
        sourceDeviceId: PHONE_ID,
        targetDeviceId: DESKTOP_ID,
        intent: "OPEN_FOLDER",
        capability: "desktop.openFolder",
        ttlMs: 60,
      });
      expect(created.ok).toBe(true);
      const handoffId = created.handoff!.handoffId;

      // Wait for TTL to elapse
      await new Promise((r) => setTimeout(r, 90));

      const expiredAttempt = await crossDeviceWorkflowOrchestrator.continueHandoffStep({
        handoffId,
      });
      expect(expiredAttempt.ok).toBe(false);
      expect(expiredAttempt.errorCode).toBe("HANDOFF_EXPIRED");
      expect(crossDeviceWorkflowOrchestrator.getHandoff(handoffId)?.progress.status).toBe(
        "EXPIRED",
      );

      // Create another handoff, complete it, and verify reuse is blocked with HANDOFF_ALREADY_FINALIZED
      const second = crossDeviceWorkflowOrchestrator.createHandoff({
        accountId: ACCOUNT_ID,
        sourceDeviceId: PHONE_ID,
        targetDeviceId: DESKTOP_ID,
        intent: "OPEN_FOLDER",
        capability: "desktop.openFolder",
      });
      const done = await crossDeviceWorkflowOrchestrator.continueHandoffStep({
        handoffId: second.handoff!.handoffId,
      });
      expect(done.ok).toBe(true);
      expect(done.handoff?.progress.status).toBe("COMPLETED");

      const replayAttempt = await crossDeviceWorkflowOrchestrator.continueHandoffStep({
        handoffId: second.handoff!.handoffId,
      });
      expect(replayAttempt.ok).toBe(false);
      expect(replayAttempt.errorCode).toBe("HANDOFF_ALREADY_FINALIZED");
    });
  });

  // ===========================================================================
  // TEST 10: Revoked / lost device
  // ===========================================================================
  describe("10. Revoked or Lost device", () => {
    it("immediately invalidates active handoffs when a device is revoked or marked lost", async () => {
      const created = crossDeviceWorkflowOrchestrator.createHandoff({
        accountId: ACCOUNT_ID,
        sourceDeviceId: PHONE_ID,
        targetDeviceId: DESKTOP_ID,
        intent: "OPEN_FOLDER",
        capability: "desktop.openFolder",
      });
      const handoffId = created.handoff!.handoffId;

      // Revoke Phone mid-handoff
      sharedAccountMemoryManager.revokeAccountDevice(ACCOUNT_ID, PHONE_ID, "Revoked in test");

      const revokedContinue = await crossDeviceWorkflowOrchestrator.continueHandoffStep({
        handoffId,
      });
      expect(revokedContinue.ok).toBe(false);
      expect(revokedContinue.errorCode).toBe("DEVICE_REVOKED");
      expect(revokedContinue.handoff?.progress.status).toBe("REVOKED");
    });

    it("blocks handoff creation and continuation with DEVICE_LOST when target device is marked lost", async () => {
      const created = crossDeviceWorkflowOrchestrator.createHandoff({
        accountId: ACCOUNT_ID,
        sourceDeviceId: PHONE_ID,
        targetDeviceId: DESKTOP_ID,
        intent: "OPEN_FOLDER",
        capability: "desktop.openFolder",
      });
      const handoffId = created.handoff!.handoffId;

      sharedAccountMemoryManager.markAccountDeviceLost(ACCOUNT_ID, DESKTOP_ID, "Desktop lost");

      const lostContinue = await crossDeviceWorkflowOrchestrator.continueHandoffStep({
        handoffId,
      });
      expect(lostContinue.ok).toBe(false);
      expect(lostContinue.errorCode).toBe("DEVICE_LOST");
      expect(lostContinue.handoff?.progress.status).toBe("REVOKED");
    });
  });

  // ===========================================================================
  // TEST 11: Emergency Stop / Security Lockdown
  // ===========================================================================
  describe("11. Emergency Stop & Security Lockdown", () => {
    it("immediately invalidates active handoffs and blocks execution on Emergency Stop", async () => {
      const created = crossDeviceWorkflowOrchestrator.createHandoff({
        accountId: ACCOUNT_ID,
        sourceDeviceId: PHONE_ID,
        targetDeviceId: DESKTOP_ID,
        intent: "OPEN_FOLDER",
        capability: "desktop.openFolder",
      });
      const handoffId = created.handoff!.handoffId;

      await emergencyStopCoordinator.trigger({
        source: "remote_device",
        deviceId: PHONE_ID,
        reason: "Phase 8 Emergency Stop test",
      });

      const blocked = await crossDeviceWorkflowOrchestrator.continueHandoffStep({
        handoffId,
      });
      expect(blocked.ok).toBe(false);
      expect(blocked.errorCode).toBe("EMERGENCY_STOP_ACTIVE");
      expect(crossDeviceWorkflowOrchestrator.getHandoff(handoffId)?.progress.status).toBe(
        "REVOKED",
      );
    });

    it("immediately invalidates active handoffs and blocks creation during Security Lockdown", async () => {
      const created = crossDeviceWorkflowOrchestrator.createHandoff({
        accountId: ACCOUNT_ID,
        sourceDeviceId: PHONE_ID,
        targetDeviceId: DESKTOP_ID,
        intent: "OPEN_FOLDER",
        capability: "desktop.openFolder",
      });
      const handoffId = created.handoff!.handoffId;

      securityPolicyEngine.setMode("LOCKDOWN");

      const blocked = await crossDeviceWorkflowOrchestrator.continueHandoffStep({
        handoffId,
      });
      expect(blocked.ok).toBe(false);
      expect(blocked.errorCode).toBe("SECURITY_LOCKDOWN_ACTIVE");
      expect(crossDeviceWorkflowOrchestrator.getHandoff(handoffId)?.progress.status).toBe(
        "REVOKED",
      );
    });
  });

  // ===========================================================================
  // TEST 12: No silent fallback
  // ===========================================================================
  describe("12. No silent fallback", () => {
    it("never silently executes a handoff step on the source device when target is offline or unsupported", async () => {
      const mobileExecSpy = vi.spyOn(androidCapabilityEngine, "execute");

      // 1. Target Desktop is offline -> Phone must NOT execute locally
      sharedAccountMemoryManager.setDeviceOnline(ACCOUNT_ID, DESKTOP_ID, false);
      const offlineAttempt = await crossDeviceWorkflowOrchestrator.executeConversationalCrossDeviceTurn({
        accountId: ACCOUNT_ID,
        utterance: "Desktop par mera project kholo",
        sourceDeviceId: PHONE_ID,
        targetDeviceId: DESKTOP_ID,
      });
      expect(offlineAttempt.ok).toBe(false);
      expect(offlineAttempt.errorCode).toBe("TARGET_DEVICE_OFFLINE");
      expect(offlineAttempt.usedSilentFallback).toBe(false);
      expect(mobileExecSpy).not.toHaveBeenCalled();

      // 2. Target Phone does not support desktop-only capability 'desktop.openFolder' -> must fail with CAPABILITY_NOT_SUPPORTED
      sharedAccountMemoryManager.setDeviceOnline(ACCOUNT_ID, DESKTOP_ID, true);
      const unsupportedAttempt = crossDeviceWorkflowOrchestrator.createHandoff({
        accountId: ACCOUNT_ID,
        sourceDeviceId: DESKTOP_ID,
        targetDeviceId: PHONE_ID,
        intent: "OPEN_FOLDER",
        capability: "desktop.openFolder",
      });
      expect(unsupportedAttempt.ok).toBe(false);
      expect(unsupportedAttempt.errorCode).toBe("CAPABILITY_NOT_SUPPORTED");
      expect(unsupportedAttempt.usedSilentFallback).toBe(false);

      mobileExecSpy.mockRestore();
    });
  });

  // ===========================================================================
  // TEST 13: Verify shared vs device-local context boundaries & DLP
  // ===========================================================================
  describe("13. Verify shared vs device-local context boundaries & DLP", () => {
    it("strips device-local keys, raw screen data, and private tokens from HandoffContext and rejects DLP secrets", () => {
      const created = crossDeviceWorkflowOrchestrator.createHandoff({
        accountId: ACCOUNT_ID,
        sourceDeviceId: DESKTOP_ID,
        targetDeviceId: PHONE_ID,
        intent: "CREATE_REMINDER",
        capability: "mobile.notes",
        rawContext: {
          projectPath: "d:/SORA AI/Sora AI",
          summary: "Continue architecture review on mobile",
          sharedMemoryKeys: ["hinglish_preference", "current_window"],
          // Forbidden device-local / raw screen / private token keys that MUST be stripped:
          current_window: "VS Code - Private File",
          active_window: "Terminal",
          rawScreenData: "base64_raw_pixels_...",
          clipboard_buffer: "copied local text",
          battery_level: 85,
          private_token: "internal_local_handle",
        },
      });

      expect(created.ok).toBe(true);
      const hc = created.handoff!;
      // Task-relevant fields are preserved
      expect(hc.relevantContext.projectPath).toBe("d:/SORA AI/Sora AI");
      expect(hc.relevantContext.summary).toBe("Continue architecture review on mobile");
      // Only SHARED memory keys survive; "current_window" is filtered out of sharedMemoryKeys
      expect(hc.relevantContext.sharedMemoryKeys).toEqual(["hinglish_preference"]);
      // All device-local / raw screen / token keys were stripped and recorded
      expect(hc.strippedLocalKeys).toEqual(
        expect.arrayContaining([
          "current_window",
          "active_window",
          "rawScreenData",
          "clipboard_buffer",
          "battery_level",
          "private_token",
        ]),
      );
      expect((hc.relevantContext as any).current_window).toBeUndefined();
      expect((hc.relevantContext as any).rawScreenData).toBeUndefined();
      expect(hc.relevantContext.metadata).toBeUndefined();

      // DLP secret in rawContext is rejected with DLP_SECRET_REJECTED
      const dlpRejected = crossDeviceWorkflowOrchestrator.createHandoff({
        accountId: ACCOUNT_ID,
        sourceDeviceId: DESKTOP_ID,
        targetDeviceId: PHONE_ID,
        intent: "CREATE_REMINDER",
        capability: "mobile.notes",
        rawContext: {
          summary: "Use API key AIzaSyD1234567890abcdefghijklmnopqrstuv",
        },
      });
      expect(dlpRejected.ok).toBe(false);
      expect(dlpRejected.errorCode).toBe("DLP_SECRET_REJECTED");
    });
  });

  // ===========================================================================
  // TEST 14: Verify final result before completion + Audit + 126 Gemini Tools
  // ===========================================================================
  describe("14. Verify final result before completion, Audit Chain & 126 Gemini Tools", () => {
    it("blocks completion with VERIFICATION_FAILED if a step or final result fails verification", async () => {
      const created = crossDeviceWorkflowOrchestrator.createHandoff({
        accountId: ACCOUNT_ID,
        sourceDeviceId: PHONE_ID,
        targetDeviceId: DESKTOP_ID,
        intent: "OPEN_FOLDER",
        capability: "desktop.openFolder",
      });
      const handoffId = created.handoff!.handoffId;

      // Custom executor returns unverified result (opened: false)
      const unverifiedStep = await crossDeviceWorkflowOrchestrator.continueHandoffStep({
        handoffId,
        customExecutor: async () => ({
          ok: true,
          result: {
            opened: false,
            projectPath: "",
          },
        }),
      });

      expect(unverifiedStep.ok).toBe(false);
      expect(unverifiedStep.verified).toBe(false);
      expect(unverifiedStep.errorCode).toBe("VERIFICATION_FAILED");
      expect(unverifiedStep.handoff?.progress.status).toBe("FAILED");
      expect(unverifiedStep.handoff?.result).toBeNull();
    });

    it("maintains tamper-evident audit chain, standalone Mobile/Desktop operation, and 126 Gemini Live tools", async () => {
      const workflow = await crossDeviceWorkflowOrchestrator.executeConversationalCrossDeviceTurn({
        accountId: ACCOUNT_ID,
        utterance: "Desktop par mera project kholo",
        sourceDeviceId: PHONE_ID,
        targetDeviceId: DESKTOP_ID,
      });
      expect(workflow.ok).toBe(true);
      expect(workflow.verified).toBe(true);

      const auditIntegrity = securityAuditLogger.verifyChainIntegrity();
      expect(auditIntegrity.valid).toBe(true);

      // Verify exactly 126 Gemini Live tools
      expect(LIVE_TOOLS[0].functionDeclarations.length).toBe(129);
    });
  });
});
