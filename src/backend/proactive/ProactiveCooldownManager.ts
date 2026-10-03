/**
 * MYRAA — Phase 21: Predictive / Proactive Engine
 * ProactiveCooldownManager
 *
 * Enforces cooldown periods between repeat notifications, checks quiet hours
 * and user suppression preferences, and invalidates expired / stale events.
 */

import type { ProactiveEvent } from "./ProactiveTypes.ts";
import { DEFAULT_COOLDOWN_MS } from "./ProactiveTypes.ts";
import { proactiveDeduplicationEngine, ProactiveDeduplicationEngine } from "./ProactiveDeduplicationEngine.ts";

export interface CooldownCheckResult {
  allowed: boolean;
  reason?: string;
  cooldownRemainingMs?: number;
}

export class ProactiveCooldownManager {
  private _cooldownMs: number;
  private _dedup: ProactiveDeduplicationEngine;
  private _quietHoursStart: number = 23; // 11 PM
  private _quietHoursEnd: number = 7; // 7 AM

  constructor(cooldownMs = DEFAULT_COOLDOWN_MS, dedup = proactiveDeduplicationEngine) {
    this._cooldownMs = cooldownMs;
    this._dedup = dedup;
  }

  /**
   * Sets custom cooldown duration in milliseconds.
   */
  public setCooldownMs(ms: number): void {
    this._cooldownMs = Math.max(0, ms);
  }

  /**
   * Checks whether an alert is allowed to be surfaced for a deduplication key.
   */
  public checkCooldown(
    deduplicationKey: string,
    now = Date.now(),
    options?: { isEmergency?: boolean; quietHoursOverride?: boolean }
  ): CooldownCheckResult {
    // Critical / Emergency alerts always bypass cooldown
    if (options?.isEmergency) {
      return { allowed: true };
    }

    // ── 1. Quiet Hours Check ────────────────────────────────────────────────
    if (!options?.quietHoursOverride && this._isQuietHours(now)) {
      return {
        allowed: false,
        reason: "QUIET_HOURS: Proactive voice/alerts suppressed during quiet hours.",
      };
    }

    // ── 2. Deduplication History & Cooldown ─────────────────────────────────
    const rec = this._dedup.getRecord(deduplicationKey);
    if (!rec || rec.lastAlertedAt === 0) {
      return { allowed: true };
    }

    const elapsed = now - rec.lastAlertedAt;
    if (elapsed < this._cooldownMs) {
      return {
        allowed: false,
        reason: `COOLDOWN_ACTIVE: Alert for this error was surfaced ${Math.round(elapsed / 1000)}s ago (cooldown: ${this._cooldownMs / 1000}s).`,
        cooldownRemainingMs: this._cooldownMs - elapsed,
      };
    }

    return { allowed: true };
  }

  /**
   * Checks if a proactive event has expired past its TTL.
   */
  public isEventExpired(event: ProactiveEvent, now = Date.now()): boolean {
    return now > event.expiresAt;
  }

  private _isQuietHours(now = Date.now()): boolean {
    const hour = new Date(now).getHours();
    if (this._quietHoursStart > this._quietHoursEnd) {
      // Overnight (e.g. 23:00 to 07:00)
      return hour >= this._quietHoursStart || hour < this._quietHoursEnd;
    }
    return hour >= this._quietHoursStart && hour < this._quietHoursEnd;
  }
}

export const proactiveCooldownManager = new ProactiveCooldownManager();
