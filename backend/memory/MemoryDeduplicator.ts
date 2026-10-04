/**
 * MYRAA — MemoryDeduplicator
 *
 * Pure functions for detecting whether a candidate memory duplicates, is
 * similar to, or conflicts with an existing memory.
 *
 * Matching hierarchy (evaluated in order, first hit wins):
 *   1. Key match  — same non-empty `key` AND same `category` → always "exact"
 *   2. Jaccard similarity on normalised text words:
 *        >= 0.9 → "exact"
 *        >= 0.7 → "similar"
 *   3. Category + first-40-chars prefix overlap → "similar"
 *   4. Same category, same key, clearly contradictory text → "conflict"
 *      (detected when: key match + Jaccard < 0.3 → content divergence)
 *   5. No match → "none"
 *
 * This module has NO side-effects and NO disk I/O.
 */

import type { EnhancedMemory } from "./MemoryTypes.ts";
import type { DeduplicationResult } from "./MemoryTypes.ts";

// ---------------------------------------------------------------------------
// Text normalisation helpers
// ---------------------------------------------------------------------------

/**
 * Normalise text to a Set of lowercase words, stripping punctuation.
 * Short stop-words (≤ 2 chars) are removed to reduce noise.
 */
function wordSet(text: string): Set<string> {
  const STOP_WORDS = new Set(["a", "an", "the", "is", "in", "of", "to", "it", "at", "on", "as", "by", "or"]);
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
  return new Set(words);
}

/**
 * Word-level Jaccard similarity between two strings.
 * Returns a value in [0, 1] where 1 = identical word sets.
 */
export function jaccardSimilarity(a: string, b: string): number {
  const setA = wordSet(a);
  const setB = wordSet(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersectionSize = 0;
  for (const w of setA) {
    if (setB.has(w)) intersectionSize++;
  }
  const unionSize = setA.size + setB.size - intersectionSize;
  return intersectionSize / unionSize;
}

/**
 * First 40 non-whitespace characters of the normalised text.
 * Used as a rough category+prefix check for "similar" detection.
 */
function prefix40(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim().substring(0, 40);
}

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------
const EXACT_THRESHOLD = 0.9;
const SIMILAR_THRESHOLD = 0.7;
const CONFLICT_THRESHOLD = 0.3; // Jaccard < 0.3 with same key = divergent

// ---------------------------------------------------------------------------
// Main API
// ---------------------------------------------------------------------------

/**
 * Compare a candidate memory text against a list of existing memories.
 * Returns the best match found, or { match: "none", score: 0 } if no match.
 *
 * Only memories in `active` or `needs_revalidation` status are considered
 * (archived memories are invisible to deduplication).
 */
export function findSimilar(
  existing: EnhancedMemory[],
  candidate: { category: string; text: string; key?: string },
): DeduplicationResult {
  const activeMemories = existing.filter(
    (m) => m.status !== "archived" && m.category === candidate.category,
  );

  let bestResult: DeduplicationResult = { match: "none", score: 0 };

  for (const mem of activeMemories) {
    // ── 1. Key match (same category already filtered above) ──────────────
    const hasKey = candidate.key && mem.key;
    if (hasKey && candidate.key === mem.key) {
      const score = jaccardSimilarity(candidate.text, mem.text);
      // Key match + very low text similarity = conflict (same topic, different content)
      if (score < CONFLICT_THRESHOLD) {
        return { match: "conflict", existing: mem, score };
      }
      // Key match = treat as exact (will update existing)
      return { match: "exact", existing: mem, score: Math.max(score, EXACT_THRESHOLD) };
    }

    // ── 2. Jaccard text similarity ────────────────────────────────────────
    const score = jaccardSimilarity(candidate.text, mem.text);

    if (score >= EXACT_THRESHOLD) {
      return { match: "exact", existing: mem, score };
    }

    if (score >= SIMILAR_THRESHOLD && score > bestResult.score) {
      bestResult = { match: "similar", existing: mem, score };
    }

    // ── 3. Category + prefix overlap ──────────────────────────────────────
    if (
      score < SIMILAR_THRESHOLD &&
      prefix40(candidate.text) === prefix40(mem.text) &&
      bestResult.match === "none"
    ) {
      bestResult = { match: "similar", existing: mem, score };
    }
  }

  return bestResult;
}

/**
 * Merge the text of an incoming similar memory into an existing one.
 * Rules:
 *   - If the incoming text is substantially longer, prefer the longer version.
 *   - If very similar (score >= 0.85), keep the existing text (avoid trivial churn).
 *   - Otherwise, use incoming text (it is the more recent statement).
 * Does NOT append repetitive notes.
 */
export function mergeText(
  existingText: string,
  incomingText: string,
  score: number,
): string {
  if (score >= 0.85) {
    // Near-identical — keep existing, no change
    return existingText;
  }
  const existingWords = existingText.split(/\s+/).length;
  const incomingWords = incomingText.split(/\s+/).length;
  if (incomingWords > existingWords * 1.5) {
    // Incoming is substantially more detailed
    return incomingText;
  }
  // Use incoming (more recent statement)
  return incomingText;
}
