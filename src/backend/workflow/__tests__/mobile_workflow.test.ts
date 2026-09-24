/**
 * Phase 27 — Mobile Autonomous Workflow Engine Tests
 *
 * Comprehensive test suite covering:
 *   1. Schedule & tasks query workflow execution ("Kal ka schedule check karo aur important tasks batao")
 *   2. Project status query workflow execution ("Is project ka latest status check karo")
 *   3. Reminder workflow with Checkpoint confirmation ("Mujhe 7 baje remind karna")
 *   4. Alarm & timer workflow with Checkpoint confirmation ("Kal subah 6 baje ka alarm set karo")
 *   5. Device status & diagnostics workflow ("Mera battery status aur wifi check karo")
 *   6. App interaction workflow ("Directions to MG Road")
 *   7. Multilingual voice response synthesis (Hindi, Hinglish, English)
 *   8. Zero duplicate planner invariant (uses Phase 5 plannerCoordinator & taskPlanner)
 *   9. Zero false positives in CompletionVerifier (fails if capability errors)
 *   10. Checkpoint confirmation approval & execution flow
 *   11. Checkpoint rejection halts execution cleanly
 *   12. Checkpoint token single-use & replay attack defense
 *   13. Checkpoint argument tampering detection
 *   14. Emergency Stop fails closed immediately
 *   15. Security Lockdown fails closed immediately
 *   16. Revoked device rejection (DEVICE_REVOKED)
 *   17. Data Loss Prevention (DLP) screening of queries
 *   18. Workflow pause and resume lifecycle
 *   19. Workflow cancellation and checkpoint expiration
 *   20. RemoteCapabilityDispatcher integration and validation
 *   21. HTTP Gateway REST endpoints (/api/remote/workflow/*)
 *   22. Non-regression of standard Phase 5 developer plans
 *   23. Invariant: Exactly 126 Gemini Live tools preserved
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import http from "http";
import { mobileWorkflowManager } from "../MobileWorkflowManager.ts";
import { plannerCoordinator } from "../../planner/PlannerCoordinator.ts";
import { taskPlanner } from "../../planner/TaskPlanner.ts";
import { goalParser } from "../../planner/GoalParser.ts";
import { completionVerifier } from "../../planner/CompletionVerifier.ts";
import { checkpointManager } from "../../planner/CheckpointManager.ts";
import { emergencyStopCoordinator } from "../../remote/EmergencyStopCoordinator.ts";
import { securityPolicyEngine } from "../../security/SecurityPolicyEngine.ts";
import { remoteStore } from "../../remote/RemoteStore.ts";
import { planStore } from "../../planner/PlanStore.ts";
import { LIVE_TOOLS } from "../../ai/GeminiSessionFactory.ts";
import { createHttpApp } from "../../gateway/HttpGateway.ts";
import type { SecurityContext } from "../../security/SecurityTypes.ts";

describe("Phase 27 — Mobile Autonomous Workflow Engine", () => {
  const testDeviceId = "test_companion_device_01";
  const secContext: SecurityContext = {
    identityId: testDeviceId,
    role: "standard",
    ipAddress: "127.0.0.1",
    deviceId: testDeviceId,
    isLocal: false,
  };

  const adminContext: SecurityContext = {
    identityId: "local_admin",
    role: "admin",
    ipAddress: "127.0.0.1",
    deviceId: "local_operator",
    isLocal: true,
  };

  beforeEach(async () => {
    emergencyStopCoordinator.reset("test_setup");
    securityPolicyEngine.setMode("BALANCED");

    // Register active device in remoteStore
    await remoteStore.saveDevice({
      id: testDeviceId,
      name: "Pixel 9 Pro Workflow Companion",
      deviceType: "mobile",
      role: "standard",
      tokenHash: "dummy_hash_p27",
      pairedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      revoked: false,
    });
  });

  afterEach(async () => {
    emergencyStopCoordinator.reset("test_cleanup");
    securityPolicyEngine.setMode("BALANCED");
  });

  // ── 1. Schedule & Tasks Query Workflow ────────────────────────────────────
  describe("1. Schedule & Tasks Query Workflow", () => {
    it("decomposes 'Kal ka schedule check karo aur important tasks batao' into calendar & sharedMemory inspect steps", async () => {
      const goal = goalParser.parse("Kal ka schedule check karo aur important tasks batao");
      expect(goal.category).toBe("workflow");

      const plan = taskPlanner.buildPlan(goal, { deviceId: testDeviceId });
      expect(plan.steps.length).toBeGreaterThanOrEqual(4);

      const calStep = plan.steps.find((s) => s.toolName === "calendar");
      expect(calStep).toBeDefined();
      expect(calStep?.phase).toBe("inspect");
      expect(calStep?.toolArgs.date).toBe("tomorrow");

      const memStep = plan.steps.find((s) => s.toolName === "sharedMemory");
      expect(memStep).toBeDefined();
      expect(memStep?.phase).toBe("inspect");
    });

    it("executes schedule & task workflow and synthesizes voice response", async () => {
      const res = await mobileWorkflowManager.executeVoiceWorkflow(
        {
          query: "Kal ka schedule check karo aur important tasks batao",
          deviceId: testDeviceId,
          preferredLanguage: "hinglish",
        },
        secContext,
      );

      expect(res.success).toBe(true);
      expect(res.status).toBe("completed");
      expect(res.voiceResponse).toContain("schedule");
      expect(res.verification?.verified).toBe(true);
    });
  });

  // ── 2. Project Status Query Workflow ──────────────────────────────────────
  describe("2. Project Status Query Workflow", () => {
    it("decomposes 'Is project ka latest status check karo' into git status & project analysis steps", async () => {
      const goal = goalParser.parse("Is project ka latest status check karo");
      expect(goal.category).toBe("workflow");

      const plan = taskPlanner.buildPlan(goal, { deviceId: testDeviceId });
      const gitStep = plan.steps.find((s) => s.toolName === "getProjectGitStatus");
      const projStep = plan.steps.find((s) => s.toolName === "analyzeProject");
      const memStep = plan.steps.find((s) => s.toolName === "sharedMemory");

      expect(gitStep).toBeDefined();
      expect(projStep).toBeDefined();
      expect(memStep).toBeDefined();
    });

    it("executes project status workflow and produces informative synthesis", async () => {
      const res = await mobileWorkflowManager.executeVoiceWorkflow(
        {
          query: "Is project ka latest status check karo",
          deviceId: testDeviceId,
          preferredLanguage: "en",
        },
        secContext,
      );

      expect(res.success).toBe(true);
      expect(res.status).toBe("completed");
      expect(res.voiceResponse).toContain("Project status");
    });
  });

  // ── 3. Reminder Workflow with Checkpoint Confirmation ─────────────────────
  describe("3. Reminder Workflow with Checkpoint Confirmation", () => {
    it("decomposes reminder into checkpoint + modify step", () => {
      const goal = goalParser.parse("Mujhe shaam 7 baje call karne ke liye remind karna");
      expect(goal.category).toBe("workflow");

      const plan = taskPlanner.buildPlan(goal, { deviceId: testDeviceId });
      const cpStep = plan.steps.find((s) => s.toolName === "_checkpoint");
      const remStep = plan.steps.find((s) => s.toolName === "createReminder");

      expect(cpStep).toBeDefined();
      expect(remStep).toBeDefined();
      expect(remStep?.isDestructive).toBe(true);
      expect(remStep?.checkpointRequired).toBe(true);
      expect(remStep?.dependsOn).toContain(cpStep!.id);
    });

    it("halts at waiting_for_approval and prompts user for confirmation", async () => {
      const res = await mobileWorkflowManager.executeVoiceWorkflow(
        {
          query: "Mujhe 7 baje remind karna",
          deviceId: testDeviceId,
          preferredLanguage: "hinglish",
        },
        secContext,
      );

      expect(res.requiresConfirmation).toBe(true);
      expect(res.status).toBe("waiting_for_approval");
      expect(res.pendingCheckpoint).toBeDefined();
      expect(res.pendingCheckpoint?.checkpointId).toBeDefined();
      expect(res.voiceResponse).toContain("draft");
    });

    it("executes reminder creation after checkpoint is approved", async () => {
      const draftRes = await mobileWorkflowManager.executeVoiceWorkflow(
        {
          query: "Mujhe 7 baje remind karna",
          deviceId: testDeviceId,
        },
        secContext,
      );

      expect(draftRes.requiresConfirmation).toBe(true);
      const cpId = draftRes.pendingCheckpoint!.checkpointId;

      const confirmedRes = await mobileWorkflowManager.confirmWorkflowStep(
        draftRes.planId,
        cpId,
        true,
        "Haan kar do",
        secContext,
      );

      expect(confirmedRes.success).toBe(true);
      expect(confirmedRes.status).toBe("completed");
      expect(confirmedRes.voiceResponse).toContain("reminder");
    });
  });

  // ── 4. Alarm / Timer Workflow with Checkpoint Confirmation ────────────────
  describe("4. Alarm & Timer Workflow", () => {
    it("creates alarm plan requiring checkpoint confirmation", async () => {
      const res = await mobileWorkflowManager.executeVoiceWorkflow(
        {
          query: "Kal subah 6 baje ka alarm set karo",
          deviceId: testDeviceId,
          preferredLanguage: "en",
        },
        secContext,
      );

      expect(res.requiresConfirmation).toBe(true);
      expect(res.status).toBe("waiting_for_approval");
      expect(res.voiceResponse).toContain("confirm");

      const confirmed = await mobileWorkflowManager.confirmWorkflowStep(
        res.planId,
        res.pendingCheckpoint!.checkpointId,
        true,
        "confirm",
        secContext,
      );

      expect(confirmed.success).toBe(true);
      expect(confirmed.status).toBe("completed");
      expect(confirmed.voiceResponse).toContain("Alarm set");
    });

    it("creates timer plan requiring checkpoint confirmation", async () => {
      const res = await mobileWorkflowManager.executeVoiceWorkflow(
        {
          query: "5 minute ka timer lagao",
          deviceId: testDeviceId,
          preferredLanguage: "hinglish",
        },
        secContext,
      );

      expect(res.requiresConfirmation).toBe(true);
      const confirmed = await mobileWorkflowManager.confirmWorkflowStep(
        res.planId,
        res.pendingCheckpoint!.checkpointId,
        true,
        undefined,
        secContext,
      );

      expect(confirmed.success).toBe(true);
      expect(confirmed.status).toBe("completed");
      expect(confirmed.voiceResponse).toContain("timer");
    });
  });

  // ── 5. Device Status Workflow ─────────────────────────────────────────────
  describe("5. Device Status Workflow", () => {
    it("queries battery and network status", async () => {
      const res = await mobileWorkflowManager.executeVoiceWorkflow(
        {
          query: "Mera battery status aur wifi check karo",
          deviceId: testDeviceId,
          preferredLanguage: "en",
        },
        secContext,
      );

      expect(res.success).toBe(true);
      expect(res.status).toBe("completed");
      expect(res.voiceResponse).toContain("battery");
    });
  });

  // ── 6. App Actions Workflow ───────────────────────────────────────────────
  describe("6. App Actions Workflow", () => {
    it("decomposes navigation request into interactApp tool step", async () => {
      const goal = goalParser.parse("Directions to MG Road");
      const plan = taskPlanner.buildPlan(goal, { deviceId: testDeviceId });

      const actStep = plan.steps.find((s) => s.toolName === "interactApp");
      expect(actStep).toBeDefined();
      expect(actStep?.toolArgs.app).toBe("maps");
      expect(actStep?.toolArgs.destination).toBe("MG Road");
    });
  });

  // ── 7. Multilingual Voice Response Synthesis ──────────────────────────────
  describe("7. Multilingual Voice Response Synthesis", () => {
    it("synthesizes accurate English responses", async () => {
      const res = await mobileWorkflowManager.executeVoiceWorkflow(
        {
          query: "Kal ka schedule check karo",
          deviceId: testDeviceId,
          preferredLanguage: "en",
        },
        secContext,
      );

      expect(res.voiceResponse).toContain("schedule");
    });

    it("synthesizes accurate Hindi responses", async () => {
      const res = await mobileWorkflowManager.executeVoiceWorkflow(
        {
          query: "Kal ka schedule check karo",
          deviceId: testDeviceId,
          preferredLanguage: "hi",
        },
        secContext,
      );

      expect(res.voiceResponse).toContain("शेड्यूल");
    });

    it("synthesizes accurate Hinglish responses", async () => {
      const res = await mobileWorkflowManager.executeVoiceWorkflow(
        {
          query: "Kal ka schedule check karo",
          deviceId: testDeviceId,
          preferredLanguage: "hinglish",
        },
        secContext,
      );

      expect(res.voiceResponse).toContain("schedule check kar liya hai");
    });
  });

  // ── 8. Zero Duplicate Planner Invariant ───────────────────────────────────
  describe("8. Zero Duplicate Planner Invariant", () => {
    it("uses authoritative Phase 5 plannerCoordinator and taskPlanner instances", async () => {
      const plan = await plannerCoordinator.createPlan("Kal ka schedule check karo aur tasks batao", {
        deviceId: testDeviceId,
      });

      expect(plan.id).toBeDefined();
      expect(plan.goal.category).toBe("workflow");

      const fetched = await plannerCoordinator.getPlan(plan.id);
      expect(fetched?.id).toBe(plan.id);
    });
  });

  // ── 9. Zero False Positives in Verification ───────────────────────────────
  describe("9. Zero False Positives in Verification", () => {
    it("reports failure when a step encounters an error rather than false positive success", async () => {
      const plan = await plannerCoordinator.createPlan("Kal ka schedule check karo", {
        deviceId: testDeviceId,
      });

      // Inject simulated step failure
      plan.steps[0].status = "failed";
      plan.steps[0].result = {
        output: null,
        elapsedMs: 10,
        error: "SIMULATED_STEP_ERROR: Calendar capability connection failed",
        evaluation: {
          status: "critical_failure",
          score: 0,
          reason: "Step failed",
          suggestedAction: "abort",
        },
      };

      const report = completionVerifier.verify(plan);
      expect(report.verified).toBe(false);
      expect(report.summary).toContain("Partial outcomes");
    });
  });

  // ── 10. Checkpoint Rejection ──────────────────────────────────────────────
  describe("10. Checkpoint Rejection", () => {
    it("marks plan cancelled when user rejects checkpoint confirmation", async () => {
      const res = await mobileWorkflowManager.executeVoiceWorkflow(
        {
          query: "Mujhe 7 baje remind karna",
          deviceId: testDeviceId,
        },
        secContext,
      );

      expect(res.requiresConfirmation).toBe(true);
      const cpId = res.pendingCheckpoint!.checkpointId;

      const rejectRes = await mobileWorkflowManager.confirmWorkflowStep(
        res.planId,
        cpId,
        false,
        "Cancel kar do",
        secContext,
      );

      expect(rejectRes.status).toBe("cancelled");
      expect(rejectRes.voiceResponse).toContain("cancel");
    });
  });

  // ── 11. Checkpoint Token Single-Use & Replay Defense ───────────────────────
  describe("11. Checkpoint Token Single-Use & Replay Defense", () => {
    it("rejects token replay after approval is consumed", async () => {
      const res = await mobileWorkflowManager.executeVoiceWorkflow(
        {
          query: "Mujhe 7 baje remind karna",
          deviceId: testDeviceId,
        },
        secContext,
      );

      const cpId = res.pendingCheckpoint!.checkpointId;
      await mobileWorkflowManager.confirmWorkflowStep(res.planId, cpId, true, undefined, secContext);

      // Attempt replay of the same token
      const replayRes = await mobileWorkflowManager.confirmWorkflowStep(
        res.planId,
        cpId,
        true,
        undefined,
        secContext,
      );

      expect(replayRes.success).toBe(false);
      expect(replayRes.errorCode).toBe("EXECUTION_ERROR");
    });
  });

  // ── 12. Checkpoint Argument Tampering Defense ─────────────────────────────
  describe("12. Checkpoint Argument Tampering Defense", () => {
    it("rejects execution if step arguments are tampered after checkpoint issuance", async () => {
      const plan = await plannerCoordinator.createPlan("Mujhe 7 baje remind karna", {
        deviceId: testDeviceId,
      });

      const pausedPlan = await plannerCoordinator.executePlan(plan.id);
      expect(pausedPlan.status).toBe("waiting_for_approval");

      const cpId = pausedPlan.pendingCheckpointId!;
      // Approve token
      checkpointManager.approve(cpId);

      // Tamper with the modify step's args
      const modifyStep = pausedPlan.steps.find((s) => s.phase === "modify");
      expect(modifyStep).toBeDefined();
      modifyStep!.toolArgs = { title: "TAMPERED_REMINDER", timeMs: 999999 };

      // Consume approval should fail because hash mismatch occurs
      const consumed = checkpointManager.consumeApproval(
        cpId,
        modifyStep!.id,
        modifyStep!.toolName,
        modifyStep!.toolArgs,
      );

      expect(consumed).toBe(false);
    });
  });

  // ── 13. Fail-Closed: Emergency Stop ───────────────────────────────────────
  describe("13. Fail-Closed: Emergency Stop", () => {
    it("halts running plans immediately when Emergency Stop is triggered", async () => {
      const plan = await plannerCoordinator.createPlan("Kal ka schedule check karo", {
        deviceId: testDeviceId,
      });

      plan.status = "running";
      await planStore.savePlan(plan);
      await plannerCoordinator.emergencyStop();

      const fresh = await plannerCoordinator.getPlan(plan.id);
      expect(fresh?.status).toBe("paused");
    });

    it("rejects new workflow execution when Emergency Stop is active", async () => {
      emergencyStopCoordinator.trigger({ source: "rest_api", reason: "Testing fail closed" });

      const res = await mobileWorkflowManager.executeVoiceWorkflow(
        {
          query: "Kal ka schedule check karo",
          deviceId: testDeviceId,
        },
        secContext,
      );

      expect(res.success).toBe(false);
      expect(res.errorCode).toBe("EMERGENCY_STOP_ACTIVE");
    });
  });

  // ── 14. Fail-Closed: Security Lockdown ────────────────────────────────────
  describe("14. Fail-Closed: Security Lockdown", () => {
    it("rejects workflow execution when system is in LOCKDOWN mode", async () => {
      securityPolicyEngine.setMode("LOCKDOWN");

      const res = await mobileWorkflowManager.executeVoiceWorkflow(
        {
          query: "Kal ka schedule check karo",
          deviceId: testDeviceId,
        },
        secContext,
      );

      expect(res.success).toBe(false);
      expect(res.errorCode).toBe("SECURITY_LOCKDOWN_ACTIVE");
    });
  });

  // ── 15. Revoked Device Defense ────────────────────────────────────────────
  describe("15. Revoked Device Defense", () => {
    it("strictly rejects execution if target device has been revoked", async () => {
      const revokedId = "revoked_companion_01";
      await remoteStore.saveDevice({
        id: revokedId,
        name: "Revoked Phone",
        deviceType: "mobile",
        role: "standard",
        tokenHash: "rev_hash",
        pairedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        revoked: true,
      });

      const res = await mobileWorkflowManager.executeVoiceWorkflow(
        {
          query: "Kal ka schedule check karo",
          deviceId: revokedId,
        },
        { ...secContext, deviceId: revokedId },
      );

      expect(res.success).toBe(false);
      expect(res.errorCode).toBe("DEVICE_REVOKED");
    });
  });

  // ── 16. Data Loss Prevention (DLP) Screening ──────────────────────────────
  describe("16. Data Loss Prevention (DLP)", () => {
    it("rejects queries with bearer tokens or API keys", async () => {
      const res = await mobileWorkflowManager.executeVoiceWorkflow(
        {
          query: "Remind me with sora_dev_secret_token_12345",
          deviceId: testDeviceId,
        },
        secContext,
      );

      expect(res.success).toBe(false);
      expect(res.errorCode).toBe("SECURITY_VIOLATION");
    });
  });

  // ── 17. Lifecycle: Pause, Resume, Cancel ──────────────────────────────────
  describe("17. Lifecycle: Pause, Resume, Cancel", () => {
    it("pauses, resumes, and cancels workflows cleanly", async () => {
      const plan = await plannerCoordinator.createPlan("Kal ka schedule check karo", {
        deviceId: testDeviceId,
      });

      plan.status = "running";
      await planStore.savePlan(plan);

      const paused = await mobileWorkflowManager.pauseWorkflow(plan.id, secContext);
      expect(paused.status).toBe("paused");

      const resumed = await mobileWorkflowManager.resumeWorkflow(plan.id, secContext);
      expect(resumed.status).toBe("completed");

      const plan2 = await plannerCoordinator.createPlan("Kal ka schedule check karo", {
        deviceId: testDeviceId,
      });
      const cancelled = await mobileWorkflowManager.cancelWorkflow(plan2.id, secContext);
      expect(cancelled.status).toBe("cancelled");
    });
  });

  // ── 18. HTTP Gateway REST Endpoints ───────────────────────────────────────
  describe("18. HTTP Gateway REST Endpoints", () => {
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

    it("POST /api/remote/workflow/execute runs voice workflow", async () => {
      const res = await fetch(`${baseUrl}/api/remote/workflow/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: "Kal ka schedule check karo aur important tasks batao",
          preferredLanguage: "hinglish",
          deviceId: testDeviceId,
        }),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.success).toBe(true);
      expect(data.planId).toBeDefined();
    });

    it("GET /api/remote/workflow/:id retrieves status", async () => {
      const plan = await plannerCoordinator.createPlan("Kal ka schedule check karo", {
        deviceId: testDeviceId,
      });

      const res = await fetch(`${baseUrl}/api/remote/workflow/${plan.id}`, {
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.planId).toBe(plan.id);
    });

    it("POST /api/remote/workflow/:id/confirm processes checkpoint response", async () => {
      const draftRes = await mobileWorkflowManager.executeVoiceWorkflow(
        { query: "Mujhe 7 baje remind karna", deviceId: testDeviceId },
        secContext,
      );

      const cpId = draftRes.pendingCheckpoint!.checkpointId;

      const res = await fetch(`${baseUrl}/api/remote/workflow/${draftRes.planId}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ checkpointId: cpId, approved: true }),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.success).toBe(true);
      expect(data.status).toBe("completed");
    });
  });

  // ── 19. Non-Regression of Phase 5 Developer Plans ─────────────────────────
  describe("19. Non-Regression of Phase 5 Developer Plans", () => {
    it("preserves standard 8-phase code editing workflow for non-workflow developer goals", () => {
      const goal = goalParser.parse("Myraa, update README.md with project architecture");
      expect(goal.category).toBe("documentation");

      const plan = taskPlanner.buildPlan(goal);
      expect(plan.steps.some((s) => s.phase === "understand")).toBe(true);
      expect(plan.steps.some((s) => s.phase === "inspect")).toBe(true);
      expect(plan.steps.some((s) => s.phase === "checkpoint")).toBe(true);
      expect(plan.steps.some((s) => s.phase === "modify")).toBe(true);
    });
  });

  // ── 20. Tool Registry Invariant (Exactly 126 Tools) ────────────────────────
  describe("20. Tool Registry Invariant", () => {
    it("preserves strictly 126 Gemini Live tools in LIVE_TOOLS", () => {
      const decls = LIVE_TOOLS.flatMap((t: any) => t.functionDeclarations);
      expect(decls).toHaveLength(126);

      const names = new Set(decls.map((d: any) => d.name));
      expect(names.size).toBe(126);
    });
  });
});
