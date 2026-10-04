/**
 * MYRAA — DesktopCapabilityEngine
 *
 * Desktop-first capability engine for MYRAA Desktop (Windows/Electron).
 *
 * This engine handles all capabilities that are native to a Windows desktop:
 *   - Application launcher (VS Code, browsers, Windows native apps)
 *   - File system operations (read, write, search, delete)
 *   - Browser control and web research
 *   - VS Code / Project Intelligence
 *   - Shell / Terminal commands
 *   - Window management
 *   - Screen capture / verification
 *   - Crash recovery
 *
 * WORKS COMPLETELY WITHOUT PHONE CONNECTED.
 *
 * "Phone installed न हो, फिर भी MYRAA Desktop complete usable हो।"
 * (Even if phone is not installed, MYRAA Desktop should be completely usable.)
 *
 * Security policy evaluation happens in CapabilityRegistry BEFORE reaching here.
 */

import type {
  ProductCapabilityEngine,
  DeviceExecutionContext,
  DeviceCapabilityResult,
  CapabilityScope,
} from "./DeviceTypes.ts";

// ---------------------------------------------------------------------------
// Desktop Application Executable Map
// Mirrors the APPLICATION_ALIASES in CapabilityRegistry for Windows desktop context.
// ---------------------------------------------------------------------------

const WINDOWS_APP_EXECUTABLES: Readonly<Record<string, string>> = {
  "vscode":         "D:/Microsoft VS Code/Code.exe",
  "cursor":         "cursor",
  "explorer":       "explorer.exe",
  "chrome":         "chrome.exe",
  "edge":           "msedge.exe",
  "brave":          "brave.exe",
  "firefox":        "firefox.exe",
  "notepad":        "notepad.exe",
  "calculator":     "calc.exe",
  "terminal":       "wt.exe",
  "cmd":            "cmd.exe",
  "powershell":     "powershell.exe",
  "task manager":   "taskmgr.exe",
  "settings":       "ms-settings:",
  "paint":          "mspaint.exe",
  "snipping tool":  "SnippingTool.exe",
  "word":           "winword.exe",
  "excel":          "excel.exe",
  "powerpoint":     "powerpnt.exe",
  "spotify":        "spotify.exe",
  "whatsapp":       "whatsapp.exe",
  "telegram":       "Telegram.exe",
  "tg":             "Telegram.exe",
  "file manager":   "explorer.exe",
  "file explorer":  "explorer.exe",
};


// ---------------------------------------------------------------------------
// Capabilities supported by Desktop engine
// ---------------------------------------------------------------------------

const DESKTOP_SUPPORTED_CAPABILITIES: ReadonlySet<string> = new Set([
  "desktop.openApplication",
  "desktop.closeApplication",
  "desktop.openFile",
  "desktop.openFolder",
  "desktop.readFile",
  "desktop.modifyFile",
  "desktop.deleteFile",
  "desktop.runCommand",
  "desktop.screenshot",
  "desktop.windowManagement",
  "desktop.clipboard",
  "desktop.codeInspect",
  "desktop.codeWorkflow",
  "desktop.projectIntelligence",
  // Shared-cloud capabilities also run here when on desktop
  "youtube.search",
  "youtube.play",
  "youtube.pause",
  "youtube.resume",
  "youtube.stop",
  "youtube.next",
  "youtube.previous",
  "youtube.volume",
  "browser.openUrl",
  "browser.search",
  "web.research",
  "ai.chat",
  "ai.summarize",
  "memory.read",
  "memory.write",
]);

const DESKTOP_SCOPE_MAP: Readonly<Record<string, CapabilityScope>> = {
  "desktop.openApplication":     "desktop-local",
  "desktop.closeApplication":    "desktop-local",
  "desktop.openFile":            "desktop-local",
  "desktop.openFolder":          "desktop-local",
  "desktop.readFile":            "desktop-local",
  "desktop.modifyFile":          "desktop-local",
  "desktop.deleteFile":          "desktop-local",
  "desktop.runCommand":          "desktop-local",
  "desktop.screenshot":          "desktop-local",
  "desktop.windowManagement":    "desktop-local",
  "desktop.clipboard":           "desktop-local",
  "desktop.codeInspect":         "desktop-local",
  "desktop.codeWorkflow":        "desktop-local",
  "desktop.projectIntelligence": "desktop-local",
  "youtube.search":              "shared-cloud",
  "youtube.play":                "shared-cloud",
  "youtube.pause":               "shared-cloud",
  "youtube.resume":              "shared-cloud",
  "youtube.stop":                "shared-cloud",
  "youtube.next":                "shared-cloud",
  "youtube.previous":            "shared-cloud",
  "youtube.volume":              "shared-cloud",
  "browser.openUrl":             "shared-cloud",
  "browser.search":              "shared-cloud",
  "web.research":                "shared-cloud",
  "ai.chat":                     "shared-cloud",
  "ai.summarize":                "shared-cloud",
  "memory.read":                 "shared-cloud",
  "memory.write":                "shared-cloud",
};

// ---------------------------------------------------------------------------
// DesktopCapabilityEngine
// ---------------------------------------------------------------------------

export class DesktopCapabilityEngine implements ProductCapabilityEngine {
  readonly productType = "MYRAA_DESKTOP" as const;

  canExecute(capability: string): boolean {
    return DESKTOP_SUPPORTED_CAPABILITIES.has(capability);
  }

  getScopeFor(capability: string): CapabilityScope | undefined {
    return DESKTOP_SCOPE_MAP[capability];
  }

  async execute(
    capability: string,
    args: Record<string, unknown>,
    _context: DeviceExecutionContext,
  ): Promise<DeviceCapabilityResult> {
    if (!this.canExecute(capability)) {
      return {
        success: false,
        message: `Capability '${capability}' is not supported on MYRAA Desktop.`,
        errorCode: "CAPABILITY_NOT_SUPPORTED",
        bridgeRequired: true,
        bridgeTargetProduct: "MYRAA_MOBILE",
      };
    }

    switch (capability) {
      case "desktop.openApplication":
        return this._openApplication(args);
      case "desktop.openFile":
        return this._openFile(args);
      case "desktop.openFolder":
        return this._openFolder(args);
      case "desktop.readFile":
        return this._readFile(args);
      case "desktop.modifyFile":
        return this._modifyFile(args);
      case "desktop.deleteFile":
        return this._deleteFile(args);
      case "desktop.runCommand":
        return this._runCommand(args);
      case "desktop.screenshot":
        return this._screenshot(args);
      case "desktop.clipboard":
        return this._clipboardAction(args);
      case "desktop.codeInspect":
        return this._codeInspect(args);
      case "youtube.search":
        return this._youtubeSearch(args);
      case "youtube.play":
        return this._youtubePlay(args);
      case "browser.openUrl":
        return this._browserOpenUrl(args);
      case "browser.search":
        return this._browserSearch(args);
      default:
        return {
          success: true,
          message: `Capability '${capability}' acknowledged by Desktop engine.`,
          payload: { capability, args, delegated: true },
        };
    }
  }

  // ── Handlers ────────────────────────────────────────────────────────────

  private _openApplication(args: Record<string, unknown>): DeviceCapabilityResult {
    const appName = String(args.appName || args.app || args.application || "").toLowerCase().trim();
    if (!appName) {
      return {
        success: false,
        message: "Please specify which application to open.",
        errorCode: "MISSING_ARG_APP_NAME",
      };
    }

    const executable = WINDOWS_APP_EXECUTABLES[appName];
    return {
      success: true,
      message: `Opening ${appName} on desktop.`,
      payload: {
        action: "OPEN_APPLICATION",
        appName,
        executable: executable || appName,
        // Executed by desktop_agent/tools_applications.py → open_application()
      },
    };
  }

  private _openFile(args: Record<string, unknown>): DeviceCapabilityResult {
    const filePath = String(args.filePath || args.path || args.file || "");
    const editor = String(args.editor || args.in || "").toLowerCase();

    if (!filePath) {
      return {
        success: false,
        message: "Please specify the file path to open.",
        errorCode: "MISSING_ARG_FILE_PATH",
      };
    }

    return {
      success: true,
      message: editor
        ? `Opening ${filePath} in ${editor}.`
        : `Opening ${filePath}.`,
      payload: {
        action: "OPEN_FILE",
        filePath,
        editor: editor || null,
      },
    };
  }

  private _openFolder(args: Record<string, unknown>): DeviceCapabilityResult {
    const folderPath = String(args.folderPath || args.path || args.folder || "");
    if (!folderPath) {
      return {
        success: false,
        message: "Please specify the folder path to open.",
        errorCode: "MISSING_ARG_FOLDER_PATH",
      };
    }
    return {
      success: true,
      message: `Opening folder: ${folderPath}`,
      payload: { action: "OPEN_FOLDER", folderPath },
    };
  }

  private _readFile(args: Record<string, unknown>): DeviceCapabilityResult {
    const filePath = String(args.filePath || args.path || args.file || "");
    if (!filePath) {
      return {
        success: false,
        message: "Please specify the file path to read.",
        errorCode: "MISSING_ARG_FILE_PATH",
      };
    }
    return {
      success: true,
      message: `Reading file: ${filePath}`,
      payload: { action: "READ_FILE", filePath },
    };
  }

  private _modifyFile(args: Record<string, unknown>): DeviceCapabilityResult {
    const filePath = String(args.filePath || args.path || args.file || "");
    if (!filePath) {
      return {
        success: false,
        message: "Please specify the file path to modify.",
        errorCode: "MISSING_ARG_FILE_PATH",
      };
    }
    return {
      success: true,
      message: `Modifying file: ${filePath}`,
      payload: { action: "MODIFY_FILE", filePath, ...args },
    };
  }

  private _deleteFile(args: Record<string, unknown>): DeviceCapabilityResult {
    const filePath = String(args.filePath || args.path || args.file || "");
    if (!filePath) {
      return {
        success: false,
        message: "Please specify the file path to delete.",
        errorCode: "MISSING_ARG_FILE_PATH",
      };
    }
    return {
      success: true,
      message: `Delete requested: ${filePath}`,
      payload: { action: "DELETE_FILE", filePath },
    };
  }

  private _runCommand(args: Record<string, unknown>): DeviceCapabilityResult {
    const command = String(args.command || args.cmd || args.script || "");
    if (!command) {
      return {
        success: false,
        message: "Please specify the command to run.",
        errorCode: "MISSING_ARG_COMMAND",
      };
    }
    return {
      success: true,
      message: `Running command: ${command.slice(0, 80)}`,
      payload: {
        action: "RUN_COMMAND",
        command,
        shell: String(args.shell || "powershell"),
      },
    };
  }

  private _screenshot(args: Record<string, unknown>): DeviceCapabilityResult {
    return {
      success: true,
      message: "Taking screenshot.",
      payload: {
        action: "SCREENSHOT",
        region: args.region || null,
        savePath: args.savePath || null,
      },
    };
  }

  private _clipboardAction(args: Record<string, unknown>): DeviceCapabilityResult {
    const action = String(args.action || "read").toLowerCase();
    return {
      success: true,
      message: action === "read" ? "Reading clipboard." : `Clipboard: ${action}`,
      payload: { action: "CLIPBOARD_" + action.toUpperCase(), ...args },
    };
  }

  private _codeInspect(args: Record<string, unknown>): DeviceCapabilityResult {
    const filePath = String(args.filePath || args.path || args.file || "");
    return {
      success: true,
      message: filePath ? `Inspecting code: ${filePath}` : "Starting code inspection.",
      payload: { action: "CODE_INSPECT", filePath: filePath || null, ...args },
    };
  }

  private _youtubeSearch(args: Record<string, unknown>): DeviceCapabilityResult {
    const query = String(args.query || args.q || "");
    if (!query) {
      return {
        success: false,
        message: "Please specify what to search on YouTube.",
        errorCode: "MISSING_ARG_QUERY",
      };
    }
    return {
      success: true,
      message: `Searching YouTube for "${query}"`,
      payload: { action: "YOUTUBE_SEARCH", query },
    };
  }

  private _youtubePlay(args: Record<string, unknown>): DeviceCapabilityResult {
    const videoId = String(args.videoId || args.id || "");
    const action = String(args.action || "play");
    return {
      success: true,
      message: videoId ? `YouTube: ${action} video ${videoId}` : `YouTube: ${action}`,
      payload: { action: "YOUTUBE_PLAY", videoId: videoId || null, playAction: action },
    };
  }

  private _browserOpenUrl(args: Record<string, unknown>): DeviceCapabilityResult {
    const url = String(args.url || args.link || "");
    if (!url) {
      return {
        success: false,
        message: "Please specify the URL to open.",
        errorCode: "MISSING_ARG_URL",
      };
    }
    return {
      success: true,
      message: `Opening ${url} in browser.`,
      payload: { action: "BROWSER_OPEN_URL", url },
    };
  }

  private _browserSearch(args: Record<string, unknown>): DeviceCapabilityResult {
    const query = String(args.query || args.q || "");
    if (!query) {
      return {
        success: false,
        message: "Please specify what to search.",
        errorCode: "MISSING_ARG_QUERY",
      };
    }
    return {
      success: true,
      message: `Searching for "${query}"`,
      payload: { action: "BROWSER_SEARCH", query },
    };
  }

  resetForTesting(): void {
    // No mutable state to reset in this engine
  }
}

export const desktopCapabilityEngine = new DesktopCapabilityEngine();
