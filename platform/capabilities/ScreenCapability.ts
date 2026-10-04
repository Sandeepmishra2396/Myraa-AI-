/**
 * MYRAA Platform — ScreenCapability Interface
 * Phase 15
 *
 * Defines the typed contract for capturing and querying screen/visual context.
 *
 * Desktop implementation: Delegates to the existing Multimodal Intelligence subsystem
 *   (captureScreenContext, analyzeVisualCode, getActiveWindowContext — MULTIMODAL_TOOLS).
 *   Existing implementations in src/backend/multimodal/:
 *     - ScreenContextManager.captureScreen() → base64 JPEG
 *     - ActiveWindowTracker.getActiveContext() → { title, processName, category }
 *
 * Android implementation (Phase 18): android.media.projection.MediaProjection API
 *   for screen capture (requires user permission grant each session); accessibility
 *   services for active app context detection.
 *
 * PRIVACY NOTE: Screen capture capability on Android requires explicit user
 * consent via MediaProjectionManager.createScreenCaptureIntent() each time.
 * The capability implementation MUST surface the permission dialog before
 * calling captureFrame(). No silent/background screen capture is permitted.
 */

// ---------------------------------------------------------------------------
// Screen Context Types
// ---------------------------------------------------------------------------

export type WindowCategory =
  | "code_editor"       // IDE, code editor (VSCode, Android Studio, etc.)
  | "browser"           // Web browser
  | "document"          // Document viewer / PDF reader
  | "terminal"          // Terminal / command prompt
  | "media"             // Video / audio player
  | "communication"     // Chat, email, video call
  | "file_manager"      // File browser
  | "settings"          // System settings
  | "game"              // Game application
  | "unknown";          // Unrecognized application category

/** Metadata about the currently active window or foreground application. */
export interface ActiveWindowContext {
  /** Window title or activity name. */
  title: string;

  /**
   * Process or package identifier.
   *   Desktop : process name (e.g., "Code.exe", "chrome.exe")
   *   Android : package name (e.g., "com.google.android.apps.maps")
   */
  processName: string;

  /** Semantic category of the active window. */
  category: WindowCategory;

  /**
   * Whether this window is classified as privacy-sensitive / shielded.
   * Shielded windows: banking apps, password managers, medical apps.
   * Screen capture MUST be refused for shielded windows.
   */
  isShielded: boolean;

  /** Timestamp of context snapshot (ISO string). */
  capturedAt: string;
}

/** Result of a screen frame capture. */
export interface ScreenFrame {
  /**
   * Base64-encoded JPEG image of the captured screen.
   * This is the format expected by the Gemini Live API
   * sendRealtimeInput({ video: { data, mimeType: "image/jpeg" } }).
   */
  jpegBase64: string;

  /** Capture timestamp (ISO string). */
  capturedAt: string;

  /** Resolution of the captured frame. */
  widthPx: number;
  heightPx: number;
}

// ---------------------------------------------------------------------------
// IScreenContext Contract
// ---------------------------------------------------------------------------

/**
 * IScreenContext — Platform-independent screen context capability.
 *
 * Desktop (via DesktopCapabilityAdapter):
 *   ScreenContextManager.captureScreen() + ActiveWindowTracker.getActiveContext().
 *   Wired into MULTIMODAL_TOOLS route in ToolOrchestrator.
 *
 * Android (Phase 18):
 *   MediaProjectionManager for screen capture.
 *   AccessibilityService or UsageStatsManager for active app context.
 */
export interface IScreenContext {
  /**
   * Capture a single JPEG frame of the current screen.
   * Implementations MUST refuse capture if `getActiveContext().isShielded` is true.
   * @throws PlatformCapabilityError if permission denied or context is shielded.
   */
  captureFrame(): Promise<ScreenFrame>;

  /**
   * Query metadata about the currently active window or foreground app.
   * Does NOT capture screen pixels — safe to call frequently.
   */
  getActiveContext(): Promise<ActiveWindowContext>;

  /**
   * Start continuous screen context monitoring.
   * Calls `onFrame` at the specified interval.
   * @param intervalMs Capture interval in milliseconds (minimum: 500 ms).
   * @param onFrame Callback receiving each captured frame.
   */
  startContinuousCapture(
    intervalMs: number,
    onFrame: (frame: ScreenFrame, context: ActiveWindowContext) => void,
  ): Promise<void>;

  /**
   * Stop continuous screen capture.
   * Safe to call even if continuous capture is not running.
   */
  stopContinuousCapture(): Promise<void>;

  /** Whether continuous screen capture is currently active. */
  readonly isContinuousCaptureActive: boolean;
}
