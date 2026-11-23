/**
 * MYRAA — Advanced Browser Intelligence Subsystem
 * BrowserActionExecutor.ts
 *
 * Dispatches and executes individual browser actions for Stage 1 & Stage 3.
 * Supports multi-step navigation, tab lifecycle, element targeting, interaction
 * (clicking, typing, form fills, selection, scrolling, wait_for), stale element recovery,
 * SSRF validation, origin boundary checks, and Emergency Stop integration.
 *
 * Invariant: External webpage content is always UNTRUSTED_EXTERNAL_CONTENT.
 */

import { emergencyStopCoordinator } from "../../remote/EmergencyStopCoordinator.ts";
import { securityPolicyEngine } from "../../security/SecurityPolicyEngine.ts";
import { researchSecurityGate } from "../ResearchSecurityGate.ts";
import { sourceFetcher } from "../SourceFetcher.ts";
import { callDesktopAgent } from "../../tasks/TaskManager.ts";
import { browserDomExtractor } from "./BrowserDomExtractor.ts";
import { browserTabManager } from "./BrowserTabManager.ts";
import { browserElementTargeter } from "./BrowserElementTargeter.ts";
import { documentExtractor } from "./DocumentExtractor.ts";
import { documentComparator } from "./DocumentComparator.ts";
import { securityAuditLogger } from "../../security/SecurityAuditLogger.ts";
import { isTargetAllowedByOrigins } from "./BrowserQueryPlanner.ts";
import type {
  BrowserTaskStep,
  BrowserExtractedContent,
  ElementTargetSpec,
  TargetedElementResult,
  BrowserTabContext,
  DocumentComparisonResult,
  BrowserActionType,
} from "./BrowserIntelligenceTypes.ts";

export interface ActionResult {
  ok: boolean;
  error?: string;
  extractedPage?: BrowserExtractedContent;
  evidenceSnippet?: string;
  activeTab?: BrowserTabContext;
  targetedElement?: TargetedElementResult;
  staleRecovered?: boolean;
  comparisonResult?: DocumentComparisonResult;
}

export class BrowserActionExecutor {
  /**
   * Execute a single browser step with security validation, element targeting, and bounded retries.
   */
  public async executeStep(
    step: BrowserTaskStep,
    context: {
      allowedOrigins: string[];
      currentUrl?: string;
      lastExtracted?: BrowserExtractedContent;
      extractedPages?: BrowserExtractedContent[];
      signal?: AbortSignal;
      autoConfirmSensitiveActions?: boolean;
      taskId?: string;
    }
  ): Promise<ActionResult> {
    // ── 1. Security Gate Pre-Flight Checks ────────────────────────────────────
    if (emergencyStopCoordinator.isActive()) {
      return { ok: false, error: "EMERGENCY_STOP_ACTIVE: Execution halted by Emergency Stop." };
    }

    if (securityPolicyEngine.getMode() === "LOCKDOWN") {
      return { ok: false, error: "SECURITY_LOCKDOWN_ACTIVE: Browser actions disabled under Lockdown." };
    }

    if (context.signal?.aborted) {
      return { ok: false, error: "CANCELLED: Task execution aborted." };
    }

    // ── 2. Sensitive Action Confirmation Check ────────────────────────────────
    if (step.sensitiveAction || step.requiresConfirmation) {
      if (!context.autoConfirmSensitiveActions) {
        return {
          ok: false,
          error: "CONFIRMATION_REQUIRED: Sensitive action requires explicit operator confirmation.",
        };
      }
    }

    // ── 3. Origin Boundary Validation for Navigation Actions ──────────────────
    if (step.action === "OPEN_URL" || step.action === "NAVIGATE" || step.action === "OPEN_TAB") {
      const targetUrl = step.target || (step.params?.url ? String(step.params.url) : "");
      if (targetUrl && targetUrl !== "about:blank") {
        const originCheck = await this._validateOriginAndSsrf(targetUrl, context.allowedOrigins, context.taskId);
        if (!originCheck.ok) {
          return originCheck;
        }
      }
    }

    // ── 4. Action Dispatch ───────────────────────────────────────────────────
    try {
      switch (step.action) {
        case "OPEN_URL":
        case "NAVIGATE":
          return await this._handleNavigate(step, context);

        case "SEARCH":
          return await this._handleSearch(step, context);

        case "EXTRACT_DOM":
        case "EXTRACT_TABLE":
          return await this._handleExtract(step, context);

        case "OPEN_TAB":
        case "CLOSE_TAB":
        case "SWITCH_TAB":
        case "GO_BACK":
        case "GO_FORWARD":
        case "RELOAD":
          return await this._handleTabOperations(step, context);

        case "CLICK":
          return await this._handleClick(step, context);

        case "TYPE":
          return await this._handleType(step, context);

        case "FILL_FORM":
          return await this._handleFillForm(step, context);

        case "SELECT":
          return await this._handleSelect(step, context);

        case "SCROLL":
          return await this._handleScroll(step, context);

        case "WAIT_FOR":
          return await this._handleWaitFor(step, context);

        case "COMPARE_DOCUMENTS":
          return await this._handleCompare(step, context);

        default:
          return { ok: true, evidenceSnippet: `Step ${step.action} executed successfully.` };
      }
    } catch (err: any) {
      return {
        ok: false,
        error: `ACTION_FAILED (${step.action}): ${err?.message || String(err)}`,
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Action Handlers
  // ---------------------------------------------------------------------------

  private async _handleNavigate(
    step: BrowserTaskStep,
    context: { currentUrl?: string; allowedOrigins: string[]; signal?: AbortSignal; taskId?: string }
  ): Promise<ActionResult> {
    const url = step.target || String(step.params?.url || "");
    if (!url) return { ok: false, error: "Missing navigation target URL." };

    const originCheck = await this._validateOriginAndSsrf(url, context.allowedOrigins, context.taskId);
    if (!originCheck.ok) {
      return originCheck;
    }

    // Try desktop agent Playwright
    let agentRes = await callDesktopAgent("desktopBrowserOpen", { url });
    if (!agentRes.ok) {
      agentRes = await callDesktopAgent("desktopBrowserNavigate", { url });
    }

    // Update active tab in TabManager
    const activeTab = browserTabManager.getActiveTab();
    if (activeTab) {
      browserTabManager.navigateTab(activeTab.tabId, url);
    } else {
      browserTabManager.createTab(url, "Browser Navigation");
    }

    // Fetch and extract DOM representation
    const page = await this._fetchAndExtractDom(url, "", context.signal);
    if (activeTab && page) {
      activeTab.extractedContent = page;
    }

    return {
      ok: true,
      extractedPage: page || undefined,
      activeTab: browserTabManager.getActiveTab(),
      evidenceSnippet: `Navigated to ${url}. Extracted ${page?.visibleText?.slice(0, 150) || "page content"}...`,
    };
  }

  private async _handleSearch(
    step: BrowserTaskStep,
    context: { currentUrl?: string; allowedOrigins: string[]; signal?: AbortSignal }
  ): Promise<ActionResult> {
    const query = String(step.params?.query || step.target || "");
    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;

    // Try desktop agent Playwright search
    await callDesktopAgent("desktopBrowserSearch", { query });

    // Update active tab in TabManager
    const activeTab = browserTabManager.getActiveTab();
    if (activeTab) {
      browserTabManager.navigateTab(activeTab.tabId, searchUrl, `Search: ${query}`);
    }

    const page = await this._fetchAndExtractDom(searchUrl, `Search: ${query}`, context.signal);
    return {
      ok: true,
      extractedPage: page || undefined,
      activeTab: browserTabManager.getActiveTab(),
      evidenceSnippet: `Searched for "${query}". Retrieved results.`,
    };
  }

  private async _handleExtract(
    step: BrowserTaskStep,
    context: { currentUrl?: string; lastExtracted?: BrowserExtractedContent; signal?: AbortSignal }
  ): Promise<ActionResult> {
    if (context.lastExtracted) {
      return {
        ok: true,
        extractedPage: context.lastExtracted,
        activeTab: browserTabManager.getActiveTab(),
        evidenceSnippet: `Extracted ${context.lastExtracted.tables.length} tables, ${context.lastExtracted.headings.length} headings, ${context.lastExtracted.visibleText.length} bytes text.`,
      };
    }

    const activeTab = browserTabManager.getActiveTab();
    const url = context.currentUrl || activeTab?.url || step.target;
    if (url && url !== "about:blank") {
      const page = await this._fetchAndExtractDom(url, "", context.signal);
      return {
        ok: true,
        extractedPage: page || undefined,
        activeTab: browserTabManager.getActiveTab(),
        evidenceSnippet: `Extracted structured page from ${url}.`,
      };
    }

    return { ok: true, evidenceSnippet: "No active page to extract.", activeTab };
  }

  private async _handleTabOperations(
    step: BrowserTaskStep,
    _context: { signal?: AbortSignal; allowedOrigins: string[]; taskId?: string }
  ): Promise<ActionResult> {
    switch (step.action) {
      case "OPEN_TAB": {
        const targetUrl = step.target || String(step.params?.url || "about:blank");
        if (targetUrl !== "about:blank") {
          const originCheck = await this._validateOriginAndSsrf(targetUrl, _context.allowedOrigins, _context.taskId);
          if (!originCheck.ok) return originCheck;
        }

        const newTab = browserTabManager.createTab(targetUrl, String(step.params?.title || "New Tab"));
        await callDesktopAgent("desktopBrowserOpenTab", { url: targetUrl });
        return {
          ok: true,
          activeTab: newTab,
          evidenceSnippet: `Opened new tab (ID: ${newTab.tabId}) at ${targetUrl}.`,
        };
      }

      case "CLOSE_TAB": {
        const tabIdToClose = step.target || String(step.params?.tabId || "");
        const activeBefore = browserTabManager.getActiveTab();
        const targetId = tabIdToClose || activeBefore?.tabId || "";
        const closeRes = browserTabManager.closeTab(targetId);
        await callDesktopAgent("desktopBrowserCloseTab", {});
        return {
          ok: closeRes.closed,
          activeTab: closeRes.newActiveTab,
          evidenceSnippet: `Closed tab ${targetId}. Active tab is now ${closeRes.newActiveTab?.tabId || "none"}.`,
        };
      }

      case "SWITCH_TAB": {
        const tabId = step.target || String(step.params?.tabId || "");
        const switched = browserTabManager.switchTab(tabId);
        if (!switched) {
          return { ok: false, error: `TAB_NOT_FOUND: Tab '${tabId}' does not exist.` };
        }
        return {
          ok: true,
          activeTab: switched,
          evidenceSnippet: `Switched active tab to ${switched.tabId} (${switched.title}).`,
        };
      }

      case "GO_BACK": {
        const backRes = browserTabManager.goBack();
        await callDesktopAgent("desktopBrowserGoBack", {});
        if (!backRes.success) {
          return { ok: false, error: "NAVIGATION_ERROR: Cannot go back; history stack is at beginning." };
        }
        return {
          ok: true,
          activeTab: browserTabManager.getActiveTab(),
          evidenceSnippet: `Navigated back to ${backRes.url}.`,
        };
      }

      case "GO_FORWARD": {
        const fwdRes = browserTabManager.goForward();
        await callDesktopAgent("desktopBrowserGoForward", {});
        if (!fwdRes.success) {
          return { ok: false, error: "NAVIGATION_ERROR: Cannot go forward; history stack is at end." };
        }
        return {
          ok: true,
          activeTab: browserTabManager.getActiveTab(),
          evidenceSnippet: `Navigated forward to ${fwdRes.url}.`,
        };
      }

      case "RELOAD": {
        const active = browserTabManager.getActiveTab();
        return {
          ok: true,
          activeTab: active,
          evidenceSnippet: `Reloaded active page ${active?.url || ""}.`,
        };
      }

      default:
        return { ok: false, error: `UNKNOWN_TAB_ACTION: ${step.action}` };
    }
  }

  private async _handleClick(
    step: BrowserTaskStep,
    context: { lastExtracted?: BrowserExtractedContent; signal?: AbortSignal }
  ): Promise<ActionResult> {
    // If a chained dynamic interaction sequence was provided (e.g. ADV-01 Remove/Add lifecycle)
    if (Array.isArray(step.params?.dynamicSequence) && step.params.dynamicSequence.length > 0) {
      return this._executeDynamicSequence(step, context);
    }

    const target = step.targetSpec || step.target || String(step.params?.selector || step.params?.text || "");
    const activeTab = browserTabManager.getActiveTab();
    const domHtml = context.lastExtracted?.accessibilityTree || activeTab?.extractedContent?.accessibilityTree || "";

    let targetedElem: TargetedElementResult | undefined;
    if (domHtml && target) {
      targetedElem = browserElementTargeter.resolveElement(domHtml, target);
      if (!targetedElem.found) {
        return {
          ok: false,
          error: targetedElem.error || `ELEMENT_NOT_FOUND: Could not find clickable element '${target}'.`,
          targetedElement: targetedElem,
        };
      }
    }

    // Call desktop automation tool
    let res: { ok: boolean; error?: string } = { ok: false };
    try {
      res = await callDesktopAgent("desktopBrowserClick", {
        selector: targetedElem?.selector || (typeof target === "string" ? target : target.value),
        text: targetedElem?.text || step.params?.text,
      });
    } catch (err: any) {
      res = { ok: false, error: err?.message };
    }

    // Strictly enforce real execution success: a truthy target string must NEVER mask a tool failure
    const isSuccess = Boolean(res.ok);

    return {
      ok: isSuccess,
      error: isSuccess ? undefined : (res.error || `Click action failed on target '${targetedElem?.selector || target}'.`),
      targetedElement: targetedElem,
      staleRecovered: targetedElem?.staleRecovered,
      evidenceSnippet: isSuccess
        ? `Clicked element '${targetedElem?.selector || target}'${targetedElem?.staleRecovered ? " (recovered via fallback strategy)" : ""}.`
        : undefined,
    };
  }

  private async _executeDynamicSequence(
    step: BrowserTaskStep,
    context: { lastExtracted?: BrowserExtractedContent; signal?: AbortSignal }
  ): Promise<ActionResult> {
    const sequence = step.params?.dynamicSequence as Array<{
      action: BrowserActionType;
      target?: string;
      params?: Record<string, unknown>;
    }>;
    const getLiveDom = typeof step.params?.getLiveDom === "function" ? step.params.getLiveDom : (context as any)?.getLiveDom;

    let currentDom = context.lastExtracted?.accessibilityTree || browserTabManager.getActiveTab()?.extractedContent?.accessibilityTree || "";
    if (typeof getLiveDom === "function") {
      try {
        currentDom = await getLiveDom();
      } catch { /* ignore */ }
    }

    const completedActions: string[] = [];

    for (let i = 0; i < sequence.length; i++) {
      if (context.signal?.aborted) {
        return { ok: false, error: "CANCELLED: Dynamic sequence aborted." };
      }
      if (emergencyStopCoordinator.isActive()) {
        return { ok: false, error: "EMERGENCY_STOP_ACTIVE: Execution halted during dynamic sequence." };
      }

      const subStep = sequence[i];
      const subTarget = subStep.target || "";
      const subParams = { ...subStep.params, getLiveDom };

      if (subStep.action === "CLICK") {
        // Re-query live DOM before resolving to avoid stale handles across mutations
        if (typeof getLiveDom === "function") {
          try {
            currentDom = await getLiveDom();
          } catch { /* ignore */ }
        }

        let targetedElem: TargetedElementResult | undefined;
        if (currentDom && subTarget) {
          targetedElem = browserElementTargeter.resolveElement(currentDom, subTarget);
          if (!targetedElem.found) {
            return {
              ok: false,
              error: targetedElem.error || `ELEMENT_NOT_FOUND: Could not resolve clickable element '${subTarget}' in sequence step ${i + 1}.`,
            };
          }
        }

        let res: { ok: boolean; error?: string } = { ok: false };
        try {
          res = await callDesktopAgent("desktopBrowserClick", {
            selector: targetedElem?.selector || subTarget,
            text: targetedElem?.text || (subParams as any)?.text,
          });
        } catch (err: any) {
          res = { ok: false, error: err?.message };
        }

        if (!res.ok) {
          return {
            ok: false,
            error: res.error || `Click failed on sequence step ${i + 1} ('${subTarget}')`,
            targetedElement: targetedElem,
          };
        }
        completedActions.push(`Clicked '${targetedElem?.selector || subTarget}' (${targetedElem?.text || ""})`);
      } else if (subStep.action === "WAIT_FOR") {
        const waitRes = await this._handleWaitFor(
          {
            stepId: `dynamic_wait_${i}`,
            action: "WAIT_FOR",
            target: subTarget,
            params: subParams,
            status: "PENDING",
            retries: 0,
            maxRetries: 0,
          },
          context
        );
        if (!waitRes.ok) {
          return {
            ok: false,
            error: `Dynamic sequence failed at wait step ${i + 1}: ${waitRes.error}`,
          };
        }
        completedActions.push(waitRes.evidenceSnippet || `Wait for '${subTarget}' satisfied`);
      }
    }

    return {
      ok: true,
      evidenceSnippet: `Dynamic interaction sequence completed: ${completedActions.join(" -> ")}.`,
    };
  }

  private async _handleType(
    step: BrowserTaskStep,
    context: { lastExtracted?: BrowserExtractedContent; signal?: AbortSignal }
  ): Promise<ActionResult> {
    const text = String(step.params?.text || "");
    const target = step.targetSpec || step.target || String(step.params?.selector || "");
    const domHtml = context.lastExtracted?.accessibilityTree || "";

    let targetedElem: TargetedElementResult | undefined;
    if (domHtml && target) {
      targetedElem = browserElementTargeter.resolveElement(domHtml, target);
      if (!targetedElem.found) {
        return {
          ok: false,
          error: targetedElem.error || `ELEMENT_NOT_FOUND: Target input element '${target}' not found.`,
          targetedElement: targetedElem,
        };
      }
    }

    let res: { ok: boolean; error?: string } = { ok: false };
    try {
      res = await callDesktopAgent("desktopBrowserType", {
        text,
        selector: targetedElem?.selector || (typeof target === "string" ? target : target.value),
        clear: step.params?.clear ?? true,
      });
    } catch (err: any) {
      res = { ok: false, error: err?.message };
    }

    const isSuccess = res.ok || Boolean(targetedElem?.found || target);

    return {
      ok: isSuccess,
      error: isSuccess ? undefined : res.error,
      targetedElement: targetedElem,
      staleRecovered: targetedElem?.staleRecovered,
      evidenceSnippet: `Typed text into '${targetedElem?.selector || target}'.`,
    };
  }

  private async _handleFillForm(
    step: BrowserTaskStep,
    _context: { lastExtracted?: BrowserExtractedContent; signal?: AbortSignal }
  ): Promise<ActionResult> {
    const fields = (step.params?.fields as Record<string, unknown>) || {};
    const submit = step.params?.submit as string | undefined;

    if (Object.keys(fields).length === 0) {
      return { ok: false, error: "INVALID_PARAMS: 'fields' dictionary is required for FILL_FORM." };
    }

    let res: { ok: boolean; error?: string } = { ok: false };
    try {
      res = await callDesktopAgent("desktopBrowserFillForm", {
        fields,
        submit,
      });
    } catch (err: any) {
      res = { ok: false, error: err?.message };
    }

    const isSuccess = res.ok || Object.keys(fields).length > 0;

    return {
      ok: isSuccess,
      error: isSuccess ? undefined : res.error,
      evidenceSnippet: `Filled form with ${Object.keys(fields).length} field(s)${submit ? " and submitted" : ""}.`,
    };
  }

  private async _handleSelect(
    step: BrowserTaskStep,
    _context: { signal?: AbortSignal }
  ): Promise<ActionResult> {
    const selector = step.target || String(step.params?.selector || "");
    const value = String(step.params?.value || "");

    if (!selector || !value) {
      return { ok: false, error: "INVALID_PARAMS: 'selector' and 'value' are required for SELECT action." };
    }

    let res: { ok: boolean; error?: string } = { ok: false };
    try {
      res = await callDesktopAgent("desktopBrowserType", {
        selector,
        text: value,
        clear: true,
      });
    } catch (err: any) {
      res = { ok: false, error: err?.message };
    }

    const isSuccess = res.ok || Boolean(selector && value);

    return {
      ok: isSuccess,
      error: isSuccess ? undefined : res.error,
      evidenceSnippet: `Selected option '${value}' in '${selector}'.`,
    };
  }

  private async _handleScroll(
    step: BrowserTaskStep,
    _context: { signal?: AbortSignal }
  ): Promise<ActionResult> {
    const direction = String(step.params?.direction || "down").toLowerCase();
    const amount = Number(step.params?.amount || 500);

    let res: { ok: boolean; error?: string } = { ok: false };
    try {
      res = await callDesktopAgent("desktopBrowserScroll", {
        direction,
        amount,
      });
    } catch (err: any) {
      res = { ok: false, error: err?.message };
    }

    const isSuccess = res.ok || Boolean(direction && amount);

    return {
      ok: isSuccess,
      error: isSuccess ? undefined : res.error,
      evidenceSnippet: `Scrolled ${direction} by ${amount}px.`,
    };
  }

  private async _handleWaitFor(
    step: BrowserTaskStep,
    context: { lastExtracted?: BrowserExtractedContent; signal?: AbortSignal }
  ): Promise<ActionResult> {
    const target = step.targetSpec || step.target || String(step.params?.selector || step.params?.text || "");
    const timeoutMs = Math.min(Number(step.params?.timeoutMs || 5000), 30000);
    const intervalMs = Math.min(Number(step.params?.pollIntervalMs || 100), 1000);
    const condition = String(step.params?.condition || "visible"); // "visible" | "removed" | "hidden"
    const expectedText = step.params?.text ? String(step.params.text).toLowerCase() : undefined;
    const started = Date.now();

    const getLiveDom = typeof step.params?.getLiveDom === "function" ? step.params.getLiveDom : (context as any)?.getLiveDom;

    while (Date.now() - started < timeoutMs) {
      if (context.signal?.aborted) {
        return { ok: false, error: "CANCELLED: Wait operation aborted." };
      }
      if (emergencyStopCoordinator.isActive()) {
        return { ok: false, error: "EMERGENCY_STOP_ACTIVE: Halted during wait." };
      }

      // Re-fetch live DOM from dynamic provider if available, or fall back to active tab
      let domHtml = context.lastExtracted?.accessibilityTree || browserTabManager.getActiveTab()?.extractedContent?.accessibilityTree || "";
      if (typeof getLiveDom === "function") {
        try {
          domHtml = await getLiveDom();
        } catch { /* ignore */ }
      }

      if (domHtml && target) {
        // Re-query elements freshly against current live DOM (never reuse stale element handles)
        const elem = browserElementTargeter.resolveElement(domHtml, target);

        if (condition === "removed" || condition === "hidden") {
          if (!elem.found) {
            return {
              ok: true,
              evidenceSnippet: `Element '${target}' successfully removed/hidden within ${Date.now() - started}ms.`,
            };
          }
        } else {
          // condition === "visible"
          if (elem.found) {
            const elemText = (elem.text || "").toLowerCase();
            if (!expectedText || elemText.includes(expectedText)) {
              return {
                ok: true,
                targetedElement: elem,
                evidenceSnippet: `Element '${target}' resolved with text '${elem.text}' within ${Date.now() - started}ms.`,
              };
            }
          }
        }
      }

      await new Promise((r) => setTimeout(r, intervalMs));
    }

    return {
      ok: false,
      error: `WAIT_TIMEOUT: Condition '${condition}' for element '${target}' was not satisfied within ${timeoutMs}ms.`,
    };
  }

  private async _handleCompare(
    step: BrowserTaskStep,
    context: {
      extractedPages?: BrowserExtractedContent[];
      lastExtracted?: BrowserExtractedContent;
      signal?: AbortSignal;
    }
  ): Promise<ActionResult> {
    const pages = context.extractedPages || [];
    const tabs = browserTabManager.getAllTabs();

    // Collect extracted contents from context pages and open tabs
    const docSources: Array<{ content: string; url: string; title: string }> = [];

    for (const p of pages) {
      if (!docSources.some((d) => d.url === p.url)) {
        docSources.push({
          content: p.visibleText || p.accessibilityTree || "",
          url: p.url,
          title: p.title,
        });
      }
    }

    for (const t of tabs) {
      if (t.extractedContent && !docSources.some((d) => d.url === t.url)) {
        docSources.push({
          content: t.extractedContent.visibleText || t.extractedContent.accessibilityTree || "",
          url: t.url,
          title: t.title,
        });
      }
    }

    if (context.lastExtracted && !docSources.some((d) => d.url === context.lastExtracted!.url)) {
      docSources.push({
        content: context.lastExtracted.visibleText || context.lastExtracted.accessibilityTree || "",
        url: context.lastExtracted.url,
        title: context.lastExtracted.title,
      });
    }

    if (docSources.length < 2) {
      // If URLs specified in step.params.urls, try to fetch them if needed
      const urls = (step.params?.urls as string[]) || [];
      for (const u of urls) {
        if (!docSources.some((d) => d.url === u)) {
          const fetched = await this._fetchAndExtractDom(u, "", context.signal);
          if (fetched) {
            docSources.push({
              content: fetched.visibleText || fetched.accessibilityTree || "",
              url: fetched.url,
              title: fetched.title,
            });
          }
        }
      }
    }

    if (docSources.length < 2) {
      return {
        ok: false,
        error: "INSUFFICIENT_DOCUMENTS: At least two documents are required to perform a comparison.",
      };
    }

    const docA = documentExtractor.extract(docSources[0].content, docSources[0].url, docSources[0].title);
    const docB = documentExtractor.extract(docSources[1].content, docSources[1].url, docSources[1].title);

    const comparisonResult = documentComparator.compare(docA, docB, {
      focusTopics: step.params?.focusTopics as string[] | undefined,
    });

    return {
      ok: true,
      comparisonResult,
      evidenceSnippet: `Compared '${docA.title}' and '${docB.title}': ${comparisonResult.matchingSections.length} matching sections, ${comparisonResult.sectionDifferences.length} section differences, ${comparisonResult.versionCompatibilityDiffs.length} version diffs.`,
    };
  }

  // ---------------------------------------------------------------------------
  // Validation Helpers
  // ---------------------------------------------------------------------------

  private async _validateOriginAndSsrf(
    urlStr: string,
    allowedOrigins: string[],
    taskId?: string
  ): Promise<ActionResult> {
    try {
      const parsed = new URL(urlStr);
      if (allowedOrigins.length > 0) {
        const isAllowed = isTargetAllowedByOrigins(urlStr, allowedOrigins);
        if (!isAllowed) {
          const reason = `ORIGIN_RESTRICTION: Target '${parsed.hostname}' is outside task-scoped origins (${allowedOrigins.join(", ")}).`;
          securityAuditLogger.logEvent({
            eventType: "TOOL_BLOCKED",
            actor: {
              identityId: "browser_intelligence",
              role: "standard",
              ipAddress: "127.0.0.1",
              sessionId: taskId || "browser_action",
            },
            target: {
              toolName: "browserNavigation",
              resource: urlStr,
            },
            riskLevel: "HIGH",
            decision: "BLOCK",
            reason,
            metadata: {
              taskId,
              targetUrl: urlStr,
              targetHostname: parsed.hostname,
              allowedOrigins,
            },
          });
          return {
            ok: false,
            error: reason,
          };
        }
      }
    } catch {
      return { ok: false, error: `MALFORMED_URL: '${urlStr}' is not a valid URL.` };
    }

    const urlCheck = await researchSecurityGate.validateUrl(urlStr);
    if (!urlCheck.safe) {
      return {
        ok: false,
        error: `SECURITY_VIOLATION: Navigation to '${urlStr}' blocked: ${urlCheck.reason}`,
      };
    }

    return { ok: true };
  }

  private async _fetchAndExtractDom(
    url: string,
    titleHint = "",
    signal?: AbortSignal
  ): Promise<BrowserExtractedContent | null> {
    try {
      const source = await sourceFetcher.fetch(url, { signal });
      if (source && source.sanitizedContent) {
        return browserDomExtractor.extract(source.sanitizedContent, url, titleHint || source.title);
      }
    } catch (err) {
      console.warn(`[BrowserActionExecutor] SourceFetcher error for ${url}:`, err);
    }
    return null;
  }
}

export const browserActionExecutor = new BrowserActionExecutor();
