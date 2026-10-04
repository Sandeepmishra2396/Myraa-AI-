/**
 * MYRAA — Canonical Conversation ActionContext / ExecutionContext Manager
 *
 * Tracks live conversational execution state across turns so follow-up commands
 * ("Play karo", "isko play karo", "play the first one", "Pause karo", "Next song",
 * "ye app open karo", "isme current project open karo", "ye file check karo")
 * resolve deterministically against the active context instead of losing state
 * or falling back to generic/unrelated actions.
 */

import type {
  ActiveMediaState,
  ConversationStateSnapshot,
  ConversationStateType,
  ExecutionContext,
  MediaSearchResultItem,
  PendingActionState,
  TargetDevice,
} from "./OrchestratorTypes.ts";

const DEFAULT_WORKSPACE = process.env.SORA_WORKSPACE_DIR || process.cwd();

export class ActionContextManager {
  private _contexts = new Map<string, ExecutionContext>();
  private _lastActiveContextId = "default";

  /**
   * Create a fresh ExecutionContext for a given contextId.
   */
  private _createInitialContext(contextId: string): ExecutionContext {
    return {
      contextId,
      currentDevice: "DESKTOP",
      currentApplication: null,
      currentWebsite: null,
      currentSearchQuery: null,
      searchResults: [],
      selectedResult: null,
      currentMedia: null,
      currentFile: null,
      currentProject: DEFAULT_WORKSPACE,
      currentWorkspace: DEFAULT_WORKSPACE,
      currentTask: null,
      lastSuccessfulTool: null,
      lastToolResult: null,
      pendingAction: null,
      conversationState: "IDLE",
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Retrieve or initialize the ExecutionContext for a session/conversation.
   */
  getContext(contextId = "default"): ExecutionContext {
    const id = (contextId || "default").trim() || "default";
    let ctx = this._contexts.get(id);
    if (!ctx) {
      // Inherit active media/application/file state from "default" if a new device/session ID is used mid-flow
      const fallback = id !== "default" ? this._contexts.get("default") : undefined;
      ctx = this._createInitialContext(id);
      if (fallback) {
        ctx.currentApplication = fallback.currentApplication;
        ctx.currentWebsite = fallback.currentWebsite;
        ctx.currentSearchQuery = fallback.currentSearchQuery;
        ctx.searchResults = [...fallback.searchResults];
        ctx.selectedResult = fallback.selectedResult ? { ...fallback.selectedResult } : null;
        ctx.currentMedia = fallback.currentMedia ? { ...fallback.currentMedia } : null;
        ctx.currentFile = fallback.currentFile;
        ctx.currentProject = fallback.currentProject;
        ctx.currentWorkspace = fallback.currentWorkspace;
        ctx.conversationState = fallback.conversationState;
      }
      this._contexts.set(id, ctx);
    }
    return ctx;
  }

  /**
   * Mirror key conversational state to the "default" context so UI/HTTP and WS callers stay in sync.
   */
  private _syncToDefault(source: ExecutionContext): void {
    this._lastActiveContextId = source.contextId;
    if (source.contextId === "default") return;
    const def = this.getContext("default");
    def.currentDevice = source.currentDevice;
    def.currentApplication = source.currentApplication;
    def.currentWebsite = source.currentWebsite;
    def.currentSearchQuery = source.currentSearchQuery;
    def.searchResults = [...source.searchResults];
    def.selectedResult = source.selectedResult ? { ...source.selectedResult } : null;
    def.currentMedia = source.currentMedia ? { ...source.currentMedia } : null;
    def.currentFile = source.currentFile;
    def.currentProject = source.currentProject;
    def.currentWorkspace = source.currentWorkspace;
    def.currentTask = source.currentTask;
    def.lastSuccessfulTool = source.lastSuccessfulTool;
    def.lastToolResult = source.lastToolResult;
    def.pendingAction = source.pendingAction;
    def.conversationState = source.conversationState;
    def.updatedAt = source.updatedAt;
  }

  /**
   * Build a lightweight snapshot of the conversation state for intent models.
   */
  getConversationSnapshot(contextId = "default"): ConversationStateSnapshot {
    const ctx = this.getContext(contextId);
    return {
      state: ctx.conversationState,
      activeApplication: ctx.currentApplication,
      activeWebsite: ctx.currentWebsite,
      activeSearchQuery: ctx.currentSearchQuery,
      hasSearchResults: ctx.searchResults.length > 0,
      selectedResultTitle: ctx.selectedResult?.title || ctx.currentMedia?.title || null,
      activeFile: ctx.currentFile,
      hasPendingConfirmation: ctx.pendingAction !== null,
    };
  }

  /**
   * Apply a partial update to the ExecutionContext.
   */
  updateContext(contextId: string, partial: Partial<ExecutionContext>): ExecutionContext {
    const ctx = this.getContext(contextId);
    Object.assign(ctx, partial, {
      contextId: ctx.contextId,
      updatedAt: new Date().toISOString(),
    });
    this._syncToDefault(ctx);
    return ctx;
  }

  /**
   * Record that an application was opened.
   */
  recordApplicationOpened(
    contextId: string,
    appName: string,
    targetDevice: TargetDevice = "DESKTOP",
    filePath?: string,
  ): ExecutionContext {
    const ctx = this.getContext(contextId);
    ctx.currentDevice = targetDevice;
    ctx.currentApplication = appName.toLowerCase().trim();
    if (filePath) {
      ctx.currentFile = filePath;
      ctx.conversationState = "FILE_OPEN";
    } else {
      ctx.conversationState = "APPLICATION_OPEN";
    }
    ctx.updatedAt = new Date().toISOString();
    this._syncToDefault(ctx);
    return ctx;
  }

  /**
   * Record that a website was opened.
   */
  recordWebsiteOpened(
    contextId: string,
    websiteOrUrl: string,
    targetDevice: TargetDevice = "BROWSER",
  ): ExecutionContext {
    const ctx = this.getContext(contextId);
    ctx.currentDevice = targetDevice;
    const lower = websiteOrUrl.toLowerCase();
    if (lower.includes("youtube")) {
      ctx.currentWebsite = "youtube";
    } else if (lower.includes("google")) {
      ctx.currentWebsite = "google";
    } else if (lower.includes("github")) {
      ctx.currentWebsite = "github";
    } else {
      ctx.currentWebsite = websiteOrUrl;
    }
    ctx.updatedAt = new Date().toISOString();
    this._syncToDefault(ctx);
    return ctx;
  }

  /**
   * Record a media/YouTube search and its results.
   * Automatically sets selectedResult = searchResults[0] when results are non-empty.
   */
  recordMediaSearch(
    contextId: string,
    query: string,
    results: MediaSearchResultItem[],
    website = "youtube",
  ): ExecutionContext {
    const ctx = this.getContext(contextId);
    const cleanQuery = query.trim();
    ctx.currentWebsite = website;
    ctx.currentSearchQuery = cleanQuery;

    const normalizedResults: MediaSearchResultItem[] =
      results.length > 0
        ? results.map((r, idx) => ({
            index: typeof r.index === "number" ? r.index : idx,
            videoId: r.videoId || `yt_${idx}_${ Buffer.from(cleanQuery).toString("hex").slice(0, 8) }`,
            title: r.title || `${cleanQuery} (Result #${idx + 1})`,
            url:
              r.url ||
              (r.videoId
                ? `https://www.youtube.com/watch?v=${r.videoId}`
                : `https://www.youtube.com/results?search_query=${encodeURIComponent(cleanQuery)}`),
            author: r.author,
            duration: r.duration,
            thumbnail: r.thumbnail,
          }))
        : [
            {
              index: 0,
              videoId: `yt_top_${Buffer.from(cleanQuery).toString("hex").slice(0, 8)}`,
              title: cleanQuery,
              url: `https://www.youtube.com/results?search_query=${encodeURIComponent(cleanQuery)}`,
              author: "YouTube",
              duration: "Video",
            },
          ];

    ctx.searchResults = normalizedResults;
    ctx.selectedResult = normalizedResults[0] || null;
    ctx.conversationState = "MEDIA_SEARCHED";
    ctx.updatedAt = new Date().toISOString();
    this._syncToDefault(ctx);
    return ctx;
  }

  /**
   * Select a specific result by 0-based index, ordinal ("first", "second", "third"), or videoId/title.
   */
  selectMediaResult(
    contextId: string,
    selector?: number | string,
  ): MediaSearchResultItem | null {
    const ctx = this.getContext(contextId);
    if (ctx.searchResults.length === 0) {
      return ctx.selectedResult || null;
    }

    if (selector === undefined || selector === null || selector === "") {
      const chosen = ctx.selectedResult || ctx.searchResults[0];
      ctx.selectedResult = chosen;
      this._syncToDefault(ctx);
      return chosen;
    }

    if (typeof selector === "number") {
      const boundedIdx = Math.max(0, Math.min(selector, ctx.searchResults.length - 1));
      const chosen = ctx.searchResults[boundedIdx];
      ctx.selectedResult = chosen;
      this._syncToDefault(ctx);
      return chosen;
    }

    const raw = String(selector).trim().toLowerCase();

    // Ordinal resolution
    if (/^(first|1st|one|pehla|pehle|first one|top|0|#1|video-0|result-0)$/.test(raw)) {
      ctx.selectedResult = ctx.searchResults[0];
      this._syncToDefault(ctx);
      return ctx.selectedResult;
    }
    if (/^(second|2nd|two|doosra|dusra|second one|1|#2|video-1|result-1)$/.test(raw)) {
      ctx.selectedResult = ctx.searchResults[Math.min(1, ctx.searchResults.length - 1)];
      this._syncToDefault(ctx);
      return ctx.selectedResult;
    }
    if (/^(third|3rd|three|teesra|tisra|third one|2|#3|video-2|result-2)$/.test(raw)) {
      ctx.selectedResult = ctx.searchResults[Math.min(2, ctx.searchResults.length - 1)];
      this._syncToDefault(ctx);
      return ctx.selectedResult;
    }

    // Check video-<videoId>
    const cleanId = raw.startsWith("video-") ? selector.toString().slice(6) : selector.toString();
    const byId = ctx.searchResults.find(
      (r) => r.videoId.toLowerCase() === cleanId.toLowerCase() || r.videoId.toLowerCase() === raw,
    );
    if (byId) {
      ctx.selectedResult = byId;
      this._syncToDefault(ctx);
      return byId;
    }

    // Check title substring match
    const byTitle = this.findMatchingMediaResult(contextId, raw);
    if (byTitle) {
      ctx.selectedResult = byTitle;
      this._syncToDefault(ctx);
      return byTitle;
    }

    // Default to currently selected or first result
    ctx.selectedResult = ctx.selectedResult || ctx.searchResults[0];
    this._syncToDefault(ctx);
    return ctx.selectedResult;
  }

  /**
   * Check if a requested song/title matches any item in current searchResults or currentSearchQuery.
   */
  findMatchingMediaResult(contextId: string, queryOrTitle: string): MediaSearchResultItem | null {
    const ctx = this.getContext(contextId);
    const needle = queryOrTitle.trim().toLowerCase();
    if (!needle) return null;

    // 1. Direct match in searchResults
    for (const item of ctx.searchResults) {
      const hay = item.title.toLowerCase();
      if (hay.includes(needle) || needle.includes(hay)) {
        return item;
      }
      // Token overlap check
      const needleTokens = needle.split(/\s+/).filter((t) => t.length >= 3);
      if (
        needleTokens.length > 0 &&
        needleTokens.every((tok) => hay.includes(tok) || (item.author || "").toLowerCase().includes(tok))
      ) {
        return item;
      }
    }

    // 2. Matches currentSearchQuery
    if (
      ctx.currentSearchQuery &&
      (ctx.currentSearchQuery.toLowerCase().includes(needle) ||
        needle.includes(ctx.currentSearchQuery.toLowerCase())) &&
      ctx.searchResults.length > 0
    ) {
      return ctx.selectedResult || ctx.searchResults[0];
    }

    return null;
  }

  /**
   * Record media playback state transition (playing / paused / stopped).
   */
  recordMediaPlayback(
    contextId: string,
    status: "playing" | "paused" | "stopped",
    item?: MediaSearchResultItem | null,
  ): ExecutionContext {
    const ctx = this.getContext(contextId);
    const targetItem =
      item ||
      ctx.selectedResult ||
      ctx.searchResults[0] ||
      (ctx.currentMedia
        ? {
            index: ctx.currentMedia.index,
            videoId: ctx.currentMedia.videoId,
            title: ctx.currentMedia.title,
            url: ctx.currentMedia.url,
          }
        : null);

    if (targetItem) {
      ctx.selectedResult = targetItem;
      ctx.currentMedia = {
        videoId: targetItem.videoId,
        title: targetItem.title,
        url: targetItem.url,
        status,
        index: targetItem.index,
        source: "youtube",
        updatedAt: new Date().toISOString(),
      };
    } else if (ctx.currentMedia) {
      ctx.currentMedia = {
        ...ctx.currentMedia,
        status,
        updatedAt: new Date().toISOString(),
      };
    }

    ctx.conversationState =
      status === "playing"
        ? "MEDIA_PLAYING"
        : status === "paused"
        ? "MEDIA_PAUSED"
        : ctx.searchResults.length > 0
        ? "MEDIA_SEARCHED"
        : "IDLE";
    ctx.updatedAt = new Date().toISOString();
    this._syncToDefault(ctx);
    return ctx;
  }

  /**
   * Advance to the next or previous item in searchResults and mark it as playing.
   */
  advanceMediaResult(
    contextId: string,
    direction: "next" | "previous",
  ): MediaSearchResultItem | null {
    const ctx = this.getContext(contextId);
    if (ctx.searchResults.length === 0) {
      return ctx.selectedResult || null;
    }

    const currentIdx =
      ctx.currentMedia?.index ??
      ctx.selectedResult?.index ??
      0;

    const nextIdx =
      direction === "next"
        ? (currentIdx + 1) % ctx.searchResults.length
        : (currentIdx - 1 + ctx.searchResults.length) % ctx.searchResults.length;

    const chosen = ctx.searchResults[nextIdx];
    ctx.selectedResult = chosen;
    this.recordMediaPlayback(contextId, "playing", chosen);
    return chosen;
  }

  /**
   * Record that a file or project folder was opened.
   */
  recordFileOpened(
    contextId: string,
    filePath: string,
    editor = "vscode",
    project?: string,
  ): ExecutionContext {
    const ctx = this.getContext(contextId);
    ctx.currentFile = filePath;
    if (editor) {
      ctx.currentApplication = editor.toLowerCase();
    }
    if (project) {
      ctx.currentProject = project;
    }
    ctx.conversationState = "FILE_OPEN";
    ctx.updatedAt = new Date().toISOString();
    this._syncToDefault(ctx);
    return ctx;
  }

  /**
   * Record the last successful tool call and its output.
   */
  recordToolSuccess(
    contextId: string,
    toolName: string,
    result: unknown,
  ): ExecutionContext {
    const ctx = this.getContext(contextId);
    ctx.lastSuccessfulTool = toolName;
    ctx.lastToolResult = result;
    ctx.updatedAt = new Date().toISOString();
    this._syncToDefault(ctx);
    return ctx;
  }

  /**
   * Set or clear a pending confirmation action in context.
   */
  setPendingAction(
    contextId: string,
    pending: PendingActionState | null,
  ): ExecutionContext {
    const ctx = this.getContext(contextId);
    ctx.pendingAction = pending;
    if (pending) {
      ctx.conversationState = "AWAITING_CONFIRMATION";
    } else if (ctx.conversationState === "AWAITING_CONFIRMATION") {
      ctx.conversationState = "IDLE";
    }
    ctx.updatedAt = new Date().toISOString();
    this._syncToDefault(ctx);
    return ctx;
  }

  /**
   * Resolve contextual pronouns ("ye app", "isko", "this file", "that one", "current project")
   * against the active ExecutionContext.
   */
  resolveContextualEntity(
    contextId: string,
    entityHint?: string | null,
  ): {
    type: "application" | "website" | "media" | "file" | "project" | "none";
    value: string | null;
    mediaItem?: MediaSearchResultItem | null;
  } {
    const ctx = this.getContext(contextId);
    const hint = (entityHint || "").trim().toLowerCase();

    if (
      /^(ye\s+app|this\s+app|current\s+app|active\s+app|same\s+app|us\s+app|wo\s+app|app)$/.test(hint)
    ) {
      if (ctx.currentApplication) {
        return { type: "application", value: ctx.currentApplication };
      }
      if (ctx.currentWebsite) {
        return { type: "website", value: ctx.currentWebsite };
      }
      return { type: "none", value: null };
    }

    if (
      /^(ye\s+file|this\s+file|current\s+file|active\s+file|same\s+file|us\s+file|wo\s+file|file)$/.test(hint)
    ) {
      return { type: "file", value: ctx.currentFile };
    }

    if (
      /^(current\s+project|this\s+project|ye\s+project|active\s+project|workspace|current\s+workspace)$/.test(hint)
    ) {
      return { type: "project", value: ctx.currentProject || ctx.currentWorkspace };
    }

    if (
      /^(isko|ise|it|this|that|that\s+one|this\s+one|wo\s+wala|ye\s+wala|current\s+song|selected)$/.test(hint)
    ) {
      if (ctx.selectedResult || ctx.searchResults.length > 0) {
        const mediaItem = ctx.selectedResult || ctx.searchResults[0];
        return { type: "media", value: mediaItem.title, mediaItem };
      }
      if (ctx.currentMedia) {
        return {
          type: "media",
          value: ctx.currentMedia.title,
          mediaItem: {
            index: ctx.currentMedia.index,
            videoId: ctx.currentMedia.videoId,
            title: ctx.currentMedia.title,
            url: ctx.currentMedia.url,
          },
        };
      }
      if (ctx.currentFile) {
        return { type: "file", value: ctx.currentFile };
      }
      if (ctx.currentApplication) {
        return { type: "application", value: ctx.currentApplication };
      }
    }

    return { type: "none", value: null };
  }

  /**
   * Reset contexts for isolated unit/integration testing.
   */
  resetForTesting(contextId?: string): void {
    if (contextId) {
      this._contexts.delete(contextId);
    } else {
      this._contexts.clear();
      this._lastActiveContextId = "default";
    }
  }
}

export const actionContextManager = new ActionContextManager();
