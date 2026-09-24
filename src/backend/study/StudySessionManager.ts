/**
 * MYRAA — StudySessionManager (Phase 9 — AI Study Companion: Stage 1)
 *
 * Coordinates real-time study state, page navigation, active question tracking,
 * and voice teaching mode:
 *   - Tracks active document, current page, and currently viewed question
 *   - Formats defensive Study Context Cards for Gemini system instructions
 *   - Strictly integrates with EmergencyStopCoordinator: killswitch immediately halts study sessions
 *   - Fences untrusted student content within <<<UNTRUSTED_STUDY_CONTENT>>>
 */

import {
  StudyDocument,
  StudyPage,
  DetectedQuestion,
  TeachingModeConfig,
  TeachingStyle,
  StudySessionContext,
  UNTRUSTED_STUDY_FENCE_START,
  UNTRUSTED_STUDY_FENCE_END,
} from "./StudyTypes.ts";
import { studyDocumentEngine } from "./StudyDocumentEngine.ts";
import { TeachingEngine } from "./TeachingEngine.ts";
import { interactiveTutor } from "./InteractiveTutor.ts";
import { studyProgressTracker } from "./StudyProgressTracker.ts";
import { courseProfileManager } from "./CourseProfileManager.ts";
import { studyResearchEngine } from "./StudyResearchEngine.ts";
import { emergencyStopCoordinator } from "../remote/EmergencyStopCoordinator.ts";

export class StudySessionManager {
  public interactiveTutor = interactiveTutor;
  public studyProgressTracker = studyProgressTracker;
  public courseProfileManager = courseProfileManager;
  public studyResearchEngine = studyResearchEngine;
  private _activeDocument: StudyDocument | null = null;
  private _currentPageNumber: number = 1;
  private _currentQuestionId: string | null = null;
  private _currentSectionId: string | null = null;
  private _teachingMode: TeachingModeConfig = {
    enabled: false,
    style: "step_by_step",
    interactiveCheckins: true,
    preferredLanguage: "hinglish",
  };
  private _sessionStartedAt: number = 0;
  private _lastActivityAt: number = 0;
  private _isEmergencyStopped: boolean = false;

  constructor() {
    // Hook into EmergencyStopCoordinator
    emergencyStopCoordinator.registerTriggerHook(() => {
      this.emergencyStop();
    });
  }

  // ---------------------------------------------------------------------------
  // Document Loading & Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Loads a document from file path or buffer into the active study session.
   */
  async loadDocument(target: string | Buffer, filename?: string): Promise<StudyDocument> {
    this._checkEmergencyStop();

    let doc: StudyDocument;
    if (typeof target === "string") {
      doc = await studyDocumentEngine.loadDocument(target);
    } else {
      doc = await studyDocumentEngine.loadDocumentFromBuffer(target, filename || "document.pdf");
    }

    this._activeDocument = doc;
    this._currentPageNumber = 1;
    this._currentQuestionId = doc.pages[0]?.questions[0]?.id || null;
    this._currentSectionId = doc.pages[0]?.sections[0]?.id || null;
    this._sessionStartedAt = Date.now();
    this._lastActivityAt = Date.now();

    return doc;
  }

  getActiveDocument(): StudyDocument | null {
    return this._activeDocument;
  }

  closeDocument(): void {
    this._activeDocument = null;
    this._currentPageNumber = 1;
    this._currentQuestionId = null;
    this._currentSectionId = null;
    this._teachingMode.enabled = false;
  }

  // ---------------------------------------------------------------------------
  // Page Navigation & Tracking
  // ---------------------------------------------------------------------------

  /**
   * Sets current viewed page number (clamped to [1, pageCount]).
   */
  setCurrentPage(pageNumber: number): StudyPage {
    this._checkEmergencyStop();
    if (!this._activeDocument || this._activeDocument.pageCount === 0) {
      throw new Error("NO_ACTIVE_DOCUMENT: Please load a study document first.");
    }

    const clamped = Math.max(1, Math.min(this._activeDocument.pageCount, pageNumber));
    this._currentPageNumber = clamped;
    this._lastActivityAt = Date.now();

    const page = this.getCurrentPage()!;
    // Auto-focus first question on this page if present
    this._currentQuestionId = page.questions[0]?.id || null;
    this._currentSectionId = page.sections[0]?.id || null;

    return page;
  }

  nextPage(): StudyPage {
    return this.setCurrentPage(this._currentPageNumber + 1);
  }

  prevPage(): StudyPage {
    return this.setCurrentPage(this._currentPageNumber - 1);
  }

  getCurrentPage(): StudyPage | null {
    if (!this._activeDocument) return null;
    return this._activeDocument.pages[this._currentPageNumber - 1] || null;
  }

  // ---------------------------------------------------------------------------
  // Question & Section Tracking
  // ---------------------------------------------------------------------------

  setCurrentQuestion(questionId: string): DetectedQuestion | null {
    this._checkEmergencyStop();
    if (!this._activeDocument) return null;

    // Look for question across all pages or current page
    for (const page of this._activeDocument.pages) {
      const q = page.questions.find((quest) => quest.id === questionId);
      if (q) {
        this._currentPageNumber = q.pageNumber;
        this._currentQuestionId = q.id;
        this._lastActivityAt = Date.now();
        return q;
      }
    }

    return null;
  }

  getCurrentQuestion(): DetectedQuestion | null {
    if (!this._activeDocument || !this._currentQuestionId) return null;
    const page = this.getCurrentPage();
    if (!page) return null;
    return page.questions.find((q) => q.id === this._currentQuestionId) || null;
  }

  setCurrentSection(sectionId: string): void {
    this._checkEmergencyStop();
    this._currentSectionId = sectionId;
    this._lastActivityAt = Date.now();
  }

  // ---------------------------------------------------------------------------
  // Voice Teaching Mode
  // ---------------------------------------------------------------------------

  toggleTeachingMode(enabled: boolean, style?: TeachingStyle): TeachingModeConfig {
    this._checkEmergencyStop();
    this._teachingMode.enabled = enabled;
    if (style) {
      this._teachingMode.style = style;
    }
    this._lastActivityAt = Date.now();
    return { ...this._teachingMode };
  }

  getTeachingMode(): TeachingModeConfig {
    return { ...this._teachingMode };
  }

  isStudyModeActive(): boolean {
    return !!this._activeDocument && !this._isEmergencyStopped;
  }

  // ---------------------------------------------------------------------------
  // Emergency Stop Safeguard
  // ---------------------------------------------------------------------------

  emergencyStop(): void {
    this._isEmergencyStopped = true;
    this._teachingMode.enabled = false;
    interactiveTutor.emergencyStop();
    courseProfileManager.emergencyStop();
    studyResearchEngine.emergencyStop();
    console.warn("[StudySessionManager] EMERGENCY STOP ACTIVATED: Study session halted immediately.");
  }

  resetEmergencyStop(): void {
    this._isEmergencyStopped = false;
    courseProfileManager.resetEmergencyStop();
    studyResearchEngine.resetEmergencyStop();
  }

  private _checkEmergencyStop(): void {
    if (this._isEmergencyStopped || emergencyStopCoordinator.isActive()) {
      if (!emergencyStopCoordinator.isActive()) {
        this._isEmergencyStopped = false;
        return;
      }
      this._isEmergencyStopped = true;
      throw new Error(
        "EMERGENCY_STOP_ACTIVE: Study session operations are blocked while emergency stop is active.",
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Session Context Card for Gemini System Instructions
  // ---------------------------------------------------------------------------

  getSessionContext(): StudySessionContext {
    const activeDoc = this._activeDocument
      ? {
          id: this._activeDocument.id,
          title: this._activeDocument.title,
          filePath: this._activeDocument.filePath,
          pageCount: this._activeDocument.pageCount,
        }
      : null;

    const currentQ = this.getCurrentQuestion();
    const currentPage = this.getCurrentPage();
    const currentSec = currentPage?.sections.find((s) => s.id === this._currentSectionId);
    const progress = studyProgressTracker.getOverallProgress();
    const tutorState = interactiveTutor.getState();
    const courseProfile = courseProfileManager.getProfile();
    const dailySession = courseProfileManager.getDailySession();
    const academicProgress = courseProfileManager.calculateAcademicProgress();

    return {
      activeDocument: activeDoc,
      currentPageNumber: this._currentPageNumber,
      totalPages: this._activeDocument?.pageCount || 0,
      currentQuestion: currentQ
        ? {
            id: currentQ.id,
            questionNumber: currentQ.questionNumber,
            prompt: currentQ.prompt,
            isMultipleChoice: currentQ.isMultipleChoice,
            optionsCount: currentQ.options.length,
            hasDocumentAnswer: currentQ.answerMapping?.isDocumentProvided || false,
            answerSource: currentQ.answerMapping?.source || "unanswered",
            answerText: currentQ.answerMapping?.documentAnswerText,
          }
        : null,
      currentSection: currentSec
        ? {
            id: currentSec.id,
            title: currentSec.title,
            lineRange: `Lines ${currentSec.lineStart}-${currentSec.lineEnd}`,
          }
        : null,
      teachingMode: { ...this._teachingMode },
      tutorState,
      progressSummary: {
        totalAttempted: progress.totalAttempted,
        accuracyRate: progress.accuracyRate,
        weakTopics: progress.weakTopics,
      },
      courseProfile,
      dailySession,
      academicProgress,
      isStudyModeActive: this.isStudyModeActive(),
      sessionStartedAt: this._sessionStartedAt,
      lastActivityAt: this._lastActivityAt,
    };
  }

  /**
   * Formats a defensive Markdown context card injected into Gemini system instructions.
   * Untrusted document text is fenced in <<<UNTRUSTED_STUDY_CONTENT>>>.
   */
  buildStudyContextCard(): string {
    if (!this.isStudyModeActive() || !this._activeDocument) {
      return "";
    }

    const doc = this._activeDocument;
    const page = this.getCurrentPage();
    const q = this.getCurrentQuestion();
    const tutorState = interactiveTutor.getState();
    const progress = studyProgressTracker.getOverallProgress();

    const lines: string[] = [
      "=== REAL-TIME STUDY COMPANION CONTEXT ===",
      `Active Document: "${doc.title}" (File: ${doc.filePath}, Pages: ${doc.pageCount})`,
      `Current Viewing Position: Page ${this._currentPageNumber} of ${doc.pageCount}`,
    ];

    const profile = courseProfileManager.getProfile();
    const dailySession = courseProfileManager.getDailySession();
    if (profile && profile.courseName && profile.courseName !== "General Academic Studies") {
      lines.push(`Academic Course: "${profile.courseName}" (${profile.currentSemester})`);
      const academic = courseProfileManager.calculateAcademicProgress();
      lines.push(
        `Academic Readiness Score: ${academic.readinessScore}/100 (${academic.readinessLevel}) | Syllabus: ${academic.overallSyllabusCompletionPercentage}% complete`,
      );
    }
    if (dailySession && dailySession.targets.length > 0) {
      const completedCount = dailySession.targets.filter((t) => t.completed).length;
      lines.push(
        `Today's Study Targets: ${completedCount}/${dailySession.targets.length} completed (${dailySession.completedMinutes}/${dailySession.totalPlannedMinutes} mins)`,
      );
    }

    if (tutorState.mode !== "off") {
      lines.push(`\n=== INTERACTIVE TUTOR: ${tutorState.mode.toUpperCase()} MODE ACTIVE ===`);
      if (tutorState.mode === "exam" && tutorState.activeExam) {
        lines.push(
          `Exam Status: ${tutorState.activeExam.timeRemainingSeconds}s remaining | Current Marks: ${tutorState.activeExam.currentScore}/${tutorState.activeExam.totalMarks} | Total Questions Answered: ${tutorState.activeExam.questionsCount}`,
        );
      } else if (tutorState.mode === "viva" && tutorState.activeViva) {
        lines.push(
          `Viva Voce Question #${tutorState.activeViva.questionIndex} of ${tutorState.activeViva.totalQuestions} | Score: ${tutorState.activeViva.score} | Topic: "${tutorState.activeViva.topic}"`,
        );
      } else if (tutorState.mode === "revision" && tutorState.activeRevision) {
        lines.push(
          `Targeted Revision on Weak Topic: "${tutorState.activeRevision.topic}" (${tutorState.activeRevision.questionsToReview.length} questions flagged for review)`,
        );
      } else if (tutorState.mode === "practice") {
        lines.push("Practice Mode: Freely solving and verifying questions from active study document.");
      }
    }

    if (progress.weakTopics.length > 0) {
      lines.push(`Identified Weak Topics (Student struggled repeatedly): ${progress.weakTopics.join(", ")}`);
    }

    if (q) {
      lines.push(
        `Currently Focused Question: Question ${q.questionNumber} ("${q.prompt.slice(0, 150)}${q.prompt.length > 150 ? "..." : ""}")`,
      );
      if (q.isMultipleChoice) {
        const optsSummary = q.options.map((o) => `(${o.key}) ${o.text}`).join(" | ");
        lines.push(`  Options: ${optsSummary}`);
      }
      if (q.answerMapping?.isDocumentProvided && q.answerMapping.documentAnswerText) {
        lines.push(
          `  Explicit Document Answer: "${q.answerMapping.documentAnswerText}" (Confidence: 1.0)`,
        );
      } else {
        lines.push(
          `  Answer Attribution: No explicit answer key in document. Any solution must be model-tutored.`,
        );
      }
    }

    if (this._teachingMode.enabled) {
      lines.push(
        `Voice Teaching Mode: ACTIVE (Style: ${this._teachingMode.style}, Interactive: ${this._teachingMode.interactiveCheckins ? "Yes" : "No"})`,
      );
      lines.push(TeachingEngine.getVoiceTeachingDirectives(this._teachingMode));
    }

    if (page) {
      lines.push("\nCurrent Page Content (Untrusted External Document Data):");
      lines.push(UNTRUSTED_STUDY_FENCE_START);
      // Include first 1500 characters of current page
      lines.push(page.sanitizedText.slice(0, 1500));
      lines.push(UNTRUSTED_STUDY_FENCE_END);
    }

    lines.push("=========================================");
    return lines.join("\n");
  }
}

export const studySessionManager = new StudySessionManager();
