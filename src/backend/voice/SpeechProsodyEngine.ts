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
import { languageManager } from "./LanguageManager.ts";

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
  forceLanguage?: DetectedLanguage;
  conversationId?: string;
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
   * Detect language across all 10 supported languages via LanguageManager.
   */
  public detectLanguage(text: string): DetectedLanguage {
    if (!text) return "english";
    return languageManager.detectLanguage(text).language;
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
    context?: ProsodyContext,
    forcedLanguage?: DetectedLanguage
  ): ProsodyDecision {
    const language = forcedLanguage || context?.forceLanguage || this.detectLanguage(text);
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
      const playfulCues = /(haha|joke|funny|kidding|lol|mazaak|chutkula|hasi|giggle|playful|clever|hilarious|चुटकुला|मजेदार|हाहा|हंसी|কা কথা বা|হাসি|মজার|はは|ふふ|面白い|ジョーク|சிரிப்பு|హాస్యం|шутка|смешно|ха-ха)/i;
      const combined = `${context?.userPrompt || ""} ${text}`;
      if (playfulCues.test(combined)) {
        shouldAddLaughter = true;
        laughterToken = languageManager.getLanguageProfile(language).laughterToken;
      }
    }

    // ── 3. Speaking Speed & Pitch ───────────────────────────────────────────
    const { rate, pitch } = this.computeRateAndPitch(emotion, isUrgent, language);

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
    const language = context?.forceLanguage || this.detectLanguage(cleanRaw);
    const emotion = this.detectEmotion(cleanRaw, context);
    const decision = this.decideProsody(cleanRaw, context, language);

    let expressiveText = cleanRaw;

    // Apply laughter if appropriate and not already present
    if (decision.shouldAddLaughter && decision.laughterToken) {
      if (!/haha|hehe|हाहा|हंसी|হাহা|はは|ふふ|ஹாஹா|హాహా|ха-ха|\*giggles\*/i.test(expressiveText)) {
        expressiveText = `${decision.laughterToken} ${expressiveText}`;
      }
    }

    // Apply short natural reaction at beginning if appropriate and not already present
    if (decision.shouldAddReaction && decision.reaction) {
      const startsWithReaction =
        expressiveText.startsWith(decision.reaction) ||
        /^(hmm|ohh|oh|aha|haha|wait|oho|achha|acha|are waah|arre|हम्म|अच्छा|अरे वाह|বাহ|হুম|わあ|えーと|ஆஹா|ஆமாம்|ఆహా|సరే|Ого|Хм)\b/iu.test(
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

    const langProfile = languageManager.getLanguageProfile(language);

    return {
      originalText: rawText,
      expressiveText,
      ssml,
      profile,
      decision,
      audioHints: {
        voice: langProfile.ttsConfig.geminiVoice,
        rate: decision.rate,
        pitch: decision.pitch,
        stylePrompt: `Speak in a warm, natural, ${emotion} tone in ${langProfile.name} with expressive pacing.`,
      },
    };
  }

  /**
   * Quick natural backchannel / acknowledgement for user speech barge-in.
   * Fully supports all 10 languages with authentic cultural phrases.
   */
  public getQuickAcknowledgement(
    userUtterance: string,
    preferredLanguage?: DetectedLanguage
  ): string {
    const lang = preferredLanguage || this.detectLanguage(userUtterance);
    const profile = languageManager.getLanguageProfile(lang);
    const lower = userUtterance.toLowerCase();

    // Stop / Interruption cues across languages (native script and romanized)
    if (/stop|wait|pause|ruko|roko|rukiye|रुको|रुकिए|रुकीं|रुकु|रुकि जाउ|दাঁড়ান|நில்லுங்கள்|ఆగండి|стоп|подождите|ちょっと待って|待って/i.test(lower)) {
      return profile.quickAcknowledgements.stopAck;
    }

    // Help / Error / Crash cues across languages
    if (/help|error|problem|crash|madad|galti|मदद|सहायता|সাহায্য|உதவி|సహాయం|помощь|ошибка|助けて|困った/i.test(lower)) {
      return profile.quickAcknowledgements.helpAck;
    }

    // Greeting cues across languages
    if (/hi|hello|hey|namaste|pranam|নমস্কার|வணக்கம்|నమస్కారం|привет|こんにちは/i.test(lower)) {
      return profile.quickAcknowledgements.greetingAck;
    }

    return profile.quickAcknowledgements.defaultAck;
  }

  // ── Private Helpers ────────────────────────────────────────────────────────

  private getCandidatesForEmotion(
    emotion: EmotionState,
    language: DetectedLanguage
  ): string[] {
    const profile = languageManager.getLanguageProfile(language);
    return profile.fillersByEmotion[emotion] || [];
  }

  private isFillerEligible(filler: string): boolean {
    const normalized = filler.toLowerCase().replace(/[^\p{L}]/gu, "");
    const recent = this.recentFillers.slice(-this.fillerCooldownTurns);
    return !recent.some((r) => r.toLowerCase().replace(/[^\p{L}]/gu, "") === normalized);
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
    isUrgent: boolean,
    language?: DetectedLanguage
  ): { rate: number; pitch: number } {
    let rate = 1.0;
    let pitch = 1.0;

    if (isUrgent) {
      rate = 1.05;
      pitch = 1.0;
    } else {
      switch (emotion) {
        case "calm":
          rate = 0.92;
          pitch = 0.98;
          break;
        case "concerned":
          rate = 0.95;
          pitch = 0.97;
          break;
        case "neutral":
          rate = 1.0;
          pitch = 1.0;
          break;
        case "curious":
          rate = 1.0;
          pitch = 1.03;
          break;
        case "happy":
          rate = 1.06;
          pitch = 1.07;
          break;
        case "excited":
          rate = 1.14;
          pitch = 1.11;
          break;
      }
    }

    if (language) {
      const profile = languageManager.getLanguageProfile(language);
      rate = Math.round(rate * profile.ttsConfig.rateMultiplier * 100) / 100;
      pitch = Math.round(pitch * profile.ttsConfig.pitchMultiplier * 100) / 100;
    }

    return { rate, pitch };
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
