/**
 * MYRAA — ContextMemoryUpdater
 *
 * Implements Result Learning and Short-Term Context Refresh:
 * After every action execution, immediately updates:
 *   lastIntent, lastTarget, lastAction, lastSuccessfulTool, lastResult, currentContext, currentTask
 *
 * Synchronizes with ActionContextManager so downstream tools and Gemini Live stay coherent.
 */

import { actionContextManager } from "../orchestrator/ActionContext.ts";
import { contextFusionEngine } from "./ContextFusionEngine.ts";
import { actionPlanningEngine } from "./ActionPlanningEngine.ts";
import type { CandidateAction } from "./IntelligenceTypes.ts";

export class ContextMemoryUpdater {
  /**
   * Updates short-term context upon successful tool/action execution.
   */
  public recordExecutionResult(
    contextId = "default",
    action: CandidateAction,
    result: unknown,
    ok = true,
    verificationDetails?: string
  ): void {
    const baseCtx = actionContextManager.getContext(contextId);

    // 1. Update ActionContextManager
    if (ok) {
      baseCtx.lastSuccessfulTool = action.toolName;
      baseCtx.lastToolResult = result;
    }

    // Entity updates based on action capability
    if (action.capability === "desktop.openFile" || action.capability === "code.inspect") {
      const filePath = (action.args.filePath || action.args.path) as string | undefined;
      if (filePath) {
        contextFusionEngine.setCurrentFile(contextId, filePath);
      }
    }

    if (action.capability === "desktop.openApplication") {
      const appName = (action.args.name || action.args.appName) as string | undefined;
      if (appName) {
        contextFusionEngine.setCurrentApplication(contextId, appName);
      } else if (action.toolName === "openInVsCode") {
        contextFusionEngine.setCurrentApplication(contextId, "vscode");
      }
    }

    if (action.capability === "browser.open") {
      const url = action.args.url as string | undefined;
      if (url) {
        contextFusionEngine.setCurrentWebsite(contextId, url);
      }
    }

    if (action.capability === "youtube.play" || action.toolName === "browserMediaControl") {
      if (baseCtx.currentMedia) {
        baseCtx.currentMedia.status = "playing";
      } else if (action.args.title) {
        baseCtx.currentMedia = {
          title: String(action.args.title),
          videoId: String(action.args.videoId || ""),
          url: `https://youtube.com/watch?v=${action.args.videoId || ""}`,
          status: "playing",
          index: 0,
          source: "youtube",
          updatedAt: new Date().toISOString(),
        };
      }
    }

    // 2. Record in ContextFusionEngine recent action ring
    contextFusionEngine.recordRecentAction(contextId, {
      actionId: action.id,
      intent: action.capability,
      toolName: action.toolName,
      target: String(action.args.path || action.args.filePath || action.args.name || action.args.url || ""),
      result,
      ok,
    });

    // 3. Advance active task step if a task is active
    const activeTask = contextFusionEngine.getActiveTask(contextId);
    if (activeTask && activeTask.status === "active") {
      actionPlanningEngine.advanceStep(contextId, result, ok, verificationDetails);
    }
  }

  /**
   * Retrieves execution memory for contextId.
   */
  public getExecutionMemory(contextId = "default"): {
    lastSuccessfulTool: string | null;
    lastToolResult: unknown;
    lastAction: string | null;
    lastTarget: string | null;
    lastResult: unknown;
  } | null {
    const baseCtx = actionContextManager.getContext(contextId);
    const recent = contextFusionEngine.fuseContext(contextId).recentActions;
    const latestAction = recent[0];
    if (!baseCtx.lastSuccessfulTool && !latestAction) return null;

    return {
      lastSuccessfulTool: baseCtx.lastSuccessfulTool,
      lastToolResult: baseCtx.lastToolResult,
      lastAction: latestAction ? latestAction.toolName : baseCtx.lastSuccessfulTool,
      lastTarget: latestAction ? latestAction.target : (baseCtx.currentDevice || "DESKTOP"),
      lastResult: latestAction ? latestAction.result : baseCtx.lastToolResult,
    };
  }
}

export const contextMemoryUpdater = new ContextMemoryUpdater();
