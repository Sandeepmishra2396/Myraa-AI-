/**
 * MYRAA — GoverningMemoryTypes (Stage 10 Phase 1)
 *
 * Types for memory write governance, user confirmation requests,
 * and cryptographic payload binding tokens.
 */

import type { EnhancedMemory, MemorySource } from "../memory/MemoryTypes.ts";
import type { IdentityRole } from "../security/SecurityTypes.ts";

export type MemoryWriteAction = "CREATE" | "UPDATE" | "ARCHIVE" | "MERGE" | "DELETE";

export type MemoryWritePolicy =
  | "always_ask"                    // MANDATORY DEFAULT: all writes require user approval
  | "auto_approve_high_confidence"  // UNRECOMMENDED OPT-IN: confidence >= 0.85
  | "session_only";                 // Reject all long-term persistence attempts

export interface MemoryWriteRequest {
  id: string;                       // UUID v4
  requestedAt: string;              // ISO8601
  action: MemoryWriteAction;
  proposedMemory: Partial<EnhancedMemory>;
  payloadHash: string;              // SHA-256 of canonical JSON string of proposedMemory
  reason: string;                   // Human-readable explanation shown in confirmation modal
  confidence: number;               // 0.0 to 1.0
  source: MemorySource;
  userId: string;                   // "default"
  provenance: string;               // Originating turn or detector trace ID
  approved?: boolean;               // undefined = pending, true = approved, false = rejected
  approvedAt?: string;
  rejectedAt?: string;
  oneTimeToken: string;             // Ephemeral token bound to payloadHash
  expiresAt: string;                // Date.now() + 24 hours
}

export interface MemoryWriteApproval {
  requestId: string;
  approved: boolean;
  token: string;
  modifiedMemory?: Partial<EnhancedMemory>; // If user edited memory in approval dialog
}

// MemoryApprovalContext — actor identity for approveWrite calls
export interface MemoryApprovalContext {
  actorId: string;       // session.identityId (e.g. "local_operator")
  role: IdentityRole;    // session.role
  ipAddress: string;     // request IP
  sessionId?: string;    // operator session ID
  isStepUpAuthenticated?: boolean; // for sensitive categories
}

// PublicMemoryWriteRequest — redacts oneTimeToken from API responses
export type PublicMemoryWriteRequest = Omit<MemoryWriteRequest, "oneTimeToken">;

// GovernanceProofPayload — canonical binding for approved persistence proof
export interface GovernanceProofPayload {
  readonly proofId: string;
  readonly requestId: string;
  readonly userId: string;
  readonly action: "CREATE" | "UPDATE" | "MERGE" | "ARCHIVE" | "DELETE";
  readonly targetMemoryId?: string;
  readonly payloadHash: string;
  readonly provenance: string;
  readonly source: string;
  readonly destinationStorage: "memories.json";
  readonly expectedVersion?: number;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly nonce: string;
}

// GovernanceProof — runtime cryptographic capability token
export interface GovernanceProof {
  readonly payload: GovernanceProofPayload;
  readonly signature: string; // HMAC-SHA256(canonicalJSON(payload), INTERNAL_PERSISTENCE_SECRET)
}
