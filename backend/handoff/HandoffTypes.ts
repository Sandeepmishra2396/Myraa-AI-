/**
 * MYRAA — HandoffTypes (Phase 25)
 *
 * Central type definitions for Cross-Device Handoff between Desktop and Android.
 * Enables seamless task, conversation, and workflow resumption while strictly
 * preserving security, DLP, single-use token constraints, and canonical memory invariants.
 */

export type HandoffStatus = "pending" | "accepted" | "resumed" | "cancelled" | "expired";

export interface HandoffDevice {
  deviceId: string;
  deviceType: "desktop" | "android" | "cloud";
  deviceName?: string;
}

export interface HandoffTargetDevice {
  deviceId?: string; // Specific target device ID, or omitted for any authenticated paired device
  deviceType?: "desktop" | "android" | "any";
  deviceName?: string;
}

export interface HandoffConversationContext {
  dialogueHistory?: Array<{ role: string; text: string }>;
  lastUserQuery?: string;
  activeIntent?: string;
  summary?: string;
}

export interface HandoffPendingAction {
  stepId: string;
  toolName: string;
  description: string;
  toolArgs?: Record<string, unknown>;
  isDestructive: boolean;
  checkpointRequired: boolean;
  riskLevel?: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
}

export interface HandoffTaskPlanState {
  planId?: string;
  goal?: string;
  currentStepIndex?: number;
  totalSteps?: number;
  currentStepDescription?: string;
  workflowPhase?: string;
  pendingActions?: HandoffPendingAction[];
  completedStepIds?: string[];
  artifacts?: string[];
  status?: string;
}

export interface HandoffProjectContext {
  projectName?: string;
  workspacePath?: string;
  activeFiles?: string[];
  relevantContextSnippet?: string;
}

export interface HandoffSafeUiContext {
  activeScreen?: string;
  currentView?: string;
  clientMetadata?: Record<string, unknown>;
}

export interface HandoffSnapshot {
  handoffId: string;
  handoffToken: string;
  status: HandoffStatus;
  sourceDevice: HandoffDevice;
  targetDevice?: HandoffTargetDevice;
  conversationContext?: HandoffConversationContext;
  taskPlanState?: HandoffTaskPlanState;
  projectContext?: HandoffProjectContext;
  sharedMemoryRefs?: string[]; // Phase 24 canonical memory IDs only (never duplicated)
  safeUiContext?: HandoffSafeUiContext;
  createdAt: string; // ISO
  expiresAt: string; // ISO
  acceptedAt?: string;
  resumedAt?: string;
  cancelledAt?: string;
  version: number;
}

export interface CreateHandoffRequest {
  targetDevice?: HandoffTargetDevice;
  conversationContext?: HandoffConversationContext;
  taskPlanState?: HandoffTaskPlanState;
  projectContext?: HandoffProjectContext;
  sharedMemoryRefs?: string[];
  safeUiContext?: HandoffSafeUiContext;
  ttlSeconds?: number; // Optional custom TTL (default 600s = 10m, min 60s, max 3600s)
}

export interface AcceptHandoffRequest {
  handoffId: string;
  handoffToken: string;
}

export interface ResumeHandoffRequest {
  handoffId: string;
  handoffToken: string;
  /** Explicit approval if executing safe resumption */
  confirmResume?: boolean;
}

export interface HandoffListFilter {
  status?: HandoffStatus;
  targetDeviceId?: string;
  sourceDeviceId?: string;
}

export interface HandoffOperationResult {
  success: boolean;
  handoff?: HandoffSnapshot;
  error?: string;
  errorCode?:
    | "NOT_FOUND"
    | "UNAUTHORIZED_DEVICE"
    | "INVALID_TOKEN"
    | "ALREADY_ACCEPTED"
    | "ALREADY_RESUMED"
    | "EXPIRED"
    | "CANCELLED"
    | "EMERGENCY_STOP_ACTIVE"
    | "SECURITY_LOCKDOWN_ACTIVE"
    | "DLP_SECRET_REJECTED"
    | "CONFLICT_STALE_STATE"
    | "HIGH_RISK_GATED";
  /** Flag indicating that pending HIGH/CRITICAL actions require operator confirmation */
  requiresConfirmation?: boolean;
  gatedActions?: HandoffPendingAction[];
}
