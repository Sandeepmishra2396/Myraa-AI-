/**
 * MYRAA — Phase 24: Personal Knowledge Graph
 * KnowledgeGraphConfidenceEngine
 *
 * Implements deterministic confidence scoring for knowledge nodes and edges.
 * Distinguishes established facts from inferences.
 *
 * Invariant: INFERENCE != FACT.
 * Inferences (< 0.50) are never silently promoted to explicit facts.
 */

import type {
  KnowledgeProvenanceSourceType,
} from "./KnowledgeGraphTypes.ts";

export type ConfidenceClassification = "FACT" | "HIGH_CONFIDENCE" | "PROBABLE" | "INFERENCE_HYPOTHESIS";

export class KnowledgeGraphConfidenceEngine {
  private static readonly BASE_CONFIDENCE_MAP: Record<KnowledgeProvenanceSourceType, number> = {
    EXPLICIT_USER: 0.95,
    EXPLICIT_CORRECTION: 0.95,
    OBSERVED_PROJECT_DATA: 0.90,
    RESEARCH_EVIDENCE: 0.85,
    VERIFIER_CONFIRMATION: 0.92,
    CODING_INVESTIGATION: 0.85,
    OBSERVED_CONTEXT: 0.80,
    SYSTEM_DEFAULT: 0.75,
    DERIVED_RELATIONSHIP: 0.70,
    INFERENCE: 0.45, // Strictly below 0.50
  };

  /**
   * Computes the initial confidence score for a given provenance source.
   */
  public getBaseConfidence(sourceType: KnowledgeProvenanceSourceType): number {
    return KnowledgeGraphConfidenceEngine.BASE_CONFIDENCE_MAP[sourceType] ?? 0.50;
  }

  /**
   * Classifies a confidence score into tiers.
   */
  public getTier(score: number): "HIGH" | "MEDIUM" | "LOW" {
    if (score >= 0.85) return "HIGH";
    if (score >= 0.50) return "MEDIUM";
    return "LOW";
  }

  /**
   * Classifies evidence into actionable categories.
   */
  public classify(sourceType: KnowledgeProvenanceSourceType, score: number): ConfidenceClassification {
    if (sourceType === "INFERENCE" || score < 0.50) {
      return "INFERENCE_HYPOTHESIS";
    }
    if (sourceType === "EXPLICIT_USER" || sourceType === "OBSERVED_PROJECT_DATA" || sourceType === "VERIFIER_CONFIRMATION") {
      return "FACT";
    }
    if (score >= 0.85) {
      return "HIGH_CONFIDENCE";
    }
    return "PROBABLE";
  }

  /**
   * Combines multiple confidence scores (Bayesian-style reinforcement).
   */
  public combineConfidences(scores: number[]): number {
    if (!scores || scores.length === 0) return 0.5;
    if (scores.length === 1) return scores[0];

    // Reinforcement formula: max + dampening of rest
    const sorted = [...scores].sort((a, b) => b - a);
    let combined = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      combined = combined + (1 - combined) * (sorted[i] * 0.2);
    }
    return Math.min(0.99, Number(combined.toFixed(2)));
  }

  /**
   * Ensures that inferred knowledge cannot be treated as an authoritative fact.
   */
  public isAuthoritativeFact(sourceType: KnowledgeProvenanceSourceType, score: number): boolean {
    if (sourceType === "INFERENCE") return false;
    return score >= 0.85;
  }
}

export const knowledgeGraphConfidenceEngine = new KnowledgeGraphConfidenceEngine();
