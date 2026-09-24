/**
 * MYRAA — SecurityAuditLogger (Phase 10A)
 *
 * Tamper-evident, cryptographically hash-chained security audit logger.
 *
 * Features:
 *   • SHA-256 hash chaining: each audit record is cryptographically linked
 *     to the previous record's hash (forming a tamper-evident audit ledger).
 *   • Strictly redacts secrets, credentials, API keys, passwords, and bearer tokens.
 *   • Fast query interfaces for incident investigation and rate limiting.
 *   • Complete chain integrity verification.
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import type {
  SecurityAuditEvent,
  CanonicalAuditRecord,
  AuditEventType,
  DecisionType,
  RiskLevel,
  IdentityRole,
} from "./SecurityTypes.ts";

const GENESIS_HASH = "0".repeat(64);

export class SecurityAuditLogger {
  private _events: SecurityAuditEvent[] = [];
  private _latestHash: string = GENESIS_HASH;
  private _maxInMemoryEvents = 5000;
  private _logFilePath: string;

  private _listeners: Array<(event: SecurityAuditEvent) => void> = [];

  constructor(logFilePath?: string) {
    const defaultLogPath = path.resolve(process.env.SORA_WORKSPACE_DIR || process.cwd(), "logs/security_audit.jsonl");
    this._logFilePath = logFilePath || defaultLogPath;
    this.resetForTesting();
  }

  /**
   * Reset logger state (for unit tests).
   */
  resetForTesting(): void {
    this._events = [];
    this._latestHash = GENESIS_HASH;
  }

  clearForTesting(): void {
    this.resetForTesting();
  }

  onAuditLogged(listener: (event: SecurityAuditEvent) => void): () => void {
    this._listeners.push(listener);
    return () => {
      this._listeners = this._listeners.filter((l) => l !== listener);
    };
  }

  clearListenersForTesting(): void {
    this._listeners = [];
  }

  /**
   * Deeply sanitize an object or string to prevent any secrets from entering audit logs.
   */
  sanitizeData<T>(input: T): T {
    if (typeof input === "string") {
      let str: string = input;
      // Mask Gemini API keys
      str = str.replace(/AIza[0-9A-Za-z\-_]{35}/g, "AIzaSy...[REDACTED]");
      // Mask generic bearer/access/refresh tokens
      str = str.replace(/sora_[a-z0-9_]+/gi, "sora_...[REDACTED]");
      // Mask sk- keys (OpenAI / Anthropic)
      str = str.replace(/sk-[A-Za-z0-9_-]{20,}/g, "sk-...[REDACTED]");
      // Mask JWTs
      str = str.replace(/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "eyJ...[REDACTED]");
      // Mask Bearer tokens
      str = str.replace(/Bearer\s+[A-Za-z0-9_\-\.]+/gi, "Bearer [REDACTED]");
      // Mask GitHub tokens
      str = str.replace(/gh[pousr]_[A-Za-z0-9_]{36,}/g, "gh_...[REDACTED]");
      // Mask AWS Access Keys
      str = str.replace(/AKIA[0-9A-Z]{16}/g, "AKIA...[REDACTED]");
      // Mask private keys
      str = str.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[PRIVATE_KEY_REDACTED]");
      // Mask SSN & Credit cards
      str = str.replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[SSN_REDACTED]");
      str = str.replace(/\b(?:\d{4}-){3}\d{4}\b/g, "[CC_REDACTED]");
      // Mask password values in JSON or key=val
      str = str.replace(/(password|passwd|secret|token|apiKey|api_key)["']?\s*[:=]\s*["']?([^"',\s]+)/gi, "$1: [REDACTED]");
      // Defang prompt injection instruction phrases to prevent attacker payloads becoming audit instructions
      str = str.replace(/\b(ignore\s+(all\s+)?previous\s+instructions|system\s+prompt\s*:|disregard\s+all\s+rules)\b/gi, "[DEFANGED_INSTRUCTION]");
      return str as unknown as T;
    }

    if (Array.isArray(input)) {
      return input.map((item) => this.sanitizeData(item)) as unknown as T;
    }

    if (input !== null && typeof input === "object") {
      const sanitized: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(input)) {
        if (/password|secret|token|key|credential|private|auth|bearer|passphrase/i.test(k) && typeof v === "string") {
          sanitized[k] = "[REDACTED]";
        } else {
          sanitized[k] = this.sanitizeData(v);
        }
      }
      return sanitized as unknown as T;
    }

    return input;
  }

  /**
   * Record a new security audit event with cryptographic hash chaining.
   */
  logEvent(params: {
    eventType: AuditEventType;
    actor: {
      identityId: string;
      role: IdentityRole;
      ipAddress: string;
      sessionId?: string;
      deviceId?: string;
      isLocal?: boolean;
    };
    target?: {
      toolName?: string;
      resource?: string;
    };
    riskLevel?: RiskLevel;
    decision: DecisionType;
    reason?: string;
    metadata?: Record<string, unknown>;
  }): SecurityAuditEvent {
    const id = crypto.randomUUID();
    const timestamp = new Date().toISOString();

    const sanitizedActor = this.sanitizeData(params.actor);
    const sanitizedTarget = params.target ? this.sanitizeData(params.target) : undefined;
    const sanitizedReason = params.reason ? this.sanitizeData(params.reason) : undefined;
    const sanitizedMeta = params.metadata ? this.sanitizeData(params.metadata) : undefined;

    const deviceSession = `${sanitizedActor?.deviceId || "unknown"}:${sanitizedActor?.sessionId || "local"}`;
    const tool = sanitizedTarget?.toolName || (sanitizedMeta?.toolName as string) || "system";
    const action = params.eventType;
    const riskLevel = params.riskLevel || "LOW";

    const prevHash = this._latestHash;

    // Compute canonical SHA-256 hash
    const canonicalPayload = JSON.stringify({
      prevHash,
      id,
      timestamp,
      eventType: params.eventType,
      actor: sanitizedActor,
      target: sanitizedTarget,
      riskLevel: params.riskLevel,
      decision: params.decision,
      reason: sanitizedReason,
      metadata: sanitizedMeta,
      eventId: id,
      deviceSession,
      action,
      tool,
    });

    const currentHash = crypto.createHash("sha256").update(canonicalPayload).digest("hex");

    const auditEvent: SecurityAuditEvent = {
      id,
      timestamp,
      eventType: params.eventType,
      actor: sanitizedActor,
      target: sanitizedTarget,
      riskLevel: params.riskLevel,
      decision: params.decision,
      reason: sanitizedReason,
      metadata: sanitizedMeta,
      prevHash,
      hash: currentHash,
      eventId: id,
      deviceSession,
      action,
      tool,
    };

    this._events.push(auditEvent);
    this._latestHash = currentHash;

    if (this._events.length > this._maxInMemoryEvents) {
      this._events.shift();
    }

    // Append-only persistence
    this._appendToFile(this.toCanonicalRecord(auditEvent));

    for (const listener of this._listeners) {
      try {
        listener(auditEvent);
      } catch (err) {
        console.warn("[SecurityAuditLogger] Listener error:", err);
      }
    }

    return auditEvent;
  }

  private _appendToFile(record: CanonicalAuditRecord): void {
    try {
      const logsDir = path.dirname(this._logFilePath);
      if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
      }
      fs.appendFileSync(this._logFilePath, JSON.stringify(record) + "\n", { encoding: "utf-8" });
    } catch {
      // Non-blocking fallback in restricted or read-only test environments
    }
  }

  /**
   * Convert any SecurityAuditEvent into its immutable, canonical audit record representation.
   */
  toCanonicalRecord(ev: SecurityAuditEvent): Readonly<CanonicalAuditRecord> {
    const record: CanonicalAuditRecord = {
      timestamp: ev.timestamp,
      eventId: ev.id,
      deviceSession: ev.deviceSession || `${ev.actor?.deviceId || "unknown"}:${ev.actor?.sessionId || "local"}`,
      action: ev.action || ev.eventType,
      tool: ev.tool || ev.target?.toolName || (ev.metadata?.toolName as string) || "system",
      riskLevel: ev.riskLevel || "LOW",
      decision: ev.decision,
      reason: ev.reason || "",
      metadata: ev.metadata,
      prevHash: ev.prevHash,
      hash: ev.hash,
    };
    return Object.freeze(record);
  }

  /**
   * Returns immutable, frozen canonical records for all in-memory events.
   */
  getCanonicalEvents(limit = 100): Readonly<CanonicalAuditRecord>[] {
    return this._events.slice(-limit).map((e) => this.toCanonicalRecord(e));
  }

  /**
   * Query events by exact security decision type.
   */
  getEventsByDecision(decision: DecisionType): SecurityAuditEvent[] {
    return this._events.filter((e) => e.decision === decision);
  }

  /**
   * Query events by target tool name.
   */
  getEventsByTool(toolName: string): SecurityAuditEvent[] {
    return this._events.filter((e) => e.tool === toolName || e.target?.toolName === toolName);
  }

  /**
   * Verify cryptographic hash chain integrity of all in-memory audit logs.
   * Returns true if chain is unbroken; false if tampering or truncation is detected.
   */
  verifyChainIntegrity(): { valid: boolean; brokenAtEventId?: string; reason?: string } {
    let expectedPrevHash = GENESIS_HASH;

    for (let i = 0; i < this._events.length; i++) {
      const ev = this._events[i];

      // Check link to previous hash
      if (ev.prevHash !== expectedPrevHash) {
        return {
          valid: false,
          brokenAtEventId: ev.id,
          reason: `Hash chain broken at index ${i}: prevHash mismatch. Expected ${expectedPrevHash}, got ${ev.prevHash}`,
        };
      }

      // Recompute hash
      const canonicalPayload = JSON.stringify({
        prevHash: ev.prevHash,
        id: ev.id,
        timestamp: ev.timestamp,
        eventType: ev.eventType,
        actor: ev.actor,
        target: ev.target,
        riskLevel: ev.riskLevel,
        decision: ev.decision,
        reason: ev.reason,
        metadata: ev.metadata,
        eventId: ev.eventId || ev.id,
        deviceSession: ev.deviceSession || `${ev.actor?.deviceId || "unknown"}:${ev.actor?.sessionId || "local"}`,
        action: ev.action || ev.eventType,
        tool: ev.tool || ev.target?.toolName || (ev.metadata?.toolName as string) || "system",
      });

      const recomputedHash = crypto.createHash("sha256").update(canonicalPayload).digest("hex");
      if (recomputedHash !== ev.hash) {
        return {
          valid: false,
          brokenAtEventId: ev.id,
          reason: `Record content tampering detected at index ${i} (${ev.id}). Recomputed hash does not match stored hash.`,
        };
      }

      expectedPrevHash = ev.hash;
    }

    return { valid: true };
  }

  /**
   * Query recent events.
   */
  getRecentEvents(limit = 100): SecurityAuditEvent[] {
    return this._events.slice(-limit);
  }

  /**
   * Query events for a specific session ID.
   */
  getEventsBySession(sessionId: string): SecurityAuditEvent[] {
    return this._events.filter((e) => e.actor?.sessionId === sessionId);
  }

  /**
   * Query events for a specific IP address.
   */
  getEventsByIp(ipAddress: string): SecurityAuditEvent[] {
    return this._events.filter((e) => e.actor?.ipAddress === ipAddress);
  }

  /**
   * Count events matching an event type and optional IP within a time window (in ms).
   */
  countEventsInWindow(
    eventType: AuditEventType,
    windowMs: number,
    filter?: { ipAddress?: string; sessionId?: string },
  ): number {
    const cutoff = Date.now() - windowMs;
    return this._events.filter((e) => {
      if (e.eventType !== eventType) return false;
      const eventTime = new Date(e.timestamp).getTime();
      if (eventTime < cutoff) return false;
      if (filter?.ipAddress && e.actor?.ipAddress !== filter.ipAddress) return false;
      if (filter?.sessionId && e.actor?.sessionId !== filter.sessionId) return false;
      return true;
    }).length;
  }
}

export const securityAuditLogger = new SecurityAuditLogger();
