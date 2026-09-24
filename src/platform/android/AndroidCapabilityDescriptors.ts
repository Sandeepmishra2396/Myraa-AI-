/**
 * MYRAA Platform — Android Capability Descriptors
 * Phase 15
 *
 * Read-only descriptor map classifying which of the 126 MYRAA tools are
 * available, partially available, or unavailable on an Android client.
 *
 * IMPORTANT INVARIANTS
 * ═══════════════════════════════════════════════════════════════════════════
 * 1. This file is a READ-ONLY descriptor. It does NOT modify the 126-tool
 *    registry in GeminiSessionFactory.ts or ToolOrchestrator.ts.
 * 2. Availability decisions are informational — they do NOT block tool calls.
 *    The authoritative security gate is always the server-side SecurityPolicyEngine.
 * 3. "Available" means the tool's effects can be meaningfully used from Android.
 *    "Unavailable" means the tool's effects are purely desktop-local (screen,
 *    mouse, keyboard, Python process) and have no Android-visible outcome.
 *
 * TOOL NAMES: Verified from GeminiSessionFactory.ts LIVE_TOOLS — 126 exact entries.
 * Do NOT add, remove, or rename entries without also updating GeminiSessionFactory.ts.
 *
 * TOOL ROUTING REFERENCE (from ToolOrchestrator.ts)
 * ═══════════════════════════════════════════════════════════════════════════
 *  Set Name             Count  Routes To
 *  ─────────────────── ──────  ──────────────────────────────────────────
 *  DESKTOP_TOOLS          61   TaskManager → Python agent (:8765)
 *  STUDY_TOOLS            22   StudySessionManager / InteractiveTutor
 *  HOLOGRAPHIC_UI          9   sendToClient({ type: "toolCall" })
 *  PLANNER_TOOLS           6   PlannerCoordinator
 *  RESEARCH_TOOLS          6   KnowledgeManager
 *  COMPANION_TOOLS         6   CompanionCoordinator
 *  MULTIMODAL_TOOLS        6   ScreenContextManager / ActiveWindowTracker
 *  PROJECT_TOOLS           5   ProjectManager
 *  REMOTE_TOOLS            4   RemoteSessionManager / EmergencyStopCoordinator
 *  MEMORY_TOOLS            1   MemoryManager
 *  ─────────────────── ──────
 *  TOTAL                 126   ✓
 */

// ---------------------------------------------------------------------------
// Availability Classification
// ---------------------------------------------------------------------------

export type AndroidToolAvailability =
  /**
   * Fully available on Android.
   * The tool's server-side execution and result are meaningful to an Android user.
   */
  | "available"

  /**
   * Partially available on Android.
   * The tool executes on the desktop but some effects may not be visible on Android.
   * Data results are still transmitted to the Android client.
   */
  | "partial"

  /**
   * Unavailable on Android.
   * The tool's effects are exclusively desktop-local (PyAutoGUI mouse/keyboard,
   * Win32 UI automation, Electron IPC) with no meaningful output for Android.
   */
  | "unavailable";

export interface AndroidToolDescriptor {
  name: string;
  toolSet: string;
  availability: AndroidToolAvailability;
  /** Human-readable note explaining the availability decision. */
  note: string;
  /**
   * For partial/unavailable tools: the Phase 16+ strategy for bridging
   * or the Android-native alternative.
   */
  androidAlternative?: string;
}

// ---------------------------------------------------------------------------
// All 126 Tool Descriptors
// (Verified against GeminiSessionFactory.ts LIVE_TOOLS on 2026-09-23)
// ---------------------------------------------------------------------------

const ALL_TOOL_DESCRIPTORS: AndroidToolDescriptor[] = [

  // ── MEMORY TOOLS (1) ──────────────────────────────────────────────────────
  {
    name: "saveCustomMemory",
    toolSet: "MEMORY_TOOLS",
    availability: "available",
    note: "Server-side memory write via MemoryManager. Results meaningful everywhere.",
  },

  // ── HOLOGRAPHIC UI TOOLS (9) ─────────────────────────────────────────────
  // Controls the desktop Electron 3D avatar and holographic browser panels.
  // No Android UI equivalent in Phase 15. Phase 17 adds Compose UI equivalents.
  {
    name: "browserOpen",
    toolSet: "HOLOGRAPHIC_UI",
    availability: "unavailable",
    note: "Desktop Electron holographic browser UI. Controls desktop React browser panel.",
    androidAlternative: "Phase 17: Android Chrome Custom Tabs / WebView via AndroidCapabilityAdapter.",
  },
  {
    name: "browserSearch",
    toolSet: "HOLOGRAPHIC_UI",
    availability: "unavailable",
    note: "Desktop Electron holographic browser search UI.",
    androidAlternative: "Phase 17: Android Intent.ACTION_WEB_SEARCH.",
  },
  {
    name: "browserClick",
    toolSet: "HOLOGRAPHIC_UI",
    availability: "unavailable",
    note: "Desktop Electron holographic browser click handler.",
    androidAlternative: "Phase 17: Android WebView.evaluateJavascript().",
  },
  {
    name: "browserMediaControl",
    toolSet: "HOLOGRAPHIC_UI",
    availability: "unavailable",
    note: "Desktop Electron holographic browser media playback control.",
    androidAlternative: "Phase 17: Android MediaSession API.",
  },
  {
    name: "browserScroll",
    toolSet: "HOLOGRAPHIC_UI",
    availability: "unavailable",
    note: "Desktop Electron holographic browser scroll control.",
  },
  {
    name: "browserType",
    toolSet: "HOLOGRAPHIC_UI",
    availability: "unavailable",
    note: "Desktop Electron holographic browser text input.",
  },
  {
    name: "browserGoBack",
    toolSet: "HOLOGRAPHIC_UI",
    availability: "unavailable",
    note: "Desktop Electron holographic browser history navigation.",
  },
  {
    name: "browserTabAction",
    toolSet: "HOLOGRAPHIC_UI",
    availability: "unavailable",
    note: "Desktop Electron holographic browser tab management.",
  },
  {
    name: "changeBackground",
    toolSet: "HOLOGRAPHIC_UI",
    availability: "unavailable",
    note: "Desktop Electron 3D holographic background / VRM avatar environment control.",
    androidAlternative: "Phase 17: Android UI theme/background update via Compose.",
  },

  // ── DESKTOP_TOOLS — Application Control (7) ───────────────────────────────
  {
    name: "openApplication",
    toolSet: "DESKTOP_TOOLS",
    availability: "unavailable",
    note: "Desktop OS application launch via Python agent / pyautogui.",
    androidAlternative: "Phase 16: Android Intent.ACTION_MAIN + PackageManager.",
  },
  {
    name: "closeApplication",
    toolSet: "DESKTOP_TOOLS",
    availability: "unavailable",
    note: "Desktop OS application close via Python agent / pyautogui.",
  },
  {
    name: "openInVsCode",
    toolSet: "DESKTOP_TOOLS",
    availability: "unavailable",
    note: "Desktop-specific: launches VS Code editor with a path. No Android equivalent.",
  },
  {
    name: "openWebsite",
    toolSet: "DESKTOP_TOOLS",
    availability: "unavailable",
    note: "Desktop OS default browser open via Python agent.",
    androidAlternative: "Phase 17: Android Intent.ACTION_VIEW for URLs.",
  },
  {
    name: "runShellCommand",
    toolSet: "DESKTOP_TOOLS",
    availability: "unavailable",
    note: "Desktop shell command execution. Desktop-local; no Android shell execution.",
  },
  {
    name: "switchApplication",
    toolSet: "DESKTOP_TOOLS",
    availability: "unavailable",
    note: "Desktop window switching via pyautogui/Win32.",
  },

  // ── DESKTOP_TOOLS — Web Search (4) ────────────────────────────────────────
  {
    name: "searchWeb",
    toolSet: "DESKTOP_TOOLS",
    availability: "partial",
    note: "Desktop browser search via Python agent. Web query results transmitted to Android.",
    androidAlternative: "Phase 17: Android can trigger native browser search.",
  },
  {
    name: "searchYouTube",
    toolSet: "DESKTOP_TOOLS",
    availability: "partial",
    note: "Desktop browser YouTube search. Results returned to Android client.",
  },
  {
    name: "searchGoogle",
    toolSet: "DESKTOP_TOOLS",
    availability: "partial",
    note: "Desktop browser Google search. Results returned to Android client.",
  },
  {
    name: "searchGitHub",
    toolSet: "DESKTOP_TOOLS",
    availability: "partial",
    note: "Desktop browser GitHub search. Results returned to Android client.",
  },

  // ── DESKTOP_TOOLS — File Operations (10) ──────────────────────────────────
  {
    name: "createFile",
    toolSet: "DESKTOP_TOOLS",
    availability: "unavailable",
    note: "Creates a file on the desktop file system. Desktop-local.",
  },
  {
    name: "modifyFile",
    toolSet: "DESKTOP_TOOLS",
    availability: "unavailable",
    note: "Modifies a file on the desktop file system. Desktop-local.",
  },
  {
    name: "readFile",
    toolSet: "DESKTOP_TOOLS",
    availability: "partial",
    note: "Reads a desktop file. File content can be returned to Android client.",
    androidAlternative: "Content returned as text in tool response.",
  },
  {
    name: "renameFile",
    toolSet: "DESKTOP_TOOLS",
    availability: "unavailable",
    note: "Renames a desktop file. Desktop-local file system operation.",
  },
  {
    name: "deleteFile",
    toolSet: "DESKTOP_TOOLS",
    availability: "unavailable",
    note: "Deletes a desktop file. Desktop-local file system operation.",
  },
  {
    name: "moveFile",
    toolSet: "DESKTOP_TOOLS",
    availability: "unavailable",
    note: "Moves a desktop file. Desktop-local file system operation.",
  },
  {
    name: "openFolder",
    toolSet: "DESKTOP_TOOLS",
    availability: "unavailable",
    note: "Opens a folder in Windows Explorer. Desktop UI-local.",
  },
  {
    name: "openFile",
    toolSet: "DESKTOP_TOOLS",
    availability: "unavailable",
    note: "Opens a file with its default desktop application. Desktop-local.",
  },
  {
    name: "listFiles",
    toolSet: "DESKTOP_TOOLS",
    availability: "partial",
    note: "Lists desktop directory contents. File list returned to Android client.",
  },
  {
    name: "searchFiles",
    toolSet: "DESKTOP_TOOLS",
    availability: "partial",
    note: "Searches for files on the desktop. Results returned to Android client.",
  },

  // ── DESKTOP_TOOLS — Volume (4) ────────────────────────────────────────────
  {
    name: "volumeUp",
    toolSet: "DESKTOP_TOOLS",
    availability: "unavailable",
    note: "Desktop system volume control via PyCaw/Win32. Desktop-local.",
    androidAlternative: "Phase 17: AudioManager.adjustVolume() on Android.",
  },
  {
    name: "volumeDown",
    toolSet: "DESKTOP_TOOLS",
    availability: "unavailable",
    note: "Desktop system volume control via PyCaw/Win32. Desktop-local.",
  },
  {
    name: "setVolume",
    toolSet: "DESKTOP_TOOLS",
    availability: "unavailable",
    note: "Desktop system volume set via PyCaw. Desktop-local.",
  },
  {
    name: "muteToggle",
    toolSet: "DESKTOP_TOOLS",
    availability: "unavailable",
    note: "Desktop system mute toggle via PyCaw. Desktop-local.",
  },

  // ── DESKTOP_TOOLS — Power (2) ─────────────────────────────────────────────
  {
    name: "requestPowerAction",
    toolSet: "DESKTOP_TOOLS",
    availability: "unavailable",
    note: "Desktop power management (shutdown/restart/sleep). Desktop-local.",
  },
  {
    name: "executePowerAction",
    toolSet: "DESKTOP_TOOLS",
    availability: "unavailable",
    note: "Desktop power action execution. Desktop-local.",
  },

  // ── DESKTOP_TOOLS — Window Management (4) ────────────────────────────────
  {
    name: "minimizeWindow",
    toolSet: "DESKTOP_TOOLS",
    availability: "unavailable",
    note: "Desktop window minimize via Win32/pyautogui. Desktop UI-local.",
  },
  {
    name: "maximizeWindow",
    toolSet: "DESKTOP_TOOLS",
    availability: "unavailable",
    note: "Desktop window maximize. Desktop UI-local.",
  },
  {
    name: "closeWindow",
    toolSet: "DESKTOP_TOOLS",
    availability: "unavailable",
    note: "Desktop window close. Desktop UI-local.",
  },

  // ── DESKTOP_TOOLS — Clipboard (4) ─────────────────────────────────────────
  {
    name: "copySelected",
    toolSet: "DESKTOP_TOOLS",
    availability: "unavailable",
    note: "Desktop clipboard copy (Ctrl+C automation). Desktop-local.",
  },
  {
    name: "pasteClipboard",
    toolSet: "DESKTOP_TOOLS",
    availability: "unavailable",
    note: "Desktop clipboard paste (Ctrl+V automation). Desktop-local.",
  },
  {
    name: "getClipboard",
    toolSet: "DESKTOP_TOOLS",
    availability: "partial",
    note: "Reads desktop clipboard text. Content returned to Android client.",
  },
  {
    name: "clearClipboard",
    toolSet: "DESKTOP_TOOLS",
    availability: "unavailable",
    note: "Clears desktop clipboard. Desktop-local.",
  },

  // ── DESKTOP_TOOLS — Screen Capture (4) ───────────────────────────────────
  {
    name: "takeScreenshot",
    toolSet: "DESKTOP_TOOLS",
    availability: "unavailable",
    note: "Desktop screenshot via PyAutoGUI. Desktop-local display capture.",
    androidAlternative: "Phase 18: Android MediaProjection screen capture.",
  },
  {
    name: "saveScreenshot",
    toolSet: "DESKTOP_TOOLS",
    availability: "unavailable",
    note: "Desktop screenshot save to file. Desktop-local.",
  },
  {
    name: "analyzeScreenshot",
    toolSet: "DESKTOP_TOOLS",
    availability: "partial",
    note: "Desktop screenshot analysis by Gemini. Analysis result returned to Android client.",
  },
  {
    name: "readScreen",
    toolSet: "DESKTOP_TOOLS",
    availability: "unavailable",
    note: "Desktop screen OCR text extraction. Desktop display-local.",
  },

  // ── DESKTOP_TOOLS — Desktop Browser via Playwright (8) ───────────────────
  {
    name: "desktopBrowserOpen",
    toolSet: "DESKTOP_TOOLS",
    availability: "unavailable",
    note: "Desktop Playwright browser automation. Desktop-local browser session.",
  },
  {
    name: "desktopBrowserNavigate",
    toolSet: "DESKTOP_TOOLS",
    availability: "unavailable",
    note: "Desktop Playwright browser navigation. Desktop-local.",
  },
  {
    name: "desktopBrowserSearch",
    toolSet: "DESKTOP_TOOLS",
    availability: "unavailable",
    note: "Desktop Playwright browser search. Desktop-local.",
  },
  {
    name: "desktopBrowserClick",
    toolSet: "DESKTOP_TOOLS",
    availability: "unavailable",
    note: "Desktop Playwright browser click. Desktop-local.",
  },
  {
    name: "desktopBrowserType",
    toolSet: "DESKTOP_TOOLS",
    availability: "unavailable",
    note: "Desktop Playwright browser text input. Desktop-local.",
  },
  {
    name: "desktopBrowserFillForm",
    toolSet: "DESKTOP_TOOLS",
    availability: "unavailable",
    note: "Desktop Playwright form fill. Desktop-local.",
  },
  {
    name: "desktopBrowserOpenTab",
    toolSet: "DESKTOP_TOOLS",
    availability: "unavailable",
    note: "Desktop Playwright browser tab open. Desktop-local.",
  },
  {
    name: "desktopBrowserCloseTab",
    toolSet: "DESKTOP_TOOLS",
    availability: "unavailable",
    note: "Desktop Playwright browser tab close. Desktop-local.",
  },
  {
    name: "desktopBrowserGoBack",
    toolSet: "DESKTOP_TOOLS",
    availability: "unavailable",
    note: "Desktop Playwright browser back. Desktop-local.",
  },
  {
    name: "desktopBrowserGoForward",
    toolSet: "DESKTOP_TOOLS",
    availability: "unavailable",
    note: "Desktop Playwright browser forward. Desktop-local.",
  },
  {
    name: "desktopBrowserScroll",
    toolSet: "DESKTOP_TOOLS",
    availability: "unavailable",
    note: "Desktop Playwright browser scroll. Desktop-local.",
  },

  // ── DESKTOP_TOOLS — Code & Project Files (4) ─────────────────────────────
  {
    name: "createPythonFile",
    toolSet: "DESKTOP_TOOLS",
    availability: "unavailable",
    note: "Creates a Python file on the desktop. Desktop-local file system.",
  },
  {
    name: "writeCodeFile",
    toolSet: "DESKTOP_TOOLS",
    availability: "unavailable",
    note: "Writes code to a desktop file. Desktop-local file system.",
  },
  {
    name: "createProjectFolder",
    toolSet: "DESKTOP_TOOLS",
    availability: "unavailable",
    note: "Creates a project directory on the desktop. Desktop-local.",
  },
  {
    name: "runPythonScript",
    toolSet: "DESKTOP_TOOLS",
    availability: "unavailable",
    note: "Runs a Python script on the desktop. Desktop-local subprocess execution.",
  },

  // ── DESKTOP_TOOLS — System Info (3) ──────────────────────────────────────
  {
    name: "systemInfo",
    toolSet: "DESKTOP_TOOLS",
    availability: "partial",
    note: "Desktop CPU/RAM/OS info via psutil. Data returned to Android client.",
  },
  {
    name: "gpuInfo",
    toolSet: "DESKTOP_TOOLS",
    availability: "partial",
    note: "Desktop GPU info via GPUtil/psutil. Data returned to Android client.",
  },
  {
    name: "temperatureInfo",
    toolSet: "DESKTOP_TOOLS",
    availability: "partial",
    note: "Desktop CPU/GPU temperature via psutil sensors. Data returned to Android client.",
  },

  // ── DESKTOP_TOOLS — Brightness (3) ────────────────────────────────────────
  {
    name: "brightnessUp",
    toolSet: "DESKTOP_TOOLS",
    availability: "unavailable",
    note: "Desktop display brightness up via WMI. Desktop-local.",
    androidAlternative: "Phase 17: WindowManager.LayoutParams.screenBrightness on Android.",
  },
  {
    name: "brightnessDown",
    toolSet: "DESKTOP_TOOLS",
    availability: "unavailable",
    note: "Desktop display brightness down via WMI. Desktop-local.",
  },
  {
    name: "setBrightness",
    toolSet: "DESKTOP_TOOLS",
    availability: "unavailable",
    note: "Desktop display brightness set via WMI. Desktop-local.",
  },

  // ── DESKTOP_TOOLS — Auto Start (3) ────────────────────────────────────────
  {
    name: "enableAutoStart",
    toolSet: "DESKTOP_TOOLS",
    availability: "unavailable",
    note: "Desktop Windows startup registry entry. Desktop-local.",
  },
  {
    name: "disableAutoStart",
    toolSet: "DESKTOP_TOOLS",
    availability: "unavailable",
    note: "Desktop Windows startup registry remove. Desktop-local.",
  },
  {
    name: "getAutoStartStatus",
    toolSet: "DESKTOP_TOOLS",
    availability: "unavailable",
    note: "Desktop Windows startup status check. Desktop-local.",
  },

  // ── PROJECT_TOOLS (5) — via ProjectManager ───────────────────────────────
  {
    name: "analyzeProject",
    toolSet: "PROJECT_TOOLS",
    availability: "available",
    note: "Server-side project analysis via ProjectManager. Results meaningful everywhere.",
  },
  {
    name: "getProjectArchitecture",
    toolSet: "PROJECT_TOOLS",
    availability: "available",
    note: "Server-side architecture analysis via ProjectManager.",
  },
  {
    name: "searchProjectCode",
    toolSet: "PROJECT_TOOLS",
    availability: "available",
    note: "Server-side code search via ProjectManager.",
  },
  {
    name: "getProjectGitStatus",
    toolSet: "PROJECT_TOOLS",
    availability: "available",
    note: "Server-side Git status via ProjectManager.",
  },
  {
    name: "trackProjectTask",
    toolSet: "PROJECT_TOOLS",
    availability: "available",
    note: "Server-side task tracking via ProjectManager.",
  },

  // ── RESEARCH_TOOLS (6) — via KnowledgeManager ────────────────────────────
  {
    name: "researchWeb",
    toolSet: "RESEARCH_TOOLS",
    availability: "available",
    note: "Server-side web research via KnowledgeManager. Results transmitted to Android.",
  },
  {
    name: "fetchOfficialDocs",
    toolSet: "RESEARCH_TOOLS",
    availability: "available",
    note: "Server-side documentation fetch via KnowledgeManager.",
  },
  {
    name: "readUrl",
    toolSet: "RESEARCH_TOOLS",
    availability: "available",
    note: "Server-side URL content fetch via KnowledgeManager. Content returned to Android.",
  },
  {
    name: "ingestKnowledge",
    toolSet: "RESEARCH_TOOLS",
    availability: "available",
    note: "Server-side knowledge base ingestion via KnowledgeManager.",
  },
  {
    name: "queryKnowledgeBase",
    toolSet: "RESEARCH_TOOLS",
    availability: "available",
    note: "Server-side knowledge base query via KnowledgeManager.",
  },
  {
    name: "checkFreshness",
    toolSet: "RESEARCH_TOOLS",
    availability: "available",
    note: "Server-side knowledge freshness check via KnowledgeManager.",
  },

  // ── PLANNER_TOOLS (6) — via PlannerCoordinator ───────────────────────────
  {
    name: "planTask",
    toolSet: "PLANNER_TOOLS",
    availability: "available",
    note: "Server-side task planning via PlannerCoordinator.",
  },
  {
    name: "executeTaskPlan",
    toolSet: "PLANNER_TOOLS",
    availability: "available",
    note: "Server-side plan execution via PlannerCoordinator.",
  },
  {
    name: "pauseTaskPlan",
    toolSet: "PLANNER_TOOLS",
    availability: "available",
    note: "Server-side plan pause via PlannerCoordinator.",
  },
  {
    name: "resumeTaskPlan",
    toolSet: "PLANNER_TOOLS",
    availability: "available",
    note: "Server-side plan resume via PlannerCoordinator.",
  },
  {
    name: "confirmCheckpoint",
    toolSet: "PLANNER_TOOLS",
    availability: "available",
    note: "Server-side plan checkpoint confirmation via PlannerCoordinator.",
  },
  {
    name: "getTaskPlanStatus",
    toolSet: "PLANNER_TOOLS",
    availability: "available",
    note: "Server-side task plan status query via PlannerCoordinator.",
  },

  // ── COMPANION_TOOLS (6) — via CompanionCoordinator ───────────────────────
  {
    name: "scheduleTask",
    toolSet: "COMPANION_TOOLS",
    availability: "available",
    note: "Server-side task scheduling via CompanionCoordinator → TaskScheduler. Notifications pushed to Android.",
  },
  {
    name: "listBackgroundTasks",
    toolSet: "COMPANION_TOOLS",
    availability: "available",
    note: "Server-side task list via CompanionCoordinator.",
  },
  {
    name: "cancelBackgroundTask",
    toolSet: "COMPANION_TOOLS",
    availability: "available",
    note: "Server-side task cancellation via CompanionCoordinator.",
  },
  {
    name: "getCompanionNotifications",
    toolSet: "COMPANION_TOOLS",
    availability: "available",
    note: "Server-side companion notifications list via CompanionCoordinator.",
  },
  {
    name: "updateCompanionPreferences",
    toolSet: "COMPANION_TOOLS",
    availability: "available",
    note: "Server-side companion preferences update via CompanionCoordinator.",
  },
  {
    name: "triggerProjectCheck",
    toolSet: "COMPANION_TOOLS",
    availability: "available",
    note: "Server-side proactive project check trigger via CompanionCoordinator.",
  },

  // ── REMOTE_TOOLS (4) — via RemoteSessionManager / EmergencyStopCoordinator
  {
    name: "generateDevicePairCode",
    toolSet: "REMOTE_TOOLS",
    availability: "available",
    note: "Generates a 6-char pairing PIN on the desktop. Used to initiate Android pairing.",
  },
  {
    name: "listRemoteDevices",
    toolSet: "REMOTE_TOOLS",
    availability: "available",
    note: "Lists paired remote devices including Android devices. Meaningful from Android.",
  },
  {
    name: "revokeRemoteDevice",
    toolSet: "REMOTE_TOOLS",
    availability: "available",
    note: "Revokes a remote device session. Admin role required.",
  },
  {
    name: "triggerEmergencyStop",
    toolSet: "REMOTE_TOOLS",
    availability: "available",
    note: "CRITICAL SAFETY TOOL. Always available. Posts max-priority notification on Android.",
  },

  // ── MULTIMODAL_TOOLS (6) — via ScreenContextManager / ActiveWindowTracker ─
  {
    name: "captureScreenContext",
    toolSet: "MULTIMODAL_TOOLS",
    availability: "unavailable",
    note: "Desktop screen capture via Python agent. Desktop display-local.",
    androidAlternative: "Phase 18: Android MediaProjection for screen capture.",
  },
  {
    name: "analyzeVisualCode",
    toolSet: "MULTIMODAL_TOOLS",
    availability: "partial",
    note: "Gemini multimodal code analysis. Analysis runs server-side; Android can send camera frames.",
    androidAlternative: "Phase 18: Send camera image via sendVideoFrame() for analysis.",
  },
  {
    name: "extractDocumentContent",
    toolSet: "MULTIMODAL_TOOLS",
    availability: "partial",
    note: "Gemini document extraction. Analysis runs server-side; Android can send document photos.",
    androidAlternative: "Phase 18: Send document photo via sendVideoFrame().",
  },
  {
    name: "getContextAwareSuggestions",
    toolSet: "MULTIMODAL_TOOLS",
    availability: "available",
    note: "AI-generated contextual suggestions from CompanionCoordinator. Fully meaningful on Android.",
  },
  {
    name: "toggleContinuousScreenContext",
    toolSet: "MULTIMODAL_TOOLS",
    availability: "unavailable",
    note: "Desktop continuous screen capture mode. Desktop display-local.",
    androidAlternative: "Phase 18: IScreenContext.startContinuousCapture() for Android camera.",
  },
  {
    name: "getActiveWindowContext",
    toolSet: "MULTIMODAL_TOOLS",
    availability: "unavailable",
    note: "Desktop active window info via ActiveWindowTracker + Win32 API. Desktop-local.",
    androidAlternative: "Phase 18: Android AccessibilityService foreground app context.",
  },

  // ── STUDY_TOOLS (22) — via StudySessionManager / InteractiveTutor ─────────
  {
    name: "loadStudyDocument",
    toolSet: "STUDY_TOOLS",
    availability: "available",
    note: "Server-side study document loading via StudySessionManager.",
  },
  {
    name: "trackStudyPage",
    toolSet: "STUDY_TOOLS",
    availability: "available",
    note: "Server-side study page progress tracking via StudySessionManager.",
  },
  {
    name: "detectStudyQuestions",
    toolSet: "STUDY_TOOLS",
    availability: "available",
    note: "Server-side study question detection via StudySessionManager.",
  },
  {
    name: "analyzeStudyDiagram",
    toolSet: "STUDY_TOOLS",
    availability: "available",
    note: "Server-side study diagram analysis via StudySessionManager.",
  },
  {
    name: "explainStudySection",
    toolSet: "STUDY_TOOLS",
    availability: "available",
    note: "Server-side study content explanation via StudySessionManager.",
  },
  {
    name: "toggleTeachingMode",
    toolSet: "STUDY_TOOLS",
    availability: "available",
    note: "Server-side teaching mode toggle via StudySessionManager.",
  },
  {
    name: "getStudySessionStatus",
    toolSet: "STUDY_TOOLS",
    availability: "available",
    note: "Server-side study session status via StudySessionManager.",
  },
  {
    name: "setInteractiveTutorMode",
    toolSet: "STUDY_TOOLS",
    availability: "available",
    note: "Server-side interactive tutor mode via InteractiveTutor.",
  },
  {
    name: "submitStudentAnswer",
    toolSet: "STUDY_TOOLS",
    availability: "available",
    note: "Server-side answer submission and evaluation via InteractiveTutor.",
  },
  {
    name: "getStudyProgress",
    toolSet: "STUDY_TOOLS",
    availability: "available",
    note: "Server-side study progress query via StudySessionManager.",
  },
  {
    name: "startRevisionSession",
    toolSet: "STUDY_TOOLS",
    availability: "available",
    note: "Server-side revision session start via StudySessionManager.",
  },
  {
    name: "navigateToStudyItem",
    toolSet: "STUDY_TOOLS",
    availability: "available",
    note: "Server-side study item navigation via StudySessionManager.",
  },
  {
    name: "explainRelevantDiagram",
    toolSet: "STUDY_TOOLS",
    availability: "available",
    note: "Server-side diagram explanation via StudySessionManager.",
  },
  {
    name: "configureCourseProfile",
    toolSet: "STUDY_TOOLS",
    availability: "available",
    note: "Server-side course profile configuration via StudySessionManager.",
  },
  {
    name: "manageSyllabus",
    toolSet: "STUDY_TOOLS",
    availability: "available",
    note: "Server-side syllabus management via StudySessionManager.",
  },
  {
    name: "researchStudyTopic",
    toolSet: "STUDY_TOOLS",
    availability: "available",
    note: "Server-side topic research via StudySessionManager + KnowledgeManager.",
  },
  {
    name: "discoverStudyVideos",
    toolSet: "STUDY_TOOLS",
    availability: "available",
    note: "Server-side study video discovery via StudySessionManager.",
  },
  {
    name: "analyzePreviousQuestions",
    toolSet: "STUDY_TOOLS",
    availability: "available",
    note: "Server-side past question analysis via StudySessionManager.",
  },
  {
    name: "generatePersonalizedStudyPlan",
    toolSet: "STUDY_TOOLS",
    availability: "available",
    note: "Server-side personalized study plan generation via StudySessionManager.",
  },
  {
    name: "getStudyRecommendations",
    toolSet: "STUDY_TOOLS",
    availability: "available",
    note: "Server-side study recommendations via StudySessionManager.",
  },
  {
    name: "manageDailyStudySession",
    toolSet: "STUDY_TOOLS",
    availability: "available",
    note: "Server-side daily study session management via StudySessionManager.",
  },
  {
    name: "getAcademicProgress",
    toolSet: "STUDY_TOOLS",
    availability: "available",
    note: "Server-side academic progress summary via StudySessionManager.",
  },
];

// ---------------------------------------------------------------------------
// Build and Validate Descriptor Map
// ---------------------------------------------------------------------------

/**
 * Complete read-only descriptor map for all 126 MYRAA tools.
 * Keyed by tool name for O(1) lookup.
 */
export const ANDROID_TOOL_DESCRIPTORS: ReadonlyMap<string, AndroidToolDescriptor> = new Map(
  ALL_TOOL_DESCRIPTORS.map((d) => [d.name, d]),
);

// Development-time assertion: verify no duplicate tool names in our descriptor list
if (ANDROID_TOOL_DESCRIPTORS.size !== ALL_TOOL_DESCRIPTORS.length) {
  throw new Error(
    `[AndroidCapabilityDescriptors] Duplicate tool name detected! ` +
    `Descriptor list has ${ALL_TOOL_DESCRIPTORS.length} entries but map has ` +
    `${ANDROID_TOOL_DESCRIPTORS.size} entries. Check for duplicate names.`,
  );
}

// ---------------------------------------------------------------------------
// Convenience Queries
// ---------------------------------------------------------------------------

/** All tool names classified as fully available on Android. */
export const ANDROID_AVAILABLE_TOOLS: readonly string[] = Object.freeze(
  [...ANDROID_TOOL_DESCRIPTORS.values()]
    .filter((d) => d.availability === "available")
    .map((d) => d.name),
);

/** All tool names classified as partially available on Android. */
export const ANDROID_PARTIAL_TOOLS: readonly string[] = Object.freeze(
  [...ANDROID_TOOL_DESCRIPTORS.values()]
    .filter((d) => d.availability === "partial")
    .map((d) => d.name),
);

/** All tool names classified as unavailable on Android. */
export const ANDROID_UNAVAILABLE_TOOLS: readonly string[] = Object.freeze(
  [...ANDROID_TOOL_DESCRIPTORS.values()]
    .filter((d) => d.availability === "unavailable")
    .map((d) => d.name),
);

/**
 * Canonical names for the 11 Phase 19 Android Native Capabilities.
 */
export const ANDROID_CAPABILITIES = Object.freeze([
  "openApp",
  "openUrl",
  "openSettings",
  "setAlarm",
  "setTimer",
  "createReminder",
  "calendar",
  "notifications",
  "mediaControls",
  "clipboard",
  "deviceStatus",
] as const);

export type AndroidCapabilityName = (typeof ANDROID_CAPABILITIES)[number];

/**
 * Canonical names for the 6 Phase 20 Android Browser Capabilities.
 */
export const BROWSER_CAPABILITIES = Object.freeze([
  "openBrowser",
  "searchWeb",
  "openUrl",
  "findOnPage",
  "navigateBack",
  "navigateForward",
] as const);

export type BrowserCapabilityName = (typeof BROWSER_CAPABILITIES)[number];

// ---------------------------------------------------------------------------
// Phase 21 — Mobile App Interaction Layer
// ---------------------------------------------------------------------------

/**
 * Supported app IDs and their capability metadata.
 * These are the ONLY apps MYRAA may interact with — any others return NOT_SUPPORTED.
 */
export const SUPPORTED_APPS = Object.freeze({
  gmail: {
    appId:          "gmail",
    displayName:    "Gmail",
    packageName:    "com.google.android.gm",
    allowedActions: ["launch", "compose", "view"] as const,
    riskLevel:      "MEDIUM" as const,
  },
  maps: {
    appId:          "maps",
    displayName:    "Google Maps",
    packageName:    "com.google.android.apps.maps",
    allowedActions: ["launch", "search", "directions", "navigation"] as const,
    riskLevel:      "LOW" as const,
  },
  youtube: {
    appId:          "youtube",
    displayName:    "YouTube",
    packageName:    "com.google.android.youtube",
    allowedActions: ["launch", "search", "watch"] as const,
    riskLevel:      "LOW" as const,
  },
  calendar: {
    appId:          "calendar",
    displayName:    "Google Calendar",
    packageName:    "com.google.android.calendar",
    allowedActions: ["launch", "view", "insert_event"] as const,
    riskLevel:      "MEDIUM" as const,
  },
  whatsapp: {
    appId:          "whatsapp",
    displayName:    "WhatsApp",
    packageName:    "com.whatsapp",
    allowedActions: ["launch", "compose_message", "view"] as const,
    riskLevel:      "MEDIUM" as const,
  },
} as const);

export type SupportedAppId = keyof typeof SUPPORTED_APPS;

/** All supported app IDs as a set for fast membership testing. */
export const SUPPORTED_APP_IDS = Object.freeze(
  new Set<string>(Object.keys(SUPPORTED_APPS))
);

/**
 * Resolves a raw app name to a canonical app ID.
 * Returns undefined for unsupported or unrecognised apps.
 */
export function resolveAppId(rawApp: string): SupportedAppId | undefined {
  const normalized = rawApp.trim().toLowerCase();
  const aliasMap: Record<string, SupportedAppId> = {
    gmail: "gmail", mail: "gmail", "google mail": "gmail", email: "gmail",
    maps: "maps", "google maps": "maps", gmap: "maps", gmaps: "maps",
    youtube: "youtube", yt: "youtube", "you tube": "youtube",
    calendar: "calendar", "google calendar": "calendar", gcal: "calendar", cal: "calendar",
    whatsapp: "whatsapp", wa: "whatsapp", "whats app": "whatsapp",
    "whatsapp messenger": "whatsapp",
  };
  return aliasMap[normalized];
}

/**
 * Returns the allowed actions for a given supported app ID.
 */
export function getAllowedAppActions(appId: SupportedAppId): readonly string[] {
  return SUPPORTED_APPS[appId]?.allowedActions ?? [];
}

/**
 * Tools and capabilities that the Android CLIENT executes locally and returns via toolResponse.
 * Phase 19: All 11 native Android capabilities.
 * Phase 20: 6 browser capabilities (openUrl shared).
 * Phase 21: interactApp capability.
 * Phase 22: mobileContext capability.
 */
export const ANDROID_CLIENT_TOOLS: readonly string[] = Object.freeze([
  ...ANDROID_CAPABILITIES,
  "openBrowser",
  "searchWeb",
  "findOnPage",
  "navigateBack",
  "navigateForward",
  // Phase 21
  "interactApp",
  // Phase 22
  "mobileContext",
  // Phase 23
  "mobileScreen",
  // Phase 24
  "sharedMemory",
  // Phase 25
  "handoff",
  // Phase 26
  "mobileProactive",
]);


// ---------------------------------------------------------------------------
// Phase 22 — Mobile Context Intelligence Descriptors
// ---------------------------------------------------------------------------

export const MOBILE_CONTEXT_CATEGORIES = Object.freeze([
  "app",
  "activity",
  "notifications",
  "device",
  "network",
  "battery",
  "screen",
  "conversation",
  "task",
] as const);

export type MobileContextCategory = (typeof MOBILE_CONTEXT_CATEGORIES)[number];

// ---------------------------------------------------------------------------
// Phase 23 — Mobile Screen Understanding Descriptors
// ---------------------------------------------------------------------------

export const MOBILE_SCREEN_MODES = Object.freeze([
  "ocr",
  "visual",
  "full",
] as const);

export type MobileScreenMode = (typeof MOBILE_SCREEN_MODES)[number];

// ---------------------------------------------------------------------------
// Phase 26 — Mobile Proactive Companion Descriptors
// ---------------------------------------------------------------------------

export const MOBILE_NOTIFICATION_CATEGORIES = Object.freeze([
  "TASK",
  "REMINDER",
  "PROJECT",
  "LONG_RUNNING_TASK",
  "SECURITY",
  "CONNECTION",
] as const);

export type MobileProactiveCategory = (typeof MOBILE_NOTIFICATION_CATEGORIES)[number];

/**

 * Get the descriptor for a specific tool by name.
 * Returns undefined if the tool is not in the registry.
 */
export function getAndroidToolDescriptor(toolName: string): AndroidToolDescriptor | undefined {
  return ANDROID_TOOL_DESCRIPTORS.get(toolName);
}

/**
 * Check if a tool is available (fully or partially) on Android.
 */
export function isToolAvailableOnAndroid(toolName: string): boolean {
  const descriptor = ANDROID_TOOL_DESCRIPTORS.get(toolName);
  return descriptor !== undefined && descriptor.availability !== "unavailable";
}
