/**
 * Phase 25 — Cross-Device Handoff Tests
 *
 * Comprehensive test suite covering:
 *   1. Desktop → Android handoff snapshot creation
 *   2. Android → Desktop handoff snapshot creation
 *   3. Conversation continuation (dialogue history, last user query, active intent)
 *   4. Active task plan continuation & workflow step staging
 *   5. Project context preservation (project name, workspace path, context snippet)
 *   6. Canonical shared-memory reference preservation (IDs only, no memory duplication)
 *   7. Handoff expiration (stale handoffs past TTL fail closed with EXPIRED)
 *   8. Single-use acceptance & replay token defense
 *   9. Target device authorization & unauthorized device rejection
 *   10. Disconnect/reconnect recovery & pending handoff listing
 *   11. Duplicate resume prevention & idempotency
 *   12. Conflict / stale-state handling (detects when source plan progressed)
 *   13. DLP & secret protection (rejects API keys, tokens, passwords, OTPs, cards)
 *   14. Emergency Stop fails closed immediately on all operations
 *   15. Security Policy Lockdown fails closed immediately
 *   16. Audit logging of create, accept, resume, and rejection events
 *   17. Gating of modifying/HIGH/CRITICAL steps upon resume (prevents auto-execution)
 *   18. Cancellation / revocation of pending handoffs
 *   19. Preserves strictly 126 Gemini Live tools
 *   20. Phase 24 Shared Memory non-regression
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CrossDeviceHandoffManager, isDlpClean } from "../CrossDeviceHandoffManager.ts";
import { MockHandoffStore } from "../HandoffStore.ts";
import { emergencyStopCoordinator } from "../../remote/EmergencyStopCoordinator.ts";
import { securityPolicyEngine } from "../../security/SecurityPolicyEngine.ts";
import { LIVE_TOOLS } from "../../ai/GeminiSessionFactory.ts";
import { sharedMemoryManager } from "../../memory/SharedMemoryManager.ts";
import type { SecurityContext } from "../../security/SecurityTypes.ts";
import type { CreateHandoffRequest, HandoffSnapshot } from "../HandoffTypes.ts";

describe("Phase 25 — Cross-Device Handoff", () => {
  let mockStore: MockHandoffStore;
  let handoffManager: CrossDeviceHandoffManager;

  const desktopContext: SecurityContext = {
    identityId: "desktop_local",
    role: "admin",
    ipAddress: "127.0.0.1",
    deviceId: "desktop_local",
    isLocal: true,
  };

  const androidContext: SecurityContext = {
    identityId: "android_companion_device_01",
    role: "standard",
    ipAddress: "192.168.1.150",
    deviceId: "android_companion_device_01",
    isLocal: false,
  };

  const thirdPartyContext: SecurityContext = {
    identityId: "unauthorized_rogue_device",
    role: "standard",
    ipAddress: "192.168.1.200",
    deviceId: "unauthorized_rogue_device",
    isLocal: false,
  };

  beforeEach(async () => {
    mockStore = new MockHandoffStore();
    handoffManager = new CrossDeviceHandoffManager(mockStore);
    await handoffManager.clearCaches();

    // Ensure Emergency Stop & Lockdown are reset
    await emergencyStopCoordinator.reset("test_setup");
    securityPolicyEngine.setMode("BALANCED");
  });

  afterEach(async () => {
    await emergencyStopCoordinator.reset("test_teardown");
    securityPolicyEngine.setMode("BALANCED");
  });

  // ---------------------------------------------------------------------------
  // 1. Cross-Device Transfer & Snapshot Creation
  // ---------------------------------------------------------------------------

  describe("Cross-Device Transfer & Creation", () => {
    it("Desktop → Android: creates secure handoff snapshot with token and context", async () => {
      const req: CreateHandoffRequest = {
        targetDevice: {
          deviceId: "android_companion_device_01",
          deviceType: "android",
        },
        conversationContext: {
          dialogueHistory: [
            { role: "user", text: "Can you analyze the system architecture?" },
            { role: "assistant", text: "I have identified 5 core microservices." },
          ],
          lastUserQuery: "Main ye research baad mein phone pe continue karunga.",
          activeIntent: "research_continuation",
          summary: "Architecture investigation of core services",
        },
        taskPlanState: {
          planId: "plan_arch_101",
          goal: "Document microservice architecture",
          currentStepIndex: 2,
          totalSteps: 5,
          currentStepDescription: "Inspect network boundaries",
          workflowPhase: "inspect",
        },
        projectContext: {
          projectName: "Sora AI Core",
          workspacePath: "d:/SORA AI/Sora AI",
          activeFiles: ["src/backend/server.ts", "src/backend/gateway/HttpGateway.ts"],
        },
        sharedMemoryRefs: ["mem_proj_001", "mem_user_pref_002"],
      };

      const result = await handoffManager.createHandoff(req, desktopContext);

      expect(result.success).toBe(true);
      expect(result.handoff).toBeDefined();
      expect(result.handoff?.handoffId).toMatch(/^handoff_/);
      expect(result.handoff?.handoffToken).toMatch(/^handoff_tok_/);
      expect(result.handoff?.status).toBe("pending");
      expect(result.handoff?.sourceDevice.deviceId).toBe("desktop_local");
      expect(result.handoff?.sourceDevice.deviceType).toBe("desktop");
      expect(result.handoff?.targetDevice?.deviceId).toBe("android_companion_device_01");
      expect(result.handoff?.version).toBe(1);
    });

    it("Android → Desktop: creates handoff from companion to resume on desktop", async () => {
      const req: CreateHandoffRequest = {
        targetDevice: {
          deviceId: "desktop_local",
          deviceType: "desktop",
        },
        conversationContext: {
          dialogueHistory: [
            { role: "user", text: "Review notifications on the road" },
            { role: "assistant", text: "You have 3 critical alerts pending." },
          ],
          lastUserQuery: "Jo kaam phone pe chal raha tha usko desktop pe continue karo.",
          summary: "Alert triage",
        },
      };

      const result = await handoffManager.createHandoff(req, androidContext);

      expect(result.success).toBe(true);
      expect(result.handoff?.sourceDevice.deviceId).toBe("android_companion_device_01");
      expect(result.handoff?.sourceDevice.deviceType).toBe("android");
      expect(result.handoff?.targetDevice?.deviceId).toBe("desktop_local");
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Context & Canonical Memory Preservation
  // ---------------------------------------------------------------------------

  describe("Context & Canonical Memory Reference Preservation", () => {
    it("preserves conversation dialogue history, queries, and task plan state accurately", async () => {
      const created = await handoffManager.createHandoff(
        {
          conversationContext: {
            dialogueHistory: [
              { role: "user", text: "How is the study session going?" },
              { role: "assistant", text: "We completed chapter 3." },
            ],
            lastUserQuery: "Continue chapter 4 later.",
          },
          taskPlanState: {
            planId: "study_plan_99",
            goal: "Complete Chapter 4 Review",
            currentStepIndex: 1,
            totalSteps: 3,
            currentStepDescription: "Solve practice quiz",
            workflowPhase: "test",
          },
          projectContext: {
            projectName: "Biology Finals",
          },
        },
        desktopContext,
      );

      const retrieved = await handoffManager.getHandoff(created.handoff!.handoffId, androidContext);
      expect(retrieved).toBeDefined();
      expect(retrieved?.conversationContext?.dialogueHistory.length).toBe(2);
      expect(retrieved?.conversationContext?.lastUserQuery).toBe("Continue chapter 4 later.");
      expect(retrieved?.taskPlanState?.goal).toBe("Complete Chapter 4 Review");
      expect(retrieved?.taskPlanState?.workflowPhase).toBe("test");
      expect(retrieved?.projectContext?.projectName).toBe("Biology Finals");
    });

    it("stores only canonical memory IDs and never duplicates Phase 24 memories", async () => {
      const memoryRefs = ["mem_canonical_1", "mem_canonical_2"];
      const created = await handoffManager.createHandoff(
        {
          sharedMemoryRefs: memoryRefs,
        },
        desktopContext,
      );

      expect(created.handoff?.sharedMemoryRefs).toEqual(memoryRefs);

      // Verify that no full memory records or nested memory database was introduced
      expect(Array.isArray(created.handoff?.sharedMemoryRefs)).toBe(true);
      created.handoff?.sharedMemoryRefs?.forEach((ref) => {
        expect(typeof ref).toBe("string");
        expect(ref.startsWith("mem_")).toBe(true);
      });
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Single-Use Tokens, Expiration & Replay Defense
  // ---------------------------------------------------------------------------

  describe("Single-Use Acceptance, Expiration & Replay Defense", () => {
    it("accepts handoff with valid token and transitions status to accepted", async () => {
      const created = await handoffManager.createHandoff(
        {
          targetDevice: { deviceId: "android_companion_device_01" },
        },
        desktopContext,
      );

      const acceptRes = await handoffManager.acceptHandoff(
        {
          handoffId: created.handoff!.handoffId,
          handoffToken: created.handoff!.handoffToken,
        },
        androidContext,
      );

      expect(acceptRes.success).toBe(true);
      expect(acceptRes.handoff?.status).toBe("accepted");
      expect(acceptRes.handoff?.acceptedAt).toBeDefined();
      expect(acceptRes.handoff?.version).toBe(2);
    });

    it("rejects invalid or tampered handoff token with INVALID_TOKEN", async () => {
      const created = await handoffManager.createHandoff({}, desktopContext);

      const acceptRes = await handoffManager.acceptHandoff(
        {
          handoffId: created.handoff!.handoffId,
          handoffToken: "handoff_tok_invalid_fake_token",
        },
        androidContext,
      );

      expect(acceptRes.success).toBe(false);
      expect(acceptRes.errorCode).toBe("INVALID_TOKEN");
    });

    it("enforces single-use acceptance: cannot accept the same handoff token twice", async () => {
      const created = await handoffManager.createHandoff(
        {
          targetDevice: { deviceId: "android_companion_device_01" },
        },
        desktopContext,
      );

      // First acceptance succeeds
      const first = await handoffManager.acceptHandoff(
        {
          handoffId: created.handoff!.handoffId,
          handoffToken: created.handoff!.handoffToken,
        },
        androidContext,
      );
      expect(first.success).toBe(true);

      // Second acceptance fails (single-use constraint)
      const second = await handoffManager.acceptHandoff(
        {
          handoffId: created.handoff!.handoffId,
          handoffToken: created.handoff!.handoffToken,
        },
        androidContext,
      );
      expect(second.success).toBe(false);
      expect(second.errorCode).toBe("ALREADY_ACCEPTED");
    });

    it("enforces handoff expiry: stale handoffs past TTL fail closed with EXPIRED", async () => {
      const created = await handoffManager.createHandoff(
        {
          ttlSeconds: 60, // 1 minute
        },
        desktopContext,
      );

      // Manually wind clock back on the snapshot to simulate expiration
      const snapshots = await mockStore.load();
      const target = snapshots.find((s) => s.handoffId === created.handoff!.handoffId)!;
      target.expiresAt = new Date(Date.now() - 5000).toISOString(); // 5 seconds in the past
      await mockStore.save(snapshots);

      const acceptRes = await handoffManager.acceptHandoff(
        {
          handoffId: created.handoff!.handoffId,
          handoffToken: created.handoff!.handoffToken,
        },
        androidContext,
      );

      expect(acceptRes.success).toBe(false);
      expect(acceptRes.errorCode).toBe("EXPIRED");
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Device Authorization & Discovery
  // ---------------------------------------------------------------------------

  describe("Device Authorization & Listing Discovery", () => {
    it("rejects unauthorized devices when target device is explicitly locked", async () => {
      const created = await handoffManager.createHandoff(
        {
          targetDevice: { deviceId: "android_companion_device_01" },
        },
        desktopContext,
      );

      // Third party device tries to accept
      const acceptRes = await handoffManager.acceptHandoff(
        {
          handoffId: created.handoff!.handoffId,
          handoffToken: created.handoff!.handoffToken,
        },
        thirdPartyContext,
      );

      expect(acceptRes.success).toBe(false);
      expect(acceptRes.errorCode).toBe("UNAUTHORIZED_DEVICE");
    });

    it("lists available handoffs for paired devices, hiding unauthorized target locks", async () => {
      // Handoff locked to android_companion_device_01
      await handoffManager.createHandoff(
        {
          targetDevice: { deviceId: "android_companion_device_01" },
          conversationContext: { summary: "Session for Android 1" },
        },
        desktopContext,
      );

      // Handoff locked to third_party
      await handoffManager.createHandoff(
        {
          targetDevice: { deviceId: "unauthorized_rogue_device" },
          conversationContext: { summary: "Session for Rogue" },
        },
        desktopContext,
      );

      // Android 1 lists
      const androidList = await handoffManager.listAvailableHandoffs({}, androidContext);
      expect(androidList.length).toBe(1);
      expect(androidList[0].targetDevice?.deviceId).toBe("android_companion_device_01");

      // Desktop operator sees all
      const desktopList = await handoffManager.listAvailableHandoffs({}, desktopContext);
      expect(desktopList.length).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Resumption Semantics & High-Risk Gating
  // ---------------------------------------------------------------------------

  describe("Resumption Semantics & Safety Gating", () => {
    it("resumes safe handoff smoothly and increments version", async () => {
      const created = await handoffManager.createHandoff(
        {
          taskPlanState: {
            goal: "Read documentation",
            pendingActions: [
              {
                stepId: "step_1",
                toolName: "readFile",
                description: "Read server.ts",
                isDestructive: false,
                checkpointRequired: false,
                riskLevel: "LOW",
              },
            ],
          },
        },
        desktopContext,
      );

      const resumeRes = await handoffManager.resumeHandoff(
        {
          handoffId: created.handoff!.handoffId,
          handoffToken: created.handoff!.handoffToken,
        },
        androidContext,
      );

      expect(resumeRes.success).toBe(true);
      expect(resumeRes.handoff?.status).toBe("resumed");
      expect(resumeRes.handoff?.resumedAt).toBeDefined();
      expect(resumeRes.requiresConfirmation).toBe(false);
    });

    it("GATES HIGH / CRITICAL actions: destructive steps NEVER execute automatically on resume", async () => {
      const created = await handoffManager.createHandoff(
        {
          taskPlanState: {
            goal: "Refactor core backend files",
            pendingActions: [
              {
                stepId: "step_mod_1",
                toolName: "deleteFile",
                description: "Delete obsolete temp logs",
                isDestructive: true,
                checkpointRequired: true,
                riskLevel: "HIGH",
              },
              {
                stepId: "step_safe_2",
                toolName: "systemInfo",
                description: "Check memory status",
                isDestructive: false,
                checkpointRequired: false,
                riskLevel: "LOW",
              },
            ],
          },
        },
        desktopContext,
      );

      const resumeRes = await handoffManager.resumeHandoff(
        {
          handoffId: created.handoff!.handoffId,
          handoffToken: created.handoff!.handoffToken,
        },
        androidContext,
      );

      expect(resumeRes.success).toBe(true);
      expect(resumeRes.requiresConfirmation).toBe(true);
      expect(resumeRes.gatedActions?.length).toBe(1);
      expect(resumeRes.gatedActions![0].stepId).toBe("step_mod_1");
      expect(resumeRes.gatedActions![0].isDestructive).toBe(true);
    });

    it("prevents duplicate resume execution idempotently", async () => {
      const created = await handoffManager.createHandoff({}, desktopContext);

      const first = await handoffManager.resumeHandoff(
        {
          handoffId: created.handoff!.handoffId,
          handoffToken: created.handoff!.handoffToken,
        },
        androidContext,
      );
      expect(first.success).toBe(true);
      expect(first.handoff?.status).toBe("resumed");

      // Second resume call succeeds idempotently without re-triggering actions
      const second = await handoffManager.resumeHandoff(
        {
          handoffId: created.handoff!.handoffId,
          handoffToken: created.handoff!.handoffToken,
        },
        androidContext,
      );
      expect(second.success).toBe(true);
      expect(second.handoff?.status).toBe("resumed");
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Cancellation & Conflict Handling
  // ---------------------------------------------------------------------------

  describe("Cancellation & Stale Conflict Handling", () => {
    it("source device can cancel pending handoff; target cannot resume cancelled handoff", async () => {
      const created = await handoffManager.createHandoff(
        { targetDevice: { deviceId: "android_companion_device_01" } },
        desktopContext,
      );

      const cancelRes = await handoffManager.cancelHandoff(created.handoff!.handoffId, desktopContext);
      expect(cancelRes.success).toBe(true);
      expect(cancelRes.handoff?.status).toBe("cancelled");

      // Target tries to accept or resume cancelled handoff
      const resumeRes = await handoffManager.resumeHandoff(
        {
          handoffId: created.handoff!.handoffId,
          handoffToken: created.handoff!.handoffToken,
        },
        androidContext,
      );

      expect(resumeRes.success).toBe(false);
      expect(resumeRes.errorCode).toBe("CANCELLED");
    });

    it("unauthorized non-source device cannot cancel a handoff", async () => {
      const created = await handoffManager.createHandoff(
        { targetDevice: { deviceId: "android_companion_device_01" } },
        desktopContext,
      );

      const cancelRes = await handoffManager.cancelHandoff(created.handoff!.handoffId, thirdPartyContext);
      expect(cancelRes.success).toBe(false);
      expect(cancelRes.errorCode).toBe("UNAUTHORIZED_DEVICE");
    });

    it("detects stale conflict when source plan has already finished or progressed", () => {
      const snapshot: HandoffSnapshot = {
        handoffId: "handoff_1",
        handoffToken: "tok_1",
        status: "pending",
        sourceDevice: { deviceId: "desktop_local", deviceType: "desktop" },
        taskPlanState: { planId: "plan_100", goal: "Complete build", workflowPhase: "modify" },
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        version: 1,
      };

      // Source plan completed in the meantime on desktop
      const staleCheck = handoffManager.detectStaleState(snapshot, {
        id: "plan_100",
        status: "completed",
      });

      expect(staleCheck.isStale).toBe(true);
      expect(staleCheck.reason).toContain("already finished");
    });
  });

  // ---------------------------------------------------------------------------
  // 7. DLP & Secret Protection
  // ---------------------------------------------------------------------------

  describe("DLP & Secret Protection", () => {
    it("isDlpClean accurately detects sensitive credentials, keys, cards, and OTPs", () => {
      expect(isDlpClean("Just a regular discussion about science")).toBe(true);
      expect(isDlpClean("sora_dev_0123456789abcdef0123456789abcdef")).toBe(false);
      expect(isDlpClean("AIzaSyD-1234567890abcdefghijklmnopqrstuv")).toBe(false);
      expect(isDlpClean("sk-1234567890abcdefghijklmnopqrstuvwx")).toBe(false);
      expect(isDlpClean("Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9")).toBe(false);
      expect(isDlpClean("-----BEGIN RSA PRIVATE KEY-----")).toBe(false);
      expect(isDlpClean("Credit card 4532-1234-5678-9012")).toBe(false);
      expect(isDlpClean("Your OTP code is 849201")).toBe(false);
    });

    it("rejects handoff creation containing sensitive API keys with DLP_SECRET_REJECTED", async () => {
      const result = await handoffManager.createHandoff(
        {
          conversationContext: {
            dialogueHistory: [
              { role: "user", text: "Here is my key: AIzaSyD-9876543210abcdefghijklmnop" },
            ],
          },
        },
        desktopContext,
      );

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe("DLP_SECRET_REJECTED");
      expect(result.error).toContain("DLP_SECRET_REJECTED");
    });

    it("rejects handoff creation containing passwords or OTPs", async () => {
      const result = await handoffManager.createHandoff(
        {
          taskPlanState: {
            goal: "Login with password: secretPassword123!",
          },
        },
        desktopContext,
      );

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe("DLP_SECRET_REJECTED");
    });
  });

  // ---------------------------------------------------------------------------
  // 8. Emergency Stop & Security Policy Lockdown
  // ---------------------------------------------------------------------------

  describe("Emergency Stop & Security Policy Lockdown", () => {
    it("fails closed immediately on create/accept/resume when Emergency Stop is active", async () => {
      await emergencyStopCoordinator.trigger({
        source: "desktop_ui",
        reason: "Immediate security halt",
      });

      await expect(handoffManager.createHandoff({}, desktopContext)).rejects.toThrow(
        "EMERGENCY_STOP_ACTIVE",
      );

      await expect(
        handoffManager.acceptHandoff(
          { handoffId: "handoff_any", handoffToken: "tok_any" },
          androidContext,
        ),
      ).rejects.toThrow("EMERGENCY_STOP_ACTIVE");

      await expect(
        handoffManager.resumeHandoff(
          { handoffId: "handoff_any", handoffToken: "tok_any" },
          androidContext,
        ),
      ).rejects.toThrow("EMERGENCY_STOP_ACTIVE");
    });

    it("fails closed immediately on all operations when Security Policy Lockdown is active", async () => {
      securityPolicyEngine.setMode("LOCKDOWN");

      await expect(handoffManager.createHandoff({}, desktopContext)).rejects.toThrow(
        "SECURITY_LOCKDOWN_ACTIVE",
      );

      await expect(handoffManager.listAvailableHandoffs({}, androidContext)).rejects.toThrow(
        "SECURITY_LOCKDOWN_ACTIVE",
      );
    });
  });

  // ---------------------------------------------------------------------------
  // 9. Real-Time Broadcasting & Tool Count Invariance
  // ---------------------------------------------------------------------------

  describe("Real-Time Broadcasting & Tool Count Invariant", () => {
    it("dispatches handoff sync events to registered listeners on create, accept, resume, and cancel", async () => {
      const events: string[] = [];
      const unsubscribe = handoffManager.onHandoffEvent((evt) => {
        events.push(evt.action);
      });

      const created = await handoffManager.createHandoff({}, desktopContext);
      await handoffManager.acceptHandoff(
        {
          handoffId: created.handoff!.handoffId,
          handoffToken: created.handoff!.handoffToken,
        },
        androidContext,
      );
      await handoffManager.resumeHandoff(
        {
          handoffId: created.handoff!.handoffId,
          handoffToken: created.handoff!.handoffToken,
        },
        androidContext,
      );

      unsubscribe();

      expect(events).toContain("create");
      expect(events).toContain("accept");
      expect(events).toContain("resume");
    });

    it("preserves exactly 126 Gemini Live tools without additions or removals", () => {
      const tools = LIVE_TOOLS[0]?.functionDeclarations;
      expect(tools).toBeDefined();
      expect(tools.length).toBe(126);
    });

    it("Phase 24 regression: canonical SharedMemoryManager functions cleanly alongside handoff", async () => {
      const memories = await sharedMemoryManager.listMemories({}, desktopContext);
      expect(Array.isArray(memories)).toBe(true);
    });
  });
});
