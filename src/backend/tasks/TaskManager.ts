/**
 * MYRAA — TaskManager
 *
 * Owns everything related to the Python desktop agent subprocess:
 *   • DESKTOP_TOOLS   — the authoritative set of tool names routed to Python
 *   • spawnDesktopAgent   — auto-starts the Python backend
 *   • isDesktopAgentAlive — health probe
 *   • ensureDesktopAgent  — lazy verification + auto-start on first use
 *   • callDesktopAgent    — dispatches a tool call to the running agent
 *
 * State is module-level (single instance per process) to exactly replicate
 * the original server.ts behaviour.
 */

import path from "path";
import { spawn, execSync } from "child_process";
import * as fs from "fs";

// Re-use the shared logger functions injected at startup.
// We accept them as function references so this module stays side-effect-free
// until wired up.
let _logCommand: (m: string) => void = () => {};
let _logStartup: (m: string) => void = () => {};
let _logError: (m: string) => void = () => {};
let _logJson: (
  level: "info" | "warn" | "error",
  event: string,
  data?: Record<string, unknown>,
) => void = () => {};

export function initTaskManagerLoggers(
  logCommand: (m: string) => void,
  logStartup: (m: string) => void,
  logError: (m: string) => void,
  logJson: (
    level: "info" | "warn" | "error",
    event: string,
    data?: Record<string, unknown>,
  ) => void,
): void {
  _logCommand = logCommand;
  _logStartup = logStartup;
  _logError = logError;
  _logJson = logJson;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
export const DESKTOP_AGENT_URL =
  process.env.DESKTOP_AGENT_URL || "http://127.0.0.1:8765";
export const DESKTOP_AGENT_TIMEOUT = 25_000; // ms

/**
 * The complete set of tool names routed to the Python desktop agent.
 * Kept in sync with desktop_agent/registry.py DESKTOP_TOOL_NAMES.
 */
export const DESKTOP_TOOLS: ReadonlySet<string> = new Set([
  // applications / websites / search
  "openApplication",
  "openInVsCode",
  "closeApplication",
  "openWebsite",
  "searchWeb",
  "searchYouTube",
  "searchGoogle",
  "searchGitHub",
  // files
  "createFile",
  "modifyFile",
  "readFile",
  "renameFile",
  "deleteFile",
  "moveFile",
  "openFolder",
  "openFile",
  "listFiles",
  "searchFiles",
  // pc control (volume + gated power)
  "volumeUp",
  "volumeDown",
  "muteToggle",
  "setVolume",
  "requestPowerAction",
  "executePowerAction",
  // windows
  "minimizeWindow",
  "maximizeWindow",
  "closeWindow",
  "switchApplication",
  // clipboard
  "copySelected",
  "pasteClipboard",
  "getClipboard",
  "clearClipboard",
  // screenshot / screen reading
  "takeScreenshot",
  "saveScreenshot",
  "analyzeScreenshot",
  "readScreen",
  // browser automation (Playwright — desktop-owned, separate from holographic UI)
  "desktopBrowserOpen",
  "desktopBrowserNavigate",
  "desktopBrowserOpenTab",
  "desktopBrowserCloseTab",
  "desktopBrowserSearch",
  "desktopBrowserClick",
  "desktopBrowserType",
  "desktopBrowserFillForm",
  "desktopBrowserGoBack",
  "desktopBrowserGoForward",
  "desktopBrowserScroll",
  // coding assistance
  "createPythonFile",
  "runPythonScript",
  "createProjectFolder",
  "writeCodeFile",
  "runShellCommand",
  // system information
  "systemInfo",
  "gpuInfo",
  "temperatureInfo",
  // brightness control (V2)
  "brightnessUp",
  "brightnessDown",
  "setBrightness",
  // Windows auto-start management (V2)
  "enableAutoStart",
  "disableAutoStart",
  "getAutoStartStatus",
]);

// ---------------------------------------------------------------------------
// Agent lifecycle state
// ---------------------------------------------------------------------------
let desktopAgentVerified = false;

/**
 * Auto-spawn the Python desktop agent as a detached child process if it is not
 * already listening. Looks for the project's bundled Python interpreter first,
 * falling back to `python` / `python3` on PATH. Runs detached so it survives
 * even if MYRAA's node process is killed.
 */
export function spawnDesktopAgent(): void {
  const agentEnv = {
    ...process.env,
    SORA_AGENT_HOST: "127.0.0.1",
    SORA_AGENT_PORT: "8765",
  };

  // Preferred path (packaged app): a PyInstaller-frozen agent exe that embeds
  // its own Python runtime. Set by the Electron main process via SORA_AGENT_EXE.
  const frozenExe = process.env.SORA_AGENT_EXE;
  if (frozenExe && fs.existsSync(frozenExe)) {
    try {
      const child = spawn(frozenExe, [], {
        cwd: path.dirname(frozenExe),
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: agentEnv,
      });
      child.unref();
      _logStartup(`AGENT_SPAWN frozen exe pid=${child.pid} path=${frozenExe}`);
      console.log(`[Desktop Agent] Launched frozen agent (PID ${child.pid}).`);
      return;
    } catch (e: any) {
      _logError(`AGENT_SPAWN_FROZEN_FAILED: ${e?.message || e}`);
      // fall through to the Python path below
    }
  }

  // Development fallback: run the agent from source using a local Python.
  const localAppData = process.env.LOCALAPPDATA || "";
  const candidates = [
    process.env.SORA_PYTHON,
    path.join(localAppData, "Programs", "Python", "Python314", "python.exe"),
    path.join(localAppData, "Programs", "Python", "Python311", "python.exe"),
    "C:\\Users\\SANDEEP\\AppData\\Local\\Programs\\Python\\Python314\\python.exe",
    "C:\\Users\\MSI\\AppData\\Local\\Programs\\Python\\Python311\\python.exe",
    "python",
    "python3",
  ].filter(Boolean) as string[];
  const py = candidates.find((p) => {
    try {
      execSync(`"${p}" --version`, { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  });
  if (!py) {
    console.warn(
      "[Desktop Agent] No frozen agent and no Python interpreter found; desktop control unavailable.",
    );
    _logError(
      "AGENT_SPAWN_NO_RUNTIME: neither SORA_AGENT_EXE nor Python available",
    );
    return;
  }
  try {
    const child = spawn(
      py,
      [
        "-m",
        "uvicorn",
        "desktop_agent.main:app",
        "--host",
        "127.0.0.1",
        "--port",
        "8765",
      ],
      {
        cwd: process.cwd(),
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: agentEnv,
      },
    );
    child.unref();
    _logStartup(`AGENT_SPAWN python pid=${child.pid}`);
    console.log(
      `[Desktop Agent] Auto-spawned via Python (PID ${child.pid}).`,
    );
  } catch (e: any) {
    console.warn(`[Desktop Agent] Auto-spawn failed: ${e?.message || e}`);
    _logError(`AGENT_SPAWN_PYTHON_FAILED: ${e?.message || e}`);
  }
}

/**
 * Probe the desktop agent /health endpoint. Returns true if it responds 200.
 */
export async function isDesktopAgentAlive(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`${DESKTOP_AGENT_URL}/health`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Ensure the desktop agent is running. If not verified yet, probe health; if
 * down, auto-spawn and poll until it is ready (or timeout).
 */
export async function ensureDesktopAgent(): Promise<void> {
  if (await isDesktopAgentAlive()) {
    desktopAgentVerified = true;
    return;
  }
  console.log("[Desktop Agent] Not detected. Auto-starting...");
  spawnDesktopAgent();
  for (let i = 1; i <= 20; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await isDesktopAgentAlive()) {
      desktopAgentVerified = true;
      console.log(`[Desktop Agent] Online after ${i}s — ready.`);
      return;
    }
  }
  console.warn(
    "[Desktop Agent] Did not come online within 20s. Desktop control will be unavailable.",
  );
}

const activeControllers = new Set<AbortController>();

/** Abort all currently executing desktop tool requests immediately. */
export function abortAllDesktopExecutions(): void {
  for (const controller of activeControllers) {
    try { controller.abort(); } catch { /* ignore */ }
  }
  activeControllers.clear();
  console.log("[TaskManager] Aborted all active desktop agent executions.");
}

/**
 * Dispatch a tool call to the Python desktop agent.
 * Lazy-ensures the agent is running on the first call.
 */
export async function callDesktopAgent(
  tool: string,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const isCloud =
    (process.env.NODE_ENV === "production" || Boolean(process.env.RENDER)) &&
    process.env.SORA_LAUNCHED_BY !== "electron";
  if (isCloud) {
    // Cloud Render environment: localhost desktop agent does NOT exist on the container.
    // Cloud Render MUST NEVER directly access localhost.
    // Secure path: route exclusively to the authenticated Windows desktop companion.
    try {
      const { remoteSessionManager } = await import("../remote/RemoteSessionManager.ts");
      const desktopCompanion = remoteSessionManager.getActiveDesktopCompanion();
      if (!desktopCompanion) {
        const errorMsg = "Windows desktop companion is not currently connected. Please ensure MYRAA is running on your PC.";
        _logError(`AGENT_OFFLINE ${tool}: ${errorMsg}`);
        _logJson("error", "desktop_companion_offline", { tool, error: errorMsg });
        return { ok: false, error: errorMsg };
      }
      return await remoteSessionManager.executeOnDesktopCompanion(tool, args);
    } catch (routeErr: any) {
      const errorMsg = `Desktop companion routing failed: ${routeErr?.message || routeErr}`;
      _logError(`AGENT_ERROR ${tool}: ${errorMsg}`);
      return { ok: false, error: errorMsg };
    }
  }

  // Normalize common application aliases so both source and frozen PyInstaller desktop agents
  // resolve them identically (e.g., "file manager" -> "file explorer", "vs code" -> "vscode").
  let effectiveArgs = args;
  if (tool === "openApplication" && args && typeof args === "object") {
    const rawKey = String(args.name ?? args.app ?? args.application ?? "").trim().toLowerCase();
    const aliasMap: Record<string, string> = {
      "file manager": "file explorer",
      "filemanager": "file explorer",
      "explorer": "file explorer",
      "files": "file explorer",
      "windows explorer": "file explorer",
      "vs code": "vscode",
      "visual studio code": "vscode",
      "code": "vscode",
    };
    if (aliasMap[rawKey]) {
      effectiveArgs = { ...args };
      if ("name" in effectiveArgs) effectiveArgs.name = aliasMap[rawKey];
      else if ("app" in effectiveArgs) effectiveArgs.app = aliasMap[rawKey];
      else if ("application" in effectiveArgs) effectiveArgs.application = aliasMap[rawKey];
      else effectiveArgs.name = aliasMap[rawKey];
    }
  }

  if (!desktopAgentVerified) {
    await ensureDesktopAgent();
  }
  const controller = new AbortController();
  activeControllers.add(controller);

  try {
    _logCommand(`EXECUTE ${tool} ${JSON.stringify(effectiveArgs)}`);
    _logJson("info", "tool_execute", { tool, args: effectiveArgs });
    const timer = setTimeout(
      () => controller.abort(),
      DESKTOP_AGENT_TIMEOUT,
    );

    const res = await fetch(`${DESKTOP_AGENT_URL}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool, args: effectiveArgs }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      _logError(`AGENT_HTTP_${res.status} ${tool}: ${text.substring(0, 200)}`);
      _logJson("error", "tool_error", {
        tool,
        http_status: res.status,
        error: text.substring(0, 200),
      });
      return {
        ok: false,
        error: `Desktop agent HTTP ${res.status}: ${text}`,
      };
    }
    const result = await res.json();
    _logJson("info", "tool_done", { tool, ok: result?.ok });
    return result;
  } catch (err: any) {
    desktopAgentVerified = false; // mark stale so next call retries the spawn

    // If local agent is unreachable on this server (e.g. Render Cloud), check for a connected Windows desktop companion
    try {
      const { remoteSessionManager } = await import("../remote/RemoteSessionManager.ts");
      const desktopCompanion = remoteSessionManager.getActiveDesktopCompanion();
      if (desktopCompanion) {
        console.log(
          `[TaskManager] Local agent unreachable on server. Forwarding desktop tool '${tool}' to connected Windows desktop companion (${desktopCompanion.session.deviceName})...`
        );
        return await remoteSessionManager.executeOnDesktopCompanion(tool, args);
      }
    } catch (_compErr) {
      /* ignore and return formatted error */
    }

    const isCloudFallback =
      (process.env.NODE_ENV === "production" || Boolean(process.env.RENDER)) &&
      process.env.SORA_LAUNCHED_BY !== "electron";
    const msg =
      err?.name === "AbortError"
        ? "Desktop agent timed out or aborted by emergency stop."
        : isCloudFallback
        ? "Windows desktop companion is not currently connected. Please ensure MYRAA is running on your PC."
        : "Desktop agent is not running. Start it with: uvicorn desktop_agent.main:app --port 8765";
    _logError(`AGENT_UNREACHABLE ${tool}: ${msg}`);
    _logJson("error", "tool_unreachable", { tool, error: msg });
    return { ok: false, error: msg };
  } finally {
    activeControllers.delete(controller);
  }
}
