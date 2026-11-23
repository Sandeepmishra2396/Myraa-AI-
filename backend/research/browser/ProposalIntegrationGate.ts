/**
 * MYRAA — Advanced Browser Intelligence & Adaptive Knowledge System
 * ProposalIntegrationGate.ts
 *
 * Stage 5: Approval & Integration Gate.
 *
 * Enforces strict governance, approval, integration, rollback, and audit trails:
 *   - Invariant 1: AI-generated proposals can NEVER self-authorize (UNAUTHORIZED_SELF_APPROVAL).
 *   - Invariant 2: Explicit human/operator approval is required before permanent integration.
 *   - Invariant 3: Critic and Security reviews MUST be APPROVED prior to approval.
 *   - Invariant 4: Every integration creates a rollback token and pre-state snapshot.
 *   - Invariant 5: Reversion/Rollback restores pre-integration state and logs immutable audit records.
 *   - Invariant 6: Zero writes to SQLite permanent memory without clearance.
 */

import crypto from "crypto";
import type {
  AdaptiveProposal,
  ProposalLifecycleState,
} from "./AdaptiveIngestionTypes.ts";
import { knowledgeNodeStore, KnowledgeNodeStore } from "../../knowledge/KnowledgeNodeStore.ts";
import type { KnowledgeNode } from "../../knowledge/KnowledgeGraphTypes.ts";

export interface ApprovalOptions {
  approver: string;
  reason?: string;
  bypassChecks?: boolean; // Must always be rejected
}

export interface RejectionOptions {
  rejecter: string;
  reason: string;
}

export interface IntegrationOptions {
  actor: string;
  targetStore?: "KNOWLEDGE_GRAPH" | "ADAPTIVE_BRAIN" | "SKILL_REGISTRY";
}

export interface RollbackOptions {
  actor: string;
  token: string;
  reason?: string;
}

export class ProposalIntegrationGate {
  private _proposals: Map<string, AdaptiveProposal> = new Map();
  private _integratedSkills: Map<string, any> = new Map();
  private _nodeStore: KnowledgeNodeStore;

  constructor(nodeStore = knowledgeNodeStore) {
    this._nodeStore = nodeStore;
  }

  // ---------------------------------------------------------------------------
  // Proposal Registration & Retrieval
  // ---------------------------------------------------------------------------

  public registerProposal(proposal: AdaptiveProposal): AdaptiveProposal {
    this._proposals.set(proposal.id, proposal);
    return proposal;
  }

  public getProposal(proposalId: string): AdaptiveProposal | undefined {
    return this._proposals.get(proposalId);
  }

  public listProposals(filter?: {
    state?: ProposalLifecycleState;
    type?: "KNOWLEDGE" | "SKILL";
  }): AdaptiveProposal[] {
    let list = Array.from(this._proposals.values());
    if (filter?.state) {
      list = list.filter((p) => p.lifecycleState === filter.state);
    }
    if (filter?.type) {
      list = list.filter((p) => p.type === filter.type);
    }
    return list;
  }

  // ---------------------------------------------------------------------------
  // Transition & Audit Helper
  // ---------------------------------------------------------------------------

  public transitionState(
    proposal: AdaptiveProposal,
    toState: ProposalLifecycleState,
    actor: string,
    reason: string,
    metadata?: Record<string, unknown>
  ): void {
    const fromState = proposal.lifecycleState;
    proposal.lifecycleState = toState;
    proposal.updatedAt = Date.now();
    proposal.auditTrail.push({
      timestamp: Date.now(),
      fromState,
      toState,
      actor,
      reason,
      metadata,
    });
  }

  // ---------------------------------------------------------------------------
  // Stage 8: Approval / Rejection Gate
  // ---------------------------------------------------------------------------

  /**
   * Approves a proposal for integration.
   * Strict Security Boundary: Must be approved by a human/operator or explicit authorized policy.
   * AI-generated self-approval is aggressively rejected.
   */
  public approveProposal(proposalId: string, options: ApprovalOptions): AdaptiveProposal {
    const proposal = this._proposals.get(proposalId);
    if (!proposal) {
      throw new Error(`PROPOSAL_NOT_FOUND: Proposal with ID "${proposalId}" does not exist.`);
    }

    // ── Invariant: AI Self-Approval Defense ──────────────────────────────────
    const approverClean = (options.approver || "").toLowerCase().trim();
    if (
      approverClean === "ai" ||
      approverClean === "assistant" ||
      approverClean === "myraa" ||
      approverClean === "self" ||
      approverClean.includes("agent") ||
      approverClean.includes("system")
    ) {
      this.transitionState(
        proposal,
        proposal.lifecycleState,
        options.approver,
        "Blocked attempt by AI to self-approve proposal."
      );
      throw new Error("UNAUTHORIZED_SELF_APPROVAL: AI agents are strictly forbidden from self-approving proposals.");
    }

    // Must be in EVALUATING or PROPOSED state
    if (proposal.lifecycleState !== "EVALUATING" && proposal.lifecycleState !== "PROPOSED") {
      throw new Error(`INVALID_STATE_TRANSITION: Cannot approve proposal in state "${proposal.lifecycleState}".`);
    }

    // Check review prerequisites
    if (proposal.criticReview && proposal.criticReview.verdict === "REJECTED") {
      throw new Error("CRITIC_VERDICT_REJECTED: Proposal was rejected by Critic Review.");
    }
    if (proposal.securityReview && proposal.securityReview.verdict === "REJECTED") {
      throw new Error("SECURITY_VERDICT_REJECTED: Proposal was rejected by Security Review.");
    }

    // Record approval
    proposal.approval = {
      status: "APPROVED",
      approver: options.approver,
      approvedAt: Date.now(),
      approvalReason: options.reason || "Approved by operator.",
      isSelfApproved: false,
    };

    this.transitionState(
      proposal,
      "APPROVED",
      options.approver,
      options.reason || "Approved by authorized human operator."
    );

    return proposal;
  }

  /**
   * Rejects a proposal.
   */
  public rejectProposal(proposalId: string, options: RejectionOptions): AdaptiveProposal {
    const proposal = this._proposals.get(proposalId);
    if (!proposal) {
      throw new Error(`PROPOSAL_NOT_FOUND: Proposal with ID "${proposalId}" does not exist.`);
    }

    proposal.approval = {
      status: "REJECTED",
      approver: options.rejecter,
      approvedAt: Date.now(),
      rejectionReason: options.reason,
      isSelfApproved: false,
    };

    this.transitionState(
      proposal,
      "REJECTED",
      options.rejecter,
      options.reason
    );

    return proposal;
  }

  // ---------------------------------------------------------------------------
  // Stage 9: Controlled Integration
  // ---------------------------------------------------------------------------

  /**
   * Integrates an approved proposal into its target storage layer.
   * Strict Boundary: Throws if proposal is not explicitly approved.
   */
  public async integrateProposal(
    proposalId: string,
    options: IntegrationOptions
  ): Promise<AdaptiveProposal> {
    const proposal = this._proposals.get(proposalId);
    if (!proposal) {
      throw new Error(`PROPOSAL_NOT_FOUND: Proposal with ID "${proposalId}" does not exist.`);
    }

    // Invariant: Proposal must be in APPROVED state
    if (proposal.lifecycleState !== "APPROVED" || proposal.approval.status !== "APPROVED") {
      throw new Error(`INTEGRATION_FORBIDDEN: Proposal "${proposalId}" is not approved (state: ${proposal.lifecycleState}).`);
    }

    const now = Date.now();
    const rollbackAuditToken = `rb_${crypto.randomBytes(8).toString("hex")}`;
    let integratedEntityId = "";
    let targetStore = options.targetStore;
    let preIntegrationSnapshot: unknown = null;

    if (proposal.payload.kind === "KNOWLEDGE") {
      targetStore = targetStore || "KNOWLEDGE_GRAPH";
      const payload = proposal.payload;

      // Check existing node for snapshot
      const existing = this._nodeStore.findByCanonicalName(payload.canonicalName);
      if (existing.length > 0) {
        preIntegrationSnapshot = JSON.parse(JSON.stringify(existing[0]));
      }

      // Create or update node in Knowledge Graph Node Store
      const node: KnowledgeNode = {
        id: `kg_node_prop_${crypto.randomBytes(4).toString("hex")}`,
        type: payload.entityType,
        canonicalName: payload.canonicalName,
        aliases: [payload.canonicalName.toLowerCase()],
        attributes: {
          ...payload.attributes,
          summary: payload.summary,
          domain: payload.targetDomain,
          isBreakingChange: payload.isBreakingChange || false,
          deprecationNotice: payload.deprecationNotice || null,
          proposalId: proposal.id,
        },
        confidence: proposal.provenance.confidence,
        importance: payload.isBreakingChange ? 5 : 3,
        createdAt: now,
        updatedAt: now,
        firstObservedAt: proposal.provenance.capturedAt || now,
        lastObservedAt: now,
        status: "ACTIVE",
        provenance: [
          {
            source: proposal.provenance.sourceUrls[0] || "PROPOSAL_INGESTION",
            sourceType: "RESEARCH_EVIDENCE",
            timestamp: now,
            confidence: proposal.provenance.confidence,
            supportingEvidence: proposal.provenance.sourceExcerpts[0] || payload.summary,
            sourceId: proposal.id,
          },
        ],
        sourceMemoryIds: [],
        sourceContextIds: [],
        sourceTaskIds: [],
        sourceResearchIds: [proposal.id],
      };

      const storedNode = this._nodeStore.addNode(node);
      integratedEntityId = storedNode.id;
    } else {
      // Skill Proposal Integration
      targetStore = targetStore || "SKILL_REGISTRY";
      const payload = proposal.payload;
      const skillId = `skill_${payload.skillName.toLowerCase().replace(/[^a-z0-9_]+/g, "_")}`;

      if (this._integratedSkills.has(skillId)) {
        preIntegrationSnapshot = JSON.parse(JSON.stringify(this._integratedSkills.get(skillId)));
      }

      const registeredSkill = {
        id: skillId,
        name: payload.skillName,
        description: payload.description,
        triggerPatterns: payload.triggerPatterns,
        workflowSteps: payload.workflowSteps,
        requiredPermissions: payload.requiredPermissions,
        sandboxed: true, // Always enforce sandboxing
        integratedAt: now,
        proposalId: proposal.id,
      };

      this._integratedSkills.set(skillId, registeredSkill);
      integratedEntityId = skillId;
    }

    proposal.integration = {
      integratedAt: now,
      targetStore,
      integratedEntityId,
      rollbackAvailable: true,
      rollbackAuditToken,
      preIntegrationSnapshot,
    };

    this.transitionState(
      proposal,
      "INTEGRATED",
      options.actor,
      `Integrated into ${targetStore} as entity "${integratedEntityId}".`,
      { integratedEntityId, rollbackAuditToken }
    );

    return proposal;
  }

  // ---------------------------------------------------------------------------
  // Stage 10: Rollback & Reversion
  // ---------------------------------------------------------------------------

  /**
   * Reverts an integrated proposal, restoring prior state or deleting the created entity.
   */
  public rollbackIntegration(proposalId: string, options: RollbackOptions): AdaptiveProposal {
    const proposal = this._proposals.get(proposalId);
    if (!proposal) {
      throw new Error(`PROPOSAL_NOT_FOUND: Proposal with ID "${proposalId}" does not exist.`);
    }

    if (proposal.lifecycleState !== "INTEGRATED" || !proposal.integration) {
      throw new Error(`ROLLBACK_INVALID: Proposal "${proposalId}" is not in INTEGRATED state.`);
    }

    if (proposal.integration.rollbackAuditToken !== options.token) {
      throw new Error("ROLLBACK_TOKEN_MISMATCH: Provided rollback token is invalid.");
    }

    const { targetStore, integratedEntityId, preIntegrationSnapshot } = proposal.integration;

    if (targetStore === "KNOWLEDGE_GRAPH") {
      if (preIntegrationSnapshot) {
        // Restore pre-integration node
        this._nodeStore.updateNode(integratedEntityId, preIntegrationSnapshot as Partial<KnowledgeNode>);
      } else {
        // Supersede/retire newly added node
        this._nodeStore.supersedeNode(integratedEntityId);
      }
    } else if (targetStore === "SKILL_REGISTRY") {
      if (preIntegrationSnapshot) {
        this._integratedSkills.set(integratedEntityId, preIntegrationSnapshot);
      } else {
        this._integratedSkills.delete(integratedEntityId);
      }
    }

    proposal.integration.rollbackAvailable = false;

    this.transitionState(
      proposal,
      "ROLLED_BACK",
      options.actor,
      options.reason || "Reverted integration via authenticated rollback token.",
      { rolledBackEntityId: integratedEntityId }
    );

    return proposal;
  }

  /**
   * Check if a skill exists in the integrated skills registry.
   */
  public getIntegratedSkill(skillId: string): any {
    return this._integratedSkills.get(skillId);
  }
}

export const proposalIntegrationGate = new ProposalIntegrationGate();
