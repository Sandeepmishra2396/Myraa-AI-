/**
 * MYRAA — Phase 9: AI Study Companion (Stage 2 — Interactive Tutor) Tests
 *
 * Comprehensive test suite verifying all Stage 2 capabilities:
 *   1. Interactive Tutor Modes (Exam, Viva, Practice, Revision, Off)
 *   2. Exam Mode with Timer & Marks Grading
 *   3. Viva Mode with Verbal Assessment & Follow-ups
 *   4. Practice Mode with Misconception Guidance & Answer Mapping
 *   5. Deterministic Weak-Topic Tracking (incorrect >= 2 OR accuracy < 60%)
 *   6. Progress Tracking & Persistence across Restarts
 *   7. Revision Drills Targeting Weak Topics
 *   8. Automatic Page & Item Navigation with Strict Bounds
 *   9. Relevant Diagram Explanation fusing Context & Metadata
 *  10. Emergency Stop Cascade & Fail-Closed Behavior
 *  11. Tool Count Integrity (exactly 117 tools) & ToolOrchestrator Dispatch
 *  12. Context Card Integration (Tutor State & Weak Topics in Prompt)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import { studyDocumentEngine } from "../StudyDocumentEngine.ts";
import { studySessionManager } from "../StudySessionManager.ts";
import { interactiveTutor } from "../InteractiveTutor.ts";
import { studyProgressTracker } from "../StudyProgressTracker.ts";
import { emergencyStopCoordinator } from "../../remote/EmergencyStopCoordinator.ts";
import { ToolOrchestrator } from "../../tools/ToolOrchestrator.ts";
import { LIVE_TOOLS } from "../../ai/GeminiSessionFactory.ts";
import { buildCompleteSystemInstructions } from "../../projects/ContextManager.ts";

describe("Phase 9 — AI Study Companion: Stage 2 — Interactive Tutor", () => {
  const workspaceRoot = path.resolve(process.cwd());
  const sampleDocPath = path.join(workspaceRoot, "temp_tutor_test_doc.txt");

  beforeEach(async () => {
    studyDocumentEngine.setWorkspaceRoot(workspaceRoot);
    await emergencyStopCoordinator.reset("test-operator");
    studySessionManager.resetEmergencyStop();
    studySessionManager.closeDocument();
    interactiveTutor.setMode("off");
    studyProgressTracker.clear();

    // Create a rich test document with questions across topics, diagrams, and answers
    const content = `=== PAGE 1 ===
Section 1.1: Kinematics and Motion
Velocity is the rate of change of displacement with respect to time.
Figure 1: Velocity-Time Graph showing linear acceleration.

Question 1: What is the unit of linear velocity?
A) m/s
B) m/s^2
C) kg*m/s
D) Joules
Ans: A) m/s

Question 2: State Newton's Second Law of Motion.
Ans: Force equals mass times acceleration (F = ma).

=== PAGE 2 ===
Section 1.2: Thermodynamics
Heat transfer occurs via conduction, convection, and radiation.
Figure 2: Carnot Engine Cycle diagram illustrating isothermal and adiabatic processes.

Question 3: Which process in a Carnot cycle occurs at constant temperature?
A) Isobaric
B) Isothermal
C) Isochoric
D) Adiabatic
Ans: B) Isothermal

Question 4: Define entropy in terms of statistical disorder.
`;
    await fs.writeFile(sampleDocPath, content, "utf-8");
    await studySessionManager.loadDocument("temp_tutor_test_doc.txt");
  });

  afterEach(async () => {
    studySessionManager.closeDocument();
    await emergencyStopCoordinator.reset("test-operator");
    studySessionManager.resetEmergencyStop();
    await fs.unlink(sampleDocPath).catch(() => {});
  });

  // ── 1. Interactive Tutor Modes & Transitions ────────────────────────────
  describe("1. Interactive Tutor Modes", () => {
    it("transitions between practice, exam, viva, revision, and off modes", () => {
      expect(interactiveTutor.getState().mode).toBe("off");

      interactiveTutor.setMode("practice");
      expect(interactiveTutor.getState().mode).toBe("practice");

      interactiveTutor.setMode("viva", {
        vivaConfig: { difficulty: "hard", focusTopic: "Thermodynamics" },
      });
      const vivaState = interactiveTutor.getState();
      expect(vivaState.mode).toBe("viva");
      expect(vivaState.activeViva?.difficulty).toBe("hard");
      expect(vivaState.activeViva?.focusTopic).toBe("Thermodynamics");

      interactiveTutor.setMode("off");
      expect(interactiveTutor.getState().mode).toBe("off");
    });

    it("manages exam mode timer and tracks time remaining", () => {
      interactiveTutor.setMode("exam", {
        examConfig: { durationMinutes: 10, totalMarks: 25 },
      });
      const examState = interactiveTutor.getState();
      expect(examState.mode).toBe("exam");
      expect(examState.activeExam?.timeLimitSeconds).toBe(600);
      expect(examState.activeExam?.timeRemainingSeconds).toBeGreaterThan(0);
      expect(examState.activeExam?.isTimedOut).toBe(false);
      expect(examState.activeExam?.totalMarks).toBe(25);
    });
  });

  // ── 2. Answer Evaluation & Grading ──────────────────────────────────────
  describe("2. Answer Evaluation & Grading", () => {
    it("grades multiple choice questions accurately based on document answer", async () => {
      interactiveTutor.setMode("practice");

      // Question 1: Unit of linear velocity -> Ans: A) m/s
      const doc = studySessionManager.getActiveDocument()!;
      const q1 = doc.pages[0].questions[0];

      const resultCorrect = await interactiveTutor.evaluateStudentAnswer({
        questionId: q1.id,
        studentAnswer: "A) m/s",
      });

      expect(resultCorrect.isCorrect).toBe(true);
      expect(resultCorrect.scoreAwarded).toBe(q1.marks || 1);
      expect(resultCorrect.source).toBe("document");
      expect(resultCorrect.feedback).toMatch(/Correct/i);

      const resultIncorrect = await interactiveTutor.evaluateStudentAnswer({
        questionId: q1.id,
        studentAnswer: "B) m/s^2",
      });

      expect(resultIncorrect.isCorrect).toBe(false);
      expect(resultIncorrect.scoreAwarded).toBe(0);
      expect(resultIncorrect.feedback).toMatch(/Incorrect/i);
    });

    it("evaluates descriptive questions and distinguishes document vs model answers", async () => {
      interactiveTutor.setMode("practice");

      const doc = studySessionManager.getActiveDocument()!;
      // Question 2 has document answer "Force equals mass times acceleration (F = ma)"
      const q2 = doc.pages[0].questions[1];
      const resultQ2 = await interactiveTutor.evaluateStudentAnswer({
        questionId: q2.id,
        studentAnswer: "F = ma, force is mass times acceleration",
      });

      expect(resultQ2.isCorrect).toBe(true);
      expect(resultQ2.source).toBe("document");
      expect(resultQ2.modelSolution).toContain("Force equals mass times acceleration");

      // Question 4 has no document answer (model inferred)
      const q4 = doc.pages[1].questions[1];
      const resultQ4 = await interactiveTutor.evaluateStudentAnswer({
        questionId: q4.id,
        studentAnswer: "Entropy is a measure of molecular randomness or disorder.",
      });

      expect(resultQ4.source).toBe("model_inferred");
      expect(resultQ4.isCorrect).toBe(true);
    });

    it("provides viva follow-up questions when evaluating in viva mode", async () => {
      interactiveTutor.setMode("viva", {
        vivaConfig: { difficulty: "medium", focusTopic: "Kinematics" },
      });

      const doc = studySessionManager.getActiveDocument()!;
      const q1 = doc.pages[0].questions[0];

      const result = await interactiveTutor.evaluateStudentAnswer({
        questionId: q1.id,
        studentAnswer: "Option A, meters per second",
      });

      expect(result.vivaFollowUpQuestion).toBeDefined();
      expect(typeof result.vivaFollowUpQuestion).toBe("string");
    });
  });

  // ── 3. Deterministic Weak-Topic Tracking ────────────────────────────────
  describe("3. Deterministic Weak-Topic Tracking", () => {
    it("marks topic as weak when incorrect >= 2", () => {
      studyProgressTracker.clear();

      // Attempt 1: Incorrect
      studyProgressTracker.recordAttempt({
        questionId: "q-kine-1",
        topic: "Kinematics",
        isCorrect: false,
        scoreAwarded: 0,
        maxMarks: 2,
        mode: "practice",
      });

      let progress = studyProgressTracker.getOverallProgress();
      expect(progress.weakTopics).not.toContain("Kinematics"); // Only 1 incorrect

      // Attempt 2: Incorrect (total incorrect = 2 -> weak)
      studyProgressTracker.recordAttempt({
        questionId: "q-kine-2",
        topic: "Kinematics",
        isCorrect: false,
        scoreAwarded: 0,
        maxMarks: 2,
        mode: "practice",
      });

      progress = studyProgressTracker.getOverallProgress();
      expect(progress.weakTopics).toContain("Kinematics");
      const kineStats = studyProgressTracker.getTopicProgress("Kinematics")!;
      expect(kineStats.isWeak).toBe(true);
      expect(kineStats.incorrect).toBe(2);
    });

    it("marks topic as weak when attempted >= 2 and accuracy < 60%", () => {
      studyProgressTracker.clear();

      // Attempt 1: Incorrect
      studyProgressTracker.recordAttempt({
        questionId: "q-thermo-1",
        topic: "Thermodynamics",
        isCorrect: false,
        scoreAwarded: 0,
        maxMarks: 2,
        mode: "practice",
      });

      // Attempt 2: Correct -> 1/2 = 50% accuracy (< 60%) with attempted >= 2
      studyProgressTracker.recordAttempt({
        questionId: "q-thermo-2",
        topic: "Thermodynamics",
        isCorrect: true,
        scoreAwarded: 2,
        maxMarks: 2,
        mode: "practice",
      });

      const thermoStats = studyProgressTracker.getTopicProgress("Thermodynamics")!;
      expect(thermoStats.attempted).toBe(2);
      expect(thermoStats.accuracyRate).toBe(50);
      expect(thermoStats.isWeak).toBe(true);
    });

    it("clears weak status when accuracy reaches 60% or higher and incorrect < 2", () => {
      studyProgressTracker.clear();

      // Record 1 incorrect and 3 correct -> attempted = 4, correct = 3, incorrect = 1, accuracy = 75%
      studyProgressTracker.recordAttempt({
        questionId: "q-opt-1",
        topic: "Optics",
        isCorrect: false,
        scoreAwarded: 0,
        maxMarks: 1,
        mode: "practice",
      });
      studyProgressTracker.recordAttempt({
        questionId: "q-opt-2",
        topic: "Optics",
        isCorrect: true,
        scoreAwarded: 1,
        maxMarks: 1,
        mode: "practice",
      });
      studyProgressTracker.recordAttempt({
        questionId: "q-opt-3",
        topic: "Optics",
        isCorrect: true,
        scoreAwarded: 1,
        maxMarks: 1,
        mode: "practice",
      });
      studyProgressTracker.recordAttempt({
        questionId: "q-opt-4",
        topic: "Optics",
        isCorrect: true,
        scoreAwarded: 1,
        maxMarks: 1,
        mode: "practice",
      });

      const opticsStats = studyProgressTracker.getTopicProgress("Optics")!;
      expect(opticsStats.attempted).toBe(4);
      expect(opticsStats.incorrect).toBe(1);
      expect(opticsStats.accuracyRate).toBe(75);
      expect(opticsStats.isWeak).toBe(false);
      expect(studyProgressTracker.getWeakTopics()).not.toContain("Optics");
    });
  });

  // ── 4. Progress Tracking & Persistence ──────────────────────────────────
  describe("4. Progress Persistence across Restarts", () => {
    it("persists study attempts to disk and reloads them accurately", () => {
      studyProgressTracker.clear();

      studyProgressTracker.recordAttempt({
        questionId: "q-persist-1",
        topic: "Electromagnetism",
        isCorrect: true,
        scoreAwarded: 5,
        maxMarks: 5,
        mode: "exam",
      });

      // Reload tracker from disk
      studyProgressTracker.reload();

      const overall = studyProgressTracker.getOverallProgress();
      expect(overall.totalAttempted).toBeGreaterThanOrEqual(1);
      const emStats = studyProgressTracker.getTopicProgress("Electromagnetism");
      expect(emStats).toBeDefined();
      expect(emStats?.correct).toBeGreaterThanOrEqual(1);
    });
  });

  // ── 5. Revision Mode Drills ─────────────────────────────────────────────
  describe("5. Revision Mode", () => {
    it("initiates revision drill targeting weak topics and previous incorrect questions", () => {
      studyProgressTracker.clear();

      // Create weak topic with 2 failed questions
      studyProgressTracker.recordAttempt({
        questionId: "q-rev-1",
        topic: "Thermodynamics",
        isCorrect: false,
        scoreAwarded: 0,
        maxMarks: 2,
        mode: "practice",
      });
      studyProgressTracker.recordAttempt({
        questionId: "q-rev-2",
        topic: "Thermodynamics",
        isCorrect: false,
        scoreAwarded: 0,
        maxMarks: 2,
        mode: "practice",
      });

      const revSession = interactiveTutor.startRevisionSession("Thermodynamics", 3);
      expect(revSession.topic).toBe("Thermodynamics");
      expect(revSession.questionIds).toContain("q-rev-1");
      expect(revSession.questionIds).toContain("q-rev-2");
      expect(interactiveTutor.getState().mode).toBe("revision");
    });
  });

  // ── 6. Automatic Page & Item Navigation ─────────────────────────────────
  describe("6. Automatic Page & Item Navigation", () => {
    it("safely navigates viewer within strict document page bounds", () => {
      // Document has 2 pages
      const navPage2 = interactiveTutor.navigateToItem({
        targetType: "page",
        pageNumber: 2,
      });

      expect(navPage2.success).toBe(true);
      expect(navPage2.targetPageNumber).toBe(2);
      expect(studySessionManager.getCurrentPage()?.pageNumber).toBe(2);

      // Attempting to navigate outside bounds throws error
      expect(() => {
        interactiveTutor.navigateToItem({
          targetType: "page",
          pageNumber: 5,
        });
      }).toThrow(/PAGE_OUT_OF_BOUNDS/);

      expect(() => {
        interactiveTutor.navigateToItem({
          targetType: "page",
          pageNumber: 0,
        });
      }).toThrow(/PAGE_OUT_OF_BOUNDS/);
    });

    it("navigates directly to target question page and updates focused question", () => {
      const doc = studySessionManager.getActiveDocument()!;
      // Question 3 is on Page 2
      const q3 = doc.pages[1].questions[0];

      // Start on page 1
      studySessionManager.setCurrentPage(1);

      const navResult = interactiveTutor.navigateToItem({
        targetType: "question",
        targetId: q3.id,
      });

      expect(navResult.success).toBe(true);
      expect(navResult.targetPageNumber).toBe(2);
      expect(studySessionManager.getCurrentPage()?.pageNumber).toBe(2);
      expect(studySessionManager.getSessionContext().currentQuestion?.id).toBe(q3.id);
    });

    it("navigates to diagram page when target diagram is requested", () => {
      studySessionManager.setCurrentPage(1);

      const navResult = interactiveTutor.navigateToItem({
        targetType: "diagram",
        targetId: "Figure 2",
      });

      expect(navResult.success).toBe(true);
      expect(navResult.targetPageNumber).toBe(2);
      expect(studySessionManager.getCurrentPage()?.pageNumber).toBe(2);
    });
  });

  // ── 7. Relevant Diagram Explanation ─────────────────────────────────────
  describe("7. Diagram Explanation", () => {
    it("explains the diagram relevant to the current page or topic", async () => {
      studySessionManager.setCurrentPage(1);

      const explanation = await interactiveTutor.explainRelevantDiagram();
      expect(explanation).toBeDefined();
      expect(explanation.figureLabel).toBe("Figure 1");
      expect(explanation.educationalTakeaway).toBeDefined();
    });

    it("finds and explains diagram associated with a specific topic", async () => {
      const explanation = await interactiveTutor.explainRelevantDiagram({
        topic: "Carnot",
      });

      expect(explanation).toBeDefined();
      expect(explanation.figureLabel).toBe("Figure 2");
      expect(explanation.educationalTakeaway).toBeDefined();
    });
  });

  // ── 8. Emergency Stop Safeguards ─────────────────────────────────────────
  describe("8. Emergency Stop Safeguards", () => {
    it("blocks all interactive tutor operations immediately when emergency stop triggers", async () => {
      interactiveTutor.setMode("exam", {
        examConfig: { durationMinutes: 15, totalMarks: 20 },
      });

      // Trigger emergency stop killswitch
      await emergencyStopCoordinator.trigger({
        source: "desktop_ui",
        reason: "Simulated security incident",
      });

      // Verify tutor mode turns off and timer cancels
      expect(interactiveTutor.getState().mode).toBe("off");

      // Verify evaluateStudentAnswer fails closed
      await expect(
        interactiveTutor.evaluateStudentAnswer({
          questionId: "q-1",
          studentAnswer: "A",
        }),
      ).rejects.toThrow(/EMERGENCY_STOP_ACTIVE/);

      // Verify navigateToItem fails closed
      expect(() => {
        interactiveTutor.navigateToItem({
          targetType: "page",
          pageNumber: 1,
        });
      }).toThrow(/EMERGENCY_STOP_ACTIVE/);

      // Verify startRevisionSession fails closed
      expect(() => {
        interactiveTutor.startRevisionSession("Kinematics");
      }).toThrow(/EMERGENCY_STOP_ACTIVE/);

      // Verify explainRelevantDiagram fails closed
      await expect(
        interactiveTutor.explainRelevantDiagram(),
      ).rejects.toThrow(/EMERGENCY_STOP_ACTIVE/);
    });
  });

  // ── 9. Tool Count & Orchestrator Dispatch Layer ─────────────────────────
  describe("9. Tool Count & Orchestrator Dispatch Layer", () => {
    it("has exactly 126 tools declared in Gemini Live Tools (104 baseline + 7 Stage 1 + 6 Stage 2 + 9 Stage 3)", () => {
      expect(LIVE_TOOLS).toBeDefined();
      const tools = LIVE_TOOLS[0].functionDeclarations;
      expect(Array.isArray(tools)).toBe(true);
      // Architecture rule: 104 baseline + 7 Stage 1 + 6 Stage 2 + 9 Stage 3 = exactly 126 tools
      expect(tools.length).toBe(126);
    });

    it("includes all 6 Stage 2 interactive tutor tools in LIVE_TOOLS", () => {
      const tools = LIVE_TOOLS[0].functionDeclarations;
      const toolNames = tools.map((t: any) => t.name);

      expect(toolNames).toContain("setInteractiveTutorMode");
      expect(toolNames).toContain("submitStudentAnswer");
      expect(toolNames).toContain("getStudyProgress");
      expect(toolNames).toContain("startRevisionSession");
      expect(toolNames).toContain("navigateToStudyItem");
      expect(toolNames).toContain("explainRelevantDiagram");
    });

    it("ToolOrchestrator dispatches Stage 2 tools to in-process handlers with client events", async () => {
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

      // 1. Dispatch setInteractiveTutorMode
      await orchestrator.dispatch(
        {
          name: "setInteractiveTutorMode",
          args: { mode: "practice" },
          id: "call-tutor-1",
        },
        mockSession as any,
        mockSendToClient,
        "test-key",
      );

      expect(toolResponseOutput).toBeDefined();
      expect(toolResponseOutput.mode).toBe("practice");
      expect(clientMessage?.event).toBe("tutor_mode_changed");

      // 2. Dispatch submitStudentAnswer
      const doc = studySessionManager.getActiveDocument()!;
      const q1 = doc.pages[0].questions[0];

      await orchestrator.dispatch(
        {
          name: "submitStudentAnswer",
          args: { questionId: q1.id, studentAnswer: "A) m/s" },
          id: "call-tutor-2",
        },
        mockSession as any,
        mockSendToClient,
        "test-key",
      );

      expect(toolResponseOutput.isCorrect).toBe(true);
      expect(clientMessage?.event).toBe("answer_submitted");

      // 3. Dispatch getStudyProgress
      await orchestrator.dispatch(
        {
          name: "getStudyProgress",
          args: {},
          id: "call-tutor-3",
        },
        mockSession as any,
        mockSendToClient,
        "test-key",
      );

      expect(toolResponseOutput.overall).toBeDefined();
      expect(clientMessage?.event).toBe("progress_retrieved");

      // 4. Dispatch navigateToStudyItem
      await orchestrator.dispatch(
        {
          name: "navigateToStudyItem",
          args: { targetType: "page", pageNumber: 2 },
          id: "call-tutor-4",
        },
        mockSession as any,
        mockSendToClient,
        "test-key",
      );

      expect(toolResponseOutput.success).toBe(true);
      expect(toolResponseOutput.targetPageNumber).toBe(2);

      // 5. Dispatch explainRelevantDiagram
      await orchestrator.dispatch(
        {
          name: "explainRelevantDiagram",
          args: { topic: "Carnot" },
          id: "call-tutor-5",
        },
        mockSession as any,
        mockSendToClient,
        "test-key",
      );

      expect(toolResponseOutput.explained).toBe(true);
      expect(clientMessage?.event).toBe("diagram_explained");
    });
  });

  // ── 10. Context Card Integration ────────────────────────────────────────
  describe("10. System Instruction & Context Card Integration", () => {
    it("injects Interactive Tutor state and weak topics into Gemini system instructions", async () => {
      // Set tutor mode to exam and record weak topic
      interactiveTutor.setMode("exam", {
        examConfig: { durationMinutes: 20, totalMarks: 30 },
      });
      studyProgressTracker.recordAttempt({
        questionId: "q-k-1",
        topic: "Quantum Mechanics",
        isCorrect: false,
        scoreAwarded: 0,
        maxMarks: 5,
        mode: "exam",
      });
      studyProgressTracker.recordAttempt({
        questionId: "q-k-2",
        topic: "Quantum Mechanics",
        isCorrect: false,
        scoreAwarded: 0,
        maxMarks: 5,
        mode: "exam",
      });

      const instructions = await buildCompleteSystemInstructions([]);

      expect(instructions).toContain("=== REAL-TIME STUDY COMPANION CONTEXT ===");
      expect(instructions).toContain("=== INTERACTIVE TUTOR: EXAM MODE ACTIVE ===");
      expect(instructions).toContain("Identified Weak Topics (Student struggled repeatedly): Quantum Mechanics");
    });
  });
});
