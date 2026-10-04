/**
 * MYRAA — Deterministic Action Result Verifier
 *
 * Ensures MYRAA never claims success unless a capability returns a verified result.
 * Produces structured verification payloads for:
 *   • openApplication  -> { launched, appName, pid, verified, targetDevice, capability }
 *   • openFile         -> { opened, filePath, editor, verified, targetDevice, capability }
 *   • youtube.search   -> { query, resultCount, topResults, selectedResult, verified, targetDevice, capability }
 *   • youtube.play     -> { playing, title, videoIdOrUrl, action, verified, targetDevice, capability }
 *   • browser.openUrl  -> { opened, url, verified, targetDevice, capability }
 */

import fs from "fs";
import path from "path";
import type {
  ActionVerificationResult,
  BrowserOpenUrlVerification,
  MediaSearchResultItem,
  OpenApplicationVerification,
  OpenFileVerification,
  TargetDevice,
  YouTubePlayVerification,
  YouTubeSearchVerification,
} from "./OrchestratorTypes.ts";

const WORKSPACE = process.env.SORA_WORKSPACE_DIR || process.cwd();

export class ActionVerifier {
  /**
   * Verify openApplication result.
   */
  verifyOpenApplication(
    appName: string,
    agentResult: { ok: boolean; result?: any; error?: string },
    targetDevice: TargetDevice = "DESKTOP",
    targetPath?: string,
  ): OpenApplicationVerification {
    if (!agentResult.ok || agentResult.error || agentResult.result?.error) {
      const errReason =
        agentResult.error ||
        agentResult.result?.error ||
        `Failed to launch application '${appName}' on ${targetDevice}.`;
      return {
        launched: false,
        appName,
        pid: null,
        verified: false,
        targetDevice,
        capability: "desktop.openApplication",
        ...(targetPath ? { path: targetPath } : {}),
        failureReason: String(errReason),
      };
    }

    const rawPid =
      typeof agentResult.result?.pid === "number"
        ? agentResult.result.pid
        : null;

    return {
      launched: true,
      appName,
      pid: rawPid,
      verified: true,
      targetDevice,
      capability: "desktop.openApplication",
      ...(targetPath ? { path: targetPath } : {}),
    };
  }

  /**
   * Verify openFile / openInVsCode result.
   */
  verifyOpenFile(
    filePath: string,
    editor = "vscode",
    agentResult: { ok: boolean; result?: any; error?: string },
    targetDevice: TargetDevice = "DESKTOP",
    checkDiskExistence = false,
  ): OpenFileVerification {
    if (!agentResult.ok || agentResult.error || agentResult.result?.error) {
      const errReason =
        agentResult.error ||
        agentResult.result?.error ||
        `Failed to open file '${filePath}' in ${editor}.`;
      return {
        opened: false,
        filePath,
        editor,
        verified: false,
        targetDevice,
        capability: "desktop.openFile",
        failureReason: String(errReason),
      };
    }

    if (checkDiskExistence && filePath) {
      const resolved = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(WORKSPACE, filePath);
      if (!fs.existsSync(resolved)) {
        return {
          opened: false,
          filePath,
          editor,
          verified: false,
          targetDevice,
          capability: "desktop.openFile",
          failureReason: `FILE_NOT_FOUND: Target file '${filePath}' does not exist on disk.`,
        };
      }
    }

    return {
      opened: true,
      filePath,
      editor,
      verified: true,
      targetDevice,
      capability: "desktop.openFile",
    };
  }

  /**
   * Verify youtube.search result.
   */
  verifyYouTubeSearch(
    query: string,
    results: MediaSearchResultItem[],
    targetDevice: TargetDevice = "BROWSER",
    error?: string,
  ): YouTubeSearchVerification {
    const cleanQuery = (query || "").trim();
    if (!cleanQuery || error) {
      return {
        query: cleanQuery,
        resultCount: 0,
        topResults: [],
        selectedResult: null,
        verified: false,
        targetDevice,
        capability: "youtube.search",
        failureReason: error || "EMPTY_SEARCH_QUERY: Search query cannot be empty.",
      };
    }

    if (!Array.isArray(results) || results.length === 0) {
      return {
        query: cleanQuery,
        resultCount: 0,
        topResults: [],
        selectedResult: null,
        verified: false,
        targetDevice,
        capability: "youtube.search",
        failureReason: `NO_SEARCH_RESULTS: No YouTube results returned for query '${cleanQuery}'.`,
      };
    }

    const topResults = results.slice(0, 5);
    return {
      query: cleanQuery,
      resultCount: results.length,
      topResults,
      selectedResult: results[0],
      verified: true,
      targetDevice,
      capability: "youtube.search",
    };
  }

  /**
   * Verify youtube.play / pause / resume / stop / next / previous result.
   */
  verifyYouTubePlay(
    mediaItem: MediaSearchResultItem | { videoId?: string; title?: string; url?: string } | null,
    action: "play" | "pause" | "resume" | "stop" | "next" | "previous" = "play",
    targetDevice: TargetDevice = "BROWSER",
    error?: string,
  ): YouTubePlayVerification {
    const capabilityMap: Record<string, string> = {
      play: "youtube.play",
      pause: "youtube.pause",
      resume: "youtube.resume",
      stop: "youtube.stop",
      next: "youtube.next",
      previous: "youtube.previous",
    };
    const capability = capabilityMap[action] || "youtube.play";

    if (error || !mediaItem || (!mediaItem.videoId && !mediaItem.url && !mediaItem.title)) {
      return {
        playing: false,
        paused: action === "pause" ? false : undefined,
        stopped: action === "stop" ? false : undefined,
        title: mediaItem?.title || "",
        videoIdOrUrl: mediaItem?.videoId || mediaItem?.url || "",
        action,
        verified: false,
        targetDevice,
        capability,
        failureReason:
          error ||
          "NO_MEDIA_SELECTED: No active media or search result available to play. Search or specify a song first.",
      };
    }

    const isPlaying = action === "play" || action === "resume" || action === "next" || action === "previous";
    const isPaused = action === "pause";
    const isStopped = action === "stop";

    return {
      playing: isPlaying,
      ...(isPaused ? { paused: true } : {}),
      ...(isStopped ? { stopped: true } : {}),
      title: mediaItem.title || mediaItem.videoId || "YouTube Video",
      videoIdOrUrl: mediaItem.videoId || mediaItem.url || "",
      action,
      verified: true,
      targetDevice,
      capability,
    };
  }

  /**
   * Verify browser.openUrl result.
   */
  verifyBrowserOpenUrl(
    url: string,
    agentResult: { ok: boolean; result?: any; error?: string },
    targetDevice: TargetDevice = "BROWSER",
  ): BrowserOpenUrlVerification {
    const cleanUrl = (url || "").trim();
    if (!cleanUrl || !agentResult.ok || agentResult.error || agentResult.result?.error) {
      return {
        opened: false,
        url: cleanUrl,
        verified: false,
        targetDevice,
        capability: "browser.openUrl",
        failureReason:
          agentResult.error ||
          agentResult.result?.error ||
          "INVALID_URL: Failed to open URL in browser.",
      };
    }

    const normalizedUrl = cleanUrl.includes("://") ? cleanUrl : `https://${cleanUrl}`;
    return {
      opened: true,
      url: normalizedUrl,
      verified: true,
      targetDevice,
      capability: "browser.openUrl",
    };
  }

  /**
   * Convert a specific verification payload into the canonical ActionVerificationResult envelope.
   */
  toEnvelope(
    verification:
      | OpenApplicationVerification
      | OpenFileVerification
      | YouTubeSearchVerification
      | YouTubePlayVerification
      | BrowserOpenUrlVerification,
  ): ActionVerificationResult {
    return {
      verified: verification.verified,
      capability: verification.capability,
      targetDevice: verification.targetDevice,
      details: { ...verification },
      ...(verification.failureReason
        ? {
            failureReason: verification.failureReason,
            failureCode: verification.failureReason.split(":")[0] || "VERIFICATION_FAILED",
          }
        : {}),
    };
  }
}

export const actionVerifier = new ActionVerifier();
