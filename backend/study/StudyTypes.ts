/**
 * MYRAA — StudyTypes (Phase 9 — AI Study Companion: Stage 1)
 *
 * Core type definitions, contracts, and safety boundaries for the Study Document Engine:
 *   - Document, Page, and Section representations
 *   - Question detection & Question-to-Answer mapping (strictly distinguishing
 *     document-provided answers from model-inferred explanations)
 *   - Diagram detection & visual explanation
 *   - Line-by-line & section-by-section tutoring contracts
 *   - Live Study Session tracking for real-time Gemini awareness
 *   - Prompt injection defense boundary fences: <<<UNTRUSTED_STUDY_CONTENT>>>
 */

// ---------------------------------------------------------------------------
// Security & Size Bounds (Preserves Phase 8 Safeguards)
// ---------------------------------------------------------------------------

export const MAX_STUDY_DOC_BYTES = 25 * 1024 * 1024;        // 25 MB max document limit
export const MAX_STUDY_DECOMPRESSED_BYTES = 5 * 1024 * 1024;// 5 MB zip-bomb prevention limit
export const MAX_PAGE_TEXT_CHARS = 30000;                   // Maximum characters retained per page
export const MAX_STUDY_PAGES = 500;                         // Maximum pages allowed in a single document

export const UNTRUSTED_STUDY_FENCE_START = "<<<UNTRUSTED_STUDY_CONTENT>>>";
export const UNTRUSTED_STUDY_FENCE_END = "<<</UNTRUSTED_STUDY_CONTENT>>>";

// ---------------------------------------------------------------------------
// Document & Page Contracts
// ---------------------------------------------------------------------------

export type StudyDocumentType = "pdf" | "markdown" | "text";

export interface StudySection {
  id: string;
  title: string;
  lineStart: number;
  lineEnd: number;
  content: string;
  summary?: string;
}

export interface StudyPage {
  pageNumber: number;               // 1-based index
  text: string;
  sanitizedText: string;            // Stripped of null-bytes and potential escape exploits
  lines: string[];
  sections: StudySection[];
  questions: DetectedQuestion[];
  diagrams: DetectedDiagram[];
  characterCount: number;
  lineCount: number;
}

export interface StudyDocument {
  id: string;
  title: string;
  filePath: string;
  fileType: StudyDocumentType;
  pageCount: number;
  pages: StudyPage[];
  totalQuestions: number;
  totalDiagrams: number;
  characterCount: number;
  loadedAt: number;
  isUntrusted: true;                // Always true for external documents
}

// ---------------------------------------------------------------------------
// Question Detection & Answer Mapping Contracts
// ---------------------------------------------------------------------------

export type AnswerSource = "document" | "model_inferred" | "unanswered";

export interface QuestionOption {
  key: string;                      // "A", "B", "C", "D" or "a", "b", etc.
  text: string;
}

export interface DetectedQuestion {
  id: string;                       // e.g. "q-p1-1"
  pageNumber: number;
  questionNumber: number;
  rawHeader: string;                // e.g. "Question 1:", "Q. 3", "1."
  prompt: string;                   // The question statement
  options: QuestionOption[];        // Extracted MCQ options (if any)
  isMultipleChoice: boolean;
  marks?: number;
  lineStart: number;
  lineEnd: number;
  answerMapping?: QuestionAnswerMapping;
}

export interface QuestionAnswerMapping {
  questionId: string;
  source: AnswerSource;             // "document" vs "model_inferred"
  isDocumentProvided: boolean;      // True ONLY if explicit answer key found in document text
  documentAnswerText?: string;      // Exact solution string from document (e.g. "Ans: (B)")
  inferredAnswer?: string;          // Model-generated solution/explanation if not in doc
  confidence: number;               // 1.0 for explicit document answer, 0.0 - 0.95 for inferred
  explanationNote: string;          // Clear attribution note to student
}

// ---------------------------------------------------------------------------
// Diagram Detection & Visual Explanation Contracts
// ---------------------------------------------------------------------------

export type DiagramCategory =
  | "chart"
  | "flowchart"
  | "schematic"
  | "geometric"
  | "anatomical"
  | "data_plot"
  | "generic_illustration";

export interface DetectedDiagram {
  id: string;                       // e.g. "diag-p2-1"
  pageNumber: number;
  figureLabel: string;              // e.g. "Figure 2.1", "Fig. 3"
  caption: string;                  // Extracted caption or figure description
  category: DiagramCategory;
  surroundingContext: string;       // Text before and after figure
  hasVisualCapture: boolean;        // True if screen/vision snapshot captured
  visualFrameBase64?: string;       // Optional cropped or active screen frame
  visualComponents: string[];       // Detected labels, axes, legends, annotations
}

export interface DiagramExplanation {
  diagramId: string;
  figureLabel: string;
  category: DiagramCategory;
  conceptualTopic: string;
  educationalTakeaway: string;
  componentBreakdown: Array<{ component: string; meaning: string }>;
  visualContextUsed: boolean;       // True if actual visual context/OCR was analyzed
  pedagogicalTip: string;
}

// ---------------------------------------------------------------------------
// Line-by-Line & Section Explanation Contracts
// ---------------------------------------------------------------------------

export interface LineExplanationResult {
  documentId: string;
  pageNumber: number;
  lineNumber: number;
  targetLine: string;
  explanation: string;
  keyTerms: Array<{ term: string; definition: string }>;
  comprehensionCheck: string;       // Checking question in Myraa's gentle tutor voice
  hasMoreLines: boolean;
  nextLineNumber?: number;
}

export interface SectionExplanationResult {
  documentId: string;
  pageNumber: number;
  sectionId: string;
  sectionTitle: string;
  conceptOverview: string;
  stepByStepPoints: string[];
  realWorldAnalogy?: string;
  keyFormulaOrRule?: string;
  comprehensionCheck: string;
}

// ---------------------------------------------------------------------------
// Voice Teaching Mode & Study Session State
// ---------------------------------------------------------------------------

export type TeachingStyle = "step_by_step" | "socratic" | "quick_review";

export interface TeachingModeConfig {
  enabled: boolean;                 // Disabled by default (preserves normal assistant behavior)
  style: TeachingStyle;
  interactiveCheckins: boolean;     // Whether Myraa gently asks "Did that make sense?"
  preferredLanguage: "hinglish" | "english";
}

export interface StudySessionContext {
  activeDocument: {
    id: string;
    title: string;
    filePath: string;
    pageCount: number;
  } | null;
  currentPageNumber: number;
  totalPages: number;
  currentQuestion: {
    id: string;
    questionNumber: number;
    prompt: string;
    isMultipleChoice: boolean;
    optionsCount: number;
    hasDocumentAnswer: boolean;
    answerSource: AnswerSource;
    answerText?: string;
  } | null;
  currentSection: {
    id: string;
    title: string;
    lineRange: string;
  } | null;
  teachingMode: TeachingModeConfig;
  tutorState?: InteractiveTutorState;
  progressSummary?: {
    totalAttempted: number;
    accuracyRate: number;
    weakTopics: string[];
  };
  courseProfile?: CourseProfile;
  dailySession?: DailyStudySession | null;
  academicProgress?: AcademicProgressSummary;
  isStudyModeActive: boolean;
  sessionStartedAt: number;
  lastActivityAt: number;
}

// ---------------------------------------------------------------------------
// Phase 9 — Stage 2: Interactive Tutor Contracts
// ---------------------------------------------------------------------------

export type TutorMode = "exam" | "viva" | "practice" | "revision" | "off";

export interface ExamConfig {
  timeLimitMinutes?: number;        // e.g. 15 minutes, or undefined for untimed
  durationMinutes?: number;         // alias
  totalMarks?: number;              // Target total marks for the test
  passingMarks?: number;            // Minimum passing score
  strictMarking?: boolean;          // Strict evaluation criteria
}

export interface VivaConfig {
  topic?: string;
  focusTopic?: string;              // alias
  difficulty?: "basic" | "intermediate" | "advanced" | "easy" | "medium" | "hard";
  oralFeedbackOnly?: boolean;
}

export interface InteractiveTutorState {
  mode: TutorMode;
  activeExam?: {
    startTime: number;
    timeLimitSeconds: number;
    timeRemainingSeconds: number;
    totalMarks: number;
    currentScore: number;
    questionsCount: number;
    isTimedOut: boolean;
  };
  activeViva?: {
    questionIndex: number;
    totalQuestions: number;
    score: number;
    currentQuestionPrompt: string;
    topic: string;
    difficulty?: string;
    focusTopic?: string;
  };
  activeRevision?: {
    topic: string;
    questionsToReview: string[];
    currentIndex: number;
  };
}

export interface StudentAnswerSubmission {
  questionId: string;
  studentAnswer: string;
  timeTakenSeconds?: number;
}

export interface AnswerEvaluationResult {
  questionId: string;
  isCorrect: boolean;
  scoreAwarded: number;
  maxMarks: number;
  feedback: string;
  modelSolution: string;
  source: AnswerSource;             // "document" vs "model_inferred"
  topic: string;
  isWeakTopic: boolean;
  vivaFollowUpQuestion?: string;
  timeTakenSeconds?: number;
}

export interface QuestionAttemptRecord {
  id: string;
  questionId: string;
  topic: string;
  studentAnswer: string;
  isCorrect: boolean;
  scoreAwarded: number;
  maxMarks: number;
  attemptedAt: number;
  mode: TutorMode;
}

export interface TopicProgress {
  topic: string;
  attempted: number;
  correct: number;
  incorrect: number;
  accuracy: number;                 // Percentage (0 - 100)
  isWeak: boolean;                  // Deterministic: incorrect >= 2 OR accuracy < 60% (with attempted >= 2)
  lastAttemptedAt: number;
}

export interface OverallStudyProgress {
  totalAttempted: number;
  totalCorrect: number;
  totalIncorrect: number;
  accuracyRate: number;             // Percentage (0 - 100)
  overallAccuracyRate?: number;     // compatibility alias
  totalScore: number;
  maxPossibleScore: number;
  topicsCovered: TopicProgress[];
  weakTopics: string[];             // List of topic names where isWeak === true
  completedExamSessions: number;
  completedVivaSessions: number;
  lastUpdated: number;
}

export interface PageNavigationResult {
  success: boolean;
  targetType: "question" | "diagram" | "page";
  targetId?: string;
  targetPageNumber: number;
  previousPageNumber: number;
  highlightSnippet?: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Phase 9 — Stage 3: AI Companion Contracts
// ---------------------------------------------------------------------------

export const UNTRUSTED_STUDY_RESEARCH_START = "<<<UNTRUSTED_STUDY_RESEARCH>>>";
export const UNTRUSTED_STUDY_RESEARCH_END = "<<</UNTRUSTED_STUDY_RESEARCH>>>";

// 1. Course Profile & Subject Configuration
export interface CourseSubject {
  id: string;                       // e.g. "sub-cs101"
  name: string;                     // e.g. "Data Structures & Algorithms"
  code?: string;                    // e.g. "CS201"
  credits?: number;
  color?: string;
}

export interface CourseProfile {
  courseName: string;               // e.g. "B.Tech Computer Science"
  currentSemester: string;          // e.g. "Semester 4"
  targetExam?: string;              // e.g. "University Finals - May 2026"
  targetExamDate?: string;          // ISO date string
  subjects: CourseSubject[];
  createdAt: number;
  lastUpdated: number;
}

// 2. Syllabus Mapping
export type TopicCompletionStatus = "not_started" | "in_progress" | "completed";

export interface SyllabusTopic {
  id?: string;                      // e.g. "top-dsa-trees"
  title: string;                    // e.g. "Binary Search Trees & AVL Trees"
  status?: TopicCompletionStatus;
  estimatedHours?: number;
  weightage?: number;               // 1-5 or marks weightage
  mappedDocIds?: string[];          // References to loaded StudyDocuments
}

export interface SyllabusChapter {
  id?: string;                      // e.g. "chap-dsa-1"
  chapterNumber?: number;
  title: string;
  topics: SyllabusTopic[];
}

export interface SubjectSyllabus {
  subjectId: string;
  subjectName: string;
  chapters: SyllabusChapter[];
  totalTopics: number;
  completedTopics: number;
  completionPercentage: number;     // 0 - 100
}

// 3. Personalized Study Plan
export interface StudyPlanMilestone {
  id: string;
  targetDate: string;               // YYYY-MM-DD
  subjectId: string;
  subjectName: string;
  topicId: string;
  topicTitle: string;
  estimatedMinutes: number;
  isPriorityWeakTopic: boolean;
  completed: boolean;
}

export interface PersonalizedStudyPlan {
  id: string;
  planName: string;
  generatedAt: number;
  targetExamDate?: string;
  dailyAvailableHours: number;
  milestones: StudyPlanMilestone[];
  overallProgressPercentage: number;
}

// 4. Daily Study Session
export interface DailySessionTarget {
  id: string;
  subjectName: string;
  topicTitle: string;
  goal: string;                     // e.g. "Solve 10 practice questions and review binary trees"
  durationMinutes: number;
  completed: boolean;
}

export interface DailyStudySession {
  date: string;                     // YYYY-MM-DD
  targets: DailySessionTarget[];
  totalPlannedMinutes: number;
  completedMinutes: number;
  status: "planned" | "active" | "completed";
  notes?: string;
}

// 5. Educational Web & YouTube Research
export interface StudyResourceItem {
  title: string;
  url: string;
  snippet: string;
  sourceType: "web" | "youtube";
  educationalRelevance: string;     // e.g. "Covers derivation of Bernoulli's theorem"
  channelName?: string;             // For YouTube
}

export interface StudyResearchResult {
  topic: string;
  summary: string;
  resources: StudyResourceItem[];
  timestamp: number;
  isUntrusted: true;
}

// 6. Previous Question Paper Analysis
export interface HighYieldTopic {
  topic: string;
  frequency: number;                // Times appeared across papers
  averageMarks: number;
  recurringQuestionSamples: string[];
  recommendation: string;
}

export interface PreviousQuestionAnalysis {
  paperTitle: string;
  totalQuestionsAnalyzed: number;
  highYieldTopics: HighYieldTopic[];
  markDistributionByTopic: Record<string, number>;
  predictedExamFocus: string[];
  suggestedActionPlan: string;
}

// 7. Weak-Topic Recommendations
export interface WeakTopicRecommendation {
  topic: string;
  accuracyRate: number;
  failureReason: string;            // e.g. "Accuracy below 60% with repeated errors"
  recommendedStudyActions: string[];
  curatedDocReferences?: string[];
  suggestedSearchQuery: string;
  suggestedVideoQuery: string;
}

// 8. Long-Term Academic Progress
export interface AcademicProgressSummary {
  courseName: string;
  currentSemester: string;
  overallSyllabusCompletionPercentage: number;
  subjectsProgress: Array<{
    subjectId: string;
    subjectName: string;
    completionPercentage: number;
    totalTopics: number;
    completedTopics: number;
  }>;
  totalQuestionsAttempted: number;
  overallQuestionAccuracy: number;
  currentWeakTopicsCount: number;
  weakTopics: string[];
  totalDailySessionsCompleted: number;
  readinessScore: number;           // 0 - 100 deterministic composite score
  readinessLevel: "needs_focus" | "developing" | "exam_ready";
}


