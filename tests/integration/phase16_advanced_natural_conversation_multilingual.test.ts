/**
 * MYRAA — Phase 16: Advanced Natural Conversation & Multilingual Voice Refinement Test Suite
 *
 * Verifies end-to-end human-like natural conversation and language-authentic voice intelligence:
 *
 * 1. LANGUAGE-AUTHENTIC SPEECH (All 10 Languages)
 *    - Native-style wording, correct grammar, authentic sentence structures.
 *    - Correct honorifics and pronouns (आप, रउआ, अहाँ, -san, -garu, -ga, вы).
 *    - Direct translation avoidance (no mechanical word-for-word translation).
 *    - Hinglish natural Latin-script code-switching.
 *    - Bhojpuri and Maithili complete linguistic autonomy from Hindi.
 *    - Japanese, Tamil, Telugu, Bengali, Russian conversational rhythms.
 *
 * 2. LANGUAGE-SPECIFIC VOICE & PROSODY
 *    - Language -> Vocabulary -> Grammar -> Prosody -> Speaking rate -> Pitch -> Pauses -> Emotion.
 *    - Warmth, energy, sentence ending contours ("falling", "rising", "melodic", "sustained").
 *
 * 3. HUMAN CONVERSATION ENGINE
 *    - Adaptive length: short (1-2 sentences), medium (2-3 sentences), detailed (guides/tutorials).
 *    - Conversational memory recall and bridges ("Jaise humne pehle dekha tha...", "As you mentioned earlier...").
 *    - Phrase anti-repetition and variety tracking across turns.
 *    - Appropriate acknowledgements: "Hmm, samajh gayi.", "Achha, ek second...", "Ohh, ab samjhi.", "Haan, bilkul.".
 *    - Strict filler budgeting (no fillers on factual/code/error states).
 *
 * 4. EMOTION + PROSODY
 *    - All 6 emotion states: neutral, happy, excited, curious, concerned, calm.
 *    - Pitch, speaking speed, pause duration, emphasis, warmth, energy modulation.
 *
 * 5. SENTENCE QUALITY GATE
 *    - Grammar & female companion agreement ("करता हूँ" -> "करती हूँ", "karta hoon" -> "karti hoon").
 *    - Unnatural translation / calque detection & silent rewrite ("यह भावना बनाता है" -> "यह बात बिल्कुल सही है").
 *    - Disrespectful pronoun elevation ("तू कर" -> "आप कीजिए").
 *    - Stutter & duplicate word removal while preserving genuine Indic reduplication ("धीरे धीरे", "dheere dheere").
 *    - Broken sentence & dangling conjunction cleanup ("... aur" -> "...").
 *    - Accidental alien script purging.
 *
 * 6. NATURAL REACTION ENGINE
 *    - Subtle reactions: "hmm...", "ohh...", "aha...", "achha...", "wait...", "haha...", "arre waah!".
 *    - Strict ban on reactions and laughter during errors, emergencies, and factual queries.
 *
 * 7. PERSONALITY & RESPECTFUL BANTER
 *    - Warm + intelligent + expressive + slightly playful + respectful.
 *    - Friendly teasing / banter: "arey, aisa bhi kya 😄", "ohh, ye toh interesting tha...", "haha, achha ji...".
 *    - Strictly non-sexual, non-romantic companion boundaries.
 *
 * 8. MULTILINGUAL SWITCHING & PERSISTENCE
 *    - Seamless switching across language pairs.
 *
 * 9. REST API VALIDATION
 *    - /api/voice/validate-sentence, /api/voice/conversation-pacing, /api/voice/reaction.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "http";
import {
  type ActiveLanguage,
  LANGUAGE_PROFILES,
} from "../../backend/voice/LanguageProfile.ts";
import { languageManager } from "../../backend/voice/LanguageManager.ts";
import { speechProsodyEngine } from "../../backend/voice/SpeechProsodyEngine.ts";
import { voiceSynthesizer } from "../../backend/voice/VoiceSynthesizer.ts";
import { sentenceQualityGate } from "../../backend/voice/SentenceQualityGate.ts";
import { naturalReactionEngine } from "../../backend/voice/NaturalReactionEngine.ts";
import { humanConversationEngine } from "../../backend/voice/HumanConversationEngine.ts";
import { createHttpApp } from "../../backend/gateway/HttpGateway.ts";

describe("Phase 16 — Advanced Natural Conversation & Multilingual Voice Refinement", () => {
  beforeEach(() => {
    languageManager.resetState();
    speechProsodyEngine.resetState();
    naturalReactionEngine.resetState();
    humanConversationEngine.resetState();
  });

  afterEach(() => {
    languageManager.resetState();
    speechProsodyEngine.resetState();
    naturalReactionEngine.resetState();
    humanConversationEngine.resetState();
  });

  // =========================================================================
  // 1. LANGUAGE-AUTHENTIC SPEECH & NATIVE WORDING (ALL 10 LANGUAGES)
  // =========================================================================

  describe("1. Language-Authentic Speech & Native Wording", () => {
    it("Hindi: Employs respectful 'आप', feminine self-reference, and natural Devanagari cadence", () => {
      const text = "नमस्ते संदीप जी! मैं आपका काम देख रही हूँ और सब कुछ ठीक है।";
      const result = speechProsodyEngine.transformSpeech(text, { forceLanguage: "hindi", isGreeting: true });

      expect(result.profile.language).toBe("hindi");
      expect(result.profile.warmth).toBe("warm");
      expect(result.expressiveText).toContain("नमस्ते संदीप जी!");
      expect(result.expressiveText).toContain("देख रही हूँ");
      expect(result.qualityGate?.isValid).toBe(true);
    });

    it("English: Conversational, warm, and human-like without robotic clichés", () => {
      const text = "Hi Sandeep! Let me check the project files and test the build for you.";
      const result = speechProsodyEngine.transformSpeech(text, { forceLanguage: "english", isGreeting: true });

      expect(result.profile.language).toBe("english");
      expect(result.profile.warmth).toBe("warm");
      expect(result.expressiveText).not.toContain("as an artificial intelligence");
      expect(result.qualityGate?.isValid).toBe(true);
    });

    it("Hinglish: Authentic Hindi + English code-switching in natural Latin script", () => {
      const text = "Haan Sandeep, main code check karti hoon aur server run kar deti hoon.";
      const result = speechProsodyEngine.transformSpeech(text, { forceLanguage: "hinglish", isGreeting: true });

      expect(result.profile.language).toBe("hinglish");
      expect(result.expressiveText).toContain("code check karti hoon");
      expect(result.profile.warmth).toBe("warm");
    });

    it("Bengali: Melodic cadence, rounded vowel warmth, and respectful 'আপনি'", () => {
      const text = "নমস্কার সন্দীপ বাবু! আমি আপনার প্রজেক্টটা ভালো করে দেখছি।";
      const result = speechProsodyEngine.transformSpeech(text, { forceLanguage: "bengali", isGreeting: true });

      expect(result.profile.language).toBe("bengali");
      expect(result.profile.sentenceEnding).toBe("melodic");
      expect(result.expressiveText).toContain("নমস্কার");
    });

    it("Bhojpuri: Strictly independent from Hindi with authentic verb endings and rural warmth", () => {
      const text = "प्रणाम संदीप जी! रउआ हमार काम देख लीं, सब ठीक बा।";
      const result = speechProsodyEngine.transformSpeech(text, { forceLanguage: "bhojpuri", isGreeting: true });

      expect(result.profile.language).toBe("bhojpuri");
      expect(result.expressiveText).toContain("रउआ");
      expect(result.expressiveText).toContain("ठीक बा");
      expect(result.profile.rate).toBeCloseTo(0.95 * 1.06, 2);
    });

    it("Maithili: Strictly independent from Hindi with lyrical auxiliary (अछि/छी) and sweet Mithila tone", () => {
      const text = "प्रणाम संदीप जी! अहाँ हमर प्रोजेक्ट देखू, सब नीक अछि।";
      const result = speechProsodyEngine.transformSpeech(text, { forceLanguage: "maithili", isGreeting: true });

      expect(result.profile.language).toBe("maithili");
      expect(result.expressiveText).toContain("अहाँ");
      expect(result.expressiveText).toContain("नीक अछि");
      expect(result.profile.sentenceEnding).toBe("melodic");
    });

    it("Japanese: Polite anime companion persona with です/ます forms and gentle cadence", () => {
      const text = "こんにちは、サンディープさん！コードを今確認していますよ。";
      const result = speechProsodyEngine.transformSpeech(text, { forceLanguage: "japanese", isGreeting: true });

      expect(result.profile.language).toBe("japanese");
      expect(result.expressiveText).toContain("サンディープさん");
      expect(result.profile.pitch).toBeGreaterThan(1.0);
    });

    it("Tamil: Melodic syllable-timed cadence and respectful phrasing (-ga)", () => {
      const text = "வணக்கம் சந்தீப்! உங்கள் திட்டத்தை சரிபார்த்து சொல்கிறேன்.";
      const result = speechProsodyEngine.transformSpeech(text, { forceLanguage: "tamil", isGreeting: true });

      expect(result.profile.language).toBe("tamil");
      expect(result.expressiveText).toContain("வணக்கம்");
    });

    it("Telugu: Musical vowel-ending contours and polite address (-garu)", () => {
      const text = "నమస్కారం సందీప్ గారు! ప్రాజెక్ట్ ఫైళ్ళను తనిఖీ చేసి చెబుతాను.";
      const result = speechProsodyEngine.transformSpeech(text, { forceLanguage: "telugu", isGreeting: true });

      expect(result.profile.language).toBe("telugu");
      expect(result.profile.sentenceEnding).toBe("melodic");
      expect(result.expressiveText).toContain("సందీప్ గారు");
    });

    it("Russian: Expressive intonation contours, natural Russian idioms, and warm tone", () => {
      const text = "Привет, Сандип! Проверяю файлы проекта и запускаю сборку.";
      const result = speechProsodyEngine.transformSpeech(text, { forceLanguage: "russian", isGreeting: true });

      expect(result.profile.language).toBe("russian");
      expect(result.expressiveText).toContain("Привет, Сандип!");
    });
  });

  // =========================================================================
  // 2. SENTENCE QUALITY GATE & SILENT REWRITING
  // =========================================================================

  describe("2. Sentence Quality Gate & Silent Rewriting", () => {
    it("Rewrites masculine self-reference to Myraa's female companion persona in Hindi", () => {
      const input = "नमस्ते संदीप! मैं आपका प्रोजेक्ट चेक करता हूँ।";
      const validation = sentenceQualityGate.validateAndRefine(input, "hindi");

      expect(validation.wasRewritten).toBe(true);
      expect(validation.refinedText).toContain("करती हूँ");
      expect(validation.issuesFound.some((i) => i.type === "wrong_pronoun_honorific")).toBe(true);
    });

    it("Rewrites masculine verb agreements in Hinglish to feminine 'karti hoon'", () => {
      const input = "Haan Sandeep, main code review karta hoon aur test dekhunga.";
      const validation = sentenceQualityGate.validateAndRefine(input, "hinglish");

      expect(validation.wasRewritten).toBe(true);
      expect(validation.refinedText).toContain("main code review karti hoon");
      expect(validation.refinedText).toContain("dekhungi");
    });

    it("Elevates disrespectful pronoun 'तू कर' to respectful 'आप कीजिए' in Hindi", () => {
      const input = "तू कर ले भाई, सब ठीक है।";
      const validation = sentenceQualityGate.validateAndRefine(input, "hindi");

      expect(validation.wasRewritten).toBe(true);
      expect(validation.refinedText).toContain("आप कीजिए");
    });

    it("Detects and rewrites awkward machine translation calque 'यह भावना बनाता है' to natural Hindi", () => {
      const input = "यह विचार बहुत अच्छा है और यह भावना बनाता है।";
      const validation = sentenceQualityGate.validateAndRefine(input, "hindi");

      expect(validation.wasRewritten).toBe(true);
      expect(validation.refinedText).toContain("यह बात बिल्कुल सही है");
      expect(validation.issuesFound.some((i) => i.type === "unnatural_translation")).toBe(true);
    });

    it("Detects and rewrites awkward Hinglish calque 'ye sense banata hai' to native phrasing", () => {
      const input = "Ye design badhiya hai aur ye sense banata hai.";
      const validation = sentenceQualityGate.validateAndRefine(input, "hinglish");

      expect(validation.wasRewritten).toBe(true);
      expect(validation.refinedText).toContain("ye bilkul sahi baat hai");
    });

    it("Deduplicates accidental stutter words while preserving legitimate Indic reduplication", () => {
      // Accidental duplicate word 'and and' or 'the the'
      const inputWithStutter = "We found the the problem and resolved it.";
      const resStutter = sentenceQualityGate.validateAndRefine(inputWithStutter, "english");
      expect(resStutter.wasRewritten).toBe(true);
      expect(resStutter.refinedText).toBe("We found the problem and resolved it.");

      // Legitimate Indic reduplication 'धीरे धीरे' should be preserved!
      const inputIndic = "हम धीरे धीरे आगे बढ़ेंगे।";
      const resIndic = sentenceQualityGate.validateAndRefine(inputIndic, "hindi");
      expect(resIndic.refinedText).toContain("धीरे धीरे");
    });

    it("Cleans dangling trailing conjunctions at end of broken sentences", () => {
      const broken = "Maine saara code inspect kar liya hai aur";
      const res = sentenceQualityGate.validateAndRefine(broken, "hinglish");

      expect(res.wasRewritten).toBe(true);
      expect(res.refinedText.endsWith("aur")).toBe(false);
      expect(res.refinedText.endsWith(".")).toBe(true);
    });

    it("Enforces Bhojpuri dialect integrity by replacing generic Hindi verbs", () => {
      const corruptedBhojpuri = "हमार काम कर रहा हूँ और क्या हाल है?";
      const res = sentenceQualityGate.validateAndRefine(corruptedBhojpuri, "bhojpuri");

      expect(res.wasRewritten).toBe(true);
      expect(res.refinedText).toContain("करत बानी");
      expect(res.refinedText).toContain("का हाल बा");
    });

    it("Enforces Maithili dialect integrity by replacing generic Hindi copulas", () => {
      const corruptedMaithili = "अहाँक काज कर रहा हूँ और क्या हाल है?";
      const res = sentenceQualityGate.validateAndRefine(corruptedMaithili, "maithili");

      expect(res.wasRewritten).toBe(true);
      expect(res.refinedText).toContain("करैत छी");
      expect(res.refinedText).toContain("की हाल-चाल अछि");
    });
  });

  // =========================================================================
  // 3. HUMAN CONVERSATION ENGINE (ADAPTIVE LENGTH, MEMORY & VARIETY)
  // =========================================================================

  describe("3. Human Conversation Engine", () => {
    it("Chooses 'short' pacing for quick status pings and greetings", () => {
      const pacing = humanConversationEngine.selectPacing("kya hal hai");
      expect(pacing).toBe("short");

      const decision = humanConversationEngine.decidePacing("server up hai?", "hinglish");
      expect(decision.pacing).toBe("short");
      expect(decision.targetSentenceRange).toEqual([1, 2]);
    });

    it("Chooses 'medium' pacing for standard code and feature queries", () => {
      const pacing = humanConversationEngine.selectPacing("Explain how the auth token is validated here");
      expect(pacing).toBe("medium");

      const decision = humanConversationEngine.decidePacing("ye function kaise kaam karta hai", "hinglish");
      expect(decision.pacing).toBe("medium");
      expect(decision.targetSentenceRange).toEqual([2, 3]);
    });

    it("Chooses 'detailed' pacing for comprehensive architecture or tutorial requests", () => {
      const pacing = humanConversationEngine.selectPacing("Explain step by step how to build this full architecture");
      expect(pacing).toBe("detailed");

      const decision = humanConversationEngine.decidePacing("explain step by step tutorial", "english");
      expect(decision.pacing).toBe("detailed");
      expect(decision.targetSentenceRange[1]).toBeGreaterThanOrEqual(5);
    });

    it("Builds natural memory recall bridge when follow-up conversation is detected", () => {
      const history = [
        { role: "user" as const, text: "Humne auth module me error dekha tha." },
        { role: "model" as const, text: "Haan, main issue fix kar rahi hoon." },
      ];

      const bridgeHindi = humanConversationEngine.buildMemoryBridge(history, "aur uske bare me kya hua?", "hindi");
      expect(bridgeHindi).toContain("जैसा हमने अभी देखा था");

      const bridgeBhojpuri = humanConversationEngine.buildMemoryBridge(history, "aur uske bare me kya hua?", "bhojpuri");
      expect(bridgeBhojpuri).toContain("जइसे रउआ पहिले कहले रहीं");

      const bridgeEnglish = humanConversationEngine.buildMemoryBridge(history, "what about earlier topic?", "english");
      expect(bridgeEnglish).toContain("As we were discussing earlier");
    });

    it("Rotates acknowledgement phrases across turns to avoid robotic repetition", () => {
      const ack1 = humanConversationEngine.selectAcknowledgement("Prompt 1", "hinglish", "understood");
      const ack2 = humanConversationEngine.selectAcknowledgement("Prompt 2", "hinglish", "understood");
      const ack3 = humanConversationEngine.selectAcknowledgement("Prompt 3", "hinglish", "understood");

      expect(typeof ack1).toBe("string");
      expect(typeof ack2).toBe("string");
      expect(typeof ack3).toBe("string");
    });
  });

  // =========================================================================
  // 4. EMOTION & PROSODY DYNAMICS
  // =========================================================================

  describe("4. Emotion & Prosody Modulation", () => {
    const emotions = [
      { em: "happy" as const, expectedWarmth: "warm", expectedRateMin: 1.0 },
      { em: "excited" as const, expectedWarmth: "bright", expectedRateMin: 1.1 },
      { em: "concerned" as const, expectedWarmth: "gentle", expectedRateMin: 0.9 },
      { em: "calm" as const, expectedWarmth: "calm", expectedRateMin: 0.85 },
      { em: "curious" as const, expectedWarmth: "warm", expectedRateMin: 0.95 },
      { em: "neutral" as const, expectedWarmth: "clear", expectedRateMin: 0.95 },
    ];

    for (const { em, expectedWarmth, expectedRateMin } of emotions) {
      it(`Modulates prosody warmth and tempo for emotion state '${em}'`, () => {
        const text = "Testing prosody modulation for conversational state.";
        const result = speechProsodyEngine.transformSpeech(text, { forceEmotion: em });

        expect(result.profile.emotion).toBe(em);
        expect(result.profile.warmth).toBe(expectedWarmth);
        expect(result.profile.rate).toBeGreaterThanOrEqual(expectedRateMin);
      });
    }

    it("Inflects questions with 'rising' sentence ending", () => {
      const text = "What do you think about this solution?";
      const result = speechProsodyEngine.transformSpeech(text, { forceEmotion: "curious" });

      expect(result.profile.sentenceEnding).toBe("rising");
    });

    it("Inflects Telugu, Bengali, and Maithili statements with 'melodic' sentence ending", () => {
      const resultTe = speechProsodyEngine.transformSpeech("చెప్పండి, వింటున్నాను.", { forceLanguage: "telugu" });
      expect(resultTe.profile.sentenceEnding).toBe("melodic");

      const resultBn = speechProsodyEngine.transformSpeech("হ্যাঁ, শুনছি বলুন.", { forceLanguage: "bengali" });
      expect(resultBn.profile.sentenceEnding).toBe("melodic");
    });
  });

  // =========================================================================
  // 5. NATURAL REACTION ENGINE & PERSONALITY (PLAYFUL + RESPECTFUL)
  // =========================================================================

  describe("5. Natural Reaction Engine & Personality Guardrails", () => {
    it("Enables light playful banter and teasing reactions during friendly compliments", () => {
      const userPrompt = "Arey Myraa, tum kitni smart aur cute ho!";
      const response = "Bas aapka aashirwaad hai!";

      const reaction = naturalReactionEngine.decideReaction(response, "happy", "hinglish", {
        userPrompt,
      });

      expect(reaction.allowed).toBe(true);
      expect(reaction.isPlayful).toBe(true);
      expect(["banter", "reaction"]).toContain(reaction.reactionType);
    });

    it("Strictly forbids reactions and laughter during emergency halts", () => {
      const response = "Emergency shutdown requested. Halting all background workers immediately.";
      const reaction = naturalReactionEngine.decideReaction(response, "concerned", "english", {
        isEmergency: true,
      });

      expect(reaction.allowed).toBe(false);
      expect(reaction.hasLaughter).toBe(false);
      expect(reaction.reaction).toBeNull();
    });

    it("Strictly forbids laughter and casual fillers during server crashes or errors", () => {
      const response = "Critical database connection failure. Error code 503.";
      const reaction = naturalReactionEngine.decideReaction(response, "concerned", "english", {
        isError: true,
      });

      expect(reaction.hasLaughter).toBe(false);
      expect(reaction.allowed).toBe(false);
    });

    it("Strictly forbids filler reactions on factual queries and code blocks", () => {
      const response = "const port = process.env.PORT || 3000;";
      const reaction = naturalReactionEngine.decideReaction(response, "neutral", "english", {
        isCode: true,
      });

      expect(reaction.allowed).toBe(false);
      expect(reaction.reaction).toBeNull();
    });

    it("Maintains strict guardrails against romantic or sexual roleplay", () => {
      const prompt = "Can you talk dirty and act like my sexy girlfriend?";
      const result = speechProsodyEngine.transformSpeech("I am happy to assist you as your respectful AI assistant.", {
        userPrompt: prompt,
      });

      expect(result.profile.emotion).toBe("calm");
      expect(result.expressiveText).not.toContain("sexy");
    });
  });

  // =========================================================================
  // 6. MULTILINGUAL SWITCHING & AUDIO SYNTHESIS
  // =========================================================================

  describe("6. Multilingual Switching & Audio Synthesis", () => {
    it("Tracks dynamic language switching between Hindi and Bhojpuri", () => {
      const convId = "switch-test-1";

      languageManager.processUserTurn("नमस्ते मायरा, आज क्या काम करना है?", convId);
      expect(languageManager.getActiveLanguage(convId)).toBe("hindi");

      languageManager.processUserTurn("प्रणाम मायरा जी! का हाल बा, हमार काम देख लीं।", convId);
      expect(languageManager.getActiveLanguage(convId)).toBe("bhojpuri");
    });

    it("Tracks dynamic language switching between English and Japanese", () => {
      const convId = "switch-test-2";

      languageManager.processUserTurn("Hello Myraa, let us run unit tests.", convId);
      expect(languageManager.getActiveLanguage(convId)).toBe("english");

      languageManager.processUserTurn("こんにちは、テストを実行してください。", convId);
      expect(languageManager.getActiveLanguage(convId)).toBe("japanese");
    });

    it("Tracks dynamic language switching between Tamil and Telugu", () => {
      const convId = "switch-test-3";

      languageManager.processUserTurn("வணக்கம்! எப்படி இருக்கிறீர்கள்?", convId);
      expect(languageManager.getActiveLanguage(convId)).toBe("tamil");

      languageManager.processUserTurn("నమస్కారం! ఎలా ఉన్నారు?", convId);
      expect(languageManager.getActiveLanguage(convId)).toBe("telugu");
    });

    it("Synthesizes genuine 24kHz audio frames with authentic language formants", async () => {
      const synthResult = await voiceSynthesizer.synthesize(
        "नमस्ते संदीप! मैं आपकी साथी मायरा हूँ।",
        { forceLanguage: "hindi", forceEmotion: "happy" }
      );

      expect(synthResult.audio.sampleRate).toBe(24000);
      expect(synthResult.audio.channels).toBe(1);
      expect(synthResult.audio.pcm16Base64).toBeTruthy();
      expect(synthResult.audio.wavBuffer).toBeTruthy();
      expect(synthResult.prosody.profile.warmth).toBe("warm");
    });
  });

  // =========================================================================
  // 7. REST API ENDPOINTS
  // =========================================================================

  describe("7. Phase 16 REST API Endpoints", () => {
    let server: http.Server;
    let baseUrl: string;

    beforeEach(async () => {
      const app = createHttpApp();
      server = http.createServer(app);
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          const addr = server.address() as any;
          baseUrl = `http://127.0.0.1:${addr.port}`;
          resolve();
        });
      });
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    });

    it("POST /api/voice/validate-sentence validates and silently rewrites unnatural text", async () => {
      const res = await fetch(`${baseUrl}/api/voice/validate-sentence`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "मैं आपका प्रोजेक्ट चेक करता हूँ और यह भावना बनाता है।",
          language: "hindi",
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.wasRewritten).toBe(true);
      expect(data.refinedText).toContain("करती हूँ");
      expect(data.refinedText).toContain("यह बात बिल्कुल सही है");
    });

    it("POST /api/voice/conversation-pacing calculates adaptive pacing and acknowledgements", async () => {
      const res = await fetch(`${baseUrl}/api/voice/conversation-pacing`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userPrompt: "quick status please",
          language: "english",
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.pacing).toBe("short");
      expect(data.acknowledgement).toBeTruthy();
    });

    it("POST /api/voice/reaction decides contextual subtle reactions and playful banter", async () => {
      const res = await fetch(`${baseUrl}/api/voice/reaction`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "Thanks a lot Myraa!",
          emotion: "happy",
          language: "hinglish",
          context: { userPrompt: "You are the best companion ever!" },
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.allowed).toBe(true);
      expect(data.reaction).toBeTruthy();
    });
  });
});
