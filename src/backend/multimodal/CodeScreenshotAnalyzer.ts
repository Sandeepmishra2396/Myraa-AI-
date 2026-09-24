/**
 * MYRAA — CodeScreenshotAnalyzer (Phase 8)
 *
 * Dedicated code snippet extractor and visual compiler diagnostic engine:
 *   - Detects programming language from syntax markers and window title
 *   - Preserves exact code structure and indentation
 *   - Isolates compiler diagnostics, red squiggles, and stack trace line numbers
 *   - Suggests targeted potential bug fixes for visible compilation errors
 */

import {
  VisualCodeAnalysis,
  StructuredOcrResult,
  ActiveWindowInfo,
} from "./MultimodalTypes.ts";
import { ocrEngine } from "./OcrEngine.ts";

export class CodeScreenshotAnalyzer {
  /**
   * High-level screenshot code analysis helper.
   */
  async analyzeScreenshot(
    base64: string,
    languageHint?: string,
    activeWindow?: ActiveWindowInfo,
  ): Promise<VisualCodeAnalysis> {
    const ocrResult = await ocrEngine.extractText(base64);
    const analysis = this.analyzeCode(ocrResult, activeWindow?.title || "");
    if (languageHint && languageHint.trim()) {
      analysis.language = languageHint.trim();
    }
    return analysis;
  }

  /**
   * Analyze code visible on screen or in OCR output.
   */
  analyzeCode(
    ocrResult: StructuredOcrResult,
    windowTitle: string = "",
  ): VisualCodeAnalysis {
    const rawCode = ocrResult.codeBlocks.length > 0
      ? ocrResult.codeBlocks.join("\n\n")
      : ocrResult.segments.filter((s) => s.category === "code").map((s) => s.text).join("\n");

    const language = this._detectLanguage(rawCode, windowTitle);
    const errors = [...ocrResult.errorLines];
    const redSquiggleCount = errors.length;

    let suggestedFix: string | undefined;
    if (errors.length > 0) {
      suggestedFix = this._suggestFixForErrors(errors, language);
    }

    // Detect line number references in errors or text
    let lineNumbers: string | undefined;
    const lineMatch = ocrResult.sanitizedText.match(/(?:line|:)(\d+)(?::(\d+))?/i);
    if (lineMatch) {
      lineNumbers = lineMatch[2] ? `Line ${lineMatch[1]}:${lineMatch[2]}` : `Line ${lineMatch[1]}`;
    }

    return {
      language,
      code: rawCode,
      lineNumbers,
      errors,
      redSquiggleCount,
      suggestedFix,
      theme: rawCode.includes("#") || windowTitle.toLowerCase().includes("dark") ? "dark" : "light",
      isUntrusted: true,
    };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private _detectLanguage(code: string, windowTitle: string): string {
    const title = windowTitle.toLowerCase();
    if (title.endsWith(".tsx") || title.endsWith(".ts")) return "TypeScript";
    if (title.endsWith(".jsx") || title.endsWith(".js")) return "JavaScript";
    if (title.endsWith(".py")) return "Python";
    if (title.endsWith(".rs")) return "Rust";
    if (title.endsWith(".go")) return "Go";
    if (title.endsWith(".cpp") || title.endsWith(".c")) return "C++";
    if (title.endsWith(".json")) return "JSON";
    if (title.endsWith(".html")) return "HTML";
    if (title.endsWith(".css")) return "CSS";
    if (title.endsWith(".sql")) return "SQL";

    // Heuristic analysis on code syntax
    if (/\b(interface|type\s+[A-Z]|enum|as\s+any)\b/.test(code)) return "TypeScript";
    if (/\b(def\s+\w+\(|import\s+\w+\s+as|elif\s+:)\b/.test(code)) return "Python";
    if (/\b(fn\s+\w+|impl\s+|let\s+mut)\b/.test(code)) return "Rust";
    if (/\b(func\s+\w+|package\s+\w+)\b/.test(code)) return "Go";
    if (/\b(const|let|var|console\.log)\b/.test(code)) return "JavaScript";

    return "plaintext";
  }

  private _suggestFixForErrors(errors: string[], language: string): string {
    const errText = errors.join(" ");

    if (/TS2322|Type '.*' is not assignable to type/i.test(errText)) {
      return "Type mismatch detected: ensure the assigned value matches the expected type union or interface definition.";
    }
    if (/TS2304|Cannot find name/i.test(errText)) {
      return "Identifier not found: verify that the missing symbol is imported at the top of the file.";
    }
    if (/TS2345|Argument of type '.*' is not assignable to parameter/i.test(errText)) {
      return "Argument type error: check the parameter signature and pass the expected object or enum value.";
    }
    if (/TypeError:.*is not a function/i.test(errText)) {
      return "Runtime invocation error: verify that the object has been initialized and exports the target method.";
    }
    if (/ModuleNotFoundError|No module named/i.test(errText)) {
      return `Missing dependency in ${language}: check if the package is installed in your virtual environment.`;
    }

    return "Review the error message and line coordinates to inspect the syntax or import mismatch.";
  }
}

export const codeScreenshotAnalyzer = new CodeScreenshotAnalyzer();
