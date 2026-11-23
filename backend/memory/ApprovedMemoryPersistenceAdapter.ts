/**
 * MYRAA — ApprovedMemoryPersistenceAdapter (Stage 10 Phase 2)
 *
 * Internal-only persistence adapter for governed memory writes.
 *
 * Architecture Position:
 *   Tier 3 in the 4-Tier acyclic memory governance architecture:
 *   GoverningMemoryGate (Tier 2) → ApprovedMemoryPersistenceAdapter (Tier 3) → MemoryStore (Tier 4)
 *
 * Responsibilities:
 *   1. Verify GovernanceProof at runtime via HMAC-SHA256 + timingSafeEqual.
 *   2. Validate proof expiration (60-second window).
 *   3. Enforce single-use proof consumption via _consumedProofIds Set.
 *   4. Prevent concurrent duplicate execution via _inFlightProofIds Set.
 *   5. Execute deduplication (findSimilar / mergeText), conflict resolution,
 *      version increments, and schema defaults — exactly as MemoryManager did.
 *   6. Establish the AsyncLocalStorage authorized context before calling MemoryStore.save().
 *   7. Ensure exactly one committed mutation per approved governance request.
 *
 * Security Invariants:
 *   - Cannot be instantiated or called outside this module without a valid GovernanceProof.
 *   - The HMAC secret is imported from GoverningMemoryGate's internal module-scoped variable.
 *   - TypeScript types alone are NOT the security boundary — runtime HMAC verification is.
 *   - Consumed proofIds cannot be reused even if the signature is valid.
 *   - Concurrent calls with the same proofId are blocked until the first completes.
 *   - Process restart clears _consumedProofIds and _inFlightProofIds (proofs from
 *     previous process lifetime become cryptographically invalid anyway).
 *
 * CRITICAL: This adapter must NOT call MemoryManager methods. It calls MemoryStore.save()
 *           directly (within the authorized AsyncLocalStorage context) to avoid circular
 *           dependency: Gate → Manager → Gate.
 */

import { memoryStore, MemoryStore } from "./MemoryStore.ts";
import { findSimilar, mergeText } from "./MemoryDeduplicator.ts";
import { makeEnhancedMemory } from "./MemoryExtractor.ts";
import {
  runAuthorizedPersistence,
  verifyGovernanceProof,
  isProofConsumed,
  isProofInFlight,
  _clearPersistenceContextForTesting,
} from "./MemoryPersistenceContext.ts";
import { securityAuditLogger } from "../security/SecurityAuditLogger.ts";
import type { GovernanceProof } from "../companion/GoverningMemoryTypes.ts";
import type { EnhancedMemory, MemoryStatus, MemorySource, MemoryCategory, Importance, Confidence } from "./MemoryTypes.ts";
import type { MemoryWriteRequest } from "../companion/GoverningMemoryTypes.ts";

// ---------------------------------------------------------------------------
// Module-level state for concurrent execution protection
// (Single-use consumed-proof enforcement is unified in MemoryPersistenceContext)
// ---------------------------------------------------------------------------

/** In-flight proofIds — prevents concurrent duplicate execution before load/save. */
const _inFlightProofIds = new Set<string>();

/**
 * Module-level serialized commit queue (FINDING-AUD-09).
 * Covers the ENTIRE read-modify-write critical section:
 *   store.load() -> _applyMemoryMutation() -> store.save()
 * Shared across all ApprovedMemoryPersistenceAdapter instances so concurrent
 * approved commits never read stale snapshots or lose updates.
 */
let _commitQueue: Promise<void> = Promise.resolve();

function _enqueueCommit<T>(task: () => Promise<T>): Promise<T> {
  const next = _commitQueue.then(task, task);
  _commitQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

// Re-export verifyGovernanceProof from MemoryPersistenceContext for backwards compatibility
export { verifyGovernanceProof };

/**
 * Helper to check ownership of an existing target memory record.
 * Rejects cross-actor mutations when a record carries an explicit ownerId.
 */
function assertTargetOwnership(
  existing: EnhancedMemory,
  request: MemoryWriteRequest,
): void {
  const existingOwner = (existing as any).ownerId as string | undefined;
  if (
    existingOwner &&
    existingOwner !== "default" &&
    existingOwner !== "system" &&
    request.userId !== existingOwner
  ) {
    securityAuditLogger.logEvent({
      eventType: "TOOL_BLOCKED",
      actor: { identityId: request.userId, role: "standard", ipAddress: "127.0.0.1" },
      target: { resource: `memory:${existing.id}` },
      decision: "BLOCK",
      reason: `UNAUTHORIZED_MEMORY_OWNER: Actor '${request.userId}' cannot mutate memory '${existing.id}' owned by '${existingOwner}'.`,
      riskLevel: "HIGH",
      metadata: { requestId: request.id, memoryId: existing.id, action: request.action },
    });
    throw new Error(
      `UNAUTHORIZED_MEMORY_OWNER: Actor '${request.userId}' is not the owner of memory '${existing.id}'.`,
    );
  }
}

// ---------------------------------------------------------------------------
// ApprovedMemoryPersistenceAdapter
// ---------------------------------------------------------------------------

export class ApprovedMemoryPersistenceAdapter {
  private store: MemoryStore;

  constructor(store: MemoryStore = memoryStore) {
    this.store = store;
  }

  /**
   * Execute an approved memory persistence operation.
   *
   * Security flow (FINDING-AUD-01, FINDING-AUD-02, FINDING-AUD-07):
   *   1. Verify GovernanceProof (structure, expiry, HMAC-SHA256, and exact
   *      binding to requestId, action, userId, payloadHash, targetMemoryId,
   *      expectedVersion, destinationStorage, and pending proposal state).
   *   2. Reject concurrent execution of same proofId (GOVERNANCE_PROOF_IN_FLIGHT).
   *   3. Reject replay of consumed proofId (GOVERNANCE_PROOF_ALREADY_CONSUMED).
   *   4. Establish single-use fail-closed AsyncLocalStorage persistence context
   *      via runAuthorizedPersistence(proof, request, ...) — proofId is consumed
   *      atomically BEFORE disk I/O so failed writes cannot be replayed.
   *   5. Enforce target ownership, expectedVersion optimistic locking, dedup,
   *      and persist atomically through MemoryStore.save().
   */
  async commitApproved(
    request: MemoryWriteRequest,
    proof: GovernanceProof,
  ): Promise<EnhancedMemory> {
    // Step 1: Verify proof + exact cryptographic binding to request
    verifyGovernanceProof(proof, request);

    const proofId = proof.payload.proofId;

    // Step 2: Concurrency protection (before any async await)
    if (_inFlightProofIds.has(proofId) || isProofInFlight(proofId)) {
      securityAuditLogger.logEvent({
        eventType: "TOOL_BLOCKED",
        actor: { identityId: request.userId, role: "standard", ipAddress: "127.0.0.1" },
        target: { resource: "memories.json" },
        decision: "BLOCK",
        reason: "GOVERNANCE_PROOF_IN_FLIGHT: Concurrent execution of same proof blocked.",
        riskLevel: "HIGH",
        metadata: { proofId, requestId: request.id },
      });
      throw new Error(
        "GOVERNANCE_PROOF_IN_FLIGHT: A concurrent persistence operation is already in progress for this proof.",
      );
    }

    // Step 3: Replay protection (single-use check)
    if (isProofConsumed(proofId)) {
      securityAuditLogger.logEvent({
        eventType: "TOOL_BLOCKED",
        actor: { identityId: request.userId, role: "standard", ipAddress: "127.0.0.1" },
        target: { resource: "memories.json" },
        decision: "BLOCK",
        reason: "GOVERNANCE_PROOF_ALREADY_CONSUMED: Replay of consumed proof detected.",
        riskLevel: "CRITICAL",
        metadata: { proofId, requestId: request.id },
      });
      throw new Error(
        "GOVERNANCE_PROOF_ALREADY_CONSUMED: This GovernanceProof has already been consumed.",
      );
    }

    _inFlightProofIds.add(proofId);

    try {
      // Step 4 & 5: Serialize the ENTIRE read-modify-write critical section
      // (store.load -> _applyMemoryMutation -> store.save) across all adapters
      // via _enqueueCommit so concurrent approved writes never lose updates
      // (FINDING-AUD-09), while keeping single-use fail-closed proof consumption
      // and ALS persistence authorization intact inside runAuthorizedPersistence.
      const resultMemory = await _enqueueCommit(() =>
        runAuthorizedPersistence(proof, request, async () => {
          const all = await this.store.load();
          const { updatedList, resultMemory: committed } = await this._applyMemoryMutation(
            request,
            all,
          );
          await this.store.save(updatedList);
          return committed;
        }),
      );

      securityAuditLogger.logEvent({
        eventType: "TOOL_CONFIRMED",
        actor: { identityId: request.userId, role: "standard", ipAddress: "127.0.0.1" },
        target: { resource: "memories.json" },
        decision: "ALLOW",
        reason: `GOVERNANCE_COMMITTED: Memory '${resultMemory.id}' committed via GovernanceProof '${proofId}'.`,
        riskLevel: "LOW",
        metadata: {
          proofId,
          requestId: request.id,
          memoryId: resultMemory.id,
          action: request.action,
        },
      });

      return resultMemory;
    } finally {
      _inFlightProofIds.delete(proofId);
    }
  }

  /**
   * Apply the memory mutation (dedup, merge, conflict resolution, or create)
   * and return the updated full list plus the resulting record.
   */
  private async _applyMemoryMutation(
    request: MemoryWriteRequest,
    all: EnhancedMemory[],
  ): Promise<{ updatedList: EnhancedMemory[]; resultMemory: EnhancedMemory }> {
    const proposed = request.proposedMemory;
    const action = request.action;
    const expectedVersion = (request as any).expectedVersion as number | undefined;

    // UPDATE path
    if (action === "UPDATE" && proposed.id) {
      const idx = all.findIndex((m) => m.id === proposed.id);
      if (idx === -1) {
        throw new Error(`MEMORY_NOT_FOUND: Target memory '${proposed.id}' not found for update.`);
      }

      assertTargetOwnership(all[idx], request);

      // Optimistic concurrency: enforce expectedVersion if set
      const currentVersion = all[idx].version ?? 1;
      if (expectedVersion !== undefined && currentVersion !== expectedVersion) {
        throw new Error(
          `STALE_RECORD_CONFLICT: Memory '${proposed.id}' version mismatch. Expected ${expectedVersion}, found ${currentVersion}.`,
        );
      }

      const updated: EnhancedMemory = {
        ...all[idx],
        ...(proposed.text !== undefined ? { text: proposed.text } : {}),
        ...(proposed.key !== undefined ? { key: proposed.key } : {}),
        ...(proposed.importance !== undefined ? { importance: proposed.importance } : {}),
        ...(proposed.confidence !== undefined ? { confidence: proposed.confidence } : {}),
        ...(proposed.status !== undefined ? { status: proposed.status } : {}),
        ...(proposed.expiresAt !== undefined ? { expiresAt: proposed.expiresAt } : {}),
        updatedAt: MemoryStore.now(),
        version: currentVersion + 1,
      };
      const updatedList = all.map((m) => (m.id === updated.id ? updated : m));
      return { updatedList, resultMemory: updated };
    }

    // DELETE path
    if (action === "DELETE" && proposed.id) {
      const target = all.find((m) => m.id === proposed.id);
      if (!target) {
        throw new Error(`MEMORY_NOT_FOUND: Target memory '${proposed.id}' not found for deletion.`);
      }
      assertTargetOwnership(target, request);
      const currentVersion = target.version ?? 1;
      if (expectedVersion !== undefined && currentVersion !== expectedVersion) {
        throw new Error(
          `STALE_RECORD_CONFLICT: Memory '${proposed.id}' version mismatch. Expected ${expectedVersion}, found ${currentVersion}.`,
        );
      }
      const updatedList = all.filter((m) => m.id !== proposed.id);
      return { updatedList, resultMemory: { ...target, status: "archived" as MemoryStatus } };
    }

    // ARCHIVE path
    if (action === "ARCHIVE" && proposed.id) {
      const idx = all.findIndex((m) => m.id === proposed.id);
      if (idx === -1) {
        throw new Error(`MEMORY_NOT_FOUND: Target memory '${proposed.id}' not found for archive.`);
      }
      assertTargetOwnership(all[idx], request);
      const currentVersion = all[idx].version ?? 1;
      if (expectedVersion !== undefined && currentVersion !== expectedVersion) {
        throw new Error(
          `STALE_RECORD_CONFLICT: Memory '${proposed.id}' version mismatch. Expected ${expectedVersion}, found ${currentVersion}.`,
        );
      }
      const archived: EnhancedMemory = {
        ...all[idx],
        status: "archived" as MemoryStatus,
        updatedAt: MemoryStore.now(),
        version: currentVersion + 1,
      };
      const updatedList = all.map((m) => (m.id === archived.id ? archived : m));
      return { updatedList, resultMemory: archived };
    }

    // MERGE path
    if (action === "MERGE" && proposed.id && (proposed as any).mergeSourceId) {
      const targetId = proposed.id;
      const sourceId = (proposed as any).mergeSourceId;
      const target = all.find((m) => m.id === targetId);
      const source = all.find((m) => m.id === sourceId);
      if (!target || !source) {
        throw new Error(`MEMORY_NOT_FOUND: Merge target '${targetId}' or source '${sourceId}' not found.`);
      }
      assertTargetOwnership(target, request);
      assertTargetOwnership(source, request);
      const currentVersion = target.version ?? 1;
      if (expectedVersion !== undefined && currentVersion !== expectedVersion) {
        throw new Error(
          `STALE_RECORD_CONFLICT: Memory '${targetId}' version mismatch. Expected ${expectedVersion}, found ${currentVersion}.`,
        );
      }
      const mergedText = mergeText(target.text, source.text, 0.5);
      const merged: EnhancedMemory = {
        ...target,
        text: mergedText,
        updatedAt: MemoryStore.now(),
        version: currentVersion + 1,
      };
      const updatedList = all
        .filter((m) => m.id !== sourceId)
        .map((m) => (m.id === targetId ? merged : m));
      return { updatedList, resultMemory: merged };
    }

    // CREATE path (default) — full deduplication
    const dedup = findSimilar(all, {
      category: (proposed.category as MemoryCategory) || "fact",
      text: proposed.text || "",
      key: proposed.key,
    });

    if (dedup.match === "exact" && dedup.existing) {
      assertTargetOwnership(dedup.existing, request);
      const updated: EnhancedMemory = {
        ...dedup.existing,
        text: proposed.text || dedup.existing.text,
        updatedAt: MemoryStore.now(),
        importance: (proposed.importance as Importance) ?? dedup.existing.importance,
        confidence: (proposed.confidence as Confidence) ?? dedup.existing.confidence,
        version: (dedup.existing.version || 1) + 1,
      };
      const updatedList = all.map((m) => (m.id === updated.id ? updated : m));
      return { updatedList, resultMemory: updated };
    }

    if (dedup.match === "similar" && dedup.existing) {
      assertTargetOwnership(dedup.existing, request);
      const mergedText = mergeText(dedup.existing.text, proposed.text || "", dedup.score);
      const merged: EnhancedMemory = {
        ...dedup.existing,
        text: mergedText,
        updatedAt: MemoryStore.now(),
        version: (dedup.existing.version || 1) + 1,
      };
      const updatedList = all.map((m) => (m.id === merged.id ? merged : m));
      return { updatedList, resultMemory: merged };
    }

    if (dedup.match === "conflict" && dedup.existing) {
      assertTargetOwnership(dedup.existing, request);
      const updatedList = all.map((m) =>
        m.id === dedup.existing!.id
          ? { ...m, status: "needs_revalidation" as MemoryStatus, updatedAt: MemoryStore.now() }
          : m,
      );
      const newRecord = makeEnhancedMemory({
        category: (proposed.category as MemoryCategory) || "fact",
        text: proposed.text || "",
        key: proposed.key,
        confidence: "low",
        importance: (proposed.importance as Importance),
        source: (proposed.source as MemorySource) ?? request.source,
        expiresAt: proposed.expiresAt,
      });
      newRecord.version = 1;
      if (proposed.deviceId) newRecord.deviceId = proposed.deviceId;
      if (proposed.deviceType) newRecord.deviceType = proposed.deviceType;
      if (proposed.clientMutationId) newRecord.clientMutationId = proposed.clientMutationId;
      if (request.userId) {
        (newRecord as any).ownerId = request.userId;
      }
      updatedList.push(newRecord);
      return { updatedList, resultMemory: newRecord };
    }

    // No match — add fresh record
    const newRecord = makeEnhancedMemory({
      category: (proposed.category as MemoryCategory) || "fact",
      text: proposed.text || "",
      key: proposed.key,
      importance: (proposed.importance as Importance),
      confidence: (proposed.confidence as Confidence),
      source: (proposed.source as MemorySource) ?? request.source,
      expiresAt: proposed.expiresAt,
    });
    newRecord.version = 1;
    if (proposed.deviceId) newRecord.deviceId = proposed.deviceId;
    if (proposed.deviceType) newRecord.deviceType = proposed.deviceType;
    if (proposed.clientMutationId) newRecord.clientMutationId = proposed.clientMutationId;
    if (request.userId) {
      (newRecord as any).ownerId = request.userId;
    }
    const updatedList = [...all, newRecord];
    return { updatedList, resultMemory: newRecord };
  }

  /**
   * Test-only: clear all consumed and in-flight proof IDs.
   * MUST NOT be called in production paths.
   */
  _clearProofStateForTesting(): void {
    _inFlightProofIds.clear();
    _clearPersistenceContextForTesting();
  }
}

/**
 * Singleton instance for use by GoverningMemoryGate.
 */
export const approvedMemoryPersistenceAdapter = new ApprovedMemoryPersistenceAdapter();
