/**
 * MYRAA — Step 8: Advanced Browser Research Agent
 * CrossCheckEngine
 *
 * Cross-checks claims across multiple sources to build corroboration scores.
 * A claim corroborated by multiple independent authoritative sources
 * receives a higher confidence score.
 *
 * Also normalizes claims to deduplicate near-identical statements
 * from different sources.
 */

import type { ResearchClaim } from "./AdvancedResearchTypes.ts";
import { sourceReliabilityEngine } from "./SourceReliabilityEngine.ts";

/** Jaccard similarity between token sets */
function tokenSimilarity(a: string, b: string): number {
  const stopWords = new Set(["the", "a", "an", "is", "are", "it", "in", "to", "of", "and", "for"]);
  const tokA = new Set(
    a
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !stopWords.has(w))
  );
  const tokB = new Set(
    b
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !stopWords.has(w))
  );
  const intersection = [...tokA].filter((t) => tokB.has(t)).length;
  const union = new Set([...tokA, ...tokB]).size;
  return union === 0 ? 0 : intersection / union;
}

export class CrossCheckEngine {
  /**
   * Cross-check all claims, update corroboration counts, and boost
   * confidence for claims supported by multiple independent sources.
   */
  public crossCheck(claims: ResearchClaim[]): ResearchClaim[] {
    const result = [...claims];

    for (let i = 0; i < result.length; i++) {
      let corroborationCount = 0;

      for (let j = 0; j < result.length; j++) {
        if (i === j) continue;
        if (result[i].sourceId === result[j].sourceId) continue; // Same source doesn't count

        const similarity = tokenSimilarity(result[i].claim, result[j].claim);
        if (similarity >= 0.50) {
          corroborationCount++;
          // Mark as supporting each other
          if (!result[i].supports.includes(result[j].id)) {
            result[i].supports.push(result[j].id);
          }
        }
      }

      // Update corroboration score
      if (corroborationCount > 0) {
        result[i].reliability = sourceReliabilityEngine.updateCorroboration(
          result[i].reliability,
          corroborationCount
        );

        // Boost confidence proportional to corroboration (max 1.0)
        const boostFactor = Math.min(0.15, corroborationCount * 0.05);
        result[i].confidence = Math.min(1.0, result[i].confidence + boostFactor);
      }
    }

    return result;
  }

  /**
   * Remove near-duplicate claims (similarity >= 0.75), keeping the highest
   * confidence/reliability version of each unique claim.
   */
  public deduplicate(claims: ResearchClaim[]): ResearchClaim[] {
    const kept: ResearchClaim[] = [];

    for (const claim of claims) {
      const duplicate = kept.find((k) => tokenSimilarity(k.claim, claim.claim) >= 0.75);
      if (duplicate) {
        // Keep the one with higher reliability
        if (claim.reliability.composite > duplicate.reliability.composite) {
          const idx = kept.indexOf(duplicate);
          kept[idx] = claim;
        }
      } else {
        kept.push(claim);
      }
    }

    return kept;
  }
}

export const crossCheckEngine = new CrossCheckEngine();
