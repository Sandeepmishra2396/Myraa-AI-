/**
 * MYRAA — ReminderStore (Stage 10.6)
 *
 * Atomic, durable persistence of reminders in DATA_DIR/reminders.json.
 *
 * Storage invariants:
 *   - Write to unique .tmp file → atomic rename (prevents partial writes).
 *   - Strips UTF-8 BOM and leading/trailing whitespace on load.
 *   - Monotonic versioning and optimistic concurrency support (saveReminderAtomic).
 *   - Strict user ownership and project isolation filtering.
 */

import fs from "fs/promises";
import path from "path";
import { dataFile } from "../server_paths.ts";
import { companionStore } from "../companion/CompanionStore.ts";
import {
  DEFAULT_CLAIM_LEASE_MS,
  MAX_DELIVERY_ATTEMPTS,
  DEFAULT_RETRY_BACKOFF_MS,
  type Reminder,
  type ReminderOccurrence,
  type ReminderStatus,
  type DeliveryResult,
} from "./ReminderTypes.ts";

function getRemindersFile(): string {
  return dataFile("reminders.json");
}

// ---------------------------------------------------------------------------
// Internal File I/O
// ---------------------------------------------------------------------------

async function readReminders(): Promise<Map<string, Reminder>> {
  const filePath = getRemindersFile();
  try {
    let raw = await fs.readFile(filePath, "utf-8");
    raw = raw.replace(/^\uFEFF/, "").trim();
    if (!raw) return new Map();
    const arr: Reminder[] = JSON.parse(raw);
    if (!Array.isArray(arr)) return new Map();
    return new Map(arr.map((r) => [r.id, r]));
  } catch (err: any) {
    if (err.code === "ENOENT") return new Map();
    console.error("[ReminderStore] Error reading reminders.json:", err);
    return new Map();
  }
}

async function writeReminders(reminders: Map<string, Reminder>): Promise<void> {
  const filePath = getRemindersFile();
  const arr = Array.from(reminders.values());
  const json = JSON.stringify(arr, null, 2);
  const tmpFile = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;

  try {
    await fs.writeFile(tmpFile, json, "utf-8");
    let renamed = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await fs.rename(tmpFile, filePath);
        renamed = true;
        break;
      } catch (err: any) {
        if ((err.code === "EPERM" || err.code === "EBUSY") && attempt < 4) {
          await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
          continue;
        }
        throw err;
      }
    }
    if (!renamed) {
      await fs.rename(tmpFile, filePath);
    }
  } catch (err) {
    console.error("[ReminderStore] Error writing reminders.json:", err);
    try {
      await fs.unlink(tmpFile);
    } catch {
      /* ignore cleanup error */
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// ReminderStore
// ---------------------------------------------------------------------------

export class ReminderStore {
  private _writeQueue: Promise<unknown> = Promise.resolve();

  /**
   * Internal queue serialization to enforce atomic read-modify-write within process.
   */
  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this._writeQueue.then(operation, operation);
    this._writeQueue = next.catch(() => {});
    return next as Promise<T>;
  }

  /**
   * Save (create or update) a reminder unconditionally.
   */
  async saveReminder(reminder: Reminder): Promise<void> {
    return this.serialize(async () => {
      const map = await readReminders();
      map.set(reminder.id, { ...reminder, updatedAt: new Date().toISOString() });
      await writeReminders(map);
    });
  }

  /**
   * Save a reminder with optimistic concurrency check.
   * If expectedVersion is specified and does not match the stored version,
   * throws STALE_UPDATE_DETECTED.
   */
  async saveReminderAtomic(reminder: Reminder, expectedVersion?: number): Promise<void> {
    return this.serialize(async () => {
      const map = await readReminders();
      const existing = map.get(reminder.id);
      if (existing && expectedVersion !== undefined) {
        if (existing.version !== expectedVersion) {
          throw new Error(
            `STALE_UPDATE_DETECTED: Reminder '${reminder.id}' version mismatch. Expected ${expectedVersion}, found ${existing.version}.`,
          );
        }
      }
      map.set(reminder.id, { ...reminder, updatedAt: new Date().toISOString() });
      await writeReminders(map);
    });
  }

  /**
   * Atomically claims an occurrence for delivery by a specific worker.
   * Prevents concurrent workers from delivering the same occurrence.
   * Enforces bounded retries and expiration leases for crash recovery.
   */
  async claimOccurrenceAtomic(
    reminderId: string,
    occurrenceId: string,
    workerId: string,
    leaseDurationMs = DEFAULT_CLAIM_LEASE_MS,
  ): Promise<{
    claimed: boolean;
    reason?: string;
    occurrence?: ReminderOccurrence;
    reminder?: Reminder;
  }> {
    return this.serialize(async () => {
      const map = await readReminders();
      const reminder = map.get(reminderId);
      if (!reminder) {
        return {
          claimed: false,
          reason: `REMINDER_NOT_FOUND: Reminder '${reminderId}' does not exist.`,
        };
      }

      if (reminder.status === "cancelled" || reminder.status === "completed") {
        return {
          claimed: false,
          reason: `REMINDER_TERMINAL: Reminder '${reminderId}' is in terminal status '${reminder.status}'.`,
          reminder,
        };
      }

      const occ = reminder.occurrences.find((o) => o.occurrenceId === occurrenceId);
      if (!occ) {
        return {
          claimed: false,
          reason: `OCCURRENCE_NOT_FOUND: Occurrence '${occurrenceId}' does not exist on reminder '${reminderId}'.`,
          reminder,
        };
      }

      if (occ.status === "delivered") {
        return {
          claimed: false,
          reason: `OCCURRENCE_ALREADY_DELIVERED: Occurrence '${occurrenceId}' has already been delivered.`,
          occurrence: occ,
          reminder,
        };
      }

      if (occ.status === "failed") {
        return {
          claimed: false,
          reason: `OCCURRENCE_FAILED: Occurrence '${occurrenceId}' has permanently failed.`,
          occurrence: occ,
          reminder,
        };
      }

      if (occ.status === "skipped") {
        return {
          claimed: false,
          reason: `OCCURRENCE_SKIPPED: Occurrence '${occurrenceId}' was skipped.`,
          occurrence: occ,
          reminder,
        };
      }

      const now = Date.now();

      // Check if another worker holds an active (unexpired) lease
      if (occ.status === "claimed") {
        const leaseExpires = occ.claimLeaseExpiresAt
          ? new Date(occ.claimLeaseExpiresAt).getTime()
          : 0;
        if (now < leaseExpires) {
          return {
            claimed: false,
            reason: `OCCURRENCE_ALREADY_CLAIMED: Occurrence '${occurrenceId}' is currently claimed by worker '${occ.claimedBy}' until ${occ.claimLeaseExpiresAt}.`,
            occurrence: occ,
            reminder,
          };
        }
        // If now >= leaseExpires, previous worker's lease expired without outcome -> can be claimed
      }

      // Check attempt limits
      const attempts = (occ.deliveryAttempts ?? 0) + 1;
      const maxAttempts = occ.maxDeliveryAttempts ?? MAX_DELIVERY_ATTEMPTS;
      if (attempts > maxAttempts) {
        occ.status = "failed";
        occ.error = `MAX_DELIVERY_ATTEMPTS_EXCEEDED: Exceeded maximum delivery attempts (${maxAttempts}).`;
        delete occ.claimLeaseExpiresAt;
        reminder.status = "failed";
        reminder.version = (reminder.version ?? 0) + 1;
        reminder.updatedAt = new Date().toISOString();
        await writeReminders(map);
        return {
          claimed: false,
          reason: occ.error,
          occurrence: occ,
          reminder,
        };
      }

      const nowIso = new Date(now).toISOString();
      const leaseExpiresIso = new Date(now + leaseDurationMs).toISOString();

      occ.status = "claimed";
      occ.claimedBy = workerId;
      occ.claimedAt = nowIso;
      occ.claimLeaseExpiresAt = leaseExpiresIso;
      occ.deliveryAttempts = attempts;
      occ.maxDeliveryAttempts = maxAttempts;
      occ.lastAttemptAt = nowIso;

      reminder.status = "due";
      reminder.version = (reminder.version ?? 0) + 1;
      reminder.updatedAt = nowIso;

      await writeReminders(map);
      return {
        claimed: true,
        occurrence: occ,
        reminder,
      };
    });
  }

  /**
   * Commits the outcome of a delivery attempt atomically to persistent storage.
   */
  async commitDeliveryOutcomeAtomic(
    reminderId: string,
    occurrenceId: string,
    result: DeliveryResult,
  ): Promise<Reminder> {
    return this.serialize(async () => {
      const map = await readReminders();
      const reminder = map.get(reminderId);
      if (!reminder) {
        throw new Error(`REMINDER_NOT_FOUND: Reminder '${reminderId}' does not exist.`);
      }

      const occ = reminder.occurrences.find((o) => o.occurrenceId === occurrenceId);
      if (!occ) {
        throw new Error(`OCCURRENCE_NOT_FOUND: Occurrence '${occurrenceId}' does not exist on '${reminderId}'.`);
      }

      delete occ.claimLeaseExpiresAt;
      const nowIso = new Date().toISOString();

      if (result.status === "delivered") {
        occ.status = "delivered";
        occ.deliveredAt = result.timestamp || nowIso;
        occ.error = undefined;
        reminder.lastDeliveredAt = occ.deliveredAt;
        reminder.status = "delivered";
      } else if (result.status === "retryable_failure") {
        const attempts = occ.deliveryAttempts ?? 1;
        const maxAttempts = occ.maxDeliveryAttempts ?? MAX_DELIVERY_ATTEMPTS;

        if (attempts >= maxAttempts) {
          occ.status = "failed";
          occ.error = `MAX_DELIVERY_ATTEMPTS_EXCEEDED: ${result.error ? result.error + " — " : ""}Delivery failed after reaching maximum of ${maxAttempts} attempts.`;
          reminder.status = "failed";
        } else {
          const backoffMs =
            result.retryAfterMs ?? (DEFAULT_RETRY_BACKOFF_MS * Math.pow(2, attempts - 1));
          occ.status = "retryable_failure";
          occ.error = result.error;
          occ.nextRetryAt = new Date(Date.now() + backoffMs).toISOString();
          reminder.status = "scheduled"; // Re-queued for retry
        }
      } else if (result.status === "failed") {
        occ.status = "failed";
        occ.error = result.error;
        reminder.status = "failed";
      } else if (result.status === "delivery_unknown") {
        occ.status = "delivery_unknown";
        occ.error = result.error;
        reminder.status = "delivery_unknown";
      }

      reminder.version = (reminder.version ?? 0) + 1;
      reminder.updatedAt = nowIso;

      await writeReminders(map);
      return reminder;
    });
  }

  /**
   * Recovers interrupted claims across application or scheduler restarts.
   * If a notification was already written to companionStore before crash,
   * reconciles occurrence to 'delivered' to prevent duplicate delivery.
   * Otherwise resets expired claims to 'due' for retry, or 'failed' if exhausted.
   */
  async recoverInterruptedClaims(workerId: string): Promise<{
    reconciledDelivered: number;
    resetToDue: number;
    markedFailed: number;
  }> {
    return this.serialize(async () => {
      const map = await readReminders();
      const notifications = await companionStore.listNotifications();
      let reconciledDelivered = 0;
      let resetToDue = 0;
      let markedFailed = 0;
      let dirty = false;
      const now = Date.now();

      for (const reminder of map.values()) {
        if (reminder.status === "cancelled" || reminder.status === "completed") {
          continue;
        }

        for (const occ of reminder.occurrences) {
          if (occ.status === "claimed") {
            const leaseExpires = occ.claimLeaseExpiresAt
              ? new Date(occ.claimLeaseExpiresAt).getTime()
              : 0;

            if (now >= leaseExpires) {
              delete occ.claimLeaseExpiresAt;
              delete occ.claimedBy;

              // Check if notification was actually dispatched before crash
              const sentNotification = notifications.find(
                (n) => n.dedupKey === occ.deliveryKey,
              );

              if (sentNotification) {
                // Sent before crash! Reconcile to delivered to avoid duplicate dispatch
                occ.status = "delivered";
                occ.deliveredAt = sentNotification.timestamp || new Date(now).toISOString();
                occ.error = undefined;
                reminder.status = "delivered";
                reminder.lastDeliveredAt = occ.deliveredAt;
                reconciledDelivered++;
                dirty = true;
              } else {
                // Not sent before crash
                const attempts = occ.deliveryAttempts ?? 1;
                const maxAttempts = occ.maxDeliveryAttempts ?? MAX_DELIVERY_ATTEMPTS;

                if (attempts >= maxAttempts) {
                  occ.status = "failed";
                  occ.error = "INTERRUPTED_CLAIM_EXHAUSTED: Lease expired after max delivery attempts.";
                  reminder.status = "failed";
                  markedFailed++;
                  dirty = true;
                } else {
                  occ.status = "due";
                  reminder.status = "due";
                  resetToDue++;
                  dirty = true;
                }
              }

              reminder.version = (reminder.version ?? 0) + 1;
              reminder.updatedAt = new Date(now).toISOString();
            }
          }
        }
      }

      if (dirty) {
        await writeReminders(map);
      }

      return {
        reconciledDelivered,
        resetToDue,
        markedFailed,
      };
    });
  }

  /**
   * Retrieve a reminder by ID without user ownership check (internal scheduler use).
   */
  async getReminder(id: string): Promise<Reminder | undefined> {
    const map = await readReminders();
    return map.get(id);
  }

  /**
   * Retrieve a reminder enforcing user ownership.
   */
  async getReminderForUser(id: string, userId: string): Promise<Reminder | undefined> {
    const reminder = await this.getReminder(id);
    if (!reminder) return undefined;
    if (reminder.userId !== userId) {
      return undefined; // Strictly isolated
    }
    return reminder;
  }

  /**
   * List reminders belonging strictly to a specific user, with optional project filtering.
   */
  async listRemindersForUser(
    userId: string,
    options?: { projectId?: string; status?: ReminderStatus },
  ): Promise<Reminder[]> {
    if (!userId || typeof userId !== "string" || !userId.trim()) {
      return [];
    }

    const map = await readReminders();
    let all = Array.from(map.values()).filter((r) => r.userId === userId);

    if (options?.projectId !== undefined && options?.projectId !== null) {
      all = all.filter((r) => r.projectId === options.projectId);
    }

    if (options?.status) {
      all = all.filter((r) => r.status === options.status);
    }

    // Sort by dueTime ascending (earliest first)
    return all.sort((a, b) => new Date(a.dueTime).getTime() - new Date(b.dueTime).getTime());
  }

  /**
   * Return all scheduled, due, or actionable reminders across the system.
   */
  async listAllActiveReminders(): Promise<Reminder[]> {
    const map = await readReminders();
    return Array.from(map.values()).filter(
      (r) =>
        r.status === "scheduled" ||
        r.status === "due" ||
        r.occurrences.some(
          (o) =>
            o.status === "due" ||
            o.status === "retryable_failure" ||
            o.status === "claimed",
        ),
    );
  }

  /**
   * Delete a reminder by ID, enforcing user ownership.
   */
  async deleteReminder(id: string, userId: string): Promise<boolean> {
    return this.serialize(async () => {
      const map = await readReminders();
      const existing = map.get(id);
      if (!existing || existing.userId !== userId) {
        return false;
      }
      map.delete(id);
      await writeReminders(map);
      return true;
    });
  }

  /**
   * Wipe all reminders (for isolated unit tests only).
   */
  async clearAllForTesting(): Promise<void> {
    return this.serialize(async () => {
      await writeReminders(new Map());
    });
  }
}

/** Module-level singleton */
export const reminderStore = new ReminderStore();
