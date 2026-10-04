/**
 * MYRAA — PlannerTypes (Phase 5)
 *
 * Central type definitions for the Agent Planner + Task Execution engine.
 * All other Phase 5 modules import from here — no circular dependencies.
 *
 * Security notes:
 *   • Checkpoint tokens are one-time, cryptographically random, and bound to
 *     a specific (stepId + toolName + serializedArgs) triple at creation.
 *   • Tokens become `consumed = true` immediately on first use — replay is rejected.
 *   • Modifying step arguments after approval is rejected (hash mismatch).
 *   • Plans persist with status `waiting_for_approval` across restarts; they do NOT
 *     automatically resume modifying/destructive steps on restart.
 *   • Retry is only allowed for safe/idempotent steps (isDestructive = false).
 */

// ---------------------------------------------------------------------------
// Goal
// ---------------------------------------------------------------------------

export type GoalCategory =
  | "documentation"   // README, comments, JSDoc, wiki updates
  | "bugfix"          // patch a defect, resolve an error
  | "refactor"        // restructure or clean code
  | "feature"         // add new capability
  | "research"        // investigate and report findings
  | "exploration"     // analyse codebase / architecture
  | "build"           // compile, package, bundle
  | "testing"         // write or run tests
  | "workflow"        // autonomous mobile / cross-device workflow
  | "general";        // anything else

export interface GoalScope {
  /** Target file paths (relative to workspace). May be empty. */
  targetFiles: string[];
  /** Specific code symbols or modules mentioned. */
  symbols: string[];
  /** Maximum number of files the plan is permitted to modify. */
  maxModifiableFiles: number;
}

export interface GoalExpectedOutcome {
  description: string;
  /** How to verify this outcome after execution. */
  verificationHint: string;
}

export interface Goal {
  id: string;
  /** Raw user utterance. */
  rawInput: string;
  /** Parsed high-level objective. */
  objective: string;
  category: GoalCategory;
  scope: GoalScope;
  expectedOutcomes: GoalExpectedOutcome[];
  /** True if the goal inherently involves modifying files or running scripts. */
  requiresModification: boolean;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Step phases and status
// ---------------------------------------------------------------------------

export type StepPhase =
  | "understand"          // Parse goal + load project context
  | "inspect"             // Scan workspace, read files, check git
  | "plan"                // Finalise step list with concrete args
  | "checkpoint"          // Pause for user confirmation
  | "modify"              // Write / create / delete files, run code
  | "test"                // Run tests or lint commands
  | "verify"              // Check outcomes against expected criteria
  | "report";             // Summarise and present final results

/**
 * Authoritative set of modifying/destructive tools across the entire platform.
 * Any invocation of these tools MUST pass both the planner safety gate and
 * the final dispatch-layer safety gate. Direct invocation without an approved
 * checkpoint is prohibited.
 */
export const MODIFYING_TOOLS: ReadonlySet<string> = new Set([
  // File operations
  "createFile",
  "deleteFile",
  "renameFile",
  "moveFile",
  "createProjectFolder",
  // Code & script execution
  "writeCodeFile",
  "createPythonFile",
  "runPythonScript",
  // System side-effects
  "executePowerAction",
  "enableAutoStart",
  "disableAutoStart",
  // Mobile state-altering / modifying capabilities (Phase 27)
  "createReminder",
  "setAlarm",
  "setTimer",
  "notifications",
]);

export type StepStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "skipped"
  | "waiting_for_approval";   // Halted at checkpoint — must NOT auto-resume

// ---------------------------------------------------------------------------
// PlanStep
// ---------------------------------------------------------------------------

export interface PlanStep {
  id: string;
  phase: StepPhase;
  status: StepStatus;

  /** Human-readable description (shown in checkpoint confirmations and reports). */
  description: string;

  /** Tool to call, e.g. "readFile", "writeCodeFile", "runPythonScript". */
  toolName: string;

  /**
   * Arguments to pass verbatim to the tool.
   * Serialised + hashed at checkpoint creation; rejected if modified before approval.
   */
  toolArgs: Record<string, unknown>;

  /**
   * SHA-256 hex digest of JSON.stringify(toolArgs) captured at plan-creation time.
   * Used by CheckpointManager to detect argument tampering before approval.
   */
  argsHash: string;

  /** IDs of steps that must complete before this step may run. */
  dependsOn: string[];

  /**
   * True if the operation is file-modifying, destructive, or has observable
   * side-effects (e.g. create/overwrite/delete file, run script, git commit,
   * database write, system action, package install).
   * Retry is forbidden for destructive steps — requires a fresh checkpoint.
   */
  isDestructive: boolean;

  /** Whether this step needs a user confirmation checkpoint before execution. */
  checkpointRequired: boolean;

  /** ID of the associated Checkpoint record (set when checkpoint is issued). */
  checkpointId?: string;

  /** Retry metadata — populated only for safe/idempotent (non-destructive) steps. */
  retryCount: number;
  maxRetries: number;

  /** Execution result, populated after completion or failure. */
  result?: StepExecutionResult;

  startedAt?: string;
  completedAt?: string;
}

// ---------------------------------------------------------------------------
// Checkpoint (one-time, non-replayable confirmation token)
// ---------------------------------------------------------------------------

export type ImpactLevel = "low" | "medium" | "high" | "critical";

export interface Checkpoint {
  /** Cryptographically random UUID. One-time use. */
  id: string;

  /** The plan this checkpoint belongs to. */
  planId: string;

  /** The step that must not proceed without approval. */
  stepId: string;

  /** Snapshot of toolName exactly as in the step at creation time. */
  toolName: string;

  /**
   * Snapshot of serialised args at creation time.
   * Must match toolArgs at execution time (tamper detection).
   */
  argsSnapshot: string;

  /** SHA-256 of argsSnapshot. Verified before execution. */
  argsHash: string;

  /** Human-readable summary of the proposed change. */
  proposedAction: string;

  impactLevel: ImpactLevel;

  /**
   * Status of this checkpoint.
   * - `pending`  → awaiting user response.
   * - `approved` → user approved; token may be used exactly once.
   * - `rejected` → user declined; step is skipped or plan is aborted.
   * - `consumed` → approval was already used; replay is rejected.
   * - `expired`  → token TTL exceeded without a response.
   */
  status: "pending" | "approved" | "rejected" | "consumed" | "expired";

  /** ISO timestamp after which the token expires regardless of status. */
  expiresAt: string;

  /** Optional feedback/instruction from user when approving or rejecting. */
  userFeedback?: string;

  createdAt: string;
  resolvedAt?: string;
}

// ---------------------------------------------------------------------------
// Execution result and evaluation
// ---------------------------------------------------------------------------

export type EvaluationStatus =
  | "success"
  | "partial"
  | "retryable_failure"   // transient — e.g. network timeout, busy agent
  | "critical_failure";   // deterministic — permission denied, syntax error, etc.

export type SuggestedAction = "proceed" | "retry" | "fallback" | "abort";

export interface ResultEvaluation {
  status: EvaluationStatus;
  /** 0–1 confidence that the step achieved its objective. */
  score: number;
  reason: string;
  suggestedAction: SuggestedAction;
  /** Alternative tool to try on fallback. */
  fallbackTool?: string;
}

export interface StepExecutionResult {
  /** Raw output from the tool. */
  output: unknown;
  elapsedMs: number;
  error?: string;
  evaluation: ResultEvaluation;
}

// ---------------------------------------------------------------------------
// Retry policy
// ---------------------------------------------------------------------------

export interface RetryPolicy {
  initialDelayMs: number;
  backoffMultiplier: number;
  maxDelayMs: number;
  maxRetries: number;
  timeoutMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  initialDelayMs: 500,
  backoffMultiplier: 2,
  maxDelayMs: 8_000,
  maxRetries: 3,
  timeoutMs: 30_000,
};

// ---------------------------------------------------------------------------
// Verification report
// ---------------------------------------------------------------------------

export interface OutcomeCriteria {
  description: string;
  verificationHint: string;
  satisfied: boolean;
  evidence?: string;
}

export interface VerificationReport {
  planId: string;
  goal: string;
  criteria: OutcomeCriteria[];
  /** 0–1 overall satisfaction ratio. */
  score: number;
  verified: boolean;
  summary: string;
  generatedAt: string;
  /** Explicit verification scope — clarifies whether only workspace outcomes were checked. */
  scope?: "workspace_outcomes_only" | "full_verification";
  verificationMethod?: string;
  checkResults?: {
    filesChecked: number;
    artifactsChecked: number;
    testsVerified?: boolean;
    buildVerified?: boolean;
  };
}

// ---------------------------------------------------------------------------
// TaskPlan — the full persisted state of a plan
// ---------------------------------------------------------------------------

export type PlanStatus =
  | "created"              // plan created, not yet started
  | "running"              // actively executing steps
  | "waiting_for_approval" // paused at checkpoint — must NOT auto-resume on restart
  | "paused"               // manually paused by user or system
  | "completed"            // all steps done and verification passed
  | "failed"               // irrecoverable failure
  | "cancelled";           // user or system cancelled

export interface ExecutionLogEntry {
  timestamp: string;
  stepId: string;
  phase: StepPhase;
  message: string;
  level: "info" | "warn" | "error";
}

export interface TaskPlan {
  id: string;
  goal: Goal;
  status: PlanStatus;
  steps: PlanStep[];

  /** Currently executing or last-executed step ID. */
  activeStepId?: string;

  /** Pending checkpoint ID (if status is waiting_for_approval). */
  pendingCheckpointId?: string;

  executionLog: ExecutionLogEntry[];

  /** Paths of files created or modified during execution. */
  artifacts: string[];

  /** Populated after the verify phase. */
  verificationReport?: VerificationReport;

  /** Target Android device ID (if workflow/mobile targeted). */
  deviceId?: string;

  /** Preferred language for voice synthesis (hi, en, hinglish). */
  preferredLanguage?: string;

  /** Synthesized natural language voice response for mobile companion. */
  voiceResponse?: string;

  /** Synthesized natural language text response for display. */
  textResponse?: string;

  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
}
