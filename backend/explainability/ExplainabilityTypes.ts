/**
 * MYRAA — ExplainabilityTypes (Stage 10.7)
 *
 * Central type definitions and contracts for the read-only Explainability system:
 *   - Structured explanations grounded strictly in verified audit, task, and reminder evidence
 *   - Clear distinction between Decision, Reason, Evidence, Interpretation, and Unknown
 *   - Tamper-resistant, secret-scrubbed evidence representation
 *   - Bounded output limits and deterministic ordering
 *
 * Architecture Invariants:
 *   - AI = proposal, Security = decision, Firewall = enforcement, Executor = execution, Verifier = evidence
 *   - Read-only observer: NEVER overrides decisions, modifies audit records, or grants execution authority.
 *   - Untrusted user, project, or memory text is defanged and NEVER elevated to trusted system evidence.
 *   - Exactly 129 unique LIVE_TOOLS declarations preserved without modification.
 */

// ---------------------------------------------------------------------------
// Constants & Bounded Limits
// ---------------------------------------------------------------------------

export const MAX_EXPLANATION_TEXT_LENGTH = 5000;
export const MAX_EXPLANATIONS_RETURNED = 50;
export const MAX_EVIDENCE_PER_EXPLANATION = 20;
export const MAX_REASON_LENGTH = 1000;

// ---------------------------------------------------------------------------
// Category & Status Types
// ---------------------------------------------------------------------------

export type ExplanationCategory =
  | "security_decision"
  | "task_orchestration"
  | "reminder_lifecycle"
  | "correlation";

export type CompletenessStatus = "complete" | "partial" | "unavailable";

export type EvidenceSource =
  | "audit_log"
  | "plan_store"
  | "checkpoint"
  | "reminder_store"
  | "security_policy"
  | "notification_hub"
  | "system_state";

// ---------------------------------------------------------------------------
// Normalized Reason Categories
// ---------------------------------------------------------------------------

export type SecurityReasonCategory =
  | "ALLOWED"
  | "ROLE_PERMISSION_DENIED"
  | "CRITICAL_PATTERN_BLOCKED"
  | "PATH_TRAVERSAL_BLOCKED"
  | "UNTRUSTED_ARGUMENT_BLOCKED"
  | "CONFIRMATION_REQUIRED"
  | "CONFIRMATION_INVALID"
  | "CONFIRMATION_EXPIRED"
  | "CONFIRMATION_REVOKED"
  | "EMERGENCY_STOP_ACTIVE"
  | "SECURITY_LOCKDOWN_ACTIVE"
  | "CONTAINMENT_ACTIVE"
  | "TOOL_DISABLED"
  | "DLP_OUTPUT_REDACTED"
  | "EXECUTION_FAILED"
  | "OUTCOME_UNCERTAIN"
  | "UNKNOWN_DECISION";

export type TaskReasonCategory =
  | "PLAN_CREATED"
  | "PLAN_REJECTED"
  | "STEP_PENDING"
  | "STEP_RUNNING"
  | "STEP_COMPLETED"
  | "STEP_FAILED"
  | "DEPENDENCY_BLOCKED"
  | "AWAITING_APPROVAL"
  | "PLAN_PAUSED"
  | "PLAN_CANCELLED"
  | "CHECKPOINT_CREATED"
  | "CHECKPOINT_REJECTED"
  | "RECOVERY_ACCEPTED"
  | "RECOVERY_BLOCKED"
  | "UNCERTAIN_SIDE_EFFECT"
  | "RECONCILIATION_REQUIRED";

export type ReminderReasonCategory =
  | "PROPOSAL_CREATED"
  | "AWAITING_APPROVAL"
  | "APPROVAL_CAPTURED"
  | "APPROVAL_REVOKED"
  | "APPROVAL_HASH_MISMATCH"
  | "REMINDER_SCHEDULED"
  | "REMINDER_DUE"
  | "NOTIFICATION_DELIVERED"
  | "DELIVERY_FAILED"
  | "DELIVERY_UNKNOWN"
  | "REMINDER_COMPLETED"
  | "REMINDER_CANCELLED";

// ---------------------------------------------------------------------------
// Evidence & Explanation Models
// ---------------------------------------------------------------------------

export interface EvidenceRecord {
  /** Identifier of the evidence record (e.g. audit ID, checkpoint ID, occurrence ID) */
  evidenceId: string;
  /** Originating system source of this evidence */
  source: EvidenceSource;
  /** Associated event type if derived from audit trail */
  eventType?: string;
  /** ISO 8601 timestamp of record generation */
  timestamp: string;
  /** Whether this evidence is cryptographically or durably verified */
  verified: boolean;
  /** Sanitized payload fields relevant to the explanation */
  fields: Record<string, unknown>;
  /** Cryptographic hash if available in source record (e.g. audit ledger hash) */
  hash?: string;
}

export interface RelatedReferences {
  planId?: string;
  stepId?: string;
  checkpointId?: string;
  reminderId?: string;
  occurrenceId?: string;
  projectId?: string;
  toolName?: string;
  deliveryKey?: string;
  auditId?: string;
  sessionId?: string;
  taskPlanId?: string;
}

export interface Explanation {
  /** Unique identifier for this explanation query response */
  explanationId: string;
  /** Primary correlation identifier (audit eventId, planId, reminderId, etc.) */
  correlationId: string;
  /** Timestamp when explanation was generated */
  timestamp: string;
  /** Category of explanation */
  category: ExplanationCategory;
  /** What the system actually decided (e.g. "ALLOW", "BLOCK", "REQUIRE_CONFIRMATION", "DELIVERED") */
  decision: string;
  /** Normalized, safe reason category supporting the decision */
  reasonCategory: string;
  /** Plain-language factual reason recorded for the decision */
  humanReadableReason: string;
  /** Plain-language interpretation of the recorded facts */
  interpretation: string;
  /** Source component responsible for the action or decision */
  sourceComponent: string;
  /** Completeness status of the gathered evidence */
  completenessStatus: CompletenessStatus;
  /** Verified factual records supporting this explanation */
  evidence: EvidenceRecord[];
  /** Related entity references */
  relatedReferences: RelatedReferences;
  /** Safe next steps available to the user (if any exist in approved workflows) */
  safeNextSteps?: string[];
  /** Explicit limitations or caveats regarding the evidence */
  limitations: string[];
  /** Factual elements that could not be established from available records */
  unknowns?: string[];
}

// ---------------------------------------------------------------------------
// Query Interfaces
// ---------------------------------------------------------------------------

export interface SecurityExplanationQuery {
  auditId?: string;
  eventId?: string;
  toolName?: string;
  correlationId?: string;
  limit?: number;
}

export interface TaskExplanationQuery {
  planId: string;
  stepId?: string;
  projectId?: string;
}

export interface ReminderExplanationQuery {
  reminderId: string;
  occurrenceId?: string;
  projectId?: string;
}

export interface CorrelationExplanationQuery {
  correlationId: string;
  projectId?: string;
  limit?: number;
}
