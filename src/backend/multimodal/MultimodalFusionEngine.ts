/**
 * MYRAA — MultimodalFusionEngine (Phase 8)
 *
 * Real-time synthesis of voice utterances, visual screen context, and project metadata:
 *   - Fuses Auditory (voice), Visual (screen + OCR + UI state), and Project (git + files) streams.
 *   - Formats defensive multimodal context cards for Gemini instructions.
 *   - Neutralizes visual prompt injection via untrusted content fences.
 *   - Maintains current unified snapshot for contextual suggestion generation.
 */

import path from "node:path";
import {
  MultimodalContextSnapshot,
  ActiveWindowInfo,
  StructuredOcrResult,
  VisualUIState,
  VisualCodeAnalysis,
} from "./MultimodalTypes.ts";
import { activeWindowTracker } from "./ActiveWindowTracker.ts";
import { screenContextManager } from "./ScreenContextManager.ts";
import { ocrEngine } from "./OcrEngine.ts";
import { visualUIAnalyzer } from "./VisualUIAnalyzer.ts";
import { codeScreenshotAnalyzer } from "./CodeScreenshotAnalyzer.ts";
import { projectManager } from "../projects/ProjectManager.ts";

export class MultimodalFusionEngine {
  private _latestSnapshot: MultimodalContextSnapshot | null = null;
  private _lastVoiceUtterance: string = "";
  private _lastModelResponse: string = "";

  // ---------------------------------------------------------------------------
  // Voice Context Ingestion
  // ---------------------------------------------------------------------------

  recordVoiceTurn(role: "user" | "model", text: string): void {
    if (role === "user") {
      this._lastVoiceUtterance = text;
    } else {
      this._lastModelResponse = text;
    }
  }

  // ---------------------------------------------------------------------------
  // Context Fusion Pipeline
  // ---------------------------------------------------------------------------

  /**
   * Generates a freshly fused multimodal context snapshot from all perception streams.
   */
  async captureFusedSnapshot(): Promise<MultimodalContextSnapshot> {
    const now = Date.now();

    // 1. Visual Stream: Active window & Screen state
    const windowInfo: ActiveWindowInfo = await activeWindowTracker.getActiveWindow();
    const status = screenContextManager.getStatus();
    const privacyShieldTriggered = status.privacyShieldActive || windowInfo.category === "sensitive";

    let ocrResult: StructuredOcrResult | undefined;
    let uiState: VisualUIState | undefined;
    let codeAnalysis: VisualCodeAnalysis | undefined;
    let screenSummary = `Active Window: '${windowInfo.title}' (${windowInfo.category}).`;

    // Only run visual extraction if privacy shield is not triggered
    if (!privacyShieldTriggered) {
      const snapshot = screenContextManager.getLatestSnapshot();
      try {
        ocrResult = await ocrEngine.extractText(snapshot?.base64);
        uiState = visualUIAnalyzer.analyzeUI(windowInfo, ocrResult);
        if (uiState.category === "ide" || ocrResult.codeBlocks.length > 0) {
          codeAnalysis = codeScreenshotAnalyzer.analyzeCode(ocrResult, windowInfo.title);
        }
        screenSummary = uiState.summary;
      } catch (err: any) {
        screenSummary += ` (Visual analysis: ${err?.message || "unavailable"})`;
      }
    } else {
      screenSummary += " [PRIVACY SHIELD ACTIVE: Sensitive application shielded]";
    }

    // 2. Project Stream: Active project & Git metadata
    let projectContext: MultimodalContextSnapshot["projectContext"] | undefined;
    try {
      const rootDir = projectManager.getActiveWorkspace();
      const projectName = path.basename(rootDir);
      projectContext = {
        projectName,
        rootDir,
      };
    } catch {}

    // 3. Synthesize unified snapshot
    const snapshot: MultimodalContextSnapshot = {
      activeWindow: windowInfo,
      windowHistory: activeWindowTracker.getWindowHistory(),
      screenSummary,
      ocrSummary: ocrResult?.sanitizedText?.slice(0, 500),
      visualUIState: uiState,
      visibleCode: codeAnalysis,
      projectContext,
      voiceContext: {
        lastUserUtterance: this._lastVoiceUtterance,
        lastModelResponse: this._lastModelResponse,
      },
      privacyShieldTriggered,
      timestamp: now,
    };

    this._latestSnapshot = snapshot;
    return snapshot;
  }

  /**
   * Return the latest fused snapshot or trigger a fresh capture.
   */
  async getLatestSnapshot(): Promise<MultimodalContextSnapshot> {
    if (!this._latestSnapshot || Date.now() - this._latestSnapshot.timestamp > 3000) {
      return this.captureFusedSnapshot();
    }
    return this._latestSnapshot;
  }

  /**
   * Return the cached snapshot immediately without async capture.
   */
  getCachedSnapshot(): MultimodalContextSnapshot | null {
    return this._latestSnapshot;
  }

  // ---------------------------------------------------------------------------
  // Context Card for Gemini Instructions
  // ---------------------------------------------------------------------------

  /**
   * Format a concise, high-signal Markdown context card injected into Gemini system instructions.
   * Defensively fences untrusted screen content against prompt injection.
   */
  buildMultimodalContextCard(snapshot?: MultimodalContextSnapshot): string {
    const s = snapshot || this._latestSnapshot;
    if (!s) return "";

    const lines: string[] = [
      "=== REAL-TIME MULTIMODAL SCREEN CONTEXT ===",
      `Active Application: ${s.activeWindow.processName} | Title: "${s.activeWindow.title}"`,
      `Workspace State: ${s.screenSummary}`,
    ];

    if (s.privacyShieldTriggered) {
      lines.push("Privacy Shield: ACTIVE (Screen content is shielded because active window is sensitive).");
      lines.push("==========================================");
      return lines.join("\n");
    }

    if (snapshot.visualUIState?.activeFile) {
      lines.push(`Currently Open File: ${snapshot.visualUIState.activeFile}`);
    }

    if (snapshot.visibleCode?.errors && snapshot.visibleCode.errors.length > 0) {
      lines.push(`Visible Compiler / Runtime Errors (${snapshot.visibleCode.errors.length}):`);
      for (const err of snapshot.visibleCode.errors.slice(0, 3)) {
        lines.push(`  - ${err}`);
      }
      if (snapshot.visibleCode.suggestedFix) {
        lines.push(`Suggested Diagnostic: ${snapshot.visibleCode.suggestedFix}`);
      }
    }

    if (snapshot.ocrSummary) {
      lines.push("Visible On-Screen Text (Untrusted User Content):");
      lines.push("<<<UNTRUSTED_SCREEN_CONTENT>>>");
      lines.push(snapshot.ocrSummary);
      lines.push("<<</UNTRUSTED_SCREEN_CONTENT>>>");
    }

    lines.push("==========================================");
    return lines.join("\n");
  }
}

export const multimodalFusionEngine = new MultimodalFusionEngine();
