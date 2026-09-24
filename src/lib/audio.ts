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
  /** Maximum reconnect attempts before giving up. */
  private readonly MAX_RECONNECT_ATTEMPTS = 5;
  /** Base delay in ms. Doubles each attempt: 1s, 2s, 4s, 8s, 16s. */
  private readonly RECONNECT_BASE_DELAY_MS = 1000;
  /** Timer handle for a pending reconnect. */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private onNotification?: (notification: any) => void;
  private token?: string;

  constructor(handlers: {
    onStateChange: (state: LiveState) => void;
    onTranscription: (role: "user" | "model", text: string) => void;
    onToolCall: (name: string, args: any, callback: (result: any) => void) => void;
    onError: (error: string) => void;
    onMemorySync?: (memories: any[]) => void;
    onNotification?: (notification: any) => void;
    token?: string;
  }) {
    this.onStateChange = handlers.onStateChange;
    this.onTranscription = handlers.onTranscription;
    this.onToolCall = handlers.onToolCall;
    this.onError = handlers.onError;
    this.onMemorySync = handlers.onMemorySync;
    this.onNotification = handlers.onNotification;
    this.token = handlers.token;
  }

  private setState(state: LiveState) {
    this.currentState = state;
    this.onStateChange(state);
  }

  public getState(): LiveState {
    return this.currentState;
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
  // Safe to call multiple times — reconnect attempts reuse this path.
  public async connect() {
    if (this.isActivated) return;
    this.isActivated = true;
    this.isIntentionalClose = false;
    this.setState("connecting");

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
        console.error("[Myraa Audio] Microphone acquisition failed:", micError);
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
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const endpoint = this.token ? `/remote-live?token=${encodeURIComponent(this.token)}` : "/live";
      this.ws = new WebSocket(`${protocol}//${window.location.host}${endpoint}`);
      this.ws.binaryType = "blob";

      this.ws.onopen = () => {
        console.log("[Myraa] Connected to server side WS bridge");
        if (!this.isActivated) return;
        this.setState("listening");
      };

      this.ws.onmessage = this._handleWsMessage.bind(this);

      this.ws.onerror = (wsError) => {
        console.error("[Myraa WS] Transport error:", wsError);
        // onerror is always followed by onclose — let onclose handle the reconnect decision.
      };

      this.ws.onclose = (event) => {
        const code = event?.code ?? 0;
        const reason = event?.reason || "";
        console.log(`[Myraa WS] Connection closed (code=${code}, reason="${reason}", intentional=${this.isIntentionalClose})`);

        // Tear down only the WS + audio resources; do NOT call full disconnect() so
        // we can reconnect. The microphone and AudioContexts will be re-created on
        // the next connect() call.
        this._closeWsOnly();

        if (this.isIntentionalClose) {
          // User clicked Stop — do a clean full disconnect and stop here.
          this._cleanupAudio();
          this.setState("disconnected");
          return;
        }

        // Unexpected close: attempt auto-reconnect.
        this.scheduleReconnect();
      };

    } catch (e: any) {
      console.error("Connection establish sequence failed:", e);
      this.onError(e.message || "Failed to initialize active channel.");
      this._cleanupAudio();
      this.setState("disconnected");
      if (!this.isIntentionalClose) {
        this.scheduleReconnect();
      }
    }
  }

  /**
   * Attempts to re-establish the WebSocket connection with exponential backoff.
   * Does NOT auto-activate the microphone — the user must click the button again
   * after reconnect completes. This only restores the WS bridge to the server.
   */
  private scheduleReconnect(): void {
    if (this.isIntentionalClose) return;
    if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      console.warn(`[Myraa WS] Max reconnect attempts (${this.MAX_RECONNECT_ATTEMPTS}) reached. Giving up.`);
      this.onError(
        `Connection lost after ${this.MAX_RECONNECT_ATTEMPTS} reconnect attempts. ` +
        `Please check your network and tap the button to try again.`
      );
      this.setState("disconnected");
      return;
    }

    const delay = this.RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnectAttempts);
    this.reconnectAttempts += 1;

    console.log(`[Myraa WS] Reconnect attempt ${this.reconnectAttempts}/${this.MAX_RECONNECT_ATTEMPTS} in ${delay}ms...`);
    // Notify the UI so it can show a "reconnecting" indicator without activating the mic.
    this.onError(
      `RECONNECTING:${this.reconnectAttempts}/${this.MAX_RECONNECT_ATTEMPTS} (${Math.round(delay / 1000)}s)`
    );
    this.setState("connecting");

    // Cancel any previously scheduled timer.
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.isIntentionalClose) return;

      // Re-open only the WebSocket — no mic setup (isActivated=false so connect() runs).
      this.isActivated = false;

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const endpoint = this.token ? `/remote-live?token=${encodeURIComponent(this.token)}` : "/live";
      const wsUrl = `${protocol}//${window.location.host}${endpoint}`;
      console.log(`[Myraa WS] Reconnecting to ${wsUrl}...`);

      try {
        const ws = new WebSocket(wsUrl);
        ws.binaryType = "blob";
        this.ws = ws;

        ws.onopen = () => {
          if (this.isIntentionalClose) {
            try { ws.close(); } catch (e) {}
            return;
          }
          console.log("[Myraa WS] Reconnected to server bridge successfully.");
          this.reconnectAttempts = 0; // reset counter on success
          this.isActivated = true;
          // Stay in "connecting" until server sends { type:"status", status:"connected" }
        };

        ws.onmessage = this._handleWsMessage.bind(this);

        ws.onerror = () => {
          // Will be followed by onclose, handled there.
        };

        ws.onclose = (event) => {
          const code = event?.code ?? 0;
          const reason = event?.reason || "";
          console.log(`[Myraa WS] Reconnect WS closed (code=${code}, reason="${reason}")`);
          this._closeWsOnly();
          if (!this.isIntentionalClose) {
            this.scheduleReconnect();
          } else {
            this._cleanupAudio();
            this.setState("disconnected");
          }
        };

      } catch (err: any) {
        console.error("[Myraa WS] Reconnect failed to create WebSocket:", err);
        this.scheduleReconnect();
      }
    }, delay);
  }

  // Interruption triggers: stops all active audio players immediately
  private handleInterruption() {
    console.log("[Audio] Interruption signal received; flushing play logs.");
    
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
    
    // Set state back to user listening
    this.setState("listening");
  }

  // Direct raw PCM chunk scheduled playback at 24kHz
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
      
      // Gapless scheduler sync
      if (this.activeSources.length === 0) {
        // Initial burst: 25ms lead time so subsequent packets queue seamlessly
        this.nextStartTime = currentTime + 0.025;
      } else if (this.nextStartTime < currentTime) {
        // Network catch-up: resume immediately at currentTime with zero inserted silence gap
        this.nextStartTime = currentTime;
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

    // Cancel any pending reconnect timer.
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempts = 0;

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
    this.isActivated = false;
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
      const data = JSON.parse(event.data);

      // Root Error Handler message
      if (data.type === "error") {
        this.onError(data.error);
        // Fatal server-side error: do a full intentional disconnect so we don't loop.
        this.disconnect();
        return;
      }

      // Handle server-side states
      if (data.type === "status") {
        console.log("[Myraa WS Status]:", data.status);
        if (data.status === "connecting_gemini") {
          // Waiting or rotating Gemini Live connection — no state change needed
        } else if (data.status === "connected") {
          this.setState("listening");
        } else if (data.status === "session_closed") {
          if (data.reason && !/normal|goaway|duration|timeout|1000|power button|clean/i.test(data.reason)) {
            console.warn("[Myraa WS] Gemini session closed:", data.code, data.reason);
            this.onError(`Gemini Live closed: ${data.reason}`);
          } else {
            console.log("[Myraa WS] Gemini session closed cleanly:", data.reason || "Normal close");
          }
          // Use _closeWsOnly so isIntentionalClose stays false and auto-reconnect works
          this._closeWsOnly();
          this.isActivated = false;
          this.scheduleReconnect();
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
          }
        }, 100);
      }

      // Handle live captions transcription
      if (data.type === "transcription") {
        this.onTranscription(data.role, data.text);
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
