/**
 * MYRAA — Phase 23: Autonomous Coding Engineer
 * CodingEngineerTypes
 *
 * Core domain types and contracts for the Autonomous Software Engineering workflow.
 */

export type EvidenceClassification = "OBSERVED_FACT" | "INFERENCE" | "RESEARCH_FINDING";

export interface InvestigationEvidence {
  id: string;
  type: "SOURCE_CODE" | "LOG" | "COMPILER_ERROR" | "TEST_FAILURE" | "CONFIG" | "RESEARCH";
  source: string;
  snippet: string;
  interpretation: string;
  classification: EvidenceClassification;
  timestamp: number;
}

export interface RootCauseAnalysis {
  problem: string;
  evidence: InvestigationEvidence[];
  likelyRootCause: string;
  alternativeCauses: string[];
  confidence: "HIGH" | "MEDIUM" | "LOW";
  confidenceScore: number;
  affectedFiles: string[];
  potentialRisk: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  isLowConfidenceAssumption: boolean;
}

export type ChangeSetStatus =
  | "PENDING"
  | "APPROVED"
  | "EXECUTED"
  | "FAILED"
  | "REVERTED"
  | "INVALIDATED";

export interface ChangeSet {
  changeSetId: string;
  taskId: string;
  patch: string;
  approvedFiles: string[];
  approvedOperations: string[];
  approvedRisk: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  approvalTimestamp?: number;
  approvalSource?: "USER_EXPLICIT" | "CONVERSATIONAL_CONFIRMATION";
  executionStatus: ChangeSetStatus;
  originalFileBackups: Record<string, string>;
  rollbackProposal?: {
    reason: string;
    restoreOperations: string[];
    targetFiles: string[];
  };
}

export interface CodingExecutionPlan {
  planId: string;
  problem: string;
  rootCause: string;
  files: string[];
  changesSummary: string;
  risk: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  tests: string[];
  approvalPrompt: string;
  isApproved: boolean;
  changeSetId: string;
}

export interface CodingVerificationReport {
  verified: boolean;
  changeActuallyApplied: boolean;
  testsPassed: boolean;
  buildCheckPassed: boolean;
  evidence: string[];
  exitCode: number;
  testResults: string[];
  regressionPassed: boolean;
}

export interface FinalEngineeringReport {
  problem: string;
  rootCause: string;
  evidence: InvestigationEvidence[];
  filesChanged: string[];
  patchSummary: string;
  testsRun: string[];
  testResults: string[];
  buildStatus: string;
  verificationEvidence: string[];
  remainingRisks: string[];
}

export interface CodingEngineerRequest {
  goal: string;
  project?: string;
  subsystem?: string;
  file?: string;
  userApprovalGranted?: boolean;
  changeSetId?: string;
  mockCompilerError?: string;
  mockLogOutput?: string;
  mockTestFailure?: string;
  allowResearch?: boolean;
  conversationalConfirmation?: string;
  contextId?: string;
}

export interface CodingEngineerResult {
  taskId: string;
  status:
    | "INVESTIGATED"
    | "AWAITING_USER_APPROVAL"
    | "COMPLETED"
    | "BLOCKED"
    | "FAILED"
    | "CANCELLED";
  rootCauseAnalysis?: RootCauseAnalysis;
  executionPlan?: CodingExecutionPlan;
  changeSet?: ChangeSet;
  verificationReport?: CodingVerificationReport;
  finalReport?: FinalEngineeringReport;
  approvalPrompt?: string;
  blockReason?: string;
  requiresUserApproval: boolean;
  finalAnswer: string;
}
