/**
 * MYRAA — Phase 19: Advanced Context Fusion Engine
 * Context Confidence Engine
 *
 * Computes calibrated confidence scores for context observations, references,
 * and fused entity bindings.
 *
 * Formulation:
 *   Confidence = SourceReliability * FreshnessDecay * CorroborationBonus
 *
 * Enforces Rule:
 *   Low-confidence inferences (< 0.50) must NEVER be treated as facts or used
 *   to silently execute actions without explicit user confirmation.
 */

import { contextSourceRegistry, ContextSourceRegistry } from "./ContextSourceRegistry.ts";
import { contextFreshnessManager, ContextFreshnessManager } from "./ContextFreshnessManager.ts";
import type { ContextSourceType } from "./IntelligenceTypes.ts";

export type ConfidenceTier = "HIGH" | "MEDIUM" | "LOW";

export class ContextConfidenceEngine {
  private _registry: ContextSourceRegistry;
  private _freshness: ContextFreshnessManager;

  constructor(registry = contextSourceRegistry, freshness = contextFreshnessManager) {
    this._registry = registry;
    this._freshness = freshness;
  }

  /**
   * Computes confidence score (0.0 to 1.0) for a context observation.
   */
  public computeConfidence(
    source: ContextSourceType,
    timestamp: number,
    corroboratingSourcesCount = 0,
    now = Date.now()
  ): number {
    const reliability = this._registry.getReliability(source);
    const decay = this._freshness.getDecayFactor(source, timestamp, now);

    // Baseline decayed confidence
    let score = reliability * decay;

    // Multi-source corroboration bonus (up to +0.10 for independent confirmation)
    if (corroboratingSourcesCount > 0 && decay > 0.3) {
      const bonus = Math.min(0.1, corroboratingSourcesCount * 0.05);
      score += bonus;
    }

    return Math.max(0.0, Math.min(1.0, Number(score.toFixed(2))));
  }

  /**
   * Categorizes a numeric score into HIGH, MEDIUM, or LOW tier.
   */
  public getTier(score: number): ConfidenceTier {
    if (score >= 0.8) return "HIGH";
    if (score >= 0.5) return "MEDIUM";
    return "LOW";
  }

  /**
   * Verifies if confidence is sufficient for safe execution.
   */
  public isExecutionSafe(score: number): boolean {
    return score >= 0.8;
  }

  /**
   * Checks if confidence requires user clarification.
   */
  public requiresClarification(score: number, isAmbiguous = false): boolean {
    return isAmbiguous || score < 0.5;
  }
}

export const contextConfidenceEngine = new ContextConfidenceEngine();
