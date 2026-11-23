/**
 * MYRAA — TaskOrchestrator (Stage 10.5)
 *
 * Coordinates multi-step task plans through:
 *   1. Task planning & DAG validation (deterministic dependency ordering, cycle detection, bounded limits)
 *   2. Checkpoint management (durable, trustworthy progress records at safe execution boundaries)
 *   3. Cancellation (prompt propagation, safe stopping boundaries, preventing subsequent dispatches)
 *   4. Safe recovery & resumption (evidence-based resumption, protecting against replaying uncertain side-effects)
 *   5. Project continuity & isolation (canonical projectId ownership, strict cross-project boundary)
 *
 * Architectural & Security Invariants:
 *   - AI = proposal, Security = decision, Firewall = enforcement, Executor = execution, Verifier = evidence
 *   - Does not become a new security authority or alternative tool execution engine.
 *   - Preserves all 129 unique LIVE_TOOLS declarations without modification.
 *   - Emergency Stop and Security Lockdown take immediate priority over all orchestration.
 *   - A plan or checkpoint NEVER grants execution authority.
 *   - Checkpoint records NEVER store credentials, confirmation tokens, or sensitive payloads.
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import type {
  TaskPlan,
  PlanStep,
  PlanStatus,
  StepPhase,
  ExecutionLogEntry,
} from "./PlannerTypes.ts";
import { MODIFYING_TOOLS } from "./PlannerTypes.ts";
import { planStore, PlanStore } from "./PlanStore.ts";
import { checkpointManager } from "./CheckpointManager.ts";
import { stepExecutor } from "./StepExecutor.ts";
import { emergencyStopCoordinator } from "../remote/EmergencyStopCoordinator.ts";
import { securityPolicyEngine } from "../security/SecurityPolicyEngine.ts";
import { runtimeMetrics } from "../diagnostics/RuntimeObservability.ts";
import { sanitizeError, isPathWithinWorkspace } from "../security/PermissionManager.ts";
import type { SecurityContext } from "../security/SecurityTypes.ts";

// ---------------------------------------------------------------------------
// Constants & Established Bounded Limits
// ---------------------------------------------------------------------------

export const MAX_PLAN_STEPS = 50;
export const MAX_DEPENDENCIES_PER_STEP = 20;
export const MAX_DESCRIPTION_LENGTH = 2000;
export const MAX_LOG_ENTRIES = 1000;
export const MAX_CHECKPOINTS = 100;

export const VALID_STEP_PHASES: ReadonlySet<StepPhase> = new Set([
  "understand",
  "inspect",
  "plan",
  "checkpoint",
  "modify",
  "test",
  "verify",
  "report",
]);

export const SENSITIVE_KEY_PATTERN =
  /(token|password|secret|auth|bearer|apikey|api_key|credential|private_key|privatekey|confirmationtoken|checkpointtoken)/i;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskCheckpointBoundaryType =
  | "initial"
  | "pre_dispatch"
  | "post_verification"
  | "paused"
  | "waiting_approval"
  | "completed"
  | "cancelled"
  | "recovery";

export interface TaskCheckpoint {
  /** Unique checkpoint identifier (UUID) */
  id: string;
  /** Owning plan ID */
  planId: string;
  /** Canonical project ID (strictly isolated) */
  projectId?: string;
  /** Monotonically increasing plan version */
  version: number;
  /** Associated step ID at this boundary */
  stepId?: string;
  /** Step phase at boundary */
  stepPhase?: StepPhase;
  /** Boundary classification */
  boundaryType: TaskCheckpointBoundaryType;
  /** IDs of steps verified as completed up to this boundary */
  completedStepIds: string[];
  /** IDs of steps remaining pending */
  pendingStepIds: string[];
  /** Verified step outcomes map (stepId -> metadata) */
  verifiedStepOutcomes: Record<
    string,
    { status: string; verifiedAt: string; argsHash?: string }
  >;
  /** Step ID of the last safe verified boundary */
  lastSafeBoundaryStepId?: string;
  /** Step IDs whose outcomes are uncertain or interrupted */
  uncertainStepIds: string[];
  /** Creation timestamp in ISO 8601 */
  createdAt: string;
  /** Audit correlation ID for traceability */
  auditCorrelationId: string;
}

export interface PlanValidationResult {
  valid: boolean;
  errors: string[];
  warnings?: string[];
  orderedStepIds?: string[];
}

export interface OrchestratedTaskPlan extends TaskPlan {
  /** Monotonic plan version incremented with each durable checkpoint */
  version?: number;
  /** Durable execution progress checkpoints */
  checkpoints?: TaskCheckpoint[];
  /** Steps whose side-effect outcomes could not be deterministically verified */
  uncertainStepIds?: string[];
  /** ISO timestamp when cancellation was accepted */
  cancelledAt?: string;
  /** Reason for cancellation */
  cancellationReason?: string;
}

export interface OrchestrationOptions {
  projectId?: string;
  callerIdentity?: string;
  signal?: AbortSignal;
}

export interface RecoveryOptions {
  projectId?: string;
  callerIdentity?: string;
  callerRole?: string;
  forceReconciliation?: boolean;
  authorizeContinuationSteps?: string[];
  securityContext?: SecurityContext;
}

export interface RecoveryResult {
  recovered: boolean;
  planId: string;
  plan?: OrchestratedTaskPlan;
  lastSafeBoundary?: string;
  unresolvedSteps: string[];
  reason?: string;
}

// ---------------------------------------------------------------------------
// Secret Scrubbing Helper
// ---------------------------------------------------------------------------

/**
 * Deeply scrubs sensitive tokens, passwords, API keys, and credentials
 * from objects before storing them in durable checkpoints.
 */
export function scrubSensitiveData<T>(input: T): T {
  if (input === null || input === undefined) return input;
  if (typeof input === "string") return input;
  if (typeof input !== "object") return input;

  if (Array.isArray(input)) {
    return input.map((item) => scrubSensitiveData(item)) as unknown as T;
  }

  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      cleaned[key] = "[REDACTED]";
    } else if (typeof value === "object" && value !== null) {
      cleaned[key] = scrubSensitiveData(value);
    } else {
      cleaned[key] = value;
    }
  }
  return cleaned as T;
}

// ---------------------------------------------------------------------------
// Step Dependency Safety Evaluator & Authorization Provenance
// ---------------------------------------------------------------------------

export interface ContinuationAuthorization {
  id: string;
  planId: string;
  stepId: string;
  predecessorStepId: string;
  projectId?: string;
  toolName: string;
  authorizedBy: string;
  authorizedRole: "admin";
  authorizedAt: string;
  expiresAt: string;
  signature: string;
}

const CONTINUATION_SECRET = crypto.randomBytes(32).toString("hex");

/**
 * Computes an HMAC-SHA256 signature binding the continuation authorization
 * strictly to its scope (plan, step, predecessor, project, tool, role, time).
 */
export function computeContinuationSignature(
  grant: Omit<ContinuationAuthorization, "signature">,
): string {
  const payload = [
    grant.id,
    grant.planId,
    grant.stepId,
    grant.predecessorStepId,
    grant.projectId || "",
    grant.toolName,
    grant.authorizedBy,
    grant.authorizedRole,
    grant.authorizedAt,
    grant.expiresAt,
  ].join(":");
  return crypto
    .createHmac("sha256", CONTINUATION_SECRET)
    .update(payload)
    .digest("hex");
}

/**
 * Evaluates whether a dependency step is satisfied for a specific dependent step.
 *
 * Enforces strict dependency safety rules:
 *   1. "completed" or "skipped" dependencies are always satisfied.
 *   2. "acknowledged_unverified" dependencies:
 *      - Destructive/modifying steps (isDestructive or in MODIFYING_TOOLS) are BLOCKED
 *        unless backed by an authentic, non-expired ContinuationAuthorization issued by an admin.
 *        Raw properties on step objects (e.g. allowUnverifiedDependency) are NEVER trusted.
 *      - Direct file-reading steps (readFile, readCodeFile) targeting the unverified output file
 *        are BLOCKED if the file does not exist on disk.
 *      - Safe informational, inspect, or report steps are ALLOWED to run after operator acknowledgement.
 *   3. All other dependency statuses (pending, in_progress, failed, outcome_unknown) are NOT satisfied.
 */
export function isStepDependencySatisfied(
  step: PlanStep,
  dep: PlanStep,
  workspaceDir: string = process.env.SORA_WORKSPACE_DIR || process.cwd(),
  plan?: OrchestratedTaskPlan,
): boolean {
  if (dep.status === "completed" || dep.status === "skipped") {
    return true;
  }

  if (dep.status === "acknowledged_unverified") {
    // 1. Destructive step safety: A destructive or modifying step cannot blindly execute
    // on an unverified predecessor without explicit, proven continuation authorization.
    if (step.isDestructive || MODIFYING_TOOLS.has(step.toolName)) {
      if (!TaskOrchestrator.verifyContinuationAuthorization(step, dep, plan)) {
        return false;
      }
    }

    // 2. Direct file-read dependency safety: If step reads the file that dep failed to verify,
    // and the file does not exist on disk, step cannot proceed.
    const depTarget =
      (dep.toolArgs?.path as string) ||
      (dep.toolArgs?.filePath as string) ||
      (dep.toolArgs?.targetFile as string) ||
      undefined;
    const stepTarget =
      (step.toolArgs?.path as string) ||
      (step.toolArgs?.filePath as string) ||
      (step.toolArgs?.targetFile as string) ||
      undefined;

    if (
      depTarget &&
      stepTarget &&
      depTarget === stepTarget &&
      (step.toolName === "readFile" || step.toolName === "readCodeFile")
    ) {
      const absPath = path.isAbsolute(stepTarget)
        ? stepTarget
        : path.resolve(workspaceDir, stepTarget);
      if (!fs.existsSync(absPath)) {
        return false;
      }
    }

    // 3. Safe read-only / report / inspect step after operator acknowledgement: allowed
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// TaskOrchestrator
// ---------------------------------------------------------------------------

export class TaskOrchestrator {
  private _store: PlanStore;
  private _activeAbortControllers = new Map<string, AbortController>();
  private _executionLocks = new Set<string>();
  private static _continuationGrants = new Map<string, ContinuationAuthorization>();

  constructor(store: PlanStore = planStore) {
    this._store = store;
  }

  // -------------------------------------------------------------------------
  // 1. Task Planning & DAG Validation
  // -------------------------------------------------------------------------

  /**
   * Validates a plan's structural integrity, bounded step limits,
   * dependency references, self-dependencies, and acyclicity (DAG cycle detection).
   * Computes a deterministic topological execution order when valid.
   */
  validatePlanGraph(plan: TaskPlan): PlanValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!plan || typeof plan !== "object") {
      return { valid: false, errors: ["Plan object is null or undefined."] };
    }

    if (!plan.id || typeof plan.id !== "string" || !plan.id.trim()) {
      errors.push("Plan is missing a valid non-empty id.");
    }

    if (!Array.isArray(plan.steps) || plan.steps.length === 0) {
      errors.push("Plan must contain at least one step.");
      return { valid: false, errors };
    }

    if (plan.steps.length > MAX_PLAN_STEPS) {
      errors.push(
        `Plan step count (${plan.steps.length}) exceeds maximum bounded limit of ${MAX_PLAN_STEPS}.`,
      );
    }

    const stepIdSet = new Set<string>();
    const graph = new Map<string, string[]>(); // stepId -> dependencies (dependsOn)
    const reverseGraph = new Map<string, string[]>(); // depId -> dependent steps

    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      if (!step || typeof step !== "object") {
        errors.push(`Step at index ${i} is malformed or not an object.`);
        continue;
      }

      // Security boundary: untrusted plan data cannot inject continuation permissions
      if ("allowUnverifiedDependency" in step) {
        delete (step as any).allowUnverifiedDependency;
      }

      if (!step.id || typeof step.id !== "string" || !step.id.trim()) {
        errors.push(`Step at index ${i} is missing a valid string id.`);
        continue;
      }

      if (stepIdSet.has(step.id)) {
        errors.push(`Duplicate step ID detected: '${step.id}'.`);
      }
      stepIdSet.add(step.id);

      if (!VALID_STEP_PHASES.has(step.phase)) {
        errors.push(`Step '${step.id}' has invalid phase '${step.phase}'.`);
      }

      if (!step.toolName || typeof step.toolName !== "string" || !step.toolName.trim()) {
        errors.push(`Step '${step.id}' is missing a valid toolName.`);
      }

      if (step.description && step.description.length > MAX_DESCRIPTION_LENGTH) {
        errors.push(
          `Step '${step.id}' description exceeds maximum length of ${MAX_DESCRIPTION_LENGTH} characters.`,
        );
      }

      if (!Array.isArray(step.dependsOn)) {
        errors.push(`Step '${step.id}' dependsOn must be an array.`);
        graph.set(step.id, []);
      } else {
        if (step.dependsOn.length > MAX_DEPENDENCIES_PER_STEP) {
          errors.push(
            `Step '${step.id}' has ${step.dependsOn.length} dependencies, exceeding maximum limit of ${MAX_DEPENDENCIES_PER_STEP}.`,
          );
        }
        graph.set(step.id, [...step.dependsOn]);
      }
    }

    // Reference validation & self-dependency check
    for (const [stepId, deps] of graph.entries()) {
      for (const depId of deps) {
        if (!stepIdSet.has(depId)) {
          errors.push(
            `Step '${stepId}' references non-existent dependency step ID '${depId}'.`,
          );
        }
        if (depId === stepId) {
          errors.push(`Step '${stepId}' cannot depend on itself (self-dependency detected).`);
        }
      }
    }

    // Stop early if graph construction has reference errors
    if (errors.length > 0) {
      return { valid: false, errors, warnings };
    }

    // Cycle detection via Depth-First Search (DFS) with 3-color marking
    // 0: unvisited, 1: visiting (in stack), 2: visited
    const state = new Map<string, number>();
    for (const stepId of stepIdSet) {
      state.set(stepId, 0);
    }

    let cycleFound = false;
    const cyclePath: string[] = [];

    const dfs = (node: string, pathStack: string[]): boolean => {
      state.set(node, 1);
      pathStack.push(node);

      const deps = graph.get(node) || [];
      for (const dep of deps) {
        const depState = state.get(dep);
        if (depState === 1) {
          // Found back-edge -> cycle
          cycleFound = true;
          const cycleStartIndex = pathStack.indexOf(dep);
          const cycleNodes = pathStack.slice(cycleStartIndex).concat([dep]);
          errors.push(
            `Dependency cycle detected: ${cycleNodes.join(" -> ")}.`,
          );
          return true;
        }
        if (depState === 0) {
          if (dfs(dep, pathStack)) return true;
        }
      }

      pathStack.pop();
      state.set(node, 2);
      return false;
    };

    for (const stepId of stepIdSet) {
      if (state.get(stepId) === 0) {
        if (dfs(stepId, [])) break;
      }
    }

    if (cycleFound) {
      return { valid: false, errors, warnings };
    }

    // Deterministic Topological Sort (Kahn's Algorithm with index tie-breaking)
    const inDegree = new Map<string, number>();
    for (const stepId of stepIdSet) {
      inDegree.set(stepId, 0);
      reverseGraph.set(stepId, []);
    }

    for (const [stepId, deps] of graph.entries()) {
      inDegree.set(stepId, deps.length);
      for (const depId of deps) {
        const rev = reverseGraph.get(depId) || [];
        rev.push(stepId);
        reverseGraph.set(depId, rev);
      }
    }

    // Initial ready queue (in-degree 0) sorted by original step index for determinism
    const originalIndexMap = new Map<string, number>();
    plan.steps.forEach((s, idx) => originalIndexMap.set(s.id, idx));

    const readyQueue: string[] = [];
    for (const [stepId, deg] of inDegree.entries()) {
      if (deg === 0) readyQueue.push(stepId);
    }
    readyQueue.sort(
      (a, b) => (originalIndexMap.get(a) ?? 0) - (originalIndexMap.get(b) ?? 0),
    );

    const orderedStepIds: string[] = [];
    while (readyQueue.length > 0) {
      const current = readyQueue.shift()!;
      orderedStepIds.push(current);

      const dependents = reverseGraph.get(current) || [];
      for (const dep of dependents) {
        const deg = (inDegree.get(dep) || 1) - 1;
        inDegree.set(dep, deg);
        if (deg === 0) {
          readyQueue.push(dep);
          readyQueue.sort(
            (a, b) =>
              (originalIndexMap.get(a) ?? 0) - (originalIndexMap.get(b) ?? 0),
          );
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      orderedStepIds,
    };
  }

  // -------------------------------------------------------------------------
  // 2. Lifecycle State Machine
  // -------------------------------------------------------------------------

  /**
   * Validates whether a proposed plan status transition is strictly allowed.
   */
  validateTransition(
    currentStatus: PlanStatus,
    targetStatus: PlanStatus,
  ): { allowed: boolean; reason?: string } {
    if (currentStatus === targetStatus) {
      return { allowed: true };
    }

    const transitions: Record<PlanStatus, ReadonlySet<PlanStatus>> = {
      created: new Set(["running", "cancelled"]),
      running: new Set([
        "waiting_for_approval",
        "paused",
        "verifying",
        "completed",
        "failed",
        "cancelled",
        "outcome_unknown",
        "recovery_required",
      ]),
      waiting_for_approval: new Set(["running", "paused", "cancelled"]),
      paused: new Set(["running", "cancelled", "recovery_required"]),
      verifying: new Set([
        "completed",
        "failed",
        "cancelled",
        "outcome_unknown",
        "recovery_required",
      ]),
      recovery_required: new Set(["running", "paused", "failed", "cancelled"]),
      outcome_unknown: new Set([
        "recovery_required",
        "failed",
        "cancelled",
        "paused",
      ]),
      completed: new Set([]), // Strictly terminal
      failed: new Set(["running", "recovery_required", "paused"]), // Only via explicit safe recovery
      cancelled: new Set([]), // Strictly terminal
    };

    const allowedTargets = transitions[currentStatus] || new Set();
    if (!allowedTargets.has(targetStatus)) {
      return {
        allowed: false,
        reason: `INVALID_LIFECYCLE_TRANSITION: Plan cannot transition from '${currentStatus}' to '${targetStatus}'.`,
      };
    }

    return { allowed: true };
  }

  /**
   * Transitions a plan to a target status with strict validation and log record.
   */
  transitionPlan(plan: OrchestratedTaskPlan, targetStatus: PlanStatus): void {
    const check = this.validateTransition(plan.status, targetStatus);
    if (!check.allowed) {
      throw new Error(check.reason);
    }
    plan.status = targetStatus;
    plan.updatedAt = new Date().toISOString();
  }

  // -------------------------------------------------------------------------
  // 3. Checkpoint Management
  // -------------------------------------------------------------------------

  /**
   * Captures a durable, trustworthy execution checkpoint at a safe boundary.
   * Monotonically increments plan version and strips any credentials/tokens.
   */
  createCheckpoint(
    plan: OrchestratedTaskPlan,
    options?: {
      stepId?: string;
      boundaryType?: TaskCheckpointBoundaryType;
      correlationId?: string;
    },
  ): TaskCheckpoint {
    const nextVersion = (plan.version ?? 0) + 1;
    plan.version = nextVersion;

    const completedStepIds = plan.steps
      .filter((s) => s.status === "completed")
      .map((s) => s.id);

    const pendingStepIds = plan.steps
      .filter((s) => s.status === "pending" || s.status === "waiting_for_approval")
      .map((s) => s.id);

    const verifiedStepOutcomes: Record<
      string,
      { status: string; verifiedAt: string; argsHash?: string }
    > = {};

    for (const step of plan.steps) {
      if (step.status === "completed") {
        verifiedStepOutcomes[step.id] = {
          status: "completed",
          verifiedAt: step.completedAt || new Date().toISOString(),
          argsHash: step.argsHash,
        };
      }
    }

    const lastSafeBoundaryStepId =
      completedStepIds.length > 0
        ? completedStepIds[completedStepIds.length - 1]
        : undefined;

    const uncertainStepIds = Array.isArray(plan.uncertainStepIds)
      ? [...plan.uncertainStepIds]
      : [];

    const checkpoint: TaskCheckpoint = {
      id: crypto.randomUUID(),
      planId: plan.id,
      projectId: plan.projectId,
      version: nextVersion,
      stepId: options?.stepId,
      stepPhase: options?.stepId
        ? plan.steps.find((s) => s.id === options.stepId)?.phase
        : undefined,
      boundaryType: options?.boundaryType || "pre_dispatch",
      completedStepIds,
      pendingStepIds,
      verifiedStepOutcomes,
      lastSafeBoundaryStepId,
      uncertainStepIds,
      createdAt: new Date().toISOString(),
      auditCorrelationId: options?.correlationId || crypto.randomUUID(),
    };

    // Scrub any sensitive data before persisting
    const scrubbed = scrubSensitiveData(checkpoint);

    if (!Array.isArray(plan.checkpoints)) {
      plan.checkpoints = [];
    }
    plan.checkpoints.push(scrubbed);

    // Keep bounded history
    if (plan.checkpoints.length > MAX_CHECKPOINTS) {
      plan.checkpoints.splice(0, plan.checkpoints.length - MAX_CHECKPOINTS);
    }

    return scrubbed;
  }

  /**
   * Verifies the structural integrity and project isolation of a checkpoint.
   */
  validateCheckpointIntegrity(
    plan: OrchestratedTaskPlan,
    checkpoint: TaskCheckpoint,
  ): { valid: boolean; reason?: string } {
    if (!checkpoint || typeof checkpoint !== "object") {
      return { valid: false, reason: "Checkpoint record is null or malformed." };
    }

    if (checkpoint.planId !== plan.id) {
      return {
        valid: false,
        reason: `CHECKPOINT_PLAN_MISMATCH: Checkpoint belongs to plan '${checkpoint.planId}', not '${plan.id}'.`,
      };
    }

    // Strict project isolation
    if (plan.projectId !== undefined && plan.projectId !== null) {
      if (checkpoint.projectId !== plan.projectId) {
        return {
          valid: false,
          reason: `CROSS_PROJECT_CHECKPOINT_MISMATCH: Checkpoint projectId '${checkpoint.projectId}' does not match plan canonical projectId '${plan.projectId}'.`,
        };
      }
    } else if (checkpoint.projectId !== undefined && checkpoint.projectId !== null) {
      return {
        valid: false,
        reason: `UNSCOPED_PLAN_CHECKPOINT_MISMATCH: Checkpoint claims projectId '${checkpoint.projectId}' but plan is unscoped.`,
      };
    }

    if (typeof checkpoint.version !== "number" || checkpoint.version <= 0) {
      return { valid: false, reason: "Checkpoint version must be a positive integer." };
    }

    const stepIdSet = new Set(plan.steps.map((s) => s.id));
    for (const compId of checkpoint.completedStepIds) {
      if (!stepIdSet.has(compId)) {
        return {
          valid: false,
          reason: `Checkpoint references completed step '${compId}' which does not exist in plan.`,
        };
      }
    }

    return { valid: true };
  }

  // -------------------------------------------------------------------------
  // 4. Cancellation & Safe Stopping
  // -------------------------------------------------------------------------

  /**
   * Cancels a plan. Signals abort to active executions, halts further step dispatch,
   * captures an uncertain boundary for in-flight destructive steps, expires pending
   * confirmation tokens, and enforces cancellation terminality.
   */
  async cancelTask(
    planId: string,
    reason = "Cancelled by user",
    options?: { projectId?: string },
  ): Promise<OrchestratedTaskPlan> {
    if (emergencyStopCoordinator.isActive()) {
      // Emergency Stop takes priority
      console.warn("[TaskOrchestrator] Emergency Stop active during cancellation request.");
    }

    const plan = (await this._store.getPlan(planId)) as OrchestratedTaskPlan | undefined;
    if (!plan) {
      throw new Error(`Plan '${planId}' not found.`);
    }

    // Project isolation check
    if (options?.projectId) {
      if (plan.projectId !== options.projectId) {
        throw new Error(
          `CROSS_PROJECT_ACCESS_DENIED: Plan belongs to project '${plan.projectId}', caller specified '${options.projectId}'.`,
        );
      }
    }

    // Cancellation is strictly terminal
    if (plan.status === "cancelled") {
      return plan;
    }

    if (plan.status === "completed") {
      throw new Error(`Cannot cancel plan '${planId}' because it has already completed.`);
    }

    // Propagate abort signal to in-flight executions
    const controller = this._activeAbortControllers.get(planId);
    if (controller) {
      controller.abort();
      this._activeAbortControllers.delete(planId);
    }

    // Interrupted in-flight steps must be evaluated safely
    if (plan.activeStepId) {
      const activeStep = plan.steps.find((s) => s.id === plan.activeStepId);
      if (activeStep && activeStep.status === "in_progress") {
        const isModifying =
          activeStep.isDestructive || MODIFYING_TOOLS.has(activeStep.toolName);
        if (isModifying) {
          // Destructive step was interrupted: outcome is uncertain!
          if (!Array.isArray(plan.uncertainStepIds)) {
            plan.uncertainStepIds = [];
          }
          if (!plan.uncertainStepIds.includes(activeStep.id)) {
            plan.uncertainStepIds.push(activeStep.id);
          }
          activeStep.status = "failed";
          activeStep.verificationStatus = "outcome_unknown";
          activeStep.result = {
            output: null,
            elapsedMs: 0,
            error: "INTERRUPTED_BY_CANCELLATION: Modifying step interrupted in-flight; outcome is uncertain.",
            evaluation: {
              status: "critical_failure",
              score: 0,
              reason: "Cancelled while modifying step in-flight",
              suggestedAction: "abort",
            },
          };
        } else {
          // Safe step: mark skipped
          activeStep.status = "skipped";
        }
      }
    }

    // Expire all pending confirmation tokens and continuation grants immediately
    checkpointManager.expireAll(planId);
    this.revokeContinuationGrants(planId);
    delete plan.pendingCheckpointId;

    // Transition to terminal cancelled status
    this.transitionPlan(plan, "cancelled");
    plan.cancelledAt = new Date().toISOString();
    plan.cancellationReason = reason;

    // Capture final cancellation checkpoint
    this.createCheckpoint(plan, {
      boundaryType: "cancelled",
    });

    await this._store.savePlan(plan);
    return plan;
  }

  // -------------------------------------------------------------------------
  // 5. Safe Recovery & Resumption
  // -------------------------------------------------------------------------

  /**
   * Resumes or reconciles a plan from its last verified checkpoint.
   * Enforces:
   *   - Emergency Stop / Security Lockdown precedence (recovery rejected if active)
   *   - Strict project isolation (Project A plans cannot be recovered by Project B)
   *   - Terminal state protection (cancelled or completed plans cannot be recovered)
   *   - In-flight interrupted destructive steps are flagged as uncertain and NOT replayed automatically
   *   - Reconciles step states to a verified safe boundary
   *   - Invalidation of expired or consumed confirmation tokens
   */
  async recoverPlan(
    planId: string,
    options?: RecoveryOptions,
  ): Promise<RecoveryResult> {
    runtimeMetrics.incrementCounter("task_recovery_attempted_total");
    if (emergencyStopCoordinator.isActive()) {
      return {
        recovered: false,
        planId,
        unresolvedSteps: [],
        reason:
          "EMERGENCY_STOP_ACTIVE: Cannot recover task plans while Emergency Stop is active.",
      };
    }

    if (securityPolicyEngine.getMode() === "LOCKDOWN") {
      return {
        recovered: false,
        planId,
        unresolvedSteps: [],
        reason:
          "SECURITY_LOCKDOWN_ACTIVE: Cannot recover task plans during Security Lockdown.",
      };
    }

    const plan = (await this._store.getPlan(planId)) as OrchestratedTaskPlan | undefined;
    if (!plan) {
      return {
        recovered: false,
        planId,
        unresolvedSteps: [],
        reason: `PLAN_NOT_FOUND: Plan '${planId}' does not exist.`,
      };
    }

    // Strict project isolation check
    if (options?.projectId !== undefined && options?.projectId !== null) {
      if (plan.projectId !== options.projectId) {
        return {
          recovered: false,
          planId,
          unresolvedSteps: [],
          reason: `CROSS_PROJECT_RECOVERY_DENIED: Plan belongs to project '${plan.projectId}', caller requested '${options.projectId}'.`,
        };
      }
    }

    // Terminal states cannot be recovered
    if (plan.status === "cancelled") {
      return {
        recovered: false,
        planId,
        unresolvedSteps: [],
        reason:
          "CANNOT_RECOVER_CANCELLED_PLAN: Plan was cancelled and cannot be resumed or recovered.",
      };
    }

    if (plan.status === "completed") {
      return {
        recovered: false,
        planId,
        unresolvedSteps: [],
        reason:
          "PLAN_ALREADY_COMPLETED: Plan has already successfully completed all steps.",
      };
    }

    // Locate latest checkpoint
    const checkpoints = plan.checkpoints || [];
    let latestCheckpoint: TaskCheckpoint | undefined =
      checkpoints.length > 0 ? checkpoints[checkpoints.length - 1] : undefined;

    if (latestCheckpoint) {
      const integrity = this.validateCheckpointIntegrity(plan, latestCheckpoint);
      if (!integrity.valid) {
        return {
          recovered: false,
          planId,
          unresolvedSteps: [],
          reason: `CHECKPOINT_INTEGRITY_COMPROMISED: ${integrity.reason}`,
        };
      }
    }

    // Reconcile step states
    if (!Array.isArray(plan.uncertainStepIds)) {
      plan.uncertainStepIds = [];
    }

    for (const step of plan.steps) {
      if (step.status === "in_progress") {
        const isModifying =
          step.isDestructive || MODIFYING_TOOLS.has(step.toolName);
        if (isModifying) {
          // Destructive step was interrupted: side-effect outcome is UNCERTAIN!
          if (!plan.uncertainStepIds.includes(step.id)) {
            plan.uncertainStepIds.push(step.id);
          }
          step.status = "failed";
          step.verificationStatus = "outcome_unknown";
          step.result = {
            output: null,
            elapsedMs: 0,
            error:
              "INTERRUPTED_UNCERTAIN_OUTCOME: Modifying step was interrupted in-flight; side-effect outcome is uncertain.",
            evaluation: {
              status: "critical_failure",
              score: 0,
              reason: "Interrupted in-flight destructive step",
              suggestedAction: "abort",
            },
          };
        } else {
          // Non-destructive step: safe to reset to pending
          step.status = "pending";
          step.verificationStatus = undefined;
          delete step.startedAt;
        }
      }
    }

    // Invalidate stale or expired confirmation tokens
    if (plan.pendingCheckpointId) {
      const cp = checkpointManager.get(plan.pendingCheckpointId);
      if (!cp || cp.status !== "pending") {
        delete plan.pendingCheckpointId;
      }
    }

    // If uncertain steps exist and forceReconciliation is not explicitly requested:
    // Safe recovery establishes the boundary but halts before dispatching uncertain work
    if (plan.uncertainStepIds.length > 0 && !options?.forceReconciliation) {
      plan.status = "paused";
      const recoveryCheckpoint = this.createCheckpoint(plan, {
        boundaryType: "recovery",
      });
      await this._store.savePlan(plan);
      return {
        recovered: true,
        planId,
        plan,
        lastSafeBoundary: latestCheckpoint?.lastSafeBoundaryStepId,
        unresolvedSteps: [...plan.uncertainStepIds],
        reason: `UNCERTAIN_STEPS_REQUIRE_RECONCILIATION: Step(s) [${plan.uncertainStepIds.join(
          ", ",
        )}] were interrupted and require user reconciliation before proceeding.`,
      };
    }

    // If caller provided explicit reconciliation: inspect real-world postconditions
    if (options?.forceReconciliation && plan.uncertainStepIds.length > 0) {
      const workspaceDir = process.env.SORA_WORKSPACE_DIR || process.cwd();
      const reconciledBy = options.callerIdentity || "operator";
      const nowIso = new Date().toISOString();

      for (const stepId of plan.uncertainStepIds) {
        const step = plan.steps.find((s) => s.id === stepId);
        if (!step) continue;

        // Check for inspectable filesystem postcondition
        const candidatePaths: string[] = [];
        if (typeof step.toolArgs?.path === "string") candidatePaths.push(step.toolArgs.path);
        if (typeof step.toolArgs?.filePath === "string") candidatePaths.push(step.toolArgs.filePath);
        if (typeof step.toolArgs?.targetFile === "string") candidatePaths.push(step.toolArgs.targetFile);
        if (Array.isArray(step.toolArgs?.files)) {
          for (const f of step.toolArgs.files) {
            if (typeof f === "string") candidatePaths.push(f);
          }
        }
        if (Array.isArray(step.toolArgs?.paths)) {
          for (const p of step.toolArgs.paths) {
            if (typeof p === "string") candidatePaths.push(p);
          }
        }
        if (Array.isArray(step.toolArgs?.targetFiles)) {
          for (const tf of step.toolArgs.targetFiles) {
            if (typeof tf === "string") candidatePaths.push(tf);
          }
        }

        let verifiedByEnv = false;
        let envEvidence = "";

        if (candidatePaths.length > 0) {
          const checks: { path: string; verified: boolean; reason: string }[] = [];
          const stepReferenceTime = new Date(step.startedAt || plan.createdAt).getTime();

          for (const targetPath of candidatePaths) {
            // 1. Workspace Boundary Check (Path Traversal defense)
            if (!isPathWithinWorkspace(targetPath, workspaceDir)) {
              checks.push({
                path: targetPath,
                verified: false,
                reason: `Target path '${targetPath}' is outside the authorized project workspace boundary.`,
              });
              continue;
            }

            try {
              const absPath = path.isAbsolute(targetPath)
                ? targetPath
                : path.resolve(workspaceDir, targetPath);

              // 2. Existence check
              if (!fs.existsSync(absPath)) {
                checks.push({
                  path: targetPath,
                  verified: false,
                  reason: `Target file '${targetPath}' does not exist on disk.`,
                });
                continue;
              }

              const stat = fs.statSync(absPath);

              // 3. Non-empty check
              if (stat.size === 0) {
                checks.push({
                  path: targetPath,
                  verified: false,
                  reason: `Target file '${targetPath}' exists but is empty (0 bytes).`,
                });
                continue;
              }

              // 4. Stale file check (mtime must not predate step execution by more than 1 second clock resolution)
              if (stepReferenceTime > 0 && stat.mtimeMs < stepReferenceTime - 1000) {
                checks.push({
                  path: targetPath,
                  verified: false,
                  reason: `Target file '${targetPath}' mtime (${new Date(stat.mtimeMs).toISOString()}) predates step execution (${new Date(stepReferenceTime).toISOString()}); stale artifact detected.`,
                });
                continue;
              }

              // 5. Expected Content check (if content was specified in toolArgs)
              if (typeof step.toolArgs?.content === "string") {
                const actualContent = fs.readFileSync(absPath, "utf-8");
                if (!actualContent.includes(step.toolArgs.content)) {
                  checks.push({
                    path: targetPath,
                    verified: false,
                    reason: `Target file '${targetPath}' exists, but content does not match expected payload.`,
                  });
                  continue;
                }
              }

              checks.push({
                path: targetPath,
                verified: true,
                reason: `Verified on disk: ${targetPath} (size: ${stat.size} bytes, mtime: ${new Date(stat.mtimeMs).toISOString()})`,
              });
            } catch (e: any) {
              checks.push({
                path: targetPath,
                verified: false,
                reason: `Filesystem error inspecting '${targetPath}': ${e?.message || "error"}`,
              });
            }
          }

          // All candidate paths must verify
          const allVerified = checks.length > 0 && checks.every((c) => c.verified);
          if (allVerified) {
            verifiedByEnv = true;
            envEvidence = `Environmental inspection verified ${checks.length} target file(s): ${checks.map((c) => c.reason).join("; ")}`;
          } else {
            verifiedByEnv = false;
            envEvidence = `Environmental inspection failed: ${checks.filter((c) => !c.verified).map((c) => c.reason).join("; ")}`;
          }
        }

        if (verifiedByEnv) {
          step.status = "completed";
          step.verificationStatus = "verified_success";
          step.observedState = envEvidence;
          step.reconciliation = {
            reconciledAt: nowIso,
            reconciledBy,
            mode: "environmental_verified",
            notes: "Postcondition verified by filesystem inspection.",
            observedState: envEvidence,
          };
        } else {
          step.status = "acknowledged_unverified";
          step.verificationStatus = "acknowledged_unverified";
          step.observedState =
            envEvidence ||
            `Environmental inspection could not verify postcondition for tool '${step.toolName}'. Operator acknowledged uncertainty.`;
          step.reconciliation = {
            reconciledAt: nowIso,
            reconciledBy,
            mode: "operator_acknowledged",
            notes:
              "Operator acknowledged uncertainty to unblock plan. Real-world postcondition remains unverified.",
            observedState: step.observedState,
          };
        }
      }

      plan.uncertainStepIds = [];
    }

    // Process explicit continuation authorizations if requested by operator
    if (options?.authorizeContinuationSteps && options.authorizeContinuationSteps.length > 0) {
      const isOperator =
        options.callerRole === "admin" ||
        options.securityContext?.role === "admin";
      if (!isOperator) {
        return {
          recovered: false,
          planId,
          unresolvedSteps: [...plan.uncertainStepIds],
          reason:
            "CROSS_ROLE_AUTHORIZATION_DENIED: Only an authenticated admin can authorize continuation on unverified dependencies.",
        };
      }

      for (const stepId of options.authorizeContinuationSteps) {
        const step = plan.steps.find((s) => s.id === stepId);
        if (!step) continue;
        for (const depId of step.dependsOn) {
          const dep = plan.steps.find((s) => s.id === depId);
          if (
            dep &&
            (dep.status === "acknowledged_unverified" ||
              dep.status === "outcome_unknown" ||
              dep.status === "failed")
          ) {
            this.grantContinuationAuthorization(
              options.securityContext || {
                identityId: options.callerIdentity || "admin",
                role: "admin",
                ipAddress: "127.0.0.1",
                isLocal: true,
              },
              plan,
              step.id,
              dep.id,
            );
          }
        }
      }
    }

    // Plan safely transitioned to paused at clean recovery boundary
    plan.status = "paused";
    this.createCheckpoint(plan, {
      boundaryType: "recovery",
    });
    await this._store.savePlan(plan);

    runtimeMetrics.incrementCounter("task_recovery_success_total");
    return {
      recovered: true,
      planId,
      plan,
      lastSafeBoundary: latestCheckpoint?.lastSafeBoundaryStepId,
      unresolvedSteps: [],
    };
  }

  // -------------------------------------------------------------------------
  // 6. Step Selection & Execution Helper
  // -------------------------------------------------------------------------

  /**
   * Deterministically finds the next executable step whose dependencies
   * are all completed or skipped.
   */
  getNextExecutableStep(plan: OrchestratedTaskPlan): PlanStep | undefined {
    const validation = this.validatePlanGraph(plan);
    if (!validation.valid || !validation.orderedStepIds) {
      return undefined;
    }

    const workspaceDir = process.env.SORA_WORKSPACE_DIR || process.cwd();

    for (const stepId of validation.orderedStepIds) {
      const step = plan.steps.find((s) => s.id === stepId);
      if (!step || step.status !== "pending") continue;

      const allDepsSatisfied = step.dependsOn.every((depId) => {
        const dep = plan.steps.find((s) => s.id === depId);
        return dep && isStepDependencySatisfied(step, dep, workspaceDir, plan);
      });

      if (allDepsSatisfied) {
        return step;
      }
    }
    return undefined;
  }

  // -------------------------------------------------------------------------
  // 7. Continuation Authorization Provenance (Phase 11.3.2)
  // -------------------------------------------------------------------------

  /**
   * Issues a cryptographically signed, time-bounded continuation authorization
   * permitting a specific downstream step to proceed on an unverified predecessor.
   *
   * STRICT SECURITY INVARIANTS:
   *   1. Only authenticated operators with role === "admin" can grant continuation.
   *   2. Rejected if Emergency Stop is active or SecurityPolicyEngine is in LOCKDOWN mode.
   *   3. Scoped strictly to (planId, stepId, predecessorStepId, projectId, toolName).
   *   4. Time-bounded with a strict TTL (default 10 minutes, max 60 minutes).
   *   5. Signed with an HMAC signature computed using CONTINUATION_SECRET.
   *   6. Logged to the plan's executionLog for audit provenance.
   *   7. DOES NOT grant execution authority: StepExecutor still enforces CheckpointManager approval.
   */
  grantContinuationAuthorization(
    context: SecurityContext,
    plan: OrchestratedTaskPlan,
    stepId: string,
    predecessorStepId: string,
    options?: { ttlMs?: number; projectId?: string },
  ): ContinuationAuthorization {
    if (emergencyStopCoordinator.isActive()) {
      throw new Error(
        "EMERGENCY_STOP_ACTIVE: Cannot grant continuation while emergency stop is active.",
      );
    }
    if (securityPolicyEngine.getMode() === "LOCKDOWN") {
      throw new Error(
        "SECURITY_LOCKDOWN: Cannot grant continuation while system is in LOCKDOWN mode.",
      );
    }

    if (!context || context.role !== "admin") {
      throw new Error(
        `CROSS_ROLE_AUTHORIZATION_DENIED: Only an authenticated admin can authorize continuation on unverified dependencies (caller role: '${context?.role || "unknown"}').`,
      );
    }

    if (!plan || !plan.id) {
      throw new Error("INVALID_PLAN: Plan is required to issue continuation authorization.");
    }

    const step = plan.steps.find((s) => s.id === stepId);
    if (!step) {
      throw new Error(`STEP_NOT_FOUND: Step '${stepId}' not found in plan '${plan.id}'.`);
    }

    const dep = plan.steps.find((s) => s.id === predecessorStepId);
    if (!dep) {
      throw new Error(
        `DEPENDENCY_NOT_FOUND: Dependency step '${predecessorStepId}' not found in plan '${plan.id}'.`,
      );
    }

    if (!step.dependsOn.includes(predecessorStepId)) {
      throw new Error(
        `INVALID_DEPENDENCY_RELATION: Step '${stepId}' does not declare dependency on '${predecessorStepId}'.`,
      );
    }

    // Verify project isolation: caller-provided projectId must match plan projectId
    const effectiveProjectId = options?.projectId || plan.projectId;
    if (plan.projectId && effectiveProjectId && plan.projectId !== effectiveProjectId) {
      throw new Error(
        `CROSS_PROJECT_VIOLATION: Cannot authorize continuation for project '${effectiveProjectId}' on plan belonging to project '${plan.projectId}'.`,
      );
    }

    const ttlMs = Math.min(Math.max(options?.ttlMs ?? 10 * 60 * 1000, 1000), 60 * 60 * 1000);
    const now = new Date();
    const authorizedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();

    const grantId = `cont_${crypto.randomBytes(8).toString("hex")}`;
    const unsignedGrant = {
      id: grantId,
      planId: plan.id,
      stepId: step.id,
      predecessorStepId: dep.id,
      projectId: effectiveProjectId,
      toolName: step.toolName,
      authorizedBy: context.identityId,
      authorizedRole: "admin" as const,
      authorizedAt,
      expiresAt,
    };

    const signature = computeContinuationSignature(unsignedGrant);
    const grant: ContinuationAuthorization = {
      ...unsignedGrant,
      signature,
    };

    const grantKey = `${plan.id}:${step.id}:${dep.id}`;
    TaskOrchestrator._continuationGrants.set(grantKey, grant);

    plan.executionLog.push({
      timestamp: authorizedAt,
      stepId: step.id,
      phase: "verify",
      level: "info",
      message: `continuation_authorized: Operator '${context.identityId}' (admin) granted continuation on unverified predecessor '${dep.id}' for step '${step.id}' (grantId: ${grantId}, expires: ${expiresAt}).`,
    });

    return grant;
  }

  /**
   * Static implementation of continuation verification across all orchestrator instances.
   */
  static verifyContinuationAuthorization(
    step: PlanStep,
    dep: PlanStep,
    plan?: OrchestratedTaskPlan,
  ): boolean {
    if (!plan || !plan.id || !step || !dep) {
      return false;
    }

    if (
      emergencyStopCoordinator.isActive() ||
      securityPolicyEngine.getMode() === "LOCKDOWN"
    ) {
      return false;
    }

    const grantKey = `${plan.id}:${step.id}:${dep.id}`;
    const grant = TaskOrchestrator._continuationGrants.get(grantKey);
    if (!grant) {
      return false;
    }

    // Check scope bindings
    if (
      grant.planId !== plan.id ||
      grant.stepId !== step.id ||
      grant.predecessorStepId !== dep.id ||
      grant.toolName !== step.toolName
    ) {
      return false;
    }

    // Check project isolation
    if (plan.projectId && grant.projectId && plan.projectId !== grant.projectId) {
      return false;
    }

    // Check role authority
    if (grant.authorizedRole !== "admin") {
      return false;
    }

    // Check TTL expiration
    const expiresMs = new Date(grant.expiresAt).getTime();
    if (isNaN(expiresMs) || Date.now() >= expiresMs) {
      // Expired: prune grant and fail closed
      TaskOrchestrator._continuationGrants.delete(grantKey);
      return false;
    }

    // Verify cryptographic signature integrity
    const expectedSig = computeContinuationSignature({
      id: grant.id,
      planId: grant.planId,
      stepId: grant.stepId,
      predecessorStepId: grant.predecessorStepId,
      projectId: grant.projectId,
      toolName: grant.toolName,
      authorizedBy: grant.authorizedBy,
      authorizedRole: grant.authorizedRole,
      authorizedAt: grant.authorizedAt,
      expiresAt: grant.expiresAt,
    });

    if (grant.signature !== expectedSig) {
      // Signature mismatch / tampering detected: fail closed
      return false;
    }

    return true;
  }

  /**
   * Instance method delegating to static verification.
   */
  verifyContinuationAuthorization(
    step: PlanStep,
    dep: PlanStep,
    plan?: OrchestratedTaskPlan,
  ): boolean {
    return TaskOrchestrator.verifyContinuationAuthorization(step, dep, plan);
  }

  /**
   * Revokes all active continuation grants for the specified plan ID.
   * Invoked upon cancellation, plan completion, or plan failure.
   */
  revokeContinuationGrants(planId: string): void {
    if (!planId) return;
    for (const [key, grant] of TaskOrchestrator._continuationGrants.entries()) {
      if (grant.planId === planId) {
        TaskOrchestrator._continuationGrants.delete(key);
      }
    }
  }

  /**
   * Test helper to clear in-memory continuation grants.
   */
  clearContinuationGrantsForTesting(): void {
    TaskOrchestrator._continuationGrants.clear();
  }

  static clearContinuationGrantsForTesting(): void {
    TaskOrchestrator._continuationGrants.clear();
  }

  /**
   * Notifies the orchestrator of an emergency stop trigger.
   */
  emergencyStop(): void {
    for (const [planId, controller] of this._activeAbortControllers.entries()) {
      controller.abort();
    }
    this._activeAbortControllers.clear();
    this._executionLocks.clear();
    TaskOrchestrator._continuationGrants.clear();
  }
}

/** Module-level singleton instance */
export const taskOrchestrator = new TaskOrchestrator();
