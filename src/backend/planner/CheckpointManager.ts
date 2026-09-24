/**
 * MYRAA — CheckpointManager (Phase 5)
 *
 * Issues one-time, expiring confirmation tokens for destructive or
 * file-modifying plan steps.  No destructive step may execute until its
 * associated Checkpoint is in status `approved`.
 *
 * Security guarantees:
 *   1. Tokens are cryptographically random UUIDs — not guessable.
 *   2. Each token is tied to (planId + stepId + toolName + argsHash).
 *      If any of those values differ at execution time → rejected.
 *   3. Tokens become `consumed` immediately on first use (no replay).
 *   4. Tokens expire after CHECKPOINT_TTL_MS (default 10 minutes).
 *   5. A `rejected` or `expired` or `consumed` token may NEVER be reused.
 *   6. No bypass path exists: StepExecutor calls `consumeApproval()` and
 *      must receive `true` before invoking any destructive tool.
 */

import crypto from "crypto";
import type { Checkpoint, ImpactLevel, PlanStep } from "./PlannerTypes.ts";

/** Token lifetime: 10 minutes. */
const CHECKPOINT_TTL_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hashArgs(toolArgs: Record<string, unknown>): string {
  const serialised = JSON.stringify(toolArgs, Object.keys(toolArgs).sort());
  return crypto.createHash("sha256").update(serialised).digest("hex");
}

function isExpired(cp: Checkpoint): boolean {
  return Date.now() > new Date(cp.expiresAt).getTime();
}

// ---------------------------------------------------------------------------
// CheckpointManager
// ---------------------------------------------------------------------------

/**
 * In-process store for pending checkpoints.
 * The coordinator also persists them inside TaskPlan.pendingCheckpointId;
 * this Map is the runtime authority.
 */
const _checkpoints = new Map<string, Checkpoint>();

export class CheckpointManager {
  /**
   * Issue a new checkpoint token for the given step.
   * The step must have `checkpointRequired: true` and `isDestructive: true`.
   *
   * Returns the Checkpoint so the coordinator can persist its ID in the plan.
   */
  issue(
    planId: string,
    step: PlanStep,
    impactLevel: ImpactLevel = "high",
  ): Checkpoint {
    const id = crypto.randomUUID();
    const argsSnapshot = JSON.stringify(step.toolArgs, Object.keys(step.toolArgs).sort());
    const argsHash = hashArgs(step.toolArgs);

    const cp: Checkpoint = {
      id,
      planId,
      stepId: step.id,
      toolName: step.toolName,
      argsSnapshot,
      argsHash,
      proposedAction: step.description,
      impactLevel,
      status: "pending",
      expiresAt: new Date(Date.now() + CHECKPOINT_TTL_MS).toISOString(),
      createdAt: new Date().toISOString(),
    };

    _checkpoints.set(id, cp);
    return cp;
  }

  /**
   * Approve a checkpoint by ID.
   * Validates:
   *   - Token exists.
   *   - Token is in `pending` state.
   *   - Token has not expired.
   *
   * Returns the approved Checkpoint on success, throws on any violation.
   * Status is set to `approved` (NOT yet `consumed` — that happens in consumeApproval).
   */
  approve(checkpointId: string, userFeedback?: string): Checkpoint {
    const cp = _checkpoints.get(checkpointId);
    if (!cp) throw new Error(`Checkpoint '${checkpointId}' not found.`);
    if (cp.status !== "pending") {
      throw new Error(`Checkpoint '${checkpointId}' is in status '${cp.status}' — cannot approve.`);
    }
    if (isExpired(cp)) {
      cp.status = "expired";
      _checkpoints.set(checkpointId, cp);
      throw new Error(`Checkpoint '${checkpointId}' has expired (TTL exceeded).`);
    }

    cp.status = "approved";
    cp.userFeedback = userFeedback;
    cp.resolvedAt = new Date().toISOString();
    _checkpoints.set(checkpointId, cp);
    return cp;
  }

  /**
   * Reject a checkpoint by ID.
   * Validates that the token is pending and not expired.
   */
  reject(checkpointId: string, reason?: string): Checkpoint {
    const cp = _checkpoints.get(checkpointId);
    if (!cp) throw new Error(`Checkpoint '${checkpointId}' not found.`);
    if (cp.status !== "pending") {
      throw new Error(`Checkpoint '${checkpointId}' is in status '${cp.status}' — cannot reject.`);
    }

    cp.status = "rejected";
    cp.userFeedback = reason;
    cp.resolvedAt = new Date().toISOString();
    _checkpoints.set(checkpointId, cp);
    return cp;
  }

  /**
   * Consume an approved checkpoint for a specific step before executing a
   * destructive tool.  Returns `true` if the checkpoint was validly approved
   * for this exact (checkpointId, stepId, toolName, currentArgs) combination.
   * Returns `false` and leaves the step blocked in all other cases, including:
   *   - Token not found / expired / rejected / already consumed.
   *   - stepId mismatch (token issued for a different step).
   *   - toolName mismatch (tool substitution attack).
   *   - argsHash mismatch (argument tampering after approval).
   *
   * On success the checkpoint transitions to `consumed` immediately.
   */
  consumeApproval(
    checkpointId: string,
    stepId: string,
    toolName: string,
    currentArgs: Record<string, unknown>,
  ): boolean {
    const cp = _checkpoints.get(checkpointId);
    if (!cp) return false;

    // All identity and integrity checks
    if (cp.status !== "approved")          return false;
    if (isExpired(cp))                     return false;
    if (cp.stepId !== stepId)              return false;
    if (cp.toolName !== toolName)          return false;
    const currentHash = hashArgs(currentArgs);
    if (cp.argsHash !== currentHash)       return false;

    // Mark consumed — irreversible
    cp.status = "consumed";
    cp.resolvedAt = cp.resolvedAt || new Date().toISOString();
    _checkpoints.set(checkpointId, cp);
    return true;
  }

  /** Return a checkpoint by ID (for status inspection). */
  get(checkpointId: string): Checkpoint | undefined {
    return _checkpoints.get(checkpointId);
  }

  /**
   * Restore a checkpoint from persisted plan state (e.g. after restart).
   * Only pending/approved checkpoints may be restored — consumed/expired are skipped.
   * After restart all restored checkpoints are marked `expired` if their TTL is past,
   * enforcing the rule that modifying steps do NOT auto-resume on restart.
   */
  restore(cp: Checkpoint): void {
    if (cp.status === "consumed" || cp.status === "expired") return;
    // On restart, immediately expire any pending/approved token so it cannot be
    // auto-consumed without fresh user confirmation.
    if (isExpired(cp) || cp.status === "approved") {
      cp.status = "expired";
    }
    _checkpoints.set(cp.id, cp);
  }

  /** Expire all pending and approved tokens for a plan (called on server shutdown or plan cancellation). */
  expireAll(planId: string): void {
    for (const [id, cp] of _checkpoints) {
      if (cp.planId === planId && (cp.status === "pending" || cp.status === "approved")) {
        cp.status = "expired";
        _checkpoints.set(id, cp);
      }
    }
  }

  /** Clear all in-memory checkpoints (used in tests). */
  clearAll(): void {
    _checkpoints.clear();
  }
}

/** Module-level singleton. */
export const checkpointManager = new CheckpointManager();

/** Exported helper for hash computation (used by tests and StepExecutor). */
export { hashArgs };
