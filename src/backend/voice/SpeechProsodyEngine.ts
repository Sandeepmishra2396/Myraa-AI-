/**
 * MYRAA — SpeechProsodyEngine
 *
 * SpeechStyle & Prosody Layer between response generation and Gemini Live/TTS.
 *
 * Responsibilities:
 *   1. Emotion State Detection: neutral, happy, excited, curious, concerned, calm.
 *   2. Language Detection: Hindi, Hinglish, English.
 *   3. Contextual Reaction & Filler Selection:
 *      - Natural short reactions: hmm, ohh, aha, haha, wait, oho, achha, are waah, etc.
 *      - Sliding history window to STRICTLY avoid repeating fillers.
 *      - Gating rule: never add filler to every sentence; factual/neutral get NO fillers.
 *      - Cooldown between turns (consecutive fillers blocked).
 *   4. Contextual Pauses & Sentence Rhythm:
 *      - Natural human breathing pauses at clause boundaries and thought transitions.
 *      - Generates clean text with expressive punctuation and SSML pause tags.
 *   5. Emphasis on Important Words:
 *      - Marks focal words for acoustic emphasis without corrupting technical syntax.
 *   6. Dynamic Speaking Speed:
 *      - Modulates rate (0.90x - 1.15x) and pitch according to emotion and context.
 *   7. Contextual Light Laughter:
 *      - Triggered only for playful/humorous/cheerful moments. Strictly barred on errors/neutral.
 *   8. Safety & Guardrails:
 *      - Preserves factual meaning, URLs, code blocks, and concise responses.
 *      - Blocks romantic/sexual roleplay; maintains warm, respectful, human-like companion persona.
 */

import type {
  EmotionState,
  DetectedLanguage,
  ProsodyProfile,
  ProsodyDecision,
  ProsodyTransformationResult,
  PauseMarker,
} from "./ProsodyTypes.ts";

export interface ProsodyContext {
  userPrompt?: string;
  isError?: boolean;
  isEmergency?: boolean;
  isGreeting?: boolean;
  taskSuccess?: boolean;
  isCode?: boolean;
  isFactual?: boolean;
  forceEmotion?: EmotionState;
  forceNoFiller?: boolean;
}

export class SpeechProsodyEngine {
  private recentFillers: string[] = [];
  private lastTurnHadFiller = false;
  private readonly maxFillerHistory = 8;
  private readonly fillerCooldownTurns = 3;

  constructor() {
    this.resetState();
  }

  /** Reset session memory of recent fillers and turn tracking. */
  public resetState(): void {
    this.recentFillers = [];
    this.lastTurnHadFiller = false;
  }

  /**
   * Detect language: Hindi, Hinglish, or English.
   */
  public detectLanguage(text: string): DetectedLanguage {
    if (!text) return "english";

    // 1. Devanagari script detection (Hindi)
    if (/[\u0900-\u097F]/.test(text)) {
      return "hindi";
    }

    // 2. Hinglish token detection (Latin script Hindi vocabulary)
    const lower = text.toLowerCase();
    const hinglishMarkers = [
      /\b(kya|hai|hain|karo|karein|kaise|achha|acha|achhi|suno|batao|thik|theek|yaar|mera|meri|mere)\b/,
      /\b(mujhe|tum|aap|hum|karna|hoga|hogi|nahi|nahin|haan|han|dekho|dekhein|chalo|bohot|bahut)\b/,
      /\b(waah|arre|are|oho|shukriya|dhanyawad|mat|kripya|bana|rakho|chal|raha|rahi|samjho|ruko|roko|ruk)\b/,
      /\b(bhai|dost|kaam|karega|karegi|karke|lekin|magar|kyunki|isko|usko|yahan|wahan|bolo|boliye|suniye)\b/,
    ];

    let matchCount = 0;
    for (const regex of hinglishMarkers) {
      if (regex.test(lower)) {
        matchCount++;
      }
    }

    if (matchCount >= 1) {
      return "hinglish";
    }

    return "english";
  }

  /**
   * Detect Emotion State: neutral, happy, excited, curious, concerned, calm.
   * Guardrail: Do NOT make every response emotional. Factual/technical queries default to neutral.
   */
  public detectEmotion(text: string, context?: ProsodyContext): EmotionState {
    if (context?.forceEmotion) {
      return context.forceEmotion;
    }

    // Emergency or critical halt -> calm/concerned
    if (context?.isEmergency) {
      return "concerned";
    }

    // System error, exception, or failure -> concerned
    if (context?.isError) {
      return "concerned";
    }

    // Milestone completion or celebration -> excited
    if (context?.taskSuccess) {
      return "excited";
    }

    // Greeting -> happy
    if (context?.isGreeting) {
      return "happy";
    }

    const fullText = `${context?.userPrompt || ""} ${text}`.toLowerCase();

    // Check romantic/sexual roleplay safeguard
    if (this.containsRomanticOrSexualContent(fullText)) {
      // Clamped to calm, respectful, professional companion
      return "calm";
    }

    // Factual queries, code blocks, terminal outputs -> neutral
    if (
      context?.isFactual ||
      context?.isCode ||
      this.isPurelyTechnicalOrFactual(text, context?.userPrompt)
    ) {
      return "neutral";
    }

    // Emotion keyword scores
    const scores: Record<EmotionState, number> = {
      neutral: 1, // base weight
      happy: 0,
      excited: 0,
      curious: 0,
      concerned: 0,
      calm: 0,
    };

    // 1. Excited cues
    if (
      /\b(wow|awesome|amazing|unbelievable|great news|badhai|shandar|zabardast|hurray|celebrate|superb|fantastic)\b/.test(
        fullText
      ) ||
      /(बधाई|शानदार|जबरदस्त)/.test(fullText) ||
      /(!{2,})/.test(text)
    ) {
      scores.excited += 4;
    }

    // 2. Happy / Playful / Humor cues
    if (
      /\b(thank|thanks|dhanyawad|shukriya|glad|happy|smile|welcome|good morning|namaste|hello|hi|hey|kushi|fun|cute|nice|good job|joke|jokes|chutkula|funny|haha|hehe|laugh|hilarious|playful|mazedar)\b/.test(
        fullText
      ) ||
      /(नमस्ते|चुटकुला|मजेदार|हाहा|हंसी|खुश)/.test(fullText)
    ) {
      scores.happy += 5;
    }

    // 3. Concerned cues
    if (
      /\b(error|crash|failed|failure|broken|problem|trouble|bug|stuck|kharab|galti|worried|sad|stress|help me|issue|warning)\b/.test(
        fullText
      ) ||
      /(समस्या|खराब|गड़बड़|क्रैश|एरर)/.test(fullText)
    ) {
      scores.concerned += 4;
    }

    // 4. Curious cues
    if (
      /\b(why|how|what if|let me check|let's see|inspect|investigate|wonder|dekhte hain|kya ye|samjho|analyze|look into|explore|examine|take a look)\b/.test(
        fullText
      ) ||
      /(जांच|जांचो|देखते हैं|क्या यह|क्या दिख|परीक्षण)/.test(fullText) ||
      /\?/.test(text.trim()) ||
      /\?/.test(context?.userPrompt || "")
    ) {
      scores.curious += 5;
    }

    // 5. Calm / Reassurance cues (high priority when soothing stress)
    if (
      /\b(relax|don't worry|chinta mat karo|it's fine|take your time|aram se|shant|peaceful|breathe|step by step|carefully|late night|sleep|sukoon|dheere|dhire)\b/.test(
        fullText
      ) ||
      /(सुकून|आराम|शांति|धीरे|चिंता मत)/.test(fullText)
    ) {
      scores.calm += 5;
    }

    // Find highest scoring emotion
    let highest: EmotionState = "neutral";
    let maxScore = scores.neutral;

    for (const [em, score] of Object.entries(scores) as [EmotionState, number][]) {
      if (score > maxScore) {
        maxScore = score;
        highest = em;
      }
    }

    return highest;
  }

  /**
   * Decide if a reaction, pause, emphasis, or laugh is appropriate.
   */
  public decideProsody(
    text: string,
    context?: ProsodyContext
  ): ProsodyDecision {
    const language = this.detectLanguage(text);
    const emotion = this.detectEmotion(text, context);
    const isTechnical = context?.isCode || this.isPurelyTechnicalOrFactual(text, context?.userPrompt);
    const isUrgent = context?.isEmergency || false;

    // ── 1. Reaction Decision ────────────────────────────────────────────────
    let shouldAddReaction = false;
    let selectedReaction: string | null = null;

    const fillerAllowed =
      !context?.forceNoFiller &&
      !isTechnical &&
      !isUrgent &&
      emotion !== "neutral" && // Rule: Do not add filler to neutral/factual responses
      !this.lastTurnHadFiller; // Rule: Avoid adding filler to every sentence / consecutive turns

    if (fillerAllowed) {
      const candidates = this.getCandidatesForEmotion(emotion, language);
      const eligible = candidates.filter((c) => this.isFillerEligible(c));

      if (eligible.length > 0) {
        // Pick reaction that fits best
        selectedReaction = this.selectBestCandidate(eligible, text);
        shouldAddReaction = true;
        this.recordFillerUsage(selectedReaction);
        this.lastTurnHadFiller = true;
      } else {
        this.lastTurnHadFiller = false;
      }
    } else {
      this.lastTurnHadFiller = false;
    }

    // ── 2. Light Laughter Decision ──────────────────────────────────────────
    // Rule: Contextual light laughter ONLY when playful, humorous, or joyful.
    // NEVER on concerned, neutral, technical, or error contexts.
    let shouldAddLaughter = false;
    let laughterToken: string | null = null;

    if (
      (emotion === "happy" || emotion === "excited") &&
      !isTechnical &&
      !context?.isError
    ) {
      const playfulCues = /(haha|joke|funny|kidding|lol|mazaak|chutkula|hasi|giggle|playful|clever|hilarious|चुटकुला|मजेदार|हाहा|हंसी)/i;
      const combined = `${context?.userPrompt || ""} ${text}`;
      if (playfulCues.test(combined)) {
        shouldAddLaughter = true;
        laughterToken = language === "hindi" ? "हाहा..." : "haha...";
      }
    }

    // ── 3. Speaking Speed & Pitch ───────────────────────────────────────────
    const { rate, pitch } = this.computeRateAndPitch(emotion, isUrgent);

    // ── 4. Contextual Pauses & Sentence Rhythm ──────────────────────────────
    const pauses = this.calculatePauseMarkers(text, emotion);

    // ── 5. Emphasis on Important Words ──────────────────────────────────────
    const emphasisWords = this.identifyEmphasisWords(text, emotion);

    return {
      shouldAddReaction,
      reaction: selectedReaction,
      shouldAddLaughter,
      laughterToken,
      rate,
      pitch,
      pauses,
      emphasisWords,
      reason: `emotion=${emotion}, lang=${language}, reaction=${selectedReaction || "none"}, laugh=${shouldAddLaughter}`,
    };
  }

  /**
   * Main Transformation: Applies natural reactions, rhythmic pauses, word emphasis,
   * and generates expressive speech text and valid SSML markup.
   */
  public transformSpeech(
    rawText: string,
    context?: ProsodyContext
  ): ProsodyTransformationResult {
    // Preserve factual text: never mangle code blocks, URLs, or commands
    const cleanRaw = this.sanitizeRoleplayIfAny(rawText);
    const language = this.detectLanguage(cleanRaw);
    const emotion = this.detectEmotion(cleanRaw, context);
    const decision = this.decideProsody(cleanRaw, context);

    let expressiveText = cleanRaw;

    // Apply laughter if appropriate and not already present
    if (decision.shouldAddLaughter && decision.laughterToken) {
      if (!/haha|hehe|\*giggles\*/i.test(expressiveText)) {
        expressiveText = `${decision.laughterToken} ${expressiveText}`;
      }
    }

    // Apply short natural reaction at beginning if appropriate and not already present
    if (decision.shouldAddReaction && decision.reaction) {
      const startsWithReaction = /^(hmm|ohh|oh|aha|haha|wait|oho|achha|acha|are waah|arre)\b/i.test(
        expressiveText
      );
      if (!startsWithReaction) {
        expressiveText = `${decision.reaction} ${expressiveText}`;
      }
    }

    // Apply conversational pauses & sentence rhythm
    expressiveText = this.applyRhythmicPausesToText(expressiveText);

    // Build valid SSML markup for TTS systems
    const ssml = this.buildSsml(expressiveText, decision, emotion);

    const profile: ProsodyProfile = {
      emotion,
      language,
      rate: decision.rate,
      pitch: decision.pitch,
      energy: emotion === "excited" ? "high" : emotion === "calm" ? "low" : "medium",
      reactionUsed: decision.reaction,
      hasLaughter: decision.shouldAddLaughter,
      laughterToken: decision.laughterToken,
      pauseCount: decision.pauses.length,
      emphasisWords: decision.emphasisWords,
    };

    return {
      originalText: rawText,
      expressiveText,
      ssml,
      profile,
      decision,
      audioHints: {
        voice: "Aoede",
        rate: decision.rate,
        pitch: decision.pitch,
        stylePrompt: `Speak in a warm, natural, ${emotion} tone with expressive pacing.`,
      },
    };
  }

  /**
   * Quick natural backchannel / acknowledgement for user speech barge-in.
   */
  public getQuickAcknowledgement(
    userUtterance: string,
    preferredLanguage?: DetectedLanguage
  ): string {
    const lang = preferredLanguage || this.detectLanguage(userUtterance);
    const lower = userUtterance.toLowerCase();

    if (lang === "hindi") {
      if (/रुको|रुकिए|stop|wait/i.test(lower)) return "जी, रुक गई।";
      if (/मदद|help|error/i.test(lower)) return "हाँ सुनो, बताइए क्या हुआ?";
      return "हाँ, सुन रही हूँ...";
    }

    if (lang === "hinglish") {
      if (/ruko|wait|stop/i.test(lower)) return "Wait, main ruk gayi.";
      if (/help|error|problem/i.test(lower)) return "Haan bolo, let's fix it.";
      return "Haan, sun rahi hoon...";
    }

    // English
    if (/stop|wait|pause/i.test(lower)) return "Holding on, go ahead.";
    if (/error|issue|problem/i.test(lower)) return "I hear you, let's look at it.";
    return "Listening, go ahead...";
  }

  // ── Private Helpers ────────────────────────────────────────────────────────

  private getCandidatesForEmotion(
    emotion: EmotionState,
    language: DetectedLanguage
  ): string[] {
    switch (language) {
      case "hindi":
        switch (emotion) {
          case "happy":
            return ["अरे वाह!", "हाहा!", "बहुत बढ़िया!"];
          case "excited":
            return ["अरे वाह!", "कमाल है!", "वाह!"];
          case "curious":
            return ["हम्म...", "अच्छा...", "देखते हैं..."];
          case "concerned":
            return ["ओहो...", "अरे...", "रुकिए..."];
          case "calm":
            return ["हाँ...", "बिल्कुल...", "ठीक है..."];
          default:
            return [];
        }

      case "hinglish":
        switch (emotion) {
          case "happy":
            return ["Aha!", "Haha!", "Arre waah!", "Nice!"];
          case "excited":
            return ["Oh wow!", "Aha!", "Super!", "Waah!"];
          case "curious":
            return ["Hmm...", "Achha...", "Wait ek second...", "Dekhte hain..."];
          case "concerned":
            return ["Oho...", "Wait...", "Arre...", "Hmm, let me check..."];
          case "calm":
            return ["Haan...", "Bilkul...", "Sure...", "I see..."];
          default:
            return [];
        }

      case "english":
      default:
        switch (emotion) {
          case "happy":
            return ["Aha!", "Haha!", "Oh wonderful!", "Nice!"];
          case "excited":
            return ["Oh wow!", "Aha!", "Awesome!"];
          case "curious":
            return ["Hmm...", "Oh?", "Let's see...", "Wait..."];
          case "concerned":
            return ["Oh...", "Wait...", "Hmm, let me check..."];
          case "calm":
            return ["I see...", "Alright...", "Sure...", "Understood..."];
          default:
            return [];
        }
    }
  }

  private isFillerEligible(filler: string): boolean {
    const normalized = filler.toLowerCase().replace(/[^a-z\u0900-\u097F]/g, "");
    const recent = this.recentFillers.slice(-this.fillerCooldownTurns);
    return !recent.some((r) => r.toLowerCase().replace(/[^a-z\u0900-\u097F]/g, "") === normalized);
  }

  private recordFillerUsage(filler: string): void {
    this.recentFillers.push(filler);
    if (this.recentFillers.length > this.maxFillerHistory) {
      this.recentFillers.shift();
    }
  }

  private selectBestCandidate(candidates: string[], text: string): string {
    // Simple deterministic hash based on text length to provide variety without being chaotic
    const index = Math.abs(text.length) % candidates.length;
    return candidates[index];
  }

  private computeRateAndPitch(
    emotion: EmotionState,
    isUrgent: boolean
  ): { rate: number; pitch: number } {
    if (isUrgent) {
      return { rate: 1.05, pitch: 1.0 };
    }

    switch (emotion) {
      case "calm":
        return { rate: 0.92, pitch: 0.98 };
      case "concerned":
        return { rate: 0.95, pitch: 0.97 };
      case "neutral":
        return { rate: 1.0, pitch: 1.0 };
      case "curious":
        return { rate: 1.0, pitch: 1.03 };
      case "happy":
        return { rate: 1.06, pitch: 1.07 };
      case "excited":
        return { rate: 1.14, pitch: 1.11 };
    }
  }

  private calculatePauseMarkers(text: string, emotion: EmotionState): PauseMarker[] {
    const markers: PauseMarker[] = [];
    const punctuationRegex = /([.,;!?—])/g;
    let match: RegExpExecArray | null;

    while ((match = punctuationRegex.exec(text)) !== null) {
      const char = match[1];
      let durationMs = 150;
      let type: "micro" | "short" | "thoughtful" = "short";

      if (char === ",") {
        durationMs = emotion === "calm" ? 180 : 100;
        type = "micro";
      } else if (char === "—" || char === ";") {
        durationMs = 250;
        type = "thoughtful";
      } else if (char === "." || char === "!" || char === "?") {
        durationMs = emotion === "calm" ? 350 : 250;
        type = "short";
      }

      markers.push({
        index: match.index,
        durationMs,
        type,
        markerText: char,
      });
    }

    return markers;
  }

  private identifyEmphasisWords(text: string, emotion: EmotionState): string[] {
    const words = text.split(/\s+/);
    const keyCandidates: string[] = [];

    const emphasisRegex =
      /\b(absolutely|completely|definitely|important|crucial|critical|safely|successfully|always|never|zaruri|bilkul|turant|dhyan|fix|resolved|done)\b/i;

    for (const w of words) {
      const clean = w.replace(/[^a-zA-Z\u0900-\u097F]/g, "");
      if (clean && emphasisRegex.test(clean) && !keyCandidates.includes(clean)) {
        keyCandidates.push(clean);
        if (keyCandidates.length >= 3) break;
      }
    }

    return keyCandidates;
  }

  private applyRhythmicPausesToText(text: string): string {
    // If text already has code blocks, preserve code blocks verbatim
    const parts = text.split(/(```[\s\S]*?```|`[^`]+`)/g);

    return parts
      .map((part) => {
        if (part.startsWith("`") || part.startsWith("```")) {
          return part; // keep code untouched
        }

        let formatted = part;
        // Turn rapid run-on punctuation into spaced breathing rhythm
        formatted = formatted.replace(/\.\.\.+/g, "... ");
        // Ensure space after commas for natural micro-pause
        formatted = formatted.replace(/,([^\s\d])/g, ", $1");
        // Ensure space after sentence ends
        formatted = formatted.replace(/([.!?])([A-Z\u0900-\u097F])/g, "$1 $2");
        return formatted;
      })
      .join("");
  }

  private buildSsml(
    text: string,
    decision: ProsodyDecision,
    emotion: EmotionState
  ): string {
    // Wrap with prosody rate and pitch
    const ratePercent = Math.round(decision.rate * 100);
    const pitchPercent = Math.round((decision.pitch - 1.0) * 100);
    const pitchStr = pitchPercent >= 0 ? `+${pitchPercent}%` : `${pitchPercent}%`;

    let body = text;
    // Replace pauses with SSML breaks (outside code tags)
    body = body.replace(/\.\.\.\s*/g, '<break time="300ms"/> ');
    body = body.replace(/—\s*/g, ' <break time="200ms"/> ');

    // Add word emphasis
    for (const word of decision.emphasisWords) {
      const regex = new RegExp(`\\b(${word})\\b`, "gi");
      body = body.replace(regex, '<emphasis level="moderate">$1</emphasis>');
    }

    return `<speak><prosody rate="${ratePercent}%" pitch="${pitchStr}">${body}</prosody></speak>`;
  }

  private isPurelyTechnicalOrFactual(text: string, userPrompt?: string): boolean {
    const combined = `${userPrompt || ""} ${text}`.toLowerCase();

    // Technical flags
    if (/```|npm |git |pip |import |export |const |function |class |powershell/i.test(text)) {
      return true;
    }

    // Factual queries (math, specs, direct definitions)
    if (
      /\b(what is \d+|calculate|square root|formula|git status|cpu usage|memory usage|file path|port number|ip address)\b/i.test(
        combined
      )
    ) {
      return true;
    }

    // Status reports
    if (/^(all steps completed|test passed|exit code|build succeeded)/i.test(text.trim())) {
      return true;
    }

    return false;
  }

  private containsRomanticOrSexualContent(text: string): boolean {
    const forbidden = /\b(romantic|dating|boyfriend|girlfriend roleplay|sexy|kiss me|love me romantically|erotic|nsfw|sensual|baby doll)\b/i;
    return forbidden.test(text);
  }

  private sanitizeRoleplayIfAny(text: string): string {
    // If text contains romantic or explicit roleplay tropes, sanitize to warm companion tone
    return text.replace(/\*(kisses|embraces passionately|blushes sexually)\*/gi, "").trim();
  }
}

export const speechProsodyEngine = new SpeechProsodyEngine();
