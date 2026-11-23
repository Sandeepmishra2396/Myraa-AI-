/**
 * MYRAA — Advanced Browser Intelligence & Adaptive Knowledge System
 * SelfImprovementTypes.ts
 *
 * Stage 7: Types and contracts for the Self-Improvement Evaluator.
 *
 * Lifecycle:
 *   SUBMITTED → VALIDATED → EVALUATING → EVALUATED → UNDER_CRITIC_REVIEW →
 *   UNDER_SECURITY_REVIEW → READY_FOR_HUMAN_REVIEW → APPROVED | REJECTED
 *   (with INTEGRATED / ROLLED_BACK / SUPERSEDED)
 *
 * Core Invariants:
 *   - Evaluation does NOT grant approval.
 *   - AI Evaluator CANNOT approve its own candidate (UNAUTHORIZED_SELF_APPROVAL).
 *   - Evaluator CANNOT modify its own fixtures, baselines, criteria, or security policy.
 *   - Hard safety gates cannot be overridden by high aggregate quality scores.
 *   - Zero unauthorized writes to permanent memory (SQLite) or Knowledge Graph.
 *   - Zero auto-deployment or automatic live activation.
 */

export type ImprovementCandidateLifecycleState =
  | "SUBMITTED"
  | "VALIDATED"
  | "EVALUATING"
  | "EVALUATED"
  | "UNDER_CRITIC_REVIEW"
  | "UNDER_SECURITY_REVIEW"
  | "READY_FOR_HUMAN_REVIEW"
  | "APPROVED"
  | "REJECTED"
  | "INTEGRATED"
  | "ROLLED_BACK"
  | "SUPERSEDED";

export type ImprovementCandidateKind =
  | "PROMPT"
  | "RETRIEVAL_QUERY"
  | "WORKFLOW_HEURISTIC";

export type FixtureCategory =
  | "TASK_SUCCESS"
  | "EVIDENTIARY_INTEGRITY"
  | "ADVERSARIAL_INJECTION"
  | "POLICY_COMPLIANCE"
  | "REGRESSION"
  | "RESOURCE_BOUNDS";

export interface EvaluationFixture {
  fixtureId: string;
  fixtureVersion: number;
  name: string;
  category: FixtureCategory;
  input: Record<string, unknown>;
  expectedOutputConstraints: {
    requiredTokens?: string[];
    forbiddenTokens?: string[];
    maxLatencyMs?: number;
    requireCitations?: boolean;
    requireSafeRejection?: boolean;
    expectedState?: Record<string, unknown>;
  };
  isAdversarial: boolean;
  isHardSafetyGate: boolean;
  timeoutMs?: number;
}

export interface FixtureEvaluationResult {
  fixtureId: string;
  fixtureVersion: number;
  category: FixtureCategory;
  passed: boolean;
  score: number; // 0.0 - 1.0
  executionTimeMs: number;
  isHardSafetyGate: boolean;
  hardSafetyViolation?: string;
  error?: string;
  observedOutput?: unknown;
  details: Record<string, unknown>;
}

export interface EvaluationReport {
  evaluatedAt: number;
  candidateId: string;
  candidateVersion: number;
  fixtureSetVersion: string;
  totalFixtures: number;
  passedFixtures: number;
  hardSafetyViolationsCount: number;
  hardSafetyPassed: boolean;
  scores: {
    taskSuccessScore: number;
    evidenceIntegrityScore: number;
    policyComplianceScore: number;
    regressionRate: number;
    unsupportedClaimRate: number;
    aggregateScore: number;
  };
  deltaAgainstBaseline?: number;
  fixtureResults: FixtureEvaluationResult[];
  recommendation: "PROCEED_TO_REVIEWS" | "HOLD_FOR_INSPECTION" | "REJECT";
  uncertaintyNotes?: string[];
}

export interface ImprovementCriticReview {
  verdict: "PASSED" | "REJECTED" | "NEEDS_REVISION";
  score: number;
  reviewedAt: number;
  reviewer: string;
  observations: string[];
  detectedFlaws: string[];
  regressionRiskNotes: string[];
  confidenceDowngraded: boolean;
}

export interface ImprovementSecurityReview {
  verdict: "PASSED" | "REJECTED";
  riskScore: number;
  reviewedAt: number;
  reviewer: string;
  injectionDetected: boolean;
  privilegeEscalationAttempt: boolean;
  containsDangerousCommands: boolean;
  containsPrivateIpOrSsrf: boolean;
  containsForbiddenKeys: boolean;
  sanitizedClean: boolean;
  violations: string[];
}

export interface HumanApprovalRecord {
  approver: string;
  approverRole: "admin" | "standard";
  decision: "APPROVE" | "REJECT";
  reason: string;
  timestamp: number;
  expiresAt: number;
  nonce: string;
  candidateVersion: number;
  signature: string;
}

export interface ImprovementAuditEntry {
  timestamp: number;
  event: string;
  actor: string;
  details: Record<string, unknown>;
  previousState?: ImprovementCandidateLifecycleState;
  newState?: ImprovementCandidateLifecycleState;
}

export interface ImprovementCandidate {
  candidateId: string;
  version: number;
  kind: ImprovementCandidateKind;
  name: string;
  description: string;
  targetComponent: string;
  proposedPayload: Record<string, unknown>;
  baselinePayload?: Record<string, unknown>;
  baselineScore?: number;
  provenance: {
    author: string;
    rationale: string;
    sourceTraces?: string[];
    createdAt: number;
  };
  criteria: {
    minTaskSuccessRate: number;
    minEvidenceIntegrityScore: number;
    maxUnsupportedClaimRate: number;
    maxRegressionRate: number;
  };
  lifecycleState: ImprovementCandidateLifecycleState;
  evaluationReport?: EvaluationReport;
  criticReview?: ImprovementCriticReview;
  securityReview?: ImprovementSecurityReview;
  humanApproval?: HumanApprovalRecord;
  integrationRecord?: {
    integratedAt: number;
    integratedBy: string;
    rollbackToken: string;
    targetComponent: string;
    backupPayload: Record<string, unknown>;
    autoDeploymentBlocked: true;
  };
  rollbackRecord?: {
    rolledBackAt: number;
    rolledBackBy: string;
    reason: string;
  };
  contentHash: string;
  auditHistory: ImprovementAuditEntry[];
  createdAt: number;
  updatedAt: number;
}

export interface SubmitCandidateInput {
  kind: ImprovementCandidateKind;
  name: string;
  description: string;
  targetComponent: string;
  proposedPayload: Record<string, unknown>;
  baselinePayload?: Record<string, unknown>;
  baselineScore?: number;
  author: string;
  rationale: string;
  sourceTraces?: string[];
  criteria?: Partial<ImprovementCandidate["criteria"]>;
}
