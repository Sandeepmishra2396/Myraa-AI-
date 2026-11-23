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

/**
 * Resolves natural spoken ordinals ("first", "4th", "chautha", "dusra", "#4", "4th no wala")
 * or numeric strings/numbers into a 0-based index.
 */
export function parseOrdinalOrIndex(raw: string | number | null | undefined): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw === "number") {
    return isNaN(raw) ? null : Math.floor(raw);
  }
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;

  // Handle explicit 0-indexed tokens e.g. "video-0", "result-2"
  if (/^(?:video|result|search-result)-(\d+)$/i.test(s)) {
    const num = parseInt(s.replace(/\D+/g, ""), 10);
    return isNaN(num) ? null : num;
  }

  // Handle explicit "do number" / "do wala" before stripping helper verb "do" ("kar do", "chala do")
  if (/\b(?:do\s+(?:no\.?|number|num|wala|wali|wale)|(?:no\.?|number|num)\s+do)\b/i.test(s)) {
    return 1;
  }

  // Clean noise, action verbs, and common filler words
  const cleaned = s
    .replace(/^#/, "")
    .replace(/\b(?:video|result|search-result)-\b/gi, "")
    .replace(/\b(?:kar|chala|baja|laga|suna|khol)\s+do\b/gi, "")
    .replace(/\b(?:no\.|no|number|num)\b/gi, "")
    .replace(/\b(?:play|karo|kar|do|chalao|chala|bajao|baja|sunao|suna|lagao|laga|open|kholo|tum|aap|please|plz|zara|bhai|yaar|myraa|myra|ko|me|main|pe|par|jo|hai|hain|usko|isko|use|usse|wo|woh|ye|yeh)\b/gi, "")
    .replace(/\b(?:wala|wali|wale|waala|waali|waale|gaana|gana|gaane|gane|songs|sonngs|sonng|song|videos|video|tracks|track|items|item|results|result|option|one|the|on|at|in|of)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  // Known English & Hindi ordinal / cardinal map (returns 0-based index)
  const ordMap: Record<string, number> = {
    "1st": 0, "first": 0, "one": 0, "ek": 0, "pehla": 0, "pehle": 0, "pahla": 0, "pahle": 0, "top": 0,
    "2nd": 1, "second": 1, "two": 1, "doosra": 1, "dusra": 1, "doosre": 1, "dusre": 1, "duja": 1,
    "3rd": 2, "third": 2, "three": 2, "teen": 2, "teesra": 2, "tisra": 2, "teesre": 2, "tisre": 2,
    "4th": 3, "fourth": 3, "four": 3, "chaar": 3, "char": 3, "chautha": 3, "chauthe": 3, "chotha": 3,
    "5th": 4, "fifth": 4, "five": 4, "paanch": 4, "panch": 4, "paanchwa": 4, "panchwa": 4, "paanchwe": 4, "panchwe": 4,
    "6th": 5, "sixth": 5, "six": 5, "chhattha": 5, "chhatha": 5, "chhatthe": 5, "chhe": 5, "chhah": 5, "che": 5,
    "7th": 6, "seventh": 6, "seven": 6, "saatwa": 6, "satwa": 6, "saatwe": 6, "saat": 6, "sat": 6,
    "8th": 7, "eighth": 7, "eight": 7, "aathwa": 7, "aathva": 7, "aathwe": 7, "aath": 7, "athwa": 7, "ath": 7,
    "9th": 8, "ninth": 8, "nine": 8, "nauwa": 8, "navma": 8, "nauwe": 8, "nau": 8, "nava": 8, "noauwa": 8,
    "10th": 9, "tenth": 9, "ten": 9, "daswa": 9, "dasva": 9, "daswe": 9, "das": 9,
    "11th": 10, "eleventh": 10, "eleven": 10, "gyarahwa": 10, "gyarah": 10,
    "12th": 11, "twelfth": 11, "twelve": 11, "barahwa": 11, "barah": 11,
    "13th": 12, "thirteenth": 12, "thirteen": 12,
    "14th": 13, "fourteenth": 13, "fourteen": 13,
    "15th": 14, "fifteenth": 14, "fifteen": 14,
  };

  if (ordMap[cleaned] !== undefined) return ordMap[cleaned];
  if (ordMap[s] !== undefined) return ordMap[s];

  // Suffix/word match e.g. "4th" or "9th" inside "9th no pe jo sonngs hai usko play karo"
  const anyOrdMatch = s.match(/\b(\d+)(?:st|nd|rd|th)\b/i);
  if (anyOrdMatch) {
    const val = parseInt(anyOrdMatch[1], 10);
    return val <= 0 ? 0 : val - 1;
  }

  // Strings like "4th", "12th", "2", "3" after cleaning
  const thMatch = cleaned.match(/^(\d+)(?:st|nd|rd|th)?$/);
  if (thMatch) {
    const val = parseInt(thMatch[1], 10);
    return val <= 0 ? 0 : val - 1;
  }

  // Check token-level ordinal match inside cleaned string (excluding ambiguous "one")
  const tokens = cleaned.split(/[\s,.;:!?]+/).filter(Boolean);
  for (const tok of tokens) {
    if (tok !== "one" && ordMap[tok] !== undefined) {
      return ordMap[tok];
    }
  }

  // Standalone digits e.g. "no 4", "number 3", "3 wala play karo", "9 no pe jo sonngs hai"
  const numMatch = s.match(/(?:^|\b)(?:no\.?|number|#)?\s*(\d+)\b/i);
  if (numMatch) {
    const val = parseInt(numMatch[1], 10);
    if (val >= 1 && val <= 50) {
      return val - 1;
    }
    if (val === 0) return 0;
  }

  return null;
}

export class ActionContextManager {
  private _contexts = new Map<string, ExecutionContext>();
  private _lastActiveContextId = "default";
  private _lastUserUtterances = new Map<string, { text: string; updatedAt: number }>();

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
   * Record the user's latest spoken transcription text for the active turn
   * to resolve ordinal and numbered selections ("3 wala play karo", "9th no pe jo sonngs hai").
   */
  recordUserUtterance(contextId: string, text: string): void {
    if (!text || !text.trim()) return;
    const entry = { text: text.trim(), updatedAt: Date.now() };
    this._lastUserUtterances.set(contextId, entry);
    if (contextId !== "default") {
      this._lastUserUtterances.set("default", entry);
    }
  }

  /**
   * Get the user's latest spoken utterance if recorded within maxAgeMs (default 30s).
   */
  getLastUserUtterance(contextId: string, maxAgeMs = 30000): string | null {
    const entry = this._lastUserUtterances.get(contextId) || this._lastUserUtterances.get("default");
    if (!entry) return null;
    if (Date.now() - entry.updatedAt > maxAgeMs) {
      return null;
    }
    return entry.text;
  }

  /**
   * Consume and clear the user's latest spoken utterance.
   */
  consumeLastUserUtterance(contextId: string): string | null {
    const text = this.getLastUserUtterance(contextId);
    this._lastUserUtterances.delete(contextId);
    this._lastUserUtterances.delete("default");
    return text;
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

    // If incoming results array is empty but ctx already holds real search results,
    // preserve existing search results rather than replacing with a dummy 1-item placeholder!
    if (results.length === 0 && ctx.searchResults.length > 0 && !ctx.searchResults[0].videoId.startsWith("yt_top_")) {
      ctx.conversationState = "MEDIA_SEARCHED";
      ctx.updatedAt = new Date().toISOString();
      this._syncToDefault(ctx);
      return ctx;
    }

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

    // Propagate to all active conversation contexts so WebSocket sessions stay in sync
    for (const [otherId, otherCtx] of this._contexts.entries()) {
      if (otherId !== ctx.contextId) {
        otherCtx.currentWebsite = website;
        otherCtx.currentSearchQuery = cleanQuery;
        otherCtx.searchResults = [...normalizedResults];
        otherCtx.selectedResult = normalizedResults[0] || null;
        otherCtx.conversationState = "MEDIA_SEARCHED";
        otherCtx.updatedAt = new Date().toISOString();
      }
    }

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

    // Fallback sync: if this context has no search results, inherit from default context
    if (ctx.searchResults.length === 0) {
      const def = this._contexts.get("default");
      if (def && def.searchResults.length > 0) {
        ctx.searchResults = [...def.searchResults];
        ctx.selectedResult = def.selectedResult ? { ...def.selectedResult } : null;
      }
    }

    if (ctx.searchResults.length === 0) {
      return ctx.selectedResult || null;
    }

    if (selector === undefined || selector === null || selector === "") {
      const chosen = ctx.selectedResult || ctx.searchResults[0];
      ctx.selectedResult = chosen;
      this._syncToDefault(ctx);
      return chosen;
    }

    const parsedIdx = parseOrdinalOrIndex(selector);
    if (parsedIdx !== null) {
      // If backend searchResults only holds a 1-item placeholder but caller asks for non-zero index (e.g. 3rd or 9th),
      // preserve the exact requested index instead of clamping to 0!
      if (
        ctx.searchResults.length === 1 &&
        ctx.searchResults[0].videoId.startsWith("yt_top_") &&
        parsedIdx > 0
      ) {
        const syntheticItem: MediaSearchResultItem = {
          index: parsedIdx,
          videoId: "",
          title: `Result #${parsedIdx + 1}`,
          url: "",
        };
        ctx.selectedResult = syntheticItem;
        this._syncToDefault(ctx);
        return syntheticItem;
      }

      const boundedIdx = Math.max(0, Math.min(parsedIdx, ctx.searchResults.length - 1));
      const chosen = ctx.searchResults[boundedIdx];
      ctx.selectedResult = chosen;
      for (const otherCtx of this._contexts.values()) {
        otherCtx.selectedResult = chosen;
      }
      this._syncToDefault(ctx);
      return chosen;
    }

    const raw = String(selector).trim().toLowerCase();

    // Check video-<videoId>
    const cleanId = raw.startsWith("video-") ? selector.toString().slice(6) : selector.toString();
    const byId = ctx.searchResults.find(
      (r) => r.videoId.toLowerCase() === cleanId.toLowerCase() || r.videoId.toLowerCase() === raw,
    );
    if (byId) {
      ctx.selectedResult = byId;
      for (const otherCtx of this._contexts.values()) {
        otherCtx.selectedResult = byId;
      }
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
      this._lastUserUtterances.delete(contextId);
    } else {
      this._contexts.clear();
      this._lastUserUtterances.clear();
      this._lastActiveContextId = "default";
    }
  }
}

export const actionContextManager = new ActionContextManager();
