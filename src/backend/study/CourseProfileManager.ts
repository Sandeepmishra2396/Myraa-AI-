/**
 * MYRAA — CourseProfileManager (Phase 9 — Stage 3: AI Companion)
 *
 * Coordinates long-term academic tracking, course profiles, syllabus mapping,
 * personalized study plans, daily study sessions, and deterministic readiness scoring.
 *
 * Persistence: Saves all academic records to academic_profile.json in the app data directory.
 * Failsafe: Re-hydrates state safely across restarts; respects emergency stop killswitch.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { dataFile } from "../../../server_paths.ts";
import {
  CourseProfile,
  CourseSubject,
  SubjectSyllabus,
  SyllabusChapter,
  TopicCompletionStatus,
  PersonalizedStudyPlan,
  StudyPlanMilestone,
  DailyStudySession,
  DailySessionTarget,
  AcademicProgressSummary,
} from "./StudyTypes.ts";
import { studyProgressTracker } from "./StudyProgressTracker.ts";
import { emergencyStopCoordinator } from "../remote/EmergencyStopCoordinator.ts";

export class CourseProfileManager {
  private _filePath: string;
  private _profile: CourseProfile;
  private _syllabi: Map<string, SubjectSyllabus> = new Map();
  private _studyPlan: PersonalizedStudyPlan | null = null;
  private _dailySessions: Map<string, DailyStudySession> = new Map(); // Keyed by YYYY-MM-DD
  private _isEmergencyStopped = false;

  constructor(customPath?: string) {
    this._filePath = customPath || dataFile("academic_profile.json");
    this._profile = this._defaultProfile();
    this.load();
  }

  setFilePath(customPath: string): void {
    this._filePath = path.resolve(customPath);
    this.load();
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  private _defaultProfile(): CourseProfile {
    const now = Date.now();
    return {
      courseName: "General Academic Studies",
      currentSemester: "Semester 1",
      subjects: [],
      createdAt: now,
      lastUpdated: now,
    };
  }

  load(): void {
    try {
      if (fs.existsSync(this._filePath)) {
        const raw = fs.readFileSync(this._filePath, "utf-8");
        const parsed = JSON.parse(raw);
        if (parsed.profile) {
          this._profile = {
            ...this._defaultProfile(),
            ...parsed.profile,
          };
        }
        if (parsed.syllabi && typeof parsed.syllabi === "object") {
          this._syllabi.clear();
          for (const [subId, syl] of Object.entries(parsed.syllabi)) {
            this._syllabi.set(subId, syl as SubjectSyllabus);
          }
        }
        if (parsed.studyPlan) {
          this._studyPlan = parsed.studyPlan;
        }
        if (parsed.dailySessions && typeof parsed.dailySessions === "object") {
          this._dailySessions.clear();
          for (const [dateKey, session] of Object.entries(parsed.dailySessions)) {
            this._dailySessions.set(dateKey, session as DailyStudySession);
          }
        }
        return;
      }
    } catch (err) {
      console.warn("[CourseProfileManager] Failed to load academic profile from disk, using defaults:", err);
    }
  }

  save(): void {
    try {
      const syllabiObj: Record<string, SubjectSyllabus> = {};
      for (const [k, v] of this._syllabi.entries()) {
        syllabiObj[k] = v;
      }

      const dailySessionsObj: Record<string, DailyStudySession> = {};
      for (const [k, v] of this._dailySessions.entries()) {
        dailySessionsObj[k] = v;
      }

      const data = {
        profile: this._profile,
        syllabi: syllabiObj,
        studyPlan: this._studyPlan,
        dailySessions: dailySessionsObj,
        lastUpdated: Date.now(),
      };

      fs.writeFileSync(this._filePath, JSON.stringify(data, null, 2), "utf-8");
    } catch (err) {
      console.error("[CourseProfileManager] Failed to persist academic profile to disk:", err);
    }
  }

  clear(): void {
    this._profile = this._defaultProfile();
    this._syllabi.clear();
    this._studyPlan = null;
    this._dailySessions.clear();
    try {
      if (fs.existsSync(this._filePath)) {
        fs.unlinkSync(this._filePath);
      }
    } catch {}
  }

  reload(): void {
    this.load();
  }

  // ---------------------------------------------------------------------------
  // Course Profile Management
  // ---------------------------------------------------------------------------

  setProfile(data: Partial<CourseProfile>): CourseProfile {
    this._checkEmergencyStop();
    const now = Date.now();

    const updatedSubjects: CourseSubject[] = Array.isArray(data.subjects)
      ? data.subjects.map((s, idx) => ({
          id: s.id || `sub-${crypto.randomUUID().slice(0, 6)}`,
          name: s.name || `Subject ${idx + 1}`,
          code: s.code,
          credits: s.credits,
          color: s.color,
        }))
      : this._profile.subjects;

    this._profile = {
      ...this._profile,
      ...data,
      subjects: updatedSubjects,
      lastUpdated: now,
    };

    this.save();
    return this.getProfile();
  }

  getProfile(): CourseProfile {
    return JSON.parse(JSON.stringify(this._profile));
  }

  // ---------------------------------------------------------------------------
  // Syllabus Mapping
  // ---------------------------------------------------------------------------

  mapSyllabus(
    subjectId: string,
    subjectName: string,
    chapters: SyllabusChapter[],
  ): SubjectSyllabus {
    this._checkEmergencyStop();

    // Calculate initial topic counts
    let totalTopics = 0;
    let completedTopics = 0;

    const formattedChapters: SyllabusChapter[] = chapters.map((ch, chIdx) => {
      const chNumber = ch.chapterNumber || chIdx + 1;
      const formattedTopics = (ch.topics || []).map((top, topIdx) => {
        totalTopics++;
        const status = top.status || "not_started";
        if (status === "completed") completedTopics++;
        return {
          id: top.id || `top-${subjectId}-${chNumber}-${topIdx + 1}`,
          title: top.title,
          status,
          estimatedHours: top.estimatedHours || 2,
          weightage: top.weightage || 1,
          mappedDocIds: top.mappedDocIds || [],
        };
      });

      return {
        id: ch.id || `chap-${subjectId}-${chNumber}`,
        chapterNumber: chNumber,
        title: ch.title,
        topics: formattedTopics,
      };
    });

    const completionPercentage =
      totalTopics > 0 ? Math.round((completedTopics / totalTopics) * 1000) / 10 : 0;

    const syllabus: SubjectSyllabus = {
      subjectId,
      subjectName,
      chapters: formattedChapters,
      totalTopics,
      completedTopics,
      completionPercentage,
    };

    this._syllabi.set(subjectId, syllabus);

    // Ensure subject is in course profile
    const existingSub = this._profile.subjects.find((s) => s.id === subjectId);
    if (!existingSub) {
      this._profile.subjects.push({ id: subjectId, name: subjectName });
    }

    this.save();
    return syllabus;
  }

  getSyllabus(subjectId?: string): SubjectSyllabus[] {
    if (subjectId) {
      const found = this._syllabi.get(subjectId);
      return found ? [JSON.parse(JSON.stringify(found))] : [];
    }
    return Array.from(this._syllabi.values()).map((s) => JSON.parse(JSON.stringify(s)));
  }

  updateTopicStatus(
    subjectId: string,
    topicId: string,
    status: TopicCompletionStatus,
  ): boolean {
    this._checkEmergencyStop();

    const syllabus = this._syllabi.get(subjectId);
    if (!syllabus) return false;

    let updated = false;
    let totalTopics = 0;
    let completedTopics = 0;

    for (const chapter of syllabus.chapters) {
      for (const topic of chapter.topics) {
        totalTopics++;
        if (topic.id === topicId) {
          topic.status = status;
          updated = true;
        }
        if (topic.status === "completed") {
          completedTopics++;
        }
      }
    }

    if (updated) {
      syllabus.totalTopics = totalTopics;
      syllabus.completedTopics = completedTopics;
      syllabus.completionPercentage =
        totalTopics > 0 ? Math.round((completedTopics / totalTopics) * 1000) / 10 : 0;
      this.save();
    }

    return updated;
  }

  // ---------------------------------------------------------------------------
  // Personalized Study Plan Generation
  // ---------------------------------------------------------------------------

  generateStudyPlan(opts?: {
    dailyHours?: number;
    targetExamDate?: string;
    planName?: string;
  }): PersonalizedStudyPlan {
    this._checkEmergencyStop();

    const dailyHours = Math.max(1, opts?.dailyHours || 3);
    const targetExamDate = opts?.targetExamDate || this._profile.targetExamDate;
    const planName = opts?.planName || `${this._profile.courseName} Adaptive Study Plan`;

    // Fetch weak topics from Stage 2 progress tracker
    const weakTopics = studyProgressTracker.getWeakTopics();

    // Gather uncompleted syllabus topics across all subjects
    const uncompletedTopics: Array<{
      subjectId: string;
      subjectName: string;
      topicId: string;
      topicTitle: string;
      estimatedMinutes: number;
      isPriorityWeakTopic: boolean;
      weightage: number;
    }> = [];

    for (const syllabus of this._syllabi.values()) {
      for (const ch of syllabus.chapters) {
        for (const top of ch.topics) {
          if (top.status !== "completed") {
            const isPriorityWeak = weakTopics.some(
              (w) =>
                top.title.toLowerCase().includes(w.toLowerCase()) ||
                w.toLowerCase().includes(top.title.toLowerCase()),
            );
            uncompletedTopics.push({
              subjectId: syllabus.subjectId,
              subjectName: syllabus.subjectName,
              topicId: top.id,
              topicTitle: top.title,
              estimatedMinutes: Math.round((top.estimatedHours || 2) * 60),
              isPriorityWeakTopic: isPriorityWeak,
              weightage: top.weightage || 1,
            });
          }
        }
      }
    }

    // Sort: priority weak topics first, then highest weightage
    uncompletedTopics.sort((a, b) => {
      if (a.isPriorityWeakTopic && !b.isPriorityWeakTopic) return -1;
      if (!a.isPriorityWeakTopic && b.isPriorityWeakTopic) return 1;
      return b.weightage - a.weightage;
    });

    // Schedule milestones day-by-day
    const milestones: StudyPlanMilestone[] = [];
    const minutesPerDay = dailyHours * 60;
    let dayOffset = 0;
    let minutesScheduledToday = 0;

    const baseDate = new Date();

    for (const item of uncompletedTopics) {
      if (minutesScheduledToday + item.estimatedMinutes > minutesPerDay && minutesScheduledToday > 0) {
        dayOffset++;
        minutesScheduledToday = 0;
      }

      const targetD = new Date(baseDate.getTime() + dayOffset * 86400000);
      const targetDateStr = targetD.toISOString().slice(0, 10);

      milestones.push({
        id: `ms-${crypto.randomUUID().slice(0, 8)}`,
        targetDate: targetDateStr,
        subjectId: item.subjectId,
        subjectName: item.subjectName,
        topicId: item.topicId,
        topicTitle: item.topicTitle,
        estimatedMinutes: item.estimatedMinutes,
        isPriorityWeakTopic: item.isPriorityWeakTopic,
        completed: false,
      });

      minutesScheduledToday += item.estimatedMinutes;
    }

    const plan: PersonalizedStudyPlan = {
      id: `plan-${crypto.randomUUID().slice(0, 8)}`,
      planName,
      generatedAt: Date.now(),
      targetExamDate,
      dailyAvailableHours: dailyHours,
      milestones,
      overallProgressPercentage: 0,
    };

    this._studyPlan = plan;
    this.save();
    return plan;
  }

  getStudyPlan(): PersonalizedStudyPlan | null {
    if (!this._studyPlan) return null;
    return JSON.parse(JSON.stringify(this._studyPlan));
  }

  // ---------------------------------------------------------------------------
  // Daily Study Session Management
  // ---------------------------------------------------------------------------

  private _todayKey(): string {
    return new Date().toISOString().slice(0, 10);
  }

  createOrGetDailySession(date?: string, targets?: DailySessionTarget[]): DailyStudySession {
    this._checkEmergencyStop();
    const dateKey = date || this._todayKey();

    let session = this._dailySessions.get(dateKey);
    if (!session) {
      let defaultTargets: DailySessionTarget[] = targets || [];

      // Auto-populate from active study plan if targets were not supplied
      if (defaultTargets.length === 0 && this._studyPlan) {
        const matchingMilestones = this._studyPlan.milestones.filter(
          (m) => m.targetDate === dateKey && !m.completed,
        );
        defaultTargets = matchingMilestones.map((m) => ({
          id: `tgt-${m.id}`,
          subjectName: m.subjectName,
          topicTitle: m.topicTitle,
          goal: `Review ${m.topicTitle} and solve practice problems`,
          durationMinutes: m.estimatedMinutes,
          completed: false,
        }));
      }

      // If still empty, supply a structured default target based on syllabus or weak topics
      if (defaultTargets.length === 0) {
        const weak = studyProgressTracker.getWeakTopics();
        const firstSubject = this._profile.subjects[0]?.name || "Core Subject";
        defaultTargets = [
          {
            id: `tgt-${crypto.randomUUID().slice(0, 6)}`,
            subjectName: firstSubject,
            topicTitle: weak[0] || "General Concept Review",
            goal: weak[0]
              ? `Remediate weak topic "${weak[0]}" with 5 targeted practice questions`
              : "Review textbook notes and solve daily questions",
            durationMinutes: 45,
            completed: false,
          },
        ];
      }

      const totalPlannedMinutes = defaultTargets.reduce((acc, t) => acc + t.durationMinutes, 0);

      session = {
        date: dateKey,
        targets: defaultTargets,
        totalPlannedMinutes,
        completedMinutes: 0,
        status: "planned",
      };

      this._dailySessions.set(dateKey, session);
      this.save();
    }

    return JSON.parse(JSON.stringify(session));
  }

  updateDailyTarget(targetId: string, completed: boolean, date?: string): DailyStudySession {
    this._checkEmergencyStop();
    const dateKey = date || this._todayKey();
    const session = this._dailySessions.get(dateKey);

    if (!session) {
      throw new Error(`NO_DAILY_SESSION: No daily study session exists for date '${dateKey}'.`);
    }

    const target = session.targets.find((t) => t.id === targetId);
    if (target) {
      target.completed = completed;
      session.completedMinutes = session.targets
        .filter((t) => t.completed)
        .reduce((acc, t) => acc + t.durationMinutes, 0);

      const allDone = session.targets.length > 0 && session.targets.every((t) => t.completed);
      if (allDone) {
        session.status = "completed";
      } else if (session.completedMinutes > 0) {
        session.status = "active";
      }

      this.save();
    }

    return JSON.parse(JSON.stringify(session));
  }

  completeDailySession(notes?: string, date?: string): DailyStudySession {
    this._checkEmergencyStop();
    const dateKey = date || this._todayKey();
    const session = this._dailySessions.get(dateKey);

    if (!session) {
      throw new Error(`NO_DAILY_SESSION: No daily study session exists for date '${dateKey}'.`);
    }

    session.status = "completed";
    session.notes = notes || session.notes || "Completed daily study session.";
    session.completedMinutes = session.totalPlannedMinutes;
    for (const t of session.targets) {
      t.completed = true;
    }

    this.save();
    return JSON.parse(JSON.stringify(session));
  }

  getDailySession(date?: string): DailyStudySession | null {
    const dateKey = date || this._todayKey();
    const session = this._dailySessions.get(dateKey);
    return session ? JSON.parse(JSON.stringify(session)) : null;
  }

  // ---------------------------------------------------------------------------
  // Long-Term Academic Progress & Deterministic Readiness Score
  // ---------------------------------------------------------------------------

  /**
   * Computes comprehensive academic progress across syllabus completion,
   * question attempts from StudyProgressTracker, and daily session consistency.
   *
   * Deterministic Readiness Score Formula:
   *   S = overallSyllabusCompletionPercentage (0 - 100)
   *   A = overallQuestionAccuracy from StudyProgressTracker (0 - 100)
   *   W = min(30, weakTopics.length * 10)
   *   D = min(15, completedDailySessions * 3)
   *   baseScore = (0.50 * S) + (0.35 * A) + D - W
   *   readinessScore = max(0, min(100, round(baseScore)))
   */
  calculateAcademicProgress(): AcademicProgressSummary {
    let totalSyllabusTopics = 0;
    let completedSyllabusTopics = 0;

    const subjectsProgress: Array<{
      subjectId: string;
      subjectName: string;
      completionPercentage: number;
      totalTopics: number;
      completedTopics: number;
    }> = [];

    for (const s of this._syllabi.values()) {
      totalSyllabusTopics += s.totalTopics;
      completedSyllabusTopics += s.completedTopics;
      subjectsProgress.push({
        subjectId: s.subjectId,
        subjectName: s.subjectName,
        completionPercentage: s.completionPercentage,
        totalTopics: s.totalTopics,
        completedTopics: s.completedTopics,
      });
    }

    const overallSyllabusCompletionPercentage =
      totalSyllabusTopics > 0
        ? Math.round((completedSyllabusTopics / totalSyllabusTopics) * 1000) / 10
        : 0;

    const progressSnapshot = studyProgressTracker.getOverallProgress();
    const totalQuestionsAttempted = progressSnapshot.totalAttempted;
    const overallQuestionAccuracy = progressSnapshot.accuracyRate;
    const weakTopics = progressSnapshot.weakTopics;

    // Count completed daily study sessions
    let totalDailySessionsCompleted = 0;
    for (const session of this._dailySessions.values()) {
      if (session.status === "completed") {
        totalDailySessionsCompleted++;
      }
    }

    // Deterministic components
    const S = overallSyllabusCompletionPercentage; // 0 - 100
    const A = totalQuestionsAttempted > 0 ? overallQuestionAccuracy : 0; // 0 - 100
    const W = Math.min(30, weakTopics.length * 10);
    const D = Math.min(15, totalDailySessionsCompleted * 3);

    const baseScore = 0.5 * S + 0.35 * A + D - W;
    const readinessScore = Math.max(0, Math.min(100, Math.round(baseScore)));

    let readinessLevel: "needs_focus" | "developing" | "exam_ready" = "needs_focus";
    if (readinessScore >= 75) {
      readinessLevel = "exam_ready";
    } else if (readinessScore >= 45) {
      readinessLevel = "developing";
    }

    return {
      courseName: this._profile.courseName,
      currentSemester: this._profile.currentSemester,
      overallSyllabusCompletionPercentage,
      subjectsProgress,
      totalQuestionsAttempted,
      overallQuestionAccuracy,
      currentWeakTopicsCount: weakTopics.length,
      weakTopics,
      totalDailySessionsCompleted,
      readinessScore,
      readinessLevel,
    };
  }

  // ---------------------------------------------------------------------------
  // Emergency Stop Handling
  // ---------------------------------------------------------------------------

  emergencyStop(): void {
    this._isEmergencyStopped = true;
    console.warn("[CourseProfileManager] EMERGENCY STOP: Pausing active daily sessions.");
    // Mark today's session status as planned if currently active
    const today = this.getDailySession();
    if (today && today.status === "active") {
      today.status = "planned";
      this._dailySessions.set(today.date, today);
    }
  }

  resetEmergencyStop(): void {
    this._isEmergencyStopped = false;
  }

  private _checkEmergencyStop(): void {
    if (this._isEmergencyStopped || emergencyStopCoordinator.isActive()) {
      if (!emergencyStopCoordinator.isActive()) {
        this._isEmergencyStopped = false;
        return;
      }
      this._isEmergencyStopped = true;
      throw new Error(
        "EMERGENCY_STOP_ACTIVE: Course profile and academic operations are blocked while emergency stop is active.",
      );
    }
  }
}

export const courseProfileManager = new CourseProfileManager();
