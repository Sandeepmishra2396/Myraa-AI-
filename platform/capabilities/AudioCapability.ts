/**
 * MYRAA Platform — AudioCapability Interface
 * Phase 15
 *
 * Defines the typed contract for platform voice audio capabilities.
 * This interface is implemented by:
 *   • DesktopCapabilityAdapter  — delegates to Web Audio API + MyraAudioSession
 *   • AndroidCapabilityAdapter  — delegates to AudioRecord + AudioTrack (Phase 16)
 *
 * AUDIO SPECIFICATION (enforced by MYRAA Gemini Live bridge):
 *   Input  (capture) : 16,000 Hz · 16-bit linear PCM · mono · little-endian
 *   Output (playback): 24,000 Hz · 16-bit linear PCM · mono · little-endian
 *   Encoding         : base64 string chunks over WebSocket JSON frames
 *
 * CONTRACT INVARIANT: The MYRAA Core server (GeminiSessionFactory.ts) expects
 * audio input as { audio: "<base64_pcm16_16khz>" } WebSocket frames and emits
 * audio output as { audio: "<base64_pcm16_24khz>" } frames. Adapters MUST
 * honour these exact formats — no resampling is performed server-side.
 */

// ---------------------------------------------------------------------------
// Audio Frame Types
// ---------------------------------------------------------------------------

/**
 * A single captured audio chunk ready for transmission to MYRAA Core.
 * `pcm16Base64` is the base64-encoded little-endian 16-bit PCM at 16,000 Hz.
 */
export interface CapturedAudioFrame {
  /** Base64-encoded PCM16 LE at 16,000 Hz, mono. */
  pcm16Base64: string;
  /** Wall-clock timestamp (ms since epoch) when this frame was captured. */
  capturedAtMs: number;
  /** Duration of this chunk in milliseconds (e.g., 20 ms for a 320-sample chunk). */
  durationMs: number;
}

/**
 * A single decoded audio chunk received from MYRAA Core for playback.
 * `pcm16Base64` is the base64-encoded little-endian 16-bit PCM at 24,000 Hz.
 */
export interface PlaybackAudioFrame {
  /** Base64-encoded PCM16 LE at 24,000 Hz, mono. */
  pcm16Base64: string;
}

// ---------------------------------------------------------------------------
// Audio Capture Capability
// ---------------------------------------------------------------------------

/** Options for starting an audio capture session. */
export interface AudioCaptureOptions {
  /** Requested sample rate in Hz. MUST be 16000 to match MYRAA Core expectation. */
  sampleRateHz: 16000;
  /** Chunk size in milliseconds per captured frame (recommended: 20 ms). */
  chunkDurationMs?: number;
}

/**
 * ICaptureAudio — Platform-independent microphone capture contract.
 *
 * Desktop implementation: Web Audio API + ScriptProcessorNode / AudioWorklet
 *   (existing in src/lib/audio.ts — MyraAudioSession already fulfils this).
 *
 * Android implementation (Phase 16): android.media.AudioRecord API
 *   with AudioRecord.Builder, 16kHz, PCM_16BIT, CHANNEL_IN_MONO.
 */
export interface ICaptureAudio {
  /**
   * Start continuous microphone capture.
   * Calls `onFrame` for each captured chunk.
   * @throws PlatformCapabilityError if microphone permission is denied.
   */
  startCapture(options: AudioCaptureOptions, onFrame: (frame: CapturedAudioFrame) => void): Promise<void>;

  /**
   * Stop microphone capture and release the audio input device.
   * Safe to call even if capture is not running.
   */
  stopCapture(): Promise<void>;

  /** Whether microphone capture is currently active. */
  readonly isCapturing: boolean;
}

// ---------------------------------------------------------------------------
// Audio Playback Capability
// ---------------------------------------------------------------------------

/** Options for initializing the playback pipeline. */
export interface AudioPlaybackOptions {
  /** Sample rate in Hz. MUST be 24000 to match MYRAA Core output. */
  sampleRateHz: 24000;
  /** Maximum internal ring buffer capacity in milliseconds (default: 2000 ms). */
  bufferCapacityMs?: number;
}

/**
 * IPlaybackAudio — Platform-independent audio playback contract.
 *
 * Desktop implementation: Web Audio API PCM → AudioBuffer → AudioBufferSourceNode
 *   (existing in src/lib/audio.ts — MyraAudioSession._playAudioChunk already fulfils this).
 *
 * Android implementation (Phase 16): android.media.AudioTrack API
 *   with AudioTrack.Builder, 24kHz, PCM_16BIT, CHANNEL_OUT_MONO, MODE_STREAM.
 */
export interface IPlaybackAudio {
  /**
   * Initialize the playback pipeline.
   * Must be called before enqueueAudioFrame.
   */
  initPlayback(options: AudioPlaybackOptions): Promise<void>;

  /**
   * Enqueue a decoded PCM frame for playback.
   * Implementation must handle jitter buffering internally.
   * Frames are played back in order of enqueue.
   */
  enqueueAudioFrame(frame: PlaybackAudioFrame): void;

  /**
   * Drain any buffered audio and stop playback.
   * Safe to call even if playback was not started.
   */
  drain(): Promise<void>;

  /** Whether the playback pipeline is initialized. */
  readonly isInitialized: boolean;

  /** Current estimated buffered audio duration in milliseconds. */
  readonly bufferedDurationMs: number;
}
