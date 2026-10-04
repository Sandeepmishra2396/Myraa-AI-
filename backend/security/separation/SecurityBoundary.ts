/**
 * MYRAA — SecurityBoundary (Phase 26)
 *
 * Core Trust Boundary Enforcement Layer.
 *
 * Invariants:
 *   1. AI Reasoning has ZERO authority.
 *   2. Intelligence cannot approve its own proposal, change security policy, or lower risk.
 *   3. Adversarial attempts to bypass policy, confirmation, firewall, or emergency stop
 *      are intercepted and classified as SECURITY_BOUNDARY_PROTECTED.
 *   4. Submissions from untrusted components are thoroughly sanitized and validated.
 */

import type { SecurityContext } from "../SecurityTypes.ts";
import { securityAuditLogger } from "../SecurityAuditLogger.ts";
import type {
  AIActionProposal,
  SecurityDecision,
  BoundaryViolation,
} from "./SecurityIntentTypes.ts";
import { securityAuthority } from "./SecurityAuthority.ts";
import { createSignedSecurityDecision } from "./SecurityDecision.ts";

/**
 * Adversarial regex patterns that attempt to instruct the system to bypass security.
 */
const ADVERSARIAL_INTENT_PATTERNS: Array<{ regex: RegExp; reason: string }> = [
  {
    regex: /(?:give\s+(?:yourself|me|ai)\s+(?:admin|permission|root|superuser|privilege))/i,
    reason: "Attempted privilege self-escalation",
  },
  {
    regex: /(?:ignore|bypass|disable|turn\s*off)\s+(?:security|policy|firewall|rules|guard)/i,
    reason: "Attempted security policy/firewall bypass",
  },
  {
    regex: /(?:ignore|bypass|skip|disable|suppress)\s+(?:confirmation|confirm|approval|prompt)/i,
    reason: "Attempted user confirmation bypass",
  },
  {
    regex: /(?:override|lower|change|fake)\s+(?:risk|risk\s*level|score)\s*(?:to\s*low)?/i,
    reason: "Attempted risk evaluation tampering",
  },
  {
    regex: /(?:ignore|override|bypass|disable)\s+emergency\s*stop/i,
    reason: "Attempted emergency stop bypass",
  },
  {
    regex: /(?:ignore|disable|turn\s*off|bypass)\s+lockdown/i,
    reason: "Attempted lockdown bypass",
  },
  {
    regex: /(?:modify|hack|patch|alter)\s+(?:securitypolicyengine|toolexecutionfirewall|securityriskengine)/i,
    reason: "Attempted security engine self-modification",
  },
  {
    regex: /(?:run|execute)\s+(?:as\s+admin|without\s+permission|without\s+check)/i,
    reason: "Attempted unauthorized privileged execution",
  },
];

export class SecurityBoundary {
  /**
   * Evaluates text for adversarial intent targeting security boundaries.
   */
  checkAdversarialIntent(text: string): { isAdversarial: boolean; reason?: string } {
    if (!text || typeof text !== "string") {
      return { isAdversarial: false };
    }

    for (const pattern of ADVERSARIAL_INTENT_PATTERNS) {
      if (pattern.regex.test(text)) {
        return {
          isAdversarial: true,
          reason: `SECURITY_BOUNDARY_PROTECTED: ${pattern.reason}.`,
        };
      }
    }

    return { isAdversarial: false };
  }

  /**
   * Submits an untrusted proposal across the trust boundary for authoritative evaluation.
   */
  async submitProposal(
    proposal: AIActionProposal,
    context: SecurityContext,
    confirmationToken?: string,
  ): Promise<SecurityDecision> {
    if (!proposal || typeof proposal !== "object") {
      throw new Error("SECURITY_BOUNDARY_VIOLATION: Proposal must be a valid object.");
    }

    // ── 1. Proposal Integrity Validation ──────────────────────────────────
    if (!proposal.proposalId || !proposal.toolName || !proposal.source) {
      const reason = "PROPOSAL_FORGERY: Proposal missing mandatory cryptographic identification.";
      securityAuditLogger.logEvent({
        eventType: "ARGUMENT_VIOLATION",
        actor: { identityId: context.identityId, role: context.role, ipAddress: context.ipAddress },
        target: { toolName: proposal.toolName || "unknown" },
        metadata: { proposalId: proposal.proposalId },
        decision: "BLOCK",
        reason,
        riskLevel: "CRITICAL",
      });

      return createSignedSecurityDecision({
        proposalId: proposal.proposalId || "invalid-proposal",
        toolName: proposal.toolName || "unknown",
        args: {},
        decision: "BLOCK",
        allowed: false,
        riskLevel: "CRITICAL",
        riskScore: 100,
        reasons: [reason],
        requiresConfirmation: false,
        authorizedBy: "SECURITY_AUTHORITY",
        secret: securityAuthority.getSigningSecret(),
      });
    }

    // ── 2. Adversarial Intent Scanning ────────────────────────────────────
    const intentCheck = this.checkAdversarialIntent(proposal.intentDescription || "");
    if (intentCheck.isAdversarial) {
      const reason = intentCheck.reason!;
      securityAuditLogger.logEvent({
        eventType: "CRITICAL_COMMAND_BLOCKED",
        actor: { identityId: context.identityId, role: context.role, ipAddress: context.ipAddress },
        target: { toolName: proposal.toolName },
        metadata: { proposalId: proposal.proposalId },
        decision: "BLOCK",
        reason,
        riskLevel: "CRITICAL",
      });

      return createSignedSecurityDecision({
        proposalId: proposal.proposalId,
        toolName: proposal.toolName,
        args: proposal.args,
        decision: "BLOCK",
        allowed: false,
        riskLevel: "CRITICAL",
        riskScore: 100,
        reasons: [reason],
        requiresConfirmation: false,
        authorizedBy: "SECURITY_AUTHORITY",
        secret: securityAuthority.getSigningSecret(),
        requestedScope: proposal.requestedScope,
      });
    }

    // Also scan string arguments for adversarial injection instructions
    for (const [key, val] of Object.entries(proposal.args || {})) {
      if (typeof val === "string") {
        const argIntent = this.checkAdversarialIntent(val);
        if (argIntent.isAdversarial) {
          const reason = `${argIntent.reason} (Detected in argument '${key}').`;
          securityAuditLogger.logEvent({
            eventType: "CRITICAL_COMMAND_BLOCKED",
            actor: { identityId: context.identityId, role: context.role, ipAddress: context.ipAddress },
            target: { toolName: proposal.toolName },
            metadata: { proposalId: proposal.proposalId, key },
            decision: "BLOCK",
            reason,
            riskLevel: "CRITICAL",
          });

          return createSignedSecurityDecision({
            proposalId: proposal.proposalId,
            toolName: proposal.toolName,
            args: proposal.args,
            decision: "BLOCK",
            allowed: false,
            riskLevel: "CRITICAL",
            riskScore: 100,
            reasons: [reason],
            requiresConfirmation: false,
            authorizedBy: "SECURITY_AUTHORITY",
            secret: securityAuthority.getSigningSecret(),
            requestedScope: proposal.requestedScope,
          });
        }
      }
    }

    // ── 3. Forward to Authoritative SecurityAuthority ─────────────────────
    return securityAuthority.evaluateProposal(proposal, context, confirmationToken);
  }
}

export const securityBoundary = new SecurityBoundary();
