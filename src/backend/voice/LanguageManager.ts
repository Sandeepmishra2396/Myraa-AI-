/**
 * MYRAA — LanguageManager
 *
 * Central orchestrator for multilingual voice intelligence:
 * 1. Automatic multi-script and transliterated language detection across 10 languages.
 * 2. Independent linguistic distinction for Bhojpuri (भोजपुरी) and Maithili (मैथिली)
 *    preventing conflation with generic Hindi.
 * 3. Manual language override vs. Auto Detect mode.
 * 4. Per-conversation/session language tracking with seamless real-time language switching.
 * 5. Mixed-language and code-switching detection (Hinglish, Tanglish, loanwords).
 * 6. Language-specific STT/TTS configurations, vowel formants, and graceful fallback handling.
 * 7. System prompt directive generation for Gemini Live.
 * 8. Persistence to settings.json across application restarts.
 */

import fs from "fs";
import path from "path";
import {
  type SupportedLanguage,
  type ActiveLanguage,
  type LanguageProfile,
  type ScriptType,
  type SttLanguageConfig,
  type TtsLanguageConfig,
  LANGUAGE_PROFILES,
} from "./LanguageProfile.ts";

export interface LanguageDetectionResult {
  language: ActiveLanguage;
  confidence: number; // 0.0 - 1.0
  script: ScriptType;
  isCodeSwitching: boolean;
  secondaryLanguage?: ActiveLanguage;
  matchedMarkers: string[];
}

export interface LanguageSwitchEvent {
  conversationId: string;
  from: ActiveLanguage;
  to: ActiveLanguage;
  timestamp: number;
  trigger: string;
}

export class LanguageManager {
  private static instance: LanguageManager;

  private preferredLanguage: SupportedLanguage = "auto";
  private conversationLanguages: Map<string, ActiveLanguage> = new Map();
  private lastDetectedLanguage: ActiveLanguage = "english";
  private switchHistory: LanguageSwitchEvent[] = [];
  private readonly defaultConversationId = "default";

  private constructor() {
    this.loadPersistedSettings();
  }

  public static getInstance(): LanguageManager {
    if (!LanguageManager.instance) {
      LanguageManager.instance = new LanguageManager();
    }
    return LanguageManager.instance;
  }

  /**
   * Reset session state (useful for tests).
   */
  public resetState(): void {
    this.preferredLanguage = "auto";
    this.conversationLanguages.clear();
    this.lastDetectedLanguage = "english";
    this.switchHistory = [];
  }

  // ── Language Preference & Conversation State ──────────────────────────────

  public getPreferredLanguage(): SupportedLanguage {
    return this.preferredLanguage;
  }

  public setPreferredLanguage(language: SupportedLanguage): void {
    this.preferredLanguage = language;
    if (language !== "auto") {
      this.conversationLanguages.set(this.defaultConversationId, language);
    }
    this.persistSettings();
  }

  public getActiveLanguage(conversationId: string = this.defaultConversationId): ActiveLanguage {
    if (this.preferredLanguage !== "auto") {
      return this.preferredLanguage;
    }
    return this.conversationLanguages.get(conversationId) || this.lastDetectedLanguage || "english";
  }

  public setActiveLanguage(
    language: ActiveLanguage,
    conversationId: string = this.defaultConversationId,
    trigger: string = "manual"
  ): void {
    const previous = this.getActiveLanguage(conversationId);
    this.conversationLanguages.set(conversationId, language);
    this.lastDetectedLanguage = language;

    if (previous !== language) {
      this.switchHistory.push({
        conversationId,
        from: previous,
        to: language,
        timestamp: Date.now(),
        trigger,
      });
    }
  }

  public getSwitchHistory(): LanguageSwitchEvent[] {
    return [...this.switchHistory];
  }

  // ── Multi-Script & Dialect Language Detection ─────────────────────────────

  /**
   * Automatic language detection across 10 languages:
   * Analyzes native scripts (Bengali, Japanese, Tamil, Telugu, Russian, Devanagari)
   * and differentiates between Hindi, Bhojpuri, Maithili, and Hinglish.
   */
  public detectLanguage(text: string): LanguageDetectionResult {
    if (!text || !text.trim()) {
      return {
        language: "english",
        confidence: 0.5,
        script: "latin",
        isCodeSwitching: false,
        matchedMarkers: [],
      };
    }

    const trimmed = text.trim();
    const lower = trimmed.toLowerCase();

    // ── 1. Script-Level Detection ───────────────────────────────────────────

    // 1A. Bengali Script
    if (/[\u0980-\u09FF]/.test(trimmed)) {
      return {
        language: "bengali",
        confidence: 0.98,
        script: "bengali",
        isCodeSwitching: /[a-zA-Z]/.test(trimmed),
        matchedMarkers: ["bengali_unicode_script"],
      };
    }

    // 1B. Japanese Scripts (Hiragana, Katakana, Kanji)
    if (/[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/.test(trimmed)) {
      return {
        language: "japanese",
        confidence: 0.99,
        script: "japanese",
        isCodeSwitching: /[a-zA-Z]/.test(trimmed),
        matchedMarkers: ["japanese_unicode_script"],
      };
    }

    // 1C. Tamil Script
    if (/[\u0B80-\u0BFF]/.test(trimmed)) {
      return {
        language: "tamil",
        confidence: 0.98,
        script: "tamil",
        isCodeSwitching: /[a-zA-Z]/.test(trimmed),
        matchedMarkers: ["tamil_unicode_script"],
      };
    }

    // 1D. Telugu Script
    if (/[\u0C00-\u0C7F]/.test(trimmed)) {
      return {
        language: "telugu",
        confidence: 0.98,
        script: "telugu",
        isCodeSwitching: /[a-zA-Z]/.test(trimmed),
        matchedMarkers: ["telugu_unicode_script"],
      };
    }

    // 1E. Russian / Cyrillic Script
    if (/[\u0400-\u04FF]/.test(trimmed)) {
      return {
        language: "russian",
        confidence: 0.98,
        script: "cyrillic",
        isCodeSwitching: /[a-zA-Z]/.test(trimmed),
        matchedMarkers: ["cyrillic_unicode_script"],
      };
    }

    // ── 2. Devanagari Script: Hindi vs. Bhojpuri vs. Maithili ───────────────
    if (/[\u0900-\u097F]/.test(trimmed)) {
      const devanagariWords = new Set(trimmed.match(/[\u0900-\u097F]+/g) || []);

      // 2A. Bhojpuri Markers (Distinct auxiliary verbs, pronouns, verbs, and idioms)
      const bhojpuriWordList = [
        "बा", "बाटे", "बानी", "बानीं", "बानीस",
        "रउआ", "राउर", "हमार", "तोहार", "तोहरा", "अपन",
        "करब", "जाइब", "आइब", "देखब", "कहब", "सुनब", "तनी", "लइका", "मेहरारू",
        "काहे", "कइसे", "कइसेन", "केकरा", "एकर", "ओकर", "उनकर", "बबुआ", "गइलीं", "लीं"
      ];
      const bhojpuriPhrases = [
        "का हाल बा", "का कहत बानी", "गोड़ लागतानी", "का बात बा", "ठीक बा", "का हो",
        "अरे बबुआ", "देख लीं", "तनी रुकीं", "रुक गइलीं", "कर देत बानी", "का करत बानी"
      ];

      let bhojpuriScore = 0;
      const matchedBhojpuri: string[] = [];

      for (const phrase of bhojpuriPhrases) {
        if (trimmed.includes(phrase)) {
          bhojpuriScore += 3;
          matchedBhojpuri.push(phrase);
        }
      }
      for (const word of bhojpuriWordList) {
        if (devanagariWords.has(word)) {
          bhojpuriScore += 2;
          matchedBhojpuri.push(word);
        }
      }

      // 2B. Maithili Markers (Distinct auxiliary verbs, pronouns, verbs, and idioms)
      const maithiliWordList = [
        "अछि", "छथि", "छी", "छै", "छियै", "छल", "छलाह",
        "अहाँ", "अहाँक", "अपने", "अपनेक", "हमर", "तोहर", "तोहरहु",
        "नीक", "बेस", "कनि", "कथि", "कतय", "कहिया", "केहेन", "कोना",
        "कएल", "कयल", "कहल", "सुनल", "जाउ", "आउ", "कहु", "देखू", "रुकि"
      ];
      const maithiliPhrases = [
        "की भेल", "बहुत नीक", "बड़ा नीक", "कते सुंदर", "करैत छी", "जय मिथिला",
        "कनि रुकु", "रुकि जाउ", "सब नीक"
      ];

      let maithiliScore = 0;
      const matchedMaithili: string[] = [];

      for (const phrase of maithiliPhrases) {
        if (trimmed.includes(phrase)) {
          maithiliScore += 3;
          matchedMaithili.push(phrase);
        }
      }
      for (const word of maithiliWordList) {
        if (devanagariWords.has(word)) {
          maithiliScore += 2;
          matchedMaithili.push(word);
        }
      }

      if (bhojpuriScore > 0 && bhojpuriScore >= maithiliScore) {
        return {
          language: "bhojpuri",
          confidence: Math.min(0.80 + bhojpuriScore * 0.05, 0.99),
          script: "devanagari",
          isCodeSwitching: /[a-zA-Z]/.test(trimmed),
          matchedMarkers: matchedBhojpuri,
        };
      }

      if (maithiliScore > 0 && maithiliScore > bhojpuriScore) {
        return {
          language: "maithili",
          confidence: Math.min(0.80 + maithiliScore * 0.05, 0.99),
          script: "devanagari",
          isCodeSwitching: /[a-zA-Z]/.test(trimmed),
          matchedMarkers: matchedMaithili,
        };
      }

      // Default Devanagari is Hindi
      return {
        language: "hindi",
        confidence: 0.95,
        script: "devanagari",
        isCodeSwitching: /[a-zA-Z]/.test(trimmed),
        matchedMarkers: ["devanagari_hindi"],
      };
    }

    // ── 3. Latin Script / Transliterated Token Detection ─────────────────────

    // 3A. Japanese Romaji
    const japaneseRomaji = /\b(konnichiwa|arigatou|sayonara|kudasai|sumimasen|desu|masu|wakarimashita|iie|ohayou|oyasumi)\b/i;
    if (japaneseRomaji.test(lower)) {
      return {
        language: "japanese",
        confidence: 0.92,
        script: "latin",
        isCodeSwitching: true,
        secondaryLanguage: "english",
        matchedMarkers: ["japanese_romaji"],
      };
    }

    // 3B. Russian Translit
    const russianTranslit = /\b(privet|spasibo|pozhaluysta|khorosho|kak dela|slushayu|ponyatno|do svidaniya)\b/i;
    if (russianTranslit.test(lower)) {
      return {
        language: "russian",
        confidence: 0.91,
        script: "latin",
        isCodeSwitching: true,
        secondaryLanguage: "english",
        matchedMarkers: ["russian_translit"],
      };
    }

    // 3C. Bengali Romanized
    const bengaliRomanized = /\b(nomoshkar|kemon acho|kemon achhen|bhalo achi|dhanyabad|ki korcho|bolun|shunchen)\b/i;
    if (bengaliRomanized.test(lower)) {
      return {
        language: "bengali",
        confidence: 0.91,
        script: "latin",
        isCodeSwitching: true,
        secondaryLanguage: "english",
        matchedMarkers: ["bengali_romanized"],
      };
    }

    // 3D. Tamil Romanized (Tanglish)
    const tamilRomanized = /\b(vanakkam|eppadi irukinga|nandri|sollunga|romba nandri|aamaam|illai|theriyum)\b/i;
    if (tamilRomanized.test(lower)) {
      return {
        language: "tamil",
        confidence: 0.91,
        script: "latin",
        isCodeSwitching: true,
        secondaryLanguage: "english",
        matchedMarkers: ["tamil_romanized"],
      };
    }

    // 3E. Telugu Romanized
    const teluguRomanized = /\b(namaskaram|ela unnaru|dhanyavadalu|cheppandi|bagundi|avunu|kaadu|emiti)\b/i;
    if (teluguRomanized.test(lower)) {
      return {
        language: "telugu",
        confidence: 0.91,
        script: "latin",
        isCodeSwitching: true,
        secondaryLanguage: "english",
        matchedMarkers: ["telugu_romanized"],
      };
    }

    // 3F. Bhojpuri Romanized
    const bhojpuriRomanized = /\b(raua|hamar|tohar|theek ba|kaise bani|gor lagatani|ka ho|tani ruki|ka baat ba)\b/i;
    if (bhojpuriRomanized.test(lower)) {
      return {
        language: "bhojpuri",
        confidence: 0.92,
        script: "latin",
        isCodeSwitching: true,
        secondaryLanguage: "hinglish",
        matchedMarkers: ["bhojpuri_romanized"],
      };
    }

    // 3G. Maithili Romanized
    const maithiliRomanized = /\b(pranam|ahan|achi|chathi|chhi|kani|neek|ki bhel|bes|jay mithila)\b/i;
    if (maithiliRomanized.test(lower)) {
      return {
        language: "maithili",
        confidence: 0.92,
        script: "latin",
        isCodeSwitching: true,
        secondaryLanguage: "hinglish",
        matchedMarkers: ["maithili_romanized"],
      };
    }

    // 3H. Hinglish (Mixed Latin Hindi)
    const hinglishMarkers = [
      /\b(kya|hai|hain|karo|karein|kaise|achha|acha|achhi|suno|batao|thik|theek|yaar|mera|meri|mere)\b/i,
      /\b(mujhe|tum|aap|hum|karna|hoga|hogi|nahi|nahin|haan|han|dekho|dekhein|chalo|bohot|bahut)\b/i,
      /\b(waah|arre|arey|are yaar|are waah|oho|shukriya|dhanyawad|kripya|bana|rakho|chal|raha|rahi|samjho|ruko|roko)\b/i,
      /\b(bhai|dost|kaam|karega|karegi|karke|lekin|magar|kyunki|isko|usko|yahan|wahan|bolo|boliye|suniye)\b/i,
    ];
    let hinglishCount = 0;
    const matchedHinglish: string[] = [];
    for (const rx of hinglishMarkers) {
      const match = lower.match(rx);
      if (match) {
        hinglishCount += match.length;
        matchedHinglish.push(match[0]);
      }
    }

    if (hinglishCount >= 1) {
      return {
        language: "hinglish",
        confidence: Math.min(0.70 + hinglishCount * 0.1, 0.95),
        script: "latin",
        isCodeSwitching: true,
        secondaryLanguage: "english",
        matchedMarkers: matchedHinglish,
      };
    }

    // 3I. Pure English default
    return {
      language: "english",
      confidence: 0.90,
      script: "latin",
      isCodeSwitching: false,
      matchedMarkers: ["english_syntax"],
    };
  }

  /**
   * Process a user conversational turn:
   * Detects language, resolves against user preference, triggers language switching
   * if user speaks a new language, and returns the active language to respond in.
   */
  public processUserTurn(
    text: string,
    conversationId: string = this.defaultConversationId
  ): {
    activeLanguage: ActiveLanguage;
    switched: boolean;
    previousLanguage: ActiveLanguage;
    detection: LanguageDetectionResult;
  } {
    const detection = this.detectLanguage(text);
    const previous = this.getActiveLanguage(conversationId);

    // If manual language preference is set (not auto), lock response to preference
    if (this.preferredLanguage !== "auto") {
      return {
        activeLanguage: this.preferredLanguage,
        switched: false,
        previousLanguage: previous,
        detection,
      };
    }

    // In Auto Detect mode: if detection is confident and different, switch language
    let active = previous;
    let switched = false;

    if (detection.confidence >= 0.70 && detection.language !== previous) {
      active = detection.language;
      switched = true;
      this.setActiveLanguage(active, conversationId, `auto_detected_${detection.script}`);
    } else {
      this.lastDetectedLanguage = active;
    }

    return {
      activeLanguage: active,
      switched,
      previousLanguage: previous,
      detection,
    };
  }

  // ── Profile, STT, and TTS Queries ─────────────────────────────────────────

  public getLanguageProfile(language?: SupportedLanguage | ActiveLanguage): LanguageProfile {
    const target: ActiveLanguage =
      !language || language === "auto"
        ? this.getActiveLanguage()
        : language;
    return LANGUAGE_PROFILES[target] || LANGUAGE_PROFILES.english;
  }

  public getAllProfiles(): LanguageProfile[] {
    return Object.values(LANGUAGE_PROFILES);
  }

  public getSttConfig(language?: ActiveLanguage): SttLanguageConfig {
    const target = language || this.getActiveLanguage();
    return this.getLanguageProfile(target).sttConfig;
  }

  public getTtsConfig(language?: ActiveLanguage): TtsLanguageConfig {
    const target = language || this.getActiveLanguage();
    return this.getLanguageProfile(target).ttsConfig;
  }

  public getFallbackDetails(language: ActiveLanguage): {
    hasNativeTts: boolean;
    hasNativeStt: boolean;
    fallbackLocale: string;
    adaptationStrategy: string;
  } {
    const profile = this.getLanguageProfile(language);
    return {
      hasNativeTts: profile.ttsConfig.providerNativeSupport,
      hasNativeStt: profile.sttConfig.providerNativeSupport,
      fallbackLocale: profile.ttsConfig.fallbackLocale,
      adaptationStrategy:
        language === "bhojpuri"
          ? "Uses hi-IN audio fallback with specialized Bhojpuri dialectal prosody, vowel lengthening, and authentic vocabulary"
          : language === "maithili"
          ? "Uses hi-IN audio fallback with lyrical Maithili cadence, sweet pitch lift, and distinctive grammar"
          : language === "hinglish"
          ? "Uses en-IN / hi-IN bilingual synthesis with dynamic phonetics for English and Hindi terms"
          : "Full native provider support",
    };
  }

  /**
   * System Prompt Directive:
   * Generates instructions to be injected into Gemini Live / LLM system prompt.
   */
  public getSystemPromptDirective(conversationId: string = this.defaultConversationId): string {
    const active = this.getActiveLanguage(conversationId);
    const profile = this.getLanguageProfile(active);

    return (
      `\n\n═════════════════════════════════════════════════════════════════════════\n` +
      `ACTIVE CONVERSATIONAL LANGUAGE DIRECTIVE: ${profile.name.toUpperCase()} (${profile.nativeName})\n` +
      `═════════════════════════════════════════════════════════════════════════\n` +
      `${profile.systemPromptDirective}\n` +
      `- STRICT RULE: Respond directly in ${profile.name}. DO NOT translate mechanically.\n` +
      `- Maintain natural native cadence, correct culturally grounded idioms, and authentic warmth.\n` +
      `- If Sandeep switches language mid-conversation, seamlessly adapt and match his new language!\n` +
      `═════════════════════════════════════════════════════════════════════════`
    );
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  private getSettingsFilePath(): string {
    return path.join(process.cwd(), "settings.json");
  }

  private loadPersistedSettings(): void {
    try {
      const p = this.getSettingsFilePath();
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, "utf-8");
        const json = JSON.parse(raw);
        if (json.languagePreference && typeof json.languagePreference === "string") {
          const valid: SupportedLanguage[] = [
            "auto", "hindi", "english", "hinglish", "bengali", "bhojpuri",
            "maithili", "japanese", "tamil", "telugu", "russian"
          ];
          if (valid.includes(json.languagePreference as SupportedLanguage)) {
            this.preferredLanguage = json.languagePreference as SupportedLanguage;
            if (this.preferredLanguage !== "auto") {
              this.conversationLanguages.set(this.defaultConversationId, this.preferredLanguage);
            }
          }
        }
      }
    } catch {
      // Best-effort startup read
    }
  }

  private persistSettings(): void {
    try {
      const p = this.getSettingsFilePath();
      let current: Record<string, unknown> = {};
      if (fs.existsSync(p)) {
        current = JSON.parse(fs.readFileSync(p, "utf-8"));
      }
      current.languagePreference = this.preferredLanguage;
      fs.writeFileSync(p, JSON.stringify(current, null, 2), "utf-8");
    } catch {
      // Best-effort write
    }
  }
}

export const languageManager = LanguageManager.getInstance();
