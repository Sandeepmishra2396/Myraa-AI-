/**
 * MYRAA — ReminderDeliveryManager (Stage 10.6)
 *
 * Dispatches due reminder notifications strictly through the approved existing
 * notification infrastructure (NotificationManager):
 *   - Never executes reminder text as a command, script, tool, or task.
 *   - Content is sanitized against secrets and prompt injection before dispatch.
 *   - Idempotency keys prevent duplicate concurrent delivery of the same occurrence.
 *   - Emergency Stop and Security Lockdown halt delivery immediately.
 *   - Handles delivered, failed, and delivery_unknown states safely without blind retries.
 */

import { notificationManager } from "../companion/NotificationManager.ts";
import { emergencyStopCoordinator } from "../remote/EmergencyStopCoordinator.ts";
import { securityPolicyEngine } from "../security/SecurityPolicyEngine.ts";
import { sanitizeVoiceText } from "../companion/NotificationManager.ts";
import {
  DEFAULT_RETRY_BACKOFF_MS,
  MAX_DELIVERY_ATTEMPTS,
  type Reminder,
  type ReminderOccurrence,
  type DeliveryResult,
} from "./ReminderTypes.ts";

export class ReminderDeliveryManager {
  private _claimedDeliveryKeys = new Set<string>();

  /**
   * Dispatches a user-facing notification for a due reminder occurrence.
   */
  async deliverOccurrence(
    reminder: Reminder,
    occurrence?: ReminderOccurrence,
  ): Promise<DeliveryResult> {
    const targetOcc: ReminderOccurrence = occurrence || reminder.occurrences[0] || {
      occurrenceId: `${reminder.id}:1:${Date.now()}`,
      reminderId: reminder.id,
      occurrenceIndex: 1,
      scheduledTime: reminder.dueTime,
      status: "due" as const,
      deliveryKey: `delivery_${reminder.id}_default`,
    };

    const deliveryKey = targetOcc.deliveryKey || `delivery_${reminder.id}_${targetOcc.occurrenceId}`;

    // ── 1. Stop Condition Checks ───────────────────────────────────────────
    if (emergencyStopCoordinator.isActive()) {
      return {
        success: false,
        deliveryKey,
        status: "failed",
        retryable: false,
        timestamp: new Date().toISOString(),
        error: "EMERGENCY_STOP_ACTIVE: Reminder delivery suppressed due to active Emergency Stop.",
      };
    }

    if (securityPolicyEngine.getMode() === "LOCKDOWN") {
      return {
        success: false,
        deliveryKey,
        status: "failed",
        retryable: false,
        timestamp: new Date().toISOString(),
        error: "SECURITY_LOCKDOWN_ACTIVE: Reminder delivery suppressed during Security Lockdown.",
      };
    }

    // ── 2. Duplicate Delivery Prevention ───────────────────────────────────
    if (targetOcc.status === "delivered") {
      return {
        success: true,
        deliveryKey,
        status: "delivered",
        timestamp: targetOcc.deliveredAt || new Date().toISOString(),
      };
    }

    if (this._claimedDeliveryKeys.has(deliveryKey)) {
      return {
        success: false,
        deliveryKey,
        status: "failed",
        retryable: false,
        timestamp: new Date().toISOString(),
        error: `DUPLICATE_DELIVERY_PREVENTED: Occurrence '${targetOcc.occurrenceId}' is already in-flight.`,
      };
    }

    this._claimedDeliveryKeys.add(deliveryKey);

    try {
      // ── 3. Sanitize Notification Content ──────────────────────────────────
      const rawText = reminder.text;
      const sanitizedMessage = sanitizeVoiceText(rawText);
      const title = `Reminder: ${sanitizedMessage.slice(0, 60)}${sanitizedMessage.length > 60 ? "…" : ""}`;

      // ── 4. Dispatch through Existing Notification Infrastructure ──────────
      // Uses notificationManager.notify() — purely user-facing visual/voice alert
      const item = await notificationManager.notify({
        title,
        message: sanitizedMessage,
        level: "info",
        source: "companion",
        dedupKey: deliveryKey,
        voiceText: `Reminder: ${sanitizedMessage}`,
        metadata: {
          reminderId: reminder.id,
          occurrenceId: targetOcc.occurrenceId,
          projectId: reminder.projectId,
          taskPlanId: reminder.taskPlanId,
          deliveryKey,
        },
      });

      if (!item) {
        // NotificationManager returned null (e.g. suppressed or deduplicated)
        // If suppressed by deduplication or unconfirmed provider state -> delivery_unknown
        targetOcc.status = "delivery_unknown";
        return {
          success: false,
          deliveryKey,
          status: "delivery_unknown",
          retryable: false,
          timestamp: new Date().toISOString(),
          error: "DELIVERY_UNCERTAIN: Notification hub returned unconfirmed delivery result.",
        };
      }

      // ── 5. Successful Delivery Recording ──────────────────────────────────
      const nowIso = new Date().toISOString();
      targetOcc.status = "delivered";
      targetOcc.deliveredAt = nowIso;
      reminder.lastDeliveredAt = nowIso;

      return {
        success: true,
        deliveryKey,
        status: "delivered",
        timestamp: nowIso,
        notificationId: item.id,
      };
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      const isRetryable =
        Boolean(err?.isRetryable) ||
        errMsg.includes("TEMPORARY") ||
        errMsg.includes("BUSY") ||
        errMsg.includes("TIMEOUT") ||
        errMsg.includes("RATE_LIMIT") ||
        errMsg.includes("TRANSIENT") ||
        errMsg.includes("ECONNREFUSED") ||
        errMsg.includes("ETIMEDOUT");

      const attempts = targetOcc.deliveryAttempts ?? 1;
      const maxAttempts = targetOcc.maxDeliveryAttempts ?? MAX_DELIVERY_ATTEMPTS;

      if (isRetryable && attempts < maxAttempts) {
        const backoffMs = DEFAULT_RETRY_BACKOFF_MS * Math.pow(2, attempts - 1);
        targetOcc.status = "retryable_failure";
        targetOcc.error = errMsg;
        return {
          success: false,
          deliveryKey,
          status: "retryable_failure",
          retryable: true,
          retryAfterMs: backoffMs,
          timestamp: new Date().toISOString(),
          error: `TEMPORARY_DELIVERY_FAILURE: ${errMsg}`,
        };
      }

      targetOcc.status = "failed";
      targetOcc.error = errMsg;
      return {
        success: false,
        deliveryKey,
        status: "failed",
        retryable: false,
        timestamp: new Date().toISOString(),
        error: `DELIVERY_FAILED: ${errMsg}`,
      };
    } finally {
      this._claimedDeliveryKeys.delete(deliveryKey);
    }
  }

  /**
   * Reset in-memory delivery claim cache (for test cleanup).
   */
  clearClaimsForTesting(): void {
    this._claimedDeliveryKeys.clear();
  }
}

/** Module-level singleton */
export const reminderDeliveryManager = new ReminderDeliveryManager();
