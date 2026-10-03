/**
 * MYRAA — SecuritySeparationCoordinator (Phase 26)
 *
 * Master Orchestrator for Security + Intelligence Separation.
 *
 * Centralizes the end-to-end lifecycle:
 *   AI Proposal → Boundary Validation → Authoritative Evaluation → Pre-Execution Verification → Guarded Execution → Audit
 *
 * Invariants:
 *   1. Zero bypass channels exist.
 *   2. Intelligence cannot self-authorize or change security policy.
 *   3. All steps are strictly audited and bound to cryptographic tokens and signatures.
 */

import crypto from "crypto";
import type { SecurityContext, SecurityMode } from "../SecurityTypes.ts";
import { securityPolicyEngine } from "../SecurityPolicyEngine.ts";
import { emergencyStopCoordinator } from "../../remote/EmergencyStopCoordinator.ts";
import type {
  AIActionProposal,
  SecurityDecision,
  ProposeActionOptions,
  DecisionValidationResult,
  SeparationExecutionResult,
  SeparationAuditRecord,
  SecuritySeparationStatus,
  BoundaryViolation,
} from "./SecurityIntentTypes.ts";
import { createAIActionProposal } from "./SecurityProposal.ts";
import { securityBoundary } from "./SecurityBoundary.ts";
import { securityBoundaryValidator } from "./SecurityBoundaryValidator.ts";
import { securityExecutionAdapter } from "./SecurityExecutionAdapter.ts";
import { securityAuthority } from "./SecurityAuthority.ts";

export class SecuritySeparationCoordinator {
  private _proposals = new Map<string, AIActionProposal>();
  private _auditTrail: SeparationAuditRecord[] = [];
  private _totalProposals = 0;
  private _totalDecisions = 0;
  private _totalExecutions = 0;
  private _totalViolations = 0;

  resetForTesting(): void {
    this._proposals.clear();
    this._auditTrail = [];
    this._totalProposals = 0;
    this._totalDecisions = 0;
    this._totalExecutions = 0;
    this._totalViolations = 0;
    securityAuthority.resetForTesting();
    securityPolicyEngine.resetForTesting();
  }

  /**
   * Ingests and sanitizes an untrusted AI action proposal.
   */
  proposeAction(options: ProposeActionOptions): AIActionProposal {
    const proposal = createAIActionProposal(options);
    this._proposals.set(proposal.proposalId, proposal);
    this._totalProposals++;
    return proposal;
  }

  /**
   * Submits a proposal across the trust boundary for authoritative security evaluation.
   */
  async evaluateProposal(
    proposal: AIActionProposal,
    context: SecurityContext,
    confirmationToken?: string,
  ): Promise<SecurityDecision> {
    const decision = await securityBoundary.submitProposal(proposal, context, confirmationToken);
    this._totalDecisions++;

    let violation: BoundaryViolation | undefined;
    if (decision.decision === "BLOCK") {
      this._totalViolations++;
      violation = {
        type: "UNAUTHORIZED_EXECUTION",
        message: decision.reasons.join("; "),
        proposalId: proposal.proposalId,
        decisionId: decision.decisionId,
        toolName: proposal.toolName,
        timestamp: Date.now(),
      };
    }

    const auditRecord: SeparationAuditRecord = {
      auditId: crypto.randomUUID(),
      timestamp: Date.now(),
      proposal,
      decision,
      violation,
      context,
    };
    this._auditTrail.push(auditRecord);

    return decision;
  }

  /**
   * Helper combining proposal creation and authoritative evaluation.
   */
  async proposeAndEvaluate(
    options: ProposeActionOptions,
    context: SecurityContext,
    confirmationToken?: string,
  ): Promise<{ proposal: AIActionProposal; decision: SecurityDecision }> {
    const proposal = this.proposeAction(options);
    const decision = await this.evaluateProposal(proposal, context, confirmationToken);
    return { proposal, decision };
  }

  /**
   * Pre-execution verification of a SecurityDecision.
   */
  validateForExecution(params: {
    decision: SecurityDecision;
    actualToolName: string;
    actualArgs: Record<string, unknown>;
    proposal?: AIActionProposal;
  }): DecisionValidationResult {
    const result = securityBoundaryValidator.validateDecision(params);
    if (!result.valid && result.violation) {
      this._totalViolations++;
    }
    return result;
  }

  /**
   * Executes an action guarded by a cryptographically verified SecurityDecision.
   */
  async executeApprovedAction(params: {
    decision: SecurityDecision;
    actualToolName: string;
    actualArgs: Record<string, unknown>;
    context: SecurityContext;
    executor: () => Promise<unknown>;
    proposal?: AIActionProposal;
  }): Promise<SeparationExecutionResult> {
    const execResult = await securityExecutionAdapter.executeAction(params);
    this._totalExecutions++;

    if (execResult.violation) {
      this._totalViolations++;
    }

    // Update corresponding audit record if present
    const record = this._auditTrail.find((r) => r.decision.decisionId === params.decision.decisionId);
    if (record) {
      (record as any).executionResult = execResult;
      if (execResult.violation) {
        (record as any).violation = execResult.violation;
      }
    }

    return execResult;
  }

  /**
   * Returns current status of the Security Separation subsystem.
   */
  getStatus(): SecuritySeparationStatus {
    const decStats = securityAuthority.getDecisionsCount();
    return {
      initialized: true,
      activeMode: securityPolicyEngine.getMode(),
      emergencyStopActive: emergencyStopCoordinator.isActive(),
      totalProposalsProcessed: this._totalProposals,
      totalDecisionsIssued: this._totalDecisions,
      totalExecutionsCompleted: this._totalExecutions,
      totalViolationsDetected: this._totalViolations,
      activeDecisionsCount: decStats.active,
      consumedDecisionsCount: decStats.consumed,
    };
  }

  /**
   * Returns full or limited audit trail.
   */
  getAuditTrail(limit = 100): SeparationAuditRecord[] {
    return this._auditTrail.slice(-limit);
  }

  getProposal(proposalId: string): AIActionProposal | undefined {
    return this._proposals.get(proposalId);
  }

  getDecision(decisionId: string): SecurityDecision | undefined {
    return securityAuthority.getDecision(decisionId);
  }
}

export const securitySeparationCoordinator = new SecuritySeparationCoordinator();
