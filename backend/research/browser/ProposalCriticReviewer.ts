/**
 * MYRAA — Advanced Browser Intelligence & Adaptive Knowledge System
 * ProposalCriticReviewer.ts
 *
 * Stage 5: Critic Review Stage.
 *
 * Rigorously evaluates candidate knowledge and skill proposals:
 *   - Challenges assumptions and flags uncorroborated inferences.
 *   - Detects false consensus arising from syndicated source copies.
 *   - Enforces epistemic boundaries (hypotheses cannot become facts).
 *   - Audits skill trigger patterns for over-breadth or conversational hijacking.
 *   - Downgrades confidence in the presence of unresolved contradictions.
 */

import type {
  AdaptiveProposal,
  CriticReviewRecord,
  CriticReviewVerdict,
} from "./AdaptiveIngestionTypes.ts";

export class ProposalCriticReviewer {
  /**
   * Conducts a multi-faceted critical evaluation of an adaptive proposal.
   */
  public review(proposal: AdaptiveProposal): CriticReviewRecord {
    const flaws: string[] = [];
    const unsupportedConclusions: string[] = [];
    const suggestedRevisions: string[] = [];
    let confidenceDowngraded = false;
    let verdict: CriticReviewVerdict = "APPROVED";

    const { provenance, payload } = proposal;

    // ── 1. Epistemic Integrity Checks ─────────────────────────────────────────
    if (provenance.epistemicClassification === "HYPOTHESIS") {
      flaws.push("Proposal is based on an unverified hypothesis, not observable fact.");
      unsupportedConclusions.push(proposal.title);
      verdict = "REJECTED";
    }

    if (provenance.epistemicClassification === "INFERENCE" && provenance.confidence < 0.65) {
      flaws.push("Inference confidence is below acceptable threshold (<0.65).");
      unsupportedConclusions.push("Low-confidence inference requires independent corroboration.");
      confidenceDowngraded = true;
      verdict = "NEEDS_REVISION";
      suggestedRevisions.push("Obtain direct documentation citation or official release note proof.");
    }

    // ── 2. Contradiction & Limitation Auditing ─────────────────────────────────
    if (provenance.contradictions && provenance.contradictions.length > 0) {
      flaws.push(`Unresolved contradictions detected (${provenance.contradictions.length}).`);
      confidenceDowngraded = true;
      if (verdict === "APPROVED") {
        verdict = "NEEDS_REVISION";
        suggestedRevisions.push("Resolve contradictions between competing documentation pages before promoting.");
      }
    }

    // ── 3. Syndication & Artificial Consensus ─────────────────────────────────
    if (provenance.syndicatedDuplicateCount && provenance.syndicatedDuplicateCount > 0) {
      if (provenance.sourceUrls.length <= 1 && provenance.confidence > 0.85) {
        flaws.push("Confidence artificially inflated despite relying on single original source with syndicated copies.");
        confidenceDowngraded = true;
        if (verdict === "APPROVED") {
          verdict = "NEEDS_REVISION";
          suggestedRevisions.push("Normalize confidence score to reflect single-origin reporting.");
        }
      }
    }

    // ── 4. Provenance & Citation Completeness ──────────────────────────────────
    if (!provenance.sourceUrls || provenance.sourceUrls.length === 0) {
      flaws.push("Proposal lacks source URL provenance.");
      unsupportedConclusions.push("No traceable source URL provided.");
      verdict = "REJECTED";
    }

    if (!provenance.sourceExcerpts || provenance.sourceExcerpts.length === 0) {
      flaws.push("Proposal lacks supporting source excerpts.");
      if (verdict === "APPROVED") {
        verdict = "NEEDS_REVISION";
        suggestedRevisions.push("Attach verbatim excerpts from the source document.");
      }
    }

    // ── 5. Skill-Specific Critic Checks ───────────────────────────────────────
    if (payload.kind === "SKILL") {
      // Overly broad triggers (e.g. single generic word or catch-all regex)
      for (const pattern of payload.triggerPatterns) {
        const clean = pattern.trim().toLowerCase();
        if (clean === ".*" || clean === ".+" || clean.length < 3) {
          flaws.push(`Trigger pattern "${pattern}" is dangerously broad and would hijack normal assistant flow.`);
          verdict = "REJECTED";
        }
      }

      // Check step definitions
      if (!payload.workflowSteps || payload.workflowSteps.length === 0) {
        flaws.push("Skill proposal contains zero executable workflow steps.");
        verdict = "REJECTED";
      } else {
        const missingTimeouts = payload.workflowSteps.some((s) => !s.timeoutMs || s.timeoutMs <= 0);
        if (missingTimeouts) {
          flaws.push("One or more workflow steps lack explicit bounded timeouts.");
          if (verdict === "APPROVED") {
            verdict = "NEEDS_REVISION";
            suggestedRevisions.push("Assign explicit timeoutMs (<= 30000ms) to all workflow steps.");
          }
        }
      }
    }

    // Construct constructive critique narrative
    const critique = flaws.length === 0
      ? "Critic review passed: Proposal demonstrates grounded evidence, sound provenance, and appropriate boundaries."
      : `Critic review identified ${flaws.length} concern(s): ${flaws.join("; ")}`;

    return {
      verdict,
      critique,
      reviewedAt: Date.now(),
      unsupportedConclusions,
      detectedFlaws: flaws,
      confidenceDowngraded,
      suggestedRevisions: suggestedRevisions.length > 0 ? suggestedRevisions : undefined,
    };
  }
}

export const proposalCriticReviewer = new ProposalCriticReviewer();
