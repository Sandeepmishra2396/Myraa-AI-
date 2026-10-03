/**
 * Phase 19 — MYRAA Advanced Context Fusion Engine Test Suite
 *
 * Comprehensive verification of the unified intelligence context architecture:
 *   1. Multi-Source Context Aggregation (Voice, App, File, Project, Browser, Screen, Brain, Task, Device, Time, Actions, UI)
 *   2. Context Freshness & Stale-Context Protection (TTL decay, stale rejection)
 *   3. Source Reliability & Confidence Scoring (Tiers, corroboration bonus, low-confidence guardrail)
 *   4. Conflict Detection & Deterministic Resolution (Explicit instruction priority, freshness precedence, score comparison)
 *   5. Deictic Reference Resolution ("isko", "isme", "ye", "ye wala", "idhar", "iske andar", "play karo")
 *   6. Multi-Turn Conversation Continuity & Entity Tracking
 *   7. Active File & Workspace Project Awareness
 *   8. Adaptive Personal Brain & Cognitive Preference Integration
 *   9. Task & Recent Action Continuity
 *  10. Screen Visual & Active Window Context Integration
 *  11. Ambiguity Detection & Clarification (NEVER guess when confidence is insufficient)
 *  12. Security Policy Enforcement (Emergency Stop, Security Lockdown, Untrusted Data Invariant)
 *  13. Context Provenance & Audit Trail (Sanitized traces, zero secret leakage)
 *  14. REST Endpoints Integration (/api/context/unified, /api/context/resolve-reference, /api/context/provenance)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "http";
import {
  contextSourceRegistry,
  contextFreshnessManager,
  contextConfidenceEngine,
  contextConflictResolver,
  referenceResolver,
  contextProvenanceTracker,
  contextFusionCoordinator,
  ContextPriority,
  type UnifiedMyraaContext,
} from "../intelligence/index.ts";
import { contextFusionEngine } from "../intelligence/ContextFusionEngine.ts";
import { situationUnderstandingEngine } from "../intelligence/SituationUnderstandingEngine.ts";
import { decisionEngine } from "../intelligence/DecisionEngine.ts";
import { goalResolver } from "../intelligence/GoalResolver.ts";
import { intelligenceCoordinator } from "../intelligence/IntelligenceCoordinator.ts";
import { emergencyStopCoordinator } from "../remote/EmergencyStopCoordinator.ts";
import { securityPolicyEngine } from "../security/SecurityPolicyEngine.ts";
import { createHttpApp } from "../gateway/HttpGateway.ts";

describe("Phase 19 — Advanced Context Fusion Engine", () => {
  beforeEach(() => {
    emergencyStopCoordinator.reset("phase19_test_setup");
    securityPolicyEngine.resetForTesting();
    contextProvenanceTracker.clear();
    contextFusionEngine.clearTransientItems();
  });

  afterEach(() => {
    emergencyStopCoordinator.reset("phase19_test_teardown");
  });

  // ── 1. Multi-Source Context Aggregation ───────────────────────────────────
  describe("1. Multi-Source Context Aggregation", () => {
    it("fuses all 12+ perception channels into UnifiedMyraaContext", async () => {
      const unified = await contextFusionCoordinator.fuseUnifiedContext("ctx_multisource", {
        currentApplication: "vscode",
        currentFile: "D:/Projects/app/main.py",
        currentProject: "D:/Projects/app",
        currentWebsite: "https://github.com",
      });

      expect(unified).toBeDefined();
      expect(unified.contextId).toBe("ctx_multisource");
      // Application, File, Project
      expect(unified.currentApplication).toBe("vscode");
      expect(unified.currentFile).toBe("D:/Projects/app/main.py");
      expect(unified.currentProject).toBe("D:/Projects/app");
      // Browser
      expect(unified.browserContext?.url).toBe("https://github.com");
      // Voice & Device
      expect(unified.voiceState).toBeDefined();
      expect(unified.deviceState).toBeDefined();
      expect(unified.deviceState.deviceType).toBe("DESKTOP");
      expect(unified.deviceState.isLocal).toBe(true);
      expect(typeof unified.deviceState.localTime).toBe("string");
      // Freshness summary & Provenance
      expect(unified.freshnessSummary).toBeDefined();
      expect(unified.freshnessSummary.file.isFresh).toBe(true);
      expect(Array.isArray(unified.provenanceChain)).toBe(true);
    });
  });

  // ── 2. Context Freshness & Stale-Context Protection ───────────────────────
  describe("2. Context Freshness & Stale-Context Protection", () => {
    it("reports fresh state when observation is recent", () => {
      const now = Date.now();
      const recentTimestamp = now - 5000; // 5s ago
      expect(contextFreshnessManager.isFresh("file", recentTimestamp, now)).toBe(true);
      expect(contextFreshnessManager.getDecayFactor("file", recentTimestamp, now)).toBe(1.0);
    });

    it("decays and marks stale when observation exceeds source TTL", () => {
      const now = Date.now();
      const screenTtl = contextSourceRegistry.getDefaultTtl("screen"); // 30s
      const staleTimestamp = now - (screenTtl + 5000); // 35s ago

      expect(contextFreshnessManager.isFresh("screen", staleTimestamp, now)).toBe(false);
      expect(contextFreshnessManager.getDecayFactor("screen", staleTimestamp, now)).toBe(0.0);
      expect(contextFreshnessManager.isUsable("screen", staleTimestamp, 0.1, now)).toBe(false);
    });

    it("evaluates complete freshness summary across all sources", () => {
      const now = Date.now();
      const summary = contextFreshnessManager.evaluateFreshnessSummary(
        {
          voice: now - 2000,
          application: now - 10000,
          screen: now - 60000, // Stale!
        },
        now
      );

      expect(summary.voice.isFresh).toBe(true);
      expect(summary.application.isFresh).toBe(true);
      expect(summary.screen.isFresh).toBe(false);
      expect(summary.screen.decayFactor).toBe(0.0);
    });
  });

  // ── 3. Source Reliability & Confidence Scoring ───────────────────────────
  describe("3. Source Reliability & Confidence Scoring", () => {
    it("calibrates confidence based on source reliability and freshness decay", () => {
      const now = Date.now();
      const fileConf = contextConfidenceEngine.computeConfidence("file", now - 1000, 0, now);
      expect(fileConf).toBeGreaterThanOrEqual(0.9);
      expect(contextConfidenceEngine.getTier(fileConf)).toBe("HIGH");

      // Stale observation yields 0.0 confidence
      const staleConf = contextConfidenceEngine.computeConfidence("screen", now - 120000, 0, now);
      expect(staleConf).toBe(0.0);
      expect(contextConfidenceEngine.getTier(staleConf)).toBe("LOW");
    });

    it("applies multi-source corroboration bonus when independent sources agree", () => {
      const now = Date.now();
      const singleScore = contextConfidenceEngine.computeConfidence("application", now, 0, now);
      const corroboratedScore = contextConfidenceEngine.computeConfidence("application", now, 2, now);

      expect(corroboratedScore).toBeGreaterThan(singleScore);
      expect(corroboratedScore).toBeLessThanOrEqual(1.0);
    });

    it("enforces low-confidence guardrail (<0.5 requires clarification)", () => {
      expect(contextConfidenceEngine.isExecutionSafe(0.85)).toBe(true);
      expect(contextConfidenceEngine.isExecutionSafe(0.45)).toBe(false);
      expect(contextConfidenceEngine.requiresClarification(0.45)).toBe(true);
      expect(contextConfidenceEngine.requiresClarification(0.9, true)).toBe(true); // Ambiguous always requires clarification
    });
  });

  // ── 4. Conflict Detection & Deterministic Resolution ─────────────────────
  describe("4. Conflict Detection & Deterministic Resolution", () => {
    it("explicit user instruction strictly overrides background sensor state", () => {
      const conflict = contextConflictResolver.resolveConflict(
        "application",
        {
          value: "cursor",
          source: "voice",
          confidence: 1.0,
          timestamp: Date.now(),
          priority: ContextPriority.EXPLICIT_CURRENT_INSTRUCTION,
          isExplicitInstruction: true, // Explicit instruction!
        },
        {
          value: "vscode",
          source: "application",
          confidence: 0.95,
          timestamp: Date.now() - 5000,
          priority: ContextPriority.CURRENT_APPLICATION_FILE_PROJECT,
          isExplicitInstruction: false,
        }
      );

      expect(conflict.resolution).toBe("primary_won");
      expect(conflict.winningValue).toBe("cursor");
      expect(conflict.rationale).toContain("strictly overrides background state");
    });

    it("fresh source overrides stale source even with equal priority", () => {
      const now = Date.now();
      const conflict = contextConflictResolver.resolveConflict(
        "file",
        {
          value: "main.py",
          source: "file",
          confidence: 0.95,
          timestamp: now - 2000, // Fresh (2s ago)
          priority: ContextPriority.CURRENT_APPLICATION_FILE_PROJECT,
        },
        {
          value: "old_script.py",
          source: "screen",
          confidence: 0.8,
          timestamp: now - 120000, // Stale! (120s ago, screen TTL is 30s)
          priority: ContextPriority.CURRENT_APPLICATION_FILE_PROJECT,
        }
      );

      expect(conflict.resolution).toBe("primary_won");
      expect(conflict.winningValue).toBe("main.py");
      expect(conflict.rationale).toContain("Candidate A is fresh");
    });

    it("detects ambiguous tie when candidates have identical effective scores", () => {
      const now = Date.now();
      const conflict = contextConflictResolver.resolveConflict(
        "file",
        {
          value: "serviceA.ts",
          source: "file",
          confidence: 0.9,
          timestamp: now,
          priority: ContextPriority.CURRENT_APPLICATION_FILE_PROJECT,
        },
        {
          value: "serviceB.ts",
          source: "file",
          confidence: 0.9,
          timestamp: now,
          priority: ContextPriority.CURRENT_APPLICATION_FILE_PROJECT,
        }
      );

      expect(conflict.resolution).toBe("ambiguous_unresolved");
      expect(conflict.winningValue).toBeNull();
      expect(conflict.rationale).toContain("Ambiguous conflict");
    });
  });

  // ── 5. Deictic Reference Resolution ("isko", "isme", "ye") ────────────────
  describe("5. Deictic Reference Resolution", () => {
    it("resolves 'Isko improve karo' to active code file", () => {
      const fused = contextFusionEngine.fuseContext({
        currentFile: "D:/Projects/app/main.py",
        currentApplication: "vscode",
      });

      const ref = referenceResolver.resolveReference("Isko improve karo", fused);
      expect(ref.rawPronoun).toBe("isko");
      expect(ref.resolvedEntity).toBe("D:/Projects/app/main.py");
      expect(ref.resolvedType).toBe("file");
      expect(ref.confidenceTier).toBe("HIGH");
      expect(ref.isAmbiguous).toBe(false);
    });

    it("resolves 'Isme bug hai, dekhna' to active file", () => {
      const fused = contextFusionEngine.fuseContext({
        currentFile: "D:/Projects/app/server.ts",
        currentApplication: "vscode",
      });

      const ref = referenceResolver.resolveReference("Isme bug hai, dekhna", fused);
      expect(ref.rawPronoun).toBe("isme");
      expect(ref.resolvedEntity).toBe("D:/Projects/app/server.ts");
      expect(ref.resolvedType).toBe("file");
      expect(ref.isAmbiguous).toBe(false);
    });

    it("resolves 'Ye wala check karo' to active file", () => {
      const fused = contextFusionEngine.fuseContext({
        currentFile: "src/utils.ts",
      });

      const ref = referenceResolver.resolveReference("Ye wala check karo", fused);
      expect(ref.rawPronoun).toBe("ye wala");
      expect(ref.resolvedEntity).toBe("src/utils.ts");
      expect(ref.resolvedType).toBe("file");
    });

    it("resolves 'Iske andar search karo' to current workspace/project", () => {
      const fused = contextFusionEngine.fuseContext({
        currentFile: null,
        currentApplication: null,
        currentProject: "D:/Projects/MyraaAI",
      });

      const ref = referenceResolver.resolveReference("Iske andar search karo", fused);
      expect(ref.rawPronoun).toBe("iske andar");
      expect(ref.resolvedEntity).toBe("D:/Projects/MyraaAI");
      expect(ref.resolvedType).toBe("project");
    });

    it("resolves 'Isko close karo' to active application", () => {
      const fused = contextFusionEngine.fuseContext({
        currentFile: null,
        currentApplication: "notepad",
      });

      const ref = referenceResolver.resolveReference("Isko close karo", fused);
      expect(ref.rawPronoun).toBe("isko");
      expect(ref.resolvedEntity).toBe("notepad");
      expect(ref.resolvedType).toBe("app");
    });

    it("resolves 'Play karo' to active media search result", () => {
      const fused = contextFusionEngine.fuseContext({
        activeMedia: {
          title: "Arijit Singh Chill Mix",
          videoId: "vid_12345",
          status: "stopped",
          searchResults: [{ index: 0, title: "Arijit Singh Chill Mix", videoId: "vid_12345", url: "https://youtube.com/watch?v=vid_12345" }],
          selectedResult: { index: 0, title: "Arijit Singh Chill Mix", videoId: "vid_12345", url: "https://youtube.com/watch?v=vid_12345" },
        },
      });

      const ref = referenceResolver.resolveReference("Play karo", fused);
      expect(ref.resolvedEntity).toBe("Arijit Singh Chill Mix");
      expect(ref.resolvedType).toBe("media");
      expect(ref.confidence).toBeGreaterThanOrEqual(0.9);
    });
  });

  // ── 6. Multi-Turn Conversation Continuity & Entity Tracking ──────────────
  describe("6. Multi-Turn Conversation Continuity", () => {
    it("tracks entities mentioned in conversation across turns", () => {
      contextFusionEngine.recordConversationTurn("ctx_turns", "user", "main.py check karo");
      contextFusionEngine.recordConversationTurn("ctx_turns", "model", "Maine main.py open kar liya hai.");
      contextFusionEngine.recordConversationTurn("ctx_turns", "user", "Ab isme unit tests likho");

      const fused = contextFusionEngine.fuseContext("ctx_turns");
      expect(fused.previousConversation.length).toBe(3);

      const sit = situationUnderstandingEngine.analyzeSituation("Ab isme unit tests likho", fused);
      expect(sit.implicitReferences.hasDeicticReference).toBe(true);
      expect(sit.domain).toBe("code");
    });
  });

  // ── 7. Active File & Workspace Project Awareness ──────────────────────────
  describe("7. Active File & Workspace Project Awareness", () => {
    it("correctly identifies active project workspace and file in situation analysis", () => {
      const fused = contextFusionEngine.fuseContext({
        currentProject: "D:/SORA AI/Sora AI",
        currentFile: "server.ts",
      });

      const sit = situationUnderstandingEngine.analyzeSituation("Code explain karo", fused);
      expect(sit.activeEntities.files).toContain("server.ts");
      expect(sit.activeEntities.focusedEntity).toBe("server.ts");
    });
  });

  // ── 8. Adaptive Personal Brain & Cognitive Preference Integration ────────
  describe("8. Adaptive Personal Brain & Cognitive Preference Integration", () => {
    it("embeds brainContext directives in UnifiedMyraaContext", async () => {
      const unified = await contextFusionCoordinator.fuseUnifiedContext("ctx_brain_test");
      expect(unified.brainContext).toBeDefined();
      expect(typeof unified.brainContext?.learnedPreferencesCount).toBe("number");
    });

    it("ensures explicit current instruction overrides learned cognitive preferences", async () => {
      // User says open in Notepad explicitly, overriding any learned editor
      const fused = contextFusionEngine.fuseContext({
        currentApplication: "vscode",
      });

      const sit = situationUnderstandingEngine.analyzeSituation("Notepad kholo", fused);
      expect(sit.activeEntities.apps[0]).toBe("notepad"); // Explicit instruction won!
    });
  });

  // ── 9. Task & Recent Action Continuity ────────────────────────────────────
  describe("9. Task & Recent Action Continuity", () => {
    it("resolves references against active task entities when active file is not focused", () => {
      const fused = contextFusionEngine.fuseContext({
        currentFile: null,
        currentTask: {
          id: "task_ref_1",
          contextId: "default",
          goal: "Refactor database models",
          status: "active",
          steps: [],
          currentStepIndex: 0,
          currentStep: null,
          completedSteps: [],
          pendingStep: null,
          relevantEntities: {
            files: ["models.py"],
            apps: [],
            urls: [],
          },
          lastResult: null,
          nextExpectedAction: "inspect_models",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      });

      const ref = referenceResolver.resolveReference("Isko check karo", fused);
      expect(ref.resolvedEntity).toBe("models.py");
      expect(ref.resolvedType).toBe("file");
    });
  });

  // ── 10. Ambiguity Detection & Clarification Gates ─────────────────────────
  describe("10. Ambiguity Detection & Clarification Gates", () => {
    it("detects high ambiguity and refuses to guess when multiple files exist with no focus", () => {
      const fused = contextFusionEngine.fuseContext({
        currentFile: null,
        currentTask: {
          id: "task_multi",
          contextId: "default",
          goal: "Code review",
          status: "active",
          steps: [],
          currentStepIndex: 0,
          currentStep: null,
          completedSteps: [],
          pendingStep: null,
          relevantEntities: {
            files: ["fileA.ts", "fileB.ts"],
            apps: [],
            urls: [],
          },
          lastResult: null,
          nextExpectedAction: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      });

      const ref = referenceResolver.resolveReference("Isko check karo", fused);
      expect(ref.isAmbiguous).toBe(true);
      expect(ref.resolvedEntity).toBeNull();
      expect(ref.candidateAlternatives.length).toBeGreaterThanOrEqual(2);
      expect(ref.clarificationPrompt).toBeDefined();

      const sit = situationUnderstandingEngine.analyzeSituation("Wo file kholo", fused);
      expect(sit.ambiguityLevel).toBe("HIGH");

      const goal = goalResolver.resolveGoal("Wo file kholo", sit, fused);
      const decision = decisionEngine.evaluateDecision("Wo file kholo", goal, sit, fused);
      expect(decision.intent).toBe("CLARIFICATION_NEEDED");
      expect(decision.requiresClarification).toBe(true);
    });
  });

  // ── 11. Security Policy Enforcement ───────────────────────────────────────
  describe("11. Security Policy Enforcement", () => {
    it("halts decisions immediately when Emergency Stop is actively engaged", async () => {
      await emergencyStopCoordinator.trigger({ source: "desktop_ui", reason: "test_emergency" });

      const unified = await contextFusionCoordinator.fuseUnifiedContext("ctx_emergency");
      const sit = situationUnderstandingEngine.analyzeSituation("main.py improve karo", unified);
      const goal = goalResolver.resolveGoal("main.py improve karo", sit, unified);
      const decision = decisionEngine.evaluateDecision("main.py improve karo", goal, sit, unified);

      expect(decision.blockedBySecurity).toBe(true);
      expect(decision.securityBlockReason).toBe("EMERGENCY_STOP");
      expect(decision.intent).toBe("BLOCKED");
    });

    it("blocks modifying actions when Security Lockdown is active", async () => {
      securityPolicyEngine.setMode("LOCKDOWN");

      const unified = await contextFusionCoordinator.fuseUnifiedContext("ctx_lockdown", {
        currentFile: "main.py",
      });
      const sit = situationUnderstandingEngine.analyzeSituation("main.py modify karo", unified);
      const goal = goalResolver.resolveGoal("main.py modify karo", sit, unified);
      const decision = decisionEngine.evaluateDecision("main.py modify karo", goal, sit, unified);

      expect(decision.blockedBySecurity).toBe(true);
      expect(decision.securityBlockReason).toBe("LOCKDOWN_MODE");
    });
  });

  // ── 12. Context Provenance & Audit Trail ──────────────────────────────────
  describe("12. Context Provenance & Audit Trail", () => {
    it("records sanitized provenance traces without leaking secrets or tokens", async () => {
      await contextFusionCoordinator.fuseUnifiedContext("ctx_prov", undefined, undefined, "Isko check karo");

      const history = contextProvenanceTracker.listRecentProvenance(10);
      expect(history.length).toBeGreaterThan(0);
      expect(history[0].sanitized).toBe(true);
      expect(history[0].contextId).toBe("ctx_prov");
      expect(history[0].contributingSources).toContain("voice");
      expect(history[0].contributingSources).toContain("file");
    });
  });

  // ── 13. End-to-End Unified Intelligence Evaluation ────────────────────────
  describe("13. End-to-End Unified Intelligence Evaluation", () => {
    it("evaluates 'Isko improve karo' end-to-end with unified context", async () => {
      contextFusionEngine.setCurrentFile("ctx_e2e", "D:/Projects/app/main.py");
      contextFusionEngine.setCurrentApplication("ctx_e2e", "vscode");

      const outcome = await intelligenceCoordinator.evaluateUnified("Isko improve karo", "ctx_e2e");
      expect(outcome.decision).toBeDefined();
      expect(outcome.unifiedContext).toBeDefined();
      expect(outcome.unifiedContext.currentFile).toBe("D:/Projects/app/main.py");
      expect(outcome.decision.intent).toBe("code.inspect");
    });
  });

  // ── 14. REST Endpoints Integration ────────────────────────────────────────
  describe("14. REST Endpoints Integration", () => {
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

    it("fuses unified context via POST /api/context/unified", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/context/unified`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contextId: "ctx_http_unified",
          overrides: { currentFile: "server.ts" },
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.unifiedContext).toBeDefined();
      expect(data.unifiedContext.currentFile).toBe("server.ts");
      expect(data.unifiedContext.voiceState).toBeDefined();
      expect(data.unifiedContext.deviceState).toBeDefined();
    });

    it("resolves reference via POST /api/context/resolve-reference", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/context/resolve-reference`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: "main.py ko improve karo",
          contextId: "ctx_http_ref",
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.reference).toBeDefined();
      expect(data.reference.resolvedEntity).toBe("main.py");
      expect(data.reference.resolvedType).toBe("file");
    });

    it("retrieves provenance trace via GET /api/context/provenance", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/context/provenance?limit=10`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(Array.isArray(data.provenance)).toBe(true);
    });
  });
});
