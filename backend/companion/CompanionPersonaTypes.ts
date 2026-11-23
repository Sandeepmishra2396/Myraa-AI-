/**
 * MYRAA — CompanionPersonaTypes (Stage 10 Phase 1)
 *
 * Type contracts for persona identity, communication preferences,
 * and avatar states. Isolated in Tier 2 (companion_persona.json).
 */

export type VerbosityLevel = "concise" | "normal" | "detailed";
export type FormalityLevel = "casual" | "professional";
export type EmotionalTone = "warm" | "neutral" | "direct";

export interface CommunicationStyle {
  verbosity: VerbosityLevel;
  formality: FormalityLevel;
  emotionalTone: EmotionalTone;
}

export interface CompanionPersona {
  id: string;                        // Fixed: "persona_default"
  displayName: string;               // e.g., "MYRAA"
  avatarStyle: "idle" | "talking" | "thinking";
  preferredLanguage: string;         // "hinglish" | "english" | "hindi"
  communicationStyle: CommunicationStyle;
  customPromptPrefix?: string;       // User-defined system instructions
  updatedAt: string;                 // ISO8601
  createdAt: string;                 // ISO8601
}

export const DEFAULT_COMPANION_PERSONA: CompanionPersona = {
  id: "persona_default",
  displayName: "MYRAA",
  avatarStyle: "idle",
  preferredLanguage: "hinglish",
  communicationStyle: {
    verbosity: "normal",
    formality: "casual",
    emotionalTone: "warm",
  },
  createdAt: "2026-10-30T00:00:00.000Z",
  updatedAt: "2026-10-30T00:00:00.000Z",
};
