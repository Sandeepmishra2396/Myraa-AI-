/**
 * MYRAA — PlannerCoordinator (Phase 5)
 *
 * Master singleton that runs the Agent Planner execution loop.
 *
 * Responsibilities:
 *   - Create, persist, and retrieve task plans.
 *   - Drive the step execution loop (step-by-step, respecting dependencies).
 *   - Issue and validate confirmation checkpoints for destructive steps.
 *   - Handle pause / resume with state persistence.
 *   - Run CompletionVerifier after the verify phase.
 *   - Enforce restart safety: plans that were `waiting_for_approval` at restart
 *     must NOT auto-resume; they stay blocked until fresh user confirmation.
 *   - Emit structured event updates via an optional callback.
 *
 * CRITICAL RULES (enforced here AND in StepExecutor):
 *   1. Destructive steps NEVER execute without a consumed, valid checkpoint.
 *   2. Plans do NOT auto-resume destructive steps after server restart.
 *   3. Sentinel step "_checkpoint" transitions plan to `waiting_for_approval`
 *      and issues a Checkpoint — it does not call any external tool.
 *   4. Sentinel step "_report" compiles and returns the final report.
 *   5. All errors are sanitized before exposure.
 */

import crypto from "crypto";
import type {
  TaskPlan,
  PlanStep,
  PlanStatus,
  ExecutionLogEntry,
  StepPhase,
  VerificationReport,
  ImpactLevel,
} from "./PlannerTypes.ts";
import { goalParser } from "./GoalParser.ts";
import { taskPlanner } from "./TaskPlanner.ts";
import { planStore } from "./PlanStore.ts";
import { checkpointManager } from "./CheckpointManager.ts";
import { stepExecutor } from "./StepExecutor.ts";
import { resultEvaluator } from "./ResultEvaluator.ts";
import { recoveryEngine } from "./RecoveryEngine.ts";
import { completionVerifier } from "./CompletionVerifier.ts";
import { emergencyStopCoordinator } from "../remote/EmergencyStopCoordinator.ts";
import { sanitizeError } from "../security/PermissionManager.ts";
import { contentSanitizer } from "../security/ContentSanitizer.ts";
import { securityPolicyEngine } from "../security/SecurityPolicyEngine.ts";
import { projectStore } from "../projects/ProjectStore.ts";
import {
  taskOrchestrator,
  isStepDependencySatisfied,
  type OrchestratedTaskPlan,
  type RecoveryResult,
  type RecoveryOptions,
  type PlanValidationResult,
} from "./TaskOrchestrator.ts";

// ---------------------------------------------------------------------------
// Stage 10.3 P2: Shared Canonical Project Identity Resolution
// ---------------------------------------------------------------------------

export type CanonicalProjectResolution =
  | { status: "omitted" }
  | { status: "resolved"; projectId: string }
  | { status: "unauthorized"; reason: string }
  | { status: "invalid"; reason: string };

const AUTHORIZED_PLAN_PROJECT_ROLES = new Set(["admin", "standard"]);

/**
 * Shared canonical project-identity resolver for all plan-creation paths
 * (HTTP API, AI/Tool orchestrator, Mobile workflows, and PlannerCoordinator).
 *
 * Security & Isolation Guarantees:
 *   1. Omitted (`undefined` / `null`) returns `{ status: "omitted" }` — NEVER
 *      infers ownership from global `ProjectStore.activeProjectId` or project ordering.
 *   2. Rejects non-string, empty, control-char, oversized, or prompt-injection inputs.
 *   3. When `secContext` or `requireAuthorizedContext` is supplied, requires a valid
 *      non-empty `identityId` and write-capable role (`admin` or `standard`).
 *   4. Validates exact canonical `project.id` match against `projectStore` (rejects
 *      filesystem path strings such as `"."` or unknown IDs; never falls back to
 *      another project).
 */
export async function resolveCanonicalProjectId(
  requestedProjectId: unknown,
  options?: {
    secContext?: {
      identityId?: string;
      role?: string;
      sessionId?: string;
      isLocal?: boolean;
    };
    requireAuthorizedContext?: boolean;
  },
): Promise<CanonicalProjectResolution> {
  if (requestedProjectId === undefined || requestedProjectId === null) {
    return { status: "omitted" };
  }

  if (options?.requireAuthorizedContext || options?.secContext !== undefined) {
    const ctx = options?.secContext;
    const identityId = typeof ctx?.identityId === "string" ? ctx.identityId.trim() : "";
    const role = typeof ctx?.role === "string" ? ctx.role.trim().toLowerCase() : "";
    if (!identityId || !AUTHORIZED_PLAN_PROJECT_ROLES.has(role)) {
      return {
        status: "unauthorized",
        reason: `Caller role '${role || "unauthenticated"}' is not authorized to associate a plan with a project.`,
      };
    }
  }

  if (typeof requestedProjectId !== "string") {
    return { status: "invalid", reason: "Project ID must be a non-empty string." };
  }

  const trimmed = requestedProjectId.trim();
  if (!trimmed) {
    return { status: "invalid", reason: "Project ID cannot be empty." };
  }
  if (trimmed.length > 200 || /[\r\n\0]/.test(trimmed)) {
    return { status: "invalid", reason: "Project ID contains invalid characters or exceeds maximum length." };
  }

  const scan = contentSanitizer.scanForPromptInjection(trimmed, {
    source: "planner_projectId",
  });
  if (scan.hasInjectionAttempt) {
    return { status: "invalid", reason: "Project ID rejected by security scanner." };
  }

  try {
    const proj = await projectStore.getProject(trimmed);
    // Require strict canonical ID equality so relative paths (e.g. ".") or rootPath
    // strings cannot accidentally resolve to an unintended project.
    if (!proj || proj.id !== trimmed) {
      return { status: "invalid", reason: `Project '${trimmed}' was not found.` };
    }
    return { status: "resolved", projectId: proj.id };
  } catch {
    return { status: "invalid", reason: "Project store unavailable for canonical project validation." };
  }
}

// ---------------------------------------------------------------------------
// Event types for real-time client updates
// ---------------------------------------------------------------------------

export interface PlannerEvent {
  type:
    | "plan_created"
    | "step_started"
    | "step_completed"
    | "step_failed"
    | "checkpoint_issued"
    | "checkpoint_resolved"
    | "plan_paused"
    | "plan_resumed"
    | "plan_completed"
    | "plan_failed"
    | "plan_cancelled";
  planId: string;
  stepId?: string;
  checkpointId?: string;
  message: string;
  data?: unknown;
  timestamp: string;
}

export type PlannerEventCallback = (event: PlannerEvent) => void;

// ---------------------------------------------------------------------------
// PlannerCoordinator
// ---------------------------------------------------------------------------

export class PlannerCoordinator {
  private _eventCallbacks: PlannerEventCallback[] = [];
  private _executionLocks = new Set<string>();

  /** Register a callback to receive real-time planner events. */
  onEvent(cb: PlannerEventCallback): void {
    this._eventCallbacks.push(cb);
  }

  /** Check if a plan currently has an active execution lock. */
  isPlanLocked(planId: string): boolean {
    return this._executionLocks.has(planId);
  }

  private _emit(event: Omit<PlannerEvent, "timestamp">): void {
    const full: PlannerEvent = { ...event, timestamp: new Date().toISOString() };
    for (const cb of this._eventCallbacks) {
      try { cb(full); } catch { /* event callback errors must not crash the loop */ }
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Parse `rawGoal` into a Goal, build a TaskPlan, persist it, and return
   * the plan (NOT yet executing — caller must call `executePlan(planId)`).
   *
   * @param options.projectId  Optional canonical project ID (Stage 10.3 P2).
   *   MUST be a pre-validated server-side ID; callers are responsible for
   *   verifying project existence and caller authorization before passing it.
   *   When present, this method performs a final existence re-check against
   *   ProjectStore — if the project no longer exists the plan is created without
   *   a projectId rather than attaching to an unknown or wrong project.
   *   Never infer project identity from active-project ordering.
   */
  async createPlan(
    rawGoal: string,
    options?: { deviceId?: string; preferredLanguage?: string; projectId?: string },
  ): Promise<TaskPlan> {
    if (emergencyStopCoordinator.isActive()) {
      throw new Error("EMERGENCY_STOP_ACTIVE: Cannot create new task plans while emergency stop is active. Reset emergency stop first.");
    }

    // ── Stage 10.3 P2: Canonical project identity validation ───────────────
    // Validate BEFORE building & persisting the plan so only a verified canonical
    // project ID propagates into TaskPlanner and PlanStore.
    // Never infer project ownership from global active-project state or ordering.
    // Invalid/unknown project IDs are never silently converted to another project.
    let canonicalProjectId: string | undefined;
    if (options?.projectId !== undefined && options?.projectId !== null) {
      const resolution = await resolveCanonicalProjectId(options.projectId);
      if (resolution.status === "resolved") {
        canonicalProjectId = resolution.projectId;
      }
      // Unknown/invalid project ID → plan remains unscoped (fail-closed isolation).
    }

    const goal = goalParser.parse(rawGoal);
    const plan = taskPlanner.buildPlan(goal, {
      deviceId: options?.deviceId,
      preferredLanguage: options?.preferredLanguage,
      ...(canonicalProjectId ? { projectId: canonicalProjectId } : {}),
    });
    if (options?.deviceId) plan.deviceId = options.deviceId;
    if (options?.preferredLanguage) plan.preferredLanguage = options.preferredLanguage;
    if (canonicalProjectId) {
      plan.projectId = canonicalProjectId;
    } else {
      delete plan.projectId;
    }

    // Stage 10.5: Validate plan graph structure & DAG limits
    const validation = taskOrchestrator.validatePlanGraph(plan);
    if (!validation.valid) {
      throw new Error(`PLAN_VALIDATION_FAILED: ${validation.errors.join("; ")}`);
    }

    // Stage 10.5: Capture durable initial checkpoint
    taskOrchestrator.createCheckpoint(plan as OrchestratedTaskPlan, { boundaryType: "initial" });

    await planStore.savePlan(plan);
    this._emit({ type: "plan_created", planId: plan.id, message: `Plan created: ${goal.objective}`, data: { stepCount: plan.steps.length, projectId: plan.projectId } });
    return plan;
  }

  /** Return a plan by ID. */
  async getPlan(planId: string): Promise<TaskPlan | undefined> {
    return planStore.getPlan(planId);
  }

  /** Return all plans ordered by createdAt descending. */
  async listPlans(): Promise<TaskPlan[]> {
    return planStore.listPlans();
  }

  /**
   * Delete a plan by ID.
   * Cancels any pending checkpoints for the plan before deletion.
   */
  async deletePlan(planId: string): Promise<boolean> {
    this._executionLocks.delete(planId);
    checkpointManager.expireAll(planId);
    return planStore.deletePlan(planId);
  }

  /** Halt all active plans immediately when an Emergency Stop is triggered. */
  async emergencyStop(): Promise<void> {
    this._executionLocks.clear();
    taskOrchestrator.emergencyStop();
    const plans = await planStore.listPlans();
    for (const plan of plans) {
      if (plan.status === "running") {
        plan.status = "paused";
        this._log(plan, "plan", "warn", "Plan halted immediately due to EMERGENCY STOP.");
        await planStore.savePlan(plan);
        this._emit({ type: "plan_paused", planId: plan.id, message: "EMERGENCY STOP: Plan execution halted." });
      }
    }
  }

  /**
   * Execute a plan from its current state.
   * - Plans in `waiting_for_approval` are returned immediately (checkpoint required).
   * - Plans in `paused` resume from the next pending step.
   * - After restart, plans that were `waiting_for_approval` remain blocked.
   * - Concurrency lock prevents simultaneous execution of the same plan.
   */
  async executePlan(
    planId: string,
    options?: { projectId?: string },
  ): Promise<TaskPlan> {
    if (emergencyStopCoordinator.isActive()) {
      throw new Error("EMERGENCY_STOP_ACTIVE: Cannot execute task plans while emergency stop is active. Reset emergency stop first.");
    }
    if (securityPolicyEngine.getMode() === "LOCKDOWN") {
      throw new Error("SECURITY_LOCKDOWN_ACTIVE: Cannot execute task plans during security lockdown.");
    }
    if (this._executionLocks.has(planId)) {
      throw new Error(
        `Plan '${planId}' is already executing (concurrency lock active). Concurrent execution is prohibited.`,
      );
    }

    this._executionLocks.add(planId);
    try {
      let plan = await planStore.getPlan(planId);
      if (!plan) throw new Error(`Plan '${planId}' not found.`);

      // Stage 10.5 Project Isolation check
      if (options?.projectId !== undefined && options?.projectId !== null) {
        if (plan.projectId !== options.projectId) {
          throw new Error(
            `CROSS_PROJECT_ACCESS_DENIED: Plan belongs to project '${plan.projectId}', caller requested '${options.projectId}'.`,
          );
        }
      }

      // RESTART SAFETY: do not auto-resume plans awaiting approval
      if (plan.status === "waiting_for_approval") {
        this._log(plan, "plan", "warn", "Plan is waiting_for_approval — cannot auto-resume. User must confirm the checkpoint.");
        await planStore.savePlan(plan);
        return plan;
      }
      if (plan.status === "completed" || plan.status === "failed" || plan.status === "cancelled") {
        return plan;
      }

      // Transition to running
      plan.status = "running";
      plan.startedAt = plan.startedAt || new Date().toISOString();
      await planStore.savePlan(plan);
      this._emit({ type: "plan_resumed", planId, message: "Plan execution started." });

      // ── Execution loop ───────────────────────────────────────────────────
      while (true) {
        // Check if plan was paused or cancelled externally
        const freshPlan = await planStore.getPlan(planId);
        if (freshPlan?.status === "paused" || freshPlan?.status === "cancelled") {
          this._log(plan, "report", "info", `Plan execution stopped because status is '${freshPlan.status}'.`);
          plan.status = freshPlan.status;
          break;
        }
      const nextStep = this._nextPendingStep(plan);
      if (!nextStep) {
        // No more pending steps eligible to execute
        const hasPending = plan.steps.some((s) => s.status === "pending");
        const hasUnresolved = plan.steps.some(
          (s) => s.status === "failed" || s.status === "outcome_unknown",
        );
        if (hasPending || hasUnresolved) {
          plan.status = "failed";
          this._log(
            plan,
            "report",
            "warn",
            hasPending
              ? "Execution halted: pending steps blocked by unsatisfied dependencies."
              : "Execution halted: some steps failed or have unknown outcomes.",
          );
        } else {
          // Mandatory Completion Verification Gate:
          if (plan.status === "running") {
            taskOrchestrator.transitionPlan(plan as OrchestratedTaskPlan, "verifying");
          }
          if (!plan.verificationReport) {
            plan.verificationReport = completionVerifier.verify(plan);
          }
          taskOrchestrator.transitionPlan(plan as OrchestratedTaskPlan, "completed");
          plan.completedAt = new Date().toISOString();
          this._log(plan, "report", "info", "All steps completed.");
          taskOrchestrator.createCheckpoint(plan as OrchestratedTaskPlan, {
            boundaryType: "completed",
          });
          this._emit({ type: "plan_completed", planId, message: "Plan completed successfully." });
        }
        await planStore.savePlan(plan);
        break;
      }

      plan.activeStepId = nextStep.id;
      nextStep.status = "in_progress";
      nextStep.startedAt = new Date().toISOString();
      this._log(plan, nextStep.phase, "info", `Starting step: ${nextStep.description}`);
      this._emit({ type: "step_started", planId, stepId: nextStep.id, message: nextStep.description });
      await planStore.savePlan(plan);

      // ── Sentinel: _checkpoint ───────────────────────────────────────────
      if (nextStep.toolName === "_checkpoint") {
        plan = await this._issueCheckpointForStep(plan, nextStep);
        if (plan.status === "waiting_for_approval") break;
        // If somehow already resolved, continue
        continue;
      }

      // ── Sentinel: _report ───────────────────────────────────────────────
      if (nextStep.toolName === "_report") {
        plan = await this._generateReport(plan, nextStep);
        continue;
      }

      // ── Normal step execution ─────────────────────────────────────────
      const result = await stepExecutor.executeStep(nextStep);
      nextStep.result = result;
      nextStep.completedAt = new Date().toISOString();

      if (result.evaluation.status === "critical_failure" || result.evaluation.suggestedAction === "abort") {
        nextStep.status = "failed";
        nextStep.verificationStatus = "verified_failure";
        plan.status = "failed";
        const errMsg = sanitizeError(result.error || result.evaluation.reason);
        this._log(plan, nextStep.phase, "error", `Step failed: ${errMsg}`);
        this._emit({ type: "step_failed", planId, stepId: nextStep.id, message: errMsg });
        await planStore.savePlan(plan);
        break;
      }

      nextStep.status = "completed";
      nextStep.verificationStatus = "verified_success";
      if (result.evaluation.suggestedAction === "retry" && !nextStep.isDestructive) {
        nextStep.retryCount++;
      }

      // Track artifacts
      if (nextStep.phase === "modify" && nextStep.toolArgs.path) {
        const p = nextStep.toolArgs.path as string;
        if (!plan.artifacts.includes(p)) plan.artifacts.push(p);
        nextStep.observedState = `Modified/created workspace path '${p}'.`;
      }

      this._log(plan, nextStep.phase, "info", `Step completed: ${nextStep.description}`);
      this._emit({ type: "step_completed", planId, stepId: nextStep.id, message: `Completed: ${nextStep.description}` });

      // Stage 10.5: Capture durable post-verification checkpoint
      taskOrchestrator.createCheckpoint(plan as OrchestratedTaskPlan, {
        stepId: nextStep.id,
        boundaryType: "post_verification",
      });

      await planStore.savePlan(plan);
    }

    return plan;
    } finally {
      this._executionLocks.delete(planId);
    }
  }

  /**
   * Pause an actively running plan.
   * Sets status to `paused` and persists. The next call to `executePlan` will
   * resume from the next pending step.
   */
  async pausePlan(planId: string): Promise<TaskPlan> {
    const plan = await planStore.getPlan(planId);
    if (!plan) throw new Error(`Plan '${planId}' not found.`);
    if (plan.status !== "running") return plan;

    plan.status = "paused";
    this._log(plan, "report", "info", "Plan paused by user.");
    await planStore.savePlan(plan);
    this._emit({ type: "plan_paused", planId, message: "Plan paused." });
    return plan;
  }

  /**
   * Resume a paused plan (does NOT auto-resume `waiting_for_approval` plans).
   */
  async resumePlan(planId: string): Promise<TaskPlan> {
    const plan = await planStore.getPlan(planId);
    if (!plan) throw new Error(`Plan '${planId}' not found.`);
    if (plan.status === "waiting_for_approval") {
      throw new Error("Plan is waiting for checkpoint approval — call confirmCheckpoint() first.");
    }
    if (plan.status !== "paused") return plan;
    return this.executePlan(planId);
  }

  /**
   * Cancel a plan. Delegates to TaskOrchestrator to ensure prompt
   * cancellation, safe stopping boundary, and terminal state preservation.
   */
  async cancelPlan(
    planId: string,
    reason = "Plan cancelled by user",
    options?: { projectId?: string },
  ): Promise<TaskPlan | undefined> {
    const existing = await planStore.getPlan(planId);
    if (!existing) return undefined;
    try {
      const plan = await taskOrchestrator.cancelTask(planId, reason, options);
      this._emit({ type: "plan_cancelled", planId, message: `Plan cancelled: ${reason}` });
      return plan;
    } catch (err: any) {
      if (err?.message?.includes("not found")) return undefined;
      throw err;
    }
  }

  /**
   * Recover a plan from its latest verified checkpoint.
   * Reconciles step states, protects against replaying uncertain side effects,
   * enforces strict project isolation, and restores safe continuation boundaries.
   */
  async recoverPlan(planId: string, options?: RecoveryOptions): Promise<RecoveryResult> {
    return taskOrchestrator.recoverPlan(planId, options);
  }

  /**
   * Validate a plan structure and dependency DAG using TaskOrchestrator.
   */
  validatePlan(plan: TaskPlan): PlanValidationResult {
    return taskOrchestrator.validatePlanGraph(plan);
  }

  /**
   * Approve a checkpoint and resume plan execution.
   *
   * Security: validates that the checkpoint belongs to this plan and is pending.
   * After approval the step's `checkpointId` is set so StepExecutor can
   * consume it when it executes the next destructive step.
   */
  async confirmCheckpoint(
    planId: string,
    checkpointId: string,
    approved: boolean,
    userFeedback?: string,
  ): Promise<TaskPlan> {
    let plan = await planStore.getPlan(planId);
    if (!plan) throw new Error(`Plan '${planId}' not found.`);

    const cp = checkpointManager.get(checkpointId);
    if (!cp) throw new Error(`Checkpoint '${checkpointId}' not found.`);
    if (cp.planId !== planId) throw new Error("Checkpoint does not belong to this plan.");
    if (cp.status !== "pending") throw new Error(`Checkpoint is already in status '${cp.status}'.`);

    if (approved) {
      checkpointManager.approve(checkpointId, userFeedback);
      this._log(plan, "checkpoint", "info", `Checkpoint '${checkpointId}' approved by user.`);
      this._emit({ type: "checkpoint_resolved", planId, checkpointId, message: "Checkpoint approved — resuming plan." });

      // Wire the checkpoint ID into the next destructive step so StepExecutor can consume it
      const checkpointStep =
        plan.steps.find((s) => s.toolName === "_checkpoint" && s.checkpointId === checkpointId) ??
        plan.steps.find((s) => s.checkpointId === checkpointId);
      const modifyStep = plan.steps.find(
        (s) => s.phase === "modify" && s.status === "pending" && (checkpointStep ? s.dependsOn.includes(checkpointStep.id) : false),
      );
      if (modifyStep) {
        modifyStep.checkpointId = checkpointId;
      }

      // Mark the sentinel checkpoint step as completed
      if (checkpointStep) checkpointStep.status = "completed";

      plan.status = "running";
      plan.pendingCheckpointId = undefined;
      await planStore.savePlan(plan);

      // Continue execution
      plan = await this.executePlan(planId);
    } else {
      checkpointManager.reject(checkpointId, userFeedback);
      this._log(plan, "checkpoint", "warn", `Checkpoint '${checkpointId}' rejected — plan cancelled.`);
      this._emit({ type: "checkpoint_resolved", planId, checkpointId, message: "Checkpoint rejected — plan cancelled." });
      plan.status = "cancelled";
      plan.pendingCheckpointId = undefined;
      await planStore.savePlan(plan);
    }

    return plan;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Find the next step that is `pending` and has all dependencies completed.
   * Returns undefined when no more eligible steps exist.
   */
  private _nextPendingStep(plan: TaskPlan): PlanStep | undefined {
    const workspaceDir = process.env.SORA_WORKSPACE_DIR || process.cwd();
    for (const step of plan.steps) {
      if (step.status !== "pending") continue;
      const allDepsDone = step.dependsOn.every((depId) => {
        const dep = plan.steps.find((s) => s.id === depId);
        return dep && isStepDependencySatisfied(step, dep, workspaceDir, plan as any);
      });
      if (allDepsDone) return step;
    }
    return undefined;
  }

  /**
   * Issue a confirmation checkpoint for the sentinel `_checkpoint` step.
   * Transitions plan to `waiting_for_approval`.
   */
  private async _issueCheckpointForStep(plan: TaskPlan, step: PlanStep): Promise<TaskPlan> {
    // Determine the first downstream destructive step
    const destroyStep = plan.steps.find(
      (s) => s.phase === "modify" && s.isDestructive && s.dependsOn.includes(step.id),
    );

    const impactLevel: ImpactLevel =
      destroyStep?.phase === "modify" ? "high" : "medium";

    const checkpointStep = destroyStep ?? step;
    const cp = checkpointManager.issue(plan.id, {
      ...checkpointStep,
      id: destroyStep?.id ?? step.id,
      toolName: destroyStep?.toolName ?? "_checkpoint",
      toolArgs: destroyStep?.toolArgs ?? {},
      argsHash: destroyStep?.argsHash ?? "",
      description: step.description,
    }, impactLevel);

    // Wire checkpoint ID into sentinel step and the downstream modify step
    step.checkpointId = cp.id;
    step.status = "waiting_for_approval";
    if (destroyStep) {
      destroyStep.checkpointId = cp.id;
    }

    plan.status = "waiting_for_approval";
    plan.pendingCheckpointId = cp.id;

    this._log(plan, "checkpoint", "warn",
      `Awaiting approval for: ${step.description}. Checkpoint ID: ${cp.id}`);
    this._emit({
      type: "checkpoint_issued",
      planId: plan.id,
      stepId: step.id,
      checkpointId: cp.id,
      message: step.description,
      data: {
        proposedAction: cp.proposedAction,
        impactLevel: cp.impactLevel,
        expiresAt: cp.expiresAt,
      },
    });

    await planStore.savePlan(plan);
    return plan;
  }

  /**
   * Generate and attach the final VerificationReport for the sentinel `_report` step.
   */
  private async _generateReport(plan: TaskPlan, step: PlanStep): Promise<TaskPlan> {
    // Run verify phase
    const verifyStep = plan.steps.find((s) => s.phase === "verify");
    if (verifyStep && verifyStep.status !== "completed") {
      const vResult = await stepExecutor.executeStep(verifyStep);
      verifyStep.result = vResult;
      verifyStep.status = vResult.evaluation.status === "critical_failure" ? "failed" : "completed";
      verifyStep.completedAt = new Date().toISOString();
    }

    const report = completionVerifier.verify(plan);
    plan.verificationReport = report;

    step.status = "completed";
    step.completedAt = new Date().toISOString();
    step.result = {
      output: report,
      elapsedMs: 0,
      evaluation: {
        status: report.verified ? "success" : "partial",
        score: report.score,
        reason: report.summary,
        suggestedAction: "proceed",
      },
    };

    this._log(plan, "report", "info", report.summary);
    await planStore.savePlan(plan);
    return plan;
  }

  private _log(plan: TaskPlan, phase: StepPhase | "plan" | "checkpoint" | "report", level: "info" | "warn" | "error", message: string): void {
    const entry: ExecutionLogEntry = {
      timestamp: new Date().toISOString(),
      stepId: plan.activeStepId ?? "coordinator",
      phase: phase as StepPhase,
      message,
      level,
    };
    plan.executionLog.push(entry);
    if (level === "error") {
      console.error(`[Planner][${phase}] ${message}`);
    } else {
      console.log(`[Planner][${phase}] ${message}`);
    }
  }
}

/** Module-level singleton. */
export const plannerCoordinator = new PlannerCoordinator();
