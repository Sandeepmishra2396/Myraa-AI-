/**
 * MYRAA — Phase 18: Adaptive Personal Brain
 * Deduplication Engine
 *
 * Prevents memory bloat by detecting duplicate or highly similar learned memories.
 * When a memory candidate reinforces an existing rule, it bumps reinforcement count
 * and confidence rather than creating a duplicate entry.
 * If candidate opposes an existing rule, flags a contradiction for resolution.
 */

import type { CognitiveMemory, DeduplicationCheckResult } from "./CognitiveTypes.ts";

export class DeduplicationEngine {
  /**
   * Evaluates a candidate memory against existing active memories.
   */
  public checkDuplicate(
    candidate: CognitiveMemory,
    existingMemories: CognitiveMemory[]
  ): DeduplicationCheckResult {
    // Filter to active memories only
    const active = existingMemories.filter((m) => m.status === "active");

    // 1. Exact Key Match Check
    const exactMatch = active.find((m) => m.key === candidate.key);
    if (exactMatch) {
      const sameValue = this._areValuesEqual(candidate.value, exactMatch.value);
      if (sameValue) {
        return {
          isDuplicate: true,
          action: "reinforce",
          existingMemory: exactMatch,
          similarityScore: 1.0,
        };
      } else {
        // Same key, different value -> Contradiction!
        return {
          isDuplicate: false,
          action: "contradict",
          existingMemory: exactMatch,
          similarityScore: 1.0,
        };
      }
    }

    // 2. Semantic Token Overlap Check (within same category)
    let bestMatch: CognitiveMemory | undefined = undefined;
    let highestSim = 0;

    for (const item of active) {
      if (item.category !== candidate.category) continue;

      const sim = this._calculateJaccardSimilarity(candidate.text, item.text);
      if (sim > highestSim) {
        highestSim = sim;
        bestMatch = item;
      }
    }

    if (bestMatch && highestSim >= 0.85) {
      const sameValue = this._areValuesEqual(candidate.value, bestMatch.value);
      if (sameValue) {
        return {
          isDuplicate: true,
          action: "reinforce",
          existingMemory: bestMatch,
          similarityScore: highestSim,
        };
      } else {
        return {
          isDuplicate: false,
          action: "contradict",
          existingMemory: bestMatch,
          similarityScore: highestSim,
        };
      }
    }

    return {
      isDuplicate: false,
      action: "create",
      similarityScore: highestSim,
    };
  }

  /**
   * Applies reinforcement to an existing memory:
   * - Increments reinforcementCount & usageCount
   * - Boosts confidence (up to 1.0)
   * - Updates lastUsedAt & updatedAt
   */
  public reinforceMemory(
    existing: CognitiveMemory,
    reinforcingSignal?: CognitiveMemory
  ): CognitiveMemory {
    const now = new Date().toISOString();
    const updatedConfidence = Math.min(1.0, Number((existing.confidence + 0.05).toFixed(2)));
    const updatedImportance = Math.min(
      5,
      Math.max(existing.importance, reinforcingSignal?.importance || existing.importance)
    );

    return {
      ...existing,
      confidence: updatedConfidence,
      importance: updatedImportance,
      usageCount: existing.usageCount + 1,
      reinforcementCount: existing.reinforcementCount + 1,
      lastUsedAt: now,
      updatedAt: now,
      expiresAt: reinforcingSignal?.expiresAt || existing.expiresAt,
    };
  }

  /**
   * Helper to check equality of memory values (primitives or JSON objects).
   */
  private _areValuesEqual(a: any, b: any): boolean {
    if (a === b) return true;
    if (typeof a !== typeof b) return false;
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }

  /**
   * Calculates word-level Jaccard similarity between two text strings.
   */
  private _calculateJaccardSimilarity(textA: string, textB: string): number {
    const tokenize = (t: string) =>
      new Set(
        t
          .toLowerCase()
          .replace(/[^\w\s]/g, "")
          .split(/\s+/)
          .filter((w) => w.length > 2)
      );

    const setA = tokenize(textA);
    const setB = tokenize(textB);

    if (setA.size === 0 || setB.size === 0) return 0;

    let intersectionCount = 0;
    for (const item of setA) {
      if (setB.has(item)) {
        intersectionCount++;
      }
    }

    const unionSize = setA.size + setB.size - intersectionCount;
    return unionSize === 0 ? 0 : intersectionCount / unionSize;
  }
}

export const deduplicationEngine = new DeduplicationEngine();
