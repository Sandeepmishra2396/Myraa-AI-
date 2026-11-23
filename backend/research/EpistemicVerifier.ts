/**
 * MYRAA — Advanced Browser Intelligence & Adaptive Knowledge System
 * EpistemicVerifier.ts
 *
 * Epistemic classification and evidence-based verification engine.
 *
 * Epistemic Labels:
 *   - FACT: Directly observed excerpt from reliable source without speculative interpretation.
 *   - INFERENCE: Derived conclusion with explicit premise links and deductive markers.
 *   - HYPOTHESIS: Plausible explanation lacking full corroboration or with open questions.
 *   - VERIFIED_CONCLUSION: Corroborated by primary official sources or multiple independent
 *     non-syndicated high-authority sources with ZERO unresolved contradictions.
 *
 * Critical Policy Invariant:
 *   Do not label a claim VERIFIED_CONCLUSION merely because multiple websites repeat it.
 *   Syndicated copies and mirror domains count as 1 source. Unresolved high/critical
 *   contradictions strictly disqualify a claim from being a VERIFIED_CONCLUSION.
 */

import type {
  ResearchClaim,
  ResearchSource,
  ContradictionRecord,
  EpistemicLabel,
  VerificationStatus,
  ClaimExcerpt,
  ClaimProvenance,
} from "./AdvancedResearchTypes.ts";
import { extractDomain } from "./DuplicateSourceDetector.ts";

// Patterns indicative of hypotheses, speculation, hedging, or ambiguity
const HYPOTHESIS_PATTERNS: RegExp[] = [
  /\b(might|may|could|perhaps|probably|possibly|speculate|hypothesize|unconfirmed|rumor|seems\s+to|appears\s+to|suspect|potential|tentative|workaround)\b/i,
  /\b(not\s+verified|unverified|anecdotal|some\s+users\s+report)\b/i,
  /\b(experimental|provisional|preliminary|tbd|todo|undocumented|subject\s+to\s+change|unclear|ambiguous|draft|alpha|beta\s+only)\b/i,
];

// Patterns indicative of inferences, logical deductions, or causal reasoning
const INFERENCE_PATTERNS: RegExp[] = [
  /\b(indicates|suggests|implies|therefore|as\s+a\s+result|consequently|deduce|infer|leads\s+to|because\s+of\s+this|hence)\b/i,
  /\b(based\s+on\s+this|this\s+demonstrates|this\s+means\s+that|conclusion\s+is)\b/i,
];

export class EpistemicVerifier {
  /**
   * Determine preliminary epistemic category for a claim.
   */
  public classifyEpistemicLabel(claim: ResearchClaim, source?: ResearchSource): EpistemicLabel {
    const text = `${claim.claim} ${claim.evidence}`.toLowerCase();

    // 1. Check for hedging, ambiguity, or speculative language → HYPOTHESIS
    if (HYPOTHESIS_PATTERNS.some((p) => p.test(text))) {
      return "HYPOTHESIS";
    }

    // 2. Forum or community content without official validation defaults to HYPOTHESIS
    if (claim.sourceType === "FORUM" || claim.sourceType === "UNKNOWN") {
      return "HYPOTHESIS";
    }

    // 3. Deductive/inference patterns → INFERENCE
    if (INFERENCE_PATTERNS.some((p) => p.test(text))) {
      return "INFERENCE";
    }

    // 4. By default, direct statements from reputable sources are FACTs
    return "FACT";
  }

  /**
   * Validates whether a claim's evidence text is present and substantively grounds the claim statement.
   * Protects against authoritative sources verifying unrelated or unsupported claims.
   */
  private _isEvidenceGrounded(claim: ResearchClaim): { grounded: boolean; reason?: string } {
    if (!claim.evidence || claim.evidence.trim().length < 15) {
      return { grounded: false, reason: "Evidence excerpt is empty or too short to substantiate claim." };
    }

    const stopWords = new Set([
      "the", "a", "an", "is", "are", "was", "were", "it", "in", "on", "at",
      "to", "of", "for", "and", "or", "but", "with", "from", "that", "this",
    ]);

    const claimTokens = new Set(
      claim.claim
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 3 && !stopWords.has(w))
    );

    const evidenceTokens = new Set(
      claim.evidence
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 3 && !stopWords.has(w))
    );

    if (claimTokens.size === 0) {
      return { grounded: true }; // Claim is purely short symbols/identifiers
    }

    let overlap = 0;
    for (const t of claimTokens) {
      if (evidenceTokens.has(t)) overlap++;
    }

    const overlapRatio = overlap / claimTokens.size;
    if (overlapRatio < 0.15 && overlap === 0) {
      return {
        grounded: false,
        reason: "Claim statement is unsupported by or unrelated to the cited source evidence excerpt.",
      };
    }

    return { grounded: true };
  }

  /**
   * Run verification policy on an individual claim.
   */
  public verifyClaim(
    claim: ResearchClaim,
    allClaims: ResearchClaim[],
    sources: ResearchSource[],
    contradictions: ContradictionRecord[]
  ): {
    label: EpistemicLabel;
    status: VerificationStatus;
    reason: string;
    supportingExcerpts: ClaimExcerpt[];
    contradictingExcerpts: ClaimExcerpt[];
    provenance: ClaimProvenance;
  } {
    const sourceMap = new Map<string, ResearchSource>();
    for (const src of sources) {
      sourceMap.set(src.id, src);
      sourceMap.set(src.url, src);
    }

    const currentSource = sourceMap.get(claim.sourceId) || sourceMap.get(claim.sourceUrl);
    const domain = extractDomain(claim.sourceUrl);

    // 1. Build Provenance Record
    const provenance: ClaimProvenance = {
      sourceUrl: claim.sourceUrl,
      fetchedAt: currentSource?.fetchedAt ?? claim.extractedAt,
      publishedAt: claim.publishedAt || currentSource?.reliability.publishedAt,
      sourceType: claim.sourceType,
      domain,
      isSyndicated: Boolean(currentSource?.reliability.isDuplicateOrSyndicated),
      canonicalUrl: currentSource?.reliability.canonicalUrl,
    };

    // 2. Collect Supporting Excerpts
    const supportingExcerpts: ClaimExcerpt[] = [];
    const supportingDomains = new Set<string>();

    for (const supportId of claim.supports) {
      const sup = allClaims.find((c) => c.id === supportId);
      if (!sup) continue;
      const supSource = sourceMap.get(sup.sourceId) || sourceMap.get(sup.sourceUrl);
      const supDomain = extractDomain(sup.sourceUrl);

      // Only count towards independent domains if not syndicated duplicate of same cluster
      const isIndependent =
        supDomain !== domain &&
        !supSource?.reliability.isDuplicateOrSyndicated &&
        supSource?.reliability.canonicalUrl !== claim.sourceUrl;

      if (isIndependent) {
        supportingDomains.add(supDomain);
      }

      supportingExcerpts.push({
        url: sup.sourceUrl,
        title: sup.sourceTitle,
        excerpt: sup.evidence,
        sourceType: sup.sourceType,
        publishedAt: sup.publishedAt,
        isIndependent,
      });
    }

    // 3. Collect Contradicting Excerpts and evaluate Contradictions
    const contradictingExcerpts: ClaimExcerpt[] = [];
    const relatedContradictions = contradictions.filter(
      (c) => c.claimA.id === claim.id || c.claimB.id === claim.id
    );

    let hasUnresolvedHighContradiction = false;
    let hasResolvedAgainstClaim = false;

    for (const contra of relatedContradictions) {
      const otherClaim = contra.claimA.id === claim.id ? contra.claimB : contra.claimA;
      const otherSource = sourceMap.get(otherClaim.sourceId) || sourceMap.get(otherClaim.sourceUrl);

      contradictingExcerpts.push({
        url: otherClaim.sourceUrl,
        title: otherClaim.sourceTitle,
        excerpt: otherClaim.evidence,
        sourceType: otherClaim.sourceType,
        publishedAt: otherClaim.publishedAt,
        isIndependent: extractDomain(otherClaim.sourceUrl) !== domain,
      });

      if (contra.resolution === "UNRESOLVED" && (contra.severity === "HIGH" || contra.severity === "CRITICAL")) {
        hasUnresolvedHighContradiction = true;
      }

      if (contra.preferredClaimId && contra.preferredClaimId !== claim.id) {
        hasResolvedAgainstClaim = true;
      }
    }

    // 4. Check for Hard Contradiction or Insufficient Evidence
    if (hasResolvedAgainstClaim) {
      return {
        label: "HYPOTHESIS",
        status: "CONTRADICTED",
        reason: "Contradicted by higher-authority or newer evidence source.",
        supportingExcerpts,
        contradictingExcerpts,
        provenance,
      };
    }

    if (hasUnresolvedHighContradiction) {
      return {
        label: "HYPOTHESIS",
        status: "INSUFFICIENT_EVIDENCE",
        reason: "Unresolved high-severity contradiction detected across sources; requires further investigation.",
        supportingExcerpts,
        contradictingExcerpts,
        provenance,
      };
    }

    // 4. Check for Evidence Grounding (prevent unsupported or unrelated claims from being verified)
    const grounding = this._isEvidenceGrounded(claim);
    if (!grounding.grounded) {
      return {
        label: "HYPOTHESIS",
        status: "INSUFFICIENT_EVIDENCE",
        reason: grounding.reason || "Claim is unsupported by or unrelated to cited source evidence.",
        supportingExcerpts,
        contradictingExcerpts,
        provenance,
      };
    }

    // 5. Evaluate for VERIFIED_CONCLUSION
    const isOfficialSource = [
      "OFFICIAL_DOCUMENTATION",
      "OFFICIAL_API_REFERENCE",
      "OFFICIAL_GITHUB",
    ].includes(claim.sourceType);

    const isHighReliability = claim.reliability.composite >= 0.80;
    const isIndependentDomain = !provenance.isSyndicated && (claim.reliability.independence ?? 1.0) >= 0.80;
    const initialLabel = this.classifyEpistemicLabel(claim, currentSource);

    // Rule A: Direct evidence from official documentation/API/GitHub with high reliability and zero high contradictions
    // Strict requirement: must be a factual statement with direct evidence, not an inference or hypothesis
    const verifiedByOfficial =
      isOfficialSource &&
      isHighReliability &&
      initialLabel === "FACT" &&
      (claim.reliability.directEvidence ?? true) &&
      grounding.grounded;

    // Rule B: Corroborated by at least 2 distinct independent non-syndicated domains with high reliability
    const verifiedByCorroboration =
      supportingDomains.size >= 2 &&
      claim.reliability.composite >= 0.70 &&
      isIndependentDomain &&
      initialLabel === "FACT" &&
      grounding.grounded;

    if (verifiedByOfficial || verifiedByCorroboration) {
      const reason = verifiedByOfficial
        ? `Verified by authoritative official documentation (${claim.sourceType}) with high reliability composite (${claim.reliability.composite.toFixed(2)}) and substantiated evidence.`
        : `Verified via independent corroboration across ${supportingDomains.size} distinct domains with zero unresolved contradictions.`;

      return {
        label: "VERIFIED_CONCLUSION",
        status: "VERIFIED_CONCLUSION",
        reason,
        supportingExcerpts,
        contradictingExcerpts,
        provenance,
      };
    }

    // 6. Evaluate for Corroborated or Unverified Fact/Inference/Hypothesis
    if (claim.reliability.composite < 0.40) {
      return {
        label: initialLabel === "FACT" ? "HYPOTHESIS" : initialLabel,
        status: "INSUFFICIENT_EVIDENCE",
        reason: `Low composite reliability (${claim.reliability.composite.toFixed(2)}) leaves evidence insufficient.`,
        supportingExcerpts,
        contradictingExcerpts,
        provenance,
      };
    }

    if (supportingExcerpts.length > 0) {
      return {
        label: initialLabel,
        status: "CORROBORATED",
        reason: `Corroborated by ${supportingExcerpts.length} supporting sources.`,
        supportingExcerpts,
        contradictingExcerpts,
        provenance,
      };
    }

    return {
      label: initialLabel,
      status: "UNVERIFIED",
      reason: "Single source claim without independent corroboration.",
      supportingExcerpts,
      contradictingExcerpts,
      provenance,
    };
  }

  /**
   * Verify all claims, attach verification fields, and return annotated claims.
   */
  public verifyAll(
    claims: ResearchClaim[],
    sources: ResearchSource[],
    contradictions: ContradictionRecord[]
  ): ResearchClaim[] {
    return claims.map((claim) => {
      const {
        label,
        status,
        reason,
        supportingExcerpts,
        contradictingExcerpts,
        provenance,
      } = this.verifyClaim(claim, claims, sources, contradictions);

      return {
        ...claim,
        epistemicLabel: label,
        verificationStatus: status,
        verificationReason: reason,
        supportingExcerpts,
        contradictingExcerpts,
        provenance,
      };
    });
  }
}

export const epistemicVerifier = new EpistemicVerifier();
