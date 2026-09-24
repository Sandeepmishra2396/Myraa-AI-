/**
 * MYRAA — GeminiSessionFactory
 *
 * Creates and manages Gemini Live sessions.  Owns:
 *   • liveTools          — the 67-tool functionDeclarations array
 *   • createSession()    — connects to the Gemini Live API with full callbacks
 *
 * The factory is stateless per-instance; all mutable state (isRotating,
 * isClientClosed, session ref) lives in ConversationManager.
 *
 * Callback responsibilities (handled here, inside onmessage):
 *   • Audio forwarding to client
 *   • Interrupted / turnComplete signals
 *   • Transcription lines (model + user)
 *   • toolCall routing → ToolOrchestrator
 *   • GoAway detection → sets isRotating = true then closes session
 *   • onopen / onerror / onclose — status/error messages to client
 */

import { GoogleGenAI, Modality, Type, LiveServerMessage, EndSensitivity } from "@google/genai";
import { loadMemories, processConversationSlice } from "../../../server_memory.ts";
import { extractAndApply } from "../memory/MemoryExtractor.ts";
import { memoryStore } from "../memory/MemoryStore.ts";
import { buildSystemInstructions, buildCompleteSystemInstructions } from "../projects/ContextManager.ts";
import { ToolOrchestrator } from "../tools/ToolOrchestrator.ts";
import type { SecurityContext } from "../security/index.ts";


// Logger placeholders — injected at startup via initGeminiLoggers()
let _logStartup: (m: string) => void = () => {};
let _logError: (m: string) => void = () => {};
let _logJson: (
  level: "info" | "warn" | "error",
  event: string,
  data?: Record<string, unknown>,
) => void = () => {};

export function initGeminiLoggers(
  logStartup: (m: string) => void,
  logError: (m: string) => void,
  logJson: (
    level: "info" | "warn" | "error",
    event: string,
    data?: Record<string, unknown>,
  ) => void,
): void {
  _logStartup = logStartup;
  _logError = logError;
  _logJson = logJson;
}

// ---------------------------------------------------------------------------
// Gemini Live tool declarations (67 total, verbatim from server.ts)
// ---------------------------------------------------------------------------
export const LIVE_TOOLS = [
  {
    functionDeclarations: [
      {
        name: "browserOpen",
        description:
          "Opens a designated website URL or interface tab inside Myraa's web agent console.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            url: {
              type: Type.STRING,
              description:
                "The destination website address or path, e.g. youtube.com, google.com, instagram.com, wikipedia.org.",
            },
          },
          required: ["url"],
        },
      },
      {
        name: "browserSearch",
        description:
          "Enters a query search term inside the active website's search box (Google Search or YouTube Search).",
        parameters: {
          type: Type.OBJECT,
          properties: {
            query: {
              type: Type.STRING,
              description: "The text query term to search for.",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "browserClick",
        description:
          "Traces computer cursor and clicks on a target button, link, or video cell ID inside the active webpage viewport.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            selector: {
              type: Type.STRING,
              description:
                "The selector target ID, e.g. 'video-mWRsgZjdfQI' for a video, 'search-result-0' for Google link index, or 'play-button', 'pause-button'.",
            },
            description: {
              type: Type.STRING,
              description:
                "A short, friendly label description of the item being clicked, e.g. 'Imagine Dragons - Believer video element'.",
            },
          },
          required: ["selector"],
        },
      },
      {
        name: "browserMediaControl",
        description:
          "Controls ongoing video/audio stream media properties on YouTube, like play, pause, volume, mute, skip, and fullscreen.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            action: {
              type: Type.STRING,
              description: "The media controller command operation.",
              enum: [
                "play",
                "pause",
                "volume",
                "fullscreen",
                "exit_fullscreen",
                "mute",
                "unmute",
                "skip",
              ],
            },
            value: {
              type: Type.INTEGER,
              description:
                "The value parameter; only relevant for set volume level, e.g. 50 for fifty percent.",
            },
          },
          required: ["action"],
        },
      },
      {
        name: "browserScroll",
        description:
          "Scrolls the currently active webpage vertically up or down.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            direction: {
              type: Type.STRING,
              description: "The scroll vector movement.",
              enum: ["up", "down"],
            },
            amount: {
              type: Type.INTEGER,
              description:
                "The distance height parameter in pixels (defaults to 300).",
            },
          },
        },
      },
      {
        name: "browserType",
        description:
          "Enters typed letters/commands inside the active input container.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            text: {
              type: Type.STRING,
              description: "The exact letters to type in.",
            },
          },
          required: ["text"],
        },
      },
      {
        name: "browserGoBack",
        description:
          "Navigates back to the previous webpage inside the current tab memory history.",
        parameters: {
          type: Type.OBJECT,
          properties: {},
        },
      },
      {
        name: "browserTabAction",
        description:
          "Performs standard browser-tab actions: open new tab, close a tab, or switch index values.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            action: {
              type: Type.STRING,
              description: "Tab action instruction.",
              enum: ["new", "close", "switch"],
            },
            tabId: {
              type: Type.STRING,
              description: "The tab identifier string if closing or switching.",
            },
            url: {
              type: Type.STRING,
              description: "The initial starting URL if creating a new tab.",
            },
          },
          required: ["action"],
        },
      },
      {
        name: "changeBackground",
        description:
          "Changes the visual theme or atmospheric glow color of Myraa's interface.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            color: {
              type: Type.STRING,
              description:
                "The theme color name (violet, crimson, emerald, celestial, gold, rose, charcoal)",
            },
          },
          required: ["color"],
        },
      },
      {
        name: "saveCustomMemory",
        description:
          "Allows Myraa to immediately save a piece of critical user information to her persistent memory core.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            category: {
              type: Type.STRING,
              description: "The memory category.",
              enum: [
                "identity",
                "preference",
                "skill",
                "goal",
                "project",
                "task",
                "decision",
                "relationship",
                "emotional",
                "behavior",
                "fact",
              ],
            },
            text: {
              type: Type.STRING,
              description: "Precise third-person statement.",
            },
          },
          required: ["category", "text"],
        },
      },


      // ======== DESKTOP CONTROL TOOLS (routed to Python agent) ========
      {
        name: "runShellCommand",
        description:
          "Execute a PowerShell or CMD command on the user's Windows PC and return the output. Use this to fix system errors, run scripts, set ExecutionPolicy, run npm/git/pip commands, check system status, etc. Default shell is PowerShell. Always runs with -ExecutionPolicy Bypass so execution policy errors are automatically handled.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            command: {
              type: Type.STRING,
              description:
                "The shell command to run, e.g. 'Set-ExecutionPolicy RemoteSigned -Scope CurrentUser -Force', 'npm install', 'git status', 'Get-Process node'.",
            },
            shell: {
              type: Type.STRING,
              description:
                "Shell to use: 'powershell' (default) or 'cmd'.",
            },
            cwd: {
              type: Type.STRING,
              description:
                "Working directory for the command. Defaults to the Myraa project root.",
            },
            timeout: {
              type: Type.NUMBER,
              description: "Timeout in seconds (default 30, max 120).",
            },
          },
          required: ["command"],
        },
      },
      {
        name: "openApplication",
        description:
          "Open a desktop application (e.g. VS Code, Notepad, Chrome, Cursor, Calculator, File Explorer, Task Manager, Settings, CMD, PowerShell). Can optionally open a specific file or folder in that application.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            name: {
              type: Type.STRING,
              description:
                "Application name, e.g. 'vscode', 'notepad', 'chrome', 'cursor'.",
            },
            path: {
              type: Type.STRING,
              description:
                "Optional file or project folder path to open with the application (e.g. 'D:/QYROX', 'server.ts').",
            },
          },
          required: ["name"],
        },
      },
      {
        name: "openInVsCode",
        description:
          "Open a file or project folder in Visual Studio Code (VS Code) on Windows.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            path: {
              type: Type.STRING,
              description:
                "Project folder or file path to open in VS Code (e.g. 'D:/QYROX', 'D:/SORA AI/Sora AI', 'server.ts'). Defaults to current workspace if omitted.",
            },
          },
        },
      },
      {
        name: "closeApplication",
        description: "Close a running desktop application by name.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            name: { type: Type.STRING, description: "Application name." },
            force: {
              type: Type.BOOLEAN,
              description: "Force close (default false).",
            },
          },
          required: ["name"],
        },
      },
      {
        name: "openWebsite",
        description:
          "Open a named website or URL in the user's default system browser. Supports shortcuts: youtube, gmail, google, github, chatgpt, etc.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            name: {
              type: Type.STRING,
              description:
                "Site name shortcut (e.g. 'youtube', 'gmail').",
            },
            url: {
              type: Type.STRING,
              description: "Full URL if no shortcut.",
            },
          },
        },
      },
      {
        name: "searchWeb",
        description:
          "Search a website engine (google, youtube, github, duckduckgo, bing) and open results in the default browser.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            query: { type: Type.STRING, description: "Search query." },
            engine: {
              type: Type.STRING,
              description: "Engine name (default 'google').",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "searchYouTube",
        description:
          "Search YouTube and open results in the default browser.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            query: { type: Type.STRING, description: "Search query." },
          },
          required: ["query"],
        },
      },
      {
        name: "searchGoogle",
        description:
          "Search Google and open results in the default browser.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            query: { type: Type.STRING, description: "Search query." },
          },
          required: ["query"],
        },
      },
      {
        name: "searchGitHub",
        description:
          "Search GitHub repositories and open results in the default browser.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            query: { type: Type.STRING, description: "Search query." },
          },
          required: ["query"],
        },
      },
      {
        name: "createFile",
        description:
          "Create a new text file with optional content. Scoped to safe folders (Desktop, Documents, Downloads, all drives C:, D:, E:, etc.).",
        parameters: {
          type: Type.OBJECT,
          properties: {
            path: { type: Type.STRING, description: "File path." },
            content: {
              type: Type.STRING,
              description: "File content (default empty).",
            },
            overwrite: {
              type: Type.BOOLEAN,
              description: "Overwrite if exists (default false).",
            },
          },
          required: ["path"],
        },
      },
      {
        name: "modifyFile",
        description:
          "Modify, edit, or update an existing file on disk. Supports overwrite, append, or target string replacement.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            path: {
              type: Type.STRING,
              description: "File path to modify or edit.",
            },
            content: {
              type: Type.STRING,
              description: "New content or code to write/append/replace.",
            },
            mode: {
              type: Type.STRING,
              description:
                "Modification mode: 'overwrite' (default), 'append', or 'replace'.",
            },
            target: {
              type: Type.STRING,
              description:
                "Target string to replace when mode is 'replace'.",
            },
            replacement: {
              type: Type.STRING,
              description:
                "Replacement string when mode is 'replace'.",
            },
          },
          required: ["path"],
        },
      },
      {
        name: "readFile",
        description: "Read the contents of a text file.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            path: { type: Type.STRING, description: "File path." },
            max_chars: {
              type: Type.INTEGER,
              description: "Max chars to return (default 8000).",
            },
          },
          required: ["path"],
        },
      },
      {
        name: "renameFile",
        description: "Rename a file.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            path: {
              type: Type.STRING,
              description: "Current file path.",
            },
            new_name: {
              type: Type.STRING,
              description: "New file name.",
            },
          },
          required: ["path", "new_name"],
        },
      },
      {
        name: "deleteFile",
        description:
          "Delete a file. Sends to Recycle Bin by default (safe). Use permanent=true for hard delete.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            path: { type: Type.STRING, description: "File path." },
            permanent: {
              type: Type.BOOLEAN,
              description: "Permanently delete (default false).",
            },
          },
          required: ["path"],
        },
      },
      {
        name: "moveFile",
        description: "Move a file to a new location.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            path: { type: Type.STRING, description: "Source file path." },
            destination: {
              type: Type.STRING,
              description: "Destination path or folder.",
            },
          },
          required: ["path", "destination"],
        },
      },
      {
        name: "openFolder",
        description:
          "Open a folder in File Explorer. Supports aliases (desktop, documents, downloads, pictures, music, videos, home, d drive, c drive), full paths (e.g. 'D:/QYROX', 'D:/', 'C:/Users'), or folder names (e.g. 'QYROX').",
        parameters: {
          type: Type.OBJECT,
          properties: {
            path: {
              type: Type.STRING,
              description: "Full folder or drive path (e.g. 'D:/QYROX', 'D:/').",
            },
            name: {
              type: Type.STRING,
              description: "Folder name or alias (e.g. 'QYROX', 'd drive', 'desktop').",
            },
          },
        },
      },
      {
        name: "openFile",
        description:
          "Open any file with its default Windows application (e.g. text file, document, script, media).",
        parameters: {
          type: Type.OBJECT,
          properties: {
            path: {
              type: Type.STRING,
              description: "Path to the file to open (e.g. 'D:/QYROX/notes.txt', 'Desktop/notes.txt').",
            },
            name: {
              type: Type.STRING,
              description: "File name if path not fully known.",
            },
          },
        },
      },
      {
        name: "listFiles",
        description: "List files in a folder.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            name: {
              type: Type.STRING,
              description: "Folder name or alias.",
            },
            path: { type: Type.STRING, description: "Full path." },
            pattern: {
              type: Type.STRING,
              description: "Glob pattern (default '*').",
            },
          },
        },
      },
      {
        name: "searchFiles",
        description:
          "Search for files by name glob or extension under a folder.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            name: {
              type: Type.STRING,
              description: "Filename glob (e.g. '*.py').",
            },
            extension: {
              type: Type.STRING,
              description: "File extension (e.g. 'py').",
            },
            folder: {
              type: Type.STRING,
              description: "Folder to search (default home).",
            },
            limit: {
              type: Type.INTEGER,
              description: "Max results (default 100).",
            },
          },
        },
      },
      {
        name: "volumeUp",
        description: "Increase system volume.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            amount: {
              type: Type.NUMBER,
              description: "Step amount 0-1 (default 0.1).",
            },
          },
        },
      },
      {
        name: "volumeDown",
        description: "Decrease system volume.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            amount: {
              type: Type.NUMBER,
              description: "Step amount 0-1 (default 0.1).",
            },
          },
        },
      },
      {
        name: "setVolume",
        description: "Set system volume to a specific percentage.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            percent: {
              type: Type.NUMBER,
              description: "Volume percentage 0-100.",
            },
          },
          required: ["percent"],
        },
      },
      {
        name: "muteToggle",
        description: "Toggle mute/unmute on the system volume.",
        parameters: { type: Type.OBJECT, properties: {} },
      },
      {
        name: "requestPowerAction",
        description:
          "FIRST STEP for dangerous power actions. Generates a confirmation token. Tell the user verbally, then call executePowerAction with the token if they confirm. Actions: shutdown, restart, sleep, lock.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            action: {
              type: Type.STRING,
              description:
                "Power action: shutdown, restart, sleep, lock.",
            },
          },
          required: ["action"],
        },
      },
      {
        name: "executePowerAction",
        description:
          "SECOND STEP: execute a previously-confirmed power action. Requires a valid execute_token from requestPowerAction. Single-use, expires in 60 seconds.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            action: {
              type: Type.STRING,
              description: "The confirmed power action.",
            },
            execute_token: {
              type: Type.STRING,
              description:
                "Confirmation token from requestPowerAction.",
            },
          },
          required: ["action", "execute_token"],
        },
      },
      {
        name: "minimizeWindow",
        description:
          "Minimize the active window or a named window.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            title: {
              type: Type.STRING,
              description:
                "Window title to match (optional, defaults to active window).",
            },
          },
        },
      },
      {
        name: "maximizeWindow",
        description:
          "Maximize the active window or a named window.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            title: {
              type: Type.STRING,
              description: "Window title to match.",
            },
          },
        },
      },
      {
        name: "closeWindow",
        description: "Close the active window or a named window.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            title: {
              type: Type.STRING,
              description: "Window title to match.",
            },
          },
        },
      },
      {
        name: "switchApplication",
        description:
          "Switch to a named application window, or cycle Alt+Tab if no title given.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            title: {
              type: Type.STRING,
              description: "Window title to switch to.",
            },
          },
        },
      },
      {
        name: "copySelected",
        description:
          "Copy selected text: sends Ctrl+C and reads the clipboard.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            wait: {
              type: Type.NUMBER,
              description:
                "Seconds to wait after Ctrl+C (default 0.35).",
            },
          },
        },
      },
      {
        name: "pasteClipboard",
        description:
          "Paste text into the active input. Writes text to clipboard then sends Ctrl+V.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            text: {
              type: Type.STRING,
              description:
                "Text to paste. If omitted, pastes current clipboard.",
            },
          },
        },
      },
      {
        name: "getClipboard",
        description: "Read the current clipboard text content.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            max_chars: {
              type: Type.INTEGER,
              description: "Max chars (default 1000).",
            },
          },
        },
      },
      {
        name: "clearClipboard",
        description: "Empty the clipboard.",
        parameters: { type: Type.OBJECT, properties: {} },
      },
      {
        name: "takeScreenshot",
        description:
          "Capture the full screen. Optionally include base64 image data.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            include_image: {
              type: Type.BOOLEAN,
              description:
                "Include base64 JPEG image (default false).",
            },
            max_dim: {
              type: Type.INTEGER,
              description: "Max image dimension (default 1280).",
            },
          },
        },
      },
      {
        name: "saveScreenshot",
        description: "Save a screenshot to Pictures/SoraScreenshots.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            name: {
              type: Type.STRING,
              description: "Optional filename prefix.",
            },
          },
        },
      },
      {
        name: "analyzeScreenshot",
        description:
          "Take a screenshot and run OCR to extract visible text from the screen.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            max_chars: {
              type: Type.INTEGER,
              description: "Max OCR chars (default 1500).",
            },
          },
        },
      },
      {
        name: "readScreen",
        description:
          "OCR the active window and return its title plus visible text.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            max_chars: {
              type: Type.INTEGER,
              description: "Max OCR chars (default 1500).",
            },
          },
        },
      },
      {
        name: "desktopBrowserOpen",
        description:
          "Open a URL in the desktop Playwright automation browser (real Chromium, separate from holographic UI).",
        parameters: {
          type: Type.OBJECT,
          properties: {
            url: { type: Type.STRING, description: "URL to open." },
          },
          required: ["url"],
        },
      },
      {
        name: "desktopBrowserNavigate",
        description:
          "Navigate the active tab in the desktop automation browser to a new URL.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            url: {
              type: Type.STRING,
              description: "New URL to navigate to.",
            },
          },
          required: ["url"],
        },
      },
      {
        name: "desktopBrowserSearch",
        description:
          "Search within the desktop automation browser.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            query: {
              type: Type.STRING,
              description: "Search query.",
            },
            engine: {
              type: Type.STRING,
              description:
                "Engine: google, youtube, github, duckduckgo, bing.",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "desktopBrowserClick",
        description:
          "Click an element in the desktop automation browser by CSS selector or text.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            selector: {
              type: Type.STRING,
              description: "CSS selector.",
            },
            text: {
              type: Type.STRING,
              description: "Text to find and click.",
            },
          },
        },
      },
      {
        name: "desktopBrowserType",
        description:
          "Type text into the active element in the desktop automation browser.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            text: { type: Type.STRING, description: "Text to type." },
            selector: {
              type: Type.STRING,
              description: "Optional CSS selector for a specific input.",
            },
            clear: {
              type: Type.BOOLEAN,
              description: "Clear before typing (default true).",
            },
          },
          required: ["text"],
        },
      },
      {
        name: "desktopBrowserFillForm",
        description:
          "Fill multiple form fields and optionally submit in the desktop automation browser.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            fields: {
              type: Type.OBJECT,
              description: "Object of selector -> value pairs.",
            },
            submit: {
              type: Type.STRING,
              description: "Optional submit button selector.",
            },
          },
          required: ["fields"],
        },
      },
      {
        name: "desktopBrowserOpenTab",
        description:
          "Open a new tab in the desktop automation browser.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            url: {
              type: Type.STRING,
              description: "URL for the new tab.",
            },
          },
        },
      },
      {
        name: "desktopBrowserCloseTab",
        description:
          "Close the active tab in the desktop automation browser.",
        parameters: { type: Type.OBJECT, properties: {} },
      },
      {
        name: "desktopBrowserGoBack",
        description:
          "Navigate back in the desktop automation browser history.",
        parameters: { type: Type.OBJECT, properties: {} },
      },
      {
        name: "desktopBrowserGoForward",
        description:
          "Navigate forward in the desktop automation browser history.",
        parameters: { type: Type.OBJECT, properties: {} },
      },
      {
        name: "desktopBrowserScroll",
        description: "Scroll the desktop automation browser page.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            direction: {
              type: Type.STRING,
              description: "Scroll direction: up or down.",
            },
            amount: {
              type: Type.INTEGER,
              description: "Pixels to scroll (default 500).",
            },
          },
        },
      },
      {
        name: "createPythonFile",
        description: "Create a Python (.py) file with content.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            path: { type: Type.STRING, description: "File path." },
            content: {
              type: Type.STRING,
              description: "Python code content.",
            },
            overwrite: {
              type: Type.BOOLEAN,
              description: "Overwrite if exists.",
            },
          },
          required: ["path"],
        },
      },
      {
        name: "writeCodeFile",
        description:
          "Create a code file in any language with appropriate extension.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            path: { type: Type.STRING, description: "File path." },
            content: {
              type: Type.STRING,
              description: "Code content.",
            },
            language: {
              type: Type.STRING,
              description:
                "Language name (e.g. 'python', 'javascript', 'html').",
            },
            overwrite: {
              type: Type.BOOLEAN,
              description: "Overwrite if exists.",
            },
          },
          required: ["path"],
        },
      },
      {
        name: "createProjectFolder",
        description:
          "Create a project folder structure with optional subfolders and starter files.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            path: {
              type: Type.STRING,
              description: "Project root folder path.",
            },
            subfolders: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
              description: "List of subfolder names.",
            },
            scaffold_standard: {
              type: Type.BOOLEAN,
              description:
                "Create src, tests, docs subfolders.",
            },
            files: {
              type: Type.OBJECT,
              description:
                "Object of relative-path -> content for starter files.",
            },
          },
          required: ["path"],
        },
      },
      {
        name: "runPythonScript",
        description:
          "Execute a Python script and capture stdout, stderr, and exit code. Has a configurable timeout.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            path: { type: Type.STRING, description: "Script path." },
            args: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
              description: "Script arguments.",
            },
            timeout: {
              type: Type.INTEGER,
              description: "Timeout in seconds (default 30).",
            },
          },
          required: ["path"],
        },
      },
      {
        name: "systemInfo",
        description:
          "Get system resource usage: CPU %, RAM %, disk usage, uptime, OS info.",
        parameters: { type: Type.OBJECT, properties: {} },
      },
      {
        name: "gpuInfo",
        description:
          "Get NVIDIA GPU stats: utilization %, VRAM usage, temperature. Graceful fallback if no NVIDIA GPU.",
        parameters: { type: Type.OBJECT, properties: {} },
      },
      {
        name: "temperatureInfo",
        description:
          "Get available temperature readings (CPU, GPU, etc.). Best-effort on Windows.",
        parameters: { type: Type.OBJECT, properties: {} },
      },
      {
        name: "brightnessUp",
        description:
          "Increase screen brightness by a step (default 10%). Use when user says 'increase brightness' or 'make screen brighter'.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            amount: {
              type: Type.NUMBER,
              description: "Percentage to increase (default 10).",
            },
          },
        },
      },
      {
        name: "brightnessDown",
        description:
          "Decrease screen brightness by a step (default 10%). Use when user says 'decrease brightness' or 'dim screen'.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            amount: {
              type: Type.NUMBER,
              description: "Percentage to decrease (default 10).",
            },
          },
        },
      },
      {
        name: "setBrightness",
        description:
          "Set screen brightness to an exact level. Use when user says 'set brightness to 50%' or 'brightness 80'.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            percent: {
              type: Type.NUMBER,
              description: "Target brightness 0-100.",
            },
          },
          required: ["percent"],
        },
      },
      {
        name: "enableAutoStart",
        description:
          "Enable MYRAA to launch automatically when Windows starts. Creates a silent startup entry.",
        parameters: { type: Type.OBJECT, properties: {} },
      },
      {
        name: "disableAutoStart",
        description:
          "Disable MYRAA auto-start on Windows login. Removes the startup entry.",
        parameters: { type: Type.OBJECT, properties: {} },
      },
      {
        name: "getAutoStartStatus",
        description:
          "Check whether MYRAA is currently configured to auto-start on Windows login.",
        parameters: { type: Type.OBJECT, properties: {} },
      },

      // ======== PROJECT INTELLIGENCE TOOLS (PHASE 3) ========
      {
        name: "analyzeProject",
        description:
          "Analyze the active coding workspace or project. Scans files, detects project type, frameworks, git status, and builds the architectural map and summary.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            path: {
              type: Type.STRING,
              description:
                "Optional workspace root directory to analyze (defaults to active project directory).",
            },
          },
        },
      },
      {
        name: "getProjectArchitecture",
        description:
          "Retrieve the architecture map of the current project, including frontend/backend layers, key components, and entry points.",
        parameters: { type: Type.OBJECT, properties: {} },
      },
      {
        name: "searchProjectCode",
        description:
          "Search code, functions, symbols, or text within the current project files. Returns file locations, line numbers, and snippets.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            query: {
              type: Type.STRING,
              description: "Search query, keyword, or symbol name.",
            },
            filePattern: {
              type: Type.STRING,
              description:
                "Optional comma-separated file pattern or extensions, e.g. '*.ts,*.tsx' or 'py'.",
            },
            caseSensitive: {
              type: Type.BOOLEAN,
              description: "Whether to perform case-sensitive search (default false).",
            },
            maxResults: {
              type: Type.INTEGER,
              description: "Max results to return (default 20).",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "getProjectGitStatus",
        description:
          "Get the Git status of the current project: branch name, uncommitted changes, and recent commits.",
        parameters: { type: Type.OBJECT, properties: {} },
      },
      {
        name: "trackProjectTask",
        description:
          "Manage project tasks and resume last session context ('last time hum kaha tak aaye the?').",
        parameters: {
          type: Type.OBJECT,
          properties: {
            action: {
              type: Type.STRING,
              description:
                "Action to perform: 'list' tasks, 'add' a task, 'update' a task status, or 'resume' to recall last session progress.",
              enum: ["list", "add", "update", "resume"],
            },
            title: {
              type: Type.STRING,
              description: "Task title (required for 'add').",
            },
            description: {
              type: Type.STRING,
              description: "Optional task details or notes.",
            },
            status: {
              type: Type.STRING,
              description: "Task status for 'add' or 'update'.",
              enum: ["todo", "in_progress", "done", "blocked"],
            },
            taskId: {
              type: Type.STRING,
              description: "ID of task to update (required for 'update').",
            },
            sessionSummary: {
              type: Type.STRING,
              description: "Summary of progress for updating session resume context.",
            },
            nextSteps: {
              type: Type.STRING,
              description: "Planned next steps for resume context.",
            },
          },
          required: ["action"],
        },
      },

      // ======== RESEARCH & KNOWLEDGE ENGINE TOOLS (PHASE 4) ========
      {
        name: "researchWeb",
        description:
          "Perform live web research for latest technologies, architecture approaches, news, or libraries. Returns search results with verified citations.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            query: {
              type: Type.STRING,
              description: "The research query or topic to look up.",
            },
            maxResults: {
              type: Type.INTEGER,
              description: "Maximum results to retrieve (default 5, max 10).",
            },
            fetchTopContent: {
              type: Type.BOOLEAN,
              description: "Whether to safely read and extract key excerpts from top result pages (default false).",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "fetchOfficialDocs",
        description:
          "Retrieve official authoritative documentation guides and reference pages for frameworks or languages (e.g. React, Next.js, Node.js, TypeScript, Python, Vite, Express, Tailwind, MDN) with exact source links.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            technology: {
              type: Type.STRING,
              description: "The technology, framework, or library name.",
            },
            topic: {
              type: Type.STRING,
              description: "Specific topic, feature, or function to look up in the docs.",
            },
          },
          required: ["technology"],
        },
      },
      {
        name: "readUrl",
        description:
          "Safely read and extract clean text content and headings from a public web page or documentation URL.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            url: {
              type: Type.STRING,
              description: "The public HTTP or HTTPS web URL to fetch and read.",
            },
          },
          required: ["url"],
        },
      },
      {
        name: "ingestKnowledge",
        description:
          "Ingest a local document (Markdown, PDF, Code, Text) or web URL into Myraa's vector knowledge base with semantic chunking and embeddings.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            source: {
              type: Type.STRING,
              description: "File path relative to workspace/safe folder, or a public web URL.",
            },
            tags: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
              description: "Optional category or technology tags to attach to the document.",
            },
          },
          required: ["source"],
        },
      },
      {
        name: "queryKnowledgeBase",
        description:
          "Perform semantic vector search across all ingested project documents, manuals, and cached research. Returns the most relevant excerpts and source citations.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            query: {
              type: Type.STRING,
              description: "The search query or concept to locate in the knowledge base.",
            },
            limit: {
              type: Type.INTEGER,
              description: "Maximum number of relevant excerpts to return (default 5).",
            },
            tags: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
              description: "Optional filter to restrict search to specific tags.",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "checkFreshness",
        description:
          "Check the age, freshness status (fresh/recent/stale), and staleness rating of stored knowledge or ingested documentation.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            topic: {
              type: Type.STRING,
              description: "Topic, document title, or document ID to evaluate.",
            },
          },
          required: ["topic"],
        },
      },

      // ======== AGENT PLANNER + TASK EXECUTION TOOLS (PHASE 5) ========
      {
        name: "planTask",
        description:
          "Parse a multi-step user goal and create a structured execution plan with 8 canonical phases: " +
          "Understand → Inspect → Plan → Checkpoint → Modify → Test → Verify → Report. " +
          "Use this whenever Sandeep asks Myraa to perform a multi-step task on the project, " +
          "e.g. 'Myraa, mere project ka README update karo', 'auth module refactor karo', 'tests likhdo'.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            goal: {
              type: Type.STRING,
              description:
                "The natural language goal or task description from the user, e.g. 'Update README.md with architecture overview'.",
            },
          },
          required: ["goal"],
        },
      },
      {
        name: "executeTaskPlan",
        description:
          "Begin or continue executing a task plan. Runs step-by-step through the plan, " +
          "pausing at confirmation checkpoints before any file-modifying or destructive action. " +
          "Returns the current plan status and active step information.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            planId: {
              type: Type.STRING,
              description: "The ID of the task plan to execute (returned by planTask).",
            },
          },
          required: ["planId"],
        },
      },
      {
        name: "pauseTaskPlan",
        description:
          "Pause an actively running task plan. The plan can be resumed later with resumeTaskPlan. " +
          "Use this when Sandeep wants to stop a running task temporarily.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            planId: {
              type: Type.STRING,
              description: "The ID of the task plan to pause.",
            },
          },
          required: ["planId"],
        },
      },
      {
        name: "resumeTaskPlan",
        description:
          "Resume a paused task plan from where it left off. " +
          "NOTE: Plans that are waiting for a confirmation checkpoint cannot be resumed this way — " +
          "use confirmCheckpoint instead.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            planId: {
              type: Type.STRING,
              description: "The ID of the paused task plan to resume.",
            },
          },
          required: ["planId"],
        },
      },
      {
        name: "confirmCheckpoint",
        description:
          "Approve or reject a pending confirmation checkpoint for a destructive or file-modifying step. " +
          "Myraa will always ask Sandeep for confirmation before overwriting files, running scripts, or other side-effect actions. " +
          "Call this with approved=true to allow the step, or approved=false to cancel it.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            planId: {
              type: Type.STRING,
              description: "The ID of the task plan that has a pending checkpoint.",
            },
            checkpointId: {
              type: Type.STRING,
              description: "The checkpoint token ID to approve or reject (provided in the checkpoint event).",
            },
            approved: {
              type: Type.BOOLEAN,
              description: "true to approve and proceed with the action, false to reject and cancel.",
            },
            userFeedback: {
              type: Type.STRING,
              description: "Optional feedback or instruction from the user (e.g. 'Yes, proceed' or 'No, skip this step').",
            },
          },
          required: ["planId", "checkpointId", "approved"],
        },
      },
      {
        name: "getTaskPlanStatus",
        description:
          "Get the current status, active step, execution log, and verification results of a task plan. " +
          "Use this to check on the progress of a running or paused plan.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            planId: {
              type: Type.STRING,
              description: "The ID of the task plan to inspect.",
            },
          },
          required: ["planId"],
        },
      },
      // ── Phase 6: Proactive Companion Tools ──────────────────────────────
      {
        name: "scheduleTask",
        description:
          "Schedule a proactive background monitoring task (e.g. periodically monitor build health, git status, deployment target, or wait for events). " +
          "Tasks run in the background with a minimum safe interval of 5 seconds and are strictly read-only by default.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            name: {
              type: Type.STRING,
              description: "Short descriptive name for the background task (e.g. 'Monitor build status', 'Watch git branch changes').",
            },
            type: {
              type: Type.STRING,
              description: "Type of task: 'build_monitor', 'git_monitor', 'deployment_monitor', 'event_waiter', or 'custom_poll'.",
            },
            intervalMs: {
              type: Type.NUMBER,
              description: "Interval in milliseconds for recurring checks (minimum 5000ms). Defaults to 15000ms.",
            },
            maxIterations: {
              type: Type.NUMBER,
              description: "Optional maximum number of iterations before automatically completing.",
            },
            targetUrl: {
              type: Type.STRING,
              description: "Target URL for deployment monitoring (must be an approved localhost or verified URL).",
            },
          },
          required: ["name", "type"],
        },
      },
      {
        name: "listBackgroundTasks",
        description:
          "List all proactive background tasks, their current execution status, iteration count, and last run timestamp.",
        parameters: {
          type: Type.OBJECT,
          properties: {},
        },
      },
      {
        name: "cancelBackgroundTask",
        description:
          "Cancel a scheduled or running background companion task by ID.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            taskId: {
              type: Type.STRING,
              description: "The unique ID of the background task to cancel.",
            },
          },
          required: ["taskId"],
        },
      },
      {
        name: "getCompanionNotifications",
        description:
          "Retrieve recent companion notifications, proactive project updates, and unread alerts.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            limit: {
              type: Type.NUMBER,
              description: "Maximum number of notifications to return (defaults to 10).",
            },
          },
        },
      },
      {
        name: "updateCompanionPreferences",
        description:
          "Update user preferences for the Proactive Companion, such as enabling/disabling voice notifications, setting quiet hours, or adjusting poll intervals.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            voiceNotificationsEnabled: {
              type: Type.BOOLEAN,
              description: "Enable or disable spoken voice announcements.",
            },
            soundEnabled: {
              type: Type.BOOLEAN,
              description: "Enable or disable UI chime sound alerts.",
            },
            quietHoursStart: {
              type: Type.STRING,
              description: "Start of quiet hours in 'HH:mm' format (e.g. '22:00'). Suppresses voice audio only.",
            },
            quietHoursEnd: {
              type: Type.STRING,
              description: "End of quiet hours in 'HH:mm' format (e.g. '08:00').",
            },
            quietHoursEnabled: {
              type: Type.BOOLEAN,
              description: "Toggle quiet hours on or off.",
            },
          },
        },
      },
      {
        name: "triggerProjectCheck",
        description:
          "Run an immediate proactive diagnostic check on the workspace: inspect build artifacts, check git status, or probe deployment health.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            type: {
              type: Type.STRING,
              description: "The diagnostic check type: 'build', 'git', or 'deployment'.",
            },
            targetUrl: {
              type: Type.STRING,
              description: "Target URL if checking deployment health (optional, defaults to local server).",
            },
          },
          required: ["type"],
        },
      },
      {
        name: "generateDevicePairCode",
        description:
          "Generates a temporary 6-digit PIN on the host to pair a new remote mobile companion device with Myraa.",
        parameters: {
          type: Type.OBJECT,
          properties: {},
        },
      },
      {
        name: "listRemoteDevices",
        description:
          "Lists all paired remote devices, their current connection status, last seen timestamp, and permission role.",
        parameters: {
          type: Type.OBJECT,
          properties: {},
        },
      },
      {
        name: "revokeRemoteDevice",
        description:
          "Revokes authorization for a paired remote device by its ID, immediately disconnecting any active remote sessions.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            deviceId: {
              type: Type.STRING,
              description: "The unique UUID of the remote device to revoke.",
            },
            reason: {
              type: Type.STRING,
              description: "Optional reason for revoking the device.",
            },
          },
          required: ["deviceId"],
        },
      },
      {
        name: "triggerEmergencyStop",
        description:
          "Immediately triggers the emergency killswitch: halts running agent plans, pauses background companion tasks, aborts in-flight desktop tool calls, and blocks new work until explicitly reset.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            reason: {
              type: Type.STRING,
              description: "Optional explanation for triggering the emergency stop.",
            },
          },
        },
      },
      // ── Phase 8 Multimodal Intelligence Tools ───────────────────────────
      {
        name: "captureScreenContext",
        description:
          "Captures the current on-screen visual context including active foreground application, window title, OCR text, and workspace UI classification.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            force: {
              type: Type.BOOLEAN,
              description: "Whether to force capture even if the continuous loop is paused.",
            },
          },
        },
      },
      {
        name: "analyzeVisualCode",
        description:
          "Analyzes code visible on screen or in an editor for syntax errors, red squiggles, compiler diagnostics, and potential bug fixes.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            language: {
              type: Type.STRING,
              description: "Optional programming language hint (e.g. TypeScript, Python, Go, Rust).",
            },
          },
        },
      },
      {
        name: "extractDocumentContent",
        description:
          "Parses, outlines, and extracts structured sections, code blocks, and action items from a workspace PDF, Markdown, or specification document.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            path: {
              type: Type.STRING,
              description: "Relative or absolute workspace path to the document file.",
            },
          },
          required: ["path"],
        },
      },
      {
        name: "getContextAwareSuggestions",
        description:
          "Retrieves proactive, context-aware next-step suggestions based on the fused real-time screen, compiler error, and project state.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            limit: {
              type: Type.INTEGER,
              description: "Maximum number of suggestions to return (default 5).",
            },
          },
        },
      },
      {
        name: "toggleContinuousScreenContext",
        description:
          "User-controlled toggle to start, pause, resume, or configure the continuous screen perception loop (disabled by default).",
        parameters: {
          type: Type.OBJECT,
          properties: {
            action: {
              type: Type.STRING,
              description: "One of: 'start', 'stop', 'pause', 'resume', 'status'.",
            },
            intervalMs: {
              type: Type.INTEGER,
              description: "Continuous capture interval in milliseconds (1000 - 10000).",
            },
          },
          required: ["action"],
        },
      },
      {
        name: "getActiveWindowContext",
        description:
          "Returns the active foreground window, application process name, window bounds, and recent window transition focus history.",
        parameters: {
          type: Type.OBJECT,
          properties: {},
        },
      },
      // ── Phase 9 AI Study Companion Tools (Stage 1) ───────────────────────
      {
        name: "loadStudyDocument",
        description:
          "Loads and parses a PDF or study document from the workspace into Myraa's AI Study Companion session.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            path: {
              type: Type.STRING,
              description: "Relative or absolute workspace path to the PDF or study document file.",
            },
          },
          required: ["path"],
        },
      },
      {
        name: "trackStudyPage",
        description:
          "Updates and tracks the currently viewed page number in the active study document so Myraa knows what the student is viewing.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            pageNumber: {
              type: Type.INTEGER,
              description: "Target page number to view (1-indexed).",
            },
            direction: {
              type: Type.STRING,
              description: "Optional navigation direction ('next', 'prev', or 'jump').",
            },
          },
        },
      },
      {
        name: "detectStudyQuestions",
        description:
          "Lists detected academic questions, MCQ options, and mapped solutions on the current or specified page.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            pageNumber: {
              type: Type.INTEGER,
              description: "Optional page number to inspect (defaults to currently viewed page).",
            },
          },
        },
      },
      {
        name: "analyzeStudyDiagram",
        description:
          "Analyzes diagrams, charts, schematics, or figures on the current page using visual and structural context.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            diagramId: {
              type: Type.STRING,
              description: "Optional diagram ID to explain.",
            },
            forceVisualCapture: {
              type: Type.BOOLEAN,
              description: "Whether to refresh on-screen visual frame for deeper analysis.",
            },
          },
        },
      },
      {
        name: "explainStudySection",
        description:
          "Provides a pedagogical line-by-line or section-by-section explanation of content on the active study page.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            mode: {
              type: Type.STRING,
              description: "'line' for line-by-line breakdown, 'section' for conceptual section overview.",
              enum: ["line", "section"],
            },
            lineNumber: {
              type: Type.INTEGER,
              description: "Line number to explain (used when mode is 'line').",
            },
            sectionId: {
              type: Type.STRING,
              description: "Optional section ID to explain (used when mode is 'section').",
            },
          },
          required: ["mode"],
        },
      },
      {
        name: "toggleTeachingMode",
        description:
          "Toggles or configures Myraa's interactive Voice Teaching Mode (step-by-step, socratic, or quick-review style).",
        parameters: {
          type: Type.OBJECT,
          properties: {
            enabled: {
              type: Type.BOOLEAN,
              description: "Whether voice teaching mode is active.",
            },
            style: {
              type: Type.STRING,
              description: "Teaching style: 'step_by_step', 'socratic', or 'quick_review'.",
              enum: ["step_by_step", "socratic", "quick_review"],
            },
          },
          required: ["enabled"],
        },
      },
      {
        name: "getStudySessionStatus",
        description:
          "Retrieves the active study session status, currently viewed page, focused question, and document details.",
        parameters: {
          type: Type.OBJECT,
          properties: {},
        },
      },
      // ── Phase 9: Stage 2 — Interactive Tutor Tools ───────────────────────
      {
        name: "setInteractiveTutorMode",
        description:
          "Configures or shifts between Interactive Tutor modes: 'exam' (timed, marks-based), 'viva' (verbal questions & evaluation), 'practice' (document-guided learning), 'revision' (drilling weak topics), or 'off'.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            mode: {
              type: Type.STRING,
              description: "Tutor mode to activate: 'exam', 'viva', 'practice', 'revision', or 'off'.",
              enum: ["exam", "viva", "practice", "revision", "off"],
            },
            timeLimitMinutes: {
              type: Type.INTEGER,
              description: "Exam time limit in minutes (e.g. 15).",
            },
            totalMarks: {
              type: Type.INTEGER,
              description: "Target total marks for exam mode.",
            },
            topic: {
              type: Type.STRING,
              description: "Optional focal topic for viva or revision mode.",
            },
          },
          required: ["mode"],
        },
      },
      {
        name: "submitStudentAnswer",
        description:
          "Submits a student's answer for evaluation in Exam, Viva, or Practice mode, returning marks, accuracy, constructive feedback, and weak-topic detection.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            questionId: {
              type: Type.STRING,
              description: "ID or number of the question being answered.",
            },
            studentAnswer: {
              type: Type.STRING,
              description: "The student's verbal or written answer.",
            },
            timeTakenSeconds: {
              type: Type.INTEGER,
              description: "Optional seconds taken to answer the question.",
            },
          },
          required: ["questionId", "studentAnswer"],
        },
      },
      {
        name: "getStudyProgress",
        description:
          "Retrieves the student's persistent study progress, questions attempted, accuracy rate, topics covered, and list of identified weak topics.",
        parameters: {
          type: Type.OBJECT,
          properties: {},
        },
      },
      {
        name: "startRevisionSession",
        description:
          "Generates a targeted revision drill focusing specifically on questions and topics where the student previously struggled.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            topic: {
              type: Type.STRING,
              description: "Optional specific topic to revise. If omitted, targets all identified weak topics.",
            },
          },
        },
      },
      {
        name: "navigateToStudyItem",
        description:
          "Safely navigates the active study document and supported PDF viewer to the exact page where a question, diagram, or page index is located.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            targetType: {
              type: Type.STRING,
              description: "Type of item to navigate to: 'question', 'diagram', or 'page'.",
              enum: ["question", "diagram", "page"],
            },
            targetId: {
              type: Type.STRING,
              description: "Question ID or diagram label to navigate to (required if targetType is 'question' or 'diagram').",
            },
            pageNumber: {
              type: Type.INTEGER,
              description: "Target page number (required if targetType is 'page').",
            },
          },
          required: ["targetType"],
        },
      },
      {
        name: "explainRelevantDiagram",
        description:
          "Locates and explains the diagram directly relevant to the current question, topic, or page, combining visual OCR with structural document metadata.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            questionId: {
              type: Type.STRING,
              description: "Optional question ID whose associated diagram should be explained.",
            },
            topic: {
              type: Type.STRING,
              description: "Optional topic keyword to locate relevant diagram.",
            },
            forceVisualCapture: {
              type: Type.BOOLEAN,
              description: "Whether to refresh on-screen visual frame for deeper analysis.",
            },
          },
        },
      },
      {
        name: "configureCourseProfile",
        description:
          "Configures or views the student's academic course profile, including degree/course name, current semester, target exam, and enrolled subjects.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            courseName: {
              type: Type.STRING,
              description: "Full name of the course or degree program (e.g. 'B.Tech Computer Science', 'Class 12 Science').",
            },
            currentSemester: {
              type: Type.STRING,
              description: "Current academic semester, grade, or term (e.g. 'Semester 4', 'Term 2').",
            },
            targetExam: {
              type: Type.STRING,
              description: "Target examination or goal (e.g. 'Final University Exam', 'GATE 2027').",
            },
            targetExamDate: {
              type: Type.STRING,
              description: "Target exam date formatted as YYYY-MM-DD.",
            },
            subjects: {
              type: Type.ARRAY,
              description: "List of enrolled course subjects.",
              items: {
                type: Type.OBJECT,
                properties: {
                  id: { type: Type.STRING, description: "Unique subject ID" },
                  name: { type: Type.STRING, description: "Subject title" },
                  code: { type: Type.STRING, description: "Optional subject code" },
                  credits: { type: Type.INTEGER, description: "Optional credit weight" },
                },
                required: ["name"],
              },
            },
          },
        },
      },
      {
        name: "manageSyllabus",
        description:
          "Maps, inspects, or updates syllabus chapters and topics for a specific course subject, including topic completion status.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            action: {
              type: Type.STRING,
              description: "Action to perform: 'map' (set syllabus chapters), 'update_status' (change topic status), or 'get' (retrieve syllabus).",
            },
            subjectId: {
              type: Type.STRING,
              description: "Subject ID to manage.",
            },
            subjectName: {
              type: Type.STRING,
              description: "Subject name (used when mapping new syllabus).",
            },
            chapters: {
              type: Type.ARRAY,
              description: "Array of syllabus chapters with topics (for 'map' action).",
              items: {
                type: Type.OBJECT,
                properties: {
                  chapterNumber: { type: Type.INTEGER },
                  title: { type: Type.STRING },
                  topics: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        id: { type: Type.STRING },
                        title: { type: Type.STRING },
                        status: { type: Type.STRING },
                        estimatedHours: { type: Type.NUMBER },
                        weightage: { type: Type.INTEGER },
                      },
                      required: ["title"],
                    },
                  },
                },
                required: ["title"],
              },
            },
            topicId: {
              type: Type.STRING,
              description: "Topic ID when updating completion status.",
            },
            status: {
              type: Type.STRING,
              description: "Completion status: 'not_started', 'in_progress', or 'completed'.",
            },
          },
        },
      },
      {
        name: "researchStudyTopic",
        description:
          "Performs focused academic web research for study topics and concepts, returning citations and educational summaries fenced safely as untrusted content.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            topic: {
              type: Type.STRING,
              description: "The specific study concept, formula, theorem, or topic to research.",
            },
            subject: {
              type: Type.STRING,
              description: "Optional subject context (e.g. 'Physics', 'Computer Science').",
            },
            maxResults: {
              type: Type.INTEGER,
              description: "Maximum number of web resource citations to return (default 4).",
            },
          },
          required: ["topic"],
        },
      },
      {
        name: "discoverStudyVideos",
        description:
          "Finds educational YouTube video tutorials, animations, and lectures for study topics, returning structured links and video recommendations.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            topic: {
              type: Type.STRING,
              description: "The study topic or derivation to find video lectures for.",
            },
            subject: {
              type: Type.STRING,
              description: "Optional subject context.",
            },
            maxResults: {
              type: Type.INTEGER,
              description: "Maximum video recommendations to return (default 4).",
            },
          },
          required: ["topic"],
        },
      },
      {
        name: "analyzePreviousQuestions",
        description:
          "Analyzes uploaded previous exam papers or questions to identify high-yield topics, recurring patterns, and mark weightage distributions.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            paperTitle: {
              type: Type.STRING,
              description: "Optional title or label for the previous question paper.",
            },
            rawText: {
              type: Type.STRING,
              description: "Optional raw text of the question paper. If omitted, uses the currently active study document.",
            },
          },
        },
      },
      {
        name: "generatePersonalizedStudyPlan",
        description:
          "Generates or retrieves an adaptive, milestone-based study plan prioritizing weak topics and uncompleted syllabus chapters.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            dailyHours: {
              type: Type.NUMBER,
              description: "Daily hours available for studying (default 3).",
            },
            targetExamDate: {
              type: Type.STRING,
              description: "Optional target exam date formatted as YYYY-MM-DD.",
            },
            planName: {
              type: Type.STRING,
              description: "Optional custom name for the study plan.",
            },
          },
        },
      },
      {
        name: "getStudyRecommendations",
        description:
          "Provides actionable remedial study recommendations for identified weak topics, including review steps, textbook references, and search prompts.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            topic: {
              type: Type.STRING,
              description: "Optional topic filter. If omitted, generates recommendations for all active weak topics.",
            },
          },
        },
      },
      {
        name: "manageDailyStudySession",
        description:
          "Generates, updates, or completes the daily study session targets and logs study time for today.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            action: {
              type: Type.STRING,
              description: "Action: 'get' (retrieve today's session), 'create' (generate today's session), 'update_target' (toggle target completed), or 'complete' (finish session).",
            },
            targetId: {
              type: Type.STRING,
              description: "Target ID when updating completion status.",
            },
            completed: {
              type: Type.BOOLEAN,
              description: "Whether target was completed (for 'update_target').",
            },
            notes: {
              type: Type.STRING,
              description: "Optional student reflection or notes when completing session.",
            },
            date: {
              type: Type.STRING,
              description: "Optional session date (YYYY-MM-DD, defaults to today).",
            },
          },
        },
      },
      {
        name: "getAcademicProgress",
        description:
          "Calculates comprehensive long-term academic progress, syllabus completion percentage, accuracy trends, and deterministic exam readiness score.",
        parameters: {
          type: Type.OBJECT,
          properties: {},
        },
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Session factory types
// ---------------------------------------------------------------------------

export interface SessionOptions {
  apiKey: string;
  clientWs: any; // The raw ws.WebSocket connection for this client
  /** Mutable flags managed by ConversationManager */
  flags: {
    isRotating: boolean;
    isClientClosed: boolean;
  };
  /** Running dialogue history (mutated in-place by callbacks) */
  dialogueHistory: { role: string; text: string }[];
  /** Accumulated model text for the current turn */
  currentModelResponseRef: { text: string };
  /** Callback to signal that a new session should be created (GoAway rotation) */
  onRotate: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// GeminiSessionFactory
// ---------------------------------------------------------------------------

export class GeminiSessionFactory {
  private orchestrator = new ToolOrchestrator();

  /**
   * Open a new Gemini Live session with the full callback set.
   * Returns the live session object.
   */
  async createSession(opts: SessionOptions): Promise<any> {
    const {
      apiKey,
      clientWs,
      flags,
      dialogueHistory,
      currentModelResponseRef,
      onRotate,
    } = opts;

    const ai = new GoogleGenAI({ apiKey });
    let liveModel =
      process.env.GEMINI_LIVE_MODEL || "gemini-3.1-flash-live-preview";
    if (liveModel === "gemini-2.5-flash" || liveModel === "gemini-2.0-flash") {
      liveModel = "gemini-3.1-flash-live-preview";
    }

    // Fresh memories + project context card every session open
    const memories = await loadMemories();
    const instructions = await buildCompleteSystemInstructions(memories);


    const sendToClient = (payload: unknown) => {
      if (clientWs && clientWs.readyState === 1) {
        try {
          clientWs.send(
            typeof payload === "string"
              ? payload
              : JSON.stringify(payload),
          );
        } catch (e) {
          console.warn("[WS] Error sending to client:", e);
        }
      }
    };

    // session is assigned after connect() returns; the callbacks capture it
    // via a wrapper so they always see the latest reference.
    let sessionRef: any = null;

    const getSession = () => sessionRef;

    const session = await ai.live.connect({
      model: liveModel,
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } },
        },
        thinkingConfig: { thinkingBudget: 0 },
        realtimeInputConfig: {
          automaticActivityDetection: {
            endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_HIGH,
            silenceDurationMs: 400,
          },
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        systemInstruction: instructions,
        tools: LIVE_TOOLS,
      },
      callbacks: {
        onmessage: (message: LiveServerMessage) => {
          // Audio Stream Chunk — scan ALL parts (native audio model may use any index)
          const parts = message.serverContent?.modelTurn?.parts ?? [];
          let audioChunkCount = 0;
          for (const part of parts) {
            const audio = (part as any)?.inlineData?.data;
            if (audio) {
              audioChunkCount++;
              if (audioChunkCount === 1) {
                console.log(`[Gemini Live] Sending voice audio to client (${audio.length} chars)`);
              }
              sendToClient({ type: "audio", audio });
            }
          }

          // Interruption flag
          if (message.serverContent?.interrupted) {
            console.log("[Myraa Interrupted!]");
            sendToClient({ type: "interrupted" });
          }

          // Turn Complete
          if (message.serverContent?.turnComplete) {
            sendToClient({ type: "turnComplete" });

            if (currentModelResponseRef.text.trim()) {
              dialogueHistory.push({
                role: "model",
                text: currentModelResponseRef.text,
              });
              currentModelResponseRef.text = "";
            }

            // Fire asynchronous memory extraction + deduplication (Phase 2)
            if (dialogueHistory.length >= 2) {
              (async () => {
                try {
                  const updated = await extractAndApply(
                    apiKey,
                    dialogueHistory,
                    memoryStore,
                  );
                  if (updated) {
                    console.log(
                      "[Memory Sync] Sending refreshed memory list to client.",
                    );
                    sendToClient({ type: "memory_sync", memories: updated });
                  }
                } catch (err) {
                  console.error(
                    "[Memory Sync] Error running background consolidation:",
                    err,
                  );
                }
              })();
            }
          }

          // Spoken output transcription from Gemini Live API
          const outputTrans = (message.serverContent as any)?.outputTranscription?.text;
          if (outputTrans) {
            sendToClient({
              type: "transcription",
              role: "model",
              text: outputTrans,
            });
            currentModelResponseRef.text += outputTrans;
          }

          // User input transcription from Gemini Live API (transcribed user speech)
          const inputTrans = (message.serverContent as any)?.inputTranscription?.text;
          if (inputTrans) {
            sendToClient({
              type: "transcription",
              role: "user",
              text: inputTrans,
            });
            dialogueHistory.push({ role: "user", text: inputTrans });
          }

          // Fallback text part transcription (skip internal thinking parts)
          if (!outputTrans) {
            for (const part of parts) {
              if (part.text && !(part as any).thought) {
                sendToClient({
                  type: "transcription",
                  role: "model",
                  text: part.text,
                });
                currentModelResponseRef.text += part.text;
              }
            }
          }

          // User input transcription from userTurn
          const userTextOutput = (message.serverContent as any)?.userTurn
            ?.parts?.[0]?.text;
          if (userTextOutput && !inputTrans) {
            sendToClient({
              type: "transcription",
              role: "user",
              text: userTextOutput,
            });
            dialogueHistory.push({ role: "user", text: userTextOutput });
          }

          // Function Calls
          if (message.toolCall?.functionCalls) {
            const remoteDev = (clientWs as any)?.remoteDevice;
            const callerSecContext: SecurityContext | undefined = remoteDev
              ? {
                  identityId: remoteDev.id,
                  role: remoteDev.role || "standard",
                  deviceId: remoteDev.id,
                  ipAddress: remoteDev.lastIp || "127.0.0.1",
                  isLocal: false,
                }
              : undefined;

            for (const fc of message.toolCall.functionCalls) {
              this.orchestrator
                .dispatch(
                  {
                    name: fc.name!,
                    args: (fc.args ?? {}) as Record<string, unknown>,
                    id: fc.id,
                  },
                  getSession(),
                  sendToClient,
                  apiKey,
                  callerSecContext,
                )
                .catch((err) =>
                  console.error(`[ToolOrchestrator] Unhandled error:`, err),
                );
            }
          }

          // GoAway signal from Gemini Live
          if ((message as any).goAway) {
            console.log(
              "[Gemini Live] Received GoAway signal (session duration limit reached). Initiating graceful rotation...",
            );
            _logStartup(
              "GEMINI_LIVE_GOAWAY: session duration limit reached, rotating session",
            );
            _logJson("info", "gemini_live_goaway", { isRotating: true });
            flags.isRotating = true;
            try {
              getSession()?.close();
            } catch (_e) {}
          }
        },

        onopen: () => {
          console.log(
            `[Gemini Live] Session opened successfully (Model: ${liveModel})`,
          );
          _logStartup(`GEMINI_LIVE_CONNECTED: model=${liveModel}`);
          _logJson("info", "gemini_live_connected", { model: liveModel });
          sendToClient({ type: "status", status: "connected" });
        },

        onerror: (err: any) => {
          const msg = err?.message || String(err);
          console.error("[Gemini Live Error]:", msg);
          _logError(`GEMINI_LIVE_ERROR: ${msg}`);
          _logJson("error", "gemini_live_error", { error: msg });
          sendToClient({
            type: "error",
            error: `Gemini Live error: ${msg}`,
          });
        },

        onclose: (event: any) => {
          const code = event?.code ?? event?._closeCode;
          const rawReason =
            event?.reason ||
            event?._closeReason ||
            (event?._closeMessage
              ? event._closeMessage.toString()
              : "");
          console.warn(
            `[Gemini Live] Session closed (code: ${code ?? "none"}, reason: ${rawReason || "none"})`,
          );
          _logError(`GEMINI_LIVE_CLOSED: code=${code} reason=${rawReason}`);
          _logJson("info", "gemini_live_closed", { code, reason: rawReason });

          const isDurationLimit =
            flags.isRotating ||
            /GoAway|session duration|duration limit/i.test(rawReason);

          // Seamless GoAway rotation
          if (
            isDurationLimit &&
            clientWs.readyState === 1 &&
            !flags.isClientClosed
          ) {
            console.log(
              "[Gemini Live] Session duration limit reached. Seamlessly rotating to a fresh Gemini Live session...",
            );
            sendToClient({ type: "status", status: "connecting_gemini" });
            setTimeout(async () => {
              if (clientWs.readyState === 1 && !flags.isClientClosed) {
                try {
                  flags.isRotating = false;
                  await onRotate();
                  console.log(
                    "[Gemini Live] Session smoothly rotated and restored!",
                  );
                } catch (rotateErr: any) {
                  console.error(
                    "[Gemini Live] Failed to rotate session:",
                    rotateErr,
                  );
                  sendToClient({
                    type: "status",
                    status: "session_closed",
                    code: 1000,
                    reason:
                      "Session duration limit reached. Tap the power button to talk again.",
                  });
                }
              }
            }, 500);
            return;
          }

          let categorizedError: string | null = null;
          const sanitizedReason = (rawReason || "").replace(/AIza[0-9A-Za-z_-]{33,}/gi, "AIzaSy...[REDACTED]");
          if (
            /API[_ ]?KEY|PERMISSION_DENIED|UNAUTHENTICATED|ACCESS_TOKEN_TYPE_UNSUPPORTED/i.test(
              sanitizedReason,
            )
          ) {
            const isProd = process.env.NODE_ENV === "production";
            const advice = isProd
              ? "Please verify that the GEMINI_API_KEY environment variable in your Render Dashboard is set to a valid, active Google Gemini API key from Google AI Studio."
              : "Please verify your Gemini API key in Settings.";
            categorizedError = `GEMINI_AUTH_FAILED: Authentication failed. ${advice} (${sanitizedReason || "invalid credentials"})`;
          } else if (
            /not found|not supported for bidiGenerateContent/i.test(sanitizedReason)
          ) {
            categorizedError = `GEMINI_MODEL_UNSUPPORTED: Model '${liveModel}' is not supported for Live voice. (${sanitizedReason})`;
          } else if (
            /quota|RESOURCE_EXHAUSTED|rate limit/i.test(sanitizedReason)
          ) {
            categorizedError = `GEMINI_QUOTA_EXCEEDED: Gemini quota or rate limit exceeded. (${sanitizedReason})`;
          } else if (code && code !== 1000 && !isDurationLimit && !flags.isClientClosed && !/operation was aborted|aborted|client closed|intentional/i.test(rawReason)) {
            categorizedError = `GEMINI_SESSION_CLOSED: Live session closed (code ${code}${sanitizedReason ? `: ${sanitizedReason}` : ""})`;
          }

          if (categorizedError) {
            sendToClient({
              type: "error",
              error: categorizedError,
              code,
              reason: sanitizedReason,
            });
          } else {
            sendToClient({
              type: "status",
              status: "session_closed",
              code,
              reason: rawReason || "Session closed cleanly",
            });
          }
        },
      },
    });

    sessionRef = session;
    return session;
  }
}
