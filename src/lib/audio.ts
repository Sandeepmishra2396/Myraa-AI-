/**
 * Audio handling utility for Myraa Live API Voice stream.
 * Handles:
 * - 16kHz layout sampling for microphone stream.
 * - Raw Little Endian Int16 PCM translation.
 * - 24kHz layout output sampling for model voice playback.
 * - Gapless double-buffer queue scheduler.
 * - Interrupt signal immediate stop.
 * - Input & Output AnalyserNodes for real-time waveform visuals.
 */

import {
  getValidRemoteWsToken,
  getAccessTokenExpiryInfo,
  StoredRemoteSession,
} from "./remoteAuth";
import {
  CanonicalConnectionState,
  SafeDiagnosticMetadata,
  RemoteReconnectController,
  sanitizeDiagnosticString,
} from "./connectionStateMachine";

export type LiveState = "disconnected" | "connecting" | "listening" | "speaking";

// PCM Conversion Helper: converts Float32Array [-1.0, 1.0] to signed Int16 Raw PCM Little Endian
function floatTo16BitPCM(input: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(input.length * 2);
  const view = new DataView(buffer);
  let offset = 0;
  for (let i = 0; i < input.length; i++, offset += 2) {
    let s = Math.max(-1, Math.min(1, input[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  return buffer;
}

// Float conversion helper: converts signed Int16 array buffer to Float32Array [-1.0, 1.0]
function pcm16ToFloats(uint8Array: Uint8Array): Float32Array {
  const int16 = new Int16Array(
    uint8Array.buffer,
    uint8Array.byteOffset,
    uint8Array.byteLength / 2
  );
  const floats = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    floats[i] = int16[i] / 32768.0;
  }
  return floats;
}

// Convert ArrayBuffer to Base64 String
function base64ArrayBuffer(arrayBuffer: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(arrayBuffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}

// Convert Base64 string to Uint8Array
function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = window.atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

export class MyraAudioSession {
  private ws: WebSocket | null = null;
  
  // Audios contexts (separate to match exact required sample rates)
  private inputAudioCtx: AudioContext | null = null;
  private outputAudioCtx: AudioContext | null = null;
  
  // Audio sources & processors
  private micStream: MediaStream | null = null;
  private micSourceNode: MediaStreamAudioSourceNode | null = null;
  // AudioWorkletNode replaces the deprecated ScriptProcessorNode
  private micWorkletNode: AudioWorkletNode | null = null;
  
  // Visualisers
  public inputAnalyser: AnalyserNode | null = null;
  public outputAnalyser: AnalyserNode | null = null;
  private outputGainNode: GainNode | null = null;
  
  // Buffering / Playback details
  private nextStartTime = 0;
  private activeSources: AudioBufferSourceNode[] = [];
  private consecutiveSpeechFrames = 0;
  private audioChunksCount = 0;
  /** Timestamp (ms) of last VAD barge-in trigger — used for echo cooldown gate. */
  private _lastBargeInTime = 0;

  
  // State Callbacks
  private onStateChange: (state: LiveState) => void;
  private onTranscription: (role: "user" | "model", text: string) => void;
  private onToolCall: (name: string, args: any, callback: (result: any) => void) => void;
  private onError: (error: string) => void;
  private onMemorySync?: (memories: any[]) => void;
  
  private currentState: LiveState = "disconnected";
  private isActivated = false;

  // ── Auto-reconnect state ─────────────────────────────────────────────────
  /**
   * True when disconnect() was called explicitly by the user (button press).
   * In that case we do NOT attempt to reconnect automatically.
   */
  private isIntentionalClose = false;
  /** How many consecutive reconnect attempts have been made. */
  private reconnectAttempts = 0;
  /** Maximum reconnect attempts before giving up. 10 × exponential (capped at 30s) = ~3 minutes — enough to survive a Render deployment restart (60–120s). */
  private readonly MAX_RECONNECT_ATTEMPTS = 10;
  /** Base delay in ms. Doubles each attempt (capped at 30s): 1s, 2s, 4s, 8s, 16s, 30s, 30s… */
  private readonly RECONNECT_BASE_DELAY_MS = 1000;
  /** Keepalive ping interval — prevents Render's proxy from timing out idle WebSocket connections after 30 min. */
  private readonly KEEPALIVE_INTERVAL_MS = 25000;
  /** Active keepalive timer handle. Cleared in _closeWsOnly(). */
  private _keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  /** Canonical Reconnect Controller & State Machine */
  private reconnectController: RemoteReconnectController;
  /** Last observed WebSocket close code (e.g. 1006 after Render sleep/restart) */
  private lastCloseCode: number | null = null;

  private onNotification?: (notification: any) => void;
  private onSessionUpdate?: (updated: StoredRemoteSession) => void;
  private onConnectionStateChange?: (state: CanonicalConnectionState) => void;
  private token?: string;

  constructor(handlers: {
    onStateChange: (state: LiveState) => void;
    onTranscription: (role: "user" | "model", text: string) => void;
    onToolCall: (name: string, args: any, callback: (result: any) => void) => void;
    onError: (error: string) => void;
    onMemorySync?: (memories: any[]) => void;
    onNotification?: (notification: any) => void;
    onSessionUpdate?: (updated: StoredRemoteSession) => void;
    onConnectionStateChange?: (state: CanonicalConnectionState) => void;
    token?: string;
  }) {
    this.onStateChange = handlers.onStateChange;
    this.onTranscription = handlers.onTranscription;
    this.onToolCall = handlers.onToolCall;
    this.onError = handlers.onError;
    this.onMemorySync = handlers.onMemorySync;
    this.onNotification = handlers.onNotification;
    this.onSessionUpdate = handlers.onSessionUpdate;
    this.onConnectionStateChange = handlers.onConnectionStateChange;
    this.token = handlers.token;

    this.reconnectController = new RemoteReconnectController({
      maxAttempts: this.MAX_RECONNECT_ATTEMPTS,
      baseDelayMs: this.RECONNECT_BASE_DELAY_MS,
      maxDelayMs: 30000,
      onStateChange: (state) => {
        if (this.onConnectionStateChange) {
          this.onConnectionStateChange(state);
        }
      },
      onHeartbeatTimeout: () => {
        console.warn("[Myraa WS] Client heartbeat timeout detected; cycling dead socket for clean reconnect.");
        this._closeWsOnly();
        this.scheduleReconnect(4000, "HEARTBEAT_TIMEOUT: pong timeout");
      },
    });
  }

  private setState(state: LiveState) {
    this.currentState = state;
    this.onStateChange(state);
  }

  public getState(): LiveState {
    return this.currentState;
  }

  public getCanonicalConnectionState(): CanonicalConnectionState {
    return this.reconnectController.getState();
  }

  public getConnectionSnapshot(): SafeDiagnosticMetadata {
    const wsState = !this.ws
      ? "CLOSED"
      : this.ws.readyState === WebSocket.CONNECTING
      ? "CONNECTING"
      : this.ws.readyState === WebSocket.OPEN
      ? "OPEN"
      : "CLOSING";
    return this.reconnectController.getDiagnostics(wsState);
  }

  public setToken(token: string): void {
    this.token = token;
  }

  /**
   * Pushes a compressed JPEG base64 screenshot frame directly to the live WebSocket server.
   */
  public sendVideoFrame(base64Data: string) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.currentState !== "disconnected") {
      this.ws.send(JSON.stringify({ type: "video", video: base64Data }));
    }
  }

  // Requests microphone and creates connections.
  // Safe to call multiple times — single-flight guarded so duplicate sockets cannot spawn.
  public async connect() {
    if (this.isActivated || this.reconnectController.hasAttemptInFlight()) return;
    this.isActivated = true;
    this.isIntentionalClose = false;
    this.lastCloseCode = null;
    this.setState("connecting");

    // Clean up any lingering previous session audio resources before acquiring a fresh stream
    this._cleanupAudio();

    try {
      // 1. Acquire microphone stream directly within the user click gesture context.
      // Calling getUserMedia here preserves the user gesture token so Chrome/Edge
      // reliably presents the native permission prompt instead of auto-denying.
      let stream: MediaStream;
      try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          throw new Error("Your browser does not support microphone access (navigator.mediaDevices.getUserMedia missing).");
        }

        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
      } catch (micError: any) {
        console.error("[Myraa Audio] Microphone acquisition failed:", sanitizeDiagnosticString(micError?.message || String(micError)));
        this.isActivated = false;
        this.setState("disconnected");

        const isDenied =
          micError.name === "NotAllowedError" ||
          micError.name === "PermissionDeniedError" ||
          /permission denied/i.test(micError.message || "");

        const isNotFound =
          micError.name === "NotFoundError" ||
          micError.name === "DevicesNotFoundError";

        if (isDenied) {
          this.onError(
            "Microphone permission was blocked! In your browser, click the 🔒 (lock) icon next to localhost:3000 in the address bar, set Microphone to 'Allow', then refresh and click the power button."
          );
        } else if (isNotFound) {
          this.onError(
            "No microphone device was detected on your computer. Please plug in a microphone or headset and try again."
          );
        } else {
          this.onError(
            `Microphone error: ${micError.message || "Failed to initialize audio input"}. Check your browser and Windows microphone privacy settings.`
          );
        }
        return;
      }

      this.micStream = stream;

      // 2. Safe, cross-browser AudioContext initialization
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioContextClass) {
        this.onError("Holographic audio link unsupported: Web Audio API missing in browser.");
        this._cleanupAudio();
        this.isActivated = false;
        this.setState("disconnected");
        return;
      }

      this.inputAudioCtx = new AudioContextClass({ sampleRate: 16000 });
      this.outputAudioCtx = new AudioContextClass({ sampleRate: 24000 });

      // Ensure Audio Contexts are active and resumed to bypass browser security blocks
      if (this.inputAudioCtx.state === "suspended") {
        await this.inputAudioCtx.resume().catch(() => {});
      }
      if (this.outputAudioCtx.state === "suspended") {
        await this.outputAudioCtx.resume().catch(() => {});
      }

      // Setup custom output Analyser & Volume Gains
      this.outputGainNode = this.outputAudioCtx.createGain();
      this.outputAnalyser = this.outputAudioCtx.createAnalyser();
      this.outputAnalyser.fftSize = 256;
      this.outputAnalyser.smoothingTimeConstant = 0.8;

      this.outputGainNode.connect(this.outputAnalyser);
      this.outputAnalyser.connect(this.outputAudioCtx.destination);

      // Setup custom input Analyser
      this.inputAnalyser = this.inputAudioCtx.createAnalyser();
      this.inputAnalyser.fftSize = 256;

      if (!this.micStream) {
        throw new Error("Microphone stream is not available.");
      }
      this.micSourceNode = this.inputAudioCtx.createMediaStreamSource(this.micStream);
      this.micSourceNode.connect(this.inputAnalyser);

      // Load the AudioWorklet processor module from the public directory
      await this.inputAudioCtx.audioWorklet.addModule("/mic-processor.worklet.js");

      // Create the worklet node (replaces the deprecated ScriptProcessorNode)
      this.micWorkletNode = new AudioWorkletNode(this.inputAudioCtx, "myraa-mic-processor");

      let micFramesSent = 0;
      this.micWorkletNode.port.onmessage = (e: MessageEvent) => {
        if (this.currentState === "disconnected" || this.currentState === "connecting") return;
        const channelData: Float32Array = e.data.channelData;

        // Local VAD energy check for immediate client-side barge-in.
        if (this.activeSources.length > 0 || this.currentState === "speaking") {
          const now = Date.now();
          const cooldownMs = 600;
          const lastInterruptTime: number = this._lastBargeInTime;

          if (now - lastInterruptTime > cooldownMs) {
            let sumSquares = 0;
            for (let i = 0; i < channelData.length; i++) {
              sumSquares += channelData[i] * channelData[i];
            }
            const rms = Math.sqrt(sumSquares / channelData.length);
            if (rms > 0.15) {
              this.consecutiveSpeechFrames++;
              if (this.consecutiveSpeechFrames >= 4) {
                console.log(
                  `[Myraa Audio] Local speech barge-in detected (RMS: ${rms.toFixed(3)}). Flushing active playback queue immediately.`
                );
                this._lastBargeInTime = Date.now();
                this.handleInterruption();
                this.consecutiveSpeechFrames = 0;
              }
            } else {
              this.consecutiveSpeechFrames = 0;
            }
          } else {
            // In cooldown window — ignore mic frames to prevent echo re-trigger
            this.consecutiveSpeechFrames = 0;
          }
        } else {
          this.consecutiveSpeechFrames = 0;
        }

        const pcmBuffer = floatTo16BitPCM(channelData);
        const base64 = base64ArrayBuffer(pcmBuffer);

        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          micFramesSent++;
          if (micFramesSent === 1 || micFramesSent % 150 === 0) {
            console.log(`[Myraa Audio] Mic streaming frame #${micFramesSent}`);
          }
          this.ws.send(JSON.stringify({ audio: base64 }));
        }
      };

      // Route: mic source → worklet node → destination
      this.micSourceNode.connect(this.micWorkletNode);
      this.micWorkletNode.connect(this.inputAudioCtx.destination);

      // 3. Establish custom WebSocket server bridge now that audio hardware is ready
      await this._openWebSocketBridge(false);

    } catch (e: any) {
      console.error("Connection establish sequence failed:", sanitizeDiagnosticString(e?.message || String(e)));
      this.onError(e.message || "Failed to initialize active channel.");
      this._cleanupAudio();
      this.setState("disconnected");
      if (!this.isIntentionalClose) {
        this.scheduleReconnect(0, e?.message || "Connection establish sequence failed");
      }
    }
  }

  /**
   * Single-flight WebSocket bridge establishment used by both initial connect()
   * and automatic reconnects. Guarantees only 1 WebSocket attempt exists at a time,
   * validates/refreshes access tokens before connecting, and logs safe diagnostics.
   */
  private async _openWebSocketBridge(isReconnect: boolean): Promise<void> {
    if (this.isIntentionalClose) return;

    // Close any previous socket before starting a new attempt
    this._closeWsOnly();

    const { generation: attemptGen } = this.reconnectController.beginConnectAttempt(isReconnect);

    const isLocalHost =
      typeof window !== "undefined" &&
      (window.location.hostname === "localhost" ||
        window.location.hostname === "127.0.0.1" ||
        window.location.hostname === "::1");

    if (!isLocalHost) {
      try {
        const expiryInfo = getAccessTokenExpiryInfo();
        if (expiryInfo.isExpiringSoon || expiryInfo.isExpired) {
          this.reconnectController.setAuthMetadata(
            expiryInfo.isExpired ? "expired" : "expiring_soon",
            expiryInfo.expiresInSec
          );
          this.reconnectController.transitionTo("AUTH_EXPIRED", "CLOSED");
          this.reconnectController.setAuthMetadata("refreshing", expiryInfo.expiresInSec);
          this.reconnectController.transitionTo("REFRESHING_AUTH", "CLOSED");
        }
        // If the previous close was 1006 (e.g. Render wake-up or proxy rejection),
        // force a token refresh / fallback check so we don't reuse a stale session token.
        const forceRefresh = isReconnect && this.lastCloseCode === 1006;
        const validToken = await getValidRemoteWsToken(this.onSessionUpdate, { forceRefresh });
        if (validToken) {
          this.token = validToken;
        }
        const updatedExpiry = getAccessTokenExpiryInfo(this.token);
        this.reconnectController.setAuthMetadata(
          this.token?.startsWith("sora_dev_") ? "fallback_device_token" : "valid",
          updatedExpiry.expiresInSec
        );
      } catch {
        /* ignore and check safe fallback below */
      }
    }

    // Abort if disconnect() or a newer attempt occurred while awaiting token refresh
    if (this.isIntentionalClose || !this.reconnectController.isCurrentGeneration(attemptGen)) {
      return;
    }

    if (!isLocalHost && !this.token && typeof localStorage !== "undefined") {
      try {
        const raw = localStorage.getItem("sora_remote_session");
        if (raw) {
          const sess = JSON.parse(raw);
          const expiryInfo = getAccessTokenExpiryInfo(sess);
          // NEVER use an expired accessToken — fall back to durable device token (sora_dev_...)
          if (sess?.accessToken && !expiryInfo.isExpired) {
            this.token = sess.accessToken;
          } else if (sess?.token) {
            this.token = sess.token;
          }
        }
      } catch { /* ignore */ }
    }

    if (!isLocalHost && !this.token) {
      const err = "REMOTE_AUTH_REQUIRED: Non-localhost connections must authenticate via /remote-live with a paired device token.";
      console.warn(`[Myraa Audio] ${err}`);
      this.reconnectController.setAuthMetadata("unauthenticated", null);
      this.reconnectController.transitionTo("FAILED", "CLOSED");
      this.onError(err);
      this._cleanupAudio();
      this.isActivated = false;
      this.setState("disconnected");
      return;
    }

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const endpoint = isLocalHost && !this.token ? "/live" : "/remote-live";
    const wsUrl = `${protocol}//${window.location.host}${endpoint}`;
    const wsProtocols = this.token ? ["myraa-auth", this.token] : undefined;

    this.reconnectController.transitionTo("AUTHENTICATING", "CONNECTING");

    console.log(
      `[Myraa WS] ${isReconnect ? "Reconnecting" : "Connecting"} to ${endpoint} ` +
      `(authenticated=${Boolean(this.token)}, attempt=${this.reconnectAttempts}, state=${this.reconnectController.getState()})...`
    );

    try {
      const ws = wsProtocols ? new WebSocket(wsUrl, wsProtocols) : new WebSocket(wsUrl);
      ws.binaryType = "blob";
      this.ws = ws;

      ws.onopen = () => {
        if (this.isIntentionalClose || !this.reconnectController.isCurrentGeneration(attemptGen)) {
          try { ws.close(); } catch {}
          return;
        }
        console.log("[Myraa WS] Connected to server-side WS bridge (awaiting Gemini READY)");
        this.reconnectController.onSocketOpen();

        // Start keepalive ping — prevents Render's proxy from dropping idle WS after 30 min.
        if (this._keepaliveTimer !== null) {
          clearInterval(this._keepaliveTimer);
        }
        this._keepaliveTimer = setInterval(() => {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: "ping" }));
          }
        }, this.KEEPALIVE_INTERVAL_MS);

        this.reconnectController.startHeartbeat(() => {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: "ping" }));
          }
        });

        if (!isReconnect) {
          this.setState("listening");
        }
      };

      ws.onmessage = this._handleWsMessage.bind(this);

      ws.onerror = () => {
        // onerror is always followed by onclose — let onclose handle classification and reconnect.
      };

      ws.onclose = (event) => {
        if (!this.reconnectController.isCurrentGeneration(attemptGen)) {
          return;
        }
        const code = event?.code ?? 0;
        const rawReason = event?.reason || "";
        const safeReason = sanitizeDiagnosticString(rawReason);
        this.lastCloseCode = code;

        console.log(
          `[Myraa WS] Connection closed (code=${code}, reason="${safeReason}", ` +
          `intentional=${this.isIntentionalClose}, state=${this.reconnectController.getState()})`
        );

        this._closeWsOnly();

        if (code === 4401 || rawReason.includes("DEVICE_REVOKED") || rawReason.includes("Device revoked")) {
          this.reconnectController.triggerTerminalSecurityStop("DEVICE_REVOKED", safeReason || "Device revoked");
          this.onError("DEVICE_REVOKED: This device pairing has been revoked by the admin.");
          this._cleanupAudio();
          this.isActivated = false;
          this.setState("disconnected");
          return;
        }

        if (code === 4423 || rawReason.includes("LOCKDOWN") || rawReason.includes("Security Lockdown")) {
          this.reconnectController.triggerTerminalSecurityStop("SECURITY_LOCKDOWN", safeReason || "Security Lockdown active");
          this.onError("LOCKDOWN: Remote access is currently locked down by security policy.");
          this._cleanupAudio();
          this.isActivated = false;
          this.setState("disconnected");
          return;
        }

        if (this.isIntentionalClose) {
          this.reconnectController.markIntentionalDisconnect();
          this._cleanupAudio();
          this.isActivated = false;
          this.setState("disconnected");
          return;
        }

        this.scheduleReconnect(code, safeReason);
      };
    } catch (err: any) {
      console.error("[Myraa WS] Failed to create WebSocket:", sanitizeDiagnosticString(err?.message || String(err)));
      this.scheduleReconnect(0, err?.message || "WebSocket creation error");
    }
  }

  /**
   * Schedules a single-flight reconnect with exponential backoff + bounded jitter via
   * RemoteReconnectController. Backoff is only reset once the session reaches READY.
   */
  private scheduleReconnect(closeCode = 1006, closeReason = ""): void {
    if (this.isIntentionalClose) return;

    const decision = this.reconnectController.scheduleReconnect(
      closeCode,
      closeReason,
      async () => {
        if (this.isIntentionalClose) return;
        await this._openWebSocketBridge(true);
      }
    );

    this.reconnectAttempts = decision.attempt;

    if (!decision.scheduled) {
      console.warn(
        `[Myraa WS] Reconnect stopped (failureClass=${decision.failureClass}, attempts=${decision.attempt}/${this.MAX_RECONNECT_ATTEMPTS}).`
      );
      if (decision.failureClass === "MAX_RECONNECTS_EXCEEDED") {
        this.onError(
          `Connection lost after ${this.MAX_RECONNECT_ATTEMPTS} reconnect attempts. ` +
          `Please check your network and tap the button to try again.`
        );
      }
      this._cleanupAudio();
      this.isActivated = false;
      this.setState("disconnected");
      return;
    }

    console.log(
      `[Myraa WS] Reconnect attempt ${decision.attempt}/${this.MAX_RECONNECT_ATTEMPTS} ` +
      `scheduled in ${decision.delayMs}ms (failureClass=${decision.failureClass})...`
    );
    this.onError(
      `RECONNECTING:${decision.attempt}/${this.MAX_RECONNECT_ATTEMPTS} (${Math.max(1, Math.round(decision.delayMs / 1000))}s)`
    );
    this.setState("connecting");
  }

  // Interruption triggers: stops all active audio players immediately
  private handleInterruption() {
    if (this.activeSources.length > 0) {
      console.log(`[Myraa Audio] Interruption signal received; flushing ${this.activeSources.length} active playback sources.`);
    }
    
    // Stop all playing nodes
    this.activeSources.forEach((source) => {
      try {
        source.stop();
      } catch (err) {
        // Already finished or stopped
      }
    });
    this.activeSources = [];
    this.nextStartTime = 0;
    this.consecutiveSpeechFrames = 0;
    
    // Set state back to user listening
    this.setState("listening");
  }

  // Direct raw PCM chunk scheduled playback at 24kHz with runaway queue bounding
  private playAudioPCMChunk(base64Audio: string) {
    if (!this.outputAudioCtx || !this.outputGainNode) return;

    if (this.outputAudioCtx.state === "suspended") {
      this.outputAudioCtx.resume().catch(() => {});
    }

    try {
      this.setState("speaking");
      const uint8Array = base64ToUint8Array(base64Audio);
      const floats = pcm16ToFloats(uint8Array);

      // Create AudioBuffer of 24000Hz (the exact playback sample rate of Gemini outputs)
      const buffer = this.outputAudioCtx.createBuffer(1, floats.length, 24000);
      buffer.getChannelData(0).set(floats);

      // Create Buffer source
      const source = this.outputAudioCtx.createBufferSource();
      source.buffer = buffer;

      // Connect source to gain which is routed to analyser & speakers
      source.connect(this.outputGainNode);

      const currentTime = this.outputAudioCtx.currentTime;
      const queueAhead = this.nextStartTime - currentTime;

      // Gapless scheduler sync & runaway queue prevention.
      // 1-3s of queue ahead is NORMAL for streaming — Web Audio API handles it natively.
      // Do NOT trim nodes in that range: resetting nextStartTime while nodes are pending
      // causes those nodes to play simultaneously with the next chunk (double voice).
      if (this.activeSources.length === 0) {
        // Fresh start — 25ms lead so subsequent packets queue seamlessly
        this.nextStartTime = currentTime + 0.025;
      } else if (this.nextStartTime < currentTime) {
        // Network catch-up — cursor fell behind hardware clock, start immediately
        this.nextStartTime = currentTime;
      } else if (queueAhead > 10) {
        // Severe safety flush only — >10s queue means something is genuinely stuck.
        console.warn(`[Myraa Audio] Queue severely drifted (${queueAhead.toFixed(2)}s, ${this.activeSources.length} nodes). Flushing.`);
        this.activeSources.forEach((s) => { try { s.stop(); } catch {} });
        this.activeSources = [];
        this.nextStartTime = currentTime + 0.05;
      }

      this.audioChunksCount++;

      if (this.audioChunksCount === 1 || this.audioChunksCount % 50 === 0) {
        console.log(
          `[Myraa Audio Latency Diag] Chunk #${this.audioChunksCount}: Active nodes: ${this.activeSources.length}, Queue ahead: ${Math.max(0, this.nextStartTime - currentTime).toFixed(2)}s, Hardware clock: ${currentTime.toFixed(2)}s`
        );
      }

      source.start(this.nextStartTime);
      this.nextStartTime += buffer.duration;

      // Keep reference to handle real-time interruptions
      source.onended = () => {
        const index = this.activeSources.indexOf(source);
        if (index > -1) {
          this.activeSources.splice(index, 1);
        }
        
        // If there are no more active play nodes, revert state back to listening
        if (this.activeSources.length === 0 && this.currentState === "speaking") {
          this.setState("listening");
        }
      };

      this.activeSources.push(source);

    } catch (playbackError) {
      console.error("PCM Chunk buffering/playback failed:", playbackError);
    }
  }


  // Fully cleanup and release microphones & connection sockets.
  // Call this when the user intentionally stops the session.
  public disconnect() {
    this.isIntentionalClose = true;
    this.isActivated = false;
    this.reconnectAttempts = 0;

    this.reconnectController.markIntentionalDisconnect();
    this._closeWsOnly();
    this._cleanupAudio();
    this.setState("disconnected");
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  /**
   * Closes only the WebSocket without touching audio resources.
   * Used internally so reconnect can reopen WS without re-requesting the mic.
   */
  private _closeWsOnly(): void {
    this.reconnectController.stopHeartbeat();
    // Stop keepalive ping — must be cleared before the WS is nulled.
    if (this._keepaliveTimer !== null) {
      clearInterval(this._keepaliveTimer);
      this._keepaliveTimer = null;
    }
    if (this.ws) {
      try {
        // Null out handlers first so the onclose callback isn't invoked recursively.
        this.ws.onopen = null;
        this.ws.onmessage = null;
        this.ws.onerror = null;
        this.ws.onclose = null;
        this.ws.close();
      } catch (e) {}
      this.ws = null;
    }
  }

  /**
   * Releases microphone streams and AudioContext resources.
   * Called on intentional disconnect or after all reconnect attempts fail.
   */
  private _cleanupAudio(): void {
    // Stop and release user microphone streams
    if (this.micStream) {
      this.micStream.getTracks().forEach((track) => {
        try { track.stop(); } catch (e) {}
      });
      this.micStream = null;
    }

    // Disconnect and clean up the AudioWorklet node
    if (this.micWorkletNode) {
      try {
        this.micWorkletNode.port.onmessage = null;
        this.micWorkletNode.disconnect();
      } catch (e) {}
      this.micWorkletNode = null;
    }

    if (this.micSourceNode) {
      try { this.micSourceNode.disconnect(); } catch (e) {}
      this.micSourceNode = null;
    }

    // Close Audio contexts
    if (this.inputAudioCtx) {
      try { this.inputAudioCtx.close(); } catch (e) {}
      this.inputAudioCtx = null;
    }

    if (this.outputAudioCtx) {
      try { this.outputAudioCtx.close(); } catch (e) {}
      this.outputAudioCtx = null;
    }

    this.activeSources = [];
    this.nextStartTime = 0;
    this.inputAnalyser = null;
    this.outputAnalyser = null;
    this.outputGainNode = null;
  }

  /**
   * Shared WebSocket message handler — used by both the initial connection and
   * any reconnect WebSocket so behaviour is identical.
   */
  private async _handleWsMessage(event: MessageEvent): Promise<void> {
    try {
      this.reconnectController.recordHeartbeat();
      const data = JSON.parse(event.data);

      if (data.type === "pong") {
        if (data.geminiState) {
          this.reconnectController.setGeminiState(data.geminiState);
        }
        return;
      }

      // Root Error Handler message
      if (data.type === "error") {
        const rawErr = String(data.error || "Unknown server error");
        const safeErr = sanitizeDiagnosticString(rawErr);
        if (/DEVICE_REVOKED|Device revoked/i.test(rawErr)) {
          this.reconnectController.triggerTerminalSecurityStop("DEVICE_REVOKED", safeErr);
        } else if (/LOCKDOWN|Security Lockdown/i.test(rawErr)) {
          this.reconnectController.triggerTerminalSecurityStop("SECURITY_LOCKDOWN", safeErr);
        } else if (/EMERGENCY_STOP|Emergency Stop/i.test(rawErr)) {
          this.reconnectController.triggerTerminalSecurityStop("EMERGENCY_STOP", safeErr);
        }
        this.onError(rawErr);
        // Fatal server-side error: do a full intentional disconnect so we don't loop.
        this.disconnect();
        return;
      }

      // Handle server-side states
      if (data.type === "status") {
        console.log("[Myraa WS Status]:", data.status);
        if (data.status === "connecting_gemini") {
          this.reconnectController.setGeminiState("STARTING_GEMINI");
        } else if (data.status === "recreating_gemini") {
          this.reconnectController.setGeminiState("RECREATING");
        } else if (data.status === "connected" || data.status === "gemini_recreated") {
          this.reconnectAttempts = 0;
          this.reconnectController.markStableReady();
          this.setState("listening");
        } else if (data.status === "gemini_degraded") {
          this.reconnectController.setGeminiState("DEGRADED");
          console.warn(
            "[Myraa WS] Gemini Live degraded; MYRAA WebSocket stays connected and will recreate Gemini on next input."
          );
        } else if (data.status === "session_closed") {
          const safeReason = sanitizeDiagnosticString(data.reason || "Normal close");
          if (data.reason && !/normal|goaway|duration|timeout|1000|power button|clean/i.test(data.reason)) {
            console.warn("[Myraa WS] Gemini session closed:", data.code, safeReason);
          } else {
            console.log("[Myraa WS] Gemini session closed cleanly:", safeReason);
          }
          // DECOUPLED ARCHITECTURE:
          // If the MYRAA /remote-live WebSocket is still OPEN, do NOT tear down the
          // authenticated WebSocket session! Request in-place Gemini Live recreation.
          if (this.ws && this.ws.readyState === WebSocket.OPEN && !this.isIntentionalClose) {
            this.reconnectController.setGeminiState("RECREATING");
            this.ws.send(JSON.stringify({ type: "recreate_gemini" }));
          } else if (!this.isIntentionalClose) {
            this._closeWsOnly();
            this.scheduleReconnect(data.code ?? 1006, safeReason);
          }
        }
        return;
      }

      // Handle audio payload (24kHzPCM model response)
      if (data.type === "audio" && data.audio) {
        console.log(`[Myraa Audio] Playing model speech chunk (${data.audio.length} chars)`);
        this.playAudioPCMChunk(data.audio);
      }

      // Handle interruption signal (e.g. user talked over Myraa)
      if (data.type === "interrupted") {
        this.handleInterruption();
      }

      // Turn complete
      if (data.type === "turnComplete") {
        // Once Myraa completes speaking, change visual state back to listening
        setTimeout(() => {
          if (this.activeSources.length === 0 && this.currentState === "speaking") {
            this.setState("listening");
            this.nextStartTime = 0;
          }
        }, 100);
      }

      // Handle live captions transcription
      if (data.type === "transcription") {
        this.onTranscription(data.role, data.text);
        if (data.role === "user" && this.activeSources.length > 0) {
          const now = Date.now();
          if (now - this._lastBargeInTime > 600) {
            console.log("[Myraa Audio] User speech recognized by model; clearing lingering playback sources.");
            this._lastBargeInTime = now;
            this.handleInterruption();
          }
        }
      }

      // Handle memory synchronization
      if (data.type === "memory_sync" && data.memories) {
        if (this.onMemorySync) {
          this.onMemorySync(data.memories);
        }
      }

      // Handle companion / emergency stop / proactive notifications
      if (data.type === "companion_notification" || data.type === "emergency_stop" || data.type === "notification") {
        if (this.onNotification) {
          this.onNotification(data);
        }
        if (data.type === "emergency_stop") {
          this.reconnectController.triggerTerminalSecurityStop("EMERGENCY_STOP", "Emergency stop triggered");
          this.disconnect();
          return;
        }
      }

      // Handle Tool Calling
      if (data.type === "toolCall") {
        const { callId, name, args } = data;
        this.onToolCall(name, args, (result) => {
          // Send back execution result to server bridge
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({
              type: "toolResponse",
              id: callId,
              name: name,
              output: result
            }));
          }
        });
      }

      // Handle Cross-Device Desktop Tool Call (dispatched from remote/mobile companion)
      if (data.type === "desktop_tool_call") {
        const { callId, name, args } = data;
        console.log(`[Myraa Audio] Received desktop tool call via bridge: ${name}`);
        this.onToolCall(name, args, (result) => {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({
              type: "desktop_tool_response",
              id: callId,
              name: name,
              ok: result?.ok !== false && !result?.error,
              result: result?.result ?? result,
              error: result?.error,
            }));
          }
        });
      }

    } catch (parseError) {
      console.error("[Myraa WS] Error reading server packet:", parseError);
    }
  }

  /**
   * Sends a user text message to the live session bridge.
   */
  public sendTextMessage(text: string): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "text", text }));
      return true;
    }
    return false;
  }
}
