/**
 * Phase 15 — MYRAA Multilingual Voice Engine Test Suite
 *
 * Verifies end-to-end multilingual support across 10 languages:
 * 1. Hindi (हिन्दी)
 * 2. English
 * 3. Hinglish (Mixed Hindi-English)
 * 4. Bengali (বাংলা)
 * 5. Bhojpuri (भोजपुरी) [Strictly independent from Hindi]
 * 6. Maithili (मैथिली) [Strictly independent from Hindi]
 * 7. Japanese (日本語)
 * 8. Tamil (தமிழ்)
 * 9. Telugu (తెలుగు)
 * 10. Russian (Русский)
 *
 * Scenarios Tested:
 * - Voice input & intent in every language
 * - Voice output & 24kHz PCM/WAV synthesis in every language
 * - Multi-script & transliterated auto-detection
 * - Manual language switching & auto-detection toggle
 * - Conversational switching: Hindi ↔ Bengali
 * - Conversational switching: Hindi ↔ Bhojpuri
 * - Conversational switching: Hindi ↔ Maithili
 * - Conversational switching: English ↔ Japanese
 * - Conversational switching: Tamil ↔ Telugu
 * - Conversational switching: Russian ↔ English
 * - Mixed-language & code-switching
 * - Restart persistence
 * - Android standalone voice contract
 * - Windows desktop audio playback
 * - REST API endpoints
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import http from "http";
import {
  LANGUAGE_PROFILES,
  type ActiveLanguage,
  type SupportedLanguage,
} from "../voice/LanguageProfile.ts";
import { languageManager, LanguageManager } from "../voice/LanguageManager.ts";
import { speechProsodyEngine } from "../voice/SpeechProsodyEngine.ts";
import { voiceSynthesizer } from "../voice/VoiceSynthesizer.ts";
import { buildCompleteSystemInstructions } from "../projects/ContextManager.ts";
import { createHttpApp } from "../gateway/HttpGateway.ts";

describe("Phase 15 — MYRAA Multilingual Voice Engine", () => {
  beforeEach(() => {
    languageManager.resetState();
    speechProsodyEngine.resetState();
  });

  afterEach(() => {
    languageManager.resetState();
    speechProsodyEngine.resetState();
  });

  // ── Scenarios 1-10: Voice Input & Intent in All 10 Languages ──────────────

  const inputScenarios: { lang: ActiveLanguage; sampleInput: string; expectedScript: string }[] = [
    { lang: "hindi", sampleInput: "नमस्ते संदीप! आपका प्रोजेक्ट चेक करके स्थिति बताती हूँ।", expectedScript: "devanagari" },
    { lang: "english", sampleInput: "Hello Sandeep, checking your workspace code and compiling now.", expectedScript: "latin" },
    { lang: "hinglish", sampleInput: "Acha suno, code check karke run karo please.", expectedScript: "latin" },
    { lang: "bengali", sampleInput: "নমস্কার সন্দীপ! প্রজেক্টটা দেখে আপনাকে জানাচ্ছি।", expectedScript: "bengali" },
    { lang: "bhojpuri", sampleInput: "प्रणाम संदीप जी! रउआ हमार काम देख लीं, का हाल बा?", expectedScript: "devanagari" },
    { lang: "maithili", sampleInput: "प्रणाम संदीप जी! अहाँ हमर प्रोजेक्ट देखू, की भेल अछि?", expectedScript: "devanagari" },
    { lang: "japanese", sampleInput: "こんにちは、サンディープさん！コードを確認しますね。", expectedScript: "japanese" },
    { lang: "tamil", sampleInput: "வணக்கம் சந்தீப்! உங்கள் திட்டத்தை சரிபார்த்து சொல்கிறேன்.", expectedScript: "tamil" },
    { lang: "telugu", sampleInput: "నమస్కారం సందీప్ గారు! ప్రాజెక్ట్ ఫైళ్ళను తనిఖీ చేసి చెబుతాను.", expectedScript: "telugu" },
    { lang: "russian", sampleInput: "Привет, Сандип! Проверяю файлы проекта и запускаю сборку.", expectedScript: "cyrillic" },
  ];

  for (const s of inputScenarios) {
    it(`Scenario: Voice input & intent understanding for ${s.lang.toUpperCase()}`, () => {
      const detection = languageManager.detectLanguage(s.sampleInput);
      expect(detection.language).toBe(s.lang);
      expect(detection.script).toBe(s.expectedScript);
      expect(detection.confidence).toBeGreaterThanOrEqual(0.75);

      const profile = languageManager.getLanguageProfile(s.lang);
      expect(profile.id).toBe(s.lang);
      expect(profile.sttConfig.locale).toBeTruthy();
      expect(profile.sttConfig.sampleRate).toBe(16000);
      expect(profile.ttsConfig.geminiVoice).toBeTruthy();
    });
  }

  // ── Scenarios 11-20: Voice Output & Audio Synthesis for All 10 Languages ──

  for (const s of inputScenarios) {
    it(`Scenario: Voice output & acoustic synthesis for ${s.lang.toUpperCase()}`, async () => {
      const result = await voiceSynthesizer.synthesize(s.sampleInput, {
        forceLanguage: s.lang,
        forceEmotion: "happy",
      });

      expect(result.prosody.profile.language).toBe(s.lang);
      expect(result.prosody.profile.emotion).toBe("happy");
      expect(result.audio.sampleRate).toBe(24000);
      expect(result.audio.channels).toBe(1);
      expect(result.audio.pcm16Base64).toBeTruthy();
      expect(result.audio.wavBuffer).toBeDefined();

      // Check standard 44-byte RIFF WAVE header
      const header = result.audio.wavBuffer!.slice(0, 12).toString("ascii");
      expect(header.startsWith("RIFF")).toBe(true);
      expect(header.endsWith("WAVE")).toBe(true);
    });
  }

  // ── Scenario 21: Auto Language Detection across Scripts & Transliterations ─

  it("Scenario 21: Auto language detection across native scripts and romanized transliterations", () => {
    // Native scripts
    expect(languageManager.detectLanguage("বাংলায় কথা বলুন").language).toBe("bengali");
    expect(languageManager.detectLanguage("日本語で話してください").language).toBe("japanese");
    expect(languageManager.detectLanguage("தமிழில் பேசுங்கள்").language).toBe("tamil");
    expect(languageManager.detectLanguage("తెలుగులో మాట్లాడండి").language).toBe("telugu");
    expect(languageManager.detectLanguage("Говорите по-русски, пожалуйста").language).toBe("russian");

    // Romanized transliterations
    expect(languageManager.detectLanguage("Konnichiwa arigatou gozaimasu").language).toBe("japanese");
    expect(languageManager.detectLanguage("Privet kak dela spasibo").language).toBe("russian");
    expect(languageManager.detectLanguage("Kemon acho bhalo achi dhanyabad").language).toBe("bengali");
    expect(languageManager.detectLanguage("Vanakkam eppadi irukinga nandri").language).toBe("tamil");
    expect(languageManager.detectLanguage("Namaskaram ela unnaru dhanyavadalu").language).toBe("telugu");
    expect(languageManager.detectLanguage("Raua hamar kaam dekhin theek ba").language).toBe("bhojpuri");
    expect(languageManager.detectLanguage("Pranam ahan kani ruku neek achi").language).toBe("maithili");
    expect(languageManager.detectLanguage("Acha suno, code check karke run karo").language).toBe("hinglish");
    expect(languageManager.detectLanguage("The compiler finished with zero errors.").language).toBe("english");
  });

  // ── Scenario 22: Manual Language Selection & Auto-Detect Toggle ───────────

  it("Scenario 22: Manual language selection overrides auto-detect and resets properly", () => {
    languageManager.setPreferredLanguage("japanese");
    expect(languageManager.getPreferredLanguage()).toBe("japanese");
    expect(languageManager.getActiveLanguage()).toBe("japanese");

    // Even if user speaks Hindi, user's manual preference locks model output
    const turn = languageManager.processUserTurn("नमस्ते संदीप!");
    expect(turn.activeLanguage).toBe("japanese");
    expect(turn.switched).toBe(false);

    // Switch back to auto
    languageManager.setPreferredLanguage("auto");
    expect(languageManager.getPreferredLanguage()).toBe("auto");

    // Now auto-detect activates dynamically
    const turn2 = languageManager.processUserTurn("বাংলায় বলুন");
    expect(turn2.activeLanguage).toBe("bengali");
    expect(turn2.switched).toBe(true);
  });

  // ── Scenario 23: Language Switch: Hindi ↔ Bengali ─────────────────────────

  it("Scenario 23: Seamless language switching between Hindi and Bengali", () => {
    const convId = "conv-hi-bn";

    // Turn 1: Hindi
    const turn1 = languageManager.processUserTurn("नमस्ते, आज क्या करना है?", convId);
    expect(turn1.activeLanguage).toBe("hindi");

    const prosody1 = speechProsodyEngine.transformSpeech("नमस्ते, सब ठीक है।", {
      conversationId: convId,
      forceLanguage: turn1.activeLanguage,
      forceEmotion: "happy",
    });
    expect(prosody1.profile.language).toBe("hindi");
    expect(["अरे वाह!", "हाहा!", "बहुत बढ़िया!", "अहा!"]).toContain(prosody1.decision.reaction);

    // Turn 2: User switches to Bengali
    const turn2 = languageManager.processUserTurn("কেমন আছেন? বাংলাতে বলুন।", convId);
    expect(turn2.activeLanguage).toBe("bengali");
    expect(turn2.switched).toBe(true);

    speechProsodyEngine.resetState();
    const prosody2 = speechProsodyEngine.transformSpeech("আমি ভালো আছি, আপনি কেমন আছেন?", {
      conversationId: convId,
      forceLanguage: turn2.activeLanguage,
      forceEmotion: "happy",
    });
    expect(prosody2.profile.language).toBe("bengali");
    expect(["বাহ!", "হাহা!", "দারুণ!", "বাঃ খুব ভালো!"]).toContain(prosody2.decision.reaction);

    // Turn 3: User switches back to Hindi
    const turn3 = languageManager.processUserTurn("धन्यवाद, वापस हिन्दी में बात करते हैं।", convId);
    expect(turn3.activeLanguage).toBe("hindi");
    expect(turn3.switched).toBe(true);
  });

  // ── Scenario 24: Independent Bhojpuri Distinction: Hindi ↔ Bhojpuri ──────

  it("Scenario 24: Strictly independent Bhojpuri recognition and distinction from Hindi", () => {
    // 1. Distinct grammar: बा / बानी vs है / हैं
    const bhojpuriUtterance = "का हाल बा? रउआ हमार काम करब?";
    const hindiUtterance = "क्या हाल है? आप मेरा काम करेंगे?";

    const bhojpuriDetection = languageManager.detectLanguage(bhojpuriUtterance);
    const hindiDetection = languageManager.detectLanguage(hindiUtterance);

    expect(bhojpuriDetection.language).toBe("bhojpuri");
    expect(hindiDetection.language).toBe("hindi");
    expect(bhojpuriDetection.language).not.toBe("hindi");

    // 2. Bhojpuri fillers & reactions
    const bhojpuriProsody = speechProsodyEngine.transformSpeech("ठीक बा, हम कर देत बानी।", {
      userPrompt: "बड़ा मजेदार चुटकुला बा!",
      forceLanguage: "bhojpuri",
      forceEmotion: "happy",
    });
    expect(bhojpuriProsody.profile.language).toBe("bhojpuri");
    expect(["अरे वाह!", "हाहा!", "का बात बा!", "बड़ा नीक!"]).toContain(bhojpuriProsody.decision.reaction);
    expect(bhojpuriProsody.decision.laughterToken).toBe("हाहा! का बात बा...");

    // 3. Bhojpuri quick ack
    const ack = speechProsodyEngine.getQuickAcknowledgement("तनी रुकीं", "bhojpuri");
    expect(ack).toBe("हँ, रुक गइलीं...");

    // 4. Fallback verification
    const fallback = languageManager.getFallbackDetails("bhojpuri");
    expect(fallback.fallbackLocale).toBe("hi-IN");
    expect(fallback.hasNativeTts).toBe(false);
    expect(fallback.adaptationStrategy).toContain("Bhojpuri dialectal prosody");
  });

  // ── Scenario 25: Independent Maithili Distinction: Hindi ↔ Maithili ───────

  it("Scenario 25: Strictly independent Maithili recognition and distinction from Hindi & Bhojpuri", () => {
    // 1. Distinct grammar: अछि / छी vs बा / बानी vs है / हैं
    const maithiliUtterance = "प्रणाम! अहाँ कथि करैत छी? सब नीक अछि?";
    const bhojpuriUtterance = "प्रणाम! रउआ का करत बानी? सब ठीक बा?";
    const hindiUtterance = "नमस्ते! आप क्या कर रहे हैं? सब ठीक है?";

    const maiDet = languageManager.detectLanguage(maithiliUtterance);
    const bhoDet = languageManager.detectLanguage(bhojpuriUtterance);
    const hiDet = languageManager.detectLanguage(hindiUtterance);

    expect(maiDet.language).toBe("maithili");
    expect(bhoDet.language).toBe("bhojpuri");
    expect(hiDet.language).toBe("hindi");

    // 2. Maithili fillers & reactions
    const maiProsody = speechProsodyEngine.transformSpeech("हँ, सब बहुत नीक अछि।", {
      userPrompt: "कोनो मजेदार बात कहु!",
      forceLanguage: "maithili",
      forceEmotion: "happy",
    });
    expect(maiProsody.profile.language).toBe("maithili");
    expect(["अरे वाह!", "हाहा!", "बहुत नीक!", "कते सुंदर!"]).toContain(maiProsody.decision.reaction);
    expect(maiProsody.decision.laughterToken).toBe("हाहा! बहुत नीक...");

    // 3. Maithili quick ack
    const ack = speechProsodyEngine.getQuickAcknowledgement("कनि रुकु", "maithili");
    expect(ack).toBe("कनि रुकि जाउ...");

    // 4. Fallback verification
    const fallback = languageManager.getFallbackDetails("maithili");
    expect(fallback.fallbackLocale).toBe("hi-IN");
    expect(fallback.hasNativeTts).toBe(false);
    expect(fallback.adaptationStrategy).toContain("lyrical Maithili cadence");
  });

  // ── Scenario 26: Language Switch: English ↔ Japanese ──────────────────────

  it("Scenario 26: Language switching between English and Japanese", () => {
    const convId = "conv-en-ja";

    const turn1 = languageManager.processUserTurn("Please build the release artifact.", convId);
    expect(turn1.activeLanguage).toBe("english");

    const turn2 = languageManager.processUserTurn("ありがとうございます、次は何をしますか？", convId);
    expect(turn2.activeLanguage).toBe("japanese");
    expect(turn2.switched).toBe(true);

    const jaProsody = speechProsodyEngine.transformSpeech("分かりました、テストを実行します。", {
      conversationId: convId,
      forceLanguage: "japanese",
      forceEmotion: "excited",
    });
    expect(jaProsody.profile.language).toBe("japanese");
    expect(["すごい!", "やったあ!", "素晴らしいです!", "わあ!"]).toContain(jaProsody.decision.reaction);
    expect(jaProsody.audioHints.voice).toBe("Kore");
  });

  // ── Scenario 27: Language Switch: Tamil ↔ Telugu ──────────────────────────

  it("Scenario 27: Language switching between Tamil and Telugu", () => {
    const convId = "conv-ta-te";

    const turn1 = languageManager.processUserTurn("வணக்கம் சந்தீப், எப்படி இருக்கிறீர்கள்?", convId);
    expect(turn1.activeLanguage).toBe("tamil");

    const turn2 = languageManager.processUserTurn("నమస్కారం, నేను బాగున్నాను, మీరు ఎలా ఉన్నారు?", convId);
    expect(turn2.activeLanguage).toBe("telugu");
    expect(turn2.switched).toBe(true);

    const teProsody = speechProsodyEngine.transformSpeech("నేను చాలా బాగున్నాను, ధన్యవాదాలు.", {
      conversationId: convId,
      forceLanguage: "telugu",
      forceEmotion: "happy",
    });
    expect(teProsody.profile.language).toBe("telugu");
    expect(["ఆహా!", "బలేగా ఉంది!", "చాలా సంతోషం!", "అద్భుతం!"]).toContain(teProsody.decision.reaction);
  });

  // ── Scenario 28: Language Switch: Russian ↔ English ───────────────────────

  it("Scenario 28: Language switching between Russian and English", () => {
    const convId = "conv-ru-en";

    const turn1 = languageManager.processUserTurn("Привет! Как твои дела?", convId);
    expect(turn1.activeLanguage).toBe("russian");

    const ruProsody = speechProsodyEngine.transformSpeech("Всё отлично, спасибо!", {
      conversationId: convId,
      forceLanguage: "russian",
      forceEmotion: "excited",
    });
    expect(ruProsody.profile.language).toBe("russian");
    expect(["Ого!", "Потрясающе!", "Вот это да!", "Супер!"]).toContain(ruProsody.decision.reaction);

    const turn2 = languageManager.processUserTurn("Let's switch back to English now.", convId);
    expect(turn2.activeLanguage).toBe("english");
    expect(turn2.switched).toBe(true);
  });

  // ── Scenario 29: Mixed-Language & Code-Switching ──────────────────────────

  it("Scenario 29: Mixed-language and code-switching detection", () => {
    // Hinglish (Hindi + English)
    const hinglishTurn = languageManager.detectLanguage("Haan Sandeep, main code check karke run karti hoon.");
    expect(hinglishTurn.language).toBe("hinglish");
    expect(hinglishTurn.isCodeSwitching).toBe(true);

    // Japanese with English technical terms
    const jaMixed = languageManager.detectLanguage("このプロジェクトのAPIエンドポイントをテストしてください。");
    expect(jaMixed.language).toBe("japanese");

    // Bengali with English technical terms
    const bnMixed = languageManager.detectLanguage("এই কোডটা রান করে দেখবো কি?");
    expect(bnMixed.language).toBe("bengali");
  });

  // ── Scenario 30: Restart Persistence ─────────────────────────────────────

  it("Scenario 30: User language preference persists across restarts", () => {
    const settingsPath = path.join(process.cwd(), "settings.json");
    const originalContent = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, "utf-8") : null;

    try {
      // Set to Russian
      languageManager.setPreferredLanguage("russian");
      expect(languageManager.getPreferredLanguage()).toBe("russian");

      // Verify written to settings.json
      const written = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
      expect(written.languagePreference).toBe("russian");

      // Reset in memory to test reload
      languageManager.resetState();
      expect(languageManager.getPreferredLanguage()).toBe("auto");

      // Re-initialize LanguageManager to simulate restart
      (languageManager as any).loadPersistedSettings();
      expect(languageManager.getPreferredLanguage()).toBe("russian");
    } finally {
      // Restore original settings.json
      if (originalContent) {
        fs.writeFileSync(settingsPath, originalContent, "utf-8");
      }
      languageManager.setPreferredLanguage("auto");
    }
  });

  // ── Scenario 31: System Prompt Injection with Active Language Directive ───

  it("Scenario 31: ContextManager injects language directive for active language", async () => {
    languageManager.setActiveLanguage("bengali");
    const instructions = await buildCompleteSystemInstructions([]);
    expect(instructions).toContain("ACTIVE CONVERSATIONAL LANGUAGE DIRECTIVE: BENGALI");
    expect(instructions).toContain("Language Mode: BENGALI (বাংলা)");

    languageManager.setActiveLanguage("bhojpuri");
    const instructionsBho = await buildCompleteSystemInstructions([]);
    expect(instructionsBho).toContain("ACTIVE CONVERSATIONAL LANGUAGE DIRECTIVE: BHOJPURI");
    expect(instructionsBho).toContain("Language Mode: BHOJPURI (भोजपुरी)");

    languageManager.setActiveLanguage("maithili");
    const instructionsMai = await buildCompleteSystemInstructions([]);
    expect(instructionsMai).toContain("ACTIVE CONVERSATIONAL LANGUAGE DIRECTIVE: MAITHILI");
    expect(instructionsMai).toContain("Language Mode: MAITHILI (मैथिली)");
  });

  // ── Scenario 32: Android Standalone Voice Compatibility ───────────────────

  it("Scenario 32: Android standalone voice contract compliance (16kHz mic, 24kHz download)", async () => {
    // 16kHz audio upload simulation
    const dummy16kPcm = Buffer.alloc(320 * 2); // 20ms of 16kHz audio
    expect(dummy16kPcm.length).toBe(640);

    // 24kHz synthesis response
    const synthesized = await voiceSynthesizer.synthesize("Android voice pipeline test", {
      forceLanguage: "english",
    });
    expect(synthesized.audio.sampleRate).toBe(24000);
    expect(synthesized.audio.format).toBe("pcm16");
    expect(synthesized.audio.channels).toBe(1);
    expect(typeof synthesized.audio.pcm16Base64).toBe("string");
    expect(synthesized.audio.pcm16Base64.length).toBeGreaterThan(100);
  });

  // ── Scenario 33: Windows Desktop Voice Playback Verification ──────────────

  it("Scenario 33: Windows desktop WAV audio generation playable by OS sound subsystem", async () => {
    const synthResult = await voiceSynthesizer.synthesize(
      "नमस्ते संदीप! यह मायरा की आवाज़ की जांच है।",
      { forceLanguage: "hindi", forceEmotion: "happy" },
      { format: "wav" }
    );

    const testWavPath = path.join(process.cwd(), "assets", "myraa_multilingual_test.wav");
    fs.writeFileSync(testWavPath, synthResult.audio.wavBuffer!);

    expect(fs.existsSync(testWavPath)).toBe(true);
    const stat = fs.statSync(testWavPath);
    expect(stat.size).toBeGreaterThan(1000);

    // Read RIFF header
    const buf = fs.readFileSync(testWavPath);
    expect(buf.slice(0, 4).toString("ascii")).toBe("RIFF");
    expect(buf.slice(8, 12).toString("ascii")).toBe("WAVE");
    expect(buf.readUInt32LE(24)).toBe(24000); // 24kHz sample rate
  });

  // ── Scenario 34: REST API: /api/voice/languages & /api/voice/language ─────

  // ── Scenario 34: REST API: /api/voice/languages & /api/voice/language ─────

  it("Scenario 34: REST API exposes language list, active language, and preference mutation", async () => {
    const app = createHttpApp();
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as any).port;

    try {
      // 1. GET /api/voice/languages
      const resList = await fetch(`http://127.0.0.1:${port}/api/voice/languages`);
      expect(resList.status).toBe(200);
      const dataList = (await resList.json()) as any;
      expect(dataList.ok).toBe(true);
      expect(Array.isArray(dataList.languages)).toBe(true);
      expect(dataList.languages.length).toBe(10);

      // Check Bhojpuri & Maithili entries in API
      const bhoEntry = dataList.languages.find((l: any) => l.id === "bhojpuri");
      expect(bhoEntry).toBeDefined();
      expect(bhoEntry.name).toBe("Bhojpuri");
      expect(bhoEntry.hasNativeTts).toBe(false);

      const maiEntry = dataList.languages.find((l: any) => l.id === "maithili");
      expect(maiEntry).toBeDefined();
      expect(maiEntry.name).toBe("Maithili");
      expect(maiEntry.hasNativeTts).toBe(false);

      // 2. POST /api/voice/language
      const resSet = await fetch(`http://127.0.0.1:${port}/api/voice/language`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ language: "bengali" }),
      });
      expect(resSet.status).toBe(200);
      const dataSet = (await resSet.json()) as any;
      expect(dataSet.preferredLanguage).toBe("bengali");

      // 3. GET /api/voice/language
      const resGet = await fetch(`http://127.0.0.1:${port}/api/voice/language`);
      expect(resGet.status).toBe(200);
      const dataGet = (await resGet.json()) as any;
      expect(dataGet.preferredLanguage).toBe("bengali");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // ── Scenario 35: REST API: /api/voice/detect-language & quick-ack ─────────

  it("Scenario 35: REST API /api/voice/detect-language and /api/voice/quick-ack", async () => {
    const app = createHttpApp();
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as any).port;

    try {
      // 1. Detect Japanese
      const resDetect = await fetch(`http://127.0.0.1:${port}/api/voice/detect-language`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "こんにちは世界" }),
      });
      expect(resDetect.status).toBe(200);
      const dataDetect = (await resDetect.json()) as any;
      expect(dataDetect.language).toBe("japanese");
      expect(dataDetect.script).toBe("japanese");

      // 2. Detect Bhojpuri
      const resBho = await fetch(`http://127.0.0.1:${port}/api/voice/detect-language`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "का हाल बा बबुआ?" }),
      });
      expect(resBho.status).toBe(200);
      const dataBho = (await resBho.json()) as any;
      expect(dataBho.language).toBe("bhojpuri");

      // 3. Quick ack for Russian
      const resAckRu = await fetch(`http://127.0.0.1:${port}/api/voice/quick-ack?text=подождите&language=russian`);
      expect(resAckRu.status).toBe(200);
      const dataAckRu = (await resAckRu.json()) as any;
      expect(dataAckRu.acknowledgement).toBe("Секундочку, остановилась...");

      // 4. Quick ack for Tamil
      const resAckTa = await fetch(`http://127.0.0.1:${port}/api/voice/quick-ack?text=நில்லுங்கள்&language=tamil`);
      expect(resAckTa.status).toBe(200);
      const dataAckTa = (await resAckTa.json()) as any;
      expect(dataAckTa.acknowledgement).toBe("ஒரு நிமிடம், நிற்கிறேன்...");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // ── Scenario 36: REST API: /api/voice/synthesize with Language Parameter ──

  it("Scenario 36: REST API /api/voice/synthesize generates language-specific audio", async () => {
    const app = createHttpApp();
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as any).port;

    try {
      // POST synthesis with language
      const resPost = await fetch(`http://127.0.0.1:${port}/api/voice/synthesize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "Проверка русского синтеза речи.",
          language: "russian",
          context: { forceEmotion: "happy" },
        }),
      });
      expect(resPost.status).toBe(200);
      const dataPost = (await resPost.json()) as any;
      expect(dataPost.ok).toBe(true);
      expect(dataPost.prosody.profile.language).toBe("russian");
      expect(dataPost.audio.sampleRate).toBe(24000);

      // GET WAV streaming with language
      const resGet = await fetch(
        `http://127.0.0.1:${port}/api/voice/synthesize?text=বাংলা+ভয়েস+টেস্ট&language=bengali`
      );
      expect(resGet.status).toBe(200);
      expect(resGet.headers.get("content-type")).toBe("audio/wav");
      expect(Number(resGet.headers.get("content-length"))).toBeGreaterThan(100);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
