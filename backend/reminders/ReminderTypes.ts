/**
 * MYRAA — ReminderTypes (Stage 10.6)
 *
 * Central type definitions for Reminders:
 *   - Explicit user approval and governance
 *   - Durable persistence and restart recovery
 *   - Correct IANA timezone and recurrence tracking
 *   - Safe notification delivery through existing infrastructure
 *   - User and optional project isolation
 *
 * Architecture Invariants:
 *   - AI = proposal, Security = decision, Firewall = enforcement, Executor = execution, Verifier = evidence
 *   - Reminders are user notifications ONLY. They NEVER execute tools, trigger tasks, or resume plans.
 *   - External content, memories, and project texts are untrusted and cannot approve reminders.
 */

import crypto from "crypto";

// ---------------------------------------------------------------------------
// Constants & Bounded Limits
// ---------------------------------------------------------------------------

export const MAX_REMINDER_TEXT_LENGTH = 1000;
export const MAX_RECURRENCE_OCCURRENCES = 365;
export const MAX_FUTURE_HORIZON_DAYS = 365;
export const MAX_SNOOZE_COUNT = 5;
export const DEFAULT_SNOOZE_MINUTES = 15;
export const MAX_USER_ACTIVE_REMINDERS = 100;
export const DEFAULT_CLAIM_LEASE_MS = 30_000;
export const MAX_DELIVERY_ATTEMPTS = 3;
export const DEFAULT_RETRY_BACKOFF_MS = 5_000;

// ---------------------------------------------------------------------------
// Status & Lifecycle Types
// ---------------------------------------------------------------------------

export type ReminderStatus =
  | "proposed"           // Initial draft/proposal, not yet approved
  | "awaiting_approval"  // Prepared and awaiting explicit user approval
  | "scheduled"          // Approved and registered in scheduler
  | "due"                // Due instant reached, ready for delivery claim
  | "delivered"          // Dispatched to user notification system
  | "completed"          // Acknowledged or completed by user
  | "cancelled"          // Cancelled by user (terminal)
  | "failed"             // Delivery or scheduling failed
  | "delivery_unknown";  // Delivery outcome uncertain / provider unconfirmed

export type OccurrenceStatus =
  | "scheduled"
  | "due"
  | "claimed"
  | "delivered"
  | "retryable_failure"
  | "failed"
  | "delivery_unknown"
  | "skipped";

export type RecurrenceFrequency = "daily" | "weekly" | "monthly" | "custom_interval";

export interface RecurrenceRule {
  frequency: RecurrenceFrequency;
  interval?: number; // e.g. every 2 days, every 3 weeks
  daysOfWeek?: number[]; // 0=Sunday, 1=Monday, ..., 6=Saturday
  endDate?: string; // ISO 8601 UTC timestamp
  maxOccurrences?: number;
}

export interface ReminderApprovalEvidence {
  approved: boolean;
  approvedBy: string; // Authenticated userId / identityId
  approvedAt: string; // ISO 8601 timestamp
  contentHash: string; // SHA-256 of (text + dueTime + timezone + recurrence)
  approvalToken?: string;
  revoked?: boolean;
  revokedAt?: string;
  revocationReason?: string;
}

export interface ReminderOccurrence {
  occurrenceId: string; // Stable identifier: `${reminderId}:${index}:${dueInstant}`
  reminderId: string;
  occurrenceIndex: number;
  scheduledTime: string; // ISO 8601 UTC
  status: OccurrenceStatus;
  claimedBy?: string;
  claimedAt?: string;
  claimLeaseExpiresAt?: string; // ISO 8601 UTC
  deliveryAttempts?: number;
  maxDeliveryAttempts?: number;
  lastAttemptAt?: string;
  nextRetryAt?: string;
  deliveredAt?: string;
  deliveryKey: string; // Idempotency key for atomic dispatch
  error?: string;
}

export interface Reminder {
  id: string; // UUID
  userId: string; // Owning user identityId
  projectId?: string; // Optional canonical project ID (Stage 10.3)
  text: string; // Reminder content
  dueTime: string; // Target due time (ISO 8601 UTC)
  timezone: string; // IANA timezone identifier (e.g. "Asia/Kolkata", "America/New_York", "UTC")
  recurrence?: RecurrenceRule;
  status: ReminderStatus;
  version: number; // Monotonically increasing version
  createdAt: string;
  updatedAt: string;
  approval?: ReminderApprovalEvidence;
  taskPlanId?: string; // Informational reference to task plan (never grants execution authority)
  snoozeCount: number;
  maxSnoozeCount: number;
  lastDeliveredAt?: string;
  currentOccurrenceId?: string;
  occurrences: ReminderOccurrence[];
  auditCorrelationId: string;
}

export interface ReminderProposalInput {
  text: string;
  dueTime: string; // ISO 8601 date string
  timezone?: string; // IANA timezone
  recurrence?: RecurrenceRule;
  projectId?: string;
  taskPlanId?: string;
}

export interface DeliveryResult {
  success: boolean;
  deliveryKey: string;
  status: "delivered" | "failed" | "delivery_unknown" | "retryable_failure";
  timestamp: string;
  notificationId?: string;
  error?: string;
  retryable?: boolean;
  retryAfterMs?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Computes a deterministic SHA-256 hash of reminder content and scheduling parameters.
 * Any modification to text, dueTime, timezone, or recurrence changes this hash,
 * immediately invalidating prior approvals.
 */
export function computeReminderContentHash(
  text: string,
  dueTime: string,
  timezone: string,
  recurrence?: RecurrenceRule,
): string {
  const normText = text.trim();
  const normDueTime = new Date(dueTime).toISOString();
  const normTimezone = timezone.trim();
  const normRecurrence = recurrence
    ? JSON.stringify(recurrence, Object.keys(recurrence).sort())
    : "none";

  const payload = `${normText}|${normDueTime}|${normTimezone}|${normRecurrence}`;
  return crypto.createHash("sha256").update(payload).digest("hex");
}

/**
 * Validates allowable state transitions for the reminder lifecycle state machine.
 */
export function validateReminderTransition(
  current: ReminderStatus,
  target: ReminderStatus,
): { allowed: boolean; reason?: string } {
  if (current === target) return { allowed: true };

  const validTransitions: Record<ReminderStatus, ReadonlySet<ReminderStatus>> = {
    proposed: new Set(["awaiting_approval", "cancelled"]),
    awaiting_approval: new Set(["scheduled", "cancelled", "proposed"]),
    scheduled: new Set(["due", "cancelled", "awaiting_approval", "failed"]),
    due: new Set(["delivered", "failed", "delivery_unknown", "cancelled", "scheduled"]), // scheduled on retry backoff
    delivered: new Set(["completed", "scheduled", "cancelled"]), // scheduled if snoozed or recurring next occurrence
    delivery_unknown: new Set(["delivered", "failed", "completed", "cancelled", "scheduled"]),
    completed: new Set([]), // Terminal
    cancelled: new Set([]), // Strictly terminal
    failed: new Set(["awaiting_approval", "cancelled", "scheduled"]), // can be rescheduled upon correction
  };

  const allowedSet = validTransitions[current] || new Set();
  if (!allowedSet.has(target)) {
    return {
      allowed: false,
      reason: `INVALID_REMINDER_TRANSITION: Cannot transition reminder from '${current}' to '${target}'.`,
    };
  }

  return { allowed: true };
}

/**
 * Validates allowable state transitions for individual reminder occurrences.
 */
export function validateOccurrenceTransition(
  current: OccurrenceStatus,
  target: OccurrenceStatus,
): { allowed: boolean; reason?: string } {
  if (current === target) return { allowed: true };

  const validTransitions: Record<OccurrenceStatus, ReadonlySet<OccurrenceStatus>> = {
    scheduled: new Set(["due", "skipped", "failed"]),
    due: new Set(["claimed", "skipped", "failed"]),
    claimed: new Set(["delivered", "retryable_failure", "failed", "delivery_unknown", "due"]), // due if lease expired and recovered
    retryable_failure: new Set(["due", "claimed", "failed", "skipped"]),
    delivered: new Set([]), // Terminal
    failed: new Set(["due"]), // Can be retried upon manual correction/intervention
    delivery_unknown: new Set(["delivered", "failed", "due"]),
    skipped: new Set([]), // Terminal
  };

  const allowedSet = validTransitions[current] || new Set();
  if (!allowedSet.has(target)) {
    return {
      allowed: false,
      reason: `INVALID_OCCURRENCE_TRANSITION: Cannot transition occurrence from '${current}' to '${target}'.`,
    };
  }

  return { allowed: true };
}
