/**
 * MYRAA Platform — DesktopCapabilityAdapter
 * Phase 15
 *
 * Reference implementation of all platform capability interfaces for the
 * MYRAA Desktop/Electron environment.
 *
 * DESIGN PRINCIPLES
 * ══════════════════════════════════════════════════════════════════════════════
 * 1. ADDITIVE ONLY: This adapter adds no new behaviour to the desktop system.
 *    It documents how the existing desktop already fulfils each capability
 *    interface and provides a typed adapter layer for future use.
 *
 * 2. ZERO SIDE EFFECTS: This module does NOT import any existing backend
 *    modules at the top level. All delegation is via injected dependencies
 *    or documented as delegation points. This prevents accidental import-time
 *    side effects on the existing system.
 *
 * 3. NO SECURITY DUPLICATION: The desktop already enforces the full
 *    Phase 10A–10F security pipeline in ToolOrchestrator.dispatch().
 *    This adapter does not add, wrap, or duplicate any security logic.
 *
 * 4. EXISTING SYSTEMS UNCHANGED: The existing MyraAudioSession, ToolOrchestrator,
 *    CompanionCoordinator, ScreenContextManager, and all other production modules
 *    continue to operate exactly as before. This adapter is an OPTIONAL typed
 *    description layer that sits alongside them.
 *
 * DELEGATION MAP
 * ══════════════════════════════════════════════════════════════════════════════
 *
 *  Capability              Desktop Delegation Target
 *  ─────────────────────── ──────────────────────────────────────────────────
 *  ICaptureAudio           src/lib/audio.ts  → MyraAudioSession
 *                          (Web Audio API + ScriptProcessor / AudioWorklet)
 *                          Audio frames: 16kHz PCM16 base64 → /live WebSocket
 *
 *  IPlaybackAudio          src/lib/audio.ts  → MyraAudioSession._playAudioChunk()
 *                          (Web Audio API → AudioBuffer → AudioBufferSourceNode)
 *                          Inbound: 24kHz PCM16 base64 from /live WebSocket
 *
 *  IAppLaunch              src/backend/tools/ToolOrchestrator.ts
 *                          → DESKTOP_TOOLS → TaskManager.callDesktopAgent()
 *                          → desktop_agent/tools_applications.py
 *                          (openApplication, closeApplication, switchApplication)
 *
 *  IBrowserAction          src/backend/tools/ToolOrchestrator.ts
 *                          → Holographic UI tools → sendToClient({ type: "toolCall" })
 *                          → src/App.tsx onToolCall handler
 *                          → src/components/BrowserAgent.tsx
 *                          Playwright: → DESKTOP_TOOLS → Python agent
 *                          (desktopBrowserOpen, desktopBrowserNavigate, etc.)
 *
 *  IAlarm                  src/backend/tools/ToolOrchestrator.ts
 *                          → COMPANION_TOOLS → _handleCompanionTool()
 *                          → CompanionCoordinator → TaskScheduler
 *                          (scheduleTask, cancelBackgroundTask, listBackgroundTasks)
 *
 *  INotification           src/backend/companion/CompanionCoordinator.ts
 *                          → registerClientBroadcast → WebSocket broadcast
 *                          → React UI notification panel
 *
 *  IDeviceStatus           src/backend/tools/ToolOrchestrator.ts
 *                          → DESKTOP_TOOLS → Python agent
 *                          (systemInfo, gpuInfo, temperatureInfo)
 *
 *  IScreenContext          src/backend/tools/ToolOrchestrator.ts
 *                          → MULTIMODAL_TOOLS → _handleMultimodalTool()
 *                          → ScreenContextManager.captureScreen()
 *                          → ActiveWindowTracker.getActiveContext()
 *
 *  IRemoteSession          src/lib/audio.ts  → MyraAudioSession
 *                          (connects to /live for local, /remote-live for remote)
 *                          Emergency Stop: EmergencyStopCoordinator via REST API
 * ══════════════════════════════════════════════════════════════════════════════
 */

import type {
  ICaptureAudio,
  IPlaybackAudio,
  IAppLaunch,
  IBrowserAction,
  IAlarm,
  INotification,
  IDeviceStatus,
  IScreenContext,
  IRemoteSession,
  AudioCaptureOptions,
  CapturedAudioFrame,
  AudioPlaybackOptions,
  PlaybackAudioFrame,
  AppDescriptor,
  AppLaunchResult,
  ScrollDirection,
  BrowserNavigateResult,
  BrowserSearchResult,
  BrowserClickResult,
  BrowserScrollResult,
  AlarmSpec,
  AlarmRecord,
  AlarmResult,
  NotificationSpec,
  BatteryStatus,
  NetworkStatus,
  StorageInfo,
  DeviceInfo,
  ScreenFrame,
  ActiveWindowContext,
  RemoteSessionConfig,
  RemoteToolCallRequest,
  RemoteToolResponse,
  TranscriptEvent,
  CompanionNotificationEvent,
  RemoteSessionState,
} from "../capabilities/index.ts";

import type { EmergencyStopState } from "../../backend/remote/RemoteTypes.ts";

// ---------------------------------------------------------------------------
// Injected Dependency Interfaces
// (Typed against existing desktop system APIs without importing them directly)
// ---------------------------------------------------------------------------

/**
 * Minimal typed interface of the existing MyraAudioSession
 * (src/lib/audio.ts) required by the DesktopCapabilityAdapter.
 * Matches the existing class's public API without importing it.
 */
export interface MyraAudioSessionLike {
  connect(): Promise<void>;
  disconnect(): void;
  sendTextMessage(text: string): boolean;
  readonly state: string;
}

// ---------------------------------------------------------------------------
// DesktopCapabilityAdapter
// ---------------------------------------------------------------------------

/**
 * DesktopCapabilityAdapter
 *
 * Typed wrapper that documents how the existing MYRAA Desktop system satisfies
 * each platform capability interface. Instances of this adapter are optional —
 * the desktop system already functions without them.
 *
 * Usage: Pass injected references to existing desktop system instances.
 * This class does NOT construct or own any backend singletons.
 *
 * @example
 * ```typescript
 * // Example usage — injecting existing system references
 * const adapter = new DesktopCapabilityAdapter({
 *   desktopBaseUrl: "http://localhost:3000",
 * });
 * const deviceInfo = await adapter.deviceStatus.getDeviceInfo();
 * ```
 */
export class DesktopCapabilityAdapter {
  /** The base URL of the MYRAA Core server (default: http://localhost:3000). */
  readonly desktopBaseUrl: string;

  constructor(options: { desktopBaseUrl?: string } = {}) {
    this.desktopBaseUrl = options.desktopBaseUrl ?? "http://localhost:3000";
  }

  // ── Audio ─────────────────────────────────────────────────────────────────

  /**
   * Desktop audio capture delegation point.
   *
   * The existing MyraAudioSession (src/lib/audio.ts) already captures
   * microphone input using Web Audio API:
   *   - AudioContext { sampleRate: 16000 }
   *   - ScriptProcessorNode or AudioWorkletNode (mic-processor.worklet.js)
   *   - Converts Float32 → Int16 → base64 → sends to /live WebSocket
   *
   * The DesktopCapabilityAdapter exposes a stub ICaptureAudio that confirms
   * the contract is met. Actual capture is managed by MyraAudioSession.
   */
  get captureAudio(): ICaptureAudio {
    return new DesktopCaptureAudioStub();
  }

  /**
   * Desktop audio playback delegation point.
   *
   * The existing MyraAudioSession._playAudioChunk() already handles:
   *   - Decoding base64 PCM16 24kHz chunks
   *   - Resampling via AudioContext
   *   - Queued playback via AudioBufferSourceNode
   */
  get playbackAudio(): IPlaybackAudio {
    return new DesktopPlaybackAudioStub();
  }

  // ── App Launch ────────────────────────────────────────────────────────────

  /**
   * Desktop app launch delegation point.
   *
   * Fulfilled by DESKTOP_TOOLS via ToolOrchestrator → Python agent:
   *   openApplication(appName)  → desktop_agent/tools_applications.py
   *   closeApplication(appName) → desktop_agent/tools_applications.py
   *   switchApplication(appName)→ desktop_agent/tools_windows.py
   */
  get appLaunch(): IAppLaunch {
    return new DesktopAppLaunchStub(this.desktopBaseUrl);
  }

  // ── Browser ───────────────────────────────────────────────────────────────

  /**
   * Desktop browser action delegation point.
   *
   * Holographic browser (9 tools): sendToClient({ type: "toolCall" })
   *   → App.tsx onToolCall → BrowserAgent.tsx
   *
   * Desktop Playwright (11 tools): Python agent
   *   → desktop_agent/tools_browser.py
   */
  get browserAction(): IBrowserAction {
    return new DesktopBrowserActionStub(this.desktopBaseUrl);
  }

  // ── Alarm ─────────────────────────────────────────────────────────────────

  /**
   * Desktop alarm delegation point.
   *
   * Fulfilled by COMPANION_TOOLS via ToolOrchestrator:
   *   scheduleTask        → CompanionCoordinator → TaskScheduler
   *   cancelBackgroundTask→ CompanionCoordinator → TaskScheduler
   *   listBackgroundTasks → CompanionCoordinator
   */
  get alarm(): IAlarm {
    return new DesktopAlarmStub(this.desktopBaseUrl);
  }

  // ── Notification ──────────────────────────────────────────────────────────

  /**
   * Desktop notification delegation point.
   *
   * Fulfilled by CompanionCoordinator.registerClientBroadcast():
   *   → WebSocket broadcast to connected clients
   *   → React UI notification panel in App.tsx
   *
   * Emergency Stop notifications: EmergencyStopCoordinator.registerBroadcast()
   *   → sends { type: "emergency_stop", state } to all clients
   */
  get notification(): INotification {
    return new DesktopNotificationStub(this.desktopBaseUrl);
  }

  // ── Device Status ─────────────────────────────────────────────────────────

  /**
   * Desktop device status delegation point.
   *
   * Fulfilled by DESKTOP_TOOLS via Python agent:
   *   systemInfo      → desktop_agent/tools_system.py → psutil / platform
   *   gpuInfo         → desktop_agent/tools_system.py → GPUtil
   *   temperatureInfo → desktop_agent/tools_system.py → psutil.sensors_temperatures
   */
  get deviceStatus(): IDeviceStatus {
    return new DesktopDeviceStatusStub(this.desktopBaseUrl);
  }

  // ── Screen Context ────────────────────────────────────────────────────────

  /**
   * Desktop screen context delegation point.
   *
   * Fulfilled by MULTIMODAL_TOOLS via ToolOrchestrator:
   *   captureScreenContext       → ScreenContextManager.captureScreen()
   *   getActiveWindowContext     → ActiveWindowTracker.getActiveContext()
   *   toggleContinuousScreenContext → ScreenContextManager.startContinuous()
   *   analyzeVisualCode          → CodeScreenshotAnalyzer
   *   extractDocumentContent     → DocumentUnderstanding
   */
  get screenContext(): IScreenContext {
    return new DesktopScreenContextStub(this.desktopBaseUrl);
  }

  // ── Remote Session ────────────────────────────────────────────────────────

  /**
   * Desktop remote session delegation point.
   *
   * The existing MyraAudioSession (src/lib/audio.ts) connects to /live
   * (local desktop session, no bearer token required).
   *
   * Remote devices (including future Android) connect to /remote-live
   * with a bearer token via RemoteSessionManager (Phase 7).
   *
   * The desktop adapter wraps the local /live session.
   */
  get remoteSession(): IRemoteSession {
    return new DesktopRemoteSessionStub(this.desktopBaseUrl);
  }
}

// ---------------------------------------------------------------------------
// Stub Implementations
// (Type-safe stubs documenting delegation — functional behaviour lives in
//  the existing desktop system modules, not here.)
// ---------------------------------------------------------------------------

/**
 * Stub: Documents that desktop audio capture is fulfilled by MyraAudioSession.
 * The stub throws a clear error if called directly — it exists for type checking
 * and documentation only. Actual capture is owned by MyraAudioSession.
 */
class DesktopCaptureAudioStub implements ICaptureAudio {
  readonly isCapturing = false;

  async startCapture(
    _options: AudioCaptureOptions,
    _onFrame: (frame: CapturedAudioFrame) => void,
  ): Promise<void> {
    throw new DesktopCapabilityDelegationError(
      "ICaptureAudio",
      "MyraAudioSession (src/lib/audio.ts)",
      "Desktop audio capture is managed directly by MyraAudioSession.connect().",
    );
  }

  async stopCapture(): Promise<void> {
    throw new DesktopCapabilityDelegationError(
      "ICaptureAudio",
      "MyraAudioSession (src/lib/audio.ts)",
      "Desktop audio capture is managed directly by MyraAudioSession.disconnect().",
    );
  }
}

class DesktopPlaybackAudioStub implements IPlaybackAudio {
  readonly isInitialized = false;
  readonly bufferedDurationMs = 0;

  async initPlayback(_options: AudioPlaybackOptions): Promise<void> {
    throw new DesktopCapabilityDelegationError(
      "IPlaybackAudio",
      "MyraAudioSession._playAudioChunk() (src/lib/audio.ts)",
      "Desktop audio playback is managed directly by MyraAudioSession.",
    );
  }

  enqueueAudioFrame(_frame: PlaybackAudioFrame): void {
    throw new DesktopCapabilityDelegationError(
      "IPlaybackAudio",
      "MyraAudioSession._playAudioChunk() (src/lib/audio.ts)",
      "Desktop audio playback is managed directly by MyraAudioSession.",
    );
  }

  async drain(): Promise<void> {
    // no-op on desktop — WebSocket close handles cleanup
  }
}

class DesktopAppLaunchStub implements IAppLaunch {
  constructor(private readonly _baseUrl: string) {}

  async launch(_appId: string): Promise<AppLaunchResult> {
    return this._delegateToRestApi("openApplication", { appName: _appId });
  }

  async close(_appId: string): Promise<AppLaunchResult> {
    return this._delegateToRestApi("closeApplication", { appName: _appId });
  }

  async listRunning(): Promise<AppDescriptor[]> {
    // Desktop: Would query Python agent systemInfo
    return [];
  }

  async isRunning(_appId: string): Promise<boolean> {
    return false;
  }

  private async _delegateToRestApi(
    _toolName: string,
    _args: Record<string, unknown>,
  ): Promise<AppLaunchResult> {
    // Delegation note: on the desktop, app launch is invoked via the Gemini Live
    // toolCall flow (MyraAudioSession → GeminiSessionFactory → ToolOrchestrator →
    // DESKTOP_TOOLS → Python agent). Direct REST invocation is not the standard path.
    return { success: false, appId: _args.appName as string, reason: "DesktopCapabilityAdapter: Use Gemini Live toolCall flow for desktop app launch." };
  }
}

class DesktopBrowserActionStub implements IBrowserAction {
  constructor(private readonly _baseUrl: string) {}

  async navigate(url: string): Promise<BrowserNavigateResult> {
    // Delegation: browserOpen tool → sendToClient({ type: "toolCall" }) → BrowserAgent
    return { success: false, url, reason: "DesktopCapabilityAdapter: Use Gemini Live toolCall flow for desktop browser navigation." };
  }

  async search(query: string, _engine?: string): Promise<BrowserSearchResult> {
    return { success: false, query, reason: "DesktopCapabilityAdapter: Use Gemini Live toolCall flow." };
  }

  async click(selector: string, _description?: string): Promise<BrowserClickResult> {
    return { success: false, selector, reason: "DesktopCapabilityAdapter: Use Gemini Live toolCall flow." };
  }

  async scroll(_direction: ScrollDirection, _pixels?: number): Promise<BrowserScrollResult> {
    return { success: false, direction: _direction, reason: "DesktopCapabilityAdapter: Use Gemini Live toolCall flow." };
  }

  async type(_text: string): Promise<{ success: boolean; reason?: string }> {
    return { success: false, reason: "DesktopCapabilityAdapter: Use Gemini Live toolCall flow." };
  }

  async goBack(): Promise<{ success: boolean; reason?: string }> {
    return { success: false, reason: "DesktopCapabilityAdapter: Use Gemini Live toolCall flow." };
  }
}

class DesktopAlarmStub implements IAlarm {
  constructor(private readonly _baseUrl: string) {}

  async schedule(_spec: AlarmSpec, _onFire?: (id: string) => void): Promise<AlarmResult> {
    // Delegation: scheduleTask COMPANION_TOOL → CompanionCoordinator → TaskScheduler
    return { success: false, alarmId: _spec.id, reason: "DesktopCapabilityAdapter: Use scheduleTask Gemini Live tool flow." };
  }

  async cancel(_id: string): Promise<{ success: boolean; reason?: string }> {
    return { success: false, reason: "DesktopCapabilityAdapter: Use cancelBackgroundTask Gemini Live tool flow." };
  }

  async list(): Promise<AlarmRecord[]> {
    return [];
  }

  async cancelAll(): Promise<void> {
    // Emergency Stop hook — desktop EmergencyStopCoordinator handles this
    // via companionCoordinator.stop() in server.ts
  }
}

class DesktopNotificationStub implements INotification {
  constructor(private readonly _baseUrl: string) {}

  async post(_spec: NotificationSpec): Promise<{ success: boolean; reason?: string }> {
    // Delegation: CompanionCoordinator.broadcast() → WebSocket → React UI
    return { success: true }; // No-op stub; actual broadcasts are internal
  }

  async dismiss(_id: string): Promise<void> { /* no-op */ }

  async dismissAll(): Promise<void> { /* no-op */ }

  async postEmergencyStop(_reason: string): Promise<void> {
    // Delegation: EmergencyStopCoordinator.trigger() → broadcast({ type: "emergency_stop" })
    // Already wired in server.ts via emergencyStopCoordinator.registerBroadcast()
  }

  async clearEmergencyStop(): Promise<void> {
    // Delegation: EmergencyStopCoordinator.reset() → broadcast({ type: "emergency_stop", active: false })
  }
}

class DesktopDeviceStatusStub implements IDeviceStatus {
  constructor(private readonly _baseUrl: string) {}

  async getBatteryStatus(): Promise<BatteryStatus> {
    // Desktop: Python agent → tools_system.py → psutil.sensors_battery()
    return { level: -1, state: "unknown", isPluggedIn: true };
  }

  async getNetworkStatus(): Promise<NetworkStatus> {
    return { type: "ethernet", isConnected: true, localIpAddress: "127.0.0.1" };
  }

  async getStorageInfo(): Promise<StorageInfo> {
    // Desktop: Python agent → tools_system.py → shutil.disk_usage()
    return { totalBytes: 0, availableBytes: 0, usedBytes: 0 };
  }

  async getDeviceInfo(): Promise<DeviceInfo> {
    return {
      platform: (process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux"),
      modelName: process.env.COMPUTERNAME ?? "MYRAA Desktop",
      osVersion: process.version,
      appVersion: "1.0.0",
    };
  }
}

class DesktopScreenContextStub implements IScreenContext {
  readonly isContinuousCaptureActive = false;
  constructor(private readonly _baseUrl?: string) {}

  async captureFrame(): Promise<ScreenFrame> {
    // Delegation: captureScreenContext MULTIMODAL_TOOL → ScreenContextManager.captureScreen()
    throw new DesktopCapabilityDelegationError(
      "IScreenContext",
      "ScreenContextManager (src/backend/multimodal/ScreenContextManager.ts)",
      "Desktop screen capture is managed by captureScreenContext tool via ToolOrchestrator.",
    );
  }

  async getActiveContext(): Promise<ActiveWindowContext> {
    // Delegation: getActiveWindowContext MULTIMODAL_TOOL → ActiveWindowTracker.getActiveContext()
    throw new DesktopCapabilityDelegationError(
      "IScreenContext",
      "ActiveWindowTracker (src/backend/multimodal/ActiveWindowTracker.ts)",
      "Desktop active window context is managed by getActiveWindowContext tool via ToolOrchestrator.",
    );
  }

  async startContinuousCapture(
    _intervalMs: number,
    _onFrame: (frame: ScreenFrame, context: ActiveWindowContext) => void,
  ): Promise<void> {
    throw new DesktopCapabilityDelegationError(
      "IScreenContext",
      "ScreenContextManager (src/backend/multimodal/ScreenContextManager.ts)",
      "Use toggleContinuousScreenContext tool via ToolOrchestrator.",
    );
  }

  async stopContinuousCapture(): Promise<void> {
    // no-op stub
  }
}

class DesktopRemoteSessionStub implements IRemoteSession {
  readonly state: RemoteSessionState = "disconnected";
  constructor(private readonly _baseUrl: string) {}

  async connect(_config: RemoteSessionConfig): Promise<void> {
    // Delegation: MyraAudioSession.connect() → WebSocket /live
    throw new DesktopCapabilityDelegationError(
      "IRemoteSession",
      "MyraAudioSession (src/lib/audio.ts)",
      "Desktop sessions are managed by MyraAudioSession.connect().",
    );
  }

  async disconnect(): Promise<void> {
    // no-op stub
  }

  sendAudioFrame(_pcm16Base64: string): void { /* no-op stub */ }
  sendVideoFrame(_jpegBase64: string): void { /* no-op stub */ }
  sendTextMessage(_text: string): void { /* no-op stub */ }
  sendToolResponse(_response: RemoteToolResponse): void { /* no-op stub */ }

  async triggerEmergencyStop(_reason?: string): Promise<{ success: boolean }> {
    // Delegation: POST /api/remote/emergency-stop → EmergencyStopCoordinator.trigger()
    try {
      const response = await fetch(`${this._baseUrl}/api/remote/emergency-stop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: _reason ?? "Triggered via DesktopCapabilityAdapter" }),
      });
      return { success: response.ok };
    } catch {
      return { success: false };
    }
  }

  async resetEmergencyStop(): Promise<{ success: boolean; reason?: string }> {
    try {
      const response = await fetch(`${this._baseUrl}/api/remote/emergency-stop/reset`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "Reset via DesktopCapabilityAdapter" }),
      });
      return { success: response.ok };
    } catch (e: any) {
      return { success: false, reason: e?.message };
    }
  }

  async getEmergencyStopState(): Promise<EmergencyStopState> {
    try {
      const response = await fetch(`${this._baseUrl}/api/remote/emergency-stop`);
      if (response.ok) return response.json();
    } catch { /* fall through */ }
    return { active: false };
  }

  onAudioFrame(_cb: (pcm16Base64: string) => void): void { /* no-op stub */ }
  onTranscript(_cb: (event: TranscriptEvent) => void): void { /* no-op stub */ }
  onToolCall(_cb: (request: RemoteToolCallRequest) => void): void { /* no-op stub */ }
  onCompanionNotification(_cb: (event: CompanionNotificationEvent) => void): void { /* no-op stub */ }
  onEmergencyStopChange(_cb: (state: EmergencyStopState) => void): void { /* no-op stub */ }
  onError(_cb: (error: string, isReconnecting: boolean) => void): void { /* no-op stub */ }
  onStateChange(_cb: (state: RemoteSessionState) => void): void { /* no-op stub */ }
  removeAllListeners(): void { /* no-op stub */ }
}

// ---------------------------------------------------------------------------
// Error Type
// ---------------------------------------------------------------------------

/**
 * Error thrown when a stub delegation method is called directly.
 * This indicates the caller should use the actual desktop system pathway
 * instead of the adapter stub.
 */
export class DesktopCapabilityDelegationError extends Error {
  readonly capability: string;
  readonly delegationTarget: string;

  constructor(capability: string, delegationTarget: string, guidance: string) {
    super(
      `[DesktopCapabilityAdapter] ${capability} stub called directly. ` +
      `This capability is fulfilled by: ${delegationTarget}. ${guidance}`,
    );
    this.name = "DesktopCapabilityDelegationError";
    this.capability = capability;
    this.delegationTarget = delegationTarget;
  }
}
