/**
 * MYRAA — SentenceQualityGate
 *
 * Pre-synthesis sentence quality validator and silent rewriter.
 *
 * Validates and refines speech text BEFORE speech prosody or TTS generation:
 *   1. Grammar & Agreement:
 *      - Ensures female companion verb agreement (e.g., "करती हूँ" instead of "करता हूँ",
 *        "karti hoon" instead of "karta hoon", "बताती हूँ", "देखती हूँ", "हो गई").
 *   2. Language Consistency & Script Integrity:
 *      - Purges accidental cross-script contamination (e.g., accidental Cyrillic in Devanagari)
 *        while preserving intentional tech words (e.g., API, VS Code, URL, JSON, RAM).
 *   3. Unnatural Translation & Calque Detection:
 *      - Replaces literal machine-translated artifacts (e.g., "यह भावना बनाता है", "यह अर्थ बनाता है",
 *        "ye sense banata hai", "do the needful") with natural colloquial expressions.
 *   4. Broken Sentences & Dangling Conjunctions:
 *      - Eliminates trailing orphan conjunctions ("aur", "and", "lekin", "but", "ki")
 *        and balances punctuation.
 *   5. Pronouns & Honorifics:
 *      - Elevates disrespectful address (e.g. "तू" / "tu") to polite "आप" / "aap" or friendly "tum".
 *   6. Repeated Words (Stutter Deduplication):
 *      - Deduplicates accidental repeating words ("the the", "is is", "and and") while
 *        preserving culturally valid Indic reduplication ("धीरे धीरे", "dheere dheere", "कनि कनि", "तनी तनी").
 *   7. Dialect Autonomy (Bhojpuri & Maithili):
 *      - Ensures Bhojpuri does not lapse into generic Hindi copulas ("है" -> "बा", "रहा हूँ" -> "बानी").
 *      - Ensures Maithili uses genuine auxiliary verbs ("है" -> "अछि", "रहा हूँ" -> "करैत छी").
 *   8. Silent Rewriting:
 *      - If any unnatural or broken phrasing is detected, silently rewrites text to produce
 *        pure, fluent, human-like speech output.
 */

import {
  type ActiveLanguage,
  type LanguageProfile,
  LANGUAGE_PROFILES,
} from "./LanguageProfile.ts";
import type { QualityIssue, QualityValidationResult } from "./ProsodyTypes.ts";

export interface QualityGateOptions {
  userPrompt?: string;
  strictDialect?: boolean;
  allowCodeIdentifiers?: boolean;
}

export class SentenceQualityGate {
  private static instance: SentenceQualityGate;

  // Culturally authentic Indic reduplications to preserve (never deduplicate these!)
  private readonly allowedReduplications = new Set<string>([
    "धीरे", "धीरे धीरे", "dheere", "dhire",
    "तनी", "तनी तनी", "tani",
    "कनि", "कनि कनि", "kani",
    "नीक", "नीक नीक", "neek",
    "कभी", "कभी कभी", "kabhi",
    "पास", "पास पास", "pass",
    "साथ", "साथ साथ", "saath",
    "थोड़ा", "थोड़ा थोड़ा", "thoda",
    "छोटे", "छोटे छोटे", "chote",
    "बार", "बार बार", "baar", "bar",
    "क्या", "क्या क्या", "kya",
    "बेस", "बेस बेस", "bes",
    "जाते", "जाते जाते", "aate",
    "चलते", "चलते चलते", "chalte",
    "देखते", "देखते देखते", "dekhte",
    "হাঁটি", "হাঁটি হাঁটি", "একটু", "একটু একটু",
    "ধীরে", "ধীরে ধীরে",
  ]);

  public static getInstance(): SentenceQualityGate {
    if (!SentenceQualityGate.instance) {
      SentenceQualityGate.instance = new SentenceQualityGate();
    }
    return SentenceQualityGate.instance;
  }

  /**
   * Validate candidate sentence and silently rewrite into natural, fluent phrasing.
   */
  public validateAndRefine(
    text: string,
    language: ActiveLanguage,
    options?: QualityGateOptions
  ): QualityValidationResult {
    if (!text || !text.trim()) {
      return {
        originalText: text,
        refinedText: text,
        isValid: true,
        issuesFound: [],
        wasRewritten: false,
        confidence: 1.0,
      };
    }

    const issues: QualityIssue[] = [];
    let refined = text;

    // Pass 1: Pronoun & Gender Agreement (Female Companion persona)
    refined = this.enforceGenderAndHonorifics(refined, language, issues);

    // Pass 2: Unnatural Translation & Calque Replacement
    refined = this.replaceUnnaturalTranslations(refined, language, issues);

    // Pass 3: Dialect Consistency (Bhojpuri / Maithili specific)
    if (language === "bhojpuri" || language === "maithili") {
      refined = this.enforceDialectAutonomy(refined, language, issues);
    }

    // Pass 4: Accidental Word Repetition / Stutter (preserving legit Indic reduplication)
    refined = this.deduplicateAccidentalWords(refined, issues);

    // Pass 5: Accidental Cross-Script Contamination
    refined = this.purgeAccidentalScriptMixing(refined, language, issues);

    // Pass 6: Broken Sentence & Dangling Conjunctions
    refined = this.repairBrokenSentence(refined, issues);

    // Pass 7: Punctuation & Micro-pause formatting
    refined = this.normalizeSentencePunctuation(refined);

    const wasRewritten = refined.trim() !== text.trim();
    const isValid = issues.length === 0;
    const confidence = Math.max(0.7, 1.0 - issues.length * 0.05);

    return {
      originalText: text,
      refinedText: refined.trim(),
      isValid,
      issuesFound: issues,
      wasRewritten,
      confidence,
    };
  }

  // ── PASS 1: GENDER & HONORIFICS ───────────────────────────────────────────

  private enforceGenderAndHonorifics(
    text: string,
    language: ActiveLanguage,
    issues: QualityIssue[]
  ): string {
    let result = text;

    if (language === "hindi") {
      // Fix masculine self-reference for Myraa (she is a female companion)
      const masculineHindiRegex: [RegExp, string][] = [
        [/(?<![\p{L}\p{M}\p{N}])मैं\s+करता\s+हूँ(?![\p{L}\p{M}\p{N}])/gu, "मैं करती हूँ"],
        [/(?<![\p{L}\p{M}\p{N}])मैं\s+करता\s+हू(?![\p{L}\p{M}\p{N}])/gu, "मैं करती हूँ"],
        [/(?<![\p{L}\p{M}\p{N}])करता\s+हूँ(?![\p{L}\p{M}\p{N}])/gu, "करती हूँ"],
        [/(?<![\p{L}\p{M}\p{N}])बताता\s+हूँ(?![\p{L}\p{M}\p{N}])/gu, "बताती हूँ"],
        [/(?<![\p{L}\p{M}\p{N}])देखता\s+हूँ(?![\p{L}\p{M}\p{N}])/gu, "देखती हूँ"],
        [/(?<![\p{L}\p{M}\p{N}])सोचता\s+हूँ(?![\p{L}\p{M}\p{N}])/gu, "सोचती हूँ"],
        [/(?<![\p{L}\p{M}\p{N}])मैं\s+गया\s+था(?![\p{L}\p{M}\p{N}])/gu, "मैं गई थी"],
        [/(?<![\p{L}\p{M}\p{N}])मैं\s+करूँगा(?![\p{L}\p{M}\p{N}])/gu, "मैं करूंगी"],
      ];

      for (const [regex, replacement] of masculineHindiRegex) {
        regex.lastIndex = 0;
        if (regex.test(result)) {
          regex.lastIndex = 0;
          issues.push({
            type: "wrong_pronoun_honorific",
            description: "Corrected masculine verb agreement to Myraa's female companion persona",
            originalSegment: regex.source,
            replacementSegment: replacement,
          });
          result = result.replace(regex, replacement);
        }
      }

      // Elevate disrespectful pronouns toward the user (तू -> आप)
      const disrespectfulRegex = /(?<![\p{L}\p{M}\p{N}])तू\s+(?:कर|बता|देख|रुक)(?![\p{L}\p{M}\p{N}])/gu;
      if (disrespectfulRegex.test(result)) {
        issues.push({
          type: "wrong_pronoun_honorific",
          description: "Elevated informal pronoun 'तू' to respectful 'आप'",
        });
        result = result
          .replace(/(?<![\p{L}\p{M}\p{N}])तू\s+कर(?![\p{L}\p{M}\p{N}])/gu, "आप कीजिए")
          .replace(/(?<![\p{L}\p{M}\p{N}])तू\s+बता(?![\p{L}\p{M}\p{N}])/gu, "आप बताइए")
          .replace(/(?<![\p{L}\p{M}\p{N}])तू\s+देख(?![\p{L}\p{M}\p{N}])/gu, "आप देखिए")
          .replace(/(?<![\p{L}\p{M}\p{N}])तू\s+रुक(?![\p{L}\p{M}\p{N}])/gu, "आप रुकिए");
      }
    } else if (language === "hinglish") {
      // Fix masculine Hinglish agreements
      const masculineHinglishRegex: [RegExp, string][] = [
        [/\b(main|mai)\s+karta\s+(hoon|hu|hun)\b/gi, "main karti hoon"],
        [/\bkarta\s+(hoon|hu|hun)\b/gi, "karti hoon"],
        [/\bbatata\s+(hoon|hu|hun)\b/gi, "batati hoon"],
        [/\bdekhunga\b/gi, "dekhungi"],
        [/\bkaroonga\b/gi, "karoongi"],
        [/\bkarunga\b/gi, "karungi"],
      ];

      for (const [regex, replacement] of masculineHinglishRegex) {
        regex.lastIndex = 0;
        if (regex.test(result)) {
          regex.lastIndex = 0;
          issues.push({
            type: "wrong_pronoun_honorific",
            description: "Corrected masculine verb agreement in Hinglish to feminine 'karti hoon'",
            originalSegment: regex.source,
            replacementSegment: replacement,
          });
          result = result.replace(regex, replacement);
        }
      }
    }

    return result;
  }

  // ── PASS 2: UNNATURAL TRANSLATIONS & CALQUES ──────────────────────────────

  private replaceUnnaturalTranslations(
    text: string,
    language: ActiveLanguage,
    issues: QualityIssue[]
  ): string {
    let result = text;
    const profile = LANGUAGE_PROFILES[language];
    if (!profile?.authenticityConfig?.calqueReplacements) return result;

    const replacements = profile.authenticityConfig.calqueReplacements;
    // Sort keys by descending length so multi-word phrases take precedence over substrings
    const sortedEntries = Object.entries(replacements).sort(
      ([keyA], [keyB]) => keyB.length - keyA.length
    );

    for (const [calque, natural] of sortedEntries) {
      const escaped = calque.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = `(?<![\\p{L}\\p{M}\\p{N}])${escaped}(?![\\p{L}\\p{M}\\p{N}])`;
      const regex = new RegExp(pattern, "giu");
      if (regex.test(result)) {
        issues.push({
          type: "unnatural_translation",
          description: `Replaced awkward machine translation '${calque}' with native expression '${natural}'`,
          originalSegment: calque,
          replacementSegment: natural,
        });
        result = result.replace(regex, natural);
      }
    }

    // Common universal robotic machine translation patterns
    const universalRoboticCalques: [RegExp, string][] = [
      [/as an ai language model/gi, "as Myraa"],
      [/i am an artificial intelligence/gi, "I am Myraa"],
      [/as a large language model/gi, "as your assistant Myraa"],
      [/एक एआई भाषा मॉडल के रूप में/g, "मायरा के रूप में"],
      [/एक कृत्रिम बुद्धिमत्ता के रूप में/g, "आपकी साथी मायरा के रूप में"],
    ];

    for (const [pat, repl] of universalRoboticCalques) {
      pat.lastIndex = 0;
      if (pat.test(result)) {
        issues.push({
          type: "awkward_phrasing",
          description: "Removed robotic AI disclaimer in favor of warm companion persona",
        });
        result = result.replace(pat, repl);
      }
    }

    return result;
  }

  // ── PASS 3: DIALECT INTEGRITY (BHOJPURI & MAITHILI) ───────────────────────

  private enforceDialectAutonomy(
    text: string,
    language: "bhojpuri" | "maithili",
    issues: QualityIssue[]
  ): string {
    let result = text;

    if (language === "bhojpuri") {
      // Ensure Bhojpuri doesn't lapse into generic Hindi copulas
      const hindiToBhojpuri: [RegExp, string][] = [
        [/(?<![\p{L}\p{M}\p{N}])कर\s+रहा\s+हूँ(?![\p{L}\p{M}\p{N}])/gu, "करत बानी"],
        [/(?<![\p{L}\p{M}\p{N}])कर\s+रहा\s+हू(?![\p{L}\p{M}\p{N}])/gu, "करत बानी"],
        [/(?<![\p{L}\p{M}\p{N}])कर\s+रही\s+हूँ(?![\p{L}\p{M}\p{N}])/gu, "करत बानी"],
        [/(?<![\p{L}\p{M}\p{N}])कर\s+रहे\s+हैं(?![\p{L}\p{M}\p{N}])/gu, "करत बानी"],
        [/(?<![\p{L}\p{M}\p{N}])कहा\s+था(?![\p{L}\p{M}\p{N}])/gu, "कहले रहीं"],
        [/(?<![\p{L}\p{M}\p{N}])क्या\s+हाल\s+है(?![\p{L}\p{M}\p{N}])/gu, "का हाल बा"],
        [/(?<![\p{L}\p{M}\p{N}])यह\s+ठीक\s+है(?![\p{L}\p{M}\p{N}])/gu, "ई ठीक बा"],
      ];

      for (const [pat, repl] of hindiToBhojpuri) {
        pat.lastIndex = 0;
        if (pat.test(result)) {
          pat.lastIndex = 0;
          issues.push({
            type: "language_inconsistency",
            description: `Replaced Hindi construction with authentic Bhojpuri verb/copula '${repl}'`,
            originalSegment: pat.source,
            replacementSegment: repl,
          });
          result = result.replace(pat, repl);
        }
      }
    } else if (language === "maithili") {
      // Ensure Maithili uses genuine lyrical auxiliary verbs (अछि / छी / छथि)
      const hindiToMaithili: [RegExp, string][] = [
        [/(?<![\p{L}\p{M}\p{N}])कर\s+रहा\s+हूँ(?![\p{L}\p{M}\p{N}])/gu, "करैत छी"],
        [/(?<![\p{L}\p{M}\p{N}])कर\s+रही\s+हूँ(?![\p{L}\p{M}\p{N}])/gu, "करैत छी"],
        [/(?<![\p{L}\p{M}\p{N}])क्या\s+हाल\s+(?:है|अछि)(?![\p{L}\p{M}\p{N}])/gu, "की हाल-चाल अछि"],
        [/(?<![\p{L}\p{M}\p{N}])यह\s+ठीक\s+है(?![\p{L}\p{M}\p{N}])/gu, "ई बेस अछि"],
        [/(?<![\p{L}\p{M}\p{N}])कहा\s+था(?![\p{L}\p{M}\p{N}])/gu, "कहलहुँ"],
      ];

      for (const [pat, repl] of hindiToMaithili) {
        pat.lastIndex = 0;
        if (pat.test(result)) {
          pat.lastIndex = 0;
          issues.push({
            type: "language_inconsistency",
            description: `Replaced Hindi construction with authentic Maithili auxiliary '${repl}'`,
            originalSegment: pat.source,
            replacementSegment: repl,
          });
          result = result.replace(pat, repl);
        }
      }
    }

    return result;
  }

  // ── PASS 4: ACCIDENTAL WORD REPETITION (STUTTERS) ─────────────────────────

  private deduplicateAccidentalWords(text: string, issues: QualityIssue[]): string {
    // Matches repeated consecutive words separated by whitespace: word + whitespace + word
    const repeatRegex = /\b([\p{L}]+)\s+(\1)\b/giu;

    return text.replace(repeatRegex, (fullMatch, word1, word2) => {
      const lower = word1.toLowerCase();
      // Check if legitimate Indic reduplication (e.g. "धीरे धीरे", "dheere dheere")
      if (this.allowedReduplications.has(word1) || this.allowedReduplications.has(lower)) {
        return fullMatch; // keep valid poetic reduplication
      }

      issues.push({
        type: "repeated_words",
        description: `Deduplicated accidental word repetition '${fullMatch}'`,
        originalSegment: fullMatch,
        replacementSegment: word1,
      });
      return word1;
    });
  }

  // ── PASS 5: CROSS-SCRIPT PURGING ─────────────────────────────────────────

  private purgeAccidentalScriptMixing(
    text: string,
    language: ActiveLanguage,
    issues: QualityIssue[]
  ): string {
    // Preserve technical codes and identifiers
    if (/`[^`]+`|```[\s\S]+```/.test(text)) {
      return text;
    }

    let result = text;

    // If Hindi, Bhojpuri, or Maithili (Devanagari target) contains accidental Cyrillic or Tamil
    if (language === "hindi" || language === "bhojpuri" || language === "maithili") {
      const alienRegex = /[\u0400-\u04FF\u0B80-\u0BFF\u0C00-\u0C7F\u3040-\u30FF]/g;
      if (alienRegex.test(result)) {
        issues.push({
          type: "accidental_language_mixing",
          description: "Removed accidental alien script glyphs in Devanagari text",
        });
        result = result.replace(alienRegex, "");
      }
    }

    // If Bengali contains stray Cyrillic or Tamil
    if (language === "bengali") {
      const alienRegex = /[\u0400-\u04FF\u0B80-\u0BFF\u0C00-\u0C7F]/g;
      if (alienRegex.test(result)) {
        issues.push({
          type: "accidental_language_mixing",
          description: "Removed accidental alien script glyphs in Bengali text",
        });
        result = result.replace(alienRegex, "");
      }
    }

    return result;
  }

  // ── PASS 6: BROKEN SENTENCE & DANGLING CONJUNCTIONS ───────────────────────

  private repairBrokenSentence(text: string, issues: QualityIssue[]): string {
    let result = text.trim();

    // Trailing dangling conjunctions
    const danglingConjunctions = /\s+(और|aur|and|lekin|but|tathaa|evam|yaani|ki|या)\s*[.,!?]*$/iu;
    if (danglingConjunctions.test(result)) {
      issues.push({
        type: "broken_sentence",
        description: "Removed dangling trailing conjunction at end of sentence",
      });
      result = result.replace(danglingConjunctions, ".");
    }

    // Fix unclosed quotes
    const doubleQuoteCount = (result.match(/"/g) || []).length;
    if (doubleQuoteCount % 2 !== 0) {
      result += '"';
    }

    // Fix unclosed parentheses
    const openParenCount = (result.match(/\(/g) || []).length;
    const closeParenCount = (result.match(/\)/g) || []).length;
    if (openParenCount > closeParenCount) {
      result += ")".repeat(openParenCount - closeParenCount);
    }

    return result;
  }

  // ── PASS 7: PUNCTUATION & MICRO-PAUSE FORMATTING ──────────────────────────

  private normalizeSentencePunctuation(text: string): string {
    // If text contains code blocks, do not touch code blocks
    const parts = text.split(/(```[\s\S]*?```|`[^`]+`)/g);

    return parts
      .map((part) => {
        if (part.startsWith("`") || part.startsWith("```")) {
          return part; // keep code untouched
        }

        let formatted = part;
        // Clean run-on punctuation
        formatted = formatted.replace(/\?{2,}/g, "?");
        formatted = formatted.replace(/!{2,}/g, "!");
        formatted = formatted.replace(/,{2,}/g, ",");
        // Ensure space after commas for natural micro-pause (not inside numbers)
        formatted = formatted.replace(/,([^\s\d])/g, ", $1");
        // Sentence ends: only space when followed by UPPERCASE letter or Indic character at sentence start (preserves .ts, .js, .py, etc.)
        formatted = formatted.replace(/([.!?])([A-Z\u0900-\u097F\u0980-\u09FF])/g, "$1 $2");
        // Clean double spaces
        formatted = formatted.replace(/\s{2,}/g, " ");
        return formatted;
      })
      .join("")
      .trim();
  }
}

export const sentenceQualityGate = SentenceQualityGate.getInstance();
