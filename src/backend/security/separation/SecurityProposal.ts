/**
 * MYRAA — SecurityProposal (Phase 26)
 *
 * Untrusted AI Action Proposal Factory & Sanitizer.
 *
 * Invariants:
 *   1. All AI proposals are UNTRUSTED by default.
 *   2. Any attempt by AI to smuggle privilege overrides, bypass flags, or
 *      self-assigned permissions is aggressively stripped.
 *   3. AI-provided risk hints are purely advisory and cannot lower risk.
 *   4. Immutable proposal objects prevent tampering downstream.
 */

import crypto from "crypto";
import type {
  AIActionProposal,
  ProposeActionOptions,
  ProposalSource,
} from "./SecurityIntentTypes.ts";

/**
 * Disallowed keys in proposed arguments that attempt to inject or simulate
 * security overrides, privileges, or policy bypasses.
 */
const FORBIDDEN_OVERRIDE_KEYS = new Set<string>([
  "bypassSecurity",
  "bypasssecurity",
  "forceExecute",
  "forceexecute",
  "skipConfirmation",
  "skipconfirmation",
  "overrideRisk",
  "overriderisk",
  "adminExecute",
  "adminexecute",
  "elevated",
  "elevatePrivilege",
  "ignoreFirewall",
  "ignoreLockdown",
  "ignoreEmergencyStop",
  "allowBypass",
  "skipValidation",
  "trustModel",
  "root",
  "sudo",
  "superuser",
  "bypassRBAC",
  "bypassPolicy",
  "bypassSandbox",
  "selfApprove",
  "autoApprove",
]);

/**
 * Deterministically produces a canonical JSON string with sorted keys,
 * ensuring consistent hashing and fingerprint generation.
 */
export function canonicalizeArguments(args: Record<string, unknown>): string {
  if (!args || typeof args !== "object") return "{}";

  const sortKeys = (obj: any): any => {
    if (obj === null || typeof obj !== "object") return obj;
    if (Array.isArray(obj)) return obj.map(sortKeys);
    const sorted: Record<string, any> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = sortKeys(obj[key]);
    }
    return sorted;
  };

  return JSON.stringify(sortKeys(args));
}

/**
 * Sanitizes arguments submitted by an AI agent, removing any security override flags.
 */
export function sanitizeProposedArguments(rawArgs: Record<string, unknown>): Record<string, unknown> {
  if (!rawArgs || typeof rawArgs !== "object") {
    return {};
  }

  const clean: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(rawArgs)) {
    // Strip any forbidden override key (case-insensitive check)
    if (FORBIDDEN_OVERRIDE_KEYS.has(key) || FORBIDDEN_OVERRIDE_KEYS.has(key.toLowerCase())) {
      continue;
    }

    // Strip attempts to override role or privileges inside args
    if (key.toLowerCase() === "role" && typeof value === "string") {
      continue;
    }
    if (key.toLowerCase() === "isadmin" || key.toLowerCase() === "admin") {
      continue;
    }

    // Recursively sanitize nested objects
    if (value && typeof value === "object" && !Array.isArray(value)) {
      clean[key] = sanitizeProposedArguments(value as Record<string, unknown>);
    } else {
      clean[key] = value;
    }
  }

  return clean;
}

/**
 * Valid proposal source validator.
 */
export function isValidProposalSource(source: string): source is ProposalSource {
  return [
    "PLANNER",
    "CODER",
    "RESEARCHER",
    "PROACTIVE",
    "RECOVERY",
    "USER_CHAT",
    "CRITIC",
    "VERIFIER",
    "UNKNOWN",
  ].includes(source);
}

/**
 * Factory for creating immutable, sanitized AIActionProposal instances.
 */
export function createAIActionProposal(options: ProposeActionOptions): AIActionProposal {
  if (!options || typeof options !== "object") {
    throw new Error("PROPOSAL_INVALID: Options must be a valid object.");
  }

  const toolName = typeof options.toolName === "string" ? options.toolName.trim() : "";
  if (!toolName) {
    throw new Error("PROPOSAL_INVALID: Tool name must be a non-empty string.");
  }

  const source: ProposalSource = isValidProposalSource(options.source) ? options.source : "UNKNOWN";
  const intentDescription = typeof options.intentDescription === "string" ? options.intentDescription.trim() : "";
  const requestedScope = Array.isArray(options.requestedScope)
    ? options.requestedScope.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    : [];

  const sanitizedArgs = sanitizeProposedArguments(options.args || {});
  const proposalId = crypto.randomUUID();
  const nonce = crypto.randomBytes(16).toString("hex");
  const createdAt = Date.now();

  const proposal: AIActionProposal = {
    proposalId,
    source,
    toolName,
    args: sanitizedArgs,
    intentDescription,
    requestedScope: requestedScope.length > 0 ? requestedScope : undefined,
    riskHint: typeof options.riskHint === "string" ? options.riskHint.trim() : undefined,
    modelMetadata: options.modelMetadata ? { ...options.modelMetadata } : undefined,
    createdAt,
    nonce,
  };

  return Object.freeze(proposal);
}
