/**
 * MYRAA — Canonical Intent Resolver
 *
 * Resolves user utterances (English, Hindi, Hinglish) and incoming tool calls
 * into the Canonical Intent Model before any tool execution:
 *   {
 *     intent,
 *     targetDevice,
 *     capability,
 *     entity,
 *     arguments,
 *     contextId,
 *     conversationState,
 *     requiresConfirmation
 *   }
 *
 * Strictly enforces:
 *   1. PLAY_MEDIA never becomes SEARCH_MEDIA or "trending songs".
 *   2. Contextual references ("ye app", "isko", "that one", "first one", "current project")
 *      resolve against ActionContext.
 *   3. Explicit target device cues ("phone par", "laptop par", "PC par", "VS Code me")
 *      bind deterministically to PHONE | DESKTOP | BROWSER | REMOTE_DESKTOP.
 */

import type { SecurityContext } from "../security/SecurityTypes.ts";
import { actionContextManager } from "./ActionContext.ts";
import { capabilityRegistry } from "./CapabilityRegistry.ts";
import type {
  CanonicalIntent,
  ExecutionContext,
  IntentType,
  TargetDevice,
} from "./OrchestratorTypes.ts";

// Generic placeholder queries that must never overwrite an active specific search result on PLAY
const GENERIC_PLACEHOLDER_QUERIES = new Set([
  "trending",
  "trending song",
  "trending songs",
  "trending music",
  "trending video",
  "trending videos",
  "popular songs",
  "top songs",
  "latest songs",
  "music",
  "songs",
  "song",
  "video",
  "youtube",
]);

export class IntentResolver {
  /**
   * Detect explicit target device from natural language utterance or arguments.
   */
  resolveTargetDevice(
    text: string,
    defaultDevice: TargetDevice = "DESKTOP",
    secContext?: SecurityContext,
    explicitArgDevice?: string,
  ): TargetDevice {
    if (explicitArgDevice) {
      const upper = explicitArgDevice.trim().toUpperCase();
      if (upper === "PHONE" || upper === "MOBILE" || upper === "ANDROID") return "PHONE";
      if (upper === "REMOTE_DESKTOP") return "REMOTE_DESKTOP";
      if (upper === "BROWSER" || upper === "WEB") return "BROWSER";
      if (upper === "DESKTOP" || upper === "PC" || upper === "LAPTOP") return "DESKTOP";
    }

    const lower = (text || "").toLowerCase();

    // 1. Explicit Phone / Mobile cues
    if (
      /\b(phone\s+par|phone\s+me|phone\s+pe|mere\s+mobile|mobile\s+me|mobile\s+par|on\s+my\s+phone|on\s+phone|on\s+mobile|in\s+mobile|android\s+par|android\s+me)\b/i.test(
        lower,
      )
    ) {
      return "PHONE";
    }

    // 2. Explicit Remote Desktop cues
    if (/\b(remote\s+desktop|remote\s+pc)\b/i.test(lower)) {
      return "REMOTE_DESKTOP";
    }

    // 3. Explicit Desktop / Laptop / PC / VS Code cues
    if (
      /\b(laptop\s+par|laptop\s+me|laptop\s+pe|pc\s+par|pc\s+me|desktop\s+par|desktop\s+me|computer\s+par|on\s+laptop|on\s+pc|on\s+desktop|vs\s*code\s+me|vscode\s+me|in\s+vs\s*code|in\s+vscode|file\s+explorer)\b/i.test(
        lower,
      )
    ) {
      return secContext && !secContext.isLocal ? "DESKTOP" : "DESKTOP";
    }

    // 4. Explicit Browser / YouTube cues
    if (/\b(browser\s+me|browser\s+par|in\s+browser|youtube\s+par|youtube\s+pe|on\s+youtube)\b/i.test(lower)) {
      return "BROWSER";
    }

    return defaultDevice;
  }

  /**
   * Check if a query is a generic placeholder like "trending songs".
   */
  isGenericPlaceholderQuery(query: string | undefined | null): boolean {
    if (!query) return true;
    const clean = query.trim().toLowerCase().replace(/\s+/g, " ");
    return GENERIC_PLACEHOLDER_QUERIES.has(clean);
  }

  /**
   * Parse a natural language utterance (English / Hindi / Hinglish) into a CanonicalIntent.
   */
  resolveFromUtterance(
    utterance: string,
    contextId = "default",
    secContext?: SecurityContext,
  ): CanonicalIntent {
    const raw = (utterance || "").trim();
    const lower = raw.toLowerCase().replace(/\s+/g, " ");
    const ctx = actionContextManager.getContext(contextId);
    const snapshot = actionContextManager.getConversationSnapshot(contextId);

    // -------------------------------------------------------------------------
    // A. Multi-Step Desktop Code Workflow Detection
    //    e.g. "VS Code me ye file open karo, code check karo, net par best approach search karo, compare karke batao..."
    // -------------------------------------------------------------------------
    const hasInspectCue = /\b(code\s+check|inspect\s+code|analyze\s+code|code\s+verify|verify\s+it|check\s+karo)\b/i.test(lower);
    const hasCompareOrResearchCue =
      /\b(best\s+approach|best\s+practice|compare|net\s+par|web\s+research|search\s+karo.*compare)\b/i.test(lower);
    if (hasInspectCue && hasCompareOrResearchCue) {
      const targetDevice = this.resolveTargetDevice(raw, "DESKTOP", secContext);
      const fileMatch = raw.match(/(?:file\s+|open\s+)([a-zA-Z0-9_./\\-]+\.[a-zA-Z0-9]+)/i);
      const targetFile = fileMatch?.[1] || ctx.currentFile || "src/App.tsx";
      const wantsUpdate = /\b(update\s+kar\s+do|modify|apply|update\s+it|fix\s+kar\s+do)\b/i.test(lower);
      return {
        intent: wantsUpdate ? "MODIFY_FILE" : "COMPARE_IMPLEMENTATION",
        targetDevice,
        capability: wantsUpdate ? "desktop.modifyFile" : "code.inspect",
        entity: targetFile,
        arguments: {
          filePath: targetFile,
          workflow: "DESKTOP_CODE_WORKFLOW",
          includeResearch: true,
          includeComparison: true,
          proposeModification: wantsUpdate,
          rawRequest: raw,
        },
        contextId: ctx.contextId,
        conversationState: snapshot,
        requiresConfirmation: wantsUpdate,
      };
    }

    // -------------------------------------------------------------------------
    // B. Media Playback Controls (PAUSE / RESUME / STOP / NEXT / PREVIOUS)
    // -------------------------------------------------------------------------
    if (/^(pause|pause\s+karo|pause\s+kar\s+do|isko\s+pause\s+karo|gaana\s+roko|rok\s+do|pause\s+video|pause\s+music|pause\s+song)$/i.test(lower)) {
      const targetDevice = this.resolveTargetDevice(raw, "BROWSER", secContext);
      return {
        intent: "PAUSE_MEDIA",
        targetDevice,
        capability: "youtube.pause",
        entity: ctx.currentMedia?.title || ctx.selectedResult?.title || null,
        arguments: {
          action: "pause",
          videoId: ctx.currentMedia?.videoId || ctx.selectedResult?.videoId,
          title: ctx.currentMedia?.title || ctx.selectedResult?.title,
        },
        contextId: ctx.contextId,
        conversationState: snapshot,
        requiresConfirmation: false,
      };
    }

    if (/^(resume|resume\s+karo|resume\s+kar\s+do|continue\s+playing|wapas\s+chala\s+do|phir\s+se\s+chalao|unpause)$/i.test(lower)) {
      const targetDevice = this.resolveTargetDevice(raw, "BROWSER", secContext);
      const targetItem = ctx.selectedResult || ctx.searchResults[0] || null;
      return {
        intent: "RESUME_MEDIA",
        targetDevice,
        capability: "youtube.resume",
        entity: ctx.currentMedia?.title || targetItem?.title || null,
        arguments: {
          action: "resume",
          videoId: ctx.currentMedia?.videoId || targetItem?.videoId,
          title: ctx.currentMedia?.title || targetItem?.title,
        },
        contextId: ctx.contextId,
        conversationState: snapshot,
        requiresConfirmation: false,
      };
    }

    if (/^(stop|stop\s+karo|stop\s+playing|gaana\s+band\s+karo|music\s+band\s+karo|video\s+band\s+karo|stop\s+media|stop\s+song)$/i.test(lower)) {
      const targetDevice = this.resolveTargetDevice(raw, "BROWSER", secContext);
      return {
        intent: "STOP_MEDIA",
        targetDevice,
        capability: "youtube.stop",
        entity: ctx.currentMedia?.title || ctx.selectedResult?.title || null,
        arguments: {
          action: "stop",
          videoId: ctx.currentMedia?.videoId || ctx.selectedResult?.videoId,
          title: ctx.currentMedia?.title || ctx.selectedResult?.title,
        },
        contextId: ctx.contextId,
        conversationState: snapshot,
        requiresConfirmation: false,
      };
    }

    if (/^(next|next\s+song|next\s+video|next\s+track|next\s+karo|agla\s+gaana|agla\s+song|agla\s+lagao|skip|skip\s+song)$/i.test(lower)) {
      const targetDevice = this.resolveTargetDevice(raw, "BROWSER", secContext);
      return {
        intent: "NEXT_MEDIA",
        targetDevice,
        capability: "youtube.next",
        entity: ctx.selectedResult?.title || null,
        arguments: {
          action: "next",
        },
        contextId: ctx.contextId,
        conversationState: snapshot,
        requiresConfirmation: false,
      };
    }

    if (/^(previous|previous\s+song|previous\s+video|previous\s+track|previous\s+karo|pichla\s+gaana|pichla\s+song|prev\s+song)$/i.test(lower)) {
      const targetDevice = this.resolveTargetDevice(raw, "BROWSER", secContext);
      return {
        intent: "PREVIOUS_MEDIA",
        targetDevice,
        capability: "youtube.previous",
        entity: ctx.selectedResult?.title || null,
        arguments: {
          action: "previous",
        },
        contextId: ctx.contextId,
        conversationState: snapshot,
        requiresConfirmation: false,
      };
    }

    // -------------------------------------------------------------------------
    // C. YouTube / Media SEARCH
    //    e.g. "YouTube par [song] search karo", "search [song] on YouTube"
    // -------------------------------------------------------------------------
    const ytSearchMatch =
      raw.match(/^(?:youtube\s+(?:par|pe|mein|me|on)\s+)(.+?)(?:\s+search\s+karo|\s+search\s+kar\s+do|\s+dhundo|\s+search)$/i) ||
      raw.match(/^(?:search\s+(?:for\s+)?)(.+?)(?:\s+on\s+youtube|\s+in\s+youtube|\s+youtube\s+par|\s+youtube\s+pe)$/i) ||
      raw.match(/^(?:youtube\s+search\s+)(.+)$/i);

    if (ytSearchMatch) {
      const query = ytSearchMatch[1]
        .replace(/\b(search\s+karo|search|youtube\s+par|youtube\s+pe|on\s+youtube)\b/gi, "")
        .trim();
      const targetDevice = this.resolveTargetDevice(raw, "BROWSER", secContext);
      return {
        intent: "SEARCH_MEDIA",
        targetDevice,
        capability: "youtube.search",
        entity: query,
        arguments: {
          query,
          engine: "youtube",
        },
        contextId: ctx.contextId,
        conversationState: snapshot,
        requiresConfirmation: false,
      };
    }

    // -------------------------------------------------------------------------
    // D. YouTube / Media PLAY ("Play karo", "isko play karo", "play the first one",
    //    "play that one", "play [song]")
    //    RULE: PLAY must NEVER degrade into "trending songs" or a generic search!
    // -------------------------------------------------------------------------
    const barePlayMatch =
      /^(play|play\s+karo|play\s+kar\s+do|isko\s+play\s+karo|ise\s+play\s+karo|ye\s+play\s+karo|chala\s+do|chalao|isko\s+chalao|bajao|isko\s+bajao|play\s+it|play\s+this|play\s+that|play\s+that\s+one|play\s+this\s+one|wo\s+wala\s+play\s+karo|ye\s+wala\s+play\s+karo)$/i.test(
        lower,
      );

    if (barePlayMatch) {
      const targetDevice = this.resolveTargetDevice(raw, "BROWSER", secContext);
      const selected = ctx.selectedResult || ctx.searchResults[0] || null;
      return {
        intent: "PLAY_MEDIA",
        targetDevice,
        capability: "youtube.play",
        entity: selected?.title || ctx.currentMedia?.title || ctx.currentSearchQuery || null,
        arguments: {
          action: "play",
          videoId: selected?.videoId || ctx.currentMedia?.videoId || null,
          title: selected?.title || ctx.currentMedia?.title || ctx.currentSearchQuery || null,
          url: selected?.url || ctx.currentMedia?.url || null,
          index: selected?.index ?? 0,
        },
        contextId: ctx.contextId,
        conversationState: snapshot,
        requiresConfirmation: false,
      };
    }

    // Ordinal play: "play the first one", "first wala play karo", "play second one", "play #1"
    const ordinalPlayMatch =
      lower.match(
        /\b(?:play\s+(?:the\s+)?(first|1st|second|2nd|third|3rd|pehla|doosra|dusra|teesra|#1|#2|#3)(?:\s+one|\s+result|\s+video|\s+song|\s+wala)?)\b/i,
      ) ||
      lower.match(
        /\b(first|1st|second|2nd|third|3rd|pehla|doosra|dusra|teesra)\s+(?:wala|one|song|video|result)?\s*(?:play\s+karo|play\s+kar\s+do|chalao|chala\s+do|bajao|play)\b/i,
      );

    if (ordinalPlayMatch) {
      const ordToken = ordinalPlayMatch[1].toLowerCase();
      const chosen = actionContextManager.selectMediaResult(contextId, ordToken);
      const targetDevice = this.resolveTargetDevice(raw, "BROWSER", secContext);
      return {
        intent: "PLAY_MEDIA",
        targetDevice,
        capability: "youtube.play",
        entity: chosen?.title || null,
        arguments: {
          action: "play",
          selector: ordToken,
          index: chosen?.index ?? 0,
          videoId: chosen?.videoId || null,
          title: chosen?.title || null,
          url: chosen?.url || null,
        },
        contextId: ctx.contextId,
        conversationState: actionContextManager.getConversationSnapshot(contextId),
        requiresConfirmation: false,
      };
    }

    // Specific song play: "play [song]" or "[song] play karo" / "YouTube par [song] play karo"
    const specificPlayMatch =
      raw.match(/^(?:youtube\s+(?:par|pe)\s+)?play\s+(.+)$/i) ||
      raw.match(/^(?:youtube\s+(?:par|pe)\s+)?(.+?)\s+(?:play\s+karo|play\s+kar\s+do|bajao|chala\s+do)$/i);

    if (
      specificPlayMatch &&
      !/\b(open\s+karo|kholo|vs\s*code|file|folder|app)\b/i.test(specificPlayMatch[1])
    ) {
      const requestedSong = specificPlayMatch[1]
        .replace(/\b(on\s+youtube|in\s+youtube|youtube\s+par|youtube\s+pe|song|video)\b/gi, "")
        .trim();

      const targetDevice = this.resolveTargetDevice(raw, "BROWSER", secContext);
      // Check if requestedSong matches an existing search result in context
      const existingMatch = actionContextManager.findMatchingMediaResult(contextId, requestedSong);

      if (existingMatch) {
        actionContextManager.selectMediaResult(contextId, existingMatch.index);
        return {
          intent: "PLAY_MEDIA",
          targetDevice,
          capability: "youtube.play",
          entity: existingMatch.title,
          arguments: {
            action: "play",
            index: existingMatch.index,
            videoId: existingMatch.videoId,
            title: existingMatch.title,
            url: existingMatch.url,
            query: requestedSong,
            autoSearchAndPlay: false,
          },
          contextId: ctx.contextId,
          conversationState: actionContextManager.getConversationSnapshot(contextId),
          requiresConfirmation: false,
        };
      }

      // Not in current results -> search [song] and play first result deterministically
      return {
        intent: "PLAY_MEDIA",
        targetDevice,
        capability: "youtube.play",
        entity: requestedSong,
        arguments: {
          action: "play",
          query: requestedSong,
          autoSearchAndPlay: true,
        },
        contextId: ctx.contextId,
        conversationState: snapshot,
        requiresConfirmation: false,
      };
    }

    // -------------------------------------------------------------------------
    // E. Open File / Open Project in VS Code
    //    e.g. "VS Code me current project open karo", "isme current project open karo",
    //         "VS Code me ye file open karo", "VS Code me server.ts open karo"
    // -------------------------------------------------------------------------
    if (
      /\b(current\s+project|ye\s+project|this\s+project|workspace)\b/i.test(lower) &&
      /\b(open|kholo|vs\s*code|vscode|isme)\b/i.test(lower)
    ) {
      const targetDevice = this.resolveTargetDevice(raw, "DESKTOP", secContext);
      const projectPath = ctx.currentProject || ctx.currentWorkspace || process.cwd();
      return {
        intent: "OPEN_FOLDER",
        targetDevice,
        capability: "desktop.openApplication",
        entity: projectPath,
        arguments: {
          name: "vscode",
          path: projectPath,
        },
        contextId: ctx.contextId,
        conversationState: snapshot,
        requiresConfirmation: false,
      };
    }

    if (
      (/\b(vs\s*code|vscode)\b/i.test(lower) && /\b(file|open|kholo)\b/i.test(lower)) ||
      /\b(ye\s+file\s+open\s+karo|open\s+this\s+file)\b/i.test(lower)
    ) {
      const targetDevice = this.resolveTargetDevice(raw, "DESKTOP", secContext);
      const explicitFileMatch = raw.match(/([a-zA-Z0-9_./\\-]+\.[a-zA-Z0-9]{1,8})/);
      const resolvedFile = explicitFileMatch?.[1] || ctx.currentFile;
      if (resolvedFile) {
        return {
          intent: "OPEN_FILE",
          targetDevice,
          capability: "desktop.openFile",
          entity: resolvedFile,
          arguments: {
            path: resolvedFile,
            editor: "vscode",
          },
          contextId: ctx.contextId,
          conversationState: snapshot,
          requiresConfirmation: false,
        };
      }
    }

    // -------------------------------------------------------------------------
    // F. Open Application ("VS Code open karo", "File Explorer open karo",
    //    "Chrome open karo", "YouTube open karo", "ye app open karo", "laptop par VS Code kholo")
    // -------------------------------------------------------------------------
    const openAppMatch =
      raw.match(/^(?:laptop\s+par\s+|pc\s+par\s+|desktop\s+par\s+|phone\s+par\s+|mere\s+mobile\s+me\s+)?(.+?)\s+(?:open\s+karo|open\s+kar\s+do|kholo|khol\s+do|chalu\s+karo|launch\s+karo)$/i) ||
      raw.match(/^(?:open|launch|start)\s+(.+?)(?:\s+on\s+laptop|\s+on\s+pc|\s+on\s+desktop|\s+on\s+phone|\s+on\s+mobile)?$/i);

    if (openAppMatch) {
      const rawTarget = openAppMatch[1].trim();
      const aliasRes = capabilityRegistry.resolveApplicationAlias(rawTarget, ctx);
      const defaultDev: TargetDevice =
        aliasRes.canonicalApp && ["gmail", "maps"].includes(aliasRes.canonicalApp)
          ? "BROWSER"
          : "DESKTOP";
      const targetDevice = this.resolveTargetDevice(raw, defaultDev, secContext);

      return {
        intent: "OPEN_APPLICATION",
        targetDevice,
        capability: "desktop.openApplication",
        entity: aliasRes.canonicalApp || rawTarget,
        arguments: {
          name: aliasRes.canonicalApp || rawTarget,
          rawName: rawTarget,
          fromContext: aliasRes.fromContext,
          isWebsiteApp: aliasRes.isWebsiteApp,
          websiteUrl: aliasRes.websiteUrl,
        },
        contextId: ctx.contextId,
        conversationState: snapshot,
        requiresConfirmation: false,
      };
    }

    // Fallback general intent
    const fallbackDevice = this.resolveTargetDevice(raw, "DESKTOP", secContext);
    return {
      intent: "GENERAL_TOOL",
      targetDevice: fallbackDevice,
      capability: "tool.general",
      entity: raw || null,
      arguments: { rawUtterance: raw },
      contextId: ctx.contextId,
      conversationState: snapshot,
      requiresConfirmation: false,
    };
  }

  /**
   * Resolve and normalize a direct tool call (from Gemini Live, HTTP, or WS) into a CanonicalIntent.
   *
   * Protects against:
   *   1. Gemini calling searchYouTube / browserSearch with "trending songs" when user asked to PLAY
   *      the current search result.
   *   2. Unresolved application aliases or contextual app names ("ye app", "VS Code", "File Explorer")
   *      in openApplication.
   *   3. Missing media item context when browserMediaControl({ action: "play" }) is called.
   */
  resolveFromToolCall(
    toolName: string,
    args: Record<string, unknown> = {},
    contextId = "default",
    secContext?: SecurityContext,
  ): CanonicalIntent {
    const ctx = actionContextManager.getContext(contextId);
    const snapshot = actionContextManager.getConversationSnapshot(contextId);
    const explicitDevice = (args.targetDevice || args.device) as string | undefined;

    // -------------------------------------------------------------------------
    // 1. Application Open (`openApplication`, `openInVsCode`)
    // -------------------------------------------------------------------------
    if (toolName === "openApplication" || toolName === "openInVsCode") {
      const rawAppName =
        toolName === "openInVsCode"
          ? "vscode"
          : String(args.name || args.app || args.app_name || args.appName || "").trim();

      const aliasRes = capabilityRegistry.resolveApplicationAlias(rawAppName, ctx);
      const resolvedApp = aliasRes.canonicalApp || rawAppName.toLowerCase();

      // Determine if opening a file/folder in VS Code
      const targetPath =
        (args.path as string | undefined) ||
        (toolName === "openInVsCode" ? ctx.currentFile || ctx.currentProject || undefined : undefined);

      const targetDevice = this.resolveTargetDevice(
        `${rawAppName} ${String(args.utterance || "")}`,
        "DESKTOP",
        secContext,
        explicitDevice,
      );

      return {
        intent: toolName === "openInVsCode" && targetPath ? "OPEN_FILE" : "OPEN_APPLICATION",
        targetDevice,
        capability: toolName === "openInVsCode" && targetPath ? "desktop.openFile" : "desktop.openApplication",
        entity: resolvedApp || null,
        arguments: {
          ...args,
          name: resolvedApp,
          rawName: rawAppName,
          ...(targetPath ? { path: targetPath } : {}),
          isWebsiteApp: aliasRes.isWebsiteApp,
          websiteUrl: aliasRes.websiteUrl,
          aliasResolved: aliasRes.resolved,
          aliasReason: aliasRes.reason,
        },
        contextId: ctx.contextId,
        conversationState: snapshot,
        requiresConfirmation: false,
      };
    }

    // -------------------------------------------------------------------------
    // 2. Open File / Open Folder (`openFile`, `openFolder`)
    // -------------------------------------------------------------------------
    if (toolName === "openFile") {
      const rawPath = String(args.path || args.name || ctx.currentFile || "").trim();
      const targetDevice = this.resolveTargetDevice(rawPath, "DESKTOP", secContext, explicitDevice);
      return {
        intent: "OPEN_FILE",
        targetDevice,
        capability: "desktop.openFile",
        entity: rawPath || null,
        arguments: {
          ...args,
          path: rawPath,
        },
        contextId: ctx.contextId,
        conversationState: snapshot,
        requiresConfirmation: false,
      };
    }

    if (toolName === "openFolder") {
      const rawPath = String(args.path || args.name || ctx.currentProject || ctx.currentWorkspace || "").trim();
      const targetDevice = this.resolveTargetDevice(rawPath, "DESKTOP", secContext, explicitDevice);
      return {
        intent: "OPEN_FOLDER",
        targetDevice,
        capability: "desktop.openFolder",
        entity: rawPath || null,
        arguments: {
          ...args,
          path: rawPath,
        },
        contextId: ctx.contextId,
        conversationState: snapshot,
        requiresConfirmation: false,
      };
    }

    // -------------------------------------------------------------------------
    // 3. YouTube & Media Search (`searchYouTube`, `browserSearch`)
    //    CRITICAL GUARD: If Gemini tries to search "trending songs" while
    //    context ALREADY has searchResults from a user query, intercept it as PLAY_MEDIA!
    // -------------------------------------------------------------------------
    if (toolName === "searchYouTube" || toolName === "browserSearch") {
      const rawQuery = String(args.query || args.q || "").trim();
      const targetDevice = this.resolveTargetDevice(rawQuery, "BROWSER", secContext, explicitDevice);

      if (this.isGenericPlaceholderQuery(rawQuery) && ctx.searchResults.length > 0) {
        const selected = ctx.selectedResult || ctx.searchResults[0];
        return {
          intent: "PLAY_MEDIA",
          targetDevice,
          capability: "youtube.play",
          entity: selected.title,
          arguments: {
            action: "play",
            videoId: selected.videoId,
            title: selected.title,
            url: selected.url,
            index: selected.index,
            interceptedGenericSearch: rawQuery,
          },
          contextId: ctx.contextId,
          conversationState: snapshot,
          requiresConfirmation: false,
        };
      }

      return {
        intent: "SEARCH_MEDIA",
        targetDevice,
        capability: "youtube.search",
        entity: rawQuery || null,
        arguments: {
          ...args,
          query: rawQuery,
          engine: "youtube",
        },
        contextId: ctx.contextId,
        conversationState: snapshot,
        requiresConfirmation: false,
      };
    }

    // -------------------------------------------------------------------------
    // 4. Media Playback Controls (`browserMediaControl`, `browserClick` on video)
    // -------------------------------------------------------------------------
    if (toolName === "browserMediaControl") {
      const rawAction = String(args.action || "play").toLowerCase().trim();
      const targetDevice = this.resolveTargetDevice(rawAction, "BROWSER", secContext, explicitDevice);

      // Map action to canonical IntentType & capability
      let intent: IntentType = "PLAY_MEDIA";
      let capability = "youtube.play";
      if (rawAction === "pause") {
        intent = "PAUSE_MEDIA";
        capability = "youtube.pause";
      } else if (rawAction === "resume") {
        intent = "RESUME_MEDIA";
        capability = "youtube.resume";
      } else if (rawAction === "stop") {
        intent = "STOP_MEDIA";
        capability = "youtube.stop";
      } else if (rawAction === "next" || rawAction === "skip") {
        intent = "NEXT_MEDIA";
        capability = "youtube.next";
      } else if (rawAction === "previous" || rawAction === "prev") {
        intent = "PREVIOUS_MEDIA";
        capability = "youtube.previous";
      }

      // Resolve target media item from context or selector
      let targetItem = ctx.selectedResult || ctx.searchResults[0] || null;
      if (args.index !== undefined || args.selector !== undefined) {
        targetItem =
          actionContextManager.selectMediaResult(
            contextId,
            (args.index ?? args.selector) as number | string,
          ) || targetItem;
      } else if (typeof args.query === "string" && args.query.trim()) {
        const matched = actionContextManager.findMatchingMediaResult(contextId, args.query);
        if (matched) {
          targetItem = matched;
        }
      }

      return {
        intent,
        targetDevice,
        capability,
        entity:
          (args.title as string) ||
          targetItem?.title ||
          ctx.currentMedia?.title ||
          (args.query as string) ||
          null,
        arguments: {
          ...args,
          action: rawAction === "skip" ? "next" : rawAction,
          videoId: (args.videoId as string) || targetItem?.videoId || ctx.currentMedia?.videoId || null,
          title: (args.title as string) || targetItem?.title || ctx.currentMedia?.title || null,
          url: (args.url as string) || targetItem?.url || ctx.currentMedia?.url || null,
          index: typeof args.index === "number" ? args.index : targetItem?.index ?? 0,
        },
        contextId: ctx.contextId,
        conversationState: snapshot,
        requiresConfirmation: false,
      };
    }

    if (toolName === "browserClick") {
      const selector = String(args.selector || "").trim();
      const targetDevice = this.resolveTargetDevice(selector, "BROWSER", secContext, explicitDevice);

      const isMediaClick =
        selector.startsWith("video-") ||
        selector === "play-button" ||
        selector === "pause-button" ||
        /^(first|second|third|0|1|2|#1|#2|#3)$/i.test(selector);

      if (isMediaClick) {
        if (selector === "pause-button") {
          return {
            intent: "PAUSE_MEDIA",
            targetDevice,
            capability: "youtube.pause",
            entity: ctx.currentMedia?.title || ctx.selectedResult?.title || null,
            arguments: { ...args, action: "pause" },
            contextId: ctx.contextId,
            conversationState: snapshot,
            requiresConfirmation: false,
          };
        }

        const chosen = actionContextManager.selectMediaResult(contextId, selector);
        return {
          intent: "PLAY_MEDIA",
          targetDevice,
          capability: "youtube.play",
          entity: chosen?.title || (args.description as string) || selector,
          arguments: {
            ...args,
            action: "play",
            selector,
            videoId: chosen?.videoId || (selector.startsWith("video-") ? selector.slice(6) : null),
            title: chosen?.title || (args.description as string) || null,
            url: chosen?.url || null,
            index: chosen?.index ?? 0,
          },
          contextId: ctx.contextId,
          conversationState: actionContextManager.getConversationSnapshot(contextId),
          requiresConfirmation: false,
        };
      }
    }

    // -------------------------------------------------------------------------
    // 5. Open Website / Browser Open (`browserOpen`, `openWebsite`)
    // -------------------------------------------------------------------------
    if (toolName === "browserOpen" || toolName === "openWebsite" || toolName === "desktopBrowserOpen") {
      const rawUrl = String(args.url || args.name || "").trim();
      const targetDevice = this.resolveTargetDevice(rawUrl, "BROWSER", secContext, explicitDevice);
      return {
        intent: "OPEN_WEBSITE",
        targetDevice,
        capability: "browser.openUrl",
        entity: rawUrl || null,
        arguments: {
          ...args,
          url: rawUrl,
        },
        contextId: ctx.contextId,
        conversationState: snapshot,
        requiresConfirmation: false,
      };
    }

    // -------------------------------------------------------------------------
    // 6. Code Inspection, Research, and File Modification
    // -------------------------------------------------------------------------
    if (toolName === "readFile" || toolName === "read_file") {
      const filePath = String(args.path || ctx.currentFile || "").trim();
      const targetDevice = this.resolveTargetDevice(filePath, "DESKTOP", secContext, explicitDevice);
      return {
        intent: "INSPECT_CODE",
        targetDevice,
        capability: "desktop.readFile",
        entity: filePath || null,
        arguments: { ...args, path: filePath },
        contextId: ctx.contextId,
        conversationState: snapshot,
        requiresConfirmation: false,
      };
    }

    if (toolName === "researchWeb" || toolName === "fetchOfficialDocs") {
      const query = String(args.query || args.topic || args.technology || "").trim();
      const targetDevice = this.resolveTargetDevice(query, "DESKTOP", secContext, explicitDevice);
      return {
        intent: "WEB_RESEARCH",
        targetDevice,
        capability: "code.research",
        entity: query || null,
        arguments: { ...args },
        contextId: ctx.contextId,
        conversationState: snapshot,
        requiresConfirmation: false,
      };
    }

    const meta = capabilityRegistry.getCapabilityMetadata(toolName);
    const resolvedTarget = this.resolveTargetDevice(
      toolName,
      meta.target,
      secContext,
      explicitDevice,
    );

    return {
      intent: meta.confirmationRequired ? "MODIFY_FILE" : "GENERAL_TOOL",
      targetDevice: resolvedTarget,
      capability: meta.capability,
      entity: (args.path || args.name || args.query || args.app || null) as string | null,
      arguments: { ...args },
      contextId: ctx.contextId,
      conversationState: snapshot,
      requiresConfirmation: meta.confirmationRequired,
    };
  }
}

export const intentResolver = new IntentResolver();
