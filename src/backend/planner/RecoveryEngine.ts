/**
 * MYRAA — RecoveryEngine (Phase 5)
 *
 * Implements bounded exponential backoff + jitter for safe/idempotent steps.
 * Enforces the rule: destructive steps may NEVER be auto-retried.
 * Provides alternate-tool fallback selection when max retries are exhausted.
 */

import type { PlanStep, RetryPolicy, DEFAULT_RETRY_POLICY } from "./PlannerTypes.ts";
import { DEFAULT_RETRY_POLICY as _DEFAULT } from "./PlannerTypes.ts";

// ---------------------------------------------------------------------------
// Delay computation
// ---------------------------------------------------------------------------

/**
 * Calculate the backoff delay for the nth retry attempt.
 * delay = min(maxDelayMs, initialDelayMs * multiplier^retryCount) + jitter
 * jitter is a random fraction of 10% of the computed delay.
 */
export function computeBackoffMs(
  retryCount: number,
  policy: RetryPolicy = _DEFAULT,
): number {
  const base = policy.initialDelayMs * Math.pow(policy.backoffMultiplier, retryCount);
  const capped = Math.min(policy.maxDelayMs, base);
  const jitter = Math.random() * capped * 0.1; // ±10% jitter
  return Math.floor(capped + jitter);
}

// ---------------------------------------------------------------------------
// Alternate tool selection
// ---------------------------------------------------------------------------

/** Maps a primary tool to a list of progressively simpler fallback alternatives. */
const FALLBACK_CHAINS: Record<string, string[]> = {
  fetchOfficialDocs:   ["researchWeb", "readUrl"],
  researchWeb:         ["readUrl", "queryKnowledgeBase"],
  writeCodeFile:       ["createFile"],
  runPythonScript:     ["readFile"],
  analyzeProject:      ["listFiles", "readFile"],
  searchProjectCode:   ["readFile"],
  getProjectGitStatus: ["listFiles"],
  ingestKnowledge:     ["readUrl", "queryKnowledgeBase"],
  queryKnowledgeBase:  ["researchWeb"],
};

/**
 * Return the next fallback tool for a given primary tool, or undefined if
 * the chain is exhausted.
 */
export function nextFallbackTool(
  primaryTool: string,
  alreadyTriedTools: string[],
): string | undefined {
  const chain = FALLBACK_CHAINS[primaryTool] ?? [];
  const tried = new Set(alreadyTriedTools);
  return chain.find((t) => !tried.has(t));
}

// ---------------------------------------------------------------------------
// RecoveryEngine
// ---------------------------------------------------------------------------

export class RecoveryEngine {
  /**
   * Determine whether a step should be retried and return the delay.
   * Returns `null` if the step should NOT be retried (destructive, or max exhausted).
   */
  shouldRetry(step: PlanStep, policy: RetryPolicy = _DEFAULT): { shouldRetry: boolean; delayMs: number } {
    // RULE: destructive steps MUST NOT be auto-retried
    if (step.isDestructive) {
      return { shouldRetry: false, delayMs: 0 };
    }

    if (step.retryCount >= step.maxRetries) {
      return { shouldRetry: false, delayMs: 0 };
    }

    const delayMs = computeBackoffMs(step.retryCount, policy);
    return { shouldRetry: true, delayMs };
  }

  /**
   * Sleep for the given number of milliseconds.
   * Bounded by policy.timeoutMs to prevent runaway waits.
   */
  async sleep(ms: number, maxMs = _DEFAULT.timeoutMs): Promise<void> {
    const bounded = Math.min(ms, maxMs);
    await new Promise<void>((resolve) => setTimeout(resolve, bounded));
  }

  /**
   * Select the best fallback tool for a step that has failed,
   * given the tools that have already been tried.
   */
  selectFallback(step: PlanStep, triedTools: string[]): string | undefined {
    return nextFallbackTool(step.toolName, triedTools);
  }
}

/** Shared singleton. */
export const recoveryEngine = new RecoveryEngine();
