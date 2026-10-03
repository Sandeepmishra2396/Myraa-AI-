/**
 * MYRAA — Phase 25: Self-Correction & Failure Recovery Engine
 * SelfCorrectionTypes
 *
 * Core type definitions for deterministic failure analysis, hypothesis generation,
 * safe recovery alternatives, verification-first recovery loops, and immutable security boundaries.
 */

export type FailureErrorType =
  | "NOT_FOUND"
  | "PATH_INVALID"
  | "PERMISSION_DENIED"
  | "TIMEOUT"
  | "NETWORK_ERROR"
  | "INVALID_ARGUMENT"
  | "DEPENDENCY_ERROR"
  | "RUNTIME_ERROR"
  | "BUILD_ERROR"
  | "TEST_FAILURE"
  | "PROCESS_EXIT"
  | "SECURITY_BOUNDARY_PROTECTED"
  | "UNKNOWN";

export type FailureSeverity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type RecoveryStatus =
  | "SUCCESS"
  | "PARTIAL_SUCCESS"
  | "FAILED"
  | "BLOCKED"
  | "CANCELLED"
  | "UNVERIFIED";

export type EpistemicStatus =
  | "OBSERVED_FACT"
  | "INFERENCE"
  | "RECOVERY_HYPOTHESIS"
  | "VERIFIED_RESULT";

export type RecoveryStrategyCategory =
  | "PARAMETER_ADJUSTMENT"
  | "PATH_DISCOVERY"
  | "RETRY_WITH_BACKOFF"
  | "ALTERNATIVE_TOOL"
  | "ENVIRONMENT_CHECK"
  | "QUERY_REFINEMENT"
  | "DEPENDENCY_INSPECTION"
  | "RESEARCH_LOOKUP"
  | "CODE_INVESTIGATION"
  | "USER_ESCALATION";

export type CorrectionScope =
  | "GLOBAL"
  | "PROJECT"
  | "WORKSPACE"
  | "APPLICATION"
  | "TASK"
  | "SESSION";

export interface FailureEvidence {
  key: string;
  value: unknown;
  source: string;
  epistemicStatus: EpistemicStatus;
  timestamp: number;
}

export interface FailureEvent {
  id: string;
  actionId: string;
  taskId?: string;
  toolName?: string;
  operation: string;
  timestamp: number;
  errorType: FailureErrorType;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  errorMessage?: string;
  evidence: FailureEvidence[];
  confidence: number;
  severity: FailureSeverity;
  targetResource?: string;
  context?: Record<string, unknown>;
}

export interface RootCauseAnalysis {
  problem: string;
  observedEvidence: string[];
  likelyCause: string;
  alternativeCauses: string[];
  confidence: number;
  affectedResource?: string;
  risk: FailureSeverity;
  recommendedRecovery: string;
  isRecurringPattern: boolean;
  recurrenceCount?: number;
}

export interface RecoveryActionProposal {
  actionId: string;
  toolName: string;
  parameters: Record<string, unknown>;
  description: string;
}

export interface RecoveryCandidate {
  strategyId: string;
  category: RecoveryStrategyCategory;
  description: string;
  requiredActions: RecoveryActionProposal[];
  risk: FailureSeverity;
  confidence: number;
  expectedOutcome: string;
  verificationPlan: string;
  requiresApproval: boolean;
  approvalPrompt?: string;
}

export interface VerificationRequirement {
  type: "PROCESS_RUNNING" | "FILE_EXISTS" | "EXIT_CODE_ZERO" | "TEST_PASSED" | "CUSTOM_CHECK";
  target: string;
  expectedValue?: unknown;
  checkTimeoutMs?: number;
}

export interface VerificationEvidence {
  verified: boolean;
  checkType: string;
  observedValue: unknown;
  expectedValue?: unknown;
  evidenceSnippet?: string;
  timestamp: number;
  failureReason?: string;
}

export interface RecoveryResult {
  recoveryId: string;
  failureId: string;
  strategyId: string;
  attemptNumber: number;
  status: RecoveryStatus;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  evidence: VerificationEvidence[];
  verifiedOutcome?: string;
  learnedKnowledge?: CorrectionRecord;
  error?: string;
  timestamp: number;
}

export interface CorrectionRecord {
  correctionId: string;
  failurePattern: string;
  previousStrategy: string;
  failureEvidence: string;
  successfulAlternative: string;
  verificationEvidence: string;
  confidence: number;
  scope: CorrectionScope;
  targetResource: string;
  verifiedValue: unknown;
  timestamp: number;
  supersedesId?: string;
}

export interface RecoveryBudget {
  maxAttemptsPerAction: number; // default: 3
  maxTotalAttemptsPerTask: number; // default: 5
  maxChainDepth: number; // default: 5
}

export interface RecoveryAuditEntry {
  auditId: string;
  timestamp: number;
  action: string;
  failureId?: string;
  strategyId?: string;
  status: string;
  details: Record<string, unknown>;
}
