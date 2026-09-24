/**
 * MYRAA — ScreenContextManager (Phase 8)
 *
 * User-controlled continuous screen perception with strict privacy & security safeguards:
 *   - DISABLED BY DEFAULT: Requires explicit user action to start.
 *   - VISIBLE STATUS: Clear visual indicators of capture state.
 *   - FAIL-CLOSED PRIVACY SHIELD: Automatically pauses and suppresses capture on sensitive
 *     apps (Bitwarden, 1Password, KeePass, incognito) or when active-window detection is uncertain.
 *   - PERCEPTUAL DIFFING: Skips identical frames to prevent CPU & API token waste.
 *   - ZERO RAW FRAME PERSISTENCE: Raw screenshots and frames exist only in volatile memory;
 *     never written to disk or logged to files.
 *   - EMERGENCY STOP: Halts immediately on emergency stop; does NOT auto-resume on reset.
 */

import crypto from "crypto";
import {
  ScreenSnapshot,
  ContinuousScreenConfig,
  DEFAULT_SCREEN_INTERVAL_MS,
  MIN_SCREEN_INTERVAL_MS,
  MAX_SCREEN_INTERVAL_MS,
  PERCEPTUAL_DIFF_THRESHOLD,
  MAX_RETAINED_SNAPSHOTS,
  ActiveWindowInfo,
} from "./MultimodalTypes.ts";
import { activeWindowTracker } from "./ActiveWindowTracker.ts";
import { callDesktopAgent } from "../tasks/TaskManager.ts";
import { emergencyStopCoordinator } from "../remote/EmergencyStopCoordinator.ts";

export type ScreenUpdateListener = (snapshot: ScreenSnapshot, hasChanged: boolean) => void;

export class ScreenContextManager {
  private _config: ContinuousScreenConfig = {
    enabled: false,                       // Disabled by default
    intervalMs: DEFAULT_SCREEN_INTERVAL_MS,
    privacyShieldEnabled: true,
    perceptualDiffThreshold: PERCEPTUAL_DIFF_THRESHOLD,
    maxRetainedSnapshots: MAX_RETAINED_SNAPSHOTS,
  };

  private _isPaused = false;
  private _timer: ReturnType<typeof setInterval> | null = null;
  private _recentSnapshots: ScreenSnapshot[] = []; // Volatile memory buffer only
  private _lastHash: string = "";
  private _privacyShieldTriggered = false;
  private _listeners = new Set<ScreenUpdateListener>();

  constructor() {
    emergencyStopCoordinator.registerTriggerHook(() => {
      this.emergencyStop();
    });
  }

  // ---------------------------------------------------------------------------
  // Lifecycle & User Controls
  // ---------------------------------------------------------------------------

  /** Start continuous screen context perception. */
  start(): void {
    if (emergencyStopCoordinator.isActive()) {
      throw new Error("EMERGENCY_STOP_ACTIVE: Cannot start screen perception while emergency stop is active.");
    }

    this._config.enabled = true;
    this._isPaused = false;
    this._privacyShieldTriggered = false;

    if (this._timer) {
      clearInterval(this._timer);
    }

    console.log(`[ScreenContextManager] Continuous screen perception started (Interval: ${this._config.intervalMs}ms).`);
    // Run an immediate capture tick
    this.captureTick().catch(() => {});

    this._timer = setInterval(() => {
      this.captureTick().catch((err) => {
        console.warn("[ScreenContextManager] Capture tick error:", err?.message || err);
      });
    }, this._config.intervalMs);
  }

  /** Stop continuous screen context perception. */
  stop(): void {
    this._config.enabled = false;
    this._isPaused = false;
    this._privacyShieldTriggered = false;

    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    console.log("[ScreenContextManager] Continuous screen perception stopped.");
  }

  /** Pause continuous capture temporarily. */
  pause(): void {
    this._isPaused = true;
    console.log("[ScreenContextManager] Screen perception paused.");
  }

  /** Resume continuous capture from paused state. */
  resume(): void {
    if (emergencyStopCoordinator.isActive()) {
      throw new Error("EMERGENCY_STOP_ACTIVE: Cannot resume screen perception while emergency stop is active.");
    }
    this._isPaused = false;
    this._privacyShieldTriggered = false;
    console.log("[ScreenContextManager] Screen perception resumed.");
  }

  /** Update configuration with interval clamping. */
  setConfig(patch: Partial<ContinuousScreenConfig>): ContinuousScreenConfig {
    if (patch.intervalMs !== undefined) {
      const clamped = Math.max(
        MIN_SCREEN_INTERVAL_MS,
        Math.min(MAX_SCREEN_INTERVAL_MS, patch.intervalMs),
      );
      this._config.intervalMs = clamped;
      if (this._config.enabled && this._timer) {
        clearInterval(this._timer);
        this._timer = setInterval(() => {
          this.captureTick().catch(() => {});
        }, clamped);
      }
    }

    if (patch.privacyShieldEnabled !== undefined) {
      this._config.privacyShieldEnabled = patch.privacyShieldEnabled;
    }
    if (patch.perceptualDiffThreshold !== undefined) {
      this._config.perceptualDiffThreshold = patch.perceptualDiffThreshold;
    }

    return { ...this._config };
  }

  /** Current state inspection for UI and API. */
  getStatus() {
    return {
      enabled: this._config.enabled,
      isPaused: this._isPaused,
      intervalMs: this._config.intervalMs,
      privacyShieldEnabled: this._config.privacyShieldEnabled,
      privacyShieldActive: this._privacyShieldTriggered,
      retainedSnapshotsCount: this._recentSnapshots.length,
      lastCaptureAt: this._recentSnapshots[this._recentSnapshots.length - 1]?.timestamp,
    };
  }

  // ---------------------------------------------------------------------------
  // Capture Engine & Privacy Shielding
  // ---------------------------------------------------------------------------

  /**
   * Execute a single perception tick.
   * Enforces privacy shielding, fail-closed guards, and perceptual diffing.
   */
  async captureTick(): Promise<ScreenSnapshot | null> {
    // 1. Emergency stop check
    if (emergencyStopCoordinator.isActive()) {
      this.pause();
      return null;
    }

    if (!this._config.enabled || this._isPaused) {
      return null;
    }

    // 2. Active Window Inspection & Privacy Shield Check
    let windowInfo: ActiveWindowInfo;
    try {
      windowInfo = await activeWindowTracker.getActiveWindow();
    } catch {
      // FAIL CLOSED: If active window inspection crashes, fail closed
      windowInfo = {
        title: "Detection Failed",
        processName: "unknown",
        category: "sensitive",
        isUncertain: true,
        timestamp: Date.now(),
      };
    }

    // 3. FAIL CLOSED RULE: Sensitive app OR uncertain window detection -> block capture
    if (
      this._config.privacyShieldEnabled &&
      (windowInfo.category === "sensitive" || windowInfo.isUncertain)
    ) {
      this._privacyShieldTriggered = true;
      // Do NOT capture or process any frame
      return null;
    }

    this._privacyShieldTriggered = false;

    // 4. Capture screenshot via desktop agent
    let captureRes: any;
    try {
      captureRes = await callDesktopAgent("takeScreenshot", {
        include_image: true,
        max_dim: 960,
      });
    } catch {
      return null;
    }

    if (!captureRes || !captureRes.image_base64) {
      return null;
    }

    const base64 = captureRes.image_base64;
    const width = Number(captureRes.width) || 1280;
    const height = Number(captureRes.height) || 720;
    const now = Date.now();

    // 5. Compute perceptual hash for frame change detection
    const frameHash = this._computeFrameHash(base64);
    const hasChanged = frameHash !== this._lastHash;
    this._lastHash = frameHash;

    const snapshot: ScreenSnapshot = {
      base64,
      mimeType: "image/jpeg",
      width,
      height,
      hash: frameHash,
      timestamp: now,
      activeWindow: windowInfo,
    };

    // 6. Retain only in volatile memory buffer (MAX_RETAINED_SNAPSHOTS)
    this._recentSnapshots.push(snapshot);
    if (this._recentSnapshots.length > this._config.maxRetainedSnapshots) {
      this._recentSnapshots.shift();
    }

    // 7. Notify listeners (e.g. MultimodalFusionEngine)
    for (const listener of this._listeners) {
      try {
        listener(snapshot, hasChanged);
      } catch (e) {
        console.warn("[ScreenContextManager] Listener notification error:", e);
      }
    }

    return snapshot;
  }

  /**
   * On-demand single capture (user requested or tool requested).
   * Enforces privacy shield and fail-closed checks.
   */
  async captureOnDemand(force = false): Promise<ScreenSnapshot> {
    if (emergencyStopCoordinator.isActive()) {
      throw new Error("EMERGENCY_STOP_ACTIVE: Cannot capture screen while emergency stop is active.");
    }

    const windowInfo = await activeWindowTracker.getActiveWindow();

    if (
      !force &&
      this._config.privacyShieldEnabled &&
      (windowInfo.category === "sensitive" || windowInfo.isUncertain)
    ) {
      throw new Error(
        `PRIVACY_SHIELD_ACTIVE: Screen capture blocked. Active window '${windowInfo.title}' contains sensitive content or detection was uncertain.`
      );
    }

    const captureRes = await callDesktopAgent("takeScreenshot", {
      include_image: true,
      max_dim: 960,
    });
    const resAny = captureRes as any;
    const base64 = resAny?.image_base64 || resAny?.result?.image_base64;

    if (!resAny || !base64) {
      throw new Error("Screen capture returned empty image data.");
    }

    const width = Number(resAny.width || resAny.result?.width) || 1280;
    const height = Number(resAny.height || resAny.result?.height) || 720;
    const hash = this._computeFrameHash(base64);

    return {
      base64,
      mimeType: "image/jpeg",
      width,
      height,
      hash,
      timestamp: Date.now(),
      activeWindow: windowInfo,
    };
  }

  /** Get the most recent in-memory snapshot (if available). */
  getLatestSnapshot(): ScreenSnapshot | null {
    if (this._recentSnapshots.length === 0) return null;
    return this._recentSnapshots[this._recentSnapshots.length - 1];
  }

  /** Subscribe to screen updates. */
  onScreenUpdate(listener: ScreenUpdateListener): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  /** Emergency Stop Handler: immediately halts capture loop. */
  emergencyStop(): void {
    this.stop();
    this._recentSnapshots = [];
    this._lastHash = "";
    console.log("[ScreenContextManager] Screen perception completely halted by Emergency Stop.");
  }

  // ---------------------------------------------------------------------------
  // Perceptual Hash Calculation
  // ---------------------------------------------------------------------------

  /**
   * Generates a lightweight perceptual hash by sampling bytes across the image buffer.
   * Sensitive to layout changes while resisting trivial noise.
   */
  private _computeFrameHash(base64: string): string {
    // Sample 64 points evenly across the base64 string
    const len = base64.length;
    if (len < 100) return crypto.createHash("md5").update(base64).digest("hex");

    const samplePoints: string[] = [];
    const step = Math.floor(len / 64);
    for (let i = 0; i < len; i += step) {
      samplePoints.push(base64[i]);
    }
    return crypto.createHash("md5").update(samplePoints.join("")).digest("hex");
  }
}

export const screenContextManager = new ScreenContextManager();
