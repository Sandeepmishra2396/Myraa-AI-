/**
 * MobileScreenAnalyzer
 * Phase 23 — Mobile Screen Understanding
 *
 * Analyzes semantic visual layout, UI component hierarchy (buttons, headers,
 * forms, dialogs), and correlates visual structure with OCR text.
 */

import type { VisualUIElement, StructuredScreenOcr } from "./MobileScreenTypes.ts";

export class MobileScreenAnalyzer {
  /**
   * Derives semantic visual UI structure from screen text and layout cues.
   */
  static analyzeUI(ocr: StructuredScreenOcr, appName?: string): {
    elements: VisualUIElement[];
    visualSummary: string;
  } {
    const elements: VisualUIElement[] = [];

    for (const line of ocr.lines) {
      const text = line.text.trim();
      if (!text) continue;

      // Classify semantic UI component type
      if (text.startsWith("#") || text.toUpperCase() === text && text.length < 30) {
        elements.push({ type: "header", label: text });
      } else if (
        /\b(submit|save|confirm|next|back|cancel|ok|done|continue|proceed|buy|order|search)\b/i.test(text) &&
        text.length < 35
      ) {
        elements.push({ type: "button", label: text });
      } else if (/\b(input|email|phone|search\.\.\.|type here|address)\b/i.test(text)) {
        elements.push({ type: "input", label: text });
      } else if (/\b(alert|warning|notice|confirm action)\b/i.test(text)) {
        elements.push({ type: "dialog", label: text });
      } else {
        elements.push({ type: "text", label: text });
      }
    }

    const appLabel = appName ? `Application: ${appName}` : "Application: Unknown";
    const headerCount = elements.filter((e) => e.type === "header").length;
    const buttonCount = elements.filter((e) => e.type === "button").length;
    const inputCount = elements.filter((e) => e.type === "input").length;

    const summaryParts = [
      appLabel,
      `Detected UI Components: ${elements.length} elements (${headerCount} headers, ${buttonCount} buttons, ${inputCount} inputs)`,
    ];

    if (ocr.sanitizedText) {
      const snippet = ocr.sanitizedText.split("\n").slice(0, 3).join(" | ");
      summaryParts.push(`Key Content: "${snippet}"`);
    }

    return {
      elements,
      visualSummary: summaryParts.join(" | "),
    };
  }
}
