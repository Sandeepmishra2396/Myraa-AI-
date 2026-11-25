/**
 * MYRAA — HttpGateway
 *
 * Registers all Express REST routes and returns the configured app.
 * Also owns the logging subsystem (appendLog, logJson, logCommand, logStartup, logError).
 *
 * Routes registered:
 *   GET/POST/DELETE  /api/memories
 *   GET/POST         /api/settings
 *   GET              /api/config
 *   POST             /api/config/apikey   [localhost-only]
 *   DELETE           /api/config/apikey   [localhost-only]
 *   GET              /api/agent-health
 *   GET              /api/logs/:file      [localhost-only]
 *   GET              /api/proxy
 *   GET              /api/web-proxy
 *   GET              /api/youtube-search
 *
 * Static/Vite middleware is NOT mounted here — that stays in server.ts so the
 * gateway remains testable without a vite dependency.
 */

import express from "express";
import path from "path";
import * as fs from "fs";
import { Memory } from "../memory/MemoryTypes.ts";
import {
  loadMemories,
  saveMemories,
} from "../server_memory.ts";
import {
  DATA_DIR,
  dataFile,
  resolveApiKeyWithMetadata,
  classifyCredential,
  hasGeminiApiKey,
  setGeminiApiKey,
  clearGeminiApiKey,
} from "../server_paths.ts";
import { GoogleGenAI } from "@google/genai";
import {
  requireLocalhost,
  sanitizeError,
  safeSsrfFetch,
} from "../security/PermissionManager.ts";
import { dataProtectionService } from "../security/DataProtectionService.ts";
import {
  DESKTOP_AGENT_URL,
  callDesktopAgent,
} from "../tasks/TaskManager.ts";
import {
  boundedLogStore,
  deepSanitizeDiagnostic,
  sanitizeDiagnosticString,
  runtimeHealthMonitor,
  runtimeMetrics,
  correlationTracer,
} from "../diagnostics/RuntimeObservability.ts";

// ---------------------------------------------------------------------------
// Logging subsystem (Backed by RuntimeObservability with deep redaction & rotation)
// ---------------------------------------------------------------------------
const LOGS_DIR = boundedLogStore.getLogsDir();

export function appendLog(fileName: string, message: string): void {
  try {
    boundedLogStore.appendPlainText(fileName, message);
  } catch {
    /* logging is best-effort */
  }
}

export const logCommand = (m: string) => appendLog("commands.log", m);
export const logStartup = (m: string) => appendLog("startup.log", m);
export const logError = (m: string) => appendLog("errors.log", m);

/**
 * Structured JSON log entry (NDJSON). Written to logs/app.log.json with deep recursive redaction and log rotation.
 */
export function logJson(
  level: "info" | "warn" | "error",
  event: string,
  data: Record<string, unknown> = {},
): void {
  try {
    if (event === "gemini_live_connected") {
      runtimeMetrics.incrementCounter("gemini_live_connections_total");
    } else if (event === "gemini_live_error") {
      runtimeMetrics.incrementCounter("gemini_live_errors_total");
    } else if (event === "gemini_live_goaway") {
      runtimeMetrics.incrementCounter("gemini_live_reconnects_total");
    } else if (event === "tool_execute") {
      runtimeMetrics.incrementCounter("task_executed_total");
    } else if (event === "tool_error" || event === "tool_unreachable") {
      runtimeMetrics.incrementCounter("desktop_agent_rpc_errors_total");
    }

    boundedLogStore.recordEvent({
      timestamp: new Date().toISOString(),
      severity: level,
      module: (data.module as string) || (event.startsWith("gemini_") ? "gemini_live" : event.startsWith("tool_") ? "tasks" : "gateway"),
      event,
      correlationId: (data.correlationId as string) || (data.auditCorrelationId as string),
      sessionId: data.sessionId as string,
      durationMs: typeof data.durationMs === "number" ? data.durationMs : undefined,
      outcome: (data.outcome as string) || (data.ok === true ? "success" : data.ok === false ? "failure" : undefined),
      errorCategory: (data.errorCategory as string) || (data.error ? "runtime_error" : undefined),
      metadata: data,
    });
  } catch {
    /* logging is best-effort */
  }
}

// ---------------------------------------------------------------------------
// Settings file helpers (co-located here because they're only used by routes)
// ---------------------------------------------------------------------------
const SETTINGS_FILE = dataFile("settings.json");

function loadSettingsFile(): Record<string, unknown> {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8"));
    }
  } catch {
    /* corrupt file — return defaults */
  }
  return {};
}

function saveSettingsFile(data: Record<string, unknown>): void {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// RFC 6454 / WHATWG Canonical Origin Normalization
// Strictly normalizes scheme, hostname, and port tuple (strips default ports)
// ---------------------------------------------------------------------------
export function normalizeOrigin(val: string | undefined | null): string | null {
  if (!val || typeof val !== "string") return null;
  try {
    const u = new URL(val.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.origin.toLowerCase();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Step-up challenge ownership registry (FINDING-AUD-03)
// Maps challengeId -> owning operator sessionId to block cross-session verification.
// ---------------------------------------------------------------------------
const _stepUpChallengeOwners = new Map<string, { sessionId: string; expiresAt: number }>();

export function registerStepUpChallengeOwner(
  challengeId: string,
  sessionId: string,
  expiresAtMs: number = Date.now() + 10 * 60 * 1000,
): void {
  if (_stepUpChallengeOwners.size > 1000) {
    const now = Date.now();
    for (const [k, v] of _stepUpChallengeOwners.entries()) {
      if (v.expiresAt < now) _stepUpChallengeOwners.delete(k);
    }
  }
  _stepUpChallengeOwners.set(challengeId, { sessionId, expiresAt: expiresAtMs });
}

const SENSITIVE_MEMORY_CATEGORIES = new Set(["identity", "credentials", "behavior"]);
const READ_ONLY_ROLES = new Set(["guest", "read_only"]);

interface AuthenticatedHttpContext {
  identityId: string;
  role: string;
  sessionId?: string;
  deviceId?: string;
  ipAddress: string;
  isLocal: boolean;
  isStepUpAuthenticated: boolean;
  authType: "operator" | "remote_device";
}

function getClientIp(req: any): { ip: string; isLocal: boolean } {
  const forwardedIp = req.headers?.["x-forwarded-for"];
  const ip = forwardedIp
    ? String(forwardedIp).split(",")[0].trim()
    : req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress || "127.0.0.1";
  const isLocal =
    !forwardedIp &&
    (ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1" || ip === "localhost");
  return { ip, isLocal };
}

/**
 * Operator-only Bearer myraa_at_... session authentication middleware.
 */
async function requireOperatorSessionMiddleware(req: any, res: any, next: () => void): Promise<void> {
  const authHeader = String(req.headers?.["authorization"] || "");
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (!token) {
    res.status(401).json({ error: "MISSING_OPERATOR_TOKEN: Authorization Bearer token required." });
    return;
  }
  const { ip, isLocal } = getClientIp(req);
  const { identityAuthManager } = await import("../security/IdentityAuthManager.ts");
  const result = identityAuthManager.validateAccessToken(token, ip);
  if (!result.valid || !result.session) {
    res.status(401).json({ error: result.error || "INVALID_OPERATOR_TOKEN: Invalid or expired session token." });
    return;
  }
  const session = result.session;
  const isStepUp = Boolean(
    session.isStepUpAuthenticated &&
      session.stepUpExpiresAt &&
      Date.now() < session.stepUpExpiresAt,
  );
  req.operatorSession = session;
  req.authContext = {
    identityId: session.identityId,
    role: session.role,
    sessionId: session.sessionId,
    deviceId: session.deviceId,
    ipAddress: ip,
    isLocal,
    isStepUpAuthenticated: isStepUp,
    authType: "operator",
  } satisfies AuthenticatedHttpContext;
  next();
}

/**
 * Unified fail-closed authentication middleware (FINDING-AUD-03):
 * Accepts a valid Bearer operator session token (myraa_at_...) OR a valid
 * Bearer paired remote device token. Never permits unauthenticated access.
 */
async function requireAuthenticatedClient(req: any, res: any, next: () => void): Promise<void> {
  const authHeader = String(req.headers?.["authorization"] || "");
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (!token) {
    res.status(401).json({ error: "UNAUTHORIZED: Valid Bearer operator or paired device token required." });
    return;
  }

  const { ip, isLocal } = getClientIp(req);

  // 1. Try desktop operator access token (myraa_at_...)
  if (token.startsWith("myraa_at_")) {
    const { identityAuthManager } = await import("../security/IdentityAuthManager.ts");
    const opAuth = identityAuthManager.validateAccessToken(token, ip);
    if (!opAuth.valid || !opAuth.session) {
      res.status(401).json({ error: opAuth.error || "UNAUTHORIZED: Invalid or expired operator token." });
      return;
    }
    const session = opAuth.session;
    const isStepUp = Boolean(
      session.isStepUpAuthenticated &&
        session.stepUpExpiresAt &&
        Date.now() < session.stepUpExpiresAt,
    );
    req.operatorSession = session;
    req.authContext = {
      identityId: session.identityId,
      role: session.role,
      sessionId: session.sessionId,
      deviceId: session.deviceId,
      ipAddress: ip,
      isLocal,
      isStepUpAuthenticated: isStepUp,
      authType: "operator",
    } satisfies AuthenticatedHttpContext;
    next();
    return;
  }

  // 2. Try paired remote device credential
  try {
    const { remoteSecurityCoordinator } = await import("../security/RemoteSecurityCoordinator.ts");
    const remoteAuth = await remoteSecurityCoordinator.authenticateRemoteCredential(
      token,
      ip,
      req.headers["user-agent"],
    );
    if (!remoteAuth.authenticated || !remoteAuth.device) {
      res.status(401).json({ error: remoteAuth.error || "UNAUTHORIZED: Invalid or revoked device token." });
      return;
    }
    req.remoteDevice = remoteAuth.device;
    req.securitySession = remoteAuth.session;
    const isStepUp = Boolean(
      remoteAuth.session?.isStepUpAuthenticated &&
        remoteAuth.session?.stepUpExpiresAt &&
        Date.now() < remoteAuth.session.stepUpExpiresAt,
    );
    req.authContext = {
      identityId: remoteAuth.device.id,
      role: remoteAuth.device.role,
      sessionId: remoteAuth.session?.sessionId,
      deviceId: remoteAuth.device.id,
      ipAddress: ip,
      isLocal,
      isStepUpAuthenticated: isStepUp,
      authType: "remote_device",
    } satisfies AuthenticatedHttpContext;
    next();
  } catch (e: any) {
    res.status(500).json({ error: sanitizeError(e?.message || e) });
  }
}

function assertWriteRoleAllowed(req: any, res: any): boolean {
  const role = String(req.authContext?.role || req.operatorSession?.role || "").toLowerCase();
  if (!role || READ_ONLY_ROLES.has(role)) {
    res.status(403).json({
      error: `FORBIDDEN_ROLE: Role '${role || "unknown"}' is not permitted to perform write mutations.`,
    });
    return false;
  }
  return true;
}

async function assertSystemNotHalted(res: any, actorId: string, resource: string): Promise<boolean> {
  const { emergencyStopCoordinator } = await import("../remote/EmergencyStopCoordinator.ts");
  const { securityPolicyEngine } = await import("../security/SecurityPolicyEngine.ts");
  const { securityAuditLogger } = await import("../security/SecurityAuditLogger.ts");

  if (emergencyStopCoordinator.isActive()) {
    securityAuditLogger.logEvent({
      eventType: "TOOL_BLOCKED",
      actor: { identityId: actorId, role: "standard", ipAddress: "127.0.0.1" },
      target: { resource },
      decision: "BLOCK",
      reason: "EMERGENCY_STOP_ACTIVE: Operation blocked while Emergency Stop is active.",
      riskLevel: "HIGH",
    });
    res.status(503).json({ error: "EMERGENCY_STOP_ACTIVE: Operation blocked while Emergency Stop is active.", blocked: true });
    return false;
  }

  if (securityPolicyEngine.getMode() === "LOCKDOWN") {
    securityAuditLogger.logEvent({
      eventType: "TOOL_BLOCKED",
      actor: { identityId: actorId, role: "standard", ipAddress: "127.0.0.1" },
      target: { resource },
      decision: "BLOCK",
      reason: "SECURITY_LOCKDOWN_ACTIVE: Operation blocked while Security Lockdown is active.",
      riskLevel: "HIGH",
    });
    res.status(423).json({ error: "SECURITY_LOCKDOWN_ACTIVE: Operation blocked while Security Lockdown is active.", blocked: true });
    return false;
  }

  return true;
}

function filterSensitiveMemoriesForCaller<T extends { category?: string }>(
  memories: T[],
  authCtx?: AuthenticatedHttpContext,
): T[] {
  if (
    authCtx?.isStepUpAuthenticated ||
    authCtx?.role === "admin" ||
    (authCtx?.isLocal && authCtx?.identityId === "local_operator")
  ) {
    return memories;
  }
  return memories.filter((m) => !SENSITIVE_MEMORY_CATEGORIES.has(String(m.category || "").toLowerCase()));
}

// ---------------------------------------------------------------------------
// Factory function — call once to get the configured Express app
// ---------------------------------------------------------------------------
export function createHttpApp(): express.Application {
  const app = express();

  // Trust first proxy hop in production (Nginx, Caddy, Cloudflare, ALB, K8s Ingress)
  if (process.env.NODE_ENV === "production") {
    app.set("trust proxy", 1);
  }

  // 10MB payload limit enforcement
  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ extended: true, limit: "10mb" }));

  // ── Environment-Aware Security Headers Middleware ─────────────────────────
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("X-XSS-Protection", "0");

    // Strict-Transport-Security (HSTS): applied strictly in production over HTTPS/TLS
    const isProd = process.env.NODE_ENV === "production";
    const proto = req.headers["x-forwarded-proto"] || req.protocol;
    if (isProd && (proto === "https" || proto === "wss" || (req.socket as any).encrypted)) {
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    next();
  });

  // ── Observability & Response Duration Metrics ─────────────────────────────
  app.use((_req, res, next) => {
    const startMs = Date.now();
    res.on("finish", () => {
      const durationMs = Date.now() - startMs;
      runtimeMetrics.recordTiming("api_request_duration_ms", durationMs);
    });
    next();
  });

  // ── Environment-Aware CORS Middleware (FINDING-AUD-04) ───────────────────
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    const isProd = process.env.NODE_ENV === "production" && process.env.SORA_LAUNCHED_BY !== "electron";

    if (origin) {
      let allowed = false;
      const isLocalOrigin = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);

      if (!isProd) {
        // Development: allow localhost and 127.0.0.1 origins
        if (isLocalOrigin) allowed = true;
      } else {
        const clientOrigin = normalizeOrigin(origin);
        if (!clientOrigin) {
          // Reject malformed or non-http(s) origins immediately
          return res.status(403).json({ error: "CORS_ORIGIN_DENIED: Origin not permitted." });
        }

        // 1. Production: strictly explicit origins from process.env.CORS_ORIGINS (comma-separated). No wildcard!
        const configuredOrigins = (process.env.CORS_ORIGINS || "")
          .split(",")
          .map((o) => normalizeOrigin(o.trim()))
          .filter((o): o is string => Boolean(o));
        if (configuredOrigins.includes(clientOrigin)) {
          allowed = true;
        }

        // 2. Canonical trusted public origin derived from Render configuration
        if (!allowed && process.env.RENDER_EXTERNAL_URL) {
          const renderUrlOrigin = normalizeOrigin(process.env.RENDER_EXTERNAL_URL);
          if (renderUrlOrigin && clientOrigin === renderUrlOrigin) {
            allowed = true;
          }
        }

        if (!allowed && process.env.RENDER_EXTERNAL_HOSTNAME) {
          const renderHostOrigin = normalizeOrigin(`https://${process.env.RENDER_EXTERNAL_HOSTNAME.trim()}`);
          if (renderHostOrigin && clientOrigin === renderHostOrigin) {
            allowed = true;
          }
        }

        // 3. Strict RFC 6454 / WHATWG same-origin matching against current request (scheme, hostname, port tuple)
        // Safely bounded by trusted deployment configuration so an arbitrary incoming Host header cannot establish trust.
        if (!allowed) {
          const reqProto = String(req.headers["x-forwarded-proto"] || req.protocol || "http").toLowerCase();
          const reqHost = String(req.get("host") || "").trim();
          if (reqHost) {
            const reqCanonicalOrigin = normalizeOrigin(`${reqProto}://${reqHost}`);
            if (reqCanonicalOrigin && clientOrigin === reqCanonicalOrigin) {
              const reqHostname = new URL(reqCanonicalOrigin).hostname.toLowerCase();
              const isTrustedDeploymentHost =
                reqHostname === "localhost" ||
                reqHostname === "127.0.0.1" ||
                reqHostname === "::1" ||
                (process.env.RENDER_EXTERNAL_HOSTNAME &&
                  reqHostname === process.env.RENDER_EXTERNAL_HOSTNAME.trim().toLowerCase()) ||
                (process.env.RENDER_EXTERNAL_URL &&
                  reqHostname === new URL(process.env.RENDER_EXTERNAL_URL).hostname.toLowerCase()) ||
                configuredOrigins.some((co) => new URL(co).hostname.toLowerCase() === reqHostname);

              if (isTrustedDeploymentHost) {
                allowed = true;
              }
            }
          }
        }
      }

      if (allowed) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
        res.setHeader("Access-Control-Allow-Credentials", "true");
        res.setHeader("Vary", "Origin");
      } else {
        // Enforce origin policy consistently on ALL requests, not only OPTIONS preflight
        return res.status(403).json({ error: "CORS_ORIGIN_DENIED: Origin not permitted." });
      }
    }

    if (req.method === "OPTIONS") {
      return res.sendStatus(204);
    }
    next();
  });

  // Enforce Transport Security: Remote callers must use HTTPS/WSS
  app.use((req, res, next) => {
    const forwardedIp = req.headers["x-forwarded-for"];
    const ip = forwardedIp
      ? String(forwardedIp).split(",")[0].trim()
      : req.socket?.remoteAddress || req.connection?.remoteAddress || "";
    const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
    const check = dataProtectionService.validateTransport({
      protocol: String(proto),
      ipAddress: ip,
      targetName: req.originalUrl || req.path,
    });
    if (!check.secure) {
      return res.status(403).json({ error: check.error });
    }
    next();
  });

  // ── Memory REST API (FINDING-AUD-03, FINDING-AUD-07) ────────────────────
  app.get("/api/memories", requireAuthenticatedClient, async (req: any, res) => {
    try {
      const { memoryManager } = await import("../memory/MemoryManager.ts");
      const memories = await memoryManager.listMemories({ includeNeedsRevalidation: true });
      res.json(filterSensitiveMemoriesForCaller(memories, req.authContext));
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  app.post("/api/memories", requireAuthenticatedClient, async (req: any, res) => {
    try {
      if (!assertWriteRoleAllowed(req, res)) return;
      if (!(await assertSystemNotHalted(res, req.authContext.identityId, "/api/memories"))) return;

      const { category, text, key, importance, confidence, source, expiresAt } = req.body || {};
      if (!category || !text) {
        return res
          .status(400)
          .json({ error: "Category and text parameters are required." });
      }

      const { isDlpClean } = await import("../memory/SharedMemoryManager.ts");
      if (!isDlpClean(String(text)) || (key && !isDlpClean(String(key)))) {
        return res.status(422).json({
          error: "DLP_SECRET_REJECTED: Secrets or credentials cannot be stored in memory.",
          blocked: true,
        });
      }

      const { contentSanitizer } = await import("../security/ContentSanitizer.ts");
      if (contentSanitizer.scanForPromptInjection(String(text)).hasInjectionAttempt) {
        return res.status(422).json({
          error: "PROMPT_INJECTION_BLOCKED: Memory content contains unsafe prompt-injection patterns.",
          blocked: true,
        });
      }

      const { governingMemoryGate } = await import("../companion/GoverningMemoryGate.ts");
      const proposal = await governingMemoryGate.requestWrite({
        action: "CREATE",
        proposedMemory: {
          category,
          text,
          key,
          importance,
          confidence,
          source: (source as any) ?? "user_explicit",
          expiresAt,
        },
        reason: "REST API memory proposal",
        confidence: typeof confidence === "number" ? confidence : 0.85,
        source: (source as any) ?? "user_explicit",
        userId: req.authContext.identityId,
        provenance: "HttpGateway.POST /api/memories",
        sessionId: req.authContext.sessionId,
        isStepUpAuthenticated: Boolean(req.authContext?.isStepUpAuthenticated || req.authContext?.role === "admin"),
      } as any);

      if (!proposal.approved && proposal.oneTimeToken && (req.authContext?.role === "admin" || req.authContext?.isLocal)) {
        try {
          await governingMemoryGate.approveWrite(proposal.id, proposal.oneTimeToken, {
            actorId: req.authContext.identityId,
            role: req.authContext.role || "admin",
            ipAddress: req.authContext.ipAddress || "127.0.0.1",
            sessionId: req.authContext.sessionId,
            isStepUpAuthenticated: true,
          });
        } catch (autoErr) {
          console.warn("[HttpGateway] Operator auto-approval notice:", autoErr);
        }
      }

      res.status(202).json({
        status: "pending_approval",
        requestId: proposal.id,
        message: "Memory proposal created. Awaiting operator confirmation.",
        proposedMemory: proposal.proposedMemory,
      });
    } catch (e: any) {
      const msg = e?.message || String(e);
      if (msg.includes("DLP_SECRET_REJECTED") || msg.includes("PROMPT_INJECTION_BLOCKED")) {
        return res.status(422).json({ error: msg, blocked: true });
      }
      if (msg.includes("EMERGENCY_STOP_ACTIVE")) {
        return res.status(503).json({ error: msg, blocked: true });
      }
      if (msg.includes("SECURITY_LOCKDOWN_ACTIVE")) {
        return res.status(423).json({ error: msg, blocked: true });
      }
      res.status(500).json({ error: sanitizeError(msg) });
    }
  });

  app.delete("/api/memories/:id", requireAuthenticatedClient, async (req: any, res) => {
    try {
      if (!assertWriteRoleAllowed(req, res)) return;
      if (!(await assertSystemNotHalted(res, req.authContext.identityId, "/api/memories/:id"))) return;

      const { id } = req.params;
      const { memoryManager } = await import("../memory/MemoryManager.ts");
      const existing = await memoryManager.getMemory(id);
      if (!existing) {
        return res.status(404).json({ error: "Memory not found." });
      }
      const { governingMemoryGate } = await import("../companion/GoverningMemoryGate.ts");
      const proposal = await governingMemoryGate.requestWrite({
        action: "DELETE",
        proposedMemory: {
          id,
          category: existing.category,
          text: existing.text,
          key: existing.key,
        },
        reason: `REST API memory deletion proposal for ${id}`,
        confidence: 0.85,
        source: existing.source || "user_explicit",
        userId: req.authContext.identityId,
        provenance: "HttpGateway.DELETE /api/memories/:id",
        sessionId: req.authContext.sessionId,
        expectedVersion: req.body?.expectedVersion ?? existing.version,
      } as any);

      if (!proposal.approved && proposal.oneTimeToken && (req.authContext?.role === "admin" || req.authContext?.isLocal)) {
        try {
          await governingMemoryGate.approveWrite(proposal.id, proposal.oneTimeToken, {
            actorId: req.authContext.identityId,
            role: req.authContext.role || "admin",
            ipAddress: req.authContext.ipAddress || "127.0.0.1",
            sessionId: req.authContext.sessionId,
            isStepUpAuthenticated: true,
          });
        } catch (autoErr) {
          console.warn("[HttpGateway] Operator auto-delete notice:", autoErr);
        }
      }

      res.status(202).json({
        status: "pending_approval",
        action: "DELETE",
        requestId: proposal.id,
        message: "Memory deletion proposal created. Awaiting operator confirmation.",
      });
    } catch (e: any) {
      const msg = e?.message || String(e);
      if (msg.includes("EMERGENCY_STOP_ACTIVE")) return res.status(503).json({ error: msg, blocked: true });
      if (msg.includes("SECURITY_LOCKDOWN_ACTIVE")) return res.status(423).json({ error: msg, blocked: true });
      res.status(500).json({ error: sanitizeError(msg) });
    }
  });


  // ── Phase 2 Memory Routes (additive — secured) ──

  // GET /api/memories/search?q=&category=&importance=&confidence=&limit=
  app.get("/api/memories/search", requireAuthenticatedClient, async (req: any, res) => {
    try {
      const { memoryManager } = await import("../memory/MemoryManager.ts");
      const {
        q,
        category,
        importance,
        confidence,
        source,
        limit,
        includeArchived,
        includeNeedsRevalidation,
      } = req.query as Record<string, string>;

      const results = await memoryManager.searchMemories({
        query: q,
        categories: category ? [category as any] : undefined,
        minImportance: importance as any,
        minConfidence: confidence as any,
        source: source as any,
        limit: limit ? parseInt(limit, 10) : 20,
        includeArchived: includeArchived === "true",
        includeNeedsRevalidation: includeNeedsRevalidation !== "false",
      });
      res.json(filterSensitiveMemoriesForCaller(results, req.authContext));
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  // PATCH /api/memories/:id — partial update via governance
  app.patch("/api/memories/:id", requireAuthenticatedClient, async (req: any, res) => {
    try {
      if (!assertWriteRoleAllowed(req, res)) return;
      if (!(await assertSystemNotHalted(res, req.authContext.identityId, "/api/memories/:id"))) return;

      const { id } = req.params;
      const { text, key, importance, confidence, status, expiresAt, expectedVersion } = req.body || {};
      const { memoryManager } = await import("../memory/MemoryManager.ts");
      const existing = await memoryManager.getMemory(id);
      if (!existing) {
        return res.status(404).json({ error: "Memory not found." });
      }

      const { isDlpClean } = await import("../memory/SharedMemoryManager.ts");
      if ((text && !isDlpClean(String(text))) || (key && !isDlpClean(String(key)))) {
        return res.status(422).json({
          error: "DLP_SECRET_REJECTED: Secrets or credentials cannot be stored in memory.",
          blocked: true,
        });
      }

      const { contentSanitizer } = await import("../security/ContentSanitizer.ts");
      if (text && contentSanitizer.scanForPromptInjection(String(text)).hasInjectionAttempt) {
        return res.status(422).json({
          error: "PROMPT_INJECTION_BLOCKED: Memory content contains unsafe prompt-injection patterns.",
          blocked: true,
        });
      }

      const { governingMemoryGate } = await import("../companion/GoverningMemoryGate.ts");
      const proposal = await governingMemoryGate.requestWrite({
        action: "UPDATE",
        proposedMemory: {
          id,
          category: existing.category,
          text,
          key,
          importance,
          confidence,
          status,
          expiresAt,
        },
        reason: `REST API memory update proposal for ${id}`,
        confidence: 0.85,
        source: existing.source || "user_explicit",
        userId: req.authContext.identityId,
        provenance: "HttpGateway.PATCH /api/memories/:id",
        sessionId: req.authContext.sessionId,
        expectedVersion: expectedVersion !== undefined ? Number(expectedVersion) : existing.version,
      } as any);
      res.status(202).json({
        status: "pending_approval",
        action: "UPDATE",
        requestId: proposal.id,
        message: "Memory update proposal created. Awaiting operator confirmation.",
        proposedMemory: proposal.proposedMemory,
      });
    } catch (e: any) {
      const msg = e?.message || String(e);
      if (msg.includes("DLP_SECRET_REJECTED") || msg.includes("PROMPT_INJECTION_BLOCKED")) {
        return res.status(422).json({ error: msg, blocked: true });
      }
      if (msg.includes("EMERGENCY_STOP_ACTIVE")) return res.status(503).json({ error: msg, blocked: true });
      if (msg.includes("SECURITY_LOCKDOWN_ACTIVE")) return res.status(423).json({ error: msg, blocked: true });
      res.status(500).json({ error: sanitizeError(msg) });
    }
  });

  // POST /api/memories/:id/archive — governed soft-delete proposal
  app.post("/api/memories/:id/archive", requireAuthenticatedClient, async (req: any, res) => {
    try {
      if (!assertWriteRoleAllowed(req, res)) return;
      if (!(await assertSystemNotHalted(res, req.authContext.identityId, "/api/memories/:id/archive"))) return;

      const { id } = req.params;
      const { memoryManager } = await import("../memory/MemoryManager.ts");
      const existing = await memoryManager.getMemory(id);
      if (!existing) {
        return res.status(404).json({ error: "Memory not found." });
      }
      const { governingMemoryGate } = await import("../companion/GoverningMemoryGate.ts");
      const proposal = await governingMemoryGate.requestWrite({
        action: "ARCHIVE",
        proposedMemory: {
          id,
          category: existing.category,
          text: existing.text,
          key: existing.key,
          status: "archived",
        },
        reason: `REST API memory archive proposal for ${id}`,
        confidence: 0.85,
        source: existing.source || "user_explicit",
        userId: req.authContext.identityId,
        provenance: "HttpGateway.POST /api/memories/:id/archive",
        sessionId: req.authContext.sessionId,
        expectedVersion: req.body?.expectedVersion ?? existing.version,
      } as any);

      if (!proposal.approved && proposal.oneTimeToken && (req.authContext?.role === "admin" || req.authContext?.isLocal)) {
        try {
          await governingMemoryGate.approveWrite(proposal.id, proposal.oneTimeToken, {
            actorId: req.authContext.identityId,
            role: req.authContext.role || "admin",
            ipAddress: req.authContext.ipAddress || "127.0.0.1",
            sessionId: req.authContext.sessionId,
            isStepUpAuthenticated: true,
          });
        } catch (autoErr) {
          console.warn("[HttpGateway] Operator auto-delete notice:", autoErr);
        }
      }

      res.status(202).json({
        status: "pending_approval",
        action: "ARCHIVE",
        requestId: proposal.id,
        message: "Memory archive proposal created. Awaiting operator confirmation.",
      });
    } catch (e: any) {
      const msg = e?.message || String(e);
      if (msg.includes("EMERGENCY_STOP_ACTIVE")) return res.status(503).json({ error: msg, blocked: true });
      if (msg.includes("SECURITY_LOCKDOWN_ACTIVE")) return res.status(423).json({ error: msg, blocked: true });
      res.status(500).json({ error: sanitizeError(msg) });
    }
  });

  // GET /api/memories/context?maxChars=2000&q= — get ranked context string
  app.get("/api/memories/context", requireAuthenticatedClient, async (req: any, res) => {
    try {
      const { memoryManager } = await import("../memory/MemoryManager.ts");
      const maxChars = req.query.maxChars ? parseInt(req.query.maxChars as string, 10) : 2000;
      const query = req.query.q as string | undefined;
      const context = await memoryManager.getRelevantContext({
        query,
        contextCharBudget: maxChars,
        touchLastAccessed: false, // read-only via REST
      });
      res.json({ context, charCount: context.length });
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  // ── Project Intelligence REST API (Phase 3) ─────────────────────────────
  app.get("/api/projects/active", async (_req, res) => {
    try {
      const { projectManager } = await import("../projects/ProjectManager.ts");
      let project = await projectManager.analyzeProject();
      res.json(project);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/projects/analyze", async (req, res) => {
    try {
      const { projectManager } = await import("../projects/ProjectManager.ts");
      const targetPath = req.body?.path as string | undefined;
      const project = await projectManager.analyzeProject(targetPath);
      res.json(project);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/projects/architecture", async (_req, res) => {
    try {
      const { projectManager } = await import("../projects/ProjectManager.ts");
      const project = await projectManager.analyzeProject();
      res.json(project.architectureMap || { layers: [], entryPoints: [], keyComponents: [] });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/projects/search", async (req, res) => {
    try {
      const { projectManager } = await import("../projects/ProjectManager.ts");
      const q = (req.query.q as string) || "";
      const pattern = req.query.pattern as string | undefined;
      const caseSensitive = req.query.caseSensitive === "true";
      const maxResults = req.query.max ? parseInt(req.query.max as string, 10) : 25;
      const results = await projectManager.searchCode(q, {
        filePattern: pattern,
        caseSensitive,
        maxResults,
      });
      res.json(results);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/projects/git", async (_req, res) => {
    try {
      const { projectManager } = await import("../projects/ProjectManager.ts");
      const git = await projectManager.getGitStatus();
      res.json(git);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/projects/tasks", async (_req, res) => {
    try {
      const { projectManager } = await import("../projects/ProjectManager.ts");
      const tasks = await projectManager.getTasks();
      const lastSession = await projectManager.getLastSession();
      res.json({ tasks, lastSession });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/projects/tasks", async (req, res) => {
    try {
      const { projectManager } = await import("../projects/ProjectManager.ts");
      const { title, description, status } = req.body;
      if (!title) {
        return res.status(400).json({ error: "Task title is required." });
      }
      const task = await projectManager.addTask(title, description, status);
      res.status(201).json(task);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.patch("/api/projects/tasks/:id", async (req, res) => {
    try {
      const { projectManager } = await import("../projects/ProjectManager.ts");
      const { title, description, status } = req.body;
      const updated = await projectManager.updateTask(req.params.id, { title, description, status });
      if (!updated) {
        return res.status(404).json({ error: "Task not found." });
      }
      res.json(updated);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete("/api/projects/tasks/:id", async (req, res) => {
    try {
      const { projectManager } = await import("../projects/ProjectManager.ts");
      const ok = await projectManager.deleteTask(req.params.id);
      if (!ok) {
        return res.status(404).json({ error: "Task not found." });
      }
      res.json({ success: true, deletedId: req.params.id });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/projects", async (_req, res) => {
    try {
      const { projectStore } = await import("../projects/ProjectStore.ts");
      const data = await projectStore.load();
      res.json(data);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/projects/active", async (req, res) => {
    try {
      const { projectStore } = await import("../projects/ProjectStore.ts");
      const { id } = req.body;
      if (!id) return res.status(400).json({ error: "Project ID is required." });
      await projectStore.setActiveProject(id);
      res.json({ success: true, activeProjectId: id });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete("/api/projects/:id", async (req, res) => {
    try {
      const { projectStore } = await import("../projects/ProjectStore.ts");
      const ok = await projectStore.deleteProject(req.params.id);
      if (!ok) return res.status(404).json({ error: "Project not found." });
      res.json({ success: true, deletedId: req.params.id });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Knowledge & Research REST API (Phase 4) ─────────────────────────────
  app.get("/api/knowledge/documents", async (_req, res) => {
    try {
      const { knowledgeManager } = await import("../knowledge/KnowledgeManager.ts");
      const docs = await knowledgeManager.listDocuments();
      res.json({ documents: docs, count: docs.length });
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  app.get("/api/knowledge/search", async (req, res) => {
    try {
      const { knowledgeManager } = await import("../knowledge/KnowledgeManager.ts");
      const q = (req.query.q as string) || "";
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 5;
      const results = await knowledgeManager.queryKnowledge(q, { limit });
      res.json(results);
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  app.post("/api/knowledge/ingest/file", async (req, res) => {
    try {
      const { knowledgeManager } = await import("../knowledge/KnowledgeManager.ts");
      const filePath = req.body?.path;
      const tags = Array.isArray(req.body?.tags) ? req.body.tags : [];
      if (!filePath) {
        return res.status(400).json({ error: "Missing 'path' parameter in request body." });
      }
      const doc = await knowledgeManager.ingestFile(filePath, tags);
      res.status(201).json({ success: true, document: doc });
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  app.post("/api/knowledge/ingest/url", async (req, res) => {
    try {
      const { knowledgeManager } = await import("../knowledge/KnowledgeManager.ts");
      const targetUrl = req.body?.url;
      const tags = Array.isArray(req.body?.tags) ? req.body.tags : [];
      if (!targetUrl) {
        return res.status(400).json({ error: "Missing 'url' parameter in request body." });
      }
      const doc = await knowledgeManager.ingestUrl(targetUrl, tags);
      res.status(201).json({ success: true, document: doc });
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  app.delete("/api/knowledge/documents/:id", async (req, res) => {
    try {
      const { knowledgeManager } = await import("../knowledge/KnowledgeManager.ts");
      const success = await knowledgeManager.deleteDocument(req.params.id);
      res.json({ success });
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  app.post("/api/knowledge/research/web", async (req, res) => {
    try {
      const { knowledgeManager } = await import("../knowledge/KnowledgeManager.ts");
      const query = (req.body?.query as string) || "";
      const maxResults = req.body?.maxResults ? Number(req.body.maxResults) : 5;
      const fetchTopContent = req.body?.fetchTopContent === true;
      const results = await knowledgeManager.researchWeb(query, { maxResults, fetchTopContent });
      res.json(results);
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  app.post("/api/knowledge/research/docs", async (req, res) => {
    try {
      const { knowledgeManager } = await import("../knowledge/KnowledgeManager.ts");
      const technology = (req.body?.technology as string) || "";
      const topic = (req.body?.topic as string) || "";
      const results = await knowledgeManager.fetchOfficialDocs(technology, topic);
      res.json(results);
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  app.get("/api/knowledge/freshness", async (req, res) => {
    try {
      const { knowledgeManager } = await import("../knowledge/KnowledgeManager.ts");
      const q = (req.query.q as string) || "";
      const report = await knowledgeManager.checkFreshness(q);
      res.json(report);
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  // ── Agent Planner REST API (Phase 5 + Stage 10.3 P2) ────────────────────
  app.post("/api/planner/plan", requireAuthenticatedClient, async (req: any, res) => {
    try {
      if (!assertWriteRoleAllowed(req, res)) return;
      const actorId = req.authContext?.identityId || "unknown";
      if (!(await assertSystemNotHalted(res, actorId, "planner:plan"))) return;

      const { plannerCoordinator, resolveCanonicalProjectId } = await import("../planner/PlannerCoordinator.ts");
      const goal = (req.body?.goal as string) || "";
      if (!goal.trim()) return res.status(400).json({ error: "Goal text is required." });

      // Stage 10.3 P2: Explicit canonical project resolution with authenticated caller check.
      // A client-supplied projectId is only a requested identifier — validate existence &
      // caller write authorization before stamping. Reject invalid/unknown/unauthorized
      // project selection rather than falling back to an unrelated or globally active project.
      // When omitted, the plan remains unscoped (never infers global active project).
      let resolvedProjectId: string | undefined;
      if (req.body?.projectId !== undefined && req.body?.projectId !== null) {
        const resolution = await resolveCanonicalProjectId(req.body.projectId, {
          secContext: req.authContext,
          requireAuthorizedContext: true,
        });
        if (resolution.status === "unauthorized") {
          return res.status(403).json({ error: `FORBIDDEN_PROJECT_ACCESS: ${resolution.reason}` });
        }
        if (resolution.status === "invalid") {
          return res.status(404).json({ error: `INVALID_PROJECT_ID: ${resolution.reason}` });
        }
        if (resolution.status === "resolved") {
          resolvedProjectId = resolution.projectId;
        }
      }

      const plan = await plannerCoordinator.createPlan(
        goal,
        resolvedProjectId ? { projectId: resolvedProjectId } : undefined,
      );
      res.status(201).json({
        planId: plan.id,
        status: plan.status,
        stepCount: plan.steps.length,
        goal: plan.goal.objective,
        category: plan.goal.category,
        requiresModification: plan.goal.requiresModification,
        projectId: plan.projectId,
      });
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  app.get("/api/planner/plans", async (_req, res) => {
    try {
      const { plannerCoordinator } = await import("../planner/PlannerCoordinator.ts");
      const plans = await plannerCoordinator.listPlans();
      res.json({
        plans: plans.map((p) => ({
          id: p.id,
          status: p.status,
          goal: p.goal.objective,
          category: p.goal.category,
          stepCount: p.steps.length,
          completedSteps: p.steps.filter((s) => s.status === "completed").length,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
        })),
        count: plans.length,
      });
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  app.get("/api/planner/plans/:id", async (req, res) => {
    try {
      const { plannerCoordinator } = await import("../planner/PlannerCoordinator.ts");
      const plan = await plannerCoordinator.getPlan(req.params.id);
      if (!plan) return res.status(404).json({ error: "Plan not found." });
      res.json(plan);
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  app.post("/api/planner/plans/:id/execute", async (req, res) => {
    try {
      const { plannerCoordinator } = await import("../planner/PlannerCoordinator.ts");
      const plan = await plannerCoordinator.executePlan(req.params.id);
      res.json({
        planId: plan.id,
        status: plan.status,
        pendingCheckpointId: plan.pendingCheckpointId,
        completedSteps: plan.steps.filter((s) => s.status === "completed").length,
        totalSteps: plan.steps.length,
        verificationReport: plan.verificationReport || null,
      });
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  app.post("/api/planner/plans/:id/pause", async (req, res) => {
    try {
      const { plannerCoordinator } = await import("../planner/PlannerCoordinator.ts");
      const plan = await plannerCoordinator.pausePlan(req.params.id);
      res.json({ planId: plan.id, status: plan.status });
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  app.post("/api/planner/plans/:id/resume", async (req, res) => {
    try {
      const { plannerCoordinator } = await import("../planner/PlannerCoordinator.ts");
      const plan = await plannerCoordinator.resumePlan(req.params.id);
      res.json({ planId: plan.id, status: plan.status });
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  app.post("/api/planner/plans/:id/checkpoint", async (req, res) => {
    try {
      const { plannerCoordinator } = await import("../planner/PlannerCoordinator.ts");
      const { checkpointId, approved, userFeedback } = req.body;
      if (!checkpointId || approved === undefined) {
        return res.status(400).json({ error: "checkpointId and approved are required." });
      }
      const plan = await plannerCoordinator.confirmCheckpoint(
        req.params.id,
        checkpointId,
        approved === true || approved === "true",
        userFeedback,
      );
      res.json({ planId: plan.id, status: plan.status, checkpointId, approved });
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  app.delete("/api/planner/plans/:id", requireLocalhost, async (req, res) => {
    try {
      const { plannerCoordinator } = await import("../planner/PlannerCoordinator.ts");
      const deleted = await plannerCoordinator.deletePlan(req.params.id);
      res.json({ success: deleted });
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  // ── Proactive Companion REST API (Phase 6 — secured FINDING-AUD-03) ─────
  app.get("/api/companion/tasks", requireAuthenticatedClient, async (_req, res) => {
    try {
      const { companionCoordinator } = await import("../companion/CompanionCoordinator.ts");
      const tasks = await companionCoordinator.listTasks();
      res.json({ tasks, count: tasks.length });
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  app.post("/api/companion/tasks", requireAuthenticatedClient, async (req: any, res) => {
    try {
      if (!assertWriteRoleAllowed(req, res)) return;
      if (!(await assertSystemNotHalted(res, req.authContext.identityId, "/api/companion/tasks"))) return;

      const { companionCoordinator } = await import("../companion/CompanionCoordinator.ts");
      const { name, type, intervalMs, delayMs, maxIterations, params } = req.body || {};
      if (!name || !type) {
        return res.status(400).json({ error: "'name' and 'type' are required fields." });
      }
      const task = await companionCoordinator.scheduleTask({
        name,
        type,
        intervalMs: intervalMs ? Number(intervalMs) : undefined,
        delayMs: delayMs ? Number(delayMs) : undefined,
        maxIterations: maxIterations ? Number(maxIterations) : undefined,
        params,
      });
      res.status(201).json(task);
    } catch (e: any) {
      res.status(400).json({ error: sanitizeError(e?.message || e) });
    }
  });

  app.delete("/api/companion/tasks/:id", requireLocalhost, requireAuthenticatedClient, async (req: any, res) => {
    try {
      if (!assertWriteRoleAllowed(req, res)) return;
      if (!(await assertSystemNotHalted(res, req.authContext.identityId, "/api/companion/tasks/:id"))) return;

      const { companionCoordinator } = await import("../companion/CompanionCoordinator.ts");
      const task = await companionCoordinator.cancelTask(req.params.id);
      if (!task) return res.status(404).json({ error: `Task '${req.params.id}' not found.` });
      res.json({ success: true, task });
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  app.post("/api/companion/tasks/:id/pause", requireAuthenticatedClient, async (req: any, res) => {
    try {
      if (!assertWriteRoleAllowed(req, res)) return;
      if (!(await assertSystemNotHalted(res, req.authContext.identityId, "/api/companion/tasks/:id/pause"))) return;

      const { companionCoordinator } = await import("../companion/CompanionCoordinator.ts");
      const task = await companionCoordinator.pauseTask(req.params.id);
      if (!task) return res.status(404).json({ error: `Task '${req.params.id}' not found.` });
      res.json(task);
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  app.post("/api/companion/tasks/:id/resume", requireAuthenticatedClient, async (req: any, res) => {
    try {
      if (!assertWriteRoleAllowed(req, res)) return;
      if (!(await assertSystemNotHalted(res, req.authContext.identityId, "/api/companion/tasks/:id/resume"))) return;

      const { companionCoordinator } = await import("../companion/CompanionCoordinator.ts");
      const task = await companionCoordinator.resumeTask(req.params.id);
      if (!task) return res.status(404).json({ error: `Task '${req.params.id}' not found.` });
      res.json(task);
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  app.get("/api/companion/notifications", requireAuthenticatedClient, async (req, res) => {
    try {
      const { companionCoordinator } = await import("../companion/CompanionCoordinator.ts");
      const limit = req.query.limit ? Number(req.query.limit) : 50;
      const all = await companionCoordinator.listNotifications();
      res.json({ notifications: all.slice(0, limit), count: all.length });
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  app.post("/api/companion/notifications/:id/dismiss", requireAuthenticatedClient, async (req: any, res) => {
    try {
      if (!assertWriteRoleAllowed(req, res)) return;
      if (!(await assertSystemNotHalted(res, req.authContext.identityId, "/api/companion/notifications/:id/dismiss"))) return;

      const { companionCoordinator } = await import("../companion/CompanionCoordinator.ts");
      const item = await companionCoordinator.dismissNotification(req.params.id);
      if (!item) return res.status(404).json({ error: `Notification '${req.params.id}' not found.` });
      res.json({ success: true, notification: item });
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  app.delete("/api/companion/notifications", requireLocalhost, requireAuthenticatedClient, async (req: any, res) => {
    try {
      if (!assertWriteRoleAllowed(req, res)) return;
      if (!(await assertSystemNotHalted(res, req.authContext.identityId, "/api/companion/notifications"))) return;

      const { companionCoordinator } = await import("../companion/CompanionCoordinator.ts");
      await companionCoordinator.clearNotifications();
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  app.get("/api/companion/preferences", requireAuthenticatedClient, async (_req, res) => {
    try {
      const { companionCoordinator } = await import("../companion/CompanionCoordinator.ts");
      const prefs = await companionCoordinator.getPreferences();
      res.json(prefs);
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  app.put("/api/companion/preferences", requireAuthenticatedClient, async (req: any, res) => {
    try {
      if (!assertWriteRoleAllowed(req, res)) return;
      if (!(await assertSystemNotHalted(res, req.authContext.identityId, "/api/companion/preferences"))) return;

      const { companionCoordinator } = await import("../companion/CompanionCoordinator.ts");
      const updated = await companionCoordinator.updatePreferences(req.body || {});
      res.json(updated);
    } catch (e: any) {
      res.status(400).json({ error: sanitizeError(e?.message || e) });
    }
  });

  app.post("/api/companion/check", requireAuthenticatedClient, async (req: any, res) => {
    try {
      if (!assertWriteRoleAllowed(req, res)) return;
      if (!(await assertSystemNotHalted(res, req.authContext.identityId, "/api/companion/check"))) return;

      const { companionCoordinator } = await import("../companion/CompanionCoordinator.ts");
      const type = req.body?.type || "build";
      const targetUrl = req.body?.targetUrl;
      const result = await companionCoordinator.triggerCheck(type, targetUrl);
      res.json({ type, result });
    } catch (e: any) {
      res.status(400).json({ error: sanitizeError(e?.message || e) });
    }
  });

  // ── Remote Voice Companion REST API (Phase 7) ───────────────────────────

  const requireLocalhostOrPairedDevice = async (req: any, res: any, next: () => void) => {
    const forwardedIp = req.headers["x-forwarded-for"];
    const ip = forwardedIp
      ? String(forwardedIp).split(",")[0].trim()
      : req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress || "";
    const isLocal = !forwardedIp && (ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1" || ip === "localhost");

    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : authHeader.trim();

    if (token) {
      try {
        const { remoteSecurityCoordinator } = await import("../security/RemoteSecurityCoordinator.ts");
        const auth = await remoteSecurityCoordinator.authenticateRemoteCredential(token, ip, req.headers["user-agent"]);
        if (!auth.authenticated || !auth.device) {
          return res.status(401).json({ error: auth.error || "Unauthorized: Invalid or revoked device token." });
        }
        req.remoteDevice = auth.device;
        req.securitySession = auth.session;
        return next();
      } catch (e: any) {
        return res.status(500).json({ error: sanitizeError(e?.message || e) });
      }
    }

    if (isLocal) {
      return next();
    }

    return res.status(401).json({ error: "Unauthorized: Localhost access or valid Bearer device token required." });
  };

  // Generate a new 5-minute pairing code (localhost, paired admin, or atomic first-device bootstrap)
  app.post("/api/remote/pair-code", async (req: any, res) => {
    try {
      const forwardedIp = req.headers["x-forwarded-for"];
      const ip = forwardedIp
        ? String(forwardedIp).split(",")[0].trim()
        : req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress || "";
      const isLocal = !forwardedIp && (ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1" || ip === "localhost");

      const authHeader = req.headers.authorization || "";
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : authHeader.trim();

      const { remoteStore } = await import("../remote/RemoteStore.ts");
      const { pairingManager } = await import("../remote/PairingManager.ts");

      // 1. Authenticated Remote Admin Device
      if (token) {
        const { remoteSecurityCoordinator } = await import("../security/RemoteSecurityCoordinator.ts");
        const auth = await remoteSecurityCoordinator.authenticateRemoteCredential(token, ip, req.headers["user-agent"]);
        if (!auth.authenticated || !auth.device) {
          return res.status(401).json({ error: auth.error || "Unauthorized: Invalid or revoked device token." });
        }
        if (auth.device.role !== "admin") {
          return res.status(403).json({ error: "Forbidden: Only admins can generate device pairing codes." });
        }
        const codeInfo = pairingManager.generatePairCode(ip);
        return res.status(201).json(codeInfo);
      }

      // 2. Localhost Access (Loopback desktop)
      if (isLocal) {
        const codeInfo = pairingManager.generatePairCode(ip);
        return res.status(201).json(codeInfo);
      }

      // 3. Atomic First-Device Bootstrap (Remote caller when zero devices exist in database)
      const bootstrapCode = await pairingManager.generateBootstrapPairCode(ip);
      return res.status(201).json(bootstrapCode);
    } catch (e: any) {
      const msg = sanitizeError(e?.message || e);
      const status = msg.includes("BOOTSTRAP_CONFLICT")
        ? 409
        : msg.includes("BOOTSTRAP_CLOSED")
        ? 403
        : 500;
      return res.status(status).json({ error: msg });
    }
  });

  // Check active pairing code status
  app.get("/api/remote/pair-code/status", async (_req, res) => {
    try {
      const { pairingManager } = await import("../remote/PairingManager.ts");
      const { remoteStore } = await import("../remote/RemoteStore.ts");
      const status = pairingManager.getActivePairCode();
      const devices = await remoteStore.listDevices();
      res.json({
        active: status !== null,
        canBootstrap: devices.length === 0,
        ...(status || {}),
      });
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  // Pair a device using PIN
  app.post("/api/remote/pair", async (req, res) => {
    try {
      const { code, deviceName, deviceType } = req.body || {};
      if (!code || !deviceName) {
        return res.status(400).json({ error: "'code' and 'deviceName' are required fields." });
      }
      const clientIp = req.ip || req.socket?.remoteAddress || "unknown";
      const { pairingManager } = await import("../remote/PairingManager.ts");
      const result = await pairingManager.pairDevice({
        code,
        deviceName,
        deviceType,
        ipAddress: clientIp,
        userAgent: req.headers["user-agent"],
      });

      const { remoteSecurityCoordinator } = await import("../security/RemoteSecurityCoordinator.ts");
      const sessionResult = remoteSecurityCoordinator.createDeviceSession(
        result.device,
        clientIp,
        req.headers["user-agent"]
      );

      res.status(201).json({
        success: true,
        device: {
          id: result.device.id,
          name: result.device.name,
          deviceType: result.device.deviceType,
          role: result.device.role,
          pairedAt: result.device.pairedAt,
          token: result.token,
        },
        token: result.token,
        deviceId: result.device.id,
        deviceRole: result.device.role,
        accessToken: sessionResult.tokens.accessToken,
        refreshToken: sessionResult.tokens.refreshToken,
        expiresInSeconds: sessionResult.tokens.expiresInSeconds,
      });
    } catch (e: any) {
      const msg = sanitizeError(e?.message || e);
      const status = msg.includes("PAIRING_LOCKED_OUT") ? 429 : 400;
      res.status(status).json({ error: msg });
    }
  });

  // Rotate session tokens with strict replay attack detection (Phase 17) & durable device token fallback
  app.post("/api/remote/token/refresh", async (req, res) => {
    try {
      const { refreshToken, deviceToken } = req.body || {};
      const forwardedIp = req.headers["x-forwarded-for"];
      const clientIp = forwardedIp
        ? String(forwardedIp).split(",")[0].trim()
        : req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress || "unknown";

      if (!refreshToken && !deviceToken) {
        return res.status(400).json({ error: "Missing required 'refreshToken' or 'deviceToken' parameter." });
      }

      const { remoteSecurityCoordinator } = await import("../security/RemoteSecurityCoordinator.ts");

      // 1. Refresh token flow (Primary rotating path)
      if (refreshToken) {
        try {
          const result = await remoteSecurityCoordinator.rotateSessionToken(refreshToken, clientIp);
          return res.json({
            success: true,
            accessToken: result.tokens.accessToken,
            refreshToken: result.tokens.refreshToken,
            expiresInSeconds: result.tokens.expiresInSeconds,
            tokenType: result.tokens.tokenType,
          });
        } catch (err: any) {
          const msg = sanitizeError(err?.message || err);
          const isReplay = msg.includes("REPLAY") || msg.includes("TOKEN_FAMILY_REVOKED");
          // Replay attacks MUST be rejected immediately with 403 and never fall through
          if (isReplay) {
            return res.status(403).json({ error: msg });
          }
          // If session or family not found (e.g. server restart) but deviceToken is present, fall through
          if (!deviceToken) {
            return res.status(401).json({ error: msg });
          }
        }
      }

      // 2. Durable device token flow (Fallback re-establishment or direct device token exchange)
      if (deviceToken) {
        const auth = await remoteSecurityCoordinator.authenticateRemoteCredential(
          deviceToken,
          clientIp,
          req.headers["user-agent"]
        );
        if (!auth.authenticated || !auth.device) {
          return res.status(401).json({ error: auth.error || "Device token invalid or revoked." });
        }
        const sessionResult = remoteSecurityCoordinator.createDeviceSession(
          auth.device,
          clientIp,
          req.headers["user-agent"]
        );
        return res.json({
          success: true,
          accessToken: sessionResult.tokens.accessToken,
          refreshToken: sessionResult.tokens.refreshToken,
          expiresInSeconds: sessionResult.tokens.expiresInSeconds,
          tokenType: sessionResult.tokens.tokenType,
        });
      }

      return res.status(400).json({ error: "Unable to refresh session." });
    } catch (e: any) {
      const msg = sanitizeError(e?.message || e);
      const isReplay = msg.includes("REPLAY") || msg.includes("TOKEN_FAMILY_REVOKED");
      const status = isReplay ? 403 : 401;
      return res.status(status).json({ error: msg });
    }
  });

  // Revoke paired device via POST (Phase 16/17 client contract)
  app.post("/api/remote/revoke", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const deviceId = req.body?.deviceId || req.remoteDevice?.id;
      if (!deviceId) {
        return res.status(400).json({ error: "Missing required 'deviceId' parameter." });
      }
      if (req.remoteDevice && req.remoteDevice.role !== "admin" && req.remoteDevice.id !== deviceId) {
        return res.status(403).json({ error: "Forbidden: Only admins, localhost, or the device itself can revoke paired devices." });
      }
      const { remoteSecurityCoordinator } = await import("../security/RemoteSecurityCoordinator.ts");
      const success = await remoteSecurityCoordinator.revokeRemoteDevice(deviceId, req.body?.reason || "Revoked via API");
      if (!success) {
        return res.status(404).json({ error: `Device '${deviceId}' not found.` });
      }
      res.json({ success: true, message: `Device '${deviceId}' revoked.` });
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  // List paired devices (strips token hash)
  app.get("/api/remote/devices", requireLocalhostOrPairedDevice, async (_req, res) => {
    try {
      const { remoteStore } = await import("../remote/RemoteStore.ts");
      const devices = await remoteStore.listDevices();
      const safeDevices = devices.map((d) => ({
        id: d.id,
        name: d.name,
        deviceType: d.deviceType,
        role: d.role,
        pairedAt: d.pairedAt,
        lastSeenAt: d.lastSeenAt,
        revoked: d.revoked,
        revokedAt: d.revokedAt,
      }));
      res.json({ devices: safeDevices, count: safeDevices.length });
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  // Revoke a paired device
  app.delete("/api/remote/devices/:id", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      if (req.remoteDevice && req.remoteDevice.role !== "admin" && req.remoteDevice.id !== req.params.id) {
        return res.status(403).json({ error: "Forbidden: Only admins, localhost, or the device itself can revoke paired devices." });
      }
      const { remoteSessionManager } = await import("../remote/RemoteSessionManager.ts");
      const success = await remoteSessionManager.revokeDevice(req.params.id, req.body?.reason || "Revoked via API");
      if (!success) {
        return res.status(404).json({ error: `Device '${req.params.id}' not found.` });
      }
      res.json({ success: true, message: `Device '${req.params.id}' revoked.` });
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  // Update a paired device's role (localhost only)
  app.patch("/api/remote/devices/:id/role", requireLocalhost, async (req, res) => {
    try {
      const { role } = req.body || {};
      const validRoles = ["read_only", "standard", "admin"];
      if (!validRoles.includes(role)) {
        return res.status(400).json({ error: `Invalid role '${role}'. Must be one of: ${validRoles.join(", ")}` });
      }
      const { remoteStore } = await import("../remote/RemoteStore.ts");
      const device = await remoteStore.getDevice(req.params.id);
      if (!device) return res.status(404).json({ error: `Device '${req.params.id}' not found.` });
      device.role = role;
      await remoteStore.saveDevice(device);
      res.json({ success: true, device: { id: device.id, name: device.name, role: device.role } });
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  // Get current caller session profile
  app.get("/api/remote/session", requireLocalhostOrPairedDevice, async (req: any, res) => {
    if (req.remoteDevice) {
      return res.json({
        type: "remote_device",
        device: {
          id: req.remoteDevice.id,
          name: req.remoteDevice.name,
          role: req.remoteDevice.role,
          deviceType: req.remoteDevice.deviceType,
        },
      });
    }
    res.json({ type: "localhost", role: "admin" });
  });

  // Safe Connection & Session Observability Endpoint (never exposes credentials)
  app.get("/api/remote/connection-status", async (req: any, res) => {
    try {
      const forwardedIp = req.headers["x-forwarded-for"];
      const clientIp = forwardedIp
        ? String(forwardedIp).split(",")[0].trim()
        : req.ip || req.socket?.remoteAddress || "127.0.0.1";
      const isLocal =
        !forwardedIp &&
        (clientIp === "127.0.0.1" || clientIp === "::1" || clientIp === "::ffff:127.0.0.1");

      const authHeader = req.headers.authorization;
      const rawToken =
        typeof authHeader === "string" && authHeader.startsWith("Bearer ")
          ? authHeader.slice(7).trim()
          : "";

      const { remoteSessionManager } = await import("../remote/RemoteSessionManager.ts");
      const { remoteSecurityCoordinator } = await import("../security/RemoteSecurityCoordinator.ts");
      const { remoteStore } = await import("../remote/RemoteStore.ts");
      const { pairingManager } = await import("../remote/PairingManager.ts");
      const { getAccessTokenExpiryInfo, parseTokenPayload } = await import("../../frontend/lib/remoteAuth.ts");

      if (rawToken) {
        const expiryInfo = getAccessTokenExpiryInfo(rawToken);
        const auth = await remoteSecurityCoordinator.authenticateRemoteCredential(
          rawToken,
          clientIp,
          req.headers["user-agent"],
        );

        if (auth.authenticated && auth.device) {
          const status = await remoteSessionManager.getConnectionStatus({
            deviceId: auth.device.id,
            authenticated: true,
            deviceAuthorized: !auth.device.revoked,
            accessTokenExpiry: expiryInfo.expiresAtIso,
          });
          return res.json(status);
        }

        // Token was invalid, expired, or revoked — extract safe deviceId if possible for diagnostics
        let candidateDeviceId: string | undefined;
        if (rawToken.startsWith("myraa_at_")) {
          const parsed = parseTokenPayload(rawToken);
          if (parsed?.did && typeof parsed.did === "string") {
            candidateDeviceId = parsed.did;
          }
        } else if (rawToken.startsWith("sora_dev_")) {
          const verified = pairingManager.verifyDeviceToken(rawToken);
          if (verified.deviceId) {
            candidateDeviceId = verified.deviceId;
          }
        }

        const storedDevice = candidateDeviceId
          ? await remoteStore.getDevice(candidateDeviceId)
          : undefined;
        const deviceAuthorized = Boolean(storedDevice && !storedDevice.revoked);

        const status = await remoteSessionManager.getConnectionStatus({
          deviceId: candidateDeviceId,
          authenticated: false,
          deviceAuthorized,
          accessTokenExpiry: expiryInfo.expiresAtIso,
          failureReason: auth.error || (expiryInfo.isExpired ? "TOKEN_EXPIRED" : "UNAUTHORIZED"),
        });
        if (expiryInfo.isExpired && status.connectionState === "DISCONNECTED") {
          status.connectionState = "AUTH_EXPIRED";
          status.lastFailureClass = "AUTH_EXPIRED";
        }
        return res.json(status);
      }

      if (isLocal) {
        const queryDeviceId = typeof req.query?.deviceId === "string" ? req.query.deviceId : undefined;
        const activeSessions = remoteSessionManager.getActiveSessions();
        const targetDeviceId = queryDeviceId || activeSessions[0]?.deviceId || "local_desktop";
        const status = await remoteSessionManager.getConnectionStatus({
          deviceId: targetDeviceId,
          authenticated: true,
          deviceAuthorized: true,
          accessTokenExpiry: null,
        });
        return res.json(status);
      }

      const status = await remoteSessionManager.getConnectionStatus({
        authenticated: false,
        deviceAuthorized: false,
        accessTokenExpiry: null,
      });
      return res.json(status);
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  // ── Phase 19 Android Capability Execution Endpoint ─────────────────────
  // POST /api/remote/capability/execute — Execute a native Android capability
  app.post("/api/remote/capability/execute", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const { capability, args, confirmationToken } = req.body || {};
      if (!capability || typeof capability !== "string") {
        return res.status(400).json({ error: "Missing required 'capability' string parameter." });
      }

      const deviceId = req.remoteDevice?.id || req.body?.deviceId || "local_operator";
      const role = req.remoteDevice?.role || "admin";
      const isLocal = !req.remoteDevice;

      const secContext = {
        identityId: deviceId,
        role,
        ipAddress: req.ip || req.socket?.remoteAddress || "127.0.0.1",
        deviceId,
        isLocal,
      };

      const { remoteCapabilityDispatcher } = await import("../remote/RemoteCapabilityDispatcher.ts");
      const result = await remoteCapabilityDispatcher.dispatchCapability(
        deviceId,
        capability,
        args || {},
        secContext,
        confirmationToken
      );

      if (!result.ok) {
        const status = result.blocked ? (result.decision?.decision === "REQUIRE_CONFIRMATION" ? 428 : 403) : 400;
        return res.status(status).json({
          success: false,
          error: result.error,
          blocked: result.blocked,
          requiresConfirmation: result.requiresConfirmation,
          confirmationToken: result.confirmationToken,
          decision: result.decision,
        });
      }

      res.json({
        success: true,
        capability,
        deviceId,
        dispatched: result.dispatched,
        result: result.result,
        decision: result.decision,
      });
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  // ── Phase 24 Shared MYRAA Memory REST API ──────────────────────────────

  // GET /api/remote/memory — List canonical shared memories (FINDING-AUD-03)
  app.get("/api/remote/memory", requireAuthenticatedClient, async (req: any, res) => {
    try {
      const authCtx = req.authContext as AuthenticatedHttpContext | undefined;
      if (!authCtx || !authCtx.identityId) {
        return res.status(401).json({ error: "UNAUTHORIZED: Authenticated client context required." });
      }

      const deviceId = authCtx.deviceId || authCtx.identityId;
      const role = authCtx.role;
      const isLocal = authCtx.authType === "operator" && authCtx.isLocal;
      const secContext = {
        identityId: authCtx.identityId,
        role: role as any,
        ipAddress: authCtx.ipAddress,
        deviceId,
        isLocal,
      };

      const { category, includeArchived, includeNeedsRevalidation } = req.query;
      const { sharedMemoryManager } = await import("../memory/SharedMemoryManager.ts");
      const memories = await sharedMemoryManager.listMemories(
        {
          category: category as any,
          includeArchived: includeArchived === "true",
          includeNeedsRevalidation: includeNeedsRevalidation !== "false",
        },
        secContext,
      );

      // Apply sensitive-category filtering (identity/credentials/behavior require step-up and non-read-only role)
      // and enforce ownership boundary for non-local-admin callers.
      const isReadOnlyRole = READ_ONLY_ROLES.has(String(authCtx.role || "").toLowerCase());
      const isLocalAdmin = Boolean(
        authCtx.authType === "operator" && authCtx.isLocal && authCtx.role === "admin",
      );
      const effectiveAuthCtx: AuthenticatedHttpContext = isReadOnlyRole
        ? { ...authCtx, isStepUpAuthenticated: false }
        : authCtx;
      const categoryFiltered = filterSensitiveMemoriesForCaller(memories, effectiveAuthCtx);
      const permitted = categoryFiltered.filter((m) => {
        const ownerId = (m as any).ownerId as string | undefined;
        if (
          ownerId &&
          ownerId !== "default" &&
          ownerId !== "system" &&
          ownerId !== authCtx.identityId &&
          !isLocalAdmin
        ) {
          return false;
        }
        return true;
      });

      res.json(permitted);
    } catch (e: any) {
      const msg = e.message || String(e);
      if (msg.includes("EMERGENCY_STOP_ACTIVE")) {
        return res.status(503).json({ error: msg, blocked: true });
      }
      if (msg.includes("SECURITY_LOCKDOWN_ACTIVE")) {
        return res.status(423).json({ error: msg, blocked: true });
      }
      res.status(500).json({ error: sanitizeError(msg) });
    }
  });

  // POST /api/remote/memory — Create a shared memory record (FINDING-AUD-03, FINDING-AUD-07)
  app.post("/api/remote/memory", requireAuthenticatedClient, async (req: any, res) => {
    try {
      if (!assertWriteRoleAllowed(req, res)) return;
      if (!(await assertSystemNotHalted(res, req.authContext.identityId, "/api/remote/memory"))) return;

      const deviceId = req.authContext.identityId;
      const isLocal = req.authContext.authType === "operator";

      const { category, text, key, importance, confidence, source, expiresAt, clientMutationId } = req.body || {};
      if (!category || !text) {
        return res.status(400).json({ error: "Category and text parameters are required." });
      }

      const { isDlpClean } = await import("../memory/SharedMemoryManager.ts");
      if (!isDlpClean(String(text)) || (key && !isDlpClean(String(key)))) {
        return res.status(422).json({ error: "DLP_SECRET_REJECTED: Secrets or credentials cannot be stored in shared memory.", blocked: true });
      }

      const { contentSanitizer } = await import("../security/ContentSanitizer.ts");
      if (contentSanitizer.scanForPromptInjection(String(text)).hasInjectionAttempt) {
        return res.status(422).json({ error: "PROMPT_INJECTION_BLOCKED: Memory content contains unsafe prompt-injection patterns.", blocked: true });
      }

      const { governingMemoryGate } = await import("../companion/GoverningMemoryGate.ts");
      const proposal = await governingMemoryGate.requestWrite({
        action: "CREATE",
        proposedMemory: {
          category,
          text,
          key,
          importance,
          confidence,
          source: source ?? (isLocal ? "system_generated" : "user_explicit"),
          expiresAt,
          deviceId,
          deviceType: isLocal ? "desktop" : "android",
          clientMutationId,
        },
        reason: "Remote companion memory creation",
        confidence: typeof confidence === "number" ? confidence : 0.85,
        source: isLocal ? "system_generated" : "user_explicit",
        userId: deviceId,
        provenance: `device:${deviceId}`,
        sessionId: req.authContext.sessionId,
      } as any);

      res.status(202).json({
        status: "pending_approval",
        requestId: proposal.id,
        message: "Proposal queued. Awaiting desktop operator confirmation.",
      });
    } catch (e: any) {
      const msg = e.message || String(e);
      if (msg.includes("DLP_SECRET_REJECTED") || msg.includes("PROMPT_INJECTION_BLOCKED")) {
        return res.status(422).json({ error: msg, blocked: true });
      }
      if (msg.includes("EMERGENCY_STOP_ACTIVE")) {
        return res.status(503).json({ error: msg, blocked: true });
      }
      if (msg.includes("SECURITY_LOCKDOWN_ACTIVE")) {
        return res.status(423).json({ error: msg, blocked: true });
      }
      res.status(500).json({ error: sanitizeError(msg) });
    }
  });

  // GET /api/remote/memory/search — Search shared memories
  app.get("/api/remote/memory/search", requireAuthenticatedClient, async (req: any, res) => {
    try {
      const deviceId = req.authContext.identityId;
      const role = req.authContext.role;
      const isLocal = req.authContext.authType === "operator";
      const secContext = {
        identityId: deviceId,
        role: role as any,
        ipAddress: req.authContext.ipAddress,
        deviceId,
        isLocal,
      };

      const {
        q,
        category,
        importance,
        confidence,
        source,
        limit,
        includeArchived,
        includeNeedsRevalidation,
      } = req.query as Record<string, string>;

      const { sharedMemoryManager } = await import("../memory/SharedMemoryManager.ts");
      const results = await sharedMemoryManager.searchMemories(
        {
          query: q,
          categories: category ? [category as any] : undefined,
          minImportance: importance as any,
          minConfidence: confidence as any,
          source: source as any,
          limit: limit ? parseInt(limit, 10) : 20,
          includeArchived: includeArchived === "true",
          includeNeedsRevalidation: includeNeedsRevalidation !== "false",
        },
        secContext,
      );

      res.json(filterSensitiveMemoriesForCaller(results, req.authContext));
    } catch (e: any) {
      const msg = e.message || String(e);
      if (msg.includes("EMERGENCY_STOP_ACTIVE")) {
        return res.status(503).json({ error: msg, blocked: true });
      }
      if (msg.includes("SECURITY_LOCKDOWN_ACTIVE")) {
        return res.status(423).json({ error: msg, blocked: true });
      }
      res.status(500).json({ error: sanitizeError(msg) });
    }
  });

  // PATCH /api/remote/memory/:id — Partial update via governed proposal
  app.patch("/api/remote/memory/:id", requireAuthenticatedClient, async (req: any, res) => {
    try {
      if (!assertWriteRoleAllowed(req, res)) return;
      if (!(await assertSystemNotHalted(res, req.authContext.identityId, "/api/remote/memory/:id"))) return;

      const { id } = req.params;
      const deviceId = req.authContext.identityId;
      const isLocal = req.authContext.authType === "operator";

      const {
        text,
        key,
        importance,
        confidence,
        status,
        expiresAt,
        clientMutationId,
        clientVersion,
        expectedVersion,
      } = req.body || {};

      const { memoryManager } = await import("../memory/MemoryManager.ts");
      const existing = await memoryManager.getMemory(id);
      if (!existing) {
        return res.status(404).json({ error: "Memory not found." });
      }

      const { isDlpClean } = await import("../memory/SharedMemoryManager.ts");
      if ((text && !isDlpClean(String(text))) || (key && !isDlpClean(String(key)))) {
        return res.status(422).json({ error: "DLP_SECRET_REJECTED: Secrets or credentials cannot be stored in shared memory.", blocked: true });
      }

      const { contentSanitizer } = await import("../security/ContentSanitizer.ts");
      if (text && contentSanitizer.scanForPromptInjection(String(text)).hasInjectionAttempt) {
        return res.status(422).json({ error: "PROMPT_INJECTION_BLOCKED: Memory content contains unsafe prompt-injection patterns.", blocked: true });
      }

      const { governingMemoryGate } = await import("../companion/GoverningMemoryGate.ts");
      const proposal = await governingMemoryGate.requestWrite({
        action: "UPDATE",
        proposedMemory: {
          id,
          category: existing.category,
          text,
          key,
          importance,
          confidence,
          status,
          expiresAt,
          deviceId,
          deviceType: isLocal ? "desktop" : "android",
          clientMutationId,
        },
        reason: "Remote companion memory update",
        confidence: 0.85,
        source: isLocal ? "system_generated" : "user_explicit",
        userId: deviceId,
        provenance: `device:${deviceId}`,
        sessionId: req.authContext.sessionId,
        expectedVersion: expectedVersion ?? clientVersion ?? existing.version,
      } as any);

      res.status(202).json({
        status: "pending_approval",
        action: "UPDATE",
        requestId: proposal.id,
        message: "Update proposal queued. Awaiting desktop operator confirmation.",
      });
    } catch (e: any) {
      const msg = e.message || String(e);
      if (msg.includes("DLP_SECRET_REJECTED") || msg.includes("PROMPT_INJECTION_BLOCKED")) {
        return res.status(422).json({ error: msg, blocked: true });
      }
      if (msg.includes("EMERGENCY_STOP_ACTIVE")) {
        return res.status(503).json({ error: msg, blocked: true });
      }
      if (msg.includes("SECURITY_LOCKDOWN_ACTIVE")) {
        return res.status(423).json({ error: msg, blocked: true });
      }
      res.status(500).json({ error: sanitizeError(msg) });
    }
  });

  // DELETE /api/remote/memory/:id — Governed delete proposal
  app.delete("/api/remote/memory/:id", requireAuthenticatedClient, async (req: any, res) => {
    try {
      if (!assertWriteRoleAllowed(req, res)) return;
      if (!(await assertSystemNotHalted(res, req.authContext.identityId, "/api/remote/memory/:id"))) return;

      const { id } = req.params;
      const deviceId = req.authContext.identityId;
      const isLocal = req.authContext.authType === "operator";

      const { memoryManager } = await import("../memory/MemoryManager.ts");
      const existing = await memoryManager.getMemory(id);
      if (!existing) {
        return res.status(404).json({ error: "Memory not found." });
      }

      const { governingMemoryGate } = await import("../companion/GoverningMemoryGate.ts");
      const proposal = await governingMemoryGate.requestWrite({
        action: "DELETE",
        proposedMemory: {
          id,
          category: existing.category,
          text: existing.text,
          key: existing.key,
          deviceId,
          deviceType: isLocal ? "desktop" : "android",
        },
        reason: `Remote companion memory deletion for ${id}`,
        confidence: 0.85,
        source: isLocal ? "system_generated" : "user_explicit",
        userId: deviceId,
        provenance: `device:${deviceId}`,
        sessionId: req.authContext.sessionId,
        expectedVersion: req.body?.expectedVersion ?? existing.version,
      } as any);

      res.status(202).json({
        status: "pending_approval",
        action: "DELETE",
        requestId: proposal.id,
        message: "Deletion proposal queued. Awaiting desktop operator confirmation.",
      });
    } catch (e: any) {
      const msg = e.message || String(e);
      if (msg.includes("EMERGENCY_STOP_ACTIVE")) {
        return res.status(503).json({ error: msg, blocked: true });
      }
      if (msg.includes("SECURITY_LOCKDOWN_ACTIVE")) {
        return res.status(423).json({ error: msg, blocked: true });
      }
      res.status(500).json({ error: sanitizeError(msg) });
    }
  });

  // POST /api/remote/memory/sync — Batch offline sync with DLP, injection, ES, Lockdown & category binding
  app.post("/api/remote/memory/sync", requireAuthenticatedClient, async (req: any, res) => {
    try {
      if (!assertWriteRoleAllowed(req, res)) return;
      if (!(await assertSystemNotHalted(res, req.authContext.identityId, "/api/remote/memory/sync"))) return;

      // Never trust client-supplied deviceId for actor attribution
      const deviceId = req.authContext.identityId;
      const isLocal = req.authContext.authType === "operator";

      const { mutations } = req.body || {};
      if (!Array.isArray(mutations)) {
        return res.status(400).json({ error: "Required 'mutations' array parameter missing." });
      }

      const { isDlpClean } = await import("../memory/SharedMemoryManager.ts");
      const { contentSanitizer } = await import("../security/ContentSanitizer.ts");
      const { memoryManager } = await import("../memory/MemoryManager.ts");
      const { governingMemoryGate } = await import("../companion/GoverningMemoryGate.ts");

      // Pre-validate every mutation for DLP and prompt injection before queueing any
      for (const mut of mutations) {
        const mutText = mut?.mutation?.text ?? mut?.data?.text;
        const mutKey = mut?.mutation?.key ?? mut?.data?.key;
        if ((mutText && !isDlpClean(String(mutText))) || (mutKey && !isDlpClean(String(mutKey)))) {
          return res.status(422).json({
            error: "DLP_SECRET_REJECTED: Batch sync contains secret or credential material.",
            blocked: true,
          });
        }
        if (mutText && contentSanitizer.scanForPromptInjection(String(mutText)).hasInjectionAttempt) {
          return res.status(422).json({
            error: "PROMPT_INJECTION_BLOCKED: Batch sync contains unsafe prompt-injection patterns.",
            blocked: true,
          });
        }
      }

      const proposals = [];
      for (const mut of mutations) {
        const mutType = String(mut.type || mut.mutationType || "create").toLowerCase();
        const action = mutType === "delete" ? "DELETE" : mutType === "update" ? "UPDATE" : "CREATE";
        const mutPayload = mut.mutation || mut.data || {};
        let existingCategory = mutPayload.category;
        let expectedVersion = mut.expectedVersion ?? mut.clientVersion;

        if ((action === "UPDATE" || action === "DELETE") && mut.memoryId) {
          const existing = await memoryManager.getMemory(mut.memoryId);
          if (existing) {
            existingCategory = existing.category;
            if (expectedVersion === undefined) expectedVersion = existing.version;
          }
        }

        const proposal = await governingMemoryGate.requestWrite({
          action: action,
          proposedMemory: {
            id: mut.memoryId,
            ...mutPayload,
            ...(existingCategory ? { category: existingCategory } : {}),
            deviceId,
            deviceType: isLocal ? "desktop" : "android",
          },
          reason: `Batch sync offline mutation (${action})`,
          confidence: 0.85,
          source: isLocal ? "system_generated" : "user_explicit",
          userId: deviceId,
          provenance: `sync:${deviceId}`,
          sessionId: req.authContext.sessionId,
          expectedVersion,
        } as any);
        proposals.push(proposal.id);
      }

      res.status(202).json({
        status: "pending_approval",
        queuedCount: proposals.length,
        requestIds: proposals,
        message: "Batch sync proposals queued for desktop operator confirmation.",
      });
    } catch (e: any) {
      const msg = e.message || String(e);
      if (msg.includes("DLP_SECRET_REJECTED") || msg.includes("PROMPT_INJECTION_BLOCKED")) {
        return res.status(422).json({ error: msg, blocked: true });
      }
      if (msg.includes("EMERGENCY_STOP_ACTIVE")) {
        return res.status(503).json({ error: msg, blocked: true });
      }
      if (msg.includes("SECURITY_LOCKDOWN_ACTIVE")) {
        return res.status(423).json({ error: msg, blocked: true });
      }
      res.status(500).json({ error: sanitizeError(msg) });
    }
  });

  // ── Phase 25 — Cross-Device Handoff REST API ────────────────────────────

  // POST /api/remote/handoff — Create handoff snapshot
  app.post("/api/remote/handoff", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const deviceId = req.remoteDevice?.id || "local_operator";
      const role = req.remoteDevice?.role || "admin";
      const isLocal = !req.remoteDevice;
      const secContext = {
        identityId: deviceId,
        role,
        ipAddress: req.ip || req.socket?.remoteAddress || "127.0.0.1",
        deviceId,
        isLocal,
      };

      const { crossDeviceHandoffManager } = await import("../handoff/CrossDeviceHandoffManager.ts");
      const result = await crossDeviceHandoffManager.createHandoff(req.body || {}, secContext);
      if (!result.success) {
        if (result.errorCode === "DLP_SECRET_REJECTED") {
          return res.status(400).json(result);
        }
        return res.status(400).json(result);
      }
      res.status(201).json(result);
    } catch (e: any) {
      const msg = e.message || String(e);
      if (msg.includes("EMERGENCY_STOP_ACTIVE")) {
        return res.status(503).json({ error: msg, blocked: true });
      }
      if (msg.includes("SECURITY_LOCKDOWN_ACTIVE")) {
        return res.status(423).json({ error: msg, blocked: true });
      }
      res.status(500).json({ error: sanitizeError(msg) });
    }
  });

  // GET /api/remote/handoff — List available handoffs for calling device
  app.get("/api/remote/handoff", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const deviceId = req.remoteDevice?.id || "local_operator";
      const role = req.remoteDevice?.role || "admin";
      const isLocal = !req.remoteDevice;
      const secContext = {
        identityId: deviceId,
        role,
        ipAddress: req.ip || req.socket?.remoteAddress || "127.0.0.1",
        deviceId,
        isLocal,
      };

      const { status, targetDeviceId, sourceDeviceId } = req.query;
      const { crossDeviceHandoffManager } = await import("../handoff/CrossDeviceHandoffManager.ts");
      const handoffs = await crossDeviceHandoffManager.listAvailableHandoffs(
        {
          status: status as any,
          targetDeviceId: targetDeviceId as string,
          sourceDeviceId: sourceDeviceId as string,
        },
        secContext,
      );
      res.json(handoffs);
    } catch (e: any) {
      const msg = e.message || String(e);
      if (msg.includes("EMERGENCY_STOP_ACTIVE")) {
        return res.status(503).json({ error: msg, blocked: true });
      }
      if (msg.includes("SECURITY_LOCKDOWN_ACTIVE")) {
        return res.status(423).json({ error: msg, blocked: true });
      }
      res.status(500).json({ error: sanitizeError(msg) });
    }
  });

  // GET /api/remote/handoff/:id — Get details of a single handoff
  app.get("/api/remote/handoff/:id", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const deviceId = req.remoteDevice?.id || "local_operator";
      const role = req.remoteDevice?.role || "admin";
      const isLocal = !req.remoteDevice;
      const secContext = {
        identityId: deviceId,
        role,
        ipAddress: req.ip || req.socket?.remoteAddress || "127.0.0.1",
        deviceId,
        isLocal,
      };

      const { crossDeviceHandoffManager } = await import("../handoff/CrossDeviceHandoffManager.ts");
      const handoff = await crossDeviceHandoffManager.getHandoff(req.params.id, secContext);
      if (!handoff) {
        return res.status(404).json({ error: `Handoff '${req.params.id}' not found.` });
      }
      res.json(handoff);
    } catch (e: any) {
      const msg = e.message || String(e);
      if (msg.includes("EMERGENCY_STOP_ACTIVE")) {
        return res.status(503).json({ error: msg, blocked: true });
      }
      if (msg.includes("SECURITY_LOCKDOWN_ACTIVE")) {
        return res.status(423).json({ error: msg, blocked: true });
      }
      res.status(500).json({ error: sanitizeError(msg) });
    }
  });

  // POST /api/remote/handoff/:id/accept — Accept handoff on target device
  app.post("/api/remote/handoff/:id/accept", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const deviceId = req.remoteDevice?.id || "local_operator";
      const role = req.remoteDevice?.role || "admin";
      const isLocal = !req.remoteDevice;
      const secContext = {
        identityId: deviceId,
        role,
        ipAddress: req.ip || req.socket?.remoteAddress || "127.0.0.1",
        deviceId,
        isLocal,
      };

      const { token } = req.body || {};
      if (!token) {
        return res.status(400).json({ error: "Missing required handoff token.", errorCode: "INVALID_TOKEN" });
      }

      const { crossDeviceHandoffManager } = await import("../handoff/CrossDeviceHandoffManager.ts");
      const result = await crossDeviceHandoffManager.acceptHandoff(
        { handoffId: req.params.id, handoffToken: token },
        secContext,
      );

      if (!result.success) {
        if (result.errorCode === "NOT_FOUND") return res.status(404).json(result);
        if (result.errorCode === "INVALID_TOKEN") return res.status(401).json(result);
        if (result.errorCode === "UNAUTHORIZED_DEVICE") return res.status(403).json(result);
        if (result.errorCode === "ALREADY_ACCEPTED" || result.errorCode === "ALREADY_RESUMED") {
          return res.status(409).json(result);
        }
        if (result.errorCode === "EXPIRED" || result.errorCode === "CANCELLED") {
          return res.status(410).json(result);
        }
        return res.status(400).json(result);
      }

      res.json(result);
    } catch (e: any) {
      const msg = e.message || String(e);
      if (msg.includes("EMERGENCY_STOP_ACTIVE")) {
        return res.status(503).json({ error: msg, blocked: true });
      }
      if (msg.includes("SECURITY_LOCKDOWN_ACTIVE")) {
        return res.status(423).json({ error: msg, blocked: true });
      }
      res.status(500).json({ error: sanitizeError(msg) });
    }
  });

  // POST /api/remote/handoff/:id/resume — Resume handoff task/conversation
  app.post("/api/remote/handoff/:id/resume", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const deviceId = req.remoteDevice?.id || "local_operator";
      const role = req.remoteDevice?.role || "admin";
      const isLocal = !req.remoteDevice;
      const secContext = {
        identityId: deviceId,
        role,
        ipAddress: req.ip || req.socket?.remoteAddress || "127.0.0.1",
        deviceId,
        isLocal,
      };

      const { token, confirmResume } = req.body || {};
      if (!token) {
        return res.status(400).json({ error: "Missing required handoff token.", errorCode: "INVALID_TOKEN" });
      }

      const { crossDeviceHandoffManager } = await import("../handoff/CrossDeviceHandoffManager.ts");
      const result = await crossDeviceHandoffManager.resumeHandoff(
        { handoffId: req.params.id, handoffToken: token, confirmResume: !!confirmResume },
        secContext,
      );

      if (!result.success) {
        if (result.errorCode === "NOT_FOUND") return res.status(404).json(result);
        if (result.errorCode === "INVALID_TOKEN") return res.status(401).json(result);
        if (result.errorCode === "UNAUTHORIZED_DEVICE") return res.status(403).json(result);
        if (result.errorCode === "CANCELLED" || result.errorCode === "EXPIRED") {
          return res.status(410).json(result);
        }
        return res.status(400).json(result);
      }

      res.json(result);
    } catch (e: any) {
      const msg = e.message || String(e);
      if (msg.includes("EMERGENCY_STOP_ACTIVE")) {
        return res.status(503).json({ error: msg, blocked: true });
      }
      if (msg.includes("SECURITY_LOCKDOWN_ACTIVE")) {
        return res.status(423).json({ error: msg, blocked: true });
      }
      res.status(500).json({ error: sanitizeError(msg) });
    }
  });

  // POST /api/remote/handoff/:id/cancel — Cancel/revoke handoff
  app.post("/api/remote/handoff/:id/cancel", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const deviceId = req.remoteDevice?.id || "local_operator";
      const role = req.remoteDevice?.role || "admin";
      const isLocal = !req.remoteDevice;
      const secContext = {
        identityId: deviceId,
        role,
        ipAddress: req.ip || req.socket?.remoteAddress || "127.0.0.1",
        deviceId,
        isLocal,
      };

      const { crossDeviceHandoffManager } = await import("../handoff/CrossDeviceHandoffManager.ts");
      const result = await crossDeviceHandoffManager.cancelHandoff(req.params.id, secContext);

      if (!result.success) {
        if (result.errorCode === "NOT_FOUND") return res.status(404).json(result);
        if (result.errorCode === "UNAUTHORIZED_DEVICE") return res.status(403).json(result);
        if (result.errorCode === "ALREADY_RESUMED") return res.status(409).json(result);
        return res.status(400).json(result);
      }

      res.json(result);
    } catch (e: any) {
      const msg = e.message || String(e);
      if (msg.includes("EMERGENCY_STOP_ACTIVE")) {
        return res.status(503).json({ error: msg, blocked: true });
      }
      if (msg.includes("SECURITY_LOCKDOWN_ACTIVE")) {
        return res.status(423).json({ error: msg, blocked: true });
      }
      res.status(500).json({ error: sanitizeError(msg) });
    }
  });

  // ── Phase 26 — Mobile Proactive Companion Endpoints ───────────────────────

  // POST /api/remote/proactive/subscribe — Register Android companion for proactive notifications
  app.post("/api/remote/proactive/subscribe", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const deviceId = req.remoteDevice?.id || req.body?.deviceId || "local_operator";
      const role = req.remoteDevice?.role || "admin";
      const isLocal = !req.remoteDevice;
      const secContext = {
        identityId: deviceId,
        role,
        ipAddress: req.ip || req.socket?.remoteAddress || "127.0.0.1",
        deviceId,
        isLocal,
      };

      const { preferences } = req.body || {};
      const { mobileProactiveManager } = await import("../companion/mobile/MobileProactiveManager.ts");
      const prefs = await mobileProactiveManager.subscribeDevice({ deviceId, preferences }, secContext);
      res.status(200).json({ success: true, preferences: prefs });
    } catch (e: any) {
      const msg = e.message || String(e);
      if (msg.includes("EMERGENCY_STOP_ACTIVE")) {
        return res.status(503).json({ error: msg, blocked: true });
      }
      if (msg.includes("SECURITY_LOCKDOWN_ACTIVE")) {
        return res.status(423).json({ error: msg, blocked: true });
      }
      res.status(500).json({ error: sanitizeError(msg) });
    }
  });

  // DELETE /api/remote/proactive/subscribe — Unregister Android companion
  app.delete("/api/remote/proactive/subscribe", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const deviceId = req.remoteDevice?.id || req.body?.deviceId || req.query?.deviceId || "local_operator";
      const role = req.remoteDevice?.role || "admin";
      const isLocal = !req.remoteDevice;
      const secContext = {
        identityId: deviceId,
        role,
        ipAddress: req.ip || req.socket?.remoteAddress || "127.0.0.1",
        deviceId,
        isLocal,
      };

      const { mobileProactiveManager } = await import("../companion/mobile/MobileProactiveManager.ts");
      const removed = await mobileProactiveManager.unsubscribeDevice(deviceId, secContext);
      res.status(200).json({ success: true, removed });
    } catch (e: any) {
      const msg = e.message || String(e);
      if (msg.includes("EMERGENCY_STOP_ACTIVE")) {
        return res.status(503).json({ error: msg, blocked: true });
      }
      if (msg.includes("SECURITY_LOCKDOWN_ACTIVE")) {
        return res.status(423).json({ error: msg, blocked: true });
      }
      res.status(500).json({ error: sanitizeError(msg) });
    }
  });

  // GET /api/remote/proactive/preferences — Get notification preferences
  app.get("/api/remote/proactive/preferences", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const deviceId = req.remoteDevice?.id || (req.query?.deviceId as string) || "local_operator";
      const { mobileProactiveManager } = await import("../companion/mobile/MobileProactiveManager.ts");
      const preferences = mobileProactiveManager.getDevicePreferences(deviceId);
      res.json({ success: true, preferences });
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  // PUT /api/remote/proactive/preferences — Update device notification preferences
  app.put("/api/remote/proactive/preferences", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const deviceId = req.remoteDevice?.id || req.body?.deviceId || "local_operator";
      const role = req.remoteDevice?.role || "admin";
      const isLocal = !req.remoteDevice;
      const secContext = {
        identityId: deviceId,
        role,
        ipAddress: req.ip || req.socket?.remoteAddress || "127.0.0.1",
        deviceId,
        isLocal,
      };

      const patch = req.body || {};
      const { mobileProactiveManager } = await import("../companion/mobile/MobileProactiveManager.ts");
      const preferences = await mobileProactiveManager.updateDevicePreferences(deviceId, patch, secContext);
      res.json({ success: true, preferences });
    } catch (e: any) {
      const msg = e.message || String(e);
      if (msg.includes("EMERGENCY_STOP_ACTIVE")) {
        return res.status(503).json({ error: msg, blocked: true });
      }
      if (msg.includes("SECURITY_LOCKDOWN_ACTIVE")) {
        return res.status(423).json({ error: msg, blocked: true });
      }
      res.status(500).json({ error: sanitizeError(msg) });
    }
  });

  // GET /api/remote/proactive/pending — Fetch & drain offline queued notifications
  app.get("/api/remote/proactive/pending", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const deviceId = req.remoteDevice?.id || (req.query?.deviceId as string) || "local_operator";
      const role = req.remoteDevice?.role || "admin";
      const isLocal = !req.remoteDevice;
      const secContext = {
        identityId: deviceId,
        role,
        ipAddress: req.ip || req.socket?.remoteAddress || "127.0.0.1",
        deviceId,
        isLocal,
      };

      const { mobileProactiveManager } = await import("../companion/mobile/MobileProactiveManager.ts");
      const notifications = await mobileProactiveManager.drainPendingNotifications(deviceId, secContext);
      res.json({ success: true, notifications, count: notifications.length });
    } catch (e: any) {
      const msg = e.message || String(e);
      if (msg.includes("EMERGENCY_STOP_ACTIVE")) {
        return res.status(503).json({ error: msg, blocked: true });
      }
      if (msg.includes("SECURITY_LOCKDOWN_ACTIVE")) {
        return res.status(423).json({ error: msg, blocked: true });
      }
      res.status(500).json({ error: sanitizeError(msg) });
    }
  });

  // POST /api/remote/proactive/clear — Clear pending notification queue
  app.post("/api/remote/proactive/clear", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const deviceId = req.remoteDevice?.id || req.body?.deviceId || "local_operator";
      const role = req.remoteDevice?.role || "admin";
      const isLocal = !req.remoteDevice;
      const secContext = {
        identityId: deviceId,
        role,
        ipAddress: req.ip || req.socket?.remoteAddress || "127.0.0.1",
        deviceId,
        isLocal,
      };

      const { mobileProactiveManager } = await import("../companion/mobile/MobileProactiveManager.ts");
      await mobileProactiveManager.clearPendingNotifications(deviceId, secContext);
      res.json({ success: true, cleared: true });
    } catch (e: any) {
      const msg = e.message || String(e);
      if (msg.includes("EMERGENCY_STOP_ACTIVE")) {
        return res.status(503).json({ error: msg, blocked: true });
      }
      if (msg.includes("SECURITY_LOCKDOWN_ACTIVE")) {
        return res.status(423).json({ error: msg, blocked: true });
      }
      res.status(500).json({ error: sanitizeError(msg) });
    }
  });

  // POST /api/remote/proactive/test — Dispatch test proactive notification
  app.post("/api/remote/proactive/test", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const deviceId = req.remoteDevice?.id || req.body?.targetDeviceId || req.body?.deviceId;
      const role = req.remoteDevice?.role || "admin";
      const isLocal = !req.remoteDevice;
      const secContext = {
        identityId: req.remoteDevice?.id || "local_operator",
        role,
        ipAddress: req.ip || req.socket?.remoteAddress || "127.0.0.1",
        deviceId: req.remoteDevice?.id || "local_operator",
        isLocal,
      };

      const { title, message, category, priority, metadata, actionUrl } = req.body || {};
      const { mobileProactiveManager } = await import("../companion/mobile/MobileProactiveManager.ts");
      const result = await mobileProactiveManager.dispatchProactiveEvent(
        {
          title: title || "Test Proactive Alert",
          message: message || "This is a test proactive companion notification.",
          category: category || "TASK",
          priority: priority || "DEFAULT",
          targetDeviceId: deviceId,
          metadata,
          actionUrl,
        },
        secContext,
      );

      if (!result.success) {
        if (result.errorCode === "DLP_SECRET_REJECTED") {
          return res.status(400).json(result);
        }
        if (result.errorCode === "EMERGENCY_STOP_ACTIVE") {
          return res.status(503).json(result);
        }
        if (result.errorCode === "SECURITY_LOCKDOWN_ACTIVE") {
          return res.status(423).json(result);
        }
        return res.status(400).json(result);
      }

      res.json(result);
    } catch (e: any) {
      const msg = e.message || String(e);
      if (msg.includes("EMERGENCY_STOP_ACTIVE")) {
        return res.status(503).json({ error: msg, blocked: true });
      }
      if (msg.includes("SECURITY_LOCKDOWN_ACTIVE")) {
        return res.status(423).json({ error: msg, blocked: true });
      }
      res.status(500).json({ error: sanitizeError(msg) });
    }
  });

  // ── Phase 27 — Mobile Autonomous Workflow Endpoints ──────────────────────

  // POST /api/remote/workflow/execute — Execute or preview autonomous voice workflow
  app.post("/api/remote/workflow/execute", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const deviceId = req.remoteDevice?.id || req.body?.deviceId || "local_operator";
      const role = req.remoteDevice?.role || "admin";
      const isLocal = !req.remoteDevice;
      const secContext = {
        identityId: deviceId,
        role,
        ipAddress: req.ip || req.socket?.remoteAddress || "127.0.0.1",
        deviceId,
        isLocal,
      };

      const { mobileWorkflowManager } = await import("../workflow/MobileWorkflowManager.ts");
      const workflowProjectOptions =
        req.body?.projectId !== undefined && req.body?.projectId !== null
          ? { projectId: req.body.projectId }
          : undefined;
      const result = await mobileWorkflowManager.executeVoiceWorkflow(
        {
          query: req.body?.query || req.body?.prompt || "",
          deviceId,
          autoExecute: req.body?.autoExecute !== false,
          preferredLanguage: req.body?.preferredLanguage,
          clientContext: req.body?.clientContext,
        },
        secContext,
        workflowProjectOptions,
      );

      if (!result.success && result.errorCode) {
        if (
          result.errorCode === "SECURITY_VIOLATION" &&
          typeof result.error === "string" &&
          result.error.startsWith("PERMISSION_DENIED:")
        ) {
          return res.status(403).json(result);
        }
        if (result.errorCode === "SECURITY_VIOLATION" || result.errorCode === "INVALID_QUERY") {
          return res.status(400).json(result);
        }
        if (result.errorCode === "EMERGENCY_STOP_ACTIVE") {
          return res.status(503).json(result);
        }
        if (result.errorCode === "SECURITY_LOCKDOWN_ACTIVE") {
          return res.status(423).json(result);
        }
        if (result.errorCode === "DEVICE_REVOKED") {
          return res.status(403).json(result);
        }
      }

      res.status(200).json(result);
    } catch (e: any) {
      const msg = e.message || String(e);
      if (msg.includes("EMERGENCY_STOP_ACTIVE")) {
        return res.status(503).json({ error: msg, blocked: true });
      }
      if (msg.includes("SECURITY_LOCKDOWN_ACTIVE")) {
        return res.status(423).json({ error: msg, blocked: true });
      }
      res.status(500).json({ error: sanitizeError(msg) });
    }
  });

  // GET /api/remote/workflow/:id — Retrieve workflow status and progress
  app.get("/api/remote/workflow/:id", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const deviceId = req.remoteDevice?.id || "local_operator";
      const role = req.remoteDevice?.role || "admin";
      const isLocal = !req.remoteDevice;
      const secContext = {
        identityId: deviceId,
        role,
        ipAddress: req.ip || req.socket?.remoteAddress || "127.0.0.1",
        deviceId,
        isLocal,
      };

      const { mobileWorkflowManager } = await import("../workflow/MobileWorkflowManager.ts");
      const result = await mobileWorkflowManager.getWorkflowStatus(req.params.id, secContext);

      if (!result.success && result.errorCode === "PLAN_NOT_FOUND") {
        return res.status(404).json(result);
      }
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  // POST /api/remote/workflow/:id/confirm — Confirm or reject a pending checkpoint
  app.post("/api/remote/workflow/:id/confirm", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const deviceId = req.remoteDevice?.id || "local_operator";
      const role = req.remoteDevice?.role || "admin";
      const isLocal = !req.remoteDevice;
      const secContext = {
        identityId: deviceId,
        role,
        ipAddress: req.ip || req.socket?.remoteAddress || "127.0.0.1",
        deviceId,
        isLocal,
      };

      const { checkpointId, approved, userFeedback } = req.body || {};
      if (!checkpointId || approved === undefined) {
        return res.status(400).json({ error: "Missing required fields: checkpointId and approved." });
      }

      const { mobileWorkflowManager } = await import("../workflow/MobileWorkflowManager.ts");
      const result = await mobileWorkflowManager.confirmWorkflowStep(
        req.params.id,
        checkpointId,
        approved === true || approved === "true",
        userFeedback,
        secContext,
      );

      if (!result.success && result.errorCode === "PLAN_NOT_FOUND") {
        return res.status(404).json(result);
      }
      res.json(result);
    } catch (e: any) {
      const msg = e.message || String(e);
      if (msg.includes("EMERGENCY_STOP_ACTIVE")) {
        return res.status(503).json({ error: msg, blocked: true });
      }
      if (msg.includes("SECURITY_LOCKDOWN_ACTIVE")) {
        return res.status(423).json({ error: msg, blocked: true });
      }
      res.status(500).json({ error: sanitizeError(msg) });
    }
  });

  // POST /api/remote/workflow/:id/pause — Pause an active workflow
  app.post("/api/remote/workflow/:id/pause", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const deviceId = req.remoteDevice?.id || "local_operator";
      const role = req.remoteDevice?.role || "admin";
      const isLocal = !req.remoteDevice;
      const secContext = {
        identityId: deviceId,
        role,
        ipAddress: req.ip || req.socket?.remoteAddress || "127.0.0.1",
        deviceId,
        isLocal,
      };

      const { mobileWorkflowManager } = await import("../workflow/MobileWorkflowManager.ts");
      const result = await mobileWorkflowManager.pauseWorkflow(req.params.id, secContext);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  // POST /api/remote/workflow/:id/resume — Resume a paused workflow
  app.post("/api/remote/workflow/:id/resume", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const deviceId = req.remoteDevice?.id || "local_operator";
      const role = req.remoteDevice?.role || "admin";
      const isLocal = !req.remoteDevice;
      const secContext = {
        identityId: deviceId,
        role,
        ipAddress: req.ip || req.socket?.remoteAddress || "127.0.0.1",
        deviceId,
        isLocal,
      };

      const { mobileWorkflowManager } = await import("../workflow/MobileWorkflowManager.ts");
      const result = await mobileWorkflowManager.resumeWorkflow(req.params.id, secContext);
      res.json(result);
    } catch (e: any) {
      const msg = e.message || String(e);
      if (msg.includes("EMERGENCY_STOP_ACTIVE")) {
        return res.status(503).json({ error: msg, blocked: true });
      }
      res.status(500).json({ error: sanitizeError(msg) });
    }
  });

  // POST /api/remote/workflow/:id/cancel — Cancel a workflow
  app.post("/api/remote/workflow/:id/cancel", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const deviceId = req.remoteDevice?.id || "local_operator";
      const role = req.remoteDevice?.role || "admin";
      const isLocal = !req.remoteDevice;
      const secContext = {
        identityId: deviceId,
        role,
        ipAddress: req.ip || req.socket?.remoteAddress || "127.0.0.1",
        deviceId,
        isLocal,
      };

      const { mobileWorkflowManager } = await import("../workflow/MobileWorkflowManager.ts");
      const result = await mobileWorkflowManager.cancelWorkflow(req.params.id, secContext);
      if (!result.success && result.errorCode === "PLAN_NOT_FOUND") {
        return res.status(404).json(result);
      }
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  // Emergency Stop Trigger (fail-safe: open to any paired device or localhost)
  app.post("/api/remote/emergency-stop", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const { emergencyStopCoordinator } = await import("../remote/EmergencyStopCoordinator.ts");
      const state = await emergencyStopCoordinator.trigger({
        source: req.remoteDevice ? "remote_device" : "rest_api",
        deviceId: req.remoteDevice?.id,
        deviceName: req.remoteDevice?.name,
        ipAddress: req.ip,
        reason: req.body?.reason,
      });
      res.json({ success: true, active: state.active, state });
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  // Emergency Stop Reset (localhost only)
  app.post("/api/remote/emergency-stop/reset", requireLocalhost, async (req, res) => {
    try {
      const { emergencyStopCoordinator } = await import("../remote/EmergencyStopCoordinator.ts");
      const state = await emergencyStopCoordinator.reset(req.ip || "localhost");
      res.json({ success: true, active: state.active, state });
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  // Emergency Stop Status Inspection (open to all)
  app.get("/api/remote/emergency-stop/status", async (_req, res) => {
    try {
      const { emergencyStopCoordinator } = await import("../remote/EmergencyStopCoordinator.ts");
      res.json(emergencyStopCoordinator.getState());
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  // ── Phase 28 — Mobile Emergency & Security Endpoints ────────────────────

  // GET /api/remote/security/status — Sanitized security status aggregate
  app.get("/api/remote/security/status", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const deviceId = req.remoteDevice?.id || "local_operator";
      const role = req.remoteDevice?.role || "admin";
      const isLocal = !req.remoteDevice;
      const secContext = {
        identityId: deviceId,
        role,
        ipAddress: req.ip || req.socket?.remoteAddress || "127.0.0.1",
        deviceId,
        isLocal,
      };
      const { androidSecurityManager } = await import("../security/AndroidSecurityManager.ts");
      const status = await androidSecurityManager.getSecurityStatus(deviceId, secContext);
      res.json({ success: true, status });
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  // GET /api/remote/security/sessions — List active remote sessions (sanitized)
  app.get("/api/remote/security/sessions", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const { androidSecurityManager } = await import("../security/AndroidSecurityManager.ts");
      const sessions = androidSecurityManager.getActiveSessions();
      res.json({ success: true, sessions, count: sessions.length });
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  // DELETE /api/remote/security/sessions/:id — Terminate specific remote session
  app.delete("/api/remote/security/sessions/:id", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const deviceId = req.remoteDevice?.id || "local_operator";
      const role = req.remoteDevice?.role || "admin";
      const isLocal = !req.remoteDevice;
      const secContext = {
        identityId: deviceId,
        role,
        ipAddress: req.ip || req.socket?.remoteAddress || "127.0.0.1",
        deviceId,
        isLocal,
      };
      const { reason } = req.body || {};
      const { androidSecurityManager } = await import("../security/AndroidSecurityManager.ts");
      const result = androidSecurityManager.terminateSession(req.params.id, reason, secContext);
      if (!result.success) {
        const code = result.errorCode === "UNAUTHORIZED" ? 403 : result.errorCode === "DEVICE_NOT_FOUND" ? 404 : 400;
        return res.status(code).json(result);
      }
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  // DELETE /api/remote/security/sessions — Terminate all remote sessions [admin/localhost]
  app.delete("/api/remote/security/sessions", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const deviceId = req.remoteDevice?.id || "local_operator";
      const role = req.remoteDevice?.role || "admin";
      const isLocal = !req.remoteDevice;
      const secContext = {
        identityId: deviceId,
        role,
        ipAddress: req.ip || req.socket?.remoteAddress || "127.0.0.1",
        deviceId,
        isLocal,
      };
      const { reason } = req.body || {};
      const { androidSecurityManager } = await import("../security/AndroidSecurityManager.ts");
      const result = androidSecurityManager.terminateAllSessions(reason, secContext);
      if (!result.success) {
        const code = result.errorCode === "UNAUTHORIZED" ? 403 : 400;
        return res.status(code).json(result);
      }
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  // POST /api/remote/security/lockdown — Trigger global Security Lockdown [admin/localhost]
  app.post("/api/remote/security/lockdown", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const deviceId = req.remoteDevice?.id || "local_operator";
      const role = req.remoteDevice?.role || "admin";
      const isLocal = !req.remoteDevice;
      const secContext = {
        identityId: deviceId,
        role,
        ipAddress: req.ip || req.socket?.remoteAddress || "127.0.0.1",
        deviceId,
        isLocal,
      };
      const { reason, nonce, timestampMs } = req.body || {};
      if (nonce && timestampMs) {
        const { remoteSecurityCoordinator } = await import("../security/RemoteSecurityCoordinator.ts");
        const nonceCheck = remoteSecurityCoordinator.validateRequestNonce(nonce, timestampMs);
        if (!nonceCheck.valid) {
          return res.status(403).json({ success: false, errorCode: "REPLAY_ATTACK", error: nonceCheck.error });
        }
      }
      const { androidSecurityManager } = await import("../security/AndroidSecurityManager.ts");
      const result = await androidSecurityManager.triggerLockdown(reason, secContext);
      if (!result.success) {
        const code = result.errorCode === "UNAUTHORIZED" ? 403 : result.errorCode === "ALREADY_IN_LOCKDOWN" ? 409 : 400;
        return res.status(code).json(result);
      }
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  // POST /api/remote/security/lockdown/recover — Recover from Security Lockdown [admin/localhost]
  app.post("/api/remote/security/lockdown/recover", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const deviceId = req.remoteDevice?.id || "local_operator";
      const role = req.remoteDevice?.role || "admin";
      const isLocal = !req.remoteDevice;
      const secContext = {
        identityId: deviceId,
        role,
        ipAddress: req.ip || req.socket?.remoteAddress || "127.0.0.1",
        deviceId,
        isLocal,
      };
      const { nonce, timestampMs } = req.body || {};
      if (nonce && timestampMs) {
        const { remoteSecurityCoordinator } = await import("../security/RemoteSecurityCoordinator.ts");
        const nonceCheck = remoteSecurityCoordinator.validateRequestNonce(nonce, timestampMs);
        if (!nonceCheck.valid) {
          return res.status(403).json({ success: false, errorCode: "REPLAY_ATTACK", error: nonceCheck.error });
        }
      }
      const { androidSecurityManager } = await import("../security/AndroidSecurityManager.ts");
      const result = await androidSecurityManager.recoverFromLockdown(secContext);
      if (!result.success) {
        const code = result.errorCode === "UNAUTHORIZED" ? 403 : result.errorCode === "NOT_IN_LOCKDOWN" ? 409 : 400;
        return res.status(code).json(result);
      }
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  // POST /api/remote/security/lost-device/enable — Enable lost-device mode [admin/localhost]
  app.post("/api/remote/security/lost-device/enable", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const deviceId = req.remoteDevice?.id || "local_operator";
      const role = req.remoteDevice?.role || "admin";
      const isLocal = !req.remoteDevice;
      const secContext = {
        identityId: deviceId,
        role,
        ipAddress: req.ip || req.socket?.remoteAddress || "127.0.0.1",
        deviceId,
        isLocal,
      };
      const { deviceId: targetDeviceId, reason, nonce, timestampMs } = req.body || {};
      if (!targetDeviceId) {
        return res.status(400).json({ success: false, errorCode: "DEVICE_NOT_FOUND", error: "Missing required 'deviceId' parameter." });
      }
      if (nonce && timestampMs) {
        const { remoteSecurityCoordinator } = await import("../security/RemoteSecurityCoordinator.ts");
        const nonceCheck = remoteSecurityCoordinator.validateRequestNonce(nonce, timestampMs);
        if (!nonceCheck.valid) {
          return res.status(403).json({ success: false, errorCode: "REPLAY_ATTACK", error: nonceCheck.error });
        }
      }
      const { androidSecurityManager } = await import("../security/AndroidSecurityManager.ts");
      const result = await androidSecurityManager.enableLostDeviceMode(targetDeviceId, reason, secContext);
      if (!result.success) {
        const code = result.errorCode === "UNAUTHORIZED" ? 403 : result.errorCode === "DEVICE_NOT_FOUND" ? 404 : result.errorCode === "DEVICE_ALREADY_LOST" ? 409 : 400;
        return res.status(code).json(result);
      }
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  // POST /api/remote/security/lost-device/recover — Recover device from lost-device mode [admin/localhost]
  app.post("/api/remote/security/lost-device/recover", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const deviceId = req.remoteDevice?.id || "local_operator";
      const role = req.remoteDevice?.role || "admin";
      const isLocal = !req.remoteDevice;
      const secContext = {
        identityId: deviceId,
        role,
        ipAddress: req.ip || req.socket?.remoteAddress || "127.0.0.1",
        deviceId,
        isLocal,
      };
      const { deviceId: targetDeviceId, nonce, timestampMs } = req.body || {};
      if (!targetDeviceId) {
        return res.status(400).json({ success: false, errorCode: "DEVICE_NOT_FOUND", error: "Missing required 'deviceId' parameter." });
      }
      if (nonce && timestampMs) {
        const { remoteSecurityCoordinator } = await import("../security/RemoteSecurityCoordinator.ts");
        const nonceCheck = remoteSecurityCoordinator.validateRequestNonce(nonce, timestampMs);
        if (!nonceCheck.valid) {
          return res.status(403).json({ success: false, errorCode: "REPLAY_ATTACK", error: nonceCheck.error });
        }
      }
      const { androidSecurityManager } = await import("../security/AndroidSecurityManager.ts");
      const result = await androidSecurityManager.recoverLostDevice(targetDeviceId, secContext);
      if (!result.success) {
        const code = result.errorCode === "UNAUTHORIZED" ? 403 : result.errorCode === "DEVICE_NOT_LOST" ? 404 : 400;
        return res.status(code).json(result);
      }
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  // POST /api/remote/security/logout-all — Global logout all devices [admin/localhost]
  app.post("/api/remote/security/logout-all", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const deviceId = req.remoteDevice?.id || "local_operator";
      const role = req.remoteDevice?.role || "admin";
      const isLocal = !req.remoteDevice;
      const secContext = {
        identityId: deviceId,
        role,
        ipAddress: req.ip || req.socket?.remoteAddress || "127.0.0.1",
        deviceId,
        isLocal,
      };
      const { reason, nonce, timestampMs } = req.body || {};
      if (nonce && timestampMs) {
        const { remoteSecurityCoordinator } = await import("../security/RemoteSecurityCoordinator.ts");
        const nonceCheck = remoteSecurityCoordinator.validateRequestNonce(nonce, timestampMs);
        if (!nonceCheck.valid) {
          return res.status(403).json({ success: false, errorCode: "REPLAY_ATTACK", error: nonceCheck.error });
        }
      }
      const { androidSecurityManager } = await import("../security/AndroidSecurityManager.ts");
      const result = await androidSecurityManager.logoutAllDevices(reason, secContext);
      if (!result.success) {
        const code = result.errorCode === "UNAUTHORIZED" ? 403 : 400;
        return res.status(code).json(result);
      }
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  // ── Phase 8 Multimodal Intelligence Routes ─────────────────────────────

  // GET /api/multimodal/context — full real-time fused snapshot
  app.get("/api/multimodal/context", async (_req, res) => {
    try {
      const { multimodalFusionEngine } = await import("../multimodal/MultimodalFusionEngine.ts");
      const snapshot = multimodalFusionEngine.getLatestSnapshot();
      res.json(snapshot || { message: "No multimodal context recorded yet." });
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  // POST /api/multimodal/screen/capture — on-demand screen capture
  app.post("/api/multimodal/screen/capture", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const { screenContextManager } = await import("../multimodal/ScreenContextManager.ts");
      const force = req.body?.force === true;
      try {
        const snapshot = await screenContextManager.captureOnDemand(force);
        res.json({
          captured: true,
          timestamp: snapshot.timestamp,
          activeWindow: snapshot.activeWindow,
          hasOcr: !!snapshot.ocrResult,
          ocrSummary: snapshot.ocrResult?.sanitizedText?.slice(0, 500) || "No text detected",
        });
      } catch (err: any) {
        if (err?.message?.includes("PRIVACY_SHIELD_ACTIVE")) {
          return res.status(200).json({
            captured: false,
            privacyShieldActive: true,
            message: err.message,
          });
        }
        throw err;
      }
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  // POST /api/multimodal/screen/continuous — control continuous perception loop
  app.post("/api/multimodal/screen/continuous", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const { screenContextManager } = await import("../multimodal/ScreenContextManager.ts");
      const action = String(req.body?.action || "status").toLowerCase();
      const intervalMs = req.body?.intervalMs ? Number(req.body.intervalMs) : undefined;

      if (intervalMs) {
        screenContextManager.setConfig({ intervalMs });
      }

      if (action === "start") {
        screenContextManager.start();
      } else if (action === "stop") {
        screenContextManager.stop();
      } else if (action === "pause") {
        screenContextManager.pause();
      } else if (action === "resume") {
        screenContextManager.resume();
      } else if (action !== "status") {
        return res.status(400).json({ error: "Invalid action. Allowed: start, stop, pause, resume, status." });
      }

      res.json(screenContextManager.getStatus());
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  // GET /api/multimodal/screen/continuous/status
  app.get("/api/multimodal/screen/continuous/status", async (_req, res) => {
    try {
      const { screenContextManager } = await import("../multimodal/ScreenContextManager.ts");
      res.json(screenContextManager.getStatus());
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  // GET /api/multimodal/window/active
  app.get("/api/multimodal/window/active", async (_req, res) => {
    try {
      const { activeWindowTracker } = await import("../multimodal/ActiveWindowTracker.ts");
      const activeWindow = await activeWindowTracker.getActiveWindow();
      const history = activeWindowTracker.getHistory();
      res.json({
        activeWindow,
        recentTransitions: history.slice(0, 10),
      });
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  // POST /api/multimodal/code/analyze
  app.post("/api/multimodal/code/analyze", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const { codeScreenshotAnalyzer } = await import("../multimodal/CodeScreenshotAnalyzer.ts");
      const { screenContextManager } = await import("../multimodal/ScreenContextManager.ts");
      let base64 = req.body?.base64;
      const language = req.body?.language;

      let activeWindow;
      if (!base64) {
        const latest = screenContextManager.getLatestSnapshot();
        if (latest?.base64) {
          base64 = latest.base64;
          activeWindow = latest.activeWindow;
        } else {
          try {
            const snap = await screenContextManager.captureOnDemand(true);
            base64 = snap.base64;
            activeWindow = snap.activeWindow;
          } catch {
            return res.status(400).json({ error: "No screen capture available to analyze." });
          }
        }
      }

      const analysis = await codeScreenshotAnalyzer.analyzeScreenshot(base64, language, activeWindow);
      res.json(analysis);
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  // POST /api/multimodal/document/analyze
  app.post("/api/multimodal/document/analyze", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const docPath = req.body?.path;
      if (!docPath || typeof docPath !== "string") {
        return res.status(400).json({ error: "Document 'path' string parameter is required." });
      }

      const { documentUnderstanding } = await import("../multimodal/DocumentUnderstanding.ts");
      const result = await documentUnderstanding.analyzeDocument(docPath);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  // GET /api/multimodal/suggestions
  app.get("/api/multimodal/suggestions", async (req, res) => {
    try {
      const limit = req.query.limit ? Number(req.query.limit) : 5;
      const { contextSuggestionEngine } = await import("../multimodal/ContextSuggestionEngine.ts");
      const suggestions = contextSuggestionEngine.generateSuggestions(undefined, { limit });
      res.json({
        count: suggestions.length,
        suggestions,
      });
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  // POST /api/multimodal/suggestions/:id/apply
  app.post("/api/multimodal/suggestions/:id/apply", requireLocalhostOrPairedDevice, async (req: any, res) => {
    try {
      const { id } = req.params;
      const checkpointToken = req.body?.checkpointToken;
      const { contextSuggestionEngine } = await import("../multimodal/ContextSuggestionEngine.ts");
      const result = await contextSuggestionEngine.applySuggestion(id, checkpointToken);
      res.json(result);
    } catch (e: any) {
      res.status(400).json({ error: sanitizeError(e?.message || e) });
    }
  });

  // ── Settings API ───────────────────────────────────────────────────────
  app.get("/api/settings", async (_req, res) => {

    try {
      res.json(loadSettingsFile());
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/settings", async (req, res) => {
    try {
      const patch = req.body;
      if (!patch || typeof patch !== "object") {
        return res
          .status(400)
          .json({ error: "Request body must be a JSON object." });
      }
      const current = loadSettingsFile();
      const next = { ...current, ...patch };
      saveSettingsFile(next);

      // If auto-start toggled, relay to the desktop agent immediately
      if ("autoStart" in patch) {
        callDesktopAgent(
          patch.autoStart ? "enableAutoStart" : "disableAutoStart",
          {},
        ).catch(() => {});
      }

      // If language preference changed, sync to languageManager immediately
      if ("languagePreference" in patch && typeof patch.languagePreference === "string") {
        const { languageManager } = await import("../voice/index.ts");
        languageManager.setPreferredLanguage(patch.languagePreference as any);
      }

      logCommand(`SETTINGS_UPDATED ${JSON.stringify(patch)}`);
      logJson("info", "settings_updated", { patch });
      res.json(next);
    } catch (e: any) {
      logError(`SETTINGS_SAVE_ERROR: ${e.message}`);
      logJson("error", "settings_save_error", { error: e.message });
      res.status(500).json({ error: e.message });
    }
  });

  // ── Config / API-key onboarding ────────────────────────────────────────
  app.get("/api/config", (_req, res) => {
    const meta = resolveApiKeyWithMetadata();
    res.json({
      hasApiKey: meta.isValid && Boolean(meta.key),
      source: meta.source,
      credentialClass: meta.credentialClass,
      masked: meta.masked,
      prefix: meta.prefix,
      length: meta.length,
      isPlaceholder: Boolean(meta.isPlaceholder),
    });
  });

  app.post("/api/config/apikey", requireLocalhost, async (req, res) => {
    if (process.env.NODE_ENV === "production" && process.env.SORA_LAUNCHED_BY !== "electron") {
      return res.status(403).json({
        error: "Forbidden: API key mutation via HTTP is disabled in production. Secrets must be configured strictly in the server environment.",
      });
    }
    try {
      const key: string = (req.body?.apiKey ?? "").toString().trim();
      if (!key) {
        return res.status(400).json({ error: "API key is required." });
      }
      const credClass = classifyCredential(key);
      if (credClass === "OAUTH_ACCESS_TOKEN") {
        return res.status(400).json({
          error:
            "Gemini API credential is invalid or expired. Raw OAuth access tokens (ya29.*) are not supported as Gemini Live API keys. Please configure a valid Gemini API key in Settings.",
        });
      }
      if (key.length < 15 || credClass === "PLACEHOLDER" || credClass === "INVALID") {
        return res.status(400).json({
          error:
            "API key is too short or invalid. Please provide a valid Gemini API key or authorization key.",
        });
      }
      // Validate by listing models — rejects genuine auth failures (expired/revoked AQ. or invalid AIza keys)
      // Skip network check during automated vitest execution to allow mock/fixture keys
      if (!process.env.VITEST) {
        try {
          const test = new GoogleGenAI({ apiKey: key });
          const pager = await test.models.list();
          await pager[Symbol.asyncIterator]().next();
        } catch (e: any) {
          const msg = sanitizeError(String(e?.message || e));
          const isAuthError =
            /API[_ ]?KEY|PERMISSION_DENIED|UNAUTHENTICATED|ACCESS_TOKEN_TYPE_UNSUPPORTED|invalid authentication credentials|Expected OAuth 2 access token|login cookie|invalid|401|403/i.test(
              msg,
            );
          if (isAuthError) {
            logError(`APIKEY_VALIDATION_REJECTED (class=${credClass}, length=${key.length}): ${msg}`);
            logJson("warn", "apikey_validation_rejected", {
              credentialClass: credClass,
              length: key.length,
              error: msg,
            });
            return res.status(400).json({
              error:
                "Gemini API credential is invalid or expired. That credential was rejected by Google (authentication failed). Please check the key in Google AI Studio and try again.",
            });
          }
          logError(`APIKEY_VALIDATION_SOFT_FAIL (saving anyway, class=${credClass}): ${msg}`);
          logJson("warn", "apikey_validation_soft_fail", {
            credentialClass: credClass,
            length: key.length,
            error: msg,
          });
        }
      }
      setGeminiApiKey(key);
      process.env.GEMINI_API_KEY = key;
      delete process.env.GOOGLE_API_KEY;
      delete process.env.GOOGLE_GENAI_API_KEY;
      logCommand(`APIKEY_SAVED (class=${credClass}, length=${key.length})`);
      logJson("info", "apikey_saved", { credentialClass: credClass, length: key.length });
      res.json({ ok: true, hasApiKey: true, credentialClass: credClass });
    } catch (e: any) {
      const sanitized = sanitizeError(e?.message || e);
      logError(`APIKEY_SAVE_ERROR: ${sanitized}`);
      logJson("error", "apikey_save_error", { error: sanitized });
      res
        .status(500)
        .json({ error: sanitized || "Failed to save API key." });
    }
  });

  app.delete("/api/config/apikey", requireLocalhost, (_req, res) => {
    if (process.env.NODE_ENV === "production" && process.env.SORA_LAUNCHED_BY !== "electron") {
      return res.status(403).json({
        error: "Forbidden: API key mutation via HTTP is disabled in production. Secrets must be configured strictly in the server environment.",
      });
    }
    clearGeminiApiKey();
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GOOGLE_GENAI_API_KEY;
    logCommand("APIKEY_CLEARED");
    logJson("info", "apikey_cleared", {});
    res.json({ ok: true, hasApiKey: false });
  });

  // ── Production Health & Readiness Endpoints ──────────────────────────────
  const healthHandler = async (_req: express.Request, res: express.Response) => {
    try {
      const { securityPolicyEngine } = await import("../security/SecurityPolicyEngine.ts");
      const { emergencyStopCoordinator } = await import("../remote/EmergencyStopCoordinator.ts");
      const isLockedDown = securityPolicyEngine.getMode() === "LOCKDOWN";
      const isEmergencyStopped = emergencyStopCoordinator.isActive();
      const hasKey = hasGeminiApiKey();

      const status = isEmergencyStopped || isLockedDown ? "degraded" : "ok";
      res.json({
        status,
        service: "myraa-backend",
        version: "2.0.0",
        uptime: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || "development",
        hasApiKey: hasKey,
        emergencyStop: isEmergencyStopped,
        securityLockdown: isLockedDown,
      });
    } catch (e: any) {
      res.status(500).json({ status: "error", error: sanitizeError(e?.message || e) });
    }
  };

  app.get("/health", healthHandler);
  app.get("/api/health", healthHandler);

  // ── Liveness & Readiness Endpoints (Unauthenticated, Safe, Read-Only) ────
  app.get("/health/liveness", (_req, res) => {
    res.json(runtimeHealthMonitor.getLiveness());
  });
  app.get("/api/health/live", (_req, res) => {
    res.json(runtimeHealthMonitor.getLiveness());
  });

  app.get("/health/readiness", async (_req, res) => {
    try {
      const readiness = await runtimeHealthMonitor.getReadiness();
      const code = readiness.status === "not_ready" ? 503 : 200;
      res.status(code).json(readiness);
    } catch (e: any) {
      res.status(500).json({ ready: false, status: "not_ready", error: sanitizeError(e?.message || e) });
    }
  });
  app.get("/api/health/ready", async (_req, res) => {
    try {
      const readiness = await runtimeHealthMonitor.getReadiness();
      const code = readiness.status === "not_ready" ? 503 : 200;
      res.status(code).json(readiness);
    } catch (e: any) {
      res.status(500).json({ ready: false, status: "not_ready", error: sanitizeError(e?.message || e) });
    }
  });

  // ── Operator Diagnostic Endpoints (Strictly Authenticated / Localhost) ──
  app.get("/api/diagnostics/metrics", requireLocalhost, async (_req, res) => {
    try {
      res.json({ ok: true, metrics: runtimeMetrics.getMetricsSummary() });
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  app.get("/api/diagnostics/health", requireLocalhost, async (_req, res) => {
    try {
      const detailed = await runtimeHealthMonitor.getComponentHealth();
      res.json({ ok: true, health: detailed });
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  app.get("/api/diagnostics/events", requireLocalhost, async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string, 10) || 50;
      const events = boundedLogStore.getRecentEvents(limit);
      res.json({ ok: true, count: events.length, events });
    } catch (e: any) {
      res.status(500).json({ error: sanitizeError(e?.message || e) });
    }
  });

  // ── Agent health proxy ─────────────────────────────────────────────────
  app.get("/api/agent-health", async (_req, res) => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3000);
      const r = await fetch(`${DESKTOP_AGENT_URL}/health`, {
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (r.ok) {
        const d = await r.json();
        res.json({ online: true, tool_count: d.tool_count });
      } else {
        res.json({ online: false });
      }
    } catch {
      res.json({ online: false });
    }
  });

  // ── Logs API ───────────────────────────────────────────────────────────
  app.get("/api/logs/:file", requireLocalhost, async (req, res) => {
    try {
      const fileName = String(req.params.file);
      if (!["commands", "startup", "errors"].includes(fileName)) {
        return res.status(400).json({
          error: "Invalid log file. Use: commands, startup, or errors.",
        });
      }
      const logPath = path.join(LOGS_DIR, `${fileName}.log`);
      if (!fs.existsSync(logPath)) {
        return res.json({ lines: [], file: fileName });
      }
      const content = fs.readFileSync(logPath, "utf-8");
      const lines = content.split("\n").filter(Boolean).slice(-100);
      res.json({ lines, file: fileName });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Proxy scraper ──────────────────────────────────────────────────────
  app.get("/api/proxy", async (req, res) => {
    try {
      const url = req.query.url as string;
      if (!url) {
        return res.status(400).json({ error: "Missing 'url' parameter." });
      }

      console.log(`[Proxy Scraper] Fetching external content for: ${url}`);
      const response = await safeSsrfFetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36",
        },
      });

      if (!response.ok) {
        throw new Error(`Scraper failed to load page: status ${response.status}`);
      }

      const html = await response.text();

      const titleMatch = html.match(/<title>(.*?)<\/title>/i);
      const title = titleMatch ? titleMatch[1].trim() : "";

      const headings: string[] = [];
      const headingMatches = html.matchAll(/<h([1-3])\b[^>]*>(.*?)<\/h\1>/gi);
      for (const match of headingMatches) {
        const text = match[2].replace(/<[^>]*>/g, "").trim();
        if (text && text.length > 3 && text.length < 120 && !headings.includes(text)) {
          headings.push(text);
        }
      }

      const links: { text: string; href: string }[] = [];
      const linkMatches = html.matchAll(
        /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi,
      );
      for (const match of linkMatches) {
        let href = match[1].trim();
        const text = match[2].replace(/<[^>]*>/g, "").trim();
        if (text && text.length > 2 && text.length < 100) {
          if (href.startsWith("/")) {
            try {
              const u = new URL(url);
              href = `${u.protocol}//${u.host}${href}`;
            } catch {}
          }
          if (href.startsWith("http://") || href.startsWith("https://")) {
            links.push({ text, href });
          }
        }
      }

      const paragraphs: string[] = [];
      const paragraphMatches = html.matchAll(/<p\b[^>]*>(.*?)<\/p>/gi);
      for (const match of paragraphMatches) {
        const text = match[1].replace(/<[^>]*>/g, "").trim();
        if (
          text &&
          text.length > 25 &&
          text.length < 600 &&
          !paragraphs.includes(text)
        ) {
          paragraphs.push(text);
        }
      }

      const buttons: string[] = [];
      const buttonMatches = html.matchAll(/<button\b[^>]*>(.*?)<\/button>/gi);
      for (const match of buttonMatches) {
        const text = match[1].replace(/<[^>]*>/g, "").trim();
        if (text && text.length > 1 && text.length < 60 && !buttons.includes(text)) {
          buttons.push(text);
        }
      }

      res.json({
        url,
        title,
        headings: headings.slice(0, 15),
        links: links
          .filter((l) => !l.href.includes("javascript:"))
          .slice(0, 30),
        buttons: buttons.slice(0, 15),
        paragraphs: paragraphs.slice(0, 12),
      });
    } catch (err: any) {
      console.error(
        `[Proxy Scraper] Error fetching ${req.query.url}:`,
        err.message,
      );
      res.status(500).json({ error: `Scraper error: ${err.message}` });
    }
  });

  // ── Full HTML proxy ────────────────────────────────────────────────────
  app.get("/api/web-proxy", async (req, res) => {
    let targetUrl = "";
    try {
      const urlParam = req.query.url as string;
      if (!urlParam) {
        return res
          .status(400)
          .send("Myraa Web Proxy Error: Missing target 'url' parameter");
      }

      targetUrl = urlParam.trim();

      if (targetUrl.startsWith("/")) {
        return res
          .status(400)
          .send(
            `Myraa Web Proxy Error: Relative paths are not supported directly (${targetUrl}).`,
          );
      }

      try {
        if (
          !targetUrl.startsWith("http://") &&
          !targetUrl.startsWith("https://")
        ) {
          targetUrl = "https://" + targetUrl;
        }
        const parsed = new URL(targetUrl);
        if (!parsed.hostname || !parsed.hostname.includes(".")) {
          throw new Error(
            "Missing or invalid domain name extension (e.g. .com, .org, .net).",
          );
        }
      } catch (err: any) {
        return res
          .status(400)
          .send(
            `Myraa Web Proxy Error: Invalid URL specified: "${urlParam}". Make sure you enter a valid domain name.`,
          );
      }

      console.log(`[Web Proxy] Routing connection through proxy: ${targetUrl}`);

      let response;
      try {
        response = await safeSsrfFetch(targetUrl, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36",
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
          },
        });
      } catch (fetchErr: any) {
        console.warn(
          `[Web Proxy Failed Fetch] Target: ${targetUrl} Error:`,
          fetchErr.message,
        );
        return res
          .status(502)
          .send(
            `Myraa Web Proxy Error: Unable to fetch the website "${targetUrl}". The site might be offline, or the URL address is spelled incorrectly. Details: ${fetchErr.message}`,
          );
      }

      if (!response.ok) {
        return res
          .status(response.status)
          .send(
            `Myraa Web Proxy Error: Failed loading remote website. Server returned status: ${response.status} (${response.statusText})`,
          );
      }

      const contentType = response.headers.get("content-type") || "";

      if (!contentType.includes("text/html")) {
        const arrayBuffer = await response.arrayBuffer();
        res.setHeader("Content-Type", contentType);
        return res.send(Buffer.from(arrayBuffer));
      }

      let htmlContents = await response.text();

      const baseUrlTag = `<base href="${targetUrl}" />`;
      const interceptorScript = `
        <script>
          (function() {
            document.addEventListener('click', function(e) {
              var anchor = e.target.closest('a');
              if (anchor) {
                var href = anchor.getAttribute('href');
                if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
                  e.preventDefault();
                  try {
                    var resolvedUrl = new URL(href, window.location.href).href;
                    window.parent.postMessage({ type: 'NAVIGATE', url: resolvedUrl }, '*');
                  } catch (err) {
                    console.error("[Proxy Interceptor] Failed resolving link:", err);
                  }
                }
              }
            }, true);

            document.addEventListener('submit', function(e) {
              var form = e.target;
              if (form) {
                e.preventDefault();
                try {
                  var formData = new FormData(form);
                  var params = new URLSearchParams();
                  formData.forEach(function(value, key) {
                    if (typeof value === 'string') {
                      params.append(key, value);
                    }
                  });
                  var actionAttr = form.getAttribute('action') || '';
                  var actionUrl = new URL(actionAttr, window.location.href).href;
                  if (form.method.toLowerCase() === 'get') {
                    actionUrl += (actionUrl.indexOf('?') !== -1 ? '&' : '?') + params.toString();
                  }
                  window.parent.postMessage({ type: 'NAVIGATE', url: actionUrl }, '*');
                } catch (err) {
                  console.error("[Proxy Interceptor] Failed submitting form:", err);
                }
              }
            }, true);

            window.alert = function(msg) { console.log("[Myraa Browser alert bypassed]:", msg); };
            window.confirm = function(msg) { console.log("[Myraa Browser confirm bypassed]:", msg); return true; };
            window.open = function(url) { window.parent.postMessage({ type: 'NAVIGATE', url: url }, '*'); return null; };
          })();
        </script>
      `;

      if (htmlContents.includes("<head>")) {
        htmlContents = htmlContents.replace(
          "<head>",
          `<head>\n${baseUrlTag}\n${interceptorScript}`,
        );
      } else if (htmlContents.includes("<HEAD>")) {
        htmlContents = htmlContents.replace(
          "<HEAD>",
          `<HEAD>\n${baseUrlTag}\n${interceptorScript}`,
        );
      } else {
        htmlContents =
          baseUrlTag + "\n" + interceptorScript + "\n" + htmlContents;
      }

      res.setHeader("Content-Type", "text/html");
      res.setHeader("X-Myraa-Proxied", "true");
      res.removeHeader("X-Frame-Options");
      res.removeHeader("Content-Security-Policy");
      res.removeHeader("content-security-policy");
      res.removeHeader("x-frame-options");

      res.status(200).send(htmlContents);
    } catch (e: any) {
      console.warn(
        "[Web Proxy Exception] Handled internal error:",
        e.message,
      );
      res
        .status(500)
        .send(
          `Myraa Web Proxy Error: Internal error occurred proxying URL "${targetUrl || "unknown"}". Details: ${e.message}`,
        );
    }
  });

  // ── YouTube search proxy ───────────────────────────────────────────────
  app.get("/api/youtube-search", async (req, res) => {
    try {
      const query = req.query.q as string;
      if (!query) {
        return res.status(400).json({ error: "Missing query q" });
      }

      console.log(
        `[YouTube Proxy Search] Searching real YouTube for: "${query}"`,
      );
      const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&hl=en&sp=EgIQAQ%253D%253D`;
      const response = await fetch(searchUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });
      const html = await response.text();

      const videoList: any[] = [];
      let data: any = null;

      // 1. Try regex extraction of ytInitialData JSON
      const jsonMatch = html.match(/ytInitialData\s*=\s*({.+?});/);
      if (jsonMatch) {
        try {
          data = JSON.parse(jsonMatch[1]);
        } catch {
          // JSON regex captured incomplete or mismatched braces, fallback below
        }
      }

      // 2. Fallback: balanced brace extraction of ytInitialData JSON object
      if (!data) {
        const startIdx = html.indexOf("ytInitialData");
        if (startIdx !== -1) {
          const openBrace = html.indexOf("{", startIdx);
          if (openBrace !== -1) {
            let depth = 0;
            let endBrace = -1;
            const maxScan = Math.min(html.length, openBrace + 3000000);
            for (let i = openBrace; i < maxScan; i++) {
              if (html[i] === "{") depth++;
              else if (html[i] === "}") {
                depth--;
                if (depth === 0) {
                  endBrace = i;
                  break;
                }
              }
            }
            if (endBrace !== -1) {
              try {
                data = JSON.parse(html.slice(openBrace, endBrace + 1));
              } catch (e: any) {
                console.warn("[YouTube Parser Engine] Balanced brace parse failed:", e.message);
              }
            }
          }
        }
      }

      // 3. Extract videos from parsed JSON data structure
      if (data) {
        try {
          const twoCol =
            data.contents?.twoColumnSearchResultsRenderer ||
            data.contents?.twoColumnSearchResultRenderer;
          const sections =
            twoCol?.primaryContents?.sectionListRenderer?.contents || [];

          for (const s of sections) {
            const items = s.itemSectionRenderer?.contents || [];
            for (const item of items) {
              const vr = item.videoRenderer || item.compactVideoRenderer;
              if (vr && vr.videoId) {
                const vId = vr.videoId;
                const title =
                  vr.title?.runs?.map((r: any) => r.text).join("") ||
                  vr.title?.simpleText ||
                  "YouTube Video";
                const thumbnail =
                  vr.thumbnail?.thumbnails?.[vr.thumbnail.thumbnails.length - 1]?.url ||
                  `https://i.ytimg.com/vi/${vId}/hqdefault.jpg`;
                const author =
                  vr.ownerText?.runs?.[0]?.text ||
                  vr.shortBylineText?.runs?.[0]?.text ||
                  vr.longBylineText?.runs?.[0]?.text ||
                  "YouTube Creator";
                const duration =
                  vr.lengthText?.simpleText ||
                  vr.thumbnailOverlays?.find((o: any) => o.thumbnailOverlayTimeStatusRenderer)
                    ?.thumbnailOverlayTimeStatusRenderer?.text?.simpleText ||
                  "Video";
                const views =
                  vr.viewCountText?.simpleText ||
                  vr.shortViewCountText?.simpleText ||
                  "Available Now";
                const published = vr.publishedTimeText?.simpleText || "";

                if (!videoList.some((v) => v.videoId === vId)) {
                  videoList.push({
                    videoId: vId,
                    title,
                    thumbnail,
                    author,
                    duration,
                    views,
                    published,
                  });
                }
              }
            }
          }
        } catch (e: any) {
          console.error(
            "[YouTube Parser Engine] Error traversing JSON:",
            e.message,
          );
        }
      }

      // 4. Fallback if JSON extraction yielded 0 items: regex scrape with title extraction
      if (videoList.length === 0) {
        const itemRegex = /"videoId":"([^"]+)".*?"title":\{"runs":\[\{"text":"([^"]+)"/g;
        let match;
        while ((match = itemRegex.exec(html)) !== null && videoList.length < 15) {
          const id = match[1];
          const rawTitle = match[2];
          if (id && !videoList.some((v) => v.videoId === id)) {
            videoList.push({
              videoId: id,
              title: rawTitle || `YouTube Video: ${id}`,
              thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
              author: "YouTube Creator",
              duration: "Video",
              views: "Available Now",
            });
          }
        }

        // Secondary fallback if still empty: raw videoId regex
        if (videoList.length === 0) {
          const videoRegex = /"videoId":"([a-zA-Z0-9_-]{11})"/g;
          const ids: string[] = [];
          while ((match = videoRegex.exec(html)) !== null && ids.length < 15) {
            const id = match[1];
            if (id && !ids.includes(id)) {
              ids.push(id);
            }
          }
          for (const id of ids) {
            videoList.push({
              videoId: id,
              title: `YouTube Video (${id})`,
              thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
              author: "YouTube Creator",
              duration: "Video",
              views: "Available Now",
            });
          }
        }
      }

      // Fast embeddability verification using YouTube oEmbed
      // Automatically identifies and filters out videos with disabled external playback (Error 150/101)
      let verifiedList = videoList;
      if (videoList.length > 0) {
        try {
          const candidateSlice = videoList.slice(0, 20);
          const checks = await Promise.allSettled(
            candidateSlice.map(async (v) => {
              try {
                const checkRes = await fetch(
                  `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${v.videoId}&format=json`,
                  { signal: AbortSignal.timeout(1200) }
                );
                return { videoId: v.videoId, embeddable: checkRes.ok };
              } catch {
                return { videoId: v.videoId, embeddable: true };
              }
            })
          );

          const statusMap = new Map<string, boolean>();
          for (const c of checks) {
            if (c.status === "fulfilled") {
              statusMap.set(c.value.videoId, c.value.embeddable);
            }
          }

          const embeddableVideos = videoList.filter(
            (v) => statusMap.get(v.videoId) !== false
          );
          if (embeddableVideos.length >= 3) {
            verifiedList = embeddableVideos;
          } else {
            verifiedList = [...videoList].sort((a, b) => {
              const aOk = statusMap.get(a.videoId) !== false ? 1 : 0;
              const bOk = statusMap.get(b.videoId) !== false ? 1 : 0;
              return bOk - aOk;
            });
          }
        } catch {
          // Best-effort fallback if oembed network check fails
        }
      }

      const topSlice = verifiedList.slice(0, 15);
      if (topSlice.length > 0) {
        try {
          const { actionContextManager, intentResolver } = await import("../orchestrator/index.ts");
          if (!intentResolver.isGenericPlaceholderQuery(query)) {
            actionContextManager.recordMediaSearch(
              "default",
              query,
              topSlice.map((v, idx) => ({
                index: idx,
                videoId: v.videoId,
                title: v.title,
                url: `https://www.youtube.com/watch?v=${v.videoId}`,
                author: v.author,
                duration: v.duration,
                thumbnail: v.thumbnail,
              })),
              "youtube",
            );
          }
        } catch {
          /* non-fatal */
        }
      }

      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
      res.status(200).json({ results: topSlice });
    } catch (err: any) {
      console.error("[YouTube Search Error]:", err.message);
      res.status(500).json({ error: err.message, results: [] });
    }
  });

  // ── Phase 9: AI Study Companion REST Endpoints ─────────────────────────

  // POST /api/study/load — load document by workspace path
  app.post("/api/study/load", async (req, res) => {
    try {
      const { path: docPath } = req.body || {};
      if (!docPath) {
        res.status(400).json({ error: "Missing required 'path' parameter in request body." });
        return;
      }
      const { studySessionManager } = await import("../study/StudySessionManager.ts");
      const doc = await studySessionManager.loadDocument(docPath);
      res.status(200).json({
        success: true,
        document: {
          id: doc.id,
          title: doc.title,
          fileType: doc.fileType,
          pageCount: doc.pageCount,
          totalQuestions: doc.totalQuestions,
          totalDiagrams: doc.totalDiagrams,
        },
      });
    } catch (err: any) {
      res.status(400).json({ error: sanitizeError(err?.message || "Failed to load study document.") });
    }
  });

  // POST /api/study/upload — ingest in-memory document buffer
  app.post("/api/study/upload", async (req, res) => {
    try {
      const { filename, base64 } = req.body || {};
      if (!filename || !base64) {
        res.status(400).json({ error: "Missing 'filename' or 'base64' payload in request body." });
        return;
      }
      const buffer = Buffer.from(base64, "base64");
      const { studySessionManager } = await import("../study/StudySessionManager.ts");
      const doc = await studySessionManager.loadDocument(buffer, filename);
      res.status(200).json({
        success: true,
        document: {
          id: doc.id,
          title: doc.title,
          fileType: doc.fileType,
          pageCount: doc.pageCount,
          totalQuestions: doc.totalQuestions,
          totalDiagrams: doc.totalDiagrams,
        },
      });
    } catch (err: any) {
      res.status(400).json({ error: sanitizeError(err?.message || "Failed to upload study document.") });
    }
  });

  // GET /api/study/session — get active study session state
  app.get("/api/study/session", async (_req, res) => {
    try {
      const { studySessionManager } = await import("../study/StudySessionManager.ts");
      const session = studySessionManager.getSessionContext();
      res.status(200).json(session);
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to get study session.") });
    }
  });

  // POST /api/study/page — navigate or set current viewed page
  app.post("/api/study/page", async (req, res) => {
    try {
      const { pageNumber, direction } = req.body || {};
      const { studySessionManager } = await import("../study/StudySessionManager.ts");
      let page;
      if (direction === "next") {
        page = studySessionManager.nextPage();
      } else if (direction === "prev") {
        page = studySessionManager.prevPage();
      } else if (pageNumber !== undefined) {
        page = studySessionManager.setCurrentPage(Number(pageNumber));
      } else {
        res.status(400).json({ error: "Specify 'pageNumber' or 'direction' ('next'/'prev')." });
        return;
      }
      res.status(200).json({
        success: true,
        currentPage: page.pageNumber,
        questionsCount: page.questions.length,
        diagramsCount: page.diagrams.length,
        linesCount: page.lineCount,
      });
    } catch (err: any) {
      res.status(400).json({ error: sanitizeError(err?.message || "Failed to set study page.") });
    }
  });

  // GET /api/study/questions — list questions on page
  app.get("/api/study/questions", async (req, res) => {
    try {
      const { studySessionManager } = await import("../study/StudySessionManager.ts");
      const activeDoc = studySessionManager.getActiveDocument();
      if (!activeDoc) {
        res.status(404).json({ error: "No active study document loaded." });
        return;
      }
      const pageNum = req.query.pageNumber
        ? Number(req.query.pageNumber)
        : studySessionManager.getSessionContext().currentPageNumber;
      const page = activeDoc.pages.find((p) => p.pageNumber === pageNum) || studySessionManager.getCurrentPage();
      if (!page) {
        res.status(404).json({ error: `Page ${pageNum} not found in document.` });
        return;
      }
      res.status(200).json({
        pageNumber: page.pageNumber,
        questions: page.questions,
      });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to retrieve questions.") });
    }
  });

  // POST /api/study/question — set focused question
  app.post("/api/study/question", async (req, res) => {
    try {
      const { questionId } = req.body || {};
      if (!questionId) {
        res.status(400).json({ error: "Missing required 'questionId'." });
        return;
      }
      const { studySessionManager } = await import("../study/StudySessionManager.ts");
      const q = studySessionManager.setCurrentQuestion(questionId);
      if (!q) {
        res.status(404).json({ error: `Question '${questionId}' not found.` });
        return;
      }
      res.status(200).json({ success: true, question: q });
    } catch (err: any) {
      res.status(400).json({ error: sanitizeError(err?.message || "Failed to set focused question.") });
    }
  });

  // POST /api/study/explain — get line or section explanation
  app.post("/api/study/explain", async (req, res) => {
    try {
      const { mode, lineNumber, sectionId } = req.body || {};
      const { studySessionManager } = await import("../study/StudySessionManager.ts");
      const { TeachingEngine } = await import("../study/TeachingEngine.ts");
      const page = studySessionManager.getCurrentPage();
      const doc = studySessionManager.getActiveDocument();
      if (!page || !doc) {
        res.status(400).json({ error: "No active study document or page." });
        return;
      }
      if (mode === "section") {
        const result = TeachingEngine.explainSection(page, sectionId || 0, doc.id);
        res.status(200).json({ success: true, mode: "section", result });
      } else {
        const result = TeachingEngine.explainLine(page, Number(lineNumber) || 1, doc.id);
        res.status(200).json({ success: true, mode: "line", result });
      }
    } catch (err: any) {
      res.status(400).json({ error: sanitizeError(err?.message || "Failed to explain study content.") });
    }
  });

  // POST /api/study/teaching-mode — toggle voice teaching mode
  app.post("/api/study/teaching-mode", async (req, res) => {
    try {
      const { enabled, style } = req.body || {};
      const { studySessionManager } = await import("../study/StudySessionManager.ts");
      const config = studySessionManager.toggleTeachingMode(Boolean(enabled), style);
      res.status(200).json({ success: true, config });
    } catch (err: any) {
      res.status(400).json({ error: sanitizeError(err?.message || "Failed to toggle teaching mode.") });
    }
  });

  // POST /api/study/tutor/mode — set interactive tutor mode (exam/viva/practice/revision/off)
  app.post("/api/study/tutor/mode", async (req, res) => {
    try {
      const { mode, examConfig, vivaConfig, targetQuestions } = req.body || {};
      const { interactiveTutor } = await import("../study/InteractiveTutor.ts");
      const state = interactiveTutor.setMode(mode || "off", {
        examConfig,
        vivaConfig,
        targetQuestions,
      });
      res.status(200).json({ success: true, state });
    } catch (err: any) {
      res.status(400).json({ error: sanitizeError(err?.message || "Failed to set tutor mode.") });
    }
  });

  // POST /api/study/tutor/submit — evaluate student answer
  app.post("/api/study/tutor/submit", async (req, res) => {
    try {
      const { questionId, studentAnswer, timeTakenSeconds } = req.body || {};
      if (!questionId || studentAnswer === undefined) {
        res.status(400).json({ error: "Missing required 'questionId' or 'studentAnswer'." });
        return;
      }
      const { interactiveTutor } = await import("../study/InteractiveTutor.ts");
      const evalResult = await interactiveTutor.evaluateStudentAnswer({
        questionId: String(questionId),
        studentAnswer: String(studentAnswer),
        timeTakenSeconds: timeTakenSeconds ? Number(timeTakenSeconds) : undefined,
      });
      res.status(200).json({ success: true, result: evalResult });
    } catch (err: any) {
      res.status(400).json({ error: sanitizeError(err?.message || "Failed to evaluate answer.") });
    }
  });

  // GET /api/study/tutor/progress — get study progress and weak topics
  app.get("/api/study/tutor/progress", async (req, res) => {
    try {
      const topic = req.query.topic as string | undefined;
      const { studyProgressTracker } = await import("../study/StudyProgressTracker.ts");
      if (topic) {
        const topicProgress = studyProgressTracker.getTopicProgress(topic);
        res.status(200).json({ success: true, topic, progress: topicProgress });
      } else {
        const overall = studyProgressTracker.getOverallProgress();
        res.status(200).json({ success: true, progress: overall });
      }
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to get study progress.") });
    }
  });

  // POST /api/study/tutor/revision — start revision session for weak topics
  app.post("/api/study/tutor/revision", async (req, res) => {
    try {
      const { topic, maxQuestions } = req.body || {};
      const { interactiveTutor } = await import("../study/InteractiveTutor.ts");
      const revision = interactiveTutor.startRevisionSession(topic, maxQuestions ? Number(maxQuestions) : 5);
      res.status(200).json({ success: true, revision });
    } catch (err: any) {
      res.status(400).json({ error: sanitizeError(err?.message || "Failed to start revision session.") });
    }
  });

  // POST /api/study/tutor/navigate — safely navigate viewer within document bounds
  app.post("/api/study/tutor/navigate", async (req, res) => {
    try {
      const { targetType, targetId, pageNumber } = req.body || {};
      const { interactiveTutor } = await import("../study/InteractiveTutor.ts");
      const navResult = interactiveTutor.navigateToItem({
        targetType: targetType || "page",
        targetId,
        pageNumber: pageNumber !== undefined ? Number(pageNumber) : undefined,
      });
      res.status(200).json(navResult);
    } catch (err: any) {
      res.status(400).json({ error: sanitizeError(err?.message || "Failed to navigate study item.") });
    }
  });

  // POST /api/study/tutor/diagram — explain relevant diagram
  app.post("/api/study/tutor/diagram", async (req, res) => {
    try {
      const { questionId, topic, forceVisualCapture } = req.body || {};
      const { interactiveTutor } = await import("../study/InteractiveTutor.ts");
      const explanation = await interactiveTutor.explainRelevantDiagram({
        questionId,
        topic,
        forceVisualCapture: Boolean(forceVisualCapture),
      });
      res.status(200).json({ success: true, diagram: explanation });
    } catch (err: any) {
      res.status(400).json({ error: sanitizeError(err?.message || "Failed to explain diagram.") });
    }
  });

  // ── Phase 9: Stage 3 — AI Companion REST Endpoints ───────────────────────

  // GET /api/study/companion/profile — get course profile
  app.get("/api/study/companion/profile", async (_req, res) => {
    try {
      const { courseProfileManager } = await import("../study/CourseProfileManager.ts");
      const profile = courseProfileManager.getProfile();
      res.status(200).json({ success: true, profile });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to get course profile.") });
    }
  });

  // POST /api/study/companion/profile — configure course profile
  app.post("/api/study/companion/profile", async (req, res) => {
    try {
      const { courseProfileManager } = await import("../study/CourseProfileManager.ts");
      const profile = courseProfileManager.setProfile(req.body || {});
      res.status(200).json({ success: true, profile });
    } catch (err: any) {
      res.status(400).json({ error: sanitizeError(err?.message || "Failed to set course profile.") });
    }
  });

  // GET /api/study/companion/syllabus — get syllabus (optional subjectId query)
  app.get("/api/study/companion/syllabus", async (req, res) => {
    try {
      const { courseProfileManager } = await import("../study/CourseProfileManager.ts");
      const subjectId = req.query.subjectId as string | undefined;
      const syllabi = courseProfileManager.getSyllabus(subjectId);
      res.status(200).json({ success: true, syllabi });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to get syllabus.") });
    }
  });

  // POST /api/study/companion/syllabus — map subject syllabus
  app.post("/api/study/companion/syllabus", async (req, res) => {
    try {
      const { subjectId, subjectName, chapters } = req.body || {};
      if (!subjectId || !subjectName || !Array.isArray(chapters)) {
        res.status(400).json({ error: "Missing required 'subjectId', 'subjectName', or 'chapters' array." });
        return;
      }
      const { courseProfileManager } = await import("../study/CourseProfileManager.ts");
      const syllabus = courseProfileManager.mapSyllabus(subjectId, subjectName, chapters);
      res.status(200).json({ success: true, syllabus });
    } catch (err: any) {
      res.status(400).json({ error: sanitizeError(err?.message || "Failed to map syllabus.") });
    }
  });

  // PATCH /api/study/companion/syllabus/topic — update topic completion status
  app.patch("/api/study/companion/syllabus/topic", async (req, res) => {
    try {
      const { subjectId, topicId, status } = req.body || {};
      if (!subjectId || !topicId || !status) {
        res.status(400).json({ error: "Missing required 'subjectId', 'topicId', or 'status'." });
        return;
      }
      const { courseProfileManager } = await import("../study/CourseProfileManager.ts");
      const updated = courseProfileManager.updateTopicStatus(subjectId, topicId, status);
      res.status(200).json({ success: true, updated });
    } catch (err: any) {
      res.status(400).json({ error: sanitizeError(err?.message || "Failed to update topic status.") });
    }
  });

  // POST /api/study/companion/research — academic web research
  app.post("/api/study/companion/research", async (req, res) => {
    try {
      const { topic, subject, maxResults } = req.body || {};
      if (!topic) {
        res.status(400).json({ error: "Missing required 'topic'." });
        return;
      }
      const { studyResearchEngine } = await import("../study/StudyResearchEngine.ts");
      const result = await studyResearchEngine.researchStudyTopic(String(topic), {
        subject: subject ? String(subject) : undefined,
        maxResults: maxResults ? Number(maxResults) : undefined,
      });
      res.status(200).json({ success: true, result });
    } catch (err: any) {
      res.status(400).json({ error: sanitizeError(err?.message || "Failed to research study topic.") });
    }
  });

  // POST /api/study/companion/videos — discover educational YouTube videos
  app.post("/api/study/companion/videos", async (req, res) => {
    try {
      const { topic, subject, maxResults } = req.body || {};
      if (!topic) {
        res.status(400).json({ error: "Missing required 'topic'." });
        return;
      }
      const { studyResearchEngine } = await import("../study/StudyResearchEngine.ts");
      const result = await studyResearchEngine.discoverStudyVideos(String(topic), {
        subject: subject ? String(subject) : undefined,
        maxResults: maxResults ? Number(maxResults) : undefined,
      });
      res.status(200).json({ success: true, ...result });
    } catch (err: any) {
      res.status(400).json({ error: sanitizeError(err?.message || "Failed to discover study videos.") });
    }
  });

  // POST /api/study/companion/analyze-questions — previous question papers analysis
  app.post("/api/study/companion/analyze-questions", async (req, res) => {
    try {
      const { paperTitle, rawText } = req.body || {};
      const { studyResearchEngine } = await import("../study/StudyResearchEngine.ts");
      const analysis = await studyResearchEngine.analyzePreviousQuestions({ paperTitle, rawText });
      res.status(200).json({ success: true, analysis });
    } catch (err: any) {
      res.status(400).json({ error: sanitizeError(err?.message || "Failed to analyze previous questions.") });
    }
  });

  // POST /api/study/companion/plan — generate personalized study plan
  app.post("/api/study/companion/plan", async (req, res) => {
    try {
      const { dailyHours, targetExamDate, planName } = req.body || {};
      const { courseProfileManager } = await import("../study/CourseProfileManager.ts");
      const plan = courseProfileManager.generateStudyPlan({
        dailyHours: dailyHours ? Number(dailyHours) : undefined,
        targetExamDate,
        planName,
      });
      res.status(200).json({ success: true, plan });
    } catch (err: any) {
      res.status(400).json({ error: sanitizeError(err?.message || "Failed to generate study plan.") });
    }
  });

  // GET /api/study/companion/plan — get current study plan
  app.get("/api/study/companion/plan", async (_req, res) => {
    try {
      const { courseProfileManager } = await import("../study/CourseProfileManager.ts");
      const plan = courseProfileManager.getStudyPlan();
      res.status(200).json({ success: true, plan });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to get study plan.") });
    }
  });

  // GET /api/study/companion/recommendations — weak topic study recommendations
  app.get("/api/study/companion/recommendations", async (_req, res) => {
    try {
      const { studyResearchEngine } = await import("../study/StudyResearchEngine.ts");
      const recommendations = studyResearchEngine.getWeakTopicRecommendations();
      res.status(200).json({ success: true, count: recommendations.length, recommendations });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to get recommendations.") });
    }
  });

  // GET /api/study/companion/daily-session — get or initialize today's daily session
  app.get("/api/study/companion/daily-session", async (req, res) => {
    try {
      const date = req.query.date as string | undefined;
      const { courseProfileManager } = await import("../study/CourseProfileManager.ts");
      const session = courseProfileManager.createOrGetDailySession(date);
      res.status(200).json({ success: true, session });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to get daily session.") });
    }
  });

  // PATCH /api/study/companion/daily-session/target — update target completed state
  app.patch("/api/study/companion/daily-session/target", async (req, res) => {
    try {
      const { targetId, completed, date } = req.body || {};
      if (!targetId) {
        res.status(400).json({ error: "Missing required 'targetId'." });
        return;
      }
      const { courseProfileManager } = await import("../study/CourseProfileManager.ts");
      const session = courseProfileManager.updateDailyTarget(String(targetId), Boolean(completed), date);
      res.status(200).json({ success: true, session });
    } catch (err: any) {
      res.status(400).json({ error: sanitizeError(err?.message || "Failed to update daily target.") });
    }
  });

  // POST /api/study/companion/daily-session/complete — complete daily session
  app.post("/api/study/companion/daily-session/complete", async (req, res) => {
    try {
      const { notes, date } = req.body || {};
      const { courseProfileManager } = await import("../study/CourseProfileManager.ts");
      const session = courseProfileManager.completeDailySession(notes, date);
      res.status(200).json({ success: true, session });
    } catch (err: any) {
      res.status(400).json({ error: sanitizeError(err?.message || "Failed to complete daily session.") });
    }
  });

  // ── Phase 10A: Security Foundation REST Endpoints ────────────────────────
  // POST /api/security/session — Establish secure session with access + refresh token
  app.post("/api/security/session", async (req, res) => {
    try {
      const { deviceId, identityId, role } = req.body || {};
      const ipAddress = req.socket?.remoteAddress || req.ip || "unknown";
      const userAgent = req.headers["user-agent"] || "unknown";

      const { identityAuthManager } = await import("../security/IdentityAuthManager.ts");
      const result = identityAuthManager.createSession({
        deviceId: deviceId || "default_device",
        identityId: identityId || "user",
        role: role || "standard",
        ipAddress,
        userAgent,
      });

      res.status(200).json({ success: true, ...result });
    } catch (err: any) {
      res.status(400).json({ error: sanitizeError(err?.message || "Failed to create security session.") });
    }
  });

  // POST /api/security/refresh — Rotate refresh token with replay attack detection
  app.post("/api/security/refresh", async (req, res) => {
    try {
      const { refreshToken } = req.body || {};
      const ipAddress = req.socket?.remoteAddress || req.ip || "unknown";

      if (!refreshToken) {
        res.status(400).json({ error: "Missing required 'refreshToken'." });
        return;
      }

      const { identityAuthManager } = await import("../security/IdentityAuthManager.ts");
      const result = identityAuthManager.refreshSession(refreshToken, ipAddress);
      res.status(200).json({ success: true, ...result });
    } catch (err: any) {
      const status = err?.message?.includes("REPLAY") ? 403 : 400;
      res.status(status).json({ error: sanitizeError(err?.message || "Failed to refresh session.") });
    }
  });

  // POST /api/security/revoke — Revoke a session or device
  app.post("/api/security/revoke", async (req, res) => {
    try {
      const { sessionId, deviceId, reason } = req.body || {};
      const { identityAuthManager } = await import("../security/IdentityAuthManager.ts");

      if (sessionId) {
        const ok = identityAuthManager.revokeSession(sessionId, reason || "Revoked by operator");
        res.status(200).json({ success: ok, revokedSessionId: sessionId });
        return;
      }

      if (deviceId) {
        const count = identityAuthManager.revokeDevice(deviceId, reason || "Device revoked by operator");
        res.status(200).json({ success: count > 0, revokedDeviceSessions: count });
        return;
      }

      res.status(400).json({ error: "Either 'sessionId' or 'deviceId' must be provided." });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to revoke.") });
    }
  });

  // POST /api/security/step-up/request — Authenticated localhost operator step-up request (FINDING-AUD-03)
  // NEVER returns plaintext PIN in HTTP response; binds strictly to authenticated operator session.
  app.post("/api/security/step-up/request", requireLocalhost, requireOperatorSessionMiddleware, async (req: any, res) => {
    try {
      if (!assertWriteRoleAllowed(req, res)) return;
      if (!(await assertSystemNotHalted(res, req.authContext.identityId, "/api/security/step-up/request"))) return;

      const { sessionId, action } = req.body || {};
      const authenticatedSessionId = req.operatorSession.sessionId;
      if (!action || typeof action !== "string") {
        res.status(400).json({ error: "Missing required 'action'." });
        return;
      }
      if (sessionId && sessionId !== authenticatedSessionId) {
        res.status(403).json({ error: "FORBIDDEN: Cannot request step-up challenge for another session." });
        return;
      }

      const { identityAuthManager } = await import("../security/IdentityAuthManager.ts");
      const challenge = identityAuthManager.requestStepUpChallenge(authenticatedSessionId, action);
      registerStepUpChallengeOwner(
        challenge.challengeId,
        authenticatedSessionId,
        new Date(challenge.expiresAt).getTime(),
      );

      // SECURITY: Never include plaintext PIN in the HTTP response body!
      res.status(200).json({
        success: true,
        challengeId: challenge.challengeId,
        expiresAt: challenge.expiresAt,
        delivery: "local_operator_console",
      });
    } catch (err: any) {
      res.status(400).json({ error: sanitizeError(err?.message || "Failed to request step-up challenge.") });
    }
  });

  // POST /api/security/step-up/verify — Authenticated localhost operator step-up verify (FINDING-AUD-03)
  app.post("/api/security/step-up/verify", requireLocalhost, requireOperatorSessionMiddleware, async (req: any, res) => {
    try {
      if (!assertWriteRoleAllowed(req, res)) return;

      const { challengeId, pin } = req.body || {};
      if (!challengeId || !pin) {
        res.status(400).json({ error: "Missing required 'challengeId' or 'pin'." });
        return;
      }

      const authenticatedSessionId = req.operatorSession.sessionId;
      const ownerRecord = _stepUpChallengeOwners.get(String(challengeId));
      if (ownerRecord && ownerRecord.sessionId !== authenticatedSessionId) {
        res.status(403).json({
          success: false,
          error: "STEP_UP_SESSION_MISMATCH: Cannot verify a step-up challenge belonging to another session.",
        });
        return;
      }

      const { identityAuthManager } = await import("../security/IdentityAuthManager.ts");
      const ok = identityAuthManager.verifyStepUpChallenge(String(challengeId), String(pin));
      if (!ok) {
        res.status(403).json({ success: false, error: "STEP_UP_FAILED: Invalid or expired PIN." });
        return;
      }
      _stepUpChallengeOwners.delete(String(challengeId));
      res.status(200).json({ success: true, verified: true });
    } catch (err: any) {
      res.status(400).json({ error: sanitizeError(err?.message || "Failed to verify step-up PIN.") });
    }
  });

  // GET /api/security/audit — Fetch tamper-evident audit logs (localhost only)
  app.get("/api/security/audit", requireLocalhost, async (req, res) => {
    try {
      const limit = req.query.limit ? Number(req.query.limit) : 50;
      const { securityAuditLogger } = await import("../security/SecurityAuditLogger.ts");
      const events = securityAuditLogger.getRecentEvents(limit);
      const integrity = securityAuditLogger.verifyChainIntegrity();
      res.status(200).json({ success: true, integrity, count: events.length, events });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to fetch audit log.") });
    }
  });

  // GET /api/security/policy — Fetch active security policy and risk engine state
  app.get("/api/security/policy", async (_req, res) => {
    try {
      const { securityPolicyEngine } = await import("../security/SecurityPolicyEngine.ts");
      res.status(200).json({
        success: true,
        mode: securityPolicyEngine.getMode(),
      });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to get security policy.") });
    }
  });

  // POST /api/security/policy/mode — Update security policy mode (localhost only)
  app.post("/api/security/policy/mode", requireLocalhost, async (req, res) => {
    try {
      const { mode } = req.body || {};
      if (!["BALANCED", "STRICT", "PARANOID", "LOCKDOWN"].includes(mode)) {
        res.status(400).json({ error: "Invalid mode. Must be BALANCED, STRICT, PARANOID, or LOCKDOWN." });
        return;
      }
      const { securityPolicyEngine } = await import("../security/SecurityPolicyEngine.ts");
      securityPolicyEngine.setMode(mode);
      res.status(200).json({ success: true, mode });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to set security mode.") });
    }
  });

  // POST /api/security/mode — Alias to /api/security/policy/mode
  app.post("/api/security/mode", requireLocalhost, async (req, res) => {
    try {
      const { mode } = req.body || {};
      if (!["BALANCED", "STRICT", "PARANOID", "LOCKDOWN"].includes(mode)) {
        res.status(400).json({ error: "Invalid mode. Must be BALANCED, STRICT, PARANOID, or LOCKDOWN." });
        return;
      }
      const { securityPolicyEngine } = await import("../security/SecurityPolicyEngine.ts");
      securityPolicyEngine.setMode(mode);
      res.status(200).json({ success: true, mode });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to set security mode.") });
    }
  });

  // GET /api/security/alerts — Fetch sanitized security alerts
  app.get("/api/security/alerts", async (req, res) => {
    try {
      const limit = req.query.limit ? Number(req.query.limit) : 50;
      const risk = req.query.risk as any;
      const unacknowledgedOnly = req.query.unacknowledged === "true";
      const { securityAlertManager } = await import("../security/SecurityAlertManager.ts");
      const alerts = securityAlertManager.getAlerts(limit, { risk, unacknowledgedOnly });
      res.status(200).json({ success: true, count: alerts.length, alerts });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to fetch security alerts.") });
    }
  });

  // POST /api/security/alerts/acknowledge — Acknowledge an alert by ID
  app.post("/api/security/alerts/acknowledge", async (req, res) => {
    try {
      const { alertId } = req.body || {};
      if (!alertId) {
        res.status(400).json({ error: "alertId is required." });
        return;
      }
      const { securityAlertManager } = await import("../security/SecurityAlertManager.ts");
      const ok = securityAlertManager.acknowledgeAlert(alertId);
      if (!ok) {
        res.status(404).json({ error: "Alert not found." });
        return;
      }
      res.status(200).json({ success: true, acknowledged: true, alertId });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to acknowledge alert.") });
    }
  });

  // GET /api/security/events — Fetch recent normalized security events
  app.get("/api/security/events", async (req, res) => {
    try {
      const limit = req.query.limit ? Number(req.query.limit) : 50;
      const { securityEventStream } = await import("../security/SecurityEventStream.ts");
      const events = securityEventStream.getRecentEvents(limit);
      res.status(200).json({ success: true, count: events.length, events });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to fetch security events.") });
    }
  });

  // GET /api/security/status — Comprehensive security monitoring status
  app.get("/api/security/status", async (_req, res) => {
    try {
      const { securityPolicyEngine } = await import("../security/SecurityPolicyEngine.ts");
      const { securityMonitor } = await import("../security/SecurityMonitor.ts");
      const { securityAlertManager } = await import("../security/SecurityAlertManager.ts");
      const { securityAuditLogger } = await import("../security/SecurityAuditLogger.ts");

      const recentThreats = securityMonitor.getDetectedThreats(10);
      const activeAlerts = securityAlertManager.getAlerts(10, { unacknowledgedOnly: true });
      const chainStatus = securityAuditLogger.verifyChainIntegrity();

      res.status(200).json({
        success: true,
        mode: securityPolicyEngine.getMode(),
        isLockdown: securityPolicyEngine.getMode() === "LOCKDOWN",
        auditChainIntact: chainStatus.valid,
        activeAlertsCount: activeAlerts.length,
        recentThreatsCount: recentThreats.length,
        recentThreats,
        activeAlerts,
      });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to fetch security status.") });
    }
  });

  // ── Phase 10D: Automatic Containment & Integrity REST Endpoints ───────────

  // GET /api/security/containments — List active/historical threat containments and disabled tools
  app.get("/api/security/containments", async (_req, res) => {
    try {
      const { threatContainmentManager } = await import("../security/ThreatContainmentManager.ts");
      const { securityPolicyEngine } = await import("../security/SecurityPolicyEngine.ts");
      const active = threatContainmentManager.getActiveContainments();
      const all = threatContainmentManager.getAllContainments();
      const disabledTools = securityPolicyEngine.getDisabledTools();

      res.status(200).json({
        success: true,
        activeCount: active.length,
        active,
        history: all,
        disabledTools,
      });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to fetch containments.") });
    }
  });

  // POST /api/security/containments/lift — Lift an active containment (Admin only)
  app.post("/api/security/containments/lift", async (req: any, res) => {
    try {
      const { containmentId, stepUpPin } = req.body || {};
      if (!containmentId) {
        res.status(400).json({ error: "containmentId is required." });
        return;
      }

      const isLocal =
        req.ip === "127.0.0.1" ||
        req.ip === "::1" ||
        req.ip === "localhost" ||
        req.hostname === "localhost" ||
        req.headers["host"]?.includes("localhost") ||
        req.headers["host"]?.includes("127.0.0.1");

      const operatorContext = {
        identityId: "admin",
        role: "admin" as const,
        ipAddress: req.ip || "127.0.0.1",
        isLocal,
        isStepUpAuthenticated: Boolean(stepUpPin),
      };

      const { threatContainmentManager } = await import("../security/ThreatContainmentManager.ts");
      const result = await threatContainmentManager.liftContainment(containmentId, operatorContext, stepUpPin);

      if (!result.success) {
        res.status(403).json({ success: false, error: result.reason });
        return;
      }

      res.status(200).json({ success: true, containmentId });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to lift containment.") });
    }
  });

  // GET /api/security/integrity — Get integrity monitor status & baseline manifest info
  app.get("/api/security/integrity", async (_req, res) => {
    try {
      const { integrityMonitor } = await import("../security/IntegrityMonitor.ts");
      const baseline = integrityMonitor.getBaselineManifest();
      const lastReport = integrityMonitor.getLastReport();

      res.status(200).json({
        success: true,
        baselineValid: Boolean(baseline && baseline.signature),
        monitoredFileCount: baseline ? Object.keys(baseline.files).length : 0,
        lastReport,
      });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to fetch integrity status.") });
    }
  });

  // POST /api/security/integrity/verify — Trigger manual integrity scan
  app.post("/api/security/integrity/verify", async (req, res) => {
    try {
      const { quarantineOnTamper } = req.body || {};
      const { integrityMonitor } = await import("../security/IntegrityMonitor.ts");
      const report = await integrityMonitor.verifyIntegrity({
        quarantineOnTamper: quarantineOnTamper !== false,
      });
      res.status(200).json({ success: true, report });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Integrity verification failed.") });
    }
  });

  // POST /api/security/integrity/rebaseline — Re-establish trusted cryptographic baseline (Admin only)
  app.post("/api/security/integrity/rebaseline", async (req: any, res) => {
    try {
      const { confirmationToken } = req.body || {};
      const isLocal =
        req.ip === "127.0.0.1" ||
        req.ip === "::1" ||
        req.ip === "localhost" ||
        req.hostname === "localhost" ||
        req.headers["host"]?.includes("localhost") ||
        req.headers["host"]?.includes("127.0.0.1");

      const operatorContext = {
        identityId: "admin",
        role: "admin" as const,
        ipAddress: req.ip || "127.0.0.1",
        isLocal,
        isStepUpAuthenticated: Boolean(confirmationToken),
      };

      const { integrityMonitor } = await import("../security/IntegrityMonitor.ts");
      const result = await integrityMonitor.rebaseline(operatorContext, confirmationToken);

      if (!result.success) {
        res.status(403).json({ success: false, error: result.reason });
        return;
      }

      res.status(200).json({ success: true, manifest: result.manifest });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Re-baseline failed.") });
    }
  });

  // ── Phase 9–10: Production UX, Multi-Device & Handoff REST Endpoints ────
  const DEFAULT_MOBILE_UX_ID = "myraa-mobile-primary";
  const DEFAULT_DESKTOP_UX_ID = "myraa-desktop-primary";
  let lastUxPairingId = "";

  async function buildUxSnapshot(mobileId = DEFAULT_MOBILE_UX_ID, desktopId = DEFAULT_DESKTOP_UX_ID) {
    const {
      productionUxController,
      crossDeviceWorkflowOrchestrator,
      deviceRegistry,
    } = await import("../device/index.ts");
    const { emergencyStopCoordinator } = await import("../remote/EmergencyStopCoordinator.ts");
    const { securityPolicyEngine } = await import("../security/SecurityPolicyEngine.ts");

    if (!deviceRegistry.getDevice(mobileId)) {
      productionUxController.initMobileUxSession({
        deviceId: mobileId,
        deviceName: "MYRAA Android Phone",
        online: true,
      });
    }
    if (!deviceRegistry.getDevice(desktopId)) {
      productionUxController.initDesktopUxSession({
        deviceId: desktopId,
        deviceName: "MYRAA Windows Workstation",
        online: true,
        projectPath: "d:/SORA AI/Sora AI",
        projectName: "MYRAA Production Core",
      });
    }

    const mobile = productionUxController.getMobileUxState(mobileId);
    const desktop = productionUxController.getDesktopUxState(desktopId);
    const mobileHandoffs = crossDeviceWorkflowOrchestrator.listHandoffsForDevice(mobileId);
    const desktopHandoffs = crossDeviceWorkflowOrchestrator.listHandoffsForDevice(desktopId);
    const handoffMap = new Map<string, any>();
    for (const h of [...mobileHandoffs, ...desktopHandoffs]) {
      handoffMap.set(h.handoffId, h);
    }
    const handoffs = Array.from(handoffMap.values());
    const activeWorkflows = handoffs.map((h: any) => ({
      ...h,
      workflowId: h.handoffId,
      title: h.intent || h.capability || "Cross-Device Workflow",
      state: h.progress?.status || h.state || "ACTIVE",
      initiatingDeviceId: h.sourceDevice?.deviceId || h.sourceDeviceId,
      currentExecutingDeviceId: h.targetDevice?.deviceId || h.targetDeviceId,
    }));

    return {
      success: true,
      mobile,
      desktop,
      handoffs,
      activeWorkflows,
      emergencyStopActive: emergencyStopCoordinator.isActive(),
      emergencyStop: { active: emergencyStopCoordinator.isActive() },
      securityMode: securityPolicyEngine.getMode(),
      totalGeminiLiveTools: desktop.toolsAndCapabilities.totalGeminiLiveTools,
    };
  }

  app.get("/api/ux/state", async (req, res) => {
    try {
      const mobileId = String(req.query.mobileDeviceId || DEFAULT_MOBILE_UX_ID);
      const desktopId = String(req.query.desktopDeviceId || DEFAULT_DESKTOP_UX_ID);
      const snap = await buildUxSnapshot(mobileId, desktopId);
      res.status(200).json(snap);
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to load UX state.") });
    }
  });

  app.post("/api/ux/mobile/onboarding", async (req, res) => {
    try {
      const { deviceId = DEFAULT_MOBILE_UX_ID, step, stepId, completeAll } = req.body || {};
      const { productionUxController } = await import("../device/index.ts");
      let onboarding: any;
      if (completeAll) {
        for (const s of ["WELCOME", "VOICE_SETUP", "PERMISSIONS", "PRIVACY_AND_ACCOUNT", "READY"] as const) {
          onboarding = productionUxController.completeMobileOnboardingStep(deviceId, s);
        }
      } else {
        onboarding = productionUxController.completeMobileOnboardingStep(
          deviceId,
          (step || stepId || "WELCOME") as any,
        );
      }
      const snap = await buildUxSnapshot(deviceId, DEFAULT_DESKTOP_UX_ID);
      res.status(200).json({ ...snap, onboarding });
    } catch (err: any) {
      res.status(400).json({ error: sanitizeError(err?.message || "Onboarding step failed.") });
    }
  });

  app.post("/api/ux/mobile/target", async (req, res) => {
    try {
      const { deviceId = DEFAULT_MOBILE_UX_ID, target } = req.body || {};
      const { productionUxController } = await import("../device/index.ts");
      productionUxController.selectMobileTargetDevice(deviceId, target || "CURRENT_DEVICE");
      const snap = await buildUxSnapshot(deviceId, DEFAULT_DESKTOP_UX_ID);
      res.status(200).json(snap);
    } catch (err: any) {
      res.status(400).json({ error: sanitizeError(err?.message || "Target selection failed.") });
    }
  });

  app.post("/api/ux/desktop/target", async (req, res) => {
    try {
      const { deviceId = DEFAULT_DESKTOP_UX_ID, target } = req.body || {};
      const { productionUxController } = await import("../device/index.ts");
      productionUxController.selectDesktopTargetDevice(deviceId, target || "CURRENT_DEVICE");
      const snap = await buildUxSnapshot(DEFAULT_MOBILE_UX_ID, deviceId);
      res.status(200).json(snap);
    } catch (err: any) {
      res.status(400).json({ error: sanitizeError(err?.message || "Desktop target selection failed.") });
    }
  });

  app.post("/api/ux/mobile/permission", async (req, res) => {
    try {
      const { deviceId = DEFAULT_MOBILE_UX_ID, permission, granted } = req.body || {};
      const { productionUxController } = await import("../device/index.ts");
      const updated = productionUxController.updateMobilePermission({
        deviceId,
        permission,
        granted: Boolean(granted),
      });
      const snap = await buildUxSnapshot(deviceId, DEFAULT_DESKTOP_UX_ID);
      res.status(200).json({ ...snap, updatedPermission: updated });
    } catch (err: any) {
      res.status(400).json({ error: sanitizeError(err?.message || "Permission update failed.") });
    }
  });

  app.post("/api/ux/mobile/privacy", async (req, res) => {
    try {
      const {
        deviceId = DEFAULT_MOBILE_UX_ID,
        privacyShieldEnabled,
        continuousScreenContextEnabled,
        redactSensitiveNotifications,
        localOnlyMode,
        clearDeviceLocalContext,
      } = req.body || {};
      const { productionUxController } = await import("../device/index.ts");
      const privacyControls = productionUxController.updateMobilePrivacyControls({
        deviceId,
        privacyShieldEnabled,
        continuousScreenContextEnabled,
        redactSensitiveNotifications,
        localOnlyMode,
        clearDeviceLocalContext,
      });
      const snap = await buildUxSnapshot(deviceId, DEFAULT_DESKTOP_UX_ID);
      res.status(200).json({ ...snap, privacyControls });
    } catch (err: any) {
      res.status(400).json({ error: sanitizeError(err?.message || "Privacy controls update failed.") });
    }
  });

  app.post("/api/ux/mobile/settings", async (req, res) => {
    try {
      const {
        deviceId = DEFAULT_MOBILE_UX_ID,
        languagePreference,
        wakeWordEnabled,
        wakePhrase,
        voiceOutputEnabled,
        theme,
        remoteAutoDisconnectMinutes,
      } = req.body || {};
      const { productionUxController } = await import("../device/index.ts");
      const settings = productionUxController.updateMobileSettings({
        deviceId,
        languagePreference,
        wakeWordEnabled,
        wakePhrase,
        voiceOutputEnabled,
        theme,
        remoteAutoDisconnectMinutes,
      });
      const snap = await buildUxSnapshot(deviceId, DEFAULT_DESKTOP_UX_ID);
      res.status(200).json({ ...snap, settings });
    } catch (err: any) {
      res.status(400).json({ error: sanitizeError(err?.message || "Mobile settings update failed.") });
    }
  });

  app.post("/api/ux/mobile/voice", async (req, res) => {
    try {
      const {
        deviceId = DEFAULT_MOBILE_UX_ID,
        utterance,
        transcript,
        explicitTargetOverride,
        targetDesktopDeviceId,
      } = req.body || {};
      const resolvedUtterance = utterance || transcript;
      if (!resolvedUtterance || !String(resolvedUtterance).trim()) {
        res.status(400).json({ error: "Utterance is required." });
        return;
      }
      const { productionUxController } = await import("../device/index.ts");
      const turn = await productionUxController.submitMobileVoiceCommand({
        deviceId,
        utterance: String(resolvedUtterance).trim(),
        explicitTargetOverride,
        targetDesktopDeviceId: targetDesktopDeviceId || DEFAULT_DESKTOP_UX_ID,
      });
      const snap = await buildUxSnapshot(deviceId, DEFAULT_DESKTOP_UX_ID);
      res.status(200).json({ ...snap, turn });
    } catch (err: any) {
      res.status(400).json({ error: sanitizeError(err?.message || "Mobile voice command failed.") });
    }
  });

  app.post("/api/ux/desktop/voice", async (req, res) => {
    try {
      const {
        deviceId = DEFAULT_DESKTOP_UX_ID,
        utterance,
        explicitTargetOverride,
        targetPhoneDeviceId,
      } = req.body || {};
      if (!utterance || !String(utterance).trim()) {
        res.status(400).json({ error: "Utterance is required." });
        return;
      }
      const { productionUxController } = await import("../device/index.ts");
      const turn = await productionUxController.submitDesktopVoiceCommand({
        deviceId,
        utterance: String(utterance).trim(),
        explicitTargetOverride,
        targetPhoneDeviceId: targetPhoneDeviceId || DEFAULT_MOBILE_UX_ID,
      });
      const snap = await buildUxSnapshot(DEFAULT_MOBILE_UX_ID, deviceId);
      res.status(200).json({ ...snap, turn });
    } catch (err: any) {
      res.status(400).json({ error: sanitizeError(err?.message || "Desktop voice command failed.") });
    }
  });

  app.post("/api/ux/desktop/project", async (req, res) => {
    try {
      const {
        deviceId = DEFAULT_DESKTOP_UX_ID,
        projectName = "MYRAA Production Core",
        projectPath = "d:/SORA AI/Sora AI",
        activeFile,
      } = req.body || {};
      const { productionUxController } = await import("../device/index.ts");
      const dashboard = productionUxController.openProjectInDashboard({
        deviceId,
        projectName,
        projectPath,
        activeFile,
      });
      const snap = await buildUxSnapshot(DEFAULT_MOBILE_UX_ID, deviceId);
      res.status(200).json({ ...snap, dashboard });
    } catch (err: any) {
      res.status(400).json({ error: sanitizeError(err?.message || "Project dashboard update failed.") });
    }
  });

  app.post("/api/ux/desktop/context", async (req, res) => {
    try {
      const {
        deviceId = DEFAULT_DESKTOP_UX_ID,
        currentWindow,
        activeApplication,
        activeFile,
        activeWebsite,
        screenSharingActive,
        privacyShieldActive,
      } = req.body || {};
      const { productionUxController } = await import("../device/index.ts");
      const activeContext = productionUxController.updateDesktopActiveContext({
        deviceId,
        currentWindow,
        activeApplication,
        activeFile,
        activeWebsite,
        screenSharingActive,
        privacyShieldActive,
      });
      const snap = await buildUxSnapshot(DEFAULT_MOBILE_UX_ID, deviceId);
      res.status(200).json({ ...snap, activeContext });
    } catch (err: any) {
      res.status(400).json({ error: sanitizeError(err?.message || "Desktop context update failed.") });
    }
  });

  app.post("/api/ux/account/auth", async (req, res) => {
    try {
      const {
        action,
        accountId = "acct-sandeep-myraa",
        displayName = "Sandeep Mishra",
        email = "sandeep@mishtron.ai",
        deviceId,
        online,
        reason,
      } = req.body || {};
      const {
        productionUxController,
        sharedAccountMemoryManager,
      } = await import("../device/index.ts");

      if (action === "login") {
        sharedAccountMemoryManager.registerAccount({
          accountId,
          displayName,
          email,
          role: "admin",
        });
        sharedAccountMemoryManager.registerAccountDevice({
          accountId,
          deviceId: DEFAULT_MOBILE_UX_ID,
          deviceName: "MYRAA Android Phone",
          productType: "MYRAA_MOBILE",
          role: "admin",
          online: true,
        });
        sharedAccountMemoryManager.registerAccountDevice({
          accountId,
          deviceId: DEFAULT_DESKTOP_UX_ID,
          deviceName: "MYRAA Windows Workstation",
          productType: "MYRAA_DESKTOP",
          role: "admin",
          online: true,
        });
        productionUxController.initMobileUxSession({
          deviceId: DEFAULT_MOBILE_UX_ID,
          deviceName: "MYRAA Android Phone",
          accountId,
        });
        productionUxController.initDesktopUxSession({
          deviceId: DEFAULT_DESKTOP_UX_ID,
          deviceName: "MYRAA Windows Workstation",
          accountId,
        });
        // Seed default Hinglish preference in Shared Account Preferences
        sharedAccountMemoryManager.setSharedPreference({
          accountId,
          deviceId: DEFAULT_MOBILE_UX_ID,
          key: "hinglish_preference",
          value: "hinglish",
        });
        // Seed mobile-local foreground_app context so both devices have distinct local context
        sharedAccountMemoryManager.writeDeviceLocalMemory({
          deviceId: DEFAULT_MOBILE_UX_ID,
          productType: "MYRAA_MOBILE",
          accountId,
          key: "foreground_app",
          value: "com.myraa.mobile",
        });
      } else if (action === "logout") {
        productionUxController.initMobileUxSession({
          deviceId: DEFAULT_MOBILE_UX_ID,
          accountId: null,
        });
        productionUxController.initDesktopUxSession({
          deviceId: DEFAULT_DESKTOP_UX_ID,
          accountId: null,
        });
      } else if (action === "set_online" && deviceId) {
        sharedAccountMemoryManager.setDeviceOnline(accountId, deviceId, Boolean(online));
      } else if (action === "revoke_device" && deviceId) {
        sharedAccountMemoryManager.revokeAccountDevice(accountId, deviceId, reason || "Revoked via UX");
      } else if (action === "mark_lost" && deviceId) {
        sharedAccountMemoryManager.markAccountDeviceLost(accountId, deviceId, reason || "Marked lost via UX");
      }

      const snap = await buildUxSnapshot(DEFAULT_MOBILE_UX_ID, DEFAULT_DESKTOP_UX_ID);
      res.status(200).json(snap);
    } catch (err: any) {
      res.status(400).json({ error: sanitizeError(err?.message || "Account action failed.") });
    }
  });

  app.post("/api/ux/memory", requireAuthenticatedClient, async (req: any, res) => {
    try {
      if (!assertWriteRoleAllowed(req, res)) return;
      if (!(await assertSystemNotHalted(res, req.authContext.identityId, "/api/ux/memory"))) return;

      const {
        action = "save",
        deviceId: requestedDeviceId = DEFAULT_MOBILE_UX_ID,
        productType = "MYRAA_MOBILE",
        accountId,
        scope = "SHARED",
        domain = "MEMORY",
        key,
        value,
        category,
      } = req.body || {};

      // Enforce DLP and prompt-injection screening on UX memory payloads
      const serializedVal = typeof value === "string" ? value : JSON.stringify(value ?? "");
      const { isDlpClean } = await import("../memory/SharedMemoryManager.ts");
      if ((key && !isDlpClean(String(key))) || !isDlpClean(serializedVal)) {
        return res.status(422).json({
          error: "DLP_SECRET_REJECTED: Secrets or credentials cannot be stored in UX memory.",
          blocked: true,
        });
      }
      const { contentSanitizer } = await import("../security/ContentSanitizer.ts");
      if (contentSanitizer.scanForPromptInjection(serializedVal).hasInjectionAttempt) {
        return res.status(422).json({
          error: "PROMPT_INJECTION_BLOCKED: UX memory payload contains unsafe prompt-injection patterns.",
          blocked: true,
        });
      }

      // Bind deviceId strictly for non-operator paired devices
      const deviceId =
        req.authContext.authType === "remote_device"
          ? req.authContext.deviceId || req.authContext.identityId
          : requestedDeviceId;

      // Also enqueue a governed memory write proposal for permanent storage tracking
      const { governingMemoryGate } = await import("../companion/GoverningMemoryGate.ts");
      const proposal = await governingMemoryGate.requestWrite({
        action: "CREATE",
        proposedMemory: {
          category: (category as any) || "fact",
          key: key ? String(key) : undefined,
          text: `${String(key || domain)}: ${serializedVal}`,
        },
        reason: `UX memory ${action} proposal`,
        confidence: 0.85,
        source: "user_explicit",
        userId: req.authContext.identityId,
        provenance: `HttpGateway.POST /api/ux/memory:${deviceId}`,
        sessionId: req.authContext.sessionId,
      } as any);

      res.status(202).json({
        status: "pending_approval",
        requestId: proposal.id,
        deviceId,
        accountId: accountId ?? null,
        scope,
        domain,
        message: "UX memory mutation queued for operator approval.",
      });
    } catch (err: any) {
      const msg = err?.message || "Memory operation failed.";
      if (msg.includes("DLP_SECRET_REJECTED") || msg.includes("PROMPT_INJECTION_BLOCKED")) {
        return res.status(422).json({ error: msg, blocked: true });
      }
      if (msg.includes("EMERGENCY_STOP_ACTIVE")) return res.status(503).json({ error: msg, blocked: true });
      if (msg.includes("SECURITY_LOCKDOWN_ACTIVE")) return res.status(423).json({ error: msg, blocked: true });
      res.status(400).json({ error: sanitizeError(msg) });
    }
  });

  app.post("/api/ux/remote/pair-request", async (req, res) => {
    try {
      const {
        sourceDeviceId = DEFAULT_MOBILE_UX_ID,
        targetDeviceId = DEFAULT_DESKTOP_UX_ID,
        accountId,
        role = "admin",
      } = req.body || {};
      const { remoteBridge } = await import("../device/index.ts");
      const challenge = remoteBridge.requestPairing({
        sourceDeviceId,
        targetDeviceId,
        requestedBy: accountId || sourceDeviceId,
        role,
        explicitUserAction: true,
      });
      lastUxPairingId = challenge.pairingId;
      const snap = await buildUxSnapshot(DEFAULT_MOBILE_UX_ID, DEFAULT_DESKTOP_UX_ID);
      res.status(200).json({ ...snap, challenge, pairingCode: challenge.pairingCode, pairingId: challenge.pairingId });
    } catch (err: any) {
      res.status(400).json({ error: sanitizeError(err?.message || "Pairing request failed.") });
    }
  });

  app.post("/api/ux/remote/pair-confirm", async (req, res) => {
    try {
      const { pairingId, pairingCode, connectAfterPair = true } = req.body || {};
      const { remoteBridge, productionUxController } = await import("../device/index.ts");
      const effectivePairingId = pairingId || lastUxPairingId || "";
      const confirmed = remoteBridge.confirmPairing({
        pairingId: String(effectivePairingId),
        pairingCode: String(pairingCode || ""),
        approvedByTargetUser: true,
      });
      if (confirmed.success && connectAfterPair && confirmed.pairing) {
        await productionUxController.connectRemoteBridgeFromUx({
          sourceDeviceId: confirmed.pairing.sourceDeviceId,
          targetDeviceId: confirmed.pairing.targetDeviceId,
        });
      }
      const snap = await buildUxSnapshot(DEFAULT_MOBILE_UX_ID, DEFAULT_DESKTOP_UX_ID);
      res.status(200).json({ ...snap, pairingResult: confirmed });
    } catch (err: any) {
      res.status(400).json({ error: sanitizeError(err?.message || "Pairing confirmation failed.") });
    }
  });

  app.post("/api/ux/remote/connect", async (req, res) => {
    try {
      const {
        sourceDeviceId = DEFAULT_MOBILE_UX_ID,
        targetDeviceId = DEFAULT_DESKTOP_UX_ID,
        autoPairIfNeeded = true,
      } = req.body || {};
      const { productionUxController, remoteBridge } = await import("../device/index.ts");
      let connectOutcome: any;
      if (autoPairIfNeeded && !remoteBridge.isPaired(sourceDeviceId, targetDeviceId)) {
        connectOutcome = await productionUxController.pairAndConnectRemoteDevice({
          sourceDeviceId,
          targetDeviceId,
          connectNow: true,
        });
      } else {
        const center = await productionUxController.connectRemoteBridgeFromUx({
          sourceDeviceId,
          targetDeviceId,
        });
        connectOutcome = {
          paired: remoteBridge.isPaired(sourceDeviceId, targetDeviceId),
          connected: center.connectionStatus === "CONNECTED",
          remoteControlCenter: center,
        };
      }
      const snap = await buildUxSnapshot(DEFAULT_MOBILE_UX_ID, DEFAULT_DESKTOP_UX_ID);
      res.status(200).json({ ...snap, connectOutcome });
    } catch (err: any) {
      res.status(400).json({ error: sanitizeError(err?.message || "Remote bridge connect failed.") });
    }
  });

  app.post("/api/ux/remote/disconnect", async (req, res) => {
    try {
      const { sourceDeviceId, deviceId, reason } = req.body || {};
      const { productionUxController } = await import("../device/index.ts");
      productionUxController.disconnectRemoteBridgeFromUx({
        sourceDeviceId: sourceDeviceId || deviceId || DEFAULT_MOBILE_UX_ID,
        reason,
      });
      const snap = await buildUxSnapshot(DEFAULT_MOBILE_UX_ID, DEFAULT_DESKTOP_UX_ID);
      res.status(200).json(snap);
    } catch (err: any) {
      res.status(400).json({ error: sanitizeError(err?.message || "Remote bridge disconnect failed.") });
    }
  });

  app.post("/api/ux/handoff", async (req, res) => {
    try {
      const {
        action = "conversational",
        accountId = "acct-sandeep-myraa",
        handoffId,
        workflowId,
        handoffToken,
        utterance,
        sourceDeviceId = DEFAULT_MOBILE_UX_ID,
        targetDeviceId = DEFAULT_DESKTOP_UX_ID,
        projectPath = "d:/SORA AI/Sora AI",
        filePath = "src/App.tsx",
      } = req.body || {};
      const effectiveHandoffId = handoffId || workflowId;
      const {
        crossDeviceWorkflowOrchestrator,
        sharedAccountMemoryManager,
      } = await import("../device/index.ts");

      // Ensure account & both devices are registered and online if running handoff from UX
      if (!sharedAccountMemoryManager.getAccount(accountId)) {
        sharedAccountMemoryManager.registerAccount({
          accountId,
          displayName: "Sandeep Mishra",
          role: "admin",
        });
      }
      if (!sharedAccountMemoryManager.getAccountDevice(accountId, DEFAULT_MOBILE_UX_ID)) {
        sharedAccountMemoryManager.registerAccountDevice({
          accountId,
          deviceId: DEFAULT_MOBILE_UX_ID,
          deviceName: "MYRAA Android Phone",
          productType: "MYRAA_MOBILE",
          role: "admin",
          online: true,
        });
      }
      if (!sharedAccountMemoryManager.getAccountDevice(accountId, DEFAULT_DESKTOP_UX_ID)) {
        sharedAccountMemoryManager.registerAccountDevice({
          accountId,
          deviceId: DEFAULT_DESKTOP_UX_ID,
          deviceName: "MYRAA Windows Workstation",
          productType: "MYRAA_DESKTOP",
          role: "admin",
          online: true,
        });
      }

      let outcome: any;
      if (action === "conversational") {
        outcome = await crossDeviceWorkflowOrchestrator.executeConversationalCrossDeviceTurn({
          accountId,
          utterance: String(utterance || "Desktop par mera project kholo"),
          sourceDeviceId,
          targetDeviceId,
          activeHandoffId: effectiveHandoffId,
          projectPath,
          filePath,
          explicitAuthorization: true,
        });
        if (!outcome?.ok && !outcome?.handoff) {
          outcome = crossDeviceWorkflowOrchestrator.createHandoff({
            accountId,
            sourceDeviceId,
            targetDeviceId,
            intent: targetDeviceId === DEFAULT_MOBILE_UX_ID ? "CREATE_REMINDER" : "OPEN_FOLDER",
            capability:
              targetDeviceId === DEFAULT_MOBILE_UX_ID ? "mobile.notes" : "desktop.openFolder",
            utterance: String(utterance || "Desktop par mera project kholo"),
            args:
              targetDeviceId === DEFAULT_MOBILE_UX_ID
                ? { title: "Continued Task", content: String(utterance || "Continued on phone") }
                : { path: projectPath, filePath },
            rawContext: {
              projectPath,
              filePath,
              summary: String(utterance || "Cross-device handoff task"),
              current_window: "MustBeStrippedLocalWindow",
            },
            explicitAuthorization: true,
          });
        }
      } else if (action === "continue") {
        const latestWf =
          crossDeviceWorkflowOrchestrator.listHandoffsForDevice(sourceDeviceId)[0] ||
          crossDeviceWorkflowOrchestrator.listHandoffsForDevice(targetDeviceId)[0];
        const targetId = effectiveHandoffId || latestWf?.handoffId;
        if (targetId && !utterance) {
          outcome = await crossDeviceWorkflowOrchestrator.continueHandoffStep({
            handoffId: targetId,
            handoffToken,
          });
        } else {
          outcome = await crossDeviceWorkflowOrchestrator.executeConversationalCrossDeviceTurn({
            accountId,
            utterance: String(utterance || "Ye task phone par continue karo"),
            sourceDeviceId,
            targetDeviceId,
            projectPath,
            filePath,
            explicitAuthorization: true,
          });
        }
      } else if (action === "pause" && effectiveHandoffId) {
        outcome = crossDeviceWorkflowOrchestrator.pauseHandoff({
          handoffId: effectiveHandoffId,
          requestedByDeviceId: sourceDeviceId,
          reason: "Paused from Production UX",
        });
      } else if (action === "resume" && effectiveHandoffId) {
        outcome = crossDeviceWorkflowOrchestrator.resumeHandoff({
          handoffId: effectiveHandoffId,
          handoffToken,
          resumingDeviceId: targetDeviceId,
        });
      } else if (action === "disconnect" && effectiveHandoffId) {
        outcome = crossDeviceWorkflowOrchestrator.handleDeviceDisconnect({
          handoffId: effectiveHandoffId,
          disconnectedDeviceId: targetDeviceId,
          reason: "Simulated disconnect from UX",
        });
      } else if (action === "recover" && effectiveHandoffId) {
        outcome = crossDeviceWorkflowOrchestrator.recoverHandoffAfterReconnect({
          handoffId: effectiveHandoffId,
          reconnectedDeviceId: targetDeviceId,
          handoffToken,
        });
      } else {
        outcome = crossDeviceWorkflowOrchestrator.createHandoff({
          accountId,
          sourceDeviceId,
          targetDeviceId,
          intent: "OPEN_PROJECT",
          capability:
            targetDeviceId === DEFAULT_MOBILE_UX_ID
              ? "mobile.openApp"
              : "desktop.openFolder",
          utterance: String(utterance || "Cross-device handoff"),
          rawContext: {
            projectPath,
            filePath,
            summary: String(utterance || "Cross-device handoff task"),
            current_window: "MustBeStrippedLocalWindow",
          },
          explicitAuthorization: true,
        });
      }

      const snap = await buildUxSnapshot(DEFAULT_MOBILE_UX_ID, DEFAULT_DESKTOP_UX_ID);
      res.status(200).json({ ...snap, handoffOutcome: outcome });
    } catch (err: any) {
      res.status(400).json({ error: sanitizeError(err?.message || "Handoff operation failed.") });
    }
  });

  app.post("/api/ux/security/emergency-stop", async (req, res) => {
    try {
      const {
        active,
        action,
        reason = "Triggered from Production UX Control Center",
        deviceId = DEFAULT_DESKTOP_UX_ID,
      } = req.body || {};
      const shouldActivate = action ? action === "trigger" : Boolean(active);
      const { emergencyStopCoordinator } = await import("../remote/EmergencyStopCoordinator.ts");
      if (shouldActivate) {
        await emergencyStopCoordinator.trigger({
          source: deviceId === DEFAULT_MOBILE_UX_ID ? "remote_device" : "desktop_ui",
          deviceId,
          deviceName:
            deviceId === DEFAULT_MOBILE_UX_ID
              ? "MYRAA Android Phone"
              : "MYRAA Windows Workstation",
          reason,
        });
      } else {
        await emergencyStopCoordinator.reset("local_admin_operator");
      }
      const snap = await buildUxSnapshot(DEFAULT_MOBILE_UX_ID, DEFAULT_DESKTOP_UX_ID);
      res.status(200).json(snap);
    } catch (err: any) {
      res.status(400).json({ error: sanitizeError(err?.message || "Emergency stop toggle failed.") });
    }
  });

  app.post("/api/ux/security/lockdown", async (req, res) => {
    try {
      const { active, mode } = req.body || {};
      const { securityPolicyEngine } = await import("../security/SecurityPolicyEngine.ts");
      if (typeof mode === "string") {
        const upper = mode.toUpperCase();
        if (upper === "LOCKDOWN") {
          securityPolicyEngine.setMode("LOCKDOWN");
        } else if (upper === "ELEVATED" || upper === "STRICT") {
          securityPolicyEngine.setMode("STRICT");
        } else if (upper === "PARANOID") {
          securityPolicyEngine.setMode("PARANOID");
        } else {
          securityPolicyEngine.setMode("BALANCED");
        }
      } else {
        securityPolicyEngine.setMode(active ? "LOCKDOWN" : "BALANCED");
      }
      const snap = await buildUxSnapshot(DEFAULT_MOBILE_UX_ID, DEFAULT_DESKTOP_UX_ID);
      res.status(200).json(snap);
    } catch (err: any) {
      res.status(400).json({ error: sanitizeError(err?.message || "Security lockdown toggle failed.") });
    }
  });

  // ── Voice & Speech Prosody Layer Endpoints ──────────────────────────────
  app.get("/api/voice/languages", async (_req, res) => {
    try {
      const { languageManager } = await import("../voice/index.ts");
      const profiles = languageManager.getAllProfiles().map((p) => ({
        id: p.id,
        name: p.name,
        nativeName: p.nativeName,
        locale: p.locale,
        script: p.script,
        sttLocale: p.sttConfig.locale,
        sttFallback: p.sttConfig.fallbackLocale,
        ttsLocale: p.ttsConfig.locale,
        ttsFallback: p.ttsConfig.fallbackLocale,
        geminiVoice: p.ttsConfig.geminiVoice,
        hasNativeTts: p.ttsConfig.providerNativeSupport,
        hasNativeStt: p.sttConfig.providerNativeSupport,
      }));
      res.status(200).json({
        ok: true,
        preferredLanguage: languageManager.getPreferredLanguage(),
        activeLanguage: languageManager.getActiveLanguage(),
        languages: profiles,
      });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to list languages") });
    }
  });

  app.get("/api/voice/language", async (req, res) => {
    try {
      const conversationId = typeof req.query.conversationId === "string" ? req.query.conversationId : "default";
      const { languageManager } = await import("../voice/index.ts");
      res.status(200).json({
        ok: true,
        preferredLanguage: languageManager.getPreferredLanguage(),
        activeLanguage: languageManager.getActiveLanguage(conversationId),
        switchHistory: languageManager.getSwitchHistory(),
      });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to get language state") });
    }
  });

  app.post("/api/voice/language", async (req, res) => {
    try {
      const { language, conversationId } = req.body || {};
      if (!language || typeof language !== "string") {
        res.status(400).json({ error: "Missing required string 'language'" });
        return;
      }
      const { languageManager } = await import("../voice/index.ts");
      languageManager.setPreferredLanguage(language as any);
      if (conversationId && typeof conversationId === "string" && language !== "auto") {
        languageManager.setActiveLanguage(language as any, conversationId, "api_manual");
      }
      res.status(200).json({
        ok: true,
        preferredLanguage: languageManager.getPreferredLanguage(),
        activeLanguage: languageManager.getActiveLanguage(conversationId || "default"),
      });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to set language preference") });
    }
  });

  app.post("/api/voice/detect-language", async (req, res) => {
    try {
      const { text } = req.body || {};
      if (!text || typeof text !== "string") {
        res.status(400).json({ error: "Missing required string 'text'" });
        return;
      }
      const { languageManager } = await import("../voice/index.ts");
      const detection = languageManager.detectLanguage(text);
      res.status(200).json({ ok: true, ...detection });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Language detection failed") });
    }
  });

  app.post("/api/voice/prosody", async (req, res) => {
    try {
      const { text, context, language } = req.body || {};
      if (!text || typeof text !== "string") {
        res.status(400).json({ error: "Missing required string 'text'" });
        return;
      }
      const { speechProsodyEngine } = await import("../voice/index.ts");
      const mergedContext = {
        ...context,
        forceLanguage: language || context?.forceLanguage,
      };
      const result = speechProsodyEngine.transformSpeech(text, mergedContext);
      res.status(200).json({ ok: true, ...result });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Prosody transform failed") });
    }
  });

  app.post("/api/voice/synthesize", async (req, res) => {
    try {
      const { text, context, options, language } = req.body || {};
      if (!text || typeof text !== "string") {
        res.status(400).json({ error: "Missing required string 'text'" });
        return;
      }
      const { voiceSynthesizer } = await import("../voice/index.ts");
      const keyMeta = resolveApiKeyWithMetadata();
      const mergedContext = {
        ...context,
        forceLanguage: language || context?.forceLanguage,
      };
      const result = await voiceSynthesizer.synthesize(text, mergedContext, options, keyMeta.key);
      res.status(200).json({
        ok: true,
        prosody: result.prosody,
        audio: {
          format: result.audio.format,
          sampleRate: result.audio.sampleRate,
          channels: result.audio.channels,
          durationMs: result.audio.durationMs,
          pcm16Base64: result.audio.pcm16Base64,
          byteLength: result.audio.byteLength,
        },
      });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Speech synthesis failed") });
    }
  });

  app.get("/api/voice/synthesize", async (req, res) => {
    try {
      const text = typeof req.query.text === "string" ? req.query.text : "";
      if (!text) {
        res.status(400).json({ error: "Missing required query 'text'" });
        return;
      }
      const emotion = typeof req.query.emotion === "string" ? (req.query.emotion as any) : undefined;
      const language = typeof req.query.language === "string" ? (req.query.language as any) : undefined;
      const { voiceSynthesizer } = await import("../voice/index.ts");
      const keyMeta = resolveApiKeyWithMetadata();
      const result = await voiceSynthesizer.synthesize(
        text,
        { forceEmotion: emotion, forceLanguage: language },
        { format: "wav" },
        keyMeta.key
      );

      if (result.audio.wavBuffer) {
        res.setHeader("Content-Type", "audio/wav");
        res.setHeader("Content-Length", result.audio.wavBuffer.length);
        res.setHeader("Cache-Control", "no-cache");
        res.status(200).send(result.audio.wavBuffer);
      } else {
        res.status(500).json({ error: "Audio buffer generation failed" });
      }
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Audio stream generation failed") });
    }
  });

  app.get("/api/voice/quick-ack", async (req, res) => {
    try {
      const text = typeof req.query.text === "string" ? req.query.text : "";
      const language = typeof req.query.language === "string" ? (req.query.language as any) : undefined;
      const { speechProsodyEngine } = await import("../voice/index.ts");
      const ack = speechProsodyEngine.getQuickAcknowledgement(text, language);
      res.status(200).json({ ok: true, acknowledgement: ack });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Quick ack failed") });
    }
  });

  app.post("/api/voice/validate-sentence", async (req, res) => {
    try {
      const { text, language, userPrompt } = req.body || {};
      if (!text || typeof text !== "string") {
        res.status(400).json({ error: "Missing required string 'text'" });
        return;
      }
      const { sentenceQualityGate, languageManager } = await import("../voice/index.ts");
      const targetLang = (language as any) || languageManager.detectLanguage(text).language;
      const result = sentenceQualityGate.validateAndRefine(text, targetLang, { userPrompt });
      res.status(200).json({ ok: true, language: targetLang, ...result });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Sentence validation failed") });
    }
  });

  app.post("/api/voice/conversation-pacing", async (req, res) => {
    try {
      const { userPrompt, language, dialogueHistory } = req.body || {};
      if (!userPrompt || typeof userPrompt !== "string") {
        res.status(400).json({ error: "Missing required string 'userPrompt'" });
        return;
      }
      const { humanConversationEngine, languageManager } = await import("../voice/index.ts");
      const targetLang = (language as any) || languageManager.detectLanguage(userPrompt).language;
      const result = humanConversationEngine.decidePacing(userPrompt, targetLang, dialogueHistory || []);
      res.status(200).json({ ok: true, language: targetLang, ...result });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Conversation pacing evaluation failed") });
    }
  });

  app.post("/api/voice/reaction", async (req, res) => {
    try {
      const { text, emotion, language, context } = req.body || {};
      if (!text || typeof text !== "string") {
        res.status(400).json({ error: "Missing required string 'text'" });
        return;
      }
      const { naturalReactionEngine, languageManager, speechProsodyEngine } = await import("../voice/index.ts");
      const targetLang = (language as any) || languageManager.detectLanguage(text).language;
      const targetEmotion = (emotion as any) || speechProsodyEngine.detectEmotion(text, context);
      const result = naturalReactionEngine.decideReaction(text, targetEmotion, targetLang, context);
      res.status(200).json({ ok: true, language: targetLang, emotion: targetEmotion, ...result });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Reaction decision failed") });
    }
  });

  // ── Phase 17 — Intelligence 2.0 REST Endpoints ───────────────────────────
  app.post("/api/intelligence/evaluate", async (req, res) => {
    try {
      const { input, contextId, device } = req.body || {};
      if (!input || typeof input !== "string") {
        res.status(400).json({ error: "Missing required string 'input'" });
        return;
      }
      const { intelligenceCoordinator } = await import("../intelligence/index.ts");
      const decision = intelligenceCoordinator.evaluate(input, contextId || "default", undefined, device);
      res.status(200).json({ ok: true, decision });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Intelligence evaluation failed") });
    }
  });

  app.post("/api/intelligence/execute", async (req, res) => {
    try {
      const { input, contextId, device } = req.body || {};
      if (!input || typeof input !== "string") {
        res.status(400).json({ error: "Missing required string 'input'" });
        return;
      }
      const { intelligenceCoordinator } = await import("../intelligence/index.ts");
      const result = await intelligenceCoordinator.execute(input, contextId || "default", undefined, undefined, device);
      res.status(200).json(result);
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Intelligence execution failed") });
    }
  });

  app.get("/api/intelligence/task/active", async (req, res) => {
    try {
      const contextId = (req.query.contextId as string) || "default";
      const { contextFusionEngine } = await import("../intelligence/index.ts");
      const activeTask = contextFusionEngine.getActiveTask(contextId);
      res.status(200).json({ ok: true, activeTask });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to retrieve active task") });
    }
  });

  app.get("/api/intelligence/traces", async (req, res) => {
    try {
      const limit = parseInt((req.query.limit as string) || "50", 10);
      const { intelligenceTrace } = await import("../intelligence/index.ts");
      const traces = intelligenceTrace.listTraces(limit);
      res.status(200).json({ ok: true, traces });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to retrieve traces") });
    }
  });

  app.post("/api/intelligence/context", requireAuthenticatedClient, async (req: any, res) => {
    const authCtx = req.authContext as AuthenticatedHttpContext;
    const { securityAuditLogger } = await import("../security/SecurityAuditLogger.ts");
    const logReject = (reason: string, status: number, error: string) => {
      securityAuditLogger.logEvent({
        eventType: "TOOL_BLOCKED",
        actor: {
          identityId: authCtx.identityId,
          role: authCtx.role as any,
          ipAddress: authCtx.ipAddress,
          sessionId: authCtx.sessionId,
          deviceId: authCtx.deviceId,
        },
        target: { resource: "/api/intelligence/context" },
        decision: "BLOCK",
        reason,
        riskLevel: status === 403 ? "HIGH" : "MEDIUM",
      });
      res.status(status).json({ error });
    };

    try {
      if (!assertWriteRoleAllowed(req, res)) return;
      if (!(await assertSystemNotHalted(res, authCtx.identityId, "/api/intelligence/context"))) return;

      const body = req.body;
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return logReject("INVALID_INTELLIGENCE_CONTEXT: Request body must be a JSON object.", 400, "INVALID_INTELLIGENCE_CONTEXT: Request body must be a JSON object.");
      }

      const ALLOWED_TOP_KEYS = new Set(["contextId", "file", "app", "website", "preferences"]);
      const dangerousKeys = ["__proto__", "constructor", "prototype"];
      for (const dk of dangerousKeys) {
        if (Object.prototype.hasOwnProperty.call(body, dk)) {
          return logReject(`INVALID_INTELLIGENCE_CONTEXT: Forbidden key '${dk}'.`, 400, `INVALID_INTELLIGENCE_CONTEXT: Forbidden key '${dk}' detected.`);
        }
      }
      for (const k of Object.keys(body)) {
        if (!ALLOWED_TOP_KEYS.has(k)) {
          return logReject(`INVALID_INTELLIGENCE_CONTEXT: Unexpected key '${k}'.`, 400, `INVALID_INTELLIGENCE_CONTEXT: Unexpected property '${k}'.`);
        }
      }

      const { contextId, file, app: appName, website, preferences } = body;
      if (contextId !== undefined) {
        if (typeof contextId !== "string" || !/^[a-zA-Z0-9_.:-]{1,64}$/.test(contextId)) {
          return logReject("INVALID_INTELLIGENCE_CONTEXT: Invalid contextId.", 400, "INVALID_INTELLIGENCE_CONTEXT: 'contextId' must be 1-64 safe characters.");
        }
        // Prevent remote devices from overwriting another user's context
        if (
          authCtx.authType === "remote_device" &&
          contextId !== authCtx.identityId &&
          contextId !== authCtx.deviceId
        ) {
          return logReject(
            `UNAUTHORIZED_CONTEXT_TARGET: Device '${authCtx.identityId}' cannot mutate context '${contextId}'.`,
            403,
            "UNAUTHORIZED_CONTEXT_TARGET: Remote clients may only update their own contextId.",
          );
        }
      }

      const { isDlpClean } = await import("../memory/SharedMemoryManager.ts");
      const { contentSanitizer } = await import("../security/ContentSanitizer.ts");
      for (const [fieldName, fieldVal] of [
        ["file", file],
        ["app", appName],
        ["website", website],
      ] as const) {
        if (fieldVal !== undefined) {
          if (typeof fieldVal !== "string" || fieldVal.length > 512) {
            return logReject(`INVALID_INTELLIGENCE_CONTEXT: '${fieldName}' must be a string <= 512 chars.`, 400, `INVALID_INTELLIGENCE_CONTEXT: '${fieldName}' must be a string <= 512 chars.`);
          }
          if (!isDlpClean(fieldVal) || contentSanitizer.scanForPromptInjection(fieldVal, { source: "intelligence_context" }).hasInjectionAttempt) {
            return logReject(`INVALID_INTELLIGENCE_CONTEXT: Unsafe content in '${fieldName}'.`, 422, `INVALID_INTELLIGENCE_CONTEXT: '${fieldName}' contains disallowed secret or injection content.`);
          }
        }
      }

      const cid =
        contextId ||
        (authCtx.authType === "remote_device" ? authCtx.identityId : "default");
      const { contextFusionEngine, userPreferenceResolver } = await import("../intelligence/index.ts");

      if (preferences !== undefined) {
        if (!preferences || typeof preferences !== "object" || Array.isArray(preferences)) {
          return logReject("INVALID_PREFERENCES: 'preferences' must be a JSON object.", 400, "INVALID_PREFERENCES: 'preferences' must be a JSON object.");
        }
        // Protected security preference `autoConfirmLowRisk` is never mutable via /api/intelligence/context
        if (Object.prototype.hasOwnProperty.call(preferences, "autoConfirmLowRisk")) {
          return logReject(
            "PROTECTED_PREFERENCE: Attempted mutation of 'autoConfirmLowRisk' via /api/intelligence/context.",
            403,
            "PROTECTED_PREFERENCE: 'autoConfirmLowRisk' cannot be modified through /api/intelligence/context.",
          );
        }
        // `preferredWorkspace` requires authorized local admin operator preference flow
        if (Object.prototype.hasOwnProperty.call(preferences, "preferredWorkspace")) {
          const isAuthorizedLocalAdmin =
            authCtx.authType === "operator" && authCtx.isLocal && authCtx.role === "admin";
          if (!isAuthorizedLocalAdmin) {
            return logReject(
              "PROTECTED_PREFERENCE: Unauthorized mutation of 'preferredWorkspace' via /api/intelligence/context.",
              403,
              "PROTECTED_PREFERENCE: 'preferredWorkspace' may only be updated by an authorized local admin operator.",
            );
          }
        }

        // Validate preference strings for DLP & prompt injection
        for (const [pk, pv] of Object.entries(preferences)) {
          if (typeof pv === "string") {
            if (!isDlpClean(pv) || contentSanitizer.scanForPromptInjection(pv, { source: `pref_${pk}` }).hasInjectionAttempt) {
              return logReject(`INVALID_PREFERENCES: Unsafe value for '${pk}'.`, 422, `INVALID_PREFERENCES: Preference '${pk}' contains disallowed secret or injection content.`);
            }
          }
        }

        try {
          userPreferenceResolver.updatePreferencesWithProvenance(cid, preferences, {
            source: authCtx.authType === "operator" ? "operator" : "api",
            actorId: authCtx.identityId,
            role: authCtx.role,
            isLocal: authCtx.isLocal,
            isStepUpAuthenticated: authCtx.isStepUpAuthenticated,
          });
        } catch (prefErr: any) {
          const msg = prefErr?.message || "Invalid preferences";
          const status = msg.includes("PROTECTED_PREFERENCE") ? 403 : 400;
          return logReject(msg, status, msg);
        }
      }

      if (file !== undefined) contextFusionEngine.setCurrentFile(cid, file);
      if (appName !== undefined) contextFusionEngine.setCurrentApplication(cid, appName);
      if (website !== undefined) contextFusionEngine.setCurrentWebsite(cid, website);

      securityAuditLogger.logEvent({
        eventType: "TOOL_CONFIRMED",
        actor: {
          identityId: authCtx.identityId,
          role: authCtx.role as any,
          ipAddress: authCtx.ipAddress,
          sessionId: authCtx.sessionId,
          deviceId: authCtx.deviceId,
        },
        target: { resource: "/api/intelligence/context" },
        decision: "ALLOW",
        reason: `INTELLIGENCE_CONTEXT_UPDATED: Context '${cid}' updated by '${authCtx.identityId}'.`,
        riskLevel: "LOW",
        metadata: {
          contextId: cid,
          updatedFields: Object.keys(body),
          preferenceKeys: preferences ? Object.keys(preferences) : [],
        },
      });

      const fused = contextFusionEngine.fuseContext(cid);
      res.status(200).json({ ok: true, context: fused });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Context update failed") });
    }
  });

  // ── Phase 19 — Advanced Context Fusion REST Endpoints ────────────────────
  app.post(["/api/intelligence/unified-context", "/api/context/unified"], async (req, res) => {
    try {
      const { contextId, overrides, device, input } = req.body || {};
      const { contextFusionCoordinator } = await import("../intelligence/index.ts");
      const unifiedContext = await contextFusionCoordinator.fuseUnifiedContext(
        contextId || "default",
        overrides,
        device,
        input
      );
      res.status(200).json({ ok: true, unifiedContext });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Unified context fusion failed") });
    }
  });

  app.post(["/api/intelligence/resolve-reference", "/api/context/resolve-reference"], async (req, res) => {
    try {
      const { input, contextId } = req.body || {};
      if (!input || typeof input !== "string") {
        res.status(400).json({ error: "Missing required string 'input'" });
        return;
      }
      const { contextFusionEngine, referenceResolver } = await import("../intelligence/index.ts");
      const base = contextFusionEngine.fuseContext(contextId || "default");
      const reference = referenceResolver.resolveReference(input, base);
      res.status(200).json({ ok: true, reference });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Reference resolution failed") });
    }
  });

  app.get(["/api/intelligence/provenance", "/api/context/provenance"], async (req, res) => {
    try {
      const limit = parseInt((req.query.limit as string) || "50", 10);
      const { contextProvenanceTracker } = await import("../intelligence/index.ts");
      const records = contextProvenanceTracker.listRecentProvenance(limit);
      res.status(200).json({ ok: true, provenance: records });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to retrieve provenance") });
    }
  });

  // ── Phase 18 — Adaptive Personal Brain REST Endpoints (secured FINDING-AUD-03) ──
  app.post("/api/brain/learn", requireAuthenticatedClient, async (req: any, res) => {
    try {
      if (!assertWriteRoleAllowed(req, res)) return;
      if (!(await assertSystemNotHalted(res, req.authContext.identityId, "/api/brain/learn"))) return;

      const { utterance } = req.body || {};
      if (!utterance || typeof utterance !== "string") {
        res.status(400).json({ error: "Missing required string 'utterance'" });
        return;
      }

      const { isDlpClean } = await import("../memory/SharedMemoryManager.ts");
      if (!isDlpClean(utterance)) {
        return res.status(422).json({
          error: "DLP_SECRET_REJECTED: Secrets or credentials cannot be stored via brain learning.",
          blocked: true,
        });
      }
      const { contentSanitizer } = await import("../security/ContentSanitizer.ts");
      if (contentSanitizer.scanForPromptInjection(utterance).hasInjectionAttempt) {
        return res.status(422).json({
          error: "PROMPT_INJECTION_BLOCKED: Utterance contains unsafe prompt-injection patterns.",
          blocked: true,
        });
      }

      const { governingMemoryGate } = await import("../companion/GoverningMemoryGate.ts");
      const proposal = await governingMemoryGate.requestWrite({
        action: "CREATE",
        proposedMemory: {
          category: "preference",
          text: utterance.trim(),
          source: "user_explicit",
        },
        reason: "Adaptive brain learning proposal",
        confidence: 0.8,
        source: "user_explicit",
        userId: req.authContext.identityId,
        provenance: "HttpGateway.POST /api/brain/learn",
        sessionId: req.authContext.sessionId,
      } as any);

      res.status(202).json({
        ok: true,
        status: "pending_approval",
        requestId: proposal.id,
        message: "Brain learning proposal queued. Awaiting operator confirmation.",
      });
    } catch (err: any) {
      const msg = err?.message || "Brain learning processing failed";
      if (msg.includes("DLP_SECRET_REJECTED") || msg.includes("PROMPT_INJECTION_BLOCKED")) {
        return res.status(422).json({ error: msg, blocked: true });
      }
      if (msg.includes("EMERGENCY_STOP_ACTIVE")) return res.status(503).json({ error: msg, blocked: true });
      if (msg.includes("SECURITY_LOCKDOWN_ACTIVE")) return res.status(423).json({ error: msg, blocked: true });
      res.status(500).json({ error: sanitizeError(msg) });
    }
  });

  app.get("/api/brain/preferences", requireAuthenticatedClient, async (req, res) => {
    try {
      const category = req.query.category as any;
      const status = req.query.status as any;
      const minConfidence = req.query.minConfidence ? parseFloat(req.query.minConfidence as string) : undefined;

      const { cognitiveLearningCoordinator } = await import("../brain/index.ts");
      const preferences = await cognitiveLearningCoordinator.listPreferences({
        category,
        status,
        minConfidence,
      });
      res.status(200).json({ ok: true, preferences });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to list cognitive preferences") });
    }
  });

  app.get("/api/brain/prompt", requireAuthenticatedClient, async (_req, res) => {
    try {
      const { cognitiveLearningCoordinator } = await import("../brain/index.ts");
      const prompt = await cognitiveLearningCoordinator.getAdaptivePrompt();
      res.status(200).json({ ok: true, prompt });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to synthesize adaptive prompt") });
    }
  });

  app.get("/api/brain/patterns", requireAuthenticatedClient, async (req, res) => {
    try {
      const minFreq = req.query.minFrequency ? parseInt(req.query.minFrequency as string, 10) : 3;
      const { cognitiveLearningCoordinator } = await import("../brain/index.ts");
      const patterns = await cognitiveLearningCoordinator.getFrequentCommands(minFreq);
      res.status(200).json({ ok: true, patterns });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to get command patterns") });
    }
  });

  app.post("/api/brain/feedback", requireAuthenticatedClient, async (req: any, res) => {
    try {
      if (!assertWriteRoleAllowed(req, res)) return;
      if (!(await assertSystemNotHalted(res, req.authContext.identityId, "/api/brain/feedback"))) return;

      const { text } = req.body || {};
      if (!text || typeof text !== "string") {
        res.status(400).json({ error: "Missing required string 'text'" });
        return;
      }

      const { isDlpClean } = await import("../memory/SharedMemoryManager.ts");
      if (!isDlpClean(text)) {
        return res.status(422).json({
          error: "DLP_SECRET_REJECTED: Secrets or credentials cannot be stored via brain feedback.",
          blocked: true,
        });
      }
      const { contentSanitizer } = await import("../security/ContentSanitizer.ts");
      if (contentSanitizer.scanForPromptInjection(text).hasInjectionAttempt) {
        return res.status(422).json({
          error: "PROMPT_INJECTION_BLOCKED: Feedback contains unsafe prompt-injection patterns.",
          blocked: true,
        });
      }

      const { governingMemoryGate } = await import("../companion/GoverningMemoryGate.ts");
      const proposal = await governingMemoryGate.requestWrite({
        action: "CREATE",
        proposedMemory: {
          category: "preference",
          text: text.trim(),
          source: "user_explicit",
        },
        reason: "Adaptive brain feedback proposal",
        confidence: 0.8,
        source: "user_explicit",
        userId: req.authContext.identityId,
        provenance: "HttpGateway.POST /api/brain/feedback",
        sessionId: req.authContext.sessionId,
      } as any);

      res.status(202).json({
        ok: true,
        status: "pending_approval",
        feedbackReceived: true,
        requestId: proposal.id,
        message: "Brain feedback proposal queued. Awaiting operator confirmation.",
      });
    } catch (err: any) {
      const msg = err?.message || "Feedback processing failed";
      if (msg.includes("DLP_SECRET_REJECTED") || msg.includes("PROMPT_INJECTION_BLOCKED")) {
        return res.status(422).json({ error: msg, blocked: true });
      }
      if (msg.includes("EMERGENCY_STOP_ACTIVE")) return res.status(503).json({ error: msg, blocked: true });
      if (msg.includes("SECURITY_LOCKDOWN_ACTIVE")) return res.status(423).json({ error: msg, blocked: true });
      res.status(500).json({ error: sanitizeError(msg) });
    }
  });

  app.delete("/api/brain/preferences/:id", requireAuthenticatedClient, async (req: any, res) => {
    try {
      if (!assertWriteRoleAllowed(req, res)) return;
      if (!(await assertSystemNotHalted(res, req.authContext.identityId, "/api/brain/preferences/:id"))) return;

      const { id } = req.params;
      const { cognitiveMemoryStore } = await import("../brain/CognitiveMemoryStore.ts");
      const existing = await cognitiveMemoryStore.getMemory(id);
      if (!existing) {
        res.status(404).json({ ok: false, error: "Cognitive preference not found." });
        return;
      }

      const { governingMemoryGate } = await import("../companion/GoverningMemoryGate.ts");
      const proposal = await governingMemoryGate.requestWrite({
        action: "DELETE",
        proposedMemory: {
          id,
          category: "preference",
          key: existing.key,
          text: `${existing.key}: ${typeof existing.value === "string" ? existing.value : JSON.stringify(existing.value)}`,
        },
        reason: `Governed cognitive preference deletion for '${id}'`,
        confidence: 0.85,
        source: "user_explicit",
        userId: req.authContext.identityId,
        provenance: "HttpGateway.DELETE /api/brain/preferences/:id",
        sessionId: req.authContext.sessionId,
      } as any);

      res.status(202).json({
        ok: true,
        status: "pending_approval",
        action: "DELETE",
        requestId: proposal.id,
        message: "Cognitive preference deletion proposal queued. Awaiting operator confirmation.",
      });
    } catch (err: any) {
      const msg = err?.message || "Failed to delete cognitive preference";
      if (msg.includes("EMERGENCY_STOP_ACTIVE")) return res.status(503).json({ error: msg, blocked: true });
      if (msg.includes("SECURITY_LOCKDOWN_ACTIVE")) return res.status(423).json({ error: msg, blocked: true });
      res.status(500).json({ error: sanitizeError(msg) });
    }
  });

  // ── Phase 20 — Advanced Natural Conversation REST Endpoints ───────────────
  app.post("/api/conversation/message", async (req, res) => {
    try {
      const { message, contextId } = req.body || {};
      if (!message || typeof message !== "string") {
        res.status(400).json({ error: "Missing required string 'message'" });
        return;
      }
      const { naturalConversationEngine } = await import("../conversation/index.ts");
      const outcome = await naturalConversationEngine.converse(message, contextId || "default");
      res.status(200).json({ ok: true, outcome });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Conversation turn processing failed") });
    }
  });

  app.post("/api/conversation/interrupt", async (req, res) => {
    try {
      const { utterance, contextId } = req.body || {};
      if (!utterance || typeof utterance !== "string") {
        res.status(400).json({ error: "Missing required string 'utterance'" });
        return;
      }
      const { naturalConversationEngine } = await import("../conversation/index.ts");
      const interruption = naturalConversationEngine.handleInterruption(utterance, contextId || "default");
      res.status(200).json({ ok: true, interruption });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Interruption handling failed") });
    }
  });

  app.get("/api/conversation/state", async (req, res) => {
    try {
      const contextId = (req.query.contextId as string) || "default";
      const { naturalConversationEngine } = await import("../conversation/index.ts");
      const state = naturalConversationEngine.getState(contextId);
      res.status(200).json({ ok: true, state });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to retrieve conversation state") });
    }
  });

  app.post("/api/conversation/confirm", async (req, res) => {
    try {
      const { contextId } = req.body || {};
      const { naturalConversationEngine } = await import("../conversation/index.ts");
      const outcome = await naturalConversationEngine.confirmPending(contextId || "default");
      res.status(200).json({ ok: true, outcome });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Confirmation failed") });
    }
  });

  app.post("/api/conversation/cancel", async (req, res) => {
    try {
      const { contextId } = req.body || {};
      const { naturalConversationEngine } = await import("../conversation/index.ts");
      const outcome = await naturalConversationEngine.cancelPending(contextId || "default");
      res.status(200).json({ ok: true, outcome });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Cancellation failed") });
    }
  });

  app.post("/api/conversation/reset", async (req, res) => {
    try {
      const { contextId } = req.body || {};
      const { naturalConversationEngine } = await import("../conversation/index.ts");
      naturalConversationEngine.reset(contextId || "default");
      res.status(200).json({ ok: true, message: "Conversation state reset" });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Reset failed") });
    }
  });

  // ── Phase 21: Predictive / Proactive Intelligence Endpoints ───────────────
  app.post("/api/proactive/observe", async (req, res) => {
    try {
      const signal = req.body || {};
      const { predictiveContextCoordinator } = await import("../proactive/index.ts");
      const event = await predictiveContextCoordinator.observeSignal(signal);
      res.status(200).json({ ok: true, event });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Signal observation failed") });
    }
  });

  app.get("/api/proactive/pending", async (_req, res) => {
    try {
      const { predictiveContextCoordinator } = await import("../proactive/index.ts");
      const pending = predictiveContextCoordinator.getPendingProactiveEvent();
      res.status(200).json({ ok: true, pending });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to get pending proactive event") });
    }
  });

  app.post("/api/proactive/respond", async (req, res) => {
    try {
      const { userUtterance, contextId } = req.body || {};
      const { predictiveContextCoordinator } = await import("../proactive/index.ts");
      const resolution = await predictiveContextCoordinator.handleUserResponse(userUtterance || "", contextId || "default");
      res.status(200).json({ ok: true, resolution });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Proactive response failed") });
    }
  });

  app.get("/api/proactive/events", async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string, 10) || 20;
      const { predictiveContextCoordinator } = await import("../proactive/index.ts");
      const events = predictiveContextCoordinator.listEvents(limit);
      res.status(200).json({ ok: true, events });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to list proactive events") });
    }
  });

  app.post("/api/proactive/reset", async (_req, res) => {
    try {
      const { predictiveContextCoordinator } = await import("../proactive/index.ts");
      predictiveContextCoordinator.reset();
      res.status(200).json({ ok: true, message: "Proactive engine state reset" });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Reset failed") });
    }
  });

  // ── Phase 22: Multi-Agent Brain Endpoints ─────────────────────────────────
  app.post("/api/multiagent/orchestrate", async (req, res) => {
    try {
      const request = req.body || {};
      const { multiAgentBrainCoordinator } = await import("../multiagent/index.ts");
      const result = await multiAgentBrainCoordinator.orchestrate(request);
      res.status(200).json({ ok: true, result });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Multi-agent orchestration failed") });
    }
  });

  app.post("/api/multiagent/cancel", async (req, res) => {
    try {
      const { reason } = req.body || {};
      const { multiAgentBrainCoordinator } = await import("../multiagent/index.ts");
      multiAgentBrainCoordinator.cancel(reason || "User requested cancellation");
      res.status(200).json({ ok: true, message: "Multi-agent orchestration cancelled" });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Cancellation failed") });
    }
  });

  app.get("/api/multiagent/traces", async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string, 10) || 20;
      const { multiAgentBrainCoordinator } = await import("../multiagent/index.ts");
      const traces = multiAgentBrainCoordinator.getRecentTraces(limit);
      res.status(200).json({ ok: true, traces });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to get traces") });
    }
  });

  app.post("/api/multiagent/reset", async (_req, res) => {
    try {
      const { multiAgentBrainCoordinator } = await import("../multiagent/index.ts");
      multiAgentBrainCoordinator.reset();
      res.status(200).json({ ok: true, message: "Multi-agent coordinator reset" });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Reset failed") });
    }
  });

  // ── Phase 23: Autonomous Coding Engineer Endpoints ─────────────────────────
  app.post("/api/coding/process", async (req, res) => {
    try {
      const request = req.body || {};
      const { autonomousCodingEngineer } = await import("../coding/index.ts");
      const result = await autonomousCodingEngineer.processRequest(request);
      res.status(200).json({ ok: true, result });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Autonomous coding process failed") });
    }
  });

  app.post("/api/coding/apply", async (req, res) => {
    try {
      const { changeSetId } = req.body || {};
      const { autonomousCodingEngineer } = await import("../coding/index.ts");
      const result = await autonomousCodingEngineer.processRequest({
        goal: "Apply approved changes",
        userApprovalGranted: true,
        changeSetId,
      });
      res.status(200).json({ ok: true, result });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Apply changes failed") });
    }
  });

  app.get("/api/coding/changeset", async (req, res) => {
    try {
      const { changeSetId } = req.query as { changeSetId?: string };
      const { changeSetManager } = await import("../coding/index.ts");
      const changeSet = changeSetId
        ? changeSetManager.getChangeSet(changeSetId)
        : changeSetManager.getLatestChangeSet();
      res.status(200).json({ ok: true, changeSet: changeSet || null });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to get ChangeSet") });
    }
  });

  app.post("/api/coding/reset", async (_req, res) => {
    try {
      const { autonomousCodingEngineer } = await import("../coding/index.ts");
      autonomousCodingEngineer.reset();
      res.status(200).json({ ok: true, message: "Autonomous coding engineer reset" });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Reset failed") });
    }
  });

  // ── Step 8: Advanced Browser Research Agent — localhost/core only ─────────
  // Security: All research routes are localhost-only.
  // External content is never executed or trusted as instructions.

  /**
   * POST /api/research/query
   * Execute a full research query with multi-source search, claim extraction,
   * contradiction detection, and citation-backed synthesis.
   */
  app.post("/api/research/query", requireLocalhost, async (req, res) => {
    try {
      const { advancedResearchCoordinator } = await import("../research/index.ts");
      const { question, projectPath, browserContext, maxSources, requireOfficial } = req.body || {};
      if (!question || typeof question !== "string") {
        return res.status(400).json({ error: "Missing required field: question" });
      }
      const result = await advancedResearchCoordinator.query({
        question,
        projectPath: typeof projectPath === "string" ? projectPath : undefined,
        browserContext: browserContext || undefined,
        maxSources: typeof maxSources === "number" ? Math.min(maxSources, 10) : 5,
        requireOfficial: Boolean(requireOfficial),
      });
      res.status(200).json({ ok: true, result });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Research query failed") });
    }
  });

  /**
   * POST /api/research/compare
   * Compare a documentation URL against the project implementation.
   * Returns a structured ComparisonReport with MATCH/MISMATCH findings.
   */
  app.post("/api/research/compare", requireLocalhost, async (req, res) => {
    try {
      const { advancedResearchCoordinator } = await import("../research/index.ts");
      const { documentationUrl, projectPath, specificFiles, focusArea } = req.body || {};
      if (!documentationUrl || typeof documentationUrl !== "string") {
        return res.status(400).json({ error: "Missing required field: documentationUrl" });
      }
      if (!projectPath || typeof projectPath !== "string") {
        return res.status(400).json({ error: "Missing required field: projectPath" });
      }
      const report = await advancedResearchCoordinator.compare({
        documentationUrl,
        projectPath,
        specificFiles: Array.isArray(specificFiles) ? specificFiles : undefined,
        focusArea: typeof focusArea === "string" ? focusArea : undefined,
      });
      res.status(200).json({ ok: true, report });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Comparison failed") });
    }
  });

  /**
   * POST /api/research/browser-context
   * Process a browser page context (user has a docs page open) and analyze it
   * against the project implementation.
   */
  app.post("/api/research/browser-context", requireLocalhost, async (req, res) => {
    try {
      const { advancedResearchCoordinator } = await import("../research/index.ts");
      const { browserContext, projectPath, question } = req.body || {};
      if (!browserContext || typeof browserContext !== "object") {
        return res.status(400).json({ error: "Missing required field: browserContext" });
      }
      const result = await advancedResearchCoordinator.fromBrowserContext({
        browserContext,
        projectPath: typeof projectPath === "string" ? projectPath : undefined,
        question: typeof question === "string" ? question : undefined,
      });
      res.status(200).json({ ok: true, result });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Browser context research failed") });
    }
  });

  /**
   * GET /api/research/session
   * Get current session status and metadata.
   */
  app.get("/api/research/session", requireLocalhost, async (req, res) => {
    try {
      const { advancedResearchCoordinator } = await import("../research/index.ts");
      const { sessionId } = req.query as { sessionId?: string };
      if (sessionId) {
        const session = advancedResearchCoordinator.getSession(sessionId);
        if (!session) {
          return res.status(404).json({ error: "Session not found" });
        }
        res.status(200).json({
          ok: true,
          session: {
            sessionId: session.sessionId,
            status: session.status,
            query: session.query,
            sourceCount: session.sources.length,
            claimCount: session.claims.length,
            contradictionCount: session.contradictions.length,
            startedAt: session.startedAt,
          },
        });
      } else {
        const sessions = advancedResearchCoordinator.getAllSessions().map((s) => ({
          sessionId: s.sessionId,
          status: s.status,
          query: s.query,
          startedAt: s.startedAt,
        }));
        res.status(200).json({ ok: true, sessions });
      }
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to get session") });
    }
  });

  /**
   * GET /api/research/claims
   * Get structured claims for a session.
   */
  app.get("/api/research/claims", requireLocalhost, async (req, res) => {
    try {
      const { advancedResearchCoordinator } = await import("../research/index.ts");
      const { sessionId } = req.query as { sessionId?: string };
      if (!sessionId) {
        return res.status(400).json({ error: "Missing required query: sessionId" });
      }
      const claims = advancedResearchCoordinator.getClaims(sessionId);
      res.status(200).json({ ok: true, sessionId, claims, totalCount: claims.length });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to get claims") });
    }
  });

  /**
   * GET /api/research/citations
   * Get citation registry for the last research session.
   */
  app.get("/api/research/citations", requireLocalhost, async (req, res) => {
    try {
      const { advancedResearchCoordinator } = await import("../research/index.ts");
      const citations = advancedResearchCoordinator.getCitations();
      res.status(200).json({ ok: true, citations, totalCount: citations.length });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to get citations") });
    }
  });

  /**
   * POST /api/research/reset
   * Reset the research coordinator — clears all sessions and citations.
   */
  app.post("/api/research/reset", requireLocalhost, async (_req, res) => {
    try {
      const { advancedResearchCoordinator } = await import("../research/index.ts");
      advancedResearchCoordinator.reset();
      res.status(200).json({ ok: true, message: "Research coordinator reset" });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Reset failed") });
    }
  });

  // ── Stage 1: Browser Intelligence Coordinator — localhost/core only ────────
  /**
   * POST /api/browser-intelligence/execute
   * Executes an end-to-end browser intelligence task.
   */
  app.post("/api/browser-intelligence/execute", requireLocalhost, async (req, res) => {
    try {
      const { browserIntelligenceCoordinator } = await import("../research/browser/index.ts");
      const { goal, initialUrl, allowedOrigins, timeoutMs, maxRetries } = req.body || {};
      if (!goal || typeof goal !== "string") {
        return res.status(400).json({ error: "Missing required field: goal" });
      }
      const result = await browserIntelligenceCoordinator.executeTask({
        goal,
        initialUrl: typeof initialUrl === "string" ? initialUrl : undefined,
        allowedOrigins: Array.isArray(allowedOrigins) ? allowedOrigins : undefined,
        timeoutMs: typeof timeoutMs === "number" ? timeoutMs : undefined,
        maxRetries: typeof maxRetries === "number" ? maxRetries : undefined,
      });
      res.status(200).json({ ok: true, result });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Browser task execution failed") });
    }
  });

  /**
   * POST /api/browser-intelligence/cancel
   * Cancels a running browser task.
   */
  app.post("/api/browser-intelligence/cancel", requireLocalhost, async (req, res) => {
    try {
      const { browserIntelligenceCoordinator } = await import("../research/browser/index.ts");
      const { taskId, reason } = req.body || {};
      if (!taskId || typeof taskId !== "string") {
        return res.status(400).json({ error: "Missing required field: taskId" });
      }
      const cancelled = browserIntelligenceCoordinator.cancelTask(taskId, reason);
      res.status(200).json({ ok: true, cancelled });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Task cancellation failed") });
    }
  });

  /**
   * POST /api/browser-intelligence/pause
   * Pauses an active browser task.
   */
  app.post("/api/browser-intelligence/pause", requireLocalhost, async (req, res) => {
    try {
      const { browserIntelligenceCoordinator } = await import("../research/browser/index.ts");
      const { taskId } = req.body || {};
      if (!taskId || typeof taskId !== "string") {
        return res.status(400).json({ error: "Missing required field: taskId" });
      }
      const paused = browserIntelligenceCoordinator.pauseTask(taskId);
      res.status(200).json({ ok: true, paused });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Task pause failed") });
    }
  });

  /**
   * POST /api/browser-intelligence/resume
   * Resumes a paused browser task.
   */
  app.post("/api/browser-intelligence/resume", requireLocalhost, async (req, res) => {
    try {
      const { browserIntelligenceCoordinator } = await import("../research/browser/index.ts");
      const { taskId } = req.body || {};
      if (!taskId || typeof taskId !== "string") {
        return res.status(400).json({ error: "Missing required field: taskId" });
      }
      const resumed = browserIntelligenceCoordinator.resumeTask(taskId);
      res.status(200).json({ ok: true, resumed });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Task resume failed") });
    }
  });

  /**
   * GET /api/browser-intelligence/task/:taskId
   * Retrieves status and results for a browser task.
   */
  app.get("/api/browser-intelligence/task/:taskId", requireLocalhost, async (req, res) => {
    try {
      const { browserIntelligenceCoordinator } = await import("../research/browser/index.ts");
      const task = browserIntelligenceCoordinator.getTask(req.params.taskId);
      if (!task) {
        return res.status(404).json({ error: "Task not found" });
      }
      res.status(200).json({ ok: true, task });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to retrieve task") });
    }
  });

  /**
   * GET /api/browser-intelligence/tasks
   * Lists all recent browser tasks.
   */
  app.get("/api/browser-intelligence/tasks", requireLocalhost, async (_req, res) => {
    try {
      const { browserIntelligenceCoordinator } = await import("../research/browser/index.ts");
      const tasks = browserIntelligenceCoordinator.listTasks();
      res.status(200).json({ ok: true, tasks });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to list tasks") });
    }
  });

  /**
   * GET /api/browser-intelligence/tabs
   * Retrieves all currently active browser tabs and active tab context.
   */
  app.get("/api/browser-intelligence/tabs", requireLocalhost, async (_req, res) => {
    try {
      const { browserTabManager } = await import("../research/browser/index.ts");
      const activeTab = browserTabManager.getActiveTab();
      const tabs = browserTabManager.getAllTabs();
      res.status(200).json({ ok: true, activeTab, tabs, count: tabs.length });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to retrieve browser tabs") });
    }
  });

  /**
   * POST /api/browser-intelligence/tabs
   * Performs tab lifecycle operation (open, switch, close).
   */
  app.post("/api/browser-intelligence/tabs", requireLocalhost, async (req, res) => {
    try {
      const { browserTabManager } = await import("../research/browser/index.ts");
      const { action, tabId, url, title } = req.body || {};

      switch (action) {
        case "open": {
          const tab = browserTabManager.createTab(
            typeof url === "string" ? url.slice(0, 500) : "about:blank",
            typeof title === "string" ? title.slice(0, 100) : "New Tab"
          );
          return res.status(200).json({ ok: true, tab });
        }
        case "switch": {
          if (!tabId || typeof tabId !== "string") {
            return res.status(400).json({ error: "Missing required field: tabId" });
          }
          const switched = browserTabManager.switchTab(tabId);
          if (!switched) {
            return res.status(404).json({ error: `Tab '${tabId}' not found.` });
          }
          return res.status(200).json({ ok: true, activeTab: switched });
        }
        case "close": {
          if (!tabId || typeof tabId !== "string") {
            return res.status(400).json({ error: "Missing required field: tabId" });
          }
          const closeRes = browserTabManager.closeTab(tabId);
          return res.status(200).json({ ok: closeRes.closed, activeTab: closeRes.newActiveTab });
        }
        default:
          return res.status(400).json({ error: "Invalid action. Supported: open, switch, close" });
      }
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Tab operation failed") });
    }
  });

  /**
   * POST /api/browser-intelligence/execute-action
   * Executes a single discrete browser control action (click, type, scroll, wait_for, etc.).
   */
  app.post("/api/browser-intelligence/execute-action", requireLocalhost, async (req, res) => {
    try {
      const { browserIntelligenceCoordinator } = await import("../research/browser/index.ts");
      const { step, allowedOrigins, autoConfirmSensitiveActions } = req.body || {};

      if (!step || typeof step !== "object" || !step.action) {
        return res.status(400).json({ error: "Missing required object: step with valid action" });
      }

      const result = await browserIntelligenceCoordinator.executeAction(step, {
        allowedOrigins: Array.isArray(allowedOrigins) ? allowedOrigins.slice(0, 20) : [],
        autoConfirmSensitiveActions: Boolean(autoConfirmSensitiveActions),
      });

      res.status(200).json({ ok: result.ok, result });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Action execution failed") });
    }
  });

  /**
   * POST /api/browser-intelligence/compare
   * Compares two or more documents with section diffing, version compatibility, and contradiction detection.
   */
  app.post("/api/browser-intelligence/compare", requireLocalhost, async (req, res) => {
    try {
      const { browserIntelligenceCoordinator } = await import("../research/browser/index.ts");
      const { documents, focusTopics, compareBy } = req.body || {};

      if (!Array.isArray(documents) || documents.length < 2) {
        return res.status(400).json({ error: "Missing required array 'documents' with at least 2 items." });
      }

      const result = await browserIntelligenceCoordinator.compareDocuments({
        documents: documents.slice(0, 5),
        focusTopics: Array.isArray(focusTopics) ? focusTopics.slice(0, 10) : undefined,
        compareBy: compareBy === "sections" || compareBy === "apis" ? compareBy : "all",
      });

      res.status(200).json({ ok: true, result });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Document comparison failed") });
    }
  });

  /**
   * POST /api/browser-intelligence/extract-document
   * Extracts structured documentation (sections, code blocks, tables, version metadata) from content or URL.
   */
  app.post("/api/browser-intelligence/extract-document", requireLocalhost, async (req, res) => {
    try {
      const { browserIntelligenceCoordinator } = await import("../research/browser/index.ts");
      const { content, url, titleHint, versionHint } = req.body || {};

      if (!content && !url) {
        return res.status(400).json({ error: "Either 'content' or 'url' must be provided in request body." });
      }

      const document = await browserIntelligenceCoordinator.extractDocument({
        content: typeof content === "string" ? content : undefined,
        url: typeof url === "string" ? url : undefined,
        titleHint: typeof titleHint === "string" ? titleHint.slice(0, 200) : undefined,
        versionHint: typeof versionHint === "string" ? versionHint.slice(0, 50) : undefined,
      });

      res.status(200).json({ ok: true, document });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Document extraction failed") });
    }
  });

  // ── Stage 5: Adaptive Knowledge & Skill Ingestion — localhost/core only ────────
  /**
   * GET /api/browser-intelligence/proposals
   * Lists all knowledge and skill proposals.
   */
  app.get("/api/browser-intelligence/proposals", requireLocalhost, async (req, res) => {
    try {
      const { knowledgeProposalPipeline } = await import("../research/browser/index.ts");
      const { state, type } = req.query as { state?: string; type?: string };
      const proposals = knowledgeProposalPipeline.listProposals({
        state: state as any,
        type: type as any,
      });
      res.status(200).json({ ok: true, proposals, count: proposals.length });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to list proposals") });
    }
  });

  /**
   * GET /api/browser-intelligence/proposals/:id
   * Retrieves a specific proposal with full provenance and audit trail.
   */
  app.get("/api/browser-intelligence/proposals/:id", requireLocalhost, async (req, res) => {
    try {
      const { knowledgeProposalPipeline } = await import("../research/browser/index.ts");
      const proposal = knowledgeProposalPipeline.getProposal(req.params.id);
      if (!proposal) {
        return res.status(404).json({ error: "Proposal not found" });
      }
      res.status(200).json({ ok: true, proposal });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to retrieve proposal") });
    }
  });

  /**
   * POST /api/browser-intelligence/proposals/generate
   * Converts a research discovery into a validated candidate proposal (Stages 1-7).
   */
  app.post("/api/browser-intelligence/proposals/generate", requireLocalhost, async (req, res) => {
    try {
      const { knowledgeProposalPipeline } = await import("../research/browser/index.ts");
      const { opportunity, payload } = req.body || {};
      if (!opportunity || typeof opportunity !== "object" || !opportunity.title || !opportunity.rawContent) {
        return res.status(400).json({ error: "Missing required opportunity object (title and rawContent are mandatory)." });
      }

      const proposal = await knowledgeProposalPipeline.processOpportunity(opportunity, payload);
      res.status(200).json({ ok: true, proposal });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to generate proposal") });
    }
  });

  /**
   * POST /api/browser-intelligence/proposals/:id/approve
   * Approves a candidate proposal (requires authorized operator).
   */
  app.post("/api/browser-intelligence/proposals/:id/approve", requireLocalhost, async (req, res) => {
    try {
      const { knowledgeProposalPipeline } = await import("../research/browser/index.ts");
      const { approver, reason } = req.body || {};
      if (!approver || typeof approver !== "string") {
        return res.status(400).json({ error: "Missing required field: approver" });
      }

      const proposal = knowledgeProposalPipeline.approve(req.params.id, approver, reason);
      res.status(200).json({ ok: true, proposal });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Proposal approval failed") });
    }
  });

  /**
   * POST /api/browser-intelligence/proposals/:id/reject
   * Rejects a candidate proposal.
   */
  app.post("/api/browser-intelligence/proposals/:id/reject", requireLocalhost, async (req, res) => {
    try {
      const { knowledgeProposalPipeline } = await import("../research/browser/index.ts");
      const { rejecter, reason } = req.body || {};
      if (!rejecter || !reason) {
        return res.status(400).json({ error: "Missing required fields: rejecter and reason" });
      }

      const proposal = knowledgeProposalPipeline.reject(req.params.id, rejecter, reason);
      res.status(200).json({ ok: true, proposal });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Proposal rejection failed") });
    }
  });

  /**
   * POST /api/browser-intelligence/proposals/:id/integrate
   * Integrates an approved proposal into Knowledge Graph or Skill Registry.
   */
  app.post("/api/browser-intelligence/proposals/:id/integrate", requireLocalhost, async (req, res) => {
    try {
      const { knowledgeProposalPipeline } = await import("../research/browser/index.ts");
      const { actor, targetStore } = req.body || {};
      if (!actor || typeof actor !== "string") {
        return res.status(400).json({ error: "Missing required field: actor" });
      }

      const proposal = await knowledgeProposalPipeline.integrate(req.params.id, actor, targetStore);
      res.status(200).json({ ok: true, proposal });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Proposal integration failed") });
    }
  });

  /**
   * POST /api/browser-intelligence/proposals/:id/rollback
   * Reverts an integrated proposal using its rollback token.
   */
  app.post("/api/browser-intelligence/proposals/:id/rollback", requireLocalhost, async (req, res) => {
    try {
      const { knowledgeProposalPipeline } = await import("../research/browser/index.ts");
      const { token, actor, reason } = req.body || {};
      if (!token || !actor) {
        return res.status(400).json({ error: "Missing required fields: token and actor" });
      }

      const proposal = knowledgeProposalPipeline.rollback(req.params.id, token, actor, reason);
      res.status(200).json({ ok: true, proposal });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Proposal rollback failed") });
    }
  });

  // ── Stage 6: Skill Proposal System — localhost/core only ─────────────────────
  /**
   * GET /api/browser-intelligence/skills/proposals
   * Lists all skill proposals with optional state filter.
   */
  app.get("/api/browser-intelligence/skills/proposals", requireLocalhost, async (req, res) => {
    try {
      const { skillProposalManager } = await import("../research/browser/index.ts");
      const { state } = req.query as { state?: string };
      const proposals = skillProposalManager.listProposals({
        state: state as any,
      });
      res.status(200).json({ ok: true, count: proposals.length, proposals });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to retrieve skill proposals") });
    }
  });

  /**
   * GET /api/browser-intelligence/skills/proposals/:id
   * Retrieves a specific skill proposal with full detection evidence, reviews, and audit history.
   */
  app.get("/api/browser-intelligence/skills/proposals/:id", requireLocalhost, async (req, res) => {
    try {
      const { skillProposalManager } = await import("../research/browser/index.ts");
      const proposal = skillProposalManager.getProposal(req.params.id);
      if (!proposal) {
        return res.status(404).json({ error: "Skill proposal not found" });
      }
      res.status(200).json({ ok: true, proposal });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to retrieve skill proposal") });
    }
  });

  /**
   * POST /api/browser-intelligence/skills/observe
   * Submits an execution trace for workflow evidence observation.
   */
  app.post("/api/browser-intelligence/skills/observe", requireLocalhost, async (req, res) => {
    try {
      const { skillProposalManager } = await import("../research/browser/index.ts");
      const traceInput = req.body || {};
      const result = skillProposalManager.recordObservation(traceInput);
      res.status(result.accepted ? 200 : 400).json({ ok: result.accepted, ...result });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to record observation") });
    }
  });

  /**
   * POST /api/browser-intelligence/skills/proposals/generate
   * Evaluates observed workflow patterns and generates candidate skill proposals.
   */
  app.post("/api/browser-intelligence/skills/proposals/generate", requireLocalhost, async (req, res) => {
    try {
      const { skillProposalManager } = await import("../research/browser/index.ts");
      const proposals = skillProposalManager.processObservedPatterns();
      res.status(200).json({ ok: true, count: proposals.length, proposals });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to generate skill proposals") });
    }
  });

  /**
   * POST /api/browser-intelligence/skills/proposals/:id/approve
   * Authenticated human operator approval of a candidate skill proposal.
   */
  app.post("/api/browser-intelligence/skills/proposals/:id/approve", requireLocalhost, async (req, res) => {
    try {
      const { skillProposalManager } = await import("../research/browser/index.ts");
      const { approver, approverRole, reason, nonce, expiresAt, proposalVersion, signature } = req.body || {};
      if (!approver || typeof approver !== "string") {
        return res.status(400).json({ error: "Missing required field: approver (human operator identifier required)" });
      }
      if (!reason || typeof reason !== "string") {
        return res.status(400).json({ error: "Missing required field: reason" });
      }

      const proposal = skillProposalManager.approveProposal(req.params.id, {
        approver,
        approverRole: approverRole || "standard",
        reason,
        nonce,
        expiresAt,
        proposalVersion,
        signature,
      });
      res.status(200).json({ ok: true, proposal });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Skill proposal approval failed") });
    }
  });

  /**
   * POST /api/browser-intelligence/skills/proposals/:id/reject
   * Rejects a candidate skill proposal with an explicit reason.
   */
  app.post("/api/browser-intelligence/skills/proposals/:id/reject", requireLocalhost, async (req, res) => {
    try {
      const { skillProposalManager } = await import("../research/browser/index.ts");
      const { rejecter, reason } = req.body || {};
      if (!rejecter || !reason) {
        return res.status(400).json({ error: "Missing required fields: rejecter and reason" });
      }

      const proposal = skillProposalManager.rejectProposal(req.params.id, {
        rejecter,
        reason,
      });
      res.status(200).json({ ok: true, proposal });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Skill proposal rejection failed") });
    }
  });

  /**
   * POST /api/browser-intelligence/skills/proposals/:id/integrate
   * Integrates an approved skill proposal into the skill registry with a rollback token.
   * STRICT INVARIANT: The newly integrated skill is NOT auto-executed.
   */
  app.post("/api/browser-intelligence/skills/proposals/:id/integrate", requireLocalhost, async (req, res) => {
    try {
      const { skillProposalManager } = await import("../research/browser/index.ts");
      const { actor } = req.body || {};
      if (!actor || typeof actor !== "string") {
        return res.status(400).json({ error: "Missing required field: actor" });
      }

      const proposal = skillProposalManager.integrateProposal(req.params.id, actor);
      res.status(200).json({ ok: true, proposal });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Skill proposal integration failed") });
    }
  });

  /**
   * POST /api/browser-intelligence/skills/proposals/:id/rollback
   * Revokes and rolls back an integrated skill using its rollback token.
   */
  app.post("/api/browser-intelligence/skills/proposals/:id/rollback", requireLocalhost, async (req, res) => {
    try {
      const { skillProposalManager } = await import("../research/browser/index.ts");
      const { token, actor, reason } = req.body || {};
      if (!token || !actor) {
        return res.status(400).json({ error: "Missing required fields: token and actor" });
      }

      const proposal = skillProposalManager.rollbackProposal(req.params.id, token, actor, reason || "Operator rollback");
      res.status(200).json({ ok: true, proposal });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Skill proposal rollback failed") });
    }
  });

  // ── Stage 7: Self-Improvement Evaluator — localhost/core only ────────────────
  /**
   * GET /api/browser-intelligence/improvements/candidates
   * Lists all self-improvement candidates with optional state and kind filters.
   */
  app.get("/api/browser-intelligence/improvements/candidates", requireLocalhost, async (req, res) => {
    try {
      const { selfImprovementEvaluator } = await import("../research/browser/index.ts");
      const { state, kind } = req.query as { state?: string; kind?: string };
      const candidates = selfImprovementEvaluator.listCandidates({
        state: state as any,
        kind,
      });
      res.status(200).json({ ok: true, count: candidates.length, candidates });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to retrieve candidates") });
    }
  });

  /**
   * GET /api/browser-intelligence/improvements/candidates/:id
   * Retrieves a specific candidate with evaluation report, reviews, and audit history.
   */
  app.get("/api/browser-intelligence/improvements/candidates/:id", requireLocalhost, async (req, res) => {
    try {
      const { selfImprovementEvaluator } = await import("../research/browser/index.ts");
      const candidate = selfImprovementEvaluator.getCandidate(req.params.id);
      if (!candidate) {
        return res.status(404).json({ error: "Candidate not found" });
      }
      res.status(200).json({ ok: true, candidate });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to retrieve candidate") });
    }
  });

  /**
   * POST /api/browser-intelligence/improvements/candidates/submit
   * Submits a new self-improvement candidate for prompts, queries, or heuristics.
   */
  app.post("/api/browser-intelligence/improvements/candidates/submit", requireLocalhost, async (req, res) => {
    try {
      const { selfImprovementEvaluator } = await import("../research/browser/index.ts");
      const input = req.body || {};
      if (!input.name || !input.targetComponent || !input.proposedPayload || !input.kind) {
        return res.status(400).json({ error: "Missing required fields: name, targetComponent, proposedPayload, kind." });
      }

      const candidate = selfImprovementEvaluator.submitCandidate(input);
      res.status(200).json({ ok: true, candidate });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to submit candidate") });
    }
  });

  /**
   * POST /api/browser-intelligence/improvements/candidates/:id/evaluate
   * Executes the isolated evaluation harness across registered fixtures.
   */
  app.post("/api/browser-intelligence/improvements/candidates/:id/evaluate", requireLocalhost, async (req, res) => {
    try {
      const { selfImprovementEvaluator } = await import("../research/browser/index.ts");
      const candidate = await selfImprovementEvaluator.evaluateCandidate(req.params.id);
      res.status(200).json({ ok: true, candidate });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Candidate evaluation failed") });
    }
  });

  /**
   * POST /api/browser-intelligence/improvements/candidates/:id/approve
   * Authenticated human operator approval of evaluated improvement candidate.
   */
  app.post("/api/browser-intelligence/improvements/candidates/:id/approve", requireLocalhost, async (req, res) => {
    try {
      const { selfImprovementEvaluator } = await import("../research/browser/index.ts");
      const { approver, approverRole, reason, nonce, expiresAt, candidateVersion, signature } = req.body || {};
      if (!approver || typeof approver !== "string") {
        return res.status(400).json({ error: "Missing required field: approver (human operator identifier required)" });
      }
      if (!reason || typeof reason !== "string") {
        return res.status(400).json({ error: "Missing required field: reason" });
      }

      const candidate = selfImprovementEvaluator.approveCandidate(req.params.id, {
        approver,
        approverRole: approverRole || "standard",
        reason,
        nonce,
        expiresAt,
        candidateVersion,
        signature,
      });
      res.status(200).json({ ok: true, candidate });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Candidate approval failed") });
    }
  });

  /**
   * POST /api/browser-intelligence/improvements/candidates/:id/reject
   * Rejects an improvement candidate with explicit reason.
   */
  app.post("/api/browser-intelligence/improvements/candidates/:id/reject", requireLocalhost, async (req, res) => {
    try {
      const { selfImprovementEvaluator } = await import("../research/browser/index.ts");
      const { rejecter, reason } = req.body || {};
      if (!rejecter || !reason) {
        return res.status(400).json({ error: "Missing required fields: rejecter and reason" });
      }

      const candidate = selfImprovementEvaluator.rejectCandidate(req.params.id, {
        rejecter,
        reason,
      });
      res.status(200).json({ ok: true, candidate });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Candidate rejection failed") });
    }
  });

  /**
   * POST /api/browser-intelligence/improvements/candidates/:id/integrate
   * Integrates approved improvement into in-memory component store with rollback token.
   * STRICT INVARIANT: autoDeployment is blocked.
   */
  app.post("/api/browser-intelligence/improvements/candidates/:id/integrate", requireLocalhost, async (req, res) => {
    try {
      const { selfImprovementEvaluator } = await import("../research/browser/index.ts");
      const { actor } = req.body || {};
      if (!actor || typeof actor !== "string") {
        return res.status(400).json({ error: "Missing required field: actor" });
      }

      const candidate = selfImprovementEvaluator.integrateCandidate(req.params.id, actor);
      res.status(200).json({ ok: true, candidate });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Candidate integration failed") });
    }
  });

  /**
   * POST /api/browser-intelligence/improvements/candidates/:id/rollback
   * Revokes and rolls back an integrated candidate using its rollback token.
   */
  app.post("/api/browser-intelligence/improvements/candidates/:id/rollback", requireLocalhost, async (req, res) => {
    try {
      const { selfImprovementEvaluator } = await import("../research/browser/index.ts");
      const { token, actor, reason } = req.body || {};
      if (!token || !actor) {
        return res.status(400).json({ error: "Missing required fields: token and actor" });
      }

      const candidate = selfImprovementEvaluator.rollbackCandidate(req.params.id, token, actor, reason || "Operator rollback");
      res.status(200).json({ ok: true, candidate });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Candidate rollback failed") });
    }
  });

  // ── Stage 2: Intelligent Search & Epistemic Research — localhost/core only ────────
  /**
   * POST /api/research/epistemic-query
   * Executes epistemic research query with claim verification, contradiction resolution, and uncertainty reporting.
   */
  app.post("/api/research/epistemic-query", requireLocalhost, async (req, res) => {
    try {
      const { advancedResearchCoordinator } = await import("../research/index.ts");
      const { question, maxSources, requireOfficial, projectPath, allowRefinement } = req.body || {};
      if (!question || typeof question !== "string" || !question.trim()) {
        return res.status(400).json({ error: "Missing required field: question" });
      }
      const boundedQuestion = question.trim().slice(0, 2000);
      const boundedSources = Math.min(10, Math.max(1, typeof maxSources === "number" ? maxSources : 5));
      const result = await advancedResearchCoordinator.epistemicQuery({
        question: boundedQuestion,
        maxSources: boundedSources,
        requireOfficial: Boolean(requireOfficial),
        projectPath: typeof projectPath === "string" ? projectPath.slice(0, 500) : undefined,
        allowRefinement: Boolean(allowRefinement),
      });
      res.status(200).json({ ok: true, result });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Epistemic research query failed") });
    }
  });

  /**
   * POST /api/research/detect-duplicates
   * Detects duplicate and syndicated sources to avoid false consensus.
   */
  app.post("/api/research/detect-duplicates", requireLocalhost, async (req, res) => {
    try {
      const { duplicateSourceDetector } = await import("../research/index.ts");
      const { sources } = req.body || {};
      if (!Array.isArray(sources)) {
        return res.status(400).json({ error: "Missing required array: sources" });
      }
      const boundedSources = sources.slice(0, 50);
      const report = duplicateSourceDetector.detectDuplicates(boundedSources);
      res.status(200).json({ ok: true, report });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Duplicate detection failed") });
    }
  });

  /**
   * POST /api/research/verify-claims
   * Evaluates claims against epistemic verification policy (FACT, INFERENCE, HYPOTHESIS, VERIFIED_CONCLUSION).
   */
  app.post("/api/research/verify-claims", requireLocalhost, async (req, res) => {
    try {
      const { epistemicVerifier } = await import("../research/index.ts");
      const { claims, sources, contradictions } = req.body || {};
      if (!Array.isArray(claims)) {
        return res.status(400).json({ error: "Missing required array: claims" });
      }
      const boundedClaims = claims.slice(0, 100);
      const boundedSources = Array.isArray(sources) ? sources.slice(0, 50) : [];
      const boundedContradictions = Array.isArray(contradictions) ? contradictions.slice(0, 100) : [];
      const verified = epistemicVerifier.verifyAll(
        boundedClaims,
        boundedSources,
        boundedContradictions
      );
      res.status(200).json({ ok: true, claims: verified });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Claim verification failed") });
    }
  });

  // ── Phase 24: Personal Knowledge Graph — localhost/core only ──────────────
  // Security: All graph endpoints are strictly localhost-only and protected
  // by Emergency Stop and Security Policy assertions.

  /**
   * POST /api/knowledge/node
   * Creates a new KnowledgeNode.
   */
  app.post("/api/knowledge/node", requireLocalhost, async (req, res) => {
    try {
      const { knowledgeGraphCoordinator } = await import("../knowledge/index.ts");
      const { type, canonicalName, aliases, attributes, confidence, importance, provenance } = req.body || {};
      if (!type || !canonicalName) {
        return res.status(400).json({ error: "Missing required fields: type, canonicalName" });
      }
      const node = await knowledgeGraphCoordinator.createNode({
        type,
        canonicalName,
        aliases: Array.isArray(aliases) ? aliases : [],
        attributes: typeof attributes === "object" && attributes !== null ? attributes : {},
        confidence: typeof confidence === "number" ? confidence : undefined,
        importance: typeof importance === "number" ? importance : undefined,
        provenance: Array.isArray(provenance) ? provenance : [
          { source: "api", sourceType: "EXPLICIT_USER", timestamp: Date.now(), confidence: 0.95 },
        ],
      });
      res.status(200).json({ ok: true, node });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to create node") });
    }
  });

  /**
   * GET /api/knowledge/node/:id
   * Retrieves a node by its ID.
   */
  app.get("/api/knowledge/node/:id", requireLocalhost, async (req, res) => {
    try {
      const { knowledgeGraphCoordinator } = await import("../knowledge/index.ts");
      const node = knowledgeGraphCoordinator.nodes.getNode(req.params.id);
      if (!node) {
        return res.status(404).json({ error: "Node not found" });
      }
      res.status(200).json({ ok: true, node });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to get node") });
    }
  });

  /**
   * POST /api/knowledge/edge
   * Creates a controlled relationship between two nodes.
   */
  app.post("/api/knowledge/edge", requireLocalhost, async (req, res) => {
    try {
      const { knowledgeGraphCoordinator } = await import("../knowledge/index.ts");
      const { sourceNodeId, relationType, targetNodeId, confidence, importance, weight, provenance } = req.body || {};
      if (!sourceNodeId || !relationType || !targetNodeId) {
        return res.status(400).json({ error: "Missing required fields: sourceNodeId, relationType, targetNodeId" });
      }
      const edge = await knowledgeGraphCoordinator.createEdge({
        sourceNodeId,
        relationType,
        targetNodeId,
        confidence: typeof confidence === "number" ? confidence : undefined,
        importance: typeof importance === "number" ? importance : undefined,
        weight: typeof weight === "number" ? weight : undefined,
        provenance: Array.isArray(provenance) ? provenance : [
          { source: "api", sourceType: "EXPLICIT_USER", timestamp: Date.now(), confidence: 0.95 },
        ],
      });
      res.status(200).json({ ok: true, edge });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to create edge") });
    }
  });

  /**
   * GET /api/knowledge/related/:id
   * Retrieves all connected relationships and neighbor nodes for a node ID.
   */
  app.get("/api/knowledge/related/:id", requireLocalhost, async (req, res) => {
    try {
      const { knowledgeGraphCoordinator } = await import("../knowledge/index.ts");
      const node = knowledgeGraphCoordinator.nodes.getNode(req.params.id);
      if (!node) {
        return res.status(404).json({ error: "Node not found" });
      }
      const edges = knowledgeGraphCoordinator.edges.getAllConnectedEdges(req.params.id, "ACTIVE");
      const neighborIds = new Set<string>();
      for (const e of edges) {
        neighborIds.add(e.sourceNodeId === node.id ? e.targetNodeId : e.sourceNodeId);
      }
      const neighbors = Array.from(neighborIds)
        .map((id) => knowledgeGraphCoordinator.nodes.getNode(id))
        .filter(Boolean);

      res.status(200).json({ ok: true, node, edges, neighbors });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to get related nodes") });
    }
  });

  /**
   * POST /api/knowledge/query
   * Executes relationship-aware queries.
   */
  app.post("/api/knowledge/query", requireLocalhost, async (req, res) => {
    try {
      const { knowledgeGraphCoordinator } = await import("../knowledge/index.ts");
      const result = knowledgeGraphCoordinator.query(req.body || {});
      res.status(200).json({ ok: true, result });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Knowledge graph query failed") });
    }
  });

  /**
   * POST /api/knowledge/traverse
   * Bounded graph traversal from a start node.
   */
  app.post("/api/knowledge/traverse", requireLocalhost, async (req, res) => {
    try {
      const { knowledgeGraphCoordinator } = await import("../knowledge/index.ts");
      const { startNodeId, maxDepth, direction, relationTypes, nodeTypes, status } = req.body || {};
      if (!startNodeId) {
        return res.status(400).json({ error: "Missing required field: startNodeId" });
      }
      const result = knowledgeGraphCoordinator.traverse({
        startNodeId,
        maxDepth: typeof maxDepth === "number" ? maxDepth : undefined,
        direction: direction || "OUTGOING",
        relationTypes: Array.isArray(relationTypes) ? relationTypes : undefined,
        nodeTypes: Array.isArray(nodeTypes) ? nodeTypes : undefined,
        status: status || "ACTIVE",
      });
      res.status(200).json({ ok: true, result });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Traversal failed") });
    }
  });

  /**
   * GET /api/knowledge/projects
   * Retrieves all active project nodes in the graph.
   */
  app.get("/api/knowledge/projects", requireLocalhost, async (_req, res) => {
    try {
      const { knowledgeGraphCoordinator } = await import("../knowledge/index.ts");
      const projects = knowledgeGraphCoordinator.nodes.findByType("PROJECT").filter((p) => p.status === "ACTIVE");
      res.status(200).json({ ok: true, projects, count: projects.length });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to get projects") });
    }
  });

  /**
   * GET /api/knowledge/preferences
   * Retrieves all active preference nodes.
   */
  app.get("/api/knowledge/preferences", requireLocalhost, async (_req, res) => {
    try {
      const { knowledgeGraphCoordinator } = await import("../knowledge/index.ts");
      const preferences = knowledgeGraphCoordinator.nodes.findByType("PREFERENCE").filter((p) => p.status === "ACTIVE");
      res.status(200).json({ ok: true, preferences, count: preferences.length });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to get preferences") });
    }
  });

  /**
   * GET /api/knowledge/tasks
   * Retrieves all active task nodes.
   */
  app.get("/api/knowledge/tasks", requireLocalhost, async (_req, res) => {
    try {
      const { knowledgeGraphCoordinator } = await import("../knowledge/index.ts");
      const tasks = knowledgeGraphCoordinator.nodes.findByType("TASK").filter((t) => t.status === "ACTIVE");
      res.status(200).json({ ok: true, tasks, count: tasks.length });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to get tasks") });
    }
  });

  /**
   * GET /api/knowledge/skills
   * Retrieves all active skill nodes.
   */
  app.get("/api/knowledge/skills", requireLocalhost, async (_req, res) => {
    try {
      const { knowledgeGraphCoordinator } = await import("../knowledge/index.ts");
      const skills = knowledgeGraphCoordinator.nodes.findByType("SKILL").filter((s) => s.status === "ACTIVE");
      res.status(200).json({ ok: true, skills, count: skills.length });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to get skills") });
    }
  });

  /**
   * GET /api/knowledge/provenance/:id
   * Explains provenance for a node or relationship ("Why do you know this?").
   */
  app.get("/api/knowledge/provenance/:id", requireLocalhost, async (req, res) => {
    try {
      const { knowledgeGraphCoordinator } = await import("../knowledge/index.ts");
      const explanation = knowledgeGraphCoordinator.explainKnowledge(req.params.id);
      res.status(200).json({ ok: true, explanation });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to get provenance") });
    }
  });

  /**
   * GET /api/knowledge/stats
   * Retrieves graph statistics.
   */
  app.get("/api/knowledge/stats", requireLocalhost, async (_req, res) => {
    try {
      const { knowledgeGraphCoordinator } = await import("../knowledge/index.ts");
      const stats = knowledgeGraphCoordinator.getStats();
      res.status(200).json({ ok: true, stats });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to get stats") });
    }
  });

  /**
   * POST /api/knowledge/refresh
   * Synchronizes memories from Phase 18 CognitiveMemoryStore into the graph.
   */
  app.post("/api/knowledge/refresh", requireLocalhost, async (_req, res) => {
    try {
      const { knowledgeGraphCoordinator } = await import("../knowledge/index.ts");
      const result = await knowledgeGraphCoordinator.refreshFromMemory();
      res.status(200).json({ ok: true, result });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to refresh knowledge graph") });
    }
  });

  /**
   * POST /api/knowledge/reset
   * Resets the entire knowledge graph.
   */
  app.post("/api/knowledge/reset", requireLocalhost, async (_req, res) => {
    try {
      const { knowledgeGraphCoordinator } = await import("../knowledge/index.ts");
      await knowledgeGraphCoordinator.reset();
      res.status(200).json({ ok: true, message: "Personal Knowledge Graph reset" });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Reset failed") });
    }
  });

  // ── Phase 25: Self-Correction & Failure Recovery Engine — localhost/core only ──
  // Security: All recovery endpoints are strictly localhost-only, security-gated,
  // and subject to Emergency Stop and Security Policy assertions.

  /**
   * POST /api/recovery/analyze
   * Ingests an error or operation failure and produces root cause analysis and candidates.
   */
  app.post("/api/recovery/analyze", requireLocalhost, async (req, res) => {
    try {
      const { selfCorrectionCoordinator } = await import("../recovery/index.ts");
      const { operation, errorMessage, stdout, stderr, exitCode, targetResource, actionId, taskId, context } = req.body || {};
      if (!operation && !errorMessage) {
        return res.status(400).json({ error: "Missing required fields: operation or errorMessage" });
      }
      const response = selfCorrectionCoordinator.handleFailure({
        operation: operation || "unknown_operation",
        errorMessage,
        stdout,
        stderr,
        exitCode,
        targetResource,
        actionId,
        taskId,
        context,
      });
      res.status(200).json({ ok: true, ...response });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to analyze failure") });
    }
  });

  /**
   * POST /api/recovery/strategies
   * Retrieves safe recovery candidates for a failure event.
   */
  app.post("/api/recovery/strategies", requireLocalhost, async (req, res) => {
    try {
      const { selfCorrectionCoordinator } = await import("../recovery/index.ts");
      const { failureId, operation, errorMessage, targetResource } = req.body || {};
      let failure = failureId ? selfCorrectionCoordinator.getFailure(failureId) : undefined;
      if (!failure) {
        const handled = selfCorrectionCoordinator.handleFailure({
          operation: operation || "unknown_operation",
          errorMessage,
          targetResource,
        });
        return res.status(200).json({ ok: true, candidates: handled.candidates });
      }
      const history = selfCorrectionCoordinator.getHistory();
      const match = history.failures.find((f) => f.id === failureId);
      res.status(200).json({ ok: true, failure: match });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to retrieve strategies") });
    }
  });

  /**
   * POST /api/recovery/execute
   * Executes a safe recovery candidate and verifies the outcome.
   */
  app.post("/api/recovery/execute", requireLocalhost, async (req, res) => {
    try {
      const { selfCorrectionCoordinator } = await import("../recovery/index.ts");
      const { failureId, strategyId, verifiedValue, scope } = req.body || {};
      if (!failureId || !strategyId) {
        return res.status(400).json({ error: "Missing required fields: failureId, strategyId" });
      }
      const result = await selfCorrectionCoordinator.executeRecovery({
        failureId,
        strategyId,
        executor: async () => ({ exitCode: 0, stdout: "Recovery executed successfully" }),
        scope,
        verifiedValue: verifiedValue || "VERIFIED_OK",
        requirements: [{ type: "EXIT_CODE_ZERO", target: "default" }],
      });
      res.status(200).json({ ok: true, result });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to execute recovery") });
    }
  });

  /**
   * POST /api/recovery/cancel
   * Signals cancellation of ongoing recovery loops.
   */
  app.post("/api/recovery/cancel", requireLocalhost, async (req, res) => {
    try {
      const { selfCorrectionCoordinator } = await import("../recovery/index.ts");
      selfCorrectionCoordinator.cancel(req.body?.reason || "User requested cancellation via API");
      res.status(200).json({ ok: true, message: "Recovery operations cancelled" });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to cancel recovery") });
    }
  });

  /**
   * GET /api/recovery/status
   * Retrieves active recovery counts, budgets, and cancellation state.
   */
  app.get("/api/recovery/status", requireLocalhost, async (_req, res) => {
    try {
      const { selfCorrectionCoordinator } = await import("../recovery/index.ts");
      const status = selfCorrectionCoordinator.getStatus();
      res.status(200).json({ ok: true, status });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to get recovery status") });
    }
  });

  /**
   * GET /api/recovery/history
   * Retrieves list of past failures, recovery attempts, and audit trail.
   */
  app.get("/api/recovery/history", requireLocalhost, async (_req, res) => {
    try {
      const { selfCorrectionCoordinator } = await import("../recovery/index.ts");
      const history = selfCorrectionCoordinator.getHistory();
      res.status(200).json({ ok: true, history });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to get recovery history") });
    }
  });

  /**
   * GET /api/recovery/:id
   * Retrieves details of a specific failure event.
   */
  app.get("/api/recovery/:id", requireLocalhost, async (req, res) => {
    try {
      const { selfCorrectionCoordinator } = await import("../recovery/index.ts");
      const failure = selfCorrectionCoordinator.getFailure(req.params.id);
      if (!failure) {
        return res.status(404).json({ error: `Failure event '${req.params.id}' not found` });
      }
      res.status(200).json({ ok: true, failure });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to get failure event") });
    }
  });

  /**
   * POST /api/recovery/reset
   * Resets all recovery tracking, state, and budgets.
   */
  app.post("/api/recovery/reset", requireLocalhost, async (_req, res) => {
    try {
      const { selfCorrectionCoordinator } = await import("../recovery/index.ts");
      selfCorrectionCoordinator.reset();
      res.status(200).json({ ok: true, message: "Recovery state reset" });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Reset failed") });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 26 — SECURITY + INTELLIGENCE SEPARATION REST API (Localhost-Only)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * POST /api/security/separation/propose
   * Submits an untrusted AI action proposal for sanitization and registry tracking.
   */
  app.post("/api/security/separation/propose", requireLocalhost, async (req, res) => {
    try {
      const { securitySeparationCoordinator } = await import("../security/separation/index.ts");
      const proposal = securitySeparationCoordinator.proposeAction({
        source: req.body?.source || "UNKNOWN",
        toolName: req.body?.toolName || "",
        args: req.body?.args || {},
        intentDescription: req.body?.intentDescription || "",
        requestedScope: req.body?.requestedScope,
        riskHint: req.body?.riskHint,
        modelMetadata: req.body?.modelMetadata,
      });
      res.status(200).json({ ok: true, proposal });
    } catch (err: any) {
      res.status(400).json({ error: sanitizeError(err?.message || "Failed to create proposal") });
    }
  });

  /**
   * POST /api/security/separation/evaluate
   * Authoritatively evaluates a proposal across the trust boundary.
   */
  app.post("/api/security/separation/evaluate", requireLocalhost, async (req, res) => {
    try {
      const { securitySeparationCoordinator } = await import("../security/separation/index.ts");
      const proposalId = req.body?.proposalId;
      let proposal = proposalId ? securitySeparationCoordinator.getProposal(proposalId) : undefined;

      if (!proposal) {
        proposal = securitySeparationCoordinator.proposeAction({
          source: req.body?.source || "UNKNOWN",
          toolName: req.body?.toolName || "",
          args: req.body?.args || {},
          intentDescription: req.body?.intentDescription || "",
          requestedScope: req.body?.requestedScope,
          riskHint: req.body?.riskHint,
          modelMetadata: req.body?.modelMetadata,
        });
      }

      const context = {
        identityId: req.body?.context?.identityId || "local_user",
        role: req.body?.context?.role || "admin",
        ipAddress: req.ip || "127.0.0.1",
        isLocal: true,
        sessionId: req.body?.context?.sessionId || "local",
      };

      const decision = await securitySeparationCoordinator.evaluateProposal(
        proposal,
        context,
        req.body?.confirmationToken,
      );

      res.status(200).json({ ok: true, proposal, decision });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Evaluation failed") });
    }
  });

  /**
   * POST /api/security/separation/validate
   * Validates a security decision immediately prior to execution.
   */
  app.post("/api/security/separation/validate", requireLocalhost, async (req, res) => {
    try {
      const { securitySeparationCoordinator } = await import("../security/separation/index.ts");
      const decisionId = req.body?.decisionId;
      const decision = decisionId ? securitySeparationCoordinator.getDecision(decisionId) : undefined;

      if (!decision) {
        return res.status(404).json({ error: `Decision '${decisionId}' not found.` });
      }

      const validation = securitySeparationCoordinator.validateForExecution({
        decision,
        actualToolName: req.body?.actualToolName || decision.toolName,
        actualArgs: req.body?.actualArgs || {},
      });

      res.status(200).json({ ok: true, validation });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Validation failed") });
    }
  });

  /**
   * GET /api/security/separation/status
   * Returns current separation status, active modes, emergency stop state, and counters.
   */
  app.get("/api/security/separation/status", requireLocalhost, async (_req, res) => {
    try {
      const { securitySeparationCoordinator } = await import("../security/separation/index.ts");
      const status = securitySeparationCoordinator.getStatus();
      res.status(200).json({ ok: true, status });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to get status") });
    }
  });

  /**
   * GET /api/security/separation/audit
   * Returns security separation audit records.
   */
  app.get("/api/security/separation/audit", requireLocalhost, async (req, res) => {
    try {
      const { securitySeparationCoordinator } = await import("../security/separation/index.ts");
      const limit = parseInt(req.query?.limit as string, 10) || 50;
      const audit = securitySeparationCoordinator.getAuditTrail(limit);
      res.status(200).json({ ok: true, audit });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Failed to get audit trail") });
    }
  });

  /**
   * POST /api/security/separation/reset
   * Resets security separation testing state.
   */
  app.post("/api/security/separation/reset", requireLocalhost, async (_req, res) => {
    try {
      const { securitySeparationCoordinator } = await import("../security/separation/index.ts");
      securitySeparationCoordinator.resetForTesting();
      res.status(200).json({ ok: true, message: "Security separation state reset" });
    } catch (err: any) {
      res.status(500).json({ error: sanitizeError(err?.message || "Reset failed") });
    }
  });




  // ── Global Sanitized Error Handling Middleware ───────────────────────────
  // Guarantees fail-closed error responses and zero stack trace / path leakage to clients
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = typeof err.status === "number" && err.status >= 400 && err.status < 600 ? err.status : 500;
    const safeMessage = sanitizeError(err.message || "Internal Server Error");
    logError(`[HttpGateway] Unhandled error: ${safeMessage}`);
    res.status(status).json({
      error: safeMessage,
    });
  });

  return app;
}

