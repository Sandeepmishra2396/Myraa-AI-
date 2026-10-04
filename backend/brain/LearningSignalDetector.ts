/**
 * MYRAA — Phase 18: Adaptive Personal Brain
 * Learning Signal Detector
 *
 * Detects implicit and explicit learning signals from user input across
 * English, Hindi, and Hinglish. Identifies corrections, preference statements,
 * communication style adjustments, coding preferences, UI choices, and temporary TTL qualifiers.
 *
 * Enforces Rule: "Never silently invent memories."
 * Only authentic signals matching verified patterns will produce a LearningSignal.
 */

import type { CognitiveCategory, LearningSignal } from "./CognitiveTypes.ts";

export class LearningSignalDetector {
  /**
   * Scans a user utterance for learning signals.
   * Returns a structured LearningSignal if a clear preference/correction is found, or null otherwise.
   */
  public detectSignal(utterance: string): LearningSignal | null {
    if (!utterance || typeof utterance !== "string") {
      return null;
    }

    const trimmed = utterance.trim();
    if (trimmed.length < 4) {
      return null;
    }

    const lower = trimmed.toLowerCase();

    // Check for temporary qualifiers (TTL)
    const { isTemporary, ttlMs } = this._detectTtl(lower);

    // 1. Correction & Negative Feedback on Format / Style
    // Example: "Mujhe ye format pasand nahi hai", "Ye format mat use karo", "I don't like this format"
    if (
      /(format pasand nahi|format mat use karo|format change karo|change the format|don't like this format|dislike this format|stop using this format)/i.test(
        lower
      )
    ) {
      // Determine what format preference might be implied or requested
      let key = "comm.format";
      let val: any = "alternative";
      let category: CognitiveCategory = "communication_style";

      if (/(bullet|points|point wise|list)/i.test(lower)) {
        key = "comm.format";
        val = "bullet_points";
      } else if (/(paragraph|para|summary|short)/i.test(lower)) {
        key = "comm.format";
        val = "concise_paragraph";
      }

      return {
        type: "correction",
        rawUtterance: trimmed,
        category,
        key,
        value: val,
        confidence: 0.95,
        importance: 4,
        isTemporary,
        ttlMs,
        explanation: `User explicitly disapproved previous output format: '${trimmed}'`,
      };
    }

    // 2. Verbosity & Length Corrections
    // Example: "Short me bolo", "Itna lamba mat bolo", "Chhota answer do", "Be more concise", "Keep answers short"
    if (
      /(short me bolo|chhota answer|itna lamba mat|lamba mat bolo|ek line me|keep it short|be more concise|shorter answers|too long|stop talking so much|brief me bolo)/i.test(
        lower
      )
    ) {
      return {
        type: "style_feedback",
        rawUtterance: trimmed,
        category: "communication_style",
        key: "comm.verbosity",
        value: "concise",
        confidence: 0.95,
        importance: 4,
        isTemporary,
        ttlMs,
        explanation: `User requested concise/short communication: '${trimmed}'`,
      };
    }

    // Example: "Detail me samjhao", "Acche se explain karo", "In-depth samjhao", "Explain in detail", "Give full details"
    if (
      /(detail me samjhao|acche se explain karo|in-depth samjhao|explain in detail|give more detail|give full explanation|thoroughly explain)/i.test(
        lower
      )
    ) {
      return {
        type: "style_feedback",
        rawUtterance: trimmed,
        category: "communication_style",
        key: "comm.verbosity",
        value: "detailed",
        confidence: 0.9,
        importance: 4,
        isTemporary,
        ttlMs,
        explanation: `User requested detailed and thorough communication: '${trimmed}'`,
      };
    }

    // 3. Coding Preferences (Indentation, Style, Testing)
    // Example: "Tabs use karo", "Spaces mat use karo", "Always use tabs"
    if (/(always use tabs|use tabs|tabs use karo|tabs chahiye|spaces mat use)/i.test(lower)) {
      return {
        type: "preference_statement",
        rawUtterance: trimmed,
        category: "coding_preference",
        key: "coding.indentation",
        value: "tabs",
        confidence: 0.95,
        importance: 5,
        isTemporary,
        ttlMs,
        explanation: `User expressed explicit coding indentation preference for tabs: '${trimmed}'`,
      };
    }

    // Example: "2 spaces use karo", "Indent with 2 spaces", "2 space indentation"
    if (/(2 spaces?|two spaces?|2 space indentation|indent with 2 spaces?)/i.test(lower)) {
      return {
        type: "preference_statement",
        rawUtterance: trimmed,
        category: "coding_preference",
        key: "coding.indentation",
        value: "2_spaces",
        confidence: 0.95,
        importance: 5,
        isTemporary,
        ttlMs,
        explanation: `User expressed explicit coding indentation preference for 2 spaces: '${trimmed}'`,
      };
    }

    // Example: "4 spaces use karo", "Indent with 4 spaces", "4 space indentation"
    if (/(4 spaces?|four spaces?|4 space indentation|indent with 4 spaces?)/i.test(lower)) {
      return {
        type: "preference_statement",
        rawUtterance: trimmed,
        category: "coding_preference",
        key: "coding.indentation",
        value: "4_spaces",
        confidence: 0.95,
        importance: 5,
        isTemporary,
        ttlMs,
        explanation: `User expressed explicit coding indentation preference for 4 spaces: '${trimmed}'`,
      };
    }

    // 4. Tone & Persona Feedback
    // Example: "Jyada formal mat bano", "Bhai jaise bolo", "Be more casual", "Talk like a friend"
    if (/(jyada formal mat|formal mat bano|bhai jaise bolo|be more casual|casual tone|talk like a friend|friendly bolo)/i.test(lower)) {
      return {
        type: "style_feedback",
        rawUtterance: trimmed,
        category: "communication_style",
        key: "comm.tone",
        value: "casual_friendly",
        confidence: 0.9,
        importance: 4,
        isTemporary,
        ttlMs,
        explanation: `User requested casual and friendly tone: '${trimmed}'`,
      };
    }

    // Example: "Professional raho", "Professional tone", "Be professional"
    if (/(professional raho|be professional|professional tone|formal bolo)/i.test(lower)) {
      return {
        type: "style_feedback",
        rawUtterance: trimmed,
        category: "communication_style",
        key: "comm.tone",
        value: "professional",
        confidence: 0.9,
        importance: 4,
        isTemporary,
        ttlMs,
        explanation: `User requested professional tone: '${trimmed}'`,
      };
    }

    // 5. Language Preference
    // Example: "Hindi me hi baat karo", "Hamesha Hindi me bolo", "Speak in Hindi"
    if (/(hindi me hi baat|hamesha hindi me|sirf hindi|speak in hindi|always speak hindi)/i.test(lower)) {
      return {
        type: "preference_statement",
        rawUtterance: trimmed,
        category: "communication_style",
        key: "comm.language",
        value: "hindi",
        confidence: 0.95,
        importance: 5,
        isTemporary,
        ttlMs,
        explanation: `User explicitly chose Hindi as preferred language: '${trimmed}'`,
      };
    }

    // Example: "English me baat karo", "Speak in English", "English only"
    if (/(english me baat|speak in english|english only|sirf english|always speak english)/i.test(lower)) {
      return {
        type: "preference_statement",
        rawUtterance: trimmed,
        category: "communication_style",
        key: "comm.language",
        value: "english",
        confidence: 0.95,
        importance: 5,
        isTemporary,
        ttlMs,
        explanation: `User explicitly chose English as preferred language: '${trimmed}'`,
      };
    }

    // Example: "Hinglish me bolo", "Hinglish use karo", "Speak in Hinglish"
    if (/(hinglish me|hinglish use karo|speak in hinglish)/i.test(lower)) {
      return {
        type: "preference_statement",
        rawUtterance: trimmed,
        category: "communication_style",
        key: "comm.language",
        value: "hinglish",
        confidence: 0.95,
        importance: 5,
        isTemporary,
        ttlMs,
        explanation: `User explicitly chose Hinglish as preferred language: '${trimmed}'`,
      };
    }

    // 6. UI & Workflow Preferences
    // Example: "Dark mode pasand hai", "Dark theme chahiye", "Use dark mode"
    if (/(dark mode pasand|dark theme|use dark mode|prefer dark mode|dark mode karo)/i.test(lower)) {
      return {
        type: "preference_statement",
        rawUtterance: trimmed,
        category: "ui_preference",
        key: "ui.theme",
        value: "dark",
        confidence: 0.9,
        importance: 3,
        isTemporary,
        ttlMs,
        explanation: `User expressed preference for dark theme: '${trimmed}'`,
      };
    }

    // Example: "Light mode pasand hai", "Use light mode"
    if (/(light mode pasand|light theme|use light mode|prefer light mode|light mode karo)/i.test(lower)) {
      return {
        type: "preference_statement",
        rawUtterance: trimmed,
        category: "ui_preference",
        key: "ui.theme",
        value: "light",
        confidence: 0.9,
        importance: 3,
        isTemporary,
        ttlMs,
        explanation: `User expressed preference for light theme: '${trimmed}'`,
      };
    }

    // Example: "VS Code me open kiya karo", "Always use VS Code", "Preferred editor VS Code"
    if (/(always use vscode|always use vs code|vs code me open kiya karo|vscode pasand hai|prefer vscode)/i.test(lower)) {
      return {
        type: "preference_statement",
        rawUtterance: trimmed,
        category: "workflow_preference",
        key: "workflow.preferred_editor",
        value: "vscode",
        confidence: 0.95,
        importance: 4,
        isTemporary,
        ttlMs,
        explanation: `User expressed preference for VS Code editor: '${trimmed}'`,
      };
    }

    // Example: "Cursor editor use karo", "Always use Cursor"
    if (/(always use cursor|cursor editor use karo|prefer cursor|cursor me open kiya karo)/i.test(lower)) {
      return {
        type: "preference_statement",
        rawUtterance: trimmed,
        category: "workflow_preference",
        key: "workflow.preferred_editor",
        value: "cursor",
        confidence: 0.95,
        importance: 4,
        isTemporary,
        ttlMs,
        explanation: `User expressed preference for Cursor editor: '${trimmed}'`,
      };
    }

    // 7. General Behavioral Correction: "Aise mat karo", "Ye galat hai", "Don't do that"
    if (
      /(aise mat karo|aisa mat karna|aise mat bolo|don't do that|never do that|stop doing that|ye galat hai|that is wrong|you are wrong)/i.test(
        lower
      )
    ) {
      return {
        type: "correction",
        rawUtterance: trimmed,
        category: "correction",
        key: "behavior.correction",
        value: { disapprovedUtterance: trimmed },
        confidence: 0.9,
        importance: 4,
        isTemporary,
        ttlMs,
        explanation: `User explicitly corrected MYRAA's behavior or output: '${trimmed}'`,
      };
    }

    // 8. Positive Reinforcement
    // Example: "Haan ye perfect hai, hamesha aise hi karna", "Good, remember this format"
    if (/(perfect hai hamesha aise|hamesha aise hi karna|remember this format|good format|keep doing this)/i.test(lower)) {
      return {
        type: "positive_feedback",
        rawUtterance: trimmed,
        category: "preference",
        key: "comm.reinforced_pattern",
        value: "reinforced",
        confidence: 0.85,
        importance: 3,
        isTemporary,
        ttlMs,
        explanation: `User praised and reinforced current pattern: '${trimmed}'`,
      };
    }

    return null;
  }

  /**
   * Helper to detect temporary duration qualifiers.
   */
  private _detectTtl(lower: string): { isTemporary: boolean; ttlMs?: number } {
    // 24 hours: "sirf aaj ke liye", "for today", "today only"
    if (/(sirf aaj ke liye|for today|today only|only today)/i.test(lower)) {
      return { isTemporary: true, ttlMs: 24 * 60 * 60 * 1000 };
    }

    // 2 hours: "abhi ke liye", "for now", "temporarily", "kuch der ke liye"
    if (/(abhi ke liye|for now|temporarily|kuch der ke liye|for the moment)/i.test(lower)) {
      return { isTemporary: true, ttlMs: 2 * 60 * 60 * 1000 };
    }

    // 1 hour: "is session ke liye", "for this session"
    if (/(is session ke liye|for this session|this session only)/i.test(lower)) {
      return { isTemporary: true, ttlMs: 60 * 60 * 1000 };
    }

    // Specific minutes: e.g. "for 30 minutes", "agle 15 minute"
    const matchMin = lower.match(/(?:for|agle)\s+(\d+)\s*(?:minutes?|mins?|minute)/i);
    if (matchMin && matchMin[1]) {
      const mins = parseInt(matchMin[1], 10);
      if (mins > 0 && mins < 1440) {
        return { isTemporary: true, ttlMs: mins * 60 * 1000 };
      }
    }

    return { isTemporary: false };
  }
}

export const learningSignalDetector = new LearningSignalDetector();
