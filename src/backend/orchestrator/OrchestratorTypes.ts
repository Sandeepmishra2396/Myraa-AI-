/**
 * MYRAA — Intent & Capability Orchestrator Types
 *
 * Defines canonical models for:
 *   1. Structured Intent Resolution (CanonicalIntent)
 *   2. Conversation Action & Execution Context (ExecutionContext / ActionContext)
 *   3. Capability Registry & Authorization Metadata (CapabilityMetadata)
 *   4. Deterministic YouTube & Media Semantics (MediaSearchResultItem, ActiveMediaState)
 *   5. Action Result Verification (ActionVerificationResult)
 *   6. Multi-Step Desktop Code Workflow & Execution Plans (OrchestratedExecutionPlan)
 */

import type { DeviceRole } from "../remote/RemoteTypes.ts";
import type { RiskLevel } from "../security/SecurityTypes.ts";

// ---------------------------------------------------------------------------
// 1. Target Device & Intent Types
// ---------------------------------------------------------------------------

export type TargetDevice =
  | "PHONE"
  | "DESKTOP"
  | "BROWSER"
  | "REMOTE_DESKTOP";

export type IntentType =
  | "OPEN_APPLICATION"
  | "CLOSE_APPLICATION"
  | "OPEN_FILE"
  | "OPEN_FOLDER"
  | "SEARCH_MEDIA"
  | "PLAY_MEDIA"
  | "PAUSE_MEDIA"
  | "RESUME_MEDIA"
  | "STOP_MEDIA"
  | "NEXT_MEDIA"
  | "PREVIOUS_MEDIA"
  | "OPEN_WEBSITE"
  | "WEB_SEARCH"
  | "INSPECT_CODE"
  | "VERIFY_CODE"
  | "WEB_RESEARCH"
  | "COMPARE_IMPLEMENTATION"
  | "PROPOSE_IMPROVEMENT"
  | "MODIFY_FILE"
  | "RUN_TESTS"
  | "VERIFY_RESULT"
  | "GENERAL_TOOL";

export type ConversationStateType =
  | "IDLE"
  | "AWAITING_SELECTION"
  | "MEDIA_SEARCHED"
  | "MEDIA_PLAYING"
  | "MEDIA_PAUSED"
  | "APPLICATION_OPEN"
  | "FILE_OPEN"
  | "CODE_WORKFLOW_IN_PROGRESS"
  | "AWAITING_CONFIRMATION";

export interface ConversationStateSnapshot {
  state: ConversationStateType;
  activeApplication: string | null;
  activeWebsite: string | null;
  activeSearchQuery: string | null;
  hasSearchResults: boolean;
  selectedResultTitle: string | null;
  activeFile: string | null;
  hasPendingConfirmation: boolean;
}

/**
 * Canonical Intent Model produced before any tool or capability is executed.
 */
export interface CanonicalIntent {
  intent: IntentType;
  targetDevice: TargetDevice;
  capability: string;
  entity: string | null;
  arguments: Record<string, unknown>;
  contextId: string;
  conversationState: ConversationStateSnapshot;
  requiresConfirmation: boolean;
}

// ---------------------------------------------------------------------------
// 2. YouTube & Media Action Context Models
// ---------------------------------------------------------------------------

export interface MediaSearchResultItem {
  index: number;
  videoId: string;
  title: string;
  url: string;
  author?: string;
  duration?: string;
  thumbnail?: string;
}

export interface ActiveMediaState {
  videoId: string;
  title: string;
  url: string;
  status: "playing" | "paused" | "stopped";
  index: number;
  source: "youtube" | "browser" | "desktop";
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// 3. Pending Action & Conversation ExecutionContext
// ---------------------------------------------------------------------------

export interface PendingActionState {
  actionId: string;
  intent: IntentType;
  capability: string;
  toolName: string;
  arguments: Record<string, unknown>;
  targetDevice: TargetDevice;
  riskLevel: RiskLevel;
  reason: string;
  proposedChanges?: {
    filePath?: string;
    summary?: string;
    diffPreview?: string;
  };
  createdAt: string;
}

/**
 * Canonical ActionContext / ExecutionContext maintained per session/conversation.
 */
export interface ExecutionContext {
  contextId: string;
  currentDevice: TargetDevice;
  currentApplication: string | null;
  currentWebsite: string | null;
  currentSearchQuery: string | null;
  searchResults: MediaSearchResultItem[];
  selectedResult: MediaSearchResultItem | null;
  currentMedia: ActiveMediaState | null;
  currentFile: string | null;
  currentProject: string | null;
  currentWorkspace: string | null;
  currentTask: string | null;
  lastSuccessfulTool: string | null;
  lastToolResult: unknown;
  pendingAction: PendingActionState | null;
  conversationState: ConversationStateType;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// 4. Capability Registry & Authorization Metadata
// ---------------------------------------------------------------------------

export interface CapabilityMetadata {
  capability: string;
  toolNames: string[];
  target: TargetDevice;
  supportedTargets: TargetDevice[];
  riskLevel: RiskLevel;
  permissionRequired: DeviceRole;
  confirmationRequired: boolean;
  verifier: string;
}

export interface CapabilityAuthorizationDecision {
  authorized: boolean;
  capability: string;
  toolName: string;
  targetDevice: TargetDevice;
  riskLevel: RiskLevel;
  permissionRequired: DeviceRole;
  confirmationRequired: boolean;
  /** True ONLY when SecurityPolicyEngine / RBAC / Firewall explicitly denied permission. */
  isPermissionDenied: boolean;
  /** True when target device (e.g. DESKTOP or PHONE) is not connected/available. */
  isDeviceUnavailable: boolean;
  errorCode?:
    | "SECURITY_POLICY_DENIED"
    | "PERMISSION_DENIED"
    | "TARGET_DEVICE_UNAVAILABLE"
    | "CONFIRMATION_REQUIRED"
    | "UNRECOGNIZED_APPLICATION"
    | "INVALID_ARGUMENTS";
  reason?: string;
}

// ---------------------------------------------------------------------------
// 5. Action Result Verification Models
// ---------------------------------------------------------------------------

export interface ActionVerificationResult {
  verified: boolean;
  capability: string;
  targetDevice: TargetDevice;
  details: Record<string, unknown>;
  failureReason?: string;
  failureCode?: string;
}

export interface OpenApplicationVerification {
  launched: boolean;
  appName: string;
  pid: number | null;
  verified: boolean;
  targetDevice: TargetDevice;
  capability: "desktop.openApplication";
  path?: string;
  failureReason?: string;
}

export interface OpenFileVerification {
  opened: boolean;
  filePath: string;
  editor: string;
  verified: boolean;
  targetDevice: TargetDevice;
  capability: "desktop.openFile";
  failureReason?: string;
}

export interface YouTubeSearchVerification {
  query: string;
  resultCount: number;
  topResults: MediaSearchResultItem[];
  selectedResult: MediaSearchResultItem | null;
  verified: boolean;
  targetDevice: TargetDevice;
  capability: "youtube.search";
  failureReason?: string;
}

export interface YouTubePlayVerification {
  playing: boolean;
  paused?: boolean;
  stopped?: boolean;
  title: string;
  videoIdOrUrl: string;
  action: "play" | "pause" | "resume" | "stop" | "next" | "previous";
  verified: boolean;
  targetDevice: TargetDevice;
  capability: string;
  failureReason?: string;
}

export interface BrowserOpenUrlVerification {
  opened: boolean;
  url: string;
  verified: boolean;
  targetDevice: TargetDevice;
  capability: "browser.openUrl";
  failureReason?: string;
}

// ---------------------------------------------------------------------------
// 6. Multi-Step ExecutionPlan & Desktop Code Workflow Models
// ---------------------------------------------------------------------------

export type CodeWorkflowStage =
  | "OPEN_AND_VERIFY"
  | "CODE_INSPECTION"
  | "WEB_DOCS_RESEARCH"
  | "COMPARISON_AND_RECOMMENDATION"
  | "CONFIRMATION_BEFORE_MODIFICATION"
  | "APPLY_AND_VERIFY";

export interface CodeInspectionDiagnostic {
  line?: number;
  severity: "info" | "warning" | "error";
  category: "syntax" | "type" | "security" | "performance" | "maintainability";
  message: string;
}

export interface CodeInspectionReport {
  filePath: string;
  exists: boolean;
  language: string;
  lineCount: number;
  imports: string[];
  functionsAndClasses: string[];
  diagnostics: CodeInspectionDiagnostic[];
  summary: string;
}

export interface CodeComparisonReport {
  filePath: string;
  currentImplementation: string;
  issuesOrLimitations: string[];
  recommendedImprovement: string;
  whyItIsBetter: string[];
  filesAndLinesAffected: string[];
  riskLevel: RiskLevel;
  requiresConfirmation: boolean;
  researchQuery: string;
  researchCitations: Array<{ title: string; url: string }>;
  /** Strictly fenced with <<<UNTRUSTED_WEB_DATA>>> via ContentSanitizer */
  fencedExternalResearch: string;
}

export interface OrchestratedPlanStep {
  stepId: string;
  stage?: CodeWorkflowStage;
  intent: IntentType;
  capability: string;
  toolName: string;
  targetDevice: TargetDevice;
  inputArguments: Record<string, unknown>;
  expectedOutput: string;
  requiresConfirmation: boolean;
  status: "pending" | "in_progress" | "awaiting_confirmation" | "completed" | "failed" | "blocked";
  securityCheck?: {
    allowed: boolean;
    riskLevel: RiskLevel;
    reason?: string;
  };
  verificationCheck?: ActionVerificationResult;
  output?: unknown;
  error?: string;
}

export interface OrchestratedExecutionPlan {
  planId: string;
  contextId: string;
  rawRequest: string;
  status: "created" | "in_progress" | "awaiting_confirmation" | "completed" | "failed" | "blocked";
  steps: OrchestratedPlanStep[];
  inspectionReport?: CodeInspectionReport;
  comparisonReport?: CodeComparisonReport;
  createdAt: string;
  updatedAt: string;
}
