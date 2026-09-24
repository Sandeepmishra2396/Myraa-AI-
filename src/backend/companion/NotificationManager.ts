/**
 * MYRAA — NotificationManager (Phase 6)
 *
 * Central notification hub:
 *   - Unified alert creation, storage, and retrieval
 *   - Deduplication within a sliding time window (prevents alert spam)
 *   - Bounded in-memory & persistent queue
 *   - Quiet hours evaluation (suppresses voice/audio only, never visual alerts)
 *   - Secret & credential sanitization in voice announcements
 *   - Myraa persona voice phrasing (sweet, proactive anime heroine tone)
 */

import crypto from "crypto";
import type {
  NotificationItem,
  NotificationLevel,
  VoiceAnnouncement,
  QuietHoursConfig,
  TaskType,
} from "./CompanionTypes.ts";
import { companionStore } from "./CompanionStore.ts";
import { eventBus } from "./EventBus.ts";
import { sanitizeError } from "../security/PermissionManager.ts";

/** Deduplication window: duplicate alerts with same dedupKey within 60s are suppressed. */
const DEDUP_WINDOW_MS = 60_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strips API keys, bearer tokens, passwords, and file paths from spoken text. */
export function sanitizeVoiceText(rawText: string): string {
  if (!rawText) return "";
  let clean = sanitizeError(rawText);
  // Redact potential API keys / hex / tokens
  clean = clean.replace(/([a-zA-Z0-9_-]{24,})/g, "[token]");
  clean = clean.replace(/(bearer\s+[^\s]+)/gi, "[token]");
  clean = clean.replace(/(password|secret|key)\s*[:=]\s*[^\s]+/gi, "$1: [hidden]");
  // Clean up excessive whitespace
  clean = clean.replace(/\s+/g, " ").trim();
  return clean;
}

/** Check whether a given Date falls inside a quiet hours window (HH:mm - HH:mm). */
export function isWithinQuietHours(now: Date, config: QuietHoursConfig): boolean {
  if (!config.enabled || !config.start || !config.end) return false;

  const [startH, startM] = config.start.split(":").map(Number);
  const [endH, endM] = config.end.split(":").map(Number);

  if (isNaN(startH) || isNaN(startM) || isNaN(endH) || isNaN(endM)) return false;

  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  if (startMinutes <= endMinutes) {
    // Normal window, e.g. 01:00 to 06:00
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  } else {
    // Overnight window, e.g. 22:00 to 08:00
    return currentMinutes >= startMinutes || currentMinutes < endMinutes;
  }
}

// ---------------------------------------------------------------------------
// NotificationManager
// ---------------------------------------------------------------------------

export class NotificationManager {
  private _recentKeys = new Map<string, number>(); // dedupKey -> timestamp
  private _voiceQueue: VoiceAnnouncement[] = [];

  /**
   * Post a new notification.
   * Handles deduplication, quiet hours check, persistence, and event emission.
   */
  async notify(opts: {
    title: string;
    message: string;
    level?: NotificationLevel;
    source?: TaskType | "companion" | "system" | "planner";
    dedupKey?: string;
    voiceText?: string;
    metadata?: Record<string, unknown>;
  }): Promise<NotificationItem | null> {
    const level: NotificationLevel = opts.level || "info";
    const source = opts.source || "companion";
    const now = Date.now();
    const dedupKey = opts.dedupKey || `${source}:${opts.title}`;

    // ── 1. Deduplication check ─────────────────────────────────────────────
    const lastSeen = this._recentKeys.get(dedupKey);
    if (lastSeen && now - lastSeen < DEDUP_WINDOW_MS) {
      // Duplicate alert within window — suppress
      return null;
    }
    this._recentKeys.set(dedupKey, now);

    // Housekeep deduplication map periodically
    if (this._recentKeys.size > 200) {
      for (const [k, ts] of this._recentKeys.entries()) {
        if (now - ts > DEDUP_WINDOW_MS) this._recentKeys.delete(k);
      }
    }

    // ── 2. Sanitize spoken voice text ──────────────────────────────────────
    const voiceText = opts.voiceText
      ? sanitizeVoiceText(opts.voiceText)
      : sanitizeVoiceText(opts.message);

    const item: NotificationItem = {
      id: crypto.randomUUID(),
      title: opts.title,
      message: opts.message,
      level,
      source,
      timestamp: new Date(now).toISOString(),
      read: false,
      dismissed: false,
      dedupKey,
      voiceText,
      metadata: opts.metadata,
    };

    // ── 3. Persist notification ────────────────────────────────────────────
    const prefs = await companionStore.getPreferences();
    await companionStore.saveNotification(item, prefs.maxNotificationQueueSize);

    // ── 4. Evaluate quiet hours for voice announcements ───────────────────
    const inQuietHours = isWithinQuietHours(new Date(now), prefs.quietHours);
    const voiceEligible =
      prefs.voiceNotificationsEnabled &&
      !inQuietHours &&
      this._isLevelEligible(level, prefs.minVoiceLevel);

    const announcement: VoiceAnnouncement = {
      id: crypto.randomUUID(),
      notificationId: item.id,
      text: voiceText,
      level,
      queuedAt: new Date(now).toISOString(),
      suppressedByQuietHours: inQuietHours,
    };

    if (voiceEligible) {
      this._voiceQueue.push(announcement);
      eventBus.emit("notification:voice", announcement);
    }

    // ── 5. Emit notification event (visual notification ALWAYS emitted) ───
    eventBus.emit("notification:created", {
      notification: item,
      voiceAnnouncement: announcement,
      suppressedByQuietHours: inQuietHours,
    });

    return item;
  }

  /** Retrieve all notifications, ordered newest first. */
  async listNotifications(): Promise<NotificationItem[]> {
    return companionStore.listNotifications();
  }

  /** Mark a notification as read or dismissed. */
  async dismissNotification(id: string): Promise<NotificationItem | undefined> {
    return companionStore.updateNotification(id, { dismissed: true, read: true });
  }

  /** Clear all notifications. */
  async clearNotifications(): Promise<void> {
    return companionStore.clearNotifications();
  }

  /** Retrieve queued voice announcements. */
  getVoiceQueue(): VoiceAnnouncement[] {
    return [...this._voiceQueue];
  }

  /** Clear processed voice queue. */
  clearVoiceQueue(): void {
    this._voiceQueue = [];
  }

  private _isLevelEligible(itemLevel: NotificationLevel, minLevel: NotificationLevel): boolean {
    const priority: Record<NotificationLevel, number> = {
      info: 1,
      success: 2,
      warning: 3,
      error: 4,
    };
    return (priority[itemLevel] ?? 1) >= (priority[minLevel] ?? 1);
  }
}

/** Global singleton notification manager. */
export const notificationManager = new NotificationManager();
