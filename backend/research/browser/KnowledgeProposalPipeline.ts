/**
 * MYRAA — Advanced Browser Intelligence & Adaptive Knowledge System
 * KnowledgeProposalPipeline.ts
 *
 * Stage 5: Master Orchestrator for the 10-Stage Adaptive Ingestion Pipeline.
 *
 * Lifecycle:
 *   1. DISCOVER
 *   2. EXTRACT
 *   3. VERIFY
 *   4. PROPOSE
 *   5. CRITIC REVIEW
 *   6. SECURITY REVIEW
 *   7. EVALUATE
 *   8. APPROVE
 *   9. INTEGRATE
 *  10. REGRESSION VERIFY
 *
 * Invariants Enforced:
 *   - Research never directly writes to permanent storage without passing the approval gate.
 *   - AI proposals can never self-authorize.
 *   - External content is strictly UNTRUSTED_EXTERNAL_CONTENT.
 *   - Emergency Stop halts pipeline immediately.
 *   - Security Policy Lockdown blocks proposal processing.
 */

import crypto from "crypto";
import type {
  AdaptiveProposal,
  IngestionOpportunity,
  KnowledgeProposalPayload,
  SkillProposalPayload,
  ProposalFilterOptions,
} from "./AdaptiveIngestionTypes.ts";
import { documentExtractor } from "./DocumentExtractor.ts";
import { proposalCriticReviewer } from "./ProposalCriticReviewer.ts";
import { proposalSecurityReviewer } from "./ProposalSecurityReviewer.ts";
import { proposalEvaluator } from "./ProposalEvaluator.ts";
import { proposalIntegrationGate, ProposalIntegrationGate } from "./ProposalIntegrationGate.ts";
import { researchSecurityGate } from "../ResearchSecurityGate.ts";
import { emergencyStopCoordinator } from "../../remote/EmergencyStopCoordinator.ts";
import { securityPolicyEngine } from "../../security/SecurityPolicyEngine.ts";
import { epistemicVerifier } from "../EpistemicVerifier.ts";
import { duplicateSourceDetector } from "../DuplicateSourceDetector.ts";

export class KnowledgeProposalPipeline {
  private _gate: ProposalIntegrationGate;

  constructor(gate = proposalIntegrationGate) {
    this._gate = gate;
  }

  // ---------------------------------------------------------------------------
  // Security Pre-flight Gate
  // ---------------------------------------------------------------------------

  private _assertOperationalState(): void {
    if (emergencyStopCoordinator.isActive()) {
      throw new Error("EMERGENCY_STOP_ACTIVE: Knowledge ingestion pipeline halted by Emergency Stop.");
    }

    if (securityPolicyEngine.getMode() === "LOCKDOWN") {
      throw new Error("SECURITY_LOCKDOWN_ACTIVE: Knowledge ingestion pipeline suspended during Security Policy Lockdown.");
    }
  }

  // ---------------------------------------------------------------------------
  // Stage 1: DISCOVER
  // ---------------------------------------------------------------------------

  public async discover(opportunity: IngestionOpportunity): Promise<AdaptiveProposal> {
    this._assertOperationalState();

    // SSRF pre-flight validation on source URL if present
    if (opportunity.sourceUrl && opportunity.sourceUrl.startsWith("http")) {
      const ssrfCheck = await researchSecurityGate.validateUrl(opportunity.sourceUrl);
      if (!ssrfCheck.safe) {
        throw new Error(`SSRF_DESTINATION_BLOCKED: Source URL "${opportunity.sourceUrl}" rejected: ${ssrfCheck.reason}`);
      }
    }

    const id = opportunity.opportunityId || `prop_${crypto.randomBytes(6).toString("hex")}`;
    const now = Date.now();

    const emptyPayload: KnowledgeProposalPayload | SkillProposalPayload =
      opportunity.type === "KNOWLEDGE"
        ? {
            kind: "KNOWLEDGE",
            targetDomain: opportunity.domain || "general",
            canonicalName: opportunity.title,
            entityType: "KNOWLEDGE",
            attributes: {},
            summary: opportunity.description,
          }
        : {
            kind: "SKILL",
            skillName: opportunity.title,
            description: opportunity.description,
            triggerPatterns: [],
            workflowSteps: opportunity.suggestedSteps || [],
            requiredPermissions: [],
            sandboxed: true,
          };

    const proposal: AdaptiveProposal = {
      id,
      type: opportunity.type,
      title: opportunity.title,
      description: opportunity.description,
      lifecycleState: "DISCOVERED",
      provenance: {
        sourceUrls: opportunity.sourceUrl ? [opportunity.sourceUrl] : [],
        sourceExcerpts: [],
        capturedAt: now,
        epistemicClassification: "HYPOTHESIS",
        confidence: 0.50,
        proposalVersion: 1,
      },
      payload: emptyPayload,
      approval: {
        status: "PENDING",
        isSelfApproved: false,
      },
      auditTrail: [
        {
          timestamp: now,
          fromState: "DISCOVERED",
          toState: "DISCOVERED",
          actor: "pipeline_discover",
          reason: `Discovered opportunity "${opportunity.title}".`,
        },
      ],
      createdAt: now,
      updatedAt: now,
    };

    return this._gate.registerProposal(proposal);
  }

  // ---------------------------------------------------------------------------
  // Stage 2: EXTRACT
  // ---------------------------------------------------------------------------

  public extract(proposalId: string, rawContent: string): AdaptiveProposal {
    this._assertOperationalState();
    const proposal = this._gate.getProposal(proposalId);
    if (!proposal) throw new Error(`Proposal "${proposalId}" not found.`);

    const structured = documentExtractor.extract(
      rawContent,
      proposal.provenance.sourceUrls[0] || "https://local-source",
      proposal.title
    );

    // Populate excerpts from extracted sections
    const excerpts: string[] = [];
    for (const sec of structured.sections) {
      if (sec.content && sec.content.length > 20) {
        excerpts.push(sec.content.slice(0, 300));
        if (excerpts.length >= 5) break;
      }
    }

    proposal.provenance.sourceExcerpts = excerpts;
    if (structured.detectedVersion) {
      proposal.provenance.uncertaintyNotes = undefined;
    } else {
      proposal.provenance.uncertaintyNotes = "Version metadata could not be detected from document.";
    }

    this._gate.transitionState(
      proposal,
      "EXTRACTED",
      "pipeline_extract",
      `Extracted ${structured.sections.length} sections and ${structured.codeBlocks.length} code blocks.`
    );

    return proposal;
  }

  // ---------------------------------------------------------------------------
  // Stage 3: VERIFY
  // ---------------------------------------------------------------------------

  public verify(
    proposalId: string,
    options?: {
      corroboratingSources?: Array<{ url: string; content: string; title: string }>;
      contradictions?: string[];
      epistemicLabel?: "FACT" | "INFERENCE" | "HYPOTHESIS" | "VERIFIED_CONCLUSION";
    }
  ): AdaptiveProposal {
    this._assertOperationalState();
    const proposal = this._gate.getProposal(proposalId);
    if (!proposal) throw new Error(`Proposal "${proposalId}" not found.`);

    let epistemic = options?.epistemicLabel || "INFERENCE";
    let confidence = 0.75;

    // Check duplicate sources / syndication
    if (options?.corroboratingSources && options.corroboratingSources.length > 1) {
      const mockResearchSources = options.corroboratingSources.map((s, idx) => ({
        id: `src_${idx}`,
        url: s.url,
        title: s.title,
        sanitizedContent: s.content,
        reliability: {
          sourceAuthority: 0.8,
          authorityScore: 0.8,
          freshnessScore: 0.8,
          independenceScore: 0.8,
          compositeScore: 0.8,
          isSyndicated: false,
        },
        fetchedAt: Date.now(),
      }));

      const dupReport = duplicateSourceDetector.detectDuplicates(mockResearchSources as any);
      if (dupReport.duplicateSourceCount > 0) {
        proposal.provenance.syndicatedDuplicateCount = dupReport.duplicateSourceCount;
        confidence -= 0.15; // Downgrade confidence for syndicated duplication
      } else {
        epistemic = "VERIFIED_CONCLUSION";
        confidence = 0.90;
      }

      for (const s of options.corroboratingSources) {
        if (!proposal.provenance.sourceUrls.includes(s.url)) {
          proposal.provenance.sourceUrls.push(s.url);
        }
      }
    }

    if (options?.contradictions && options.contradictions.length > 0) {
      proposal.provenance.contradictions = options.contradictions;
      confidence -= 0.20;
    }

    proposal.provenance.epistemicClassification = epistemic;
    proposal.provenance.confidence = Math.max(0.1, Math.min(1.0, confidence));

    this._gate.transitionState(
      proposal,
      "VERIFIED",
      "pipeline_verify",
      `Verified epistemic standing as ${epistemic} (confidence: ${confidence}).`
    );

    return proposal;
  }

  // ---------------------------------------------------------------------------
  // Stage 4: PROPOSE
  // ---------------------------------------------------------------------------

  public propose(
    proposalId: string,
    payload: KnowledgeProposalPayload | SkillProposalPayload
  ): AdaptiveProposal {
    this._assertOperationalState();
    const proposal = this._gate.getProposal(proposalId);
    if (!proposal) throw new Error(`Proposal "${proposalId}" not found.`);

    proposal.payload = payload;

    this._gate.transitionState(
      proposal,
      "PROPOSED",
      "pipeline_propose",
      `Constructed ${payload.kind} proposal "${proposal.title}".`
    );

    return proposal;
  }

  // ---------------------------------------------------------------------------
  // Stage 5: CRITIC REVIEW
  // ---------------------------------------------------------------------------

  public criticReview(proposalId: string): AdaptiveProposal {
    this._assertOperationalState();
    const proposal = this._gate.getProposal(proposalId);
    if (!proposal) throw new Error(`Proposal "${proposalId}" not found.`);

    const review = proposalCriticReviewer.review(proposal);
    proposal.criticReview = review;

    if (review.confidenceDowngraded) {
      proposal.provenance.confidence = Math.max(0.2, proposal.provenance.confidence - 0.20);
    }

    if (review.verdict === "REJECTED") {
      this._gate.transitionState(
        proposal,
        "REJECTED",
        "critic_reviewer",
        `Critic rejected proposal: ${review.critique}`
      );
    } else {
      this._gate.transitionState(
        proposal,
        "UNDER_CRITIC_REVIEW",
        "critic_reviewer",
        `Critic review result: ${review.verdict}.`
      );
    }

    return proposal;
  }

  // ---------------------------------------------------------------------------
  // Stage 6: SECURITY REVIEW
  // ---------------------------------------------------------------------------

  public securityReview(proposalId: string): AdaptiveProposal {
    this._assertOperationalState();
    const proposal = this._gate.getProposal(proposalId);
    if (!proposal) throw new Error(`Proposal "${proposalId}" not found.`);

    const review = proposalSecurityReviewer.review(proposal);
    proposal.securityReview = review;

    if (review.verdict === "REJECTED") {
      this._gate.transitionState(
        proposal,
        "REJECTED",
        "security_reviewer",
        `Security review rejected proposal: ${review.securityConcerns.join("; ")}`
      );
    } else {
      this._gate.transitionState(
        proposal,
        "UNDER_SECURITY_REVIEW",
        "security_reviewer",
        "Security review passed with acceptable risk score."
      );
    }

    return proposal;
  }

  // ---------------------------------------------------------------------------
  // Stage 7: EVALUATE
  // ---------------------------------------------------------------------------

  public evaluate(proposalId: string): AdaptiveProposal {
    this._assertOperationalState();
    const proposal = this._gate.getProposal(proposalId);
    if (!proposal) throw new Error(`Proposal "${proposalId}" not found.`);

    if (proposal.lifecycleState === "REJECTED") {
      return proposal; // Already rejected
    }

    const evaluation = proposalEvaluator.evaluate(proposal);
    proposal.evaluation = evaluation;

    if (evaluation.recommendedAction === "REJECT") {
      this._gate.transitionState(
        proposal,
        "REJECTED",
        "evaluator",
        `Evaluator recommended rejection: ${evaluation.evalNotes}`
      );
    } else {
      this._gate.transitionState(
        proposal,
        "EVALUATING",
        "evaluator",
        `Evaluated: regression risk ${evaluation.regressionRisk}, score ${evaluation.evalScore}. Recommendation: ${evaluation.recommendedAction}.`
      );
    }

    return proposal;
  }

  // ---------------------------------------------------------------------------
  // Stage 8: APPROVE (Gate delegated)
  // ---------------------------------------------------------------------------

  public approve(proposalId: string, approver: string, reason?: string): AdaptiveProposal {
    this._assertOperationalState();
    return this._gate.approveProposal(proposalId, { approver, reason });
  }

  public reject(proposalId: string, rejecter: string, reason: string): AdaptiveProposal {
    this._assertOperationalState();
    return this._gate.rejectProposal(proposalId, { rejecter, reason });
  }

  // ---------------------------------------------------------------------------
  // Stage 9: INTEGRATE (Gate delegated)
  // ---------------------------------------------------------------------------

  public async integrate(
    proposalId: string,
    actor: string,
    targetStore?: "KNOWLEDGE_GRAPH" | "ADAPTIVE_BRAIN" | "SKILL_REGISTRY"
  ): Promise<AdaptiveProposal> {
    this._assertOperationalState();
    return this._gate.integrateProposal(proposalId, { actor, targetStore });
  }

  // ---------------------------------------------------------------------------
  // Stage 10: REGRESSION VERIFY & ROLLBACK
  // ---------------------------------------------------------------------------

  public regressionVerify(proposalId: string, isHealthy: boolean, actor: string): AdaptiveProposal {
    this._assertOperationalState();
    const proposal = this._gate.getProposal(proposalId);
    if (!proposal) throw new Error(`Proposal "${proposalId}" not found.`);

    if (!isHealthy && proposal.integration?.rollbackAuditToken) {
      // Trigger rollback automatically on regression
      return this._gate.rollbackIntegration(proposalId, {
        actor,
        token: proposal.integration.rollbackAuditToken,
        reason: "Automatic rollback triggered by post-integration regression verification failure.",
      });
    }

    this._gate.transitionState(
      proposal,
      proposal.lifecycleState,
      actor,
      "Post-integration regression verification passed cleanly."
    );

    return proposal;
  }

  public rollback(proposalId: string, token: string, actor: string, reason?: string): AdaptiveProposal {
    this._assertOperationalState();
    return this._gate.rollbackIntegration(proposalId, { actor, token, reason });
  }

  // ---------------------------------------------------------------------------
  // End-to-End Orchestrated Pipeline
  // ---------------------------------------------------------------------------

  /**
   * Processes a learning opportunity through stages 1 to 7 (stops at Approval Gate).
   */
  public async processOpportunity(
    opportunity: IngestionOpportunity,
    payloadData?: KnowledgeProposalPayload | SkillProposalPayload
  ): Promise<AdaptiveProposal> {
    // 1. Discover
    const proposal = await this.discover(opportunity);

    // 2. Extract
    this.extract(proposal.id, opportunity.rawContent);

    // 3. Verify
    this.verify(proposal.id, {
      epistemicLabel: opportunity.extractedClaims?.[0]?.epistemicLabel || "INFERENCE",
    });

    // 4. Propose
    const payload = payloadData || (
      opportunity.type === "KNOWLEDGE"
        ? {
            kind: "KNOWLEDGE" as const,
            targetDomain: opportunity.domain || "general",
            canonicalName: opportunity.title,
            entityType: "KNOWLEDGE" as const,
            attributes: { raw: opportunity.description },
            summary: opportunity.description,
          }
        : {
            kind: "SKILL" as const,
            skillName: opportunity.title,
            description: opportunity.description,
            triggerPatterns: [opportunity.title.toLowerCase()],
            workflowSteps: opportunity.suggestedSteps || [
              { stepId: "step_1", action: "OPEN_URL", params: { url: opportunity.sourceUrl }, timeoutMs: 15000 },
            ],
            requiredPermissions: ["browser:read"],
            sandboxed: true,
          }
    );
    this.propose(proposal.id, payload);

    // 5. Critic Review
    const pCritic = this.criticReview(proposal.id);
    if ((pCritic.lifecycleState as string) === "REJECTED") return pCritic;

    // 6. Security Review
    const pSecurity = this.securityReview(proposal.id);
    if ((pSecurity.lifecycleState as string) === "REJECTED") return pSecurity;

    // 7. Evaluate
    const pEval = this.evaluate(proposal.id);

    // STOPS AT STAGE 7: Awaits manual user approval (Stage 8)
    return pEval;
  }

  public listProposals(filter?: ProposalFilterOptions): AdaptiveProposal[] {
    return this._gate.listProposals(filter);
  }

  public getProposal(proposalId: string): AdaptiveProposal | undefined {
    return this._gate.getProposal(proposalId);
  }
}

export const knowledgeProposalPipeline = new KnowledgeProposalPipeline();
