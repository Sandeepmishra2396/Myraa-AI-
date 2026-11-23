/**
 * MYRAA — Advanced Browser Intelligence & Adaptive Knowledge System
 * SkillProposalCritic.ts
 *
 * Stage 6: Critic Reviewer specialized for Candidate Skill Proposals.
 *
 * Checks:
 *   - Step cohesion and postcondition completeness.
 *   - Overly broad or ambiguous trigger patterns (e.g. ".*", "help", single words).
 *   - Viability of failure recovery and rollback strategies.
 *   - Unaddressed execution contradictions and flakiness.
 *   - Evidence grounding and confidence levels.
 */

import type {
  CandidateWorkflow,
  SkillCriticReview,
  WorkflowDetectionRecord,
} from "./SkillProposalTypes.ts";

export class SkillProposalCritic {
  private readonly _overlyBroadTriggers = new Set<string>([
    ".*",
    ".+",
    "help",
    "hello",
    "hi",
    "run",
    "execute",
    "test",
    "open",
    "close",
    "start",
    "stop",
    "do",
    "make",
  ]);

  /**
   * Conducts a strict critic review of a candidate workflow proposal.
   */
  public reviewProposal(
    workflow: CandidateWorkflow,
    detection: WorkflowDetectionRecord,
  ): SkillCriticReview {
    const observations: string[] = [];
    const detectedGaps: string[] = [];
    const unaddressedContradictions: string[] = [];
    let confidenceDowngraded = false;
    let score = 1.0;

    // 1. Evidence grounding & confidence check
    if (detection.confidenceScore < 0.5) {
      detectedGaps.push(`Low confidence score (${detection.confidenceScore.toFixed(2)} < 0.50).`);
      score -= 0.3;
    }

    // 2. Step cohesion and verification
    if (!workflow.orderedSteps || workflow.orderedSteps.length === 0) {
      detectedGaps.push("Workflow has zero ordered steps.");
      score = 0;
    } else {
      for (const step of workflow.orderedSteps) {
        if (!step.toolName || typeof step.toolName !== "string") {
          detectedGaps.push(`Step ${step.stepIndex} has invalid toolName.`);
          score -= 0.2;
        }
        if (!step.postconditions || step.postconditions.length === 0) {
          detectedGaps.push(`Step ${step.stepIndex} (${step.toolName}) missing postconditions.`);
          score -= 0.1;
        }
      }
    }

    // 3. Trigger pattern review (reject broad/generic triggers)
    if (!workflow.triggerPatterns || workflow.triggerPatterns.length === 0) {
      detectedGaps.push("Workflow has no trigger patterns defined.");
      score -= 0.25;
    } else {
      for (const trig of workflow.triggerPatterns) {
        const clean = trig.trim().toLowerCase();
        if (clean.length < 3 || this._overlyBroadTriggers.has(clean)) {
          detectedGaps.push(`Overly broad or trivial trigger pattern detected: "${trig}".`);
          score -= 0.25;
        }
      }
    }

    // 4. Failure recovery & rollback review
    if (
      !workflow.failureRecoveryStrategy ||
      workflow.failureRecoveryStrategy.trim().length < 5 ||
      /ignore\s+(all\s+)?errors/i.test(workflow.failureRecoveryStrategy)
    ) {
      detectedGaps.push("Unsound or missing failure recovery strategy.");
      score -= 0.2;
    }

    // 5. Contradictions & flakiness review
    if (detection.failedExecutions > 0) {
      const failRatio = detection.failedExecutions / detection.totalExecutions;
      if (failRatio > 0.15) {
        unaddressedContradictions.push(
          `Detected flakiness: ${detection.failedExecutions} of ${detection.totalExecutions} executions failed (${(failRatio * 100).toFixed(1)}%).`,
        );
        confidenceDowngraded = true;
        score -= 0.25;
      } else {
        observations.push(`Minor failure rate observed (${detection.failedExecutions}/${detection.totalExecutions}).`);
      }
    }

    score = Math.max(0, Math.min(1.0, score));

    let verdict: "PASSED" | "REJECTED" | "NEEDS_REVISION" = "PASSED";
    if (score < 0.5) {
      verdict = "REJECTED";
    } else if (score < 0.8 || detectedGaps.length > 0 || unaddressedContradictions.length > 0) {
      verdict = "NEEDS_REVISION";
    }

    return {
      verdict,
      score: Math.round(score * 100) / 100,
      reviewTimestamp: Date.now(),
      reviewer: "SkillProposalCritic",
      observations,
      detectedGaps,
      unaddressedContradictions,
      confidenceDowngraded,
      suggestions:
        detectedGaps.length > 0
          ? detectedGaps.map((g) => `Resolve gap: ${g}`)
          : undefined,
    };
  }
}

export const skillProposalCritic = new SkillProposalCritic();
