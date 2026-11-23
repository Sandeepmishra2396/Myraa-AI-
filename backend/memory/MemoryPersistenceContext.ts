/**
 * MYRAA — MemoryPersistenceContext (Stage 10 Phase 2 Remediation)
 *
 * Private AsyncLocalStorage-based runtime authorization context for MemoryStore.save().
 *
 * Security Purpose:
 *   Eliminates SEC-FINDING-P2-01 by:
 *   1. Strictly preventing the export of raw AsyncLocalStorage instances.
 *   2. Removing all caller-supplied authorization objects like `{ authorized: true }`.
 *   3. Enforcing an unforgeable, ephemeral, cryptographically verified session handshake
 *      between ApprovedMemoryPersistenceAdapter and MemoryStore.
 *   4. Requiring a valid, non-expired, unconsumed GovernanceProof with HMAC-SHA256
 *      verification before any persistence context can be established.
 *
 * Security Invariants:
 *   - The underlying AsyncLocalStorage instance is completely module-private.
 *   - External callers cannot establish an authorized context by importing this module.
 *   - Fabricated proof IDs, nonces, or forged `{ authorized: true }` objects are rejected.
 *   - Active sessions are bound to high-entropy 256-bit random tokens in an unexported Map.
 *   - Active sessions are immediately deregistered upon completion or exception.
 *   - MemoryStore.save() cross-checks the active session registry before any disk write.
 */

import { AsyncLocalStorage } from "async_hooks";
import crypto from "crypto";
import {
  computeCanonicalPayloadHash,
  verifyGovernanceProofSignature,
} from "../companion/GoverningMemorySecret.ts";
import { securityAuditLogger } from "../security/SecurityAuditLogger.ts";
import type {
  GovernanceProof,
  MemoryWriteRequest,
} from "../companion/GoverningMemoryTypes.ts";

/**
 * Internal persistence session descriptor.
 * Strictly module-private.
 */
interface PersistenceSession {
  readonly sessionToken: string;
  readonly proofId: string;
  readonly requestId: string;
  readonly expiresAt: number;
}

const VALID_ACTIONS = new Set(["CREATE", "UPDATE", "ARCHIVE", "MERGE", "DELETE"]);
const MUTATION_ACTIONS_REQUIRING_TARGET = new Set(["UPDATE", "ARCHIVE", "MERGE", "DELETE"]);
const MAX_PROOF_TTL_MS = 65_000; // 60s nominal + 5s clock tolerance

/**
 * Module-private AsyncLocalStorage instance.
 * NEVER exported to prevent unauthorized callers from invoking .run().
 */
const _storageContext = new AsyncLocalStorage<PersistenceSession>();

/**
 * Active session registry.
 * Maps proofId -> active PersistenceSession.
 * Only populated during runAuthorizedPersistence execution.
 */
const _activeSessions = new Map<string, PersistenceSession>();

/**
 * Single-use consumed proof registry (FINDING-AUD-02).
 * Maps proofId -> proof expiresAt timestamp.
 * Entries are recorded atomically BEFORE persistence runs (fail-closed)
 * and only pruned once their expiry window has passed.
 */
const _consumedProofs = new Map<string, number>();

function _pruneExpiredConsumedProofs(now: number): void {
  if (_consumedProofs.size < 2000) return;
  for (const [id, exp] of _consumedProofs.entries()) {
    if (exp < now) {
      _consumedProofs.delete(id);
    }
  }
}

/**
 * Check whether a proofId has already been consumed.
 */
export function isProofConsumed(proofId: string): boolean {
  return _consumedProofs.has(proofId);
}

/**
 * Check whether a proofId is currently in flight.
 */
export function isProofInFlight(proofId: string): boolean {
  return _activeSessions.has(proofId);
}

/**
 * Cryptographically verify a GovernanceProof (structure, expiry, HMAC-SHA256)
 * and, when `expectedRequest` is supplied (mandatory for persistence), verify
 * exact binding to requestId, action, userId, payloadHash, targetMemoryId,
 * expectedVersion, destinationStorage, and proposal state (FINDING-AUD-01).
 *
 * Throws on any verification failure.
 */
export function verifyGovernanceProof(
  proof: GovernanceProof,
  expectedRequest?: MemoryWriteRequest,
): void {
  if (!proof || typeof proof !== "object") {
    throw new Error(
      "UNAUTHORIZED_PERSISTENCE_CALL: GovernanceProof is missing or not an object.",
    );
  }

  const { payload, signature } = proof;
  if (!payload || typeof payload !== "object" || !signature || typeof signature !== "string") {
    throw new Error(
      "UNAUTHORIZED_PERSISTENCE_CALL: GovernanceProof is structurally invalid.",
    );
  }

  // Structural field validation
  if (
    typeof payload.proofId !== "string" ||
    payload.proofId.trim().length === 0 ||
    typeof payload.requestId !== "string" ||
    payload.requestId.trim().length === 0 ||
    typeof payload.userId !== "string" ||
    payload.userId.trim().length === 0 ||
    !VALID_ACTIONS.has(payload.action) ||
    typeof payload.payloadHash !== "string" ||
    payload.payloadHash.trim().length === 0
  ) {
    throw new Error(
      "UNAUTHORIZED_PERSISTENCE_CALL: GovernanceProof payload is missing required fields.",
    );
  }

  // Expiration check (60-second window)
  const now = Date.now();
  if (
    typeof payload.expiresAt !== "number" ||
    !Number.isFinite(payload.expiresAt) ||
    now > payload.expiresAt
  ) {
    securityAuditLogger.logEvent({
      eventType: "TOOL_BLOCKED",
      actor: { identityId: payload.userId || "unknown", role: "standard", ipAddress: "127.0.0.1" },
      target: { resource: "memories.json" },
      decision: "BLOCK",
      reason: "GOVERNANCE_PROOF_EXPIRED: Proof validity window exceeded (60s).",
      riskLevel: "HIGH",
      metadata: { proofId: payload.proofId, requestId: payload.requestId },
    });
    throw new Error(
      "GOVERNANCE_PROOF_EXPIRED: GovernanceProof has expired (60-second window exceeded).",
    );
  }

  // IssuedAt / TTL sanity validation
  if (
    typeof payload.issuedAt !== "number" ||
    !Number.isFinite(payload.issuedAt) ||
    payload.issuedAt > now + 5_000 ||
    payload.expiresAt <= payload.issuedAt ||
    payload.expiresAt - payload.issuedAt > MAX_PROOF_TTL_MS ||
    payload.destinationStorage !== "memories.json" ||
    typeof payload.nonce !== "string" ||
    payload.nonce.length < 8
  ) {
    securityAuditLogger.logEvent({
      eventType: "TOOL_BLOCKED",
      actor: { identityId: payload.userId || "unknown", role: "standard", ipAddress: "127.0.0.1" },
      target: { resource: "memories.json" },
      decision: "BLOCK",
      reason: "UNAUTHORIZED_PERSISTENCE_CALL: Malformed GovernanceProof metadata or TTL.",
      riskLevel: "CRITICAL",
      metadata: { proofId: payload.proofId, requestId: payload.requestId },
    });
    throw new Error(
      "UNAUTHORIZED_PERSISTENCE_CALL: GovernanceProof metadata, destinationStorage, or TTL is invalid.",
    );
  }

  // HMAC-SHA256 signature verification via module-private secret
  const signaturesMatch = verifyGovernanceProofSignature(payload, signature);
  if (!signaturesMatch) {
    securityAuditLogger.logEvent({
      eventType: "TOOL_BLOCKED",
      actor: { identityId: payload.userId || "unknown", role: "standard", ipAddress: "127.0.0.1" },
      target: { resource: "memories.json" },
      decision: "BLOCK",
      reason: "UNAUTHORIZED_PERSISTENCE_CALL: GovernanceProof HMAC signature mismatch.",
      riskLevel: "CRITICAL",
      metadata: { proofId: payload.proofId, requestId: payload.requestId },
    });
    throw new Error(
      "UNAUTHORIZED_PERSISTENCE_CALL: Attempted execution of persistence adapter without a valid runtime GovernanceProof.",
    );
  }

  // FINDING-AUD-01: Mandatory cryptographic binding to expected MemoryWriteRequest
  if (expectedRequest !== undefined) {
    if (!expectedRequest || typeof expectedRequest !== "object") {
      throw new Error(
        "GOVERNANCE_PROOF_MISMATCH: Expected MemoryWriteRequest is missing or invalid.",
      );
    }

    // Proposal state checks
    if (expectedRequest.approved === false) {
      throw new Error(
        "PROPOSAL_NOT_PENDING: Cannot persist a rejected memory write request.",
      );
    }
    if (expectedRequest.approved === true) {
      throw new Error(
        "PROPOSAL_ALREADY_APPROVED: Memory write request has already been committed.",
      );
    }
    if (
      expectedRequest.expiresAt &&
      new Date(expectedRequest.expiresAt).getTime() < now
    ) {
      throw new Error(
        "REQUEST_EXPIRED: Target MemoryWriteRequest has expired.",
      );
    }

    const expectedTargetId = expectedRequest.proposedMemory?.id ?? undefined;
    const proofTargetId = payload.targetMemoryId ?? undefined;
    const expectedVersion = (expectedRequest as any).expectedVersion ?? undefined;
    const proofExpectedVersion = payload.expectedVersion ?? undefined;
    const recomputedPayloadHash = computeCanonicalPayloadHash(
      expectedRequest.proposedMemory || {},
    );

    const mismatches: string[] = [];
    if (payload.requestId !== expectedRequest.id) mismatches.push("requestId");
    if (payload.action !== expectedRequest.action) mismatches.push("action");
    if (payload.userId !== expectedRequest.userId) mismatches.push("userId");
    if (payload.destinationStorage !== "memories.json") mismatches.push("destinationStorage");
    if (proofTargetId !== expectedTargetId) mismatches.push("targetMemoryId");
    if (
      MUTATION_ACTIONS_REQUIRING_TARGET.has(expectedRequest.action) &&
      (!proofTargetId || typeof proofTargetId !== "string")
    ) {
      mismatches.push("targetMemoryId_required");
    }
    if (proofExpectedVersion !== expectedVersion) mismatches.push("expectedVersion");
    if (
      expectedRequest.payloadHash &&
      expectedRequest.payloadHash !== recomputedPayloadHash
    ) {
      mismatches.push("requestPayloadHash");
    }
    if (payload.payloadHash !== recomputedPayloadHash) {
      mismatches.push("proofPayloadHash");
    }
    if (expectedRequest.source && payload.source !== expectedRequest.source) {
      mismatches.push("source");
    }
    if (expectedRequest.provenance && payload.provenance !== expectedRequest.provenance) {
      mismatches.push("provenance");
    }

    if (mismatches.length > 0) {
      securityAuditLogger.logEvent({
        eventType: "TOOL_BLOCKED",
        actor: {
          identityId: expectedRequest.userId || payload.userId || "unknown",
          role: "standard",
          ipAddress: "127.0.0.1",
        },
        target: { resource: "memories.json" },
        decision: "BLOCK",
        reason: `GOVERNANCE_PROOF_MISMATCH: Proof binding mismatch on [${mismatches.join(", ")}].`,
        riskLevel: "CRITICAL",
        metadata: {
          proofId: payload.proofId,
          proofRequestId: payload.requestId,
          requestId: expectedRequest.id,
          mismatches,
        },
      });
      throw new Error(
        `GOVERNANCE_PROOF_MISMATCH: GovernanceProof does not match target MemoryWriteRequest (${mismatches.join(", ")}).`,
      );
    }
  }
}

/**
 * Run a persistence callback under an active, cryptographically verified,
 * single-use persistence session.
 *
 * Security Invariants:
 * 1. Requires BOTH a valid GovernanceProof AND the matching MemoryWriteRequest.
 * 2. Verifies HMAC-SHA256, expiry, and exact request/payload binding.
 * 3. Rejects concurrent executions of the same proof (GOVERNANCE_PROOF_IN_FLIGHT).
 * 4. Rejects sequential replay of any previously consumed proof (GOVERNANCE_PROOF_ALREADY_CONSUMED).
 * 5. Consumes proofId atomically BEFORE executing callback (fail-closed on write error).
 * 6. Runs callback inside module-private AsyncLocalStorage and cleans up in finally.
 */
export async function runAuthorizedPersistence<T>(
  proof: GovernanceProof,
  expectedRequest: MemoryWriteRequest,
  fn: (session: { proofId: string }) => Promise<T>,
): Promise<T> {
  if (!expectedRequest || typeof fn !== "function") {
    throw new Error(
      "UNAUTHORIZED_PERSISTENCE_CALL: Both GovernanceProof and bound MemoryWriteRequest are required.",
    );
  }

  // Step 1: Cryptographically verify proof + exact binding to request
  verifyGovernanceProof(proof, expectedRequest);

  const proofId = proof.payload.proofId;

  // Step 2: Concurrency check
  if (_activeSessions.has(proofId)) {
    securityAuditLogger.logEvent({
      eventType: "TOOL_BLOCKED",
      actor: { identityId: proof.payload.userId || "unknown", role: "standard", ipAddress: "127.0.0.1" },
      target: { resource: "memories.json" },
      decision: "BLOCK",
      reason: "GOVERNANCE_PROOF_IN_FLIGHT: Concurrent execution of same proof blocked.",
      riskLevel: "HIGH",
      metadata: { proofId, requestId: proof.payload.requestId },
    });
    throw new Error(
      "GOVERNANCE_PROOF_IN_FLIGHT: A concurrent persistence operation is already in progress for this proof.",
    );
  }

  // Step 3: Single-use replay check (FINDING-AUD-02)
  if (_consumedProofs.has(proofId)) {
    securityAuditLogger.logEvent({
      eventType: "TOOL_BLOCKED",
      actor: { identityId: proof.payload.userId || "unknown", role: "standard", ipAddress: "127.0.0.1" },
      target: { resource: "memories.json" },
      decision: "BLOCK",
      reason: "GOVERNANCE_PROOF_ALREADY_CONSUMED: Replay of consumed proof blocked in persistence context.",
      riskLevel: "CRITICAL",
      metadata: { proofId, requestId: proof.payload.requestId },
    });
    throw new Error(
      "GOVERNANCE_PROOF_ALREADY_CONSUMED: This GovernanceProof has already been consumed.",
    );
  }

  // Step 4: Fail-closed atomic consumption + ephemeral 256-bit session capability
  _pruneExpiredConsumedProofs(Date.now());
  _consumedProofs.set(proofId, proof.payload.expiresAt);

  const sessionToken = crypto.randomBytes(32).toString("hex");
  const session: PersistenceSession = {
    sessionToken,
    proofId,
    requestId: expectedRequest.id,
    expiresAt: proof.payload.expiresAt,
  };
  _activeSessions.set(proofId, session);

  try {
    // Step 5: Execute inside private AsyncLocalStorage
    return await _storageContext.run(session, async () => {
      return await fn({ proofId });
    });
  } finally {
    // Step 6: Always deregister active session immediately upon return or exception
    // Note: proofId remains in _consumedProofs so failed attempts cannot be replayed.
    _activeSessions.delete(proofId);
  }
}

/**
 * Called strictly by MemoryStore.save() to assert that an active, verified
 * persistence session is in flight.
 */
export function assertActivePersistenceSession(): { proofId: string } {
  const session = _storageContext.getStore();
  if (!session) {
    securityAuditLogger.logEvent({
      eventType: "TOOL_BLOCKED",
      actor: { identityId: "unknown", role: "standard", ipAddress: "127.0.0.1" },
      target: { resource: "memories.json" },
      decision: "BLOCK",
      reason: "FORBIDDEN_STORAGE_WRITE: Direct invocation of MemoryStore.save() outside authorized persistence context.",
      riskLevel: "CRITICAL",
    });
    throw new Error(
      "FORBIDDEN_STORAGE_WRITE: Direct invocation of MemoryStore.save() is blocked. Writes must pass through ApprovedMemoryPersistenceAdapter with a valid GovernanceProof.",
    );
  }

  // Cross-check session against active registry
  const registered = _activeSessions.get(session.proofId);
  if (!registered || registered.sessionToken !== session.sessionToken || Date.now() > registered.expiresAt) {
    securityAuditLogger.logEvent({
      eventType: "TOOL_BLOCKED",
      actor: { identityId: "unknown", role: "standard", ipAddress: "127.0.0.1" },
      target: { resource: "memories.json" },
      decision: "BLOCK",
      reason: "FORBIDDEN_STORAGE_WRITE: Persistence session is invalid, forged, or expired.",
      riskLevel: "CRITICAL",
      metadata: { proofId: session.proofId },
    });
    throw new Error(
      "FORBIDDEN_STORAGE_WRITE: Invalid or unauthenticated persistence session. Forged context detected.",
    );
  }

  return { proofId: session.proofId };
}

/**
 * Test-only reset for consumed proof registry.
 */
export function _clearPersistenceContextForTesting(): void {
  _consumedProofs.clear();
  _activeSessions.clear();
}
