/**
 * MYRAA Platform — NotificationCapability Interface
 * Phase 15
 *
 * Defines the typed contract for platform-native notification posting.
 *
 * Desktop implementation: Delegates to CompanionCoordinator.broadcast()
 *   (existing in src/backend/companion/CompanionCoordinator.ts).
 *   The CompanionCoordinator already broadcasts notifications to all connected
 *   WebSocket clients via the registered broadcast functions in server.ts.
 *
 * Android implementation (Phase 17): android.app.NotificationManager +
 *   NotificationCompat.Builder via AndroidX for API 26+ notification channels.
 *
 * IMPORTANT: Emergency Stop notifications MUST always be posted with PRIORITY_MAX
 * and cannot be dismissed by the user while the emergency is active.
 * This matches the EmergencyStopCoordinator broadcast semantics on the desktop.
 */

// ---------------------------------------------------------------------------
// Notification Types
// ---------------------------------------------------------------------------

export type NotificationPriority =
  | "min"        // Low-priority background
  | "low"        // Below normal
  | "default"    // Standard
  | "high"       // Attention required
  | "max";       // Urgent — Emergency Stop, security alerts

export type NotificationCategory =
  | "companion"       // Proactive companion update
  | "emergency_stop"  // Emergency Stop active/reset
  | "security_alert"  // Phase 10 security event
  | "study"           // AI Study Companion reminder
  | "task"            // Background task completion
  | "system";         // General system notification

export interface NotificationAction {
  /** Action identifier (e.g., "dismiss", "view", "emergency_stop_reset"). */
  id: string;
  /** Button label shown to the user. */
  label: string;
}

export interface NotificationSpec {
  /** Unique notification identifier. Posting same id updates an existing notification. */
  id: string;

  /** Notification headline. */
  title: string;

  /** Notification body text. */
  body: string;

  /** Priority level. Defaults to "default". */
  priority?: NotificationPriority;

  /** Semantic category. Used for Android channel mapping and filtering. */
  category?: NotificationCategory;

  /** Whether this notification is ongoing (cannot be dismissed by user swipe). */
  ongoing?: boolean;

  /** Optional action buttons shown with the notification. */
  actions?: NotificationAction[];

  /** Whether to vibrate when posting this notification. */
  vibrate?: boolean;

  /** ISO timestamp for notification sort ordering. Defaults to now. */
  timestamp?: string;
}

// ---------------------------------------------------------------------------
// INotification Contract
// ---------------------------------------------------------------------------

/**
 * INotification — Platform-independent notification posting contract.
 *
 * Desktop (via DesktopCapabilityAdapter):
 *   Wraps CompanionCoordinator.broadcast() which pushes WebSocket events
 *   to the React UI notification panel.
 *
 * Android (Phase 17):
 *   NotificationManager.notify() with NotificationCompat.Builder.
 *   Emergency Stop → NotificationCompat.PRIORITY_MAX + setOngoing(true).
 */
export interface INotification {
  /**
   * Post or update a notification.
   * If a notification with the given `id` already exists, it is updated in place.
   * @param spec The notification specification.
   */
  post(spec: NotificationSpec): Promise<{ success: boolean; reason?: string }>;

  /**
   * Dismiss a specific notification by id.
   * Safe to call if the notification does not exist.
   */
  dismiss(id: string): Promise<void>;

  /**
   * Dismiss all active notifications.
   * Used during system shutdown or session end.
   */
  dismissAll(): Promise<void>;

  /**
   * Post an Emergency Stop notification.
   * Shorthand that forces priority="max", ongoing=true, vibrate=true,
   * category="emergency_stop". Implementations MUST NOT allow this to be
   * dismissed by the user while the emergency stop remains active.
   */
  postEmergencyStop(reason: string): Promise<void>;

  /**
   * Clear the Emergency Stop notification.
   * Should only be called after EmergencyStopCoordinator.reset() confirms success.
   */
  clearEmergencyStop(): Promise<void>;
}
