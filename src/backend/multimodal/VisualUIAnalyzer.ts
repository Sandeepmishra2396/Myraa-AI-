/**
 * MYRAA — VisualUIAnalyzer (Phase 8)
 *
 * Semantic UI state classifier and workspace layout analyzer:
 *   - Classifies active UI state (IDE, terminal, browser, dialog, system)
 *   - Extracts active file, line numbers, terminal commands, and open modals
 *   - Correlates foreground window title with on-screen OCR tokens
 */

import {
  VisualUIState,
  VisualUICategory,
  ActiveWindowInfo,
  StructuredOcrResult,
} from "./MultimodalTypes.ts";

export class VisualUIAnalyzer {
  /**
   * Analyze the UI state from the active window metadata and OCR results.
   */
  analyzeUI(windowInfo: ActiveWindowInfo, ocrResult: StructuredOcrResult): VisualUIState {
    let category: VisualUICategory = "unknown";
    let confidence = 0.6;
    let activeFile: string | undefined;
    let terminalPrompt: string | undefined;
    let lastTerminalCommand: string | undefined;
    let hasErrorToast = ocrResult.errorLines.length > 0;
    const detectedModals: string[] = [];

    const titleLower = windowInfo.title.toLowerCase();
    const processLower = windowInfo.processName.toLowerCase();

    // 1. IDE / Editor Detection
    if (
      windowInfo.category === "code_editor" ||
      /\.(ts|tsx|js|jsx|py|go|rs|cpp|h|java|html|css|json|yaml|sql|md)\b/i.test(titleLower)
    ) {
      category = "ide";
      confidence = 0.95;

      // Extract filename from title, e.g. "server.ts - Myraa AI - Visual Studio Code"
      const fileMatch = windowInfo.title.match(/([A-Za-z0-9_\-./\\]+\.[A-Za-z0-9]+)/);
      if (fileMatch) {
        activeFile = fileMatch[1];
      }
    }
    // 2. Terminal Detection
    else if (windowInfo.category === "terminal" || /powershell|bash|cmd|terminal/i.test(titleLower)) {
      category = "terminal";
      confidence = 0.95;

      if (ocrResult.commands.length > 0) {
        lastTerminalCommand = ocrResult.commands[ocrResult.commands.length - 1];
      }
      terminalPrompt = windowInfo.title;
    }
    // 3. Web Browser Detection
    else if (windowInfo.category === "browser" || /chrome|edge|firefox|brave/i.test(processLower)) {
      category = "browser";
      confidence = 0.9;
    }
    // 4. Modal / Dialog Detection
    else if (/dialog|modal|confirm|alert|warning|prompt/i.test(titleLower)) {
      category = "dialog";
      confidence = 0.85;
      detectedModals.push(windowInfo.title);
    }
    // 5. System Shell
    else if (windowInfo.category === "system") {
      category = "system";
      confidence = 0.8;
    }

    // Modal check inside OCR text
    for (const segment of ocrResult.segments) {
      if (/are you sure|confirm|permission denied|warning|alert/i.test(segment.text)) {
        detectedModals.push(segment.text);
      }
    }

    // Build human-readable UI summary
    let summary = `Workspace UI: ${category.toUpperCase()}. Foreground: '${windowInfo.title}'.`;
    if (activeFile) summary += ` Editing file: ${activeFile}.`;
    if (lastTerminalCommand) summary += ` Last command: '${lastTerminalCommand}'.`;
    if (hasErrorToast) summary += ` Visible errors: ${ocrResult.errorLines.length}.`;

    return {
      category,
      activeFile,
      terminalPrompt,
      lastTerminalCommand,
      hasErrorToast,
      detectedModals,
      confidence,
      summary,
    };
  }
}

export const visualUIAnalyzer = new VisualUIAnalyzer();
