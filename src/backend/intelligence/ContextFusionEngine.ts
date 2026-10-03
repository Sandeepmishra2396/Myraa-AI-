/**
 * MYRAA — ContextFusionEngine
 *
 * Centralized Context Fusion Engine for Intelligence 2.0:
 * Unifies device, application, website, file, project, task, conversation,
 * recent actions, user preferences, and available capabilities into a single
 * coherent FusedContext.
 *
 * Enforces strict Context Priority:
 *   Explicit User Instruction (100)
 *   > Current Task Context (85)
 *   > Current App/File/Project (70)
 *   > Recent Conversation (55)
 *   > Recent Successful Action (40)
 *   > User Preference (25)
 *   > Long-term Memory (10)
 *
 * Implements Context Decay (5-minute transient decay, task-scoped retention).
 */

import { actionContextManager } from "../orchestrator/ActionContext.ts";
import { userPreferenceResolver } from "./UserPreferenceResolver.ts";
import {
  ContextPriority,
  type FusedContext,
  type TaskState,
  type TaskSummary,
  type UserPreferenceProfile,
} from "./IntelligenceTypes.ts";
import type { TargetDevice, ConversationStateType } from "../orchestrator/OrchestratorTypes.ts";

const TRANSIENT_DECAY_MS = 5 * 60 * 1000; // 5 minutes inactivity decay

export class ContextFusionEngine {
  private _conversationHistory = new Map<string, Array<{ role: "user" | "model"; text: string; timestamp: number }>>();
  private _recentActions = new Map<
    string,
    Array<{
      actionId: string;
      intent: string;
      toolName: string;
      target: string;
      result: unknown;
      timestamp: number;
      ok: boolean;
    }>
  >();
  private _activeTasks = new Map<string, TaskState>();
  private _taskHistories = new Map<string, TaskSummary[]>();
  private _entityTimestamps = new Map<string, { appTime?: number; fileTime?: number; urlTime?: number }>();
  private _transientItems = new Map<string, Map<string, { value: unknown; priority: ContextPriority; expiresAt: number }>>();

  /**
   * Set a transient context item with optional TTL.
   */
  public setTransientItem<T>(
    contextId = "default",
    key: string,
    value: T,
    priority: ContextPriority = ContextPriority.RECENT_CONVERSATION,
    ttlMs: number = TRANSIENT_DECAY_MS
  ): void {
    let map = this._transientItems.get(contextId);
    if (!map) {
      map = new Map();
      this._transientItems.set(contextId, map);
    }
    map.set(key, { value, priority, expiresAt: Date.now() + ttlMs });
  }

  /**
   * Get a transient context item if not expired.
   */
  public getTransientItem<T>(contextId = "default", key: string): T | null {
    const map = this._transientItems.get(contextId);
    if (!map) return null;
    const item = map.get(key);
    if (!item) return null;
    if (Date.now() > item.expiresAt) {
      map.delete(key);
      return null;
    }
    return item.value as T;
  }

  /**
   * Clear transient items for a context or all contexts.
   */
  public clearTransientItems(contextId?: string): void {
    if (contextId) {
      this._transientItems.delete(contextId);
    } else {
      this._transientItems.clear();
    }
  }

  /**
   * Record a conversation message in the session buffer.
   */
  public recordConversationTurn(contextId = "default", role: "user" | "model", text: string): void {
    const list = this._conversationHistory.get(contextId) || [];
    list.push({ role, text, timestamp: Date.now() });
    if (list.length > 20) {
      list.shift(); // sliding window of 20 turns
    }
    this._conversationHistory.set(contextId, list);
  }

  /**
   * Record a completed action.
   */
  public recordRecentAction(
    contextId = "default",
    action: {
      actionId: string;
      intent: string;
      toolName: string;
      target: string;
      result: unknown;
      ok: boolean;
    }
  ): void {
    const list = this._recentActions.get(contextId) || [];
    list.unshift({ ...action, timestamp: Date.now() });
    if (list.length > 10) {
      list.pop();
    }
    this._recentActions.set(contextId, list);
  }

  /**
   * Set active task for a context.
   */
  public setActiveTask(contextId = "default", task: TaskState | null): void {
    if (!task) {
      this._activeTasks.delete(contextId);
      return;
    }
    this._activeTasks.set(contextId, task);
    const summaries = this._taskHistories.get(contextId) || [];
    const existingIdx = summaries.findIndex((s) => s.taskId === task.id);
    const summary: TaskSummary = {
      taskId: task.id,
      goal: task.goal,
      status: task.status,
      stepsTotal: task.steps.length,
      stepsCompleted: task.completedSteps.length,
      updatedAt: task.updatedAt,
    };
    if (existingIdx >= 0) {
      summaries[existingIdx] = summary;
    } else {
      summaries.unshift(summary);
    }
    this._taskHistories.set(contextId, summaries);
  }

  /**
   * Get active task for a context.
   */
  public getActiveTask(contextId = "default"): TaskState | null {
    return this._activeTasks.get(contextId) || null;
  }

  /**
   * Set current file with updated timestamp.
   */
  public setCurrentFile(contextId = "default", file: string | null): void {
    const baseCtx = actionContextManager.getContext(contextId);
    baseCtx.currentFile = file;
    const timestamps = this._entityTimestamps.get(contextId) || {};
    timestamps.fileTime = file ? Date.now() : undefined;
    this._entityTimestamps.set(contextId, timestamps);
  }

  /**
   * Set current application with updated timestamp.
   */
  public setCurrentApplication(contextId = "default", app: string | null): void {
    const baseCtx = actionContextManager.getContext(contextId);
    baseCtx.currentApplication = app;
    const timestamps = this._entityTimestamps.get(contextId) || {};
    timestamps.appTime = app ? Date.now() : undefined;
    this._entityTimestamps.set(contextId, timestamps);
  }

  /**
   * Set current website URL with updated timestamp.
   */
  public setCurrentWebsite(contextId = "default", url: string | null): void {
    const baseCtx = actionContextManager.getContext(contextId);
    baseCtx.currentWebsite = url;
    const timestamps = this._entityTimestamps.get(contextId) || {};
    timestamps.urlTime = url ? Date.now() : undefined;
    this._entityTimestamps.set(contextId, timestamps);
  }

  /**
   * Prune transient context entities if they have exceeded the decay limit.
   */
  public pruneStaleContext(contextId = "default", maxAgeMs = TRANSIENT_DECAY_MS): void {
    const now = Date.now();
    const timestamps = this._entityTimestamps.get(contextId);
    if (!timestamps) return;

    const baseCtx = actionContextManager.getContext(contextId);

    // Prune transient application if stale
    if (timestamps.appTime && now - timestamps.appTime > maxAgeMs) {
      baseCtx.currentApplication = null;
      timestamps.appTime = undefined;
    }

    // Prune transient file if stale and no active task references it
    const activeTask = this.getActiveTask(contextId);
    const isFileReferencedInTask =
      activeTask && baseCtx.currentFile && activeTask.relevantEntities.files.includes(baseCtx.currentFile);

    if (timestamps.fileTime && now - timestamps.fileTime > maxAgeMs && !isFileReferencedInTask) {
      baseCtx.currentFile = null;
      timestamps.fileTime = undefined;
    }

    // Prune transient website if stale
    if (timestamps.urlTime && now - timestamps.urlTime > maxAgeMs) {
      baseCtx.currentWebsite = null;
      timestamps.urlTime = undefined;
    }

    this._entityTimestamps.set(contextId, timestamps);
  }

  /**
   * Main Context Fusion method: merges all available state into a canonical FusedContext.
   */
  public fuseContext(
    contextIdOrOverrides: string | Partial<FusedContext> = "default",
    currentDeviceHint?: TargetDevice
  ): FusedContext {
    const contextId =
      typeof contextIdOrOverrides === "string"
        ? contextIdOrOverrides
        : contextIdOrOverrides.contextId || "default";

    this.pruneStaleContext(contextId);

    const baseCtx = actionContextManager.getContext(contextId);
    const userPrefs: UserPreferenceProfile = userPreferenceResolver.getPreferences(contextId);
    const activeTask = this.getActiveTask(contextId);
    const conversation = this._conversationHistory.get(contextId) || [];
    const recentActions = this._recentActions.get(contextId) || [];
    const taskHistory = this._taskHistories.get(contextId) || [];

    const device = currentDeviceHint || baseCtx.currentDevice || "DESKTOP";

    let fused: FusedContext = {
      contextId,
      timestamp: Date.now(),
      currentDevice: device,
      currentApplication: baseCtx.currentApplication,
      currentWebsite: baseCtx.currentWebsite,
      currentFile: baseCtx.currentFile,
      currentProject: baseCtx.currentProject || userPrefs.preferredWorkspace,
      currentWorkspace: baseCtx.currentWorkspace || userPrefs.preferredWorkspace,
      currentTask: activeTask,
      previousConversation: [...conversation],
      recentActions: [...recentActions],
      userPreferences: userPrefs,
      availableCapabilities: [
        "desktop.openApplication",
        "desktop.closeApplication",
        "desktop.openFile",
        "desktop.openFolder",
        "desktop.modifyFile",
        "desktop.createFile",
        "desktop.runShellCommand",
        "desktop.runPythonScript",
        "youtube.search",
        "youtube.play",
        "browser.open",
        "browser.mediaControl",
        "code.inspect",
        "code.runTests",
        "code.compare",
      ],
      previousToolResults: baseCtx.lastToolResult ? { lastResult: baseCtx.lastToolResult } : {},
      sessionState: baseCtx.conversationState || "IDLE",
      taskHistory: [...taskHistory],
      activeMedia: baseCtx.currentMedia
        ? {
            title: baseCtx.currentMedia.title,
            videoId: baseCtx.currentMedia.videoId,
            status: baseCtx.currentMedia.status,
            searchResults: baseCtx.searchResults,
            selectedResult: baseCtx.selectedResult,
          }
        : baseCtx.searchResults.length > 0
        ? {
            title: baseCtx.selectedResult?.title || baseCtx.searchResults[0]?.title || "",
            videoId: baseCtx.selectedResult?.videoId || baseCtx.searchResults[0]?.videoId,
            status: "stopped",
            searchResults: baseCtx.searchResults,
            selectedResult: baseCtx.selectedResult,
          }
        : null,
    };

    if (typeof contextIdOrOverrides === "object") {
      fused = {
        ...fused,
        ...contextIdOrOverrides,
        userPreferences: {
          ...fused.userPreferences,
          ...(contextIdOrOverrides.userPreferences || {}),
        },
      };
    }

    return fused;
  }

  /**
   * Phase 19: Asynchronously fuses all 12+ multi-source perception streams into a UnifiedMyraaContext.
   */
  public async fuseUnifiedContext(
    contextIdOrOverrides: string | Partial<import("./IntelligenceTypes.ts").UnifiedMyraaContext> = "default",
    currentDeviceHint?: TargetDevice,
    userInput?: string
  ): Promise<import("./IntelligenceTypes.ts").UnifiedMyraaContext> {
    const { contextFusionCoordinator } = await import("./ContextFusionCoordinator.ts");
    const cid =
      typeof contextIdOrOverrides === "string"
        ? contextIdOrOverrides
        : contextIdOrOverrides.contextId || "default";
    const overrides = typeof contextIdOrOverrides === "object" ? contextIdOrOverrides : undefined;
    return contextFusionCoordinator.fuseUnifiedContext(cid, overrides, currentDeviceHint, userInput);
  }
}

export const contextFusionEngine = new ContextFusionEngine();
