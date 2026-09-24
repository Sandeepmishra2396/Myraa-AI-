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
import { isPathWithinWorkspace, isSsrfSafeUrl } from "./PermissionManager.ts";
import { contentSanitizer } from "./ContentSanitizer.ts";

const WORKSPACE = process.env.SORA_WORKSPACE_DIR || process.cwd();
export const POLICY_SIGNING_SECRET =
  process.env.POLICY_SIGNING_SECRET ||
  process.env.MYRAA_POLICY_SECRET ||
  process.env.MYRAA_SECURITY_SECRET ||
  crypto.randomBytes(32).toString("hex");

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

export class SecurityPolicyEngine {
  private _mode: SecurityMode = "BALANCED";
  private _consumedConfirmationTokens = new Set<string>();
  private _disabledTools = new Map<string, { reason: string; disabledAt: number; disabledBy: string }>();

  constructor() {
    this.resetForTesting();
  }

  resetForTesting(): void {
    this._mode = "BALANCED";
    this._consumedConfirmationTokens.clear();
    this._disabledTools.clear();
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

  private _hashArgs(args: Record<string, unknown>): string {
    return crypto.createHash("sha256").update(JSON.stringify(args || {})).digest("hex");
  }

  /**
   * Issues a cryptographically signed confirmation token bound to tool and arguments.
   */
  generateConfirmationToken(
    toolName: string,
    args: Record<string, unknown>,
    sessionId = "local",
  ): string {
    const tokenId = crypto.randomUUID();
    const now = Date.now();
    const payload: ConfirmationTokenPayload = {
      tokenId,
      toolName,
      argsHash: this._hashArgs(args),
      sessionId,
      issuedAt: now,
      expiresAt: now + CONFIRMATION_TOKEN_TTL_MS,
    };

    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const sig = crypto.createHmac("sha256", POLICY_SIGNING_SECRET).update(encoded).digest("base64url");
    return `sora_conf_${encoded}.${sig}`;
  }

  /**
   * Verifies and consumes a confirmation token (ensures single-use, anti-tamper, non-expired).
   */
  verifyAndConsumeConfirmation(
    token: string,
    toolName: string,
    args: Record<string, unknown>,
    sessionId?: string,
  ): { valid: boolean; reason?: string } {
    if (!token || !token.startsWith("sora_conf_")) {
      return { valid: false, reason: "INVALID_CONFIRMATION_TOKEN: Missing or malformed token." };
    }

    const parts = token.slice("sora_conf_".length).split(".");
    if (parts.length !== 2) {
      return { valid: false, reason: "INVALID_CONFIRMATION_TOKEN: Malformed token structure." };
    }

    const [encoded, sig] = parts;
    const expectedSig = crypto.createHmac("sha256", POLICY_SIGNING_SECRET).update(encoded).digest("base64url");
    const a = Buffer.from(sig);
    const b = Buffer.from(expectedSig);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return { valid: false, reason: "INVALID_CONFIRMATION_TOKEN: Signature verification failed." };
    }

    try {
      const payload: ConfirmationTokenPayload = JSON.parse(
        Buffer.from(encoded, "base64url").toString("utf-8"),
      );

      // Check replay
      if (this._consumedConfirmationTokens.has(payload.tokenId)) {
        return { valid: false, reason: "CONFIRMATION_TOKEN_REPLAY: Token has already been consumed." };
      }

      // Check expiration
      if (Date.now() > payload.expiresAt) {
        return { valid: false, reason: "CONFIRMATION_TOKEN_EXPIRED: Token has expired." };
      }

      // Check tool binding
      if (payload.toolName !== toolName) {
        return {
          valid: false,
          reason: `CONFIRMATION_TOOL_MISMATCH: Token bound to '${payload.toolName}', but used for '${toolName}'.`,
        };
      }

      // Check arguments hash
      const currentArgsHash = this._hashArgs(args);
      if (payload.argsHash !== currentArgsHash) {
        return {
          valid: false,
          reason: "CONFIRMATION_ARGS_TAMPERED: Arguments have been modified since confirmation.",
        };
      }

      // Mark consumed
      this._consumedConfirmationTokens.add(payload.tokenId);
      return { valid: true };
    } catch (e: any) {
      return { valid: false, reason: `MALFORMED_CONFIRMATION_PAYLOAD: ${e.message}` };
    }
  }

  // ---------------------------------------------------------------------------
  // Risk Analysis
  // ---------------------------------------------------------------------------

  /**
   * Deterministic Risk Analysis algorithm for all 126 tools and parameters.
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
        const clean = val.trim();
        // Detect directory traversal
        if (clean.includes("../") || clean.includes("..\\") || clean.startsWith("..")) {
          return {
            valid: false,
            reason: `ARGUMENT_VIOLATION: Directory traversal (..) detected in argument '${k}'.`,
          };
        }

        // Check if path is within workspace
        if (!isPathWithinWorkspace(clean, WORKSPACE)) {
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
    // If tool is HIGH or CRITICAL, explicit user confirmation is strictly required!
    if (risk.requiresConfirmation || this._mode === "STRICT" || this._mode === "PARANOID") {
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

      // Verify confirmation token (supports both sora_conf_ and Planner Checkpoint IDs)
      let isTokenValid = false;
      let rejectReason = "";

      if (providedToken.startsWith("sora_conf_")) {
        const verifyRes = this.verifyAndConsumeConfirmation(
          providedToken,
          toolName,
          args,
          context.sessionId,
        );
        isTokenValid = verifyRes.valid;
        rejectReason = verifyRes.reason || "Invalid confirmation token.";
      } else {
        // Planner Checkpoint ID: verify it exists and is approved for this tool
        try {
          const { checkpointManager } = await import("../planner/CheckpointManager.ts");
          const cp = checkpointManager.get(providedToken);
          if (cp && (cp.status === "approved" || cp.status === "pending") && cp.toolName === toolName) {
            isTokenValid = true;
          } else {
            isTokenValid = false;
            rejectReason = `Checkpoint '${providedToken}' is invalid or not approved (status: ${cp?.status || "not found"}).`;
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
