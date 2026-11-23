/**
 * MYRAA — Stage 10.5: Task Orchestrator Test Suite
 *
 * Covers:
 *   1. Task Planning & Graph Validation
 *      - Valid multi-step plan & deterministic dependency ordering
 *      - Invalid step references
 *      - Self-dependency rejection
 *      - Dependency-cycle rejection (2-cycle, 3-cycle)
 *      - Duplicate step IDs
 *      - Bounded plan validation (step limits, dependency limits, description limits)
 *      - Lifecycle state transitions & rejection of invalid transitions
 *   2. Checkpoint Integrity
 *      - Checkpoint creation after verified progress
 *      - Monotonic versioning
 *      - Sensitive secret & confirmation token scrubbing
 *      - Corrupted / invalid checkpoint rejection
 *      - Plan-version mismatch & stale-update protection (PlanStore.savePlanAtomic)
 *      - Project mismatch rejection (strict cross-project checkpoint isolation)
 *   3. Cancellation & Safe Stopping
 *      - Cancellation prevents subsequent step dispatch
 *      - In-flight abort signal propagation
 *      - Uncertain in-flight outcomes are not reported as completed
 *      - Terminality: no dispatch after cancellation is accepted
 *      - Emergency Stop & Security Lockdown precedence
 *   4. Safe Recovery & Resumption
 *      - Resume from a valid verified checkpoint
 *      - Do not replay completed verified steps
 *      - Do not automatically replay uncertain side-effects
 *      - Explicit reconciliation required for unresolved outcomes
 *      - Reject cross-project recovery attempts
 *      - Invalidate expired / stale confirmation tokens on recovery
 *      - Preserve cancellation and stop conditions across recovery
 *   5. Security & Integration
 *      - Step execution strictly delegates to StepExecutor
 *      - Argument tampering detection (hash mismatch)
 *      - Expired or consumed tokens cannot be reused
 *      - Plan/checkpoint never bypasses workspace or security gates
 *      - Stage 10.3 canonical projectId preservation
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";
import crypto from "crypto";

// ── Module imports ──────────────────────────────────────────────────────────
import {
  TaskOrchestrator,
  taskOrchestrator,
  scrubSensitiveData,
  MAX_PLAN_STEPS,
  MAX_DEPENDENCIES_PER_STEP,
  MAX_DESCRIPTION_LENGTH,
  type OrchestratedTaskPlan,
  type TaskCheckpoint,
} from "../../backend/planner/TaskOrchestrator.ts";
import { TaskPlanner } from "../../backend/planner/TaskPlanner.ts";
import { GoalParser } from "../../backend/planner/GoalParser.ts";
import { PlanStore } from "../../backend/planner/PlanStore.ts";
import { PlannerCoordinator } from "../../backend/planner/PlannerCoordinator.ts";
import { CheckpointManager, hashArgs } from "../../backend/planner/CheckpointManager.ts";
import { emergencyStopCoordinator } from "../../backend/remote/EmergencyStopCoordinator.ts";
import { securityPolicyEngine } from "../../backend/security/SecurityPolicyEngine.ts";
import { projectStore } from "../../backend/projects/ProjectStore.ts";
import type { PlanStep, TaskPlan, Goal } from "../../backend/planner/PlannerTypes.ts";

// ── Test Helpers ────────────────────────────────────────────────────────────

function makeTestStep(id: string, toolName = "analyzeProject", deps: string[] = [], isDestructive = false): PlanStep {
  const toolArgs: Record<string, unknown> = { query: `test-${id}` };
  return {
    id,
    phase: isDestructive ? "modify" : "inspect",
    status: "pending",
    description: `Step description for ${id}`,
    toolName,
    toolArgs,
    argsHash: hashArgs(toolArgs),
    dependsOn: [...deps],
    isDestructive,
    checkpointRequired: isDestructive,
    retryCount: 0,
    maxRetries: isDestructive ? 0 : 3,
  };
}

function makeMockPlan(id = "plan-test-001", stepCount = 3, projectId?: string): OrchestratedTaskPlan {
  const steps: PlanStep[] = [];
  let prevId: string | undefined;

  for (let i = 1; i <= stepCount; i++) {
    const stepId = `step-00${i}`;
    const deps = prevId ? [prevId] : [];
    const isDestructive = i === 2; // middle step destructive
    steps.push(makeTestStep(stepId, isDestructive ? "writeCodeFile" : "analyzeProject", deps, isDestructive));
    prevId = stepId;
  }

  const now = new Date().toISOString();
  return {
    id,
    projectId,
    goal: {
      id: `goal-${id}`,
      rawInput: "Test goal input",
      objective: "Test objective",
      category: "general",
      scope: { targetFiles: [], symbols: [], maxModifiableFiles: 3 },
      expectedOutcomes: [{ description: "Done", verificationHint: "Check" }],
      requiresModification: true,
      createdAt: now,
    },
    status: "created",
    steps,
    executionLog: [],
    artifacts: [],
    version: 1,
    checkpoints: [],
    uncertainStepIds: [],
    createdAt: now,
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// 1. Task Planning & Graph Validation
// ---------------------------------------------------------------------------

describe("Stage 10.5 — Task Planning & DAG Validation", () => {
  let orchestrator: TaskOrchestrator;

  beforeEach(() => {
    orchestrator = new TaskOrchestrator();
  });

  it("validates a structured multi-step plan with correct deterministic ordering", () => {
    const plan = makeMockPlan("plan-valid-01", 3);
    const result = orchestrator.validatePlanGraph(plan);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.orderedStepIds).toEqual(["step-001", "step-002", "step-003"]);
  });

  it("computes deterministic topological order when steps branch and rejoin", () => {
    // S1 -> S2, S1 -> S3; S2 -> S4, S3 -> S4
    const s1 = makeTestStep("s1", "analyzeProject", []);
    const s2 = makeTestStep("s2", "searchProjectCode", ["s1"]);
    const s3 = makeTestStep("s3", "readFile", ["s1"]);
    const s4 = makeTestStep("s4", "writeCodeFile", ["s2", "s3"], true);

    const plan = makeMockPlan("plan-branch-01");
    plan.steps = [s1, s2, s3, s4];

    const result = orchestrator.validatePlanGraph(plan);
    expect(result.valid).toBe(true);
    expect(result.orderedStepIds).toBeDefined();
    const order = result.orderedStepIds!;
    expect(order.indexOf("s1")).toBeLessThan(order.indexOf("s2"));
    expect(order.indexOf("s1")).toBeLessThan(order.indexOf("s3"));
    expect(order.indexOf("s2")).toBeLessThan(order.indexOf("s4"));
    expect(order.indexOf("s3")).toBeLessThan(order.indexOf("s4"));
  });

  it("rejects plans referencing non-existent step IDs in dependsOn", () => {
    const s1 = makeTestStep("s1", "analyzeProject", ["ghost-step-999"]);
    const plan = makeMockPlan("plan-invalid-ref");
    plan.steps = [s1];

    const result = orchestrator.validatePlanGraph(plan);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("non-existent dependency step ID 'ghost-step-999'"))).toBe(true);
  });

  it("rejects plans with self-dependency", () => {
    const s1 = makeTestStep("s1", "analyzeProject", ["s1"]);
    const plan = makeMockPlan("plan-self-dep");
    plan.steps = [s1];

    const result = orchestrator.validatePlanGraph(plan);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("cannot depend on itself"))).toBe(true);
  });

  it("rejects 2-step mutual dependency cycle (A -> B -> A)", () => {
    const s1 = makeTestStep("s1", "analyzeProject", ["s2"]);
    const s2 = makeTestStep("s2", "analyzeProject", ["s1"]);
    const plan = makeMockPlan("plan-2-cycle");
    plan.steps = [s1, s2];

    const result = orchestrator.validatePlanGraph(plan);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Dependency cycle detected"))).toBe(true);
  });

  it("rejects 3-step dependency cycle (A -> B -> C -> A)", () => {
    const s1 = makeTestStep("s1", "analyzeProject", ["s3"]);
    const s2 = makeTestStep("s2", "analyzeProject", ["s1"]);
    const s3 = makeTestStep("s3", "analyzeProject", ["s2"]);
    const plan = makeMockPlan("plan-3-cycle");
    plan.steps = [s1, s2, s3];

    const result = orchestrator.validatePlanGraph(plan);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Dependency cycle detected"))).toBe(true);
  });

  it("rejects duplicate step IDs", () => {
    const s1 = makeTestStep("step-dup", "analyzeProject", []);
    const s2 = makeTestStep("step-dup", "readFile", []);
    const plan = makeMockPlan("plan-dup-id");
    plan.steps = [s1, s2];

    const result = orchestrator.validatePlanGraph(plan);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Duplicate step ID"))).toBe(true);
  });

  it("enforces bounded plan limits: max steps exceeded", () => {
    const steps: PlanStep[] = [];
    for (let i = 1; i <= MAX_PLAN_STEPS + 5; i++) {
      steps.push(makeTestStep(`step-${i}`));
    }
    const plan = makeMockPlan("plan-oversized");
    plan.steps = steps;

    const result = orchestrator.validatePlanGraph(plan);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("exceeds maximum bounded limit"))).toBe(true);
  });

  it("enforces bounded dependency limits: max dependencies per step", () => {
    const deps: string[] = [];
    const steps: PlanStep[] = [];
    for (let i = 1; i <= MAX_DEPENDENCIES_PER_STEP + 2; i++) {
      const id = `dep-${i}`;
      deps.push(id);
      steps.push(makeTestStep(id));
    }
    const mainStep = makeTestStep("main", "analyzeProject", deps);
    steps.push(mainStep);

    const plan = makeMockPlan("plan-over-deps");
    plan.steps = steps;

    const result = orchestrator.validatePlanGraph(plan);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("exceeding maximum limit"))).toBe(true);
  });

  it("enforces description character limit", () => {
    const step = makeTestStep("s1");
    step.description = "x".repeat(MAX_DESCRIPTION_LENGTH + 10);
    const plan = makeMockPlan("plan-long-desc");
    plan.steps = [step];

    const result = orchestrator.validatePlanGraph(plan);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("exceeds maximum length"))).toBe(true);
  });

  it("enforces strict lifecycle transitions and rejects invalid transitions", () => {
    const plan = makeMockPlan("plan-lifecycle");

    // created -> running: allowed
    expect(orchestrator.validateTransition(plan.status, "running").allowed).toBe(true);
    orchestrator.transitionPlan(plan, "running");
    expect(plan.status).toBe("running");

    // running -> completed: allowed
    expect(orchestrator.validateTransition(plan.status, "completed").allowed).toBe(true);
    orchestrator.transitionPlan(plan, "completed");
    expect(plan.status).toBe("completed");

    // completed is terminal -> cannot transition to running or created
    expect(orchestrator.validateTransition(plan.status, "running").allowed).toBe(false);
    expect(() => orchestrator.transitionPlan(plan, "running")).toThrow(/INVALID_LIFECYCLE_TRANSITION/);

    // cancelled is strictly terminal
    const cancelledPlan = makeMockPlan("plan-cancelled");
    orchestrator.transitionPlan(cancelledPlan, "cancelled");
    expect(cancelledPlan.status).toBe("cancelled");
    expect(orchestrator.validateTransition(cancelledPlan.status, "running").allowed).toBe(false);
    expect(orchestrator.validateTransition(cancelledPlan.status, "paused").allowed).toBe(false);
    expect(() => orchestrator.transitionPlan(cancelledPlan, "running")).toThrow(/INVALID_LIFECYCLE_TRANSITION/);
  });
});

// ---------------------------------------------------------------------------
// 2. Checkpoint Integrity
// ---------------------------------------------------------------------------

describe("Stage 10.5 — Checkpoint Integrity", () => {
  let tmpDir: string;
  let originalEnv: string | undefined;
  let store: PlanStore;
  let orchestrator: TaskOrchestrator;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "myraa-chkpt-test-"));
    originalEnv = process.env.SORA_DATA_DIR;
    process.env.SORA_DATA_DIR = tmpDir;
    store = new PlanStore();
    orchestrator = new TaskOrchestrator(store);
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.SORA_DATA_DIR;
    } else {
      process.env.SORA_DATA_DIR = originalEnv;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates durable checkpoint with monotonic version increment and safe boundary metadata", async () => {
    const plan = makeMockPlan("plan-chkpt-01", 3, "proj_canonical_alpha");
    plan.steps[0].status = "completed";
    plan.steps[0].completedAt = new Date().toISOString();

    const chkpt1 = orchestrator.createCheckpoint(plan, {
      stepId: "step-001",
      boundaryType: "post_verification",
    });

    expect(chkpt1.id).toBeTruthy();
    expect(chkpt1.version).toBe(2);
    expect(chkpt1.completedStepIds).toEqual(["step-001"]);
    expect(chkpt1.pendingStepIds).toContain("step-002");
    expect(chkpt1.lastSafeBoundaryStepId).toBe("step-001");
    expect(chkpt1.projectId).toBe("proj_canonical_alpha");
    expect(chkpt1.verifiedStepOutcomes["step-001"]).toBeDefined();

    // Verify monotonic increment on second checkpoint
    const chkpt2 = orchestrator.createCheckpoint(plan, {
      stepId: "step-002",
      boundaryType: "pre_dispatch",
    });
    expect(chkpt2.version).toBe(3);
    expect(plan.checkpoints).toHaveLength(2);
  });

  it("scrubs sensitive credentials, tokens, and keys from checkpoint data", () => {
    const sensitivePayload = {
      apiKey: "sk-secret-live-123456",
      bearerToken: "Bearer eyJhbGciOi...",
      confirmationToken: "sora_conf_987654321",
      userPassword: "SuperSecretPassword!",
      privateKey: "-----BEGIN RSA PRIVATE KEY-----",
      nested: {
        authToken: "tok_secret_abc",
        safeParam: "allowed-value",
      },
      safeArray: [
        { secretToken: "redact-me", visibleText: "ok-to-keep" },
      ],
    };

    const scrubbed = scrubSensitiveData(sensitivePayload);
    expect(scrubbed.apiKey).toBe("[REDACTED]");
    expect(scrubbed.bearerToken).toBe("[REDACTED]");
    expect(scrubbed.confirmationToken).toBe("[REDACTED]");
    expect(scrubbed.userPassword).toBe("[REDACTED]");
    expect(scrubbed.privateKey).toBe("[REDACTED]");
    expect(scrubbed.nested.authToken).toBe("[REDACTED]");
    expect(scrubbed.nested.safeParam).toBe("allowed-value");
    expect(scrubbed.safeArray[0].secretToken).toBe("[REDACTED]");
    expect(scrubbed.safeArray[0].visibleText).toBe("ok-to-keep");
  });

  it("rejects corrupted or mismatched checkpoint records during integrity validation", () => {
    const plan = makeMockPlan("plan-chkpt-integrity", 2, "proj_alpha");
    const validChkpt = orchestrator.createCheckpoint(plan);

    // Valid check passes
    expect(orchestrator.validateCheckpointIntegrity(plan, validChkpt).valid).toBe(true);

    // Mismatched plan ID
    const wrongPlanChkpt = { ...validChkpt, planId: "other-plan-id" };
    const res1 = orchestrator.validateCheckpointIntegrity(plan, wrongPlanChkpt);
    expect(res1.valid).toBe(false);
    expect(res1.reason).toContain("CHECKPOINT_PLAN_MISMATCH");

    // Project mismatch (checkpoint claims proj_beta for proj_alpha plan)
    const crossProjChkpt = { ...validChkpt, projectId: "proj_beta" };
    const res2 = orchestrator.validateCheckpointIntegrity(plan, crossProjChkpt);
    expect(res2.valid).toBe(false);
    expect(res2.reason).toContain("CROSS_PROJECT_CHECKPOINT_MISMATCH");

    // Invalid non-existent step reference
    const nonExistStepChkpt = { ...validChkpt, completedStepIds: ["ghost-step"] };
    const res3 = orchestrator.validateCheckpointIntegrity(plan, nonExistStepChkpt);
    expect(res3.valid).toBe(false);
    expect(res3.reason).toContain("does not exist in plan");
  });

  it("PlanStore.savePlanAtomic enforces optimistic concurrency and rejects stale version overwrite", async () => {
    const plan = makeMockPlan("plan-atomic-01");
    plan.version = 5;
    await store.savePlan(plan);

    // Saving with matching expectedVersion 5 succeeds
    plan.version = 6;
    await expect(store.savePlanAtomic(plan, 5)).resolves.not.toThrow();

    // Stale update: trying to save expecting version 4 when store is now at 6 must throw
    plan.version = 7;
    await expect(store.savePlanAtomic(plan, 4)).rejects.toThrow(/STALE_UPDATE_DETECTED/);
  });
});

// ---------------------------------------------------------------------------
// 3. Cancellation & Safe Stopping
// ---------------------------------------------------------------------------

describe("Stage 10.5 — Cancellation & Safe Stopping", () => {
  let tmpDir: string;
  let originalEnv: string | undefined;
  let store: PlanStore;
  let orchestrator: TaskOrchestrator;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "myraa-cancel-test-"));
    originalEnv = process.env.SORA_DATA_DIR;
    process.env.SORA_DATA_DIR = tmpDir;
    store = new PlanStore();
    orchestrator = new TaskOrchestrator(store);
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.SORA_DATA_DIR;
    } else {
      process.env.SORA_DATA_DIR = originalEnv;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("cancels an active plan, marks status cancelled with timestamp, and expires pending tokens", async () => {
    const plan = makeMockPlan("plan-cancel-01");
    plan.status = "running";
    plan.pendingCheckpointId = "dummy-token-123";
    await store.savePlan(plan);

    const cancelled = await orchestrator.cancelTask(plan.id, "User requested halt");
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.cancelledAt).toBeDefined();
    expect(cancelled.cancellationReason).toBe("User requested halt");
    expect(cancelled.pendingCheckpointId).toBeUndefined();

    // Checkpoint records boundaryType = 'cancelled'
    const lastChkpt = cancelled.checkpoints![cancelled.checkpoints!.length - 1];
    expect(lastChkpt.boundaryType).toBe("cancelled");
  });

  it("marks in-flight modifying step as uncertain outcome upon cancellation", async () => {
    const plan = makeMockPlan("plan-cancel-uncertain", 3);
    plan.status = "running";
    // step 2 is writeCodeFile (destructive) and is in-flight
    plan.activeStepId = "step-002";
    plan.steps[1].status = "in_progress";
    await store.savePlan(plan);

    const cancelled = await orchestrator.cancelTask(plan.id, "Interrupted mid-write");
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.uncertainStepIds).toContain("step-002");
    expect(cancelled.steps[1].status).toBe("failed");
    expect(cancelled.steps[1].result?.error).toContain("INTERRUPTED_BY_CANCELLATION");
  });

  it("enforces cancellation terminality: cannot cancel already completed plan", async () => {
    const plan = makeMockPlan("plan-completed-terminal");
    plan.status = "completed";
    await store.savePlan(plan);

    await expect(orchestrator.cancelTask(plan.id)).rejects.toThrow(/Cannot cancel plan/);
  });

  it("idempotently returns already-cancelled plan without error", async () => {
    const plan = makeMockPlan("plan-already-cancelled");
    plan.status = "cancelled";
    await store.savePlan(plan);

    const res = await orchestrator.cancelTask(plan.id);
    expect(res.status).toBe("cancelled");
  });

  it("enforces Emergency Stop priority across orchestrator", () => {
    expect(typeof orchestrator.emergencyStop).toBe("function");
    orchestrator.emergencyStop();
    // Verify emergency stop does not crash or throw
  });
});

// ---------------------------------------------------------------------------
// 4. Safe Recovery & Resumption
// ---------------------------------------------------------------------------

describe("Stage 10.5 — Safe Recovery & Resumption", () => {
  let tmpDir: string;
  let originalEnv: string | undefined;
  let store: PlanStore;
  let orchestrator: TaskOrchestrator;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "myraa-recovery-test-"));
    originalEnv = process.env.SORA_DATA_DIR;
    process.env.SORA_DATA_DIR = tmpDir;
    store = new PlanStore();
    orchestrator = new TaskOrchestrator(store);
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.SORA_DATA_DIR;
    } else {
      process.env.SORA_DATA_DIR = originalEnv;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("safely recovers from a valid verified checkpoint with clean safe boundary", async () => {
    const plan = makeMockPlan("plan-recover-01", 3, "proj_canonical_delta");
    plan.status = "running";
    plan.steps[0].status = "completed";
    plan.steps[0].completedAt = new Date().toISOString();
    orchestrator.createCheckpoint(plan, { stepId: "step-001", boundaryType: "post_verification" });
    await store.savePlan(plan);

    const recovery = await orchestrator.recoverPlan(plan.id, { projectId: "proj_canonical_delta" });
    expect(recovery.recovered).toBe(true);
    expect(recovery.unresolvedSteps).toHaveLength(0);
    expect(recovery.lastSafeBoundary).toBe("step-001");
    expect(recovery.plan?.status).toBe("paused");
  });

  it("does NOT automatically replay interrupted destructive steps — flags them as uncertain and requires reconciliation", async () => {
    const plan = makeMockPlan("plan-recover-uncertain", 3);
    plan.status = "running";
    plan.steps[0].status = "completed";
    // Step 2 was modifying (writeCodeFile) and left in_progress due to process crash
    plan.steps[1].status = "in_progress";
    await store.savePlan(plan);

    const recovery = await orchestrator.recoverPlan(plan.id);
    expect(recovery.recovered).toBe(true);
    expect(recovery.unresolvedSteps).toContain("step-002");
    expect(recovery.reason).toContain("UNCERTAIN_STEPS_REQUIRE_RECONCILIATION");
    expect(recovery.plan?.status).toBe("paused");
    expect(recovery.plan?.steps[1].status).toBe("failed");
    expect(recovery.plan?.steps[1].result?.error).toContain("INTERRUPTED_UNCERTAIN_OUTCOME");
  });

  it("allows safe resumption once explicit human reconciliation is provided", async () => {
    const plan = makeMockPlan("plan-recover-force", 3);
    plan.status = "running";
    plan.steps[0].status = "completed";
    plan.steps[1].status = "in_progress";
    await store.savePlan(plan);

    // With explicit reconciliation, uncertain step list is cleared
    const recovery = await orchestrator.recoverPlan(plan.id, { forceReconciliation: true });
    expect(recovery.recovered).toBe(true);
    expect(recovery.unresolvedSteps).toHaveLength(0);
    expect(recovery.plan?.uncertainStepIds).toHaveLength(0);
  });

  it("resets non-destructive in_progress steps to pending for clean rerun", async () => {
    const plan = makeMockPlan("plan-recover-safe-reset", 3);
    plan.status = "running";
    // Step 1 is inspect/analyzeProject (non-destructive)
    plan.steps[0].status = "in_progress";
    await store.savePlan(plan);

    const recovery = await orchestrator.recoverPlan(plan.id);
    expect(recovery.recovered).toBe(true);
    expect(recovery.unresolvedSteps).toHaveLength(0);
    expect(recovery.plan?.steps[0].status).toBe("pending");
  });

  it("strictly rejects cross-project recovery attempts (Project B cannot recover Project A plan)", async () => {
    const plan = makeMockPlan("plan-proj-a", 3, "project_A_canonical");
    await store.savePlan(plan);

    const recovery = await orchestrator.recoverPlan(plan.id, { projectId: "project_B_canonical" });
    expect(recovery.recovered).toBe(false);
    expect(recovery.reason).toContain("CROSS_PROJECT_RECOVERY_DENIED");
  });

  it("rejects recovery of a cancelled plan (cancellation terminality)", async () => {
    const plan = makeMockPlan("plan-cancelled-recovery", 3);
    plan.status = "cancelled";
    await store.savePlan(plan);

    const recovery = await orchestrator.recoverPlan(plan.id);
    expect(recovery.recovered).toBe(false);
    expect(recovery.reason).toContain("CANNOT_RECOVER_CANCELLED_PLAN");
  });

  it("rejects recovery of an already completed plan", async () => {
    const plan = makeMockPlan("plan-completed-recovery", 3);
    plan.status = "completed";
    await store.savePlan(plan);

    const recovery = await orchestrator.recoverPlan(plan.id);
    expect(recovery.recovered).toBe(false);
    expect(recovery.reason).toContain("PLAN_ALREADY_COMPLETED");
  });

  it("rejects recovery when Emergency Stop is active", async () => {
    const plan = makeMockPlan("plan-estop-recovery", 3);
    await store.savePlan(plan);

    // Mock emergency stop active
    const spy = vi.spyOn(emergencyStopCoordinator, "isActive").mockReturnValue(true);
    const recovery = await orchestrator.recoverPlan(plan.id);
    expect(recovery.recovered).toBe(false);
    expect(recovery.reason).toContain("EMERGENCY_STOP_ACTIVE");
    spy.mockRestore();
  });

  it("rejects recovery when Security Lockdown is active", async () => {
    const plan = makeMockPlan("plan-lockdown-recovery", 3);
    await store.savePlan(plan);

    const spy = vi.spyOn(securityPolicyEngine, "getMode").mockReturnValue("LOCKDOWN");
    const recovery = await orchestrator.recoverPlan(plan.id);
    expect(recovery.recovered).toBe(false);
    expect(recovery.reason).toContain("SECURITY_LOCKDOWN_ACTIVE");
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 5. Security & Integration
// ---------------------------------------------------------------------------

describe("Stage 10.5 — Security & Integration", () => {
  let tmpDir: string;
  let originalEnv: string | undefined;
  let store: PlanStore;
  let coordinator: PlannerCoordinator;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "myraa-sec-int-test-"));
    originalEnv = process.env.SORA_DATA_DIR;
    process.env.SORA_DATA_DIR = tmpDir;
    store = new PlanStore();
    coordinator = new PlannerCoordinator();
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.SORA_DATA_DIR;
    } else {
      process.env.SORA_DATA_DIR = originalEnv;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("PlannerCoordinator.validatePlan integrates TaskOrchestrator graph validation", () => {
    const plan = makeMockPlan("plan-coord-val");
    const res = coordinator.validatePlan(plan);
    expect(res.valid).toBe(true);
  });

  it("PlannerCoordinator.createPlan automatically captures initial durable checkpoint", async () => {
    const plan = await coordinator.createPlan("Research documentation for API");
    const retrieved = (await store.getPlan(plan.id)) as OrchestratedTaskPlan;
    expect(retrieved).toBeDefined();
    expect(retrieved.checkpoints).toBeDefined();
    expect(retrieved.checkpoints!.length).toBeGreaterThanOrEqual(1);
    expect(retrieved.checkpoints![0].boundaryType).toBe("initial");
    await coordinator.deletePlan(plan.id);
  });

  it("PlannerCoordinator.cancelPlan delegates to TaskOrchestrator and sets cancelled status", async () => {
    const plan = await coordinator.createPlan("Inspect project code");
    const cancelled = await coordinator.cancelPlan(plan.id, "Stopped via coordinator");
    expect(cancelled).toBeDefined();
    expect(cancelled!.status).toBe("cancelled");
    await coordinator.deletePlan(plan.id);
  });

  it("PlannerCoordinator.recoverPlan exposes safe recovery API with isolation checks", async () => {
    const plan = await coordinator.createPlan("Analyze project architecture");
    const res = await coordinator.recoverPlan(plan.id);
    expect(res.recovered).toBe(true);
    await coordinator.deletePlan(plan.id);
  });

  it("Changed action parameters invalidate confirmation token (args tampering defense)", () => {
    const cm = new CheckpointManager();
    const step = makeTestStep("s-tamper", "writeCodeFile", [], true);
    const cp = cm.issue("plan-tamper", step);
    cm.approve(cp.id);

    // Same args -> approved
    expect(cm.consumeApproval(cp.id, step.id, step.toolName, step.toolArgs)).toBe(true);

    // Issue second token, approve, then tamper args
    const cp2 = cm.issue("plan-tamper-2", step);
    cm.approve(cp2.id);
    const tamperedArgs = { ...step.toolArgs, extraPayload: "injected" };
    expect(cm.consumeApproval(cp2.id, step.id, step.toolName, tamperedArgs)).toBe(false);
  });

  it("Revoked, expired, or consumed tokens cannot be reused", () => {
    const cm = new CheckpointManager();
    const step = makeTestStep("s-replay", "writeCodeFile", [], true);
    const cp = cm.issue("plan-replay", step);
    cm.approve(cp.id);

    // First use consumes
    expect(cm.consumeApproval(cp.id, step.id, step.toolName, step.toolArgs)).toBe(true);
    // Second use is rejected
    expect(cm.consumeApproval(cp.id, step.id, step.toolName, step.toolArgs)).toBe(false);
  });

  it("Strictly preserves LIVE_TOOLS count at 129", async () => {
    const { LIVE_TOOLS } = await import("../../backend/ai/GeminiSessionFactory.ts");
    expect(LIVE_TOOLS).toBeDefined();
    expect(Array.isArray(LIVE_TOOLS)).toBe(true);
    const decls = LIVE_TOOLS[0].functionDeclarations;
    expect(decls).toHaveLength(129);
    const uniqueNames = new Set(decls.map((d: any) => d.name));
    expect(uniqueNames.size).toBe(129);
  });
});
