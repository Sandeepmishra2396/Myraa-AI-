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
import crypto from "crypto";
import { dataFile } from "../server_paths.ts";
import { emergencyStopCoordinator } from "../remote/EmergencyStopCoordinator.ts";
import { securityPolicyEngine } from "../security/SecurityPolicyEngine.ts";
import { securityAuditLogger } from "../security/SecurityAuditLogger.ts";
import { contentSanitizer } from "../security/ContentSanitizer.ts";
import { assertActivePersistenceSession } from "../memory/MemoryPersistenceContext.ts";
import type {
  CognitiveCategory,
  CognitiveMemory,
  CognitiveMemoryStatus,
  CommandPatternRecord,
} from "./CognitiveTypes.ts";

function assertCognitiveWriteAllowed(actorId = "system"): void {
  if (emergencyStopCoordinator.isActive()) {
    securityAuditLogger.logEvent({
      eventType: "TOOL_BLOCKED",
      actor: { identityId: actorId, role: "standard", ipAddress: "127.0.0.1" },
      target: { resource: "cognitive_memories.json" },
      decision: "BLOCK",
      reason: "EMERGENCY_STOP_ACTIVE: Cognitive memory write blocked during Emergency Stop.",
      riskLevel: "HIGH",
    });
    throw new Error("EMERGENCY_STOP_ACTIVE: Cognitive memory mutations are blocked during Emergency Stop.");
  }
  if (securityPolicyEngine.getMode() === "LOCKDOWN") {
    securityAuditLogger.logEvent({
      eventType: "TOOL_BLOCKED",
      actor: { identityId: actorId, role: "standard", ipAddress: "127.0.0.1" },
      target: { resource: "cognitive_memories.json" },
      decision: "BLOCK",
      reason: "SECURITY_LOCKDOWN_ACTIVE: Cognitive memory write blocked during Security Lockdown.",
      riskLevel: "HIGH",
    });
    throw new Error("SECURITY_LOCKDOWN_ACTIVE: Cognitive memory mutations are blocked during Security Lockdown.");
  }
}

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
   * Load all memories from disk (read-only). Flags expired records in memory
   * without performing unauthenticated disk writes (FINDING-AUD-03).
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
        this._expireMemories(this._cachedMemories);
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
   * Governed memory proposal path (FINDING-AUD-03):
   * Never writes directly to cognitive_memories.json without governance.
   * Enforces Emergency Stop, Security Lockdown, DLP secret screening,
   * prompt-injection screening, and routes through GoverningMemoryGate.
   */
  public async saveMemory(
    memory: CognitiveMemory,
    actorContext?: { userId?: string; sessionId?: string },
  ): Promise<CognitiveMemory> {
    const actorId = actorContext?.userId || "system";
    assertCognitiveWriteAllowed(actorId);

    const textRepr = `${memory.key}: ${typeof memory.value === "string" ? memory.value : JSON.stringify(memory.value)}`;
    const sourceText = String((memory as any).sourceUtterance || "");

    const { isDlpClean } = await import("../memory/SharedMemoryManager.ts");
    if (!isDlpClean(textRepr) || !isDlpClean(sourceText)) {
      securityAuditLogger.logEvent({
        eventType: "TOOL_BLOCKED",
        actor: { identityId: actorId, role: "standard", ipAddress: "127.0.0.1", sessionId: actorContext?.sessionId },
        target: { resource: "cognitive_memories.json" },
        decision: "BLOCK",
        reason: "DLP_SECRET_REJECTED: Secret/credential pattern detected in cognitive memory proposal.",
        riskLevel: "HIGH",
      });
      throw new Error("DLP_SECRET_REJECTED: Secrets or credentials cannot be stored in cognitive memory.");
    }

    const scanVal = contentSanitizer.scanForPromptInjection(textRepr, { source: "cognitive_memory", identifier: memory.id });
    const scanSrc = sourceText
      ? contentSanitizer.scanForPromptInjection(sourceText, { source: "cognitive_memory_source", identifier: memory.id })
      : { hasInjectionAttempt: false, matchedPatterns: [] };
    if (scanVal.hasInjectionAttempt || scanSrc.hasInjectionAttempt) {
      securityAuditLogger.logEvent({
        eventType: "PROMPT_INJECTION_DETECTED",
        actor: { identityId: actorId, role: "standard", ipAddress: "127.0.0.1", sessionId: actorContext?.sessionId },
        target: { resource: "cognitive_memories.json" },
        decision: "BLOCK",
        reason: "PROMPT_INJECTION_BLOCKED: Injection pattern detected in cognitive memory content.",
        riskLevel: "HIGH",
      });
      throw new Error("PROMPT_INJECTION_BLOCKED: Cognitive memory content contains unsafe prompt-injection instructions.");
    }

    const { governingMemoryGate } = await import("../companion/GoverningMemoryGate.ts");
    const proposal = await governingMemoryGate.requestWrite({
      action: "CREATE",
      proposedMemory: {
        category: "preference",
        key: memory.key,
        text: textRepr,
        confidence: memory.confidence >= 0.8 ? "high" : memory.confidence >= 0.5 ? "medium" : "low",
        source: "conversation_extracted",
      },
      reason: `Governed cognitive memory proposal for key '${memory.key}'`,
      confidence: typeof memory.confidence === "number" ? memory.confidence : 0.7,
      source: "conversation_extracted",
      userId: actorId,
      provenance: `cognitive_memory:${memory.id}`,
      sessionId: actorContext?.sessionId,
    } as any);

    const updatedMemory: CognitiveMemory = {
      ...memory,
      updatedAt: new Date().toISOString(),
    };
    (updatedMemory as any).pendingApproval = true;
    (updatedMemory as any).governanceRequestId = proposal.id;
    return updatedMemory;
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
   * Record usage of a memory in RAM cache only (no unauthenticated disk writes).
   */
  public async recordUsage(id: string): Promise<void> {
    const list = await this.loadMemories();
    const item = list.find((m) => m.id === id);
    if (item && item.status === "active") {
      item.usageCount = (item.usageCount || 0) + 1;
      item.lastUsedAt = new Date().toISOString();
      item.updatedAt = new Date().toISOString();
    }
  }

  /**
   * Proposes superseding a memory via GoverningMemoryGate (never writes disk directly).
   */
  public async supersedeMemory(
    oldId: string,
    newId: string,
    reason: string,
    actorContext?: { userId?: string; sessionId?: string },
  ): Promise<void> {
    const actorId = actorContext?.userId || "system";
    assertCognitiveWriteAllowed(actorId);

    const list = await this.loadMemories();
    const oldItem = list.find((m) => m.id === oldId);
    if (!oldItem) return;

    const { governingMemoryGate } = await import("../companion/GoverningMemoryGate.ts");
    await governingMemoryGate.requestWrite({
      action: "ARCHIVE",
      proposedMemory: {
        id: oldId,
        category: "preference",
        key: oldItem.key,
        text: `${oldItem.key}: superseded by ${newId} (${reason})`,
      },
      reason: `Supersede cognitive memory '${oldId}' with '${newId}': ${reason}`,
      confidence: 0.85,
      source: "system_generated",
      userId: actorId,
      provenance: `cognitive_supersede:${oldId}`,
      sessionId: actorContext?.sessionId,
    } as any);
  }

  /**
   * Proposes permanent deletion via GoverningMemoryGate (FINDING-AUD-03).
   * Never deletes directly from cognitive_memories.json without governance.
   */
  public async deleteMemory(
    id: string,
    actorContext?: { userId?: string; sessionId?: string },
  ): Promise<boolean> {
    const actorId = actorContext?.userId || "system";
    assertCognitiveWriteAllowed(actorId);

    const list = await this.loadMemories();
    const existing = list.find((m) => m.id === id);
    if (!existing) {
      return false;
    }

    const { governingMemoryGate } = await import("../companion/GoverningMemoryGate.ts");
    await governingMemoryGate.requestWrite({
      action: "DELETE",
      proposedMemory: {
        id,
        category: "preference",
        key: existing.key,
        text: `${existing.key}: ${typeof existing.value === "string" ? existing.value : JSON.stringify(existing.value)}`,
      },
      reason: `Governed cognitive memory deletion for '${id}'`,
      confidence: 0.85,
      source: "user_explicit",
      userId: actorId,
      provenance: `cognitive_delete:${id}`,
      sessionId: actorContext?.sessionId,
    } as any);
    return true;
  }

  /**
   * Direct disk clear is blocked outside an active verified persistence session.
   */
  public async clear(): Promise<void> {
    assertActivePersistenceSession();
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
   * Atomic file write for memories — strictly requires an active verified
   * persistence session (FINDING-AUD-03).
   */
  private async _persistMemories(memories: CognitiveMemory[]): Promise<void> {
    assertActivePersistenceSession();
    const dir = path.dirname(this._memoryFilePath);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {}

    const tmpFile = `${this._memoryFilePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString("hex")}.tmp`;
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
