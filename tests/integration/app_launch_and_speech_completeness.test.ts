/**
 * MYRAA — Comprehensive Verification Test Suite
 *
 * Verifies:
 *   1. Application resolution & launching (File Manager, File Explorer, Chrome, Edge, VS Code, Notepad, Calculator, etc.)
 *   2. System path resolution & alias normalization in TaskManager and CapabilityRegistry
 *   3. Situation Understanding & Goal Resolution for desktop apps & file manager
 *   4. Response Length & Speech Completeness (Pacing, directives, preventing 4-5 word cutoffs)
 */

import { describe, it, expect } from "vitest";
import { capabilityRegistry } from "../../backend/orchestrator/CapabilityRegistry.ts";
import { intentResolver } from "../../backend/orchestrator/IntentResolver.ts";
import { situationUnderstandingEngine } from "../../backend/intelligence/SituationUnderstandingEngine.ts";
import { goalResolver } from "../../backend/intelligence/GoalResolver.ts";
import { contextFusionEngine } from "../../backend/intelligence/ContextFusionEngine.ts";
import { humanConversationEngine } from "../../backend/voice/HumanConversationEngine.ts";

describe("Application Launching & Path Resolution Suite", () => {
  it("resolves 'file manager' to canonical 'explorer' in CapabilityRegistry", () => {
    const res = capabilityRegistry.resolveApplicationAlias("file manager");
    expect(res.resolved).toBe(true);
    expect(res.canonicalApp).toBe("explorer");
  });

  it("resolves loose file manager variants: 'filemanager', 'file explorer', 'files', 'windows explorer'", () => {
    const variants = ["filemanager", "file explorer", "files", "windows explorer", "explorer", "this pc", "my computer"];
    for (const v of variants) {
      const res = capabilityRegistry.resolveApplicationAlias(v);
      expect(res.resolved).toBe(true);
      expect(res.canonicalApp).toBe("explorer");
    }
  });

  it("resolves major desktop productivity apps accurately", () => {
    const appMap: Record<string, string> = {
      "vs code": "vscode",
      "visual studio code": "vscode",
      "code": "vscode",
      "google chrome": "chrome",
      "browser": "chrome",
      "microsoft edge": "edge",
      "ms edge": "edge",
      "notepad": "notepad",
      "calculator": "calculator",
      "calc": "calculator",
      "task manager": "task manager",
      "taskmgr": "task manager",
      "cmd": "cmd",
      "command prompt": "cmd",
      "powershell": "powershell",
      "terminal": "terminal",
      "windows terminal": "terminal",
      "paint": "paint",
      "settings": "settings",
    };

    for (const [raw, expectedCanonical] of Object.entries(appMap)) {
      const res = capabilityRegistry.resolveApplicationAlias(raw);
      expect(res.resolved).toBe(true);
      expect(res.canonicalApp).toBe(expectedCanonical);
    }
  });

  it("IntentResolver properly resolves openApplication with 'file manager'", () => {
    const intent = intentResolver.resolveFromToolCall(
      "openApplication",
      { name: "file manager" },
      "test-context",
    );
    expect(intent.intent).toBe("OPEN_APPLICATION");
    expect(intent.entity).toBe("explorer");
    expect(intent.arguments.aliasResolved).toBe(true);
  });

  it("SituationUnderstandingEngine extracts 'explorer' for 'file manager' mentions", () => {
    const fused = contextFusionEngine.fuseContext({
      currentDevice: "DESKTOP",
      currentApplication: null,
      currentWebsite: null,
      currentFile: null,
      currentProject: null,
    });

    const sit = situationUnderstandingEngine.analyzeSituation("Bhai file manager open karo", fused);
    expect(sit.domain).toBe("desktop");
    expect(sit.activeEntities.apps).toContain("explorer");
  });

  it("GoalResolver generates high-confidence goal for opening File Manager", () => {
    const fused = contextFusionEngine.fuseContext({
      currentDevice: "DESKTOP",
      currentApplication: null,
      currentWebsite: null,
      currentFile: null,
      currentProject: null,
    });
    const sit = situationUnderstandingEngine.analyzeSituation("file manager kholo", fused);
    const goal = goalResolver.resolveGoal("file manager kholo", sit, fused);

    expect(goal.targetEntity).toBe("explorer");
    expect(goal.primaryGoal).toBe("Open Windows File Explorer");
    expect(goal.confidence).toBeGreaterThanOrEqual(0.95);
  });
});

describe("Response Length & Anti-Truncation Suite", () => {
  it("never classifies substantive questions as 'short' pacing even if brief", () => {
    const questions = [
      "AI kya hai?",
      "Docker kya hota hai?",
      "Why is sky blue?",
      "What is gravity?",
      "Explain React state",
      "Kaise kaam karta hai ye?",
      "Iska meaning batao",
    ];

    for (const q of questions) {
      const pacing = humanConversationEngine.selectPacing(q);
      expect(pacing).not.toBe("short");
      expect(["medium", "detailed"]).toContain(pacing);
    }
  });

  it("only assigns 'short' to pure greetings and simple pings", () => {
    const greetings = ["hi", "hello", "namaste", "ping", "status", "ok", "done", "theek hai"];
    for (const g of greetings) {
      const pacing = humanConversationEngine.selectPacing(g);
      expect(pacing).toBe("short");
    }
  });

  it("ensures decidePacing directives prevent premature cutoffs", () => {
    const decisionShort = humanConversationEngine.decidePacing("hi", "english");
    expect(decisionShort.instructionDirective).toContain("Do not cut short");

    const decisionMedium = humanConversationEngine.decidePacing("Tell me about Docker containers", "english");
    expect(decisionMedium.instructionDirective).toContain("Never cut short after only 4-5 words");

    const decisionDetailed = humanConversationEngine.decidePacing("Explain step by step how to build this full architecture", "english");
    expect(decisionDetailed.instructionDirective).toContain("complete response");
  });

  it("permits file modification tools when DesktopSecurityGate is UNLOCKED by operator ('Mummy Ka Beta')", async () => {
    const { desktopSecurityGate } = await import("../../backend/security/DesktopSecurityGate.ts");
    const { securityPolicyEngine } = await import("../../backend/security/SecurityPolicyEngine.ts");

    // Unlock gate with secret code
    const unlockRes = desktopSecurityGate.verifyPasscode("Mummy Ka Beta");
    expect(unlockRes.success).toBe(true);
    expect(desktopSecurityGate.isUnlocked()).toBe(true);

    const secContext = {
      identityId: "local_operator",
      role: "admin" as const,
      ipAddress: "127.0.0.1",
      sessionId: "local-test-session",
      isLocal: true,
    };

    // Evaluate modifying tools: modifyFile, createFile, writeCodeFile
    const modifyDecision = await securityPolicyEngine.evaluateRequest(
      "modifyFile",
      { path: "D:\\Daily New Coding Game\\game.py", content: "# Advanced game logic" },
      secContext
    );
    expect(modifyDecision.allowed).toBe(true);

    const writeDecision = await securityPolicyEngine.evaluateRequest(
      "writeCodeFile",
      { path: "D:\\Daily New Coding Game\\advanced_level.py", content: "print('Level 2')" },
      secContext
    );
    expect(writeDecision.allowed).toBe(true);
  });
});
