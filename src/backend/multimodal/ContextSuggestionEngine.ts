/**
 * MYRAA — ContextSuggestionEngine (Phase 8)
 *
 * Proactive contextual next-step recommendations based on multimodal state:
 *   - Evaluates fused snapshot (screen, errors, active file, terminal, git)
 *   - Proactively generates ranked suggestions with confidence scores
 *   - MANDATORY SAFETY GATE: Modifying actions CANNOT execute directly; they are marked
 *     isModifying = true and must halt at a Phase 5 confirmation checkpoint.
 */

import crypto from "crypto";
import {
  ContextSuggestion,
  MultimodalContextSnapshot,
} from "./MultimodalTypes.ts";
import { checkpointManager } from "../planner/CheckpointManager.ts";
import { MODIFYING_TOOLS, PlanStep } from "../planner/PlannerTypes.ts";
import { multimodalFusionEngine } from "./MultimodalFusionEngine.ts";

export class ContextSuggestionEngine {
  private _suggestions: ContextSuggestion[] = [];

  /**
   * Evaluates the multimodal snapshot and returns ranked suggestions.
   */
  generateSuggestions(
    snapshot?: MultimodalContextSnapshot,
    opts?: { limit?: number },
  ): ContextSuggestion[] {
    const activeSnapshot: Partial<MultimodalContextSnapshot> = snapshot || multimodalFusionEngine.getCachedSnapshot() || {
      timestamp: Date.now(),
    };
    const suggestions: ContextSuggestion[] = [];
    const now = Date.now();

    // 1. Error on screen -> Suggest targeted fix
    if (activeSnapshot.visibleCode?.errors && activeSnapshot.visibleCode.errors.length > 0) {
      const topError = activeSnapshot.visibleCode.errors[0];
      const targetFile = activeSnapshot.visualUIState?.activeFile;

      suggestions.push({
        id: `sug_${crypto.randomBytes(6).toString("hex")}`,
        title: `Fix visible error in ${targetFile || "active file"}`,
        description: activeSnapshot.visibleCode.suggestedFix || `Investigate compiler error: ${topError}`,
        category: "code_fix",
        actionTool: "readFile",
        actionArgs: targetFile ? { path: targetFile } : undefined,
        isModifying: false, // Reading file is safe
        confidence: 0.92,
        reason: `Detected ${activeSnapshot.visibleCode.errors.length} compiler/runtime error(s) on screen.`,
        timestamp: now,
      });

      // Modifying action: proposed fix
      suggestions.push({
        id: `sug_${crypto.randomBytes(6).toString("hex")}`,
        title: `Apply automated fix for ${topError.slice(0, 40)}`,
        description: `Patch ${targetFile || "active file"} to resolve compilation issue.`,
        category: "code_fix",
        actionTool: "writeCodeFile",
        actionArgs: targetFile ? { path: targetFile } : undefined,
        isModifying: true, // MUST route through Phase 5 confirmation checkpoint
        confidence: 0.85,
        reason: "Modifying file requires user approval checkpoint.",
        timestamp: now,
      });
    }

    // 2. Terminal failure on screen -> Suggest test runner
    if (
      activeSnapshot.visualUIState?.category === "terminal" &&
      activeSnapshot.ocrSummary &&
      /FAIL|AssertionError|Test.*failed/i.test(activeSnapshot.ocrSummary)
    ) {
      suggestions.push({
        id: `sug_${crypto.randomBytes(6).toString("hex")}`,
        title: "Diagnose and rerun failed test",
        description: "Inspect test failure output and rerun isolated test suite.",
        category: "test_runner",
        actionTool: "execute_command",
        actionArgs: { command: "npm test" },
        isModifying: true, // Executing commands has side-effects -> gated by Phase 5
        confidence: 0.9,
        reason: "Detected failing test runner output in terminal window.",
        timestamp: now,
      });
    }

    // 3. Active open file in IDE -> Suggest documentation / inspection
    if (activeSnapshot.visualUIState?.category === "ide" && activeSnapshot.visualUIState.activeFile) {
      suggestions.push({
        id: `sug_${crypto.randomBytes(6).toString("hex")}`,
        title: `Explore ${activeSnapshot.visualUIState.activeFile}`,
        description: `Analyze module exports, dependencies, and architecture for ${activeSnapshot.visualUIState.activeFile}.`,
        category: "doc_lookup",
        actionTool: "readFile",
        actionArgs: { path: activeSnapshot.visualUIState.activeFile },
        isModifying: false,
        confidence: 0.75,
        reason: `Currently focused on editing ${activeSnapshot.visualUIState.activeFile}.`,
        timestamp: now,
      });
    }

    // 4. Default fallback general suggestion if all quiet
    if (suggestions.length === 0) {
      suggestions.push({
        id: `sug_${crypto.randomBytes(6).toString("hex")}`,
        title: "Workspace Health Check",
        description: "Run automated lint and test diagnostics across the project.",
        category: "general",
        actionTool: "execute_command",
        actionArgs: { command: "npm run lint" },
        isModifying: true,
        confidence: 0.7,
        reason: "No errors or conflicts detected on screen.",
        timestamp: now,
      });
    }

    this._suggestions = opts?.limit ? suggestions.slice(0, opts.limit) : suggestions;
    return [...this._suggestions];
  }

  /**
   * Get current cached suggestions.
   */
  getSuggestions(): ContextSuggestion[] {
    return [...this._suggestions];
  }

  /**
   * Apply a context suggestion.
   * STRICT SAFETY GATE: If suggestion isModifying === true, it MUST have an approved Phase 5 checkpoint.
   */
  async applySuggestion(
    suggestionId: string,
    checkpointToken?: string,
  ): Promise<{
    success: boolean;
    blocked: boolean;
    checkpointRequired?: boolean;
    checkpointId?: string;
    message: string;
  }> {
    const suggestion = this._suggestions.find((s) => s.id === suggestionId);
    if (!suggestion) {
      throw new Error(`SUGGESTION_NOT_FOUND: Suggestion '${suggestionId}' does not exist.`);
    }

    // Verify modifying tool status against authoritative MODIFYING_TOOLS set
    const toolName = suggestion.actionTool || "";
    const isDestructive = suggestion.isModifying || MODIFYING_TOOLS.has(toolName) || toolName === "execute_command";

    // SAFETY GATE: If modifying, require Phase 5 checkpoint approval
    if (isDestructive) {
      if (!checkpointToken) {
        // Issue an explicit Phase 5 confirmation checkpoint
        const toolArgs = suggestion.actionArgs || {};
        const step: PlanStep = {
          id: suggestion.id,
          description: `Execute context suggestion: ${suggestion.title}`,
          phase: "modify",
          toolName,
          toolArgs,
          argsHash: crypto.createHash("sha256").update(JSON.stringify(toolArgs, Object.keys(toolArgs).sort())).digest("hex"),
          dependsOn: [],
          checkpointRequired: true,
          isDestructive: true,
          retryCount: 0,
          maxRetries: 0,
          status: "pending",
        };
        const checkpoint = checkpointManager.issue(
          "multimodal_suggestion",
          step,
          "high",
        );

        return {
          success: false,
          blocked: true,
          checkpointRequired: true,
          checkpointId: checkpoint.id,
          message: `CONFIRMATION REQUIRED: Action '${suggestion.title}' requires explicit checkpoint approval. Checkpoint ID: ${checkpoint.id}.`,
        };
      }

      // If token provided, consume and validate
      const valid = checkpointManager.consumeApproval(
        checkpointToken,
        suggestion.id,
        toolName,
        suggestion.actionArgs || {},
      );

      if (!valid) {
        throw new Error("CHECKPOINT_REJECTED: Invalid, expired, or unapproved confirmation token.");
      }
    }

    // Safe read-only action or approved modifying action
    return {
      success: true,
      blocked: false,
      message: `Suggestion '${suggestion.title}' executed successfully.`,
    };
  }
}

export const contextSuggestionEngine = new ContextSuggestionEngine();
