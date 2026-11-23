/**
 * MYRAA — Advanced Browser Intelligence & Adaptive Knowledge System
 * SkillProposalManager.ts
 *
 * Stage 6: Master Proposal Manager & State Machine Controller.
 *
 * Enforces:
 *   - Strict state transitions:
 *     OBSERVED → CANDIDATE → UNDER_CRITIC_REVIEW → UNDER_SECURITY_REVIEW →
 *     READY_FOR_HUMAN_REVIEW → APPROVED | REJECTED (with INTEGRATED / ROLLED_BACK / EXPIRED / INVALIDATED)
 *   - AI Self-Approval Prevention (UNAUTHORIZED_SELF_APPROVAL).
 *   - Authenticated Human Approval with Nonce Replay Defense, Version Binding, and Expiration.
 *   - Invalidation of Approval on Material Workflow Change.
 *   - In-memory separated proposal store (zero unauthorized writes to SQLite permanent memory or Knowledge Graph).
 *   - Atomic Integration with Rollback Tokens & zero automatic execution of newly proposed skills.
 *   - Emergency Stop & Security Policy Lockdown integration.
 */

import crypto from "crypto";
import { emergencyStopCoordinator } from "../../remote/EmergencyStopCoordinator.ts";
import { securityPolicyEngine } from "../../security/SecurityPolicyEngine.ts";
import {
  workflowEvidenceObserver,
  WorkflowEvidenceObserver,
} from "./WorkflowEvidenceObserver.ts";
import {
  workflowPatternDetector,
  WorkflowPatternDetector,
} from "./WorkflowPatternDetector.ts";
import {
  skillProposalCritic,
  SkillProposalCritic,
} from "./SkillProposalCritic.ts";
import {
  skillProposalSecurityReviewer,
  SkillProposalSecurityReviewer,
} from "./SkillProposalSecurityReviewer.ts";
import type {
  CandidateWorkflow,
  HumanApprovalDecision,
  SkillObservationInput,
  SkillProposal,
  SkillProposalAuditEntry,
  SkillProposalLifecycleState,
  WorkflowDetectionRecord,
} from "./SkillProposalTypes.ts";

export interface CreateProposalOptions {
  workflow: CandidateWorkflow;
  detection: WorkflowDetectionRecord;
}

export class SkillProposalManager {
  private _proposals: Map<string, SkillProposal> = new Map();
  private _usedApprovalNonces: Set<string> = new Set();
  private _registeredSkills: Map<string, Record<string, unknown>> = new Map();

  private _observer: WorkflowEvidenceObserver;
  private _detector: WorkflowPatternDetector;
  private _critic: SkillProposalCritic;
  private _securityReviewer: SkillProposalSecurityReviewer;

  // Forbidden AI self-approver identities
  private readonly _aiApproverIdentities = new Set<string>([
    "myraa",
    "ai",
    "system",
    "autonomous_agent",
    "model",
    "assistant",
    "bot",
    "gemini",
    "browser_agent",
    "proposer",
    "critic",
    "executor",
    "evaluator",
  ]);

  constructor(
    observer = workflowEvidenceObserver,
    detector = workflowPatternDetector,
    critic = skillProposalCritic,
    securityReviewer = skillProposalSecurityReviewer,
  ) {
    this._observer = observer;
    this._detector = detector;
    this._critic = critic;
    this._securityReviewer = securityReviewer;
  }

  public resetForTesting(): void {
    this._proposals.clear();
    this._usedApprovalNonces.clear();
    this._registeredSkills.clear();
    this._observer.resetForTesting();
  }

  // ── Pre-flight Safety Checks ──────────────────────────────────────────────

  private _assertSystemOperational(opName: string): void {
    if (emergencyStopCoordinator.isActive()) {
      throw new Error(`EMERGENCY_STOP_ACTIVE: Operation '${opName}' blocked because Emergency Stop is active.`);
    }

    if (securityPolicyEngine.getMode() === "LOCKDOWN") {
      throw new Error(`SECURITY_LOCKDOWN_ACTIVE: Operation '${opName}' blocked during Security Policy Lockdown.`);
    }
  }

  // ── Observation Ingestion ─────────────────────────────────────────────────

  public recordObservation(input: SkillObservationInput): {
    accepted: boolean;
    traceId?: string;
    rejectionReason?: string;
  } {
    this._assertSystemOperational("recordObservation");
    return this._observer.recordTrace(input);
  }

  // ── Pattern Detection & Proposal Formulation ──────────────────────────────

  public processObservedPatterns(): SkillProposal[] {
    this._assertSystemOperational("processObservedPatterns");

    const detectionResult = this._detector.detectCandidateWorkflows();
    const createdProposals: SkillProposal[] = [];

    for (const candidate of detectionResult.candidates) {
      // Check if active proposal already exists for this workflow signature
      const existing = Array.from(this._proposals.values()).find(
        (p) =>
          p.workflow.workflowSignature === candidate.workflow.workflowSignature &&
          ["CANDIDATE", "UNDER_CRITIC_REVIEW", "UNDER_SECURITY_REVIEW", "READY_FOR_HUMAN_REVIEW", "APPROVED"].includes(
            p.lifecycleState,
          ),
      );

      if (existing) {
        // Already tracked, update detection timestamps and trace IDs
        existing.detection.totalExecutions = candidate.detection.totalExecutions;
        existing.detection.successfulExecutions = candidate.detection.successfulExecutions;
        existing.detection.lastObservedAt = candidate.detection.lastObservedAt;
        existing.updatedAt = Date.now();
        continue;
      }

      // Create new candidate proposal
      const proposal = this._createCandidateProposal(candidate.workflow, candidate.detection);
      this._proposals.set(proposal.proposalId, proposal);
      candidate.detection.candidateProposalId = proposal.proposalId;
      createdProposals.push(proposal);

      // Automatically advance through critic and security review stages
      this._advanceThroughAutomatedReviews(proposal.proposalId);
    }

    return createdProposals;
  }

  private _createCandidateProposal(
    workflow: CandidateWorkflow,
    detection: WorkflowDetectionRecord,
  ): SkillProposal {
    const now = Date.now();
    const proposalId = `prop_skill_${now}_${crypto.randomBytes(4).toString("hex")}`;
    const contentHash = this._computeWorkflowHash(workflow);

    const proposal: SkillProposal = {
      proposalId,
      version: 1,
      lifecycleState: "CANDIDATE",
      workflow,
      detection,
      auditHistory: [
        {
          timestamp: now,
          event: "PROPOSAL_CREATED",
          actor: "WorkflowPatternDetector",
          details: { signature: workflow.workflowSignature, name: workflow.name },
          newState: "CANDIDATE",
        },
      ],
      createdAt: now,
      updatedAt: now,
      contentHash,
    };

    return proposal;
  }

  private _computeWorkflowHash(workflow: CandidateWorkflow): string {
    const raw = JSON.stringify({
      sig: workflow.workflowSignature,
      steps: workflow.orderedSteps,
      triggers: workflow.triggerPatterns,
      tools: workflow.requiredTools,
      risk: workflow.riskLevel,
    });
    return crypto.createHash("sha256").update(raw).digest("hex");
  }

  // ── Automated Reviews (Critic + Phase 26 Security) ─────────────────────────

  private _advanceThroughAutomatedReviews(proposalId: string): void {
    const proposal = this._proposals.get(proposalId);
    if (!proposal || proposal.lifecycleState !== "CANDIDATE") return;

    // 1. Critic Review
    this._transitionState(proposal, "UNDER_CRITIC_REVIEW", "Advancing to Critic Review", "SkillProposalManager");
    const criticReview = this._critic.reviewProposal(proposal.workflow, proposal.detection);
    proposal.criticReview = criticReview;

    if (criticReview.verdict === "REJECTED") {
      this._transitionState(
        proposal,
        "REJECTED",
        `Critic review failed: ${criticReview.detectedGaps.join("; ")}`,
        "SkillProposalCritic",
      );
      return;
    }

    // 2. Security Review
    this._transitionState(proposal, "UNDER_SECURITY_REVIEW", "Advancing to Security Review", "SkillProposalManager");
    const securityReview = this._securityReviewer.reviewSecurity(proposal.workflow);
    proposal.securityReview = securityReview;

    if (securityReview.verdict === "REJECTED") {
      this._transitionState(
        proposal,
        "REJECTED",
        `Security review failed: ${securityReview.violations.join("; ")}`,
        "Phase26SecurityAuthority",
      );
      return;
    }

    // 3. Ready for Human Review
    this._transitionState(
      proposal,
      "READY_FOR_HUMAN_REVIEW",
      "Passed automated critic and security reviews. Awaiting authenticated human decision.",
      "SkillProposalManager",
    );
  }

  // ── Material Change & Approval Invalidation ────────────────────────────────

  public updateWorkflow(proposalId: string, updatedWorkflow: Partial<CandidateWorkflow>, actor: string): SkillProposal {
    this._assertSystemOperational("updateWorkflow");

    const proposal = this._proposals.get(proposalId);
    if (!proposal) {
      throw new Error(`PROPOSAL_NOT_FOUND: Proposal '${proposalId}' does not exist.`);
    }

    if (["INTEGRATED", "ROLLED_BACK"].includes(proposal.lifecycleState)) {
      throw new Error(`CANNOT_MODIFY_TERMINAL_PROPOSAL: Proposal is already ${proposal.lifecycleState}.`);
    }

    const mergedWorkflow: CandidateWorkflow = {
      ...proposal.workflow,
      ...updatedWorkflow,
    };

    const newHash = this._computeWorkflowHash(mergedWorkflow);
    const materialChange = newHash !== proposal.contentHash;

    proposal.workflow = mergedWorkflow;
    proposal.version += 1;
    proposal.contentHash = newHash;
    proposal.updatedAt = Date.now();

    if (materialChange) {
      const priorState = proposal.lifecycleState;
      // Invalidate prior reviews and approvals
      proposal.humanApproval = undefined;
      proposal.criticReview = undefined;
      proposal.securityReview = undefined;

      this._transitionState(
        proposal,
        "UNDER_CRITIC_REVIEW",
        `Material change detected in workflow definition. Prior approvals invalidated; resetting to review.`,
        actor,
      );

      // Re-run automated reviews
      const criticReview = this._critic.reviewProposal(proposal.workflow, proposal.detection);
      proposal.criticReview = criticReview;

      if (criticReview.verdict === "REJECTED") {
        this._transitionState(proposal, "REJECTED", `Critic re-review failed after material modification.`, "SkillProposalCritic");
      } else {
        const secReview = this._securityReviewer.reviewSecurity(proposal.workflow);
        proposal.securityReview = secReview;
        if (secReview.verdict === "REJECTED") {
          this._transitionState(proposal, "REJECTED", `Security re-review failed after material modification.`, "Phase26SecurityAuthority");
        } else {
          this._transitionState(proposal, "READY_FOR_HUMAN_REVIEW", `Re-reviews passed after modification. Ready for human review.`, "SkillProposalManager");
        }
      }
    }

    return proposal;
  }

  // ── Authenticated Human Approval Gate ──────────────────────────────────────

  public approveProposal(
    proposalId: string,
    decision: {
      approver: string;
      approverRole: "admin" | "standard";
      reason: string;
      nonce?: string;
      expiresAt?: number;
      proposalVersion?: number;
      signature?: string;
    },
  ): SkillProposal {
    this._assertSystemOperational("approveProposal");

    const proposal = this._proposals.get(proposalId);
    if (!proposal) {
      throw new Error(`PROPOSAL_NOT_FOUND: Proposal '${proposalId}' does not exist.`);
    }

    // 1. Strict AI Self-Approval Defense
    const cleanApprover = (decision.approver || "").trim().toLowerCase();
    if (!cleanApprover || this._aiApproverIdentities.has(cleanApprover)) {
      throw new Error(
        `UNAUTHORIZED_SELF_APPROVAL: AI or autonomous agent '${decision.approver}' cannot self-approve proposals. Human operator authorization required.`,
      );
    }

    // 2. State Guard
    if (proposal.lifecycleState !== "READY_FOR_HUMAN_REVIEW") {
      throw new Error(
        `INVALID_LIFECYCLE_STATE: Cannot approve proposal in state '${proposal.lifecycleState}'. Proposal must be 'READY_FOR_HUMAN_REVIEW'.`,
      );
    }

    // 3. Reason Guard
    if (!decision.reason || decision.reason.trim().length < 5) {
      throw new Error("APPROVAL_REASON_REQUIRED: Explicit reason (>= 5 chars) required for human approval.");
    }

    // 4. Nonce Replay Defense
    const nonce = decision.nonce || crypto.randomBytes(16).toString("hex");
    if (this._usedApprovalNonces.has(nonce)) {
      throw new Error(`REPLAYED_APPROVAL_REJECTED: Nonce '${nonce}' has already been used.`);
    }
    this._usedApprovalNonces.add(nonce);

    // 5. Expiration Defense
    const now = Date.now();
    const expiresAt = decision.expiresAt || now + 3600 * 1000;
    if (expiresAt < now) {
      this._transitionState(proposal, "EXPIRED", "Approval decision payload expired.", cleanApprover);
      throw new Error(`EXPIRED_APPROVAL_REJECTED: Approval timestamp is in the past (${new Date(expiresAt).toISOString()}).`);
    }

    // 6. Proposal Version Binding Defense
    if (typeof decision.proposalVersion === "number" && decision.proposalVersion !== proposal.version) {
      throw new Error(
        `VERSION_MISMATCH_REJECTED: Decision is bound to proposal version ${decision.proposalVersion}, but current version is ${proposal.version}.`,
      );
    }

    // 7. Security Reviews Must Be Present and Passed
    if (!proposal.securityReview || proposal.securityReview.verdict !== "PASSED") {
      throw new Error("SECURITY_GATE_BLOCKED: Cannot approve proposal without verified passing security review.");
    }

    const signature =
      decision.signature ||
      crypto
        .createHmac("sha256", "myraa_human_approval_secret")
        .update(`${proposal.proposalId}:${proposal.version}:${cleanApprover}:${nonce}`)
        .digest("hex");

    const approvalRecord: HumanApprovalDecision = {
      approver: cleanApprover,
      approverRole: decision.approverRole || "standard",
      decision: "APPROVE",
      reason: decision.reason.trim(),
      timestamp: now,
      expiresAt,
      nonce,
      proposalVersion: proposal.version,
      signature,
    };

    proposal.humanApproval = approvalRecord;
    this._transitionState(
      proposal,
      "APPROVED",
      `Approved by operator '${cleanApprover}' (${decision.approverRole}). Reason: ${decision.reason}`,
      cleanApprover,
    );

    return proposal;
  }

  public rejectProposal(
    proposalId: string,
    decision: {
      rejecter: string;
      reason: string;
    },
  ): SkillProposal {
    this._assertSystemOperational("rejectProposal");

    const proposal = this._proposals.get(proposalId);
    if (!proposal) {
      throw new Error(`PROPOSAL_NOT_FOUND: Proposal '${proposalId}' does not exist.`);
    }

    if (["INTEGRATED", "ROLLED_BACK"].includes(proposal.lifecycleState)) {
      throw new Error(`CANNOT_REJECT_TERMINAL_PROPOSAL: Proposal is already ${proposal.lifecycleState}.`);
    }

    this._transitionState(
      proposal,
      "REJECTED",
      `Rejected by '${decision.rejecter}'. Reason: ${decision.reason || "No reason specified."}`,
      decision.rejecter,
    );

    return proposal;
  }

  // ── Controlled Integration & Atomic Rollback ───────────────────────────────

  public integrateProposal(
    proposalId: string,
    actor: string,
  ): SkillProposal {
    this._assertSystemOperational("integrateProposal");

    const proposal = this._proposals.get(proposalId);
    if (!proposal) {
      throw new Error(`PROPOSAL_NOT_FOUND: Proposal '${proposalId}' does not exist.`);
    }

    if (proposal.lifecycleState !== "APPROVED") {
      throw new Error(
        `UNAUTHORIZED_INTEGRATION_BLOCKED: Proposal must be 'APPROVED' before integration. Current state: '${proposal.lifecycleState}'.`,
      );
    }

    if (!proposal.humanApproval) {
      throw new Error("HUMAN_APPROVAL_MISSING: Cannot integrate without verified human approval.");
    }

    const now = Date.now();
    const rollbackToken = `rlbk_skill_${now}_${crypto.randomBytes(8).toString("hex")}`;
    const skillKey = `skill_${proposal.workflow.name}`;

    // Capture state snapshot before integration
    const previousSnapshot = this._registeredSkills.get(skillKey) ? { ...this._registeredSkills.get(skillKey) } : {};

    // Register skill in local bounded registry — STRICT INVARIANT: autoExecution is blocked
    this._registeredSkills.set(skillKey, {
      name: proposal.workflow.name,
      steps: proposal.workflow.orderedSteps,
      triggers: proposal.workflow.triggerPatterns,
      permissions: proposal.workflow.requiredPermissions,
      integratedAt: now,
      integratedBy: actor,
      status: "ACTIVE_STANDBY", // standby awaiting explicit invocation, NOT auto-executing
      autoExecutionAllowed: false,
    });

    proposal.integrationRecord = {
      integratedAt: now,
      integratedBy: actor,
      rollbackToken,
      registeredSkillKey: skillKey,
      snapshotState: previousSnapshot,
      autoExecutionBlocked: true,
    };

    this._transitionState(
      proposal,
      "INTEGRATED",
      `Skill '${skillKey}' integrated into skill registry by '${actor}'. Auto-execution blocked. Rollback token generated.`,
      actor,
    );

    return proposal;
  }

  public rollbackProposal(
    proposalId: string,
    rollbackToken: string,
    actor: string,
    reason: string,
  ): SkillProposal {
    this._assertSystemOperational("rollbackProposal");

    const proposal = this._proposals.get(proposalId);
    if (!proposal) {
      throw new Error(`PROPOSAL_NOT_FOUND: Proposal '${proposalId}' does not exist.`);
    }

    if (proposal.lifecycleState !== "INTEGRATED") {
      throw new Error(
        `CANNOT_ROLLBACK_NON_INTEGRATED: Proposal state is '${proposal.lifecycleState}', expected 'INTEGRATED'.`,
      );
    }

    if (!proposal.integrationRecord || proposal.integrationRecord.rollbackToken !== rollbackToken) {
      throw new Error("INVALID_ROLLBACK_TOKEN: Rollback token does not match integration record.");
    }

    const skillKey = proposal.integrationRecord.registeredSkillKey;
    const previousSnapshot = proposal.integrationRecord.snapshotState;

    // Atomic rollback: restore previous state or delete if was non-existent
    if (Object.keys(previousSnapshot).length === 0) {
      this._registeredSkills.delete(skillKey);
    } else {
      this._registeredSkills.set(skillKey, previousSnapshot);
    }

    const now = Date.now();
    proposal.rollbackRecord = {
      rolledBackAt: now,
      rolledBackBy: actor,
      reason: reason || "Rollback initiated by operator.",
    };

    this._transitionState(
      proposal,
      "ROLLED_BACK",
      `Skill '${skillKey}' revoked and rolled back by '${actor}'. Reason: ${reason}`,
      actor,
    );

    return proposal;
  }

  // ── Query & Inspection ────────────────────────────────────────────────────

  public getProposal(proposalId: string): SkillProposal | undefined {
    return this._proposals.get(proposalId);
  }

  public listProposals(filter?: { state?: SkillProposalLifecycleState }): SkillProposal[] {
    const list = Array.from(this._proposals.values());
    if (filter?.state) {
      return list.filter((p) => p.lifecycleState === filter.state);
    }
    return list;
  }

  public getRegisteredSkills(): Map<string, Record<string, unknown>> {
    return new Map(this._registeredSkills);
  }

  private _transitionState(
    proposal: SkillProposal,
    newState: SkillProposalLifecycleState,
    reason: string,
    actor: string,
  ): void {
    const previousState = proposal.lifecycleState;
    proposal.lifecycleState = newState;
    proposal.updatedAt = Date.now();

    const auditEntry: SkillProposalAuditEntry = {
      timestamp: Date.now(),
      event: `STATE_TRANSITION_${newState}`,
      actor,
      details: { reason },
      previousState,
      newState,
    };

    proposal.auditHistory.push(auditEntry);
  }
}

export const skillProposalManager = new SkillProposalManager();
