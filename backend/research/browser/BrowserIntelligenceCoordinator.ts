/**
 * MYRAA — Advanced Browser Intelligence Subsystem
 * BrowserIntelligenceCoordinator.ts
 *
 * Master orchestrator for Stage 1 & Stage 3: Browser Intelligence & Browser Control.
 * Manages natural-language intent understanding, query planning, browser navigation,
 * multi-step interaction (clicking, typing, form filling, selection, scrolling, wait_for),
 * tab context lifecycles, DOM extraction, bounded retries, task timeouts, real cancellation,
 * progress updates, and sanitized handoff to the Phase 8 research pipeline.
 *
 * Security: External content is UNTRUSTED. Coordinator is read-only toward
 * local project files and permanent memory.
 */

import crypto from "crypto";
import { browserIntentInterpreter } from "./BrowserIntentInterpreter.ts";
import { browserQueryPlanner } from "./BrowserQueryPlanner.ts";
import { browserActionExecutor, type ActionResult } from "./BrowserActionExecutor.ts";
import { browserTabManager } from "./BrowserTabManager.ts";
import { browserContextResearcher } from "../BrowserContextResearcher.ts";
import { advancedResearchCoordinator } from "../AdvancedResearchCoordinator.ts";
import { researchSecurityGate } from "../ResearchSecurityGate.ts";
import { sourceFetcher } from "../SourceFetcher.ts";
import { documentExtractor } from "./DocumentExtractor.ts";
import { documentComparator } from "./DocumentComparator.ts";
import { securityAuditLogger } from "../../security/SecurityAuditLogger.ts";
import { emergencyStopCoordinator } from "../../remote/EmergencyStopCoordinator.ts";
import { securityPolicyEngine } from "../../security/SecurityPolicyEngine.ts";
import type {
  BrowserTaskRequest,
  BrowserTaskResult,
  BrowserTaskState,
  BrowserProgressUpdate,
  BrowserExtractedContent,
  BrowserEvidenceReport,
  BrowserTaskStep,
  DocumentComparisonRequest,
  DocumentComparisonResult,
  StructuredDocument,
} from "./BrowserIntelligenceTypes.ts";

export class BrowserIntelligenceCoordinator {
  private _tasks = new Map<string, BrowserTaskResult>();
  private _abortControllers = new Map<string, AbortController>();
  private _pauseResolvers = new Map<string, () => void>();
  private _progressListeners: Array<(update: BrowserProgressUpdate) => void> = [];

  /**
   * Execute an end-to-end browser intelligence and control task.
   */
  public async executeTask(req: BrowserTaskRequest): Promise<BrowserTaskResult> {
    const taskId = `btask_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
    const startedAt = Date.now();

    // ── 0. Pre-Flight Security Checks ─────────────────────────────────────────
    if (emergencyStopCoordinator.isActive()) {
      return this._createBlockedResult(taskId, req.goal, startedAt, "EMERGENCY_STOP_ACTIVE");
    }
    if (securityPolicyEngine.getMode() === "LOCKDOWN") {
      return this._createBlockedResult(taskId, req.goal, startedAt, "SECURITY_LOCKDOWN_ACTIVE");
    }

    const abortController = new AbortController();
    this._abortControllers.set(taskId, abortController);

    // Initialize task state immediately as PENDING
    const result: BrowserTaskResult = {
      taskId,
      goal: req.goal,
      state: "PENDING",
      startedAt,
      steps: [],
      extractedPages: [],
      evidenceReport: this._emptyEvidenceReport(),
      errors: [],
      securityFlags: [],
      activeTabId: browserTabManager.getActiveTab()?.tabId,
      tabs: browserTabManager.getAllTabs(),
    };
    this._tasks.set(taskId, result);

    // 1. Audit log task initiation
    securityAuditLogger.logEvent({
      eventType: "TOOL_ALLOW",
      actor: { identityId: "browser_intelligence", role: "standard", ipAddress: "127.0.0.1" },
      target: { toolName: "browserIntelligenceCoordinator", resource: taskId },
      riskLevel: "LOW",
      decision: "ALLOW",
      reason: `Browser task initiated: ${req.goal.slice(0, 80)}`,
    });

    // 2. Interpret natural-language intent
    const intent = browserIntentInterpreter.interpret(req.goal, req.contextId);

    // 3. Plan task steps
    let plan;
    try {
      plan = await browserQueryPlanner.plan(req, intent);
    } catch (err: any) {
      result.state = "FAILED";
      result.completedAt = Date.now();
      result.errors.push(`Planning error: ${err?.message || String(err)}`);
      if (err?.message?.includes("SECURITY") || err?.message?.includes("ORIGIN_RESTRICTION")) {
        result.securityFlags.push(err.message);
      }
      return result;
    }

    // 4. Update task state with plan
    if (result.state !== "PAUSED" && (result.state as string) !== "CANCELLED") {
      result.state = "RUNNING";
    }
    result.steps = plan.steps;

    if (abortController.signal.aborted || (result.state as string) === "CANCELLED") {
      result.state = "CANCELLED";
      if (!result.errors.some((e) => e.toLowerCase().includes("cancel"))) {
        result.errors.push("Task was cancelled.");
      }
      return result;
    }

    this._emitProgress({
      taskId,
      state: result.state,
      currentStepIndex: 0,
      totalSteps: plan.steps.length,
      progressPercentage: 5,
      statusMessage: `Plan created with ${plan.steps.length} steps. Starting execution...`,
      timestamp: Date.now(),
      activeTabId: result.activeTabId,
    });

    // Set hard timeout guard
    const timeoutId = setTimeout(() => {
      this.cancelTask(taskId, `Task exceeded timeout limit of ${plan.timeoutMs}ms.`);
    }, plan.timeoutMs);

    // 5. Execute steps sequentially
    let currentUrl = req.initialUrl || intent.targetUrl;
    let lastExtracted: BrowserExtractedContent | undefined;

    try {
      for (let i = 0; i < plan.steps.length; i++) {
        // Check for pause
        if (result.state === "PAUSED") {
          await this._waitForResume(taskId);
        }

        // Check for cancellation or Emergency Stop
        if (abortController.signal.aborted || (result.state as string) === "CANCELLED") {
          result.state = "CANCELLED";
          if (!result.errors.some((e) => e.toLowerCase().includes("cancel"))) {
            result.errors.push("Task was cancelled.");
          }
          break;
        }

        if (emergencyStopCoordinator.isActive()) {
          result.state = "FAILED";
          result.errors.push("EMERGENCY_STOP_ACTIVE: Execution halted by Emergency Stop.");
          break;
        }

        if (securityPolicyEngine.getMode() === "LOCKDOWN") {
          result.state = "FAILED";
          result.errors.push("SECURITY_LOCKDOWN_ACTIVE: Browser actions disabled under Lockdown.");
          break;
        }

        const step = plan.steps[i];
        step.status = "RUNNING";
        step.startedAt = Date.now();

        this._emitProgress({
          taskId,
          state: result.state,
          currentStepIndex: i + 1,
          totalSteps: plan.steps.length,
          progressPercentage: Math.round(((i + 1) / (plan.steps.length + 1)) * 100),
          statusMessage: `Executing step ${i + 1}/${plan.steps.length}: ${step.action}...`,
          timestamp: Date.now(),
          activeTabId: browserTabManager.getActiveTab()?.tabId,
        });

        // Retry loop for step
        let stepSucceeded = false;
        while (step.retries <= step.maxRetries && !stepSucceeded) {
          if (abortController.signal.aborted || (result.state as string) === "CANCELLED") break;

          const actionRes = await browserActionExecutor.executeStep(step, {
            allowedOrigins: plan.allowedOrigins,
            currentUrl,
            lastExtracted,
            extractedPages: result.extractedPages,
            signal: abortController.signal,
            autoConfirmSensitiveActions: req.autoConfirmSensitiveActions,
            taskId,
          });

          if (actionRes.ok) {
            step.status = "COMPLETED";
            step.completedAt = Date.now();
            step.evidenceSnippet = actionRes.evidenceSnippet;
            stepSucceeded = true;

            if (actionRes.comparisonResult) {
              result.comparisonResult = actionRes.comparisonResult;
              result.synthesizedAnswer = actionRes.comparisonResult.synthesizedSummary;
              result.evidenceReport.observedFacts.push(...actionRes.comparisonResult.observedFacts);
              result.evidenceReport.inferences.push(...actionRes.comparisonResult.inferences);
              result.evidenceReport.hypotheses.push(...actionRes.comparisonResult.hypotheses);
              result.evidenceReport.verifiedConclusions.push(...actionRes.comparisonResult.verifiedConclusions);
            }

            if (actionRes.extractedPage) {
              lastExtracted = actionRes.extractedPage;
              currentUrl = actionRes.extractedPage.url;
              if (!result.extractedPages.some((p) => p.url === actionRes.extractedPage!.url)) {
                result.extractedPages.push(actionRes.extractedPage);
              }
            }

            result.activeTabId = browserTabManager.getActiveTab()?.tabId;
            result.tabs = browserTabManager.getAllTabs();
          } else {
            step.error = actionRes.error;
            // Fatal security, origin restriction, or confirmation denial: fail fast with zero retries
            if (
              actionRes.error?.includes("ORIGIN_RESTRICTION") ||
              actionRes.error?.includes("SECURITY_VIOLATION") ||
              actionRes.error?.includes("CONFIRMATION_REQUIRED")
            ) {
              step.status = "FAILED";
              result.errors.push(`Step ${step.action} failed: ${actionRes.error}`);
              break;
            }

            step.retries++;
            if (step.retries > step.maxRetries) {
              step.status = "FAILED";
              result.errors.push(`Step ${step.action} failed: ${actionRes.error}`);
            } else {
              // Exponential backoff before retry
              await new Promise((resolve) => setTimeout(resolve, 50 * step.retries));
            }
          }
        }

        // If step failed critically on security violation, origin restriction, or confirmation requirement, halt execution
        if (
          step.error?.includes("ORIGIN_RESTRICTION") ||
          step.error?.includes("SECURITY_VIOLATION") ||
          step.error?.includes("CONFIRMATION_REQUIRED")
        ) {
          result.securityFlags.push(step.error);
          result.state = "FAILED";
          break;
        }

        // If cancellation requested during step retry
        if (abortController.signal.aborted || (result.state as string) === "CANCELLED") {
          result.state = "CANCELLED";
          break;
        }
      }

      // 6. Synthesized Research Handoff (if requested and extracted pages exist)
      if (result.state !== "FAILED" && result.state !== "CANCELLED" && result.extractedPages.length > 0) {
        this._emitProgress({
          taskId,
          state: "RUNNING",
          currentStepIndex: plan.steps.length,
          totalSteps: plan.steps.length,
          progressPercentage: 90,
          statusMessage: "Extracting evidence claims and synthesizing citation-backed response...",
          timestamp: Date.now(),
          activeTabId: result.activeTabId,
        });

        await this._handoffToResearchPipeline(result, req.goal);
        if (abortController.signal.aborted || (result.state as string) === "CANCELLED") {
          result.state = "CANCELLED";
        } else if (result.errors.length > 0 && result.extractedPages.length === 0) {
          result.state = "FAILED";
        } else {
          result.state = "COMPLETED";
        }
      } else if (result.state === "RUNNING") {
        if (abortController.signal.aborted || (result.state as string) === "CANCELLED") {
          result.state = "CANCELLED";
        } else {
          result.state = result.errors.length > 0 ? "FAILED" : "COMPLETED";
        }
      }
    } catch (err: any) {
      result.state = "FAILED";
      result.errors.push(`Execution error: ${err?.message || String(err)}`);
    } finally {
      clearTimeout(timeoutId);
      result.completedAt = Date.now();
      result.activeTabId = browserTabManager.getActiveTab()?.tabId;
      result.tabs = browserTabManager.getAllTabs();
      this._abortControllers.delete(taskId);
      this._pauseResolvers.delete(taskId);

      this._emitProgress({
        taskId,
        state: result.state,
        currentStepIndex: plan.steps.length,
        totalSteps: plan.steps.length,
        progressPercentage: 100,
        statusMessage: `Task finished with status: ${result.state}`,
        timestamp: Date.now(),
        activeTabId: result.activeTabId,
      });
    }

    return result;
  }

  /**
   * Execute a single discrete browser control action directly.
   */
  public async executeAction(
    step: BrowserTaskStep,
    context: {
      allowedOrigins?: string[];
      autoConfirmSensitiveActions?: boolean;
      taskId?: string;
    } = {}
  ): Promise<ActionResult> {
    return browserActionExecutor.executeStep(step, {
      allowedOrigins: context.allowedOrigins || [],
      autoConfirmSensitiveActions: context.autoConfirmSensitiveActions,
      taskId: context.taskId,
    });
  }

  /**
   * Compare two or more documents directly with security and SSRF validation.
   */
  public async compareDocuments(
    req: DocumentComparisonRequest,
    context?: { signal?: AbortSignal }
  ): Promise<DocumentComparisonResult> {
    if (emergencyStopCoordinator.isActive()) {
      throw new Error("EMERGENCY_STOP_ACTIVE: Document comparison halted by Emergency Stop.");
    }
    if (securityPolicyEngine.getMode() === "LOCKDOWN") {
      throw new Error("SECURITY_LOCKDOWN_ACTIVE: Comparison disabled under Lockdown.");
    }

    const rawDocs: StructuredDocument[] = [];

    for (let i = 0; i < req.documents.length; i++) {
      const d = req.documents[i];
      if (d.content) {
        rawDocs.push(
          documentExtractor.extract(
            d.content,
            d.url || `https://doc${i + 1}.internal`,
            d.title || `Document ${i + 1}`,
            d.version
          )
        );
      } else if (d.url) {
        // Validate SSRF
        const secCheck = await researchSecurityGate.validateUrl(d.url);
        if (!secCheck.safe) {
          throw new Error(`SECURITY_VIOLATION: Document URL blocked: ${d.url} (${secCheck.reason})`);
        }
        const fetched = await sourceFetcher.fetch(d.url, { signal: context?.signal });
        if (!fetched || !fetched.sanitizedContent) {
          throw new Error(`FETCH_FAILED: Could not fetch content from ${d.url}`);
        }
        rawDocs.push(
          documentExtractor.extract(
            fetched.sanitizedContent,
            d.url,
            d.title || fetched.title,
            d.version
          )
        );
      }
    }

    if (rawDocs.length < 2) {
      throw new Error("INVALID_REQUEST: At least two documents are required for comparison.");
    }

    return documentComparator.compare(rawDocs[0], rawDocs[1], {
      focusTopics: req.focusTopics,
      compareBy: req.compareBy,
    });
  }

  /**
   * Extract structured documentation from content or URL.
   */
  public async extractDocument(
    contentOrUrl: { content?: string; url?: string; titleHint?: string; versionHint?: string },
    context?: { signal?: AbortSignal }
  ): Promise<StructuredDocument> {
    if (emergencyStopCoordinator.isActive()) {
      throw new Error("EMERGENCY_STOP_ACTIVE: Document extraction halted by Emergency Stop.");
    }

    if (contentOrUrl.content) {
      return documentExtractor.extract(
        contentOrUrl.content,
        contentOrUrl.url || "https://document.internal",
        contentOrUrl.titleHint,
        contentOrUrl.versionHint
      );
    }

    if (contentOrUrl.url) {
      const secCheck = await researchSecurityGate.validateUrl(contentOrUrl.url);
      if (!secCheck.safe) {
        throw new Error(`SECURITY_VIOLATION: Document URL blocked: ${contentOrUrl.url} (${secCheck.reason})`);
      }
      const fetched = await sourceFetcher.fetch(contentOrUrl.url, { signal: context?.signal });
      if (!fetched || !fetched.sanitizedContent) {
        throw new Error(`FETCH_FAILED: Could not fetch content from ${contentOrUrl.url}`);
      }
      return documentExtractor.extract(
        fetched.sanitizedContent,
        contentOrUrl.url,
        contentOrUrl.titleHint || fetched.title,
        contentOrUrl.versionHint
      );
    }

    throw new Error("INVALID_REQUEST: Either 'content' or 'url' must be provided.");
  }

  /**
   * Access the Tab Manager.
   */
  public getTabManager() {
    return browserTabManager;
  }

  /**
   * Pause a currently running task.
   */
  public pauseTask(taskId: string): boolean {
    const task = this._tasks.get(taskId);
    if (!task || (task.state !== "RUNNING" && task.state !== "PENDING")) return false;
    task.state = "PAUSED";
    this._emitProgress({
      taskId,
      state: "PAUSED",
      currentStepIndex: 0,
      totalSteps: task.steps.length,
      progressPercentage: 50,
      statusMessage: "Task execution paused by operator.",
      timestamp: Date.now(),
      activeTabId: task.activeTabId,
    });
    return true;
  }

  /**
   * Resume a paused task.
   */
  public resumeTask(taskId: string): boolean {
    const task = this._tasks.get(taskId);
    if (!task || task.state !== "PAUSED") return false;
    task.state = "RUNNING";
    const resolver = this._pauseResolvers.get(taskId);
    if (resolver) {
      resolver();
      this._pauseResolvers.delete(taskId);
    }
    this._emitProgress({
      taskId,
      state: "RESUMED",
      currentStepIndex: 0,
      totalSteps: task.steps.length,
      progressPercentage: 50,
      statusMessage: "Task execution resumed.",
      timestamp: Date.now(),
      activeTabId: task.activeTabId,
    });
    return true;
  }

  /**
   * Cancel an active task.
   */
  public cancelTask(taskId: string, reason = "Operator cancelled task"): boolean {
    const task = this._tasks.get(taskId);
    const controller = this._abortControllers.get(taskId);
    if (controller) {
      controller.abort();
      this._abortControllers.delete(taskId);
    }
    // Unblock any paused resolver so loop unblocks immediately
    const resolver = this._pauseResolvers.get(taskId);
    if (resolver) {
      resolver();
      this._pauseResolvers.delete(taskId);
    }
    if (task) {
      task.state = "CANCELLED";
      task.errors.push(reason);
      if (!task.errors.some((e) => e.includes("cancelled"))) {
        task.errors.push("Task was cancelled.");
      }
      task.completedAt = Date.now();
      this._emitProgress({
        taskId,
        state: "CANCELLED",
        currentStepIndex: 0,
        totalSteps: task.steps.length,
        progressPercentage: 100,
        statusMessage: `Task cancelled: ${reason}`,
        timestamp: Date.now(),
        activeTabId: task.activeTabId,
      });
      return true;
    }
    return false;
  }

  /**
   * Retrieve task details and progress.
   */
  public getTask(taskId: string): BrowserTaskResult | undefined {
    return this._tasks.get(taskId);
  }

  /**
   * List all recent tasks.
   */
  public listTasks(): BrowserTaskResult[] {
    return [...this._tasks.values()].slice(-50);
  }

  /**
   * Register a progress listener.
   */
  public onProgress(listener: (update: BrowserProgressUpdate) => void): () => void {
    this._progressListeners.push(listener);
    return () => {
      this._progressListeners = this._progressListeners.filter((l) => l !== listener);
    };
  }

  /**
   * Reset all tasks and tab manager state (testing helper).
   */
  public reset(): void {
    for (const controller of this._abortControllers.values()) {
      controller.abort();
    }
    for (const resolver of this._pauseResolvers.values()) {
      resolver();
    }
    this._tasks.clear();
    this._abortControllers.clear();
    this._pauseResolvers.clear();
    browserTabManager.reset();
  }

  // ── Private Helpers ─────────────────────────────────────────────────────────

  private async _waitForResume(taskId: string): Promise<void> {
    const task = this._tasks.get(taskId);
    if (!task || task.state !== "PAUSED") return;
    return new Promise((resolve) => {
      this._pauseResolvers.set(taskId, resolve);
    });
  }

  private _emitProgress(update: BrowserProgressUpdate): void {
    for (const listener of this._progressListeners) {
      try {
        listener(update);
      } catch (err) {
        console.warn("[BrowserIntelligenceCoordinator] Progress listener error:", err);
      }
    }
  }

  private async _handoffToResearchPipeline(result: BrowserTaskResult, goal: string): Promise<void> {
    const observedFacts: string[] = [];
    const sourceUrls: string[] = [];

    for (const page of result.extractedPages) {
      sourceUrls.push(page.url);

      if (page.headings.length > 0) {
        observedFacts.push(`Page '${page.title}' sections: ${page.headings.slice(0, 3).join(", ")}`);
      }
      for (const tbl of page.tables) {
        if (tbl.headers.length > 0) {
          observedFacts.push(
            `Table ${tbl.caption || ""} headers: [${tbl.headers.join(", ")}] with ${tbl.rows.length} rows`
          );
        }
      }

      const pageCtx = {
        currentUrl: page.url,
        pageTitle: page.title,
        visibleText: page.visibleText,
        pageHeadings: page.headings,
        codeSnippets: [],
        capturedAt: page.capturedAt,
      };

      try {
        const researchOut = await browserContextResearcher.processPageContext(pageCtx);
        if (researchOut && researchOut.claims.length > 0) {
          for (const c of researchOut.claims.slice(0, 5)) {
            observedFacts.push(c.claim);
          }
        }
      } catch (err) {
        console.warn(`[BrowserIntelligenceCoordinator] Research handoff error for ${page.url}:`, err);
      }
    }

    try {
      const epistemicResult = await advancedResearchCoordinator.epistemicQuery({
        question: goal,
        maxSources: Math.min(result.extractedPages.length, 3),
        allowRefinement: false,
      });

      result.researchResult = epistemicResult;
      result.synthesizedAnswer = epistemicResult.answer;
      const epistemicSummary = epistemicResult.epistemicSummary;
      result.evidenceReport = {
        observedFacts: [
          ...new Set([
            ...observedFacts,
            ...(epistemicSummary?.facts?.map((c) => c.claim) || []),
          ]),
        ],
        inferences: epistemicSummary?.inferences?.map((c) => c.claim) || [],
        hypotheses: epistemicSummary?.hypotheses?.map((c) => c.claim) || [],
        verifiedConclusions: epistemicSummary?.verifiedConclusions?.map((c) => c.claim) || [],
        sourceUrls: [
          ...new Set([...sourceUrls, ...epistemicResult.citations.map((c) => c.sourceUrl)]),
        ],
        citationsCount: epistemicResult.citations.length,
        hasUncertainty: Boolean(epistemicResult.hasUncertainty),
        uncertaintyNotes: epistemicResult.uncertaintyReport?.join("; "),
      };
    } catch {
      result.synthesizedAnswer = `Extracted ${result.extractedPages.length} pages: ${result.extractedPages.map((p) => p.title).join(", ")}.`;
      result.evidenceReport = {
        observedFacts,
        inferences: [],
        hypotheses: [],
        verifiedConclusions: [],
        sourceUrls,
        citationsCount: sourceUrls.length,
        hasUncertainty: false,
      };
    }
  }

  private _createBlockedResult(
    taskId: string,
    goal: string,
    startedAt: number,
    reason: string
  ): BrowserTaskResult {
    const blocked: BrowserTaskResult = {
      taskId,
      goal,
      state: "FAILED",
      startedAt,
      completedAt: Date.now(),
      steps: [],
      extractedPages: [],
      evidenceReport: this._emptyEvidenceReport(),
      errors: [`Execution blocked: ${reason}`],
      securityFlags: [reason],
      activeTabId: browserTabManager.getActiveTab()?.tabId,
      tabs: browserTabManager.getAllTabs(),
    };
    this._tasks.set(taskId, blocked);
    return blocked;
  }

  private _emptyEvidenceReport(): BrowserEvidenceReport {
    return {
      observedFacts: [],
      inferences: [],
      hypotheses: [],
      verifiedConclusions: [],
      sourceUrls: [],
      citationsCount: 0,
      hasUncertainty: false,
    };
  }
}

export const browserIntelligenceCoordinator = new BrowserIntelligenceCoordinator();
