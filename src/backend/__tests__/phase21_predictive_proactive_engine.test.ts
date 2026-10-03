/**
 * MYRAA — Phase 21: Predictive / Proactive Engine Tests
 *
 * Comprehensive validation suite covering:
 *   1. Build failure detection
 *   2. TypeScript error detection (TSxxxx, line/col extraction)
 *   3. Test failure detection (Vitest / assertion errors)
 *   4. Runtime error detection (Uncaught exceptions, EADDRINUSE)
 *   5. Signal confidence & LOW-confidence safety protection
 *   6. Evidence & provenance tracking
 *   7. Deduplication & Cooldown (anti-spam, 10x repeated error escalation)
 *   8. Stale event expiration (TTL)
 *   9. Task stalled detection
 *  10. Safe suggestion generation & 6-tier Autonomy Levels
 *  11. Natural conversation continuity (haan, nahi, baad mein, ghost-action check)
 *  12. Security Policy Enforcement (Emergency Stop & Security Lockdown)
 *  13. End-to-End Simulation: Observe -> Analyze -> Prepare -> Ask -> Approve -> Execute -> Verify -> Report
 *  14. REST Endpoints Integration (/api/proactive/*)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "http";
import {
  predictiveContextCoordinator,
  predictiveSignalDetector,
  proactiveInsightAnalyzer,
  proactiveDeduplicationEngine,
  proactiveCooldownManager,
  proactiveSuggestionEngine,
  proactiveNotificationManager,
  proactiveVerificationManager,
} from "../proactive/index.ts";
import { naturalConversationEngine } from "../conversation/index.ts";
import { emergencyStopCoordinator } from "../remote/EmergencyStopCoordinator.ts";
import { securityPolicyEngine } from "../security/SecurityPolicyEngine.ts";
import { createHttpApp } from "../gateway/HttpGateway.ts";

describe("Phase 21 — Predictive / Proactive Engine", () => {
  beforeEach(async () => {
    predictiveContextCoordinator.reset();
    proactiveDeduplicationEngine.clear();
    naturalConversationEngine.reset("default");
    naturalConversationEngine.reset("ctx_proactive");

    if (emergencyStopCoordinator.isActive()) {
      await emergencyStopCoordinator.reset("phase21_test_setup");
    }
    securityPolicyEngine.setMode("BALANCED");
  });

  afterEach(async () => {
    if (emergencyStopCoordinator.isActive()) {
      await emergencyStopCoordinator.reset("phase21_test_teardown");
    }
    securityPolicyEngine.setMode("BALANCED");
    predictiveContextCoordinator.reset();
  });

  // ── 1. Build Failure Detection ─────────────────────────────────────────────
  describe("1. Build Failure Detection", () => {
    it("detects build failure from terminal output and prepares diagnostic event", async () => {
      const rawBuildOutput = `
vite v6.4.3 building for production...
transforming (14)...
error during build:
[vite:esbuild] Unexpected token (12:8) in src/auth.ts
Build failed with 1 error
`;
      const event = await predictiveContextCoordinator.observeSignal({
        source: "terminal",
        rawText: rawBuildOutput,
        command: "npm run build",
        exitCode: 1,
        project: "sora-ai",
        file: "src/auth.ts",
      });

      expect(event).toBeDefined();
      expect(event?.eventType).toBe("BUILD_FAILED");
      expect(event?.confidence).toBe("HIGH");
      expect(event?.confidenceScore).toBeGreaterThanOrEqual(0.9);
      expect(event?.approvalRequired).toBe(true);
      expect(event?.status).toBe("AWAITING_APPROVAL");
      expect(event?.suggestedAction).toBeDefined();
      expect(event?.suggestedAction?.autonomyLevel).toBe(3); // Level 3: Ask for approval
    });
  });

  // ── 2. TypeScript Error Detection ──────────────────────────────────────────
  describe("2. TypeScript Error Detection", () => {
    it("parses TS error diagnostic with line, column, error code and root cause", async () => {
      const tsOutput = "src/services/auth.ts:24:12 - error TS2304: Cannot find name 'verifyJwt'.";

      const event = await predictiveContextCoordinator.observeSignal({
        source: "compiler",
        rawText: tsOutput,
        command: "npx tsc --noEmit",
        exitCode: 1,
        project: "auth-service",
      });

      expect(event).toBeDefined();
      expect(event?.eventType).toBe("TYPE_ERROR");
      expect(event?.evidence[0].errorCode).toBe("TS2304");
      expect(event?.evidence[0].lineNumber).toBe(24);
      expect(event?.evidence[0].columnNumber).toBe(12);
      expect(event?.analysis.rootCause).toContain("'verifyJwt' is referenced");
      expect(event?.analysis.naturalHindiExplanation).toContain("verifyJwt");
      expect(event?.confidence).toBe("HIGH");
    });
  });

  // ── 3. Test Failure Detection ──────────────────────────────────────────────
  describe("3. Test Failure Detection", () => {
    it("detects unit test failures and prepares inspection action", async () => {
      const testOutput = `
FAIL src/backend/__tests__/auth.test.ts > AuthSuite > verifies token expiry
AssertionError: expected true to be false
Tests: 1 failed, 12 passed
`;
      const event = await predictiveContextCoordinator.observeSignal({
        source: "test_runner",
        rawText: testOutput,
        command: "npx vitest run src/backend/__tests__/auth.test.ts",
        exitCode: 1,
        file: "src/backend/__tests__/auth.test.ts",
      });

      expect(event).toBeDefined();
      expect(event?.eventType).toBe("TEST_FAILED");
      expect(event?.file).toBe("src/backend/__tests__/auth.test.ts");
      expect(event?.analysis.summary).toContain("Test suite failed");
      expect(event?.suggestedAction?.toolName).toBe("readFile");
    });
  });

  // ── 4. Runtime Error Detection ─────────────────────────────────────────────
  describe("4. Runtime Error Detection", () => {
    it("detects port conflict EADDRINUSE and prepares port recovery action", async () => {
      const runtimeLog = "Error: listen EADDRINUSE: address already in use :::3000";

      const event = await predictiveContextCoordinator.observeSignal({
        source: "runtime",
        rawText: runtimeLog,
        command: "npm run dev",
        exitCode: 1,
      });

      expect(event).toBeDefined();
      expect(event?.eventType).toBe("RUNTIME_ERROR");
      expect(event?.evidence[0].errorCode).toBe("EADDRINUSE");
      expect(event?.suggestedAction?.args.command).toContain("kill-port 3000");
      expect(event?.suggestedAction?.riskLevel).toBe("HIGH");
      expect(event?.approvalRequired).toBe(true);
    });

    it("detects uncaught TypeError with callstack", async () => {
      const runtimeLog = "TypeError: Cannot read properties of undefined (reading 'token')\n    at login (auth.js:42:15)";

      const event = await predictiveContextCoordinator.observeSignal({
        source: "runtime",
        rawText: runtimeLog,
        file: "auth.js",
      });

      expect(event).toBeDefined();
      expect(event?.eventType).toBe("RUNTIME_ERROR");
      expect(event?.evidence[0].errorCode).toBe("TypeError");
    });
  });

  // ── 5. Confidence Scoring & LOW-Confidence Safety Gate ─────────────────────
  describe("5. Confidence Scoring & Safety Gates", () => {
    it("assigns HIGH confidence to direct compiler diagnostics with line numbers", () => {
      const diag = proactiveInsightAnalyzer.analyze(
        "TYPE_ERROR",
        {
          source: "compiler",
          rawOutput: "Cannot find name 'testVar'",
          errorCode: "TS2304",
          lineNumber: 10,
          capturedAt: Date.now(),
        },
        "proj",
        "file.ts"
      );

      expect(diag.confidence).toBe("HIGH");
      expect(diag.confidenceScore).toBeGreaterThanOrEqual(0.9);
    });

    it("assigns LOW confidence to vague heuristic signals and rejects autonomous action", () => {
      const diag = proactiveInsightAnalyzer.analyze(
        "SAFE_SUGGESTION",
        {
          source: "system",
          rawOutput: "heuristic context clue",
          capturedAt: Date.now(),
        },
        "proj",
        "file.ts"
      );

      expect(diag.confidence).toBe("LOW");
      expect(diag.confidenceScore).toBeLessThan(0.6);

      const suggestion = proactiveSuggestionEngine.generateSuggestion(
        "SAFE_SUGGESTION",
        diag.analysis,
        { source: "system", rawOutput: "heuristic", capturedAt: Date.now() },
        "LOW"
      );

      // INVARIANT: LOW-confidence predictions must NEVER trigger autonomous actions!
      expect(suggestion.suggestedAction).toBeNull();
      expect(suggestion.approvalRequired).toBe(false);
    });
  });

  // ── 6. Deduplication & Anti-Spam (10x Repeated Failure) ─────────────────────
  describe("6. Deduplication & Anti-Spam", () => {
    it("deduplicates identical errors and suppresses spam on rapid repeats", async () => {
      const errorText = "src/index.ts:10:1 - error TS2304: Cannot find name 'foo'.";
      const now = Date.now();

      // First occurrence -> allowed and notified
      const event1 = await predictiveContextCoordinator.observeSignal(
        { source: "compiler", rawText: errorText, file: "src/index.ts" },
        now
      );
      expect(event1).toBeDefined();
      expect(event1?.eventType).toBe("TYPE_ERROR");

      // Rapid second occurrence (within 60s cooldown) -> suppressed from creating duplicate alert
      const event2 = await predictiveContextCoordinator.observeSignal(
        { source: "compiler", rawText: errorText, file: "src/index.ts" },
        now + 5000
      );
      // Suppressed by cooldown
      expect(event2).toBeNull();
    });

    it("escalates to REPEATED_FAILURE when error occurs 10 times and consolidates notification", async () => {
      const errorText = "src/index.ts:10:1 - error TS2304: Cannot find name 'foo'.";
      let lastEvent: any = null;

      // Simulate 10 build failures with cooldown advancing
      for (let i = 0; i < 10; i++) {
        const timeOffset = Date.now() + i * 70_000; // past 60s cooldown
        const ev = await predictiveContextCoordinator.observeSignal(
          { source: "compiler", rawText: errorText, file: "src/index.ts" },
          timeOffset
        );
        if (ev) lastEvent = ev;
      }

      expect(lastEvent).toBeDefined();
      expect(lastEvent.eventType).toBe("REPEATED_FAILURE");
      expect(lastEvent.repeatCount).toBe(10);
      expect(lastEvent.promptQuestion).toContain("Ye same error repeatedly aa raha hai");
    });
  });

  // ── 7. Stale Event Expiration (TTL) ────────────────────────────────────────
  describe("7. Stale Event Expiration", () => {
    it("expires proactive events past TTL (300s) and blocks execution", async () => {
      const errorText = "src/index.ts:10:1 - error TS2304: Cannot find name 'foo'.";
      const now = Date.now();

      await predictiveContextCoordinator.observeSignal(
        { source: "compiler", rawText: errorText, file: "src/index.ts" },
        now
      );

      expect(predictiveContextCoordinator.getPendingProactiveEvent(now)).toBeDefined();

      // Advance time by 301 seconds (past 300s TTL)
      const future = now + 301_000;
      expect(predictiveContextCoordinator.getPendingProactiveEvent(future)).toBeNull();

      // Attempting to respond to expired event
      const res = await predictiveContextCoordinator.handleUserResponse("haan", "default", future);
      expect(res.resolved).toBe(false);
      expect(res.actionTaken).toBe("NO_ACTION");
      expect(res.reason).toBe("NO_PENDING_PROACTIVE_EVENT");
    });
  });

  // ── 8. Task Stalled Detection ──────────────────────────────────────────────
  describe("8. Task Stalled Detection", () => {
    it("detects stalled background tasks and proposes cancellation", async () => {
      const event = await predictiveContextCoordinator.observeSignal({
        source: "task_monitor",
        rawText: "task timeout after 600s: process hung",
        command: "task-1024",
        task: "stalled",
      });

      expect(event).toBeDefined();
      expect(event?.eventType).toBe("TASK_STALLED");
      expect(event?.suggestedAction?.capability).toBe("tasks.cancelTask");
      expect(event?.suggestedAction?.args.taskId).toBe("task-1024");
    });
  });

  // ── 9. Natural Dialogue Integration: 'haan', 'nahi', 'baad mein' ───────────
  describe("9. Natural Dialogue Integration", () => {
    it("approves and executes proactive action when user says 'haan'", async () => {
      await predictiveContextCoordinator.observeSignal({
        source: "compiler",
        rawText: "src/app.ts:5:2 - error TS2304: Cannot find name 'config'.",
        file: "src/app.ts",
      });

      expect(predictiveContextCoordinator.getPendingProactiveEvent()).toBeDefined();

      const outcome = await predictiveContextCoordinator.handleUserResponse("haan");
      expect(outcome.resolved).toBe(true);
      expect(outcome.actionTaken).toBe("APPROVED_AND_EXECUTED");
      expect(outcome.event?.status).toBe("VERIFIED");
      expect(predictiveContextCoordinator.getPendingProactiveEvent()).toBeNull();
    });

    it("dismisses proactive suggestion when user says 'nahi'", async () => {
      await predictiveContextCoordinator.observeSignal({
        source: "compiler",
        rawText: "src/app.ts:5:2 - error TS2304: Cannot find name 'config'.",
        file: "src/app.ts",
      });

      const outcome = await predictiveContextCoordinator.handleUserResponse("nahi");
      expect(outcome.resolved).toBe(true);
      expect(outcome.actionTaken).toBe("DISMISSED");
      expect(outcome.event?.status).toBe("DISMISSED");
      expect(predictiveContextCoordinator.getPendingProactiveEvent()).toBeNull();
    });

    it("snoozes proactive suggestion when user says 'baad mein'", async () => {
      await predictiveContextCoordinator.observeSignal({
        source: "compiler",
        rawText: "src/app.ts:5:2 - error TS2304: Cannot find name 'config'.",
        file: "src/app.ts",
      });

      const outcome = await predictiveContextCoordinator.handleUserResponse("baad mein");
      expect(outcome.resolved).toBe(true);
      expect(outcome.actionTaken).toBe("SNOOZED");
      expect(outcome.event?.status).toBe("SNOOZED");
      expect(predictiveContextCoordinator.getPendingProactiveEvent()).toBeNull();
    });

    it("prevents ghost actions: 'haan kar do' with no pending event returns NOOP", async () => {
      expect(predictiveContextCoordinator.getPendingProactiveEvent()).toBeNull();

      const resp = await naturalConversationEngine.converse("haan kar do", "ctx_proactive");
      expect(resp.decision.intent).toBe("NOOP");
      expect(resp.decision.reason).toContain("INVARIANT: Affirmation received with no pending confirmation");
    });
  });

  // ── 10. Security Policy Enforcement ────────────────────────────────────────
  describe("10. Security Policy Enforcement", () => {
    it("halts observation immediately when Emergency Stop is active", async () => {
      await emergencyStopCoordinator.trigger({ source: "desktop_ui", reason: "unit_test_stop" });

      const event = await predictiveContextCoordinator.observeSignal({
        source: "compiler",
        rawText: "src/app.ts:5:2 - error TS2304: Cannot find name 'config'.",
      });

      expect(event).toBeNull();
    });

    it("blocks execution of proactive action if Emergency Stop is engaged during approval", async () => {
      await predictiveContextCoordinator.observeSignal({
        source: "compiler",
        rawText: "src/app.ts:5:2 - error TS2304: Cannot find name 'config'.",
        file: "src/app.ts",
      });

      // Emergency stop triggered before user responds
      await emergencyStopCoordinator.trigger({ source: "desktop_ui", reason: "unit_test_stop" });

      const outcome = await predictiveContextCoordinator.handleUserResponse("haan");
      expect(outcome.actionTaken).toBe("BLOCKED");
      expect(outcome.reason).toBe("EMERGENCY_STOP_ACTIVE");
    });

    it("blocks state-changing proactive action when Security Lockdown is active", async () => {
      await predictiveContextCoordinator.observeSignal({
        source: "compiler",
        rawText: "src/app.ts:5:2 - error TS2304: Cannot find name 'config'.",
        file: "src/app.ts",
      });

      // Security lockdown engaged
      securityPolicyEngine.setMode("LOCKDOWN");

      const outcome = await predictiveContextCoordinator.handleUserResponse("haan");
      expect(outcome.actionTaken).toBe("BLOCKED");
      expect(outcome.reason).toBe("SECURITY_LOCKDOWN_ACTIVE");
    });
  });

  // ── 11. End-to-End Simulation: Full 6-Tier Proactive Flow ──────────────────
  describe("11. End-to-End Proactive Flow Simulation", () => {
    it("executes the full lifecycle: OBSERVE -> ANALYZE -> PREPARE -> ASK -> APPROVE -> EXECUTE -> VERIFY -> REPORT", async () => {
      // Step 1 & 2: Project open, build fails with TypeScript error
      const buildFailureLog = "src/database/client.ts:31:10 - error TS2304: Cannot find name 'PoolClient'.";

      // Step 3 & 4: OBSERVE & ANALYZE
      const event = await predictiveContextCoordinator.observeSignal({
        source: "compiler",
        rawText: buildFailureLog,
        command: "npm run build",
        exitCode: 1,
        project: "db-service",
        file: "src/database/client.ts",
      });

      expect(event).toBeDefined();
      expect(event?.status).toBe("AWAITING_APPROVAL");

      // Step 5: PREPARE
      expect(event?.suggestedAction?.summary).toContain("client.ts");
      expect(event?.promptQuestion).toBeDefined();

      // Step 6: ASK
      // MYRAA speaks question: "Sandeep, build mein ek TypeScript error hai..."
      expect(event?.promptQuestion).toContain("PoolClient");

      // Step 7 & 8: APPROVE & EXECUTE via Natural Conversation
      const convResp = await naturalConversationEngine.converse("haan kar do", "ctx_proactive");

      // Step 9 & 10: VERIFY & REPORT
      expect(convResp.decision.requiresConfirmation).toBe(false);
      expect(convResp.responseSpeech).toContain("execute kar diya hai aur verification successful rahi");
      expect(predictiveContextCoordinator.getPendingProactiveEvent()).toBeNull();
    });
  });

  // ── 12. REST Endpoints Integration ─────────────────────────────────────────
  describe("12. REST Endpoints Integration", () => {
    let server: http.Server;
    let baseUrl: string;

    beforeEach(async () => {
      const app = createHttpApp();
      await new Promise<void>((resolve) => {
        server = app.listen(0, "127.0.0.1", () => {
          const addr = server.address() as any;
          baseUrl = `http://127.0.0.1:${addr.port}`;
          resolve();
        });
      });
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it("observes a signal via POST /api/proactive/observe", async () => {
      const res = await fetch(`${baseUrl}/api/proactive/observe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "compiler",
          rawText: "src/test.ts:1:1 - error TS2304: Cannot find name 'x'.",
          file: "src/test.ts",
        }),
      });

      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.ok).toBe(true);
      expect(json.event.eventType).toBe("TYPE_ERROR");
    });

    it("retrieves pending proactive event via GET /api/proactive/pending", async () => {
      await predictiveContextCoordinator.observeSignal({
        source: "compiler",
        rawText: "src/test.ts:1:1 - error TS2304: Cannot find name 'x'.",
        file: "src/test.ts",
      });

      const res = await fetch(`${baseUrl}/api/proactive/pending`);
      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.ok).toBe(true);
      expect(json.pending).toBeDefined();
      expect(json.pending.file).toBe("src/test.ts");
    });

    it("responds to proactive suggestion via POST /api/proactive/respond", async () => {
      await predictiveContextCoordinator.observeSignal({
        source: "compiler",
        rawText: "src/test.ts:1:1 - error TS2304: Cannot find name 'x'.",
        file: "src/test.ts",
      });

      const res = await fetch(`${baseUrl}/api/proactive/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userUtterance: "haan" }),
      });

      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.ok).toBe(true);
      expect(json.resolution.actionTaken).toBe("APPROVED_AND_EXECUTED");
    });

    it("lists recent events via GET /api/proactive/events", async () => {
      const res = await fetch(`${baseUrl}/api/proactive/events?limit=5`);
      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.ok).toBe(true);
      expect(Array.isArray(json.events)).toBe(true);
    });

    it("resets state via POST /api/proactive/reset", async () => {
      const res = await fetch(`${baseUrl}/api/proactive/reset`, { method: "POST" });
      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.ok).toBe(true);
    });
  });
});
