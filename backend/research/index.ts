/**
 * MYRAA — Step 8: Advanced Browser Research Agent
 * index.ts — Research Module Public API
 *
 * Exports the coordinator and all public types.
 * Internal implementation modules are not re-exported to prevent
 * misuse from outside the research subsystem.
 */

export { advancedResearchCoordinator } from "./AdvancedResearchCoordinator.ts";
export { documentationComparator } from "./DocumentationComparator.ts";
export { citationManager } from "./CitationManager.ts";
export { duplicateSourceDetector } from "./DuplicateSourceDetector.ts";
export { epistemicVerifier } from "./EpistemicVerifier.ts";
export { sourceReliabilityEngine } from "./SourceReliabilityEngine.ts";
export { researchQueryPlanner } from "./ResearchQueryPlanner.ts";

export type {
  ResearchQueryRequest,
  ResearchCompareRequest,
  ResearchBrowserContextRequest,
  SynthesizedResearchResult,
  ResearchSession,
  ResearchSessionResponse,
  ResearchClaimsResponse,
  ResearchCitationsResponse,
  ComparisonReport,
  ResearchClaim,
  CitationEntry,
  ContradictionRecord,
  BrowserPageContext,
  SourceType,
  SourceReliabilityScore,
  EpistemicLabel,
  VerificationStatus,
  EpistemicSummary,
  DuplicateCluster,
  DuplicateDetectionReport,
  EpistemicQueryRequest,
  DuplicateDetectionRequest,
  VerifyClaimsRequest,
  RefinedQueryPlan,
  QueryRefinementStep,
} from "./AdvancedResearchTypes.ts";
