/**
 * MYRAA — SessionContextManager (Stage 10 Phase 1)
 *
 * Transient in-memory 50-turn ring buffer for active conversation state (Tier 1).
 *
 * Security & Privacy Invariants:
 *  - 100% RAM only — absolutely NO unsolicited disk writes
 *  - Content is passed through DLP redaction and prompt-injection defanging
 *  - Google AI API keys ("AIza...") are explicitly redacted to [REDACTED_GEMINI_KEY]
 *  - Bounded at maxRingBufferSize (50 turns): turn 51 evicts turn 1 (FIFO)
 *  - Returns defensive copies to prevent callers from mutating the ring buffer
 */

import crypto from "crypto";
import { outputDataFirewall } from "../security/OutputDataFirewall.ts";
import { contentSanitizer } from "../security/ContentSanitizer.ts";

export interface SessionContextEntry {
  turnId: string;
  timestamp: string;
  role: "user" | "assistant" | "system";
  content: string;
  sensitiveRedacted: boolean;
  topics?: string[];
}

export interface SessionContextConfig {
  maxRingBufferSize: number; // default: 50
  sessionTimeoutMs: number;  // default: 30 minutes
}

interface PartitionedSessionState {
  turns: SessionContextEntry[];
  lastActivityAt: number;
}

const DEFAULT_SESSION_ID = "default";

export class SessionContextManager {
  private _sessions: Map<string, PartitionedSessionState> = new Map();
  private _config: SessionContextConfig;

  constructor(customConfig?: Partial<SessionContextConfig>) {
    this._config = {
      maxRingBufferSize: customConfig?.maxRingBufferSize || 50,
      sessionTimeoutMs: customConfig?.sessionTimeoutMs || 30 * 60 * 1000,
    };
  }

  private _normalizeSessionId(sessionId?: string): string {
    if (typeof sessionId === "string" && sessionId.trim().length > 0) {
      return sessionId.trim();
    }
    return DEFAULT_SESSION_ID;
  }

  /**
   * Prunes any sessions whose inactivity has exceeded sessionTimeoutMs (FINDING-AUD-08).
   */
  pruneExpiredSessions(nowMs: number = Date.now()): number {
    let pruned = 0;
    for (const [sid, state] of this._sessions.entries()) {
      if (nowMs - state.lastActivityAt > this._config.sessionTimeoutMs) {
        this._sessions.delete(sid);
        pruned++;
      }
    }
    return pruned;
  }

  private _getActiveSession(sessionId?: string, nowMs: number = Date.now()): PartitionedSessionState | undefined {
    const sid = this._normalizeSessionId(sessionId);
    const state = this._sessions.get(sid);
    if (!state) return undefined;
    if (nowMs - state.lastActivityAt > this._config.sessionTimeoutMs) {
      this._sessions.delete(sid);
      return undefined;
    }
    return state;
  }

  /**
   * Appends a conversation turn into the isolated per-session transient ring buffer.
   * Performs DLP secret redaction and prompt-injection defanging.
   * Enforces sessionTimeoutMs and drops the oldest entry if buffer exceeds maxRingBufferSize.
   */
  appendTurn(
    entry: {
      role: "user" | "assistant" | "system";
      content: string;
      topics?: string[];
      sessionId?: string;
    },
    sessionIdOverride?: string,
    nowMs: number = Date.now(),
  ): SessionContextEntry {
    const sid = this._normalizeSessionId(sessionIdOverride ?? entry.sessionId);
    this.pruneExpiredSessions(nowMs);

    let sanitizedContent = entry.content || "";
    let sensitiveRedacted = false;

    // 1. Explicit Gemini API key redaction pattern (CP03.4)
    if (/AIza[0-9A-Za-z\-_]{20,}/g.test(sanitizedContent)) {
      sanitizedContent = sanitizedContent.replace(/AIza[0-9A-Za-z\-_]{20,}/g, "[REDACTED_GEMINI_KEY]");
      sensitiveRedacted = true;
    }

    // 2. DLP firewall secret sanitization (includes myraa_at_, myraa_rf_, sora_dev_, sora_conf_, Bearer, sk-, PEM)
    const dlpResult = outputDataFirewall.sanitizeResult(sanitizedContent);
    if (dlpResult.redactedCount > 0) {
      sanitizedContent = dlpResult.sanitized;
      sensitiveRedacted = true;
    }

    // 3. Prompt injection defanging
    const injectionResult = contentSanitizer.scanForPromptInjection(sanitizedContent, {
      source: `session_turn_${entry.role}`,
      identifier: sid,
    });
    if (injectionResult.hasInjectionAttempt) {
      sanitizedContent = injectionResult.sanitizedText;
      sensitiveRedacted = true;
    }

    const turn: SessionContextEntry = {
      turnId: crypto.randomUUID(),
      timestamp: new Date(nowMs).toISOString(),
      role: entry.role,
      content: sanitizedContent,
      sensitiveRedacted,
      topics: entry.topics ? [...entry.topics] : undefined,
    };

    let state = this._getActiveSession(sid, nowMs);
    if (!state) {
      state = { turns: [], lastActivityAt: nowMs };
      this._sessions.set(sid, state);
    }

    // FIFO eviction on capacity overflow (per-session bounded)
    while (state.turns.length >= this._config.maxRingBufferSize) {
      state.turns.shift();
    }

    state.turns.push(turn);
    state.lastActivityAt = nowMs;
    return { ...turn };
  }

  /**
   * Returns a defensive deep copy of all turns for the specified session in FIFO order.
   * Never leaks turns from other sessions; returns [] if session expired or absent.
   */
  getTurns(sessionId?: string, nowMs: number = Date.now()): SessionContextEntry[] {
    const state = this._getActiveSession(sessionId, nowMs);
    if (!state) return [];
    return state.turns.map((t) => ({
      ...t,
      topics: t.topics ? [...t.topics] : undefined,
    }));
  }

  /**
   * Clears turns for a specific session (or all sessions if clearAll is true).
   */
  clearSession(sessionId?: string): void {
    if (sessionId === undefined) {
      this._sessions.delete(DEFAULT_SESSION_ID);
      return;
    }
    this._sessions.delete(this._normalizeSessionId(sessionId));
  }

  /**
   * Clears every partitioned session buffer from memory.
   */
  clearAllSessions(): void {
    this._sessions.clear();
  }

  getTurnCount(sessionId?: string, nowMs: number = Date.now()): number {
    const state = this._getActiveSession(sessionId, nowMs);
    return state ? state.turns.length : 0;
  }

  getLastTurn(sessionId?: string, nowMs: number = Date.now()): SessionContextEntry | undefined {
    const state = this._getActiveSession(sessionId, nowMs);
    if (!state || state.turns.length === 0) return undefined;
    const last = state.turns[state.turns.length - 1];
    return {
      ...last,
      topics: last.topics ? [...last.topics] : undefined,
    };
  }

  listActiveSessionIds(nowMs: number = Date.now()): string[] {
    this.pruneExpiredSessions(nowMs);
    return Array.from(this._sessions.keys());
  }
}

export const sessionContextManager = new SessionContextManager();
