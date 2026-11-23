/**
 * MYRAA — Runtime Observability, Structured Diagnostics & Health Monitoring (Phase 11.6)
 *
 * Provides trustworthy, security-first operational visibility:
 *   1. Deep recursive redaction of secrets, tokens, credentials, and private keys.
 *   2. Standardized structured diagnostic events with consistent severity levels.
 *   3. Bounded NDJSON file logging with automatic size-based log rotation (max 5MB, 3 backups).
 *   4. Bounded in-memory event ring buffer (max 500 events).
 *   5. Fixed-cardinality performance & reliability metric counters/aggregates (zero high-cardinality leakage).
 *   6. Distinct liveness, readiness, and authenticated component health monitors.
 *   7. Operation correlation tracing without authorization authority.
 *   8. Zero-crash defensive architecture: logging or diagnostic errors NEVER crash primary application flows.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { DATA_DIR } from "../server_paths.ts";

// ---------------------------------------------------------------------------
// Configuration & Limits
// ---------------------------------------------------------------------------

export const MAX_LOG_FILE_SIZE = 5 * 1024 * 1024; // 5 MB per file
export const MAX_ROTATED_FILES = 3;
export const MAX_IN_MEMORY_EVENTS = 500;
export const MAX_TIMING_SAMPLES = 100;

export const SENSITIVE_KEY_PATTERN =
  /(password|passwd|passcode|secret|token|checkpoint|proof|key|credential|private|auth|bearer|passphrase|signature)/i;

export const SAFE_CORRELATION_KEYS = new Set([
  "tokenId",
  "planId",
  "stepId",
  "correlationId",
  "sessionId",
  "actorId",
  "deviceId",
  "projectId",
  "toolName",
  "module",
  "event",
]);

// ---------------------------------------------------------------------------
// 1. Deep Recursive Redaction Engine
// ---------------------------------------------------------------------------

/**
 * Sanitizes a string, redacting all known API keys, tokens, credentials, and private URLs.
 */
export function sanitizeDiagnosticString(input: string): string {
  if (typeof input !== "string") return String(input || "");
  let str = input;

  // 1. Sensitive environment variable assignments (e.g. GEMINI_API_KEY=..., MYRAA_SECURITY_SECRET=...)
  str = str.replace(
    /(?:GEMINI_API_KEY|MYRAA_SECURITY_SECRET|SORA_REMOTE_SECRET|MYRAA_MASTER_KEY)\s*[:=]\s*[^\s\r\n]+/gi,
    "[ENV_KEY_REDACTED]",
  );

  // 2. Google API keys (standard 39-char and synthetic AIza... keys)
  str = str.replace(/AIza[0-9A-Za-z\-_]{16,}/g, "AIza...[REDACTED]");

  // 3. Gemini ephemeral tokens
  str = str.replace(/AQ\.[0-9A-Za-z\-_.]{10,}/g, "AQ...[REDACTED]");

  // 4. OAuth access tokens
  str = str.replace(/ya29\.[0-9A-Za-z\-_.]{10,}/g, "ya29...[REDACTED]");

  // 5. Sora / Myraa tokens & session keys
  str = str.replace(/(?:sora|myraa)_[A-Za-z0-9_\-.]+/gi, "myraa_...[REDACTED]");

  // 6. Bearer tokens
  str = str.replace(/Bearer\s+[A-Za-z0-9_\-\.]+/gi, "Bearer [REDACTED]");

  // 7. sk- keys (OpenAI / Anthropic / third-party)
  str = str.replace(/sk-[A-Za-z0-9_-]{20,}/g, "sk-...[REDACTED]");

  // 8. JWT 2-part and 3-part signatures
  str = str.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?/g, "eyJ...[REDACTED]");

  // 9. PEM Private keys
  str = str.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[PRIVATE_KEY_REDACTED]");

  // 10. Private URLs with secret parameters in query strings
  str = str.replace(
    /([?&])(key|token|secret|apiKey|api_key|password|code|pairingCode|auth)=([^&]+)/gi,
    "$1$2=[REDACTED]",
  );

  // 11. Key-value credential patterns in json or console strings
  str = str.replace(
    /(password|passwd|passcode|secret|token|checkpointId|_checkpointId|apiKey|api_key|proof|authorization|credential)["']?\s*[:=]\s*["']?(?!\[REDACTED\]|\[ENV_KEY_REDACTED\]|AIza\.\.\.\[REDACTED\])([^"',\s}]+)/gi,
    "$1: [REDACTED]",
  );

  // 12. Defang prompt injection instruction phrases
  str = str.replace(
    /\b(ignore\s+(all\s+)?previous\s+instructions|system\s+prompt\s*:|disregard\s+all\s+rules)\b/gi,
    "[DEFANGED_INSTRUCTION]",
  );

  return str;
}

/**
 * Deeply sanitizes any value (string, object, array, Error) recursively.
 * Employs a WeakSet to prevent infinite recursion on circular object graphs.
 */
export function deepSanitizeDiagnostic<T>(input: T, seen = new WeakSet<object>()): T {
  if (input === null || input === undefined) {
    return input;
  }

  if (typeof input === "string") {
    return sanitizeDiagnosticString(input) as unknown as T;
  }

  if (typeof input === "number" || typeof input === "boolean" || typeof input === "bigint") {
    return input;
  }

  if (input instanceof Error) {
    const sanitizedError: Record<string, unknown> = {
      name: input.name,
      message: sanitizeDiagnosticString(input.message),
    };
    if (input.stack) {
      sanitizedError.stack = sanitizeDiagnosticString(input.stack);
    }
    return sanitizedError as unknown as T;
  }

  if (Array.isArray(input)) {
    if (seen.has(input)) return "[CIRCULAR]" as unknown as T;
    seen.add(input);
    return input.map((item) => deepSanitizeDiagnostic(item, seen)) as unknown as T;
  }

  if (typeof input === "object") {
    if (seen.has(input)) return "[CIRCULAR]" as unknown as T;
    seen.add(input);

    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      // If the key itself indicates a sensitive credential and is not a safe trace identifier, redact it
      if (SENSITIVE_KEY_PATTERN.test(key) && !SAFE_CORRELATION_KEYS.has(key)) {
        sanitized[key] = "[REDACTED]";
      } else {
        sanitized[key] = deepSanitizeDiagnostic(value, seen);
      }
    }
    return sanitized as unknown as T;
  }

  return input;
}

// ---------------------------------------------------------------------------
// 2. Structured Diagnostic Event Schema
// ---------------------------------------------------------------------------

export type DiagnosticSeverity = "info" | "warn" | "error";

export type DiagnosticModule =
  | "gateway"
  | "gemini_live"
  | "tasks"
  | "planner"
  | "reminders"
  | "voice"
  | "security"
  | "desktop_agent"
  | "storage"
  | "companion"
  | "system";

export type DiagnosticOutcome =
  | "success"
  | "failure"
  | "rejected"
  | "timeout"
  | "interrupted"
  | "pending"
  | "degraded";

export interface StructuredDiagnosticEvent {
  timestamp?: string; // ISO 8601
  severity: DiagnosticSeverity;
  module: DiagnosticModule | string;
  event: string;
  correlationId?: string;
  sessionId?: string;
  durationMs?: number;
  outcome?: DiagnosticOutcome | string;
  errorCategory?: string;
  recoveryAction?: string;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 3. Performance & Reliability Metrics Registry
// ---------------------------------------------------------------------------

export type TimingMetricName =
  | "api_request_duration_ms"
  | "task_step_duration_ms"
  | "desktop_agent_rpc_duration_ms"
  | "gemini_connect_duration_ms"
  | "voice_turn_duration_ms";

export type CounterMetricName =
  | "gemini_live_connections_total"
  | "gemini_live_reconnects_total"
  | "gemini_live_errors_total"
  | "voice_session_turns_total"
  | "voice_session_errors_total"
  | "reminder_scheduled_total"
  | "reminder_claimed_total"
  | "reminder_delivered_total"
  | "reminder_delivery_failed_total"
  | "task_executed_total"
  | "task_recovery_attempted_total"
  | "task_recovery_success_total"
  | "desktop_agent_rpc_errors_total"
  | "storage_errors_total";

interface TimingSummary {
  count: number;
  totalMs: number;
  minMs: number;
  maxMs: number;
  avgMs: number;
  p95Ms: number;
  samples: number[];
}

export class RuntimeMetricsRegistry {
  private _counters = new Map<CounterMetricName, number>();
  private _timings = new Map<TimingMetricName, TimingSummary>();

  constructor() {
    this.resetForTesting();
  }

  resetForTesting(): void {
    this._counters.clear();
    this._timings.clear();
  }

  incrementCounter(name: CounterMetricName, amount = 1): void {
    if (typeof amount !== "number" || isNaN(amount) || amount <= 0) amount = 1;
    const current = this._counters.get(name) || 0;
    this._counters.set(name, current + amount);
  }

  getCounter(name: CounterMetricName): number {
    return this._counters.get(name) || 0;
  }

  recordTiming(name: TimingMetricName, durationMs: number): void {
    if (typeof durationMs !== "number" || isNaN(durationMs) || durationMs < 0) return;
    const rounded = Math.round(durationMs * 10) / 10;

    let summary = this._timings.get(name);
    if (!summary) {
      summary = {
        count: 0,
        totalMs: 0,
        minMs: rounded,
        maxMs: rounded,
        avgMs: rounded,
        p95Ms: rounded,
        samples: [],
      };
      this._timings.set(name, summary);
    }

    summary.count += 1;
    summary.totalMs += rounded;
    summary.minMs = Math.min(summary.minMs, rounded);
    summary.maxMs = Math.max(summary.maxMs, rounded);
    summary.avgMs = Math.round((summary.totalMs / summary.count) * 10) / 10;

    summary.samples.push(rounded);
    if (summary.samples.length > MAX_TIMING_SAMPLES) {
      summary.samples.shift();
    }

    // Compute p95 over current bounded sample window
    const sorted = [...summary.samples].sort((a, b) => a - b);
    const p95Idx = Math.floor(sorted.length * 0.95);
    summary.p95Ms = sorted[Math.min(p95Idx, sorted.length - 1)];
  }

  getTimingSummary(name: TimingMetricName): Omit<TimingSummary, "samples"> | null {
    const summary = this._timings.get(name);
    if (!summary) return null;
    return {
      count: summary.count,
      totalMs: Math.round(summary.totalMs * 10) / 10,
      minMs: summary.minMs,
      maxMs: summary.maxMs,
      avgMs: summary.avgMs,
      p95Ms: summary.p95Ms,
    };
  }

  getMetricsSummary(): Record<string, unknown> {
    const countersObj: Record<string, number> = {};
    for (const [k, v] of this._counters.entries()) {
      countersObj[k] = v;
    }

    const timingsObj: Record<string, unknown> = {};
    for (const [k] of this._timings.entries()) {
      timingsObj[k] = this.getTimingSummary(k);
    }

    return {
      uptimeSeconds: Math.floor(process.uptime()),
      collectedAt: new Date().toISOString(),
      counters: countersObj,
      timings: timingsObj,
    };
  }
}

export const runtimeMetrics = new RuntimeMetricsRegistry();

// ---------------------------------------------------------------------------
// 4. Bounded Storage & Automatic Log Rotation
// ---------------------------------------------------------------------------

export class BoundedLogStore {
  private _logsDir: string;
  private _inMemoryEvents: StructuredDiagnosticEvent[] = [];

  constructor(logsDir?: string) {
    this._logsDir = logsDir || path.join(DATA_DIR, "logs");
    try {
      fs.mkdirSync(this._logsDir, { recursive: true });
    } catch {
      /* already exists */
    }
  }

  getLogsDir(): string {
    return this._logsDir;
  }

  resetForTesting(): void {
    this._inMemoryEvents = [];
  }

  /**
   * Safely checks file size and rotates logs if size exceeds MAX_LOG_FILE_SIZE.
   */
  rotateLogFileIfNeeded(filePath: string): void {
    try {
      if (!fs.existsSync(filePath)) return;
      const stat = fs.statSync(filePath);
      if (stat.size < MAX_LOG_FILE_SIZE) return;

      // Rotate: file.3 is dropped, file.2 -> file.3, file.1 -> file.2, file -> file.1
      for (let i = MAX_ROTATED_FILES - 1; i >= 1; i--) {
        const source = `${filePath}.${i}`;
        const target = `${filePath}.${i + 1}`;
        if (fs.existsSync(source)) {
          try {
            fs.renameSync(source, target);
          } catch {
            /* ignore rename race */
          }
        }
      }

      const firstBackup = `${filePath}.1`;
      try {
        fs.renameSync(filePath, firstBackup);
      } catch {
        /* ignore */
      }
    } catch {
      /* best effort rotation */
    }
  }

  /**
   * Records a structured diagnostic event:
   *  1. Deeply redacts all metadata and strings
   *  2. Buffers in memory (bounded to MAX_IN_MEMORY_EVENTS)
   *  3. Rotates app.log.json if needed
   *  4. Appends to app.log.json
   */
  recordEvent(event: StructuredDiagnosticEvent): StructuredDiagnosticEvent {
    try {
      const sanitized = deepSanitizeDiagnostic(event);
      if (!sanitized.timestamp) {
        sanitized.timestamp = new Date().toISOString();
      }

      // Add to bounded in-memory buffer
      this._inMemoryEvents.push(sanitized);
      if (this._inMemoryEvents.length > MAX_IN_MEMORY_EVENTS) {
        this._inMemoryEvents.shift();
      }

      // Record to disk
      const logFile = path.join(this._logsDir, "app.log.json");
      this.rotateLogFileIfNeeded(logFile);

      const line = JSON.stringify(sanitized) + "\n";
      fs.appendFileSync(logFile, line, { encoding: "utf-8" });

      return sanitized;
    } catch {
      // Never throw from logging
      return event;
    }
  }

  /**
   * Safely appends a message to a text log file (e.g. commands.log, startup.log, errors.log).
   * Automatically redacts and checks rotation.
   */
  appendPlainText(fileName: string, message: string): void {
    try {
      const logFile = path.join(this._logsDir, fileName);
      this.rotateLogFileIfNeeded(logFile);

      const sanitizedMsg = sanitizeDiagnosticString(message);
      const line = `[${new Date().toISOString()}] ${sanitizedMsg}\n`;
      fs.appendFileSync(logFile, line, { encoding: "utf-8" });
    } catch {
      /* best effort plain text append */
    }
  }

  getRecentEvents(limit = 100): StructuredDiagnosticEvent[] {
    const safeLimit = Math.max(1, Math.min(limit, MAX_IN_MEMORY_EVENTS));
    return this._inMemoryEvents.slice(-safeLimit);
  }
}

export const boundedLogStore = new BoundedLogStore();

// ---------------------------------------------------------------------------
// 5. Operation Correlation Tracer
// ---------------------------------------------------------------------------

export class CorrelationTracer {
  /**
   * Generates a unique, non-authorizing diagnostic correlation ID.
   * Format: `corr_<prefix>_<uuid>`
   */
  generateCorrelationId(prefix = "op"): string {
    const cleanPrefix = prefix.replace(/[^a-zA-Z0-9_-]/g, "").substring(0, 16);
    return `corr_${cleanPrefix}_${crypto.randomUUID()}`;
  }

  /**
   * Validates that an incoming correlation ID is well-formed.
   * Strips any untrusted injection attempts and ensures length limits.
   */
  sanitizeCorrelationId(rawId: unknown): string {
    if (!rawId || typeof rawId !== "string") {
      return this.generateCorrelationId("auto");
    }
    const clean = rawId.trim().replace(/[^a-zA-Z0-9_\-]/g, "");
    if (clean.length === 0 || clean.length > 80) {
      return this.generateCorrelationId("sanitized");
    }
    return clean;
  }
}

export const correlationTracer = new CorrelationTracer();

// ---------------------------------------------------------------------------
// 6. Runtime Health & Readiness Monitor
// ---------------------------------------------------------------------------

export interface LivenessStatus {
  live: true;
  service: "myraa-backend";
  uptimeSeconds: number;
  timestamp: string;
}

export interface ReadinessStatus {
  ready: boolean;
  status: "ready" | "degraded" | "not_ready";
  timestamp: string;
  limitations: string[];
}

export interface ComponentHealthStatus {
  status: "ok" | "degraded" | "error";
  service: string;
  version: string;
  uptimeSeconds: number;
  timestamp: string;
  components: {
    storage: { status: "ok" | "error"; writable: boolean; details?: string };
    securityPolicy: { status: "ok" | "degraded"; mode: string };
    emergencyStop: { status: "ok" | "degraded"; active: boolean };
    geminiLive: { status: "ok" | "degraded"; hasApiKey: boolean };
    reminders: { status: "ok"; scheduler: "running" };
    taskOrchestrator: { status: "ok"; engine: "ready" };
  };
}

export class RuntimeHealthMonitor {
  /**
   * Liveness Probe — confirms process is executing and event loop is responsive.
   * Never mutates state or queries slow external dependencies.
   */
  getLiveness(): LivenessStatus {
    return {
      live: true,
      service: "myraa-backend",
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Readiness Probe — confirms service can safely accept requests.
   * Returns degraded if under Emergency Stop, Security Lockdown, or if storage is read-only.
   */
  async getReadiness(): Promise<ReadinessStatus> {
    const limitations: string[] = [];
    let isStorageWritable = true;

    // Check storage writability without mutating business data
    try {
      const probeFile = path.join(DATA_DIR, ".health_probe.tmp");
      fs.writeFileSync(probeFile, "1");
      fs.unlinkSync(probeFile);
    } catch (e: any) {
      isStorageWritable = false;
      limitations.push(`STORAGE_NOT_WRITABLE: ${e?.message || "Storage directory probe failed"}`);
    }

    let isEmergencyStopped = false;
    let isLockedDown = false;

    try {
      const { emergencyStopCoordinator } = await import("../remote/EmergencyStopCoordinator.ts");
      isEmergencyStopped = emergencyStopCoordinator.isActive();
      if (isEmergencyStopped) {
        limitations.push("EMERGENCY_STOP_ACTIVE: High-risk operations halted by operator");
      }
    } catch {
      /* fallback */
    }

    try {
      const { securityPolicyEngine } = await import("../security/SecurityPolicyEngine.ts");
      isLockedDown = securityPolicyEngine.getMode() === "LOCKDOWN";
      if (isLockedDown) {
        limitations.push("SECURITY_LOCKDOWN_ACTIVE: Tool execution restricted to SAFE mode");
      }
    } catch {
      /* fallback */
    }

    if (!isStorageWritable) {
      return {
        ready: false,
        status: "not_ready",
        timestamp: new Date().toISOString(),
        limitations,
      };
    }

    if (isEmergencyStopped || isLockedDown) {
      return {
        ready: true,
        status: "degraded",
        timestamp: new Date().toISOString(),
        limitations,
      };
    }

    return {
      ready: true,
      status: "ready",
      timestamp: new Date().toISOString(),
      limitations: [],
    };
  }

  /**
   * Authenticated Component Health — provides granular component visibility for operators.
   * Masks secrets and prevents side-effects.
   */
  async getComponentHealth(): Promise<ComponentHealthStatus> {
    let mode = "NORMAL";
    let isEmergencyStopped = false;

    try {
      const { securityPolicyEngine } = await import("../security/SecurityPolicyEngine.ts");
      mode = securityPolicyEngine.getMode();
    } catch {}

    try {
      const { emergencyStopCoordinator } = await import("../remote/EmergencyStopCoordinator.ts");
      isEmergencyStopped = emergencyStopCoordinator.isActive();
    } catch {}

    let storageWritable = true;
    try {
      const probeFile = path.join(DATA_DIR, ".health_probe.tmp");
      fs.writeFileSync(probeFile, "1");
      fs.unlinkSync(probeFile);
    } catch {
      storageWritable = false;
    }

    const hasKey = Boolean(process.env.GEMINI_API_KEY || process.env.MYRAA_API_KEY);

    const overallStatus: "ok" | "degraded" | "error" =
      !storageWritable ? "error" : isEmergencyStopped || mode === "LOCKDOWN" ? "degraded" : "ok";

    return {
      status: overallStatus,
      service: "myraa-backend",
      version: "2.0.0",
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      components: {
        storage: {
          status: storageWritable ? "ok" : "error",
          writable: storageWritable,
        },
        securityPolicy: {
          status: mode === "LOCKDOWN" ? "degraded" : "ok",
          mode,
        },
        emergencyStop: {
          status: isEmergencyStopped ? "degraded" : "ok",
          active: isEmergencyStopped,
        },
        geminiLive: {
          status: hasKey ? "ok" : "degraded",
          hasApiKey: hasKey,
        },
        reminders: {
          status: "ok",
          scheduler: "running",
        },
        taskOrchestrator: {
          status: "ok",
          engine: "ready",
        },
      },
    };
  }
}

export const runtimeHealthMonitor = new RuntimeHealthMonitor();

// ---------------------------------------------------------------------------
// 7. Backward-Compatible Logging Facade Helpers
// ---------------------------------------------------------------------------

/**
 * Standardized logging facade function matching `logJson(level, event, data)`.
 * Transparently applies deep sanitization, bounded metrics, and log rotation.
 */
export function logDiagnosticJson(
  severity: DiagnosticSeverity,
  event: string,
  metadata: Record<string, unknown> = {},
  options?: {
    module?: DiagnosticModule | string;
    correlationId?: string;
    sessionId?: string;
    durationMs?: number;
    outcome?: DiagnosticOutcome | string;
    errorCategory?: string;
  },
): StructuredDiagnosticEvent {
  const structuredEvent: StructuredDiagnosticEvent = {
    timestamp: new Date().toISOString(),
    severity,
    module: options?.module || "gateway",
    event,
    correlationId: options?.correlationId,
    sessionId: options?.sessionId,
    durationMs: options?.durationMs,
    outcome: options?.outcome,
    errorCategory: options?.errorCategory,
    metadata,
  };

  return boundedLogStore.recordEvent(structuredEvent);
}
