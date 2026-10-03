/**
 * MYRAA — Phase 25: Self-Correction & Failure Recovery Engine
 * RecoveryAttemptManager
 *
 * Enforces retry limits, attempt budgets, and retry differentiation:
 *   - Maximum recovery attempts per action: 3
 *   - Maximum total recovery attempts per task: 5
 *   - Maximum correction chain depth: 5
 *   - Repeated strategy prevention: If same strategy fails twice, blocks repetition
 *   - Retry differentiation: Retries must differ meaningfully from previous failed attempts
 */

import type {
  RecoveryCandidate,
  RecoveryBudget,
} from "./SelfCorrectionTypes.ts";

export interface AttemptCheckResult {
  allowed: boolean;
  attemptNumber: number;
  reason?: string;
}

export class RecoveryAttemptManager {
  private _budget: RecoveryBudget;
  // actionId -> number of attempts
  private _actionAttempts: Map<string, number> = new Map();
  // taskId -> number of total attempts
  private _taskAttempts: Map<string, number> = new Map();
  // actionId -> Set of attempted strategyIds
  private _actionStrategies: Map<string, Map<string, number>> = new Map();
  // chainId -> depth
  private _chainDepths: Map<string, number> = new Map();

  constructor(
    budget: RecoveryBudget = {
      maxAttemptsPerAction: 3,
      maxTotalAttemptsPerTask: 5,
      maxChainDepth: 5,
    }
  ) {
    this._budget = budget;
  }

  public get budget(): RecoveryBudget {
    return this._budget;
  }

  /**
   * Resets all attempt tracking.
   */
  public reset(): void {
    this._actionAttempts.clear();
    this._taskAttempts.clear();
    this._actionStrategies.clear();
    this._chainDepths.clear();
  }

  /**
   * Checks whether a recovery attempt is permitted under retry budgets.
   */
  public canAttempt(
    actionId: string,
    candidate: RecoveryCandidate,
    taskId?: string,
    chainId?: string
  ): AttemptCheckResult {
    // 1. Check action attempt budget (max 3)
    const currentActionAttempts = this._actionAttempts.get(actionId) || 0;
    if (currentActionAttempts >= this._budget.maxAttemptsPerAction) {
      return {
        allowed: false,
        attemptNumber: currentActionAttempts + 1,
        reason: `Exceeded maximum recovery attempts per action (${this._budget.maxAttemptsPerAction}).`,
      };
    }

    // 2. Check task attempt budget (max 5)
    if (taskId) {
      const currentTaskAttempts = this._taskAttempts.get(taskId) || 0;
      if (currentTaskAttempts >= this._budget.maxTotalAttemptsPerTask) {
        return {
          allowed: false,
          attemptNumber: currentActionAttempts + 1,
          reason: `Exceeded maximum total recovery attempts for task '${taskId}' (${this._budget.maxTotalAttemptsPerTask}).`,
        };
      }
    }

    // 3. Check chain depth budget (max 5)
    if (chainId) {
      const currentDepth = this._chainDepths.get(chainId) || 0;
      if (currentDepth >= this._budget.maxChainDepth) {
        return {
          allowed: false,
          attemptNumber: currentActionAttempts + 1,
          reason: `Exceeded maximum correction chain depth (${this._budget.maxChainDepth}).`,
        };
      }
    }

    // 4. Repeated Strategy Prevention
    // If the same strategy has failed twice for this action, block it!
    const strategyCounts = this._actionStrategies.get(actionId) || new Map<string, number>();
    const count = strategyCounts.get(candidate.strategyId) || 0;
    if (count >= 2) {
      return {
        allowed: false,
        attemptNumber: currentActionAttempts + 1,
        reason: `Strategy '${candidate.strategyId}' has failed ${count} times. Repetition blocked; alternative required.`,
      };
    }

    return {
      allowed: true,
      attemptNumber: currentActionAttempts + 1,
    };
  }

  /**
   * Records an executed attempt.
   */
  public recordAttempt(
    actionId: string,
    candidate: RecoveryCandidate,
    taskId?: string,
    chainId?: string
  ): number {
    const currentAction = (this._actionAttempts.get(actionId) || 0) + 1;
    this._actionAttempts.set(actionId, currentAction);

    if (taskId) {
      const currentTask = (this._taskAttempts.get(taskId) || 0) + 1;
      this._taskAttempts.set(taskId, currentTask);
    }

    if (chainId) {
      const currentChain = (this._chainDepths.get(chainId) || 0) + 1;
      this._chainDepths.set(chainId, currentChain);
    }

    let strategyCounts = this._actionStrategies.get(actionId);
    if (!strategyCounts) {
      strategyCounts = new Map<string, number>();
      this._actionStrategies.set(actionId, strategyCounts);
    }
    const currentStratCount = (strategyCounts.get(candidate.strategyId) || 0) + 1;
    strategyCounts.set(candidate.strategyId, currentStratCount);

    return currentAction;
  }

  /**
   * Evaluates if a proposed retry differs meaningfully from the previous attempt.
   */
  public isMeaningfullyDifferent(
    lastCandidate: RecoveryCandidate | undefined,
    newCandidate: RecoveryCandidate
  ): boolean {
    if (!lastCandidate) return true;
    if (lastCandidate.strategyId !== newCandidate.strategyId) return true;

    // Compare actions
    if (lastCandidate.requiredActions.length !== newCandidate.requiredActions.length) return true;
    for (let i = 0; i < lastCandidate.requiredActions.length; i++) {
      const a1 = lastCandidate.requiredActions[i];
      const a2 = newCandidate.requiredActions[i];
      if (a1.toolName !== a2.toolName) return true;
      if (JSON.stringify(a1.parameters) !== JSON.stringify(a2.parameters)) return true;
    }

    return false;
  }
}

export const recoveryAttemptManager = new RecoveryAttemptManager();
