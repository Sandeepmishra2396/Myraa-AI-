import crypto from "crypto";
import type {
  GovernanceProof,
  GovernanceProofPayload,
} from "./GoverningMemoryTypes.ts";

// Module-level ephemeral HMAC secret for governance proof signing.
// Rotates on every server restart — proofs are only valid for the lifetime of the process.
// STRICTLY MODULE-PRIVATE: NEVER exported or returned to callers (FINDING-AUD-02).
const INTERNAL_PERSISTENCE_SECRET = crypto.randomBytes(32);

// One-time signer capability claim guard — only GoverningMemoryGate may claim
// the signing closure at module initialization time.
let _signerClaimed = false;

/**
 * Recursively sort keys for deterministic canonical JSON serialization.
 */
export function canonicalizeGovernanceObject(obj: unknown): unknown {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(canonicalizeGovernanceObject);
  const sortedKeys = Object.keys(obj as Record<string, unknown>).sort();
  const result: Record<string, unknown> = {};
  for (const k of sortedKeys) {
    const v = (obj as Record<string, unknown>)[k];
    if (v !== undefined) {
      result[k] = canonicalizeGovernanceObject(v);
    }
  }
  return result;
}

/**
 * Compute deterministic SHA-256 hash of a canonicalized payload object.
 */
export function computeCanonicalPayloadHash(payload: unknown): string {
  const canonicalStr = JSON.stringify(canonicalizeGovernanceObject(payload ?? {}));
  return crypto.createHash("sha256").update(canonicalStr, "utf8").digest("hex");
}

/**
 * One-time capability claim for minting GovernanceProof signatures.
 * Must ONLY be invoked once by GoverningMemoryGate during module initialization.
 * Any subsequent call is rejected fail-closed so external in-process callers
 * cannot acquire signing authority.
 */
export function claimGovernanceProofSigner(): (
  payload: GovernanceProofPayload,
) => GovernanceProof {
  if (_signerClaimed) {
    throw new Error(
      "UNAUTHORIZED_SIGNER_CLAIM: Governance proof signing capability has already been claimed.",
    );
  }
  _signerClaimed = true;

  return (payload: GovernanceProofPayload): GovernanceProof => {
    const canonicalStr = JSON.stringify(canonicalizeGovernanceObject(payload));
    const signature = crypto
      .createHmac("sha256", INTERNAL_PERSISTENCE_SECRET)
      .update(canonicalStr, "utf8")
      .digest("hex");
    return {
      payload: Object.freeze({ ...payload }),
      signature,
    };
  };
}

/**
 * Constant-time HMAC-SHA256 verification of a GovernanceProof payload and signature.
 * Safe to invoke from trusted verifiers because it never exposes the signing key
 * and cannot mint signatures.
 */
export function verifyGovernanceProofSignature(
  payload: GovernanceProofPayload,
  signature: string,
): boolean {
  if (
    !payload ||
    typeof payload !== "object" ||
    typeof signature !== "string" ||
    !/^[0-9a-f]{64}$/i.test(signature)
  ) {
    return false;
  }

  const canonicalStr = JSON.stringify(canonicalizeGovernanceObject(payload));
  const expectedSignature = crypto
    .createHmac("sha256", INTERNAL_PERSISTENCE_SECRET)
    .update(canonicalStr, "utf8")
    .digest("hex");

  const sigBufProvided = Buffer.from(signature.toLowerCase(), "hex");
  const sigBufExpected = Buffer.from(expectedSignature, "hex");

  return (
    sigBufProvided.length === 32 &&
    sigBufProvided.length === sigBufExpected.length &&
    crypto.timingSafeEqual(sigBufProvided, sigBufExpected)
  );
}
