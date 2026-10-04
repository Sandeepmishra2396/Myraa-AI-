/**
 * MYRAA — SecurityRiskEngine (Phase 10E)
 *
 * Centralized, deterministic risk engine used by the Tool Execution Firewall:
 *   • Evaluates 7 deterministic factors:
 *       1. Tool Sensitivity (Benign, Network/Browser, State-Altering, Critical/System)
 *       2. Operation Type (query, modify, execute, security_config)
 *       3. Authentication & Role (admin, standard, read_only, guest)
 *       4. Session / Device Trust (local, paired_trusted, remote_unpaired)
 *       5. Argument Validation & Attack Patterns (traversal, dangerous flags, protected paths, injection)
 *       6. Network Destination (loopback, public, private/restricted)
 *       7. Existing Threat State & Security Mode (BALANCED, STRICT, PARANOID, LOCKDOWN, containments)
 *   • Strictly enforces the 4-tier risk classification:
 *       LOW (0–29): Allow
 *       MEDIUM (30–59): Allow + Audit
 *       HIGH (60–84): Require Confirmation (single-use token)
 *       CRITICAL (85–100): Block + Alert + Containment
 *   • CRITICAL INVARIANT:
 *       AI must NEVER decide its own permissions or risk level.
 *       Any model-supplied risk claims, bypass parameters, or overrides in args are completely ignored.
 *   • Deterministic Repeatability:
 *       Identical inputs produce identical score and classification every time.
 */

import type {
  RiskLevel,
  RiskEvaluation,
  RiskFactors,
  OperationType,
  IdentityRole,
  SecurityMode,
  SecurityContext,
  DecisionType,
} from "./SecurityTypes.ts";
import { contentSanitizer } from "./ContentSanitizer.ts";

// ---------------------------------------------------------------------------
// Tool Risk Sensitivity Classification (All 126 Tools)
// ---------------------------------------------------------------------------

export const CRITICAL_TOOLS = new Set<string>([
  "runShellCommand",
  "executePowerAction",
  "revokeRemoteDevice",
  "triggerEmergencyStop",
  "deleteFile",
  "enableAutoStart",
  "disableAutoStart",
]);

export const HIGH_RISK_TOOLS = new Set<string>([
  "createFile",
  "modifyFile",
  "renameFile",
  "moveFile",
  "createProjectFolder",
  "writeCodeFile",
  "createPythonFile",
  "runPythonScript",
  "scheduleTask",
  "cancelBackgroundTask",
  "executeTaskPlan",
  "confirmCheckpoint",
  "requestPowerAction",
  "setVolume",
  "muteToggle",
  "setBrightness",
]);

export const MEDIUM_RISK_TOOLS = new Set<string>([
  "openWebsite",
  "desktopBrowserOpen",
  "desktopBrowserNavigate",
  "desktopBrowserClick",
  "desktopBrowserType",
  "desktopBrowserFillForm",
  "desktopBrowserOpenTab",
  "desktopBrowserCloseTab",
  "readUrl",
  "ingestKnowledge",
  "researchWeb",
  "discoverStudyVideos",
  "trackProjectTask",
  "saveCustomMemory",
  "toggleContinuousScreenContext",
  "configureCourseProfile",
  "manageSyllabus",
  "manageDailyStudySession",
  "updateCompanionPreferences",
  "generateDevicePairCode",
  "openUrl",
  // Phase 20 Browser Capabilities
  "openBrowser",
  // Phase 21 Mobile App Interaction Layer
  "interactApp",
  // Phase 22 Mobile Context Intelligence
  "mobileContext",
  // Phase 23 Mobile Screen Understanding
  "mobileScreen",
  // Phase 24 Shared MYRAA Memory
  "sharedMemory",
  // Phase 25 Cross-Device Handoff
  "handoff",
  // Phase 26 Mobile Proactive Companion
  "mobileProactive",
  // Phase 27 Mobile Autonomous Workflow
  "mobileWorkflow",
]);

// Dangerous shell command patterns (must be blocked immediately as suspicious/critical)
export const MALICIOUS_SHELL_PATTERNS = [
  /\brm\s+-[rRfF]{1,3}\b/i,
  /\bRemove-Item\s+.*-(Recurse|Force)\b/i,
  /\bdel\s+\/[fFqQsS]{1,4}\b/i,
  /\bformat\s+[A-Za-z]:/i,
  /\bdiskpart\b/i,
  /\bshutdown\s+\/[sSrR]\b/i,
  /\bStop-Computer\b/i,
  /\breg\s+(delete|add)\b/i,
  /\|\s*(bash|sh|powershell|cmd)\b/i,
  /\bInvoke-Expression\b/i,
  /\biex\s*\(/i,
  /\bpowershell.*-enc(odedCommand)?\b/i,
  /\bcurl\s+.*\|\s*sh\b/i,
  /\bwget\s+.*\|\s*sh\b/i,
  /\btype\s+.*\.env\b/i,
  /\bcat\s+.*\.env\b/i,
  /\b(passwords?|secret|token|credential)\.txt\b/i,
];

// Sensitive filenames/paths protected from inspection/modification
export const PROTECTED_PATHS = [
  /\.env(\..+)?$/i,
  /secrets?\.json$/i,
  /id_rsa/i,
  /id_ed25519/i,
  /\.ssh/i,
  /\.git[\/\\]config/i,
  /system32/i,
  /\bsam\b/i,
  /\bntds\.dit\b/i,
];

export class SecurityRiskEngine {
  /**
   * Deterministic Risk Analysis algorithm for any tool and parameters.
   * AI-supplied risk levels or bypass parameters are strictly ignored.
   */
  calculateRisk(
    toolName: string,
    args: Record<string, unknown> = {},
    context?: Partial<SecurityContext>,
    options?: { currentMode?: SecurityMode; activeContainment?: boolean },
  ): RiskEvaluation {
    const reasons: string[] = [];

    // ── 0. AI Unrestricted Control Defense ──────────────────────────────
    // Strictly strip and discard any model/caller-supplied risk override parameters
    const sanitizedArgs: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args || {})) {
      if (["riskLevel", "risk", "permission", "decision", "bypassRisk", "overrideSecurity"].includes(key)) {
        reasons.push(`Model-supplied parameter '${key}' was rejected; permissions are non-delegable.`);
        continue;
      }
      sanitizedArgs[key] = value;
    }

    // ── 1. Factor 1: Tool Sensitivity ──────────────────────────────────
    let toolCat: "benign" | "network_browser" | "state_altering" | "critical_system" = "benign";
    let baseScore = 15;

    if (CRITICAL_TOOLS.has(toolName)) {
      toolCat = "critical_system";
      baseScore = 90;
      reasons.push(`Tool '${toolName}' performs irreversible, system-level or administrative actions.`);
    } else if (HIGH_RISK_TOOLS.has(toolName)) {
      toolCat = "state_altering";
      baseScore = 70;
      reasons.push(`Tool '${toolName}' alters filesystem, writes code, or modifies system state.`);
    } else if (MEDIUM_RISK_TOOLS.has(toolName)) {
      toolCat = "network_browser";
      baseScore = 40;
      reasons.push(`Tool '${toolName}' interacts with external network, browser or context.`);
    } else {
      toolCat = "benign";
      baseScore = 15;
      reasons.push(`Tool '${toolName}' is read-only, informational or benign.`);
    }

    // ── 2. Factor 2: Operation Type ────────────────────────────────────
    let opType: OperationType = "query";
    let opScore = 0;
    if (["revokeRemoteDevice", "enableAutoStart", "disableAutoStart", "resetLockdown"].includes(toolName)) {
      opType = "security_config";
      opScore = 15;
    } else if (["runShellCommand", "runPythonScript", "executePowerAction", "executeTaskPlan"].includes(toolName)) {
      opType = "execute";
      opScore = 10;
    } else if (["createFile", "modifyFile", "renameFile", "moveFile", "deleteFile", "writeCodeFile", "createPythonFile"].includes(toolName)) {
      opType = "modify";
      opScore = 5;
    }

    // ── 3. Factor 3: Authentication & Role ──────────────────────────────
    const role: IdentityRole = context?.role || "admin";
    let roleScore = 0;
    if (role === "guest") {
      roleScore = 20;
    } else if (role === "read_only") {
      roleScore = 10;
    } else if (role === "standard") {
      roleScore = 5;
    }

    // ── 4. Factor 4: Session / Device Trust ─────────────────────────────
    let trustLevel: "local" | "paired_trusted" | "remote_unpaired" = "local";
    let trustScore = 0;
    if (context) {
      if (context.isLocal) {
        trustLevel = "local";
        trustScore = 0;
      } else if (context.deviceId && !context.deviceId.startsWith("unpaired")) {
        trustLevel = "paired_trusted";
        trustScore = 5;
      } else {
        trustLevel = "remote_unpaired";
        trustScore = 20;
        reasons.push("Operation initiated from remote or untrusted device session.");
      }
    }

    // ── 5. Factor 5: Argument Validation & Attack Patterns ─────────────
    let traversalAttempt = false;
    let dangerousFlags = false;
    let protectedPathTarget = false;
    let fencedUntrustedData = false;
    let argScore = 0;

    // Check dangerous shell patterns
    const cmdStr = String(sanitizedArgs.command || sanitizedArgs.cmd || sanitizedArgs.script || "");
    if (cmdStr) {
      for (const pat of MALICIOUS_SHELL_PATTERNS) {
        if (pat.test(cmdStr)) {
          dangerousFlags = true;
          reasons.push(`Malicious/destructive command pattern matched: ${pat}`);
          break;
        }
      }
    }

    // Check protected paths & traversal
    const allStringArgs = Object.values(sanitizedArgs).map((v) => String(v));
    for (const val of allStringArgs) {
      if (val.includes("../") || val.includes("..\\") || val.startsWith("..")) {
        traversalAttempt = true;
        reasons.push(`Directory traversal pattern detected in argument: ${val}`);
      }
      for (const p of PROTECTED_PATHS) {
        if (p.test(val)) {
          protectedPathTarget = true;
          reasons.push(`Access to protected credential or system path target: ${val}`);
          break;
        }
      }
    }

    // Check fenced untrusted data in sensitive execution parameters
    for (const [k, v] of Object.entries(sanitizedArgs)) {
      if (typeof v === "string" && contentSanitizer.isFencedUntrustedData(v)) {
        if (["command", "cmd", "script", "url", "code", "fields"].includes(k) || CRITICAL_TOOLS.has(toolName)) {
          fencedUntrustedData = true;
          reasons.push(`Fenced untrusted data detected in execution parameter '${k}'.`);
        }
      }
    }

    if (dangerousFlags) argScore += 50;
    if (protectedPathTarget) argScore += 45;
    if (traversalAttempt) argScore += 40;
    if (fencedUntrustedData) argScore += 35;

    // ── 6. Factor 6: Network Destination ────────────────────────────────
    let isPrivateOrRestricted = false;
    let isLoopback = false;
    let networkScore = 0;
    const urlStr = String(sanitizedArgs.url || sanitizedArgs.targetUrl || sanitizedArgs.link || "");
    if (urlStr) {
      try {
        const parsed = new URL(urlStr);
        const host = parsed.hostname.toLowerCase();
        if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
          isLoopback = true;
        } else if (
          host === "169.254.169.254" ||
          host.startsWith("10.") ||
          host.startsWith("192.168.") ||
          /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host)
        ) {
          isPrivateOrRestricted = true;
          networkScore = 35;
          reasons.push(`Target URL '${urlStr}' attempts private/restricted network SSRF access.`);
        }
      } catch {
        // Invalid URL format
      }
    }

    // ── 7. Factor 7: Existing Threat State & Security Mode ──────────────
    const mode: SecurityMode = options?.currentMode || "BALANCED";
    let threatScore = 0;
    if (mode === "LOCKDOWN") {
      threatScore = 50;
      reasons.push("System is in fail-closed LOCKDOWN mode.");
    } else if (mode === "PARANOID") {
      threatScore = 25;
    } else if (mode === "STRICT") {
      threatScore = 15;
    }
    if (options?.activeContainment) {
      threatScore += 25;
      reasons.push("Active threat containment in progress.");
    }

    // ── Deterministic Score Composition ─────────────────────────────────
    let score = baseScore;

    // Critical attack patterns escalate immediately to CRITICAL tier (>= 95)
    if (dangerousFlags) {
      score = 100;
    } else if (protectedPathTarget) {
      score = 95;
    } else {
      score = baseScore;
    }

    const rawScore = score;
    const finalScore = Math.max(0, Math.min(100, Math.round(score)));

    // ── 4-Tier Deterministic Classification ──────────────────────────────
    let level: RiskLevel = "LOW";
    let requiresConfirmation = false;
    let isCritical = false;

    if (finalScore >= 85) {
      level = "CRITICAL";
      isCritical = true;
      requiresConfirmation = true;
    } else if (finalScore >= 60) {
      level = "HIGH";
      requiresConfirmation = true;
    } else if (finalScore >= 30) {
      level = "MEDIUM";
      requiresConfirmation = false;
    } else {
      level = "LOW";
      requiresConfirmation = false;
    }

    const factors: RiskFactors = {
      toolSensitivity: { category: toolCat, baseScore },
      operationType: { type: opType, score: opScore },
      role: { role, score: roleScore },
      trustLevel: { level: trustLevel, score: trustScore },
      argumentValidation: {
        traversalAttempt,
        dangerousFlags,
        protectedPathTarget,
        fencedUntrustedData,
        score: argScore,
      },
      networkDestination: urlStr ? { isPrivateOrRestricted, isLoopback, score: networkScore } : undefined,
      threatState: { mode, containmentActive: options?.activeContainment, score: threatScore },
      rawScore,
      finalScore,
    };

    return {
      level,
      score: finalScore,
      reasons,
      requiresConfirmation,
      isCritical,
      factors,
    };
  }

  /**
   * Deterministically maps a risk evaluation to its standard policy decision.
   *   LOW      -> ALLOW
   *   MEDIUM   -> AUDIT
   *   HIGH     -> CONFIRMATION_REQUIRED
   *   CRITICAL -> BLOCK
   */
  classifyDecision(
    risk: RiskEvaluation,
    options?: { hasValidConfirmation?: boolean; isLockdown?: boolean; isRecovery?: boolean },
  ): DecisionType {
    if (options?.isLockdown && !options?.isRecovery) {
      return "LOCKDOWN";
    }

    switch (risk.level) {
      case "LOW":
        return "ALLOW";
      case "MEDIUM":
        return "AUDIT";
      case "HIGH":
        return options?.hasValidConfirmation ? "ALLOW" : "CONFIRMATION_REQUIRED";
      case "CRITICAL":
        return "BLOCK";
    }
  }
}

export const securityRiskEngine = new SecurityRiskEngine();
