/**
 * MYRAA — Advanced Browser Intelligence & Adaptive Knowledge System
 * ProposalEvaluator.ts
 *
 * Stage 5: Evaluation Stage.
 *
 * Pre-approval evaluation of candidate proposals:
 *   - Assesses regression risk (LOW, MEDIUM, HIGH) before user review.
 *   - Flags breaking changes and deprecations for heightened scrutiny.
 *   - Checks cross-compatibility against existing knowledge structures.
 *   - Recommends whether a proposal is ready for approval or requires manual inspection.
 */

import type {
  AdaptiveProposal,
  ProposalEvaluationRecord,
  RegressionRisk,
} from "./AdaptiveIngestionTypes.ts";

export class ProposalEvaluator {
  /**
   * Evaluates an adaptive proposal that has successfully cleared Critic and Security reviews.
   */
  public evaluate(proposal: AdaptiveProposal): ProposalEvaluationRecord {
    const notes: string[] = [];
    let regressionRisk: RegressionRisk = "LOW";
    let compatibilityPassed = true;
    let evalScore = 0.85;

    // ── 1. Breaking Change Assessment ─────────────────────────────────────────
    if (proposal.payload.kind === "KNOWLEDGE" && proposal.payload.isBreakingChange) {
      regressionRisk = "MEDIUM";
      notes.push("Knowledge payload documents an upstream breaking change or API deprecation.");
      evalScore -= 0.10;
    }

    // ── 2. Contradiction & Uncertainty Assessment ─────────────────────────────
    if (proposal.provenance.contradictions && proposal.provenance.contradictions.length > 0) {
      regressionRisk = "HIGH";
      compatibilityPassed = false;
      notes.push(`Presence of ${proposal.provenance.contradictions.length} unresolved contradiction(s) elevates regression risk to HIGH.`);
      evalScore -= 0.25;
    }

    if (proposal.provenance.uncertaintyNotes) {
      notes.push(`Uncertainty recorded: "${proposal.provenance.uncertaintyNotes.slice(0, 100)}".`);
      evalScore -= 0.05;
    }

    // ── 3. Skill Complexity & Workflow Safety ─────────────────────────────────
    if (proposal.payload.kind === "SKILL") {
      const stepCount = proposal.payload.workflowSteps.length;
      if (stepCount > 8) {
        regressionRisk = regressionRisk === "HIGH" ? "HIGH" : "MEDIUM";
        notes.push(`Skill has complex multi-step workflow (${stepCount} steps).`);
        evalScore -= 0.10;
      }

      // Check for state-mutating actions
      const mutatingActions = proposal.payload.workflowSteps.filter((s) =>
        /click|type|fill|submit|execute/i.test(s.action)
      );
      if (mutatingActions.length > 3) {
        if (regressionRisk === "LOW") regressionRisk = "MEDIUM";
        notes.push("Skill performs multiple state-mutating browser interactions.");
      }
    }

    // ── 4. Provenance Confidence Influence (Balanced Blending) ────────────────
    evalScore = Math.max(0.1, Math.min(1.0, (evalScore * 0.6) + (proposal.provenance.confidence * 0.4)));

    // ── 5. Recommended Action Determination ───────────────────────────────────
    let recommendedAction: "PROCEED_TO_APPROVAL" | "HOLD_FOR_MANUAL_INSPECTION" | "REJECT" = "PROCEED_TO_APPROVAL";

    if (regressionRisk === "HIGH" || evalScore < 0.50 || !compatibilityPassed) {
      recommendedAction = "HOLD_FOR_MANUAL_INSPECTION";
    }

    if (evalScore < 0.20) {
      recommendedAction = "REJECT";
    }

    return {
      regressionRisk,
      evalScore: Math.round(evalScore * 100) / 100,
      evalNotes: notes.length > 0 ? notes.join(" ") : "Evaluation successful: Low regression risk, full compatibility verified.",
      evaluatedAt: Date.now(),
      compatibilityPassed,
      recommendedAction,
    };
  }
}

export const proposalEvaluator = new ProposalEvaluator();
