/**
 * MYRAA — Canonical Capability Registry & Authorization Resolver
 *
 * Centralizes capability metadata:
 *   { capability, toolNames, target, supportedTargets, riskLevel, permissionRequired, confirmationRequired, verifier }
 *
 * Rules enforced:
 *   1. Deterministic application alias resolution (VS Code, File Explorer, Chrome, YouTube, Cursor, etc.).
 *   2. Deterministic target device availability checks (PHONE | DESKTOP | BROWSER | REMOTE_DESKTOP)
 *      returning TARGET_DEVICE_UNAVAILABLE with zero silent fallback to the wrong device.
 *   3. Authoritative security delegation to SecurityPolicyEngine, SecurityRiskEngine, and RemoteSessionManager.
 *   4. Accurate permission vs. execution error reporting — never inventing "I don't have permission"
 *      when an application capability is authorized.
 */

import { securityPolicyEngine, LOCKDOWN_ALLOWLIST } from "../security/SecurityPolicyEngine.ts";
import { securityRiskEngine } from "../security/SecurityRiskEngine.ts";
import { emergencyStopCoordinator } from "../remote/EmergencyStopCoordinator.ts";
import { remoteSessionManager } from "../remote/RemoteSessionManager.ts";
import { MODIFYING_TOOLS } from "../planner/PlannerTypes.ts";
import type { SecurityContext } from "../security/SecurityTypes.ts";
import type {
  CapabilityAuthorizationDecision,
  CapabilityMetadata,
  ExecutionContext,
  TargetDevice,
} from "./OrchestratorTypes.ts";

// ---------------------------------------------------------------------------
// 1. Canonical Application Alias Table
// ---------------------------------------------------------------------------

export const APPLICATION_ALIASES: Readonly<Record<string, string>> = {
  // VS Code
  "vscode": "vscode",
  "vs code": "vscode",
  "visual studio code": "vscode",
  "code": "vscode",
  "vsc": "vscode",
  "code.exe": "vscode",
  "microsoft vs code": "vscode",

  // Cursor
  "cursor": "cursor",
  "cursor ai": "cursor",
  "cursor editor": "cursor",
  "cursor ide": "cursor",

  // File Explorer
  "explorer": "explorer",
  "file explorer": "explorer",
  "windows explorer": "explorer",
  "files": "explorer",
  "file manager": "explorer",
  "my computer": "explorer",
  "this pc": "explorer",
  "explorer.exe": "explorer",

  // Browsers
  "chrome": "chrome",
  "google chrome": "chrome",
  "browser": "chrome",
  "edge": "edge",
  "microsoft edge": "edge",
  "msedge": "edge",
  "brave": "brave",
  "brave browser": "brave",
  "firefox": "firefox",
  "mozilla firefox": "firefox",

  // Media & Web Apps
  "youtube": "youtube",
  "yt": "youtube",
  "youtube app": "youtube",
  "spotify": "spotify",
  "whatsapp": "whatsapp",
  "gmail": "gmail",
  "maps": "maps",
  "google maps": "maps",
  "calendar": "calendar",

  // System & Productivity Utilities
  "notepad": "notepad",
  "text editor": "notepad",
  "notepad.exe": "notepad",
  "calculator": "calculator",
  "calc": "calculator",
  "calc.exe": "calculator",
  "terminal": "terminal",
  "windows terminal": "terminal",
  "cmd": "cmd",
  "command prompt": "cmd",
  "powershell": "powershell",
  "pwsh": "powershell",
  "task manager": "task manager",
  "taskmgr": "task manager",
  "settings": "settings",
  "windows settings": "settings",
  "system settings": "settings",
  "paint": "paint",
  "mspaint": "paint",
  "snipping tool": "snipping tool",
  "word": "word",
  "ms word": "word",
  "microsoft word": "word",
  "excel": "excel",
  "ms excel": "excel",
  "microsoft excel": "excel",
  "powerpoint": "powerpoint",
  "ppt": "powerpoint",
  "ms powerpoint": "powerpoint",
};

export const DESKTOP_NATIVE_APPS: ReadonlySet<string> = new Set([
  "vscode",
  "cursor",
  "explorer",
  "chrome",
  "edge",
  "brave",
  "firefox",
  "notepad",
  "calculator",
  "terminal",
  "cmd",
  "powershell",
  "task manager",
  "settings",
  "paint",
  "snipping tool",
  "word",
  "excel",
  "powerpoint",
  "spotify",
  "whatsapp",
]);

export const MOBILE_SUPPORTED_APPS: ReadonlySet<string> = new Set([
  "gmail",
  "maps",
  "youtube",
  "calendar",
  "whatsapp",
  "chrome",
  "spotify",
]);

// ---------------------------------------------------------------------------
// 2. Canonical Capability Metadata Definitions
// ---------------------------------------------------------------------------

export const CAPABILITY_DEFINITIONS: Readonly<Record<string, CapabilityMetadata>> = {
  "desktop.openApplication": {
    capability: "desktop.openApplication",
    toolNames: ["openApplication", "openInVsCode", "switchApplication"],
    target: "DESKTOP",
    supportedTargets: ["DESKTOP", "REMOTE_DESKTOP", "PHONE", "BROWSER"],
    riskLevel: "LOW",
    permissionRequired: "standard",
    confirmationRequired: false,
    verifier: "verifyOpenApplication",
  },
  "desktop.closeApplication": {
    capability: "desktop.closeApplication",
    toolNames: ["closeApplication", "closeWindow"],
    target: "DESKTOP",
    supportedTargets: ["DESKTOP", "REMOTE_DESKTOP"],
    riskLevel: "LOW",
    permissionRequired: "standard",
    confirmationRequired: false,
    verifier: "verifyCloseApplication",
  },
  "desktop.openFile": {
    capability: "desktop.openFile",
    toolNames: ["openFile", "openInVsCode"],
    target: "DESKTOP",
    supportedTargets: ["DESKTOP", "REMOTE_DESKTOP"],
    riskLevel: "LOW",
    permissionRequired: "standard",
    confirmationRequired: false,
    verifier: "verifyOpenFile",
  },
  "desktop.openFolder": {
    capability: "desktop.openFolder",
    toolNames: ["openFolder"],
    target: "DESKTOP",
    supportedTargets: ["DESKTOP", "REMOTE_DESKTOP"],
    riskLevel: "LOW",
    permissionRequired: "standard",
    confirmationRequired: false,
    verifier: "verifyOpenFolder",
  },
  "desktop.readFile": {
    capability: "desktop.readFile",
    toolNames: ["readFile", "read_file", "listFiles", "searchFiles"],
    target: "DESKTOP",
    supportedTargets: ["DESKTOP", "REMOTE_DESKTOP"],
    riskLevel: "LOW",
    permissionRequired: "read_only",
    confirmationRequired: false,
    verifier: "verifyReadFile",
  },
  "desktop.modifyFile": {
    capability: "desktop.modifyFile",
    toolNames: [
      "modifyFile",
      "writeCodeFile",
      "createFile",
      "createPythonFile",
      "write_to_file",
      "replace_file_content",
      "renameFile",
      "moveFile",
    ],
    target: "DESKTOP",
    supportedTargets: ["DESKTOP", "REMOTE_DESKTOP"],
    riskLevel: "MEDIUM",
    permissionRequired: "standard",
    confirmationRequired: true,
    verifier: "verifyCodeModification",
  },
  "desktop.deleteFile": {
    capability: "desktop.deleteFile",
    toolNames: ["deleteFile"],
    target: "DESKTOP",
    supportedTargets: ["DESKTOP", "REMOTE_DESKTOP"],
    riskLevel: "HIGH",
    permissionRequired: "admin",
    confirmationRequired: true,
    verifier: "verifyDeleteFile",
  },
  "desktop.runCommand": {
    capability: "desktop.runCommand",
    toolNames: ["runShellCommand", "runPythonScript", "execute_command"],
    target: "DESKTOP",
    supportedTargets: ["DESKTOP", "REMOTE_DESKTOP"],
    riskLevel: "HIGH",
    permissionRequired: "admin",
    confirmationRequired: true,
    verifier: "verifyRunCommand",
  },
  "youtube.search": {
    capability: "youtube.search",
    toolNames: ["searchYouTube", "browserSearch"],
    target: "BROWSER",
    supportedTargets: ["BROWSER", "DESKTOP", "PHONE", "REMOTE_DESKTOP"],
    riskLevel: "LOW",
    permissionRequired: "read_only",
    confirmationRequired: false,
    verifier: "verifyYouTubeSearch",
  },
  "youtube.play": {
    capability: "youtube.play",
    toolNames: ["browserMediaControl", "browserClick"],
    target: "BROWSER",
    supportedTargets: ["BROWSER", "DESKTOP", "PHONE", "REMOTE_DESKTOP"],
    riskLevel: "LOW",
    permissionRequired: "read_only",
    confirmationRequired: false,
    verifier: "verifyYouTubePlay",
  },
  "youtube.pause": {
    capability: "youtube.pause",
    toolNames: ["browserMediaControl"],
    target: "BROWSER",
    supportedTargets: ["BROWSER", "DESKTOP", "PHONE", "REMOTE_DESKTOP"],
    riskLevel: "LOW",
    permissionRequired: "read_only",
    confirmationRequired: false,
    verifier: "verifyYouTubePlay",
  },
  "youtube.resume": {
    capability: "youtube.resume",
    toolNames: ["browserMediaControl"],
    target: "BROWSER",
    supportedTargets: ["BROWSER", "DESKTOP", "PHONE", "REMOTE_DESKTOP"],
    riskLevel: "LOW",
    permissionRequired: "read_only",
    confirmationRequired: false,
    verifier: "verifyYouTubePlay",
  },
  "youtube.stop": {
    capability: "youtube.stop",
    toolNames: ["browserMediaControl"],
    target: "BROWSER",
    supportedTargets: ["BROWSER", "DESKTOP", "PHONE", "REMOTE_DESKTOP"],
    riskLevel: "LOW",
    permissionRequired: "read_only",
    confirmationRequired: false,
    verifier: "verifyYouTubePlay",
  },
  "youtube.next": {
    capability: "youtube.next",
    toolNames: ["browserMediaControl", "browserClick"],
    target: "BROWSER",
    supportedTargets: ["BROWSER", "DESKTOP", "PHONE", "REMOTE_DESKTOP"],
    riskLevel: "LOW",
    permissionRequired: "read_only",
    confirmationRequired: false,
    verifier: "verifyYouTubePlay",
  },
  "youtube.previous": {
    capability: "youtube.previous",
    toolNames: ["browserMediaControl", "browserClick"],
    target: "BROWSER",
    supportedTargets: ["BROWSER", "DESKTOP", "PHONE", "REMOTE_DESKTOP"],
    riskLevel: "LOW",
    permissionRequired: "read_only",
    confirmationRequired: false,
    verifier: "verifyYouTubePlay",
  },
  "browser.openUrl": {
    capability: "browser.openUrl",
    toolNames: ["browserOpen", "openWebsite", "desktopBrowserOpen", "desktopBrowserNavigate"],
    target: "BROWSER",
    supportedTargets: ["BROWSER", "DESKTOP", "PHONE", "REMOTE_DESKTOP"],
    riskLevel: "LOW",
    permissionRequired: "read_only",
    confirmationRequired: false,
    verifier: "verifyBrowserOpenUrl",
  },
  "browser.search": {
    capability: "browser.search",
    toolNames: ["searchWeb", "searchGoogle", "searchGitHub", "desktopBrowserSearch"],
    target: "BROWSER",
    supportedTargets: ["BROWSER", "DESKTOP", "PHONE", "REMOTE_DESKTOP"],
    riskLevel: "LOW",
    permissionRequired: "read_only",
    confirmationRequired: false,
    verifier: "verifyBrowserSearch",
  },
  "code.inspect": {
    capability: "code.inspect",
    toolNames: ["readFile", "read_file", "analyzeProject", "searchProjectCode", "analyzeVisualCode"],
    target: "DESKTOP",
    supportedTargets: ["DESKTOP", "REMOTE_DESKTOP"],
    riskLevel: "LOW",
    permissionRequired: "read_only",
    confirmationRequired: false,
    verifier: "verifyCodeInspection",
  },
  "code.research": {
    capability: "code.research",
    toolNames: ["researchWeb", "fetchOfficialDocs", "queryKnowledgeBase", "readUrl"],
    target: "DESKTOP",
    supportedTargets: ["DESKTOP", "BROWSER", "REMOTE_DESKTOP", "PHONE"],
    riskLevel: "LOW",
    permissionRequired: "read_only",
    confirmationRequired: false,
    verifier: "verifyWebResearch",
  },
  "phone.interactApp": {
    capability: "phone.interactApp",
    toolNames: ["interactApp", "appInteraction", "interactWithApp", "mobileAppAction"],
    target: "PHONE",
    supportedTargets: ["PHONE"],
    riskLevel: "LOW",
    permissionRequired: "standard",
    confirmationRequired: false,
    verifier: "verifyPhoneAppInteraction",
  },
};

// ---------------------------------------------------------------------------
// 3. CapabilityRegistry Class
// ---------------------------------------------------------------------------

export interface DeviceAvailabilityOverrides {
  desktopAvailable?: boolean;
  phoneAvailable?: boolean;
  remoteDesktopAvailable?: boolean;
  browserAvailable?: boolean;
}

export class CapabilityRegistry {
  private _availabilityOverrides: DeviceAvailabilityOverrides = {};

  /**
   * Configure test or runtime overrides for target device availability.
   */
  setDeviceAvailabilityOverrides(overrides: DeviceAvailabilityOverrides): void {
    this._availabilityOverrides = { ...overrides };
  }

  resetForTesting(): void {
    this._availabilityOverrides = {};
  }

  /**
   * Look up capability metadata by capability ID or tool name.
   */
  getCapabilityMetadata(capabilityOrTool: string): CapabilityMetadata {
    if (CAPABILITY_DEFINITIONS[capabilityOrTool]) {
      return CAPABILITY_DEFINITIONS[capabilityOrTool];
    }
    for (const meta of Object.values(CAPABILITY_DEFINITIONS)) {
      if (meta.toolNames.includes(capabilityOrTool)) {
        return meta;
      }
    }
    const isMod = MODIFYING_TOOLS.has(capabilityOrTool);
    return {
      capability: `tool.${capabilityOrTool}`,
      toolNames: [capabilityOrTool],
      target: "DESKTOP",
      supportedTargets: ["DESKTOP", "BROWSER", "PHONE", "REMOTE_DESKTOP"],
      riskLevel: isMod ? "MEDIUM" : "LOW",
      permissionRequired: isMod ? "standard" : "read_only",
      confirmationRequired: isMod,
      verifier: "verifyGenericTool",
    };
  }

  /**
   * Resolve a user-provided application name or contextual reference ("ye app", "VS Code", etc.)
   * into a canonical application key.
   */
  resolveApplicationAlias(
    rawInput: string | null | undefined,
    context?: ExecutionContext,
  ): {
    resolved: boolean;
    canonicalApp: string | null;
    isWebsiteApp: boolean;
    websiteUrl?: string;
    fromContext: boolean;
    reason?: string;
  } {
    const cleaned = String(rawInput || "")
      .trim()
      .toLowerCase()
      .replace(/\b(open\s+karo|kholo|khol\s+do|chalu\s+karo|launch|start|open|on\s+laptop|on\s+pc|on\s+desktop|laptop\s+par|pc\s+par|desktop\s+par|me|mein|par)\b/gi, "")
      .replace(/\s+/g, " ")
      .trim();

    // 1. Contextual pronouns ("ye app", "this app", "isko", "current app", or empty when context has an app)
    if (
      !cleaned ||
      /^(ye\s*app|this\s*app|current\s*app|active\s*app|same\s*app|us\s*app|wo\s*app|isko|ise|it|app)$/.test(cleaned)
    ) {
      if (context?.currentApplication) {
        const canonical = APPLICATION_ALIASES[context.currentApplication.toLowerCase()] || context.currentApplication.toLowerCase();
        return {
          resolved: true,
          canonicalApp: canonical,
          isWebsiteApp: canonical === "youtube" || canonical === "gmail",
          websiteUrl: canonical === "youtube" ? "https://www.youtube.com" : undefined,
          fromContext: true,
        };
      }
      if (context?.currentWebsite) {
        const site = context.currentWebsite.toLowerCase();
        return {
          resolved: true,
          canonicalApp: site,
          isWebsiteApp: true,
          websiteUrl: site === "youtube" ? "https://www.youtube.com" : site,
          fromContext: true,
        };
      }
      return {
        resolved: false,
        canonicalApp: null,
        isWebsiteApp: false,
        fromContext: true,
        reason: "NO_ACTIVE_APPLICATION_IN_CONTEXT: No active application found in conversation context. Please specify the application name (e.g. 'VS Code', 'Chrome', 'File Explorer').",
      };
    }

    // 2. Direct alias lookup
    if (APPLICATION_ALIASES[cleaned]) {
      const canonical = APPLICATION_ALIASES[cleaned];
      return {
        resolved: true,
        canonicalApp: canonical,
        isWebsiteApp: canonical === "youtube" || canonical === "gmail" || canonical === "maps" || canonical === "calendar",
        websiteUrl:
          canonical === "youtube"
            ? "https://www.youtube.com"
            : canonical === "gmail"
            ? "https://mail.google.com"
            : undefined,
        fromContext: false,
      };
    }

    // 3. Strip trailing "app" / "application" and retry
    const withoutAppSuffix = cleaned.replace(/\s+(app|application)$/i, "").trim();
    if (APPLICATION_ALIASES[withoutAppSuffix]) {
      const canonical = APPLICATION_ALIASES[withoutAppSuffix];
      return {
        resolved: true,
        canonicalApp: canonical,
        isWebsiteApp: canonical === "youtube" || canonical === "gmail" || canonical === "maps" || canonical === "calendar",
        websiteUrl:
          canonical === "youtube"
            ? "https://www.youtube.com"
            : canonical === "gmail"
            ? "https://mail.google.com"
            : undefined,
        fromContext: false,
      };
    }

    // 4. Substring match against known multi-word aliases
    for (const [alias, canonical] of Object.entries(APPLICATION_ALIASES)) {
      if (alias.length >= 4 && (cleaned.includes(alias) || alias.includes(cleaned))) {
        return {
          resolved: true,
          canonicalApp: canonical,
          isWebsiteApp: canonical === "youtube" || canonical === "gmail" || canonical === "maps" || canonical === "calendar",
          websiteUrl:
            canonical === "youtube"
              ? "https://www.youtube.com"
              : canonical === "gmail"
              ? "https://mail.google.com"
              : undefined,
          fromContext: false,
        };
      }
    }

    return {
      resolved: false,
      canonicalApp: null,
      isWebsiteApp: false,
      fromContext: false,
      reason: `UNRECOGNIZED_APPLICATION: Application '${rawInput}' is not registered in the allowed desktop/mobile application catalog.`,
    };
  }

  /**
   * Verify that the requested TargetDevice is available and reachable.
   * NEVER silently falls back to the wrong device if an explicit target device is unavailable.
   */
  verifyTargetDeviceAvailability(
    targetDevice: TargetDevice,
    secContext: SecurityContext,
  ): {
    available: boolean;
    targetDevice: TargetDevice;
    errorCode?: "TARGET_DEVICE_UNAVAILABLE";
    reason?: string;
  } {
    // 1. Explicit test/runtime overrides
    if (targetDevice === "DESKTOP" && this._availabilityOverrides.desktopAvailable !== undefined) {
      if (!this._availabilityOverrides.desktopAvailable) {
        return {
          available: false,
          targetDevice,
          errorCode: "TARGET_DEVICE_UNAVAILABLE",
          reason: "TARGET_DEVICE_UNAVAILABLE: Target device 'DESKTOP' is currently offline or unreachable.",
        };
      }
      return { available: true, targetDevice };
    }

    if (targetDevice === "REMOTE_DESKTOP" && this._availabilityOverrides.remoteDesktopAvailable !== undefined) {
      if (!this._availabilityOverrides.remoteDesktopAvailable) {
        return {
          available: false,
          targetDevice,
          errorCode: "TARGET_DEVICE_UNAVAILABLE",
          reason: "TARGET_DEVICE_UNAVAILABLE: Target device 'REMOTE_DESKTOP' companion is not connected.",
        };
      }
      return { available: true, targetDevice };
    }

    if (targetDevice === "PHONE" && this._availabilityOverrides.phoneAvailable !== undefined) {
      if (!this._availabilityOverrides.phoneAvailable) {
        return {
          available: false,
          targetDevice,
          errorCode: "TARGET_DEVICE_UNAVAILABLE",
          reason: "TARGET_DEVICE_UNAVAILABLE: Target device 'PHONE' (Android/mobile companion) is not connected.",
        };
      }
      return { available: true, targetDevice };
    }

    if (targetDevice === "BROWSER" && this._availabilityOverrides.browserAvailable !== undefined) {
      if (!this._availabilityOverrides.browserAvailable) {
        return {
          available: false,
          targetDevice,
          errorCode: "TARGET_DEVICE_UNAVAILABLE",
          reason: "TARGET_DEVICE_UNAVAILABLE: Target device 'BROWSER' is not available.",
        };
      }
      return { available: true, targetDevice };
    }

    // 2. Runtime checks
    if (targetDevice === "PHONE") {
      // Available if the caller is a remote mobile session OR an active mobile client is connected
      const isRemoteCaller = !secContext.isLocal;
      const activeSessions = remoteSessionManager.getActiveSessions();
      const hasMobileSession = activeSessions.length > 0 || isRemoteCaller;
      if (!hasMobileSession) {
        return {
          available: false,
          targetDevice: "PHONE",
          errorCode: "TARGET_DEVICE_UNAVAILABLE",
          reason: "TARGET_DEVICE_UNAVAILABLE: Target device 'PHONE' is not connected. Pair or connect your mobile companion first.",
        };
      }
      return { available: true, targetDevice: "PHONE" };
    }

    if (targetDevice === "REMOTE_DESKTOP") {
      const desktopCompanion = remoteSessionManager.getActiveDesktopCompanion();
      if (!desktopCompanion && !secContext.isLocal) {
        return {
          available: false,
          targetDevice: "REMOTE_DESKTOP",
          errorCode: "TARGET_DEVICE_UNAVAILABLE",
          reason: "TARGET_DEVICE_UNAVAILABLE: Remote desktop companion is not connected.",
        };
      }
      return { available: true, targetDevice: "REMOTE_DESKTOP" };
    }

    if (targetDevice === "DESKTOP") {
      // If running on cloud (process.env.RENDER) without a connected desktop companion and not local
      const isCloudHosted = Boolean(process.env.RENDER);
      if (!secContext.isLocal && isCloudHosted && !remoteSessionManager.getActiveDesktopCompanion()) {
        return {
          available: false,
          targetDevice: "DESKTOP",
          errorCode: "TARGET_DEVICE_UNAVAILABLE",
          reason: "TARGET_DEVICE_UNAVAILABLE: Desktop PC companion is not connected to the cloud gateway.",
        };
      }
      return { available: true, targetDevice: "DESKTOP" };
    }

    // BROWSER is available via holographic BrowserAgent / default browser
    return { available: true, targetDevice: "BROWSER" };
  }

  /**
   * Evaluate capability authorization strictly through SecurityPolicyEngine, SecurityRiskEngine,
   * EmergencyStopCoordinator, and RemoteSessionManager.
   *
   * Never lets Gemini decide permissions or bypass risk.
   */
  authorizeCapability(
    capabilityOrTool: string,
    toolName: string,
    args: Record<string, unknown>,
    secContext: SecurityContext,
    targetDevice?: TargetDevice,
    hasExplicitConfirmation = false,
  ): CapabilityAuthorizationDecision {
    const meta = this.getCapabilityMetadata(capabilityOrTool);
    const resolvedDevice = targetDevice || meta.target;

    // 1. Emergency stop & Lockdown check via SecurityPolicyEngine
    if (emergencyStopCoordinator.isActive()) {
      return {
        authorized: false,
        capability: meta.capability,
        toolName,
        targetDevice: resolvedDevice,
        riskLevel: "CRITICAL",
        permissionRequired: meta.permissionRequired,
        confirmationRequired: true,
        isPermissionDenied: true,
        isDeviceUnavailable: false,
        errorCode: "SECURITY_POLICY_DENIED",
        reason: "EMERGENCY_STOP_ACTIVE: All tool and capability execution is halted by emergency stop.",
      };
    }

    const currentMode = securityPolicyEngine.getMode();
    if (currentMode === "LOCKDOWN" && !LOCKDOWN_ALLOWLIST.has(toolName)) {
      return {
        authorized: false,
        capability: meta.capability,
        toolName,
        targetDevice: resolvedDevice,
        riskLevel: "CRITICAL",
        permissionRequired: meta.permissionRequired,
        confirmationRequired: true,
        isPermissionDenied: true,
        isDeviceUnavailable: false,
        errorCode: "SECURITY_POLICY_DENIED",
        reason: `SECURITY_LOCKDOWN: Tool '${toolName}' is blocked. System is in fail-closed LOCKDOWN mode.`,
      };
    }

    if (securityPolicyEngine.isToolDisabled(toolName)) {
      return {
        authorized: false,
        capability: meta.capability,
        toolName,
        targetDevice: resolvedDevice,
        riskLevel: "HIGH",
        permissionRequired: meta.permissionRequired,
        confirmationRequired: true,
        isPermissionDenied: true,
        isDeviceUnavailable: false,
        errorCode: "SECURITY_POLICY_DENIED",
        reason: `TOOL_DISABLED: Tool '${toolName}' has been dynamically disabled by automated containment.`,
      };
    }

    // 2. Target Device Availability Check (no silent fallback)
    const deviceCheck = this.verifyTargetDeviceAvailability(resolvedDevice, secContext);
    if (!deviceCheck.available) {
      return {
        authorized: false,
        capability: meta.capability,
        toolName,
        targetDevice: resolvedDevice,
        riskLevel: meta.riskLevel,
        permissionRequired: meta.permissionRequired,
        confirmationRequired: meta.confirmationRequired,
        isPermissionDenied: false,
        isDeviceUnavailable: true,
        errorCode: "TARGET_DEVICE_UNAVAILABLE",
        reason: deviceCheck.reason,
      };
    }

    // 3. Remote role permission check if caller is remote
    const roleStr = String(secContext.role || "").toLowerCase();
    if (roleStr === "anonymous" || roleStr === "unauthenticated") {
      return {
        authorized: false,
        capability: meta.capability,
        toolName,
        targetDevice: resolvedDevice,
        riskLevel: meta.riskLevel,
        permissionRequired: meta.permissionRequired,
        confirmationRequired: meta.confirmationRequired,
        isPermissionDenied: true,
        isDeviceUnavailable: false,
        errorCode: "PERMISSION_DENIED",
        reason: `PERMISSION_DENIED: Unauthenticated or anonymous caller cannot execute '${toolName}'.`,
      };
    }

    if (!secContext.isLocal) {
      const rolePerm = remoteSessionManager.checkToolPermission(secContext.role as any, toolName);
      if (!rolePerm.allowed) {
        return {
          authorized: false,
          capability: meta.capability,
          toolName,
          targetDevice: resolvedDevice,
          riskLevel: meta.riskLevel,
          permissionRequired: meta.permissionRequired,
          confirmationRequired: meta.confirmationRequired,
          isPermissionDenied: true,
          isDeviceUnavailable: false,
          errorCode: "PERMISSION_DENIED",
          reason: rolePerm.reason,
        };
      }
    }

    // 4. Authoritative SecurityPolicyEngine & SecurityRiskEngine evaluation
    const riskAssessment = securityPolicyEngine.evaluateRisk(toolName, args, secContext);
    if (riskAssessment.score >= 95) {
      return {
        authorized: false,
        capability: meta.capability,
        toolName,
        targetDevice: resolvedDevice,
        riskLevel: "CRITICAL",
        permissionRequired: meta.permissionRequired,
        confirmationRequired: true,
        isPermissionDenied: true,
        isDeviceUnavailable: false,
        errorCode: "SECURITY_POLICY_DENIED",
        reason: `CRITICAL_SECURITY_BLOCK: ${riskAssessment.reasons.join("; ")}`,
      };
    }

    if (secContext.role === "guest" && riskAssessment.level !== "LOW") {
      return {
        authorized: false,
        capability: meta.capability,
        toolName,
        targetDevice: resolvedDevice,
        riskLevel: riskAssessment.level,
        permissionRequired: meta.permissionRequired,
        confirmationRequired: meta.confirmationRequired,
        isPermissionDenied: true,
        isDeviceUnavailable: false,
        errorCode: "PERMISSION_DENIED",
        reason: `PERMISSION_DENIED: Role 'guest' is only permitted to execute LOW risk tools.`,
      };
    }

    if (
      secContext.role === "read_only" &&
      (riskAssessment.level === "HIGH" || riskAssessment.level === "CRITICAL" || MODIFYING_TOOLS.has(toolName))
    ) {
      return {
        authorized: false,
        capability: meta.capability,
        toolName,
        targetDevice: resolvedDevice,
        riskLevel: riskAssessment.level,
        permissionRequired: meta.permissionRequired,
        confirmationRequired: meta.confirmationRequired,
        isPermissionDenied: true,
        isDeviceUnavailable: false,
        errorCode: "PERMISSION_DENIED",
        reason: `PERMISSION_DENIED: Role 'read_only' cannot execute state-altering tool '${toolName}'.`,
      };
    }

    // 5. Confirmation check
    const needsConfirmation =
      meta.confirmationRequired ||
      MODIFYING_TOOLS.has(toolName) ||
      riskAssessment.requiresConfirmation ||
      currentMode === "STRICT" ||
      currentMode === "PARANOID";

    if (
      needsConfirmation &&
      !hasExplicitConfirmation &&
      !args.checkpointId &&
      !args._checkpointId &&
      !args.confirmed &&
      !args.confirmationToken
    ) {
      return {
        authorized: false,
        capability: meta.capability,
        toolName,
        targetDevice: resolvedDevice,
        riskLevel: riskAssessment.level,
        permissionRequired: meta.permissionRequired,
        confirmationRequired: true,
        isPermissionDenied: false,
        isDeviceUnavailable: false,
        errorCode: "CONFIRMATION_REQUIRED",
        reason: `CONFIRMATION_REQUIRED: Capability '${meta.capability}' (${toolName}) is classified as ${riskAssessment.level} risk and requires explicit user confirmation before execution.`,
      };
    }

    return {
      authorized: true,
      capability: meta.capability,
      toolName,
      targetDevice: resolvedDevice,
      riskLevel: riskAssessment.level,
      permissionRequired: meta.permissionRequired,
      confirmationRequired: needsConfirmation,
      isPermissionDenied: false,
      isDeviceUnavailable: false,
    };
  }
}

export const capabilityRegistry = new CapabilityRegistry();
