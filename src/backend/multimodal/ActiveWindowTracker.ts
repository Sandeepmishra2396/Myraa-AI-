/**
 * MYRAA — ActiveWindowTracker (Phase 8)
 *
 * Tracks the active foreground window, application process, and focus transition history:
 *   - Probes active window via desktop agent or native OS fallback
 *   - Categorizes foreground application (code_editor, terminal, browser, sensitive)
 *   - Fail-closed: Sets isUncertain = true on detection failure/ambiguity to shield privacy
 *   - Tracks window focus transition history (max 20 entries) with focus durations
 */

import {
  ActiveWindowInfo,
  WindowHistoryEntry,
  WindowCategory,
  SENSITIVE_APP_PATTERNS,
} from "./MultimodalTypes.ts";
import { callDesktopAgent } from "../tasks/TaskManager.ts";

export class ActiveWindowTracker {
  private _currentWindow: ActiveWindowInfo | null = null;
  private _history: WindowHistoryEntry[] = [];
  private readonly MAX_HISTORY_ENTRIES = 20;

  // ---------------------------------------------------------------------------
  // Classification
  // ---------------------------------------------------------------------------

  /**
   * Classify an application window into a semantic category based on its
   * executable name and window title.
   */
  classifyWindowCategory(processName: string, title: string): WindowCategory {
    const combined = `${processName} ${title}`.toLowerCase();

    // Sensitive check first — strict privacy protection
    for (const pattern of SENSITIVE_APP_PATTERNS) {
      if (pattern.test(combined)) {
        return "sensitive";
      }
    }

    // Code editors & IDEs
    if (
      /\b(code|cursor|idea64?|devenv|pycharm(64)?|webstorm(64)?|sublime_text|notepad\+\+|atom|vim|nvim)\b/i.test(processName) ||
      /visual studio code|sublime text|jetbrains|cursor/i.test(title)
    ) {
      return "code_editor";
    }

    // Terminals & Command prompts
    if (
      /\b(powershell|pwsh|cmd|wt|windowsterminal|bash|zsh|git-bash|mintty|conhost)\b/i.test(processName) ||
      /powershell|command prompt|terminal|ming\w+/i.test(title)
    ) {
      return "terminal";
    }

    // Web Browsers
    if (
      /\b(chrome|msedge|firefox|brave|opera|vivaldi|safari|arc)\b/i.test(processName) ||
      /google chrome|microsoft edge|mozilla firefox/i.test(title)
    ) {
      return "browser";
    }

    // Communication & Chat
    if (
      /\b(slack|teams|discord|telegram|whatsapp|signal|zoom)\b/i.test(processName) ||
      /slack|discord|microsoft teams/i.test(title)
    ) {
      return "chat";
    }

    // System utilities & shells
    if (
      /\b(explorer|taskmgr|systemsettings|mmc|regedit)\b/i.test(processName) ||
      /file explorer|task manager|settings/i.test(title)
    ) {
      return "system";
    }

    return "unknown";
  }

  // ---------------------------------------------------------------------------
  // Foreground Window Inspection
  // ---------------------------------------------------------------------------

  /**
   * Probes the current active foreground window.
   * If detection fails or is uncertain, marks isUncertain = true and
   * category = "sensitive" to FAIL CLOSED.
   */
  async getActiveWindow(): Promise<ActiveWindowInfo> {
    const now = Date.now();

    try {
      // 1. Probe via desktop agent (fastest in-process Python win32gui hook)
      const agentRes = await callDesktopAgent("readScreen", { max_chars: 100 });
      const resAny = agentRes as any;
      const rawTitle = resAny?.active_window || resAny?.result?.active_window;
      if (rawTitle && typeof rawTitle === "string" && rawTitle.trim()) {
        const title = rawTitle.trim();
        const processName = this._inferProcessNameFromTitle(title);
        const category = this.classifyWindowCategory(processName, title);

        const info: ActiveWindowInfo = {
          title,
          processName,
          category,
          isUncertain: false,
          timestamp: now,
        };

        this._recordFocus(info);
        return info;
      }
    } catch {
      // Desktop agent probe failed; fallback to PowerShell
    }

    // 2. Fallback: Quick native PowerShell active window title probe
    try {
      const psInfo = await this._probeViaPowerShell();
      if (psInfo && psInfo.title) {
        const category = this.classifyWindowCategory(psInfo.processName, psInfo.title);
        const info: ActiveWindowInfo = {
          title: psInfo.title,
          processName: psInfo.processName,
          category,
          isUncertain: false,
          timestamp: now,
        };
        this._recordFocus(info);
        return info;
      }
    } catch {
      // Fallback probe failed
    }

    // 3. FAIL CLOSED: If detection cannot be confirmed, return an uncertain record
    // that triggers the privacy shield.
    const failClosedInfo: ActiveWindowInfo = {
      title: "Unknown Window (Detection Unavailable)",
      processName: "unknown",
      category: "sensitive", // Mark sensitive to guarantee privacy fail-closed
      isUncertain: true,
      timestamp: now,
    };

    this._recordFocus(failClosedInfo);
    return failClosedInfo;
  }

  /**
   * Record a window focus event into the transition history buffer.
   */
  private _recordFocus(window: ActiveWindowInfo): void {
    const now = window.timestamp;

    if (this._currentWindow) {
      // If the window hasn't changed, do not create duplicate history entries
      if (
        this._currentWindow.title === window.title &&
        this._currentWindow.processName === window.processName
      ) {
        return;
      }

      // Close previous window history entry
      const startedAt = this._currentWindow.timestamp;
      const durationMs = Math.max(0, now - startedAt);
      this._history.push({
        window: this._currentWindow,
        startedAt,
        endedAt: now,
        durationMs,
      });

      // Maintain max history bounds
      if (this._history.length > this.MAX_HISTORY_ENTRIES) {
        this._history.splice(0, this._history.length - this.MAX_HISTORY_ENTRIES);
      }
    }

    this._currentWindow = window;
  }

  /** Retrieve the window transition history trail. */
  getWindowHistory(): WindowHistoryEntry[] {
    return [...this._history];
  }

  /** Alias for getWindowHistory. */
  getHistory(): WindowHistoryEntry[] {
    return this.getWindowHistory();
  }

  /** Return the most recent detected window without running a new probe. */
  getLastKnownWindow(): ActiveWindowInfo | null {
    return this._currentWindow ? { ...this._currentWindow } : null;
  }

  /** Clear all recorded history (for test isolation). */
  clear(): void {
    this._currentWindow = null;
    this._history = [];
  }

  // ---------------------------------------------------------------------------
  // Internal Helpers
  // ---------------------------------------------------------------------------

  private _inferProcessNameFromTitle(title: string): string {
    const t = title.toLowerCase();
    if (t.includes("visual studio code") || t.includes("code")) return "Code.exe";
    if (t.includes("google chrome") || t.includes("chrome")) return "chrome.exe";
    if (t.includes("microsoft edge") || t.includes("edge")) return "msedge.exe";
    if (t.includes("firefox")) return "firefox.exe";
    if (t.includes("powershell") || t.includes("pwsh")) return "powershell.exe";
    if (t.includes("command prompt") || t.includes("cmd")) return "cmd.exe";
    if (t.includes("windows terminal")) return "wt.exe";
    if (t.includes("file explorer")) return "explorer.exe";
    return "unknown";
  }

  private async _probeViaPowerShell(): Promise<{ title: string; processName: string } | null> {
    const { exec } = await import("child_process");
    return new Promise((resolve) => {
      const cmd = `powershell -NoProfile -Command "Add-Type '@using System; using System.Runtime.InteropServices; public class Win { [DllImport(\\\"user32.dll\\\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\\\"user32.dll\\\")] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count); }'; $h = [Win]::GetForegroundWindow(); $b = New-Object System.Text.StringBuilder 256; [void][Win]::GetWindowText($h, $b, 256); $b.ToString()"`;
      exec(cmd, { timeout: 1500 }, (error, stdout) => {
        if (error || !stdout.trim()) {
          resolve(null);
          return;
        }
        const title = stdout.trim();
        resolve({ title, processName: "unknown" });
      });
    });
  }
}

export const activeWindowTracker = new ActiveWindowTracker();
