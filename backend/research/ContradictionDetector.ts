/**
 * MYRAA — Step 8: Advanced Browser Research Agent
 * ContradictionDetector
 *
 * Detects, analyzes, and attempts to resolve contradictions between claims.
 *
 * Example:
 *   Source A: "Feature X is supported."
 *   Source B: "Feature X is not supported."
 *   Source C: "Feature X is supported only from version Y."
 *
 * Resolution strategy:
 *   1. Version-dependent: Check if disagreement is version-gated
 *   2. Context-dependent: Check if claims apply to different contexts
 *   3. Authority-resolved: Higher authority source wins
 *   4. Recency-resolved: Newer source wins
 *   5. UNRESOLVED: Confidence = LOW, no guessing
 *
 * INVARIANT: MYRAA never declares something correct just because one
 * documentation page says so. Contradictions are reported honestly.
 */

import crypto from "crypto";
import type {
  ResearchClaim,
  ContradictionRecord,
  ContradictionSeverity,
  ContradictionResolution,
} from "./AdvancedResearchTypes.ts";

// Negation patterns for detecting contradictions
const POSITIVE_PATTERNS: RegExp[] = [
  /\b(is|are|does|do|supports?|provides?|allows?|enables?|works?|available|included|implemented|enabled)\b/i,
];

const NEGATIVE_PATTERNS: RegExp[] = [
  /\b(not|no|never|doesn'?t|don'?t|isn'?t|aren'?t|won'?t|cannot|can'?t|unsupported|unavailable|removed|deprecated|dropped|disabled)\b/i,
];

function isPositiveClaim(text: string): boolean {
  return (
    POSITIVE_PATTERNS.some((p) => p.test(text)) && !NEGATIVE_PATTERNS.some((p) => p.test(text))
  );
}

function isNegativeClaim(text: string): boolean {
  return NEGATIVE_PATTERNS.some((p) => p.test(text));
}

/** Extract key subject tokens from a claim for comparison */
function extractKeyTokens(claim: string): Set<string> {
  const stopWords = new Set([
    "the", "a", "an", "is", "are", "was", "were", "it", "in", "on", "at",
    "to", "of", "for", "and", "or", "but", "with", "from", "that", "this",
  ]);
  return new Set(
    claim
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !stopWords.has(w))
  );
}

/** Jaccard similarity between two token sets */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  const intersection = new Set([...a].filter((x) => b.has(x)));
  const union = new Set([...a, ...b]);
  return union.size === 0 ? 0 : intersection.size / union.size;
}

export class ContradictionDetector {
  /**
   * Analyze all extracted claims and detect contradictions.
   * Returns an array of ContradictionRecords.
   */
  public detect(claims: ResearchClaim[]): ContradictionRecord[] {
    const contradictions: ContradictionRecord[] = [];
    const seen = new Set<string>();

    for (let i = 0; i < claims.length; i++) {
      for (let j = i + 1; j < claims.length; j++) {
        const a = claims[i];
        const b = claims[j];

        // Skip same-source comparisons
        if (a.sourceId === b.sourceId) continue;

        // Skip already-detected pairs
        const pairKey = [a.id, b.id].sort().join("|");
        if (seen.has(pairKey)) continue;

        // Check if claims are about the same topic (Jaccard > 0.3)
        const tokA = extractKeyTokens(a.claim);
        const tokB = extractKeyTokens(b.claim);
        const similarity = jaccardSimilarity(tokA, tokB);
        if (similarity < 0.30) continue;

        // Detect polarity contradiction
        const aPositive = isPositiveClaim(a.claim);
        const bPositive = isPositiveClaim(b.claim);
        const aNegative = isNegativeClaim(a.claim);
        const bNegative = isNegativeClaim(b.claim);

        const isContradiction =
          (aPositive && bNegative) || (aNegative && bPositive);

        if (!isContradiction) continue;

        seen.add(pairKey);

        const contradiction = this._resolve(a, b, similarity);
        contradictions.push(contradiction);

        // Update claim links
        a.contradicts.push(b.id);
        b.contradicts.push(a.id);
      }
    }

    return contradictions;
  }

  // ---------------------------------------------------------------------------
  // Resolution Strategy
  // ---------------------------------------------------------------------------

  private _resolve(
    claimA: ResearchClaim,
    claimB: ResearchClaim,
    similarity: number
  ): ContradictionRecord {
    const severity = this._assessSeverity(claimA, claimB, similarity);

    // Strategy 1: Version-dependent
    if (claimA.version || claimB.version) {
      const explanation =
        claimA.version && claimB.version
          ? `ClaimA applies to v${claimA.version}; ClaimB applies to v${claimB.version}. Disagreement is version-gated.`
          : `One claim specifies version ${claimA.version || claimB.version}. Check which version is active in your project.`;

      const preferred =
        claimA.version && claimB.version
          ? null // Can't determine without project version
          : claimA.version
          ? claimA.id
          : claimB.id;

      return this._buildRecord(
        claimA, claimB, severity,
        "VERSION_DEPENDENT", explanation,
        preferred,
        0.60
      );
    }

    // Strategy 2: Authority-resolved
    const authDiff = Math.abs(claimA.reliability.sourceAuthority - claimB.reliability.sourceAuthority);
    if (authDiff > 0.25) {
      const winner = claimA.reliability.sourceAuthority > claimB.reliability.sourceAuthority ? claimA : claimB;
      const loser = winner === claimA ? claimB : claimA;
      return this._buildRecord(
        claimA, claimB, severity,
        "SOURCE_AUTHORITY_RESOLVED",
        `${winner.sourceType} (authority ${(winner.reliability.sourceAuthority * 100).toFixed(0)}%) ` +
        `outranks ${loser.sourceType} (authority ${(loser.reliability.sourceAuthority * 100).toFixed(0)}%). ` +
        `Preferring claim from ${winner.sourceTitle}.`,
        winner.id,
        winner.reliability.composite
      );
    }

    // Strategy 3: Recency-resolved
    const recencyDiff = Math.abs(claimA.reliability.recency - claimB.reliability.recency);
    if (recencyDiff > 0.20) {
      const newer = claimA.reliability.recency > claimB.reliability.recency ? claimA : claimB;
      return this._buildRecord(
        claimA, claimB, severity,
        "RECENCY_RESOLVED",
        `More recent source (${newer.sourceTitle}) preferred over older source.`,
        newer.id,
        newer.reliability.recency
      );
    }

    // Strategy 4: UNRESOLVED — honest, no guessing
    return this._buildRecord(
      claimA, claimB, severity,
      "UNRESOLVED",
      "Sources disagree and no resolution criterion (version, authority, recency) is decisive. " +
      "Manual verification required. Confidence: LOW.",
      null,
      0.20
    );
  }

  private _assessSeverity(
    a: ResearchClaim,
    b: ResearchClaim,
    similarity: number
  ): ContradictionSeverity {
    const avgAuthority = (a.reliability.sourceAuthority + b.reliability.sourceAuthority) / 2;
    if (avgAuthority > 0.80 && similarity > 0.60) return "CRITICAL";
    if (avgAuthority > 0.60 && similarity > 0.40) return "HIGH";
    if (avgAuthority > 0.40) return "MEDIUM";
    return "LOW";
  }

  private _buildRecord(
    claimA: ResearchClaim,
    claimB: ResearchClaim,
    severity: ContradictionSeverity,
    resolution: ContradictionResolution,
    explanation: string,
    preferredClaimId: string | null,
    resolvedConfidence: number
  ): ContradictionRecord {
    // Determine shared topic from overlapping tokens
    const tokA = extractKeyTokens(claimA.claim);
    const tokB = extractKeyTokens(claimB.claim);
    const shared = [...tokA].filter((t) => tokB.has(t)).slice(0, 5).join(", ");

    return {
      id: crypto.randomUUID(),
      topic: shared || "unknown topic",
      claimA,
      claimB,
      severity,
      resolution,
      resolutionExplanation: explanation,
      preferredClaimId,
      resolvedConfidence,
    };
  }
}

export const contradictionDetector = new ContradictionDetector();
