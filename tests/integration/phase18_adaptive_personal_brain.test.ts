/**
 * Phase 18 — MYRAA Adaptive Personal Brain Test Suite
 *
 * Verifies the Personal Cognitive Learning Layer without retraining the base Gemini model:
 *   1. Preference Learning (Coding, Communication, Workflow, UI)
 *   2. Correction Learning ("Mujhe ye format pasand nahi hai", negative feedback)
 *   3. Communication Style Learning (Verbosity, Tone, Language)
 *   4. Frequently Used Command Patterns (Frequency tracking, recurrence detection)
 *   5. Project & Coding Preferences (Indentation, Editors)
 *   6. UI & Workflow Preferences (Themes, Layouts)
 *   7. Memory Confidence & Importance (Scoring, Low-confidence filtering)
 *   8. Memory Expiration (TTL detection, automatic expiration, exclusion)
 *   9. Duplicate Memory Detection (Reinforcement, counter bumps, no bloat)
 *  10. Contradiction Detection & Deterministic Resolution (Recency, confidence, audit trail)
 *  11. Absolute Precedence Invariant (Explicit current instruction ALWAYS overrides learned memory)
 *  12. Anti-Hallucination Invariant (Never silently invent memories on ordinary chat)
 *  13. ContextManager Prompt Synthesis Integration
 *  14. REST Endpoints Integration (/api/brain/*)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import http from "http";
import {
  CognitiveLearningCoordinator,
  CognitiveMemoryStore,
  LearningSignalDetector,
  PreferenceExtractor,
  DeduplicationEngine,
  ContradictionResolver,
  AdaptivePromptSynthesizer,
  type CognitiveMemory,
} from "../../backend/brain/index.ts";
import { buildCompleteSystemInstructions } from "../../backend/projects/ContextManager.ts";
import { userPreferenceResolver } from "../../backend/intelligence/UserPreferenceResolver.ts";
import { createHttpApp } from "../../backend/gateway/HttpGateway.ts";

describe("Phase 18 — MYRAA Adaptive Personal Brain", () => {
  let tempDir: string;
  let memFile: string;
  let patFile: string;
  let store: CognitiveMemoryStore;
  let detector: LearningSignalDetector;
  let extractor: PreferenceExtractor;
  let dedup: DeduplicationEngine;
  let resolver: ContradictionResolver;
  let synthesizer: AdaptivePromptSynthesizer;
  let coordinator: CognitiveLearningCoordinator;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "myraa-brain-test-"));
    memFile = path.join(tempDir, "cognitive_memories.json");
    patFile = path.join(tempDir, "command_patterns.json");

    store = new CognitiveMemoryStore(memFile, patFile);
    detector = new LearningSignalDetector();
    extractor = new PreferenceExtractor();
    dedup = new DeduplicationEngine();
    resolver = new ContradictionResolver();
    synthesizer = new AdaptivePromptSynthesizer(store);
    coordinator = new CognitiveLearningCoordinator(
      store,
      detector,
      extractor,
      dedup,
      resolver,
      synthesizer
    );
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  // ── 1. Correction Learning ────────────────────────────────────────────────
  describe("1. Correction Learning", () => {
    it("detects Hindi/Hinglish format correction: 'Mujhe ye format pasand nahi hai'", async () => {
      const res = await coordinator.processUserInput("Mujhe ye format pasand nahi hai");
      expect(res.signal).not.toBeNull();
      expect(res.signal?.type).toBe("correction");
      expect(res.action).toBe("created");
      expect(res.memory).not.toBeNull();
      expect(res.memory?.key).toBe("comm.format");
      expect(res.memory?.confidence).toBeGreaterThanOrEqual(0.9);
      expect(res.memory?.importance).toBeGreaterThanOrEqual(4);
    });

    it("detects explicit negative feedback: 'Aise mat karo, ye galat hai'", async () => {
      const res = await coordinator.processUserInput("Aise mat karo, ye galat hai");
      expect(res.signal).not.toBeNull();
      expect(res.signal?.type).toBe("correction");
      expect(res.memory?.category).toBe("correction");
      expect(res.memory?.sourceSignal).toBe("explicit_correction");
    });

    it("detects English correction: 'I don't like this format, use bullet points'", async () => {
      const res = await coordinator.processUserInput("I don't like this format, use bullet points");
      expect(res.signal).not.toBeNull();
      expect(res.signal?.value).toBe("bullet_points");
      expect(res.memory?.value).toBe("bullet_points");
      expect(res.memory?.confidence).toBe(0.95);
    });
  });

  // ── 2. Preference Learning (Coding & Workflow) ────────────────────────────
  describe("2. Coding & Workflow Preference Learning", () => {
    it("learns explicit tabs indentation: 'Always use tabs'", async () => {
      const res = await coordinator.processUserInput("Always use tabs");
      expect(res.signal?.key).toBe("coding.indentation");
      expect(res.signal?.value).toBe("tabs");
      expect(res.memory?.value).toBe("tabs");
      expect(res.memory?.importance).toBe(5);
    });

    it("learns 2 spaces indentation: '2 spaces use karo'", async () => {
      const res = await coordinator.processUserInput("2 spaces use karo");
      expect(res.signal?.key).toBe("coding.indentation");
      expect(res.signal?.value).toBe("2_spaces");
      expect(res.memory?.value).toBe("2_spaces");
    });

    it("learns 4 spaces indentation: 'Indent with 4 spaces'", async () => {
      const res = await coordinator.processUserInput("Indent with 4 spaces");
      expect(res.signal?.key).toBe("coding.indentation");
      expect(res.signal?.value).toBe("4_spaces");
      expect(res.memory?.value).toBe("4_spaces");
    });

    it("learns preferred editor: 'Always use VS Code'", async () => {
      const res = await coordinator.processUserInput("Always use VS Code");
      expect(res.signal?.key).toBe("workflow.preferred_editor");
      expect(res.signal?.value).toBe("vscode");
      expect(res.memory?.value).toBe("vscode");
    });

    it("learns Cursor editor preference: 'Cursor editor use karo'", async () => {
      const res = await coordinator.processUserInput("Cursor editor use karo");
      expect(res.signal?.key).toBe("workflow.preferred_editor");
      expect(res.signal?.value).toBe("cursor");
      expect(res.memory?.value).toBe("cursor");
    });
  });

  // ── 3. Communication Style Learning ───────────────────────────────────────
  describe("3. Communication Style Learning", () => {
    it("learns concise verbosity: 'Short me bolo, lamba mat bolo'", async () => {
      const res = await coordinator.processUserInput("Short me bolo, lamba mat bolo");
      expect(res.signal?.key).toBe("comm.verbosity");
      expect(res.signal?.value).toBe("concise");
      expect(res.memory?.value).toBe("concise");
    });

    it("learns detailed verbosity: 'Detail me samjhao acche se'", async () => {
      const res = await coordinator.processUserInput("Detail me samjhao acche se");
      expect(res.signal?.key).toBe("comm.verbosity");
      expect(res.signal?.value).toBe("detailed");
      expect(res.memory?.value).toBe("detailed");
    });

    it("learns casual friendly tone: 'Bhai jaise bolo, jyada formal mat bano'", async () => {
      const res = await coordinator.processUserInput("Bhai jaise bolo, jyada formal mat bano");
      expect(res.signal?.key).toBe("comm.tone");
      expect(res.signal?.value).toBe("casual_friendly");
    });

    it("learns professional tone: 'Professional raho'", async () => {
      const res = await coordinator.processUserInput("Professional raho");
      expect(res.signal?.key).toBe("comm.tone");
      expect(res.signal?.value).toBe("professional");
    });

    it("learns language preference: 'Hindi me hi baat karo'", async () => {
      const res = await coordinator.processUserInput("Hindi me hi baat karo");
      expect(res.signal?.key).toBe("comm.language");
      expect(res.signal?.value).toBe("hindi");
    });

    it("learns English preference: 'Speak in English only'", async () => {
      const res = await coordinator.processUserInput("Speak in English only");
      expect(res.signal?.key).toBe("comm.language");
      expect(res.signal?.value).toBe("english");
    });
  });

  // ── 4. UI & Theme Preferences ─────────────────────────────────────────────
  describe("4. UI & Theme Preferences", () => {
    it("learns dark mode: 'Dark mode pasand hai'", async () => {
      const res = await coordinator.processUserInput("Dark mode pasand hai");
      expect(res.signal?.key).toBe("ui.theme");
      expect(res.signal?.value).toBe("dark");
      expect(res.memory?.value).toBe("dark");
    });

    it("learns light mode: 'Light mode pasand hai'", async () => {
      const res = await coordinator.processUserInput("Light mode pasand hai");
      expect(res.signal?.key).toBe("ui.theme");
      expect(res.signal?.value).toBe("light");
      expect(res.memory?.value).toBe("light");
    });
  });

  // ── 5. Frequently Used Command Patterns ───────────────────────────────────
  describe("5. Frequently Used Command Patterns", () => {
    it("records command executions and tracks frequency", async () => {
      await coordinator.recordCommand("openApplication", "vscode");
      await coordinator.recordCommand("openApplication", "vscode");
      const rec = await coordinator.recordCommand("openApplication", "vscode");

      expect(rec.frequency).toBe(3);
      expect(rec.toolName).toBe("openApplication");
      expect(rec.target).toBe("vscode");

      const frequent = await coordinator.getFrequentCommands(3);
      expect(frequent.length).toBe(1);
      expect(frequent[0].patternKey).toBe("openApplication:vscode");
      expect(frequent[0].frequency).toBe(3);
    });

    it("differentiates different targets for the same tool", async () => {
      await coordinator.recordCommand("openApplication", "notepad");
      await coordinator.recordCommand("openApplication", "chrome");

      const patterns = await store.loadPatterns();
      expect(patterns.length).toBe(2);
      expect(patterns.some((p) => p.target === "notepad")).toBe(true);
      expect(patterns.some((p) => p.target === "chrome")).toBe(true);
    });
  });

  // ── 6. Memory Confidence & Importance ─────────────────────────────────────
  describe("6. Memory Confidence & Importance", () => {
    it("assigns high confidence and importance to explicit corrections", async () => {
      const res = await coordinator.processUserInput("Aise mat karo, hamesha 2 spaces use karo");
      expect(res.memory?.confidence).toBeGreaterThanOrEqual(0.9);
      expect(res.memory?.importance).toBe(5);
    });

    it("does NOT treat low-confidence (<0.5) memories as facts", async () => {
      const lowConfMemory: CognitiveMemory = {
        id: "cog_test_low",
        category: "preference",
        key: "test.speculative",
        value: "unverified",
        text: "Unverified guess",
        confidence: 0.3, // Low confidence!
        importance: 1,
        sourceSignal: "user_feedback",
        status: "active",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        usageCount: 1,
        reinforcementCount: 1,
      };
      await store.saveMemory(lowConfMemory);

      // Low confidence memory must be excluded from high-confidence prompt synthesis
      const prompt = await synthesizer.synthesizePrompt(800, 0.6);
      expect(prompt).not.toContain("Unverified guess");

      // Runtime resolution must NOT apply low-confidence as fact
      const resolved = await coordinator.resolveEffectivePreference("test.speculative", "default_val");
      expect(resolved.source).toBe("default");
      expect(resolved.value).toBe("default_val");
    });
  });

  // ── 7. Memory Expiration (TTL) ────────────────────────────────────────────
  describe("7. Memory Expiration (TTL)", () => {
    it("detects temporary qualifiers: 'Sirf aaj ke liye dark mode karo'", async () => {
      const res = await coordinator.processUserInput("Sirf aaj ke liye dark mode karo");
      expect(res.signal?.isTemporary).toBe(true);
      expect(res.signal?.ttlMs).toBe(24 * 60 * 60 * 1000);
      expect(res.memory?.expiresAt).toBeDefined();

      const expDate = new Date(res.memory!.expiresAt!);
      expect(expDate.getTime()).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000);
    });

    it("detects short-term qualifier: 'Abhi ke liye short me bolo'", async () => {
      const res = await coordinator.processUserInput("Abhi ke liye short me bolo");
      expect(res.signal?.isTemporary).toBe(true);
      expect(res.signal?.ttlMs).toBe(2 * 60 * 60 * 1000);
    });

    it("automatically marks expired memories as expired and excludes them from active queries", async () => {
      const pastTime = new Date(Date.now() - 10000).toISOString(); // Expired 10s ago
      const expiredMem: CognitiveMemory = {
        id: "cog_expired_test",
        category: "communication_style",
        key: "comm.verbosity",
        value: "concise",
        text: "Temporary concise preference",
        confidence: 0.9,
        importance: 2,
        sourceSignal: "explicit_statement",
        status: "active",
        createdAt: new Date(Date.now() - 20000).toISOString(),
        updatedAt: new Date(Date.now() - 20000).toISOString(),
        expiresAt: pastTime,
        usageCount: 1,
        reinforcementCount: 1,
      };
      await store.saveMemory(expiredMem);

      // On load/query, it must be expired
      const active = await store.getActiveMemories();
      expect(active.some((m) => m.id === "cog_expired_test")).toBe(false);

      const reloaded = await store.getMemory("cog_expired_test");
      expect(reloaded?.status).toBe("expired");

      // Excluded from runtime preference resolution
      const resolved = await coordinator.resolveEffectivePreference("comm.verbosity", "default_verb");
      expect(resolved.source).toBe("default");
      expect(resolved.value).toBe("default_verb");
    });
  });

  // ── 8. Duplicate Memory Detection & Reinforcement ─────────────────────────
  describe("8. Duplicate Memory Detection & Reinforcement", () => {
    it("reinforces existing memory on duplicate signal without creating a new record", async () => {
      // First turn
      const turn1 = await coordinator.processUserInput("Always use tabs");
      expect(turn1.action).toBe("created");
      const id1 = turn1.memory!.id;

      // Second turn with identical preference
      const turn2 = await coordinator.processUserInput("Always use tabs");
      expect(turn2.action).toBe("reinforced");
      expect(turn2.memory?.id).toBe(id1); // Reuses the same memory ID!
      expect(turn2.memory?.reinforcementCount).toBe(2);
      expect(turn2.memory?.usageCount).toBe(2);

      const all = await store.loadMemories();
      expect(all.length).toBe(1); // No duplicate bloat!
    });
  });

  // ── 9. Contradiction Detection & Deterministic Resolution ─────────────────
  describe("9. Contradiction Detection & Resolution", () => {
    it("newer explicit preference deterministically supersedes older conflicting preference", async () => {
      // Turn 1: User says use 4 spaces
      const turn1 = await coordinator.processUserInput("Indent with 4 spaces");
      expect(turn1.action).toBe("created");
      expect(turn1.memory?.value).toBe("4_spaces");
      const id1 = turn1.memory!.id;

      // Small delay so timestamp is newer
      await new Promise((r) => setTimeout(r, 20));

      // Turn 2: User says 2 spaces use karo (direct contradiction!)
      const turn2 = await coordinator.processUserInput("2 spaces use karo");
      expect(turn2.action).toBe("superseded");
      expect(turn2.memory?.value).toBe("2_spaces");
      const id2 = turn2.memory!.id;

      // Check old memory status
      const oldMem = await store.getMemory(id1);
      expect(oldMem?.status).toBe("superseded");
      expect(oldMem?.supersededBy).toBe(id2);
      expect(oldMem?.contradictionHistory?.length).toBeGreaterThan(0);

      // Check new memory is active
      const newMem = await store.getMemory(id2);
      expect(newMem?.status).toBe("active");

      // Effective preference returns the winner
      const resolved = await coordinator.resolveEffectivePreference("coding.indentation", "default_indent");
      expect(resolved.value).toBe("2_spaces");
      expect(resolved.source).toBe("learned_preference");
    });
  });

  // ── 10. Absolute Precedence Invariant ──────────────────────────────────────
  describe("10. Absolute Precedence Invariant", () => {
    it("explicit instruction in the current turn ALWAYS overrides learned preference", async () => {
      // User previously learned preference for VS Code
      await coordinator.processUserInput("Always use VS Code");

      // Current turn: User explicitly instructs to open in Cursor
      const resolved = await coordinator.resolveEffectivePreference(
        "workflow.preferred_editor",
        "vscode",
        "Aaj Cursor kholo"
      );

      expect(resolved.isExplicitOverride).toBe(true);
      expect(resolved.source).toBe("explicit_override");
      expect(resolved.value).toBe("cursor"); // Explicit override won!
    });

    it("UserPreferenceResolver respects explicit instruction over learned editor", () => {
      // Sync learned preference into profile
      userPreferenceResolver.syncCognitivePreferences([
        { key: "workflow.preferred_editor", value: "vscode", status: "active" },
      ]);

      const result = userPreferenceResolver.resolveEffectiveTarget("Cursor kholo", "preferredEditor");
      expect(result.isExplicitOverride).toBe(true);
      expect(result.target).toBe("cursor");
    });
  });

  // ── 11. Anti-Hallucination Invariant ───────────────────────────────────────
  describe("11. Anti-Hallucination Invariant", () => {
    it("does NOT invent memories on ordinary conversational questions or math", async () => {
      const inputs = [
        "Aaj mausam kaisa hai?",
        "What is the capital of France?",
        "Calculate 25 * 4",
        "Can you help me with this function?",
        "Good morning!",
      ];

      for (const input of inputs) {
        const res = await coordinator.processUserInput(input);
        expect(res.signal).toBeNull();
        expect(res.memory).toBeNull();
        expect(res.action).toBe("ignored");
      }

      const all = await store.loadMemories();
      expect(all.length).toBe(0);
    });
  });

  // ── 12. Context Prompt Synthesis ──────────────────────────────────────────
  describe("12. Context Prompt Synthesis", () => {
    it("synthesizes concise, structured prompt directives with precedence notice", async () => {
      await coordinator.processUserInput("Always use tabs");
      await coordinator.processUserInput("Short me bolo");
      await coordinator.processUserInput("Dark mode pasand hai");

      const prompt = await synthesizer.synthesizePrompt();
      expect(prompt).toContain("[LEARNED USER ADAPTATIONS & COGNITIVE PREFERENCES (PHASE 18)]");
      expect(prompt).toContain("CRITICAL PRECEDENCE INVARIANT");
      expect(prompt).toContain("Indent with tabs");
      expect(prompt).toContain("Prefer concise responses");
      expect(prompt).toContain("Use dark theme");
    });

    it("integrates into ContextManager.buildCompleteSystemInstructions", async () => {
      const instructions = await buildCompleteSystemInstructions([]);
      expect(instructions).toBeDefined();
      expect(typeof instructions).toBe("string");
      // Must contain core base instructions
      expect(instructions).toContain("You are Myraa");
    });
  });

  // ── 13. REST Endpoints Integration ────────────────────────────────────────
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

    it("processes learning input via POST /api/brain/learn", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/brain/learn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ utterance: "Always use tabs" }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.result).toBeDefined();
    });

    it("rejects invalid input on POST /api/brain/learn with 400", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/brain/learn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBeDefined();
    });

    it("lists preferences via GET /api/brain/preferences", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/brain/preferences`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(Array.isArray(data.preferences)).toBe(true);
    });

    it("synthesizes prompt via GET /api/brain/prompt", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/brain/prompt`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(typeof data.prompt).toBe("string");
    });

    it("retrieves command patterns via GET /api/brain/patterns", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/brain/patterns`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(Array.isArray(data.patterns)).toBe(true);
    });

    it("processes user feedback via POST /api/brain/feedback", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/brain/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Mujhe ye format pasand nahi hai" }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.feedbackReceived).toBe(true);
    });

    it("handles preference deletion via DELETE /api/brain/preferences/:id", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/brain/preferences/non_existent_id`, {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.deleted).toBe(false);
    });
  });
});
