/**
 * MYRAA — Phase 20: Advanced Natural Conversation Engine
 * Conversation Types & Interfaces
 *
 * Defines the structured conversation state model, multi-turn entity continuity,
 * reference resolution tiers, confirmation tracking, and barge-in / interruption contracts.
 */

import type { TaskState } from "../intelligence/IntelligenceTypes.ts";
import type { RiskLevel, SecurityContext } from "../security/SecurityTypes.ts";
import type { DecisionEvaluation } from "../intelligence/IntelligenceTypes.ts";
import type { TargetDevice } from "../orchestrator/OrchestratorTypes.ts";

// ---------------------------------------------------------------------------
// 1. Conversation Entity & Lifecycle
// ---------------------------------------------------------------------------

export type ConversationEntityType =
  | "file"
  | "project"
  | "app"
  | "url"
  | "media"
  | "action"
  | "task"
  | "topic";

export interface ConversationEntity {
  entityId: string;
  entityType: ConversationEntityType;
  name: string;
  path?: string;
  confidence: number; // 0.0 - 1.0
  lastMentionedAt: number;
  turnIndex: number;
  source: "user" | "model" | "system";
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 2. Pending Confirmation Model (Principle: Single-use, bounded TTL, no ghost actions)
// ---------------------------------------------------------------------------

export interface PendingConfirmation {
  confirmationId: string;
  actionId: string;
  capability: string;
  toolName: string;
  targetEntity?: string | null;
  targetDevice: TargetDevice;
  args: Record<string, unknown>;
  summary: string;
  risk: RiskLevel;
  createdAt: number;
  expiresAt: number; // TTL (default: 60,000ms)
  isConfirmed: boolean;
  isCancelled: boolean;
  requiredRole?: string;
}

export interface ConfirmationResult {
  isConfirmed: boolean;
  isCancelled: boolean;
  isPending: boolean;
  matchedPendingAction: PendingConfirmation | null;
  reason: string;
  userUtterance: string;
}

// ---------------------------------------------------------------------------
// 3. Barge-In & Interruption Events
// ---------------------------------------------------------------------------

export type InterruptionCategory =
  | "correction"     // "nahi wo nahi, doosra wala"
  | "cancellation"   // "ruk jao", "cancel karo", "chhodo"
  | "interruption"   // "ruko, pehle git status check karo"
  | "follow_up"      // "aur suno..."
  | "new_intent";    // Completely changing topic

export interface InterruptionEvent {
  interruptionId: string;
  timestamp: number;
  userUtterance: string;
  interruptedModelTurnText?: string;
  interruptionType: InterruptionCategory;
  targetCorrectionEntity?: string | null;
  cancelledAudioBytes: number;
  audioStopped: boolean;
  replanRequired: boolean;
}

// ---------------------------------------------------------------------------
// 4. Conversation Turn Model
// ---------------------------------------------------------------------------

export interface ConversationTurn {
  turnId: string;
  turnIndex: number;
  role: "user" | "model";
  text: string;
  timestamp: number;
  entitiesMentioned: ConversationEntity[];
  detectedIntent?: string | null;
  wasInterrupted?: boolean;
}

// ---------------------------------------------------------------------------
// 5. Follow-Up Resolution Model
// ---------------------------------------------------------------------------

export type FollowUpCategory =
  | "inspect"    // "iska backend check karo", "isko optimize karo"
  | "run"        // "ab isko run karo"
  | "test"       // "ab ispe test run karo"
  | "modify"     // "isme authentication fix karo"
  | "close"      // "ab isko close kar do"
  | "select"     // "haan wahi wala", "second wala"
  | "confirm"    // "haan kar do", "theek hai"
  | "cancel"     // "nahi ruk jao", "cancel"
  | "clarify"    // Answering clarification question
  | "none";

export interface FollowUpResolution {
  isFollowUp: boolean;
  followUpType: FollowUpCategory;
  resolvedTarget: string | null;
  resolvedTargetType: ConversationEntityType | null;
  confidence: number;
  rationale: string;
  requiresClarification: boolean;
}

// ---------------------------------------------------------------------------
// 6. Canonical Conversation State Model
// ---------------------------------------------------------------------------

export interface ConversationState {
  conversationId: string;
  currentTopic: string | null;
  activeEntity: string | null;
  activeProject: string | null;
  activeFile: string | null;
  activeApplication: string | null;
  activeTask: TaskState | null;
  previousIntent: string | null;
  currentIntent: string | null;
  pendingConfirmation: PendingConfirmation | null;
  recentUserReferences: string[];
  recentAssistantActions: string[];
  conversationTimestamp: number;
  confidence: number;
  stateExpiration: number; // TTL (default: 300,000ms = 5 mins)
  isStale: boolean;
}

// ---------------------------------------------------------------------------
// 7. Conversational Reference Resolution Result
// ---------------------------------------------------------------------------

export interface ConversationalReferenceResult {
  rawPronoun: string;
  resolvedEntity: string | null;
  resolvedType: ConversationEntityType | null;
  confidence: number;
  sourceTier:
    | "EXPLICIT_USER_INSTRUCTION"
    | "CURRENT_CONVERSATIONAL_TURN"
    | "ACTIVE_CONVERSATION_ENTITY"
    | "PREVIOUS_TURN_ENTITY"
    | "ACTIVE_TASK"
    | "UNIFIED_MYRAA_CONTEXT"
    | "RECENT_SUCCESSFUL_ACTION"
    | "ADAPTIVE_PERSONAL_BRAIN"
    | "NONE";
  isAmbiguous: boolean;
  candidateAlternatives: string[];
  clarificationPrompt?: string;
  isStale: boolean;
}

// ---------------------------------------------------------------------------
// 8. Natural Conversation Outcome
// ---------------------------------------------------------------------------

export interface NaturalConversationResponse {
  decision: DecisionEvaluation;
  conversationState: ConversationState;
  responseSpeech: string;
  acknowledgement: string;
  pacing: "short" | "medium" | "detailed";
  requiresConfirmation: boolean;
  confirmationPrompt?: string;
  requiresClarification: boolean;
  clarificationQuestion?: string;
  clarificationOptions?: string[];
  interruptionHandled?: boolean;
  interruptionEvent?: InterruptionEvent;
}
