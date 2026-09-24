/**
 * MYRAA — MemoryStore
 *
 * Single source-of-truth for reading and writing memories.json.
 * Responsibilities:
 *   • load()   — read from disk, migrate old records by adding defaults
 *   • save()   — write to disk atomically (temp file + rename)
 *   • In-memory cache — avoids redundant disk reads within the same process
 *
 * This file wraps the existing loadMemories / saveMemories functions from
 * server_memory.ts so that all disk access is co-located and the migration
 * logic has exactly one home.
 *
 * There is ONE memories.json file. No second database. No duplicate cache.
 */

import fs from "fs/promises";
import path from "path";
import { dataFile } from "../../../server_paths.ts";
import type { Memory } from "../../lib/memoryTypes.ts";
import type {
  EnhancedMemory,
  Importance,
  Confidence,
  MemorySource,
  MemoryStatus,
} from "./MemoryTypes.ts";

const MEMORY_FILE = dataFile("memories.json");

// ---------------------------------------------------------------------------
// Default values for missing fields (migration from Phase 1 records)
// ---------------------------------------------------------------------------
const DEFAULTS = {
  importance: "medium" as Importance,
  confidence: "medium" as Confidence,
  source: "conversation_extracted" as MemorySource,
  status: "active" as MemoryStatus,
} as const;

/**
 * Migrate a raw Memory or partial EnhancedMemory record to a full
 * EnhancedMemory object by filling in defaults for any missing fields.
 * Existing fields are preserved as-is.
 */
export function migrateRecord(raw: Memory): EnhancedMemory {
  const r = raw as Partial<EnhancedMemory>;
  return {
    id: raw.id,
    category: raw.category,
    text: raw.text,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    key: r.key,
    importance: r.importance ?? DEFAULTS.importance,
    confidence: r.confidence ?? DEFAULTS.confidence,
    source: r.source ?? DEFAULTS.source,
    lastAccessedAt: r.lastAccessedAt,
    expiresAt: r.expiresAt,
    status: r.status ?? DEFAULTS.status,
    deviceId: r.deviceId,
    deviceType: r.deviceType ?? "desktop",
    version: typeof r.version === "number" && r.version > 0 ? r.version : 1,
    lastSyncedAt: r.lastSyncedAt,
    clientMutationId: r.clientMutationId,
  };
}

// ---------------------------------------------------------------------------
// In-process cache
// ---------------------------------------------------------------------------
let _cache: EnhancedMemory[] | null = null;
let _cacheWriteTime: number = 0;

function invalidateCache(): void {
  _cache = null;
  _cacheWriteTime = 0;
}

// ---------------------------------------------------------------------------
// MemoryStore
// ---------------------------------------------------------------------------

export class MemoryStore {
  /**
   * Load all memories from disk (with in-process caching).
   * Old Phase 1 records without Phase 2 fields are transparently migrated.
   * Never throws — returns [] on any error.
   */
  async load(): Promise<EnhancedMemory[]> {
    if (_cache !== null) {
      return _cache;
    }
    try {
      let data = await fs.readFile(MEMORY_FILE, "utf-8");
      data = data.replace(/^\uFEFF/, "").trim();
      const raw: Memory[] = data ? JSON.parse(data) : [];
      const migrated = raw.map(migrateRecord);
      _cache = migrated;
      return migrated;
    } catch (err: any) {
      if (err.code === "ENOENT") {
        _cache = [];
        return [];
      }
      console.error("[MemoryStore] Error loading memories.json:", err);
      return [];
    }
  }

  /**
   * Persist the full memory list atomically.
   * Writes to a .tmp file then renames so the JSON is never half-written.
   * Invalidates the in-process cache after each save.
   */
  async save(memories: EnhancedMemory[]): Promise<void> {
    const tmpFile = MEMORY_FILE + ".tmp";
    try {
      await fs.writeFile(tmpFile, JSON.stringify(memories, null, 2), "utf-8");
      await fs.rename(tmpFile, MEMORY_FILE);
      _cache = memories;
      _cacheWriteTime = Date.now();
      console.log(`[MemoryStore] Saved ${memories.length} memories.`);
    } catch (err) {
      console.error("[MemoryStore] Error saving memories:", err);
      // Clean up temp file if rename failed
      try {
        await fs.unlink(tmpFile);
      } catch {
        /* ignore cleanup error */
      }
    }
  }

  /** Forcibly clear the in-process cache (useful in tests). */
  clearCache(): void {
    invalidateCache();
  }

  /**
   * Check whether a memory is currently expired.
   * Returns true if expiresAt is set AND is in the past.
   */
  static isExpired(memory: EnhancedMemory): boolean {
    if (!memory.expiresAt) return false;
    return new Date(memory.expiresAt) < new Date();
  }

  /**
   * Check whether a memory should be flagged needs_revalidation based on age.
   * Rule: conversation_extracted memories older than 180 days → revalidation.
   * No other category-based expiration is applied automatically.
   */
  static shouldRevalidate(memory: EnhancedMemory): boolean {
    if (memory.source !== "conversation_extracted") return false;
    if (memory.status !== "active") return false;
    const age = Date.now() - new Date(memory.updatedAt).getTime();
    const days180 = 180 * 24 * 60 * 60 * 1000;
    return age > days180;
  }

  /**
   * Generate a new unique memory ID.
   */
  static newId(): string {
    return Math.random().toString(36).substring(2, 11);
  }

  /**
   * Current ISO8601 timestamp string.
   */
  static now(): string {
    return new Date().toISOString();
  }
}

/**
 * Module-level singleton for use by MemoryManager and other modules.
 * Tests can use `new MemoryStore()` with a different backing for isolation.
 */
export const memoryStore = new MemoryStore();
