/**
 * MYRAA — RemoteCapabilityDispatcher (Phase 19)
 *
 * Server-side coordinator for Android Native Capabilities.
 *
 * Every capability execution request is strictly routed through the existing
 * Phase 10A–10F security pipeline before dispatch to an Android device:
 *
 *   Remote Request (Voice Intent / REST / Tool)
 *                     │
 *                     ▼
 *           Emergency Stop Guard
 *                     │
 *                     ▼
 *          Security Lockdown Guard
 *                     │
 *                     ▼
 *            Argument Validation
 *       (SSRF check, URL safety, token guards)
 *                     │
 *                     ▼
 *        ToolExecutionFirewall Gate
 *       (SecurityPolicyEngine + RiskEngine)
 *                     │
 *                     ▼
 *     RemoteSessionManager / WebSocket Dispatch
 *                     │
 *                     ▼
 *              Android System
 *                     │
 *                     ▼
 *             Audit Trail Record
 */

import crypto from "crypto";
import { securityPolicyEngine } from "../security/SecurityPolicyEngine.ts";
import { toolExecutionFirewall, GuardedExecutionResult } from "../security/ToolExecutionFirewall.ts";
import { emergencyStopCoordinator } from "./EmergencyStopCoordinator.ts";
import { remoteSessionManager } from "./RemoteSessionManager.ts";
import { remoteStore } from "./RemoteStore.ts";
import { securityAuditLogger } from "../security/SecurityAuditLogger.ts";
import { isSsrfSafeUrl } from "../security/PermissionManager.ts";
import { contentSanitizer } from "../security/ContentSanitizer.ts";
import { ANDROID_CAPABILITIES } from "../../platform/android/AndroidCapabilityDescriptors.ts";
import type { SecurityContext, PolicyDecision } from "../security/SecurityTypes.ts";

export interface CapabilityDispatchResult extends GuardedExecutionResult {
  deviceId: string;
  capability: string;
  dispatched: boolean;
}

export class RemoteCapabilityDispatcher {
  /**
   * Validate parameters specifically for Android capabilities before execution.
   */
  async validateCapabilityArguments(
    capability: string,
    args: Record<string, unknown>
  ): Promise<{ valid: boolean; reason?: string }> {
    // 1. openUrl SSRF & protocol validation
    if (capability === "openUrl" || capability === "openWebsite" || capability === "browserOpen") {
      const url = String(args.url || args.link || "").trim();
      if (!url) {
        return { valid: false, reason: "ARGUMENT_VIOLATION: Missing required parameter 'url'." };
      }
      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        return {
          valid: false,
          reason: "SSRF_VIOLATION: Invalid URL protocol. Only http:// and https:// URLs are permitted.",
        };
      }
      // SSRF check against loopback, private networks, and internal cloud metadata
      const ssrfCheck = await isSsrfSafeUrl(url);
      if (!ssrfCheck.safe) {
        return {
          valid: false,
          reason: `SSRF_VIOLATION: ${ssrfCheck.reason || "Target URL is restricted."}`,
        };
      }
    }

    // 2. openApp validation: prevent command injection strings
    if (capability === "openApp" || capability === "openApplication") {
      const appName = String(args.appName || args.app || args.name || "");
      const packageName = String(args.packageName || args.package || "");
      if (!appName && !packageName) {
        return { valid: false, reason: "ARGUMENT_VIOLATION: Either 'appName' or 'packageName' must be specified." };
      }
      const combined = `${appName} ${packageName}`;
      if (/[;&|`$<>]/.test(combined)) {
        return { valid: false, reason: "ARGUMENT_VIOLATION: Dangerous metacharacters detected in app/package name." };
      }
    }

    // 3. clipboard validation: prevent credential leakage
    if (capability === "clipboard" || capability === "copySelected" || capability === "pasteClipboard") {
      const text = String(args.text || args.content || "");
      if (text.includes("sora_dev_") || text.includes("myraa_at_") || text.includes("Bearer ")) {
        return { valid: false, reason: "SECURITY_VIOLATION: Sensitive credentials cannot be copied to clipboard." };
      }
    }

    // 4. notifications validation: prevent credential leakage
    if (capability === "notifications") {
      const text = `${String(args.title || "")} ${String(args.message || args.body || "")}`;
      if (text.includes("sora_dev_") || text.includes("myraa_at_") || text.includes("Bearer ")) {
        return { valid: false, reason: "SECURITY_VIOLATION: Sensitive credentials cannot be exposed in notifications." };
      }
    }

    // 5. setAlarm validation
    if (capability === "setAlarm") {
      const hour = Number(args.hour);
      const minutes = Number(args.minutes ?? args.minute ?? 0);
      if (isNaN(hour) || hour < 0 || hour > 23 || isNaN(minutes) || minutes < 0 || minutes > 59) {
        return { valid: false, reason: `ARGUMENT_VIOLATION: Invalid alarm time '${hour}:${minutes}' (hour: 0-23, min: 0-59).` };
      }
    }

    // 6. setTimer validation
    if (capability === "setTimer") {
      const lengthSeconds = Number(args.lengthSeconds ?? args.seconds ?? (Number(args.minutes ?? 0) * 60));
      if (isNaN(lengthSeconds) || lengthSeconds <= 0) {
        return { valid: false, reason: `ARGUMENT_VIOLATION: Timer duration must be greater than 0 seconds.` };
      }
    }

    // 7. createReminder validation
    if (capability === "createReminder") {
      const title = String(args.title || args.message || args.text || "").trim();
      if (!title) {
        return { valid: false, reason: "ARGUMENT_VIOLATION: Reminder title is required." };
      }
    }

    // 8. openBrowser validation (Phase 20)
    if (capability === "openBrowser" || capability === "desktopBrowserOpen") {
      const browserName = String(args.browserName || args.browser || "").trim();
      const url = String(args.url || args.link || "").trim();

      if (browserName && /[;&|`$<>]/.test(browserName)) {
        return { valid: false, reason: "ARGUMENT_VIOLATION: Dangerous metacharacters detected in browserName." };
      }
      if (url) {
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
          return {
            valid: false,
            reason: "SSRF_VIOLATION: Invalid URL protocol. Only http:// and https:// URLs are permitted.",
          };
        }
        const ssrfCheck = await isSsrfSafeUrl(url);
        if (!ssrfCheck.safe) {
          return {
            valid: false,
            reason: `SSRF_VIOLATION: ${ssrfCheck.reason || "Target URL is restricted."}`,
          };
        }
      }
      const combined = `${browserName} ${url}`;
      if (combined.includes("sora_dev_") || combined.includes("myraa_at_") || combined.includes("Bearer ") || combined.includes("sk-")) {
        return { valid: false, reason: "SECURITY_VIOLATION: Sensitive credentials cannot be exposed in browser arguments." };
      }
    }

    // 9. searchWeb validation (Phase 20)
    if (
      capability === "searchWeb" ||
      capability === "browserSearch" ||
      capability === "searchGoogle" ||
      capability === "desktopBrowserSearch"
    ) {
      const query = String(args.query || args.search || args.term || args.q || "").trim();
      if (!query) {
        return { valid: false, reason: "ARGUMENT_VIOLATION: Missing required parameter 'query'." };
      }
      if (query.length > 500) {
        return { valid: false, reason: "ARGUMENT_VIOLATION: Search query exceeds maximum length of 500 characters." };
      }
      if (/[;&|`$<>]/.test(query)) {
        return { valid: false, reason: "ARGUMENT_VIOLATION: Dangerous metacharacters detected in search query." };
      }
      if (query.includes("sora_dev_") || query.includes("myraa_at_") || query.includes("Bearer ") || query.includes("sk-")) {
        return { valid: false, reason: "SECURITY_VIOLATION: Sensitive credentials cannot be searched via searchWeb." };
      }
      const engine = String(args.engine || args.provider || "google").toLowerCase().trim();
      const allowedEngines = ["google", "duckduckgo", "bing", "youtube", "ecosia"];
      if (!allowedEngines.includes(engine)) {
        return { valid: false, reason: `ARGUMENT_VIOLATION: Unsupported search engine '${engine}'. Allowed: ${allowedEngines.join(", ")}.` };
      }
    }

    // 10. findOnPage validation (Phase 20)
    if (capability === "findOnPage") {
      const query = String(args.query || args.text || args.term || "").trim();
      if (!query) {
        return { valid: false, reason: "ARGUMENT_VIOLATION: Missing required parameter 'query'." };
      }
      if (query.length > 200) {
        return { valid: false, reason: "ARGUMENT_VIOLATION: Find query exceeds maximum length of 200 characters." };
      }
      if (/[;&|`$<>]/.test(query)) {
        return { valid: false, reason: "ARGUMENT_VIOLATION: Dangerous metacharacters detected in find query." };
      }
    }

    // 11. navigateBack / navigateForward validation (Phase 20)
    if (
      capability === "navigateBack" ||
      capability === "navigateForward" ||
      capability === "browserGoBack" ||
      capability === "desktopBrowserGoBack" ||
      capability === "desktopBrowserGoForward"
    ) {
      if (args.steps !== undefined && args.steps !== null) {
        const steps = Number(args.steps);
        if (isNaN(steps) || steps < 1 || steps > 50 || !Number.isInteger(steps)) {
          return { valid: false, reason: "ARGUMENT_VIOLATION: Steps must be an integer between 1 and 50." };
        }
      }
    }

    // 12. interactApp validation (Phase 21)
    if (capability === "interactApp" || capability === "appInteraction" || capability === "interactWithApp" || capability === "mobileAppAction") {
      const rawApp = String(args.app || args.appName || args.application || "").trim();
      const rawAction = String(args.action || args.operation || "launch").trim();

      if (!rawApp) {
        return { valid: false, reason: "ARGUMENT_VIOLATION: Missing required parameter 'app' for interactApp." };
      }

      // Import resolveAppId at validation time
      const { resolveAppId, getAllowedAppActions } = await import("../../platform/android/AndroidCapabilityDescriptors.ts");

      const appId = resolveAppId(rawApp);
      if (!appId) {
        return {
          valid: false,
          reason: `NOT_SUPPORTED: App '${rawApp}' is not in the MYRAA supported app registry. Supported apps: gmail, maps, youtube, calendar, whatsapp.`,
        };
      }

      // Action validation (lenient — Android side does final alias resolution)
      const allowedActions = getAllowedAppActions(appId);
      // Command/shell metacharacter injection guard on all string arguments
      const allStrings = [rawApp, rawAction,
        String(args.query || ""), String(args.recipient || ""), String(args.subject || ""),
        String(args.body || ""), String(args.destination || ""), String(args.title || ""),
        String(args.description || ""), String(args.videoId || ""),
        String(args.phone || ""), String(args.text || ""),
      ].join(" ");

      if (/[;&|`$<>]/.test(allStrings)) {
        return { valid: false, reason: "ARGUMENT_VIOLATION: Dangerous metacharacters detected in interactApp arguments." };
      }

      // Credential/token scan
      const sensitivePatterns = ["sora_dev_", "myraa_at_", "Bearer ", "sk-", "AIza", "password=", "token=", "secret=", "api_key="];
      for (const pat of sensitivePatterns) {
        if (allStrings.includes(pat)) {
          return { valid: false, reason: "SECURITY_VIOLATION: Sensitive credentials cannot be passed in interactApp arguments." };
        }
      }

      // Email address format (for Gmail compose)
      if (appId === "gmail" && (rawAction === "compose" || args.recipient)) {
        const recipient = String(args.recipient || "").trim();
        if (recipient && !/^[A-Za-z0-9+_.-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(recipient)) {
          return { valid: false, reason: `ARGUMENT_VIOLATION: Invalid email address format for Gmail compose: '${recipient}'.` };
        }
      }

      // Phone number format (for WhatsApp compose_message)
      if (appId === "whatsapp" && (rawAction === "compose_message" || args.phone)) {
        const phone = String(args.phone || "").trim();
        if (phone && !/^\+?[0-9][0-9 \-]{6,18}[0-9]$/.test(phone)) {
          return { valid: false, reason: `ARGUMENT_VIOLATION: Invalid phone number format for WhatsApp: '${phone}'.` };
        }
      }

      // YouTube videoId format
      if (appId === "youtube" && (rawAction === "watch" || args.videoId)) {
        const videoId = String(args.videoId || "").trim();
        if (videoId && !/^[A-Za-z0-9_\-]{1,20}$/.test(videoId)) {
          return { valid: false, reason: `ARGUMENT_VIOLATION: Invalid YouTube video ID format: '${videoId}'.` };
        }
      }

      // Length guards
      const checkLen = (field: string, max: number, name: string) => {
        if (field.length > max) return { valid: false as const, reason: `ARGUMENT_VIOLATION: ${name} exceeds ${max} characters.` };
        return null;
      };
      for (const [field, max, name] of [
        [String(args.query || ""), 500, "query"],
        [String(args.subject || ""), 500, "subject"],
        [String(args.destination || ""), 500, "destination"],
        [String(args.title || ""), 500, "title"],
        [String(args.body || ""), 2000, "body"],
        [String(args.text || ""), 2000, "text"],
        [String(args.description || ""), 2000, "description"],
      ] as [string, number, string][]) {
        const err = checkLen(field, max, name);
        if (err) return err;
      }
    }

    // 13. mobileContext validation (Phase 22)
    if (
      capability === "mobileContext" ||
      capability === "getContextSnapshot" ||
      capability === "getMobileContext" ||
      capability === "deviceContext" ||
      capability === "activeMobileContext" ||
      capability === "screenContext"
    ) {
      // Validate categories if provided
      if (args.categories !== undefined && args.categories !== null) {
        if (!Array.isArray(args.categories)) {
          return { valid: false, reason: "ARGUMENT_VIOLATION: Categories must be an array of strings." };
        }

        const validCategories = new Set([
          "app", "activity", "notifications", "device",
          "network", "battery", "screen", "conversation", "task",
        ]);

        for (const cat of args.categories) {
          if (typeof cat !== "string" || !validCategories.has(cat.toLowerCase().trim())) {
            return {
              valid: false,
              reason: `ARGUMENT_VIOLATION: Invalid context category '${cat}'. Allowed categories: app, activity, notifications, device, network, battery, screen, conversation, task.`,
            };
          }
        }
      }

      // Validate approvedScreenContext flag
      if (args.approvedScreenContext !== undefined && typeof args.approvedScreenContext !== "boolean") {
        return { valid: false, reason: "ARGUMENT_VIOLATION: approvedScreenContext must be a boolean flag." };
      }

      // Credential and metacharacter screening
      const allText = [
        String(args.query || ""),
        String(args.screenSummary || ""),
        String(args.rawScreenText || ""),
      ].join(" ");

      if (/[;&|`$<>]/.test(allText)) {
        return { valid: false, reason: "ARGUMENT_VIOLATION: Dangerous metacharacters detected in mobile context arguments." };
      }

      const sensitivePatterns = [
        "sora_dev_", "myraa_at_", "Bearer ", "sk-", "AIza",
        "password=", "token=", "secret=", "api_key=",
      ];
      for (const pat of sensitivePatterns) {
        if (allText.includes(pat)) {
          return {
            valid: false,
            reason: "SECURITY_VIOLATION: Sensitive credentials cannot be passed in mobile context arguments.",
          };
        }
      }

      // Length guards
      if (String(args.query || "").length > 500) {
        return { valid: false, reason: "ARGUMENT_VIOLATION: Query exceeds 500 characters." };
      }
      if (String(args.screenSummary || "").length > 4000) {
        return { valid: false, reason: "ARGUMENT_VIOLATION: Screen summary exceeds 4000 characters." };
      }
    }

    // 14. mobileScreen validation (Phase 23)
    if (
      capability === "mobileScreen" ||
      capability === "screenUnderstanding" ||
      capability === "captureMobileScreen" ||
      capability === "readMobileScreen" ||
      capability === "understandScreen" ||
      capability === "screenCapture"
    ) {
      if (args.approved !== undefined && typeof args.approved !== "boolean") {
        return { valid: false, reason: "ARGUMENT_VIOLATION: approved must be a boolean flag." };
      }

      if (args.captureMode !== undefined) {
        const allowedModes = ["ocr", "visual", "full"];
        if (!allowedModes.includes(String(args.captureMode))) {
          return {
            valid: false,
            reason: `ARGUMENT_VIOLATION: Invalid captureMode '${args.captureMode}'. Allowed: ocr, visual, full.`,
          };
        }
      }

      // Credential and metacharacter screening
      const allText = [
        String(args.query || ""),
        String(args.screenSummary || ""),
        String(args.rawScreenText || ""),
      ].join(" ");

      if (/[;&|`$<>]/.test(allText)) {
        return { valid: false, reason: "ARGUMENT_VIOLATION: Dangerous metacharacters detected in mobile screen arguments." };
      }

      const sensitivePatterns = [
        "sora_dev_", "myraa_at_", "Bearer ", "sk-", "AIza",
        "password=", "token=", "secret=", "api_key=",
      ];
      for (const pat of sensitivePatterns) {
        if (allText.includes(pat)) {
          return {
            valid: false,
            reason: "SECURITY_VIOLATION: Sensitive credentials cannot be passed in mobile screen arguments.",
          };
        }
      }

      // Length guards
      if (String(args.query || "").length > 500) {
        return { valid: false, reason: "ARGUMENT_VIOLATION: Query exceeds 500 characters." };
      }
      if (String(args.screenSummary || "").length > 4000) {
        return { valid: false, reason: "ARGUMENT_VIOLATION: Screen summary exceeds 4000 characters." };
      }
    }

    // ── 15. Shared MYRAA Memory Capability Validation (Phase 24) ────────────
    if (
      capability === "sharedMemory" ||
      capability === "memorySync" ||
      capability === "syncMemory" ||
      capability === "getSharedMemory" ||
      capability === "saveSharedMemory"
    ) {
      const action = String(args.action || "get").toLowerCase();
      const validActions = ["get", "create", "update", "delete", "search", "sync"];
      if (!validActions.includes(action)) {
        return {
          valid: false,
          reason: `ARGUMENT_VIOLATION: Invalid shared memory action '${args.action}'. Allowed: ${validActions.join(", ")}.`,
        };
      }

      const allMeta = [
        String(args.id || ""),
        String(args.category || ""),
        String(args.key || ""),
        String(args.query || ""),
      ].join(" ");

      if (/[;&|`$<>]/.test(allMeta)) {
        return { valid: false, reason: "ARGUMENT_VIOLATION: Dangerous metacharacters detected in shared memory metadata." };
      }

      // Credential and secret screening on text, key, and query
      const textToScreen = [
        String(args.text || ""),
        String(args.query || ""),
        String(args.key || ""),
      ].join(" ");

      const sensitivePatterns = [
        "sora_dev_", "myraa_at_", "Bearer ", "sk-", "AIza",
        "password=", "token=", "secret=", "api_key=",
        "-----BEGIN", "PRIVATE KEY",
      ];
      for (const pat of sensitivePatterns) {
        if (textToScreen.includes(pat)) {
          return {
            valid: false,
            reason: "SECURITY_VIOLATION: Secrets, credentials, or API keys cannot be passed in shared memory arguments.",
          };
        }
      }

      if (String(args.text || "").length > 4000) {
        return { valid: false, reason: "ARGUMENT_VIOLATION: Memory text exceeds 4000 characters." };
      }
      if (String(args.query || "").length > 500) {
        return { valid: false, reason: "ARGUMENT_VIOLATION: Memory search query exceeds 500 characters." };
      }
    }

    // ── 16. Phase 25 — Cross-Device Handoff ──────────────────────────────
    if (capability === "handoff") {
      const action = String(args.action || "").trim().toLowerCase();
      const validActions = ["create", "list", "get", "accept", "resume", "cancel"];
      if (!action || !validActions.includes(action)) {
        return {
          valid: false,
          reason: `ARGUMENT_VIOLATION: Invalid handoff action '${action}'. Must be one of: ${validActions.join(", ")}.`,
        };
      }

      // Check dangerous metacharacters on id, token, targetDeviceId
      const allMeta = [
        String(args.handoffId || ""),
        String(args.handoffToken || ""),
        String(args.targetDeviceId || ""),
      ].join(" ");

      if (/[;&|`$<>]/.test(allMeta)) {
        return { valid: false, reason: "ARGUMENT_VIOLATION: Dangerous metacharacters detected in handoff metadata." };
      }

      // Credential and secret screening
      const textToScreen = [
        JSON.stringify(args.conversationContext || {}),
        JSON.stringify(args.taskPlanState || {}),
        JSON.stringify(args.projectContext || {}),
        JSON.stringify(args.safeUiContext || {}),
      ].join(" ");

      const sensitivePatterns = [
        "sora_dev_", "myraa_at_", "Bearer ", "sk-", "AIza",
        "password=", "token=", "secret=", "api_key=",
        "-----BEGIN", "PRIVATE KEY",
      ];
      for (const pat of sensitivePatterns) {
        if (textToScreen.includes(pat)) {
          return {
            valid: false,
            reason: "SECURITY_VIOLATION: Secrets, credentials, or API keys cannot be passed in handoff arguments.",
          };
        }
      }

      if (String(args.handoffId || "").length > 200) {
        return { valid: false, reason: "ARGUMENT_VIOLATION: Handoff ID exceeds length limit." };
      }
      if (String(args.handoffToken || "").length > 200) {
        return { valid: false, reason: "ARGUMENT_VIOLATION: Handoff token exceeds length limit." };
      }
    }

    // ── 17. Phase 26 — Mobile Proactive Companion ────────────────────────
    if (capability === "mobileProactive") {
      const action = String(args.action || "post").trim().toLowerCase();
      const validActions = [
        "subscribe",
        "unsubscribe",
        "getpreferences",
        "updatepreferences",
        "drainpending",
        "clear",
        "post",
        "test",
        "notify",
      ];
      if (!validActions.includes(action)) {
        return {
          valid: false,
          reason: `ARGUMENT_VIOLATION: Invalid mobile proactive action '${action}'. Must be one of: ${validActions.join(", ")}.`,
        };
      }

      // Check dangerous metacharacters on strings
      const allMeta = [
        String(args.title || ""),
        String(args.actionUrl || ""),
      ].join(" ");

      if (/[;&|`$<>]/.test(allMeta)) {
        return { valid: false, reason: "ARGUMENT_VIOLATION: Dangerous metacharacters detected in proactive metadata." };
      }

      // Credential and secret screening
      const textToScreen = [
        String(args.title || ""),
        String(args.message || ""),
        String(args.voiceText || ""),
        JSON.stringify(args.metadata || {}),
        JSON.stringify(args.preferences || {}),
      ].join(" ");

      const sensitivePatterns = [
        "sora_dev_", "myraa_at_", "Bearer ", "sk-", "AIza",
        "password=", "token=", "secret=", "api_key=",
        "-----BEGIN", "PRIVATE KEY",
      ];
      for (const pat of sensitivePatterns) {
        if (textToScreen.includes(pat)) {
          return {
            valid: false,
            reason: "SECURITY_VIOLATION: Secrets, credentials, or API keys cannot be passed in proactive notification arguments.",
          };
        }
      }

      if (String(args.title || "").length > 200) {
        return { valid: false, reason: "ARGUMENT_VIOLATION: Proactive notification title exceeds 200 characters." };
      }
      if (String(args.message || "").length > 2000) {
        return { valid: false, reason: "ARGUMENT_VIOLATION: Proactive notification message exceeds 2000 characters." };
      }
    }

    // ── 18. Phase 27 — Mobile Autonomous Workflow ────────────────────────
    if (capability === "mobileWorkflow" || capability === "workflow") {
      const query = String(args.query || args.prompt || args.command || "").trim();
      if (!query) {
        return { valid: false, reason: "ARGUMENT_VIOLATION: Workflow query cannot be empty." };
      }
      if (query.length > 500) {
        return { valid: false, reason: "ARGUMENT_VIOLATION: Workflow query exceeds 500 characters." };
      }

      if (/[;&|`$<>]/.test(query)) {
        return { valid: false, reason: "ARGUMENT_VIOLATION: Dangerous metacharacters detected in workflow query." };
      }

      const textToScreen = [
        query,
        String(args.deviceId || ""),
        JSON.stringify(args.clientContext || {}),
      ].join(" ");

      const sensitivePatterns = [
        "sora_dev_", "myraa_at_", "Bearer ", "sk-", "AIza",
        "password=", "token=", "secret=", "api_key=",
        "-----BEGIN", "PRIVATE KEY",
      ];
      for (const pat of sensitivePatterns) {
        if (textToScreen.includes(pat)) {
          return {
            valid: false,
            reason: "SECURITY_VIOLATION: Secrets, credentials, or API keys cannot be passed in workflow arguments.",
          };
        }
      }
    }

    return { valid: true };
  }

  /**
   * Sanitizes external web or search result content to ensure it remains untrusted data
   * and cannot inject directives or prompts into the LLM context.
   */
  fenceWebContent(rawContent: string, metadata?: { url?: string; title?: string }) {
    return contentSanitizer.sanitizeWebContent(rawContent, metadata);
  }

  /**
   * Dispatch a native Android capability execution through the complete security pipeline.
   */
  async dispatchCapability(
    deviceId: string,
    capability: string,
    args: Record<string, unknown>,
    context: SecurityContext,
    confirmationToken?: string
  ): Promise<CapabilityDispatchResult> {
    const auditId = crypto.randomUUID();

    // ── 1. Emergency Stop Killswitch Check ─────────────────────────────────
    if (emergencyStopCoordinator.isActive()) {
      const reason = "EMERGENCY_STOP_ACTIVE: Android capability execution blocked. Killswitch is currently active.";
      securityAuditLogger.logEvent({
        eventType: "TOOL_BLOCKED",
        actor: {
          identityId: context.identityId,
          role: context.role,
          ipAddress: context.ipAddress,
          sessionId: context.sessionId,
          deviceId,
        },
        target: { toolName: capability },
        decision: "BLOCK",
        reason,
        riskLevel: "CRITICAL",
      });
      return {
        ok: false,
        deviceId,
        capability,
        dispatched: false,
        error: reason,
        blocked: true,
        decision: {
          decision: "BLOCK",
          allowed: false,
          risk: { level: "CRITICAL", score: 100, reasons: [reason], requiresConfirmation: false, isCritical: true },
          reason,
          auditId,
        },
      };
    }

    // ── 2. Security Policy Engine Lockdown Check ──────────────────────────
    if (securityPolicyEngine.getMode() === "LOCKDOWN") {
      const reason = `SECURITY_LOCKDOWN: Capability '${capability}' is blocked. System is in fail-closed LOCKDOWN mode.`;
      securityAuditLogger.logEvent({
        eventType: "TOOL_BLOCKED",
        actor: {
          identityId: context.identityId,
          role: context.role,
          ipAddress: context.ipAddress,
          sessionId: context.sessionId,
          deviceId,
        },
        target: { toolName: capability },
        decision: "BLOCK",
        reason,
        riskLevel: "CRITICAL",
      });
      return {
        ok: false,
        deviceId,
        capability,
        dispatched: false,
        error: reason,
        blocked: true,
        decision: {
          decision: "BLOCK",
          allowed: false,
          risk: { level: "CRITICAL", score: 100, reasons: [reason], requiresConfirmation: false, isCritical: true },
          reason,
          auditId,
        },
      };
    }

    // ── 3. Device Revocation & Store Check ────────────────────────────────
    const device = await remoteStore.getDevice(deviceId);
    if (!device || device.revoked) {
      const reason = `DEVICE_REVOKED: Device '${deviceId}' is not registered or has been revoked.`;
      return {
        ok: false,
        deviceId,
        capability,
        dispatched: false,
        error: reason,
        blocked: true,
        decision: {
          decision: "BLOCK",
          allowed: false,
          risk: { level: "HIGH", score: 85, reasons: [reason], requiresConfirmation: false, isCritical: false },
          reason,
          auditId,
        },
      };
    }

    // ── 4. Parameter-Level Safety & SSRF Validation ──────────────────────
    const argCheck = await this.validateCapabilityArguments(capability, args);
    if (!argCheck.valid) {
      const reason = argCheck.reason || "Parameter validation failed.";
      securityAuditLogger.logEvent({
        eventType: "ARGUMENT_VIOLATION",
        actor: {
          identityId: context.identityId,
          role: context.role,
          ipAddress: context.ipAddress,
          sessionId: context.sessionId,
          deviceId,
        },
        target: { toolName: capability },
        decision: "BLOCK",
        reason,
        riskLevel: "HIGH",
      });
      return {
        ok: false,
        deviceId,
        capability,
        dispatched: false,
        error: reason,
        blocked: true,
        decision: {
          decision: "BLOCK",
          allowed: false,
          risk: { level: "HIGH", score: 80, reasons: [reason], requiresConfirmation: false, isCritical: false },
          reason,
          auditId,
        },
      };
    }

    // ── 5. ToolExecutionFirewall Mandatory Pipeline ───────────────────────
    const callId = crypto.randomUUID();
    const firewallResult = await toolExecutionFirewall.executeGuardedTool(
      capability,
      args,
      context,
      async () => {
        // Executor: Send toolCall to active Android client socket
        const sent = remoteSessionManager.sendToolCallToDevice(deviceId, {
          callId,
          name: capability,
          args,
        });

        return {
          callId,
          dispatched: sent,
          deviceId,
          capability,
          status: sent ? "dispatched_to_device" : "queued_offline",
          timestamp: new Date().toISOString(),
        };
      },
      confirmationToken
    );

    const isDispatched = firewallResult.ok && Boolean((firewallResult.result as any)?.dispatched);

    return {
      ...firewallResult,
      deviceId,
      capability,
      dispatched: isDispatched,
    };
  }
}

export const remoteCapabilityDispatcher = new RemoteCapabilityDispatcher();
