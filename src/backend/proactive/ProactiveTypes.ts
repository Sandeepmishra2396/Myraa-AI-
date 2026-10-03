/**
 * MYRAA — Phase 21: Predictive / Proactive Engine
 * ProactiveTypes
 *
 * Core type system for predictive signal detection, proactive event tracking,
 * confidence scoring, deduplication, cooldowns, and the strict safety lifecycle:
 *   OBSERVE → ANALYZE → PREPARE → ASK → EXECUTE → VERIFY
 */

import type { RiskLevel } from "../security/SecurityTypes.ts";
import type { TargetDevice } from "../orchestrator/OrchestratorTypes.ts";

// ---------------------------------------------------------------------------
// 1. Proactive Event & Status Types
// ---------------------------------------------------------------------------

export type ProactiveEventType =
  | "BUILD_FAILED"
  | "TEST_FAILED"
  | "TYPE_ERROR"
  | "RUNTIME_ERROR"
  | "TASK_STALLED"
  | "REPEATED_FAILURE"
  | "PROJECT_WARNING"
  | "WORKFLOW_PATTERN"
  | "GOAL_BLOCKED"
  | "SAFE_SUGGESTION";

export type ProactiveStatus =
  | "DETECTED"
  | "ANALYZING"
  | "PREPARED"
  | "AWAITING_APPROVAL"
  | "APPROVED"
  | "EXECUTING"
  | "VERIFIED"
  | "DISMISSED"
  | "SNOOZED"
  | "EXPIRED"
  | "BLOCKED"
  | "FAILED";

export type ProactiveConfidence = "HIGH" | "MEDIUM" | "LOW";

// ---------------------------------------------------------------------------
// 2. Evidence, Analysis & Action Models
// ---------------------------------------------------------------------------

export interface ProactiveEvidence {
  source:
    | "terminal"
    | "compiler"
    | "test_runner"
    | "runtime"
    | "task_monitor"
    | "git"
    | "system"
    | "conversation";
  rawOutput: string;
  exitCode?: number;
  filePath?: string;
  lineNumber?: number;
  columnNumber?: number;
  errorCode?: string;
  errorSignature?: string;
  command?: string;
  capturedAt: number;
}

export interface ProactiveAnalysis {
  summary: string;
  rootCause: string;
  likelyFix: string;
  affectedComponents: string[];
  naturalHindiExplanation: string;
  naturalEnglishExplanation: string;
  corroboratingSignalsCount: number;
}

export interface ProactiveSuggestedAction {
  id: string;
  capability: string;
  toolName: string;
  args: Record<string, unknown>;
  summary: string;
  isStateChanging: boolean;
  autonomyLevel: 0 | 1 | 2 | 3 | 4 | 5;
  riskLevel: RiskLevel;
  targetDevice: TargetDevice;
}

export interface ProactiveProvenance {
  sourceChannel: string;
  capturedAt: number;
  sanitizedHash: string;
  detectorVersion: string;
}

export interface ProactiveExecutionResult {
  success: boolean;
  output: string;
  verified: boolean;
  timestamp: number;
  error?: string;
  verificationEvidence?: string;
}

// ---------------------------------------------------------------------------
// 3. Proactive Event State Model
// ---------------------------------------------------------------------------

export interface ProactiveEvent {
  eventId: string;
  eventType: ProactiveEventType;
  timestamp: number;
  project: string | null;
  file: string | null;
  task: string | null;
  evidence: ProactiveEvidence[];
  analysis: ProactiveAnalysis;
  confidence: ProactiveConfidence;
  confidenceScore: number; // 0.0 - 1.0
  riskLevel: RiskLevel;
  suggestedAction: ProactiveSuggestedAction | null;
  approvalRequired: boolean;
  status: ProactiveStatus;
  expiresAt: number;
  deduplicationKey: string;
  provenance: ProactiveProvenance;
  repeatCount: number;
  promptQuestion?: string;
  executionResult?: ProactiveExecutionResult;
}

// ---------------------------------------------------------------------------
// 4. Raw Signal Input Model
// ---------------------------------------------------------------------------

export interface RawProactiveSignal {
  source: ProactiveEvidence["source"];
  rawText: string;
  command?: string;
  exitCode?: number;
  project?: string;
  file?: string;
  task?: string;
  timestamp?: number;
  contextId?: string;
}

// ---------------------------------------------------------------------------
// 5. Resolution & Response Models
// ---------------------------------------------------------------------------

export interface ProactiveResolutionResult {
  resolved: boolean;
  event: ProactiveEvent | null;
  actionTaken: "APPROVED_AND_EXECUTED" | "DISMISSED" | "SNOOZED" | "BLOCKED" | "NO_ACTION";
  responseSpeech: string;
  reason: string;
  verificationResult?: ProactiveExecutionResult;
}

// ---------------------------------------------------------------------------
// 6. Invariant Constants
// ---------------------------------------------------------------------------

export const DEFAULT_PROACTIVE_TTL_MS = 300_000; // 5 minutes
export const DEFAULT_COOLDOWN_MS = 60_000; // 1 minute between repeat alerts
export const REPEATED_FAILURE_THRESHOLD = 2; // >=2 occurrences triggers REPEATED_FAILURE
export const LOW_CONFIDENCE_THRESHOLD = 0.6; // < 0.6 is LOW confidence
export const HIGH_CONFIDENCE_THRESHOLD = 0.9; // >= 0.9 is HIGH confidence
