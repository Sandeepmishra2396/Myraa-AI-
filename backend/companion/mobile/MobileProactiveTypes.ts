/**
 * MYRAA — MobileProactiveTypes (Phase 26)
 *
 * Full type system for Phase 26 Mobile Proactive Companion:
 *   - Notification categories (TASK, REMINDER, PROJECT, LONG_RUNNING_TASK, SECURITY, CONNECTION)
 *   - Priorities (LOW, DEFAULT, HIGH, URGENT)
 *   - Notification payloads & channel specifications
 *   - Device subscription & notification preferences
 *   - Anti-spam & rate-limiting policies
 *   - REST request & response contracts
 */

export type MobileNotificationCategory =
  | "TASK"
  | "REMINDER"
  | "PROJECT"
  | "LONG_RUNNING_TASK"
  | "SECURITY"
  | "CONNECTION";

export const ALL_MOBILE_NOTIFICATION_CATEGORIES: readonly MobileNotificationCategory[] = Object.freeze([
  "TASK",
  "REMINDER",
  "PROJECT",
  "LONG_RUNNING_TASK",
  "SECURITY",
  "CONNECTION",
]);

export type MobileNotificationPriority = "LOW" | "DEFAULT" | "HIGH" | "URGENT";

export interface MobileProactiveNotification {
  /** Unique notification / event identifier */
  id: string;
  /** Notification headline */
  title: string;
  /** Notification body text (DLP sanitized) */
  message: string;
  /** Notification category */
  category: MobileNotificationCategory;
  /** Notification priority */
  priority: MobileNotificationPriority;
  /** Timestamp in ISO 8601 */
  timestamp: string;
  /** Deduplication key to prevent alert flooding (e.g. category + signature) */
  dedupKey?: string;
  /** Optional deep link or action URI (e.g. app intent, internal screen route) */
  actionUrl?: string;
  /** Optional spoken phrase for companion voice readouts */
  voiceText?: string;
  /** Optional arbitrary metadata payload */
  metadata?: Record<string, unknown>;
  /** Optional target device ID; if omitted, dispatched to all subscribed devices */
  targetDeviceId?: string;
  /** Expiration timestamp in ISO 8601 (default: 1 hour from creation) */
  expiresAt?: string;
}

export interface DeviceQuietHoursConfig {
  enabled: boolean;
  /** Format "HH:mm" in 24h, e.g. "22:00" */
  start: string;
  /** Format "HH:mm" in 24h, e.g. "08:00" */
  end: string;
}

export interface DeviceNotificationPreferences {
  deviceId: string;
  enabled: boolean;
  enabledCategories: Record<MobileNotificationCategory, boolean>;
  minPriority: MobileNotificationPriority;
  quietHours: DeviceQuietHoursConfig;
  updatedAt: string;
}

export const DEFAULT_DEVICE_NOTIFICATION_PREFERENCES: Omit<DeviceNotificationPreferences, "deviceId"> = {
  enabled: true,
  enabledCategories: {
    TASK: true,
    REMINDER: true,
    PROJECT: true,
    LONG_RUNNING_TASK: true,
    SECURITY: true,
    CONNECTION: true,
  },
  minPriority: "LOW",
  quietHours: {
    enabled: false,
    start: "22:00",
    end: "08:00",
  },
  updatedAt: new Date(0).toISOString(),
};

export interface SubscribeDeviceRequest {
  deviceId: string;
  preferences?: Partial<DeviceNotificationPreferences>;
}

export interface UpdatePreferencesRequest {
  enabled?: boolean;
  enabledCategories?: Partial<Record<MobileNotificationCategory, boolean>>;
  minPriority?: MobileNotificationPriority;
  quietHours?: Partial<DeviceQuietHoursConfig>;
}

export interface MobileProactiveOperationResult {
  success: boolean;
  notificationId?: string;
  delivered?: boolean;
  queued?: boolean;
  suppressedReason?: string;
  error?: string;
  errorCode?: string;
}
