/**
 * MYRAA — ResultEvaluator (Phase 5)
 *
 * Analyses the raw output of a tool execution and produces a `ResultEvaluation`
 * categorising the outcome and recommending what to do next.
 *
 * Evaluation logic is fully deterministic (no AI calls) so that it works
 * offline and in unit tests without side-effects.
 */

import type {
  StepExecutionResult,
  ResultEvaluation,
  EvaluationStatus,
  SuggestedAction,
  PlanStep,
} from "./PlannerTypes.ts";

// ---------------------------------------------------------------------------
// Transient-error patterns (retryable for safe/idempotent steps only)
// ---------------------------------------------------------------------------

const TRANSIENT_PATTERNS: RegExp[] = [
  /timeout/i,
  /ETIMEDOUT/,
  /ECONNREFUSED/,
  /ECONNRESET/,
  /network/i,
  /socket hang up/i,
  /desktop agent is not running/i,
  /EBUSY/,
  /temporarily unavailable/i,
  /service unavailable/i,
  /503/,
  /502/,
  /429/,                         // rate-limit
];

// ---------------------------------------------------------------------------
// Deterministic-failure patterns (non-retryable)
// ---------------------------------------------------------------------------

const CRITICAL_PATTERNS: RegExp[] = [
  /access denied/i,
  /permission denied/i,
  /EACCES/,
  /outside.*workspace/i,
  /traversal/i,
  /ssrf/i,
  /forbidden/i,
  /not found|ENOENT/i,
  /syntax error/i,
  /cannot find module/i,
  /checkpoint.*not found/i,
  /token.*consumed/i,
  /token.*expired/i,
  /token.*replay/i,
];

// ---------------------------------------------------------------------------
// Fallback tool map (called by RecoveryEngine when action === "fallback")
// ---------------------------------------------------------------------------

const FALLBACK_TOOLS: Record<string, string> = {
  fetchOfficialDocs: "researchWeb",
  researchWeb:       "readUrl",
  searchProjectCode: "readFile",
  writeCodeFile:     "createFile",
  runPythonScript:   "readFile",        // downgrade to read-only inspection
  analyzeProject:    "listFiles",
};

// ---------------------------------------------------------------------------
// ResultEvaluator
// ---------------------------------------------------------------------------

export class ResultEvaluator {
  /**
   * Evaluate the result of a step execution.
   * @param step  The step that was attempted.
   * @param result  Raw tool output and timing info.
   */
  evaluate(step: PlanStep, result: Pick<StepExecutionResult, "output" | "error" | "elapsedMs">): ResultEvaluation {
    const errorMsg = result.error ?? "";
    const output = result.output;

    // ── 1. Check for explicit error ────────────────────────────────────────
    if (errorMsg) {
      // Critical / deterministic failure → no retry
      if (CRITICAL_PATTERNS.some((rx) => rx.test(errorMsg))) {
        return {
          status: "critical_failure",
          score: 0,
          reason: errorMsg,
          suggestedAction: "abort",
          fallbackTool: FALLBACK_TOOLS[step.toolName],
        };
      }

      // Transient failure → retry only if step is not destructive
      if (TRANSIENT_PATTERNS.some((rx) => rx.test(errorMsg))) {
        if (step.isDestructive) {
          // Destructive steps must NOT be auto-retried — require fresh checkpoint
          return {
            status: "critical_failure",
            score: 0,
            reason: `Transient error on destructive step — requires new checkpoint. Error: ${errorMsg}`,
            suggestedAction: "abort",
          };
        }
        if (step.retryCount < step.maxRetries) {
          return {
            status: "retryable_failure",
            score: 0,
            reason: errorMsg,
            suggestedAction: "retry",
            fallbackTool: FALLBACK_TOOLS[step.toolName],
          };
        }
        // Max retries exhausted → fallback or abort
        const fallbackTool = FALLBACK_TOOLS[step.toolName];
        return {
          status: "retryable_failure",
          score: 0,
          reason: `Max retries (${step.maxRetries}) exhausted. Last error: ${errorMsg}`,
          suggestedAction: fallbackTool ? "fallback" : "abort",
          fallbackTool,
        };
      }

      // Unknown error
      return {
        status: "critical_failure",
        score: 0,
        reason: errorMsg,
        suggestedAction: step.isDestructive ? "abort" : "fallback",
        fallbackTool: FALLBACK_TOOLS[step.toolName],
      };
    }

    // ── 2. No error — evaluate output quality ─────────────────────────────
    if (output === null || output === undefined) {
      return {
        status: "partial",
        score: 0.3,
        reason: "Tool returned empty output without an error.",
        suggestedAction: step.retryCount < step.maxRetries && !step.isDestructive ? "retry" : "proceed",
      };
    }

    // Success
    const score = this._scoreOutput(output);
    const status: EvaluationStatus = score >= 0.6 ? "success" : "partial";
    const suggestedAction: SuggestedAction = score >= 0.4 ? "proceed" : "fallback";
    return {
      status,
      score,
      reason: score >= 0.6 ? "Step completed successfully." : "Step completed with limited output.",
      suggestedAction,
      fallbackTool: score < 0.4 ? FALLBACK_TOOLS[step.toolName] : undefined,
    };
  }

  /** Heuristic score for the richness/usefulness of output. Returns 0–1. */
  private _scoreOutput(output: unknown): number {
    if (typeof output === "string") {
      return output.trim().length > 10 ? 1 : 0.3;
    }
    if (typeof output === "object" && output !== null) {
      const obj = output as Record<string, unknown>;
      if (obj.error) return 0;
      if (obj.success === false) return 0.1;
      const keys = Object.keys(obj).length;
      if (keys === 0) return 0.2;
      const hasContent =
        obj.content || obj.result || obj.summary || obj.output || obj.text || obj.matches;
      return hasContent ? 1 : Math.min(1, 0.4 + keys * 0.1);
    }
    if (Array.isArray(output)) return output.length > 0 ? 1 : 0.2;
    return output !== undefined && output !== null ? 0.8 : 0.1;
  }
}

/** Shared singleton. */
export const resultEvaluator = new ResultEvaluator();
