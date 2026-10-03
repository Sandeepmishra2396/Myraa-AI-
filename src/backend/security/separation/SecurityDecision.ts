/**
 * MYRAA — SecurityDecision (Phase 26)
 *
 * Cryptographic Security Decision Primitives and Verification Utilities.
 *
 * Invariants:
 *   1. Decisions can ONLY be generated and signed by the authoritative security layer.
 *   2. Cryptographically binds proposalId, toolName, canonical args, riskLevel, and timestamp.
 *   3. Enforces constant-time HMAC-SHA256 signature verification to prevent timing attacks.
 *   4. Strictly immutable decision objects.
 */

import crypto from "crypto";
import type { RiskLevel } from "../SecurityTypes.ts";
import type {
  SecurityDecision,
  DecisionOutcome,
} from "./SecurityIntentTypes.ts";
import { canonicalizeArguments } from "./SecurityProposal.ts";

/**
 * Default decision validity TTL in milliseconds (60 seconds).
 */
export const DEFAULT_DECISION_TTL_MS = 60 * 1000;

/**
 * Computes an immutable SHA-256 fingerprint binding the decision's core parameters.
 */
export function computeDecisionFingerprint(params: {
  proposalId: string;
  toolName: string;
  args: Record<string, unknown>;
  riskLevel: RiskLevel;
  issuedAt: number;
  requestedScope?: string[];
}): string {
  const canonicalArgs = canonicalizeArguments(params.args);
  const scopeStr = params.requestedScope && params.requestedScope.length > 0
    ? [...params.requestedScope].sort().join(",")
    : "";

  const payload = [
    params.proposalId,
    params.toolName,
    canonicalArgs,
    params.riskLevel,
    params.issuedAt.toString(),
    scopeStr,
  ].join("|");

  return crypto.createHash("sha256").update(payload, "utf8").digest("hex");
}

/**
 * Signs a decision fingerprint with HMAC-SHA256 using the security authority secret.
 */
export function signDecisionFingerprint(fingerprint: string, secret: string): string {
  if (!secret) {
    throw new Error("SECURITY_SECRET_REQUIRED: Cannot sign decision without secret.");
  }
  return crypto.createHmac("sha256", secret).update(fingerprint, "utf8").digest("hex");
}

/**
 * Verifies that a decision signature matches the expected HMAC of the fingerprint
 * using constant-time comparison to prevent timing side-channel attacks.
 */
export function verifyDecisionSignature(
  fingerprint: string,
  signature: string,
  secret: string,
): boolean {
  if (!fingerprint || !signature || !secret) {
    return false;
  }

  try {
    const expectedSig = crypto.createHmac("sha256", secret).update(fingerprint, "utf8").digest("hex");
    const sigBuf = Buffer.from(signature, "hex");
    const expectedBuf = Buffer.from(expectedSig, "hex");

    if (sigBuf.length !== expectedBuf.length) {
      return false;
    }

    return crypto.timingSafeEqual(sigBuf, expectedBuf);
  } catch {
    return false;
  }
}

/**
 * Checks if a security decision has expired.
 */
export function isDecisionExpired(decision: SecurityDecision, now = Date.now()): boolean {
  return now > decision.expiresAt;
}

/**
 * Options for constructing a new signed SecurityDecision.
 */
export interface CreateSecurityDecisionOptions {
  proposalId: string;
  toolName: string;
  args: Record<string, unknown>;
  decision: DecisionOutcome;
  allowed: boolean;
  riskLevel: RiskLevel;
  riskScore: number;
  reasons: string[];
  requiresConfirmation: boolean;
  confirmationToken?: string;
  authorizedBy:
    | "SECURITY_POLICY_ENGINE"
    | "EMERGENCY_STOP"
    | "LOCKDOWN_POLICY"
    | "SECURITY_AUTHORITY";
  secret: string;
  ttlMs?: number;
  requestedScope?: string[];
}

/**
 * Creates and signs an immutable SecurityDecision.
 */
export function createSignedSecurityDecision(
  options: CreateSecurityDecisionOptions,
): SecurityDecision {
  const decisionId = crypto.randomUUID();
  const issuedAt = Date.now();
  const expiresAt = issuedAt + (options.ttlMs || DEFAULT_DECISION_TTL_MS);

  const fingerprint = computeDecisionFingerprint({
    proposalId: options.proposalId,
    toolName: options.toolName,
    args: options.args,
    riskLevel: options.riskLevel,
    issuedAt,
    requestedScope: options.requestedScope,
  });

  const signature = signDecisionFingerprint(fingerprint, options.secret);

  const decision: SecurityDecision = {
    decisionId,
    proposalId: options.proposalId,
    toolName: options.toolName,
    decision: options.decision,
    allowed: options.allowed,
    riskLevel: options.riskLevel,
    riskScore: options.riskScore,
    reasons: Object.freeze([...options.reasons]),
    requiresConfirmation: options.requiresConfirmation,
    confirmationToken: options.confirmationToken,
    fingerprint,
    signature,
    issuedAt,
    expiresAt,
    authorizedBy: options.authorizedBy,
    requestedScope: options.requestedScope ? Object.freeze([...options.requestedScope]) : undefined,
    consumed: false,
    consumedAt: undefined,
  };

  return Object.freeze(decision);
}

/**
 * Creates a consumed clone of a decision.
 */
export function markDecisionConsumed(decision: SecurityDecision, consumedAt = Date.now()): SecurityDecision {
  const updated: SecurityDecision = {
    ...decision,
    consumed: true,
    consumedAt,
  };
  return Object.freeze(updated);
}
