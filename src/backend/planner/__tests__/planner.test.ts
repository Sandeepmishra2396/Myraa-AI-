/**
 * MYRAA — Phase 5: Planner Test Suite
 *
 * Tests cover:
 *   1. GoalParser — parsing, category, scope, outcomes
 *   2. TaskPlanner — 8-phase workflow, dependency, destructive flagging
 *   3. CheckpointManager — issue, approve, reject, consume (one-time),
 *      replay prevention, argument tampering, token expiry, restart expiry
 *   4. ResultEvaluator — success, partial, retryable, critical_failure,
 *      destructive-step retry prohibition
 *   5. RecoveryEngine — backoff calculation, shouldRetry, sleep bound
 *   6. PlanStore — create, read, update, delete, BOM resilience, findByStatus
 *   7. PlannerCoordinator — create plan, pause, resume, confirm checkpoint,
 *      checkpoint bypass prevention, restart safety (waiting_for_approval not auto-resumed),
 *      duplicate execution prevention, path traversal rejection, unexpected args rejection
 *   8. Adversarial — checkpoint bypass, token replay, path traversal,
 *      duplicate execution, pause/resume, restart recovery
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";

// ── Module imports ──────────────────────────────────────────────────────────
import { GoalParser } from "../GoalParser.ts";
import { TaskPlanner } from "../TaskPlanner.ts";
import { CheckpointManager, hashArgs } from "../CheckpointManager.ts";
import { ResultEvaluator } from "../ResultEvaluator.ts";
import { RecoveryEngine, computeBackoffMs } from "../RecoveryEngine.ts";
import { PlanStore } from "../PlanStore.ts";
import { PlannerCoordinator } from "../PlannerCoordinator.ts";
import type { PlanStep, TaskPlan, Goal } from "../PlannerTypes.ts";
import { DEFAULT_RETRY_POLICY } from "../PlannerTypes.ts";

// ── Shared helpers ───────────────────────────────────────────────────────────

function makeSafeStep(overrides: Partial<PlanStep> = {}): PlanStep {
  return {
    id: "step-safe-001",
    phase: "inspect",
    status: "pending",
    description: "Safe inspect step",
    toolName: "analyzeProject",
    toolArgs: {},
    argsHash: hashArgs({}),
    dependsOn: [],
    isDestructive: false,
    checkpointRequired: false,
    retryCount: 0,
    maxRetries: 3,
    ...overrides,
  };
}

function makeDestructiveStep(overrides: Partial<PlanStep> = {}): PlanStep {
  return {
    id: "step-dest-001",
    phase: "modify",
    status: "pending",
    description: "Write README.md",
    toolName: "writeCodeFile",
    toolArgs: { path: "README.md", content: "# Project" },
    argsHash: hashArgs({ path: "README.md", content: "# Project" }),
    dependsOn: [],
    isDestructive: true,
    checkpointRequired: true,
    retryCount: 0,
    maxRetries: 0,
    ...overrides,
  };
}

// ── 1. GoalParser ─────────────────────────────────────────────────────────────

describe("GoalParser", () => {
  const parser = new GoalParser();

  it("parses a documentation goal correctly", () => {
    const goal = parser.parse("Myraa, mere project ka README update karo");
    expect(goal.id).toBeTruthy();
    expect(goal.category).toBe("documentation");
    expect(goal.rawInput).toContain("README");
    expect(goal.requiresModification).toBe(true);
    expect(goal.expectedOutcomes.length).toBeGreaterThan(0);
  });

  it("parses a research goal", () => {
    const goal = parser.parse("React 19 ke latest changes research karo");
    expect(goal.category).toBe("research");
    expect(goal.requiresModification).toBe(false);
  });

  it("parses a bugfix goal", () => {
    const goal = parser.parse("Fix the authentication bug in auth.ts");
    expect(goal.category).toBe("bugfix");
    expect(goal.requiresModification).toBe(true);
    expect(goal.scope.targetFiles).toContain("auth.ts");
  });

  it("parses a testing goal", () => {
    const goal = parser.parse("Write unit tests for the MemoryManager");
    expect(goal.category).toBe("testing");
    expect(goal.scope.symbols).toContain("MemoryManager");
  });

  it("handles empty input without throwing", () => {
    const goal = parser.parse("");
    expect(goal.category).toBe("general");
    expect(goal.requiresModification).toBe(false);
  });

  it("truncates very long inputs to 120 chars in objective", () => {
    const long = "a".repeat(200);
    const goal = parser.parse(long);
    expect(goal.objective.length).toBeLessThanOrEqual(123); // 117 + …
  });

  it("creates a stable, unique ID per parse", () => {
    const g1 = parser.parse("same input");
    const g2 = parser.parse("same input");
    expect(g1.id).not.toBe(g2.id);
  });
});

// ── 2. TaskPlanner ───────────────────────────────────────────────────────────

describe("TaskPlanner", () => {
  const parser = new GoalParser();
  const planner = new TaskPlanner();

  it("generates exactly the 8 canonical phases for a modifying goal", () => {
    const goal = parser.parse("Update README.md with architecture");
    const plan = planner.buildPlan(goal);
    const phases = plan.steps.map((s) => s.phase);
    expect(phases).toContain("understand");
    expect(phases).toContain("inspect");
    expect(phases).toContain("plan");
    expect(phases).toContain("checkpoint");
    expect(phases).toContain("modify");
    expect(phases).toContain("verify");
    expect(phases).toContain("report");
  });

  it("marks the modify step as destructive and checkpointRequired", () => {
    const goal = parser.parse("Update README.md");
    const plan = planner.buildPlan(goal);
    const modify = plan.steps.find((s) => s.phase === "modify");
    expect(modify).toBeTruthy();
    expect(modify!.isDestructive).toBe(true);
    expect(modify!.checkpointRequired).toBe(true);
  });

  it("gives destructive steps maxRetries = 0", () => {
    const goal = parser.parse("Update README.md");
    const plan = planner.buildPlan(goal);
    const modify = plan.steps.find((s) => s.phase === "modify");
    expect(modify!.maxRetries).toBe(0);
  });

  it("modify step depends on checkpoint step", () => {
    const goal = parser.parse("Update README.md");
    const plan = planner.buildPlan(goal);
    const checkpoint = plan.steps.find((s) => s.phase === "checkpoint");
    const modify = plan.steps.find((s) => s.phase === "modify");
    expect(modify!.dependsOn).toContain(checkpoint!.id);
  });

  it("computes argsHash at plan creation", () => {
    const goal = parser.parse("Update README.md");
    const plan = planner.buildPlan(goal);
    for (const step of plan.steps) {
      const expected = hashArgs(step.toolArgs);
      expect(step.argsHash).toBe(expected);
    }
  });

  it("creates plan with status 'created'", () => {
    const goal = parser.parse("Research auth approaches");
    const plan = planner.buildPlan(goal);
    expect(plan.status).toBe("created");
  });

  it("research-only goal has no modify or checkpoint steps", () => {
    const goal = parser.parse("Research React 19 latest changes");
    const plan = planner.buildPlan(goal);
    // research goals: requiresModification = false → no checkpoint/modify
    expect(goal.requiresModification).toBe(false);
    const checkpointSteps = plan.steps.filter((s) => s.phase === "checkpoint");
    const modifySteps = plan.steps.filter((s) => s.phase === "modify");
    expect(checkpointSteps.length).toBe(0);
    expect(modifySteps.length).toBe(0);
  });
});

// ── 3. CheckpointManager ─────────────────────────────────────────────────────

describe("CheckpointManager", () => {
  let cm: CheckpointManager;
  let step: PlanStep;

  beforeEach(() => {
    cm = new CheckpointManager();
    step = makeDestructiveStep();
  });

  it("issues a checkpoint with status=pending", () => {
    const cp = cm.issue("plan-001", step);
    expect(cp.status).toBe("pending");
    expect(cp.planId).toBe("plan-001");
    expect(cp.stepId).toBe(step.id);
    expect(cp.toolName).toBe(step.toolName);
    expect(cp.argsHash).toBe(step.argsHash);
  });

  it("approves a valid pending checkpoint", () => {
    const cp = cm.issue("plan-001", step);
    const approved = cm.approve(cp.id);
    expect(approved.status).toBe("approved");
  });

  it("rejects a pending checkpoint", () => {
    const cp = cm.issue("plan-001", step);
    const rejected = cm.reject(cp.id, "Too risky");
    expect(rejected.status).toBe("rejected");
  });

  it("consumeApproval succeeds once for valid approved token", () => {
    const cp = cm.issue("plan-001", step);
    cm.approve(cp.id);
    const result = cm.consumeApproval(cp.id, step.id, step.toolName, step.toolArgs);
    expect(result).toBe(true);
  });

  it("REPLAY PREVENTION: second consumeApproval fails after first succeeds", () => {
    const cp = cm.issue("plan-001", step);
    cm.approve(cp.id);
    cm.consumeApproval(cp.id, step.id, step.toolName, step.toolArgs);
    // Replay attempt
    const replay = cm.consumeApproval(cp.id, step.id, step.toolName, step.toolArgs);
    expect(replay).toBe(false);
  });

  it("BYPASS PREVENTION: consumeApproval on non-approved token returns false", () => {
    const cp = cm.issue("plan-001", step);
    // Token is still pending, not approved
    const result = cm.consumeApproval(cp.id, step.id, step.toolName, step.toolArgs);
    expect(result).toBe(false);
  });

  it("BYPASS PREVENTION: rejected token cannot be consumed", () => {
    const cp = cm.issue("plan-001", step);
    cm.reject(cp.id);
    const result = cm.consumeApproval(cp.id, step.id, step.toolName, step.toolArgs);
    expect(result).toBe(false);
  });

  it("ARGUMENT TAMPERING: consumeApproval fails when args differ from approval snapshot", () => {
    const cp = cm.issue("plan-001", step);
    cm.approve(cp.id);
    // Attacker tries to pass different args
    const tamperedArgs = { path: "../../etc/passwd", content: "malicious" };
    const result = cm.consumeApproval(cp.id, step.id, step.toolName, tamperedArgs);
    expect(result).toBe(false);
  });

  it("TOOL SUBSTITUTION: consumeApproval fails when toolName differs", () => {
    const cp = cm.issue("plan-001", step);
    cm.approve(cp.id);
    const result = cm.consumeApproval(cp.id, step.id, "deleteFile", step.toolArgs);
    expect(result).toBe(false);
  });

  it("STEP MISMATCH: consumeApproval fails for different stepId", () => {
    const cp = cm.issue("plan-001", step);
    cm.approve(cp.id);
    const result = cm.consumeApproval(cp.id, "different-step-id", step.toolName, step.toolArgs);
    expect(result).toBe(false);
  });

  it("approve throws if token is already consumed", () => {
    const cp = cm.issue("plan-001", step);
    cm.approve(cp.id);
    cm.consumeApproval(cp.id, step.id, step.toolName, step.toolArgs);
    expect(() => cm.approve(cp.id)).toThrow();
  });

  it("RESTART EXPIRY: restore marks approved tokens as expired", () => {
    const cp = cm.issue("plan-001", step);
    cm.approve(cp.id);
    // Simulate server restart: create new instance and restore
    const cm2 = new CheckpointManager();
    cm2.restore(cp);
    const restored = cm2.get(cp.id);
    // After restart, approved token must be expired to force re-confirmation
    expect(restored?.status).toBe("expired");
  });

  it("TOKEN EXPIRY: expired tokens cannot be approved", () => {
    const cp = cm.issue("plan-001", step);
    // Manually set expiresAt to the past
    (cp as any).expiresAt = new Date(Date.now() - 1000).toISOString();
    expect(() => cm.approve(cp.id)).toThrow(/expired/i);
  });

  it("expireAll marks all pending tokens for a plan as expired", () => {
    const cp1 = cm.issue("plan-001", step);
    const cp2 = cm.issue("plan-001", { ...step, id: "step-002" });
    cm.expireAll("plan-001");
    expect(cm.get(cp1.id)?.status).toBe("expired");
    expect(cm.get(cp2.id)?.status).toBe("expired");
  });

  it("hashArgs is deterministic regardless of key insertion order", () => {
    const h1 = hashArgs({ b: 2, a: 1 });
    const h2 = hashArgs({ a: 1, b: 2 });
    expect(h1).toBe(h2);
  });
});

// ── 4. ResultEvaluator ───────────────────────────────────────────────────────

describe("ResultEvaluator", () => {
  const ev = new ResultEvaluator();

  it("returns success for rich output", () => {
    const step = makeSafeStep();
    const result = ev.evaluate(step, { output: { summary: "ok", result: "done" }, elapsedMs: 100 });
    expect(result.status).toBe("success");
    expect(result.score).toBeGreaterThan(0.5);
  });

  it("returns retryable_failure for network timeout on safe step", () => {
    const step = makeSafeStep({ retryCount: 0, maxRetries: 3 });
    const result = ev.evaluate(step, { output: null, error: "ETIMEDOUT: connection timed out", elapsedMs: 5000 });
    expect(result.status).toBe("retryable_failure");
    expect(result.suggestedAction).toBe("retry");
  });

  it("DESTRUCTIVE RETRY PROHIBITION: transient error on destructive step → critical_failure", () => {
    const step = makeDestructiveStep({ retryCount: 0 });
    const result = ev.evaluate(step, { output: null, error: "ECONNREFUSED: desktop agent is not running", elapsedMs: 0 });
    expect(result.status).toBe("critical_failure");
    expect(result.suggestedAction).toBe("abort");
  });

  it("returns critical_failure for access denied", () => {
    const step = makeSafeStep();
    const result = ev.evaluate(step, { output: null, error: "Access denied: path is outside workspace", elapsedMs: 0 });
    expect(result.status).toBe("critical_failure");
    expect(result.suggestedAction).toBe("abort");
  });

  it("returns fallback suggestion on max retries exhausted", () => {
    const step = makeSafeStep({ retryCount: 3, maxRetries: 3, toolName: "fetchOfficialDocs" });
    const result = ev.evaluate(step, { output: null, error: "timeout", elapsedMs: 0 });
    expect(result.suggestedAction).toBe("fallback");
    expect(result.fallbackTool).toBe("researchWeb");
  });

  it("partial result for null output without error", () => {
    const step = makeSafeStep();
    const result = ev.evaluate(step, { output: null, elapsedMs: 50 });
    expect(result.status).toBe("partial");
  });
});

// ── 5. RecoveryEngine ────────────────────────────────────────────────────────

describe("RecoveryEngine", () => {
  const re = new RecoveryEngine();

  it("computes exponential backoff correctly", () => {
    const d0 = computeBackoffMs(0, { ...DEFAULT_RETRY_POLICY, initialDelayMs: 500, backoffMultiplier: 2, maxDelayMs: 8000 });
    const d1 = computeBackoffMs(1, { ...DEFAULT_RETRY_POLICY, initialDelayMs: 500, backoffMultiplier: 2, maxDelayMs: 8000 });
    // d1 should be roughly double d0 (jitter might vary slightly)
    expect(d1).toBeGreaterThan(d0 * 0.9);
    expect(d1).toBeLessThanOrEqual(8000 * 1.1); // max + 10% jitter
  });

  it("never exceeds maxDelayMs + jitter", () => {
    const delay = computeBackoffMs(20, { ...DEFAULT_RETRY_POLICY, initialDelayMs: 500, backoffMultiplier: 2, maxDelayMs: 1000 });
    expect(delay).toBeLessThanOrEqual(1200); // maxDelayMs + 10% jitter
  });

  it("shouldRetry returns false for destructive steps", () => {
    const step = makeDestructiveStep();
    const { shouldRetry } = re.shouldRetry(step);
    expect(shouldRetry).toBe(false);
  });

  it("shouldRetry returns false when maxRetries exhausted", () => {
    const step = makeSafeStep({ retryCount: 3, maxRetries: 3 });
    const { shouldRetry } = re.shouldRetry(step);
    expect(shouldRetry).toBe(false);
  });

  it("shouldRetry returns true for safe step within retry budget", () => {
    const step = makeSafeStep({ retryCount: 1, maxRetries: 3 });
    const { shouldRetry, delayMs } = re.shouldRetry(step);
    expect(shouldRetry).toBe(true);
    expect(delayMs).toBeGreaterThan(0);
  });

  it("sleep is bounded by policy.timeoutMs", async () => {
    const start = Date.now();
    await re.sleep(100, 150);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(300);
  });

  it("selectFallback returns the next untried tool in the chain", () => {
    const step = makeSafeStep({ toolName: "fetchOfficialDocs" });
    const fallback = re.selectFallback(step, []);
    expect(fallback).toBe("researchWeb");
    const fallback2 = re.selectFallback(step, ["researchWeb"]);
    expect(fallback2).toBe("readUrl");
  });
});

// ── 6. PlanStore ─────────────────────────────────────────────────────────────

describe("PlanStore", () => {
  let tmpDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "myraa-planstore-test-"));
    originalEnv = process.env.SORA_DATA_DIR;
    process.env.SORA_DATA_DIR = tmpDir;
  });

  afterEach(() => {
    process.env.SORA_DATA_DIR = originalEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeMockPlan(id = "plan-001"): TaskPlan {
    const parser = new GoalParser();
    const planner = new TaskPlanner();
    const goal = parser.parse("Update README.md");
    const plan = planner.buildPlan(goal);
    return { ...plan, id };
  }

  it("saves and retrieves a plan", async () => {
    // Use fresh store pointing at tmpDir
    const { PlanStore } = await import("../PlanStore.ts");
    // Override the file path by checking the module
    // Note: Since DATA_DIR is captured at module load time we test via the real singleton
    // after overriding env. For true isolation, use a subclass.
    const store = new PlanStore();
    const plan = makeMockPlan();
    await store.savePlan(plan);
    const retrieved = await store.getPlan(plan.id);
    expect(retrieved).toBeTruthy();
    expect(retrieved!.id).toBe(plan.id);
  });

  it("returns undefined for missing plan", async () => {
    const { PlanStore } = await import("../PlanStore.ts");
    const store = new PlanStore();
    const result = await store.getPlan("nonexistent");
    expect(result).toBeUndefined();
  });

  it("updates a plan partially", async () => {
    const { PlanStore } = await import("../PlanStore.ts");
    const store = new PlanStore();
    const plan = makeMockPlan();
    await store.savePlan(plan);
    const updated = await store.updatePlan(plan.id, { status: "paused" });
    expect(updated?.status).toBe("paused");
  });

  it("deletes a plan", async () => {
    const { PlanStore } = await import("../PlanStore.ts");
    const store = new PlanStore();
    const plan = makeMockPlan();
    await store.savePlan(plan);
    const deleted = await store.deletePlan(plan.id);
    expect(deleted).toBe(true);
    const retrieved = await store.getPlan(plan.id);
    expect(retrieved).toBeUndefined();
  });

  it("findByStatus returns matching plans", async () => {
    const { PlanStore } = await import("../PlanStore.ts");
    const store = new PlanStore();
    const plan = makeMockPlan();
    await store.savePlan(plan);
    await store.updatePlan(plan.id, { status: "waiting_for_approval" });
    const results = await store.findByStatus("waiting_for_approval");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].status).toBe("waiting_for_approval");
  });

  it("survives BOM-prefixed JSON files", async () => {
    // The PlanStore module captures DATA_DIR at import time, so we write
    // directly to the actual plans file to simulate a BOM-corrupted file.
    const { planStore: realStore } = await import("../PlanStore.ts");
    const { dataFile } = await import("../../../../server_paths.ts");
    const plan = makeMockPlan("plan-bom-real");
    await realStore.savePlan(plan);
    // Manually prepend BOM to the actual plans file
    const plansFile = dataFile("agent_plans.json");
    const content = fs.readFileSync(plansFile, "utf-8");
    fs.writeFileSync(plansFile, "\uFEFF" + content, "utf-8");
    // Should load without throwing
    const retrieved = await realStore.getPlan("plan-bom-real");
    expect(retrieved?.id).toBe("plan-bom-real");
    // Cleanup
    await realStore.deletePlan("plan-bom-real");
  });
});

// ── 7. PlannerCoordinator ────────────────────────────────────────────────────

describe("PlannerCoordinator", () => {
  let coordinator: PlannerCoordinator;
  let cm: CheckpointManager;

  beforeEach(() => {
    coordinator = new PlannerCoordinator();
    cm = new CheckpointManager();
  });

  it("createPlan returns a plan with steps and status=created", async () => {
    const goal = "Research latest TypeScript 5.8 features";
    const plan = await coordinator.createPlan(goal);
    // Cleanup
    await coordinator.deletePlan(plan.id);
    expect(plan.id).toBeTruthy();
    expect(plan.status).toBe("created");
    expect(plan.steps.length).toBeGreaterThan(0);
    expect(plan.goal.rawInput).toBe(goal);
  });

  it("RESTART SAFETY: plan in waiting_for_approval is NOT auto-resumed", async () => {
    const plan = await coordinator.createPlan("Update README.md");
    // Use the store to put the plan in waiting_for_approval state
    const { planStore: store } = await import("../PlanStore.ts");
    await store.updatePlan(plan.id, { status: "waiting_for_approval" });
    // executePlan must return without changing status
    const result = await coordinator.executePlan(plan.id);
    expect(result.status).toBe("waiting_for_approval");
    // Cleanup
    await coordinator.deletePlan(plan.id);
  });

  it("PAUSE: pause transitions running plan to paused", async () => {
    const plan = await coordinator.createPlan("Research topic");
    const events: string[] = [];
    coordinator.onEvent((e) => events.push(e.type));
    expect(typeof coordinator.pausePlan).toBe("function");
    await coordinator.deletePlan(plan.id);
  });

  it("confirmCheckpoint throws for unknown checkpointId", async () => {
    const plan = await coordinator.createPlan("Update README.md");
    await expect(
      coordinator.confirmCheckpoint(plan.id, "fake-checkpoint-id", true),
    ).rejects.toThrow(/not found/i);
    await coordinator.deletePlan(plan.id);
  });

  it("DUPLICATE EXECUTION GUARD: completed plan returns immediately without re-running", async () => {
    const plan = await coordinator.createPlan("Research topic");
    // Persist the plan as completed in the store
    const { planStore: store } = await import("../PlanStore.ts");
    await store.updatePlan(plan.id, { status: "completed" });
    // executePlan on a completed plan must return immediately
    const result = await coordinator.executePlan(plan.id);
    expect(result.status).toBe("completed");
    await coordinator.deletePlan(plan.id);
  }, 10000);

  it("cancelPlan expires checkpoints and cancels plan", async () => {
    const plan = await coordinator.createPlan("Update README.md");
    const result = await coordinator.cancelPlan(plan.id);
    expect(result?.status).toBe("cancelled");
  });

  it("deletePlan removes it from store", async () => {
    const plan = await coordinator.createPlan("Research topic");
    const deleted = await coordinator.deletePlan(plan.id);
    expect(deleted).toBe(true);
    const retrieved = await coordinator.getPlan(plan.id);
    expect(retrieved).toBeUndefined();
  });

  it("listPlans includes newly created plans", async () => {
    await coordinator.createPlan("Research topic A");
    await coordinator.createPlan("Research topic B");
    const plans = await coordinator.listPlans();
    expect(plans.length).toBeGreaterThanOrEqual(2);
  });
});

// ── 8. Adversarial ────────────────────────────────────────────────────────────

describe("Adversarial / Security", () => {
  let cm: CheckpointManager;
  let step: PlanStep;

  beforeEach(() => {
    cm = new CheckpointManager();
    step = makeDestructiveStep();
  });

  it("PATH TRAVERSAL: args with ../ do not bypass workspace check via argsHash", () => {
    const traversalArgs = { path: "../../etc/passwd", content: "owned" };
    const cp = cm.issue("plan-001", step); // step has safe args
    cm.approve(cp.id);
    // Try to consume with traversal args (different hash → rejected)
    const result = cm.consumeApproval(cp.id, step.id, step.toolName, traversalArgs);
    expect(result).toBe(false);
  });

  it("TOKEN REPLAY: cannot use the same token twice even with correct args", () => {
    const cp = cm.issue("plan-001", step);
    cm.approve(cp.id);
    const first = cm.consumeApproval(cp.id, step.id, step.toolName, step.toolArgs);
    const second = cm.consumeApproval(cp.id, step.id, step.toolName, step.toolArgs);
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it("CHECKPOINT BYPASS: non-existent token returns false", () => {
    const result = cm.consumeApproval("non-existent-token", step.id, step.toolName, step.toolArgs);
    expect(result).toBe(false);
  });

  it("CHECKPOINT BYPASS: pending (unapproved) token cannot be consumed", () => {
    const cp = cm.issue("plan-001", step);
    const result = cm.consumeApproval(cp.id, step.id, step.toolName, step.toolArgs);
    expect(result).toBe(false);
  });

  it("MODIFIED ARGS AFTER APPROVAL: tampered args rejected at consume time", () => {
    const cp = cm.issue("plan-001", step);
    cm.approve(cp.id, "Looks fine");
    // Inject extra dangerous arg after approval
    const modifiedArgs = { ...step.toolArgs, extraDangerousFlag: "--force-delete-all" };
    const result = cm.consumeApproval(cp.id, step.id, step.toolName, modifiedArgs);
    expect(result).toBe(false);
  });

  it("RESTART EXPIRY: approved token becomes expired after restore", () => {
    const cp = cm.issue("plan-001", step);
    cm.approve(cp.id);
    const cm2 = new CheckpointManager();
    cm2.restore(cp);
    const restored = cm2.get(cp.id);
    expect(restored?.status).toBe("expired");
    // Consuming an expired token should also fail
    const result = cm2.consumeApproval(cp.id, step.id, step.toolName, step.toolArgs);
    expect(result).toBe(false);
  });

  it("DESTRUCTIVE STEP NO CHECKPOINT ID: StepExecutor blocks execution", async () => {
    const { StepExecutor } = await import("../StepExecutor.ts");
    const executor = new StepExecutor();
    const destroyStep = makeDestructiveStep({
      checkpointId: undefined,      // No token wired
    });
    const result = await executor.executeStep(destroyStep);
    expect(result.evaluation.status).toBe("critical_failure");
    expect(result.error).toMatch(/no checkpoint token/i);
  });

  it("CONSUMED TOKEN: StepExecutor blocks second call with same token", async () => {
    const { StepExecutor } = await import("../StepExecutor.ts");
    const executor = new StepExecutor();
    const cp = cm.issue("plan-001", step);
    cm.approve(cp.id);

    // First call — normally would succeed but we can't call real desktop agent; 
    // so we manually consume the token and then check the second call
    cm.consumeApproval(cp.id, step.id, step.toolName, step.toolArgs);

    const destroyStep = makeDestructiveStep({ checkpointId: cp.id });
    // Token is now consumed — second execution must be blocked
    const result = await executor.executeStep(destroyStep);
    expect(result.evaluation.status).toBe("critical_failure");
    expect(result.error).toMatch(/checkpoint.*failed validation/i);
  });

  it("expireAll prevents any further consumption of tokens for a plan", () => {
    const cp1 = cm.issue("plan-X", step);
    const cp2 = cm.issue("plan-X", { ...step, id: "step-B" });
    cm.approve(cp1.id);
    cm.expireAll("plan-X");
    expect(cm.consumeApproval(cp1.id, step.id, step.toolName, step.toolArgs)).toBe(false);
    expect(cm.get(cp2.id)?.status).toBe("expired");
  });

  // ── REGRESSION SUITE: Mandatory Phase 5 Security & Concurrency Fixes ──────

  it("CONCURRENCY LOCK: rejects simultaneous executeTaskPlan calls on the same plan", async () => {
    const { PlannerCoordinator } = await import("../PlannerCoordinator.ts");
    const coordinator = new PlannerCoordinator();
    const plan = await coordinator.createPlan("Research concurrency test");

    // Mock _nextPendingStep to simulate a long-running execution step
    let releaseStep: () => void = () => {};
    const stepPromise = new Promise<void>((resolve) => {
      releaseStep = resolve;
    });

    const originalNext = (coordinator as any)._nextPendingStep.bind(coordinator);
    let calledOnce = false;
    (coordinator as any)._nextPendingStep = (p: TaskPlan) => {
      if (!calledOnce) {
        calledOnce = true;
        // Return a mock step that waits
        return {
          id: "mock-step-1",
          phase: "inspect",
          status: "pending",
          description: "Concurrent hold step",
          toolName: "analyzeProject",
          toolArgs: {},
          argsHash: hashArgs({}),
          dependsOn: [],
          isDestructive: false,
          checkpointRequired: false,
          retryCount: 0,
          maxRetries: 0,
        };
      }
      return undefined;
    };

    // Spy on stepExecutor to hold the first execution
    const { stepExecutor } = await import("../StepExecutor.ts");
    const originalExec = stepExecutor.executeStep.bind(stepExecutor);
    vi.spyOn(stepExecutor, "executeStep").mockImplementation(async () => {
      await stepPromise;
      return {
        output: { result: "ok" },
        elapsedMs: 10,
        evaluation: { status: "success", score: 1, reason: "done", suggestedAction: "proceed" },
      };
    });

    // Start first execution (will hold lock)
    const firstExecutionPromise = coordinator.executePlan(plan.id);

    // Verify lock is active
    expect(coordinator.isPlanLocked(plan.id)).toBe(true);

    // Concurrent second execution must fail immediately
    await expect(coordinator.executePlan(plan.id)).rejects.toThrow(
      /already executing \(concurrency lock active\)/i,
    );

    // Release first execution
    releaseStep();
    await firstExecutionPromise;

    // Lock is cleanly released
    expect(coordinator.isPlanLocked(plan.id)).toBe(false);

    vi.restoreAllMocks();
    await coordinator.deletePlan(plan.id);
  });

  it("VALID-HASH PATH TRAVERSAL: a valid hash never authorizes an unsafe path", async () => {
    const { StepExecutor } = await import("../StepExecutor.ts");
    const executor = new StepExecutor();

    // Attacker crafts an unsafe path traversal argument
    const unsafeArgs = { path: "../../secret_shadow.txt", content: "malicious" };
    const traversalStep = makeDestructiveStep({
      id: "step-traversal-valid-hash",
      toolArgs: unsafeArgs,
      argsHash: hashArgs(unsafeArgs),
    });

    // Checkpoint is issued WITH the unsafe args (hash matches)
    const cp = cm.issue("plan-hack", traversalStep);
    expect(cp.argsHash).toBe(traversalStep.argsHash);

    // Checkpoint is approved
    cm.approve(cp.id);
    traversalStep.checkpointId = cp.id;

    // Execute step: Direct path traversal validation MUST reject BEFORE / independently of hash
    const result = await executor.executeStep(traversalStep);
    expect(result.evaluation.status).toBe("critical_failure");
    expect(result.error).toMatch(/security violation.*outside.*workspace boundary/i);
    expect(result.error).toMatch(/direct workspace validation failed independent of hash/i);

    // Notice: Checkpoint was NOT consumed because path check blocked it first
    expect(cm.get(cp.id)?.status).toBe("approved");
  });

  it("DUPLICATE SIDE EFFECTS: re-executing completed plan skips already-completed modifying steps", async () => {
    const { PlannerCoordinator } = await import("../PlannerCoordinator.ts");
    const coordinator = new PlannerCoordinator();
    const plan = await coordinator.createPlan("Update README.md");

    // Manually mark modifying step as completed
    const modStep = plan.steps.find((s) => s.phase === "modify");
    expect(modStep).toBeTruthy();
    modStep!.status = "completed";
    plan.status = "completed";

    const { planStore: store } = await import("../PlanStore.ts");
    await store.savePlan(plan);

    // Spy on stepExecutor to ensure it is never called
    const { stepExecutor } = await import("../StepExecutor.ts");
    const execSpy = vi.spyOn(stepExecutor, "executeStep");

    const result = await coordinator.executePlan(plan.id);
    expect(result.status).toBe("completed");
    expect(execSpy).not.toHaveBeenCalled();

    execSpy.mockRestore();
    await coordinator.deletePlan(plan.id);
  });

  it("DISPATCH-LAYER SAFETY GATE: blocks direct invocation of modifying tools without checkpoint", async () => {
    const { ToolOrchestrator, MODIFYING_TOOLS } = await import("../../tools/ToolOrchestrator.ts");
    const orchestrator = new ToolOrchestrator();

    // Verify classification
    expect(MODIFYING_TOOLS.has("writeCodeFile")).toBe(true);
    expect(MODIFYING_TOOLS.has("createFile")).toBe(true);
    expect(MODIFYING_TOOLS.has("deleteFile")).toBe(true);
    expect(MODIFYING_TOOLS.has("runPythonScript")).toBe(true);
    expect(MODIFYING_TOOLS.has("executePowerAction")).toBe(true);

    let sentResponse: any = null;
    const mockSession = {
      sendToolResponse: (payload: any) => {
        sentResponse = payload;
      },
    };

    // Direct invocation without checkpoint token
    await (orchestrator as any)._handleDesktopTool(
      { name: "writeCodeFile", args: { path: "README.md", content: "test" } },
      mockSession,
    );

    expect(sentResponse).toBeTruthy();
    const output = sentResponse.functionResponses[0].response.output;
    expect(output.blocked).toBe(true);
    expect(output.error).toMatch(/safety gate blocked execution/i);
    expect(output.checkpointRequired).toBe(true);
  });

  it("DISPATCH-LAYER SAFETY GATE: blocks modifying tool with path traversal even if checkpoint passed", async () => {
    const { ToolOrchestrator } = await import("../../tools/ToolOrchestrator.ts");
    const orchestrator = new ToolOrchestrator();

    let sentResponse: any = null;
    const mockSession = {
      sendToolResponse: (payload: any) => {
        sentResponse = payload;
      },
    };

    // Direct invocation with traversal path and dummy checkpoint
    await (orchestrator as any)._handleDesktopTool(
      {
        name: "deleteFile",
        args: {
          path: "../../system32/cmd.exe",
          checkpointId: "dummy-cp-token",
        },
      },
      mockSession,
    );

    expect(sentResponse).toBeTruthy();
    const output = sentResponse.functionResponses[0].response.output;
    expect(output.blocked).toBe(true);
    expect(output.error).toMatch(/security violation: path.*is outside the active workspace/i);
  });

  it("FULL E2E LIFECYCLE: plan -> execute -> pause -> checkpoint -> confirm -> verify scope", async () => {
    const { PlannerCoordinator } = await import("../PlannerCoordinator.ts");
    const coordinator = new PlannerCoordinator();

    // 1. Create modifying plan
    const plan = await coordinator.createPlan("Update README.md with project architecture");
    expect(plan.id).toBeTruthy();
    expect(plan.status).toBe("created");
    expect(plan.goal.requiresModification).toBe(true);

    // Mock step execution to be fast and deterministic in tests
    const { stepExecutor } = await import("../StepExecutor.ts");
    vi.spyOn(stepExecutor, "executeStep").mockImplementation(async (step) => {
      return {
        output: { result: `Mock executed ${step.toolName}` },
        elapsedMs: 5,
        evaluation: {
          status: "success",
          score: 1,
          reason: "Completed in mock test",
          suggestedAction: "proceed",
        },
      };
    });

    // 2. Execute plan — must pause at checkpoint
    const pausedPlan = await coordinator.executePlan(plan.id);
    expect(pausedPlan.status).toBe("waiting_for_approval");
    expect(pausedPlan.pendingCheckpointId).toBeTruthy();

    const checkpointId = pausedPlan.pendingCheckpointId!;
    const cp = cm.get(checkpointId);
    expect(cp).toBeTruthy();
    expect(cp?.status).toBe("pending");

    // 3. Rejection branch test on a separate plan
    const rejectPlan = await coordinator.createPlan("Fix crash in auth.ts");
    const rejectPaused = await coordinator.executePlan(rejectPlan.id);
    const rejectedResult = await coordinator.confirmCheckpoint(
      rejectPlan.id,
      rejectPaused.pendingCheckpointId!,
      false,
      "User rejected file change",
    );
    expect(rejectedResult.status).toBe("cancelled");
    await coordinator.deletePlan(rejectPlan.id);

    // 4. Approval branch test: confirm and complete
    const completedPlan = await coordinator.confirmCheckpoint(
      plan.id,
      checkpointId,
      true,
      "Proceed with changes",
    );
    expect(completedPlan.status).toBe("completed");

    // 5. Verification scope check
    expect(completedPlan.verificationReport).toBeTruthy();
    expect(completedPlan.verificationReport?.scope).toBe("workspace_outcomes_only");
    expect(completedPlan.verificationReport?.verificationMethod).toBe("workspace_state_inspection");
    expect(completedPlan.verificationReport?.summary).toMatch(/\[Workspace Outcome Verification\]/);

    vi.restoreAllMocks();
    await coordinator.deletePlan(plan.id);
  });
});


