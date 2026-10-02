/**
 * MYRAA — Intelligence 2.0 Types & Schemas
 *
 * Defines the core types for Context-Aware Decision & Action Engine:
 *   1. Context Priority & Decay
 *   2. Fused Context Schema
 *   3. Situation Understanding & Entity Binding
 *   4. Goal Resolution
 *   5. User Preferences
 *   6. Capability Awareness & Constraints
 *   7. Decision Evaluation & Confidence Scoring
 *   8. Action Planning & Task Continuity
 *   9. Action Verification Contract
 *  10. Sanitized Intelligence Trace
 */

import type { TargetDevice, IntentType, MediaSearchResultItem, ConversationStateType } from "../orchestrator/OrchestratorTypes.ts";
import type { RiskLevel, SecurityContext } from "../security/SecurityTypes.ts";

// ---------------------------------------------------------------------------
// 1. Context Priority & Decay
// ---------------------------------------------------------------------------

export enum ContextPriority {
  EXPLICIT_CURRENT_INSTRUCTION = 100,
  EXPLICIT_USER_INSTRUCTION = 100,
  CURRENT_TASK_CONTEXT = 85,
  CURRENT_APPLICATION_FILE_PROJECT = 70,
  RECENT_CONVERSATION = 55,
  RECENT_SUCCESSFUL_ACTION = 40,
  USER_PREFERENCE = 25,
  LONG_TERM_MEMORY = 10,
}

export type ContextDecayTier = "TRANSIENT" | "TASK_SCOPED" | "SESSION_SCOPED" | "PERSISTENT";

export interface ContextItem<T = unknown> {
  key: string;
  value: T;
  priority: ContextPriority;
  tier: ContextDecayTier;
  createdAt: number;
  expiresAt?: number;
  source: string;
}

// ---------------------------------------------------------------------------
// 2. User Preferences
// ---------------------------------------------------------------------------

export interface UserPreferenceProfile {
  preferredEditor: string;
  preferredWorkspace: string;
  preferredBrowser: string;
  preferredLanguage: string;
  preferredVolume: number;
  autoConfirmLowRisk: boolean;
  activeProjectName?: string;
}

// ---------------------------------------------------------------------------
// 3. Fused Context Schema
// ---------------------------------------------------------------------------

export interface FusedContext {
  contextId: string;
  timestamp: number;
  currentDevice: TargetDevice;
  currentApplication: string | null;
  currentWebsite: string | null;
  currentFile: string | null;
  currentProject: string | null;
  currentWorkspace: string | null;
  currentTask: TaskState | null;
  previousConversation: Array<{
    role: "user" | "model";
    text: string;
    timestamp: number;
  }>;
  recentActions: Array<{
    actionId: string;
    intent: string;
    toolName: string;
    target: string;
    result: unknown;
    timestamp: number;
    ok: boolean;
  }>;
  userPreferences: UserPreferenceProfile;
  availableCapabilities: string[];
  previousToolResults: Record<string, unknown>;
  sessionState: ConversationStateType | string;
  taskHistory: TaskSummary[];
  activeMedia?: {
    title: string;
    videoId?: string;
    status: "playing" | "paused" | "stopped";
    searchResults?: MediaSearchResultItem[];
    selectedResult?: MediaSearchResultItem | null;
  } | null;
}

// ---------------------------------------------------------------------------
// 4. Situation Understanding & Reference Resolution
// ---------------------------------------------------------------------------

export interface SituationUnderstanding {
  domain: "code" | "media" | "web" | "desktop" | "system" | "task" | "general";
  activeEntities: {
    files: string[];
    apps: string[];
    urls: string[];
    queries: string[];
    selectedMedia?: MediaSearchResultItem | null;
    focusedEntity?: string | null;
  };
  implicitReferences: {
    hasDeicticReference: boolean; // "isko", "isme", "ye wala", "that", "this"
    rawPronoun?: string;
    resolvedEntity: string | null;
    resolvedType: "file" | "app" | "media" | "project" | "url" | "action" | "code" | null;
    sourcePriority: ContextPriority;
    confidence: number;
  };
  ambiguityLevel: "NONE" | "LOW" | "MEDIUM" | "HIGH";
  ambiguousCandidates: string[];
  missingContext: string[];
  riskContext: RiskLevel;
}

// ---------------------------------------------------------------------------
// 5. Goal Resolution
// ---------------------------------------------------------------------------

export interface ResolvedGoal {
  goalId: string;
  rawInput: string;
  primaryGoal: string;
  subGoals: string[];
  expectedOutcome: string;
  isImplicit: boolean;
  referenceResolved: boolean;
  targetEntity: string | null;
  targetDevice: TargetDevice;
  confidence: number; // 0.0 - 1.0
  isFollowUp: boolean;
  followUpType?: "test" | "run" | "browse" | "inspect" | "select" | "confirm" | "retry" | null;
}

// ---------------------------------------------------------------------------
// 6. Capability Assessment
// ---------------------------------------------------------------------------

export interface CapabilityAssessment {
  targetDevice: TargetDevice;
  deviceOnline: boolean;
  capabilitySupported: boolean;
  toolName: string;
  requiredRole: string;
  isAuthorized: boolean;
  riskLevel: RiskLevel;
  confirmationRequired: boolean;
  constraints: string[];
}

// ---------------------------------------------------------------------------
// 7. Decision System & Confidence
// ---------------------------------------------------------------------------

export type DecisionConfidenceLevel = "HIGH" | "MEDIUM" | "LOW";

export interface CandidateAction {
  id: string;
  capability: string;
  toolName: string;
  args: Record<string, unknown>;
  targetDevice: TargetDevice;
  score: number; // 0.0 - 1.0
  risk: RiskLevel;
  requiresConfirmation: boolean;
  confirmationPrompt?: string;
  reason: string;
  verificationMethod: string;
}

export interface DecisionEvaluation {
  decisionId: string;
  timestamp: number;
  userInput: string;
  intent: IntentType | string;
  targetDevice: TargetDevice;
  targetEntity: string | null;
  goal: ResolvedGoal;
  contextSnapshot: {
    device: TargetDevice;
    application: string | null;
    file: string | null;
    project: string | null;
    task: string | null;
  };
  availableCapabilities: string[];
  constraints: string[];
  risk: RiskLevel;
  confidence: DecisionConfidenceLevel;
  confidenceScore: number; // 0.0 - 1.0
  candidateActions: CandidateAction[];
  selectedAction: CandidateAction | null;
  reason: string;
  verificationMethod: string;
  requiresClarification: boolean;
  clarificationQuestion?: string;
  clarificationOptions?: string[];
  requiresConfirmation: boolean;
  confirmationPrompt?: string;
  blockedBySecurity?: boolean;
  securityBlockReason?: string;
}

// ---------------------------------------------------------------------------
// 8. Action Planning & Task Continuity
// ---------------------------------------------------------------------------

export interface TaskStep {
  stepIndex: number;
  stepId?: string;
  description: string;
  capability: string;
  toolName: string;
  args: Record<string, unknown>;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  result?: unknown;
  verified?: boolean;
  verificationDetails?: string;
}

export interface TaskState {
  id: string;
  contextId: string;
  goal: string;
  status: "active" | "completed" | "failed" | "paused";
  steps: TaskStep[];
  currentStepIndex: number;
  currentStep: TaskStep | null;
  completedSteps: TaskStep[];
  pendingStep: TaskStep | null;
  relevantEntities: {
    files: string[];
    apps: string[];
    urls: string[];
    project?: string;
    mediaItem?: MediaSearchResultItem | null;
  };
  lastResult: unknown;
  nextExpectedAction: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface TaskSummary {
  taskId: string;
  goal: string;
  status: "active" | "completed" | "failed" | "paused";
  stepsTotal: number;
  stepsCompleted: number;
  lastResultSummary?: string;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// 9. Intelligence Trace (Sanitized Audit Log)
// ---------------------------------------------------------------------------

export interface IntelligenceTraceRecord {
  traceId: string;
  timestamp: number;
  durationMs: number;
  userInput: string;
  intent: string;
  context: {
    device: string;
    app: string | null;
    file: string | null;
    project: string | null;
    taskGoal: string | null;
  };
  goal: {
    primary: string;
    confidence: number;
  };
  candidateActions: Array<{
    tool: string;
    score: number;
    reason: string;
  }>;
  selectedAction: {
    tool: string;
    args: Record<string, unknown>;
    confidence: DecisionConfidenceLevel;
    confidenceScore: number;
  } | null;
  verification: {
    method: string;
    verified: boolean;
    details?: string;
  };
  result: {
    ok: boolean;
    summary: string;
  };
  sanitized: boolean;
}
