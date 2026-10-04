/**
 * MYRAA — InteractiveTutor (Phase 9 — Stage 2: Interactive Tutor)
 *
 * Core pedagogical controller for interactive tutoring:
 *   - Exam Mode: Timed sessions, marks-based responses, exam-style grading
 *   - Viva Mode: Oral question prompts, viva evaluations, constructive feedback & follow-ups
 *   - Practice Mode: Document-grounded questions, answer verification & misconceptions
 *   - Revision Mode: Targeted recall drills on identified weak topics and failed questions
 *   - Automatic Page Navigation: Safe PDF viewer page jumps with strict bounds checking
 *   - Diagram Explanation: Locates and explains relevant diagrams with visual context
 */

import {
  TutorMode,
  ExamConfig,
  VivaConfig,
  InteractiveTutorState,
  AnswerEvaluationResult,
  PageNavigationResult,
  DiagramExplanation,
  DetectedQuestion,
  DetectedDiagram,
} from "./StudyTypes.ts";
import { studySessionManager } from "./StudySessionManager.ts";
import { studyProgressTracker } from "./StudyProgressTracker.ts";
import { DiagramAnalyzer } from "./DiagramAnalyzer.ts";
import { emergencyStopCoordinator } from "../remote/EmergencyStopCoordinator.ts";

export class InteractiveTutor {
  private _state: InteractiveTutorState = {
    mode: "off",
  };

  constructor() {
    emergencyStopCoordinator.registerTriggerHook(() => {
      this.emergencyStop();
    });
  }

  // ---------------------------------------------------------------------------
  // Mode Controller
  // ---------------------------------------------------------------------------

  setMode(
    mode: TutorMode,
    config?: {
      exam?: ExamConfig;
      viva?: VivaConfig;
      examConfig?: ExamConfig;
      vivaConfig?: VivaConfig;
      targetQuestions?: string[];
    },
  ): InteractiveTutorState {
    this._checkEmergencyStop();

    if (mode === "off") {
      this._state = { mode: "off" };
      return this.getState();
    }

    if (mode === "exam") {
      const examCfg = config?.examConfig || config?.exam;
      const timeLimitMinutes = examCfg?.durationMinutes || examCfg?.timeLimitMinutes || 15;
      const totalMarks = examCfg?.totalMarks || 20;
      this._state = {
        mode: "exam",
        activeExam: {
          startTime: Date.now(),
          timeLimitSeconds: timeLimitMinutes * 60,
          timeRemainingSeconds: timeLimitMinutes * 60,
          totalMarks,
          currentScore: 0,
          questionsCount: 0,
          isTimedOut: false,
        },
      };
      studyProgressTracker.incrementExamSessions();
      return this.getState();
    }

    if (mode === "viva") {
      const vivaCfg = config?.vivaConfig || config?.viva;
      const topic = vivaCfg?.focusTopic || vivaCfg?.topic || "Current Study Topic";
      const difficulty = vivaCfg?.difficulty || "medium";
      this._state = {
        mode: "viva",
        activeViva: {
          questionIndex: 1,
          totalQuestions: 5,
          score: 0,
          currentQuestionPrompt: "Let's begin the viva. Tell me the core definition of this topic.",
          topic,
          difficulty,
          focusTopic: topic,
        },
      };
      studyProgressTracker.incrementVivaSessions();
      return this.getState();
    }

    if (mode === "practice") {
      this._state = { mode: "practice" };
      return this.getState();
    }

    if (mode === "revision") {
      const weakTopics = studyProgressTracker.getWeakTopics();
      const incorrectQuestions = studyProgressTracker.getIncorrectQuestions();
      this._state = {
        mode: "revision",
        activeRevision: {
          topic: weakTopics[0] || "General Revision",
          questionsToReview: incorrectQuestions,
          currentIndex: 0,
        },
      };
      return this.getState();
    }

    this._state = { mode };
    return this.getState();
  }

  getState(): InteractiveTutorState {
    // Update remaining exam time if exam is active
    if (this._state.mode === "exam" && this._state.activeExam) {
      const elapsedSeconds = Math.floor(
        (Date.now() - this._state.activeExam.startTime) / 1000,
      );
      const remaining = Math.max(
        0,
        this._state.activeExam.timeLimitSeconds - elapsedSeconds,
      );
      this._state.activeExam.timeRemainingSeconds = remaining;
      this._state.activeExam.isTimedOut = remaining === 0;
    }
    return JSON.parse(JSON.stringify(this._state));
  }

  /**
   * Initiates a targeted revision session focusing on weak topics and incorrect questions.
   */
  startRevisionSession(topic?: string, maxQuestions: number = 5): {
    topic: string;
    questionsCount: number;
    questionIds: string[];
    weakTopics: string[];
    message: string;
  } {
    this._checkEmergencyStop();

    const weakTopics = studyProgressTracker.getWeakTopics();
    const targetTopic = topic || weakTopics[0] || "General Revision";

    let incorrectQuestions = studyProgressTracker.getIncorrectQuestions();
    const doc = studySessionManager.getActiveDocument();

    if (doc && topic) {
      // Filter or find questions matching this topic
      const topicQuestions = doc.pages
        .flatMap((p) => p.questions)
        .filter((q) => {
          const qTopic = this._extractTopic(q.prompt);
          return qTopic.toLowerCase() === topic.toLowerCase() || q.prompt.toLowerCase().includes(topic.toLowerCase());
        })
        .map((q) => q.id);

      // If we have recorded incorrect questions, filter by topic matches; if none match, keep all incorrect questions;
      // if no incorrect questions exist at all, fall back to doc topic questions
      const matchingIncorrect = incorrectQuestions.filter((id) => topicQuestions.includes(id));
      if (matchingIncorrect.length > 0) {
        incorrectQuestions = matchingIncorrect;
      } else if (incorrectQuestions.length === 0 && topicQuestions.length > 0) {
        incorrectQuestions = topicQuestions;
      }
    }

    const reviewQuestions = incorrectQuestions.slice(0, Math.max(1, maxQuestions));

    this._state = {
      mode: "revision",
      activeRevision: {
        topic: targetTopic,
        questionsToReview: reviewQuestions,
        currentIndex: 0,
      },
    };

    return {
      topic: targetTopic,
      questionsCount: reviewQuestions.length,
      questionIds: reviewQuestions,
      weakTopics,
      message:
        reviewQuestions.length > 0
          ? `Revision drill initiated on "${targetTopic}" with ${reviewQuestions.length} targeted questions.`
          : `No previous incorrect questions found for "${targetTopic}". You can practice fresh questions from the document!`,
    };
  }

  // ---------------------------------------------------------------------------
  // Answer Evaluation (Exam / Viva / Practice)
  // ---------------------------------------------------------------------------

  async evaluateStudentAnswer(opts: {
    questionId: string;
    studentAnswer: string;
    timeTakenSeconds?: number;
  }): Promise<AnswerEvaluationResult> {
    this._checkEmergencyStop();

    const doc = studySessionManager.getActiveDocument();
    if (!doc) {
      throw new Error("NO_ACTIVE_DOCUMENT: Please load a study document first.");
    }

    // Locate target question
    let targetQ: DetectedQuestion | undefined;
    for (const page of doc.pages) {
      targetQ = page.questions.find((q) => q.id === opts.questionId);
      if (targetQ) break;
    }

    // Fallback: search by question number if ID did not match directly
    if (!targetQ) {
      const num = parseInt(opts.questionId, 10);
      if (!isNaN(num)) {
        for (const page of doc.pages) {
          targetQ = page.questions.find((q) => q.questionNumber === num);
          if (targetQ) break;
        }
      }
    }

    if (!targetQ) {
      throw new Error(`QUESTION_NOT_FOUND: Question '${opts.questionId}' does not exist in active document.`);
    }

    // Determine correctness & score
    const maxMarks = targetQ.marks || (targetQ.isMultipleChoice ? 1 : 2);
    const { isCorrect, scoreAwarded, feedback, modelSolution, topic } =
      this._gradeAnswer(targetQ, opts.studentAnswer, this._state.mode);

    // Record in progress tracker
    studyProgressTracker.recordAttempt({
      questionId: targetQ.id,
      topic,
      studentAnswer: opts.studentAnswer,
      isCorrect,
      scoreAwarded,
      maxMarks,
      mode: this._state.mode,
    });

    // Check if topic is weak
    const progress = studyProgressTracker.getOverallProgress();
    const isWeakTopic = progress.weakTopics.includes(topic);

    // Update active Exam score if in Exam mode
    if (this._state.mode === "exam" && this._state.activeExam) {
      this._state.activeExam.currentScore += scoreAwarded;
      this._state.activeExam.questionsCount++;
    }

    // Update active Viva progress if in Viva mode
    let vivaFollowUpQuestion: string | undefined;
    if (this._state.mode === "viva" && this._state.activeViva) {
      this._state.activeViva.score += scoreAwarded;
      this._state.activeViva.questionIndex++;
      vivaFollowUpQuestion = isCorrect
        ? `Great answer! Now, can you explain what happens under limiting or extreme conditions?`
        : `Let's reconsider this: what fundamental law connects these two variables?`;
    }

    return {
      questionId: targetQ.id,
      isCorrect,
      scoreAwarded,
      maxMarks,
      feedback,
      modelSolution,
      source: targetQ.answerMapping?.isDocumentProvided ? "document" : "model_inferred",
      topic,
      isWeakTopic,
      vivaFollowUpQuestion,
      timeTakenSeconds: opts.timeTakenSeconds,
    };
  }

  // ---------------------------------------------------------------------------
  // Automatic Page Navigation (Restricted to Study Document/PDF Viewer)
  // ---------------------------------------------------------------------------

  /**
   * Safely navigates the active study document and supported viewer to the exact page
   * containing a target question, diagram, or page index.
   * STRICT BOUNDS: Only navigates within [1, pageCount]. Does NOT control external apps.
   */
  navigateToItem(opts: {
    targetType: "question" | "diagram" | "page";
    targetId?: string;
    pageNumber?: number;
  }): PageNavigationResult {
    this._checkEmergencyStop();

    const doc = studySessionManager.getActiveDocument();
    if (!doc) {
      throw new Error("NO_ACTIVE_DOCUMENT: Please load a study document first.");
    }

    const previousPageNumber = studySessionManager.getSessionContext().currentPageNumber;

    if (opts.targetType === "page") {
      if (opts.pageNumber === undefined || isNaN(opts.pageNumber)) {
        throw new Error("INVALID_PAGE: Target page number must be specified.");
      }
      if (opts.pageNumber < 1 || opts.pageNumber > doc.pageCount) {
        throw new Error(`PAGE_OUT_OF_BOUNDS: Target page ${opts.pageNumber} is out of document bounds (1-${doc.pageCount}).`);
      }
      const page = studySessionManager.setCurrentPage(opts.pageNumber);
      return {
        success: true,
        targetType: "page",
        targetPageNumber: page.pageNumber,
        previousPageNumber,
        message: `Navigated viewer to Page ${page.pageNumber} of ${doc.pageCount}.`,
      };
    }

    if (opts.targetType === "question") {
      if (!opts.targetId) {
        throw new Error("INVALID_QUESTION: Target question ID must be specified.");
      }

      // Search document pages for question
      for (const page of doc.pages) {
        const q =
          page.questions.find((quest) => quest.id === opts.targetId) ||
          page.questions.find((quest) => quest.questionNumber === Number(opts.targetId));

        if (q) {
          studySessionManager.setCurrentPage(page.pageNumber);
          studySessionManager.setCurrentQuestion(q.id);
          return {
            success: true,
            targetType: "question",
            targetId: q.id,
            targetPageNumber: page.pageNumber,
            previousPageNumber,
            highlightSnippet: q.prompt.slice(0, 100),
            message: `Navigated to Page ${page.pageNumber} for Question ${q.questionNumber}.`,
          };
        }
      }

      throw new Error(`QUESTION_NOT_FOUND: Question '${opts.targetId}' not found in document.`);
    }

    if (opts.targetType === "diagram") {
      if (!opts.targetId) {
        throw new Error("INVALID_DIAGRAM: Target diagram ID or label must be specified.");
      }

      for (const page of doc.pages) {
        const d =
          page.diagrams.find((diag) => diag.id === opts.targetId) ||
          page.diagrams.find((diag) =>
            diag.figureLabel.toLowerCase().includes(opts.targetId!.toLowerCase()),
          );

        if (d) {
          studySessionManager.setCurrentPage(page.pageNumber);
          return {
            success: true,
            targetType: "diagram",
            targetId: d.id,
            targetPageNumber: page.pageNumber,
            previousPageNumber,
            highlightSnippet: d.figureLabel,
            message: `Navigated to Page ${page.pageNumber} for ${d.figureLabel}.`,
          };
        }
      }

      throw new Error(`DIAGRAM_NOT_FOUND: Diagram '${opts.targetId}' not found in document.`);
    }

    throw new Error(`INVALID_TARGET_TYPE: Target type '${opts.targetType}' is not supported.`);
  }

  // ---------------------------------------------------------------------------
  // Relevant Diagram Explanation
  // ---------------------------------------------------------------------------

  /**
   * Explains the diagram currently relevant to the active question or topic,
   * combining visual perception and document diagrams.
   */
  async explainRelevantDiagram(opts?: {
    questionId?: string;
    topic?: string;
    forceVisualCapture?: boolean;
  }): Promise<DiagramExplanation> {
    this._checkEmergencyStop();

    const doc = studySessionManager.getActiveDocument();
    if (!doc) {
      throw new Error("NO_ACTIVE_DOCUMENT: Please load a study document first.");
    }

    const currentPage = studySessionManager.getCurrentPage();
    let targetDiagram: DetectedDiagram | undefined;

    // 1. If questionId is provided, check if that question or page has an associated diagram
    if (opts?.questionId) {
      for (const page of doc.pages) {
        const hasQ = page.questions.some(
          (q) => q.id === opts.questionId || q.questionNumber === Number(opts.questionId),
        );
        if (hasQ && page.diagrams.length > 0) {
          targetDiagram = page.diagrams[0];
          studySessionManager.setCurrentPage(page.pageNumber);
          break;
        }
      }
    }

    // 2. Search document by topic keyword if provided
    if (!targetDiagram && opts?.topic) {
      const lower = opts.topic.toLowerCase();
      for (const page of doc.pages) {
        const found = page.diagrams.find((d) =>
          `${d.figureLabel} ${d.caption} ${d.surroundingContext}`.toLowerCase().includes(lower),
        );
        if (found) {
          targetDiagram = found;
          studySessionManager.setCurrentPage(page.pageNumber);
          break;
        }
      }
    }

    // 3. Check current page diagrams
    if (!targetDiagram && currentPage && currentPage.diagrams.length > 0) {
      targetDiagram = currentPage.diagrams[0];
    }

    // 4. Fallback: first diagram in the document
    if (!targetDiagram) {
      for (const page of doc.pages) {
        if (page.diagrams.length > 0) {
          targetDiagram = page.diagrams[0];
          break;
        }
      }
    }

    if (!targetDiagram) {
      throw new Error("NO_DIAGRAM_AVAILABLE: No diagrams or figures detected in this document.");
    }

    return DiagramAnalyzer.explainDiagram(targetDiagram, Boolean(opts?.forceVisualCapture));
  }

  // ---------------------------------------------------------------------------
  // Internal Helpers & Grading Logic
  // ---------------------------------------------------------------------------

  private _gradeAnswer(
    question: DetectedQuestion,
    studentAnswer: string,
    mode: TutorMode,
  ): {
    isCorrect: boolean;
    scoreAwarded: number;
    feedback: string;
    modelSolution: string;
    topic: string;
  } {
    const rawStudent = (studentAnswer || "").trim().toLowerCase();
    const docAnswer = question.answerMapping?.documentAnswerText || "";
    const rawDoc = docAnswer.toLowerCase();
    const maxMarks = question.marks || (question.isMultipleChoice ? 1 : 2);

    // Derive topic from question prompt or document
    const topic = this._extractTopic(question.prompt);

    let isCorrect = false;

    // Check multiple-choice matching
    if (question.isMultipleChoice) {
      // Look for option letters like "a", "b", "c", "d"
      const studentLetter = rawStudent.match(/\b([a-d])\b/)?.[1] || rawStudent.slice(0, 1);
      const docLetter = rawDoc.match(/\b([a-d])\b/)?.[1];

      if (docLetter && studentLetter === docLetter) {
        isCorrect = true;
      } else if (docAnswer && rawStudent.length > 2 && rawDoc.includes(rawStudent)) {
        isCorrect = true;
      } else if (!docLetter) {
        // Model-inferred check for MCQ
        const optA = question.options[0]?.text.toLowerCase();
        if (optA && rawStudent.includes(optA)) {
          isCorrect = true;
        }
      }
    } else {
      // Free-form text matching
      if (rawDoc && rawDoc.length > 2) {
        const keywords = rawDoc.split(/\s+/).filter((w) => w.length > 3);
        const matchCount = keywords.filter((kw) => rawStudent.includes(kw)).length;
        isCorrect = matchCount >= Math.max(1, Math.floor(keywords.length * 0.4));
      } else {
        // Concept evaluation
        isCorrect = rawStudent.length > 10 && !rawStudent.includes("don't know");
      }
    }

    const scoreAwarded = isCorrect ? maxMarks : 0;

    let modelSolution: string;
    if (question.answerMapping?.isDocumentProvided && docAnswer) {
      modelSolution = `[Document Solution]: ${docAnswer}`;
    } else {
      modelSolution = `[Model Solution]: For "${question.prompt.slice(0, 80)}...", key concept is ${topic}.`;
    }

    let feedback: string;
    if (mode === "exam") {
      feedback = isCorrect
        ? `[Exam Grade: ${scoreAwarded}/${maxMarks} Marks] Full marks awarded. Your answer aligns accurately with the expected grading scheme.`
        : `[Exam Grade: 0/${maxMarks} Marks] Incorrect response. In an exam, ensure you state: ${modelSolution}`;
    } else if (mode === "viva") {
      feedback = isCorrect
        ? `[Viva Score: ${scoreAwarded}/${maxMarks}] Well articulated, Sandeep! You demonstrated clear grasp of ${topic}.`
        : `[Viva Score: 0/${maxMarks}] Not quite there. Consider the core relationship in ${topic}. Review: ${modelSolution}`;
    } else {
      feedback = isCorrect
        ? `Correct! Excellent understanding of ${topic}.`
        : `Incorrect. Let's learn from this: ${modelSolution}`;
    }

    return {
      isCorrect,
      scoreAwarded,
      feedback,
      modelSolution,
      topic,
    };
  }

  private _extractTopic(prompt: string): string {
    const lower = prompt.toLowerCase();
    if (lower.includes("kinematics") || lower.includes("velocity") || lower.includes("acceleration")) {
      return "Kinematics";
    }
    if (lower.includes("newton") || lower.includes("force") || lower.includes("friction")) {
      return "Newtonian Mechanics";
    }
    if (lower.includes("energy") || lower.includes("work") || lower.includes("power")) {
      return "Work and Energy";
    }
    if (lower.includes("circuit") || lower.includes("ohm") || lower.includes("voltage") || lower.includes("current")) {
      return "Current Electricity";
    }
    if (lower.includes("momentum") || lower.includes("collision")) {
      return "Momentum and Collisions";
    }
    if (lower.includes("thermodynamics") || lower.includes("heat") || lower.includes("entropy")) {
      return "Thermodynamics";
    }
    return "General Physics";
  }

  private _checkEmergencyStop(): void {
    if (emergencyStopCoordinator.isActive()) {
      this.emergencyStop();
      throw new Error("EMERGENCY_STOP_ACTIVE: Interactive tutor operations are blocked while emergency stop is active.");
    }
  }

  emergencyStop(): void {
    if (this._state.mode === "exam" && this._state.activeExam) {
      this._state.activeExam.isTimedOut = true;
    }
    this._state.mode = "off";
    console.warn("[InteractiveTutor] EMERGENCY STOP: Active tutor session, exam, and timers halted.");
  }
}

export const interactiveTutor = new InteractiveTutor();
