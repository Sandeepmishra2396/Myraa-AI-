/**
 * MYRAA — Step 8: Advanced Browser Research Agent
 * AdvancedResearchTypes
 *
 * Core type system for the evidence-driven research architecture:
 *   Query Planner → Multi-Source Search → Claim Extraction → Cross-Check
 *   → Contradiction Detection → Synthesis → Citation Report
 *
 * Security invariant: ALL external content is UNTRUSTED_EXTERNAL_CONTENT.
 * No webpage can override instructions, trigger tools, or bypass policy.
 */

// ---------------------------------------------------------------------------
// 1. Source Classification & Reliability
// ---------------------------------------------------------------------------

export type SourceType =
  | "OFFICIAL_DOCUMENTATION"
  | "OFFICIAL_API_REFERENCE"
  | "OFFICIAL_GITHUB"
  | "ACADEMIC"
  | "TRUSTED_TECHNICAL_SOURCE"
  | "COMMUNITY"
  | "FORUM"
  | "UNKNOWN";

export interface SourceReliabilityScore {
  sourceType: SourceType;
  /** 0.0–1.0: authority of the originating domain/org */
  sourceAuthority: number;
  /** 0.0–1.0: how recent the content is (decay over time) */
  recency: number;
  /** 0.0–1.0: how specific/detailed the claim evidence is */
  specificity: number;
  /** Whether the source provides direct, first-hand evidence */
  directEvidence: boolean;
  /** Number of other sources that corroborate this claim */
  corroboration: number;
  /** Whether the version matches the project's current version */
  versionMatch: boolean;
  /** Composite reliability score (0.0–1.0) */
  composite: number;
}

// ---------------------------------------------------------------------------
// 2. Research Claim (Structured Evidence Unit)
// ---------------------------------------------------------------------------

export interface ResearchClaim {
  id: string;
  /** The extractable, verifiable statement */
  claim: string;
  /** Evidence text from the source (quoted/summarized) */
  evidence: string;

  sourceId: string;
  sourceUrl: string;
  sourceTitle: string;
  sourceType: SourceType;
  reliability: SourceReliabilityScore;

  /** Confidence level for this individual claim */
  confidence: number; // 0.0–1.0

  /** Version this claim applies to, if stated */
  version?: string;
  /** ISO date when source was published/updated */
  publishedAt?: string;
  /** When the claim was extracted */
  extractedAt: number;

  /** IDs of claims this claim supports */
  supports: string[];
  /** IDs of claims this claim contradicts */
  contradicts: string[];
}

// ---------------------------------------------------------------------------
// 3. Research Source
// ---------------------------------------------------------------------------

export interface ResearchSource {
  id: string;
  url: string;
  title: string;
  type: SourceType;
  /** Raw sanitized text (prompt-injection stripped) */
  sanitizedContent: string;
  fetchedAt: number;
  reliability: SourceReliabilityScore;
  /** Whether prompt injection was detected in the content */
  injectionDetected: boolean;
}

// ---------------------------------------------------------------------------
// 4. Contradiction Detection
// ---------------------------------------------------------------------------

export type ContradictionSeverity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type ContradictionResolution =
  | "VERSION_DEPENDENT"
  | "CONTEXT_DEPENDENT"
  | "SOURCE_AUTHORITY_RESOLVED"
  | "RECENCY_RESOLVED"
  | "UNRESOLVED";

export interface ContradictionRecord {
  id: string;
  topic: string;
  claimA: ResearchClaim;
  claimB: ResearchClaim;
  severity: ContradictionSeverity;
  resolution: ContradictionResolution;
  resolutionExplanation: string;
  /** Which claim is more likely correct after resolution attempt */
  preferredClaimId: string | null;
  /** Final confidence after contradiction analysis */
  resolvedConfidence: number;
}

// ---------------------------------------------------------------------------
// 5. Query Planning
// ---------------------------------------------------------------------------

export interface ResearchQueryPlan {
  originalQuestion: string;
  primaryQuery: string;
  secondaryQueries: string[];
  officialDocQuery: string;
  versionSpecificQuery: string;
  knownIssueQuery: string;
  implementationQuery: string;
  searchDomains: string[];
  estimatedComplexity: "SIMPLE" | "MODERATE" | "COMPLEX";
}

// ---------------------------------------------------------------------------
// 6. Browser Context
// ---------------------------------------------------------------------------

export interface BrowserPageContext {
  currentUrl: string;
  pageTitle: string;
  visibleText: string;
  selectedText?: string;
  pageHeadings: string[];
  codeSnippets: string[];
  tabId?: string;
  capturedAt: number;
}

// ---------------------------------------------------------------------------
// 7. Project Research Bridge
// ---------------------------------------------------------------------------

export interface ProjectResearchContext {
  projectName: string;
  projectPath: string;
  packageJson?: Record<string, unknown>;
  architecture?: string;
  dependencies?: Record<string, string>;
  relevantFiles: Array<{
    path: string;
    content: string;
    relevanceScore: number;
  }>;
  runtimeErrors?: string[];
  testResults?: string;
}

// ---------------------------------------------------------------------------
// 8. Documentation Comparison
// ---------------------------------------------------------------------------

export type ComparisonStatus =
  | "MATCH"
  | "PARTIAL_MATCH"
  | "MISMATCH"
  | "NOT_FOUND"
  | "PARTIALLY_ALIGNED"
  | "MISSING_REQUIREMENT";

export interface DocumentationRequirement {
  requirementId: string;
  description: string;
  evidenceFromDocs: string;
  sourceUrl: string;
  sourceSection: string;
  isCritical: boolean;
}

export interface ImplementationFinding {
  requirementId: string;
  requirement: DocumentationRequirement;
  implementationLocation: string; // e.g., "src/backend/voice/GeminiLive.ts:142"
  implementationSnippet: string;
  status: ComparisonStatus;
  explanation: string;
  potentialIssue?: string;
}

export interface ComparisonReport {
  reportId: string;
  generatedAt: number;
  documentationSources: ResearchSource[];
  requirements: DocumentationRequirement[];
  findings: ImplementationFinding[];
  overallStatus: ComparisonStatus;
  summary: string;
  criticalMismatches: ImplementationFinding[];
}

// ---------------------------------------------------------------------------
// 9. Research Session & Results
// ---------------------------------------------------------------------------

export interface ResearchSession {
  sessionId: string;
  startedAt: number;
  query: string;
  queryPlan: ResearchQueryPlan;
  sources: ResearchSource[];
  claims: ResearchClaim[];
  contradictions: ContradictionRecord[];
  browserContext?: BrowserPageContext;
  projectContext?: ProjectResearchContext;
  status: "ACTIVE" | "COMPLETE" | "FAILED" | "CANCELLED";
}

export interface SynthesizedResearchResult {
  sessionId: string;
  query: string;
  answer: string;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  confidenceScore: number;
  keyFindings: Array<{
    finding: string;
    supportingClaims: string[]; // claim IDs
    citationSummary: string;
  }>;
  contradictions: ContradictionRecord[];
  citations: CitationEntry[];
  comparisonReport?: ComparisonReport;
  generatedAt: number;
  securityFlags: string[];
}

// ---------------------------------------------------------------------------
// 10. Citation System
// ---------------------------------------------------------------------------

export interface CitationEntry {
  citationId: string;
  claimId: string;
  claim: string;
  evidence: string;
  sourceUrl: string;
  sourceTitle: string;
  sourceType: SourceType;
  relevantSection?: string;
  publishedAt?: string;
  reliability: number;
}

// ---------------------------------------------------------------------------
// 11. REST API Request/Response models
// ---------------------------------------------------------------------------

export interface ResearchQueryRequest {
  question: string;
  projectPath?: string;
  browserContext?: BrowserPageContext;
  maxSources?: number;
  requireOfficial?: boolean;
}

export interface ResearchCompareRequest {
  documentationUrl: string;
  projectPath: string;
  specificFiles?: string[];
  focusArea?: string;
}

export interface ResearchBrowserContextRequest {
  browserContext: BrowserPageContext;
  projectPath?: string;
  question?: string;
}

export interface ResearchSessionResponse {
  sessionId: string;
  status: string;
  query: string;
  sourceCount: number;
  claimCount: number;
  contradictionCount: number;
  startedAt: number;
}

export interface ResearchClaimsResponse {
  sessionId: string;
  claims: ResearchClaim[];
  totalCount: number;
}

export interface ResearchCitationsResponse {
  sessionId: string;
  citations: CitationEntry[];
  totalCount: number;
}
