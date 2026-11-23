/**
 * MYRAA — ReminderService (Stage 10.6)
 *
 * User-facing coordinator & business logic facade for Reminders:
 *   - Propose, approve, update, snooze, complete, cancel, and query reminders.
 *   - Strictly enforces user identity ownership & cross-user isolation.
 *   - Strictly enforces canonical project isolation (Stage 10.3).
 *   - Task plan follow-ups are strictly informational (NO task or tool execution authority).
 *   - Model suggestions remain proposals until explicit user approval.
 */

import crypto from "crypto";
import {
  reminderStore,
  type ReminderStore,
} from "./ReminderStore.ts";
import {
  reminderGovernance,
  type ReminderGovernance,
} from "./ReminderGovernance.ts";
import {
  reminderScheduler,
  type ReminderScheduler,
} from "./ReminderScheduler.ts";
import {
  isValidIanaTimezone,
  isValidDateString,
} from "./TimezoneUtil.ts";
import {
  MAX_REMINDER_TEXT_LENGTH,
  MAX_SNOOZE_COUNT,
  DEFAULT_SNOOZE_MINUTES,
  MAX_USER_ACTIVE_REMINDERS,
  validateReminderTransition,
  computeReminderContentHash,
  type Reminder,
  type ReminderProposalInput,
  type ReminderStatus,
} from "./ReminderTypes.ts";

export class ReminderService {
  private _store: ReminderStore;
  private _governance: ReminderGovernance;
  private _scheduler: ReminderScheduler;

  constructor(
    store: ReminderStore = reminderStore,
    governance: ReminderGovernance = reminderGovernance,
    scheduler: ReminderScheduler = reminderScheduler,
  ) {
    this._store = store;
    this._governance = governance;
    this._scheduler = scheduler;
  }

  /**
   * Proposes a new reminder. Starts in 'proposed' / 'awaiting_approval' status.
   * NEVER scheduled without explicit user approval.
   */
  async proposeReminder(
    userId: string,
    input: ReminderProposalInput,
  ): Promise<Reminder> {
    if (!userId || typeof userId !== "string" || !userId.trim()) {
      throw new Error("UNAUTHORIZED: Valid user identity required to propose a reminder.");
    }

    if (!input.text || typeof input.text !== "string" || !input.text.trim()) {
      throw new Error("INVALID_ARGUMENT: Reminder text cannot be empty.");
    }

    if (input.text.trim().length > MAX_REMINDER_TEXT_LENGTH) {
      throw new Error(
        `INVALID_ARGUMENT: Reminder text exceeds maximum length of ${MAX_REMINDER_TEXT_LENGTH} characters.`,
      );
    }

    if (!isValidDateString(input.dueTime)) {
      throw new Error("INVALID_ARGUMENT: Valid ISO 8601 dueTime date string is required.");
    }

    const timezone = (input.timezone || "UTC").trim();
    if (!isValidIanaTimezone(timezone)) {
      throw new Error(`INVALID_TIMEZONE: '${timezone}' is not a recognized IANA timezone identifier.`);
    }

    // Check bounded limit of active reminders per user
    const active = await this._store.listRemindersForUser(userId, { status: "scheduled" });
    if (active.length >= MAX_USER_ACTIVE_REMINDERS) {
      throw new Error(
        `CAPACITY_LIMIT_EXCEEDED: User has reached the maximum of ${MAX_USER_ACTIVE_REMINDERS} active scheduled reminders.`,
      );
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const dueTimeIso = new Date(input.dueTime).toISOString();

    const reminder: Reminder = {
      id,
      userId: userId.trim(),
      projectId: input.projectId?.trim() || undefined,
      text: input.text.trim(),
      dueTime: dueTimeIso,
      timezone,
      recurrence: input.recurrence,
      status: "proposed",
      version: 1,
      createdAt: now,
      updatedAt: now,
      taskPlanId: input.taskPlanId?.trim() || undefined,
      snoozeCount: 0,
      maxSnoozeCount: MAX_SNOOZE_COUNT,
      occurrences: [],
      auditCorrelationId: crypto.randomUUID(),
    };

    await this._store.saveReminder(reminder);
    return reminder;
  }

  /**
   * Approves a reminder proposal and registers it with the scheduler.
   * Enforces that User A cannot approve User B's reminder.
   */
  async approveAndSchedule(
    userId: string,
    reminderId: string,
    options?: { token?: string },
  ): Promise<Reminder> {
    const reminder = await this._store.getReminder(reminderId);
    if (!reminder) {
      throw new Error(`REMINDER_NOT_FOUND: Reminder '${reminderId}' does not exist.`);
    }

    if (reminder.userId !== userId) {
      throw new Error(
        `CROSS_USER_ACCESS_DENIED: User '${userId}' cannot approve reminder owned by '${reminder.userId}'.`,
      );
    }

    // Capture approval evidence via governance
    this._governance.approveProposal(reminder, userId, options);

    // Persist and schedule
    await this._store.saveReminder(reminder);
    await this._scheduler.scheduleReminder(reminder);

    return (await this._store.getReminder(reminderId)) || reminder;
  }

  /**
   * Modifies an existing reminder. Any change to content, dueTime, timezone,
   * or recurrence invalidates previous approval and transitions to 'awaiting_approval'.
   */
  async updateReminder(
    userId: string,
    reminderId: string,
    patch: Partial<ReminderProposalInput>,
  ): Promise<Reminder> {
    const reminder = await this._store.getReminder(reminderId);
    if (!reminder) {
      throw new Error(`REMINDER_NOT_FOUND: Reminder '${reminderId}' does not exist.`);
    }

    if (reminder.userId !== userId) {
      throw new Error(
        `CROSS_USER_ACCESS_DENIED: User '${userId}' cannot modify reminder owned by '${reminder.userId}'.`,
      );
    }

    if (reminder.status === "cancelled" || reminder.status === "completed") {
      throw new Error(
        `CANNOT_MODIFY_TERMINAL_REMINDER: Cannot update reminder in '${reminder.status}' status.`,
      );
    }

    let parametersChanged = false;

    if (patch.text !== undefined) {
      const trimmed = patch.text.trim();
      if (!trimmed) throw new Error("INVALID_ARGUMENT: Reminder text cannot be empty.");
      if (trimmed.length > MAX_REMINDER_TEXT_LENGTH) {
        throw new Error(`INVALID_ARGUMENT: Text exceeds limit of ${MAX_REMINDER_TEXT_LENGTH} chars.`);
      }
      if (trimmed !== reminder.text) {
        reminder.text = trimmed;
        parametersChanged = true;
      }
    }

    if (patch.dueTime !== undefined) {
      if (!isValidDateString(patch.dueTime)) {
        throw new Error("INVALID_ARGUMENT: Invalid ISO dueTime date string.");
      }
      const dueIso = new Date(patch.dueTime).toISOString();
      if (dueIso !== reminder.dueTime) {
        reminder.dueTime = dueIso;
        parametersChanged = true;
      }
    }

    if (patch.timezone !== undefined) {
      const tz = patch.timezone.trim();
      if (!isValidIanaTimezone(tz)) {
        throw new Error(`INVALID_TIMEZONE: '${tz}' is not a valid IANA timezone.`);
      }
      if (tz !== reminder.timezone) {
        reminder.timezone = tz;
        parametersChanged = true;
      }
    }

    if (patch.recurrence !== undefined) {
      reminder.recurrence = patch.recurrence;
      parametersChanged = true;
    }

    if (patch.projectId !== undefined) {
      reminder.projectId = patch.projectId?.trim() || undefined;
    }

    if (parametersChanged) {
      // Invalidate existing approval and cancel active timer
      this._governance.invalidateApproval(reminder, "Reminder parameters were edited by user.");
      this._scheduler.cancelTimer(reminder.id);
    }

    await this._store.saveReminder(reminder);
    return reminder;
  }

  /**
   * Snoozes a delivered or due reminder by a specified number of minutes.
   * Reschedules the reminder up to MAX_SNOOZE_COUNT times.
   */
  async snoozeReminder(
    userId: string,
    reminderId: string,
    durationMinutes = DEFAULT_SNOOZE_MINUTES,
  ): Promise<Reminder> {
    const reminder = await this._store.getReminder(reminderId);
    if (!reminder) {
      throw new Error(`REMINDER_NOT_FOUND: Reminder '${reminderId}' does not exist.`);
    }

    if (reminder.userId !== userId) {
      throw new Error(
        `CROSS_USER_ACCESS_DENIED: User '${userId}' cannot snooze reminder owned by '${reminder.userId}'.`,
      );
    }

    if (reminder.status !== "delivered" && reminder.status !== "due" && reminder.status !== "scheduled") {
      throw new Error(`CANNOT_SNOOZE: Reminder in status '${reminder.status}' cannot be snoozed.`);
    }

    if (reminder.snoozeCount >= reminder.maxSnoozeCount) {
      throw new Error(
        `MAX_SNOOZE_EXCEEDED: Reminder has already been snoozed ${reminder.snoozeCount} times (maximum is ${reminder.maxSnoozeCount}).`,
      );
    }

    reminder.snoozeCount += 1;
    const snoozeMs = Math.max(1, durationMinutes) * 60 * 1000;
    const newDueTime = new Date(Date.now() + snoozeMs).toISOString();

    reminder.dueTime = newDueTime;
    reminder.status = "scheduled";
    reminder.version = (reminder.version ?? 0) + 1;

    // Explicit user snooze action updates the approved content hash for the deferred due instant
    if (reminder.approval && reminder.approval.approved) {
      reminder.approval.contentHash = computeReminderContentHash(
        reminder.text,
        newDueTime,
        reminder.timezone,
        reminder.recurrence,
      );
    }

    // Create snooze occurrence
    const occurrenceIndex = reminder.occurrences.length + 1;
    const occurrenceId = `${reminder.id}:${occurrenceIndex}:snooze_${Date.now()}`;
    const occurrence = {
      occurrenceId,
      reminderId: reminder.id,
      occurrenceIndex,
      scheduledTime: newDueTime,
      status: "scheduled" as const,
      deliveryKey: `delivery_${reminder.id}_${occurrenceId}`,
    };
    reminder.currentOccurrenceId = occurrenceId;
    reminder.occurrences.push(occurrence);

    await this._store.saveReminder(reminder);
    await this._scheduler.scheduleReminder(reminder);

    return reminder;
  }

  /**
   * Marks a delivered reminder as acknowledged or completed.
   */
  async completeReminder(userId: string, reminderId: string): Promise<Reminder> {
    const reminder = await this._store.getReminder(reminderId);
    if (!reminder) {
      throw new Error(`REMINDER_NOT_FOUND: Reminder '${reminderId}' does not exist.`);
    }

    if (reminder.userId !== userId) {
      throw new Error(
        `CROSS_USER_ACCESS_DENIED: User '${userId}' cannot complete reminder owned by '${reminder.userId}'.`,
      );
    }

    const check = validateReminderTransition(reminder.status, "completed");
    if (!check.allowed) {
      throw new Error(check.reason);
    }

    this._scheduler.cancelTimer(reminder.id);
    reminder.status = "completed";
    reminder.version = (reminder.version ?? 0) + 1;
    await this._store.saveReminder(reminder);

    return reminder;
  }

  /**
   * Cancels a reminder. Terminal transition.
   */
  async cancelReminder(userId: string, reminderId: string): Promise<Reminder> {
    const reminder = await this._store.getReminder(reminderId);
    if (!reminder) {
      throw new Error(`REMINDER_NOT_FOUND: Reminder '${reminderId}' does not exist.`);
    }

    if (reminder.userId !== userId) {
      throw new Error(
        `CROSS_USER_ACCESS_DENIED: User '${userId}' cannot cancel reminder owned by '${reminder.userId}'.`,
      );
    }

    if (reminder.status === "cancelled") {
      return reminder;
    }

    const check = validateReminderTransition(reminder.status, "cancelled");
    if (!check.allowed) {
      throw new Error(check.reason);
    }

    this._scheduler.cancelTimer(reminder.id);
    reminder.status = "cancelled";
    reminder.version = (reminder.version ?? 0) + 1;
    await this._store.saveReminder(reminder);

    return reminder;
  }

  /**
   * Lists reminders belonging strictly to the authenticated user.
   * Project filtering ensures Project A reminders are never exposed in Project B.
   */
  async listReminders(
    userId: string,
    options?: { projectId?: string; status?: ReminderStatus },
  ): Promise<Reminder[]> {
    return this._store.listRemindersForUser(userId, options);
  }

  /**
   * Gets reminder details for the authenticated user only.
   */
  async getReminder(userId: string, reminderId: string): Promise<Reminder | undefined> {
    return this._store.getReminderForUser(reminderId, userId);
  }
}

/** Module-level singleton */
export const reminderService = new ReminderService();
