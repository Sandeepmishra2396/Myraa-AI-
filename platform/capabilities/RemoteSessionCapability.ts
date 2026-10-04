/**
 * MYRAA Platform — RemoteSessionCapability Interface
 * Phase 15
 *
 * Defines the typed contract for connecting to and communicating with the
 * MYRAA Desktop Core server over the /remote-live WebSocket endpoint.
 *
 * This is the CORE capability that all other capabilities flow through.
 * All tool dispatches, audio streaming, notifications, and emergency stop
 * commands transit through this single authenticated session.
 *
 * EXISTING WIRE PROTOCOL:
 * ════════════════════════════════════════════════════════════════════════════
 * Connection:  ws(s)://<desktop>:3000/remote-live
 * Auth header: Sec-WebSocket-Protocol: myraa-auth, <sora_dev_...token>
 *   OR         ?token=<sora_dev_...token>   (query param fallback)
 *
 * Outbound frames (client → server):
 *   { audio: "<base64_pcm16_16khz>" }                  ← mic audio chunk
 *   { type: "video", video: "<base64_jpeg>" }           ← camera/screen frame
 *   { type: "text", text: "<message>" }                 ← text command
 *   { type: "toolResponse", id, name, output }          ← UI tool execution result
 *
 * Inbound frames (server → client):
 *   { audio: "<base64_pcm16_24khz>" }                   ← TTS audio chunk
 *   { type: "status", status: "..." }                   ← session status
 *   { type: "modelTurn", text: "..." }                  ← model transcript
 *   { type: "userTurn", text: "..." }                   ← user transcript
 *   { type: "turnComplete" }                            ← turn ended
 *   { type: "interrupted" }                             ← model interrupted
 *   { type: "toolCall", callId, name, args }            ← client-side tool request
 *   { type: "memory_sync", memories: [...] }            ← memory update
 *   { type: "companion_notification", notification }    ← proactive notification
 *   { type: "emergency_stop", state }                   ← emergency stop event
 *   { type: "error", error: "..." }                     ← error message
 *
 * Security: All tool executions are gated by Phase 10A–10F SecurityPolicyEngine
 *           on the MYRAA Core — the client NEVER bypasses server-side security.
 * ════════════════════════════════════════════════════════════════════════════
 */

import type { EmergencyStopState, DeviceRole } from "../../backend/remote/RemoteTypes.ts";

// ---------------------------------------------------------------------------
// Connection Types
// ---------------------------------------------------------------------------

export type RemoteSessionState =
  | "disconnected"
  | "connecting"
  | "authenticating"
  | "connected"
  | "reconnecting"
  | "error"
  | "emergency_stop_active";

export interface RemoteSessionConfig {
  /**
   * WebSocket URL of the MYRAA Desktop Core /remote-live endpoint.
   * Format: ws(s)://<desktop-ip>:3000/remote-live
   * Production: wss:// required. Development: ws:// permitted on LAN.
   */
  desktopUrl: string;

  /**
   * HMAC-SHA256 signed bearer token issued by PairingManager.
   * Format: sora_dev_<base64url(deviceId.ts.nonce)>.<hmac>
   * Stored in Android Keystore-backed EncryptedSharedPreferences.
   */
  bearerToken: string;

  /**
   * Friendly device name sent in the pairing handshake.
   * Shown in the desktop device management UI.
   */
  deviceName: string;

  /**
   * Device role (assigned by desktop during pairing).
   * Determines which tools and operations are permitted.
   */
  deviceRole: DeviceRole;

  /**
   * Reconnection configuration.
   * The session MUST auto-reconnect on transient network interruptions.
   */
  reconnect?: {
    /** Maximum number of automatic reconnection attempts (default: 5). */
    maxAttempts?: number;
    /** Initial backoff delay in ms (default: 1000). Doubles each attempt. */
    initialDelayMs?: number;
    /** Maximum backoff delay cap in ms (default: 30000). */
    maxDelayMs?: number;
  };
}

/** Client-side tool call request received from MYRAA Core. */
export interface RemoteToolCallRequest {
  /** Tool execution ID for correlation in the response. */
  callId?: string;
  /** Tool name from the 126-tool registry. */
  name: string;
  /** Tool arguments from Gemini Live function call. */
  args: Record<string, unknown>;
}

/** Client-side tool execution result to send back to MYRAA Core. */
export interface RemoteToolResponse {
  /** Correlating call ID from the received tool call. */
  id?: string;
  /** Tool name. */
  name: string;
  /** Execution result or error object. */
  output: unknown;
}

/** Transcript event from the Gemini Live session. */
export interface TranscriptEvent {
  role: "model" | "user";
  text: string;
  isFinal: boolean;
}

/** Companion notification event. */
export interface CompanionNotificationEvent {
  id?: string;
  type: string;
  title?: string;
  message?: string;
  action?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// IRemoteSession Contract
// ---------------------------------------------------------------------------

/**
 * IRemoteSession — The core Android ↔ MYRAA Core communication contract.
 *
 * Desktop (via DesktopCapabilityAdapter):
 *   Wraps the existing MyraAudioSession (src/lib/audio.ts) which connects to /live.
 *   The desktop session is local and does not use bearer token authentication.
 *
 * Android (Phase 16):
 *   OkHttp3 WebSocket client connecting to /remote-live with bearer token
 *   in Sec-WebSocket-Protocol header. Managed by LiveAudioForegroundService.
 *
 * INVARIANT: This interface MUST NOT reimplement any security logic.
 *   All security enforcement happens server-side in SecurityPolicyEngine.
 *   The client is a trusted-but-verified endpoint, not a security boundary.
 */
export interface IRemoteSession {
  // ── Connection Lifecycle ──────────────────────────────────────────────────

  /**
   * Establish the WebSocket connection to MYRAA Core.
   * Sends the bearer token via Sec-WebSocket-Protocol.
   * Resolves when the connection is authenticated and ready.
   * @throws PlatformCapabilityError on auth failure or connection timeout.
   */
  connect(config: RemoteSessionConfig): Promise<void>;

  /**
   * Gracefully disconnect from MYRAA Core.
   * Flushes any buffered audio, sends a close frame, then terminates.
   * Safe to call even if already disconnected.
   */
  disconnect(): Promise<void>;

  /** Current session connection state. */
  readonly state: RemoteSessionState;

  // ── Outbound Streams ──────────────────────────────────────────────────────

  /**
   * Send a captured PCM16 audio frame to MYRAA Core.
   * Frame format: { audio: "<base64_pcm16_16khz>" }
   * Must only be called while state is "connected".
   * Silently drops frames if not connected (prevents buffering overflow).
   */
  sendAudioFrame(pcm16Base64: string): void;

  /**
   * Send a JPEG video/screen frame to MYRAA Core.
   * Frame format: { type: "video", video: "<base64_jpeg>" }
   * Used for camera streaming (Phase 18) and Android screen context.
   */
  sendVideoFrame(jpegBase64: string): void;

  /**
   * Send a text message to the Gemini Live session.
   * Frame format: { type: "text", text: "<message>" }
   */
  sendTextMessage(text: string): void;

  /**
   * Return the result of a client-side tool execution to MYRAA Core.
   * Frame format: { type: "toolResponse", id, name, output }
   * This is how holographic UI tools complete their execution cycle.
   */
  sendToolResponse(response: RemoteToolResponse): void;

  // ── Emergency Stop Controls ───────────────────────────────────────────────

  /**
   * Trigger the MYRAA Emergency Stop killswitch on the desktop.
   * Calls POST /api/remote/emergency-stop on the MYRAA Core server.
   * This immediately halts all agent plans, desktop tool executions,
   * and background companion monitors on the desktop.
   * @param reason Human-readable reason string for the audit log.
   */
  triggerEmergencyStop(reason?: string): Promise<{ success: boolean }>;

  /**
   * Reset the Emergency Stop (requires admin role device).
   * Calls POST /api/remote/emergency-stop/reset.
   */
  resetEmergencyStop(): Promise<{ success: boolean; reason?: string }>;

  /**
   * Get the current Emergency Stop state from MYRAA Core.
   * Calls GET /api/remote/emergency-stop.
   */
  getEmergencyStopState(): Promise<EmergencyStopState>;

  // ── Inbound Event Handlers ────────────────────────────────────────────────

  /**
   * Register a callback for incoming TTS audio frames.
   * Frame format: { audio: "<base64_pcm16_24khz>" }
   * The callback should pass frames to IPlaybackAudio.enqueueAudioFrame().
   */
  onAudioFrame(callback: (pcm16Base64: string) => void): void;

  /**
   * Register a callback for transcript events (model and user turns).
   */
  onTranscript(callback: (event: TranscriptEvent) => void): void;

  /**
   * Register a callback for client-side tool call requests.
   * The callback MUST call sendToolResponse() with the execution result.
   */
  onToolCall(callback: (request: RemoteToolCallRequest) => void): void;

  /**
   * Register a callback for companion notification events.
   */
  onCompanionNotification(callback: (event: CompanionNotificationEvent) => void): void;

  /**
   * Register a callback for emergency stop state changes.
   * Called whenever the server broadcasts an emergency_stop event.
   */
  onEmergencyStopChange(callback: (state: EmergencyStopState) => void): void;

  /**
   * Register a callback for session errors and reconnection status.
   * The `isReconnecting` flag indicates whether auto-reconnect is in progress.
   */
  onError(callback: (error: string, isReconnecting: boolean) => void): void;

  /**
   * Register a callback for session state changes.
   */
  onStateChange(callback: (state: RemoteSessionState) => void): void;

  /**
   * Remove all registered callbacks and release resources.
   * Called on disconnect or adapter teardown.
   */
  removeAllListeners(): void;
}
