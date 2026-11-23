/**
 * MYRAA — Advanced Browser Intelligence Subsystem
 * BrowserQueryPlanner.ts
 *
 * Generates a bounded, deterministic execution plan for browser tasks.
 * Enforces origin restrictions, step limits, timeout constraints, SSRF security checks,
 * and multi-step interactive workflows (clicking, typing, scrolling, tab management).
 */

import crypto from "crypto";
import { researchSecurityGate } from "../ResearchSecurityGate.ts";
import { securityAuditLogger } from "../../security/SecurityAuditLogger.ts";
import type {
  BrowserTaskPlan,
  BrowserTaskStep,
  BrowserTaskRequest,
} from "./BrowserIntelligenceTypes.ts";
import type { InterpretedBrowserIntent } from "./BrowserIntentInterpreter.ts";

/**
 * Normalizes an origin/domain string into a clean lowercase hostname.
 * Handles protocol prefixes (http://, https://), trailing slashes/paths, ports, and leading dots.
 */
export function normalizeOrigin(raw: string): string {
  if (!raw || typeof raw !== "string") return "";
  let trimmed = raw.trim().toLowerCase();
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    try {
      trimmed = new URL(trimmed).hostname.toLowerCase();
    } catch {
      trimmed = trimmed.replace(/^https?:\/\//i, "").split("/")[0];
    }
  } else if (trimmed.includes("/")) {
    trimmed = trimmed.split("/")[0];
  }
  if (trimmed.includes(":") && !trimmed.includes("::")) {
    trimmed = trimmed.split(":")[0];
  }
  return trimmed.replace(/^\.+/, "").replace(/\.+$/, "");
}

/**
 * Checks whether targetUrlOrHostname is permitted by a single allowed origin.
 * Matches exact hostname or valid subdomain (.origin).
 * Strictly prevents deceptive suffix attacks (e.g. "example.com.evil.org" vs "example.com").
 */
export function isHostnameAllowedByOrigin(targetUrlOrHostname: string, rawOrigin: string): boolean {
  const normTarget = normalizeOrigin(targetUrlOrHostname);
  const normOrigin = normalizeOrigin(rawOrigin);
  if (!normTarget || !normOrigin) return false;

  // Exact match
  if (normTarget === normOrigin) return true;

  // Subdomain match: must end with ".<origin>"
  if (normTarget.endsWith(`.${normOrigin}`)) {
    return true;
  }

  return false;
}

/**
 * Validates a target URL/hostname against an array of allowed origins.
 */
export function isTargetAllowedByOrigins(targetUrlOrHostname: string, allowedOrigins: string[]): boolean {
  if (!allowedOrigins || allowedOrigins.length === 0) return false;
  return allowedOrigins.some((origin) => isHostnameAllowedByOrigin(targetUrlOrHostname, origin));
}

export class BrowserQueryPlanner {
  /**
   * Plans a browser task based on user request and interpreted intent.
   */
  public async plan(
    req: BrowserTaskRequest,
    intent: InterpretedBrowserIntent
  ): Promise<BrowserTaskPlan> {
    const planId = `bplan_${crypto.randomBytes(4).toString("hex")}`;
    const timeoutMs = Math.min(Math.max(req.timeoutMs || 45_000, 5_000), 120_000);
    const maxRetries = Math.min(Math.max(req.maxRetries ?? 3, 1), 5);

    const steps: BrowserTaskStep[] = [];
    const isExplicitAllowlist = Array.isArray(req.allowedOrigins);
    const allowedOrigins = isExplicitAllowlist
      ? req.allowedOrigins!.map(normalizeOrigin).filter(Boolean)
      : [...(intent.originRestrictions || []).map(normalizeOrigin).filter(Boolean)];

    // 1. Gather all candidate URLs from initialUrl, intent target, comparisonUrls, and goal text
    const candidateUrls: Array<{ url: string; source: string }> = [];

    if (req.initialUrl && typeof req.initialUrl === "string" && req.initialUrl.trim()) {
      candidateUrls.push({ url: req.initialUrl.trim(), source: "initialUrl" });
    }
    if (intent.targetUrl && typeof intent.targetUrl === "string" && intent.targetUrl.trim()) {
      if (!candidateUrls.some((c) => c.url === intent.targetUrl!.trim())) {
        candidateUrls.push({ url: intent.targetUrl.trim(), source: "goal target" });
      }
    }
    if (Array.isArray(intent.comparisonUrls)) {
      for (const u of intent.comparisonUrls) {
        if (u && typeof u === "string" && u.trim() && !candidateUrls.some((c) => c.url === u.trim())) {
          candidateUrls.push({ url: u.trim(), source: "comparison target" });
        }
      }
    }
    const extractedGoalUrls = (req.goal || "").match(/https?:\/\/[^\s"'<>]+/gi) || [];
    for (const u of extractedGoalUrls) {
      if (u && !candidateUrls.some((c) => c.url === u.trim())) {
        candidateUrls.push({ url: u.trim(), source: "goal" });
      }
    }

    // 2. Strict Origin Boundary Validation (Fail closed before any actions are planned)
    if (isExplicitAllowlist) {
      if (allowedOrigins.length === 0) {
        const targetDesc = candidateUrls.length > 0 ? candidateUrls[0].url : "browser navigation";
        const reason = `ORIGIN_RESTRICTION: Explicit allowedOrigins is empty (fail-closed). Target '${targetDesc}' is blocked.`;
        securityAuditLogger.logEvent({
          eventType: "TOOL_BLOCKED",
          actor: { identityId: "browser_intelligence", role: "standard", ipAddress: "127.0.0.1" },
          target: { toolName: "browserQueryPlanner", resource: targetDesc },
          riskLevel: "HIGH",
          decision: "BLOCK",
          reason,
          metadata: { goal: req.goal, candidateUrls: candidateUrls.map((c) => c.url), allowedOrigins },
        });
        throw new Error(reason);
      }

      for (const { url, source } of candidateUrls) {
        if (!isTargetAllowedByOrigins(url, allowedOrigins)) {
          const reason = `ORIGIN_RESTRICTION: Target URL '${url}' from ${source} is outside task-scoped allowedOrigins (${allowedOrigins.join(", ")}).`;
          securityAuditLogger.logEvent({
            eventType: "TOOL_BLOCKED",
            actor: { identityId: "browser_intelligence", role: "standard", ipAddress: "127.0.0.1" },
            target: { toolName: "browserQueryPlanner", resource: url },
            riskLevel: "HIGH",
            decision: "BLOCK",
            reason,
            metadata: { goal: req.goal, targetUrl: url, source, allowedOrigins },
          });
          throw new Error(reason);
        }
      }
    }

    // 3. Validate ALL candidate URLs against SSRF / private-network protections
    for (const { url } of candidateUrls) {
      const secCheck = await researchSecurityGate.validateUrl(url);
      if (!secCheck.safe) {
        throw new Error(
          `SECURITY_VIOLATION: Target URL blocked by security gate: ${url} (${secCheck.reason})`
        );
      }
    }

    // 4. Auto-derive origins ONLY when caller omitted the allowlist
    if (!isExplicitAllowlist) {
      for (const { url } of candidateUrls) {
        try {
          const parsed = new URL(url);
          const normHost = normalizeOrigin(parsed.hostname);
          if (normHost && !allowedOrigins.includes(normHost)) {
            allowedOrigins.push(normHost);
          }
        } catch {
          // ignore
        }
      }
    }

    // Multi-Document Comparison Planning
    if (intent.primaryAction === "COMPARE_DOCUMENTS" && intent.comparisonUrls && intent.comparisonUrls.length >= 2) {
      for (let i = 0; i < intent.comparisonUrls.length; i++) {
        const u = intent.comparisonUrls[i];

        // Navigation step
        steps.push({
          stepId: `step_nav_${Date.now()}_${steps.length + 1}`,
          action: i === 0 ? "OPEN_URL" : "OPEN_TAB",
          target: u,
          params: { url: u, title: `Doc ${i + 1}` },
          status: "PENDING",
          retries: 0,
          maxRetries,
        });

        // Structured Extraction step
        steps.push({
          stepId: `step_ext_${Date.now()}_${steps.length + 1}`,
          action: "EXTRACT_DOM",
          target: u,
          params: { preferStructured: true },
          status: "PENDING",
          retries: 0,
          maxRetries,
        });
      }

      // Comparison execution step
      steps.push({
        stepId: `step_cmp_${Date.now()}_${steps.length + 1}`,
        action: "COMPARE_DOCUMENTS",
        target: intent.comparisonUrls.join(" vs "),
        params: { urls: intent.comparisonUrls, focusArea: intent.focusArea },
        status: "PENDING",
        retries: 0,
        maxRetries: 1,
      });

      // Synthesis step
      steps.push({
        stepId: `step_syn_${Date.now()}_${steps.length + 1}`,
        action: "SUMMARIZE_RESEARCH",
        params: { focusArea: intent.focusArea, requiresMultiSource: true },
        status: "PENDING",
        retries: 0,
        maxRetries: 1,
      });

      return {
        planId,
        goal: req.goal,
        steps: steps.slice(0, 10),
        allowedOrigins,
        timeoutMs,
        maxRetries,
        estimatedComplexity: "COMPLEX",
      };
    }

    // Single-target Navigation / Search Planning
    const initialUrl = req.initialUrl?.trim();
    const goalTargetUrl = intent.targetUrl?.trim();

    // If primaryAction is SEARCH, navigation is SEARCH action
    if (intent.primaryAction === "SEARCH") {
      const searchUrl = goalTargetUrl || initialUrl;
      if (searchUrl) {
        steps.push({
          stepId: `step_search_${Date.now()}_1`,
          action: "SEARCH",
          target: searchUrl,
          params: { query: intent.searchQuery, url: searchUrl },
          status: "PENDING",
          retries: 0,
          maxRetries,
        });
      }
    } else {
      // Regular navigation: preserve both initialUrl and goalTargetUrl if both exist and differ
      if (initialUrl && goalTargetUrl && initialUrl !== goalTargetUrl) {
        // Step 1: Open starting URL
        steps.push({
          stepId: `step_nav_${Date.now()}_1`,
          action: "OPEN_URL",
          target: initialUrl,
          params: { url: initialUrl },
          status: "PENDING",
          retries: 0,
          maxRetries,
        });
        // Step 2: Navigate to intended goal target URL
        steps.push({
          stepId: `step_nav_${Date.now()}_2`,
          action: "NAVIGATE",
          target: goalTargetUrl,
          params: { url: goalTargetUrl },
          status: "PENDING",
          retries: 0,
          maxRetries,
        });
      } else {
        const navUrl = goalTargetUrl || initialUrl;
        if (navUrl) {
          steps.push({
            stepId: `step_nav_${Date.now()}_1`,
            action: "OPEN_URL",
            target: navUrl,
            params: { url: navUrl },
            status: "PENDING",
            retries: 0,
            maxRetries,
          });
        }
      }
    }

    const targetUrl = goalTargetUrl || initialUrl;

    // Interactive Action Step (CLICK, TYPE, SCROLL, FILL_FORM, TABS, etc.)
    const interactiveActions = [
      "CLICK",
      "TYPE",
      "FILL_FORM",
      "SELECT",
      "SCROLL",
      "WAIT_FOR",
      "OPEN_TAB",
      "CLOSE_TAB",
      "SWITCH_TAB",
      "GO_BACK",
      "GO_FORWARD",
      "RELOAD",
    ];

    if (interactiveActions.includes(intent.primaryAction)) {
      steps.push({
        stepId: `step_act_${Date.now()}_${steps.length + 1}`,
        action: intent.primaryAction,
        target: intent.interactionTarget || targetUrl,
        params: intent.interactionParams,
        status: "PENDING",
        retries: 0,
        maxRetries,
      });
    }

    // Step 2: Extraction (DOM / Tables / Links)
    if (intent.tableExtractionRequested) {
      steps.push({
        stepId: `step_tbl_${Date.now()}_${steps.length + 1}`,
        action: "EXTRACT_TABLE",
        status: "PENDING",
        retries: 0,
        maxRetries,
      });
    }

    // Extraction step (unless pure tab close/switch)
    if (!["CLOSE_TAB", "SWITCH_TAB"].includes(intent.primaryAction) || targetUrl) {
      steps.push({
        stepId: `step_ext_${Date.now()}_${steps.length + 1}`,
        action: "EXTRACT_DOM",
        params: {
          preferStructured: req.preferStructuredExtraction ?? true,
        },
        status: "PENDING",
        retries: 0,
        maxRetries,
      });
    }

    // Step 3: Synthesis / Research Handoff
    if ((req.enableResearchHandoff ?? true) && steps.length > 0) {
      steps.push({
        stepId: `step_syn_${Date.now()}_${steps.length + 1}`,
        action: "SUMMARIZE_RESEARCH",
        params: {
          focusArea: intent.focusArea,
          requiresMultiSource: intent.requiresMultiSource,
        },
        status: "PENDING",
        retries: 0,
        maxRetries: 1,
      });
    }

    const estimatedComplexity: "SIMPLE" | "MODERATE" | "COMPLEX" =
      steps.length <= 2 ? "SIMPLE" : steps.length <= 4 ? "MODERATE" : "COMPLEX";

    return {
      planId,
      goal: req.goal,
      steps: steps.slice(0, 10), // Hard upper bound of 10 steps
      allowedOrigins,
      timeoutMs,
      maxRetries,
      estimatedComplexity,
    };
  }
}

export const browserQueryPlanner = new BrowserQueryPlanner();
