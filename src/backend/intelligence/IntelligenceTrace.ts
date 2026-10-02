/**
 * MYRAA — IntelligenceTrace
 *
 * Maintains a high-performance in-memory ring buffer of sanitized intelligence traces:
 * USER_INPUT -> INTENT -> CONTEXT -> GOAL -> CANDIDATE ACTIONS -> SELECTED ACTION -> VERIFICATION -> RESULT
 *
 * Strictly redacts secrets, tokens, passwords, private keys, and authorization headers.
 */

import crypto from "crypto";
import type { IntelligenceTraceRecord } from "./IntelligenceTypes.ts";

export class IntelligenceTraceManager {
  private static readonly MAX_TRACES = 200;
  private _traces: IntelligenceTraceRecord[] = [];

  /**
   * Sanitizes a string or object by masking any accidental credentials, tokens, or private secrets.
   */
  public sanitizeData<T>(data: T): T {
    if (!data) return data;
    if (typeof data === "string") {
      let str: string = data as unknown as string;
      // Mask bearer tokens, API keys, private passwords, and hashes
      str = str.replace(/(api[_-]?key|token|bearer|secret|password|credential)["'\s:=]+([\w.-]{8,})/gi, "$1: [REDACTED]");
      str = str.replace(/AIza[0-9A-Za-z-_]{35}/g, "[REDACTED_GEMINI_KEY]");
      str = str.replace(/(sk-[a-zA-Z0-9_-]{20,})/g, "[REDACTED_KEY]");
      return (str as unknown) as T;
    }

    if (typeof data === "object") {
      if (Array.isArray(data)) {
        return data.map((item) => this.sanitizeData(item)) as unknown as T;
      }
      const sanitizedObj: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
        if (/token|secret|password|key|auth|credential/i.test(key)) {
          sanitizedObj[key] = "[REDACTED]";
        } else {
          sanitizedObj[key] = this.sanitizeData(value);
        }
      }
      return sanitizedObj as unknown as T;
    }

    return data;
  }

  /**
   * Record a new intelligence execution trace.
   */
  public recordTrace(
    record: Omit<IntelligenceTraceRecord, "traceId" | "sanitized" | "timestamp"> & { timestamp?: number }
  ): IntelligenceTraceRecord {
    const traceId = `trace_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
    const sanitizedTrace: IntelligenceTraceRecord = {
      traceId,
      timestamp: record.timestamp || Date.now(),
      durationMs: record.durationMs || 0,
      userInput: this.sanitizeData(record.userInput),
      intent: record.intent,
      context: this.sanitizeData(record.context),
      goal: this.sanitizeData(record.goal),
      candidateActions: this.sanitizeData(record.candidateActions),
      selectedAction: this.sanitizeData(record.selectedAction),
      verification: this.sanitizeData(record.verification),
      result: this.sanitizeData(record.result),
      sanitized: true,
    };

    this._traces.unshift(sanitizedTrace);
    if (this._traces.length > IntelligenceTraceManager.MAX_TRACES) {
      this._traces.length = IntelligenceTraceManager.MAX_TRACES;
    }

    return sanitizedTrace;
  }

  /**
   * Retrieve a trace by its unique ID.
   */
  public getTrace(traceId: string): IntelligenceTraceRecord | null {
    return this._traces.find((t) => t.traceId === traceId) || null;
  }

  /**
   * List recent traces up to limit.
   */
  public listTraces(limit = 50): IntelligenceTraceRecord[] {
    return this._traces.slice(0, Math.max(1, Math.min(200, limit)));
  }

  /**
   * Clear all traces (useful for tests or security audit reset).
   */
  public clearTraces(): void {
    this._traces = [];
  }
}

export const intelligenceTrace = new IntelligenceTraceManager();
