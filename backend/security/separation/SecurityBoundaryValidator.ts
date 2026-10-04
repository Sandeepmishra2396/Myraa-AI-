/**
 * MYRAA — SecurityBoundaryValidator (Phase 26)
 *
 * Pre-Execution Cryptographic and Integrity Validator.
 *
 * Invariants:
 *   1. Execution CANNOT occur without passing this validator.
 *   2. Cryptographically verifies HMAC signature against SecurityAuthority.
 *   3. Enforces strict anti-tamper argument binding via SHA-256 fingerprint matching.
 *   4. Strictly prevents replay attacks (consumed decisions are rejected).
 *   5. Strictly enforces TTL expiration.
 *   6. Immediately halts if Emergency Stop became active after decision issuance.
 */

import { emergencyStopCoordinator } from "../../remote/EmergencyStopCoordinator.ts";
import type {
  SecurityDecision,
  AIActionProposal,
  DecisionValidationResult,
  BoundaryViolation,
} from "./SecurityIntentTypes.ts";
import {
  computeDecisionFingerprint,
  verifyDecisionSignature,
  isDecisionExpired,
} from "./SecurityDecision.ts";
import { securityAuthority } from "./SecurityAuthority.ts";

export class SecurityBoundaryValidator {
  /**
   * Validates a SecurityDecision against incoming execution parameters and system state.
   */
  validateDecision(params: {
    decision: SecurityDecision;
    actualToolName: string;
    actualArgs: Record<string, unknown>;
    proposal?: AIActionProposal;
    now?: number;
  }): DecisionValidationResult {
    const { decision, actualToolName, actualArgs, proposal } = params;
    const now = params.now || Date.now();

    // ── 1. Null / Structural Check ─────────────────────────────────────────
    if (!decision || typeof decision !== "object" || !decision.decisionId) {
      return {
        valid: false,
        violation: {
          type: "DECISION_FORGERY",
          message: "Missing or malformed security decision.",
          timestamp: now,
        },
      };
    }

    // ── 2. Emergency Stop Killswitch (Post-Issuance Check) ─────────────────
    if (emergencyStopCoordinator.isActive()) {
      return {
        valid: false,
        violation: {
          type: "EMERGENCY_STOP_ACTIVE",
          message: "Emergency stop killswitch is active. All executions are halted.",
          decisionId: decision.decisionId,
          proposalId: decision.proposalId,
          toolName: actualToolName,
          timestamp: now,
        },
      };
    }

    // ── 3. Decision Replay Check ──────────────────────────────────────────
    if (decision.consumed) {
      return {
        valid: false,
        violation: {
          type: "REPLAY_ATTACK",
          message: `Decision '${decision.decisionId}' has already been consumed and cannot be reused.`,
          decisionId: decision.decisionId,
          proposalId: decision.proposalId,
          toolName: actualToolName,
          timestamp: now,
        },
      };
    }

    // ── 4. Decision Expiration Check ──────────────────────────────────────
    if (isDecisionExpired(decision, now)) {
      return {
        valid: false,
        violation: {
          type: "EXPIRED_DECISION",
          message: `Decision '${decision.decisionId}' expired at ${new Date(decision.expiresAt).toISOString()}.`,
          decisionId: decision.decisionId,
          proposalId: decision.proposalId,
          toolName: actualToolName,
          timestamp: now,
        },
      };
    }

    // ── 5. Decision Allowance Check ───────────────────────────────────────
    if (!decision.allowed || decision.decision !== "ALLOW") {
      return {
        valid: false,
        violation: {
          type: "UNAUTHORIZED_EXECUTION",
          message: `Decision '${decision.decisionId}' is not in ALLOW state (state: ${decision.decision}, allowed: ${decision.allowed}).`,
          decisionId: decision.decisionId,
          proposalId: decision.proposalId,
          toolName: actualToolName,
          timestamp: now,
        },
      };
    }

    // ── 6. Proposal Linkage (if proposal supplied) ─────────────────────────
    if (proposal) {
      if (decision.proposalId !== proposal.proposalId) {
        return {
          valid: false,
          violation: {
            type: "PROPOSAL_FORGERY",
            message: `Proposal ID mismatch: Decision bound to '${decision.proposalId}', but received '${proposal.proposalId}'.`,
            decisionId: decision.decisionId,
            proposalId: proposal.proposalId,
            timestamp: now,
          },
        };
      }
    }

    // ── 7. Tool Binding Check ─────────────────────────────────────────────
    if (decision.toolName !== actualToolName) {
      return {
        valid: false,
        violation: {
          type: "DISALLOWED_TOOL",
          message: `Tool mismatch: Decision authorized '${decision.toolName}', but attempted execution with '${actualToolName}'.`,
          decisionId: decision.decisionId,
          proposalId: decision.proposalId,
          toolName: actualToolName,
          timestamp: now,
        },
      };
    }

    // ── 8. Cryptographic Signature Verification ───────────────────────────
    const secret = securityAuthority.getSigningSecret();
    const isSigValid = verifyDecisionSignature(decision.fingerprint, decision.signature, secret);
    if (!isSigValid) {
      return {
        valid: false,
        violation: {
          type: "DECISION_FORGERY",
          message: `Cryptographic signature verification failed for decision '${decision.decisionId}'.`,
          decisionId: decision.decisionId,
          proposalId: decision.proposalId,
          toolName: actualToolName,
          timestamp: now,
        },
      };
    }

    // ── 9. Argument Tamper & Fingerprint Integrity ────────────────────────
    const expectedFingerprint = computeDecisionFingerprint({
      proposalId: decision.proposalId,
      toolName: actualToolName,
      args: actualArgs,
      riskLevel: decision.riskLevel,
      issuedAt: decision.issuedAt,
      requestedScope: decision.requestedScope ? [...decision.requestedScope] : undefined,
    });

    if (decision.fingerprint !== expectedFingerprint) {
      return {
        valid: false,
        violation: {
          type: "ARGUMENT_TAMPER",
          message: `Anti-tamper fingerprint mismatch for decision '${decision.decisionId}'. Execution arguments do not match approved decision.`,
          decisionId: decision.decisionId,
          proposalId: decision.proposalId,
          toolName: actualToolName,
          timestamp: now,
        },
      };
    }

    return {
      valid: true,
      decision,
    };
  }
}

export const securityBoundaryValidator = new SecurityBoundaryValidator();
