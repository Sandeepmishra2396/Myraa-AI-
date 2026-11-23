/**
 * MYRAA — Advanced Browser Intelligence Subsystem
 * BrowserIntelligenceTypes.ts
 *
 * Core type declarations for Stage 1 & Stage 3: Browser Intelligence & Browser Control.
 * Defines task lifecycles, structured extraction models, execution states,
 * tab context models, element targeting specifications, progress updates,
 * and security constraints.
 *
 * Invariant: External webpage content is always UNTRUSTED_EXTERNAL_CONTENT.
 */

import type { SynthesizedResearchResult } from "../AdvancedResearchTypes.ts";

export type BrowserTaskState =
  | "PENDING"
  | "RUNNING"
  | "PAUSED"
  | "RESUMED"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

export type BrowserActionType =
  | "OPEN_URL"
  | "NAVIGATE"
  | "SEARCH"
  | "CLICK"
  | "TYPE"
  | "FILL_FORM"
  | "SELECT"
  | "SCROLL"
  | "WAIT_FOR"
  | "GO_BACK"
  | "GO_FORWARD"
  | "RELOAD"
  | "EXTRACT_DOM"
  | "EXTRACT_TABLE"
  | "OPEN_TAB"
  | "CLOSE_TAB"
  | "SWITCH_TAB"
  | "COMPARE_DOCUMENTS"
  | "SUMMARIZE_RESEARCH";

export type ElementTargetingStrategy =
  | "CSS_SELECTOR"
  | "XPATH"
  | "TEXT_MATCH"
  | "ARIA_ROLE"
  | "ACCESSIBILITY_ID";

export interface ElementTargetSpec {
  strategy: ElementTargetingStrategy;
  value: string;
  fallbackStrategies?: Array<{ strategy: ElementTargetingStrategy; value: string }>;
  requiredText?: string;
  role?: string;
}

export interface TargetedElementResult {
  found: boolean;
  strategyUsed?: ElementTargetingStrategy;
  selector?: string;
  text?: string;
  tagName?: string;
  attributes?: Record<string, string>;
  isClickable?: boolean;
  isVisible?: boolean;
  error?: string;
  staleRecovered?: boolean;
}

export type TabStatus = "IDLE" | "LOADING" | "LOADED" | "CRASHED" | "CLOSED";

export interface BrowserTabContext {
  tabId: string;
  url: string;
  title: string;
  status: TabStatus;
  history: string[];
  historyIndex: number;
  createdAt: number;
  lastActiveAt: number;
  lastActiveSequence?: number;
  extractedContent?: BrowserExtractedContent;
}

export interface BrowserTaskStep {
  stepId: string;
  action: BrowserActionType;
  target?: string;
  targetSpec?: ElementTargetSpec;
  params?: Record<string, unknown>;
  status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "SKIPPED";
  retries: number;
  maxRetries: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
  evidenceSnippet?: string;
  sensitiveAction?: boolean;
  requiresConfirmation?: boolean;
}

export interface ExtractedTableData {
  caption?: string;
  headers: string[];
  rows: string[][];
}

export interface ExtractedLinkData {
  text: string;
  url: string;
  relevanceScore?: number;
}

export interface BrowserExtractedContent {
  url: string;
  title: string;
  visibleText: string;
  headings: string[];
  tables: ExtractedTableData[];
  links: ExtractedLinkData[];
  accessibilityTree?: string;
  capturedAt: number;
  sanitized: boolean;
  injectionDetected: boolean;
}

export interface BrowserProgressUpdate {
  taskId: string;
  state: BrowserTaskState;
  currentStepIndex: number;
  totalSteps: number;
  progressPercentage: number;
  statusMessage: string;
  timestamp: number;
  activeTabId?: string;
}

export interface BrowserTaskRequest {
  goal: string;
  initialUrl?: string;
  allowedOrigins?: string[];
  timeoutMs?: number;
  maxRetries?: number;
  contextId?: string;
  preferStructuredExtraction?: boolean;
  enableResearchHandoff?: boolean;
  autoConfirmSensitiveActions?: boolean;
}

export interface BrowserEvidenceReport {
  observedFacts: string[];
  inferences: string[];
  hypotheses: string[];
  verifiedConclusions: string[];
  sourceUrls: string[];
  citationsCount: number;
  hasUncertainty: boolean;
  uncertaintyNotes?: string;
}

export interface BrowserTaskResult {
  taskId: string;
  goal: string;
  state: BrowserTaskState;
  startedAt: number;
  completedAt?: number;
  steps: BrowserTaskStep[];
  extractedPages: BrowserExtractedContent[];
  synthesizedAnswer?: string;
  researchResult?: SynthesizedResearchResult;
  evidenceReport: BrowserEvidenceReport;
  errors: string[];
  securityFlags: string[];
  activeTabId?: string;
  tabs?: BrowserTabContext[];
  comparisonResult?: DocumentComparisonResult;
}

export interface BrowserTaskPlan {
  planId: string;
  goal: string;
  steps: BrowserTaskStep[];
  allowedOrigins: string[];
  timeoutMs: number;
  maxRetries: number;
  estimatedComplexity: "SIMPLE" | "MODERATE" | "COMPLEX";
}

// -----------------------------------------------------------------------------
// Stage 4: Document Comparison & Extraction Models
// -----------------------------------------------------------------------------

export interface ExtractedCodeBlock {
  code: string;
  language?: string;
  contextHeading?: string;
  lineCount: number;
}

export interface DocumentSection {
  id: string;
  heading: string;
  level: number;
  content: string;
  codeBlocks: ExtractedCodeBlock[];
  tables: ExtractedTableData[];
}

export interface StructuredDocument {
  id: string;
  url: string;
  title: string;
  detectedVersion?: string;
  sections: DocumentSection[];
  tables: ExtractedTableData[];
  codeBlocks: ExtractedCodeBlock[];
  headings: string[];
  visibleText: string;
  retrievedAt: number;
  sanitized: boolean;
  injectionDetected: boolean;
  metadata?: Record<string, string>;
}

export interface SectionDifference {
  heading: string;
  changeType: "ADDED" | "REMOVED" | "MODIFIED" | "UNCHANGED";
  baseContent?: string;
  targetContent?: string;
  baseCode?: ExtractedCodeBlock[];
  targetCode?: ExtractedCodeBlock[];
  explanation: string;
  epistemicLabel: "FACT" | "INFERENCE" | "HYPOTHESIS" | "VERIFIED_CONCLUSION";
}

export interface VersionCompatibilityDiff {
  featureOrApi: string;
  baseVersion?: string;
  targetVersion?: string;
  changeType: "ADDED" | "REMOVED" | "DEPRECATED" | "SIGNATURE_CHANGED" | "BEHAVIOR_CHANGED";
  description: string;
  isBreakingChange: boolean;
  epistemicLabel: "FACT" | "INFERENCE" | "HYPOTHESIS" | "VERIFIED_CONCLUSION";
  sourceUrl?: string;
}

export interface ConflictingClaim {
  topic: string;
  docAClaim: string;
  docASource: string;
  docBClaim: string;
  docBSource: string;
  conflictType: "CONTRADICTION" | "INCONSISTENT_BEHAVIOR" | "AMBIGUITY";
  severity: "LOW" | "MEDIUM" | "HIGH";
  epistemicLabel: "FACT" | "INFERENCE" | "HYPOTHESIS";
}

export interface DocumentComparisonCitation {
  sourceUrl: string;
  documentTitle: string;
  sectionHeading?: string;
  excerpt: string;
  timestamp: number;
}

export interface DocumentComparisonResult {
  comparisonId: string;
  baseDocument: {
    id: string;
    url: string;
    title: string;
    version?: string;
  };
  targetDocument: {
    id: string;
    url: string;
    title: string;
    version?: string;
  };
  matchingSections: string[];
  sectionDifferences: SectionDifference[];
  versionCompatibilityDiffs: VersionCompatibilityDiff[];
  conflictingClaims: ConflictingClaim[];
  unresolvedGaps: string[];
  observedFacts: string[];
  inferences: string[];
  hypotheses: string[];
  verifiedConclusions: string[];
  citations: DocumentComparisonCitation[];
  uncertaintyNotes?: string;
  comparedAt: number;
  synthesizedSummary: string;
}

export interface DocumentComparisonRequest {
  documents: Array<{
    url?: string;
    content?: string;
    title?: string;
    version?: string;
  }>;
  focusTopics?: string[];
  compareBy?: "sections" | "apis" | "all";
  contextId?: string;
}
