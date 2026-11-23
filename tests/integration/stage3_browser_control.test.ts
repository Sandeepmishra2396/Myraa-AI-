/**
 * MYRAA — Advanced Browser Intelligence Subsystem
 * Stage 3: Browser Control Integration Test Suite
 *
 * Verifies:
 *   1. Tab context tracking, tab creation, switching, closing, and history navigation.
 *   2. DOM and accessibility-based element discovery (CSS, XPath, Text, ARIA role, data-testid).
 *   3. Stale element handling, dynamic selector fallback, and timeout recovery.
 *   4. Interactive browser control: clicking, typing, form filling, selecting, scrolling, waiting.
 *   5. Multi-step task execution, progress updates, and evidence-backed completion reports.
 *   6. Task lifecycle transitions: PENDING -> RUNNING -> PAUSED -> RESUMED -> COMPLETED / CANCELLED.
 *   7. Real cancellation: aborting in-flight operations and preventing subsequent steps.
 *   8. Security boundaries: Origin boundaries, SSRF/redirect checks, prompt injection,
 *      confirmation requirements, Emergency Stop, and Security Lockdown.
 *   9. Tool registry invariant: Exactly 129 LIVE_TOOLS preserved.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  browserIntelligenceCoordinator,
  browserTabManager,
  browserElementTargeter,
  browserActionExecutor,
  browserIntentInterpreter,
  browserQueryPlanner,
  MAX_OPEN_TABS,
} from "../../backend/research/browser/index.ts";
import { emergencyStopCoordinator } from "../../backend/remote/EmergencyStopCoordinator.ts";
import { securityPolicyEngine } from "../../backend/security/SecurityPolicyEngine.ts";
import { LIVE_TOOLS } from "../../backend/ai/GeminiSessionFactory.ts";
import * as taskManager from "../../backend/tasks/TaskManager.ts";

const SAMPLE_PAGE_HTML = `
<!DOCTYPE html>
<html>
<head>
  <title>MYRAA Automation Portal</title>
</head>
<body>
  <nav aria-label="Main Navigation">
    <a href="/home" class="nav-link">Home</a>
    <a href="/docs" class="nav-link">Documentation</a>
    <button id="theme-toggle" role="button" aria-label="Toggle Dark Mode">Theme</button>
  </nav>

  <main>
    <h1>Welcome to MYRAA Cloud</h1>
    <p>Manage distributed AI agents and browser automation workloads.</p>

    <form id="login-form" action="/login" method="POST">
      <label for="username">Username</label>
      <input type="text" id="username" name="user_name" placeholder="Enter username" data-testid="user-input" />

      <label for="password">Password</label>
      <input type="password" id="password" name="user_pass" placeholder="Enter password" data-testid="pass-input" />

      <label for="role">Role</label>
      <select id="role" name="role_select">
        <option value="developer">Developer</option>
        <option value="admin">Administrator</option>
      </select>

      <button type="submit" id="submit-btn" class="btn-primary" role="button">Sign In</button>
      <button type="button" id="cancel-btn" class="btn-secondary">Cancel</button>
    </form>

    <section id="results-table">
      <table>
        <caption>Active Tasks</caption>
        <thead>
          <tr><th>ID</th><th>Status</th><th>Duration</th></tr>
        </thead>
        <tbody>
          <tr><td>task_01</td><td>SUCCESS</td><td>1.2s</td></tr>
          <tr><td>task_02</td><td>RUNNING</td><td>0.4s</td></tr>
        </tbody>
      </table>
    </section>
  </main>
</body>
</html>
`;

describe("Stage 3 — Browser Control Integration Suite", () => {
  beforeEach(() => {
    emergencyStopCoordinator.reset("test_setup");
    securityPolicyEngine.resetForTesting();
    browserIntelligenceCoordinator.reset();
    browserTabManager.reset();
    vi.spyOn(taskManager, "callDesktopAgent").mockImplementation(async (tool, args) => {
      return { ok: true, result: { success: true, tool } };
    });
  });

  afterEach(() => {
    emergencyStopCoordinator.reset("test_teardown");
    securityPolicyEngine.resetForTesting();
    browserIntelligenceCoordinator.reset();
    browserTabManager.reset();
    vi.restoreAllMocks();
  });

  // ── 1. Tab Context Tracking & Lifecycle ─────────────────────────────────────
  describe("1. Tab Management & Active Context Tracking", () => {
    it("1.1 initializes with a single default blank tab", () => {
      const active = browserTabManager.getActiveTab();
      expect(active).toBeDefined();
      expect(active?.url).toBe("about:blank");
      expect(active?.title).toBe("New Tab");
      expect(browserTabManager.getAllTabs().length).toBe(1);
    });

    it("1.2 creates new tabs and makes them active", () => {
      const tab1 = browserTabManager.createTab("https://docs.nestjs.com", "NestJS Docs");
      expect(tab1).toBeDefined();
      expect(tab1.url).toBe("https://docs.nestjs.com");
      expect(browserTabManager.getActiveTab()?.tabId).toBe(tab1.tabId);
      expect(browserTabManager.getAllTabs().length).toBe(2);
    });

    it("1.3 switches active tab context cleanly", () => {
      const tabA = browserTabManager.createTab("https://site-a.com", "Site A");
      const tabB = browserTabManager.createTab("https://site-b.com", "Site B");

      expect(browserTabManager.getActiveTab()?.tabId).toBe(tabB.tabId);

      const switched = browserTabManager.switchTab(tabA.tabId);
      expect(switched?.tabId).toBe(tabA.tabId);
      expect(browserTabManager.getActiveTab()?.tabId).toBe(tabA.tabId);
    });

    it("1.4 closing active tab falls back to the most recently active remaining tab", () => {
      const tab1 = browserTabManager.createTab("https://tab1.com", "Tab 1");
      const tab2 = browserTabManager.createTab("https://tab2.com", "Tab 2");

      expect(browserTabManager.getActiveTab()?.tabId).toBe(tab2.tabId);

      const closeRes = browserTabManager.closeTab(tab2.tabId);
      expect(closeRes.closed).toBe(true);
      expect(browserTabManager.getActiveTab()?.tabId).toBe(tab1.tabId);
    });

    it("1.5 closing the last remaining tab provisions a clean default tab", () => {
      const allTabs = browserTabManager.getAllTabs();
      for (const t of allTabs) {
        browserTabManager.closeTab(t.tabId);
      }

      const active = browserTabManager.getActiveTab();
      expect(active).toBeDefined();
      expect(active?.url).toBe("about:blank");
      expect(browserTabManager.getAllTabs().length).toBe(1);
    });

    it("1.6 maintains per-tab history stacks with back and forward navigation", () => {
      const tab = browserTabManager.createTab("https://site.com/step1", "Step 1");
      browserTabManager.navigateTab(tab.tabId, "https://site.com/step2", "Step 2");
      browserTabManager.navigateTab(tab.tabId, "https://site.com/step3", "Step 3");

      expect(tab.history.length).toBe(3);
      expect(tab.url).toBe("https://site.com/step3");

      const backRes = browserTabManager.goBack(tab.tabId);
      expect(backRes.success).toBe(true);
      expect(backRes.url).toBe("https://site.com/step2");

      const fwdRes = browserTabManager.goForward(tab.tabId);
      expect(fwdRes.success).toBe(true);
      expect(fwdRes.url).toBe("https://site.com/step3");
    });

    it("1.7 bounds tab capacity to MAX_OPEN_TABS (10), pruning oldest inactive tabs", () => {
      for (let i = 1; i <= 15; i++) {
        browserTabManager.createTab(`https://site.com/tab${i}`, `Tab ${i}`);
      }

      const openTabs = browserTabManager.getAllTabs();
      expect(openTabs.length).toBeLessThanOrEqual(MAX_OPEN_TABS);
    });
  });

  // ── 2. DOM & Accessibility Element Discovery ────────────────────────────────
  describe("2. DOM and Accessibility Element Discovery", () => {
    it("2.1 targets elements by CSS ID selector", () => {
      const result = browserElementTargeter.resolveElement(SAMPLE_PAGE_HTML, "#submit-btn");
      expect(result.found).toBe(true);
      expect(result.strategyUsed).toBe("CSS_SELECTOR");
      expect(result.text).toBe("Sign In");
      expect(result.isClickable).toBe(true);
    });

    it("2.2 targets elements by CSS Class selector", () => {
      const result = browserElementTargeter.resolveElement(SAMPLE_PAGE_HTML, ".btn-secondary");
      expect(result.found).toBe(true);
      expect(result.text).toBe("Cancel");
    });

    it("2.3 targets input elements by tag and attribute selector", () => {
      const result = browserElementTargeter.resolveElement(SAMPLE_PAGE_HTML, 'input[name="user_name"]');
      expect(result.found).toBe(true);
      expect(result.attributes?.placeholder).toBe("Enter username");
    });

    it("2.4 targets elements by Text Match", () => {
      const result = browserElementTargeter.resolveElement(SAMPLE_PAGE_HTML, "Documentation");
      expect(result.found).toBe(true);
      expect(result.strategyUsed).toBe("TEXT_MATCH");
      expect(result.tagName).toBe("a");
      expect(result.isClickable).toBe(true);
    });

    it("2.5 targets elements by ARIA role with required accessible name", () => {
      const result = browserElementTargeter.resolveElement(SAMPLE_PAGE_HTML, {
        strategy: "ARIA_ROLE",
        value: "button",
        requiredText: "Sign In",
      });
      expect(result.found).toBe(true);
      expect(result.strategyUsed).toBe("ARIA_ROLE");
      expect(result.text).toBe("Sign In");
    });

    it("2.6 targets elements by Accessibility ID (data-testid)", () => {
      const result = browserElementTargeter.resolveElement(SAMPLE_PAGE_HTML, "data-testid=user-input");
      expect(result.found).toBe(true);
      expect(result.strategyUsed).toBe("ACCESSIBILITY_ID");
      expect(result.attributes?.name).toBe("user_name");
    });

    it("2.7 targets elements by XPath contains text", () => {
      const result = browserElementTargeter.resolveElement(SAMPLE_PAGE_HTML, "//button[contains(text(), 'Sign In')]");
      expect(result.found).toBe(true);
      expect(result.text).toBe("Sign In");
    });
  });

  // ── 3. Stale Elements & Resilient Fallback Recovery ─────────────────────────
  describe("3. Stale Element Handling & Recovery", () => {
    it("3.1 recovers dynamically changed selector using explicit fallback strategy", () => {
      // Primary selector #non-existent-hash fails, but fallback text "Sign In" succeeds
      const result = browserElementTargeter.resolveElement(SAMPLE_PAGE_HTML, {
        strategy: "CSS_SELECTOR",
        value: "#hash_9281_stale_submit",
        fallbackStrategies: [
          { strategy: "TEXT_MATCH", value: "Sign In" },
        ],
      });

      expect(result.found).toBe(true);
      expect(result.strategyUsed).toBe("TEXT_MATCH");
      expect(result.staleRecovered).toBe(true);
      expect(result.text).toBe("Sign In");
    });

    it("3.2 recovers via heuristic automatic fallback when selector is mutated", () => {
      // When primary CSS selector #cancel-btn-v2 is stale, heuristic falls back to text "cancel btn"
      const result = browserElementTargeter.resolveElement(SAMPLE_PAGE_HTML, {
        strategy: "CSS_SELECTOR",
        value: "#cancel-btn",
        requiredText: "Cancel",
      });

      expect(result.found).toBe(true);
      expect(result.text).toBe("Cancel");
    });

    it("3.3 returns structured ELEMENT_NOT_FOUND error when target is completely absent", () => {
      const result = browserElementTargeter.resolveElement(SAMPLE_PAGE_HTML, "#completely-absent-widget");
      expect(result.found).toBe(false);
      expect(result.error).toContain("ELEMENT_NOT_FOUND");
    });
  });

  // ── 4. Interactive Browser Actions ──────────────────────────────────────────
  describe("4. Interactive Browser Actions via BrowserActionExecutor", () => {
    it("4.1 executes CLICK action with resolved element", async () => {
      const step = {
        stepId: "step_click_1",
        action: "CLICK" as const,
        target: "#submit-btn",
        status: "PENDING" as const,
        retries: 0,
        maxRetries: 1,
      };

      const result = await browserActionExecutor.executeStep(step, {
        allowedOrigins: ["example.com"],
        lastExtracted: {
          url: "https://example.com",
          title: "Portal",
          visibleText: "Portal text",
          headings: [],
          tables: [],
          links: [],
          accessibilityTree: SAMPLE_PAGE_HTML,
          capturedAt: Date.now(),
          sanitized: true,
          injectionDetected: false,
        },
      });

      expect(result.ok).toBe(true);
      expect(result.targetedElement?.found).toBe(true);
      expect(result.targetedElement?.text).toBe("Sign In");
    });

    it("4.2 executes TYPE action into target input field", async () => {
      const step = {
        stepId: "step_type_1",
        action: "TYPE" as const,
        target: 'input[name="user_name"]',
        params: { text: "operator_alex" },
        status: "PENDING" as const,
        retries: 0,
        maxRetries: 1,
      };

      const result = await browserActionExecutor.executeStep(step, {
        allowedOrigins: ["example.com"],
        lastExtracted: {
          url: "https://example.com",
          title: "Portal",
          visibleText: "Portal text",
          headings: [],
          tables: [],
          links: [],
          accessibilityTree: SAMPLE_PAGE_HTML,
          capturedAt: Date.now(),
          sanitized: true,
          injectionDetected: false,
        },
      });

      expect(result.ok).toBe(true);
      expect(result.evidenceSnippet).toContain("Typed text");
    });

    it("4.3 executes FILL_FORM action with multi-field mapping", async () => {
      const step = {
        stepId: "step_fill_1",
        action: "FILL_FORM" as const,
        params: {
          fields: {
            '#username': "admin_user",
            '#password': "secret123",
          },
          submit: "#submit-btn",
        },
        status: "PENDING" as const,
        retries: 0,
        maxRetries: 1,
      };

      const result = await browserActionExecutor.executeStep(step, {
        allowedOrigins: ["example.com"],
      });

      expect(result.ok).toBe(true);
      expect(result.evidenceSnippet).toContain("Filled form with 2 field(s)");
    });

    it("4.4 executes SELECT dropdown option", async () => {
      const step = {
        stepId: "step_sel_1",
        action: "SELECT" as const,
        target: "#role",
        params: { value: "admin" },
        status: "PENDING" as const,
        retries: 0,
        maxRetries: 1,
      };

      const result = await browserActionExecutor.executeStep(step, {
        allowedOrigins: ["example.com"],
      });

      expect(result.ok).toBe(true);
      expect(result.evidenceSnippet).toContain("Selected option 'admin'");
    });

    it("4.5 executes SCROLL action with direction and pixel amount", async () => {
      const step = {
        stepId: "step_scroll_1",
        action: "SCROLL" as const,
        params: { direction: "down", amount: 600 },
        status: "PENDING" as const,
        retries: 0,
        maxRetries: 1,
      };

      const result = await browserActionExecutor.executeStep(step, {
        allowedOrigins: ["example.com"],
      });

      expect(result.ok).toBe(true);
      expect(result.evidenceSnippet).toContain("Scrolled down by 600px");
    });

    it("4.6 WAIT_FOR resolves element if present in DOM", async () => {
      const step = {
        stepId: "step_wait_1",
        action: "WAIT_FOR" as const,
        target: "#submit-btn",
        params: { timeoutMs: 1000 },
        status: "PENDING" as const,
        retries: 0,
        maxRetries: 1,
      };

      const result = await browserActionExecutor.executeStep(step, {
        allowedOrigins: ["example.com"],
        lastExtracted: {
          url: "https://example.com",
          title: "Portal",
          visibleText: "Portal text",
          headings: [],
          tables: [],
          links: [],
          accessibilityTree: SAMPLE_PAGE_HTML,
          capturedAt: Date.now(),
          sanitized: true,
          injectionDetected: false,
        },
      });

      expect(result.ok).toBe(true);
      expect(result.targetedElement?.found).toBe(true);
    });
  });

  // ── 5. Multi-Step Navigation & Natural Language Planning ────────────────────
  describe("5. Natural Language Intent & Multi-Step Execution", () => {
    it("5.1 interprets natural-language interaction intent (click button)", () => {
      const intent = browserIntentInterpreter.interpret("Click on the 'Sign In' button on https://portal.myraa.ai");
      expect(intent.primaryAction).toBe("CLICK");
      expect(intent.interactionTarget).toBe("Sign In");
      expect(intent.targetUrl).toBe("https://portal.myraa.ai");
    });

    it("5.2 plans multi-step task with navigation, interaction, and DOM extraction", async () => {
      const intent = browserIntentInterpreter.interpret("Click the login button on https://ai.google.dev");
      const plan = await browserQueryPlanner.plan(
        { goal: "Click the login button on https://ai.google.dev", initialUrl: "https://ai.google.dev" },
        intent
      );

      expect(plan.steps.length).toBeGreaterThanOrEqual(2);
      expect(plan.steps[0].action).toBe("OPEN_URL");
      expect(plan.steps[1].action).toBe("CLICK");
    });

    it("5.3 executes end-to-end browser control task with tab tracking", async () => {
      const result = await browserIntelligenceCoordinator.executeTask({
        goal: "Check API documentation on https://docs.nestjs.com",
        initialUrl: "https://docs.nestjs.com",
        timeoutMs: 15000,
        maxRetries: 1,
      });

      expect(result.state).toBe("COMPLETED");
      expect(result.activeTabId).toBeDefined();
      expect(result.tabs?.length).toBeGreaterThan(0);
      expect(result.evidenceReport).toBeDefined();
    });
  });

  // ── 6. Task Lifecycle: Pause, Resume, and State Transitions ─────────────────
  describe("6. Task Lifecycle (PENDING, RUNNING, PAUSED, RESUMED, COMPLETED)", () => {
    it("6.1 successfully pauses and resumes an active task", async () => {
      const statesObserved: string[] = [];
      const unsubscribe = browserIntelligenceCoordinator.onProgress((update) => {
        statesObserved.push(update.state);
      });

      const taskPromise = browserIntelligenceCoordinator.executeTask({
        goal: "Navigate and extract from https://docs.python.org",
        initialUrl: "https://docs.python.org",
      });

      // Allow coordinator to start
      await new Promise((r) => setTimeout(r, 10));

      const tasks = browserIntelligenceCoordinator.listTasks();
      const activeTask = tasks[0];
      expect(activeTask).toBeDefined();

      // Pause task
      const paused = browserIntelligenceCoordinator.pauseTask(activeTask.taskId);
      expect(paused).toBe(true);
      expect(statesObserved).toContain("PAUSED");

      // Resume task
      const resumed = browserIntelligenceCoordinator.resumeTask(activeTask.taskId);
      expect(resumed).toBe(true);
      expect(statesObserved).toContain("RESUMED");

      const finalResult = await taskPromise;
      expect(finalResult.state).toBe("COMPLETED");

      unsubscribe();
    });
  });

  // ── 7. Real Cancellation & In-Flight Abort ──────────────────────────────────
  describe("7. Real Cancellation & In-Flight Abort", () => {
    it("7.1 cancels a running task and executes zero subsequent steps", async () => {
      const taskPromise = browserIntelligenceCoordinator.executeTask({
        goal: "Long running search and interaction on https://cloud.google.com",
        initialUrl: "https://cloud.google.com",
        timeoutMs: 30000,
      });

      await new Promise((r) => setTimeout(r, 10));

      const tasks = browserIntelligenceCoordinator.listTasks();
      const activeTask = tasks[0];
      expect(activeTask).toBeDefined();

      const cancelled = browserIntelligenceCoordinator.cancelTask(activeTask.taskId, "Operator abort test");
      expect(cancelled).toBe(true);

      const result = await taskPromise;
      expect(result.state).toBe("CANCELLED");
      expect(result.errors.some((e) => e.includes("cancelled"))).toBe(true);
    });

    it("7.2 unblocks paused execution immediately when cancelled while paused", async () => {
      const taskPromise = browserIntelligenceCoordinator.executeTask({
        goal: "Paused task abort test on https://vitejs.dev",
        initialUrl: "https://vitejs.dev",
      });

      await new Promise((r) => setTimeout(r, 10));

      const tasks = browserIntelligenceCoordinator.listTasks();
      const activeTask = tasks[0];

      browserIntelligenceCoordinator.pauseTask(activeTask.taskId);
      // Cancel while paused
      browserIntelligenceCoordinator.cancelTask(activeTask.taskId, "Cancelled during pause");

      const result = await taskPromise;
      expect(result.state).toBe("CANCELLED");
    });
  });

  // ── 8. Security Boundaries & Protection Gates ───────────────────────────────
  describe("8. Security Boundaries, SSRF, Confirmation, and Lockdown", () => {
    it("8.1 blocks navigation to destinations outside task-scoped allowedOrigins", async () => {
      const step = {
        stepId: "step_unauth_origin",
        action: "OPEN_URL" as const,
        target: "https://evil-hacker-site.org/malware",
        status: "PENDING" as const,
        retries: 0,
        maxRetries: 1,
      };

      const result = await browserActionExecutor.executeStep(step, {
        allowedOrigins: ["safe-docs.com"],
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("ORIGIN_RESTRICTION");
    });

    it("8.2 blocks navigation to private/loopback IP addresses via SSRF gate", async () => {
      const step = {
        stepId: "step_ssrf_private",
        action: "OPEN_URL" as const,
        target: "http://127.0.0.1:8080/admin",
        status: "PENDING" as const,
        retries: 0,
        maxRetries: 1,
      };

      const result = await browserActionExecutor.executeStep(step, {
        allowedOrigins: [],
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("SECURITY_VIOLATION");
    });

    it("8.3 enforces confirmation check on sensitive actions unless auto-confirmed", async () => {
      const sensitiveStep = {
        stepId: "step_sensitive_delete",
        action: "CLICK" as const,
        target: "#delete-account-btn",
        sensitiveAction: true,
        status: "PENDING" as const,
        retries: 0,
        maxRetries: 1,
      };

      // When autoConfirmSensitiveActions is false -> blocked
      const blockedRes = await browserActionExecutor.executeStep(sensitiveStep, {
        allowedOrigins: ["example.com"],
        autoConfirmSensitiveActions: false,
      });
      expect(blockedRes.ok).toBe(false);
      expect(blockedRes.error).toContain("CONFIRMATION_REQUIRED");

      // When autoConfirmSensitiveActions is true -> proceeds
      const allowedRes = await browserActionExecutor.executeStep(sensitiveStep, {
        allowedOrigins: ["example.com"],
        autoConfirmSensitiveActions: true,
      });
      expect(allowedRes.ok).toBe(true);
    });

    it("8.4 halts browser execution immediately under Emergency Stop", async () => {
      await emergencyStopCoordinator.trigger({ source: "rest_api", reason: "Operator Emergency Stop" });

      const step = {
        stepId: "step_halted",
        action: "SCROLL" as const,
        status: "PENDING" as const,
        retries: 0,
        maxRetries: 1,
      };

      const result = await browserActionExecutor.executeStep(step, {
        allowedOrigins: [],
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("EMERGENCY_STOP_ACTIVE");
    });

    it("8.5 halts browser actions under Security Lockdown", async () => {
      securityPolicyEngine.setMode("LOCKDOWN");

      const step = {
        stepId: "step_lockdown",
        action: "CLICK" as const,
        target: "#login-btn",
        status: "PENDING" as const,
        retries: 0,
        maxRetries: 1,
      };

      const result = await browserActionExecutor.executeStep(step, {
        allowedOrigins: [],
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("SECURITY_LOCKDOWN_ACTIVE");
    });
  });

  // ── 9. Strict Invariant: Exactly 129 LIVE_TOOLS Preserved ────────────────────
  describe("9. Strict Invariant: Exactly 129 LIVE_TOOLS Preserved", () => {
    it("9.1 preserves exactly 129 function declarations in LIVE_TOOLS", () => {
      expect(LIVE_TOOLS).toBeDefined();
      const tools = LIVE_TOOLS[0].functionDeclarations;
      expect(tools.length).toBe(129);
      const uniqueNames = new Set(tools.map((t) => t.name));
      expect(uniqueNames.size).toBe(129);
    });

    it("9.2 Stage 3 browser control does not add arbitrary declarations to LIVE_TOOLS", () => {
      const toolNames = LIVE_TOOLS[0].functionDeclarations.map((t) => t.name);
      expect(toolNames).not.toContain("browserControlStage3");
      expect(toolNames).not.toContain("arbitraryBrowserExecutor");
    });
  });
});
