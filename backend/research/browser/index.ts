/**
 * MYRAA — Advanced Browser Intelligence Subsystem
 * index.ts — Public API Barrel
 *
 * Stage 1 & Stage 3: Browser Intelligence & Browser Control
 */

export {
  browserIntelligenceCoordinator,
  BrowserIntelligenceCoordinator,
} from "./BrowserIntelligenceCoordinator.ts";

export {
  browserIntentInterpreter,
  BrowserIntentInterpreter,
} from "./BrowserIntentInterpreter.ts";

export {
  browserQueryPlanner,
  BrowserQueryPlanner,
} from "./BrowserQueryPlanner.ts";

export {
  browserDomExtractor,
  BrowserDomExtractor,
} from "./BrowserDomExtractor.ts";

export {
  browserActionExecutor,
  BrowserActionExecutor,
  type ActionResult,
} from "./BrowserActionExecutor.ts";

export {
  browserTabManager,
  BrowserTabManager,
  MAX_OPEN_TABS,
} from "./BrowserTabManager.ts";

export {
  browserElementTargeter,
  BrowserElementTargeter,
} from "./BrowserElementTargeter.ts";

export {
  documentExtractor,
  DocumentExtractor,
  MAX_EXTRACT_BYTES,
  MAX_TEXT_LENGTH,
} from "./DocumentExtractor.ts";

export {
  documentComparator,
  DocumentComparator,
} from "./DocumentComparator.ts";

export type {
  BrowserTaskState,
  BrowserActionType,
  BrowserTaskStep,
  BrowserTaskRequest,
  BrowserTaskResult,
  BrowserTaskPlan,
  BrowserExtractedContent,
  ExtractedTableData,
  ExtractedLinkData,
  BrowserProgressUpdate,
  BrowserEvidenceReport,
  BrowserTabContext,
  TabStatus,
  ElementTargetSpec,
  ElementTargetingStrategy,
  TargetedElementResult,
  ExtractedCodeBlock,
  DocumentSection,
  StructuredDocument,
  SectionDifference,
  VersionCompatibilityDiff,
  ConflictingClaim,
  DocumentComparisonCitation,
  DocumentComparisonResult,
  DocumentComparisonRequest,
} from "./BrowserIntelligenceTypes.ts";

export {
  knowledgeProposalPipeline,
  KnowledgeProposalPipeline,
} from "./KnowledgeProposalPipeline.ts";

export {
  proposalIntegrationGate,
  ProposalIntegrationGate,
} from "./ProposalIntegrationGate.ts";

export {
  proposalCriticReviewer,
  ProposalCriticReviewer,
} from "./ProposalCriticReviewer.ts";

export {
  proposalSecurityReviewer,
  ProposalSecurityReviewer,
} from "./ProposalSecurityReviewer.ts";

export {
  proposalEvaluator,
  ProposalEvaluator,
} from "./ProposalEvaluator.ts";

export type {
  AdaptiveProposal,
  ProposalLifecycleState,
  ProposalType,
  EpistemicClassification,
  ProposalProvenance,
  KnowledgeProposalPayload,
  SkillProposalPayload,
  SkillWorkflowStep,
  CriticReviewVerdict,
  CriticReviewRecord,
  SecurityReviewVerdict,
  SecurityReviewRecord,
  RegressionRisk,
  ProposalEvaluationRecord,
  ProposalApprovalRecord,
  ProposalIntegrationRecord,
  ProposalAuditEntry,
  IngestionOpportunity,
  ProposalFilterOptions,
} from "./AdaptiveIngestionTypes.ts";

// ── Stage 6: Skill Proposal System ──────────────────────────────────────────
export {
  workflowEvidenceObserver,
  WorkflowEvidenceObserver,
  DEFAULT_PROPOSAL_CONFIG,
} from "./WorkflowEvidenceObserver.ts";

export {
  workflowPatternDetector,
  WorkflowPatternDetector,
} from "./WorkflowPatternDetector.ts";

export {
  skillProposalCritic,
  SkillProposalCritic,
} from "./SkillProposalCritic.ts";

export {
  skillProposalSecurityReviewer,
  SkillProposalSecurityReviewer,
} from "./SkillProposalSecurityReviewer.ts";

export {
  skillProposalManager,
  SkillProposalManager,
} from "./SkillProposalManager.ts";

export type {
  SkillProposalLifecycleState,
  SkillRiskLevel,
  ObservedStepEvidence,
  ObservedExecutionTrace,
  SkillStepDefinition,
  CandidateWorkflow,
  WorkflowDetectionRecord,
  SkillCriticReview,
  SkillSecurityReview,
  HumanApprovalDecision,
  SkillProposalAuditEntry,
  SkillProposal,
  SkillProposalConfig,
  SkillObservationInput,
} from "./SkillProposalTypes.ts";

// ── Stage 7: Self-Improvement Evaluator ──────────────────────────────────────
export {
  evaluationFixtureRegistry,
  EvaluationFixtureRegistry,
  FIXTURE_SET_VERSION,
} from "./EvaluationFixtureRegistry.ts";

export {
  isolatedEvaluationHarness,
  IsolatedEvaluationHarness,
} from "./IsolatedEvaluationHarness.ts";

export {
  improvementCriticReviewer,
  ImprovementCriticReviewer,
} from "./ImprovementCriticReviewer.ts";

export {
  improvementSecurityReviewer,
  ImprovementSecurityReviewer,
} from "./ImprovementSecurityReviewer.ts";

export {
  selfImprovementEvaluator,
  SelfImprovementEvaluator,
  DEFAULT_IMPROVEMENT_CRITERIA,
} from "./SelfImprovementEvaluator.ts";

export type {
  ImprovementCandidateLifecycleState,
  ImprovementCandidateKind,
  FixtureCategory,
  EvaluationFixture,
  FixtureEvaluationResult,
  EvaluationReport,
  ImprovementCriticReview,
  ImprovementSecurityReview,
  HumanApprovalRecord,
  ImprovementAuditEntry,
  ImprovementCandidate,
  SubmitCandidateInput,
} from "./SelfImprovementTypes.ts";



