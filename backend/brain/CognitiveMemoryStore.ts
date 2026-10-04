/**
 * MYRAA — Phase 18: Adaptive Personal Brain
 * Cognitive Memory Store
 *
 * Provides atomic, thread-safe, resilient persistence for cognitive memories
 * in DATA_DIR/cognitive_memories.json and command patterns in DATA_DIR/command_patterns.json.
 * Handles TTL expiration checks, confidence/importance filtering, and frequency tracking.
 */

import * as fs from "fs";
import * as path from "path";
import { dataFile, DATA_DIR } from "../server_paths.ts";
import type {
  CognitiveCategory,
  CognitiveMemory,
  CognitiveMemoryStatus,
  CommandPatternRecord,
} from "./CognitiveTypes.ts";

export class CognitiveMemoryStore {
  private _memoryFilePath: string;
  private _patternFilePath: string;
  private _cachedMemories: CognitiveMemory[] | null = null;
  private _cachedPatterns: CommandPatternRecord[] | null = null;

  constructor(
    memoryFile = dataFile("cognitive_memories.json"),
    patternFile = dataFile("command_patterns.json")
  ) {
    this._memoryFilePath = memoryFile;
    this._patternFilePath = patternFile;
  }

  // ── Memory Persistence ───────────────────────────────────────────────────

  /**
   * Load all memories from disk. Automatically flags expired records.
   */
  public async loadMemories(): Promise<CognitiveMemory[]> {
    if (this._cachedMemories) {
      this._expireMemories(this._cachedMemories);
      return [...this._cachedMemories];
    }

    try {
      if (!fs.existsSync(this._memoryFilePath)) {
        this._cachedMemories = [];
        return [];
      }

      let content = fs.readFileSync(this._memoryFilePath, "utf8");
      // Remove UTF-8 BOM if present
      if (content.charCodeAt(0) === 0xfeff) {
        content = content.slice(1);
      }

      if (!content.trim()) {
        this._cachedMemories = [];
        return [];
      }

      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        this._cachedMemories = parsed;
        const expiredCount = this._expireMemories(this._cachedMemories);
        if (expiredCount > 0) {
          await this._persistMemories(this._cachedMemories);
        }
        return [...this._cachedMemories];
      }
      this._cachedMemories = [];
      return [];
    } catch (err) {
      console.warn(`[CognitiveMemoryStore] Failed to parse ${this._memoryFilePath}, starting empty:`, err);
      this._cachedMemories = [];
      return [];
    }
  }

  /**
   * Atomically save a memory record (insert or update).
   */
  public async saveMemory(memory: CognitiveMemory): Promise<CognitiveMemory> {
    const list = await this.loadMemories();
    const existingIdx = list.findIndex((m) => m.id === memory.id);

    const updatedMemory = {
      ...memory,
      updatedAt: new Date().toISOString(),
    };

    if (existingIdx >= 0) {
      list[existingIdx] = updatedMemory;
    } else {
      list.push(updatedMemory);
    }

    this._cachedMemories = list;
    await this._persistMemories(list);
    return { ...updatedMemory };
  }

  /**
   * Fetch a single memory by ID.
   */
  public async getMemory(id: string): Promise<CognitiveMemory | null> {
    const list = await this.loadMemories();
    const match = list.find((m) => m.id === id);
    return match ? { ...match } : null;
  }

  /**
   * Fetch active memory by exact dot-key.
   */
  public async getActiveMemoryByKey(key: string): Promise<CognitiveMemory | null> {
    const list = await this.loadMemories();
    const match = list.find((m) => m.key === key && m.status === "active");
    return match ? { ...match } : null;
  }

  /**
   * Get all active memories, optionally filtered by category and minConfidence.
   */
  public async getActiveMemories(
    category?: CognitiveCategory,
    minConfidence = 0.5
  ): Promise<CognitiveMemory[]> {
    const list = await this.loadMemories();
    return list.filter((m) => {
      if (m.status !== "active") return false;
      if (category && m.category !== category) return false;
      if (m.confidence < minConfidence) return false;
      return true;
    });
  }

  /**
   * List memories with arbitrary filters.
   */
  public async listMemories(filter?: {
    category?: CognitiveCategory;
    status?: CognitiveMemoryStatus;
    minConfidence?: number;
  }): Promise<CognitiveMemory[]> {
    const list = await this.loadMemories();
    return list.filter((m) => {
      if (filter?.category && m.category !== filter.category) return false;
      if (filter?.status && m.status !== filter.status) return false;
      if (typeof filter?.minConfidence === "number" && m.confidence < filter.minConfidence) return false;
      return true;
    });
  }

  /**
   * Record usage of a memory (bumps usageCount and lastUsedAt).
   */
  public async recordUsage(id: string): Promise<void> {
    const list = await this.loadMemories();
    const item = list.find((m) => m.id === id);
    if (item && item.status === "active") {
      item.usageCount = (item.usageCount || 0) + 1;
      item.lastUsedAt = new Date().toISOString();
      item.updatedAt = new Date().toISOString();
      await this._persistMemories(list);
    }
  }

  /**
   * Marks a memory as superseded by a newer winner.
   */
  public async supersedeMemory(oldId: string, newId: string, reason: string): Promise<void> {
    const list = await this.loadMemories();
    const oldItem = list.find((m) => m.id === oldId);
    if (oldItem) {
      oldItem.status = "superseded";
      oldItem.supersededBy = newId;
      oldItem.updatedAt = new Date().toISOString();
      const history = oldItem.contradictionHistory || [];
      history.push(`[${new Date().toISOString()}] Superseded by ${newId}: ${reason}`);
      oldItem.contradictionHistory = history;
      await this._persistMemories(list);
    }
  }

  /**
   * Deletes a memory permanently.
   */
  public async deleteMemory(id: string): Promise<boolean> {
    const list = await this.loadMemories();
    const initialLen = list.length;
    const filtered = list.filter((m) => m.id !== id);
    if (filtered.length !== initialLen) {
      this._cachedMemories = filtered;
      await this._persistMemories(filtered);
      return true;
    }
    return false;
  }

  /**
   * Clears all stored memories.
   */
  public async clear(): Promise<void> {
    this._cachedMemories = [];
    await this._persistMemories([]);
  }

  // ── Command Pattern Frequency Tracking ────────────────────────────────────

  /**
   * Load all command patterns.
   */
  public async loadPatterns(): Promise<CommandPatternRecord[]> {
    if (this._cachedPatterns) {
      return [...this._cachedPatterns];
    }

    try {
      if (!fs.existsSync(this._patternFilePath)) {
        this._cachedPatterns = [];
        return [];
      }

      let content = fs.readFileSync(this._patternFilePath, "utf8");
      if (content.charCodeAt(0) === 0xfeff) {
        content = content.slice(1);
      }
      if (!content.trim()) {
        this._cachedPatterns = [];
        return [];
      }

      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        this._cachedPatterns = parsed;
        return [...this._cachedPatterns];
      }
      this._cachedPatterns = [];
      return [];
    } catch {
      this._cachedPatterns = [];
      return [];
    }
  }

  /**
   * Records a command execution and updates its pattern frequency.
   */
  public async recordCommandPattern(
    toolName: string,
    target: string,
    contextHints?: Record<string, any>
  ): Promise<CommandPatternRecord> {
    const patterns = await this.loadPatterns();
    const patternKey = `${toolName}:${target.toLowerCase().trim()}`;
    const now = new Date().toISOString();

    const existingIdx = patterns.findIndex((p) => p.patternKey === patternKey);
    let record: CommandPatternRecord;

    if (existingIdx >= 0) {
      record = {
        ...patterns[existingIdx],
        frequency: patterns[existingIdx].frequency + 1,
        lastExecutedAt: now,
        contextHints: {
          ...(patterns[existingIdx].contextHints || {}),
          ...(contextHints || {}),
        },
      };
      patterns[existingIdx] = record;
    } else {
      record = {
        patternKey,
        toolName,
        target,
        frequency: 1,
        firstSeenAt: now,
        lastExecutedAt: now,
        contextHints,
      };
      patterns.push(record);
    }

    this._cachedPatterns = patterns;
    await this._persistPatterns(patterns);
    return { ...record };
  }

  /**
   * Retrieves frequently used command patterns (frequency >= minFrequency).
   */
  public async getFrequentCommandPatterns(minFrequency = 3): Promise<CommandPatternRecord[]> {
    const patterns = await this.loadPatterns();
    return patterns
      .filter((p) => p.frequency >= minFrequency)
      .sort((a, b) => b.frequency - a.frequency);
  }

  /**
   * Clears command patterns.
   */
  public async clearCommandPatterns(): Promise<void> {
    this._cachedPatterns = [];
    await this._persistPatterns([]);
  }

  // ── Internal Helpers ─────────────────────────────────────────────────────

  /**
   * Flags expired memories in-place and returns number of newly expired items.
   */
  private _expireMemories(memories: CognitiveMemory[]): number {
    const now = Date.now();
    let count = 0;
    for (const m of memories) {
      if (m.status === "active" && m.expiresAt) {
        const exp = new Date(m.expiresAt).getTime();
        if (now > exp) {
          m.status = "expired";
          m.updatedAt = new Date().toISOString();
          count++;
        }
      }
    }
    return count;
  }

  /**
   * Atomic file write for memories.
   */
  private async _persistMemories(memories: CognitiveMemory[]): Promise<void> {
    const dir = path.dirname(this._memoryFilePath);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {}

    const tmpFile = `${this._memoryFilePath}.${Date.now()}.tmp`;
    const json = JSON.stringify(memories, null, 2);
    fs.writeFileSync(tmpFile, json, "utf8");
    try {
      fs.renameSync(tmpFile, this._memoryFilePath);
    } catch {
      // Windows file lock fallback: copy and unlink
      fs.copyFileSync(tmpFile, this._memoryFilePath);
      try {
        fs.unlinkSync(tmpFile);
      } catch {}
    }
  }

  /**
   * Atomic file write for command patterns.
   */
  private async _persistPatterns(patterns: CommandPatternRecord[]): Promise<void> {
    const dir = path.dirname(this._patternFilePath);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {}

    const tmpFile = `${this._patternFilePath}.${Date.now()}.tmp`;
    const json = JSON.stringify(patterns, null, 2);
    fs.writeFileSync(tmpFile, json, "utf8");
    try {
      fs.renameSync(tmpFile, this._patternFilePath);
    } catch {
      fs.copyFileSync(tmpFile, this._patternFilePath);
      try {
        fs.unlinkSync(tmpFile);
      } catch {}
    }
  }
}

export const cognitiveMemoryStore = new CognitiveMemoryStore();
