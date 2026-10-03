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
} from "./AdvancedResearchTypes.ts";
