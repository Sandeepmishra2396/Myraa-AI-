/**
 * MYRAA — MultimodalTypes (Phase 8)
 *
 * Core type definitions for Advanced Multimodal Intelligence:
 *   - Active window inspection, window categories, focus transition history
 *   - Screen snapshots, perceptual frame hashes, continuous vision state
 *   - Multi-tier OCR results, token categorization, secret sanitization
 *   - Semantic visual UI state (IDE, terminal, browser, dialogs)
 *   - Code screenshot analysis, error diagnostics, red squiggle detection
 *   - Document understanding (PDF stream extractor, markdown, diagrams)
 *   - Unified Multimodal Context Fusion snapshot
 *   - Context-aware proactive suggestions with Phase 5 confirmation gates
 *   - Security, privacy shielding, and rate-limiting bounds
 */

// ---------------------------------------------------------------------------
// Window Perception Contracts
// ---------------------------------------------------------------------------

export type WindowCategory =
  | "code_editor"
  | "terminal"
  | "browser"
  | "chat"
  | "sensitive"
  | "system"
  | "unknown";

export interface WindowBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ActiveWindowInfo {
  title: string;
  processName: string;
  processId?: number;
  bounds?: WindowBounds;
  isMaximized?: boolean;
  isUncertain: boolean;         // Set to true if detection failed or is ambiguous (fails closed)
  category: WindowCategory;
  timestamp: number;
}

export interface WindowHistoryEntry {
  window: ActiveWindowInfo;
  startedAt: number;
  endedAt: number;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Screen Snapshot & Continuous Vision
// ---------------------------------------------------------------------------

export interface ScreenSnapshot {
  base64: string;               // In-memory only base64 JPEG
  mimeType: string;             // "image/jpeg"
  width: number;
  height: number;
  hash: string;                 // Perceptual 16x16 luminance grid hash for change detection
  timestamp: number;
  activeWindow?: ActiveWindowInfo;
  isRedacted?: boolean;
  ocrResult?: StructuredOcrResult;
}

export interface ContinuousScreenConfig {
  enabled: boolean;             // Disabled by default
  intervalMs: number;           // Clamped between MIN_SCREEN_INTERVAL_MS and MAX_SCREEN_INTERVAL_MS
  privacyShieldEnabled: boolean;// Automatically pause when sensitive window active
  perceptualDiffThreshold: number; // Delta threshold to consider screen changed
  maxRetainedSnapshots: number; // Max in-memory snapshot buffer size (default 3)
}

// ---------------------------------------------------------------------------
// OCR & Text Extraction Contracts
// ---------------------------------------------------------------------------

export type OcrSegmentCategory =
  | "code"
  | "error"
  | "url"
  | "command"
  | "ui_label"
  | "text";

export interface OcrTextSegment {
  category: OcrSegmentCategory;
  text: string;
  line?: number;
  confidence?: number;
}

export interface StructuredOcrResult {
  fullText: string;
  sanitizedText: string;        // Sensitive tokens/secrets redacted
  segments: OcrTextSegment[];
  codeBlocks: string[];
  errorLines: string[];
  urls: string[];
  commands: string[];
  secretsRedactedCount: number;
  isUntrusted: boolean;         // Always true for external visual content
}

// ---------------------------------------------------------------------------
// Visual UI & Code Understanding
// ---------------------------------------------------------------------------

export type VisualUICategory =
  | "ide"
  | "terminal"
  | "browser"
  | "dialog"
  | "system"
  | "unknown";

export interface VisualUIState {
  category: VisualUICategory;
  activeFile?: string;
  terminalPrompt?: string;
  lastTerminalCommand?: string;
  hasErrorToast?: boolean;
  detectedModals: string[];
  confidence: number;
  summary: string;
}

export interface VisualCodeAnalysis {
  language: string;
  code: string;
  lineNumbers?: string;
  errors: string[];
  redSquiggleCount: number;
  suggestedFix?: string;
  theme?: "dark" | "light";
  isUntrusted: boolean;
}

// ---------------------------------------------------------------------------
// Document Understanding
// ---------------------------------------------------------------------------

export type DocumentType = "pdf" | "markdown" | "code" | "diagram" | "unknown";

export interface DocumentAnalysisResult {
  filePath: string;
  fileType: DocumentType;
  title: string;
  headings: string[];
  outline: string[];
  codeBlocks: string[];
  tables: string[];
  actionItems: string[];
  characterCount: number;
  pageCount?: number;
  isUntrusted: boolean;
  fencedContent?: string;
  injectionScan?: {
    hasInjectionAttempt: boolean;
    score: number;
    matchedPatterns: string[];
  };
}

// ---------------------------------------------------------------------------
// Fused Multimodal Context Snapshot
// ---------------------------------------------------------------------------

export interface MultimodalContextSnapshot {
  activeWindow: ActiveWindowInfo;
  windowHistory: WindowHistoryEntry[];
  screenSummary: string;
  ocrSummary?: string;
  visualUIState?: VisualUIState;
  visibleCode?: VisualCodeAnalysis;
  projectContext?: {
    projectName: string;
    rootDir: string;
    gitBranch?: string;
    modifiedFilesCount?: number;
  };
  voiceContext?: {
    lastUserUtterance?: string;
    lastModelResponse?: string;
  };
  privacyShieldTriggered: boolean;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Context-Aware Suggestions Contracts
// ---------------------------------------------------------------------------

export type SuggestionCategory =
  | "code_fix"
  | "git_workflow"
  | "test_runner"
  | "build"
  | "doc_lookup"
  | "general";

export interface ContextSuggestion {
  id: string;
  title: string;
  description: string;
  category: SuggestionCategory;
  actionTool?: string;
  actionArgs?: Record<string, unknown>;
  isModifying: boolean;         // If true, MUST route through Phase 5 confirmation checkpoint
  confidence: number;           // 0.0 - 1.0
  reason: string;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Configuration & Boundary Constants
// ---------------------------------------------------------------------------

export const DEFAULT_SCREEN_INTERVAL_MS = 2000;       // 2 seconds default capture interval
export const MIN_SCREEN_INTERVAL_MS = 1000;           // 1 second minimum interval floor
export const MAX_SCREEN_INTERVAL_MS = 10000;          // 10 seconds maximum
export const PERCEPTUAL_DIFF_THRESHOLD = 0.03;        // 3% pixel delta considered changed
export const MAX_RETAINED_SNAPSHOTS = 3;              // Keep only last 3 frames in volatile memory
export const MAX_DOC_BYTES = 25 * 1024 * 1024;        // 25 MB max document file size
export const MAX_DECOMPRESSED_BYTES = 5 * 1024 * 1024;// 5 MB max decompression bomb limit
export const MAX_OCR_TEXT_CHARS = 20000;              // 20,000 max OCR characters processed
export const MAX_GEMINI_VISION_DIM = 960;             // Downscale dimension for Gemini vision

/** List of process names and title fragments treated as strictly sensitive (fails closed) */
export const SENSITIVE_APP_PATTERNS = [
  /\b1password\b/i,
  /\bbitwarden\b/i,
  /\bkeepass\b/i,
  /\blastpass\b/i,
  /\bdashlane\b/i,
  /\bauthy\b/i,
  /\bcredential\b/i,
  /\bincognito\b/i,
  /\bprivate browsing\b/i,
  /\binprivate\b/i,
  /\bbanking\b/i,
  /\bnetbanking\b/i,
  /\bwallet\b/i,
  /\bmetamask\b/i,
  /\bkeychain\b/i,
];
