/**
 * MYRAA — SecurityAuthority (Phase 26)
 *
 * The SOLE Authoritative Entity permitted to evaluate proposals and issue signed SecurityDecisions.
 *
 * Invariants:
 *   1. AI Reasoning agents (Planner, Coder, Researcher, Recovery, Proactive)
 *      CANNOT invoke or bypass the SecurityAuthority.
 *   2. Evaluates proposals strictly against Emergency Stop, Lockdown, RBAC,
 *      Deterministic Risk, Argument Boundaries, and Confirmation gates.
 *   3. All issued decisions are cryptographically signed with HMAC-SHA256.
 *   4. Maintains an authoritative, anti-replay decision registry.
 */

import crypto from "crypto";
import type { SecurityContext, RiskLevel } from "../SecurityTypes.ts";
import {
  securityPolicyEngine,
  POLICY_SIGNING_SECRET,
  LOCKDOWN_ALLOWLIST,
} from "../SecurityPolicyEngine.ts";
import {
  securityRiskEngine,
  CRITICAL_TOOLS,
  HIGH_RISK_TOOLS,
} from "../SecurityRiskEngine.ts";
import { securityAuditLogger } from "../SecurityAuditLogger.ts";
import { emergencyStopCoordinator } from "../../remote/EmergencyStopCoordinator.ts";
import type {
  AIActionProposal,
  SecurityDecision,
  DecisionOutcome,
} from "./SecurityIntentTypes.ts";
import {
  createSignedSecurityDecision,
  markDecisionConsumed,
} from "./SecurityDecision.ts";

export class SecurityAuthority {
  private _decisions = new Map<string, SecurityDecision>();
  private _proposalToDecision = new Map<string, string>();
  private _signingSecret: string;

  constructor(secret = POLICY_SIGNING_SECRET) {
    this._signingSecret = secret;
  }

  resetForTesting(): void {
    this._decisions.clear();
    this._proposalToDecision.clear();
    this._signingSecret = POLICY_SIGNING_SECRET;
  }

  getSigningSecret(): string {
    return this._signingSecret;
  }

  setSigningSecretForTesting(secret: string): void {
    this._signingSecret = secret;
  }

  getDecision(decisionId: string): SecurityDecision | undefined {
    return this._decisions.get(decisionId);
  }

  getDecisionForProposal(proposalId: string): SecurityDecision | undefined {
    const decisionId = this._proposalToDecision.get(proposalId);
    return decisionId ? this._decisions.get(decisionId) : undefined;
  }

  /**
   * Authoritatively evaluates an untrusted AIActionProposal.
   */
  async evaluateProposal(
    proposal: AIActionProposal,
    context: SecurityContext,
    confirmationToken?: string,
  ): Promise<SecurityDecision> {
    if (!proposal || !proposal.proposalId || !proposal.toolName) {
      throw new Error("SECURITY_AUTHORITY_ERROR: Invalid proposal provided for evaluation.");
    }

    const { toolName, args, proposalId, requestedScope } = proposal;

    // ── 1. Emergency Stop Killswitch Check ──────────────────────────────────
    if (emergencyStopCoordinator.isActive()) {
      const reason = "EMERGENCY_STOP_ACTIVE: Operations suspended by emergency stop killswitch.";
      securityAuditLogger.logEvent({
        eventType: "TOOL_BLOCKED",
        actor: {
          identityId: context.identityId,
          role: context.role,
          ipAddress: context.ipAddress,
          isLocal: context.isLocal,
        },
        target: { toolName },
        decision: "BLOCK",
        reason,
        riskLevel: "CRITICAL",
      });

      const decision = createSignedSecurityDecision({
        proposalId,
        toolName,
        args,
        decision: "BLOCK",
        allowed: false,
        riskLevel: "CRITICAL",
        riskScore: 100,
        reasons: [reason],
        requiresConfirmation: false,
        authorizedBy: "EMERGENCY_STOP",
        secret: this._signingSecret,
        requestedScope,
      });

      this._recordDecision(decision);
      return decision;
    }

    // ── 2. Security Lockdown Check (Fail-closed except recovery allowlist) ────
    const currentMode = securityPolicyEngine.getMode();
    if (currentMode === "LOCKDOWN") {
      if (!LOCKDOWN_ALLOWLIST.has(toolName)) {
        const reason = `SECURITY_LOCKDOWN: Tool '${toolName}' is blocked. System is in fail-closed LOCKDOWN mode.`;
        securityAuditLogger.logEvent({
          eventType: "TOOL_BLOCKED",
          actor: {
            identityId: context.identityId,
            role: context.role,
            ipAddress: context.ipAddress,
            isLocal: context.isLocal,
          },
          target: { toolName },
          decision: "BLOCK",
          reason,
          riskLevel: "CRITICAL",
        });

        const decision = createSignedSecurityDecision({
          proposalId,
          toolName,
          args,
          decision: "BLOCK",
          allowed: false,
          riskLevel: "CRITICAL",
          riskScore: 100,
          reasons: [reason],
          requiresConfirmation: false,
          authorizedBy: "LOCKDOWN_POLICY",
          secret: this._signingSecret,
          requestedScope,
        });

        this._recordDecision(decision);
        return decision;
      }
    }

    // ── 3. Dynamic Tool Containment / Disable Check ────────────────────────
    if (securityPolicyEngine.isToolDisabled(toolName)) {
      const disabledTools = securityPolicyEngine.getDisabledTools();
      const info = disabledTools.find((d) => d.toolName === toolName);
      const reason = `TOOL_DISABLED: Tool '${toolName}' disabled by automated threat containment (${info?.reason || "active containment"}).`;

      securityAuditLogger.logEvent({
        eventType: "TOOL_BLOCKED",
        actor: {
          identityId: context.identityId,
          role: context.role,
          ipAddress: context.ipAddress,
          isLocal: context.isLocal,
        },
        target: { toolName },
        decision: "BLOCK",
        reason,
        riskLevel: "HIGH",
      });

      const decision = createSignedSecurityDecision({
        proposalId,
        toolName,
        args,
        decision: "BLOCK",
        allowed: false,
        riskLevel: "HIGH",
        riskScore: 85,
        reasons: [reason],
        requiresConfirmation: false,
        authorizedBy: "SECURITY_POLICY_ENGINE",
        secret: this._signingSecret,
        requestedScope,
      });

      this._recordDecision(decision);
      return decision;
    }

    // ── 4. Role-Based Access Control (RBAC) ────────────────────────────────
    if (context.role === "read_only" || context.role === "guest") {
      if (CRITICAL_TOOLS.has(toolName) || HIGH_RISK_TOOLS.has(toolName)) {
        const reason = `ROLE_PERMISSION_DENIED: Role '${context.role}' does not have permission to execute modifying tool '${toolName}'.`;
        securityAuditLogger.logEvent({
          eventType: "SECURITY_POLICY_VIOLATION",
          actor: {
            identityId: context.identityId,
            role: context.role,
            ipAddress: context.ipAddress,
            isLocal: context.isLocal,
          },
          target: { toolName },
          decision: "BLOCK",
          reason,
          riskLevel: "HIGH",
        });

        const decision = createSignedSecurityDecision({
          proposalId,
          toolName,
          args,
          decision: "BLOCK",
          allowed: false,
          riskLevel: "HIGH",
          riskScore: 80,
          reasons: [reason],
          requiresConfirmation: false,
          authorizedBy: "SECURITY_POLICY_ENGINE",
          secret: this._signingSecret,
          requestedScope,
        });

        this._recordDecision(decision);
        return decision;
      }
    }

    // ── 5. Argument Boundary Validation (Traversal, SSRF, injection) ───────
    const argCheck = await securityPolicyEngine.validateArguments(toolName, args);
    if (!argCheck.valid) {
      const reason = argCheck.reason || "ARGUMENT_VIOLATION: Validation failed.";
      securityAuditLogger.logEvent({
        eventType: "ARGUMENT_VIOLATION",
        actor: {
          identityId: context.identityId,
          role: context.role,
          ipAddress: context.ipAddress,
          isLocal: context.isLocal,
        },
        target: { toolName },
        metadata: { args },
        decision: "BLOCK",
        reason,
        riskLevel: "CRITICAL",
      });

      const decision = createSignedSecurityDecision({
        proposalId,
        toolName,
        args,
        decision: "BLOCK",
        allowed: false,
        riskLevel: "CRITICAL",
        riskScore: 95,
        reasons: [reason],
        requiresConfirmation: false,
        authorizedBy: "SECURITY_POLICY_ENGINE",
        secret: this._signingSecret,
        requestedScope,
      });

      this._recordDecision(decision);
      return decision;
    }

    // ── 6. Deterministic Risk Assessment via SecurityRiskEngine ───────────
    const risk = securityRiskEngine.calculateRisk(toolName, args, context, {
      currentMode,
    });

    if (risk.score >= 95 || (risk.level === "CRITICAL" && !risk.requiresConfirmation)) {
      const reason = `CRITICAL_SECURITY_BLOCK: Malicious/critical pattern detected in '${toolName}' (${risk.reasons.join("; ")}).`;
      securityAuditLogger.logEvent({
        eventType: "CRITICAL_COMMAND_BLOCKED",
        actor: {
          identityId: context.identityId,
          role: context.role,
          ipAddress: context.ipAddress,
          isLocal: context.isLocal,
        },
        target: { toolName },
        metadata: { args },
        decision: "BLOCK",
        reason,
        riskLevel: "CRITICAL",
      });

      const decision = createSignedSecurityDecision({
        proposalId,
        toolName,
        args,
        decision: "BLOCK",
        allowed: false,
        riskLevel: "CRITICAL",
        riskScore: risk.score,
        reasons: [reason],
        requiresConfirmation: false,
        authorizedBy: "SECURITY_POLICY_ENGINE",
        secret: this._signingSecret,
        requestedScope,
      });

      this._recordDecision(decision);
      return decision;
    }

    // ── 7. Confirmation Gate ──────────────────────────────────────────────
    if (risk.requiresConfirmation || risk.level === "HIGH" || risk.level === "CRITICAL") {
      if (!confirmationToken) {
        // Issue new single-use confirmation token
        const issuedToken = securityPolicyEngine.generateConfirmationToken(
          toolName,
          args,
          context.sessionId || "local",
        );
        const reason = `CONFIRMATION_REQUIRED: Action requires explicit user confirmation (${risk.reasons.join("; ")}).`;

        const decision = createSignedSecurityDecision({
          proposalId,
          toolName,
          args,
          decision: "REQUIRE_CONFIRMATION",
          allowed: false,
          riskLevel: risk.level,
          riskScore: risk.score,
          reasons: [reason, ...risk.reasons],
          requiresConfirmation: true,
          confirmationToken: issuedToken,
          authorizedBy: "SECURITY_POLICY_ENGINE",
          secret: this._signingSecret,
          requestedScope,
        });

        this._recordDecision(decision);
        return decision;
      }

      // Verify and consume confirmation token
      const tokenVerification = securityPolicyEngine.verifyAndConsumeConfirmation(
        confirmationToken,
        toolName,
        args,
        context.sessionId,
      );

      if (!tokenVerification.valid) {
        const reason = `CONFIRMATION_FAILED: ${tokenVerification.reason || "Invalid confirmation token."}`;
        securityAuditLogger.logEvent({
          eventType: "SECURITY_POLICY_VIOLATION",
          actor: {
            identityId: context.identityId,
            role: context.role,
            ipAddress: context.ipAddress,
            isLocal: context.isLocal,
          },
          target: { toolName },
          metadata: { args },
          decision: "BLOCK",
          reason,
          riskLevel: risk.level,
        });

        const decision = createSignedSecurityDecision({
          proposalId,
          toolName,
          args,
          decision: "BLOCK",
          allowed: false,
          riskLevel: risk.level,
          riskScore: risk.score,
          reasons: [reason],
          requiresConfirmation: true,
          authorizedBy: "SECURITY_POLICY_ENGINE",
          secret: this._signingSecret,
          requestedScope,
        });

        this._recordDecision(decision);
        return decision;
      }

      // Confirmed successfully
      const reason = `CONFIRMED: Explicit confirmation verified for '${toolName}'.`;
      const decision = createSignedSecurityDecision({
        proposalId,
        toolName,
        args,
        decision: "ALLOW",
        allowed: true,
        riskLevel: risk.level,
        riskScore: risk.score,
        reasons: [reason],
        requiresConfirmation: false,
        authorizedBy: "SECURITY_AUTHORITY",
        secret: this._signingSecret,
        requestedScope,
      });

      this._recordDecision(decision);
      return decision;
    }

    // ── 8. Standard ALLOW Path (LOW / MEDIUM) ──────────────────────────────
    const reason = `AUTHORIZED: Action '${toolName}' evaluated as ${risk.level} risk (${risk.score}/100).`;
    const decision = createSignedSecurityDecision({
      proposalId,
      toolName,
      args,
      decision: "ALLOW",
      allowed: true,
      riskLevel: risk.level,
      riskScore: risk.score,
      reasons: [reason],
      requiresConfirmation: false,
      authorizedBy: "SECURITY_AUTHORITY",
      secret: this._signingSecret,
      requestedScope,
    });

    this._recordDecision(decision);
    return decision;
  }

  /**
   * Authoritatively marks a decision as consumed upon successful execution.
   */
  consumeDecision(decisionId: string): SecurityDecision {
    const existing = this._decisions.get(decisionId);
    if (!existing) {
      throw new Error(`SECURITY_AUTHORITY_ERROR: Decision '${decisionId}' not found.`);
    }
    if (existing.consumed) {
      throw new Error(`SECURITY_AUTHORITY_ERROR: Decision '${decisionId}' has already been consumed.`);
    }

    const consumed = markDecisionConsumed(existing);
    this._decisions.set(decisionId, consumed);
    return consumed;
  }

  /**
   * Revokes an existing decision.
   */
  revokeDecision(decisionId: string, reason = "Revoked by SecurityAuthority"): boolean {
    const existing = this._decisions.get(decisionId);
    if (!existing) return false;

    // Replace with a BLOCK decision
    const revoked = createSignedSecurityDecision({
      proposalId: existing.proposalId,
      toolName: existing.toolName,
      args: {},
      decision: "BLOCK",
      allowed: false,
      riskLevel: "CRITICAL",
      riskScore: 100,
      reasons: [`DECISION_REVOKED: ${reason}`],
      requiresConfirmation: false,
      authorizedBy: "SECURITY_AUTHORITY",
      secret: this._signingSecret,
    });

    this._decisions.set(decisionId, revoked);
    return true;
  }

  getDecisionsCount(): { total: number; active: number; consumed: number } {
    let active = 0;
    let consumed = 0;
    const now = Date.now();
    for (const d of this._decisions.values()) {
      if (d.consumed) {
        consumed++;
      } else if (d.expiresAt > now) {
        active++;
      }
    }
    return {
      total: this._decisions.size,
      active,
      consumed,
    };
  }

  private _recordDecision(decision: SecurityDecision): void {
    this._decisions.set(decision.decisionId, decision);
    this._proposalToDecision.set(decision.proposalId, decision.decisionId);
  }
}

export const securityAuthority = new SecurityAuthority();
