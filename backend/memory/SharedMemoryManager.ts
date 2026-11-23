/**
 * MYRAA — SharedMemoryManager (Phase 24)
 *
 * Centralized shared memory and synchronization controller bridging Desktop and Android.
 *
 * Responsibilities:
 *   1. Single Canonical Store: Operates exclusively on the canonical MemoryStore (memories.json).
 *   2. Device Attribution: Records originating deviceId, deviceType, version, and sync timestamps.
 *   3. Security & Safety Gates:
 *      - Fails closed immediately on Emergency Stop (isActive) or Security Lockdown (LOCKDOWN mode).
 *      - Aggressive DLP & credential screening: rejects API keys, passwords, private keys, cards, OTPs.
 *   4. Deterministic Conflict Resolution:
 *      - Optimistic concurrency with monotonic version numbers.
 *      - Server-authoritative Last-Write-Wins (LWW) conflict resolution with timestamp and server version tie-breaking.
 *   5. Idempotent Offline Sync:
 *      - Deduplicates mutations via clientMutationId to prevent duplicate applications across reconnects.
 *   6. Cross-Device Real-Time Broadcasts:
 *      - Dispatches sync events to connected desktop UI and paired Android companions.
 */

import { MemoryStore, memoryStore } from "./MemoryStore.ts";
import { findSimilar, mergeText } from "./MemoryDeduplicator.ts";
import { searchMemories as _searchMemories } from "./MemorySearch.ts";
import { makeEnhancedMemory } from "./MemoryExtractor.ts";
import { emergencyStopCoordinator } from "../remote/EmergencyStopCoordinator.ts";
import { securityPolicyEngine } from "../security/SecurityPolicyEngine.ts";
import { outputDataFirewall } from "../security/OutputDataFirewall.ts";
import type { SecurityContext } from "../security/SecurityTypes.ts";
import type {
  EnhancedMemory,
  DeviceType,
  MemorySyncMutation,
  MemorySyncBatchRequest,
  MemorySyncBatchResponse,
  SharedMemorySyncEvent,
  SharedMemoryOperationResult,
  MemorySearchOptions,
  MemoryCategory,
  Importance,
  Confidence,
  MemoryStatus,
} from "./MemoryTypes.ts";

// ---------------------------------------------------------------------------
// DLP Secret Screening Patterns
// ---------------------------------------------------------------------------

const SENSITIVE_CREDENTIAL_PATTERNS: readonly RegExp[] = Object.freeze([
  // Google / Gemini API keys (starts with AIza followed by 20+ chars)
  /\bAIza[0-9A-Za-z_\-]{20,}\b/i,
  // OpenAI / Anthropic API keys
  /\bsk-[0-9a-zA-Z_\-]{20,}\b/i,
  // MYRAA / Sora device, access, and refresh tokens
  /\b(?:sora_(?:conf|tok|dev)_[A-Za-z0-9_\-.]+|myraa_(?:at|rf)_[A-Za-z0-9_\-.]+)\b/i,
  // Bearer authentication tokens
  /\bBearer\s+[A-Za-z0-9\-_=.]+\b/i,
  // PEM Private keys
  /-----BEGIN[ A-Z0-9_-]*PRIVATE KEY-----/i,
  // Plaintext password assignments
  /\b(?:password|passwd|pwd)\s*[:=]\s*[^\s,;]{4,}\b/i,
  // Payment card numbers (Visa, MC, Amex, Discover with spaces/dashes)
  /\b(?:4[0-9]{3}|5[1-5][0-9]{2}|6(?:011|5[0-9]{2})|3[47][0-9]{2})[ -]?[0-9]{4}[ -]?[0-9]{4}[ -]?[0-9]{3,4}\b/,
  // OTP, verification, and PIN codes (e.g. "otp is 1234", "otp code is 123456", "verification code: 482910")
  /\b(?:otp(?:\s+code)?|one[- ]time[- ]password|verification(?:\s*code)?|auth(?:\s*code)?|pin)\s*(?:is|:|=)?\s*\d{4,8}\b/i,
]);

const SENSITIVE_BROADCAST_CATEGORIES = new Set(["identity", "credentials", "behavior"]);

export interface WsBroadcastRecipientContext {
  identityId?: string;
  role?: string;
  isLocal?: boolean;
  isStepUpAuthenticated?: boolean;
}

/**
 * Filter and DLP-sanitize memory records before sending over WebSocket `memory_sync`
 * (FINDING-AUD-09). Enforces:
 *   1. Authenticated recipient required (returns [] if recipient has no identityId).
 *   2. Ownership filtering: drops records explicitly owned by another actor unless
 *      recipient is a local admin.
 *   3. Sensitive-category gating: drops `identity`, `credentials`, and `behavior`
 *      records unless the recipient session is step-up authenticated.
 *   4. DLP filtering: drops records failing isDlpClean and redacts residual secrets,
 *      stripping any token/proof fields.
 */
export function filterMemoriesForWsBroadcast<T extends Partial<EnhancedMemory>>(
  memories: T[],
  recipient?: WsBroadcastRecipientContext,
): T[] {
  if (!Array.isArray(memories) || memories.length === 0) return [];
  if (!recipient || !recipient.identityId) return [];

  const allowSensitive = Boolean(recipient.isStepUpAuthenticated);
  const isLocalAdmin = Boolean(recipient.isLocal && recipient.role === "admin");

  const filtered: T[] = [];
  for (const mem of memories) {
    if (!mem || typeof mem !== "object") continue;

    // 1. Category policy: never broadcast sensitive categories without step-up auth
    const cat = String(mem.category || "").toLowerCase();
    if (SENSITIVE_BROADCAST_CATEGORIES.has(cat) && !allowSensitive) {
      continue;
    }

    // 2. Ownership boundary check
    const ownerId = (mem as any).ownerId as string | undefined;
    if (
      ownerId &&
      ownerId !== "default" &&
      ownerId !== "system" &&
      ownerId !== recipient.identityId &&
      !isLocalAdmin
    ) {
      continue;
    }

    // 3. DLP filtering — drop dirty secret records completely
    if (!isDlpClean(mem.text) || (mem.key && !isDlpClean(mem.key))) {
      continue;
    }

    // 4. Redact any residual secret patterns via OutputDataFirewall and strip sensitive/token properties
    const { sanitized } = outputDataFirewall.sanitizeResult(mem.text || "");
    const {
      oneTimeToken: _tok,
      proof: _proof,
      signature: _sig,
      ...safeCopy
    } = mem as any;
    safeCopy.text = sanitized;
    filtered.push(safeCopy as T);
  }
  return filtered;
}

/**
 * Validates whether text contains any forbidden secrets or credentials.
 * Returns true if clean, false if sensitive credential detected.
 */
export function isDlpClean(text?: string): boolean {
  if (!text || typeof text !== "string") return true;
  for (const pattern of SENSITIVE_CREDENTIAL_PATTERNS) {
    if (pattern.test(text)) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// SharedMemoryManager Class
// ---------------------------------------------------------------------------

export class SharedMemoryManager {
  private _store?: MemoryStore;
  private _processedMutations = new Set<string>(); // clientMutationId idempotency cache
  private _syncListeners: Array<(event: SharedMemorySyncEvent) => void> = [];

  constructor(store?: MemoryStore) {
    if (store) {
      this._store = store;
    }
  }

  private get store(): MemoryStore {
    if (!this._store) {
      this._store = memoryStore;
    }
    return this._store;
  }

  // ── Sync Listener Registration ───────────────────────────────────────────

  /**
   * Register a callback for real-time memory synchronization events.
   * Returns an unregister function.
   */
  registerSyncListener(listener: (event: SharedMemorySyncEvent) => void): () => void {
    this._syncListeners.push(listener);
    return () => {
      this._syncListeners = this._syncListeners.filter((l) => l !== listener);
    };
  }

  /**
   * Broadcast sync event to local listeners and authenticated remote subscribers
   * with per-client ownership, sensitive-category, and DLP filtering (FINDING-AUD-09).
   */
  private async _broadcastSync(
    action: "create" | "update" | "delete" | "batch_sync",
    deviceId: string,
    deviceType: DeviceType,
    memories: EnhancedMemory[],
    memoryId?: string,
    version?: number,
  ): Promise<void> {
    if (emergencyStopCoordinator.isActive() || securityPolicyEngine.getMode() === "LOCKDOWN") {
      return;
    }

    // Filter sensitive/DLP memories for general in-process listeners
    const listenerSafeMemories = filterMemoriesForWsBroadcast(memories, {
      identityId: deviceId || "local_operator",
      role: "standard",
      isLocal: true,
      isStepUpAuthenticated: false,
    });

    const listenerEvent: SharedMemorySyncEvent = {
      type: "memory_sync",
      action,
      deviceId,
      deviceType,
      memoryId,
      memories: listenerSafeMemories,
      timestamp: MemoryStore.now(),
      version,
    };

    // 1. Notify direct in-process listeners
    for (const listener of this._syncListeners) {
      try {
        listener(listenerEvent);
      } catch (err) {
        console.warn("[SharedMemoryManager] Listener error:", err);
      }
    }

    // 2. Notify remote session manager with strict per-client ownership/category/DLP filtering
    try {
      const { remoteSessionManager } = await import("../remote/RemoteSessionManager.ts");
      const sessions = remoteSessionManager.getActiveSessions();
      for (const s of sessions) {
        const client = remoteSessionManager.getClientForDevice(s.deviceId);
        if (!client || !client.ws || client.ws.readyState !== 1) continue;

        const isStepUp = Boolean(
          (s as any).isStepUpAuthenticated &&
            (!(s as any).stepUpExpiresAt || Date.now() < (s as any).stepUpExpiresAt),
        );
        const clientSafeMemories = filterMemoriesForWsBroadcast(memories, {
          identityId: s.deviceId,
          role: (s as any).role || "standard",
          isLocal: Boolean((s as any).isLocal),
          isStepUpAuthenticated: isStepUp,
        });

        const clientEvent: SharedMemorySyncEvent = {
          type: "memory_sync",
          action,
          deviceId,
          deviceType,
          memoryId,
          memories: clientSafeMemories,
          timestamp: MemoryStore.now(),
          version,
        };

        try {
          client.ws.send(JSON.stringify(clientEvent));
        } catch {
          /* ignore dropped frame */
        }
      }
    } catch {
      /* ignore if remoteSessionManager not yet initialized */
    }
  }

  // ── Pre-flight Security Gate ─────────────────────────────────────────────

  /**
   * Verifies Emergency Stop and Security Policy Lockdown.
   * Throws if either security safeguard is active.
   */
  private _assertSecurityClearance(): void {
    if (emergencyStopCoordinator.isActive()) {
      throw new Error("EMERGENCY_STOP_ACTIVE: Shared memory operations are blocked while emergency stop is active.");
    }
    if (securityPolicyEngine.getMode() === "LOCKDOWN") {
      throw new Error("SECURITY_LOCKDOWN_ACTIVE: Shared memory access is forbidden during security lockdown.");
    }
  }

  // ── Core CRUD Operations ─────────────────────────────────────────────────

  /**
   * Create a new memory with full deduplication, DLP screening, and device attribution.
   */
  async createMemory(
    data: {
      category: MemoryCategory;
      text: string;
      key?: string;
      source?: any;
      importance?: Importance;
      confidence?: Confidence;
      expiresAt?: string;
      deviceId?: string;
      deviceType?: DeviceType;
      clientMutationId?: string;
    },
    secContext?: SecurityContext,
  ): Promise<EnhancedMemory> {
    this._assertSecurityClearance();

    // DLP Screening
    if (!isDlpClean(data.text) || !isDlpClean(data.key)) {
      throw new Error("DLP_SECRET_REJECTED: Secrets, credentials, or API keys cannot be stored in shared memory.");
    }

    const deviceId = data.deviceId || secContext?.deviceId || "desktop_local";
    const deviceType: DeviceType = data.deviceType || (secContext?.isLocal ? "desktop" : "android");

    // SEC-P1-02: Route through GoverningMemoryGate
    const { governingMemoryGate } = await import("../companion/GoverningMemoryGate.ts");
    const req = await governingMemoryGate.requestWrite({
      action: "CREATE",
      proposedMemory: {
        category: data.category,
        text: data.text,
        key: data.key,
        importance: data.importance,
        confidence: data.confidence,
        expiresAt: data.expiresAt,
        deviceId,
        deviceType,
        clientMutationId: data.clientMutationId,
      },
      reason: "SharedMemoryManager createMemory proposal",
      confidence: data.confidence === "high" ? 0.9 : data.confidence === "low" ? 0.4 : 0.8,
      source: data.source ?? (deviceType === "android" ? "user_explicit" : "system_generated"),
      userId: deviceId,
      provenance: `device:${deviceId}`,
    });

    if (data.clientMutationId) {
      this._processedMutations.add(data.clientMutationId);
    }

    if (req.approved) {
      const all = await this.store.load();
      const match = all.find((m) => m.text === data.text && m.category === data.category);
      if (match) return match;
    }

    return {
      id: req.id,
      category: data.category,
      text: data.text,
      key: data.key,
      source: data.source ?? (deviceType === "android" ? "user_explicit" : "system_generated"),
      importance: data.importance ?? "medium",
      confidence: data.confidence ?? "medium",
      status: "pending_approval" as any,
      createdAt: req.requestedAt,
      updatedAt: req.requestedAt,
      version: 1,
      deviceId,
      deviceType,
      clientMutationId: data.clientMutationId,
    };
  }

  /**
   * Update an existing memory proposal through GoverningMemoryGate.
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
      deviceId?: string;
      deviceType?: DeviceType;
      clientMutationId?: string;
      clientVersion?: number;
      timestamp?: string;
    },
    secContext?: SecurityContext,
  ): Promise<SharedMemoryOperationResult> {
    this._assertSecurityClearance();

    // DLP Screening
    if ((patch.text && !isDlpClean(patch.text)) || (patch.key && !isDlpClean(patch.key))) {
      throw new Error("DLP_SECRET_REJECTED: Secrets, credentials, or API keys cannot be stored in shared memory.");
    }

    const all = await this.store.load();
    const existing = all.find((m) => m.id === id);
    if (!existing) {
      return { success: false, error: `Memory '${id}' not found.` };
    }

    const deviceId = patch.deviceId || secContext?.deviceId || existing.deviceId || "desktop_local";
    const deviceType = patch.deviceType || (secContext?.isLocal ? "desktop" : "android");

    // SEC-P1-02 + FINDING-AUD-07: Route through GoverningMemoryGate preserving target category & expectedVersion
    const { governingMemoryGate } = await import("../companion/GoverningMemoryGate.ts");
    const req = await governingMemoryGate.requestWrite({
      action: "UPDATE",
      proposedMemory: {
        id,
        category: existing.category,
        ...patch,
        deviceId,
        deviceType,
      },
      reason: `SharedMemoryManager updateMemory proposal for ${id}`,
      confidence: 0.85,
      source: "user_explicit",
      userId: deviceId,
      provenance: `device:${deviceId}`,
      expectedVersion: patch.clientVersion ?? existing.version ?? 1,
    });

    if (patch.clientMutationId) {
      this._processedMutations.add(patch.clientMutationId);
    }

    return {
      success: true,
      memory: {
        ...existing,
        ...patch,
        status: "pending_approval" as any,
        updatedAt: req.requestedAt,
      },
      conflictResolved: false,
    };
  }

  /**
   * Propose deletion of a memory from the canonical store through GoverningMemoryGate.
   * FINDING-AUD-07: Preserves target category and expectedVersion.
   */
  async deleteMemory(id: string, secContext?: SecurityContext): Promise<boolean> {
    this._assertSecurityClearance();

    const all = await this.store.load();
    const target = all.find((m) => m.id === id);
    if (!target) return false;

    const deviceId = secContext?.deviceId || target.deviceId || "desktop_local";

    const { governingMemoryGate } = await import("../companion/GoverningMemoryGate.ts");
    await governingMemoryGate.requestWrite({
      action: "DELETE",
      proposedMemory: {
        id,
        category: target.category,
        text: target.text,
        key: target.key,
      },
      reason: `SharedMemoryManager delete proposal for ${id}`,
      confidence: 0.9,
      source: "user_explicit",
      userId: deviceId,
      provenance: `device:${deviceId}`,
      expectedVersion: target.version ?? 1,
    });

    return true;
  }

    /**
   * Get a single memory by ID.
   */
  async getMemory(id: string, _secContext?: SecurityContext): Promise<EnhancedMemory | undefined> {
    this._assertSecurityClearance();
    const all = await this.store.load();
    return all.find((m) => m.id === id);
  }

  /**
   * List active memories (excluding archived and expired unless requested).
   */
  async listMemories(
    opts: {
      includeNeedsRevalidation?: boolean;
      includeArchived?: boolean;
      category?: MemoryCategory;
      deviceId?: string;
    } = {},
    _secContext?: SecurityContext,
  ): Promise<EnhancedMemory[]> {
    this._assertSecurityClearance();
    const all = await this.store.load();
    return all.filter((m) => {
      if (MemoryStore.isExpired(m)) return false;
      if (m.status === "archived" && !opts.includeArchived) return false;
      if (m.status === "needs_revalidation" && opts.includeNeedsRevalidation === false) return false;
      if (opts.category && m.category !== opts.category) return false;
      if (opts.deviceId && m.deviceId !== opts.deviceId) return false;
      return true;
    });
  }

  /**
   * Search memories by query string, category, and ranking.
   */
  async searchMemories(opts: MemorySearchOptions, _secContext?: SecurityContext): Promise<EnhancedMemory[]> {
    this._assertSecurityClearance();
    const all = await this.store.load();
    return _searchMemories(all, opts);
  }

  // ── Offline Batch Synchronization ────────────────────────────────────────

  /**
   * Process an offline mutation queue from an Android companion device.
   * Deterministically applies mutations, resolves conflicts, and returns the current canonical snapshot.
   */
  async syncBatch(
    batch: MemorySyncBatchRequest,
    secContext?: SecurityContext,
  ): Promise<MemorySyncBatchResponse> {
    this._assertSecurityClearance();

    const deviceId = batch.deviceId || secContext?.deviceId || "unknown_remote";
    const deviceType: DeviceType = batch.deviceType || (secContext?.isLocal ? "desktop" : "android");

    let appliedCount = 0;
    let conflictsResolved = 0;
    const rejectedMutations: Array<{ clientMutationId: string; reason: string; memoryId?: string }> = [];

    // Sort mutations by client timestamp ascending to preserve intent order
    const sortedMutations = [...batch.mutations].sort((a, b) => {
      const ta = new Date(a.timestamp).getTime();
      const tb = new Date(b.timestamp).getTime();
      return (isNaN(ta) ? 0 : ta) - (isNaN(tb) ? 0 : tb);
    });

    for (const mut of sortedMutations) {
      // 1. Idempotency check: Skip duplicate mutations that were already processed
      if (this._processedMutations.has(mut.clientMutationId)) {
        appliedCount++;
        continue;
      }

      // 2. DLP Screening
      if (mut.data?.text && !isDlpClean(mut.data.text)) {
        rejectedMutations.push({
          clientMutationId: mut.clientMutationId,
          reason: "DLP_SECRET_REJECTED: Secrets or credentials prohibited in shared memory.",
          memoryId: mut.memoryId,
        });
        continue;
      }

      try {
        switch (mut.mutationType) {
          case "CREATE": {
            if (!mut.data?.category || !mut.data?.text) {
              rejectedMutations.push({
                clientMutationId: mut.clientMutationId,
                reason: "MISSING_REQUIRED_FIELDS: Category and text required.",
              });
              break;
            }
            await this.createMemory(
              {
                category: mut.data.category,
                text: mut.data.text,
                key: mut.data.key,
                importance: mut.data.importance,
                confidence: mut.data.confidence,
                source: mut.data.source,
                expiresAt: mut.data.expiresAt,
                deviceId,
                deviceType,
                clientMutationId: mut.clientMutationId,
              },
              secContext,
            );
            appliedCount++;
            break;
          }

          case "UPDATE": {
            if (!mut.memoryId) {
              rejectedMutations.push({
                clientMutationId: mut.clientMutationId,
                reason: "MISSING_MEMORY_ID: Update mutation requires memoryId.",
              });
              break;
            }
            const res = await this.updateMemory(
              mut.memoryId,
              {
                ...mut.data,
                deviceId,
                deviceType,
                clientMutationId: mut.clientMutationId,
                clientVersion: mut.clientVersion,
                timestamp: mut.timestamp,
              },
              secContext,
            );
            if (res.success) {
              appliedCount++;
              if (res.conflictResolved) {
                conflictsResolved++;
              }
            } else {
              rejectedMutations.push({
                clientMutationId: mut.clientMutationId,
                reason: res.error || "UPDATE_FAILED",
                memoryId: mut.memoryId,
              });
            }
            break;
          }

          case "DELETE": {
            if (!mut.memoryId) {
              rejectedMutations.push({
                clientMutationId: mut.clientMutationId,
                reason: "MISSING_MEMORY_ID: Delete mutation requires memoryId.",
              });
              break;
            }
            const deleted = await this.deleteMemory(mut.memoryId, secContext);
            if (deleted) {
              appliedCount++;
            }
            this._processedMutations.add(mut.clientMutationId);
            break;
          }

          default:
            rejectedMutations.push({
              clientMutationId: mut.clientMutationId,
              reason: `UNKNOWN_MUTATION_TYPE: ${(mut as any).mutationType}`,
              memoryId: mut.memoryId,
            });
        }
      } catch (err: any) {
        rejectedMutations.push({
          clientMutationId: mut.clientMutationId,
          reason: err.message || "MUTATION_ERROR",
          memoryId: mut.memoryId,
        });
      }
    }

    const currentMemories = await this.listMemories({ includeNeedsRevalidation: true });

    return {
      success: rejectedMutations.length === 0,
      appliedCount,
      conflictsResolved,
      memories: currentMemories,
      serverTimestamp: MemoryStore.now(),
      rejectedMutations: rejectedMutations.length > 0 ? rejectedMutations : undefined,
    };
  }

  /**
   * Forcibly clear in-memory caches (useful in tests).
   */
  clearCaches(): void {
    this._processedMutations.clear();
    this.store.clearCache();
  }
}

// ---------------------------------------------------------------------------
// Module-level Singleton
// ---------------------------------------------------------------------------

export const sharedMemoryManager = new SharedMemoryManager();
