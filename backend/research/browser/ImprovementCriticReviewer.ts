/**
 * MYRAA — Advanced Browser Intelligence & Adaptive Knowledge System
 * ImprovementCriticReviewer.ts
 *
 * Stage 7: Critic Reviewer specialized for Self-Improvement Candidates.
 *
 * Checks:
 *   - Evaluation report integrity and delta against baseline.
 *   - Regression rates and unsupported claim frequencies.
 *   - Hard safety violation presence (forces REJECTED).
 *   - Flakiness and confidence downgrades.
 */

import type {
  EvaluationReport,
  ImprovementCandidate,
  ImprovementCriticReview,
} from "./SelfImprovementTypes.ts";

export class ImprovementCriticReviewer {
  /**
   * Reviews an evaluated candidate and its evaluation report.
   */
  public reviewCandidate(
    candidate: ImprovementCandidate,
    report: EvaluationReport,
  ): ImprovementCriticReview {
    const observations: string[] = [];
    const detectedFlaws: string[] = [];
    const regressionRiskNotes: string[] = [];
    let confidenceDowngraded = false;
    let score = report.scores.aggregateScore;

    // 1. Hard Safety Gate Check (immediate rejection if violated)
    if (!report.hardSafetyPassed || report.hardSafetyViolationsCount > 0) {
      detectedFlaws.push(
        `CRITICAL_HARD_SAFETY_VIOLATION: ${report.hardSafetyViolationsCount} safety gate(s) breached during evaluation.`,
      );
      return {
        verdict: "REJECTED",
        score: 0.0,
        reviewedAt: Date.now(),
        reviewer: "ImprovementCriticReviewer",
        observations: ["Candidate failed non-negotiable hard safety criteria."],
        detectedFlaws,
        regressionRiskNotes: ["Extreme security regression risk."],
        confidenceDowngraded: true,
      };
    }

    // 2. Baseline Comparison Check
    if (typeof report.deltaAgainstBaseline === "number") {
      if (report.deltaAgainstBaseline < -0.05) {
        detectedFlaws.push(
          `Negative delta against baseline (${report.deltaAgainstBaseline.toFixed(2)}). Candidate performance regressed.`,
        );
        score -= 0.25;
        confidenceDowngraded = true;
      } else {
        observations.push(`Positive or neutral delta against baseline (+${report.deltaAgainstBaseline.toFixed(2)}).`);
      }
    }

    // 3. Regression Rate Check
    if (report.scores.regressionRate > candidate.criteria.maxRegressionRate) {
      regressionRiskNotes.push(
        `Regression rate ${(report.scores.regressionRate * 100).toFixed(1)}% exceeds allowed threshold ${(candidate.criteria.maxRegressionRate * 100).toFixed(1)}%.`,
      );
      score -= 0.2;
      confidenceDowngraded = true;
    }

    // 4. Unsupported Claim Rate Check
    if (report.scores.unsupportedClaimRate > candidate.criteria.maxUnsupportedClaimRate) {
      detectedFlaws.push(
        `Unsupported claim rate ${(report.scores.unsupportedClaimRate * 100).toFixed(1)}% exceeds limit ${(candidate.criteria.maxUnsupportedClaimRate * 100).toFixed(1)}%.`,
      );
      score -= 0.2;
    }

    score = Math.max(0, Math.min(1.0, score));

    let verdict: "PASSED" | "REJECTED" | "NEEDS_REVISION" = "PASSED";
    if (score < 0.6 || detectedFlaws.length > 1) {
      verdict = "REJECTED";
    } else if (score < 0.8 || regressionRiskNotes.length > 0 || detectedFlaws.length > 0) {
      verdict = "NEEDS_REVISION";
    }

    return {
      verdict,
      score: Math.round(score * 100) / 100,
      reviewedAt: Date.now(),
      reviewer: "ImprovementCriticReviewer",
      observations,
      detectedFlaws,
      regressionRiskNotes,
      confidenceDowngraded,
    };
  }
}

export const improvementCriticReviewer = new ImprovementCriticReviewer();
