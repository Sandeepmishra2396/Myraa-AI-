/**
 * MYRAA — NaturalReactionEngine
 *
 * Evaluates contextual cues and injects subtle, natural reactions and playful banter:
 *
 *   1. Context Classification:
 *      - Serious / Emergency: Halted, safety alarms, shutdown -> NO reactions, NO laughter.
 *      - Error / Bug / Exception: Supportive, calm, no laughing, focused fix.
 *      - Factual / Technical: Calculations, paths, status codes -> NO fillers, direct accuracy.
 *      - Casual / Banter / Compliment / Joke: Warm, expressive, slightly playful companion.
 *
 *   2. Subtle Reactions:
 *      - "hmm...", "ohh...", "aha...", "achha...", "wait...", "haha...", "arre waah!"
 *
 *   3. Personality & Friendly Banter:
 *      - Warm + Intelligent + Expressive + Slightly Playful + Respectful.
 *      - Gentle teasing / shy reactions:
 *        "arey, aisa bhi kya 😄"
 *        "ohh, ye toh interesting tha..."
 *        "haha, achha ji..."
 *
 *   4. Safety & Invariant:
 *      - Non-sexual, non-romantic companion boundaries strictly preserved.
 */

import {
  type ActiveLanguage,
  LANGUAGE_PROFILES,
} from "./LanguageProfile.ts";
import type { EmotionState } from "./ProsodyTypes.ts";

export interface ReactionContext {
  userPrompt?: string;
  isError?: boolean;
  isEmergency?: boolean;
  isFactual?: boolean;
  isCode?: boolean;
  isGreeting?: boolean;
  taskSuccess?: boolean;
  forceNoReaction?: boolean;
}

export interface ReactionDecisionResult {
  allowed: boolean;
  reaction: string | null;
  reactionType: "acknowledgement" | "reaction" | "banter" | "shy" | "laughter" | null;
  hasLaughter: boolean;
  laughterToken: string | null;
  isPlayful: boolean;
  reason: string;
}

export class NaturalReactionEngine {
  private static instance: NaturalReactionEngine;

  private recentReactions: string[] = [];
  private lastTurnHadReaction = false;
  private readonly maxReactionHistory = 6;
  private readonly reactionCooldownTurns = 2;

  public static getInstance(): NaturalReactionEngine {
    if (!NaturalReactionEngine.instance) {
      NaturalReactionEngine.instance = new NaturalReactionEngine();
    }
    return NaturalReactionEngine.instance;
  }

  public resetState(): void {
    this.recentReactions = [];
    this.lastTurnHadReaction = false;
  }

  /**
   * Decide whether to add a subtle reaction, light banter, or laughter.
   */
  public decideReaction(
    text: string,
    emotion: EmotionState,
    language: ActiveLanguage,
    context?: ReactionContext
  ): ReactionDecisionResult {
    const combined = `${context?.userPrompt || ""} ${text}`.toLowerCase();

    // ── 1. HARD GUARDS: Serious situations, emergencies, errors, factual queries ──
    if (context?.forceNoReaction) {
      this.lastTurnHadReaction = false;
      return {
        allowed: false,
        reaction: null,
        reactionType: null,
        hasLaughter: false,
        laughterToken: null,
        isPlayful: false,
        reason: "Forced no reaction",
      };
    }

    if (context?.isEmergency || /emergency|danger|shutdown|reboot|crash|critical|alert/i.test(combined)) {
      this.lastTurnHadReaction = false;
      return {
        allowed: false,
        reaction: null,
        reactionType: null,
        hasLaughter: false,
        laughterToken: null,
        isPlayful: false,
        reason: "Emergency / critical context prohibits reactions",
      };
    }

    if (context?.isError || /error|exception|fail|traceback|syntaxerror|typeerror|rejection/i.test(combined)) {
      this.lastTurnHadReaction = false;
      return {
        allowed: false,
        reaction: null,
        reactionType: null,
        hasLaughter: false,
        laughterToken: null,
        isPlayful: false,
        reason: "Error debugging context prohibits laughter and casual fillers",
      };
    }

    if (context?.isFactual || context?.isCode || this.isStrictlyFactualOrCode(text, context?.userPrompt)) {
      this.lastTurnHadReaction = false;
      return {
        allowed: false,
        reaction: null,
        reactionType: null,
        hasLaughter: false,
        laughterToken: null,
        isPlayful: false,
        reason: "Factual/technical query requires direct concise answer without filler",
      };
    }

    // ── 2. LAUGHTER DECISION: Playful / Humor moments ONLY ───────────────────
    let hasLaughter = false;
    let laughterToken: string | null = null;

    const humorCues = /(haha|joke|jokes|funny|chutkula|hasi|laugh|hilarious|playful|mazedar|चुटकुला|मजेदार|हाहा|हंसी|হাসি|মজার|ふふ|ジョーク|சிரிப்பு|హాస్యం|шутка|смешно)/i;
    if ((emotion === "happy" || emotion === "excited") && humorCues.test(combined)) {
      hasLaughter = true;
      laughterToken = LANGUAGE_PROFILES[language].laughterToken;
    }

    // ── 3. COOLDOWN & TURN BUDGETING ─────────────────────────────────────────
    // Prevent reaction on every turn
    if (this.lastTurnHadReaction) {
      this.lastTurnHadReaction = false;
      return {
        allowed: false,
        reaction: null,
        reactionType: null,
        hasLaughter,
        laughterToken,
        isPlayful: false,
        reason: "Turn cooldown: reaction skipped to prevent filler overuse",
      };
    }

    // ── 4. LIGHT PLAYFUL BANTER & SHY REACTIONS ─────────────────────────────
    const profile = LANGUAGE_PROFILES[language];
    const authConfig = profile.authenticityConfig;

    const teasingComplimentCues = /(tareef|smart|genius|cute|sweet|pretty|beautiful|good girl|love you|pasand|tease|kya baat|aisa bhi kya|aisa kyu|heroine|naughty|chalu)/i;
    const isTeasingMoment = teasingComplimentCues.test(combined);

    if (isTeasingMoment && authConfig?.playfulBanter && authConfig.playfulBanter.length > 0) {
      const banterCandidates = authConfig.playfulBanter.filter((b) => this.isEligible(b));
      if (banterCandidates.length > 0) {
        const banter = banterCandidates[Math.floor(Math.random() * banterCandidates.length)];
        this.recordUsage(banter);
        this.lastTurnHadReaction = true;
        return {
          allowed: true,
          reaction: banter,
          reactionType: "banter",
          hasLaughter,
          laughterToken,
          isPlayful: true,
          reason: "Light playful banter match",
        };
      }
    }

    // ── 5. SUBTLE EMOTIONAL REACTIONS ───────────────────────────────────────
    // Allow subtle reaction for greeting, happy, excited, curious
    if (emotion !== "neutral") {
      const candidates = profile.fillersByEmotion[emotion] || [];
      const eligible = candidates.filter((c) => this.isEligible(c));

      if (eligible.length > 0) {
        const reaction = eligible[Math.floor(Math.random() * eligible.length)];
        this.recordUsage(reaction);
        this.lastTurnHadReaction = true;
        return {
          allowed: true,
          reaction,
          reactionType: "reaction",
          hasLaughter,
          laughterToken,
          isPlayful: emotion === "happy" || emotion === "excited",
          reason: `Subtle emotion reaction for ${emotion}`,
        };
      }
    }

    this.lastTurnHadReaction = false;
    return {
      allowed: false,
      reaction: null,
      reactionType: null,
      hasLaughter,
      laughterToken,
      isPlayful: false,
      reason: "No eligible reaction or neutral context",
    };
  }

  // ── PRIVATE HELPERS ───────────────────────────────────────────────────────

  private isEligible(candidate: string): boolean {
    const clean = candidate.toLowerCase().replace(/[^\p{L}]/gu, "");
    const recent = this.recentReactions.slice(-this.reactionCooldownTurns);
    return !recent.some((r) => r.toLowerCase().replace(/[^\p{L}]/gu, "") === clean);
  }

  private recordUsage(candidate: string): void {
    this.recentReactions.push(candidate);
    if (this.recentReactions.length > this.maxReactionHistory) {
      this.recentReactions.shift();
    }
  }

  private isStrictlyFactualOrCode(text: string, userPrompt?: string): boolean {
    const combined = `${userPrompt || ""} ${text}`.toLowerCase();
    if (/```|npm |git |pip |import |export |const |function |class /i.test(text)) {
      return true;
    }
    if (
      /\b(what is \d+|calculate|formula|square root|git status|cpu usage|memory usage|file path|port number|ip address)\b/i.test(
        combined
      )
    ) {
      return true;
    }
    return false;
  }
}

export const naturalReactionEngine = NaturalReactionEngine.getInstance();
