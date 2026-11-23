/**
 * MYRAA — ReminderScheduler (Stage 10.6)
 *
 * Reliable reminder scheduling & persistent recovery:
 *   - Reconstructs active schedules on application startup from ReminderStore.
 *   - Handles overdue/missed reminders explicitly without silent time shifting.
 *   - Stable occurrence identity and duplicate dispatch protection.
 *   - Accurate recurrence advancement preserving local wall-clock time across DST.
 *   - Periodic tick loop + precision timers for prompt due-time delivery.
 */

import {
  reminderStore,
  type ReminderStore,
} from "./ReminderStore.ts";
import {
  reminderGovernance,
  type ReminderGovernance,
} from "./ReminderGovernance.ts";
import {
  reminderDeliveryManager,
  type ReminderDeliveryManager,
} from "./ReminderDeliveryManager.ts";
import {
  computeNextOccurrence,
  isValidIanaTimezone,
} from "./TimezoneUtil.ts";
import {
  DEFAULT_CLAIM_LEASE_MS,
  type Reminder,
  type ReminderOccurrence,
  type DeliveryResult,
} from "./ReminderTypes.ts";
import { runtimeMetrics } from "../diagnostics/RuntimeObservability.ts";

/** Maximum timer delay in Node.js (~24.8 days in ms) */
const MAX_TIMEOUT_MS = 2_147_483_647;

export class ReminderScheduler {
  private _store: ReminderStore;
  private _governance: ReminderGovernance;
  private _delivery: ReminderDeliveryManager;
  private _timers = new Map<string, NodeJS.Timeout>();
  private _isRunning = false;
  private _tickInterval: NodeJS.Timeout | null = null;
  private _workerId: string;

  constructor(
    store: ReminderStore = reminderStore,
    governance: ReminderGovernance = reminderGovernance,
    delivery: ReminderDeliveryManager = reminderDeliveryManager,
    workerId?: string,
  ) {
    this._store = store;
    this._governance = governance;
    this._delivery = delivery;
    this._workerId = workerId || `worker_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  }

  getWorkerId(): string {
    return this._workerId;
  }

  setWorkerId(workerId: string): void {
    this._workerId = workerId;
  }

  /**
   * Starts the scheduler and reconstructs schedules from persistent storage.
   */
  async start(tickIntervalMs = 15_000): Promise<void> {
    if (this._isRunning) return;
    this._isRunning = true;

    // 1. Recover interrupted claims and reconstruct all active reminders from disk
    await this.recoverAndScheduleAll();

    // 2. Start background heartbeat to detect due reminders and missed occurrences
    this._tickInterval = setInterval(() => {
      this.tick().catch((err) => {
        console.error("[ReminderScheduler] Tick error:", err);
      });
    }, tickIntervalMs);
  }

  /**
   * Stops the scheduler and clears all active timers.
   */
  stop(): void {
    this._isRunning = false;
    if (this._tickInterval) {
      clearInterval(this._tickInterval);
      this._tickInterval = null;
    }
    for (const timer of this._timers.values()) {
      clearTimeout(timer);
    }
    this._timers.clear();
  }

  /**
   * Reconstructs all scheduled/due reminders on startup or process recovery.
   * Also recovers any interrupted delivery claims from previous crashed workers.
   */
  async recoverAndScheduleAll(): Promise<number> {
    // 1. Recover interrupted claims first
    await this._store.recoverInterruptedClaims(this._workerId);

    // 2. Reconstruct active schedules
    const active = await this._store.listAllActiveReminders();
    let scheduledCount = 0;

    for (const reminder of active) {
      try {
        const scheduled = await this.scheduleReminder(reminder);
        if (scheduled) scheduledCount++;
      } catch (err) {
        console.error(`[ReminderScheduler] Error scheduling reminder '${reminder.id}':`, err);
      }
    }

    return scheduledCount;
  }

  /**
   * Schedules a single approved reminder for due-time execution.
   */
  async scheduleReminder(reminder: Reminder): Promise<boolean> {
    // Verify approval integrity before scheduling
    const check = this._governance.verifyApproval(reminder);
    if (!check.valid) {
      console.warn(`[ReminderScheduler] Cannot schedule reminder '${reminder.id}': ${check.reason}`);
      this._governance.invalidateApproval(reminder, check.reason);
      await this._store.saveReminder(reminder);
      return false;
    }

    // Cancel existing timer if present
    this.cancelTimer(reminder.id);

    const now = Date.now();
    const dueMs = new Date(reminder.dueTime).getTime();
    const delayMs = dueMs - now;

    // Ensure initial occurrence exists
    if (!reminder.currentOccurrenceId || reminder.occurrences.length === 0) {
      const occurrenceIndex = reminder.occurrences.length + 1;
      const occurrenceId = `${reminder.id}:${occurrenceIndex}:${dueMs}`;
      const occurrence: ReminderOccurrence = {
        occurrenceId,
        reminderId: reminder.id,
        occurrenceIndex,
        scheduledTime: reminder.dueTime,
        status: delayMs <= 0 ? "due" : "scheduled",
        deliveryKey: `delivery_${reminder.id}_${occurrenceId}`,
      };
      reminder.currentOccurrenceId = occurrenceId;
      reminder.occurrences.push(occurrence);
      await this._store.saveReminder(reminder);
    }

    if (delayMs <= 0) {
      // Overdue or due immediately -> process and claim
      runtimeMetrics.incrementCounter("reminder_scheduled_total");
      await this.processDueReminder(reminder.id);
      return true;
    }

    // Set precision timer (bounded by max 32-bit int)
    const boundedDelay = Math.min(delayMs, MAX_TIMEOUT_MS);
    const timer = setTimeout(() => {
      this.processDueReminder(reminder.id).catch((e) =>
        console.error(`[ReminderScheduler] Timer execution error for ${reminder.id}:`, e),
      );
    }, boundedDelay);

    this._timers.set(reminder.id, timer);
    runtimeMetrics.incrementCounter("reminder_scheduled_total");
    return true;
  }

  /**
   * Cancels in-memory timer for a reminder.
   */
  cancelTimer(reminderId: string): void {
    const existing = this._timers.get(reminderId);
    if (existing) {
      clearTimeout(existing);
      this._timers.delete(reminderId);
    }
  }

  /**
   * Processes a due reminder occurrence:
   *   1. Atomically claims the occurrence with a persistent lease to prevent duplicate delivery.
   *   2. Dispatches notification through ReminderDeliveryManager.
   *   3. Atomically commits the delivery outcome to disk.
   *   4. Advances recurrence if recurring and delivery succeeded.
   */
  async processDueReminder(
    reminderId: string,
    targetOccurrenceId?: string,
  ): Promise<DeliveryResult | null> {
    this.cancelTimer(reminderId);

    const reminder = await this._store.getReminder(reminderId);
    if (!reminder) return null;

    if (reminder.status === "cancelled" || reminder.status === "completed") {
      return null;
    }

    // Verify approval
    const check = this._governance.verifyApproval(reminder);
    if (!check.valid) {
      this._governance.invalidateApproval(reminder, check.reason);
      await this._store.saveReminder(reminder);
      return null;
    }

    // Locate active occurrence
    let occurrence = targetOccurrenceId
      ? reminder.occurrences.find((o) => o.occurrenceId === targetOccurrenceId)
      : reminder.occurrences.find((o) => o.occurrenceId === reminder.currentOccurrenceId);

    if (!occurrence) {
      // Find earliest non-terminal occurrence
      occurrence = reminder.occurrences.find(
        (o) =>
          o.status === "due" ||
          o.status === "scheduled" ||
          o.status === "retryable_failure",
      );
    }

    if (!occurrence) {
      const occurrenceIndex = reminder.occurrences.length + 1;
      const occurrenceId = `${reminder.id}:${occurrenceIndex}:${Date.now()}`;
      occurrence = {
        occurrenceId,
        reminderId: reminder.id,
        occurrenceIndex,
        scheduledTime: reminder.dueTime,
        status: "due",
        deliveryKey: `delivery_${reminder.id}_${occurrenceId}`,
      };
      reminder.currentOccurrenceId = occurrenceId;
      reminder.occurrences.push(occurrence);
      await this._store.saveReminder(reminder);
    }

    // ── ATOMIC PERSISTENT CLAIM ───────────────────────────────────────────
    const claimResult = await this._store.claimOccurrenceAtomic(
      reminder.id,
      occurrence.occurrenceId,
      this._workerId,
      DEFAULT_CLAIM_LEASE_MS,
    );

    if (!claimResult.claimed) {
      // Occurrence is already claimed by another active worker or already delivered
      return null;
    }

    runtimeMetrics.incrementCounter("reminder_claimed_total");
    const claimedReminder = claimResult.reminder!;
    const claimedOccurrence = claimResult.occurrence!;

    // ── DISPATCH NOTIFICATION ─────────────────────────────────────────────
    const result = await this._delivery.deliverOccurrence(
      claimedReminder,
      claimedOccurrence,
    );

    if (result.status === "delivered") {
      runtimeMetrics.incrementCounter("reminder_delivered_total");
    } else {
      runtimeMetrics.incrementCounter("reminder_delivery_failed_total");
    }

    // ── COMMIT OUTCOME ATOMICALLY ─────────────────────────────────────────
    const updatedReminder = await this._store.commitDeliveryOutcomeAtomic(
      reminder.id,
      claimedOccurrence.occurrenceId,
      result,
    );

    // ── RECURRENCE ADVANCEMENT ───────────────────────────────────────────
    if (result.status === "delivered" && updatedReminder.recurrence) {
      const nextDueTime = computeNextOccurrence(
        updatedReminder.dueTime,
        updatedReminder.timezone,
        updatedReminder.recurrence,
      );

      if (nextDueTime) {
        updatedReminder.dueTime = nextDueTime;
        updatedReminder.status = "scheduled";
        updatedReminder.snoozeCount = 0; // reset snooze on new recurrence occurrence

        const nextIndex = updatedReminder.occurrences.length + 1;
        const nextOccId = `${updatedReminder.id}:${nextIndex}:${new Date(nextDueTime).getTime()}`;
        const nextOcc: ReminderOccurrence = {
          occurrenceId: nextOccId,
          reminderId: updatedReminder.id,
          occurrenceIndex: nextIndex,
          scheduledTime: nextDueTime,
          status: "scheduled",
          deliveryKey: `delivery_${updatedReminder.id}_${nextOccId}`,
        };
        updatedReminder.currentOccurrenceId = nextOccId;
        updatedReminder.occurrences.push(nextOcc);

        // Re-schedule next occurrence timer
        await this._store.saveReminder(updatedReminder);
        await this.scheduleReminder(updatedReminder);
        return result;
      } else {
        // Recurrence rule ended or exhausted
        updatedReminder.status = "completed";
        await this._store.saveReminder(updatedReminder);
      }
    }

    return result;
  }

  /**
   * Heartbeat tick to scan for and dispatch any overdue or ready reminders,
   * including retryable failures whose backoff window has elapsed.
   */
  async tick(): Promise<void> {
    const active = await this._store.listAllActiveReminders();
    const now = Date.now();

    for (const r of active) {
      if (r.status === "cancelled" || r.status === "completed" || r.status === "failed") continue;

      // Check if there is an occurrence in retryable_failure
      const retryableOcc = r.occurrences.find((o) => o.status === "retryable_failure");
      if (retryableOcc) {
        // Only retry if the backoff window has elapsed
        if (retryableOcc.nextRetryAt && new Date(retryableOcc.nextRetryAt).getTime() <= now) {
          await this.processDueReminder(r.id, retryableOcc.occurrenceId);
        }
        // Do not fall through to regular due check while waiting on backoff
        continue;
      }

      // Check for due or scheduled occurrences whose dueTime has arrived
      const dueMs = new Date(r.dueTime).getTime();
      if (dueMs <= now && r.status !== "delivered") {
        await this.processDueReminder(r.id);
      }
    }
  }
}

/** Module-level singleton */
export const reminderScheduler = new ReminderScheduler();
