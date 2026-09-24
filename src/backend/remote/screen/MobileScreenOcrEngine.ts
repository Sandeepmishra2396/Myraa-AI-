/**
 * MobileScreenOcrEngine
 * Phase 23 — Mobile Screen Understanding
 *
 * Extracts text, tokenizes lines, enforces DLP secret redaction,
 * defangs prompt injection attempts, and sandboxes on-screen text
 * with UNTRUSTED_SCREEN_OCR boundary delimiters.
 */

import { contentSanitizer } from "../../security/ContentSanitizer.ts";
import { MobileContextSanitizer } from "../context/MobileContextSanitizer.ts";
import type {
  StructuredScreenOcr,
  StructuredOcrLine,
} from "./MobileScreenTypes.ts";

export class MobileScreenOcrEngine {
  /**
   * Processes raw screen text through tokenization, DLP redaction, and untrusted sandboxing.
   */
  static processOcr(rawText: string, windowTitle: string = "Mobile Screen"): StructuredScreenOcr {
    if (!rawText || !rawText.trim()) {
      return {
        rawText: "",
        sanitizedText: "",
        fencedText: contentSanitizer.sanitizeScreenOcrContent("", { activeWindow: windowTitle }).fencedText,
        lines: [],
        redactedSecretsCount: 0,
      };
    }

    const rawLines = rawText.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const structuredLines: StructuredOcrLine[] = [];
    let redactedCount = 0;

    for (const line of rawLines) {
      const sanitized = MobileContextSanitizer.sanitizeString(line);
      const isRedacted = sanitized !== line.trim();
      if (isRedacted) {
        redactedCount++;
      }

      structuredLines.push({
        text: sanitized,
        isRedacted,
        hasPromptInjection: sanitized.includes("[DEFANGED_"),
      });
    }

    const fullSanitizedText = structuredLines.map((l) => l.text).join("\n");
    const sandbox = contentSanitizer.sanitizeScreenOcrContent(fullSanitizedText, {
      activeWindow: windowTitle,
    });

    return {
      rawText,
      sanitizedText: fullSanitizedText,
      fencedText: sandbox.fencedText,
      lines: structuredLines,
      redactedSecretsCount: redactedCount,
    };
  }
}
