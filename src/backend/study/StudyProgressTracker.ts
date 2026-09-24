/**
 * MYRAA — StudyProgressTracker (Phase 9 — Stage 2: Interactive Tutor)
 *
 * Persistent progress and weak-topic intelligence engine:
 *   - Records student attempts across Exam, Viva, and Practice modes
 *   - Deterministic Weak-Topic Rule:
 *       isWeak === true if (incorrect >= 2) OR (attempted >= 2 && accuracy < 60%)
 *   - Tracks questions attempted, accuracy rate, topics covered, and scores
 *   - Persists data to study_progress.json in DATA_DIR to ensure continuity across restarts
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  QuestionAttemptRecord,
  TopicProgress,
  OverallStudyProgress,
  TutorMode,
} from "./StudyTypes.ts";
import { dataFile } from "../../../server_paths.ts";

export class StudyProgressTracker {
  private _filePath: string;
  private _attempts: QuestionAttemptRecord[] = [];
  private _completedExamSessions = 0;
  private _completedVivaSessions = 0;
  private _initialized = false;

  constructor(filePath?: string) {
    this._filePath = filePath || dataFile("study_progress.json");
    this.load();
  }

  setFilePath(customPath: string): void {
    this._filePath = path.resolve(customPath);
    this.load();
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  load(): void {
    try {
      if (fs.existsSync(this._filePath)) {
        const raw = fs.readFileSync(this._filePath, "utf-8");
        const parsed = JSON.parse(raw);
        this._attempts = Array.isArray(parsed.attempts) ? parsed.attempts : [];
        this._completedExamSessions = Number(parsed.completedExamSessions) || 0;
        this._completedVivaSessions = Number(parsed.completedVivaSessions) || 0;
        this._initialized = true;
        return;
      }
    } catch (err) {
      console.warn("[StudyProgressTracker] Failed to load progress from disk, initializing fresh:", err);
    }
    this._attempts = [];
    this._completedExamSessions = 0;
    this._completedVivaSessions = 0;
    this._initialized = true;
  }

  save(): void {
    try {
      const data = {
        attempts: this._attempts,
        completedExamSessions: this._completedExamSessions,
        completedVivaSessions: this._completedVivaSessions,
        lastUpdated: Date.now(),
      };
      fs.writeFileSync(this._filePath, JSON.stringify(data, null, 2), "utf-8");
    } catch (err) {
      console.error("[StudyProgressTracker] Failed to persist progress to disk:", err);
    }
  }

  clear(): void {
    this._attempts = [];
    this._completedExamSessions = 0;
    this._completedVivaSessions = 0;
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
  // Attempt Logging & Evaluation
  // ---------------------------------------------------------------------------

  recordAttempt(opts: {
    questionId: string;
    topic: string;
    studentAnswer?: string;
    isCorrect: boolean;
    scoreAwarded: number;
    maxMarks: number;
    mode: TutorMode;
  }): QuestionAttemptRecord {
    const record: QuestionAttemptRecord = {
      id: `att-${crypto.randomUUID().slice(0, 8)}`,
      questionId: opts.questionId,
      topic: opts.topic || "General",
      studentAnswer: opts.studentAnswer || "",
      isCorrect: opts.isCorrect,
      scoreAwarded: opts.scoreAwarded,
      maxMarks: opts.maxMarks,
      attemptedAt: Date.now(),
      mode: opts.mode,
    };

    this._attempts.push(record);
    this.save();
    return record;
  }

  incrementExamSessions(): void {
    this._completedExamSessions++;
    this.save();
  }

  incrementVivaSessions(): void {
    this._completedVivaSessions++;
    this.save();
  }

  // ---------------------------------------------------------------------------
  // Progress & Weak-Topic Aggregation
  // ---------------------------------------------------------------------------

  /**
   * Aggregates all recorded attempts into an OverallStudyProgress snapshot.
   */
  getOverallProgress(): OverallStudyProgress {
    const topicMap = new Map<
      string,
      { attempted: number; correct: number; incorrect: number; lastAttemptedAt: number }
    >();

    let totalScore = 0;
    let maxPossibleScore = 0;
    let totalCorrect = 0;
    let totalIncorrect = 0;

    for (const att of this._attempts) {
      const topicName = att.topic.trim() || "General";
      const existing = topicMap.get(topicName) || {
        attempted: 0,
        correct: 0,
        incorrect: 0,
        lastAttemptedAt: 0,
      };

      existing.attempted++;
      if (att.isCorrect) {
        existing.correct++;
        totalCorrect++;
      } else {
        existing.incorrect++;
        totalIncorrect++;
      }

      totalScore += att.scoreAwarded;
      maxPossibleScore += att.maxMarks;
      existing.lastAttemptedAt = Math.max(existing.lastAttemptedAt, att.attemptedAt);
      topicMap.set(topicName, existing);
    }

    const topicsCovered: TopicProgress[] = [];
    const weakTopics: string[] = [];

    for (const [topic, stats] of topicMap.entries()) {
      const accuracy =
        stats.attempted > 0
          ? Math.round((stats.correct / stats.attempted) * 1000) / 10
          : 0;

      // Deterministic Weak-Topic Rule:
      // isWeak === true if (incorrect >= 2) OR (accuracy < 60% when attempted >= 2)
      const isWeak = stats.incorrect >= 2 || (stats.attempted >= 2 && accuracy < 60);

      if (isWeak) {
        weakTopics.push(topic);
      }

      topicsCovered.push({
        topic,
        attempted: stats.attempted,
        correct: stats.correct,
        incorrect: stats.incorrect,
        accuracy,
        isWeak,
        lastAttemptedAt: stats.lastAttemptedAt,
      });
    }

    const totalAttempted = this._attempts.length;
    const accuracyRate =
      totalAttempted > 0
        ? Math.round((totalCorrect / totalAttempted) * 1000) / 10
        : 0;

    return {
      totalAttempted,
      totalCorrect,
      totalIncorrect,
      accuracyRate,
      overallAccuracyRate: accuracyRate,
      totalScore,
      maxPossibleScore,
      topicsCovered,
      weakTopics,
      completedExamSessions: this._completedExamSessions,
      completedVivaSessions: this._completedVivaSessions,
      lastUpdated: Date.now(),
    };
  }

  getWeakTopics(): string[] {
    return this.getOverallProgress().weakTopics;
  }

  /**
   * Retrieves aggregated progress metrics for a specific topic.
   */
  getTopicProgress(
    topicName: string,
  ): (TopicProgress & { accuracyRate: number }) | null {
    const overall = this.getOverallProgress();
    const found = overall.topicsCovered.find(
      (t) => t.topic.toLowerCase() === topicName.toLowerCase(),
    );
    if (!found) return null;
    return {
      ...found,
      accuracyRate: found.accuracy,
    };
  }

  /**
   * Returns list of unique question IDs that were answered incorrectly in the most recent attempt.
   */
  getIncorrectQuestions(): string[] {
    const latestPerQuestion = new Map<string, boolean>();
    for (const att of this._attempts) {
      latestPerQuestion.set(att.questionId, att.isCorrect);
    }

    const incorrect: string[] = [];
    for (const [qId, isCorrect] of latestPerQuestion.entries()) {
      if (!isCorrect) {
        incorrect.push(qId);
      }
    }
    return incorrect;
  }

  resetProgress(): void {
    this._attempts = [];
    this._completedExamSessions = 0;
    this._completedVivaSessions = 0;
    this.save();
  }
}

export const studyProgressTracker = new StudyProgressTracker();
