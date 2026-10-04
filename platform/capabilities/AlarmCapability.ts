/**
 * MYRAA Platform — AlarmCapability Interface
 * Phase 15
 *
 * Defines the typed contract for platform alarm and timer scheduling.
 *
 * Desktop implementation: Delegates to the Proactive Companion TaskScheduler
 *   (scheduleTask tool → CompanionCoordinator → TaskScheduler).
 *   Existing in src/backend/companion/TaskScheduler.ts.
 *
 * Android implementation (Phase 17): android.app.AlarmManager with
 *   AlarmManager.RTC_WAKEUP for exact alarms, or WorkManager for inexact
 *   background scheduling.
 *
 * NOTE: The desktop companion scheduler (scheduleTask tool) operates on the
 * MYRAA Desktop Core server. Android-native alarms fire on the device independently
 * of the desktop. These serve different use cases:
 *   • Desktop companion alarms: background task monitoring, proactive notifications.
 *   • Android alarms: device-local reminders, wake-device events.
 */

// ---------------------------------------------------------------------------
// Alarm Types
// ---------------------------------------------------------------------------

export type AlarmRepeat = "none" | "daily" | "weekly" | "custom";

export interface AlarmSpec {
  /** Unique identifier for this alarm (for cancellation and updates). */
  id: string;

  /** Alarm label shown to the user (e.g., "Study reminder"). */
  label: string;

  /**
   * When the alarm should fire.
   * `triggerAtMs` : Absolute epoch milliseconds (preferred for exactness).
   * `delayMs`     : Relative delay from now in milliseconds.
   * Exactly one must be provided.
   */
  triggerAtMs?: number;
  delayMs?: number;

  /** Repeat interval. Defaults to "none" (one-shot). */
  repeat?: AlarmRepeat;

  /**
   * For "custom" repeat, the interval in milliseconds.
   * Only used when `repeat` is "custom".
   */
  repeatIntervalMs?: number;
}

export interface AlarmRecord extends AlarmSpec {
  /** Actual scheduled trigger timestamp (epoch ms). */
  scheduledAtMs: number;

  /** Whether this alarm has been cancelled. */
  cancelled: boolean;
}

export interface AlarmResult {
  success: boolean;
  alarmId: string;
  /** Scheduled trigger time as epoch ms, if successfully scheduled. */
  scheduledAtMs?: number;
  reason?: string;
}

// ---------------------------------------------------------------------------
// IAlarm Contract
// ---------------------------------------------------------------------------

/**
 * IAlarm — Platform-independent alarm/timer contract.
 *
 * Desktop (via DesktopCapabilityAdapter):
 *   Maps to the `scheduleTask` companion tool →
 *   CompanionCoordinator → TaskScheduler.
 *
 * Android (Phase 17):
 *   AlarmManager.setExactAndAllowWhileIdle() for API 23+,
 *   WorkManager for inexact background tasks.
 */
export interface IAlarm {
  /**
   * Schedule a one-shot or recurring alarm.
   * @param spec The alarm specification.
   * @param onFire Callback invoked when the alarm fires (where supported by platform).
   */
  schedule(spec: AlarmSpec, onFire?: (alarmId: string) => void): Promise<AlarmResult>;

  /**
   * Cancel a previously scheduled alarm.
   * @param id The alarm identifier passed to `schedule`.
   * Safe to call even if the alarm has already fired or does not exist.
   */
  cancel(id: string): Promise<{ success: boolean; reason?: string }>;

  /**
   * List all currently scheduled (non-cancelled) alarms.
   */
  list(): Promise<AlarmRecord[]>;

  /**
   * Cancel all scheduled alarms.
   * Used during Emergency Stop to clear all pending operations.
   */
  cancelAll(): Promise<void>;
}
