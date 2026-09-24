/**
 * MYRAA — Phase 9: AI Study Companion (Stage 3: AI Companion) Test Suite
 *
 * Comprehensive validation across:
 *   1. Course Profile Management (creation, update, persistence, reload)
 *   2. Syllabus Mapping (subjects, chapters, topics, completion status, recalculation)
 *   3. Personalized Adaptive Study Plan (milestones, weak-topic priority, hours scheduling)
 *   4. Daily Study Session Management (targets, completion, duration tracking, notes)
 *   5. Deterministic Academic Progress & Exam Readiness Score (formula, clamped [0,100], level thresholds)
 *   6. Educational Web Research & Untrusted Content Fencing (fenced, safe fallback)
 *   7. YouTube Video Resource Discovery (fenced, channel extraction, safe links)
 *   8. Previous Question Paper Pattern Analysis (PYQ parsing, high-yield detection, mark distributions)
 *   9. Weak-Topic Remedial Recommendations (StudyProgressTracker integration, action items)
 *  10. Emergency Stop Cascade & Fail-Closed Safeguards
 *  11. Tool Count Integrity (exactly 126 tools) & ToolOrchestrator Dispatch
 *  12. Context Card Integration (Course Profile & Readiness in System Prompt)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import { studyDocumentEngine } from "../StudyDocumentEngine.ts";
import { studySessionManager } from "../StudySessionManager.ts";
import { studyProgressTracker } from "../StudyProgressTracker.ts";
import { courseProfileManager } from "../CourseProfileManager.ts";
import { studyResearchEngine } from "../StudyResearchEngine.ts";
import { emergencyStopCoordinator } from "../../remote/EmergencyStopCoordinator.ts";
import { ToolOrchestrator } from "../../tools/ToolOrchestrator.ts";
import { LIVE_TOOLS } from "../../ai/GeminiSessionFactory.ts";
import {
  UNTRUSTED_STUDY_RESEARCH_START,
  UNTRUSTED_STUDY_RESEARCH_END,
} from "../StudyTypes.ts";

describe("Phase 9 — AI Study Companion: Stage 3 — AI Companion", () => {
  const workspaceRoot = path.resolve(process.cwd());
  const tempProfilePath = path.join(workspaceRoot, "temp_academic_profile_test.json");
  const sampleDocPath = path.join(workspaceRoot, "temp_companion_test_doc.txt");

  beforeEach(async () => {
    studyDocumentEngine.setWorkspaceRoot(workspaceRoot);
    courseProfileManager.setFilePath(tempProfilePath);
    courseProfileManager.clear();
    studyProgressTracker.clear();

    await emergencyStopCoordinator.reset("test-operator");
    studySessionManager.resetEmergencyStop();
    courseProfileManager.resetEmergencyStop();
    studyResearchEngine.resetEmergencyStop();

    // Create a mock previous question paper / study document
    const docContent = `=== PAGE 1 ===
Section 1: Kinematics and Mechanics
Question 1: Derive the expression for linear acceleration in uniform motion. (Marks: 5)
Ans: a = (v - u) / t.

Question 2: What is the relation between linear velocity and angular velocity? (Marks: 3)
Ans: v = r * omega.

=== PAGE 2 ===
Section 2: Thermodynamics
Question 3: State the Second Law of Thermodynamics and explain entropy. (Marks: 7)
Ans: Entropy of an isolated system always increases.

Question 4: Calculate the efficiency of a Carnot heat engine operating between 500K and 300K. (Marks: 5)
Ans: eta = 1 - (Tc / Th) = 1 - (300/500) = 40%.
`;
    await fs.writeFile(sampleDocPath, docContent, "utf-8");
    await studySessionManager.loadDocument("temp_companion_test_doc.txt");
  });

  afterEach(async () => {
    studySessionManager.closeDocument();
    courseProfileManager.clear();
    await emergencyStopCoordinator.reset("test-operator");
    studySessionManager.resetEmergencyStop();
    courseProfileManager.resetEmergencyStop();
    studyResearchEngine.resetEmergencyStop();
    await fs.unlink(tempProfilePath).catch(() => {});
    await fs.unlink(sampleDocPath).catch(() => {});
  });

  // ── 1. Course Profile Management ────────────────────────────────────────
  describe("1. Course Profile Management", () => {
    it("configures academic profile and retrieves defaults", () => {
      const initial = courseProfileManager.getProfile();
      expect(initial.courseName).toBeDefined();
      expect(initial.currentSemester).toBeDefined();

      const updated = courseProfileManager.setProfile({
        courseName: "B.Tech Computer Science & Engineering",
        currentSemester: "Semester 6",
        targetExam: "End-Term University Examination",
        targetExamDate: "2026-12-15",
        subjects: [
          { id: "sub-algo", name: "Design & Analysis of Algorithms", code: "CS301", credits: 4 },
          { id: "sub-os", name: "Operating Systems", code: "CS302", credits: 4 },
          { id: "sub-db", name: "Database Management Systems", code: "CS303", credits: 3 },
        ],
      });

      expect(updated.courseName).toBe("B.Tech Computer Science & Engineering");
      expect(updated.currentSemester).toBe("Semester 6");
      expect(updated.targetExam).toBe("End-Term University Examination");
      expect(updated.targetExamDate).toBe("2026-12-15");
      expect(updated.subjects.length).toBe(3);
      expect(updated.subjects[0].name).toBe("Design & Analysis of Algorithms");
    });

    it("persists academic profile across disk reload", () => {
      courseProfileManager.setProfile({
        courseName: "M.Sc Physics",
        currentSemester: "Semester 2",
        targetExam: "National Eligibility Test",
        subjects: [{ id: "sub-qm", name: "Quantum Mechanics" }],
      });

      // Re-hydrate from same file path
      const freshManager = new (courseProfileManager.constructor as any)(tempProfilePath);
      const retrieved = freshManager.getProfile();

      expect(retrieved.courseName).toBe("M.Sc Physics");
      expect(retrieved.currentSemester).toBe("Semester 2");
      expect(retrieved.targetExam).toBe("National Eligibility Test");
      expect(retrieved.subjects[0].name).toBe("Quantum Mechanics");
    });
  });

  // ── 2. Syllabus Mapping ──────────────────────────────────────────────────
  describe("2. Syllabus Mapping", () => {
    it("maps chapters and topics, calculating completion percentage", () => {
      const chapters = [
        {
          chapterNumber: 1,
          title: "Divide and Conquer",
          topics: [
            { id: "top-1-1", title: "Merge Sort", status: "completed" as const, estimatedHours: 2 },
            { id: "top-1-2", title: "Quick Sort", status: "not_started" as const, estimatedHours: 3 },
          ],
        },
        {
          chapterNumber: 2,
          title: "Dynamic Programming",
          topics: [
            { id: "top-2-1", title: "0/1 Knapsack", status: "not_started" as const, estimatedHours: 4 },
            { id: "top-2-2", title: "Longest Common Subsequence", status: "not_started" as const, estimatedHours: 3 },
          ],
        },
      ];

      const syllabus = courseProfileManager.mapSyllabus("sub-algo", "Algorithms", chapters);

      expect(syllabus.subjectId).toBe("sub-algo");
      expect(syllabus.chapters.length).toBe(2);
      expect(syllabus.totalTopics).toBe(4);
      expect(syllabus.completedTopics).toBe(1);
      expect(syllabus.completionPercentage).toBe(25); // 1 / 4 = 25%
    });

    it("updates topic completion status and recalculates syllabus progress", () => {
      courseProfileManager.mapSyllabus("sub-algo", "Algorithms", [
        {
          chapterNumber: 1,
          title: "Sorting",
          topics: [
            { id: "top-ms", title: "Merge Sort", status: "not_started" as const },
            { id: "top-qs", title: "Quick Sort", status: "not_started" as const },
          ],
        },
      ]);

      expect(courseProfileManager.getSyllabus("sub-algo")[0].completionPercentage).toBe(0);

      // Mark Merge Sort completed
      const updated = courseProfileManager.updateTopicStatus("sub-algo", "top-ms", "completed");
      expect(updated).toBe(true);

      const sylAfter = courseProfileManager.getSyllabus("sub-algo")[0];
      expect(sylAfter.completedTopics).toBe(1);
      expect(sylAfter.completionPercentage).toBe(50);

      // Mark Quick Sort in progress
      courseProfileManager.updateTopicStatus("sub-algo", "top-qs", "in_progress");
      const sylAfter2 = courseProfileManager.getSyllabus("sub-algo")[0];
      expect(sylAfter2.completedTopics).toBe(1);
      expect(sylAfter2.completionPercentage).toBe(50);
    });
  });

  // ── 3. Personalized Adaptive Study Plan ─────────────────────────────────
  describe("3. Personalized Study Plan Generation", () => {
    it("generates milestone-based study plan prioritizing weak topics and weightage", () => {
      // Record a weak topic in StudyProgressTracker
      studyProgressTracker.recordAttempt({
        questionId: "q-dp-1",
        topic: "Dynamic Programming",
        isCorrect: false,
        scoreAwarded: 0,
        maxMarks: 5,
        mode: "practice",
      });
      studyProgressTracker.recordAttempt({
        questionId: "q-dp-2",
        topic: "Dynamic Programming",
        isCorrect: false,
        scoreAwarded: 0,
        maxMarks: 5,
        mode: "practice",
      });
      expect(studyProgressTracker.getWeakTopics()).toContain("Dynamic Programming");

      // Setup syllabus with multiple topics
      courseProfileManager.mapSyllabus("sub-algo", "Algorithms", [
        {
          chapterNumber: 1,
          title: "Basics",
          topics: [
            { id: "top-bs", title: "Binary Search", status: "not_started" as const, estimatedHours: 2, weightage: 1 },
            { id: "top-dp", title: "Dynamic Programming Foundations", status: "not_started" as const, estimatedHours: 3, weightage: 2 },
            { id: "top-gr", title: "Greedy Algorithms", status: "not_started" as const, estimatedHours: 2, weightage: 3 },
          ],
        },
      ]);

      const plan = courseProfileManager.generateStudyPlan({
        dailyHours: 4,
        targetExamDate: "2026-11-20",
        planName: "Algorithms Intensive Mastery Plan",
      });

      expect(plan.id).toBeDefined();
      expect(plan.planName).toBe("Algorithms Intensive Mastery Plan");
      expect(plan.milestones.length).toBe(3);

      // Weak topic must be scheduled first
      expect(plan.milestones[0].isPriorityWeakTopic).toBe(true);
      expect(plan.milestones[0].topicTitle).toContain("Dynamic Programming");

      // Verify retrieval
      const fetched = courseProfileManager.getStudyPlan();
      expect(fetched?.id).toBe(plan.id);
    });
  });

  // ── 4. Daily Study Sessions ──────────────────────────────────────────────
  describe("4. Daily Study Sessions", () => {
    it("creates, tracks targets, and completes today's daily session", () => {
      const session = courseProfileManager.createOrGetDailySession(undefined, [
        {
          id: "tgt-1",
          subjectName: "Algorithms",
          topicTitle: "Dynamic Programming",
          goal: "Solve 3 0/1 Knapsack problems",
          durationMinutes: 45,
          completed: false,
        },
        {
          id: "tgt-2",
          subjectName: "Operating Systems",
          topicTitle: "Deadlocks",
          goal: "Revise Banker's Algorithm",
          durationMinutes: 30,
          completed: false,
        },
      ]);

      expect(session.targets.length).toBe(2);
      expect(session.totalPlannedMinutes).toBe(75);
      expect(session.completedMinutes).toBe(0);
      expect(session.status).toBe("planned");

      // Mark target 1 completed
      const afterTgt1 = courseProfileManager.updateDailyTarget("tgt-1", true);
      expect(afterTgt1.completedMinutes).toBe(45);
      expect(afterTgt1.status).toBe("active");

      // Complete session
      const completed = courseProfileManager.completeDailySession("Covered knapsack recurrence and banker proof.");
      expect(completed.status).toBe("completed");
      expect(completed.completedMinutes).toBe(75);
      expect(completed.targets.every((t) => t.completed)).toBe(true);
      expect(completed.notes).toContain("knapsack recurrence");
    });
  });

  // ── 5. Deterministic Academic Progress & Exam Readiness Score ───────────
  describe("5. Deterministic Academic Progress & Exam Readiness Score", () => {
    it("calculates readiness score according to deterministic formula", () => {
      // Setup syllabus: 2 topics, 1 completed -> S = 50%
      courseProfileManager.mapSyllabus("sub-test", "Physics", [
        {
          chapterNumber: 1,
          title: "Mechanics",
          topics: [
            { id: "top-1", title: "Motion", status: "completed" as const },
            { id: "top-2", title: "Energy", status: "not_started" as const },
          ],
        },
      ]);

      // Progress Tracker: 4 attempts, 3 correct -> A = 75%, 0 weak topics -> W = 0
      studyProgressTracker.recordAttempt({ questionId: "q-m-1", topic: "Motion", isCorrect: true, scoreAwarded: 5, maxMarks: 5, mode: "practice" });
      studyProgressTracker.recordAttempt({ questionId: "q-m-2", topic: "Motion", isCorrect: true, scoreAwarded: 5, maxMarks: 5, mode: "practice" });
      studyProgressTracker.recordAttempt({ questionId: "q-m-3", topic: "Motion", isCorrect: true, scoreAwarded: 5, maxMarks: 5, mode: "practice" });
      studyProgressTracker.recordAttempt({ questionId: "q-m-4", topic: "Motion", isCorrect: false, scoreAwarded: 0, maxMarks: 5, mode: "practice" });

      // Complete 2 daily study sessions -> D = min(15, 2 * 3) = 6
      courseProfileManager.createOrGetDailySession("2026-09-18");
      courseProfileManager.completeDailySession("Day 1 done", "2026-09-18");

      courseProfileManager.createOrGetDailySession("2026-09-19");
      courseProfileManager.completeDailySession("Day 2 done", "2026-09-19");

      // Expected base score:
      // S = 50
      // A = 75
      // W = 0
      // D = 6
      // baseScore = (0.5 * 50) + (0.35 * 75) + 6 - 0 = 25 + 26.25 + 6 = 57.25 -> round = 57
      const progress = courseProfileManager.calculateAcademicProgress();

      expect(progress.overallSyllabusCompletionPercentage).toBe(50);
      expect(progress.overallQuestionAccuracy).toBe(75);
      expect(progress.totalDailySessionsCompleted).toBe(2);
      expect(progress.readinessScore).toBe(57);
      expect(progress.readinessLevel).toBe("developing");
    });

    it("evaluates high readiness (>= 75) as 'exam_ready'", () => {
      // Syllabus: 100% complete -> S = 100
      courseProfileManager.mapSyllabus("sub-math", "Math", [
        {
          chapterNumber: 1,
          title: "Calculus",
          topics: [{ id: "top-calc", title: "Integration", status: "completed" as const, estimatedHours: 2 }],
        },
      ]);

      // 5 correct attempts -> A = 100%
      for (let i = 0; i < 5; i++) {
        studyProgressTracker.recordAttempt({ questionId: `q-c-${i}`, topic: "Calculus", isCorrect: true, scoreAwarded: 5, maxMarks: 5, mode: "practice" });
      }

      // 5 completed daily sessions -> D = 15
      for (let i = 1; i <= 5; i++) {
        const d = `2026-08-0${i}`;
        courseProfileManager.createOrGetDailySession(d);
        courseProfileManager.completeDailySession("Done", d);
      }

      // BaseScore = (0.5 * 100) + (0.35 * 100) + 15 - 0 = 50 + 35 + 15 = 100
      const progress = courseProfileManager.calculateAcademicProgress();
      expect(progress.readinessScore).toBe(100);
      expect(progress.readinessLevel).toBe("exam_ready");
    });

    it("evaluates low readiness (< 45) as 'needs_focus' with weak topic penalty", () => {
      // 0% syllabus complete -> S = 0
      courseProfileManager.mapSyllabus("sub-chem", "Chemistry", [
        {
          chapterNumber: 1,
          title: "Organic",
          topics: [{ id: "top-org", title: "Aldehydes", status: "not_started" as const, estimatedHours: 2 }],
        },
      ]);

      // 3 weak topics -> W = min(30, 3 * 10) = 30
      studyProgressTracker.recordAttempt({ questionId: "q-a1", topic: "TopicA", isCorrect: false, scoreAwarded: 0, maxMarks: 5, mode: "practice" });
      studyProgressTracker.recordAttempt({ questionId: "q-a2", topic: "TopicA", isCorrect: false, scoreAwarded: 0, maxMarks: 5, mode: "practice" });
      studyProgressTracker.recordAttempt({ questionId: "q-b1", topic: "TopicB", isCorrect: false, scoreAwarded: 0, maxMarks: 5, mode: "practice" });
      studyProgressTracker.recordAttempt({ questionId: "q-b2", topic: "TopicB", isCorrect: false, scoreAwarded: 0, maxMarks: 5, mode: "practice" });
      studyProgressTracker.recordAttempt({ questionId: "q-c1", topic: "TopicC", isCorrect: false, scoreAwarded: 0, maxMarks: 5, mode: "practice" });
      studyProgressTracker.recordAttempt({ questionId: "q-c2", topic: "TopicC", isCorrect: false, scoreAwarded: 0, maxMarks: 5, mode: "practice" });

      const progress = courseProfileManager.calculateAcademicProgress();
      expect(progress.currentWeakTopicsCount).toBe(3);
      expect(progress.readinessScore).toBe(0); // Clamped at 0
      expect(progress.readinessLevel).toBe("needs_focus");
    });
  });

  // ── 6. Educational Web Research & Untrusted Content Fencing ───────────────
  describe("6. Educational Web Research & Untrusted Content Fencing", () => {
    it("returns structured research result marked as untrusted", async () => {
      const res = await studyResearchEngine.researchStudyTopic("Fourier Transform", {
        subject: "Signals and Systems",
        maxResults: 3,
      });

      expect(res.topic).toBe("Fourier Transform");
      expect(res.isUntrusted).toBe(true);
      expect(res.summary).toBeDefined();
      expect(Array.isArray(res.resources)).toBe(true);
      expect(res.resources.length).toBeGreaterThan(0);
      expect(res.resources[0].sourceType).toBe("web");
      expect(res.resources[0].educationalRelevance).toBeDefined();
    });

    it("rejects empty topic search query", async () => {
      await expect(studyResearchEngine.researchStudyTopic("")).rejects.toThrow(/EMPTY_QUERY/);
    });
  });

  // ── 7. YouTube Video Resource Discovery ──────────────────────────────────
  describe("7. YouTube Video Resource Discovery", () => {
    it("discovers educational YouTube videos fenced inside untrusted markers", async () => {
      const res = await studyResearchEngine.discoverStudyVideos("Newtonian Mechanics", {
        subject: "Physics",
        maxResults: 4,
      });

      expect(res.topic).toBe("Newtonian Mechanics");
      expect(res.isUntrusted).toBe(true);
      expect(Array.isArray(res.videos)).toBe(true);
      expect(res.videos.length).toBeGreaterThan(0);
      expect(res.videos[0].sourceType).toBe("youtube");

      // Verify strict untrusted fencing
      expect(res.fencedSummary).toContain(UNTRUSTED_STUDY_RESEARCH_START);
      expect(res.fencedSummary).toContain(UNTRUSTED_STUDY_RESEARCH_END);
    });
  });

  // ── 8. Previous Question Paper Pattern Analysis ──────────────────────────
  describe("8. Previous Question Paper Pattern Analysis", () => {
    it("analyzes question papers, identifying high-yield topics and mark distributions", async () => {
      // Analyze from the active loaded document (sampleDocPath)
      const analysis = await studyResearchEngine.analyzePreviousQuestions({
        paperTitle: "Mid-Term Physics 2025",
      });

      expect(analysis.paperTitle).toBe("Mid-Term Physics 2025");
      expect(analysis.totalQuestionsAnalyzed).toBe(4);
      expect(analysis.highYieldTopics.length).toBeGreaterThan(0);

      // Verify mark distributions exist
      expect(Object.keys(analysis.markDistributionByTopic).length).toBeGreaterThan(0);
      expect(analysis.predictedExamFocus.length).toBeGreaterThan(0);
      expect(analysis.suggestedActionPlan).toContain("high-yield focus");
    });

    it("analyzes raw question paper text if provided", async () => {
      const rawText = `
Question 1: What is kinetic energy? (Marks: 2)
Question 2: State the work-energy theorem. (Marks: 6)
Question 3: A particle moves with velocity v. Find momentum. (Marks: 4)
`;
      const analysis = await studyResearchEngine.analyzePreviousQuestions({
        rawText,
        paperTitle: "Class Test 1",
      });

      expect(analysis.totalQuestionsAnalyzed).toBe(3);
      expect(analysis.paperTitle).toBe("Class Test 1");
    });
  });

  // ── 9. Weak-Topic Recommendations ─────────────────────────────────────────
  describe("9. Weak-Topic Remedial Recommendations", () => {
    it("generates actionable study recommendations for weak topics", () => {
      // Introduce a weak topic: Kinematics (fails 2 times)
      studyProgressTracker.recordAttempt({
        questionId: "q-k-1",
        topic: "Kinematics",
        isCorrect: false,
        scoreAwarded: 0,
        maxMarks: 5,
        mode: "practice",
      });
      studyProgressTracker.recordAttempt({
        questionId: "q-k-2",
        topic: "Kinematics",
        isCorrect: false,
        scoreAwarded: 0,
        maxMarks: 5,
        mode: "practice",
      });

      const recommendations = studyResearchEngine.getWeakTopicRecommendations();
      expect(recommendations.length).toBe(1);

      const rec = recommendations[0];
      expect(rec.topic).toBe("Kinematics");
      expect(rec.accuracyRate).toBe(0);
      expect(rec.failureReason).toContain("Repeated errors");
      expect(rec.recommendedStudyActions.length).toBeGreaterThan(0);
      expect(rec.suggestedSearchQuery).toContain("Kinematics");
      expect(rec.suggestedVideoQuery).toContain("Kinematics");

      // Should find document reference on page 1 of active document
      expect(rec.curatedDocReferences).toBeDefined();
      expect(rec.curatedDocReferences![0]).toContain("Page 1");
    });
  });

  // ── 10. Emergency Stop Cascade & Fail-Closed Behavior ─────────────────────
  describe("10. Emergency Stop Cascade", () => {
    it("blocks course profile and study research operations while Emergency Stop is active", async () => {
      await emergencyStopCoordinator.trigger({
        source: "desktop_ui",
        reason: "Operator Emergency Test",
      });

      expect(() => {
        courseProfileManager.setProfile({ courseName: "Blocked Operation" });
      }).toThrow(/EMERGENCY_STOP_ACTIVE/);

      expect(() => {
        courseProfileManager.mapSyllabus("sub", "Sub", []);
      }).toThrow(/EMERGENCY_STOP_ACTIVE/);

      await expect(
        studyResearchEngine.researchStudyTopic("Blocked Topic"),
      ).rejects.toThrow(/EMERGENCY_STOP_ACTIVE/);

      await expect(
        studyResearchEngine.discoverStudyVideos("Blocked Videos"),
      ).rejects.toThrow(/EMERGENCY_STOP_ACTIVE/);
    });

    it("resumes functionality after Emergency Stop is cleared", async () => {
      await emergencyStopCoordinator.trigger({
        source: "desktop_ui",
        reason: "Operator Emergency Test",
      });
      await emergencyStopCoordinator.reset("test-operator");
      courseProfileManager.resetEmergencyStop();
      studyResearchEngine.resetEmergencyStop();

      const profile = courseProfileManager.setProfile({ courseName: "Resume Test" });
      expect(profile.courseName).toBe("Resume Test");
    });
  });

  // ── 11. Tool Count Integrity & ToolOrchestrator Dispatch ──────────────────
  describe("11. Tool Count & Orchestrator Dispatch Layer", () => {
    it("has exactly 126 tools declared in Gemini Live Tools (104 baseline + 7 Stage 1 + 6 Stage 2 + 9 Stage 3)", () => {
      expect(LIVE_TOOLS).toBeDefined();
      const tools = LIVE_TOOLS[0].functionDeclarations;
      expect(Array.isArray(tools)).toBe(true);
      // Strict Architecture Rule: exactly 126 runtime tools
      expect(tools.length).toBe(126);
    });

    it("includes all 9 Stage 3 AI companion tools in LIVE_TOOLS", () => {
      const tools = LIVE_TOOLS[0].functionDeclarations;
      const toolNames = tools.map((t: any) => t.name);

      expect(toolNames).toContain("configureCourseProfile");
      expect(toolNames).toContain("manageSyllabus");
      expect(toolNames).toContain("researchStudyTopic");
      expect(toolNames).toContain("discoverStudyVideos");
      expect(toolNames).toContain("analyzePreviousQuestions");
      expect(toolNames).toContain("generatePersonalizedStudyPlan");
      expect(toolNames).toContain("getStudyRecommendations");
      expect(toolNames).toContain("manageDailyStudySession");
      expect(toolNames).toContain("getAcademicProgress");
    });

    it("dispatches configureCourseProfile through ToolOrchestrator", async () => {
      const orchestrator = new ToolOrchestrator();
      let sentPayload: any = null;
      let broadcastEvent: any = null;

      const mockSession = {
        sendToolResponse: (payload: any) => {
          sentPayload = payload;
        },
      };

      await orchestrator.dispatch(
        {
          name: "configureCourseProfile",
          args: {
            courseName: "B.Tech Electrical Engineering",
            currentSemester: "Semester 5",
            targetExam: "GATE 2027",
          },
          id: "call-profile-1",
        },
        mockSession as any,
        (evt: any) => {
          broadcastEvent = evt;
        },
        "mock-api-key",
      );

      expect(sentPayload).toBeDefined();
      const resp = sentPayload.functionResponses[0].response.output;
      expect(resp.configured).toBe(true);
      expect(resp.profile.courseName).toBe("B.Tech Electrical Engineering");
      expect(broadcastEvent.type).toBe("study_event");
      expect(broadcastEvent.event).toBe("course_profile_configured");
    });

    it("dispatches getAcademicProgress through ToolOrchestrator", async () => {
      const orchestrator = new ToolOrchestrator();
      let sentPayload: any = null;

      const mockSession = {
        sendToolResponse: (payload: any) => {
          sentPayload = payload;
        },
      };

      await orchestrator.dispatch(
        {
          name: "getAcademicProgress",
          args: {},
          id: "call-progress-1",
        },
        mockSession as any,
        () => {},
        "mock-api-key",
      );

      expect(sentPayload).toBeDefined();
      const resp = sentPayload.functionResponses[0].response.output;
      expect(resp.overallSyllabusCompletionPercentage).toBeDefined();
      expect(resp.readinessScore).toBeDefined();
      expect(resp.readinessLevel).toBeDefined();
    });
  });

  // ── 12. Context Card Integration ──────────────────────────────────────────
  describe("12. Context Card Integration", () => {
    it("incorporates course profile and academic readiness into Study Session Context Card", () => {
      courseProfileManager.setProfile({
        courseName: "Automotive Engineering",
        currentSemester: "Semester 7",
        targetExam: "Final Thesis",
      });

      const card = studySessionManager.buildStudyContextCard();
      expect(card).toContain("Automotive Engineering");
      expect(card).toContain("Semester 7");
      expect(card).toContain("Readiness Score");
    });
  });
});
