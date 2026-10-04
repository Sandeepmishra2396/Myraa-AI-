/**
 * MYRAA — Phase 18: Adaptive Personal Brain
 * Preference Extractor
 *
 * Converts raw LearningSignals into candidate CognitiveMemory objects with
 * normalized keys, verified confidence/importance, structured human-readable text,
 * and expiration timestamps when temporary.
 */

import type { CognitiveMemory, LearningSignal, LearningSignalSource } from "./CognitiveTypes.ts";

export class PreferenceExtractor {
  /**
   * Generates a unique CognitiveMemory ID.
   */
  public generateId(): string {
    const timestamp = Date.now();
    const rand = Math.random().toString(36).substring(2, 7);
    return `cog_${timestamp}_${rand}`;
  }

  /**
   * Extracts a candidate CognitiveMemory from a detected LearningSignal.
   */
  public extractMemory(signal: LearningSignal): CognitiveMemory {
    const id = this.generateId();
    const now = new Date().toISOString();

    let expiresAt: string | undefined = undefined;
    if (signal.isTemporary && signal.ttlMs && signal.ttlMs > 0) {
      expiresAt = new Date(Date.now() + signal.ttlMs).toISOString();
    }

    let sourceSignal: LearningSignalSource = "explicit_statement";
    if (signal.type === "correction" || signal.type === "negative_feedback") {
      sourceSignal = "explicit_correction";
    } else if (signal.type === "positive_feedback") {
      sourceSignal = "user_feedback";
    } else if (signal.type === "command_execution") {
      sourceSignal = "observed_pattern";
    }

    const humanText = this._formatHumanText(signal);

    return {
      id,
      category: signal.category,
      key: signal.key,
      value: signal.value,
      text: humanText,
      confidence: Math.max(0.1, Math.min(1.0, signal.confidence)),
      importance: Math.max(1, Math.min(5, Math.round(signal.importance))),
      sourceSignal,
      status: "active",
      createdAt: now,
      updatedAt: now,
      expiresAt,
      lastUsedAt: now,
      usageCount: 1,
      reinforcementCount: 1,
      rawSignal: signal.rawUtterance,
    };
  }

  /**
   * Generates clear, readable text for the learned preference.
   */
  private _formatHumanText(signal: LearningSignal): string {
    switch (signal.key) {
      case "coding.indentation":
        if (signal.value === "tabs") return "User prefers tabs for code indentation";
        if (signal.value === "2_spaces") return "User prefers 2 spaces for code indentation";
        if (signal.value === "4_spaces") return "User prefers 4 spaces for code indentation";
        return `User prefers ${signal.value} code indentation`;

      case "comm.verbosity":
        if (signal.value === "concise") return "User prefers concise, brief answers without unnecessary fluff";
        if (signal.value === "detailed") return "User prefers detailed, thorough and in-depth explanations";
        return `User prefers ${signal.value} response verbosity`;

      case "comm.tone":
        if (signal.value === "casual_friendly") return "User prefers a casual, friendly, approachable conversational tone";
        if (signal.value === "professional") return "User prefers a professional, direct and objective tone";
        return `User prefers ${signal.value} tone`;

      case "comm.language":
        return `User prefers conversation in ${signal.value}`;

      case "comm.format":
        return `User prefers ${signal.value} format for structured outputs`;

      case "ui.theme":
        return `User prefers ${signal.value} theme for UI`;

      case "workflow.preferred_editor":
        return `User prefers ${signal.value} as their code editor`;

      case "behavior.correction":
        return `User corrected previous behavior: ${signal.explanation}`;

      default:
        return signal.explanation || `Learned preference for ${signal.key}: ${JSON.stringify(signal.value)}`;
    }
  }
}

export const preferenceExtractor = new PreferenceExtractor();
