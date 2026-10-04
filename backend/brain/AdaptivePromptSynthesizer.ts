/**
 * MYRAA — Phase 18: Adaptive Personal Brain
 * Adaptive Prompt Synthesizer
 *
 * Synthesizes high-confidence, non-expired learned cognitive preferences into a compact,
 * structured system prompt directive block for Gemini Live and conversational sessions.
 *
 * Prevents prompt bloat by enforcing a character budget and grouping directives by domain.
 * Enforces the Golden Invariant:
 * "Explicit current instructions in the active turn ALWAYS override learned preferences."
 */

import { cognitiveMemoryStore, CognitiveMemoryStore } from "./CognitiveMemoryStore.ts";
import type { CognitiveMemory } from "./CognitiveTypes.ts";

export class AdaptivePromptSynthesizer {
  private _store: CognitiveMemoryStore;

  constructor(store: CognitiveMemoryStore = cognitiveMemoryStore) {
    this._store = store;
  }

  /**
   * Generates the system prompt directive block from active learned preferences.
   *
   * @param maxChars Maximum characters allocated for the directive block (default 800)
   * @param minConfidence Minimum confidence threshold (default 0.6)
   */
  public async synthesizePrompt(maxChars = 800, minConfidence = 0.6): Promise<string> {
    const activeMemories = await this._store.getActiveMemories(undefined, minConfidence);

    if (!activeMemories || activeMemories.length === 0) {
      return "";
    }

    // Sort by importance (highest first) and usage count
    const sorted = [...activeMemories].sort((a, b) => {
      if (b.importance !== a.importance) return b.importance - a.importance;
      return b.usageCount - a.usageCount;
    });

    const codingDirectives: string[] = [];
    const commDirectives: string[] = [];
    const workflowDirectives: string[] = [];
    const uiDirectives: string[] = [];
    const otherDirectives: string[] = [];

    for (const mem of sorted) {
      const summary = this._summarizeMemory(mem);
      if (!summary) continue;

      if (mem.category === "coding_preference") {
        codingDirectives.push(summary);
      } else if (mem.category === "communication_style") {
        commDirectives.push(summary);
      } else if (mem.category === "workflow_preference") {
        workflowDirectives.push(summary);
      } else if (mem.category === "ui_preference") {
        uiDirectives.push(summary);
      } else {
        otherDirectives.push(summary);
      }
    }

    const lines: string[] = [
      "[LEARNED USER ADAPTATIONS & COGNITIVE PREFERENCES (PHASE 18)]",
      "CRITICAL PRECEDENCE INVARIANT: Any explicit instruction given by Sandeep in the current turn ALWAYS takes absolute priority over any learned preference below!",
    ];

    if (commDirectives.length > 0) {
      lines.push(`- Communication Style: ${commDirectives.join("; ")}`);
    }
    if (codingDirectives.length > 0) {
      lines.push(`- Coding Preferences: ${codingDirectives.join("; ")}`);
    }
    if (workflowDirectives.length > 0) {
      lines.push(`- Workflow & Tools: ${workflowDirectives.join("; ")}`);
    }
    if (uiDirectives.length > 0) {
      lines.push(`- UI Preferences: ${uiDirectives.join("; ")}`);
    }
    if (otherDirectives.length > 0) {
      lines.push(`- Learned Habits: ${otherDirectives.slice(0, 3).join("; ")}`);
    }

    const output = lines.join("\n");
    if (output.length > maxChars) {
      return output.substring(0, maxChars - 3) + "...";
    }
    return output;
  }

  /**
   * Helper to format a single memory into a brief directive bullet.
   */
  private _summarizeMemory(mem: CognitiveMemory): string {
    switch (mem.key) {
      case "coding.indentation":
        return `Indent with ${mem.value}`;
      case "comm.verbosity":
        return `Prefer ${mem.value} responses`;
      case "comm.tone":
        return `Use ${mem.value} tone`;
      case "comm.language":
        return `Speak in ${mem.value}`;
      case "comm.format":
        return `Use ${mem.value} format`;
      case "ui.theme":
        return `Use ${mem.value} theme`;
      case "workflow.preferred_editor":
        return `Preferred editor is ${mem.value}`;
      default:
        return mem.text;
    }
  }
}

export const adaptivePromptSynthesizer = new AdaptivePromptSynthesizer();
