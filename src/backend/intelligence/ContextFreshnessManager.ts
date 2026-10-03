/**
 * MYRAA — Phase 19: Advanced Context Fusion Engine
 * Context Freshness Manager
 *
 * Implements strict Time-To-Live (TTL) tracking and gradual decay factors
 * for multi-source context signals.
 *
 * Stale Context Protection:
 * Guarantees that stale or obsolete sensor data (e.g. screen OCR from 5 mins ago,
 * closed browser tab, or old file) is never treated as current ground-truth.
 */

import { contextSourceRegistry, ContextSourceRegistry } from "./ContextSourceRegistry.ts";
import type { ContextSourceType } from "./IntelligenceTypes.ts";

export class ContextFreshnessManager {
  private _registry: ContextSourceRegistry;

  constructor(registry = contextSourceRegistry) {
    this._registry = registry;
  }

  /**
   * Returns age of an observation in milliseconds.
   */
  public getAgeMs(timestamp: number, now = Date.now()): number {
    return Math.max(0, now - timestamp);
  }

  /**
   * Checks whether a context source observation is within its valid TTL window.
   */
  public isFresh(source: ContextSourceType, timestamp: number, now = Date.now()): boolean {
    if (!timestamp || timestamp <= 0) return false;
    const ttl = this._registry.getDefaultTtl(source);
    return this.getAgeMs(timestamp, now) < ttl;
  }

  /**
   * Calculates a continuous decay factor from 1.0 (fresh) down to 0.0 (stale).
   *   - Age <= 50% TTL: 1.0 (maximum freshness)
   *   - 50% TTL < Age < 100% TTL: linear decay from 1.0 to 0.0
   *   - Age >= 100% TTL: 0.0 (fully stale)
   */
  public getDecayFactor(source: ContextSourceType, timestamp: number, now = Date.now()): number {
    if (!timestamp || timestamp <= 0) return 0.0;
    const ttl = this._registry.getDefaultTtl(source);
    const age = this.getAgeMs(timestamp, now);

    if (age <= ttl * 0.5) {
      return 1.0;
    }
    if (age >= ttl) {
      return 0.0;
    }

    const decayPortion = (age - ttl * 0.5) / (ttl * 0.5);
    return Math.max(0.0, Number((1.0 - decayPortion).toFixed(2)));
  }

  /**
   * Determines whether an item is usable based on a decay threshold.
   */
  public isUsable(source: ContextSourceType, timestamp: number, minDecay = 0.1, now = Date.now()): boolean {
    return this.getDecayFactor(source, timestamp, now) >= minDecay;
  }

  /**
   * Generates a complete freshness summary across all registered sources.
   */
  public evaluateFreshnessSummary(
    timestamps: Partial<Record<ContextSourceType, number>>,
    now = Date.now()
  ): Record<ContextSourceType, { isFresh: boolean; ageMs: number; decayFactor: number }> {
    const allSources = this._registry.getAllSources();
    const result = {} as Record<ContextSourceType, { isFresh: boolean; ageMs: number; decayFactor: number }>;

    for (const src of allSources) {
      const ts = timestamps[src.sourceId] || 0;
      const ageMs = ts > 0 ? this.getAgeMs(ts, now) : Infinity;
      const isFresh = ts > 0 && this.isFresh(src.sourceId, ts, now);
      const decayFactor = ts > 0 ? this.getDecayFactor(src.sourceId, ts, now) : 0.0;

      result[src.sourceId] = {
        isFresh,
        ageMs: ageMs === Infinity ? -1 : ageMs,
        decayFactor,
      };
    }

    return result;
  }
}

export const contextFreshnessManager = new ContextFreshnessManager();
