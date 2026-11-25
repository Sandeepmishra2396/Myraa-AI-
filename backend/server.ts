/**
 * MYRAA — Entry Point (server.ts)
 *
 * Thin wiring layer. Responsibilities:
 *   1. Load .env + log key resolution
 *   2. Create Express app via HttpGateway
 *   3. Create http.Server + WebSocketServer
 *   4. Wire /live WebSocket to ConversationManager
 *   5. Wire loggers into TaskManager and GeminiSessionFactory
 *   6. Mount Vite (dev) or static dist (prod)
 *   7. Listen on port 3000
 *   8. Boot-probe the desktop agent
 *
 * No business logic lives here.
 */

import crypto from "crypto";
import http from "http";
import path from "path";
import fs from "fs";
import { WebSocketServer } from "ws";
import dotenv from "dotenv";

import { logKeyResolution } from "./server_paths.ts";
import {
  createHttpApp,
  logCommand,
  logStartup,
  logError,
  logJson,
  registerStepUpChallengeOwner,
} from "./gateway/HttpGateway.ts";
import { ConversationManager } from "./conversation/ConversationManager.ts";
import {
  initTaskManagerLoggers,
  ensureDesktopAgent,
} from "./tasks/TaskManager.ts";
import { initGeminiLoggers, prewarmInstructions } from "./ai/GeminiSessionFactory.ts";
import { companionCoordinator } from "./companion/CompanionCoordinator.ts";
import { companionPersonaStore } from "./companion/CompanionPersonaStore.ts";
import { governingMemoryGate } from "./companion/GoverningMemoryGate.ts";
import { emergencyStopCoordinator } from "./remote/EmergencyStopCoordinator.ts";
import { requireLocalhost } from "./security/PermissionManager.ts";
import { identityAuthManager } from "./security/IdentityAuthManager.ts";
import { securityPolicyEngine } from "./security/SecurityPolicyEngine.ts";
import { securityAuditLogger } from "./security/SecurityAuditLogger.ts";
import { contentSanitizer } from "./security/ContentSanitizer.ts";
import { isDlpClean } from "./memory/SharedMemoryManager.ts";
import { memoryStore } from "./memory/MemoryStore.ts";
import type { MemoryApprovalContext } from "./companion/GoverningMemoryTypes.ts";

dotenv.config();
logKeyResolution();

// Wire loggers into modules that need them
initTaskManagerLoggers(logCommand, logStartup, logError, logJson);
initGeminiLoggers(logStartup, logError, logJson);

// Pre-warm system instruction cache asynchronously at startup
prewarmInstructions().catch((e) => console.warn("[Startup] Prewarm instructions failed:", e));

// ---------------------------------------------------------------------------
// SEC-P3-R1.3-01 / Stage 10.4.2: Trusted Local Desktop /live Session Identity
// ---------------------------------------------------------------------------

export interface LocalLiveSessionContext {
  readonly sessionId: string;
  readonly deviceId: "local_desktop";
  readonly deviceName: string;
  readonly role: "standard";
  readonly ipAddress: string;
  readonly userAgent: string;
  readonly connectedAt: string;
  readonly authenticated: true;
  readonly isLocal: true;
  readonly transport: "loopback";
}

export type LocalUpgradeValidationResult =
  | { trusted: true; ipAddress: string; userAgent: string }
  | { trusted: false; statusCode: 401 | 403; reason: string };

const LOOPBACK_ORIGIN_REGEX = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

/**
 * Returns true ONLY for strict physical loopback addresses (127.0.0.1, ::1, ::ffff:127.0.0.1).
 * Explicitly excludes LAN subnets (192.168.*, 10.*, 172.16-31.*) and external IPs.
 */
export function isStrictLoopbackAddress(ip: string | undefined | null): boolean {
  if (!ip || typeof ip !== "string") return false;
  const normalized = ip.trim().toLowerCase().replace(/^::ffff:/, "");
  return normalized === "127.0.0.1" || normalized === "::1";
}

/**
 * Validates Origin header for local /live upgrades to block Cross-Site WebSocket Hijacking (CSWSH).
 * Non-browser local clients may omit Origin; browser clients MUST present a loopback Origin.
 */
export function isAllowedLocalLiveOrigin(origin: string | undefined | null): boolean {
  if (origin === undefined || origin === null || origin === "") return true;
  if (typeof origin !== "string") return false;
  return LOOPBACK_ORIGIN_REGEX.test(origin.trim());
}

/**
 * Validates that an unauthenticated WebSocket upgrade request qualifies as a trusted
 * local desktop /live connection. Never trusts client-supplied session IDs or forwarded headers.
 */
export function validateLocalLiveUpgrade(
  request: any,
  socket: any,
  pathname: string,
): LocalUpgradeValidationResult {
  if (pathname !== "/live") {
    return {
      trusted: false,
      statusCode: 401,
      reason: "REMOTE_ENDPOINT_REQUIRES_AUTH: /remote-live requires a paired device token.",
    };
  }

  // Reject any proxied/forwarded connection attempting to claim local desktop identity
  if (request?.headers?.["x-forwarded-for"]) {
    return {
      trusted: false,
      statusCode: 403,
      reason: "PROXIED_LOCAL_REJECTED: Proxied requests cannot establish local /live identity.",
    };
  }

  const rawSocketIp: string =
    socket?.remoteAddress || request?.socket?.remoteAddress || "";
  if (!isStrictLoopbackAddress(rawSocketIp)) {
    return {
      trusted: false,
      statusCode: 401,
      reason: "NON_LOOPBACK_AUTH_REQUIRED: Non-loopback connections must authenticate with a paired device token.",
    };
  }

  const originHeader = request?.headers?.origin;
  if (!isAllowedLocalLiveOrigin(originHeader)) {
    return {
      trusted: false,
      statusCode: 403,
      reason: "LOCAL_ORIGIN_DENIED: Cross-origin WebSocket upgrade to /live is forbidden.",
    };
  }

  const normalizedIp = rawSocketIp.trim().replace(/^::ffff:/i, "");
  const userAgent = String(request?.headers?.["user-agent"] || "local_desktop");
  return { trusted: true, ipAddress: normalizedIp, userAgent };
}

/**
 * Manages server-minted local desktop /live session identities.
 * Uses a private WeakMap for upgrade-to-connection handoff so external/client code
 * can never forge a trusted local upgrade or reuse a retired session ID.
 */
export class LocalLiveSessionRegistry {
  private _trustedUpgrades = new WeakMap<object, { ipAddress: string; userAgent: string; upgradedAt: number }>();
  private _activeSessions = new Map<string, LocalLiveSessionContext>();
  private _socketToSessionId = new WeakMap<object, string>();
  private _retiredSessionIds = new Set<string>();

  /** Marks a newly upgraded WebSocket as having passed strict local loopback upgrade validation. */
  markTrustedUpgrade(ws: object, meta: { ipAddress: string; userAgent: string }): void {
    this._trustedUpgrades.set(ws, {
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      upgradedAt: Date.now(),
    });
  }

  /**
   * Establishes a unique, server-generated local session context on a verified /live socket.
   * Ignores any client-supplied session IDs; returns null if the socket was not verified at upgrade.
   */
  establishLocalSession(clientWs: any): LocalLiveSessionContext | null {
    if (!clientWs || typeof clientWs !== "object") return null;

    const trustedMeta = this._trustedUpgrades.get(clientWs);
    if (!trustedMeta) {
      // Fail closed: socket did not pass server-side local upgrade verification.
      // Strip any pre-existing spoofed properties if present.
      try {
        delete clientWs.remoteSession;
        delete clientWs.remoteSessionId;
        delete clientWs.sessionId;
      } catch { /* ignore */ }
      return null;
    }

    // Consume one-time upgrade trust marker
    this._trustedUpgrades.delete(clientWs);

    // Clean any pre-existing client-supplied spoofed properties before binding
    try {
      delete clientWs.remoteSession;
      delete clientWs.remoteSessionId;
      delete clientWs.sessionId;
    } catch { /* ignore */ }

    // Mint strictly unique server-side session ID (never reused across connections)
    let sessionId = `local_sess_${crypto.randomUUID()}`;
    while (this._activeSessions.has(sessionId) || this._retiredSessionIds.has(sessionId)) {
      sessionId = `local_sess_${crypto.randomUUID()}`;
    }

    const sessionCtx: LocalLiveSessionContext = Object.freeze({
      sessionId,
      deviceId: "local_desktop",
      deviceName: "Local Desktop",
      role: "standard",
      ipAddress: trustedMeta.ipAddress,
      userAgent: trustedMeta.userAgent,
      connectedAt: new Date().toISOString(),
      authenticated: true,
      isLocal: true,
      transport: "loopback",
    });

    this._activeSessions.set(sessionId, sessionCtx);
    this._socketToSessionId.set(clientWs, sessionId);

    // Attach frozen, non-writable context matching ConversationManager & GeminiSessionFactory contract
    Object.defineProperty(clientWs, "remoteSession", {
      value: sessionCtx,
      writable: false,
      enumerable: true,
      configurable: true,
    });
    Object.defineProperty(clientWs, "remoteSessionId", {
      value: sessionId,
      writable: false,
      enumerable: true,
      configurable: true,
    });
    Object.defineProperty(clientWs, "sessionId", {
      value: sessionId,
      writable: false,
      enumerable: true,
      configurable: true,
    });

    return sessionCtx;
  }

  /** Cleans up and permanently retires the session ID on socket disconnect. */
  cleanupLocalSession(clientWs: any): boolean {
    if (!clientWs || typeof clientWs !== "object") return false;
    this._trustedUpgrades.delete(clientWs);

    const sessionId = this._socketToSessionId.get(clientWs);
    if (!sessionId) return false;

    this._socketToSessionId.delete(clientWs);
    this._activeSessions.delete(sessionId);
    this._retiredSessionIds.add(sessionId);

    try {
      delete clientWs.remoteSession;
      delete clientWs.remoteSessionId;
      delete clientWs.sessionId;
    } catch { /* ignore */ }

    return true;
  }

  /** Returns the active session context for a currently connected local socket. */
  getSessionForSocket(clientWs: any): LocalLiveSessionContext | undefined {
    if (!clientWs || typeof clientWs !== "object") return undefined;
    const sessionId = this._socketToSessionId.get(clientWs);
    return sessionId ? this._activeSessions.get(sessionId) : undefined;
  }

  isActiveSession(sessionId: string): boolean {
    return this._activeSessions.has(sessionId);
  }

  isRetiredSession(sessionId: string): boolean {
    return this._retiredSessionIds.has(sessionId);
  }

  getActiveCount(): number {
    return this._activeSessions.size;
  }

  resetForTesting(): void {
    this._activeSessions.clear();
    this._retiredSessionIds.clear();
  }
}

export const localLiveSessionRegistry = new LocalLiveSessionRegistry();

// ---------------------------------------------------------------------------
// SEC-P1-03: Operator session middleware — validates Bearer myraa_at_... token
// ---------------------------------------------------------------------------
function requireOperatorSession(req: any, res: any, next: () => void): void {
  const authHeader = req.headers?.["authorization"] || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) {
    res.status(401).json({ error: "MISSING_OPERATOR_TOKEN: Authorization header required." });
    return;
  }
  const socketIp = req.socket?.remoteAddress || req.connection?.remoteAddress || "127.0.0.1";
  const result = identityAuthManager.validateAccessToken(token, socketIp);
  if (!result.valid || !result.session) {
    res.status(401).json({ error: result.error || "INVALID_OPERATOR_TOKEN" });
    return;
  }
  req.operatorSession = result.session;
  next();
}

// ---------------------------------------------------------------------------
// Persona payload validator — SEC-P1-03 §7
// ---------------------------------------------------------------------------
const ALLOWED_PERSONA_KEYS = new Set([
  "id",
  "displayName",
  "name",
  "avatarStyle",
  "preferredLanguage",
  "communicationStyle",
  "customPromptPrefix",
  "customInstructions",
  "formality",
  "verbosity",
  "tone",
  "traits",
  "createdAt",
  "updatedAt",
]);

const ALLOWED_AVATAR_STYLES = new Set(["idle", "talking", "thinking"]);
const ALLOWED_LANGUAGES = new Set([
  "hinglish",
  "english",
  "hindi",
  "en",
  "hi",
  "en-us",
  "en-gb",
  "hi-in",
  "bhojpuri",
  "marathi",
  "tamil",
  "telugu",
  "bengali",
  "gujarati",
  "punjabi",
]);
const ALLOWED_COMM_STYLE_KEYS = new Set(["verbosity", "formality", "emotionalTone"]);
const READ_ONLY_OPERATOR_ROLES = new Set(["guest", "read_only"]);

function validatePersonaPayload(body: any): { valid: true } | { valid: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { valid: false, error: "Persona payload must be a JSON object." };
  }

  // Prototype pollution check
  const dangerousKeys = ["__proto__", "constructor", "prototype"];
  for (const dk of dangerousKeys) {
    if (Object.prototype.hasOwnProperty.call(body, dk)) {
      return { valid: false, error: `INVALID_PERSONA: Forbidden key '${dk}' detected.` };
    }
  }

  // Unexpected property check
  for (const key of Object.keys(body)) {
    if (!ALLOWED_PERSONA_KEYS.has(key)) {
      return { valid: false, error: `INVALID_PERSONA: Unexpected property '${key}'.` };
    }
  }

  // Validate id
  if (body.id !== undefined) {
    if (typeof body.id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(body.id)) {
      return { valid: false, error: "INVALID_PERSONA: 'id' must be 1-64 alphanumeric/underscore/hyphen characters." };
    }
  }

  // Validate displayName / name
  for (const nameKey of ["displayName", "name"] as const) {
    if (body[nameKey] !== undefined) {
      if (typeof body[nameKey] !== "string" || body[nameKey].length < 1 || body[nameKey].length > 64) {
        return { valid: false, error: `INVALID_PERSONA: '${nameKey}' must be a string between 1 and 64 characters.` };
      }
      if (!isDlpClean(body[nameKey]) || contentSanitizer.scanForPromptInjection(body[nameKey]).hasInjectionAttempt) {
        return { valid: false, error: `INVALID_PERSONA: '${nameKey}' contains unsafe or sensitive content.` };
      }
    }
  }

  // Validate avatarStyle (FINDING-AUD-04)
  if (body.avatarStyle !== undefined) {
    if (typeof body.avatarStyle !== "string" || !ALLOWED_AVATAR_STYLES.has(body.avatarStyle)) {
      return { valid: false, error: "INVALID_PERSONA: 'avatarStyle' must be one of: idle, talking, thinking." };
    }
  }

  // Validate preferredLanguage (FINDING-AUD-04)
  if (body.preferredLanguage !== undefined) {
    if (
      typeof body.preferredLanguage !== "string" ||
      body.preferredLanguage.length < 2 ||
      body.preferredLanguage.length > 32 ||
      !ALLOWED_LANGUAGES.has(body.preferredLanguage.toLowerCase())
    ) {
      return { valid: false, error: "INVALID_PERSONA: 'preferredLanguage' is not an allowed language code." };
    }
  }

  // Validate communicationStyle (FINDING-AUD-04)
  if (body.communicationStyle !== undefined) {
    const cs = body.communicationStyle;
    if (!cs || typeof cs !== "object" || Array.isArray(cs)) {
      return { valid: false, error: "INVALID_PERSONA: 'communicationStyle' must be a JSON object." };
    }
    for (const dk of dangerousKeys) {
      if (Object.prototype.hasOwnProperty.call(cs, dk)) {
        return { valid: false, error: `INVALID_PERSONA: Forbidden key '${dk}' in communicationStyle.` };
      }
    }
    for (const k of Object.keys(cs)) {
      if (!ALLOWED_COMM_STYLE_KEYS.has(k)) {
        return { valid: false, error: `INVALID_PERSONA: Unexpected communicationStyle property '${k}'.` };
      }
    }
    if (cs.verbosity !== undefined && !["concise", "normal", "detailed"].includes(cs.verbosity)) {
      return { valid: false, error: "INVALID_PERSONA: 'communicationStyle.verbosity' must be concise, normal, or detailed." };
    }
    if (cs.formality !== undefined && !["casual", "professional"].includes(cs.formality)) {
      return { valid: false, error: "INVALID_PERSONA: 'communicationStyle.formality' must be casual or professional." };
    }
    if (cs.emotionalTone !== undefined && !["warm", "neutral", "direct"].includes(cs.emotionalTone)) {
      return { valid: false, error: "INVALID_PERSONA: 'communicationStyle.emotionalTone' must be warm, neutral, or direct." };
    }
  }

  // Validate customPromptPrefix (FINDING-AUD-04 — length + DLP + prompt-injection defense)
  if (body.customPromptPrefix !== undefined) {
    if (typeof body.customPromptPrefix !== "string" || body.customPromptPrefix.length > 1000) {
      return { valid: false, error: "INVALID_PERSONA: 'customPromptPrefix' must be a string with max 1000 characters." };
    }
    if (!isDlpClean(body.customPromptPrefix)) {
      return { valid: false, error: "INVALID_PERSONA: 'customPromptPrefix' contains sensitive secret/credential material." };
    }
    if (contentSanitizer.scanForPromptInjection(body.customPromptPrefix).hasInjectionAttempt) {
      return { valid: false, error: "INVALID_PERSONA: 'customPromptPrefix' contains disallowed prompt-injection patterns." };
    }
  }

  // Validate customInstructions
  if (body.customInstructions !== undefined) {
    if (typeof body.customInstructions !== "string" || body.customInstructions.length > 2000) {
      return { valid: false, error: "INVALID_PERSONA: 'customInstructions' must be a string with max 2000 characters." };
    }
    if (!isDlpClean(body.customInstructions)) {
      return { valid: false, error: "INVALID_PERSONA: 'customInstructions' contains sensitive secret/credential material." };
    }
    if (contentSanitizer.scanForPromptInjection(body.customInstructions).hasInjectionAttempt) {
      return { valid: false, error: "INVALID_PERSONA: 'customInstructions' contains disallowed prompt-injection patterns." };
    }
  }

  // Validate optional ISO timestamps
  for (const tsKey of ["createdAt", "updatedAt"] as const) {
    if (body[tsKey] !== undefined) {
      if (typeof body[tsKey] !== "string" || body[tsKey].length > 40 || Number.isNaN(Date.parse(body[tsKey]))) {
        return { valid: false, error: `INVALID_PERSONA: '${tsKey}' must be a valid ISO timestamp string.` };
      }
    }
  }

  // Validate legacy top-level formality/verbosity/tone/traits
  if (body.formality !== undefined) {
    if (!["casual", "neutral", "formal", "professional"].includes(body.formality)) {
      return { valid: false, error: "INVALID_PERSONA: 'formality' must be one of: casual, neutral, formal, professional." };
    }
  }

  if (body.verbosity !== undefined) {
    if (!["concise", "balanced", "normal", "elaborate", "detailed"].includes(body.verbosity)) {
      return { valid: false, error: "INVALID_PERSONA: 'verbosity' must be one of: concise, balanced, normal, elaborate, detailed." };
    }
  }

  if (body.tone !== undefined) {
    if (!["warm", "direct", "playful", "calm", "neutral"].includes(body.tone)) {
      return { valid: false, error: "INVALID_PERSONA: 'tone' must be one of: warm, direct, playful, calm, neutral." };
    }
  }

  if (body.traits !== undefined) {
    if (!Array.isArray(body.traits) || body.traits.length > 10) {
      return { valid: false, error: "INVALID_PERSONA: 'traits' must be an array with at most 10 elements." };
    }
    for (const trait of body.traits) {
      if (typeof trait !== "string" || trait.length > 32) {
        return { valid: false, error: "INVALID_PERSONA: Each trait must be a string with at most 32 characters." };
      }
    }
  }

  return { valid: true };
}

function assertCompanionMutationAllowed(req: any, res: any, resource: string): boolean {
  const session = req.operatorSession;
  const role = String(session?.role || "").toLowerCase();
  if (!role || READ_ONLY_OPERATOR_ROLES.has(role)) {
    securityAuditLogger.logEvent({
      eventType: "TOOL_BLOCKED",
      actor: {
        identityId: session?.identityId || "unknown",
        role: session?.role || "guest",
        ipAddress: req.socket?.remoteAddress || "127.0.0.1",
        sessionId: session?.sessionId,
      },
      target: { resource },
      decision: "BLOCK",
      reason: `FORBIDDEN_ROLE: Role '${role || "unknown"}' cannot mutate '${resource}'.`,
      riskLevel: "HIGH",
    });
    res.status(403).json({ error: `FORBIDDEN_ROLE: Role '${role || "unknown"}' is not permitted for this operation.` });
    return false;
  }

  if (emergencyStopCoordinator.isActive()) {
    securityAuditLogger.logEvent({
      eventType: "TOOL_BLOCKED",
      actor: {
        identityId: session?.identityId || "unknown",
        role: session?.role || "standard",
        ipAddress: req.socket?.remoteAddress || "127.0.0.1",
        sessionId: session?.sessionId,
      },
      target: { resource },
      decision: "BLOCK",
      reason: `EMERGENCY_STOP_ACTIVE: Blocked '${resource}' while Emergency Stop is active.`,
      riskLevel: "HIGH",
    });
    res.status(503).json({ error: "EMERGENCY_STOP_ACTIVE: Operation blocked while Emergency Stop is active.", blocked: true });
    return false;
  }

  if (securityPolicyEngine.getMode() === "LOCKDOWN") {
    securityAuditLogger.logEvent({
      eventType: "TOOL_BLOCKED",
      actor: {
        identityId: session?.identityId || "unknown",
        role: session?.role || "standard",
        ipAddress: req.socket?.remoteAddress || "127.0.0.1",
        sessionId: session?.sessionId,
      },
      target: { resource },
      decision: "BLOCK",
      reason: `SECURITY_LOCKDOWN_ACTIVE: Blocked '${resource}' while Security Lockdown is active.`,
      riskLevel: "HIGH",
    });
    res.status(423).json({ error: "SECURITY_LOCKDOWN_ACTIVE: Operation blocked while Security Lockdown is active.", blocked: true });
    return false;
  }

  return true;
}

export function mountCompanionRoutes(app: import("express").Application): void {
  // GET /api/companion/persona — localhost only
  app.get("/api/companion/persona", requireLocalhost, async (_req, res) => {
    try {
      const persona = await companionPersonaStore.getPersona();
      res.json(persona);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "Failed to get persona" });
    }
  });

  // PUT /api/companion/persona — localhost + operator auth + RBAC + ES/Lockdown + strict validation + audit (FINDING-AUD-04)
  app.put("/api/companion/persona", requireLocalhost, requireOperatorSession, async (req: any, res) => {
    const session = req.operatorSession;
    const socketIp = req.socket?.remoteAddress || req.connection?.remoteAddress || "127.0.0.1";
    try {
      if (!assertCompanionMutationAllowed(req, res, "companion_persona.json")) return;

      // SEC-P1-03 §8: Body size limit
      const contentLength = parseInt(req.headers?.["content-length"] || "0", 10);
      if (contentLength > 10000) {
        return res.status(413).json({ error: "PAYLOAD_TOO_LARGE: Request body exceeds 10000 bytes." });
      }

      // SEC-P1-03 §7 + FINDING-AUD-04: Strict persona validation across all fields
      const validation = validatePersonaPayload(req.body);
      if (validation.valid === false) {
        securityAuditLogger.logEvent({
          eventType: "TOOL_BLOCKED",
          actor: {
            identityId: session.identityId,
            role: session.role,
            ipAddress: socketIp,
            sessionId: session.sessionId,
          },
          target: { resource: "companion_persona.json" },
          decision: "BLOCK",
          reason: `PERSONA_UPDATE_REJECTED: ${validation.error}`,
          riskLevel: "MEDIUM",
        });
        return res.status(400).json({ error: validation.error });
      }

      const updated = await companionPersonaStore.savePersona(req.body);
      securityAuditLogger.logEvent({
        eventType: "TOOL_CONFIRMED",
        actor: {
          identityId: session.identityId,
          role: session.role,
          ipAddress: socketIp,
          sessionId: session.sessionId,
        },
        target: { resource: "companion_persona.json" },
        decision: "ALLOW",
        reason: `PERSONA_UPDATED: Persona updated by operator '${session.identityId}'.`,
        riskLevel: "LOW",
        metadata: { displayName: updated.displayName, updatedFields: Object.keys(req.body || {}) },
      });
      res.json(updated);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "Failed to update persona" });
    }
  });

  // GET /api/companion/memory/requests — localhost + operator auth
  app.get("/api/companion/memory/requests", requireLocalhost, requireOperatorSession, (req: any, res) => {
    try {
      const session = req.operatorSession;
      const filterActor = session.role === "admin" ? undefined : session.identityId;
      const requests = governingMemoryGate.listPendingRequests(filterActor);
      res.json(requests);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "Failed to list memory requests" });
    }
  });

  // POST /api/companion/memory/propose — localhost + operator auth + RBAC + ES/Lockdown + DLP/injection
  app.post("/api/companion/memory/propose", requireLocalhost, requireOperatorSession, async (req: any, res) => {
    try {
      if (!assertCompanionMutationAllowed(req, res, "/api/companion/memory/propose")) return;

      const session = req.operatorSession;
      const { category, text, key, importance, confidence, source, reason } = req.body || {};
      if (!category || !text) {
        return res.status(400).json({ error: "Category and text parameters are required." });
      }

      if (!isDlpClean(String(text)) || (key && !isDlpClean(String(key)))) {
        return res.status(422).json({
          error: "DLP_SECRET_REJECTED: Secrets or credentials cannot be stored in memory.",
          blocked: true,
        });
      }
      if (contentSanitizer.scanForPromptInjection(String(text)).hasInjectionAttempt) {
        return res.status(422).json({
          error: "PROMPT_INJECTION_BLOCKED: Proposed memory contains unsafe prompt-injection patterns.",
          blocked: true,
        });
      }

      const proposal = await governingMemoryGate.requestWrite({
        action: "CREATE",
        proposedMemory: { category, text, key, importance, confidence },
        reason: reason || "Companion proposal endpoint",
        confidence: typeof confidence === "number" ? confidence : 0.85,
        source: source || "user_explicit",
        userId: session.identityId,
        provenance: "companion_propose",
        sessionId: session.sessionId,
        actorRole: session.role,
        isStepUpAuthenticated: !!(session.isStepUpAuthenticated && session.stepUpExpiresAt && Date.now() < session.stepUpExpiresAt),
      });
      res.status(202).json({
        status: "pending_approval",
        requestId: proposal.id,
        message: "Memory proposal created. Awaiting operator confirmation.",
        proposedMemory: proposal.proposedMemory,
      });
    } catch (err: any) {
      const msg = err?.message || "Failed to create proposal";
      if (msg.includes("DLP_SECRET_REJECTED") || msg.includes("PROMPT_INJECTION_BLOCKED")) {
        return res.status(422).json({ error: msg, blocked: true });
      }
      if (msg.includes("EMERGENCY_STOP_ACTIVE")) return res.status(503).json({ error: msg, blocked: true });
      if (msg.includes("SECURITY_LOCKDOWN_ACTIVE")) return res.status(423).json({ error: msg, blocked: true });
      res.status(500).json({ error: msg });
    }
  });

  // Approval handler (FINDING-AUD-05, FINDING-AUD-07)
  const handleApprove = async (req: any, res: any) => {
    try {
      if (!assertCompanionMutationAllowed(req, res, "/api/companion/memory/approve")) return;

      const { id } = req.params;
      const { token, modifiedMemory } = req.body || {};

      // Build MemoryApprovalContext from validated operator session
      const session = req.operatorSession;
      const socketIp = req.socket?.remoteAddress || req.connection?.remoteAddress || "127.0.0.1";
      const context: MemoryApprovalContext = {
        actorId: session.identityId,
        role: session.role,
        ipAddress: socketIp,
        sessionId: session.sessionId,
        isStepUpAuthenticated: !!(session?.isStepUpAuthenticated && session?.stepUpExpiresAt && Date.now() < session.stepUpExpiresAt),
      };

      // Check pending request AND live target record for sensitive category — issue step-up challenge if needed
      const pendingRequest = governingMemoryGate.getRequest(id);
      if (pendingRequest) {
        const SENSITIVE_CATEGORIES = new Set(["identity", "credentials", "behavior"]);
        let category = (pendingRequest.proposedMemory as any)?.category
          ? String((pendingRequest.proposedMemory as any).category).toLowerCase()
          : undefined;

        if (
          (!category || !SENSITIVE_CATEGORIES.has(category)) &&
          pendingRequest.proposedMemory?.id &&
          ["UPDATE", "DELETE", "ARCHIVE", "MERGE"].includes(pendingRequest.action)
        ) {
          const all = await memoryStore.load();
          const existing = all.find((m) => m.id === pendingRequest.proposedMemory.id);
          if (existing?.category && SENSITIVE_CATEGORIES.has(String(existing.category).toLowerCase())) {
            category = String(existing.category).toLowerCase();
          }
        }

        if (category && SENSITIVE_CATEGORIES.has(category) && !context.isStepUpAuthenticated) {
          // Issue a step-up challenge for the operator session (never returning PIN in HTTP response)
          let challengeId: string | undefined;
          try {
            if (session?.sessionId) {
              const challenge = identityAuthManager.requestStepUpChallenge(session.sessionId, "memory_approve_sensitive");
              challengeId = challenge.challengeId;
              registerStepUpChallengeOwner(
                challenge.challengeId,
                session.sessionId,
                new Date(challenge.expiresAt).getTime(),
              );
            }
          } catch { /* step-up challenge issuance failed */ }
          return res.status(403).json({ stepUpRequired: true, challengeId });
        }
      }

      const saved = await governingMemoryGate.approveWrite(id, token, context, modifiedMemory);
      res.json({ ok: true, memory: saved });
    } catch (err: any) {
      const msg = err?.message || "Failed to approve memory request";
      if (msg.includes("REQUEST_NOT_FOUND")) {
        return res.status(404).json({ error: msg });
      }
      if (msg.includes("STEP_UP_REQUIRED")) {
        return res.status(403).json({ error: msg, stepUpRequired: true });
      }
      if (
        msg.includes("UNAUTHORIZED_ACTOR") ||
        msg.includes("UNAUTHORIZED_SESSION") ||
        msg.includes("UNAUTHORIZED_MEMORY_OWNER") ||
        msg.includes("FORBIDDEN_ROLE")
      ) {
        return res.status(403).json({ error: msg });
      }
      if (msg.includes("STALE_RECORD_CONFLICT")) {
        return res.status(409).json({ error: msg });
      }
      if (msg.includes("EMERGENCY_STOP_ACTIVE")) {
        return res.status(503).json({ error: msg, blocked: true });
      }
      if (msg.includes("SECURITY_LOCKDOWN_ACTIVE")) {
        return res.status(423).json({ error: msg, blocked: true });
      }
      if (
        msg.includes("PAYLOAD_TAMPERED") ||
        msg.includes("REQUEST_EXPIRED") ||
        msg.includes("REQUEST_ALREADY_REJECTED") ||
        msg.includes("MISSING_APPROVAL_TOKEN") ||
        msg.includes("CONCURRENT_APPROVAL_CONFLICT")
      ) {
        return res.status(400).json({ error: msg });
      }
      res.status(500).json({ error: msg });
    }
  };

  // Mount approve on both canonical paths
  app.post("/api/companion/memory/requests/:id/approve", requireLocalhost, requireOperatorSession, handleApprove);
  app.post("/api/companion/memory/approve/:id", requireLocalhost, requireOperatorSession, handleApprove);

  // Reject handler (FINDING-AUD-05 — passes authenticated actor + session context)
  const handleReject = (req: any, res: any) => {
    try {
      if (!assertCompanionMutationAllowed(req, res, "/api/companion/memory/reject")) return;

      const { id } = req.params;
      const { reason } = req.body || {};
      const session = req.operatorSession;
      const socketIp = req.socket?.remoteAddress || req.connection?.remoteAddress || "127.0.0.1";
      const context: MemoryApprovalContext = {
        actorId: session.identityId,
        role: session.role,
        ipAddress: socketIp,
        sessionId: session.sessionId,
        isStepUpAuthenticated: !!(session?.isStepUpAuthenticated && session?.stepUpExpiresAt && Date.now() < session.stepUpExpiresAt),
      };

      governingMemoryGate.rejectWrite(id, reason, context);
      res.json({ ok: true, message: `Request '${id}' rejected.` });
    } catch (err: any) {
      const msg = err?.message || "Failed to reject memory request";
      if (msg.includes("REQUEST_NOT_FOUND")) {
        return res.status(404).json({ error: msg });
      }
      if (
        msg.includes("UNAUTHORIZED_ACTOR") ||
        msg.includes("UNAUTHORIZED_SESSION") ||
        msg.includes("FORBIDDEN_ROLE")
      ) {
        return res.status(403).json({ error: msg });
      }
      if (msg.includes("EMERGENCY_STOP_ACTIVE")) {
        return res.status(503).json({ error: msg, blocked: true });
      }
      if (msg.includes("SECURITY_LOCKDOWN_ACTIVE")) {
        return res.status(423).json({ error: msg, blocked: true });
      }
      res.status(500).json({ error: msg });
    }
  };

  // Mount reject on both canonical paths
  app.post("/api/companion/memory/requests/:id/reject", requireLocalhost, requireOperatorSession, handleReject);
  app.post("/api/companion/memory/reject/:id", requireLocalhost, requireOperatorSession, handleReject);
}

async function startServer() {
  const app = createHttpApp();
  mountCompanionRoutes(app);
  const PORT = parseInt(process.env.PORT || "3000", 10);
  const HOST = process.env.HOST || "0.0.0.0";

  let server: http.Server | import("https").Server;
  const tlsCertPath = process.env.MYRAA_TLS_CERT;
  const tlsKeyPath = process.env.MYRAA_TLS_KEY;

  if (tlsCertPath && tlsKeyPath && fs.existsSync(tlsCertPath) && fs.existsSync(tlsKeyPath)) {
    const https = await import("https");
    server = https.createServer(
      {
        cert: fs.readFileSync(tlsCertPath),
        key: fs.readFileSync(tlsKeyPath),
      },
      app,
    );
    console.log("[Server] Production native HTTPS/TLS enabled via certificate files.");
  } else {
    server = http.createServer(app);
  }

  // WebSocket server — upgrades /live and /remote-live connections
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => {
      if (protocols.has("myraa-auth")) {
        return "myraa-auth";
      }
      // Fail closed: reject any unknown or arbitrary protocols
      return false;
    },
  });

  server.on("upgrade", async (request, socket, head) => {
    try {
      const url = new URL(
        request.url || "",
        `http://${request.headers.host}`,
      );
      const pathname = url.pathname;
      if (pathname === "/live" || pathname === "/remote-live") {
        const forwardedFor = request.headers["x-forwarded-for"];
        const ip = typeof forwardedFor === "string"
          ? forwardedFor.split(",")[0].trim()
          : (socket as any).remoteAddress || request.socket?.remoteAddress || "";
        const cleanIp = ip.replace(/^::ffff:/, "");
        const isLanIp =
          cleanIp.startsWith("192.168.") ||
          cleanIp.startsWith("10.") ||
          cleanIp.startsWith("172.16.") ||
          cleanIp.startsWith("172.17.") ||
          cleanIp.startsWith("172.18.") ||
          cleanIp.startsWith("172.19.") ||
          cleanIp.startsWith("172.2") ||
          cleanIp.startsWith("172.3");
        const isLocal = !forwardedFor && (cleanIp === "127.0.0.1" || cleanIp === "::1" || cleanIp === "localhost" || isLanIp);


        // Validate Transport Security: Non-localhost WebSocket connections must use WSS
        if (!isLocal) {
          const { dataProtectionService } = await import("./security/DataProtectionService.ts");
          const protoHeader = request.headers["x-forwarded-proto"];
          const protoFirst = typeof protoHeader === "string" ? protoHeader.split(",")[0].trim() : protoHeader;
          const isSslOn = request.headers["x-forwarded-ssl"] === "on" || request.headers["front-end-https"] === "on";
          const proto = protoFirst || (isSslOn ? "wss" : ((socket as any).encrypted ? "wss" : "ws"));
          const transportCheck = dataProtectionService.validateTransport({
            protocol: String(proto),
            ipAddress: ip,
            targetName: pathname,
          });
          if (!transportCheck.secure) {
            console.warn(`[WebSocket Upgrade] Insecure transport rejected for ${ip} (proto=${proto}): ${transportCheck.error}`);
            socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
            socket.destroy();
            return;
          }
        }

        // Extract token from Sec-WebSocket-Protocol
        let token: string | null = null;
        const protocols = request.headers["sec-websocket-protocol"];
        if (protocols) {
          const parts = protocols.split(",").map((s) => s.trim());
          const authIdx = parts.indexOf("myraa-auth");
          if (authIdx >= 0 && parts[authIdx + 1]) {
            token = parts[authIdx + 1];
          }
        }

        // Reject token parameter in URL query on remote non-localhost connections to eliminate credential leakage
        if (url.searchParams.has("token")) {
          if (!isLocal) {
            console.warn(`[WebSocket Upgrade] Insecure query-parameter authentication rejected for remote client ${ip}. Use Sec-WebSocket-Protocol.`);
            socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
            socket.destroy();
            return;
          }
          if (!token) {
            token = url.searchParams.get("token");
          }
        }

        // Authenticate connection:
        // - If a device token is present OR endpoint is /remote-live: enforce remote credential auth.
        // - If unauthenticated /live: enforce strict loopback + Origin + non-proxied validation
        //   and establish a server-minted local desktop session identity (never client-supplied).
        let remoteDevice = null;
        let trustedLocalUpgrade: { ipAddress: string; userAgent: string } | null = null;

        if (token || pathname === "/remote-live") {
          if (!token) {
            console.warn(`[WebSocket Upgrade] Missing authentication token for remote client from ${ip}`);
            socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
            socket.destroy();
            return;
          }
          const { remoteSecurityCoordinator } = await import("./security/RemoteSecurityCoordinator.ts");
          const auth = await remoteSecurityCoordinator.authenticateRemoteCredential(token, ip, request.headers["user-agent"]);
          if (!auth.authenticated || !auth.device) {
            console.warn(`[WebSocket Upgrade] Authentication failed for remote client ${ip}: ${auth.error || "Invalid credential"}`);
            socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
            socket.destroy();
            return;
          }
          remoteDevice = auth.device;
        } else {
          const localCheck = validateLocalLiveUpgrade(request, socket, pathname);
          if (localCheck.trusted === false) {
            const failCheck = localCheck as { trusted: false; statusCode: 401 | 403; reason: string };
            console.warn(`[WebSocket Upgrade] Local /live upgrade rejected for ${ip}: ${failCheck.reason}`);
            const statusLine = failCheck.statusCode === 403 ? "HTTP/1.1 403 Forbidden" : "HTTP/1.1 401 Unauthorized";
            socket.write(`${statusLine}\r\n\r\n`);
            socket.destroy();
            return;
          }
          const okCheck = localCheck as { trusted: true; ipAddress: string; userAgent: string };
          trustedLocalUpgrade = { ipAddress: okCheck.ipAddress, userAgent: okCheck.userAgent };
        }

        // Reject new connections if Security Lockdown is active
        const { securityPolicyEngine } = await import("./security/SecurityPolicyEngine.ts");
        if (securityPolicyEngine.getMode() === "LOCKDOWN") {
          console.warn("[WebSocket Upgrade] Connection rejected: Security Lockdown active");
          socket.write("HTTP/1.1 423 Locked\r\n\r\n");
          socket.destroy();
          return;
        }

        // Reject new connections if Emergency Stop is currently active
        const { emergencyStopCoordinator } = await import("./remote/EmergencyStopCoordinator.ts");
        if (emergencyStopCoordinator.isActive()) {
          console.warn("[WebSocket Upgrade] Connection rejected: Emergency Stop active");
          socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
          socket.destroy();
          return;
        }

        wss.handleUpgrade(request, socket, head, (ws) => {
          (ws as any).remoteDevice = remoteDevice;
          if (!remoteDevice && trustedLocalUpgrade) {
            localLiveSessionRegistry.markTrustedUpgrade(ws, trustedLocalUpgrade);
          }
          wss.emit("connection", ws, request);
        });
      } else {
        socket.destroy();
      }
    } catch (err: any) {
      console.error("[WebSocket Upgrade Error]:", err?.message || err);
      socket.destroy();
    }
  });

  const conversationManager = new ConversationManager();

  wss.on("connection", async (clientWs, request: any) => {
    const remoteDevice = (clientWs as any).remoteDevice;
    if (remoteDevice) {
      const { remoteSessionManager } = await import("./remote/RemoteSessionManager.ts");
      remoteSessionManager.registerClient(
        clientWs,
        remoteDevice,
        request?.socket?.remoteAddress || "unknown",
        request?.headers?.["user-agent"] || "unknown",
      );
    } else {
      // Establish unique, server-generated local desktop /live session identity
      localLiveSessionRegistry.establishLocalSession(clientWs);
    }

    // Wire emergency stop broadcast
    const { emergencyStopCoordinator } = await import("./remote/EmergencyStopCoordinator.ts");
    const unregisterEmergency = emergencyStopCoordinator.registerBroadcast((payload) => {
      if (clientWs.readyState === 1) {
        try {
          clientWs.send(typeof payload === "string" ? payload : JSON.stringify(payload));
        } catch { /* ignore dropped frame */ }
      }
    });

    // Wire proactive companion broadcasts to connected client
    const unregisterBroadcast = companionCoordinator.registerClientBroadcast((payload) => {
      if (clientWs.readyState === 1) {
        try {
          clientWs.send(typeof payload === "string" ? payload : JSON.stringify(payload));
        } catch { /* ignore dropped frame */ }
      }
    });

    const onDisconnect = () => {
      localLiveSessionRegistry.cleanupLocalSession(clientWs);
      unregisterEmergency();
      unregisterBroadcast();
    };

    clientWs.on("close", onDisconnect);
    clientWs.on("error", onDisconnect);

    await conversationManager.handleConnection(clientWs);
  });

  // Vite dev middleware (dev) or static dist (prod)
  if (process.env.NODE_ENV !== "production") {
    // Serve custom static assets in development
    const rootAssetsPath = path.join(process.cwd(), "assets");
    if (fs.existsSync(rootAssetsPath)) {
      app.use(
        "/assets",
        (await import("express")).default.static(rootAssetsPath, {
          fallthrough: true,
        }),
      );
    }

    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        watch: {
          ignored: [
            "**/logs/**",
            "**/desktop_agent/**",
            "**/Desktop/**",
            "**/Downloads/**",
            "**/*.json",
            "**/*.log",
            "**/*.txt",
            "**/*.pyc",
            "**/scratch/**",
          ],
        },
      },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const { default: express } = await import("express");
    const distPath = path.join(process.cwd(), "dist");
    const distAssetsPath = path.join(distPath, "assets");
    const rootAssetsPath = path.join(process.cwd(), "assets");

    // Primary: serve compiled production frontend assets with immutable caching
    if (fs.existsSync(distAssetsPath)) {
      app.use(
        "/assets",
        express.static(distAssetsPath, {
          maxAge: "1y",
          immutable: true,
          fallthrough: true,
        }),
      );
    }

    // Fallback: serve root custom assets directory
    if (fs.existsSync(rootAssetsPath)) {
      app.use(
        "/assets",
        express.static(rootAssetsPath, {
          fallthrough: true,
        }),
      );
    }

    // Secondary: serve root dist files (favicon, icon, manifest, models, worklets)
    app.use(
      express.static(distPath, {
        fallthrough: true,
      }),
    );

    // SPA fallback: serve index.html for client navigation, strictly excluding /assets/* and /api/*
    app.get("*", (req, res) => {
      if (req.path.startsWith("/assets/") || req.path.startsWith("/api/")) {
        res.status(404).type("text/plain").send("Not Found");
        return;
      }
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  server.on("error", (err: NodeJS.ErrnoException) => {
    const msg =
      err.code === "EADDRINUSE"
        ? `[Server] Fatal: Port ${PORT} on ${HOST} is already in use (EADDRINUSE).`
        : `[Server] Fatal HTTP listener error (${err.code || "UNKNOWN"}): ${err.message}`;
    console.error(msg);
    logError(msg);
    process.exit(1);
  });

  let wsHeartbeatInterval: ReturnType<typeof setInterval> | null = null;

  server.listen(PORT, HOST, () => {
    const isTls = Boolean(tlsCertPath && tlsKeyPath && fs.existsSync(tlsCertPath) && fs.existsSync(tlsKeyPath));
    const protocol = isTls ? "https" : "http";
    logStartup(`MYRAA V2 server started on ${protocol}://${HOST}:${PORT}`);
    console.log(`[Server] Running on ${protocol}://${HOST}:${PORT}`);
    ensureDesktopAgent().catch((e) =>
      console.warn(`[Desktop Agent] Boot probe failed: ${e?.message || e}`),
    );
    companionCoordinator.start().catch((e) =>
      console.warn(`[Companion] Startup error: ${e?.message || e}`),
    );
    emergencyStopCoordinator.init().catch((e) =>
      console.warn(`[EmergencyStop] Init error: ${e?.message || e}`),
    );
    import("./remote/RemoteStore.ts").then(({ remoteStore }) => {
      remoteStore.recoverSoleAdminDevice().catch((e) =>
        console.warn(`[RemoteStore] Sole admin recovery error: ${e?.message || e}`),
      );
    });
    import("./remote/RemoteSessionManager.ts").then(({ remoteSessionManager }) => {
      wsHeartbeatInterval = setInterval(() => {
        try {
          remoteSessionManager.checkHeartbeats();
        } catch {
          /* best-effort heartbeat check */
        }
      }, 20000);
      wsHeartbeatInterval.unref?.();
    });
  });

  let isShuttingDown = false;
  const shutdown = (signal: string, exitCode = 0) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`[Server] Graceful shutdown initiated (${signal})...`);
    logStartup(`[Server] Graceful shutdown initiated (${signal}).`);

    if (wsHeartbeatInterval) {
      clearInterval(wsHeartbeatInterval);
      wsHeartbeatInterval = null;
    }

    // 1. Stop background task coordinators
    try {
      companionCoordinator.stop();
    } catch { /* ignore */ }

    // 2. Disconnect active remote WebSocket sessions gracefully
    try {
      wss.clients.forEach((client) => {
        if (client.readyState === 1) {
          try {
            client.close(1001, "Server shutting down");
          } catch { /* ignore */ }
        }
      });
      wss.close();
    } catch { /* ignore */ }

    // 3. Close HTTP server
    server.close(() => {
      console.log("[Server] HTTP and WebSocket listeners closed cleanly.");
      logStartup("[Server] HTTP and WebSocket listeners closed cleanly.");
      process.exit(exitCode);
    });

    // Force exit if connection drain exceeds 5 seconds
    setTimeout(() => {
      console.warn("[Server] Forced shutdown timeout reached. Terminating.");
      process.exit(exitCode);
    }, 5000).unref();
  };

  process.on("SIGINT", () => shutdown("SIGINT", 0));
  process.on("SIGTERM", () => shutdown("SIGTERM", 0));

  process.on("unhandledRejection", (reason: any) => {
    const msg = reason?.message || String(reason);
    logError(`[Process] Unhandled promise rejection: ${msg}`);
  });

  process.on("uncaughtException", (error: Error) => {
    console.error(`[Process] Uncaught exception: ${error?.stack || error?.message || error}`);
    logError(`[Process] Uncaught exception: ${error.message}`);
    shutdown("uncaughtException", 1);
  });
}

if (!process.env.VITEST && process.env.NODE_ENV !== "test") {
  startServer().catch((error) => {
    console.error("Failed to start server startup sequence:", error);
  });
}
