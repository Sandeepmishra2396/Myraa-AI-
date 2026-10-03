/**
 * MYRAA — Phase 21: Predictive / Proactive Engine
 * ProactiveDeduplicationEngine
 *
 * Prevents notification spam by computing deterministic deduplication keys,
 * tracking repeat counts across recent errors, and escalating repeated failures
 * into a single consolidated, actionable diagnostic event.
 */

import type {
  ProactiveEvent,
  ProactiveEventType,
  ProactiveEvidence,
} from "./ProactiveTypes.ts";
import { REPEATED_FAILURE_THRESHOLD } from "./ProactiveTypes.ts";

export interface DeduplicationRecord {
  key: string;
  firstObservedAt: number;
  lastObservedAt: number;
  count: number;
  lastAlertedAt: number;
  escalatedToRepeatedFailure: boolean;
}

export class ProactiveDeduplicationEngine {
  private _history = new Map<string, DeduplicationRecord>();
  private _maxRecords = 200;

  /**
   * Computes a deterministic deduplication key for an event.
   */
  public computeKey(
    eventType: ProactiveEventType,
    project: string | null,
    file: string | null,
    evidence: ProactiveEvidence
  ): string {
    const projKey = (project || "default").trim().toLowerCase();
    const fileKey = (evidence.filePath || file || "root").trim().toLowerCase();
    const sigKey = (evidence.errorSignature || evidence.errorCode || "sig").trim().toLowerCase();
    return `${eventType}:${projKey}:${fileKey}:${sigKey}`;
  }

  /**
   * Records an occurrence of the deduplication key and assesses whether it
   * should be escalated to a repeated failure.
   */
  public registerOccurrence(
    key: string,
    now = Date.now()
  ): {
    repeatCount: number;
    isRepeatedFailure: boolean;
    isFirstObservation: boolean;
  } {
    let rec = this._history.get(key);
    if (!rec) {
      rec = {
        key,
        firstObservedAt: now,
        lastObservedAt: now,
        count: 1,
        lastAlertedAt: 0,
        escalatedToRepeatedFailure: false,
      };
      this._history.set(key, rec);
      this._trimHistory();
      return {
        repeatCount: 1,
        isRepeatedFailure: false,
        isFirstObservation: true,
      };
    }

    rec.count += 1;
    rec.lastObservedAt = now;

    const isRepeatedFailure = rec.count >= REPEATED_FAILURE_THRESHOLD;
    if (isRepeatedFailure && !rec.escalatedToRepeatedFailure) {
      rec.escalatedToRepeatedFailure = true;
    }

    return {
      repeatCount: rec.count,
      isRepeatedFailure,
      isFirstObservation: false,
    };
  }

  /**
   * Records that an alert was surfaced for this key.
   */
  public markAlerted(key: string, now = Date.now()): void {
    const rec = this._history.get(key);
    if (rec) {
      rec.lastAlertedAt = now;
    }
  }

  /**
   * Retrieves the current record for a key.
   */
  public getRecord(key: string): DeduplicationRecord | undefined {
    return this._history.get(key);
  }

  /**
   * Clears in-memory deduplication history (for testing or reset).
   */
  public clear(): void {
    this._history.clear();
  }

  private _trimHistory(): void {
    if (this._history.size <= this._maxRecords) return;
    const entries = Array.from(this._history.entries());
    entries.sort((a, b) => a[1].lastObservedAt - b[1].lastObservedAt);
    const toRemove = entries.slice(0, entries.length - this._maxRecords);
    for (const [k] of toRemove) {
      this._history.delete(k);
    }
  }
}

export const proactiveDeduplicationEngine = new ProactiveDeduplicationEngine();
