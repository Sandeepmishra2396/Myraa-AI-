/**
 * MYRAA — MemorySearch
 *
 * Pure functions for searching and ranking EnhancedMemory arrays.
 *
 * Scoring model (additive, higher = more relevant):
 *   importance  high=3  medium=2  low=1
 *   confidence  high=3  medium=2  low=1
 *   recency     linear decay from 3→0 over 90 days (capped at 0)
 *   keyword     +1 per query word found in text+key (capped at 3)
 *
 * Maximum possible score = 3 + 3 + 3 + 3 = 12
 *
 * Filtering:
 *   - status must be "active" (unless includeArchived / includeNeedsRevalidation)
 *   - expiresAt must be absent or in the future
 *   - category filter applied if provided
 *   - minImportance / minConfidence applied if provided
 *
 * No disk I/O. No side effects.
 */

import type { EnhancedMemory, Importance, Confidence, MemorySearchOptions } from "./MemoryTypes.ts";
import { MemoryStore } from "./MemoryStore.ts";

// ---------------------------------------------------------------------------
// Score helpers
// ---------------------------------------------------------------------------

const IMPORTANCE_SCORE: Record<Importance, number> = {
  low: 1,
  medium: 2,
  high: 3,
};

const CONFIDENCE_SCORE: Record<Confidence, number> = {
  low: 1,
  medium: 2,
  high: 3,
};

const MIN_IMPORTANCE_RANK: Record<Importance, number> = {
  low: 1,
  medium: 2,
  high: 3,
};

const RECENCY_MAX_DAYS = 90;

function recencyScore(updatedAt: string): number {
  const ageDays = (Date.now() - new Date(updatedAt).getTime()) / (1000 * 60 * 60 * 24);
  if (ageDays >= RECENCY_MAX_DAYS) return 0;
  return 3 * (1 - ageDays / RECENCY_MAX_DAYS);
}

function keywordScore(memory: EnhancedMemory, queryWords: string[]): number {
  if (queryWords.length === 0) return 0;
  const haystack = `${memory.text} ${memory.key ?? ""} ${memory.category}`.toLowerCase();
  let hits = 0;
  for (const word of queryWords) {
    if (haystack.includes(word)) hits++;
  }
  return Math.min(hits, 3);
}

function totalScore(memory: EnhancedMemory, queryWords: string[]): number {
  return (
    IMPORTANCE_SCORE[memory.importance] +
    CONFIDENCE_SCORE[memory.confidence] +
    recencyScore(memory.updatedAt) +
    keywordScore(memory, queryWords)
  );
}

// ---------------------------------------------------------------------------
// Main search function
// ---------------------------------------------------------------------------

/**
 * Search and rank memories according to the provided options.
 * Returns a sorted array (highest relevance first), capped at opts.limit.
 */
export function searchMemories(
  memories: EnhancedMemory[],
  opts: MemorySearchOptions = {},
): EnhancedMemory[] {
  const {
    query,
    categories,
    minImportance,
    minConfidence,
    source,
    limit = 20,
    includeArchived = false,
    includeNeedsRevalidation = true,
  } = opts;

  const queryWords = query
    ? query.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2)
    : [];

  const minImportanceRank = minImportance ? MIN_IMPORTANCE_RANK[minImportance] : 0;
  const minConfidenceRank = minConfidence ? MIN_IMPORTANCE_RANK[minConfidence] : 0;

  const filtered = memories.filter((m) => {
    // Status filter
    if (m.status === "archived" && !includeArchived) return false;
    if (m.status === "needs_revalidation" && !includeNeedsRevalidation) return false;

    // Expiry filter
    if (MemoryStore.isExpired(m)) return false;

    // Category filter
    if (categories && categories.length > 0 && !categories.includes(m.category)) return false;

    // Importance filter
    if (minImportanceRank > 0 && IMPORTANCE_SCORE[m.importance] < minImportanceRank) return false;

    // Confidence filter
    if (minConfidenceRank > 0 && CONFIDENCE_SCORE[m.confidence] < minConfidenceRank) return false;

    // Source filter
    if (source && m.source !== source) return false;

    // Keyword filter: if query provided, memory must contain at least one word
    if (queryWords.length > 0) {
      const haystack = `${m.text} ${m.key ?? ""} ${m.category}`.toLowerCase();
      const hasAny = queryWords.some((w) => haystack.includes(w));
      if (!hasAny) return false;
    }

    return true;
  });

  // Sort by score descending
  const scored = filtered
    .map((m) => ({ memory: m, score: totalScore(m, queryWords) }))
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, limit).map((s) => s.memory);
}

/**
 * Filter memories suitable for context injection:
 *   - Only "active" status
 *   - Not expired
 *   - Ranked by importance + confidence + recency
 *   - Optionally hint with a query string for keyword relevance
 * Returns memories ready to format into the system prompt.
 */
export function filterForContext(
  memories: EnhancedMemory[],
  query?: string,
  limit = 50,
): EnhancedMemory[] {
  return searchMemories(memories, {
    query,
    includeArchived: false,
    includeNeedsRevalidation: true, // still show these but they're ranked lower
    limit,
  });
}
