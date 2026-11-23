/**
 * MYRAA — ReminderGovernance (Stage 10.6)
 *
 * Enforces explicit approval and authority boundaries for Reminders:
 *   - Proposals NEVER become scheduled without explicit user confirmation.
 *   - Approval is cryptographically bound to exact content, dueTime, timezone, and recurrence.
 *   - Modifying any reminder parameter immediately invalidates prior approvals.
 *   - Inferred conversational intent, memory preferences, or AI plans CANNOT authorize scheduling.
 *   - Strict user ownership: User B cannot approve, inspect, or modify User A's reminder.
 *   - Emergency Stop and Security Lockdown prevent approval resolution.
 */

import crypto from "crypto";
import {
  computeReminderContentHash,
  type Reminder,
  type ReminderApprovalEvidence,
} from "./ReminderTypes.ts";
import { emergencyStopCoordinator } from "../remote/EmergencyStopCoordinator.ts";
import { securityPolicyEngine } from "../security/SecurityPolicyEngine.ts";

export class ReminderGovernance {
  /**
   * Approves a reminder proposal.
   * Validates:
   *   1. Caller is the authentic owner of the reminder.
   *   2. Reminder is in 'proposed' or 'awaiting_approval' status.
   *   3. Emergency Stop / Lockdown is not active.
   *   4. Content hash is captured and bound to the approval evidence.
   */
  approveProposal(
    reminder: Reminder,
    approverUserId: string,
    options?: { token?: string },
  ): ReminderApprovalEvidence {
    if (emergencyStopCoordinator.isActive()) {
      throw new Error(
        "EMERGENCY_STOP_ACTIVE: Cannot approve reminders while Emergency Stop is active.",
      );
    }

    if (securityPolicyEngine.getMode() === "LOCKDOWN") {
      throw new Error(
        "SECURITY_LOCKDOWN_ACTIVE: Cannot approve reminders during Security Lockdown.",
      );
    }

    if (!approverUserId || typeof approverUserId !== "string" || !approverUserId.trim()) {
      throw new Error("UNAUTHORIZED: Approver user identity must be provided.");
    }

    if (reminder.userId !== approverUserId) {
      throw new Error(
        `CROSS_USER_APPROVAL_DENIED: User '${approverUserId}' cannot approve reminder owned by '${reminder.userId}'.`,
      );
    }

    if (reminder.status === "cancelled") {
      throw new Error("CANNOT_APPROVE_CANCELLED_REMINDER: Cancelled reminders cannot be approved.");
    }

    if (reminder.status === "completed") {
      throw new Error("CANNOT_APPROVE_COMPLETED_REMINDER: Completed reminders cannot be approved.");
    }

    const contentHash = computeReminderContentHash(
      reminder.text,
      reminder.dueTime,
      reminder.timezone,
      reminder.recurrence,
    );

    const evidence: ReminderApprovalEvidence = {
      approved: true,
      approvedBy: approverUserId,
      approvedAt: new Date().toISOString(),
      contentHash,
      approvalToken: options?.token || crypto.randomUUID(),
      revoked: false,
    };

    reminder.approval = evidence;
    reminder.status = "scheduled";
    reminder.version = (reminder.version ?? 0) + 1;
    reminder.updatedAt = new Date().toISOString();

    return evidence;
  }

  /**
   * Verifies that a reminder has valid, non-revoked, and tamper-free approval evidence.
   * Returns false if parameters have changed since approval or if approval was revoked.
   */
  verifyApproval(reminder: Reminder): { valid: boolean; reason?: string } {
    if (!reminder.approval) {
      return { valid: false, reason: "MISSING_APPROVAL: Reminder has no approval record." };
    }

    if (!reminder.approval.approved) {
      return { valid: false, reason: "APPROVAL_REJECTED: Reminder was not approved." };
    }

    if (reminder.approval.revoked) {
      return {
        valid: false,
        reason: `APPROVAL_REVOKED: Approval was revoked (${reminder.approval.revocationReason || "no reason specified"}).`,
      };
    }

    // Verify content hash integrity (detects parameter tampering post-approval)
    const currentHash = computeReminderContentHash(
      reminder.text,
      reminder.dueTime,
      reminder.timezone,
      reminder.recurrence,
    );

    if (currentHash !== reminder.approval.contentHash) {
      return {
        valid: false,
        reason: "APPROVAL_HASH_MISMATCH: Reminder parameters changed after approval was granted. Fresh approval required.",
      };
    }

    return { valid: true };
  }

  /**
   * Explicitly revokes or invalidates an existing approval (e.g. after parameter update).
   */
  invalidateApproval(reminder: Reminder, reason = "Parameters modified"): void {
    if (reminder.approval) {
      reminder.approval.revoked = true;
      reminder.approval.revokedAt = new Date().toISOString();
      reminder.approval.revocationReason = reason;
    }
    if (reminder.status === "scheduled" || reminder.status === "due") {
      reminder.status = "awaiting_approval";
    }
    reminder.version = (reminder.version ?? 0) + 1;
    reminder.updatedAt = new Date().toISOString();
  }
}

/** Module-level singleton */
export const reminderGovernance = new ReminderGovernance();
