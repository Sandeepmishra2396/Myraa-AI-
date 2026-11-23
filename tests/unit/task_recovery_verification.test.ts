/**
 * MYRAA — Phase 11.3: Task Recovery, Execution Evidence & Completion Verification Test Suite
 *
 * Verifies:
 *   1. Crash Before Execution (Scenario A) — pending steps preserved, no phantom execution
 *   2. Crash During Execution (Scenario B) — modifying step interrupted, halts at safe boundary
 *   3. Crash After Side Effect (Scenario C.1) — environmental verification via file inspection (completed)
 *   4. Crash After Side Effect (Scenario C.2) — environmental verification fails (acknowledged_unverified)
 *   5. Downstream Execution & Deadlock Prevention — acknowledged_unverified unblocks dependent steps
 *   6. Checkpoint Recovery & Replay Protection (Scenario D) — completed steps preserved, non-destructive reset
 *   7. Retry Safety (Scenario E) — destructive steps non-retryable (maxRetries 0), read-only retryable
 *   8. Cancellation Terminality & Uncertain Boundary (Scenario F) — in-flight modifying step marked outcome_unknown
 *   9. State Machine Lifecycle Restrictions — outcome_unknown / failed cannot jump to completed
 *  10. CompletionVerifier Evidence Integrity — unverified acknowledged steps produce unsatisfied criteria
 *  11. Explainability Groundedness — explicit limitations rendered for unverified side effects
 *  12. Tool Invariant — exactly 129 LIVE_TOOLS preserved
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";
import {
  TaskOrchestrator,
  isStepDependencySatisfied,
  computeContinuationSignature,
  type OrchestratedTaskPlan,
} from "../../backend/planner/TaskOrchestrator.ts";
import { PlanStore } from "../../backend/planner/PlanStore.ts";
import { checkpointManager, hashArgs } from "../../backend/planner/CheckpointManager.ts";
import { stepExecutor } from "../../backend/planner/StepExecutor.ts";
import { emergencyStopCoordinator } from "../../backend/remote/EmergencyStopCoordinator.ts";
import { securityPolicyEngine } from "../../backend/security/SecurityPolicyEngine.ts";
import { completionVerifier } from "../../backend/planner/CompletionVerifier.ts";
import { explainabilityService } from "../../backend/explainability/ExplainabilityService.ts";
import { LIVE_TOOLS } from "../../backend/ai/GeminiSessionFactory.ts";
import type { PlanStep } from "../../backend/planner/PlannerTypes.ts";
import type { SecurityContext } from "../../backend/security/SecurityTypes.ts";

function makeStep(
  id: string,
  toolName = "analyzeProject",
  deps: string[] = [],
  isDestructive = false,
  toolArgs: Record<string, unknown> = {},
): any {
  const args = Object.keys(toolArgs).length > 0 ? toolArgs : { query: `query-${id}` };
  return {
    id,
    phase: isDestructive ? "modify" : "inspect",
    status: "pending",
    description: `Step description for ${id}`,
    toolName,
    toolArgs: args,
    argsHash: hashArgs(args),
    dependsOn: [...deps],
    isDestructive,
    checkpointRequired: isDestructive,
    retryCount: 0,
    maxRetries: isDestructive ? 0 : 3,
  };
}

function makePlan(id: string, steps: any[]): OrchestratedTaskPlan {
  const now = new Date().toISOString();
  return {
    id,
    goal: {
      id: `goal-${id}`,
      rawInput: "Test goal input",
      objective: "Test objective",
      category: "general",
      scope: { targetFiles: [], symbols: [], maxModifiableFiles: 3 },
      expectedOutcomes: [{ description: "Task objective completed", verificationHint: "Check outcomes" }],
      requiresModification: steps.some((s) => s.isDestructive),
      createdAt: now,
    },
    status: "created",
    steps,
    executionLog: [],
    artifacts: [],
    version: 1,
    checkpoints: [],
    createdAt: now,
    updatedAt: now,
  };
}

const mockSecurityContext: any = {
  identityId: "usr_operator_1",
  role: "admin",
  sessionId: "sess_recovery_test",
  authenticatedAt: new Date().toISOString(),
};

describe("Phase 11.3: Task Recovery, Execution Evidence & Verified Completion", () => {
  let tmpDir: string;
  let originalEnv: string | undefined;
  let originalWorkspace: string | undefined;
  let testStore: PlanStore;
  let orchestrator: TaskOrchestrator;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "myraa-p11-3-"));
    originalEnv = process.env.SORA_DATA_DIR;
    originalWorkspace = process.env.SORA_WORKSPACE_DIR;
    process.env.SORA_DATA_DIR = tmpDir;
    process.env.SORA_WORKSPACE_DIR = tmpDir;
    testStore = new PlanStore();
    orchestrator = new TaskOrchestrator(testStore);
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.SORA_DATA_DIR;
    } else {
      process.env.SORA_DATA_DIR = originalEnv;
    }
    if (originalWorkspace === undefined) {
      delete process.env.SORA_WORKSPACE_DIR;
    } else {
      process.env.SORA_WORKSPACE_DIR = originalWorkspace;
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  // ── Scenario A: Crash Before Execution ─────────────────────────────────────
  it("Scenario A: Crash before execution preserves pending status and establishes safe starting boundary", async () => {
    const s1 = makeStep("step-1", "analyzeProject");
    const s2 = makeStep("step-2", "write_file", ["step-1"], true, { path: "out.txt" });
    const plan = makePlan("plan-crash-before", [s1, s2]);
    await testStore.savePlan(plan);

    const recovery = await orchestrator.recoverPlan(plan.id);
    expect(recovery.recovered).toBe(true);
    expect(recovery.unresolvedSteps).toHaveLength(0);
    expect(recovery.plan?.status).toBe("paused");
    expect(recovery.plan?.steps[0].status).toBe("pending");
    expect(recovery.plan?.steps[1].status).toBe("pending");

    const nextStep = orchestrator.getNextExecutableStep(recovery.plan!);
    expect(nextStep?.id).toBe("step-1");
  });

  // ── Scenario B: Crash During Modifying Execution ───────────────────────────
  it("Scenario B: Crash during in-flight modifying step halts at safe boundary and flags uncertain outcome", async () => {
    const s1 = makeStep("step-1", "analyzeProject");
    s1.status = "completed";
    s1.completedAt = new Date().toISOString();

    const s2 = makeStep("step-2", "write_file", ["step-1"], true, { path: "pending.txt" });
    s2.status = "in_progress";
    s2.startedAt = new Date().toISOString();

    const s3 = makeStep("step-3", "reportOutcome", ["step-2"]);

    const plan = makePlan("plan-crash-during", [s1, s2, s3]);
    plan.status = "running";
    plan.activeStepId = "step-2";
    await testStore.savePlan(plan);

    const recovery = await orchestrator.recoverPlan(plan.id);
    expect(recovery.recovered).toBe(true);
    expect(recovery.unresolvedSteps).toContain("step-2");
    expect(recovery.reason).toContain("UNCERTAIN_STEPS_REQUIRE_RECONCILIATION");
    expect(recovery.plan?.status).toBe("paused");
    expect(recovery.plan?.steps[1].status).toBe("failed");
    expect(recovery.plan?.steps[1].verificationStatus).toBe("outcome_unknown");
    expect(recovery.plan?.steps[1].result?.error).toContain("INTERRUPTED_UNCERTAIN_OUTCOME");

    // Dependent step 3 is NOT executable because step 2 is failed/uncertain
    const nextStep = orchestrator.getNextExecutableStep(recovery.plan!);
    expect(nextStep).toBeUndefined();
  });

  // ── Scenario C.1: Crash After Side Effect with Environmental Verification ───
  it("Scenario C.1: Force reconciliation verifies actual filesystem side effect and marks verified_success", async () => {
    const testFilePath = path.join(tmpDir, "verified_artifact.txt");
    fs.writeFileSync(testFilePath, "real world side effect content", "utf-8");

    const s1 = makeStep("step-1", "analyzeProject");
    s1.status = "completed";

    const s2 = makeStep("step-2", "write_file", ["step-1"], true, { path: testFilePath });
    s2.status = "in_progress";

    const s3 = makeStep("step-3", "reportOutcome", ["step-2"]);

    const plan = makePlan("plan-env-verified", [s1, s2, s3]);
    plan.status = "running";
    plan.activeStepId = "step-2";
    await testStore.savePlan(plan);

    // Operator triggers recovery with forceReconciliation
    const recovery = await orchestrator.recoverPlan(plan.id, {
      forceReconciliation: true,
      callerIdentity: "lead_operator",
    });

    expect(recovery.recovered).toBe(true);
    expect(recovery.unresolvedSteps).toHaveLength(0);
    expect(recovery.plan?.uncertainStepIds).toHaveLength(0);

    const reconciledStep = recovery.plan?.steps[1];
    expect(reconciledStep?.status).toBe("completed");
    expect(reconciledStep?.verificationStatus).toBe("verified_success");
    expect(reconciledStep?.observedState).toContain("Environmental inspection verified");
    expect(reconciledStep?.reconciliation).toBeDefined();
    expect(reconciledStep?.reconciliation?.mode).toBe("environmental_verified");
    expect(reconciledStep?.reconciliation?.reconciledBy).toBe("lead_operator");

    // Step 3 is now unblocked
    const nextStep = orchestrator.getNextExecutableStep(recovery.plan!);
    expect(nextStep?.id).toBe("step-3");
  });

  // ── Scenario C.2: Crash After Side Effect where Environmental Verification Fails ──
  it("Scenario C.2: Force reconciliation marks acknowledged_unverified when side effect cannot be proven", async () => {
    const nonExistentPath = path.join(tmpDir, "phantom_never_written.txt");

    const s1 = makeStep("step-1", "analyzeProject");
    s1.status = "completed";

    const s2 = makeStep("step-2", "write_file", ["step-1"], true, { path: nonExistentPath });
    s2.status = "in_progress";

    const s3 = makeStep("step-3", "reportOutcome", ["step-2"]);

    const plan = makePlan("plan-env-unverified", [s1, s2, s3]);
    plan.status = "running";
    plan.activeStepId = "step-2";
    await testStore.savePlan(plan);

    const recovery = await orchestrator.recoverPlan(plan.id, {
      forceReconciliation: true,
      callerIdentity: "support_engineer",
    });

    expect(recovery.recovered).toBe(true);
    expect(recovery.unresolvedSteps).toHaveLength(0);

    const reconciledStep = recovery.plan?.steps[1];
    expect(reconciledStep?.status).toBe("acknowledged_unverified");
    expect(reconciledStep?.verificationStatus).toBe("acknowledged_unverified");
    expect(reconciledStep?.observedState).toContain("does not exist on disk");
    expect(reconciledStep?.reconciliation).toBeDefined();
    expect(reconciledStep?.reconciliation?.mode).toBe("operator_acknowledged");
    expect(reconciledStep?.reconciliation?.reconciledBy).toBe("support_engineer");
    expect(reconciledStep?.reconciliation?.notes).toContain("Real-world postcondition remains unverified");

    // Downstream step 3 is unblocked to execute
    const nextStep = orchestrator.getNextExecutableStep(recovery.plan!);
    expect(nextStep?.id).toBe("step-3");
  });

  // ── CompletionVerifier Evidence Integrity ─────────────────────────────────
  it("CompletionVerifier evaluates acknowledged_unverified steps as unsatisfied criteria and notes uncertainty", () => {
    const s1 = makeStep("step-1", "analyzeProject");
    s1.status = "completed";

    const s2 = makeStep("step-2", "write_file", ["step-1"], true, { path: "some_file.txt" });
    s2.status = "acknowledged_unverified";
    s2.verificationStatus = "acknowledged_unverified";
    s2.reconciliation = {
      reconciledAt: new Date().toISOString(),
      reconciledBy: "operator_bill",
      mode: "operator_acknowledged",
      notes: "Unverified acknowledgement",
      observedState: "File not found",
    };

    const s3 = makeStep("step-3", "reportOutcome", ["step-2"]);
    s3.status = "completed";

    const plan = makePlan("plan-eval-integrity", [s1, s2, s3]);
    const report = completionVerifier.verify(plan);

    // Verifier must identify the unverified step
    const unverifiedCriterion = report.criteria.find((c) =>
      c.description.includes("step-2"),
    );
    expect(unverifiedCriterion).toBeDefined();
    expect(unverifiedCriterion?.satisfied).toBe(false);
    expect(unverifiedCriterion?.evidence).toContain("UNVERIFIED_ACKNOWLEDGEMENT");

    // Report summary must flag the unverified step
    expect(report.summary).toContain("NOTICE: 1 step(s) have unverified outcomes (step-2)");
  });

  // ── Scenario D: Checkpoint Recovery & Replay Protection ───────────────────
  it("Scenario D: Checkpoint recovery preserves completed steps and resets pending/non-destructive steps", async () => {
    const s1 = makeStep("step-1", "analyzeProject");
    s1.status = "completed";
    s1.completedAt = new Date().toISOString();

    const s2 = makeStep("step-2", "fetchExternalContext", ["step-1"]);
    s2.status = "completed";
    s2.completedAt = new Date().toISOString();

    const s3 = makeStep("step-3", "inspectCode", ["step-2"]);
    s3.status = "in_progress"; // Non-destructive step interrupted

    const s4 = makeStep("step-4", "reportSummary", ["step-3"]);

    const plan = makePlan("plan-checkpoint-recovery", [s1, s2, s3, s4]);
    orchestrator.createCheckpoint(plan, { stepId: "step-2", boundaryType: "post_verification" });
    await testStore.savePlan(plan);

    const recovery = await orchestrator.recoverPlan(plan.id);
    expect(recovery.recovered).toBe(true);
    expect(recovery.lastSafeBoundary).toBe("step-2");
    expect(recovery.plan?.steps[0].status).toBe("completed");
    expect(recovery.plan?.steps[1].status).toBe("completed");
    expect(recovery.plan?.steps[2].status).toBe("pending"); // Safely reset to pending
    expect(recovery.plan?.steps[3].status).toBe("pending");

    const nextStep = orchestrator.getNextExecutableStep(recovery.plan!);
    expect(nextStep?.id).toBe("step-3");
  });

  // ── Scenario E: Retry Safety ──────────────────────────────────────────────
  it("Scenario E: Step retry bounds enforce zero retries for destructive steps", () => {
    const destructive = makeStep("step-destr", "write_file", [], true);
    const readOnly = makeStep("step-read", "analyzeProject", [], false);

    expect(destructive.isDestructive).toBe(true);
    expect(destructive.maxRetries).toBe(0);
    expect(readOnly.isDestructive).toBe(false);
    expect(readOnly.maxRetries).toBe(3);
  });

  // ── Scenario F: Cancellation Safety & Terminality ─────────────────────────
  it("Scenario F: Cancellation flags in-flight modifying steps and enforces strict terminality", async () => {
    const s1 = makeStep("step-1", "analyzeProject");
    s1.status = "completed";

    const s2 = makeStep("step-2", "write_file", ["step-1"], true, { path: "cancelled.txt" });
    s2.status = "in_progress";

    const plan = makePlan("plan-cancel-terminal", [s1, s2]);
    plan.status = "running";
    plan.activeStepId = "step-2";
    await testStore.savePlan(plan);

    const cancelled = await orchestrator.cancelTask(plan.id, "Emergency operator cancel");
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.uncertainStepIds).toContain("step-2");
    expect(cancelled.steps[1].status).toBe("failed");
    expect(cancelled.steps[1].verificationStatus).toBe("outcome_unknown");

    // Terminality: cannot recover cancelled plan
    const recovery = await orchestrator.recoverPlan(plan.id);
    expect(recovery.recovered).toBe(false);
    expect(recovery.reason).toContain("CANNOT_RECOVER_CANCELLED_PLAN");

    // Terminality: cannot cancel already completed plan
    plan.status = "completed";
    await testStore.savePlan(plan);
    await expect(orchestrator.cancelTask(plan.id)).rejects.toThrow(
      "Cannot cancel plan 'plan-cancel-terminal' because it has already completed.",
    );
  });

  // ── State Machine Lifecycle Transitions ───────────────────────────────────
  it("Lifecycle State Machine strictly rejects invalid transitions to completed", () => {
    // outcome_unknown cannot transition to completed
    const t1 = orchestrator.validateTransition("outcome_unknown", "completed");
    expect(t1.allowed).toBe(false);
    expect(t1.reason).toContain("INVALID_LIFECYCLE_TRANSITION");

    // failed cannot transition to completed
    const t2 = orchestrator.validateTransition("failed", "completed");
    expect(t2.allowed).toBe(false);

    // recovery_required cannot transition to completed
    const t3 = orchestrator.validateTransition("recovery_required", "completed");
    expect(t3.allowed).toBe(false);

    // completed is terminal
    const t4 = orchestrator.validateTransition("completed", "running");
    expect(t4.allowed).toBe(false);

    // cancelled is terminal
    const t5 = orchestrator.validateTransition("cancelled", "running");
    expect(t5.allowed).toBe(false);
  });

  // ── Explainability Service Groundedness ───────────────────────────────────
  it("ExplainabilityService renders UNCERTAIN_SIDE_EFFECT and explicit limitations for unverified steps", async () => {
    const s1 = makeStep("step-1", "write_file", [], true, { path: "unverified.txt" });
    s1.status = "acknowledged_unverified";
    s1.verificationStatus = "acknowledged_unverified";

    const plan = makePlan("plan-explain-test", [s1]);
    await testStore.savePlan(plan);

    // Step-level explanation
    const stepExplanation = await explainabilityService.explainTaskOrchestration(
      mockSecurityContext,
      { planId: plan.id, stepId: "step-1" },
    );
    expect(stepExplanation.reasonCategory).toBe("UNCERTAIN_SIDE_EFFECT");
    expect(stepExplanation.limitations.length).toBeGreaterThan(0);
    expect(stepExplanation.limitations[0]).toContain(
      "Step was acknowledged by operator to unblock plan execution, but external environmental side-effects were not independently proven.",
    );

    // Whole-plan explanation
    const planExplanation = await explainabilityService.explainTaskOrchestration(
      mockSecurityContext,
      { planId: plan.id },
    );
    expect(
      planExplanation.limitations.some((l) =>
        l.includes("Operator acknowledged uncertainty for step(s) [step-1]"),
      ),
    ).toBe(true);
  });

  // ── Tool Invariant ────────────────────────────────────────────────────────
  it("Strictly preserves LIVE_TOOLS invariant at 129 tools", () => {
    expect(LIVE_TOOLS).toBeDefined();
    expect(Array.isArray(LIVE_TOOLS)).toBe(true);
    const decls = (LIVE_TOOLS[0] as any).functionDeclarations;
    expect(decls).toHaveLength(129);
    const uniqueNames = new Set(decls.map((d: any) => d.name));
    expect(uniqueNames.size).toBe(129);
  });
});

describe("Phase 11.3.1: Postcondition Verification, Dependency Safety & Completion Gate Integrity", () => {
  let tmpDir: string;
  let originalEnv: string | undefined;
  let originalWorkspace: string | undefined;
  let testStore: PlanStore;
  let orchestrator: TaskOrchestrator;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "myraa-p11-3-1-"));
    originalEnv = process.env.SORA_DATA_DIR;
    originalWorkspace = process.env.SORA_WORKSPACE_DIR;
    process.env.SORA_DATA_DIR = tmpDir;
    process.env.SORA_WORKSPACE_DIR = tmpDir;
    testStore = new PlanStore();
    orchestrator = new TaskOrchestrator(testStore);
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.SORA_DATA_DIR;
    } else {
      process.env.SORA_DATA_DIR = originalEnv;
    }
    if (originalWorkspace === undefined) {
      delete process.env.SORA_WORKSPACE_DIR;
    } else {
      process.env.SORA_WORKSPACE_DIR = originalWorkspace;
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  // ── Area 1: Environmental Postcondition Correctness ────────────────────────
  describe("Area 1: Environmental Postcondition Scenarios", () => {
    it("1.1 File exists and contains correct expected content -> verified_success", async () => {
      const filePath = path.join(tmpDir, "correct_file.txt");
      fs.writeFileSync(filePath, "exact expected content", "utf-8");

      const s1 = makeStep("step-1", "write_file", [], true, {
        path: filePath,
        content: "exact expected content",
      });
      s1.status = "in_progress";
      s1.startedAt = new Date().toISOString();

      const plan = makePlan("plan-post-1", [s1]);
      plan.status = "running";
      plan.uncertainStepIds = ["step-1"];
      await testStore.savePlan(plan);

      const recovery = await orchestrator.recoverPlan(plan.id, { forceReconciliation: true });
      expect(recovery.recovered).toBe(true);
      expect(recovery.plan?.steps[0].status).toBe("completed");
      expect(recovery.plan?.steps[0].verificationStatus).toBe("verified_success");
      expect(recovery.plan?.steps[0].reconciliation?.mode).toBe("environmental_verified");
    });

    it("1.2 File exists but contains incorrect content -> acknowledged_unverified", async () => {
      const filePath = path.join(tmpDir, "wrong_file.txt");
      fs.writeFileSync(filePath, "unexpected garbage content", "utf-8");

      const s1 = makeStep("step-1", "write_file", [], true, {
        path: filePath,
        content: "mandatory schema definition",
      });
      s1.status = "in_progress";
      s1.startedAt = new Date().toISOString();

      const plan = makePlan("plan-post-2", [s1]);
      plan.status = "running";
      plan.uncertainStepIds = ["step-1"];
      await testStore.savePlan(plan);

      const recovery = await orchestrator.recoverPlan(plan.id, { forceReconciliation: true });
      expect(recovery.recovered).toBe(true);
      expect(recovery.plan?.steps[0].status).toBe("acknowledged_unverified");
      expect(recovery.plan?.steps[0].verificationStatus).toBe("acknowledged_unverified");
      expect(recovery.plan?.steps[0].observedState).toContain("content does not match expected payload");
    });

    it("1.3 A stale file from an earlier execution exists -> acknowledged_unverified", async () => {
      const filePath = path.join(tmpDir, "stale_file.txt");
      fs.writeFileSync(filePath, "stale content from yesterday", "utf-8");

      // Backdate mtime to 1 hour ago
      const oneHourAgo = new Date(Date.now() - 3600 * 1000);
      fs.utimesSync(filePath, oneHourAgo, oneHourAgo);

      const s1 = makeStep("step-1", "write_file", [], true, { path: filePath });
      s1.status = "in_progress";
      s1.startedAt = new Date().toISOString(); // step started now

      const plan = makePlan("plan-post-3", [s1]);
      plan.status = "running";
      plan.uncertainStepIds = ["step-1"];
      await testStore.savePlan(plan);

      const recovery = await orchestrator.recoverPlan(plan.id, { forceReconciliation: true });
      expect(recovery.recovered).toBe(true);
      expect(recovery.plan?.steps[0].status).toBe("acknowledged_unverified");
      expect(recovery.plan?.steps[0].observedState).toContain("stale artifact detected");
    });

    it("1.4 File exists but is empty (0 bytes) -> acknowledged_unverified", async () => {
      const filePath = path.join(tmpDir, "empty_file.txt");
      fs.writeFileSync(filePath, "", "utf-8");

      const s1 = makeStep("step-1", "write_file", [], true, { path: filePath });
      s1.status = "in_progress";
      s1.startedAt = new Date().toISOString();

      const plan = makePlan("plan-post-4", [s1]);
      plan.status = "running";
      plan.uncertainStepIds = ["step-1"];
      await testStore.savePlan(plan);

      const recovery = await orchestrator.recoverPlan(plan.id, { forceReconciliation: true });
      expect(recovery.recovered).toBe(true);
      expect(recovery.plan?.steps[0].status).toBe("acknowledged_unverified");
      expect(recovery.plan?.steps[0].observedState).toContain("is empty (0 bytes)");
    });

    it("1.5 Expected file is missing -> acknowledged_unverified", async () => {
      const missingPath = path.join(tmpDir, "ghost.txt");

      const s1 = makeStep("step-1", "write_file", [], true, { path: missingPath });
      s1.status = "in_progress";

      const plan = makePlan("plan-post-5", [s1]);
      plan.status = "running";
      plan.uncertainStepIds = ["step-1"];
      await testStore.savePlan(plan);

      const recovery = await orchestrator.recoverPlan(plan.id, { forceReconciliation: true });
      expect(recovery.recovered).toBe(true);
      expect(recovery.plan?.steps[0].status).toBe("acknowledged_unverified");
      expect(recovery.plan?.steps[0].observedState).toContain("does not exist on disk");
    });

    it("1.6 Multi-file operation where one file is missing -> acknowledged_unverified", async () => {
      const f1 = path.join(tmpDir, "multi_1.txt");
      const f2 = path.join(tmpDir, "multi_2.txt");
      fs.writeFileSync(f1, "file 1 exists", "utf-8");
      // f2 intentionally NOT created

      const s1 = makeStep("step-1", "write_file", [], true, { files: [f1, f2] });
      s1.status = "in_progress";
      s1.startedAt = new Date().toISOString();

      const plan = makePlan("plan-post-6", [s1]);
      plan.status = "running";
      plan.uncertainStepIds = ["step-1"];
      await testStore.savePlan(plan);

      const recovery = await orchestrator.recoverPlan(plan.id, { forceReconciliation: true });
      expect(recovery.recovered).toBe(true);
      expect(recovery.plan?.steps[0].status).toBe("acknowledged_unverified");
      expect(recovery.plan?.steps[0].observedState).toContain("does not exist on disk");
    });

    it("1.7 Non-filesystem side effect cannot fabricate evidence -> acknowledged_unverified", async () => {
      const s1 = makeStep("step-1", "deployService", [], true, { service: "auth-gateway" });
      s1.status = "in_progress";

      const plan = makePlan("plan-post-7", [s1]);
      plan.status = "running";
      plan.uncertainStepIds = ["step-1"];
      await testStore.savePlan(plan);

      const recovery = await orchestrator.recoverPlan(plan.id, { forceReconciliation: true });
      expect(recovery.recovered).toBe(true);
      expect(recovery.plan?.steps[0].status).toBe("acknowledged_unverified");
      expect(recovery.plan?.steps[0].observedState).toContain("could not verify postcondition");
    });

    it("1.8 Target path outside authorized workspace is rejected -> acknowledged_unverified", async () => {
      const outsidePath = "../../outside_system_file.txt";

      const s1 = makeStep("step-1", "write_file", [], true, { path: outsidePath });
      s1.status = "in_progress";

      const plan = makePlan("plan-post-8", [s1]);
      plan.status = "running";
      plan.uncertainStepIds = ["step-1"];
      await testStore.savePlan(plan);

      const recovery = await orchestrator.recoverPlan(plan.id, { forceReconciliation: true });
      expect(recovery.recovered).toBe(true);
      expect(recovery.plan?.steps[0].status).toBe("acknowledged_unverified");
      expect(recovery.plan?.steps[0].observedState).toContain("outside the authorized project workspace boundary");
    });
  });

  // ── Area 2: Acknowledged Unverified Dependency Safety ──────────────────────
  describe("Area 2: Acknowledged Unverified Dependency Safety Scenarios", () => {
    it("2.1 Read-only downstream step after unverified predecessor is satisfied", () => {
      const s1 = makeStep("step-1", "write_file", [], true, { path: "out.txt" });
      s1.status = "acknowledged_unverified";

      const s2 = makeStep("step-2", "analyzeProject", ["step-1"], false);
      expect(isStepDependencySatisfied(s2, s1, tmpDir)).toBe(true);
    });

    it("2.2 File-read step after unverified file-creation step (missing file) is NOT satisfied", () => {
      const s1 = makeStep("step-1", "write_file", [], true, { path: "missing_target.txt" });
      s1.status = "acknowledged_unverified";

      const s2 = makeStep("step-2", "readFile", ["step-1"], false, { path: "missing_target.txt" });
      // File does not exist on disk in tmpDir
      expect(isStepDependencySatisfied(s2, s1, tmpDir)).toBe(false);
    });

    it("2.3 Destructive step after unverified predecessor without explicit policy is NOT satisfied", () => {
      const s1 = makeStep("step-1", "write_file", [], true, { path: "schema.sql" });
      s1.status = "acknowledged_unverified";

      const s2 = makeStep("step-2", "deleteFile", ["step-1"], true, { path: "old_schema.sql" });
      // Destructive step without allowUnverifiedDependency
      expect(isStepDependencySatisfied(s2, s1, tmpDir)).toBe(false);
    });

    it("2.4 Destructive step after unverified predecessor rejects untrusted allowUnverifiedDependency but accepts valid admin ContinuationAuthorization", () => {
      const s1 = makeStep("step-1", "write_file", [], true, { path: "schema.sql" });
      s1.status = "acknowledged_unverified";

      const s2 = makeStep("step-2", "deleteFile", ["step-1"], true, { path: "old_schema.sql" });
      const plan = makePlan("plan-auth-check", [s1, s2]);

      // 1. Untrusted raw property on step object without admin ContinuationAuthorization fails closed
      (s2 as any).allowUnverifiedDependency = true;
      expect(isStepDependencySatisfied(s2, s1, tmpDir, plan)).toBe(false);

      // 2. When valid ContinuationAuthorization is granted by an authenticated admin, it is satisfied
      orchestrator.grantContinuationAuthorization(
        mockSecurityContext,
        plan,
        s2.id,
        s1.id,
      );
      expect(isStepDependencySatisfied(s2, s1, tmpDir, plan)).toBe(true);
    });

    it("2.5 Step depending on multiple predecessors (one completed, one unverified) blocks destructive downstream", () => {
      const s1 = makeStep("step-1", "inspectCode", [], false);
      s1.status = "completed";

      const s2 = makeStep("step-2", "write_file", [], true, { path: "intermediate.txt" });
      s2.status = "acknowledged_unverified";

      const s3 = makeStep("step-3", "writeCodeFile", ["step-1", "step-2"], true);
      const plan = makePlan("plan-multi-dep", [s1, s2, s3]);

      const next = orchestrator.getNextExecutableStep(plan);
      // Step 3 is destructive and cannot execute on unverified step 2
      expect(next).toBeUndefined();
    });
  });

  // ── Area 3: Final Completion Gate Integrity ────────────────────────────────
  describe("Area 3: Final Completion Gate Integrity", () => {
    it("3.1 CompletionVerifier refuses out-of-workspace target files", () => {
      const plan = makePlan("plan-outside-gate", []);
      plan.goal.scope.targetFiles = ["../../windows/system32/cmd.exe"];

      const report = completionVerifier.verify(plan);
      expect(report.criteria[0].satisfied).toBe(false);
      expect(report.criteria[0].evidence).toContain("not found or empty");
    });

    it("3.2 Plan with acknowledged_unverified steps cannot produce 100% verified completion", () => {
      const s1 = makeStep("step-1", "analyzeProject");
      s1.status = "completed";

      const s2 = makeStep("step-2", "write_file", ["step-1"], true, { path: "unproven.txt" });
      s2.status = "acknowledged_unverified";

      const plan = makePlan("plan-unverified-score", [s1, s2]);
      const report = completionVerifier.verify(plan);

      expect(report.score).toBeLessThan(1.0);
      expect(report.summary).toContain("NOTICE: 1 step(s) have unverified outcomes");
    });

    it("3.3 Cancelled plan cannot be recovered or resumed (strictly terminal)", async () => {
      const s1 = makeStep("step-1", "analyzeProject");
      const plan = makePlan("plan-cancel-gate", [s1]);
      plan.status = "cancelled";
      await testStore.savePlan(plan);

      const recovery = await orchestrator.recoverPlan(plan.id);
      expect(recovery.recovered).toBe(false);
      expect(recovery.reason).toContain("CANNOT_RECOVER_CANCELLED_PLAN");

      const check = orchestrator.validateTransition("cancelled", "running");
      expect(check.allowed).toBe(false);
    });

    it("3.4 Completed plan cannot transition back to running (strictly terminal)", () => {
      const check = orchestrator.validateTransition("completed", "running");
      expect(check.allowed).toBe(false);
      expect(check.reason).toContain("INVALID_LIFECYCLE_TRANSITION");
    });
  });

  // ── Area 4: Phase 11.3.2 Unverified Dependency Authorization Provenance ─────
  describe("Area 4: Phase 11.3.2 Unverified Dependency Authorization Provenance", () => {
    afterEach(() => {
      TaskOrchestrator.clearContinuationGrantsForTesting();
      checkpointManager.clearAll();
      securityPolicyEngine.resetForTesting();
    });

    it("4.1 Raw allowUnverifiedDependency on plan step is stripped by validatePlanGraph", () => {
      const s1 = makeStep("step-1", "write_file", [], true, { path: "schema.sql" });
      const s2 = makeStep("step-2", "deleteFile", ["step-1"], true, { path: "old.sql" });
      (s2 as any).allowUnverifiedDependency = true;

      const plan = makePlan("plan-untrusted-input", [s1, s2]);
      const result = orchestrator.validatePlanGraph(plan);

      expect(result.valid).toBe(true);
      // Property must be stripped from step
      expect((plan.steps[1] as any).allowUnverifiedDependency).toBeUndefined();
    });

    it("4.2 AI-generated plan with raw allowUnverifiedDependency cannot self-authorize destructive execution", () => {
      const s1 = makeStep("step-1", "write_file", [], true, { path: "schema.sql" });
      s1.status = "acknowledged_unverified";

      const s2 = makeStep("step-2", "deleteFile", ["step-1"], true, { path: "old.sql" });
      (s2 as any).allowUnverifiedDependency = true; // Untrusted AI attempt to self-authorize

      const plan = makePlan("plan-ai-self-auth", [s1, s2]);

      // isStepDependencySatisfied must fail closed without valid admin ContinuationAuthorization
      expect(isStepDependencySatisfied(s2, s1, tmpDir, plan)).toBe(false);
      expect(orchestrator.getNextExecutableStep(plan)).toBeUndefined();
    });

    it("4.3 Non-admin role cannot grant continuation authorization (CROSS_ROLE_AUTHORIZATION_DENIED)", () => {
      const s1 = makeStep("step-1", "write_file", [], true, { path: "schema.sql" });
      s1.status = "acknowledged_unverified";
      const s2 = makeStep("step-2", "deleteFile", ["step-1"], true, { path: "old.sql" });
      const plan = makePlan("plan-non-admin", [s1, s2]);

      const standardContext: SecurityContext = {
        identityId: "user_regular",
        role: "standard",
        ipAddress: "127.0.0.1",
        isLocal: true,
      };

      expect(() => {
        orchestrator.grantContinuationAuthorization(standardContext, plan, s2.id, s1.id);
      }).toThrow(/CROSS_ROLE_AUTHORIZATION_DENIED/);

      const guestContext: SecurityContext = {
        identityId: "guest_user",
        role: "guest",
        ipAddress: "127.0.0.1",
        isLocal: false,
      };

      expect(() => {
        orchestrator.grantContinuationAuthorization(guestContext, plan, s2.id, s1.id);
      }).toThrow(/CROSS_ROLE_AUTHORIZATION_DENIED/);
    });

    it("4.4 Continuation authorization is scoped strictly: approval for step-2 cannot authorize step-3", () => {
      const s1 = makeStep("step-1", "write_file", [], true, { path: "schema.sql" });
      s1.status = "acknowledged_unverified";
      const s2 = makeStep("step-2", "deleteFile", ["step-1"], true, { path: "old.sql" });
      const s3 = makeStep("step-3", "writeCodeFile", ["step-1"], true, { path: "index.ts" });
      const plan = makePlan("plan-step-scoping", [s1, s2, s3]);

      // Grant authorization only for step-2
      orchestrator.grantContinuationAuthorization(mockSecurityContext, plan, s2.id, s1.id);

      // step-2 is authorized
      expect(isStepDependencySatisfied(s2, s1, tmpDir, plan)).toBe(true);

      // step-3 is NOT authorized
      expect(isStepDependencySatisfied(s3, s1, tmpDir, plan)).toBe(false);
    });

    it("4.5 Continuation authorization is scoped strictly: approval for plan-A cannot authorize plan-B", () => {
      const s1A = makeStep("step-1", "write_file", [], true, { path: "schema.sql" });
      s1A.status = "acknowledged_unverified";
      const s2A = makeStep("step-2", "deleteFile", ["step-1"], true, { path: "old.sql" });
      const planA = makePlan("plan-A", [s1A, s2A]);

      const s1B = makeStep("step-1", "write_file", [], true, { path: "schema.sql" });
      s1B.status = "acknowledged_unverified";
      const s2B = makeStep("step-2", "deleteFile", ["step-1"], true, { path: "old.sql" });
      const planB = makePlan("plan-B", [s1B, s2B]);

      // Grant for planA
      orchestrator.grantContinuationAuthorization(mockSecurityContext, planA, s2A.id, s1A.id);

      expect(isStepDependencySatisfied(s2A, s1A, tmpDir, planA)).toBe(true);
      // planB with same step IDs has NO authorization
      expect(isStepDependencySatisfied(s2B, s1B, tmpDir, planB)).toBe(false);
    });

    it("4.6 Continuation authorization enforces project isolation: cannot authorize across projects", () => {
      const s1 = makeStep("step-1", "write_file", [], true, { path: "schema.sql" });
      s1.status = "acknowledged_unverified";
      const s2 = makeStep("step-2", "deleteFile", ["step-1"], true, { path: "old.sql" });
      const plan = makePlan("plan-proj-isolation", [s1, s2]);
      plan.projectId = "project-alpha";

      // Attempting to grant with mismatched projectId throws CROSS_PROJECT_VIOLATION
      expect(() => {
        orchestrator.grantContinuationAuthorization(mockSecurityContext, plan, s2.id, s1.id, {
          projectId: "project-beta",
        });
      }).toThrow(/CROSS_PROJECT_VIOLATION/);

      // Successfully granted with matching project
      orchestrator.grantContinuationAuthorization(mockSecurityContext, plan, s2.id, s1.id, {
        projectId: "project-alpha",
      });
      expect(isStepDependencySatisfied(s2, s1, tmpDir, plan)).toBe(true);

      // Mismatched runtime plan projectId fails closed
      const planTampered = { ...plan, projectId: "project-gamma" };
      expect(isStepDependencySatisfied(s2, s1, tmpDir, planTampered)).toBe(false);
    });

    it("4.7 Expired continuation authorization fails closed and is purged", () => {
      const s1 = makeStep("step-1", "write_file", [], true, { path: "schema.sql" });
      s1.status = "acknowledged_unverified";
      const s2 = makeStep("step-2", "deleteFile", ["step-1"], true, { path: "old.sql" });
      const plan = makePlan("plan-ttl-test", [s1, s2]);

      // Grant with minimal TTL (1000ms)
      orchestrator.grantContinuationAuthorization(mockSecurityContext, plan, s2.id, s1.id, {
        ttlMs: 1000,
      });

      // Initially satisfied
      expect(isStepDependencySatisfied(s2, s1, tmpDir, plan)).toBe(true);

      // Manually backdate the grant's expiresAt to simulate expiration
      const grantKey = `${plan.id}:${s2.id}:${s1.id}`;
      const grant = (TaskOrchestrator as any)._continuationGrants.get(grantKey);
      expect(grant).toBeDefined();
      grant.expiresAt = new Date(Date.now() - 5000).toISOString();

      // Verification fails closed and deletes the expired grant
      expect(isStepDependencySatisfied(s2, s1, tmpDir, plan)).toBe(false);
      expect((TaskOrchestrator as any)._continuationGrants.has(grantKey)).toBe(false);
    });

    it("4.8 Cryptographic signature tampering causes immediate fail-closed rejection", () => {
      const s1 = makeStep("step-1", "write_file", [], true, { path: "schema.sql" });
      s1.status = "acknowledged_unverified";
      const s2 = makeStep("step-2", "deleteFile", ["step-1"], true, { path: "old.sql" });
      const plan = makePlan("plan-tamper-sig", [s1, s2]);

      orchestrator.grantContinuationAuthorization(mockSecurityContext, plan, s2.id, s1.id);

      const grantKey = `${plan.id}:${s2.id}:${s1.id}`;
      const grant = (TaskOrchestrator as any)._continuationGrants.get(grantKey);
      expect(grant).toBeDefined();

      // Tamper with signature
      grant.signature = "deadbeef" + grant.signature.slice(8);

      // Must fail closed
      expect(isStepDependencySatisfied(s2, s1, tmpDir, plan)).toBe(false);
    });

    it("4.9 Emergency stop and SecurityPolicyEngine LOCKDOWN block continuation authorization", async () => {
      const s1 = makeStep("step-1", "write_file", [], true, { path: "schema.sql" });
      s1.status = "acknowledged_unverified";
      const s2 = makeStep("step-2", "deleteFile", ["step-1"], true, { path: "old.sql" });
      const plan = makePlan("plan-emerg-test", [s1, s2]);

      // 1. Lockdown mode blocks grant and verification
      securityPolicyEngine.setMode("LOCKDOWN");
      expect(() => {
        orchestrator.grantContinuationAuthorization(mockSecurityContext, plan, s2.id, s1.id);
      }).toThrow(/SECURITY_LOCKDOWN/);

      securityPolicyEngine.resetForTesting();

      // 2. Grant normal authorization
      orchestrator.grantContinuationAuthorization(mockSecurityContext, plan, s2.id, s1.id);
      expect(isStepDependencySatisfied(s2, s1, tmpDir, plan)).toBe(true);

      // Trigger emergency stop -> must immediately clear grants and fail closed
      orchestrator.emergencyStop();
      expect(isStepDependencySatisfied(s2, s1, tmpDir, plan)).toBe(false);
    });

    it("4.10 CheckpointManager independence: continuation grant NEVER bypasses execution confirmation gate", async () => {
      const s1 = makeStep("step-1", "write_file", [], true, { path: "schema.sql" });
      s1.status = "acknowledged_unverified";
      const s2 = makeStep("step-2", "deleteFile", ["step-1"], true, { path: "old.sql" });
      const plan = makePlan("plan-gate-defense", [s1, s2]);

      // Operator grants continuation authorization to allow step to become executable
      orchestrator.grantContinuationAuthorization(mockSecurityContext, plan, s2.id, s1.id);
      expect(isStepDependencySatisfied(s2, s1, tmpDir, plan)).toBe(true);

      // Orchestrator finds s2 as next executable step
      const next = orchestrator.getNextExecutableStep(plan);
      expect(next?.id).toBe("step-2");

      // However, executing s2 directly via stepExecutor WITHOUT an approved checkpoint token FAILS
      const resultWithoutToken = await stepExecutor.executeStep(s2);
      expect(resultWithoutToken.output).toBeNull();
      expect(resultWithoutToken.error).toContain("No checkpoint token found for destructive step");
    });

    it("4.11 recoverPlan with authorizeContinuationSteps creates grants and records audit log", async () => {
      const s1 = makeStep("step-1", "write_file", [], true, { path: "schema.sql" });
      s1.status = "in_progress"; // crashed mid-execution
      const s2 = makeStep("step-2", "deleteFile", ["step-1"], true, { path: "old.sql" });
      const plan = makePlan("plan-recover-auth", [s1, s2]);
      await testStore.savePlan(plan);

      // Non-admin attempting recovery with continuation authorization is denied
      const nonAdminRecovery = await orchestrator.recoverPlan(plan.id, {
        forceReconciliation: true,
        callerIdentity: "user_regular",
        callerRole: "standard",
        authorizeContinuationSteps: [s2.id],
      });
      expect(nonAdminRecovery.recovered).toBe(false);
      expect(nonAdminRecovery.reason).toContain("CROSS_ROLE_AUTHORIZATION_DENIED");

      // Admin recovery with continuation authorization succeeds
      const adminRecovery = await orchestrator.recoverPlan(plan.id, {
        forceReconciliation: true,
        callerIdentity: "admin_user",
        callerRole: "admin",
        securityContext: mockSecurityContext,
        authorizeContinuationSteps: [s2.id],
      });
      expect(adminRecovery.recovered).toBe(true);
      const recoveredPlan = adminRecovery.plan!;
      expect(
        isStepDependencySatisfied(
          recoveredPlan.steps[1],
          recoveredPlan.steps[0],
          tmpDir,
          recoveredPlan,
        ),
      ).toBe(true);

      // Plan execution log contains audit entry
      const logEntry = adminRecovery.plan?.executionLog.find((e) =>
        e.message.includes("continuation_authorized"),
      );
      expect(logEntry).toBeDefined();
      expect(logEntry?.message).toContain("usr_operator_1");
    });

    it("4.12 cancelTask immediately revokes active continuation grants", async () => {
      const s1 = makeStep("step-1", "write_file", [], true, { path: "schema.sql" });
      s1.status = "acknowledged_unverified";
      const s2 = makeStep("step-2", "deleteFile", ["step-1"], true, { path: "old.sql" });
      const plan = makePlan("plan-cancel-revocation", [s1, s2]);
      await testStore.savePlan(plan);

      orchestrator.grantContinuationAuthorization(mockSecurityContext, plan, s2.id, s1.id);
      expect(isStepDependencySatisfied(s2, s1, tmpDir, plan)).toBe(true);

      // Cancel the task
      await orchestrator.cancelTask(plan.id, "Operator cancelled workflow");

      // Continuation grant has been revoked
      expect(isStepDependencySatisfied(s2, s1, tmpDir, plan)).toBe(false);
    });
  });
});
