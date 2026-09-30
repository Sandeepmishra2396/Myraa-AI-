/**
 * MYRAA — ProsodyTypes
 *
 * Types for the SpeechStyle & Prosody Layer.
 * Defines emotion states, language detection, prosody profiles, reactions,
 * and audio synthesis contracts.
 */

export type EmotionState =
  | "neutral"
  | "happy"
  | "excited"
  | "curious"
  | "concerned"
  | "calm";

import type { ActiveLanguage, SupportedLanguage } from "./LanguageProfile.ts";

export type { ActiveLanguage, SupportedLanguage };
export type DetectedLanguage = ActiveLanguage;

export interface PauseMarker {
  index: number;
  durationMs: number;
  type: "micro" | "short" | "thoughtful";
  markerText: string;
}

export interface ProsodyProfile {
  emotion: EmotionState;
  language: DetectedLanguage;
  rate: number;         // 0.85 - 1.20
  pitch: number;        // 0.90 - 1.15
  energy: "low" | "medium" | "high";
  reactionUsed: string | null;
  hasLaughter: boolean;
  laughterToken: string | null;
  pauseCount: number;
  emphasisWords: string[];
}

export interface ProsodyDecision {
  shouldAddReaction: boolean;
  reaction: string | null;
  shouldAddLaughter: boolean;
  laughterToken: string | null;
  rate: number;
  pitch: number;
  pauses: PauseMarker[];
  emphasisWords: string[];
  reason: string;
}

export interface ProsodyTransformationResult {
  originalText: string;
  expressiveText: string;
  ssml: string;
  profile: ProsodyProfile;
  decision: ProsodyDecision;
  audioHints: {
    voice: string;
    rate: number;
    pitch: number;
    stylePrompt: string;
  };
}

export interface AudioSynthesisOptions {
  sampleRate?: number;       // default 24000
  channels?: number;         // default 1 (mono)
  bitDepth?: number;         // default 16
  format?: "pcm16" | "wav";  // default pcm16
  speakingRate?: number;     // multiplier, default 1.0
  pitch?: number;            // multiplier, default 1.0
}

export interface AudioSynthesisResult {
  format: "pcm16" | "wav";
  sampleRate: number;
  channels: number;
  durationMs: number;
  pcm16Base64: string;
  wavBuffer?: Buffer;
  byteLength: number;
}
