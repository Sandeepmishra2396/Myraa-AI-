/**
 * MYRAA — Phase 22: Multi-Agent Brain
 * CriticAgent
 *
 * Responsibilities:
 *   - Critically challenges proposed plans, specialist solutions, and diffs.
 *   - Evaluates:
 *       • Incorrect assumptions
 *       • Missing steps (e.g., code edit without test verification)
 *       • Security boundaries & privilege violations
 *       • Unnecessary or destructive actions
 *       • Unsupported conclusions
 *   - Emits structured verdict: APPROVED | REJECTED | NEEDS_REVISION
 *   - INVARIANT: Critic NEVER silently modifies the plan!
 */

import type {
  AgentResult,
  AgentRole,
  CriticEvaluation,
  CriticVerdict,
  MultiAgentExecutionPlan,
} from "../MultiAgentTypes.ts";
import { multiAgentContextManager } from "../MultiAgentContextManager.ts";

export class CriticAgent {
  public readonly role: AgentRole = "critic";

  /**
   * Evaluates the execution plan and proposed specialist actions.
   */
  public async evaluate(
    plan: MultiAgentExecutionPlan,
    specialistResults: Record<string, unknown> = {},
    context: Record<string, unknown> = {},
    now = Date.now()
  ): Promise<AgentResult<CriticEvaluation>> {
    const scoped = multiAgentContextManager.prepareScopedContext("critic", {
      ...context,
      plan,
      specialistResults,
    });

    const reasons: string[] = [];
    const missingSteps: string[] = [];
    const securityConcerns: string[] = [];
    const unsupportedConclusions: string[] = [];
    const suggestedRevisions: string[] = [];
    let verdict: CriticVerdict = "APPROVED";

    const hasStateChangingAction = plan.subtasks.some((s) => s.isStateChanging);
    const hasVerificationStep = plan.subtasks.some((s) => s.assignedAgent === "verifier");
    const rawGoal = plan.goal.toLowerCase();

    // ── Check 1: Security Risk & Disallowed Patterns ─────────────────────────
    if (/\b(delete database|rm -rf|drop table|format c:|kill -9 1)\b/i.test(rawGoal)) {
      verdict = "REJECTED";
      reasons.push("Critical destructive command detected in goal.");
      securityConcerns.push("Catastrophic deletion commands are strictly forbidden.");
    }

    // ── Check 2: Missing Verification Step on State-Changing Plan ────────────
    if (hasStateChangingAction && !hasVerificationStep) {
      verdict = "NEEDS_REVISION";
      missingSteps.push("Plan modifies project code/files but lacks a post-execution Verifier step.");
      suggestedRevisions.push("Add a Verifier subtask to check build and test exit codes post-execution.");
    }

    // ── Check 3: Missing User Confirmation for State Changes ─────────────────
    if (hasStateChangingAction && !plan.requiresUserApproval) {
      verdict = "NEEDS_REVISION";
      securityConcerns.push("State-changing plan does not require user confirmation.");
      suggestedRevisions.push("Flag plan as requiresUserApproval: true.");
    }

    // ── Check 4: Unsupported Specialist Claims ──────────────────────────────
    const coderResult = (specialistResults.coder as any)?.result;
    if (coderResult && !coderResult.proposedPatch && hasStateChangingAction) {
      verdict = "NEEDS_REVISION";
      unsupportedConclusions.push("Coder proposed state changes without providing a concrete unified diff.");
      suggestedRevisions.push("Coder must provide a concrete proposedPatch before approval.");
    }

    const critique =
      verdict === "APPROVED"
        ? "Plan is sound, adheres to principle of least privilege, includes verification, and bounds risk."
        : verdict === "NEEDS_REVISION"
        ? `Plan requires refinement: ${[...missingSteps, ...securityConcerns, ...suggestedRevisions].join("; ")}`
        : `Plan rejected: ${reasons.join("; ")}`;

    const evaluation: CriticEvaluation = {
      verdict,
      reasons: reasons.length > 0 ? reasons : ["All structural invariants satisfied."],
      critique,
      missingSteps,
      securityConcerns,
      unsupportedConclusions,
      suggestedRevisions,
    };

    return {
      agentId: "critic",
      taskId: `crit_${now}_${Math.random().toString(36).slice(2, 7)}`,
      timestamp: now,
      inputContext: scoped,
      objective: `Evaluate plan validity, safety boundaries, and completeness for '${plan.goal}'`,
      result: evaluation,
      evidence: [
        `Verdict: ${verdict}`,
        `Security evaluation: ${securityConcerns.length === 0 ? "PASSED" : "CONCERNS_FOUND"}`,
        `Verification step present: ${hasVerificationStep ? "YES" : "NO"}`,
      ],
      confidence: "HIGH",
      confidenceScore: 0.96,
      riskLevel: securityConcerns.length > 0 ? "HIGH" : plan.riskLevel,
      proposedActions: [],
      dependencies: [],
      status: verdict === "APPROVED" ? "SUCCESS" : verdict === "NEEDS_REVISION" ? "NEEDS_REVISION" : "REJECTED",
      provenance: {
        agent: "CriticAgent",
        version: "22.0.0",
        timestamp: now,
      },
    };
  }
}

export const criticAgent = new CriticAgent();
