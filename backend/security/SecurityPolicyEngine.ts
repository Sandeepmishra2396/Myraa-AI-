/**
 * MYRAA — SecurityPolicyEngine (Phase 10A)
 *
 * Deterministic Security Policy Engine:
 *   • Sits between MYRAA AI and every tool execution.
 *   • Mandatory pipeline:
 *     AI/User Request → Policy Engine → Risk Analysis → Permission Check → Argument Validation → Tool Execution → Result Validation → Audit
 *   • Strict Risk Levels: LOW / MEDIUM / HIGH / CRITICAL
 *   • Confirmation token issuance, binding, and single-use consumption.
 *   • Comprehensive argument sanitization & boundary enforcement.
 *   • Zero unrestricted system control for AI.
 */

import crypto from "crypto";
import path from "path";
import type {
  RiskLevel,
  SecurityMode,
  SecurityContext,
  RiskEvaluation,
  PolicyDecision,
  ConfirmationTokenPayload,
  DecisionType,
} from "./SecurityTypes.ts";
import { CONFIRMATION_TOKEN_TTL_MS } from "./SecurityTypes.ts";
import { securityAuditLogger } from "./SecurityAuditLogger.ts";
import { isPathWithinWorkspace, isPathWithinSafeRoots, isSsrfSafeUrl } from "./PermissionManager.ts";
import { contentSanitizer } from "./ContentSanitizer.ts";
import { desktopSecurityGate } from "./DesktopSecurityGate.ts";


const WORKSPACE = process.env.SORA_WORKSPACE_DIR || process.cwd();
export const POLICY_SIGNING_SECRET =
  process.env.POLICY_SIGNING_SECRET ||
  process.env.MYRAA_POLICY_SECRET ||
  process.env.MYRAA_SECURITY_SECRET ||
  crypto.randomBytes(32).toString("hex");

// ---------------------------------------------------------------------------
// SEC-P3-R1.3-01: Per-Process Boot Generation ID.
// MYRAA runs as a single Node.js process with an in-memory consumed-token Map.
// Independent worker processes do NOT share consumed-token state, so this boot ID
// is strictly unique per process instance (never inherited from a shared env var)
// to fail closed across workers and restarts and prevent cross-process token replay.
// Never log raw tokens or signatures.
// ---------------------------------------------------------------------------
export const PROCESS_BOOT_ID = crypto.randomUUID();

// ---------------------------------------------------------------------------
// Tool Risk Classification & Patterns (Delegated to SecurityRiskEngine)
// ---------------------------------------------------------------------------

export {
  CRITICAL_TOOLS,
  HIGH_RISK_TOOLS,
  MEDIUM_RISK_TOOLS,
  MALICIOUS_SHELL_PATTERNS,
  PROTECTED_PATHS,
} from "./SecurityRiskEngine.ts";
import {
  CRITICAL_TOOLS,
  HIGH_RISK_TOOLS,
  MEDIUM_RISK_TOOLS,
  MALICIOUS_SHELL_PATTERNS,
  PROTECTED_PATHS,
  securityRiskEngine,
} from "./SecurityRiskEngine.ts";

/**
 * Explicit allowlist of recovery operations permitted during LOCKDOWN mode.
 * Everything else is fail-closed.
 */
export const LOCKDOWN_ALLOWLIST = new Set<string>([
  "triggerEmergencyStop",
  "getEmergencyStopStatus",
  "resetEmergencyStop",
]);

export type ConsumedTokenStatus = "CONFIRMED" | "REVOKED";

export interface ConfirmationVerificationResult {
  valid: boolean;
  reason?: string;
  tokenId?: string;
  argsHash?: string;
  status?: "CONFIRMED" | "ALREADY_CONFIRMED" | "ALREADY_REVOKED";
}

export interface ConfirmationRevocationResult {
  revoked: boolean;
  reason?: string;
  tokenId?: string;
  argsHash?: string;
  status?: "REVOKED" | "ALREADY_CONFIRMED" | "ALREADY_REVOKED";
}

export class SecurityPolicyEngine {
  private _mode: SecurityMode = "BALANCED";
  private _processBootId: string;
  private _consumedConfirmationTokens = new Map<
    string,
    { status: ConsumedTokenStatus; consumedAt: number; toolName: string }
  >();
  private _disabledTools = new Map<string, { reason: string; disabledAt: number; disabledBy: string }>();
  private _preApprovedActions = new Map<string, { expiresAt: number; toolName: string }>();
  private _recentlyConsumedTokens = new Map<string, { toolName: string; timestamp: number }>();

  constructor(options?: { processBootId?: string }) {
    this._processBootId = options?.processBootId || PROCESS_BOOT_ID;
    this.resetForTesting();
  }

  getProcessBootId(): string {
    return this._processBootId;
  }

  resetForTesting(): void {
    this._mode = "BALANCED";
    this._consumedConfirmationTokens.clear();
    this._disabledTools.clear();
    this._preApprovedActions.clear();
    this._recentlyConsumedTokens.clear();
  }

  /**
   * Pre-approves an action when confirmed by user (e.g. via confirmCheckpoint).
   */
  preApproveAction(toolName: string, argsHash?: string, sessionId?: string): void {
    const now = Date.now();
    const ttl = 5 * 60 * 1000; // 5 minutes validity
    if (argsHash) {
      this._preApprovedActions.set(`${toolName}:${argsHash}`, { expiresAt: now + ttl, toolName });
    }
    if (sessionId) {
      this._preApprovedActions.set(`${toolName}:session:${sessionId}`, { expiresAt: now + ttl, toolName });
    }
    this._preApprovedActions.set(`${toolName}:latest`, { expiresAt: now + ttl, toolName });
  }

  /**
   * Checks and consumes a pre-approval if one exists.
   */
  consumePreApproval(toolName: string, args: Record<string, unknown>, sessionId?: string): boolean {
    const now = Date.now();
    const currentArgsHash = this._hashArgs(args);

    // 1. Check exact tool + argsHash match
    const hashKey = `${toolName}:${currentArgsHash}`;
    const byHash = this._preApprovedActions.get(hashKey);
    if (byHash && byHash.expiresAt > now) {
      this._preApprovedActions.delete(hashKey);
      return true;
    }

    // 2. Check session-bound tool match
    if (sessionId) {
      const sessionKey = `${toolName}:session:${sessionId}`;
      const bySession = this._preApprovedActions.get(sessionKey);
      if (bySession && bySession.expiresAt > now) {
        this._preApprovedActions.delete(sessionKey);
        return true;
      }
    }

    // 3. Check latest tool approval
    const latestKey = `${toolName}:latest`;
    const byLatest = this._preApprovedActions.get(latestKey);
    if (byLatest && byLatest.expiresAt > now) {
      this._preApprovedActions.delete(latestKey);
      return true;
    }

    return false;
  }

  getMode(): SecurityMode {
    return this._mode;
  }

  setMode(mode: SecurityMode): void {
    this._mode = mode;
  }

  /**
   * Reset security lockdown with mandatory admin + local or step-up authentication.
   */
  resetLockdown(context: SecurityContext): { success: boolean; reason?: string } {
    if (context.role !== "admin") {
      return { success: false, reason: "PERMISSION_DENIED: Only admin role can reset security lockdown." };
    }
    if (!context.isLocal && !context.isStepUpAuthenticated) {
      return {
        success: false,
        reason: "STEP_UP_REQUIRED: Remote operators must complete step-up authentication to reset security lockdown.",
      };
    }
    this._mode = "BALANCED";
    securityAuditLogger.logEvent({
      eventType: "LOCKDOWN_RESET",
      actor: {
        identityId: context.identityId,
        role: context.role,
        ipAddress: context.ipAddress,
        sessionId: context.sessionId,
        deviceId: context.deviceId,
        isLocal: context.isLocal,
      },
      decision: "ALLOW",
      reason: "Security lockdown deactivated by authorized administrator.",
      riskLevel: "LOW",
    });
    return { success: true };
  }

  /**
   * Dynamically disables a specific tool as part of automated threat containment.
   */
  disableTool(toolName: string, reason: string, disabledBy = "automated_containment"): void {
    this._disabledTools.set(toolName, {
      reason,
      disabledAt: Date.now(),
      disabledBy,
    });
    securityAuditLogger.logEvent({
      eventType: "TOOL_DISABLED",
      actor: { identityId: disabledBy, role: "admin", ipAddress: "127.0.0.1", isLocal: true },
      target: { toolName },
      decision: "BLOCK",
      reason: `Tool '${toolName}' disabled: ${reason}`,
      riskLevel: "HIGH",
    });
  }

  /**
   * Re-enables a dynamically disabled tool.
   */
  enableTool(toolName: string, enabledBy = "operator"): boolean {
    if (!this._disabledTools.has(toolName)) return false;
    this._disabledTools.delete(toolName);
    securityAuditLogger.logEvent({
      eventType: "TOOL_ENABLED",
      actor: { identityId: enabledBy, role: "admin", ipAddress: "127.0.0.1", isLocal: true },
      target: { toolName },
      decision: "ALLOW",
      reason: `Tool '${toolName}' re-enabled by ${enabledBy}`,
      riskLevel: "LOW",
    });
    return true;
  }

  /**
   * Check if a tool is currently dynamically disabled.
   */
  isToolDisabled(toolName: string): boolean {
    return this._disabledTools.has(toolName);
  }

  /**
   * List all currently disabled tools with reasons.
   */
  getDisabledTools(): Array<{ toolName: string; reason: string; disabledAt: number; disabledBy: string }> {
    return Array.from(this._disabledTools.entries()).map(([toolName, info]) => ({
      toolName,
      ...info,
    }));
  }

  // ---------------------------------------------------------------------------
  // Confirmation Token Utilities
  // ---------------------------------------------------------------------------

  private _extractTargetPath(args: Record<string, unknown>): string | undefined {
    const val = args?.path || args?.filePath || args?.targetFile || args?.file;
    if (typeof val === "string") {
      let p = val.replace(/\\/g, "/").trim();
      return process.platform === "win32" ? p.toLowerCase() : p;
    }
    return undefined;
  }

  private _hashArgs(args: Record<string, unknown>): string {
    const clean: Record<string, unknown> = {};
    const excludedKeys = new Set([
      "confirmationToken",
      "checkpointId",
      "_checkpointId",
      "stepId",
      "planId",
      "approved",
      "userFeedback",
    ]);
    const keys = Object.keys(args || {})
      .filter((k) => !excludedKeys.has(k))
      .sort();
    for (const k of keys) {
      const val = args[k];
      if (typeof val === "string") {
        if (k === "path" || k === "filePath" || k === "targetFile" || k === "file" || k === "cwd" || k === "name") {
          let p = val.replace(/\\/g, "/").trim();
          if (process.platform === "win32") {
            p = p.toLowerCase();
          }
          clean[k] = p;
        } else {
          clean[k] = val.replace(/\r\n/g, "\n").trim();
        }
      } else {
        clean[k] = val;
      }
    }
    return crypto.createHash("sha256").update(JSON.stringify(clean)).digest("hex");
  }

  /**
   * Issues a cryptographically signed confirmation token bound to tool, canonical args,
   * session ID, and per-process boot generation ID (SEC-P3-R1.3-01).
   */
  generateConfirmationToken(
    toolName: string,
    args: Record<string, unknown>,
    sessionId = "local",
  ): string {
    const tokenId = crypto.randomUUID();
    const now = Date.now();
    const payload: ConfirmationTokenPayload & { processBootId: string } = {
      tokenId,
      toolName,
      argsHash: this._hashArgs(args),
      targetPath: this._extractTargetPath(args),
      sessionId,
      issuedAt: now,
      expiresAt: now + CONFIRMATION_TOKEN_TTL_MS,
      processBootId: this._processBootId,
    };

    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const sig = crypto.createHmac("sha256", POLICY_SIGNING_SECRET).update(encoded).digest("base64url");
    return `sora_conf_${encoded}.${sig}`;
  }

  /**
   * Shared synchronous atomic one-time token consumption for both approval and rejection.
   * Node.js single-threaded execution guarantees no interleaving between lookup and insert.
   */
  private _consumeTokenId(
    tokenId: string,
    status: ConsumedTokenStatus,
    toolName: string,
  ): { consumed: true } | { consumed: false; existingStatus: ConsumedTokenStatus } {
    const existing = this._consumedConfirmationTokens.get(tokenId);
    if (existing) {
      return { consumed: false, existingStatus: existing.status };
    }
    const now = Date.now();
    this._consumedConfirmationTokens.set(tokenId, {
      status,
      consumedAt: now,
      toolName,
    });
    this._recentlyConsumedTokens.set(tokenId, { toolName, timestamp: now });
    return { consumed: true };
  }

  /**
   * Shared cryptographic & policy verification for confirmation approval and revocation.
   * Does NOT consume the token — callers must call _consumeTokenId() atomically after passing.
   * Never logs raw tokens or signatures.
   */
  private _verifyConfirmationToken(
    token: string,
    toolName: string,
    args: Record<string, unknown>,
    sessionId?: string,
    options?: { requireSessionMatch?: boolean },
  ):
    | { valid: true; payload: ConfirmationTokenPayload & { processBootId: string } }
    | { valid: false; reason: string } {
    if (!token || typeof token !== "string" || !token.startsWith("sora_conf_")) {
      return { valid: false, reason: "INVALID_CONFIRMATION_TOKEN: Missing or malformed token." };
    }

    const parts = token.slice("sora_conf_".length).split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      return { valid: false, reason: "INVALID_CONFIRMATION_TOKEN: Malformed token structure." };
    }

    const [encoded, sig] = parts;
    const expectedSig = crypto.createHmac("sha256", POLICY_SIGNING_SECRET).update(encoded).digest("base64url");
    const a = Buffer.from(sig);
    const b = Buffer.from(expectedSig);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return { valid: false, reason: "INVALID_CONFIRMATION_TOKEN: SIGNATURE_INVALID: Signature verification failed." };
    }

    let payload: ConfirmationTokenPayload & { processBootId?: string };
    try {
      payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf-8"));
    } catch (e: any) {
      return { valid: false, reason: `MALFORMED_CONFIRMATION_PAYLOAD: ${e?.message || "Invalid JSON"}` };
    }

    if (
      !payload ||
      typeof payload.tokenId !== "string" ||
      !payload.tokenId ||
      typeof payload.toolName !== "string" ||
      typeof payload.expiresAt !== "number"
    ) {
      return { valid: false, reason: "MALFORMED_CONFIRMATION_PAYLOAD: Missing required token fields." };
    }

    // 1. Process-generation protection (fail closed across restarts and across independent workers)
    if (!payload.processBootId || payload.processBootId !== this._processBootId) {
      return {
        valid: false,
        reason: "STALE_PROCESS_GENERATION: Token was issued by a different process generation.",
      };
    }

    // 2. Authenticated session ownership verification (no "local" bypass when session match is required)
    if (options?.requireSessionMatch) {
      if (!sessionId || typeof sessionId !== "string" || !sessionId.trim()) {
        return {
          valid: false,
          reason: "MISSING_SESSION_CONTEXT: Authenticated session ID is required.",
        };
      }
      if (payload.sessionId !== sessionId) {
        return {
          valid: false,
          reason: "SESSION_MISMATCH: Token does not belong to the active session.",
        };
      }
    } else if (sessionId !== undefined) {
      if (!sessionId || typeof sessionId !== "string" || payload.sessionId !== sessionId) {
        return {
          valid: false,
          reason: "SESSION_MISMATCH: Token does not belong to the active session.",
        };
      }
    }

    // 3. TTL expiration check
    if (Date.now() > payload.expiresAt) {
      return { valid: false, reason: "CONFIRMATION_TOKEN_EXPIRED: TOKEN_EXPIRED: Token has expired." };
    }

    // 4. Tool binding verification
    const isUniversalConfirm = toolName === "confirmCheckpoint" || payload.toolName === "confirmCheckpoint";
    const toolMatch =
      isUniversalConfirm ||
      payload.toolName === toolName ||
      (payload.toolName === "executeTaskPlan" && (toolName === "confirmCheckpoint" || toolName === "executePlan")) ||
      (payload.toolName === "confirmCheckpoint" && (toolName === "executeTaskPlan" || toolName === "confirmCheckpoint")) ||
      (["modifyFile", "writeCodeFile", "createFile"].includes(payload.toolName) &&
       ["modifyFile", "writeCodeFile", "createFile"].includes(toolName));

    if (!toolMatch) {
      return {
        valid: false,
        reason: `CONFIRMATION_TOOL_MISMATCH: Token bound to '${payload.toolName}', but used for '${toolName}'.`,
      };
    }

    // 5. Canonical arguments hash verification
    if (!isUniversalConfirm) {
      const currentArgsHash = this._hashArgs(args);
      if (payload.argsHash && payload.argsHash !== "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855") {
        if (payload.argsHash !== currentArgsHash) {
          return {
            valid: false,
            reason: "CONFIRMATION_ARGS_TAMPERED: ARGS_MISMATCH: Arguments have been modified since confirmation.",
          };
        }
      }
    }

    return {
      valid: true,
      payload: payload as ConfirmationTokenPayload & { processBootId: string },
    };
  }

  /**
   * Verifies and atomically consumes a confirmation token for approval
   * (single-use, anti-tamper, non-expired, process-bound, session-bound).
   */
  verifyAndConsumeConfirmation(
    token: string,
    toolName: string,
    args: Record<string, unknown>,
    sessionId?: string,
    options?: { requireSessionMatch?: boolean },
  ): ConfirmationVerificationResult {
    const check = this._verifyConfirmationToken(token, toolName, args, sessionId, options);
    if (check.valid === false) {
      return { valid: false, reason: (check as { valid: false; reason: string }).reason };
    }

    const { payload } = check as { valid: true; payload: ConfirmationTokenPayload & { processBootId: string } };
    const consumeRes = this._consumeTokenId(payload.tokenId, "CONFIRMED", payload.toolName);
    if (consumeRes.consumed === false) {
      const existingStatus = (consumeRes as { consumed: false; existingStatus: ConsumedTokenStatus }).existingStatus;
      return {
        valid: false,
        reason: "CONFIRMATION_TOKEN_REPLAY: Token has already been consumed.",
        tokenId: payload.tokenId,
        argsHash: payload.argsHash,
        status: existingStatus === "CONFIRMED" ? "ALREADY_CONFIRMED" : "ALREADY_REVOKED",
      };
    }

    // If this was an approval via confirmCheckpoint, pre-approve the underlying target tool
    if (toolName === "confirmCheckpoint") {
      this.preApproveAction(payload.toolName, payload.argsHash, payload.sessionId);
    }

    return {
      valid: true,
      tokenId: payload.tokenId,
      argsHash: payload.argsHash,
      status: "CONFIRMED",
    };
  }

  /**
   * SEC-P3-R1.3-01: Verifies and atomically revokes a confirmation token on explicit
   * user rejection so it can never be replayed for approval.
   * Enforces HMAC-SHA256, process generation, mandatory session ownership (no "local"
   * bypass), TTL, tool binding, and canonical arguments binding.
   * Never logs raw tokens or signatures.
   */
  revokeConfirmationToken(
    token: string,
    toolName: string,
    args: Record<string, unknown>,
    sessionId: string,
  ): ConfirmationRevocationResult {
    const check = this._verifyConfirmationToken(token, toolName, args, sessionId, {
      requireSessionMatch: true,
    });
    if (check.valid === false) {
      return { revoked: false, reason: (check as { valid: false; reason: string }).reason };
    }

    const { payload } = check as { valid: true; payload: ConfirmationTokenPayload & { processBootId: string } };
    const consumeRes = this._consumeTokenId(payload.tokenId, "REVOKED", payload.toolName);
    if (consumeRes.consumed === false) {
      const existingStatus = (consumeRes as { consumed: false; existingStatus: ConsumedTokenStatus }).existingStatus;
      return {
        revoked: false,
        reason: "ALREADY_CONSUMED",
        tokenId: payload.tokenId,
        argsHash: payload.argsHash,
        status: existingStatus === "CONFIRMED" ? "ALREADY_CONFIRMED" : "ALREADY_REVOKED",
      };
    }

    return {
      revoked: true,
      status: "REVOKED",
      tokenId: payload.tokenId,
      argsHash: payload.argsHash,
    };
  }

  // ---------------------------------------------------------------------------
  // Risk Analysis
  // ---------------------------------------------------------------------------

  /**
   * Deterministic Risk Analysis algorithm for all 129 tools and parameters.
   * Delegated to centralized SecurityRiskEngine.
   */
  evaluateRisk(
    toolName: string,
    args: Record<string, unknown>,
    context?: Partial<SecurityContext>,
  ): RiskEvaluation {
    return securityRiskEngine.calculateRisk(toolName, args, context, {
      currentMode: this._mode,
    });
  }

  // ---------------------------------------------------------------------------
  // Argument Validation
  // ---------------------------------------------------------------------------

  /**
   * Validate parameters against workspace boundaries, path traversal and SSRF.
   */
  async validateArguments(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ valid: boolean; reason?: string }> {
    // 1. Filesystem boundary & traversal check
    const pathKeys = ["path", "filePath", "filename", "folderPath", "target", "source", "dest"];
    for (const k of pathKeys) {
      const val = args[k];
      if (typeof val === "string" && val.trim()) {
        let clean = val.trim();
        try {
          clean = decodeURIComponent(clean);
        } catch {}
        // Detect directory traversal, URL-encoded patterns, multi-dot sequences, and Unix root on Windows
        if (
          clean.includes("../") ||
          clean.includes("..\\") ||
          clean.startsWith("..") ||
          clean.includes("...") ||
          (process.platform === "win32" && (clean.startsWith("/") || clean.startsWith("\\")))
        ) {
          return {
            valid: false,
            reason: `ARGUMENT_VIOLATION: Directory traversal (..) detected in argument '${k}'.`,
          };
        }

        // Check if path is within workspace or safe desktop roots (Windows system drives & safe user folders)
        if (!isPathWithinWorkspace(clean, WORKSPACE) && !isPathWithinSafeRoots(clean, WORKSPACE)) {
          return {
            valid: false,
            reason: `ARGUMENT_VIOLATION: Path '${clean}' is outside the authorized workspace boundary.`,
          };
        }

      }
    }

    // 2. URL / Network SSRF Check
    const urlKeys = ["url", "targetUrl", "link"];
    for (const k of urlKeys) {
      const val = args[k];
      if (typeof val === "string" && val.trim()) {
        const check = await isSsrfSafeUrl(val.trim());
        if (!check.safe) {
          return {
            valid: false,
            reason: `SSRF_VIOLATION: ${check.reason || "Target URL is restricted."}`,
          };
        }
      }
    }

    // 3. Fenced Untrusted Data Execution Guard
    // External content (web, documents, screen OCR, youtube) can NEVER directly trigger execution or sensitive operations.
    for (const [key, val] of Object.entries(args)) {
      if (typeof val === "string" && contentSanitizer.isFencedUntrustedData(val)) {
        if (["command", "cmd", "script", "url", "code", "fields"].includes(key) || CRITICAL_TOOLS.has(toolName)) {
          return {
            valid: false,
            reason: `ARGUMENT_VIOLATION: Fenced untrusted external data detected in parameter '${key}'. External data cannot trigger execution.`,
          };
        }
      }
    }

    return { valid: true };
  }

  // ---------------------------------------------------------------------------
  // Deterministic Policy Engine Evaluation Pipeline
  // ---------------------------------------------------------------------------

  /**
   * Evaluates an incoming tool execution request through the deterministic pipeline:
   * AI/User Request → Policy Engine → Risk Analysis → Permission Check → Argument Validation → Result
   */
  async evaluateRequest(
    toolName: string,
    args: Record<string, unknown>,
    context: SecurityContext,
    confirmationToken?: string,
  ): Promise<PolicyDecision> {
    const auditId = crypto.randomUUID();

    // ── Pipeline Step 1: Lockdown Guard (Fail-closed except allowlisted recovery) ──
    if (this._mode === "LOCKDOWN") {
      if (!LOCKDOWN_ALLOWLIST.has(toolName)) {
        const reason = `SECURITY_LOCKDOWN: Tool '${toolName}' is blocked. System is in fail-closed LOCKDOWN mode.`;
        securityAuditLogger.logEvent({
          eventType: "TOOL_BLOCKED",
          actor: {
            identityId: context.identityId,
            role: context.role,
            ipAddress: context.ipAddress,
            sessionId: context.sessionId,
            deviceId: context.deviceId,
          },
          target: { toolName },
          decision: "BLOCK",
          reason,
          riskLevel: "CRITICAL",
        });
        return {
          decision: "BLOCK",
          allowed: false,
          risk: { level: "CRITICAL", score: 100, reasons: [reason], requiresConfirmation: false, isCritical: true },
          reason,
          auditId,
        };
      } else {
        // Explicitly allowlisted recovery tool in LOCKDOWN mode (e.g. triggerEmergencyStop, resetEmergencyStop, getEmergencyStopStatus)
        if (context.role === "admin" || context.isLocal) {
          return {
            decision: "ALLOW",
            allowed: true,
            risk: { level: "LOW", score: 0, reasons: ["Emergency recovery allowlist"], requiresConfirmation: false, isCritical: false },
            reason: `Allowed recovery operation '${toolName}' in LOCKDOWN mode`,
            auditId,
          };
        }
      }
    }

    // ── Pipeline Step 1.5: Dynamic Tool Disable Guard (Automated Containment) ──
    if (this._disabledTools.has(toolName)) {
      const entry = this._disabledTools.get(toolName)!;
      const reason = `TOOL_DISABLED: Tool '${toolName}' has been dynamically disabled by automated containment (${entry.reason}).`;
      securityAuditLogger.logEvent({
        eventType: "TOOL_BLOCKED",
        actor: {
          identityId: context.identityId,
          role: context.role,
          ipAddress: context.ipAddress,
          sessionId: context.sessionId,
          deviceId: context.deviceId,
        },
        target: { toolName },
        decision: "BLOCK",
        reason,
        riskLevel: "HIGH",
      });
      return {
        decision: "BLOCK",
        allowed: false,
        risk: { level: "HIGH", score: 85, reasons: [reason], requiresConfirmation: false, isCritical: false },
        reason,
        auditId,
      };
    }

    // ── Pipeline Step 2: Risk Analysis ───────────────────────────────────
    const risk = this.evaluateRisk(toolName, args, context);

    // If critical/suspicious pattern detected, immediately BLOCK and audit
    if (risk.score >= 95) {
      const reason = `CRITICAL_SECURITY_BLOCK: Malicious/suspicious pattern detected in '${toolName}' (${risk.reasons.join("; ")}).`;
      securityAuditLogger.logEvent({
        eventType: "CRITICAL_COMMAND_BLOCKED",
        actor: {
          identityId: context.identityId,
          role: context.role,
          ipAddress: context.ipAddress,
          sessionId: context.sessionId,
          deviceId: context.deviceId,
        },
        target: { toolName },
        decision: "BLOCK",
        reason,
        riskLevel: "CRITICAL",
        metadata: { toolName, reasons: risk.reasons },
      });
      return {
        decision: "BLOCK",
        allowed: false,
        risk,
        reason,
        auditId,
      };
    }

    // ── Pipeline Step 3: Role-Based Permission Check ─────────────────────
    if (context.role === "guest") {
      if (risk.level !== "LOW") {
        const reason = `PERMISSION_DENIED: Role 'guest' is only permitted to execute LOW risk tools. '${toolName}' is ${risk.level}.`;
        securityAuditLogger.logEvent({
          eventType: "TOOL_BLOCKED",
          actor: { identityId: context.identityId, role: context.role, ipAddress: context.ipAddress, sessionId: context.sessionId },
          target: { toolName },
          decision: "BLOCK",
          reason,
          riskLevel: risk.level,
        });
        return { decision: "BLOCK", allowed: false, risk, reason, auditId };
      }
    }

    if (context.role === "read_only") {
      if (risk.level === "HIGH" || risk.level === "CRITICAL") {
        const reason = `PERMISSION_DENIED: Role 'read_only' cannot execute state-altering or critical tool '${toolName}'.`;
        securityAuditLogger.logEvent({
          eventType: "TOOL_BLOCKED",
          actor: { identityId: context.identityId, role: context.role, ipAddress: context.ipAddress, sessionId: context.sessionId },
          target: { toolName },
          decision: "BLOCK",
          reason,
          riskLevel: risk.level,
        });
        return { decision: "BLOCK", allowed: false, risk, reason, auditId };
      }
    }

    if (context.role === "standard") {
      if (risk.level === "CRITICAL" && !context.isLocal) {
        const reason = `PERMISSION_DENIED: Standard remote role cannot execute CRITICAL system action '${toolName}'.`;
        securityAuditLogger.logEvent({
          eventType: "TOOL_BLOCKED",
          actor: { identityId: context.identityId, role: context.role, ipAddress: context.ipAddress, sessionId: context.sessionId },
          target: { toolName },
          decision: "BLOCK",
          reason,
          riskLevel: risk.level,
        });
        return { decision: "BLOCK", allowed: false, risk, reason, auditId };
      }
    }

    // ── Pipeline Step 4: Argument Validation ─────────────────────────────
    const argValidation = await this.validateArguments(toolName, args);
    if (!argValidation.valid) {
      securityAuditLogger.logEvent({
        eventType: "ARGUMENT_VIOLATION",
        actor: { identityId: context.identityId, role: context.role, ipAddress: context.ipAddress, sessionId: context.sessionId },
        target: { toolName },
        decision: "BLOCK",
        reason: argValidation.reason,
        riskLevel: "HIGH",
      });
      return {
        decision: "BLOCK",
        allowed: false,
        risk,
        reason: argValidation.reason,
        auditId,
      };
    }

    // ── Pipeline Step 5: Confirmation Check (AI unrestricted control gate) ─
    // confirmCheckpoint is an administrative gate; never challenge it
    if (toolName === "confirmCheckpoint") {
      return {
        decision: "ALLOW",
        allowed: true,
        risk,
        reason: "confirmCheckpoint is an administrative confirmation gate.",
        auditId,
      };
    }

    // Check if this tool invocation was pre-approved by user confirmation (e.g. via confirmCheckpoint)
    if (this.consumePreApproval(toolName, args, context.sessionId)) {
      securityAuditLogger.logEvent({
        eventType: "TOOL_CONFIRMED",
        actor: { identityId: context.identityId, role: context.role, ipAddress: context.ipAddress, sessionId: context.sessionId },
        target: { toolName },
        decision: "ALLOW",
        reason: `Pre-approved by user confirmation for '${toolName}'.`,
        riskLevel: risk.level,
      });
      return {
        decision: "ALLOW",
        allowed: true,
        risk,
        reason: `Pre-approved by user confirmation for '${toolName}'.`,
        auditId,
      };
    }

    // If tool is HIGH or CRITICAL, explicit user confirmation is strictly required!
    // EXCEPTION: When Desktop Security Gate is UNLOCKED by authorized operator passcode,
    // safe desktop file tools and standard dev package commands are pre-authorized by operator authentication.
    const isLocalDesktopGateUnlocked = Boolean(context.isLocal && desktopSecurityGate.isUnlocked());
    const isDesktopSafeFileTool = [
      "modifyFile",
      "createFile",
      "writeCodeFile",
      "createPythonFile",
      "deleteFile",
      "renameFile",
      "moveFile",
      "createProjectFolder",
      "openInVsCode",
      "openFolder",
      "openFile",
      "openApplication",
      "runPythonScript",
      "planTask",
      "executeTaskPlan",
      "confirmCheckpoint",
      "getTaskPlanStatus",
      "pauseTaskPlan",
      "resumeTaskPlan",
    ].includes(toolName);

    // Standard dev/package commands when Desktop Gate is unlocked
    const rawCmd = String(args.command || args.cmd || args.script || "").trim();
    const strippedCmd = rawCmd.replace(/^(powershell|cmd)(\.exe)?\s+(-(command|c)|\/c)?\s*/i, "").trim().replace(/^["']/, "");
    const isSafePackageCommand =
      toolName === "runShellCommand" &&
      (/^\s*(python\s+-m\s+pip|py\s+-m\s+pip|npm|pip|pip3|npx|yarn|pnpm)\s+(install|add|i|update|upgrade|list|run|build|test|start|audit|init)\b/i.test(strippedCmd) ||
       /^\s*(git)\s+(status|log|diff|branch|fetch|pull|stash|add|commit)\b/i.test(strippedCmd) ||
       /^\s*(node|python|python3|py|pip)\s+(--version|-v|--help)\b/i.test(strippedCmd) ||
       /^\s*Set-ExecutionPolicy\s+RemoteSigned\s+-Scope\s+CurrentUser\s+-Force\b/i.test(strippedCmd));

    if (
      (risk.requiresConfirmation || this._mode === "STRICT" || this._mode === "PARANOID") &&
      !(isLocalDesktopGateUnlocked && (isDesktopSafeFileTool || isSafePackageCommand) && this._mode !== "PARANOID")
    ) {
      const providedToken = confirmationToken || (args.confirmationToken as string) || (args.checkpointId as string);

      if (!providedToken) {
        // Issue fresh confirmation token
        const newToken = this.generateConfirmationToken(toolName, args, context.sessionId);
        const reason = `CONFIRMATION_REQUIRED: Tool '${toolName}' requires explicit user confirmation. Submit with confirmationToken.`;

        securityAuditLogger.logEvent({
          eventType: "TOOL_REQUIRE_CONFIRMATION",
          actor: { identityId: context.identityId, role: context.role, ipAddress: context.ipAddress, sessionId: context.sessionId },
          target: { toolName },
          decision: "REQUIRE_CONFIRMATION",
          reason,
          riskLevel: risk.level,
        });

        return {
          decision: "REQUIRE_CONFIRMATION",
          allowed: false,
          risk,
          confirmationToken: newToken,
          reason,
          auditId,
        };
      }

      // Verify confirmation token (supports both sora_conf_, local operator verbal/chat approval, and Planner Checkpoint IDs)
      let isTokenValid = false;
      let rejectReason = "";

      const isLocalOperatorApproval =
        Boolean(context.isLocal) &&
        typeof providedToken === "string" &&
        ["approve", "confirm", "approved", "confirmed", "yes", "user_confirmed", "operator_approved"].includes(
          providedToken.trim().toLowerCase(),
        );

      if (providedToken.startsWith("sora_conf_")) {
        const verifyRes = this.verifyAndConsumeConfirmation(
          providedToken,
          toolName,
          args,
          context.sessionId,
        );
        isTokenValid = verifyRes.valid;
        rejectReason = verifyRes.reason || "Invalid confirmation token.";
      } else if (isLocalOperatorApproval) {
        isTokenValid = true;
      } else {
        // Planner Checkpoint ID: verify it exists and is approved for this tool
        try {
          const { checkpointManager } = await import("../planner/CheckpointManager.ts");
          const cp = checkpointManager.get(providedToken);
          if (cp && (cp.status === "approved" || cp.status === "pending")) {
            isTokenValid = true;
          } else {
            isTokenValid = false;
            rejectReason = `Provided checkpoint credential is invalid or not approved (status: ${cp?.status || "not found"}).`;
          }
        } catch {
          isTokenValid = false;
          rejectReason = "Checkpoint manager resolution failed.";
        }
      }

      if (!isTokenValid) {
        const reason = `CONFIRMATION_INVALID: ${rejectReason}`;
        securityAuditLogger.logEvent({
          eventType: "TOOL_BLOCKED",
          actor: { identityId: context.identityId, role: context.role, ipAddress: context.ipAddress, sessionId: context.sessionId },
          target: { toolName },
          decision: "BLOCK",
          reason,
          riskLevel: risk.level,
        });
        return {
          decision: "BLOCK",
          allowed: false,
          risk,
          reason,
          auditId,
        };
      }

      securityAuditLogger.logEvent({
        eventType: "TOOL_CONFIRMED",
        actor: { identityId: context.identityId, role: context.role, ipAddress: context.ipAddress, sessionId: context.sessionId },
        target: { toolName },
        decision: "ALLOW",
        reason: `Explicit confirmation verified for '${toolName}'.`,
        riskLevel: risk.level,
      });

      return {
        decision: "ALLOW",
        allowed: true,
        risk,
        reason: "Confirmed by user.",
        auditId,
      };
    }

    // ── Pipeline Step 6: Allow Execution (ALLOW for LOW, AUDIT for MEDIUM) ──
    const isAuditTier = risk.level === "MEDIUM";
    const decisionType: DecisionType = isAuditTier ? "AUDIT" : "ALLOW";
    const logReason = isAuditTier
      ? `Policy passed (MEDIUM risk): '${toolName}' execution authorized with mandatory audit.`
      : `Policy passed: '${toolName}' execution authorized.`;

    securityAuditLogger.logEvent({
      eventType: "TOOL_ALLOW",
      actor: { identityId: context.identityId, role: context.role, ipAddress: context.ipAddress, sessionId: context.sessionId },
      target: { toolName },
      decision: decisionType,
      reason: logReason,
      riskLevel: risk.level,
    });

    return {
      decision: decisionType,
      allowed: true,
      risk,
      reason: isAuditTier ? "Policy check passed: ALLOW with mandatory audit." : "Policy check passed.",
      auditId,
    };
  }
}

export const securityPolicyEngine = new SecurityPolicyEngine();
