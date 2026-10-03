/**
 * MYRAA — Phase 19: Advanced Context Fusion Engine
 * Context Conflict Resolver
 *
 * Deterministically detects and resolves conflicts between divergent context sources:
 *   - Voice utterance vs Active foreground window
 *   - Explicit file mention vs Open editor file
 *   - Learned cognitive preference vs Current explicit command
 *   - Screen visual perception vs Task state
 *
 * Enforces the Golden Priority Ladder:
 *   Current explicit user instruction (100)
 *   > Active task (85)
 *   > Current conversation (75)
 *   > Current app/file/project (65)
 *   > Screen/browser context (50)
 *   > Recent actions (40)
 *   > Device/time (30)
 *   > Learned preferences/memory (20)
 *
 * Stale Protection:
 *   A stale higher-priority source NEVER overrides a fresh lower-priority source!
 */

import { ContextPriority, type ContextConflict, type ContextSourceType } from "./IntelligenceTypes.ts";
import { contextFreshnessManager, ContextFreshnessManager } from "./ContextFreshnessManager.ts";
import { contextConfidenceEngine, ContextConfidenceEngine } from "./ContextConfidenceEngine.ts";

export class ContextConflictResolver {
  private _freshness: ContextFreshnessManager;
  private _confidence: ContextConfidenceEngine;

  constructor(freshness = contextFreshnessManager, confidence = contextConfidenceEngine) {
    this._freshness = freshness;
    this._confidence = confidence;
  }

  /**
   * Resolves a conflict between two competing context candidates for the same entity slot.
   */
  public resolveConflict(
    entityType: ContextConflict["entityType"],
    candidateA: {
      value: string;
      source: ContextSourceType;
      confidence: number;
      timestamp: number;
      priority: ContextPriority;
      isExplicitInstruction?: boolean;
    },
    candidateB: {
      value: string;
      source: ContextSourceType;
      confidence: number;
      timestamp: number;
      priority: ContextPriority;
      isExplicitInstruction?: boolean;
    }
  ): ContextConflict {
    const valA = (candidateA.value || "").trim().toLowerCase();
    const valB = (candidateB.value || "").trim().toLowerCase();

    // 0. If identical values, no contradiction exists
    if (valA === valB) {
      return {
        entityType,
        primaryCandidate: {
          value: candidateA.value,
          source: candidateA.source,
          confidence: candidateA.confidence,
          timestamp: candidateA.timestamp,
        },
        conflictingCandidate: {
          value: candidateB.value,
          source: candidateB.source,
          confidence: candidateB.confidence,
          timestamp: candidateB.timestamp,
        },
        resolution: "primary_won",
        winningValue: candidateA.value,
        rationale: "Both candidates agree on the same entity value.",
      };
    }

    // 1. Explicit Current User Instruction Priority Rule
    if (candidateA.isExplicitInstruction && !candidateB.isExplicitInstruction) {
      return {
        entityType,
        primaryCandidate: {
          value: candidateA.value,
          source: candidateA.source,
          confidence: candidateA.confidence,
          timestamp: candidateA.timestamp,
        },
        conflictingCandidate: {
          value: candidateB.value,
          source: candidateB.source,
          confidence: candidateB.confidence,
          timestamp: candidateB.timestamp,
        },
        resolution: "primary_won",
        winningValue: candidateA.value,
        rationale: `Explicit user instruction '${candidateA.value}' strictly overrides background state '${candidateB.value}'.`,
      };
    }

    if (!candidateA.isExplicitInstruction && candidateB.isExplicitInstruction) {
      return {
        entityType,
        primaryCandidate: {
          value: candidateA.value,
          source: candidateA.source,
          confidence: candidateA.confidence,
          timestamp: candidateA.timestamp,
        },
        conflictingCandidate: {
          value: candidateB.value,
          source: candidateB.source,
          confidence: candidateB.confidence,
          timestamp: candidateB.timestamp,
        },
        resolution: "conflicting_won",
        winningValue: candidateB.value,
        rationale: `Explicit user instruction '${candidateB.value}' strictly overrides background state '${candidateA.value}'.`,
      };
    }

    // 2. Freshness check: Discard stale candidates
    const decayA = this._freshness.getDecayFactor(candidateA.source, candidateA.timestamp);
    const decayB = this._freshness.getDecayFactor(candidateB.source, candidateB.timestamp);

    if (decayA > 0.1 && decayB <= 0.1) {
      return {
        entityType,
        primaryCandidate: {
          value: candidateA.value,
          source: candidateA.source,
          confidence: candidateA.confidence,
          timestamp: candidateA.timestamp,
        },
        conflictingCandidate: {
          value: candidateB.value,
          source: candidateB.source,
          confidence: candidateB.confidence,
          timestamp: candidateB.timestamp,
        },
        resolution: "primary_won",
        winningValue: candidateA.value,
        rationale: `Candidate A is fresh (${decayA}) while Candidate B is stale (${decayB}).`,
      };
    }

    if (decayB > 0.1 && decayA <= 0.1) {
      return {
        entityType,
        primaryCandidate: {
          value: candidateA.value,
          source: candidateA.source,
          confidence: candidateA.confidence,
          timestamp: candidateA.timestamp,
        },
        conflictingCandidate: {
          value: candidateB.value,
          source: candidateB.source,
          confidence: candidateB.confidence,
          timestamp: candidateB.timestamp,
        },
        resolution: "conflicting_won",
        winningValue: candidateB.value,
        rationale: `Candidate B is fresh (${decayB}) while Candidate A is stale (${decayA}).`,
      };
    }

    // 3. Effective Priority Score Comparison
    // Effective Score = (Priority / 100) * DecayedConfidence
    const scoreA = (candidateA.priority / 100) * (candidateA.confidence * decayA);
    const scoreB = (candidateB.priority / 100) * (candidateB.confidence * decayB);

    const diff = Math.abs(scoreA - scoreB);

    // If difference is statistically negligible and neither is clearly authoritative: flag ambiguous
    if (diff < 0.05 && Math.abs(candidateA.priority - candidateB.priority) < 15) {
      return {
        entityType,
        primaryCandidate: {
          value: candidateA.value,
          source: candidateA.source,
          confidence: candidateA.confidence,
          timestamp: candidateA.timestamp,
        },
        conflictingCandidate: {
          value: candidateB.value,
          source: candidateB.source,
          confidence: candidateB.confidence,
          timestamp: candidateB.timestamp,
        },
        resolution: "ambiguous_unresolved",
        winningValue: null,
        rationale: `Ambiguous conflict between '${candidateA.value}' (${candidateA.source}) and '${candidateB.value}' (${candidateB.source}) with tied effective scores (${scoreA.toFixed(2)} vs ${scoreB.toFixed(2)}).`,
      };
    }

    if (scoreA >= scoreB) {
      return {
        entityType,
        primaryCandidate: {
          value: candidateA.value,
          source: candidateA.source,
          confidence: candidateA.confidence,
          timestamp: candidateA.timestamp,
        },
        conflictingCandidate: {
          value: candidateB.value,
          source: candidateB.source,
          confidence: candidateB.confidence,
          timestamp: candidateB.timestamp,
        },
        resolution: "primary_won",
        winningValue: candidateA.value,
        rationale: `Candidate A won with effective score ${scoreA.toFixed(2)} vs ${scoreB.toFixed(2)} (${candidateA.source} over ${candidateB.source}).`,
      };
    }

    return {
      entityType,
      primaryCandidate: {
        value: candidateA.value,
        source: candidateA.source,
        confidence: candidateA.confidence,
        timestamp: candidateA.timestamp,
      },
      conflictingCandidate: {
        value: candidateB.value,
        source: candidateB.source,
        confidence: candidateB.confidence,
        timestamp: candidateB.timestamp,
      },
      resolution: "conflicting_won",
      winningValue: candidateB.value,
      rationale: `Candidate B won with effective score ${scoreB.toFixed(2)} vs ${scoreA.toFixed(2)} (${candidateB.source} over ${candidateA.source}).`,
    };
  }
}

export const contextConflictResolver = new ContextConflictResolver();
