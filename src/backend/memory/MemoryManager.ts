/**
 * MYRAA — MemoryManager (Phase 2)
 *
 * Full memory management API. Replaces the Phase 1 thin facade.
 *
 * Methods:
 *   createMemory      — create with dedup check, returns created/merged record
 *   getMemory         — fetch single by id
 *   listMemories      — all active memories (excludes archived & expired)
 *   searchMemories    — keyword + category + ranked search
 *   updateMemory      — partial update (text, importance, confidence, status, key)
 *   deleteMemory      — permanent removal from disk
 *   mergeMemory       — merge two records into one, delete the source
 *   archiveMemory     — soft-delete (status = "archived")
 *   revalidateMemory  — clear needs_revalidation flag (set to active)
 *   getRelevantContext — ranked, char-budget-bounded context string for Gemini
 *
 * Also re-exports raw server_memory.ts functions so existing callers are
 * backward-compatible without import changes.
 */

import {
  loadMemories,
  saveMemories,
  formatSystemInstructionsWithMemories,
  processConversationSlice,
} from "../../../server_memory.ts";
import { MemoryStore, memoryStore } from "./MemoryStore.ts";
import { searchMemories as _searchMemories, filterForContext } from "./MemorySearch.ts";
import { findSimilar } from "./MemoryDeduplicator.ts";
import { makeEnhancedMemory } from "./MemoryExtractor.ts";
import type {
  EnhancedMemory,
  MemorySearchOptions,
  ContextOptions,
  Importance,
  Confidence,
  MemoryStatus,
  MemorySource,
} from "./MemoryTypes.ts";
import type { Memory, MemoryCategory } from "../../lib/memoryTypes.ts";

// ---------------------------------------------------------------------------
// Category display labels for context formatting
// ---------------------------------------------------------------------------
const CATEGORY_LABELS: Record<MemoryCategory, string> = {
  identity:     "Identity",
  preference:   "Preferences",
  skill:        "Skills",
  goal:         "Goals",
  project:      "Projects",
  task:         "Tasks",
  decision:     "Important Decisions",
  relationship: "Relationships",
  emotional:    "Milestones",
  behavior:     "Behaviors & Habits",
  fact:         "General Facts",
};

// Ordered for display in system prompt
const CATEGORY_ORDER: MemoryCategory[] = [
  "identity", "preference", "skill", "goal", "project",
  "task", "decision", "relationship", "emotional", "behavior", "fact",
];

// ---------------------------------------------------------------------------
// MemoryManager
// ---------------------------------------------------------------------------

export class MemoryManager {
  private store: MemoryStore;

  constructor(store: MemoryStore = memoryStore) {
    this.store = store;
  }

  // ── Read operations ──────────────────────────────────────────────────────

  /** Load all memories from disk (including archived). */
  async load(): Promise<EnhancedMemory[]> {
    return this.store.load();
  }

  /** Fetch a single memory by id. Returns undefined if not found. */
  async getMemory(id: string): Promise<EnhancedMemory | undefined> {
    const all = await this.store.load();
    return all.find((m) => m.id === id);
  }

  /**
   * List active (and optionally needs_revalidation) memories.
   * Excludes archived and expired records.
   */
  async listMemories(opts: { includeNeedsRevalidation?: boolean } = {}): Promise<EnhancedMemory[]> {
    const all = await this.store.load();
    return all.filter((m) => {
      if (MemoryStore.isExpired(m)) return false;
      if (m.status === "archived") return false;
      if (m.status === "needs_revalidation" && !opts.includeNeedsRevalidation) return false;
      return true;
    });
  }

  /**
   * Search memories by keyword, category, importance, confidence, source.
   * Returns ranked results (highest relevance first).
   */
  async searchMemories(opts: MemorySearchOptions): Promise<EnhancedMemory[]> {
    const all = await this.store.load();
    return _searchMemories(all, opts);
  }

  // ── Write operations ─────────────────────────────────────────────────────

  /**
   * Create a new memory with full deduplication check.
   *
   * - If an exact match exists: silently update the existing record's text+timestamp.
   * - If a similar match exists: merge text, keep existing record.
   * - If a conflict exists: mark existing as needs_revalidation, add new with low confidence.
   * - If no match: add as new record.
   *
   * Returns the final record (created or updated existing).
   */
  async createMemory(data: {
    category: MemoryCategory;
    text: string;
    key?: string;
    source?: MemorySource;
    importance?: Importance;
    confidence?: Confidence;
    expiresAt?: string;
  }): Promise<EnhancedMemory> {
    const all = await this.store.load();
    const dedup = findSimilar(all, { category: data.category, text: data.text, key: data.key });

    if (dedup.match === "exact" && dedup.existing) {
      // Update the existing record
      const updated: EnhancedMemory = {
        ...dedup.existing,
        text: data.text,
        updatedAt: MemoryStore.now(),
        // Prefer explicitly-passed values over existing
        importance: data.importance ?? dedup.existing.importance,
        confidence: data.confidence ?? dedup.existing.confidence,
      };
      const newList = all.map((m) => (m.id === updated.id ? updated : m));
      await this.store.save(newList);
      return updated;
    }

    if (dedup.match === "similar" && dedup.existing) {
      // Merge into existing record
      const { mergeText } = await import("./MemoryDeduplicator.ts");
      const mergedText = mergeText(dedup.existing.text, data.text, dedup.score);
      const merged: EnhancedMemory = {
        ...dedup.existing,
        text: mergedText,
        updatedAt: MemoryStore.now(),
      };
      const newList = all.map((m) => (m.id === merged.id ? merged : m));
      await this.store.save(newList);
      return merged;
    }

    if (dedup.match === "conflict" && dedup.existing) {
      // Mark existing as needs_revalidation
      const newList = all.map((m) =>
        m.id === dedup.existing!.id
          ? { ...m, status: "needs_revalidation" as MemoryStatus, updatedAt: MemoryStore.now() }
          : m,
      );
      // Add new with low confidence
      const newRecord = makeEnhancedMemory({
        ...data,
        confidence: "low",
        source: data.source ?? "system_generated",
      });
      newList.push(newRecord);
      await this.store.save(newList);
      return newRecord;
    }

    // No match — add new
    const newRecord = makeEnhancedMemory(data);
    all.push(newRecord);
    await this.store.save(all);
    return newRecord;
  }

  /**
   * Partial update of an existing memory.
   * Only provided fields are changed; others are preserved.
   */
  async updateMemory(
    id: string,
    patch: {
      text?: string;
      key?: string;
      importance?: Importance;
      confidence?: Confidence;
      status?: MemoryStatus;
      expiresAt?: string;
    },
  ): Promise<EnhancedMemory | undefined> {
    const all = await this.store.load();
    const idx = all.findIndex((m) => m.id === id);
    if (idx === -1) return undefined;

    const updated: EnhancedMemory = {
      ...all[idx],
      ...patch,
      updatedAt: MemoryStore.now(),
    };
    all[idx] = updated;
    await this.store.save(all);
    return updated;
  }

  /**
   * Permanently delete a memory from disk.
   * After deletion the record will NOT appear in context or search.
   */
  async deleteMemory(id: string): Promise<boolean> {
    const all = await this.store.load();
    const before = all.length;
    const filtered = all.filter((m) => m.id !== id);
    if (filtered.length === before) return false;
    await this.store.save(filtered);
    return true;
  }

  /**
   * Merge sourceId into targetId:
   *   - targetId.text is replaced with merged text
   *   - sourceId is deleted
   *   - targetId.updatedAt is refreshed
   */
  async mergeMemory(targetId: string, sourceId: string): Promise<EnhancedMemory | undefined> {
    const all = await this.store.load();
    const target = all.find((m) => m.id === targetId);
    const source = all.find((m) => m.id === sourceId);
    if (!target || !source) return undefined;

    const { mergeText } = await import("./MemoryDeduplicator.ts");
    const mergedText = mergeText(target.text, source.text, 0.5); // unknown similarity
    const merged: EnhancedMemory = {
      ...target,
      text: mergedText,
      updatedAt: MemoryStore.now(),
    };

    const newList = all
      .filter((m) => m.id !== sourceId)
      .map((m) => (m.id === targetId ? merged : m));
    await this.store.save(newList);
    return merged;
  }

  /**
   * Soft-delete: set status to "archived".
   * Archived memories are excluded from search and context retrieval.
   */
  async archiveMemory(id: string): Promise<EnhancedMemory | undefined> {
    return this.updateMemory(id, { status: "archived" });
  }

  /**
   * Clear a needs_revalidation flag, returning the memory to active status.
   * Optionally bump confidence to "medium" if it was "low".
   */
  async revalidateMemory(
    id: string,
    opts: { promoteConfidence?: boolean } = {},
  ): Promise<EnhancedMemory | undefined> {
    const mem = await this.getMemory(id);
    if (!mem) return undefined;
    const patch: Parameters<typeof this.updateMemory>[1] = { status: "active" };
    if (opts.promoteConfidence && mem.confidence === "low") {
      patch.confidence = "medium";
    }
    return this.updateMemory(id, patch);
  }

  // ── Context generation ───────────────────────────────────────────────────

  /**
   * Build the memory context string for injection into the Gemini system prompt.
   *
   * Algorithm:
   *   1. Filter and rank memories via filterForContext()
   *   2. Group by category in CATEGORY_ORDER
   *   3. Write entries line-by-line, stopping when contextCharBudget is reached
   *   4. Update lastAccessedAt for all memories included in the context
   *
   * @param opts.query             Optional current-turn hint for keyword ranking
   * @param opts.contextCharBudget Max characters to include (default 2000)
   * @param opts.touchLastAccessed Update lastAccessedAt (default true)
   */
  async getRelevantContext(opts: ContextOptions = {}): Promise<string> {
    const { query, contextCharBudget = 2000, touchLastAccessed = true } = opts;

    const all = await this.store.load();
    const ranked = filterForContext(all, query);

    if (ranked.length === 0) {
      return (
        "\n\n=== MYRAA MEMORY CORE ===\n" +
        "You do not possess any historic recollections of this companion yet. " +
        "As you speak, pay deep attention to who they are, their projects, " +
        "relationships, and habits so you naturally grow closer over time.\n" +
        "=========================\n"
      );
    }

    // Group by category
    const grouped: Partial<Record<MemoryCategory, EnhancedMemory[]>> = {};
    for (const m of ranked) {
      if (!grouped[m.category]) grouped[m.category] = [];
      grouped[m.category]!.push(m);
    }

    // Build header
    const header =
      "\n\n=== MYRAA PERSISTENT MEMORY CORE (RECOLLECTIONS) ===\n" +
      "You have spoken with this user for a long duration. Below are your persistent recollections.\n" +
      "CRITICAL PRINCIPLES: Integrate memories naturally and casually as a true friend would. " +
      "NEVER say 'According to my memory files' or 'As you told me'. " +
      "Memories marked [needs review] should be used cautiously.\n\n" +
      "Sandeep\n";

    let block = header;
    const includedIds: string[] = [];

    for (const cat of CATEGORY_ORDER) {
      const entries = grouped[cat];
      if (!entries || entries.length === 0) continue;

      const catLine = `├── ${CATEGORY_LABELS[cat]}\n`;
      const entryLines = entries.map((m) => {
        const flag = m.status === "needs_revalidation" ? " [needs review]" : "";
        return `│   - ${m.text}${flag}\n`;
      });

      // Check budget before adding this category block
      const blockCandidate = catLine + entryLines.join("");
      if (block.length + blockCandidate.length + 30 > contextCharBudget) {
        // Add as many entries as fit
        let partial = catLine;
        for (const line of entryLines) {
          if (block.length + partial.length + line.length + 30 > contextCharBudget) break;
          partial += line;
          const entryId = entries[entryLines.indexOf(line)]?.id;
          if (entryId) includedIds.push(entryId);
        }
        if (partial !== catLine) block += partial;
        break; // Budget exhausted
      }

      block += blockCandidate;
      entries.forEach((m) => includedIds.push(m.id));
    }

    block += "====================================================\n";

    // Truncate hard if still somehow over budget
    if (block.length > contextCharBudget + header.length) {
      block = block.substring(0, contextCharBudget + header.length);
    }

    // Update lastAccessedAt for included memories
    if (touchLastAccessed && includedIds.length > 0) {
      const now = MemoryStore.now();
      const idSet = new Set(includedIds);
      const updated = all.map((m) =>
        idSet.has(m.id) ? { ...m, lastAccessedAt: now } : m,
      );
      await this.store.save(updated).catch(() => {}); // best-effort
    }

    return block;
  }

  // ── Compatibility shims ──────────────────────────────────────────────────

  /** @deprecated Use getRelevantContext() + buildSystemInstructions() instead. */
  formatInstructions(baseInstruction: string, memories: Memory[]): string {
    return formatSystemInstructionsWithMemories(baseInstruction, memories);
  }

  /** Persist the full memory list (legacy path). */
  async save(memories: EnhancedMemory[]): Promise<void> {
    return this.store.save(memories);
  }

  /**
   * Run background memory consolidation over a dialogue slice.
   * Returns the updated memory array, or null if nothing changed.
   * @deprecated Use MemoryExtractor.extractAndApply() for full deduplication.
   */
  async processSlice(
    apiKey: string,
    dialogueHistory: { role: string; text: string }[],
  ): Promise<Memory[] | null> {
    return processConversationSlice(apiKey, dialogueHistory);
  }
}

// Module-level singleton
export const memoryManager = new MemoryManager();

// Re-export base functions for backward compatibility
export {
  loadMemories,
  saveMemories,
  formatSystemInstructionsWithMemories,
  processConversationSlice,
};
export type { Memory, EnhancedMemory };
