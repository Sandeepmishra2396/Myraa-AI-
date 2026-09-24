/**
 * MYRAA — MobileProactiveManager (Phase 26)
 *
 * Central Mobile Proactive Companion Manager:
 *   • Bridges Phase 6 Proactive Companion with Android mobile delivery.
 *   • Zero duplicate engine: reuses Phase 6 EventBus, NotificationManager, TaskScheduler.
 *   • Multi-tier anti-spam protection:
 *       - eventId deduplication
 *       - sliding 60s time-window dedup
 *       - category rate-limiting (max 5/min)
 *       - connection alert collapsing
 *   • Quiet hours enforcement with post-quiet-hours queued delivery.
 *   • Urgent security alerts bypass quiet hours as required by security policy.
 *   • Fail-closed under Emergency Stop and Security Policy Lockdown (only SECURITY alerts during lockdown).
 *   • Strict DLP secret protection (no API keys, passwords, OTPs, cards, tokens).
 *   • Bounded per-device pending queue (max 20 items, 1-hour TTL).
 */

import crypto from "crypto";
import type { SecurityContext } from "../../security/SecurityTypes.ts";
import { emergencyStopCoordinator } from "../../remote/EmergencyStopCoordinator.ts";
import { securityPolicyEngine } from "../../security/SecurityPolicyEngine.ts";
import { securityAuditLogger } from "../../security/SecurityAuditLogger.ts";
import { remoteSessionManager } from "../../remote/RemoteSessionManager.ts";
import { eventBus } from "../EventBus.ts";
import type {
  MobileProactiveNotification,
  MobileNotificationCategory,
  MobileNotificationPriority,
  DeviceNotificationPreferences,
  DeviceQuietHoursConfig,
  SubscribeDeviceRequest,
  UpdatePreferencesRequest,
  MobileProactiveOperationResult,
} from "./MobileProactiveTypes.ts";
import { DEFAULT_DEVICE_NOTIFICATION_PREFERENCES } from "./MobileProactiveTypes.ts";

// ── DLP & Secret Detection Patterns ─────────────────────────────────────────

export const SENSITIVE_CREDENTIAL_PATTERNS: RegExp[] = [
  /\b(?:sora_dev_|myraa_at_)[0-9A-Za-z_\-]{16,}\b/i,
  /\bAIza[0-9A-Za-z_\-]{20,}\b/,
  /\bsk-[0-9A-Za-z_\-]{20,}\b/,
  /\bBearer\s+[A-Za-z0-9\-_.~+/]+=*\b/i,
  /-----BEGIN(?:\s+[A-Z]+)?\s+PRIVATE KEY-----/,
  /\b(?:password|passwd|pwd|secret)\s*[:=]\s*[^\s,;]{6,}\b/i,
  /\b(?:\d{4}[- ]?){3}\d{4}\b/, // 16-digit credit card pattern
  /\b(?:otp(?:\s+code)?|one[- ]time[- ]password|verification(?:\s*code)?|auth(?:\s*code)?|pin)\s*(?:is|:|=)?\s*\d{4,8}\b/i,
];

export function isDlpClean(content: string): boolean {
  if (!content || typeof content !== "string") return true;
  for (const pattern of SENSITIVE_CREDENTIAL_PATTERNS) {
    if (pattern.test(content)) return false;
  }
  return true;
}

// ── Quiet Hours Evaluation ───────────────────────────────────────────────────

export function isWithinQuietHours(now: Date, config: DeviceQuietHoursConfig): boolean {
  if (!config.enabled || !config.start || !config.end) return false;

  const [startH, startM] = config.start.split(":").map(Number);
  const [endH, endM] = config.end.split(":").map(Number);

  if (isNaN(startH) || isNaN(startM) || isNaN(endH) || isNaN(endM)) return false;

  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  if (startMinutes <= endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  } else {
    // Overnight window (e.g. 22:00 to 08:00)
    return currentMinutes >= startMinutes || currentMinutes < endMinutes;
  }
}

// ── Rate Limiting & Dedup Constants ──────────────────────────────────────────

const DEDUP_WINDOW_MS = 60_000; // 60 seconds sliding window
const MAX_RATE_PER_CATEGORY_PER_MINUTE = 5;
const MAX_PENDING_QUEUE_SIZE = 20;
const NOTIFICATION_TTL_MS = 60 * 60 * 1000; // 1 hour TTL
const CONNECTION_COLLAPSE_WINDOW_MS = 60_000;

export class MobileProactiveManager {
  private _devicePreferences: Map<string, DeviceNotificationPreferences> = new Map();
  private _pendingQueues: Map<string, MobileProactiveNotification[]> = new Map(); // deviceId -> notifications
  private _processedEventIds: Set<string> = new Set();
  private _recentDedupKeys: Map<string, number> = new Map(); // key -> timestamp
  private _categoryRateLimiter: Map<string, number[]> = new Map(); // "deviceId:category" -> timestamps
  private _lastConnectionAlert: Map<string, { notification: MobileProactiveNotification; timestamp: number }> = new Map();
  private _unsubscribers: Array<() => void> = [];
  private _initialized = false;

  constructor() {
    this.init();
  }

  /**
   * Initializes event listeners to connect with Phase 6 Proactive Companion.
   */
  init(): void {
    if (this._initialized) return;
    this._initialized = true;

    // 1. Listen for Phase 6 NotificationManager events
    this._unsubscribers.push(
      eventBus.on("notification:created", async (event: any) => {
        try {
          const item = event.data?.notification;
          if (!item) return;

          let category: MobileNotificationCategory = "REMINDER";
          let priority: MobileNotificationPriority = "DEFAULT";

          // Map Phase 6 task/system source to Phase 26 Mobile Notification Category
          switch (item.source) {
            case "build_monitor":
            case "git_monitor":
            case "deployment_monitor":
              category = "PROJECT";
              break;
            case "event_waiter":
            case "custom_poll":
            case "planner":
              category = "TASK";
              break;
            case "companion":
              category = "REMINDER";
              break;
            case "system":
              category = item.level === "error" ? "SECURITY" : "CONNECTION";
              break;
            default:
              category = "REMINDER";
          }

          switch (item.level) {
            case "error":
              priority = "HIGH";
              break;
            case "warning":
              priority = "DEFAULT";
              break;
            case "success":
            case "info":
            default:
              priority = "LOW";
              break;
          }

          await this.dispatchProactiveEvent({
            id: item.id,
            title: item.title,
            message: item.message,
            category,
            priority,
            dedupKey: item.dedupKey,
            voiceText: item.voiceText,
            metadata: item.metadata,
          });
        } catch (err) {
          console.error("[MobileProactiveManager] Error handling notification:created event:", err);
        }
      })
    );

    // 2. Listen for background task completions (Phase 6 TaskScheduler)
    this._unsubscribers.push(
      eventBus.on("task:completed", async (event: any) => {
        try {
          const task = event.data?.task;
          if (!task) return;
          await this.dispatchProactiveEvent({
            id: `task_comp_${task.id}_${Date.now()}`,
            title: `Task Completed: ${task.name}`,
            message: `Background task '${task.name}' has finished execution successfully.`,
            category: "LONG_RUNNING_TASK",
            priority: "DEFAULT",
            dedupKey: `task_completed_${task.id}`,
            metadata: { taskId: task.id, type: task.type },
          });
        } catch (err) {
          console.error("[MobileProactiveManager] Error handling task:completed event:", err);
        }
      })
    );

    // 3. Listen for background task failures
    this._unsubscribers.push(
      eventBus.on("task:failed", async (event: any) => {
        try {
          const task = event.data?.task;
          if (!task) return;
          await this.dispatchProactiveEvent({
            id: `task_fail_${task.id}_${Date.now()}`,
            title: `Task Failed: ${task.name}`,
            message: `Background task '${task.name}' failed: ${task.lastError || "Unknown error"}`,
            category: "LONG_RUNNING_TASK",
            priority: "HIGH",
            dedupKey: `task_failed_${task.id}`,
            metadata: { taskId: task.id, type: task.type, error: task.lastError },
          });
        } catch (err) {
          console.error("[MobileProactiveManager] Error handling task:failed event:", err);
        }
      })
    );
  }

  /**
   * Resets all internal stores, timers, queues, and preferences (primarily for test teardown).
   */
  clearAll(): void {
    this._devicePreferences.clear();
    this._pendingQueues.clear();
    this._processedEventIds.clear();
    this._recentDedupKeys.clear();
    this._categoryRateLimiter.clear();
    this._lastConnectionAlert.clear();
  }

  // ---------------------------------------------------------------------------
  // Device Subscription & Preferences
  // ---------------------------------------------------------------------------

  /**
   * Subscribes an Android device to receive proactive notifications.
   */
  async subscribeDevice(
    req: SubscribeDeviceRequest,
    secContext?: SecurityContext
  ): Promise<DeviceNotificationPreferences> {
    this._assertSecurityClearance("subscribeDevice");

    const deviceId = req.deviceId || secContext?.deviceId || "unknown_device";
    const existing = this._devicePreferences.get(deviceId) || {
      ...DEFAULT_DEVICE_NOTIFICATION_PREFERENCES,
      deviceId,
    };

    const updated: DeviceNotificationPreferences = {
      ...existing,
      ...req.preferences,
      deviceId,
      enabledCategories: {
        ...existing.enabledCategories,
        ...(req.preferences?.enabledCategories || {}),
      },
      quietHours: {
        ...existing.quietHours,
        ...(req.preferences?.quietHours || {}),
      },
      updatedAt: new Date().toISOString(),
    };

    this._devicePreferences.set(deviceId, updated);
    if (!this._pendingQueues.has(deviceId)) {
      this._pendingQueues.set(deviceId, []);
    }

    securityAuditLogger.logEvent({
      eventType: "AUTH_SUCCESS",
      actor: {
        identityId: secContext?.identityId || deviceId,
        role: secContext?.role || "standard",
        deviceId,
        ipAddress: secContext?.ipAddress,
      },
      target: { toolName: "subscribeDevice" },
      decision: "ALLOW",
      reason: `Android device '${deviceId}' subscribed to mobile proactive companion.`,
      riskLevel: "LOW",
    });

    return updated;
  }

  /**
   * Unsubscribes an Android device from proactive notifications.
   */
  async unsubscribeDevice(
    deviceId: string,
    secContext?: SecurityContext
  ): Promise<boolean> {
    this._assertSecurityClearance("unsubscribeDevice");
    const existed = this._devicePreferences.delete(deviceId);
    this._pendingQueues.delete(deviceId);
    this._categoryRateLimiter.delete(deviceId);
    return existed;
  }

  /**
   * Retrieves notification preferences for a device.
   */
  getDevicePreferences(deviceId: string): DeviceNotificationPreferences {
    return (
      this._devicePreferences.get(deviceId) || {
        ...DEFAULT_DEVICE_NOTIFICATION_PREFERENCES,
        deviceId,
      }
    );
  }

  /**
   * Updates notification preferences for a device.
   */
  async updateDevicePreferences(
    deviceId: string,
    patch: UpdatePreferencesRequest,
    secContext?: SecurityContext
  ): Promise<DeviceNotificationPreferences> {
    this._assertSecurityClearance("updateDevicePreferences");

    const current = this.getDevicePreferences(deviceId);
    const updated: DeviceNotificationPreferences = {
      ...current,
      enabled: patch.enabled !== undefined ? patch.enabled : current.enabled,
      minPriority: patch.minPriority || current.minPriority,
      enabledCategories: {
        ...current.enabledCategories,
        ...(patch.enabledCategories || {}),
      },
      quietHours: {
        ...current.quietHours,
        ...(patch.quietHours || {}),
      },
      updatedAt: new Date().toISOString(),
    };

    this._devicePreferences.set(deviceId, updated);
    return updated;
  }

  // ---------------------------------------------------------------------------
  // Proactive Event Dispatching & Policy Engine
  // ---------------------------------------------------------------------------

  /**
   * Dispatches a proactive notification to subscribed Android devices according to security,
   * DLP, quiet hours, anti-spam, and rate-limiting policies.
   */
  async dispatchProactiveEvent(
    notificationInput: Partial<MobileProactiveNotification> & {
      title: string;
      message: string;
      category?: MobileNotificationCategory;
    },
    secContext?: SecurityContext
  ): Promise<MobileProactiveOperationResult> {
    const category: MobileNotificationCategory = notificationInput.category || "REMINDER";
    const priority: MobileNotificationPriority = notificationInput.priority || "DEFAULT";
    const id = notificationInput.id || `notif_${crypto.randomUUID()}`;
    const now = Date.now();
    const timestamp = notificationInput.timestamp || new Date(now).toISOString();
    const expiresAt =
      notificationInput.expiresAt || new Date(now + NOTIFICATION_TTL_MS).toISOString();

    // ── 1. Emergency Stop Killswitch Check ─────────────────────────────────
    if (emergencyStopCoordinator.isActive()) {
      return {
        success: false,
        notificationId: id,
        delivered: false,
        error: "EMERGENCY_STOP_ACTIVE: Proactive notifications halted by Emergency Stop.",
        errorCode: "EMERGENCY_STOP_ACTIVE",
      };
    }

    // ── 2. Security Policy Lockdown Check ──────────────────────────────────
    // In LOCKDOWN mode, only SECURITY notifications are permitted to pass
    if (securityPolicyEngine.getMode() === "LOCKDOWN" && category !== "SECURITY") {
      return {
        success: false,
        notificationId: id,
        delivered: false,
        error: `SECURITY_LOCKDOWN_ACTIVE: Non-security proactive notification '${category}' blocked during Lockdown.`,
        errorCode: "SECURITY_LOCKDOWN_ACTIVE",
      };
    }

    // ── 3. DLP & Secret Detection ──────────────────────────────────────────
    const dlpText = [
      notificationInput.title,
      notificationInput.message,
      notificationInput.voiceText || "",
      JSON.stringify(notificationInput.metadata || {}),
    ].join(" ");

    if (!isDlpClean(dlpText)) {
      securityAuditLogger.logEvent({
        eventType: "SECURITY_POLICY_VIOLATION",
        actor: {
          identityId: secContext?.identityId || "system",
          role: secContext?.role || "standard",
          deviceId: secContext?.deviceId,
          ipAddress: secContext?.ipAddress,
        },
        target: { toolName: "dispatchProactiveEvent" },
        decision: "BLOCK",
        reason: "DLP_SECRET_REJECTED: Secrets, credentials, or API keys detected in proactive notification payload.",
        riskLevel: "HIGH",
      });

      return {
        success: false,
        notificationId: id,
        delivered: false,
        error: "DLP_SECRET_REJECTED: Proactive notifications cannot contain credentials or secret tokens.",
        errorCode: "DLP_SECRET_REJECTED",
      };
    }

    // ── 4. Event ID Deduplication ──────────────────────────────────────────
    if (this._processedEventIds.has(id)) {
      return {
        success: true,
        notificationId: id,
        delivered: false,
        suppressedReason: "DEDUPLICATED_EVENT_ID",
      };
    }
    this._processedEventIds.add(id);
    if (this._processedEventIds.size > 1000) {
      // Prune oldest items from processed set
      const iter = this._processedEventIds.values();
      for (let i = 0; i < 200; i++) {
        const next = iter.next();
        if (next.done) break;
        this._processedEventIds.delete(next.value);
      }
    }

    // ── 5. Sliding Time-Window Deduplication ────────────────────────────────
    const dedupKey = notificationInput.dedupKey || `${category}:${notificationInput.title}`;
    const lastSeen = this._recentDedupKeys.get(dedupKey);
    if (lastSeen && now - lastSeen < DEDUP_WINDOW_MS) {
      return {
        success: true,
        notificationId: id,
        delivered: false,
        suppressedReason: "DEDUPLICATED_TIME_WINDOW",
      };
    }
    this._recentDedupKeys.set(dedupKey, now);

    // Housekeep dedup keys
    if (this._recentDedupKeys.size > 200) {
      for (const [k, ts] of this._recentDedupKeys.entries()) {
        if (now - ts > DEDUP_WINDOW_MS) this._recentDedupKeys.delete(k);
      }
    }

    const fullNotification: MobileProactiveNotification = {
      id,
      title: notificationInput.title,
      message: notificationInput.message,
      category,
      priority,
      timestamp,
      dedupKey,
      actionUrl: notificationInput.actionUrl,
      voiceText: notificationInput.voiceText,
      metadata: notificationInput.metadata,
      targetDeviceId: notificationInput.targetDeviceId,
      expiresAt,
    };

    // Determine target devices
    const targetDevices = notificationInput.targetDeviceId
      ? [notificationInput.targetDeviceId]
      : Array.from(this._devicePreferences.keys());

    if (targetDevices.length === 0) {
      // No subscribed devices
      return {
        success: true,
        notificationId: id,
        delivered: false,
        suppressedReason: "NO_SUBSCRIBED_DEVICES",
      };
    }

    let anyDelivered = false;
    let anyQueued = false;
    let lastSuppressedReason: string | undefined;

    for (const devId of targetDevices) {
      const prefs = this.getDevicePreferences(devId);

      // Check Master Toggle
      if (!prefs.enabled) {
        lastSuppressedReason = "DEVICE_NOTIFICATIONS_DISABLED";
        continue;
      }

      // Check Category Toggle
      if (!prefs.enabledCategories[category]) {
        lastSuppressedReason = "CATEGORY_DISABLED";
        continue;
      }

      // Check Minimum Priority
      if (!this._isPriorityEligible(priority, prefs.minPriority)) {
        lastSuppressedReason = "PRIORITY_BELOW_MINIMUM";
        continue;
      }

      // Check Category Rate Limit (max 5/min)
      const rateLimitKey = `${devId}:${category}`;
      const timestamps = this._categoryRateLimiter.get(rateLimitKey) || [];
      const validTimestamps = timestamps.filter((t) => now - t < 60_000);
      if (validTimestamps.length >= MAX_RATE_PER_CATEGORY_PER_MINUTE) {
        lastSuppressedReason = "RATE_LIMITED_CATEGORY";
        continue;
      }
      validTimestamps.push(now);
      this._categoryRateLimiter.set(rateLimitKey, validTimestamps);

      // Check Connection Alert Collapsing
      if (category === "CONNECTION") {
        const lastConn = this._lastConnectionAlert.get(devId);
        if (lastConn && now - lastConn.timestamp < CONNECTION_COLLAPSE_WINDOW_MS) {
          // Collapse into previous connection alert
          lastConn.timestamp = now;
          lastConn.notification = fullNotification;
          lastSuppressedReason = "COLLAPSED_CONNECTION_ALERT";
          continue;
        }
        this._lastConnectionAlert.set(devId, { notification: fullNotification, timestamp: now });
      }

      // Quiet Hours Evaluation
      const inQuietHours = isWithinQuietHours(new Date(now), prefs.quietHours);
      const isUrgentSecurity = category === "SECURITY" && (priority === "HIGH" || priority === "URGENT");
      const isUrgent = priority === "URGENT" || isUrgentSecurity;

      if (inQuietHours && !isUrgent) {
        // Enqueue for post-quiet-hours delivery
        this._enqueueForDevice(devId, fullNotification);
        anyQueued = true;
        lastSuppressedReason = "QUEUED_QUIET_HOURS";
        continue;
      }

      // Attempt Real-Time WebSocket Delivery
      const client = remoteSessionManager.getClientForDevice(devId);
      if (client && client.ws && client.ws.readyState === 1) {
        try {
          client.ws.send(
            JSON.stringify({
              type: "proactive_notification",
              notification: fullNotification,
            })
          );
          anyDelivered = true;
        } catch {
          // Fallback to queue if delivery fails
          this._enqueueForDevice(devId, fullNotification);
          anyQueued = true;
        }
      } else {
        // Device is offline: save in bounded pending queue
        this._enqueueForDevice(devId, fullNotification);
        anyQueued = true;
      }
    }

    return {
      success: true,
      notificationId: id,
      delivered: anyDelivered,
      queued: anyQueued,
      suppressedReason: anyDelivered ? undefined : lastSuppressedReason,
    };
  }

  // ---------------------------------------------------------------------------
  // Pending Offline / Quiet Hours Queue Management
  // ---------------------------------------------------------------------------

  private _enqueueForDevice(deviceId: string, notification: MobileProactiveNotification): void {
    let queue = this._pendingQueues.get(deviceId);
    if (!queue) {
      queue = [];
      this._pendingQueues.set(deviceId, queue);
    }

    // Prune expired notifications (> 1 hour TTL)
    const now = Date.now();
    queue = queue.filter((item) => {
      const exp = item.expiresAt ? new Date(item.expiresAt).getTime() : 0;
      return exp > now;
    });

    // Enforce bounded queue (FIFO max 20)
    if (queue.length >= MAX_PENDING_QUEUE_SIZE) {
      queue.shift(); // Evict oldest
    }

    queue.push(notification);
    this._pendingQueues.set(deviceId, queue);
  }

  /**
   * Fetches and drains pending notifications for a device upon reconnect or post-quiet-hours.
   */
  async drainPendingNotifications(
    deviceId: string,
    secContext?: SecurityContext
  ): Promise<MobileProactiveNotification[]> {
    this._assertSecurityClearance("drainPendingNotifications");

    const queue = this._pendingQueues.get(deviceId) || [];
    const now = Date.now();

    // Filter out expired items
    const validItems = queue.filter((item) => {
      const exp = item.expiresAt ? new Date(item.expiresAt).getTime() : 0;
      return exp > now;
    });

    // Clear drained queue
    this._pendingQueues.set(deviceId, []);
    return validItems;
  }

  /**
   * Clears all pending notifications for a device.
   */
  async clearPendingNotifications(
    deviceId: string,
    secContext?: SecurityContext
  ): Promise<void> {
    this._assertSecurityClearance("clearPendingNotifications");
    this._pendingQueues.set(deviceId, []);
  }

  /**
   * Returns current pending queue for a device without draining (for inspection).
   */
  getPendingNotifications(deviceId: string): MobileProactiveNotification[] {
    const queue = this._pendingQueues.get(deviceId) || [];
    const now = Date.now();
    return queue.filter((item) => {
      const exp = item.expiresAt ? new Date(item.expiresAt).getTime() : 0;
      return exp > now;
    });
  }

  // ---------------------------------------------------------------------------
  // Internal Helpers
  // ---------------------------------------------------------------------------

  private _assertSecurityClearance(action: string): void {
    if (emergencyStopCoordinator.isActive()) {
      throw new Error(
        `EMERGENCY_STOP_ACTIVE: Action '${action}' is blocked. Emergency stop is active.`
      );
    }
    if (securityPolicyEngine.getMode() === "LOCKDOWN" && action !== "getDevicePreferences") {
      throw new Error(
        `SECURITY_LOCKDOWN_ACTIVE: Action '${action}' is blocked during Security Lockdown.`
      );
    }
  }

  private _isPriorityEligible(
    itemPriority: MobileNotificationPriority,
    minPriority: MobileNotificationPriority
  ): boolean {
    const priorityValues: Record<MobileNotificationPriority, number> = {
      LOW: 1,
      DEFAULT: 2,
      HIGH: 3,
      URGENT: 4,
    };
    return (priorityValues[itemPriority] ?? 2) >= (priorityValues[minPriority] ?? 1);
  }
}

export const mobileProactiveManager = new MobileProactiveManager();
