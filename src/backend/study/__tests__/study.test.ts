/**
 * MYRAA — Phase 9: AI Study Companion (Stage 1 — Study Document) Tests
 *
 * Comprehensive test suite verifying all Stage 1 capabilities:
 *   1. Document Loading & Workspace Security (traversal, null-bytes, 25MB ceiling)
 *   2. Automatic Page Detection & Current-Page Tracking (next, prev, jump, auto-focus)
 *   3. Question Detection & Question-to-Answer Mapping (strict document vs model distinction)
 *   4. Diagram Detection & Visual Context Explanation (visual elements, categorization)
 *   5. Line-by-line & Section-by-section Tutoring (analogies, Socratic check-ins)
 *   6. Voice Teaching Mode & System Instruction Context Cards (untrusted fencing)
 *   7. Emergency Stop Integration (immediate session halt, fails closed)
 *   8. Gemini Live Tool Count & ToolOrchestrator Dispatch Layer (exactly 111 tools)
 */

import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import { studyDocumentEngine } from "../StudyDocumentEngine.ts";
import { studySessionManager } from "../StudySessionManager.ts";
import { QuestionParser } from "../QuestionParser.ts";
import { DiagramAnalyzer } from "../DiagramAnalyzer.ts";
import { TeachingEngine } from "../TeachingEngine.ts";
import { emergencyStopCoordinator } from "../../remote/EmergencyStopCoordinator.ts";
import { ToolOrchestrator } from "../../tools/ToolOrchestrator.ts";
import { LIVE_TOOLS } from "../../ai/GeminiSessionFactory.ts";
import { buildCompleteSystemInstructions } from "../../projects/ContextManager.ts";

describe("Phase 9 — AI Study Companion: Stage 1 — Study Document", () => {
  const workspaceRoot = path.resolve(process.cwd());

  beforeEach(() => {
    studyDocumentEngine.setWorkspaceRoot(workspaceRoot);
    studySessionManager.resetEmergencyStop();
    studySessionManager.closeDocument();
  });

  // ── 1. Document Loading & Workspace Security ────────────────────────────
  describe("1. Document Ingestion & Boundary Safeguards", () => {
    it("validates paths and rejects directory traversal outside workspace", () => {
      expect(() => {
        studyDocumentEngine.validatePath("../../sensitive/document.pdf");
      }).toThrow(/PATH_TRAVERSAL_BLOCKED/);
    });

    it("rejects null byte injection in file paths", () => {
      expect(() => {
        studyDocumentEngine.validatePath("documents/paper.pdf\0.exe");
      }).toThrow(/Null byte injection detected/);
    });

    it("rejects document buffers exceeding 25MB limit", async () => {
      // Create mock buffer larger than 25MB
      const oversized = Buffer.alloc(26 * 1024 * 1024);
      await expect(
        studyDocumentEngine.loadDocumentFromBuffer(oversized, "huge.pdf"),
      ).rejects.toThrow(/FILE_TOO_LARGE/);
    });

    it("rejects empty document buffers", async () => {
      await expect(
        studyDocumentEngine.loadDocumentFromBuffer(Buffer.alloc(0), "empty.txt"),
      ).rejects.toThrow(/EMPTY_DOCUMENT/);
    });

    it("marks loaded documents as untrusted external content", async () => {
      const sampleText = "# Physics Chapter 1: Kinematics\n\nStudy of motion without regard to causes.";
      const doc = await studyDocumentEngine.loadDocumentFromBuffer(
        Buffer.from(sampleText, "utf-8"),
        "kinematics.md",
      );
      expect(doc.isUntrusted).toBe(true);
      expect(doc.title).toBe("kinematics");
      expect(doc.fileType).toBe("markdown");
      expect(doc.pageCount).toBeGreaterThanOrEqual(1);
    });
  });

  // ── 2. Automatic Page Detection & Current-Page Tracking ─────────────────
  describe("2. Automatic Page Detection & Current-Page Tracking", () => {
    it("splits document with pagebreak markers into discrete pages", async () => {
      const multiPageText =
        "Page 1 Content\nNewton's First Law\n\fPage 2 Content\nNewton's Second Law\n\fPage 3 Content\nNewton's Third Law";
      const doc = await studyDocumentEngine.loadDocumentFromBuffer(
        Buffer.from(multiPageText, "utf-8"),
        "newton_laws.txt",
      );

      expect(doc.pageCount).toBe(3);
      expect(doc.pages[0].pageNumber).toBe(1);
      expect(doc.pages[1].pageNumber).toBe(2);
      expect(doc.pages[2].pageNumber).toBe(3);
    });

    it("tracks currently viewed page and clamps out-of-range navigation", async () => {
      const sample = "Page 1 Content\fPage 2 Content\fPage 3 Content";
      await studySessionManager.loadDocument(Buffer.from(sample, "utf-8"), "physics.txt");

      expect(studySessionManager.getSessionContext().currentPageNumber).toBe(1);

      // Advance to next page
      const p2 = studySessionManager.nextPage();
      expect(p2.pageNumber).toBe(2);
      expect(studySessionManager.getSessionContext().currentPageNumber).toBe(2);

      // Advance again to page 3
      const p3 = studySessionManager.nextPage();
      expect(p3.pageNumber).toBe(3);

      // Attempting to advance past total pages clamps to max page (3)
      const clampedNext = studySessionManager.nextPage();
      expect(clampedNext.pageNumber).toBe(3);

      // Backtrack
      const p2Back = studySessionManager.prevPage();
      expect(p2Back.pageNumber).toBe(2);

      // Jump to valid page
      const p1 = studySessionManager.setCurrentPage(1);
      expect(p1.pageNumber).toBe(1);

      // Jump below 1 clamps to 1
      const clampedMin = studySessionManager.setCurrentPage(-5);
      expect(clampedMin.pageNumber).toBe(1);
    });

    it("fails cleanly when tracking page without active document", () => {
      expect(() => {
        studySessionManager.setCurrentPage(2);
      }).toThrow(/NO_ACTIVE_DOCUMENT/);
    });
  });

  // ── 3. Question Detection & Question-to-Answer Mapping ──────────────────
  describe("3. Question Detection & Answer Attribution", () => {
    it("detects numbered questions, MCQ options, and marks", () => {
      const lines = [
        "Question 1: What is the SI unit of electric force? [2 marks]",
        "(A) Joule",
        "(B) Newton",
        "(C) Watt",
        "(D) Pascal",
        "Ans: (B) Newton",
        "",
        "Question 2: State the work-energy theorem.",
      ];

      const questions = QuestionParser.parsePageQuestions(lines, 1);
      expect(questions.length).toBe(2);

      // Question 1
      const q1 = questions[0];
      expect(q1.questionNumber).toBe(1);
      expect(q1.prompt).toContain("SI unit of electric force");
      expect(q1.isMultipleChoice).toBe(true);
      expect(q1.options.length).toBe(4);
      expect(q1.options[1].key).toBe("B");
      expect(q1.options[1].text).toBe("Newton");
      expect(q1.marks).toBe(2);

      // Explicit document answer mapping
      expect(q1.answerMapping?.source).toBe("document");
      expect(q1.answerMapping?.isDocumentProvided).toBe(true);
      expect(q1.answerMapping?.documentAnswerText).toBe("(B) Newton");
      expect(q1.answerMapping?.confidence).toBe(1.0);

      // Question 2 (unanswered in doc)
      const q2 = questions[1];
      expect(q2.questionNumber).toBe(2);
      expect(q2.isMultipleChoice).toBe(false);
      expect(q2.answerMapping?.source).toBe("unanswered");
      expect(q2.answerMapping?.isDocumentProvided).toBe(false);
    });

    it("strictly tags model-generated solutions as inferred (never claims document source)", () => {
      const qLines = ["Problem 1: Calculate kinetic energy of a 2kg mass moving at 3m/s."];
      const questions = QuestionParser.parsePageQuestions(qLines, 1);
      const q = questions[0];

      expect(q.answerMapping?.isDocumentProvided).toBe(false);

      // Apply model tutoring
      const mapped = QuestionParser.applyModelExplanation(
        q,
        "Using KE = 0.5 * m * v^2 = 0.5 * 2 * 9 = 9 Joules.",
      );

      expect(mapped.source).toBe("model_inferred");
      expect(mapped.isDocumentProvided).toBe(false);
      expect(mapped.inferredAnswer).toContain("9 Joules");
      expect(mapped.explanationNote).toContain("no explicit answer key in document");
    });
  });

  // ── 4. Diagram Detection & Visual Context Explanation ───────────────────
  describe("4. Diagram Detection & Visual Explanation", () => {
    it("detects figures, captions, and categorizes diagram types", async () => {
      const lines = [
        "Below is the experimental circuit setup:",
        "Figure 2.1: Schematic diagram of Wheatstone Bridge circuit with resistor R1, R2, R3, and galvanometer.",
        "The bridge is balanced when no current flows through the galvanometer.",
      ];

      const diagrams = DiagramAnalyzer.parsePageDiagrams(lines, 2);
      expect(diagrams.length).toBe(1);

      const d = diagrams[0];
      expect(d.figureLabel).toBe("Figure 2.1");
      expect(d.category).toBe("schematic");
      expect(d.visualComponents).toContain("circuit");

      // Visual explanation
      const explanation = await DiagramAnalyzer.explainDiagram(d);
      expect(explanation.figureLabel).toBe("Figure 2.1");
      expect(explanation.category).toBe("schematic");
      expect(explanation.educationalTakeaway).toContain("schematic");
      expect(explanation.pedagogicalTip).toBeDefined();
    });

    it("detects ASCII flowcharts and process diagrams", () => {
      const lines = [
        "Algorithm Execution Flow:",
        "[Start] --> [Input Array] --> [Sort Elements] --> [Return Result]",
      ];

      const diagrams = DiagramAnalyzer.parsePageDiagrams(lines, 1);
      expect(diagrams.length).toBe(1);
      expect(diagrams[0].category).toBe("flowchart");
    });
  });

  // ── 5. Line-by-Line & Section-by-Section Tutoring ───────────────────────
  describe("5. Line-by-Line & Section Tutoring", async () => {
    it("provides granular line explanation with key terms and comprehension checks", async () => {
      const pageText =
        "Line 1: Momentum is defined as the product of mass and velocity of an object.\n" +
        "Line 2: It is a vector quantity having both magnitude and direction.\n" +
        "Line 3: The SI unit of momentum is kg m/s.";

      const doc = await studySessionManager.loadDocument(
        Buffer.from(pageText, "utf-8"),
        "momentum.txt",
      );
      const page = studySessionManager.getCurrentPage()!;

      const line1 = TeachingEngine.explainLine(page, 1, doc.id);
      expect(line1.lineNumber).toBe(1);
      expect(line1.targetLine).toContain("Momentum is defined as");
      expect(line1.explanation).toContain("establishing the premise");
      expect(line1.keyTerms.length).toBeGreaterThan(0);
      expect(line1.comprehensionCheck).toBeDefined();
      expect(line1.hasMoreLines).toBe(true);
      expect(line1.nextLineNumber).toBe(2);
    });

    it("provides section explanation with real-world analogies", async () => {
      const sectionText =
        "# Newton's Second Law of Motion\n" +
        "The acceleration of an object as produced by a net force is directly proportional to the magnitude of the net force.\n" +
        "In the same direction as the net force, and inversely proportional to the mass of the object: F = ma.";

      const doc = await studySessionManager.loadDocument(
        Buffer.from(sectionText, "utf-8"),
        "laws.md",
      );
      const page = studySessionManager.getCurrentPage()!;

      const sectionExp = TeachingEngine.explainSection(page, 0, doc.id);
      expect(sectionExp.sectionTitle).toBe("Newton's Second Law of Motion");
      expect(sectionExp.stepByStepPoints.length).toBeGreaterThan(0);
      expect(sectionExp.realWorldAnalogy).toContain("shopping cart");
      expect(sectionExp.keyFormulaOrRule).toContain("F = ma");
      expect(sectionExp.comprehensionCheck).toContain("Sandeep");
    });

    it("explains question with pedagogical clarity and distinction", () => {
      const qLines = [
        "Question 1: What is the unit of resistance?",
        "(A) Ampere (B) Ohm (C) Volt (D) Coulomb",
        "Ans: (B) Ohm",
      ];
      const q = QuestionParser.parsePageQuestions(qLines, 1)[0];
      const explanation = TeachingEngine.explainQuestion(q);

      expect(explanation.pedagogicalExplanation).toContain("[DOCUMENT ANSWER:");
      expect(explanation.pedagogicalExplanation).toContain("(B) Ohm");
      expect(explanation.checkPrompt).toContain("Sandeep");
    });
  });

  // ── 6. Voice Teaching Mode & Context Card Generation ───────────────────
  describe("6. Voice Teaching Mode & System Instruction Cards", () => {
    it("toggles teaching mode styles cleanly", () => {
      const config = studySessionManager.toggleTeachingMode(true, "socratic");
      expect(config.enabled).toBe(true);
      expect(config.style).toBe("socratic");

      const off = studySessionManager.toggleTeachingMode(false);
      expect(off.enabled).toBe(false);
    });

    it("formats defensive study context card fenced with <<<UNTRUSTED_STUDY_CONTENT>>>", async () => {
      const text =
        "Question 1: What is kinetic friction?\n" +
        "Ans: Friction opposing relative motion between surfaces.\n" +
        "Normal force N = mg.";

      await studySessionManager.loadDocument(Buffer.from(text, "utf-8"), "friction.txt");
      studySessionManager.toggleTeachingMode(true, "step_by_step");

      const card = studySessionManager.buildStudyContextCard();
      expect(card).toContain("=== REAL-TIME STUDY COMPANION CONTEXT ===");
      expect(card).toContain("Active Document: \"friction\"");
      expect(card).toContain("Current Viewing Position: Page 1 of 1");
      expect(card).toContain("Currently Focused Question: Question 1");
      expect(card).toContain("Explicit Document Answer:");
      expect(card).toContain("Voice Teaching Mode: ACTIVE");
      expect(card).toContain("<<<UNTRUSTED_STUDY_CONTENT>>>");
      expect(card).toContain("<<</UNTRUSTED_STUDY_CONTENT>>>");
    });

    it("injects study context card into buildCompleteSystemInstructions when study mode is active", async () => {
      const text = "Study content on thermodynamics.";
      await studySessionManager.loadDocument(Buffer.from(text, "utf-8"), "thermo.txt");

      const instructions = await buildCompleteSystemInstructions([]);
      expect(instructions).toContain("=== REAL-TIME STUDY COMPANION CONTEXT ===");
      expect(instructions).toContain("Active Document: \"thermo\"");

      // Close document: instructions must return to clean baseline
      studySessionManager.closeDocument();
      const cleanInstructions = await buildCompleteSystemInstructions([]);
      expect(cleanInstructions).not.toContain("=== REAL-TIME STUDY COMPANION CONTEXT ===");
    });
  });

  // ── 7. Emergency Stop Integration ──────────────────────────────────────
  describe("7. Emergency Stop Safeguards", () => {
    it("halts study session immediately when emergency stop triggers", async () => {
      await studySessionManager.loadDocument(
        Buffer.from("Question 1: Test question", "utf-8"),
        "test.txt",
      );
      studySessionManager.toggleTeachingMode(true);
      expect(studySessionManager.getTeachingMode().enabled).toBe(true);

      // Trigger emergency stop killswitch
      await emergencyStopCoordinator.trigger({
        source: "desktop_ui",
        reason: "Student emergency halt",
      });

      // Active study session must be halted immediately
      expect(studySessionManager.getTeachingMode().enabled).toBe(false);

      // Subsequent operations fail-closed
      expect(() => {
        studySessionManager.setCurrentPage(1);
      }).toThrow(/EMERGENCY_STOP_ACTIVE/);

      // Reset emergency stop for subsequent tests
      await emergencyStopCoordinator.reset("desktop_ui");
      studySessionManager.resetEmergencyStop();
    });
  });

  // ── 8. Tool Count & Orchestrator Dispatch Integrity ─────────────────────
  describe("8. Tool Count & Orchestrator Dispatch Layer", () => {
    it("has exactly 126 tools declared in Gemini Live Tools (104 baseline + 7 Stage 1 + 6 Stage 2 + 9 Stage 3)", () => {
      expect(LIVE_TOOLS).toBeDefined();
      expect(Array.isArray(LIVE_TOOLS)).toBe(true);
      const tools = LIVE_TOOLS[0].functionDeclarations;
      expect(Array.isArray(tools)).toBe(true);
      // Architecture rule: 104 baseline + 7 Stage 1 + 6 Stage 2 + 9 Stage 3 tools = exactly 126 total
      expect(tools.length).toBe(126);
    });

    it("includes all 7 Phase 9 study companion tools in LIVE_TOOLS", () => {
      const tools = LIVE_TOOLS[0].functionDeclarations;
      const toolNames = tools.map((t: any) => t.name);

      expect(toolNames).toContain("loadStudyDocument");
      expect(toolNames).toContain("trackStudyPage");
      expect(toolNames).toContain("detectStudyQuestions");
      expect(toolNames).toContain("analyzeStudyDiagram");
      expect(toolNames).toContain("explainStudySection");
      expect(toolNames).toContain("toggleTeachingMode");
      expect(toolNames).toContain("getStudySessionStatus");
    });

    it("ToolOrchestrator dispatches study tools to in-process handlers", async () => {
      const orchestrator = new ToolOrchestrator();
      let toolResponseOutput: any = null;
      let clientMessage: any = null;

      const mockSession = {
        sendToolResponse: (payload: any) => {
          toolResponseOutput = payload.functionResponses[0].response.output;
        },
      };

      const mockSendToClient = (msg: any) => {
        clientMessage = msg;
      };

      // Create a temporary study file in workspace
      const testFilePath = path.join(workspaceRoot, "test_study_doc.txt");
      await fs.writeFile(
        testFilePath,
        "Question 1: What is velocity?\nAns: Rate of change of displacement.",
      );

      try {
        // Dispatch loadStudyDocument
        await orchestrator.dispatch(
          {
            name: "loadStudyDocument",
            args: { path: "test_study_doc.txt" },
            id: "call-study-1",
          },
          mockSession as any,
          mockSendToClient,
          "test-key",
        );

        expect(toolResponseOutput).toBeDefined();
        expect(toolResponseOutput.loaded).toBe(true);
        expect(clientMessage?.type).toBe("study_event");
        expect(clientMessage?.event).toBe("document_loaded");

        // Dispatch trackStudyPage
        await orchestrator.dispatch(
          {
            name: "trackStudyPage",
            args: { pageNumber: 1 },
            id: "call-study-2",
          },
          mockSession as any,
          mockSendToClient,
          "test-key",
        );

        expect(toolResponseOutput.currentPage).toBe(1);
        expect(clientMessage?.event).toBe("page_changed");

        // Dispatch toggleTeachingMode
        await orchestrator.dispatch(
          {
            name: "toggleTeachingMode",
            args: { enabled: true, style: "socratic" },
            id: "call-study-3",
          },
          mockSession as any,
          mockSendToClient,
          "test-key",
        );

        expect(toolResponseOutput.enabled).toBe(true);
        expect(toolResponseOutput.style).toBe("socratic");
        expect(clientMessage?.event).toBe("teaching_mode_toggled");
      } finally {
        // Cleanup temp file
        await fs.unlink(testFilePath).catch(() => {});
      }
    });
  });
});
