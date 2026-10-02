/**
 * MYRAA — HumanConversationEngine
 *
 * Engine for human-like conversational dynamics:
 *
 *   1. Adaptive Response Length:
 *      - Avoids unnecessarily long answers.
 *      - Classifies pacing context:
 *        * SHORT: Quick status, yes/no, greeting, ping, time/date, single fact.
 *        * MEDIUM: Standard explanations, code summaries, feature queries.
 *        * DETAILED: Step-by-step guides, architecture reviews, deep debugging.
 *
 *   2. Natural Memory Recall & Conversational Bridges:
 *      - Remembers user's previous points naturally ("Jaise humne pehle dekha tha...",
 *        "As you mentioned earlier...", "जइसे रउआ पहिले कहले रहीं...").
 *
 *   3. Phrase Anti-Repetition & Variety:
 *      - Tracks used openers, acknowledgement phrases, and sentence closers across turns.
 *      - Prevents repeating the same phrase within sliding window.
 *
 *   4. Appropriate Acknowledgements:
 *      - Language-authentic conversational markers:
 *        "Hmm, samajh gayi.", "Achha, ek second...", "Ohh, ab samjhi.", "Haan, bilkul."
 *      - Strict budget: Never overuses fillers.
 */

import {
  type ActiveLanguage,
  LANGUAGE_PROFILES,
} from "./LanguageProfile.ts";

export type ConversationPacing = "short" | "medium" | "detailed";

export interface DialogueTurn {
  role: "user" | "model";
  text: string;
}

export interface ConversationPacingDecision {
  pacing: ConversationPacing;
  targetSentenceRange: [number, number];
  instructionDirective: string;
  acknowledgement: string;
  memoryBridge?: string;
}

export class HumanConversationEngine {
  private static instance: HumanConversationEngine;

  private recentOpeners: string[] = [];
  private recentAcknowledgements: string[] = [];
  private readonly maxHistorySize = 10;
  private readonly phraseCooldownTurns = 3;

  public static getInstance(): HumanConversationEngine {
    if (!HumanConversationEngine.instance) {
      HumanConversationEngine.instance = new HumanConversationEngine();
    }
    return HumanConversationEngine.instance;
  }

  public resetState(): void {
    this.recentOpeners = [];
    this.recentAcknowledgements = [];
  }

  /**
   * Determine the optimal response pacing (short, medium, or detailed) based on query context.
   */
  public selectPacing(userPrompt: string): ConversationPacing {
    if (!userPrompt || !userPrompt.trim()) return "short";

    const lower = userPrompt.trim().toLowerCase();

    // Short queries: simple greetings, status checks, binary questions, short pings
    if (
      lower.length < 25 ||
      /^(hi|hello|hey|namaste|pranam|kya hal hai|kaise ho|status|ready\?|ping|time|date|theek hai|haan|nahi|ok|done)\b/i.test(
        lower
      ) ||
      /\b(is (the )?server (running|up)|are you (there|ready)|what time is it)\b/i.test(lower)
    ) {
      return "short";
    }

    // Detailed queries: deep tutorials, step-by-step guides, architecture breakdowns, exhaustive comparisons
    if (
      /\b(step[- ]by[- ]step|explain step[- ]by[- ]step|in detail|detailed plan|full architecture|complete architecture|complete guide|architecture breakdown|tutorial|sikhao|pura samjhao|vistar se|deep dive)\b/i.test(
        lower
      ) ||
      lower.includes("why did this happen and how to prevent it")
    ) {
      return "detailed";
    }

    // Default: medium (focused, natural conversational explanation)
    return "medium";
  }

  /**
   * Select an appropriate, authentic conversational acknowledgement without repeating recent ones.
   */
  public selectAcknowledgement(
    userPrompt: string,
    language: ActiveLanguage,
    type: "understood" | "waitSec" | "gotItNow" | "absolutely" = "understood"
  ): string {
    const profile = LANGUAGE_PROFILES[language];
    const auth = profile.authenticityConfig;

    let candidate = auth?.acknowledgements?.[type];
    if (!candidate) {
      candidate = profile.quickAcknowledgements.defaultAck;
    }

    // Check anti-repetition
    const clean = candidate.toLowerCase().replace(/[^\p{L}]/gu, "");
    const recent = this.recentAcknowledgements.slice(-this.phraseCooldownTurns);

    if (recent.some((r) => r.toLowerCase().replace(/[^\p{L}]/gu, "") === clean)) {
      // Pick alternative acknowledgement
      const fallbackOptions: string[] = [
        auth?.acknowledgements?.understood,
        auth?.acknowledgements?.absolutely,
        auth?.acknowledgements?.waitSec,
        profile.quickAcknowledgements.defaultAck,
      ].filter(Boolean) as string[];

      const unused = fallbackOptions.find(
        (opt) => !recent.some((r) => r.toLowerCase().replace(/[^\p{L}]/gu, "") === opt.toLowerCase().replace(/[^\p{L}]/gu, ""))
      );
      if (unused) {
        candidate = unused;
      }
    }

    this.recordAcknowledgement(candidate);
    return candidate;
  }

  /**
   * Scan dialogue history and formulate a natural conversational memory recall bridge
   * if the user is referencing earlier topics or continuing an earlier train of thought.
   */
  public buildMemoryBridge(
    dialogueHistory: DialogueTurn[],
    userPrompt: string,
    language: ActiveLanguage
  ): string | undefined {
    if (!dialogueHistory || dialogueHistory.length < 2) return undefined;

    const lower = userPrompt.toLowerCase();
    const isFollowup =
      /\b(aur|also|and|what about|iske bare me|uske bare me|wahi|same|earlier|pehle|jaise|previous)\b/i.test(
        lower
      );

    if (!isFollowup) return undefined;

    // Scan backwards to find the last substantive user topic
    const priorUserTurn = [...dialogueHistory]
      .reverse()
      .find((t) => t.role === "user" && t.text !== userPrompt);

    if (!priorUserTurn) return undefined;

    // Return language-authentic memory bridge
    switch (language) {
      case "hindi":
        return "जैसा हमने अभी देखा था, ";
      case "hinglish":
        return "Jaise hum pehle discuss kar rahe the, ";
      case "bhojpuri":
        return "जइसे रउआ पहिले कहले रहीं, ";
      case "maithili":
        return "जहिना हम सब पहिले देखलहुँ, ";
      case "bengali":
        return "যেমন আপনি একটু আগে বলছিলেন, ";
      case "japanese":
        return "先ほどお話ししていたように、";
      case "tamil":
        return "நாம் முன்பு பார்த்தது போல, ";
      case "telugu":
        return "మనం ఇందాక చూసినట్లుగా, ";
      case "russian":
        return "Как мы обсуждали ранее, ";
      case "english":
      default:
        return "As we were discussing earlier, ";
    }
  }

  /**
   * Complete pacing decision with directives for LLM prompting and TTS synthesis.
   */
  public decidePacing(
    userPrompt: string,
    language: ActiveLanguage,
    dialogueHistory: DialogueTurn[] = []
  ): ConversationPacingDecision {
    const pacing = this.selectPacing(userPrompt);
    const acknowledgement = this.selectAcknowledgement(userPrompt, language);
    const memoryBridge = this.buildMemoryBridge(dialogueHistory, userPrompt, language);

    let targetSentenceRange: [number, number] = [2, 3];
    let instructionDirective = "Keep response natural, warm, and moderately paced (2-3 sentences).";

    if (pacing === "short") {
      targetSentenceRange = [1, 2];
      instructionDirective = "User query is brief/direct. Keep response very crisp (1-2 sentences). Do not over-explain.";
    } else if (pacing === "detailed") {
      targetSentenceRange = [4, 7];
      instructionDirective = "User asked for a deep explanation. Provide a structured, thoughtful response without being verbose.";
    }

    return {
      pacing,
      targetSentenceRange,
      instructionDirective,
      acknowledgement,
      memoryBridge,
    };
  }

  // ── PRIVATE TRACKERS ──────────────────────────────────────────────────────

  private recordAcknowledgement(phrase: string): void {
    this.recentAcknowledgements.push(phrase);
    if (this.recentAcknowledgements.length > this.maxHistorySize) {
      this.recentAcknowledgements.shift();
    }
  }
}

export const humanConversationEngine = HumanConversationEngine.getInstance();
