/**
 * Phase 20 — MYRAA Advanced Natural Conversation Engine Test Suite
 *
 * Comprehensive verification of context-aware natural voice companion behavior:
 *   1. Multi-turn conversation state & continuity
 *   2. Pronoun & deictic resolution ("ye", "woh", "isko", "usko", "isme", "usme", "yahi", "wahi", "ye wala", "woh wala")
 *   3. Follow-up commands & intent continuity
 *   4. Project continuity ("authentication project" -> "haan wahi wala" -> "iska backend check karo")
 *   5. File continuity ("main.py kholo" -> "isko optimize karo" -> "ab isme test karo")
 *   6. Application continuity ("VS Code kholo" -> "ab isko close karo")
 *   7. Task continuity
 *   8. Hindi, English & Hinglish code-switching
 *   9. Natural confirmation handling ("haan", "kar do", "theek hai", "bilkul")
 *  10. Confirmation expiration & ghost-action prevention ("haan kar do" with no pending confirmation)
 *  11. Correction handling ("nahi ye wala nahi, doosra wala")
 *  12. Interruption / barge-in handling & audio playback cancellation
 *  13. Conversation state expiration & stale-context protection
 *  14. Ambiguity detection & clarification gates (NEVER GUESS)
 *  15. Security policy enforcement (Emergency Stop, Security Lockdown)
 *  16. REST Endpoints Integration (/api/conversation/*)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "http";
import {
  conversationStateManager,
  conversationTurnTracker,
  conversationEntityTracker,
  followUpIntentResolver,
  conversationalReferenceResolver,
  confirmationContextManager,
  bargeInController,
  conversationContextCoordinator,
  naturalConversationEngine,
} from "../conversation/index.ts";
import { emergencyStopCoordinator } from "../remote/EmergencyStopCoordinator.ts";
import { securityPolicyEngine } from "../security/SecurityPolicyEngine.ts";
import { createHttpApp } from "../gateway/HttpGateway.ts";

describe("Phase 20 — Advanced Natural Conversation Engine", () => {
  beforeEach(() => {
    emergencyStopCoordinator.reset("phase20_test_setup");
    securityPolicyEngine.resetForTesting();
    conversationStateManager.clearAll();
    conversationTurnTracker.clearAll();
    conversationEntityTracker.clearAll();
  });

  afterEach(() => {
    emergencyStopCoordinator.reset("phase20_test_teardown");
    conversationStateManager.clearAll();
    conversationTurnTracker.clearAll();
    conversationEntityTracker.clearAll();
  });

  // ── 1. Multi-Turn Conversation State & Continuity ─────────────────────────
  describe("1. Multi-Turn Conversation State & Continuity", () => {
    it("maintains structured state and advances active entities across turns", async () => {
      const resp1 = await naturalConversationEngine.converse("main.py kholo", "ctx_multiturn");
      expect(resp1).toBeDefined();
      expect(resp1.conversationState.activeFile).toBe("main.py");
      expect(resp1.conversationState.currentIntent).toBe("desktop.openFile");

      const resp2 = await naturalConversationEngine.converse("isko optimize karo", "ctx_multiturn");
      expect(resp2).toBeDefined();
      expect(resp2.conversationState.activeFile).toBe("main.py");
      expect(resp2.decision.intent).toBe("code.inspect");
      expect(resp2.responseSpeech).toContain("code.inspect");

      const turns = conversationTurnTracker.getTurns("ctx_multiturn");
      expect(turns.length).toBe(4); // 2 user turns + 2 model turns
    });
  });

  // ── 2. Pronoun & Deictic Resolution ───────────────────────────────────────
  describe("2. Pronoun & Deictic Resolution", () => {
    it("resolves 'isko', 'isme', 'ye wala', and 'wahi wala' to active file", () => {
      const state = conversationStateManager.setActiveEntity("ctx_deictic", "auth.ts", "file");

      const ref1 = conversationalReferenceResolver.resolveReference("isko inspect karo", state);
      expect(ref1.resolvedEntity).toBe("auth.ts");
      expect(ref1.resolvedType).toBe("file");
      expect(ref1.sourceTier).toBe("ACTIVE_CONVERSATION_ENTITY");

      const ref2 = conversationalReferenceResolver.resolveReference("isme bug hai", state);
      expect(ref2.resolvedEntity).toBe("auth.ts");
      expect(ref2.resolvedType).toBe("file");

      const ref3 = conversationalReferenceResolver.resolveReference("ye wala check karo", state);
      expect(ref3.resolvedEntity).toBe("auth.ts");
      expect(ref3.resolvedType).toBe("file");

      const ref4 = conversationalReferenceResolver.resolveReference("haan wahi wala", state);
      expect(ref4.resolvedEntity).toBe("auth.ts");
      expect(ref4.resolvedType).toBe("file");
    });
  });

  // ── 3. Project Continuity & Fuzzy Query Matching ──────────────────────────
  describe("3. Project Continuity", () => {
    it("resolves fuzzy project description and chains 'haan wahi wala' and 'iska backend'", async () => {
      // 1. Candidate project matching
      const candidateProjects = [
        { name: "auth-service", description: "User authentication, JWT, and oauth fix", tags: ["auth", "security"] },
        { name: "payment-gateway", description: "Stripe and PayPal integration", tags: ["billing"] },
        { name: "dashboard-ui", description: "React analytics frontend", tags: ["ui"] },
      ];

      const matches = conversationEntityTracker.matchProjectCandidates(
        "Bhai woh project kholo na jisme kal hum authentication fix kar rahe the",
        candidateProjects
      );

      expect(matches.length).toBeGreaterThan(0);
      expect(matches[0].candidate.name).toBe("auth-service");
      expect(matches[0].score).toBeGreaterThanOrEqual(0.6);

      // Register selected project in state
      conversationStateManager.setActiveEntity("ctx_project", "auth-service", "project");

      // 2. Turn 2: User says "Haan wahi wala"
      const resp2 = await naturalConversationEngine.converse("Haan wahi wala", "ctx_project");
      expect(resp2.conversationState.activeProject).toBe("auth-service");

      // 3. Turn 3: User says "Iska backend check karo"
      const resp3 = await naturalConversationEngine.converse("Iska backend check karo", "ctx_project");
      expect(resp3.conversationState.activeProject).toBe("auth-service");
      expect(resp3.decision.intent).toBe("code.inspect");
    });
  });

  // ── 4. File & App Continuity ──────────────────────────────────────────────
  describe("4. File & App Continuity", () => {
    it("chains file operations without forcing repeated context", async () => {
      // Turn 1: open file
      await naturalConversationEngine.converse("utils.py open karo", "ctx_file_chain");

      // Turn 2: optimize
      const resp2 = await naturalConversationEngine.converse("isko thoda optimize karo", "ctx_file_chain");
      expect(resp2.conversationState.activeFile).toBe("utils.py");

      // Turn 3: test
      const resp3 = await naturalConversationEngine.converse("ab ispe test run karo", "ctx_file_chain");
      expect(resp3.conversationState.activeFile).toBe("utils.py");
    });

    it("chains app launch and subsequent close", async () => {
      // Turn 1: open vscode
      await naturalConversationEngine.converse("VS Code kholo", "ctx_app_chain");

      // Turn 2: close it
      const resp2 = await naturalConversationEngine.converse("ab isko close kar do", "ctx_app_chain");
      expect(resp2.decision.intent).toBe("desktop.closeApplication");
    });
  });

  // ── 5. Hinglish & Code-Switching ──────────────────────────────────────────
  describe("5. Hinglish & Code-Switching", () => {
    it("correctly understands natural Hinglish conversational requests", async () => {
      const inputs = [
        "bhai ye wala project kholo",
        "isko thoda optimize karo",
        "isme bug check karna",
        "achha ab isko close kar do",
      ];

      for (const input of inputs) {
        const resp = await naturalConversationEngine.converse(input, "ctx_hinglish");
        expect(resp).toBeDefined();
        expect(resp.responseSpeech.length).toBeGreaterThan(0);
        expect(resp.acknowledgement).toBeDefined();
      }
    });
  });

  // ── 6. Natural Confirmation & Invariant Enforcement ───────────────────────
  describe("6. Natural Confirmation & Invariant Enforcement", () => {
    it("confirms pending sensitive action when user says 'haan'", async () => {
      confirmationContextManager.registerPendingConfirmation("ctx_confirm", {
        confirmationId: "conf_delete_1",
        actionId: "act_rm_1",
        capability: "desktop.deleteFile",
        toolName: "deleteFile",
        targetDevice: "DESKTOP",
        targetEntity: "old_temp.log",
        args: { path: "old_temp.log" },
        summary: "delete file old_temp.log",
        risk: "HIGH",
      });

      const resp = await naturalConversationEngine.converse("haan kar do", "ctx_confirm");
      expect(resp.decision.intent).toBe("desktop.deleteFile");
      expect(resp.responseSpeech).toContain("execute kar diya hai");
      expect(conversationStateManager.getConversationState("ctx_confirm").pendingConfirmation).toBeNull();
    });

    it("cancels pending action when user says 'nahi ruk jao'", async () => {
      confirmationContextManager.registerPendingConfirmation("ctx_cancel", {
        confirmationId: "conf_mod_1",
        actionId: "act_mod_1",
        capability: "desktop.modifyFile",
        toolName: "writeFile",
        targetDevice: "DESKTOP",
        args: { path: "main.py" },
        summary: "modify file main.py",
        risk: "HIGH",
      });

      const resp = await naturalConversationEngine.converse("nahi ruk jao", "ctx_cancel");
      expect(resp.decision.intent).toBe("CANCELLED");
      expect(resp.responseSpeech).toContain("cancel kar diya hai");
      expect(conversationStateManager.getConversationState("ctx_cancel").pendingConfirmation).toBeNull();
    });

    it("INVARIANT: 'haan kar do' with NO pending confirmation MUST NOT invent an action", async () => {
      const resp = await naturalConversationEngine.converse("haan kar do", "ctx_ghost");
      expect(resp.decision.intent).toBe("NOOP");
      expect(resp.decision.reason).toContain("INVARIANT: Affirmation received with no pending confirmation");
      expect(resp.responseSpeech).toContain("koi pending action nahi hai");
    });

    it("rejects confirmation when TTL window has expired", () => {
      const now = Date.now();
      // Register with 10ms TTL
      confirmationContextManager.registerPendingConfirmation(
        "ctx_expire_conf",
        {
          confirmationId: "conf_old",
          actionId: "act_old",
          capability: "desktop.runShellCommand",
          toolName: "runShellCommand",
          targetDevice: "DESKTOP",
          args: { command: "dir" },
          summary: "run shell command",
          risk: "HIGH",
        },
        10,
        now - 1000 // issued 1000ms ago, TTL was 10ms
      );

      const result = confirmationContextManager.evaluateConfirmation("haan", "ctx_expire_conf", now);
      expect(result.isConfirmed).toBe(false);
      expect(result.isCancelled).toBe(true);
      expect(result.reason).toContain("CONFIRMATION_EXPIRED");
    });
  });

  // ── 7. Correction Handling ────────────────────────────────────────────────
  describe("7. Correction Handling", () => {
    it("detects correction signal when user rejects candidate", () => {
      const state = conversationStateManager.getConversationState("ctx_corr");
      state.activeEntity = "wrong_file.py";

      const followUp = followUpIntentResolver.resolveFollowUp("nahi ye wala nahi, doosra wala", state);
      expect(followUp.isFollowUp).toBe(true);
      expect(followUp.requiresClarification).toBe(true);
    });
  });

  // ── 8. Interruption & Barge-In Handling ────────────────────────────────────
  describe("8. Interruption & Barge-In Handling", () => {
    it("safely halts audio playback and classifies interruption when user speaks", () => {
      let stoppedBytes = 0;
      bargeInController.registerAudioStopCallback(() => {
        stoppedBytes = 24000;
        return 24000;
      });

      // Assistant is currently speaking
      bargeInController.setSpeakingState("ctx_barge", true);
      conversationTurnTracker.recordTurn("ctx_barge", "model", "Main file inspect kar rahi hoon...");

      const event = bargeInController.handleInterruption(
        "Ruko, pehle git status check karo",
        "ctx_barge",
        "Main file inspect kar rahi hoon..."
      );

      expect(event.audioStopped).toBe(true);
      expect(event.cancelledAudioBytes).toBe(24000);
      expect(event.interruptionType).toBe("interruption");
      expect(event.replanRequired).toBe(true);
      expect(bargeInController.isSpeaking("ctx_barge")).toBe(false);
    });

    it("handles barge-in transparently in naturalConversationEngine.converse", async () => {
      bargeInController.setSpeakingState("ctx_barge_engine", true);

      const resp = await naturalConversationEngine.converse("Ruko pehle test karo", "ctx_barge_engine");
      expect(resp.interruptionHandled).toBe(true);
      expect(resp.interruptionEvent).toBeDefined();
      expect(resp.interruptionEvent?.interruptionType).toBe("interruption");
    });
  });

  // ── 9. State Expiration & Stale-Context Protection ─────────────────────────
  describe("9. State Expiration & Stale-Context Protection", () => {
    it("degrades expired conversational state and never treats stale entities as facts", () => {
      const now = Date.now();
      const state = conversationStateManager.getConversationState("ctx_expire", now - 400_000);
      conversationStateManager.setActiveEntity("ctx_expire", "old_file.ts", "file", now - 400_000);

      // Now query with current time (exceeds 300,000ms TTL)
      const freshState = conversationStateManager.getConversationState("ctx_expire", now);
      expect(freshState.isStale).toBe(true);
      expect(freshState.activeFile).toBeNull();
      expect(freshState.activeEntity).toBeNull();
    });
  });

  // ── 10. Ambiguity Detection & Clarification Gates ──────────────────────────
  describe("10. Ambiguity Detection & Clarification Gates", () => {
    it("refuses to guess and asks clarification when multiple candidates exist with equal confidence", () => {
      const state = conversationStateManager.getConversationState("ctx_ambig");
      // Add two files with identical confidence
      conversationEntityTracker.registerEntity({ name: "file1.ts", entityType: "file", confidence: 0.9 }, "ctx_ambig");
      conversationEntityTracker.registerEntity({ name: "file2.ts", entityType: "file", confidence: 0.9 }, "ctx_ambig");

      const ref = conversationalReferenceResolver.resolveReference("isko check karo", state);
      expect(ref.isAmbiguous).toBe(true);
      expect(ref.resolvedEntity).toBeNull();
      expect(ref.candidateAlternatives).toContain("file1.ts");
      expect(ref.candidateAlternatives).toContain("file2.ts");
      expect(ref.clarificationPrompt).toBeDefined();
    });
  });

  // ── 11. Security Policy Enforcement ───────────────────────────────────────
  describe("11. Security Policy Enforcement", () => {
    it("halts conversation immediately when Emergency Stop is triggered", async () => {
      await emergencyStopCoordinator.trigger({ source: "desktop_ui", reason: "unit_test_stop" });

      const resp = await naturalConversationEngine.converse("main.py improve karo", "ctx_sec");
      expect(resp.decision.blockedBySecurity).toBe(true);
      expect(resp.decision.securityBlockReason).toBe("EMERGENCY_STOP");
      expect(resp.responseSpeech).toContain("security policy ki wajah se block");
    });

    it("blocks modifying actions when Security Lockdown is active", async () => {
      securityPolicyEngine.setMode("LOCKDOWN");

      const resp = await naturalConversationEngine.converse("main.py modify karo", "ctx_sec_lock");
      expect(resp.decision.blockedBySecurity).toBe(true);
      expect(resp.decision.securityBlockReason).toBe("LOCKDOWN_MODE");
    });
  });

  // ── 12. REST Endpoints Integration ────────────────────────────────────────
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

    it("processes a conversation message via POST /api/conversation/message", async () => {
      const res = await fetch(`${baseUrl}/api/conversation/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "main.py kholo", contextId: "rest_ctx" }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.outcome).toBeDefined();
      expect(data.outcome.conversationState.activeFile).toBe("main.py");
    });

    it("handles speech interruption via POST /api/conversation/interrupt", async () => {
      const res = await fetch(`${baseUrl}/api/conversation/interrupt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ utterance: "Ruko pehle check karo", contextId: "rest_ctx" }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.interruption).toBeDefined();
      expect(data.interruption.interruptionType).toBe("interruption");
    });

    it("retrieves conversation state via GET /api/conversation/state", async () => {
      const res = await fetch(`${baseUrl}/api/conversation/state?contextId=rest_ctx`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.state).toBeDefined();
    });

    it("resets conversation state via POST /api/conversation/reset", async () => {
      const res = await fetch(`${baseUrl}/api/conversation/reset`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contextId: "rest_ctx" }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
    });
  });
});
