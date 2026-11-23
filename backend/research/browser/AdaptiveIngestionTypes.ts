/**
 * MYRAA — Advanced Browser Intelligence & Adaptive Knowledge System
 * AdaptiveIngestionTypes.ts
 *
 * Stage 5: Types and models for the 10-stage Adaptive Knowledge & Skill Ingestion Pipeline.
 *
 * Lifecycle:
 *   DISCOVER → EXTRACT → VERIFY → PROPOSE → CRITIC REVIEW → SECURITY REVIEW →
 *   EVALUATE → APPROVE → INTEGRATE → REGRESSION VERIFY
 *
 * Core Invariants:
 *   - External content remains UNTRUSTED_EXTERNAL_CONTENT.
 *   - Research must NEVER directly mutate permanent memory, Knowledge Graph, or executable skills.
 *   - AI proposals must NEVER self-authorize (isSelfApproved is strictly forbidden).
 *   - Full provenance, epistemic tagging, citation retention, and rollbacks are mandatory.
 */

export type ProposalLifecycleState =
  | "DISCOVERED"
  | "EXTRACTED"
  | "VERIFIED"
  | "PROPOSED"
  | "UNDER_CRITIC_REVIEW"
  | "UNDER_SECURITY_REVIEW"
  | "EVALUATING"
  | "APPROVED"
  | "REJECTED"
  | "INTEGRATED"
  | "ROLLED_BACK";

export type ProposalType = "KNOWLEDGE" | "SKILL";

export type EpistemicClassification =
  | "FACT"
  | "INFERENCE"
  | "HYPOTHESIS"
  | "VERIFIED_CONCLUSION";

export interface ProposalProvenance {
  sourceUrls: string[];
  sourceExcerpts: string[];
  capturedAt: number;
  epistemicClassification: EpistemicClassification;
  confidence: number;
  uncertaintyNotes?: string;
  contradictions?: string[];
  knownLimitations?: string[];
  syndicatedDuplicateCount?: number;
  proposalVersion: number;
}

export interface KnowledgeProposalPayload {
  kind: "KNOWLEDGE";
  targetDomain: string;
  canonicalName: string;
  entityType: "TECHNOLOGY" | "FRAMEWORK" | "TOOL" | "KNOWLEDGE" | "DOCUMENT" | "SOURCE" | "RESEARCH_CLAIM";
  attributes: Record<string, unknown>;
  isBreakingChange?: boolean;
  deprecationNotice?: string;
  summary: string;
}

export interface SkillWorkflowStep {
  stepId: string;
  action: string;
  params: Record<string, unknown>;
  timeoutMs?: number;
  description?: string;
}

export interface SkillProposalPayload {
  kind: "SKILL";
  skillName: string;
  description: string;
  triggerPatterns: string[];
  workflowSteps: SkillWorkflowStep[];
  requiredPermissions: string[];
  sandboxed: boolean;
}

export type CriticReviewVerdict = "APPROVED" | "REJECTED" | "NEEDS_REVISION";

export interface CriticReviewRecord {
  verdict: CriticReviewVerdict;
  critique: string;
  reviewedAt: number;
  unsupportedConclusions: string[];
  detectedFlaws: string[];
  confidenceDowngraded: boolean;
  suggestedRevisions?: string[];
}

export type SecurityReviewVerdict = "APPROVED" | "REJECTED";

export interface SecurityReviewRecord {
  verdict: SecurityReviewVerdict;
  riskScore: number;
  securityConcerns: string[];
  injectionDetected: boolean;
  privilegeEscalationAttempt: boolean;
  forbiddenKeysDetected: string[];
  reviewedAt: number;
}

export type RegressionRisk = "LOW" | "MEDIUM" | "HIGH";

export interface ProposalEvaluationRecord {
  regressionRisk: RegressionRisk;
  evalScore: number;
  evalNotes: string;
  evaluatedAt: number;
  compatibilityPassed: boolean;
  recommendedAction: "PROCEED_TO_APPROVAL" | "HOLD_FOR_MANUAL_INSPECTION" | "REJECT";
}

export interface ProposalApprovalRecord {
  status: "PENDING" | "APPROVED" | "REJECTED";
  approver?: string;
  approvedAt?: number;
  approvalReason?: string;
  rejectionReason?: string;
  isSelfApproved: boolean; // Must always evaluate to false
}

export interface ProposalIntegrationRecord {
  integratedAt: number;
  targetStore: "KNOWLEDGE_GRAPH" | "ADAPTIVE_BRAIN" | "SKILL_REGISTRY";
  integratedEntityId: string;
  rollbackAvailable: boolean;
  rollbackAuditToken: string;
  preIntegrationSnapshot?: unknown;
}

export interface ProposalAuditEntry {
  timestamp: number;
  fromState: ProposalLifecycleState;
  toState: ProposalLifecycleState;
  actor: string;
  reason: string;
  metadata?: Record<string, unknown>;
}

export interface AdaptiveProposal {
  id: string;
  type: ProposalType;
  title: string;
  description: string;
  lifecycleState: ProposalLifecycleState;
  provenance: ProposalProvenance;
  payload: KnowledgeProposalPayload | SkillProposalPayload;
  criticReview?: CriticReviewRecord;
  securityReview?: SecurityReviewRecord;
  evaluation?: ProposalEvaluationRecord;
  approval: ProposalApprovalRecord;
  integration?: ProposalIntegrationRecord;
  auditTrail: ProposalAuditEntry[];
  createdAt: number;
  updatedAt: number;
}

export interface IngestionOpportunity {
  opportunityId?: string;
  type: ProposalType;
  title: string;
  description: string;
  rawContent: string;
  sourceUrl: string;
  sourceTitle?: string;
  extractedClaims?: Array<{
    claimText: string;
    excerpt: string;
    version?: string;
    epistemicLabel?: EpistemicClassification;
    confidence?: number;
  }>;
  suggestedSteps?: SkillWorkflowStep[];
  domain?: string;
}

export interface ProposalFilterOptions {
  state?: ProposalLifecycleState;
  type?: ProposalType;
  minConfidence?: number;
  limit?: number;
}
