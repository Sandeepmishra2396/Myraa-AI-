/**
 * MYRAA Platform — AppLaunchCapability Interface
 * Phase 15
 *
 * Defines the typed contract for platform application lifecycle control.
 *
 * Desktop implementation: Delegates to ToolOrchestrator DESKTOP_TOOLS
 *   (openApplication, closeApplication, switchApplication — handled by Python agent).
 *
 * Android implementation: android.content.Intent.ACTION_MAIN + PackageManager
 *   for launching apps; ActivityManager for listing running apps.
 *
 * IMPORTANT: The desktop implementation of app launching is handled by the
 * existing 61-tool Python desktop agent pipeline. The AndroidCapabilityAdapter
 * (Phase 16) MUST NOT attempt to replicate desktop tool execution — it should
 * only expose Android-native app lifecycle operations.
 */

// ---------------------------------------------------------------------------
// App Descriptors
// ---------------------------------------------------------------------------

/**
 * Identifies a running or installed application on the current platform.
 */
export interface AppDescriptor {
  /**
   * Platform-specific application identifier.
   *   Desktop  : process name or executable path (e.g., "notepad.exe", "code")
   *   Android  : package name (e.g., "com.android.chrome")
   */
  appId: string;

  /** Human-readable display name (e.g., "Google Chrome", "Notepad"). */
  displayName: string;

  /** Whether the application is currently in the foreground / active. */
  isForeground: boolean;

  /** PID of the running process, if available. */
  pid?: number;
}

/** Result of an app launch attempt. */
export interface AppLaunchResult {
  success: boolean;
  appId: string;
  /** Reason for failure if success is false. */
  reason?: string;
}

// ---------------------------------------------------------------------------
// IAppLaunch Contract
// ---------------------------------------------------------------------------

/**
 * IAppLaunch — Platform-independent application lifecycle contract.
 *
 * On Desktop (via DesktopCapabilityAdapter):
 *   Triggers the existing `openApplication` / `closeApplication` tools through
 *   the ToolOrchestrator → Python desktop agent pipeline.
 *
 * On Android (Phase 16):
 *   Uses Intent.ACTION_MAIN + PackageManager directly on the Android device.
 */
export interface IAppLaunch {
  /**
   * Launch (or bring to foreground) the specified application.
   * @param appId Platform-specific app identifier.
   */
  launch(appId: string): Promise<AppLaunchResult>;

  /**
   * Request that the specified application be closed/terminated.
   * @param appId Platform-specific app identifier.
   */
  close(appId: string): Promise<AppLaunchResult>;

  /**
   * List currently running / visible applications.
   * Result is advisory — implementations may return partial lists
   * depending on platform security restrictions.
   */
  listRunning(): Promise<AppDescriptor[]>;

  /**
   * Check whether a specific application is currently running.
   * @param appId Platform-specific app identifier.
   */
  isRunning(appId: string): Promise<boolean>;
}
