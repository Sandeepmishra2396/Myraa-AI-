/**
 * MYRAA — Phase 17: Intelligence 2.0 Test Suite
 *
 * Verifies the Context-Aware Decision & Action Engine:
 * 1. Context Fusion & Priority Ladder (Instruction > Task > App/File > Conversation > Action > Preference > Long-term)
 * 2. Situation Understanding & Deictic Reference Resolution ("isko", "isme", "ye wala")
 * 3. Ambiguity Detection & Clarification (No blind execution when multiple candidates exist)
 * 4. Confidence Tiering (HIGH, MEDIUM, LOW)
 * 5. Task Continuity & Follow-up Actions ("Ab isko test karo", "Phir browser kholo", "Isme kya problem hai")
 * 6. YouTube Contextual Follow-up ("Play karo" referring to previous search result)
 * 7. User Preferences & Explicit Instruction Overrides
 * 8. Capability Awareness & Security Policy / Lockdown Constraints
 * 9. Emergency Stop & Security Gate Protection
 * 10. Action Result Verification (Shell, Code Test, App Launch, Media)
 * 11. Result Memory & Short-Term Learning
 * 12. Sanitized Intelligence Trace with Credential Redaction
 * 13. End-to-End Intelligence Coordinator Lifecycle
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { contextFusionEngine } from "../intelligence/ContextFusionEngine.ts";
import { situationUnderstandingEngine } from "../intelligence/SituationUnderstandingEngine.ts";
import { goalResolver } from "../intelligence/GoalResolver.ts";
import { userPreferenceResolver } from "../intelligence/UserPreferenceResolver.ts";
import { capabilityAwarenessEngine } from "../intelligence/CapabilityAwarenessEngine.ts";
import { decisionEngine } from "../intelligence/DecisionEngine.ts";
import { actionPlanningEngine } from "../intelligence/ActionPlanningEngine.ts";
import { intelligenceActionVerifier } from "../intelligence/ActionVerifier.ts";
import { contextMemoryUpdater } from "../intelligence/ContextMemoryUpdater.ts";
import { intelligenceTrace } from "../intelligence/IntelligenceTrace.ts";
import { intelligenceCoordinator } from "../intelligence/IntelligenceCoordinator.ts";
import { ContextPriority } from "../intelligence/IntelligenceTypes.ts";
import http from "http";
import { createHttpApp } from "../gateway/HttpGateway.ts";
import { emergencyStopCoordinator } from "../remote/EmergencyStopCoordinator.ts";
import { securityPolicyEngine } from "../security/SecurityPolicyEngine.ts";

describe("Phase 17 — MYRAA Intelligence 2.0", () => {
  beforeEach(async () => {
    // Reset test state
    intelligenceTrace.clearTraces();
    await emergencyStopCoordinator.reset();
    securityPolicyEngine.setMode("BALANCED");
    userPreferenceResolver.resetPreferences();
    contextFusionEngine.clearTransientItems("test_context");
  });

  // ── 1. Context Fusion & Priority Hierarchy ──────────────────────────────────
  describe("1. Context Fusion & Priority Ladder", () => {
    it("assigns strict numeric priority ladder values", () => {
      expect(ContextPriority.EXPLICIT_USER_INSTRUCTION).toBe(100);
      expect(ContextPriority.CURRENT_TASK_CONTEXT).toBe(85);
      expect(ContextPriority.CURRENT_APPLICATION_FILE_PROJECT).toBe(70);
      expect(ContextPriority.RECENT_CONVERSATION).toBe(55);
      expect(ContextPriority.RECENT_SUCCESSFUL_ACTION).toBe(40);
      expect(ContextPriority.USER_PREFERENCE).toBe(25);
      expect(ContextPriority.LONG_TERM_MEMORY).toBe(10);
    });

    it("fuses multi-source context correctly into FusedContext", () => {
      const fused = contextFusionEngine.fuseContext({
        contextId: "ctx_101",
        currentDevice: "DESKTOP",
        currentApplication: "vscode",
        currentFile: "D:/SORA AI/Sora AI/src/server.ts",
        currentProject: "D:/SORA AI/Sora AI",
        previousConversation: [
          { role: "user", text: "Open server file", timestamp: Date.now() - 20000 },
          { role: "model", text: "Opened server.ts", timestamp: Date.now() - 19000 },
        ],
      });

      expect(fused.contextId).toBe("ctx_101");
      expect(fused.currentDevice).toBe("DESKTOP");
      expect(fused.currentApplication).toBe("vscode");
      expect(fused.currentFile).toBe("D:/SORA AI/Sora AI/src/server.ts");
      expect(fused.currentProject).toBe("D:/SORA AI/Sora AI");
      expect(fused.previousConversation.length).toBe(2);
      expect(fused.userPreferences.preferredEditor).toBe("vscode");
    });

    it("decays transient entities after expiry window", () => {
      // Add transient item with 0ms remaining
      contextFusionEngine.setTransientItem(
        "ctx_decay",
        "temp_button",
        "clicked_element",
        ContextPriority.RECENT_CONVERSATION,
        -1000 // already expired
      );

      const retrieved = contextFusionEngine.getTransientItem("ctx_decay", "temp_button");
      expect(retrieved).toBeNull();
    });
  });

  // ── 2. Situation Understanding & Deictic Pronoun Resolution ──────────────────
  describe("2. Situation Understanding & Pronoun Binding", () => {
    it("resolves 'isko' to active file when present", () => {
      const context = contextFusionEngine.fuseContext({
        contextId: "ctx_code",
        currentFile: "D:/SORA AI/Sora AI/src/backend/server.ts",
      });

      const situation = situationUnderstandingEngine.analyzeSituation("Isko check karo", context);
      expect(situation.domain).toBe("code");
      expect(situation.implicitReferences.hasDeicticReference).toBe(true);
      expect(situation.implicitReferences.resolvedEntity).toBe("D:/SORA AI/Sora AI/src/backend/server.ts");
      expect(situation.implicitReferences.resolvedType).toBe("file");
      expect(situation.implicitReferences.confidence).toBeGreaterThanOrEqual(0.85);
    });

    it("resolves 'isme' to current project when discussing bugs", () => {
      const context = contextFusionEngine.fuseContext({
        contextId: "ctx_bug",
        currentFile: "D:/SORA AI/Sora AI/src/auth.ts",
        currentProject: "D:/SORA AI/Sora AI",
      });

      const situation = situationUnderstandingEngine.analyzeSituation("Isme bug hai, dekhna", context);
      expect(situation.domain).toBe("code");
      expect(situation.implicitReferences.hasDeicticReference).toBe(true);
      expect(situation.implicitReferences.resolvedEntity).toBe("D:/SORA AI/Sora AI/src/auth.ts");
    });

    it("identifies media domain for playback controls", () => {
      const context = contextFusionEngine.fuseContext({
        contextId: "ctx_media",
        activeMedia: {
          title: "Kesariya - Arijit Singh",
          videoId: "BddP6PYo2gs",
          status: "stopped",
        },
      });

      const situation = situationUnderstandingEngine.analyzeSituation("Play karo", context);
      expect(situation.domain).toBe("media");
    });
  });

  // ── 3. Ambiguity Detection & No-Blind-Execution ──────────────────────────────
  describe("3. Ambiguity Detection & Safe Clarification", () => {
    it("flags HIGH ambiguity when user says 'open that file' with multiple candidate files", () => {
      const context = contextFusionEngine.fuseContext({
        contextId: "ctx_ambig",
        currentFile: null,
      });

      const situation = situationUnderstandingEngine.analyzeSituation(
        "Open that file from server.ts and config.ts",
        context
      );

      expect(situation.ambiguityLevel).toBe("HIGH");
      expect(situation.ambiguousCandidates.length).toBe(2);
      expect(situation.ambiguousCandidates).toContain("server.ts");
      expect(situation.ambiguousCandidates).toContain("config.ts");

      const goal = goalResolver.resolveGoal("Open that file from server.ts and config.ts", situation, context);
      const decision = decisionEngine.evaluateDecision("Open that file from server.ts and config.ts", goal, situation, context);

      expect(decision.requiresClarification).toBe(true);
      expect(decision.candidateActions.length).toBe(0);
      expect(decision.selectedAction).toBeNull();
      expect(decision.clarificationQuestion).toContain("Kaunsi file open karni hai?");
    });

    it("flags MEDIUM ambiguity if 'play karo' is asked without any previous media context", () => {
      const context = contextFusionEngine.fuseContext({
        contextId: "ctx_empty_media",
        activeMedia: null,
      });

      const situation = situationUnderstandingEngine.analyzeSituation("Play karo", context);
      expect(situation.ambiguityLevel).toBe("MEDIUM");
      expect(situation.missingContext).toContain("media_query");
    });
  });

  // ── 4. Goal Resolution & Follow-Up Commands ─────────────────────────────────
  describe("4. Goal Resolver & Natural Follow-ups", () => {
    it("correctly flags follow-up: 'Ab isko test karo'", () => {
      const context = contextFusionEngine.fuseContext({
        contextId: "ctx_followup",
        currentFile: "src/auth.test.ts",
      });
      const situation = situationUnderstandingEngine.analyzeSituation("Ab isko test karo", context);
      const goal = goalResolver.resolveGoal("Ab isko test karo", situation, context);

      expect(goal.isFollowUp).toBe(true);
      expect(goal.followUpType).toBe("test");
      expect(goal.targetEntity).toBe("src/auth.test.ts");
    });

    it("correctly flags follow-up: 'Phir browser kholo'", () => {
      const context = contextFusionEngine.fuseContext({
        contextId: "ctx_browser",
        currentWebsite: "https://github.com",
      });
      const situation = situationUnderstandingEngine.analyzeSituation("Phir browser kholo", context);
      const goal = goalResolver.resolveGoal("Phir browser kholo", situation, context);

      expect(goal.isFollowUp).toBe(true);
      expect(goal.followUpType).toBe("browse");
    });

    it("correctly flags follow-up: 'Isme kya problem hai?'", () => {
      const context = contextFusionEngine.fuseContext({
        contextId: "ctx_diag",
        currentFile: "src/index.ts",
      });
      const situation = situationUnderstandingEngine.analyzeSituation("Isme kya problem hai?", context);
      const goal = goalResolver.resolveGoal("Isme kya problem hai?", situation, context);

      expect(goal.isFollowUp).toBe(true);
      expect(goal.followUpType).toBe("inspect");
      expect(goal.targetEntity).toBe("src/index.ts");
    });
  });

  // ── 5. User Preferences & Explicit Overrides ────────────────────────────────
  describe("5. User Preference Resolver & Overrides", () => {
    it("uses default user preferences for editor and workspace", () => {
      const prefs = userPreferenceResolver.getPreferences();
      expect(prefs.preferredEditor).toBe("vscode");
      expect(prefs.preferredBrowser).toBe("chrome");
      expect(prefs.preferredWorkspace.replace(/\\/g, "/")).toBe("D:/SORA AI/Sora AI");
    });

    it("allows updating preferences dynamically", () => {
      userPreferenceResolver.updatePreferences({ preferredEditor: "cursor" });
      const prefs = userPreferenceResolver.getPreferences();
      expect(prefs.preferredEditor).toBe("cursor");
    });

    it("never lets user preference override an explicit user instruction", () => {
      userPreferenceResolver.updatePreferences({ preferredEditor: "vscode" });
      const context = contextFusionEngine.fuseContext({
        contextId: "ctx_override",
      });

      // User explicitly requests Notepad
      const situation = situationUnderstandingEngine.analyzeSituation("Notepad mein open karo", context);
      const goal = goalResolver.resolveGoal("Notepad mein open karo", situation, context);

      // Explicit instruction "Notepad" takes precedence over preferred "vscode"
      expect(goal.targetEntity).toBe("notepad");
    });
  });

  // ── 6. Capability Awareness & Security Policy Integration ────────────────────
  describe("6. Capability Awareness & Security Policy", () => {
    it("reports all system capabilities", () => {
      const caps = capabilityAwarenessEngine.getAvailableCapabilities();
      expect(caps).toContain("desktop.openApplication");
      expect(caps).toContain("desktop.openFile");
      expect(caps).toContain("youtube.play");
      expect(caps).toContain("code.inspect");
      expect(caps).toContain("code.runTests");
    });

    it("restricts capabilities when Security Lockdown is active", () => {
      securityPolicyEngine.setMode("LOCKDOWN");
      const context = contextFusionEngine.fuseContext({ contextId: "ctx_lock" });
      const assessment = capabilityAwarenessEngine.assessCapability(
        "runShellCommand",
        { command: "dir" },
        "DESKTOP",
        context
      );

      expect(assessment.constraints.some((c) => c.includes("Lockdown"))).toBe(true);
    });

    it("flags path traversal attempts in arguments", () => {
      const context = contextFusionEngine.fuseContext({ contextId: "ctx_trav" });
      const assessment = capabilityAwarenessEngine.assessCapability(
        "openFile",
        { path: "../../windows/system32" },
        "DESKTOP",
        context
      );

      expect(assessment.constraints.some((c) => c.includes("traversal"))).toBe(true);
    });
  });

  // ── 7. Decision Engine Scenarios ────────────────────────────────────────────
  describe("7. Decision Engine Scenarios", () => {
    it("VS Code scenario: 'Bhai VS Code kholo' evaluates workspace and selects high confidence open", () => {
      const context = contextFusionEngine.fuseContext({
        contextId: "ctx_vsc",
        currentProject: "D:/SORA AI/Sora AI",
      });

      const situation = situationUnderstandingEngine.analyzeSituation("Bhai VS Code kholo", context);
      const goal = goalResolver.resolveGoal("Bhai VS Code kholo", situation, context);
      const decision = decisionEngine.evaluateDecision("Bhai VS Code kholo", goal, situation, context);

      expect(decision.intent).toBe("desktop.openApplication");
      expect(decision.confidence).toBe("HIGH");
      expect(decision.confidenceScore).toBeGreaterThanOrEqual(0.85);
      expect(decision.selectedAction).not.toBeNull();
      expect(decision.selectedAction?.toolName).toBe("openInVsCode");
      expect(decision.selectedAction?.args.path).toBe("D:/SORA AI/Sora AI");
      expect(decision.requiresConfirmation).toBe(false);
    });

    it("YouTube context scenario: 'Play karo' after search selects selectedResult", () => {
      const context = contextFusionEngine.fuseContext({
        contextId: "ctx_yt",
        activeMedia: {
          title: "Channa Mereya - Arijit Singh",
          videoId: "284Ov7ysmfA",
          status: "stopped",
          selectedResult: {
            index: 1,
            title: "Channa Mereya - Arijit Singh",
            videoId: "284Ov7ysmfA",
            url: "https://youtube.com/watch?v=284Ov7ysmfA",
          },
        },
      });

      const situation = situationUnderstandingEngine.analyzeSituation("Play karo", context);
      const goal = goalResolver.resolveGoal("Play karo", situation, context);
      const decision = decisionEngine.evaluateDecision("Play karo", goal, situation, context);

      expect(decision.intent).toBe("youtube.play");
      expect(decision.selectedAction?.toolName).toBe("browserMediaControl");
      expect(decision.selectedAction?.args.videoId).toBe("284Ov7ysmfA");
      expect(decision.confidence).toBe("HIGH");
    });

    it("Code Inspection scenario: 'Isko check karo' inspects active file", () => {
      const context = contextFusionEngine.fuseContext({
        contextId: "ctx_inspect",
        currentFile: "D:/SORA AI/Sora AI/src/backend/gateway/HttpGateway.ts",
      });

      const situation = situationUnderstandingEngine.analyzeSituation("Isko check karo", context);
      const goal = goalResolver.resolveGoal("Isko check karo", situation, context);
      const decision = decisionEngine.evaluateDecision("Isko check karo", goal, situation, context);

      expect(decision.intent).toBe("code.inspect");
      expect(decision.selectedAction?.toolName).toBe("readFile");
      expect(decision.selectedAction?.args.filePath).toBe("D:/SORA AI/Sora AI/src/backend/gateway/HttpGateway.ts");
    });

    it("Blocks all decisions when Emergency Stop is engaged", async () => {
      await emergencyStopCoordinator.trigger({ source: "desktop_ui", reason: "manual_test" });
      const context = contextFusionEngine.fuseContext({ contextId: "ctx_es" });
      const situation = situationUnderstandingEngine.analyzeSituation("VS Code kholo", context);
      const goal = goalResolver.resolveGoal("VS Code kholo", situation, context);
      const decision = decisionEngine.evaluateDecision("VS Code kholo", goal, situation, context);

      expect(decision.blockedBySecurity).toBe(true);
      expect(decision.securityBlockReason).toBe("EMERGENCY_STOP");
      expect(decision.candidateActions.length).toBe(0);
      expect(decision.selectedAction).toBeNull();
      await emergencyStopCoordinator.reset();
    });
  });

  // ── 8. Task Planning & Continuity ───────────────────────────────────────────
  describe("8. Task Planning & Continuity", () => {
    it("initializes a multi-step task and advances steps sequentially", () => {
      const task = actionPlanningEngine.initTask("Bug Fix and Verification", [
        {
          stepId: "step_1",
          description: "Inspect code in auth.ts",
          capability: "code.inspect",
          toolName: "readFile",
          args: { filePath: "src/auth.ts" },
          targetDevice: "DESKTOP",
        },
        {
          stepId: "step_2",
          description: "Run test suite",
          capability: "code.runTests",
          toolName: "runShellCommand",
          args: { command: "npm test" },
          targetDevice: "DESKTOP",
        },
      ]);

      expect(task.goal).toBe("Bug Fix and Verification");
      expect(task.currentStep?.stepId).toBe("step_1");
      expect(task.completedSteps.length).toBe(0);

      // Advance step 1
      const updatedTask = actionPlanningEngine.advanceStep({ ok: true, output: "No syntax errors" });
      expect(updatedTask).not.toBeNull();
      expect(updatedTask?.completedSteps.length).toBe(1);
      expect(updatedTask?.currentStep?.stepId).toBe("step_2");
    });
  });

  // ── 9. Action Verifier ──────────────────────────────────────────────────────
  describe("9. Action Verifier (Principle 8: Evidence-based verification)", () => {
    it("verifies shell command success with exit code 0", () => {
      const result = intelligenceActionVerifier.verifyShellCommand("dir", {
        ok: true,
        exitCode: 0,
        stdout: "Volume in drive D is Data\nDirectory of D:\\",
      });

      expect(result.verified).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.stdoutSnippet).toContain("Volume in drive D");
    });

    it("rejects shell command failure with non-zero exit code", () => {
      const result = intelligenceActionVerifier.verifyShellCommand("nonexistent_cmd", {
        ok: false,
        exitCode: 1,
        stderr: "command not found",
      });

      expect(result.verified).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.failureReason).toContain("command not found");
    });

    it("verifies test execution outcome", () => {
      const pass = intelligenceActionVerifier.verifyTestExecution({ passed: true, output: "12 tests passed" });
      expect(pass.verified).toBe(true);

      const fail = intelligenceActionVerifier.verifyTestExecution({ passed: false, error: "1 assertion failed" });
      expect(fail.verified).toBe(false);
    });
  });

  // ── 10. Context Memory Updater & Learning ───────────────────────────────────
  describe("10. Context Memory Updater & Learning", () => {
    it("updates short-term execution memory upon successful tool run", () => {
      contextMemoryUpdater.recordExecutionResult(
        "ctx_learn",
        {
          id: "act_1",
          capability: "desktop.openApplication",
          toolName: "openInVsCode",
          args: { path: "D:/SORA AI" },
          targetDevice: "DESKTOP",
          score: 1.0,
          risk: "LOW",
          requiresConfirmation: false,
          reason: "Opened VS Code",
          verificationMethod: "process_check",
        },
        { pid: 1234, launched: true },
        true
      );

      const memory = contextMemoryUpdater.getExecutionMemory("ctx_learn");
      expect(memory).not.toBeNull();
      expect(memory?.lastAction).toBe("openInVsCode");
      expect(memory?.lastSuccessfulTool).toBe("openInVsCode");
      expect(memory?.lastTarget).toBe("D:/SORA AI");
      expect(memory?.lastResult).toEqual({ pid: 1234, launched: true });
    });
  });

  // ── 11. Sanitized Intelligence Trace ────────────────────────────────────────
  describe("11. Sanitized Intelligence Trace", () => {
    it("masks sensitive API keys, tokens, and passwords in execution traces", () => {
      const trace = intelligenceTrace.recordTrace({
        durationMs: 15,
        userInput: "Use API key AIzaSyBxyz1234567890abcdefghijklmnopqrst and token secret123456",
        intent: "code.inspect",
        context: {
          device: "DESKTOP",
          app: "vscode",
          file: "config.json",
          project: "test",
          taskGoal: null,
        },
        goal: { primary: "Test key masking", confidence: 1.0 },
        candidateActions: [],
        selectedAction: null,
        verification: { method: "none", verified: true },
        result: { ok: true, summary: "Completed" },
      });

      expect(trace.sanitized).toBe(true);
      expect(trace.userInput).not.toContain("AIzaSyBxyz1234567890abcdefghijklmnopqrst");
      expect(trace.userInput).toContain("[REDACTED_GEMINI_KEY]");
      expect(trace.userInput).toContain("[REDACTED]");
    });

    it("maintains ring buffer up to 200 traces without memory leak", () => {
      for (let i = 0; i < 220; i++) {
        intelligenceTrace.recordTrace({
          durationMs: 1,
          userInput: `Turn ${i}`,
          intent: "general.assist",
          context: { device: "DESKTOP", app: null, file: null, project: null, taskGoal: null },
          goal: { primary: `Turn ${i}`, confidence: 1.0 },
          candidateActions: [],
          selectedAction: null,
          verification: { method: "none", verified: true },
          result: { ok: true, summary: "OK" },
        });
      }

      const list = intelligenceTrace.listTraces(300);
      expect(list.length).toBe(200);
      expect(list[0].userInput).toBe("Turn 219");
    });
  });

  // ── 12. Intelligence Coordinator Lifecycle ──────────────────────────────────
  describe("12. Intelligence Coordinator Lifecycle", () => {
    it("evaluates user query and returns complete structured DecisionEvaluation", () => {
      const decision = intelligenceCoordinator.evaluate("Bhai VS Code kholo", "ctx_coord_1");
      expect(decision.decisionId).toBeDefined();
      expect(decision.intent).toBe("desktop.openApplication");
      expect(decision.selectedAction?.toolName).toBe("openInVsCode");
      expect(decision.confidence).toBe("HIGH");

      // Verify trace was recorded
      const traces = intelligenceTrace.listTraces(10);
      expect(traces.length).toBeGreaterThan(0);
      expect(traces[0].intent).toBe("desktop.openApplication");
    });

    it("executes an action through existing orchestrator and records verification evidence", async () => {
      const outcome = await intelligenceCoordinator.execute(
        "Bhai VS Code kholo",
        "ctx_coord_exec",
        undefined,
        {
          openApplication: async (app, args, device) => ({
            ok: true,
            result: { appName: "vscode", pid: 9999, launched: true },
          }),
        }
      );

      expect(outcome.decision).toBeDefined();
      expect(outcome.trace).toBeDefined();
      expect(outcome.trace.sanitized).toBe(true);
    });
  });

  // ── 13. REST Endpoints Integration ──────────────────────────────────────────
  describe("13. REST Endpoints Integration", () => {
    let server: http.Server | null = null;
    let port = 0;

    beforeEach(async () => {
      const app = createHttpApp();
      server = http.createServer(app);
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
      port = (server.address() as any).port;
    });

    afterEach(async () => {
      if (server) {
        await new Promise<void>((resolve) => server!.close(() => resolve()));
        server = null;
      }
    });

    it("evaluates intent via POST /api/intelligence/evaluate", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/intelligence/evaluate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: "Bhai VS Code kholo", contextId: "ctx_http_eval" }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.decision).toBeDefined();
      expect(data.decision.intent).toBe("desktop.openApplication");
      expect(data.decision.confidence).toBe("HIGH");
    });

    it("updates and retrieves context via POST /api/intelligence/context", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/intelligence/context`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contextId: "ctx_http_update",
          file: "D:/SORA AI/Sora AI/src/server.ts",
          app: "vscode",
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.context.currentFile).toBe("D:/SORA AI/Sora AI/src/server.ts");
      expect(data.context.currentApplication).toBe("vscode");
    });

    it("lists recent sanitized traces via GET /api/intelligence/traces", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/intelligence/traces?limit=10`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(Array.isArray(data.traces)).toBe(true);
    });
  });
});
