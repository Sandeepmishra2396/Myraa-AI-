/**
 * MYRAA — MobileWorkflowTypes (Phase 27)
 *
 * Formal TypeScript contracts for the Mobile Autonomous Workflow Engine.
 * Integrates Phase 5 Agent Planner + Task Execution with mobile capabilities
 * and natural voice interactions.
 */

import type { TaskPlan, PlanStep, PlanStatus, StepStatus, VerificationReport } from "../planner/PlannerTypes.ts";
import type { SecurityContext } from "../security/SecurityTypes.ts";

export type WorkflowLanguage = "hi" | "en" | "hinglish";

export type WorkflowIntentCategory =
  | "schedule_tasks"
  | "project_status"
  | "reminder_alarm"
  | "device_status"
  | "app_action"
  | "research_browser"
  | "custom_workflow";

export interface MobileWorkflowRequest {
  /** High-level natural voice command or query (e.g. "Kal ka schedule check karo aur important tasks batao"). */
  query: string;

  /** Target Android device ID. If omitted, resolved to active companion session. */
  deviceId?: string;

  /**
   * If true, immediately triggers `executePlan` after creation.
   * If false, creates plan and returns it in status "created" for preview.
   * Default: true.
   */
  autoExecute?: boolean;

  /** Preferred language for synthesized voice and text responses. Default: "hinglish". */
  preferredLanguage?: WorkflowLanguage;

  /** Optional client context snapshot (e.g. active app, screen context, location hints). */
  clientContext?: {
    currentApp?: string;
    screenSummary?: string;
    timeZone?: string;
    currentTimeMs?: number;
  };
}

export interface WorkflowStepSnapshot {
  id: string;
  description: string;
  toolName: string;
  phase: string;
  status: StepStatus;
  isDestructive: boolean;
  checkpointRequired: boolean;
  result?: unknown;
  error?: string;
}

export interface WorkflowPendingCheckpoint {
  checkpointId: string;
  action: string;
  impactLevel: "low" | "medium" | "high" | "critical";
  expiresAt: string;
  stepId: string;
  toolName: string;
}

export interface MobileWorkflowResponse {
  success: boolean;
  planId: string;
  goal: string;
  category: WorkflowIntentCategory | string;
  status: PlanStatus;
  steps: WorkflowStepSnapshot[];
  voiceResponse: string;
  textResponse: string;
  requiresConfirmation: boolean;
  pendingCheckpoint?: WorkflowPendingCheckpoint;
  verification?: VerificationReport;
  error?: string;
  errorCode?:
    | "EMERGENCY_STOP_ACTIVE"
    | "SECURITY_LOCKDOWN_ACTIVE"
    | "DEVICE_REVOKED"
    | "INVALID_QUERY"
    | "PLAN_NOT_FOUND"
    | "CHECKPOINT_REJECTED"
    | "SECURITY_VIOLATION"
    | "EXECUTION_ERROR";
}

export interface WorkflowConfirmRequest {
  checkpointId: string;
  approved: boolean;
  userFeedback?: string;
  preferredLanguage?: WorkflowLanguage;
}

export interface ParsedWorkflowIntent {
  category: WorkflowIntentCategory;
  rawQuery: string;
  objective: string;
  isStateAltering: boolean;
  requiresConfirmation: boolean;
  targetEntities: {
    targetDate?: string;
    timeString?: string;
    appName?: string;
    appAction?: string;
    reminderText?: string;
    alarmHour?: number;
    alarmMinute?: number;
    searchQuery?: string;
  };
  expectedOutcomes: Array<{
    description: string;
    verificationHint: string;
  }>;
}
