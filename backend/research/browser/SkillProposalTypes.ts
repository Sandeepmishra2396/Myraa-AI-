/**
 * MYRAA — Advanced Browser Intelligence & Adaptive Knowledge System
 * SkillProposalTypes.ts
 *
 * Stage 6: Types and contracts for the Evidence-Driven Skill Proposal System.
 *
 * Lifecycle:
 *   OBSERVED → CANDIDATE → UNDER_CRITIC_REVIEW → UNDER_SECURITY_REVIEW →
 *   READY_FOR_HUMAN_REVIEW → APPROVED | REJECTED (with INTEGRATED / ROLLED_BACK / EXPIRED / INVALIDATED)
 *
 * Core Invariants:
 *   - A proposal is NEVER an executable skill and must never grant itself permission to run.
 *   - Success is NEVER inferred merely because a tool returned without an error.
 *   - AI proposals are UNTRUSTED input; AI self-approval is strictly forbidden.
 *   - Human approval must be authenticated, version-bound, and protected against replay.
 *   - Zero unauthorized writes to permanent memory (SQLite) or Personal Knowledge Graph.
 *   - Zero automatic execution of newly proposed or integrated skills.
 */

export type SkillProposalLifecycleState =
  | "OBSERVED"
  | "CANDIDATE"
  | "UNDER_CRITIC_REVIEW"
  | "UNDER_SECURITY_REVIEW"
  | "READY_FOR_HUMAN_REVIEW"
  | "APPROVED"
  | "REJECTED"
  | "INTEGRATED"
  | "ROLLED_BACK"
  | "EXPIRED"
  | "INVALIDATED";

export type SkillRiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface ObservedStepEvidence {
  stepIndex: number;
  toolName: string;
  parameters: Record<string, unknown>;
  outputEvidence: unknown;
  durationMs: number;
  succeeded: boolean;
  verifiedOutcome: boolean;
  preconditionsMet?: boolean;
  postconditionsMet?: boolean;
  failureReason?: string;
  timestamp: number;
}

export interface ObservedExecutionTrace {
  traceId: string;
  sessionId: string;
  taskDescription: string;
  steps: ObservedStepEvidence[];
  overallSuccess: boolean;
  startedAt: number;
  completedAt: number;
  taskOrigin: "user_turn" | "workflow" | "scheduled" | "browser_intelligence";
  contextTags?: string[];
}

export interface SkillStepDefinition {
  stepIndex: number;
  toolName: string;
  inputTemplate: Record<string, unknown>;
  preconditions: string[];
  postconditions: string[];
  timeoutMs?: number;
  requiresConfirmation: boolean;
  description?: string;
}

export interface CandidateWorkflow {
  workflowSignature: string;
  name: string;
  description: string;
  triggerPatterns: string[];
  intendedOutcome: string;
  orderedSteps: SkillStepDefinition[];
  requiredTools: string[];
  requiredPermissions: string[];
  riskLevel: SkillRiskLevel;
  requiresConfirmation: boolean;
  failureRecoveryStrategy: string;
  regressionTestRequirements: string[];
  estimatedDurationMs: number;
}

export interface WorkflowDetectionRecord {
  signature: string;
  observedTraceIds: string[];
  distinctSessionIds: string[];
  totalExecutions: number;
  successfulExecutions: number;
  failedExecutions: number;
  successRate: number;
  firstObservedAt: number;
  lastObservedAt: number;
  confidenceScore: number;
  candidateProposalId?: string;
}

export interface SkillCriticReview {
  verdict: "PASSED" | "REJECTED" | "NEEDS_REVISION";
  score: number;
  reviewTimestamp: number;
  reviewer: string;
  observations: string[];
  detectedGaps: string[];
  unaddressedContradictions: string[];
  confidenceDowngraded: boolean;
  suggestions?: string[];
}

export interface SkillSecurityReview {
  verdict: "PASSED" | "REJECTED";
  riskScore: number;
  reviewTimestamp: number;
  reviewer: string;
  injectionDetected: boolean;
  privilegeEscalationAttempt: boolean;
  containsDangerousCommands: boolean;
  containsPrivateIpOrSsrf: boolean;
  containsForbiddenKeys: boolean;
  sanitizedClean: boolean;
  requiredSecurityLevel: SkillRiskLevel;
  confirmationRequired: boolean;
  violations: string[];
}

export interface HumanApprovalDecision {
  approver: string;
  approverRole: "admin" | "standard";
  decision: "APPROVE" | "REJECT";
  reason: string;
  timestamp: number;
  expiresAt: number;
  nonce: string;
  proposalVersion: number;
  signature: string;
}

export interface SkillProposalAuditEntry {
  timestamp: number;
  event: string;
  actor: string;
  details: Record<string, unknown>;
  previousState?: SkillProposalLifecycleState;
  newState?: SkillProposalLifecycleState;
}

export interface SkillProposal {
  proposalId: string;
  version: number;
  lifecycleState: SkillProposalLifecycleState;
  workflow: CandidateWorkflow;
  detection: WorkflowDetectionRecord;
  criticReview?: SkillCriticReview;
  securityReview?: SkillSecurityReview;
  humanApproval?: HumanApprovalDecision;
  integrationRecord?: {
    integratedAt: number;
    integratedBy: string;
    rollbackToken: string;
    registeredSkillKey: string;
    snapshotState: Record<string, unknown>;
    autoExecutionBlocked: true;
  };
  rollbackRecord?: {
    rolledBackAt: number;
    rolledBackBy: string;
    reason: string;
  };
  auditHistory: SkillProposalAuditEntry[];
  createdAt: number;
  updatedAt: number;
  contentHash: string;
}

export interface SkillProposalConfig {
  minSuccessfulExecutions: number;
  minDistinctSessions: number;
  minSuccessRate: number;
  maxStoredObservations: number;
  maxActiveProposals: number;
  approvalTtlMs: number;
  observationTtlMs: number;
}

export interface SkillObservationInput {
  traceId?: string;
  sessionId: string;
  taskDescription: string;
  steps: {
    toolName: string;
    parameters: Record<string, unknown>;
    outputEvidence?: unknown;
    durationMs?: number;
    succeeded: boolean;
    verifiedOutcome?: boolean;
    preconditionsMet?: boolean;
    postconditionsMet?: boolean;
    failureReason?: string;
  }[];
  taskOrigin?: "user_turn" | "workflow" | "scheduled" | "browser_intelligence";
  contextTags?: string[];
}
