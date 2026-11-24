/**
 * MYRAA — ConversationManager
 *
 * Manages the full lifecycle of a single client WebSocket connection to the
 * /live and /remote-live endpoints:
 *
 *   1. Validates the API key
 *   2. Restores bounded safe conversation context from RemoteStore snapshot
 *   3. Opens a Gemini Live session via GeminiSessionFactory (decoupled from WS)
 *   4. Responds to application-level ping heartbeats with pong + geminiState
 *   5. Forwards client messages (audio PCM, video frames, text, toolResponses)
 *   6. Handles seamless GoAway rotation and transient Gemini Live recreation
 *      without dropping the authenticated MYRAA WebSocket session
 *   7. Cleans up on client disconnect
 */

import { resolveApiKeyWithMetadata } from "../server_paths.ts";
import {
  GeminiSessionFactory,
  classifyGeminiLiveCloseError,
  invalidateInstructionsCache,
  sanitizeGeminiErrorReason,
} from "../ai/GeminiSessionFactory.ts";
import { remoteSessionManager } from "../remote/RemoteSessionManager.ts";
import { remoteStore } from "../remote/RemoteStore.ts";
import type { GeminiSessionState } from "../../frontend/lib/connectionStateMachine.ts";
import { desktopSecurityGate } from "../security/DesktopSecurityGate.ts";
import type { IdentityRole } from "../security/SecurityTypes.ts";

// ---------------------------------------------------------------------------
// SEC-P4-A01: Canonical Base64 / PCM Validation & Bounded Audio Ring Buffer
// ---------------------------------------------------------------------------

export interface QueuedAudioFrame {
  data: string;          // Canonical Base64-encoded PCM string
  pcmByteLength: number; // Exact decoded PCM byte count (standard frame: 4,096 bytes)
  epoch: number;         // Context generation epoch
  sequence: number;      // Monotonic sequence number
  timestamp: number;     // Ingress timestamp (Date.now())
}

export type AudioValidationErrorReason =
  | "OVERSIZED_FRAME"
  | "INVALID_FORMAT"
  | "MALFORMED_PADDING";

export type EnqueueFailureReason = AudioValidationErrorReason | "QUEUE_FULL";

export type EnqueueResult =
  | { success: true; enqueuedCount: number; frame: QueuedAudioFrame }
  | { success: false; reason: EnqueueFailureReason };

export type AudioFrameValidationResult =
  | { valid: true; pcmByteLength: number; charLength: number }
  | { valid: false; reason: AudioValidationErrorReason };

const CANONICAL_BASE64_REGEX = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Validates a Base64-encoded 16 kHz mono 16-bit PCM audio frame.
 * Enforces canonical Base64 encoding, exact padding subtraction matched against
 * Buffer.byteLength(), 16-bit sample boundary (even byte count), and the
 * 4,096-byte (5,464 Base64 char) standard frame ceiling.
 */
export function validatePcmBase64Frame(base64Data: unknown): AudioFrameValidationResult {
  if (!base64Data || typeof base64Data !== "string") {
    return { valid: false, reason: "INVALID_FORMAT" };
  }

  const charLen = base64Data.length;
  if (charLen > BoundedAudioRingBuffer.STANDARD_FRAME_B64_CHARS) {
    return { valid: false, reason: "OVERSIZED_FRAME" };
  }

  // Canonical Base64 validation: divisible by 4, valid alphabet, max 2 trailing '='
  if (charLen === 0 || charLen % 4 !== 0 || !CANONICAL_BASE64_REGEX.test(base64Data)) {
    return { valid: false, reason: "MALFORMED_PADDING" };
  }

  // Exact decoded PCM byte length via padding subtraction
  let padding = 0;
  if (base64Data.endsWith("==")) padding = 2;
  else if (base64Data.endsWith("=")) padding = 1;
  const pcmBytes = (charLen * 3) / 4 - padding;

  // Verify strict canonical Base64 round-trip and exact Buffer.byteLength agreement
  const decoded = Buffer.from(base64Data, "base64");
  const bufferByteLen = Buffer.byteLength(base64Data, "base64");
  if (
    decoded.length !== pcmBytes ||
    bufferByteLen !== pcmBytes ||
    decoded.toString("base64") !== base64Data
  ) {
    return { valid: false, reason: "MALFORMED_PADDING" };
  }

  // Catch 4,097-byte (5,464 chars ending in '=') and 4,098-byte (5,464 chars, no '=') oversized payloads
  if (pcmBytes > BoundedAudioRingBuffer.STANDARD_FRAME_PCM_BYTES) {
    return { valid: false, reason: "OVERSIZED_FRAME" };
  }

  // public/mic-processor.worklet.js emits fixed 2,048 Float32 samples (4,096 Int16 PCM bytes,
  // 5,464 canonical Base64 chars ending in "==") with no partial-frame emission.
  // Reject all short frames (both odd and even) and any non-exact frame size.
  if (
    pcmBytes !== BoundedAudioRingBuffer.STANDARD_FRAME_PCM_BYTES ||
    charLen !== BoundedAudioRingBuffer.STANDARD_FRAME_B64_CHARS
  ) {
    return { valid: false, reason: "INVALID_FORMAT" };
  }

  return { valid: true, pcmByteLength: pcmBytes, charLength: charLen };
}

/**
 * Per-client bounded FIFO audio buffer for Gemini Live session recreation continuity.
 * Hard limits: 24 frames, 98,304 decoded PCM bytes (96 KB), 131,136 Base64 chars (~128 KB).
 * Supports atomic enqueue, peek, dequeue, and conditional epoch+sequence removal.
 */
export class BoundedAudioRingBuffer {
  public static readonly MAX_FRAMES = 24;                 // 3.072 seconds max at 128 ms/frame
  public static readonly MAX_PCM_BYTES = 98_304;          // 24 × 4,096 bytes (96 KB)
  public static readonly MAX_BASE64_CHARS = 131_136;      // 24 × 5,464 chars (~128 KB)
  public static readonly STANDARD_FRAME_PCM_BYTES = 4_096;
  public static readonly STANDARD_FRAME_B64_CHARS = 5_464;

  private frames: QueuedAudioFrame[] = [];
  private totalPcmBytes = 0;
  private totalBase64Chars = 0;
  private sequenceCounter = 0;

  /**
   * Enqueues an incoming Base64 PCM frame with strict validation and hard bounds.
   * Rejects overflow explicitly (QUEUE_FULL); never drops oldest frames silently.
   */
  public enqueue(base64Data: string, epoch: number): EnqueueResult {
    const validation = validatePcmBase64Frame(base64Data);
    if (validation.valid === false) {
      return { success: false, reason: validation.reason };
    }

    const { pcmByteLength, charLength } = validation;

    if (
      this.frames.length >= BoundedAudioRingBuffer.MAX_FRAMES ||
      this.totalPcmBytes + pcmByteLength > BoundedAudioRingBuffer.MAX_PCM_BYTES ||
      this.totalBase64Chars + charLength > BoundedAudioRingBuffer.MAX_BASE64_CHARS
    ) {
      return { success: false, reason: "QUEUE_FULL" };
    }

    const frame: QueuedAudioFrame = {
      data: base64Data,
      pcmByteLength,
      epoch,
      sequence: ++this.sequenceCounter,
      timestamp: Date.now(),
    };
    this.frames.push(frame);
    this.totalPcmBytes += pcmByteLength;
    this.totalBase64Chars += charLength;

    return { success: true, enqueuedCount: this.frames.length, frame };
  }

  /**
   * Atomic dequeue: removes and returns the head frame while updating byte accounting.
   */
  public dequeue(): QueuedAudioFrame | undefined {
    const frame = this.frames.shift();
    if (frame) {
      this.totalPcmBytes = Math.max(0, this.totalPcmBytes - frame.pcmByteLength);
      this.totalBase64Chars = Math.max(0, this.totalBase64Chars - frame.data.length);
    }
    return frame;
  }

  /**
   * Conditional atomic dequeue: removes and returns the head frame ONLY if it matches
   * the expected epoch and sequence number. Prevents stale async drain workers from
   * removing frames belonging to a newer epoch after a project-switch cutover.
   */
  public dequeueIfMatch(expectedEpoch: number, expectedSequence: number): QueuedAudioFrame | undefined {
    const head = this.frames[0];
    if (!head || head.epoch !== expectedEpoch || head.sequence !== expectedSequence) {
      return undefined;
    }
    return this.dequeue();
  }

  /**
   * Peek: inspects the head frame without mutating queue state.
   */
  public peek(): QueuedAudioFrame | undefined {
    return this.frames[0];
  }

  /**
   * Drains all frames matching an epoch, purging all frames atomically.
   */
  public drainForEpoch(epoch: number): QueuedAudioFrame[] {
    const valid = this.frames.filter((f) => f.epoch === epoch);
    this.clear();
    return valid;
  }

  /**
   * Clears the queue and resets all byte/char counters atomically.
   */
  public clear(): void {
    this.frames = [];
    this.totalPcmBytes = 0;
    this.totalBase64Chars = 0;
  }

  public get size(): number {
    return this.frames.length;
  }

  public get pcmBytes(): number {
    return this.totalPcmBytes;
  }

  public get base64Chars(): number {
    return this.totalBase64Chars;
  }
}

export type ConversationGeminiState = GeminiSessionState | "DRAINING";

interface ActiveDrainWorker {
  workerId: number;
  sessionId: string;
  epoch: number;
  invalidated: boolean;
}

export class ConversationManager {
  private factory: GeminiSessionFactory;
  private drainInterChunkDelayMs: number;

  constructor(
    factory?: GeminiSessionFactory,
    options?: { drainInterChunkDelayMs?: number },
  ) {
    this.factory = factory || new GeminiSessionFactory();
    this.drainInterChunkDelayMs = options?.drainInterChunkDelayMs ?? 5;
  }

  /**
   * Handle a new client WebSocket connection.
   * Call this from the wss "connection" event.
   */
  async handleConnection(clientWs: any): Promise<void> {
    const remoteDevice = (clientWs as any)?.remoteDevice;
    const deviceId: string = remoteDevice?.id || "local_desktop";
    const clientSessionId: string | undefined =
      (clientWs as any)?.remoteSession?.sessionId || (clientWs as any)?.remoteSessionId;

    // ── PER-RUN SECURITY: Lock desktop gate on every new Myraa session ───────
    // This is the core of the per-run security model. Every time Myraa connects
    // (app launch, reconnect, or new session), desktop control is locked fresh.
    // User MUST provide the code again to get desktop access. No lifetime unlock.
    desktopSecurityGate.lockForNewSession();

    console.log("Client WebSocket connected to /live");
    const keyMeta = resolveApiKeyWithMetadata();

    if (!keyMeta.isValid || !keyMeta.key) {
      const isCloud =
        (process.env.NODE_ENV === "production" || keyMeta.source === "GEMINI_API_KEY") &&
        process.env.SORA_LAUNCHED_BY !== "electron" &&
        process.env.MYRAA_LOCAL_DESKTOP !== "true";
      const isPlaceholder = Boolean(keyMeta.isPlaceholder);
      const errMsg = isPlaceholder && isCloud
        ? "SERVER_API_KEY_PLACEHOLDER: The server environment variable GEMINI_API_KEY on Render contains an unconfigured template placeholder (ends in HERE). Please update GEMINI_API_KEY in the Render Dashboard with a valid Google Gemini API key from Google AI Studio."
        : isCloud
        ? "NO_SERVER_API_KEY: Server environment variable GEMINI_API_KEY is missing or invalid. Please configure your Google Gemini API key in the Render Dashboard."
        : keyMeta.source !== "none"
        ? "Gemini API credential is invalid or expired. Please configure a valid Gemini credential in Settings."
        : "NO_API_KEY: Please configure a valid Gemini API key (starts with AIzaSy) in Settings to start talking to MYRAA.";

      console.warn(
        `[Gemini Auth] Connection rejected: source=${keyMeta.source} credentialClass=${keyMeta.credentialClass} prefix=${keyMeta.prefix} length=${keyMeta.length}`,
      );
      await remoteSessionManager.updateDeviceSessionState(deviceId, {
        connectionState: "FAILED",
        geminiState: "FAILED",
        lastFailureClass: "GEMINI_AUTH_FAILURE",
      });
      this._send(clientWs, {
        type: "error",
        error: errMsg,
      });
      clientWs.close();
      return;
    }

    const apiKey = keyMeta.key;
    console.log(
      `[Gemini Auth] source=${keyMeta.source} credentialClass=${keyMeta.credentialClass} prefix=${keyMeta.prefix} length=${keyMeta.length}`,
    );

    // Synchronize process.env so SDK doesn't warn about conflicting env vars
    process.env.GEMINI_API_KEY = apiKey;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GOOGLE_GENAI_API_KEY;

    // Restore bounded safe conversation context from persistent snapshot if available
    const dialogueHistory: { role: string; text: string }[] = [];
    try {
      const existingSnapshot = await remoteStore.getSessionSnapshot(deviceId);
      if (existingSnapshot?.recentContext?.length) {
        for (const turn of existingSnapshot.recentContext) {
          if (turn && (turn.role === "user" || turn.role === "model") && turn.text && !turn.text.startsWith("[")) {
            dialogueHistory.push({ role: turn.role, text: turn.text });
          }
        }
        this._send(clientWs, {
          type: "status",
          status: "session_restored",
          restoredTurns: dialogueHistory.length,
          version: existingSnapshot.version,
        });
      }
    } catch {
      /* snapshot recovery best-effort */
    }

    let currentGeminiState: ConversationGeminiState = "STARTING_GEMINI";
    let inFlightCreatePromise: Promise<any> | null = null;
    let session: any = null;
    const currentModelResponseRef = { text: "" };

    // ── SEC-P4-A01: Per-client bounded FIFO audio queue & epoch/session isolation ──
    const audioBuffer = new BoundedAudioRingBuffer();
    let sessionEpoch = 1;
    let activeSessionId: string | null = null;
    let openedSessionId: string | null = null;
    let connectedEmittedForSessionId: string | null = null;
    let activeDrainWorker: ActiveDrainWorker | null = null;
    let drainWorkerSeq = 0;
    let sessionGenSeq = 0;

    const invalidateActiveDrainWorker = () => {
      if (activeDrainWorker) {
        activeDrainWorker.invalidated = true;
        activeDrainWorker = null;
      }
    };

    const persistContextSnapshot = () => {
      const safeTurns = dialogueHistory
        .filter((t) => t.text && !t.text.startsWith("["))
        .slice(-10)
        .map((t) => ({
          role: (t.role === "model" ? "model" : "user") as "user" | "model",
          text: t.text,
        }));
      const persistedGeminiState: GeminiSessionState =
        currentGeminiState === "DRAINING" ? "RECREATING" : currentGeminiState;
      remoteSessionManager
        .updateDeviceSessionState(deviceId, {
          connectionState: currentGeminiState === "READY" ? "READY" : "CONNECTED",
          geminiState: persistedGeminiState,
          lastGeminiTimestamp:
            currentGeminiState === "READY" ? new Date().toISOString() : undefined,
          recentContext: safeTurns,
        })
        .catch(() => {});
    };

    const emitConnectedReadyOnce = (forSessionId: string, forEpoch: number) => {
      if (connectedEmittedForSessionId === forSessionId) return;
      connectedEmittedForSessionId = forSessionId;
      currentGeminiState = "READY";
      persistContextSnapshot();
      this._send(clientWs, {
        type: "status",
        status: "connected",
        geminiState: "READY",
        epoch: forEpoch,
      });

      // Synchronize durable memories on connection so frontend UI immediately reflects memories across restarts
      import("../server_memory.ts")
        .then(async ({ loadMemories }) => {
          try {
            const memories = await loadMemories();
            if (Array.isArray(memories) && !flags.isClientClosed && clientWs.readyState === 1) {
              this._send(clientWs, {
                type: "memory_sync",
                memories,
              });
            }
          } catch {}
        })
        .catch(() => {});
    };

    /**
     * SEC-P4-A01: Single active async drain worker per session generation.
     * Bound to (targetSession, boundSessionId, boundEpoch, workerId).
     * Never dequeues new-epoch frames, never modifies replacement session state,
     * and never delivers stale-epoch audio to a new session.
     */
    const drainBufferedAudio = async (
      targetSession: any,
      boundSessionId: string,
      boundEpoch: number,
    ): Promise<void> => {
      // Idempotency: only one drain worker per session generation
      if (
        activeDrainWorker &&
        !activeDrainWorker.invalidated &&
        activeDrainWorker.sessionId === boundSessionId &&
        activeDrainWorker.epoch === boundEpoch
      ) {
        return;
      }

      // Invalidate any lingering worker from an older generation
      invalidateActiveDrainWorker();

      const worker: ActiveDrainWorker = {
        workerId: ++drainWorkerSeq,
        sessionId: boundSessionId,
        epoch: boundEpoch,
        invalidated: false,
      };
      activeDrainWorker = worker;
      currentGeminiState = "DRAINING";
      persistContextSnapshot();

      const isWorkerCurrent = (): boolean =>
        !worker.invalidated &&
        !flags.isClientClosed &&
        clientWs.readyState === 1 &&
        activeDrainWorker?.workerId === worker.workerId &&
        activeSessionId === boundSessionId &&
        sessionEpoch === boundEpoch &&
        session === targetSession;

      try {
        while (
          isWorkerCurrent() &&
          audioBuffer.size > 0 &&
          currentGeminiState === "DRAINING"
        ) {
          const frame = audioBuffer.peek();
          if (!frame) break;

          // Purge frames belonging to a stale epoch using conditional removal
          if (frame.epoch !== boundEpoch) {
            audioBuffer.dequeueIfMatch(frame.epoch, frame.sequence);
            continue;
          }

          await targetSession.sendRealtimeInput?.({
            audio: { data: frame.data, mimeType: "audio/pcm;rate=16000" },
          });

          // CRITICAL CONCURRENCY GUARD:
          // If cutover/invalidation occurred while awaiting sendRealtimeInput(),
          // exit immediately without touching the queue or replacement session state!
          if (!isWorkerCurrent()) {
            return;
          }

          // Conditional removal guarantees we only remove the exact frame we just dispatched
          audioBuffer.dequeueIfMatch(frame.epoch, frame.sequence);

          if (this.drainInterChunkDelayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, this.drainInterChunkDelayMs));
          }

          if (!isWorkerCurrent()) {
            return;
          }
        }

        if (isWorkerCurrent() && currentGeminiState === "DRAINING" && audioBuffer.size === 0) {
          emitConnectedReadyOnce(boundSessionId, boundEpoch);
        }
      } catch (err: any) {
        // Only mutate state & emit failure if this worker still owns the active session/epoch
        if (isWorkerCurrent()) {
          console.error("[AudioDrain] Drain failed:", err);
          currentGeminiState = "FAILED";
          audioBuffer.clear();
          persistContextSnapshot();
          this._send(clientWs, {
            type: "status",
            status: "session_failed",
            geminiState: "FAILED",
            reason: sanitizeGeminiErrorReason(err?.message || String(err)),
          });
        }
      } finally {
        if (activeDrainWorker?.workerId === worker.workerId) {
          activeDrainWorker = null;
        }
      }
    };

    /**
     * SEC-P4-A01 (§2.4): Synchronous project-switch / rotation epoch cutover.
     * Increments epoch, invalidates any in-flight drain worker, purges residual
     * old-epoch frames, and notifies client of RECREATING state.
     */
    const performEpochCutover = (reason: string) => {
      sessionEpoch += 1;
      invalidateActiveDrainWorker();
      audioBuffer.clear();
      currentGeminiState = "RECREATING";
      persistContextSnapshot();
      this._send(clientWs, {
        type: "status",
        status: "connecting_gemini",
        geminiState: "RECREATING",
        epoch: sessionEpoch,
        reason,
      });
    };

    const activateOpenedSession = (sid: string, targetSession: any) => {
      if (sid !== activeSessionId || flags.isClientClosed) return;
      if (audioBuffer.size > 0) {
        void drainBufferedAudio(targetSession, sid, sessionEpoch);
      } else {
        emitConnectedReadyOnce(sid, sessionEpoch);
      }
    };

    const flags = {
      isRotating: false,
      isClientClosed: false,
      geminiRecreateAttempts: 0,
      maxGeminiRecreateAttempts: 3,
      pendingSessionRotation: undefined as string | undefined,
      isCurrentSession: (sid: string) => sid === activeSessionId,
      onEpochCutover: (reason: string) => {
        performEpochCutover(reason);
      },
      onSessionOpen: (sid: string, openedSess: any): boolean => {
        if (sid !== activeSessionId || flags.isClientClosed) {
          return true; // Drop stale session callback
        }
        // Duplicate onopen idempotency guard (AC-14)
        if (openedSessionId === sid) {
          return true;
        }
        openedSessionId = sid;
        const targetSession = openedSess || session;
        if (targetSession) {
          activateOpenedSession(sid, targetSession);
        } else {
          // onopen fired synchronously before createSession resolved; activate once resolved
          currentGeminiState = audioBuffer.size > 0 ? "DRAINING" : "READY";
        }
        return true;
      },
      onRecreateExhausted: (code: number | undefined, reason: string) => {
        invalidateActiveDrainWorker();
        audioBuffer.clear();
        currentGeminiState = "CLOSED";
        persistContextSnapshot();
        this._send(clientWs, {
          type: "status",
          status: "session_closed",
          geminiState: "CLOSED",
          code,
          reason:
            reason ||
            "Gemini Live session could not be restored. Buffered audio was cleared; please repeat your last message.",
          bufferCleared: true,
          promptRepeat: true,
        });
      },
      onGeminiStateChange: (
        nextState: "STARTING_GEMINI" | "READY" | "RECREATING" | "DRAINING" | "CLOSED" | "FAILED",
        sid?: string,
      ) => {
        if (sid && activeSessionId && sid !== activeSessionId) {
          return; // Ignore stale session state change (AC-15)
        }
        if (nextState === "RECREATING") {
          invalidateActiveDrainWorker();
        }
        currentGeminiState = nextState;
        persistContextSnapshot();
      },
    };

    this._send(clientWs, {
      type: "status",
      status: "connecting_gemini",
      geminiState: "STARTING_GEMINI",
      epoch: sessionEpoch,
    });

    const createOrRotateGeminiSession = async (isRecreation = false): Promise<any> => {
      if (flags.isClientClosed || clientWs.readyState !== 1) return null;
      if (inFlightCreatePromise) {
        return inFlightCreatePromise;
      }

      const nextSessionId = `gem_${deviceId}_${++sessionGenSeq}_${Date.now()}`;
      invalidateActiveDrainWorker();
      activeSessionId = nextSessionId;
      openedSessionId = null;
      connectedEmittedForSessionId = null;

      inFlightCreatePromise = (async () => {
        try {
          const newSession = await this.factory.createSession({
            apiKey,
            clientWs,
            sessionId: nextSessionId,
            flags,
            dialogueHistory,
            currentModelResponseRef,
            onRotate: () => createOrRotateGeminiSession(true),
          });

          // If superseded or client closed while awaiting connect, discard stale session
          if (activeSessionId !== nextSessionId || flags.isClientClosed) {
            try {
              newSession?.close?.();
            } catch {}
            return null;
          }

          session = newSession;

          // If this session was recreated mid-conversation or after a server restart,
          // seed the new Gemini session with the bounded recent conversation context
          // (without triggering a spoken turn) so conversational context is preserved.
          if (isRecreation && dialogueHistory.length > 0 && typeof newSession?.sendClientContent === "function") {
            try {
              const recentTurns = dialogueHistory.slice(-6).map((t) => ({
                role: t.role === "model" ? "model" : "user",
                parts: [{ text: t.text }],
              }));
              newSession.sendClientContent({
                turns: recentTurns,
                turnComplete: false,
              });
            } catch {
              /* context priming best-effort */
            }
          }

          // If onopen fired while createSession was still awaiting resolution, activate now
          if (openedSessionId === nextSessionId) {
            activateOpenedSession(nextSessionId, newSession);
          }

          return newSession;
        } finally {
          inFlightCreatePromise = null;
        }
      })();

      return inFlightCreatePromise;
    };

    // Attach message and close listeners BEFORE awaiting Gemini connection so
    // ping/pong heartbeats and desktop_tool_response frames work immediately
    // even while Gemini is still connecting or recreating!
    let audioFramesIn = 0;
    clientWs.on("message", async (rawMsg: any) => {
      try {
        remoteSessionManager.recordHeartbeat(clientSessionId || deviceId);
        const msg = JSON.parse(rawMsg.toString());

        if (msg.type === "ping") {
          this._send(clientWs, {
            type: "pong",
            timestamp: new Date().toISOString(),
            geminiState: currentGeminiState,
          });
          return;
        }

        if (msg.type === "recreate_gemini") {
          if (!flags.isClientClosed && clientWs.readyState === 1) {
            flags.geminiRecreateAttempts = 0;
            invalidateActiveDrainWorker();
            currentGeminiState = "RECREATING";
            persistContextSnapshot();
            this._send(clientWs, {
              type: "status",
              status: "connecting_gemini",
              geminiState: "RECREATING",
              epoch: sessionEpoch,
            });
            createOrRotateGeminiSession(true).catch((err: any) => {
              const sanitized = sanitizeGeminiErrorReason(err?.message || String(err));
              audioBuffer.clear();
              currentGeminiState = "CLOSED";
              persistContextSnapshot();
              this._send(clientWs, {
                type: "status",
                status: "session_closed",
                geminiState: "CLOSED",
                reason: `Could not recreate Gemini session: ${sanitized}`,
                bufferCleared: true,
              });
            });
          }
          return;
        }

        if (msg.type === "interrupted") {
          console.log("[ConversationManager] Client signaled local barge-in interruption.");
          currentModelResponseRef.text = "";
          return;
        }

        if (msg.audio !== undefined) {
          audioFramesIn++;

          // ── SEC-P4-A01: Strict canonical Base64 & exact PCM frame-size validation ─
          const validation = validatePcmBase64Frame(msg.audio);
          if (validation.valid === false) {
            const reason = validation.reason;
            console.warn(
              `[ConversationManager:${deviceId}] Audio frame #${audioFramesIn} rejected: ${reason}`,
            );
            this._send(clientWs, {
              type: "audio_warning",
              reason,
              message: `Audio frame rejected (${reason}).`,
            });
            return;
          }

          if (audioFramesIn === 1 || audioFramesIn % 15 === 0) {
            console.log(
              `[ConversationManager:${deviceId}] Audio frame #${audioFramesIn} (${validation.pcmByteLength} PCM bytes, state=${currentGeminiState}, epoch=${sessionEpoch}, queued=${audioBuffer.size})`,
            );
          }

          // State machine dispatch:
          // READY with empty queue and no active drain worker -> direct upstream dispatch
          if (
            currentGeminiState === "READY" &&
            session &&
            audioBuffer.size === 0 &&
            !activeDrainWorker
          ) {
            session.sendRealtimeInput?.({
              audio: { data: msg.audio, mimeType: "audio/pcm;rate=16000" },
            });
          } else {
            // If CLOSED, trigger automatic recreation while buffering
            if (!session && currentGeminiState === "CLOSED" && !inFlightCreatePromise) {
              currentGeminiState = "RECREATING";
              persistContextSnapshot();
              createOrRotateGeminiSession(true).catch(() => {});
            }

            // RECREATING / DRAINING / STARTING_GEMINI: append to bounded FIFO queue tail
            const enq = audioBuffer.enqueue(msg.audio, sessionEpoch);
            if (enq.success === false) {
              const reason = enq.reason;
              console.warn(
                `[ConversationManager:${deviceId}] Audio queue rejected frame: ${reason} (size=${audioBuffer.size}/${BoundedAudioRingBuffer.MAX_FRAMES}, bytes=${audioBuffer.pcmBytes}/${BoundedAudioRingBuffer.MAX_PCM_BYTES}, epoch=${sessionEpoch})`,
              );
              this._send(clientWs, {
                type: "audio_warning",
                reason,
                queueSize: audioBuffer.size,
                maxFrames: BoundedAudioRingBuffer.MAX_FRAMES,
                pcmBytes: audioBuffer.pcmBytes,
                maxPcmBytes: BoundedAudioRingBuffer.MAX_PCM_BYTES,
                message:
                  reason === "QUEUE_FULL"
                    ? "Audio continuity buffer is full (24 frames / 98,304 bytes). Frame rejected without dropping older audio."
                    : `Audio frame rejected (${reason}).`,
              });
            }
          }
        } else if (msg.type === "video" && msg.video) {
          const blob = { data: msg.video, mimeType: "image/jpeg" };
          session?.sendRealtimeInput?.({
            video: blob,
          });
        } else if (msg.type === "text" && msg.text) {
          const userText = String(msg.text);
          dialogueHistory.push({ role: "user", text: userText });
          persistContextSnapshot();

          const sendTextToSession = (targetSession: any) => {
            if (typeof targetSession?.sendClientContent === "function") {
              targetSession.sendClientContent({
                turns: [{ role: "user", parts: [{ text: userText }] }],
                turnComplete: true,
              });
            } else if (typeof targetSession?.sendRealtimeInput === "function") {
              targetSession.sendRealtimeInput({ text: userText });
            }
          };

          if (session && currentGeminiState === "READY") {
            sendTextToSession(session);
          } else {
            createOrRotateGeminiSession(true)
              .then((recreated) => {
                if (recreated) sendTextToSession(recreated);
              })
              .catch(() => {});
          }
        } else if (msg.type === "desktop_tool_response") {
          const sid = (clientWs as any)?.remoteSession?.sessionId || (clientWs as any)?.remoteSessionId;
          remoteSessionManager.handleDesktopToolResponse(msg, sid);
        } else if (msg.type === "toolResponse") {
          const sid = (clientWs as any)?.remoteSession?.sessionId || (clientWs as any)?.remoteSessionId;
          const handled = remoteSessionManager.handleDesktopToolResponse(msg, sid);

          if (
            (msg.name === "browserSearch" || msg.name === "searchYouTube") &&
            Array.isArray(msg.output?.results) &&
            msg.output.results.length > 0
          ) {
            import("../orchestrator/ActionContext.ts")
              .then(({ actionContextManager }) => {
                const results = msg.output.results.map((v: any, idx: number) => ({
                  index: idx,
                  videoId: v.videoId || "",
                  title: v.title || `Video ${idx + 1}`,
                  url: v.url || (v.videoId ? `https://www.youtube.com/watch?v=${v.videoId}` : ""),
                  author: v.author,
                  duration: v.duration,
                  thumbnail: v.thumbnail,
                }));
                actionContextManager.recordMediaSearch(
                  "default",
                  msg.output.query || "youtube",
                  results,
                  "youtube",
                );
              })
              .catch(() => {});
          }

          if (!handled) {
            session?.sendToolResponse?.({
              functionResponses: [
                {
                  name: msg.name,
                  response: { output: msg.output },
                  id: msg.id,
                },
              ],
            });
          }
        } else if (msg.type === "confirm_decision") {
          const { decisionId, projectId, confirmationToken } = msg;
          if (!decisionId || !confirmationToken) {
            this._send(clientWs, {
              type: "decision_confirmation_failed",
              decisionId,
              projectId,
              error: "decisionId and confirmationToken are required",
            });
            return;
          }

          // 1. Mandatory Authenticated Session Extraction (SEC-P3-R1.3-01)
          // Read strictly from live server-attached socket context (never client message or stale closure).
          const socketSessionId: string | undefined =
            !flags.isClientClosed && clientWs.readyState === 1
              ? (clientWs as any)?.remoteSession?.sessionId || (clientWs as any)?.remoteSessionId
              : undefined;
          if (!socketSessionId) {
            this._send(clientWs, {
              type: "decision_confirmation_failed",
              decisionId,
              projectId,
              error: "MISSING_SESSION_CONTEXT",
            });
            return;
          }

          const actorRole = (
            (clientWs as any)?.remoteSession?.role ||
            (clientWs as any)?.remoteDevice?.role ||
            "standard"
          ) as IdentityRole;
          const actorIdentityId: string =
            (clientWs as any)?.remoteDevice?.id || socketSessionId;
          const actorIp: string =
            (clientWs as any)?.remoteSession?.ipAddress ||
            (clientWs as any)?.remoteDevice?.lastIp ||
            "127.0.0.1";

          const { securityAuditLogger } = await import("../security/SecurityAuditLogger.ts");

          // 2. RBAC Check (preserve guest / read_only restrictions)
          if (actorRole === "guest" || actorRole === "read_only") {
            securityAuditLogger.logEvent({
              eventType: "TOOL_BLOCKED",
              actor: { identityId: actorIdentityId, role: actorRole, ipAddress: actorIp, sessionId: socketSessionId },
              target: { toolName: "trackProjectTask", resource: `decision:${decisionId}` },
              decision: "BLOCK",
              reason: `PERMISSION_DENIED: Role '${actorRole}' is not permitted to confirm project decisions.`,
              riskLevel: "HIGH",
              metadata: { decisionId, projectId },
            });
            this._send(clientWs, {
              type: "decision_confirmation_failed",
              decisionId,
              projectId,
              error: "PERMISSION_DENIED",
            });
            return;
          }

          // 3. Emergency Stop Fail-Closed Gate
          const { emergencyStopCoordinator } = await import("../remote/EmergencyStopCoordinator.ts");
          if (emergencyStopCoordinator.isActive()) {
            securityAuditLogger.logEvent({
              eventType: "TOOL_BLOCKED",
              actor: { identityId: actorIdentityId, role: actorRole, ipAddress: actorIp, sessionId: socketSessionId },
              target: { toolName: "trackProjectTask", resource: `decision:${decisionId}` },
              decision: "BLOCK",
              reason: "EMERGENCY_STOP_ACTIVE: Decision confirmation blocked while Emergency Stop is active.",
              riskLevel: "CRITICAL",
              metadata: { decisionId, projectId },
            });
            this._send(clientWs, {
              type: "decision_confirmation_failed",
              decisionId,
              projectId,
              error: "EMERGENCY_STOP_ACTIVE",
            });
            return;
          }

          // 4. Security Lockdown Fail-Closed Gate
          const { securityPolicyEngine } = await import("../security/SecurityPolicyEngine.ts");
          if (securityPolicyEngine.getMode() === "LOCKDOWN") {
            securityAuditLogger.logEvent({
              eventType: "TOOL_BLOCKED",
              actor: { identityId: actorIdentityId, role: actorRole, ipAddress: actorIp, sessionId: socketSessionId },
              target: { toolName: "trackProjectTask", resource: `decision:${decisionId}` },
              decision: "BLOCK",
              reason: "SECURITY_LOCKDOWN_ACTIVE: Decision confirmation blocked in LOCKDOWN mode.",
              riskLevel: "CRITICAL",
              metadata: { decisionId, projectId },
            });
            this._send(clientWs, {
              type: "decision_confirmation_failed",
              decisionId,
              projectId,
              error: "SECURITY_LOCKDOWN_ACTIVE",
            });
            return;
          }

          // 5. Server-Side Canonical Decision Lookup (never trust client-supplied expected args)
          const { projectDecisionStore } = await import("../projects/ProjectDecisionStore.ts");
          const decision = await projectDecisionStore.getDecision(decisionId);
          if (!decision) {
            this._send(clientWs, {
              type: "decision_confirmation_failed",
              decisionId,
              projectId,
              error: "DECISION_NOT_FOUND",
            });
            return;
          }

          // Enforce project ownership match if client provided a projectId
          if (projectId && projectId !== decision.projectId) {
            securityAuditLogger.logEvent({
              eventType: "TOOL_BLOCKED",
              actor: { identityId: actorIdentityId, role: actorRole, ipAddress: actorIp, sessionId: socketSessionId },
              target: { toolName: "trackProjectTask", resource: `decision:${decisionId}` },
              decision: "BLOCK",
              reason: `ARGS_MISMATCH: Cross-project confirmation attempt for decision '${decisionId}'.`,
              riskLevel: "HIGH",
              metadata: { decisionId, expectedProjectId: decision.projectId, providedProjectId: projectId },
            });
            this._send(clientWs, {
              type: "decision_confirmation_failed",
              decisionId,
              projectId: decision.projectId,
              error: "ARGS_MISMATCH",
            });
            return;
          }

          const canonicalArgs = {
            action: "confirm_decision",
            decisionId: decision.id,
            projectId: decision.projectId,
          };

          // 6. Atomic Token Verification & Consumption (BEFORE store persistence — fail-closed)
          const verifyRes = securityPolicyEngine.verifyAndConsumeConfirmation(
            confirmationToken,
            "trackProjectTask",
            canonicalArgs,
            socketSessionId,
            { requireSessionMatch: true },
          );

          if (!verifyRes.valid) {
            securityAuditLogger.logEvent({
              eventType: "TOOL_BLOCKED",
              actor: { identityId: actorIdentityId, role: actorRole, ipAddress: actorIp, sessionId: socketSessionId },
              target: { toolName: "trackProjectTask", resource: `decision:${decisionId}` },
              decision: "BLOCK",
              reason: `Frontend human confirmation failed: ${verifyRes.reason}`,
              riskLevel: "HIGH",
              metadata: {
                decisionId,
                projectId: decision.projectId,
                ...(verifyRes.tokenId ? { tokenId: verifyRes.tokenId } : {}),
                ...(verifyRes.argsHash ? { argsHash: verifyRes.argsHash } : {}),
              },
            });
            this._send(clientWs, {
              type: "decision_confirmation_failed",
              decisionId,
              projectId: decision.projectId,
              error: verifyRes.reason || "Invalid or expired confirmation token.",
            });
            return;
          }

          // 7. Persist Confirmation (Fail-Closed: if store throws, token REMAINS consumed)
          try {
            const confirmedDecision = await projectDecisionStore.confirmDecision(
              decision.id,
              decision.projectId,
            );
            if (!confirmedDecision) {
              throw new Error(`Decision '${decision.id}' could not be confirmed in store.`);
            }
            // GAP-10.3-02: Invalidate cached system instructions ONLY after successful persistence
            invalidateInstructionsCache();
            securityAuditLogger.logEvent({
              eventType: "TOOL_CONFIRMED",
              actor: { identityId: actorIdentityId, role: actorRole, ipAddress: actorIp, sessionId: socketSessionId },
              target: { toolName: "trackProjectTask", resource: `decision:${decisionId}` },
              decision: "ALLOW",
              reason: `Project decision confirmed via trusted frontend human approval: ${confirmedDecision?.description || decisionId}`,
              riskLevel: "HIGH",
              metadata: {
                decisionId,
                projectId: decision.projectId,
                tokenId: verifyRes.tokenId,
                argsHash: verifyRes.argsHash,
                confirmedAt: confirmedDecision?.confirmedAt,
              },
            });

            this._send(clientWs, {
              type: "decision_confirmed",
              decisionId,
              projectId: decision.projectId,
              success: true,
              decision: confirmedDecision,
            });

            // Inform active Gemini session of the approval
            const notificationText = `[System Action: The human operator has approved and confirmed the project decision "${confirmedDecision?.description || decisionId}".]`;
            if (typeof session?.sendClientContent === "function") {
              session.sendClientContent({
                turns: [{ role: "user", parts: [{ text: notificationText }] }],
                turnComplete: true,
              });
            } else if (typeof session?.sendRealtimeInput === "function") {
              session.sendRealtimeInput({ text: notificationText });
            }
          } catch (err: any) {
            securityAuditLogger.logEvent({
              eventType: "TOOL_BLOCKED",
              actor: { identityId: actorIdentityId, role: actorRole, ipAddress: actorIp, sessionId: socketSessionId },
              target: { toolName: "trackProjectTask", resource: `decision:${decisionId}` },
              decision: "BLOCK",
              reason: `PERSISTENCE_ERROR: Store failed after confirmation token consumption; failing closed.`,
              riskLevel: "HIGH",
              metadata: {
                decisionId,
                projectId: decision.projectId,
                tokenId: verifyRes.tokenId,
                argsHash: verifyRes.argsHash,
              },
            });
            this._send(clientWs, {
              type: "decision_confirmation_failed",
              decisionId,
              projectId: decision.projectId,
              error: `PERSISTENCE_ERROR: ${err?.message || "Failed to confirm decision in store. Token consumed; request a new confirmation."}`,
            });
          }
        } else if (msg.type === "reject_decision") {
          const { decisionId, projectId, confirmationToken } = msg;

          // 1. Mandatory Authenticated Session Extraction (SEC-P3-R1.3-01)
          // Read strictly from live server-attached socket context (never client message or stale closure).
          const socketSessionId: string | undefined =
            !flags.isClientClosed && clientWs.readyState === 1
              ? (clientWs as any)?.remoteSession?.sessionId || (clientWs as any)?.remoteSessionId
              : undefined;
          if (!socketSessionId) {
            this._send(clientWs, {
              type: "decision_rejection_failed",
              decisionId,
              projectId,
              error: "MISSING_SESSION_CONTEXT",
            });
            return;
          }

          if (!decisionId || !confirmationToken) {
            this._send(clientWs, {
              type: "decision_rejection_failed",
              decisionId,
              projectId,
              error: "INVALID_CONFIRMATION_TOKEN: decisionId and confirmationToken are required",
            });
            return;
          }

          const actorRole = (
            (clientWs as any)?.remoteSession?.role ||
            (clientWs as any)?.remoteDevice?.role ||
            "standard"
          ) as IdentityRole;
          const actorIdentityId: string =
            (clientWs as any)?.remoteDevice?.id || socketSessionId;
          const actorIp: string =
            (clientWs as any)?.remoteSession?.ipAddress ||
            (clientWs as any)?.remoteDevice?.lastIp ||
            "127.0.0.1";

          const { securityAuditLogger } = await import("../security/SecurityAuditLogger.ts");

          // 2. RBAC Check
          if (actorRole === "guest" || actorRole === "read_only") {
            securityAuditLogger.logEvent({
              eventType: "TOOL_BLOCKED",
              actor: { identityId: actorIdentityId, role: actorRole, ipAddress: actorIp, sessionId: socketSessionId },
              target: { toolName: "trackProjectTask", resource: `decision:${decisionId}` },
              decision: "BLOCK",
              reason: `PERMISSION_DENIED: Role '${actorRole}' is not permitted to reject project decisions.`,
              riskLevel: "HIGH",
              metadata: { decisionId, projectId },
            });
            this._send(clientWs, {
              type: "decision_rejection_failed",
              decisionId,
              projectId,
              error: "PERMISSION_DENIED",
            });
            return;
          }

          // 3. Emergency Stop Fail-Closed Gate
          const { emergencyStopCoordinator } = await import("../remote/EmergencyStopCoordinator.ts");
          if (emergencyStopCoordinator.isActive()) {
            securityAuditLogger.logEvent({
              eventType: "TOOL_BLOCKED",
              actor: { identityId: actorIdentityId, role: actorRole, ipAddress: actorIp, sessionId: socketSessionId },
              target: { toolName: "trackProjectTask", resource: `decision:${decisionId}` },
              decision: "BLOCK",
              reason: "EMERGENCY_STOP_ACTIVE: Decision rejection blocked while Emergency Stop is active.",
              riskLevel: "CRITICAL",
              metadata: { decisionId, projectId },
            });
            this._send(clientWs, {
              type: "decision_rejection_failed",
              decisionId,
              projectId,
              error: "EMERGENCY_STOP_ACTIVE",
            });
            return;
          }

          // 4. Security Policy Lockdown Fail-Closed Gate
          const { securityPolicyEngine } = await import("../security/SecurityPolicyEngine.ts");
          if (securityPolicyEngine.getMode() === "LOCKDOWN") {
            securityAuditLogger.logEvent({
              eventType: "TOOL_BLOCKED",
              actor: { identityId: actorIdentityId, role: actorRole, ipAddress: actorIp, sessionId: socketSessionId },
              target: { toolName: "trackProjectTask", resource: `decision:${decisionId}` },
              decision: "BLOCK",
              reason: "SECURITY_LOCKDOWN_ACTIVE: Decision rejection blocked in LOCKDOWN mode.",
              riskLevel: "CRITICAL",
              metadata: { decisionId, projectId },
            });
            this._send(clientWs, {
              type: "decision_rejection_failed",
              decisionId,
              projectId,
              error: "SECURITY_LOCKDOWN_ACTIVE",
            });
            return;
          }

          // 5. Retrieve Canonical Decision Record from Store (never trust client-supplied args)
          const { projectDecisionStore } = await import("../projects/ProjectDecisionStore.ts");
          const decision = await projectDecisionStore.getDecision(decisionId);
          if (!decision) {
            this._send(clientWs, {
              type: "decision_rejection_failed",
              decisionId,
              projectId,
              error: "DECISION_NOT_FOUND",
            });
            return;
          }

          // Enforce project ownership match if client provided projectId
          if (projectId && projectId !== decision.projectId) {
            securityAuditLogger.logEvent({
              eventType: "TOOL_BLOCKED",
              actor: { identityId: actorIdentityId, role: actorRole, ipAddress: actorIp, sessionId: socketSessionId },
              target: { toolName: "trackProjectTask", resource: `decision:${decisionId}` },
              decision: "BLOCK",
              reason: `ARGS_MISMATCH: Tampered projectId in reject_decision for decision '${decisionId}'.`,
              riskLevel: "HIGH",
              metadata: { decisionId, expectedProjectId: decision.projectId, providedProjectId: projectId },
            });
            this._send(clientWs, {
              type: "decision_rejection_failed",
              decisionId,
              projectId: decision.projectId,
              error: "ARGS_MISMATCH",
            });
            return;
          }

          const canonicalArgs = {
            action: "confirm_decision",
            decisionId: decision.id,
            projectId: decision.projectId,
          };

          // 6. Atomic Server-Side Capability Revocation
          const revokeRes = securityPolicyEngine.revokeConfirmationToken(
            confirmationToken,
            "trackProjectTask",
            canonicalArgs,
            socketSessionId,
          );

          if (!revokeRes.revoked) {
            securityAuditLogger.logEvent({
              eventType: "TOOL_BLOCKED",
              actor: { identityId: actorIdentityId, role: actorRole, ipAddress: actorIp, sessionId: socketSessionId },
              target: { toolName: "trackProjectTask", resource: `decision:${decisionId}` },
              decision: "BLOCK",
              reason: `Decision rejection failed: ${revokeRes.reason}`,
              riskLevel: "HIGH",
              metadata: {
                decisionId,
                projectId: decision.projectId,
                ...(revokeRes.tokenId ? { tokenId: revokeRes.tokenId } : {}),
                ...(revokeRes.argsHash ? { argsHash: revokeRes.argsHash } : {}),
              },
            });
            this._send(clientWs, {
              type: "decision_rejection_failed",
              decisionId,
              projectId: decision.projectId,
              error: revokeRes.reason,
              ...(revokeRes.status ? { status: revokeRes.status } : {}),
            });
            return;
          }

          // 7. Secret-Safe Audit Logging (only tokenId + argsHash; NEVER raw token or sig)
          securityAuditLogger.logEvent({
            eventType: "TOOL_BLOCKED",
            actor: { identityId: actorIdentityId, role: actorRole, ipAddress: actorIp, sessionId: socketSessionId },
            target: { toolName: "trackProjectTask", resource: `decision:${decisionId}` },
            decision: "BLOCK",
            reason: `User explicitly rejected decision confirmation in UI; capability revoked.`,
            riskLevel: "HIGH",
            metadata: {
              decisionId,
              projectId: decision.projectId,
              tokenId: revokeRes.tokenId,
              argsHash: revokeRes.argsHash,
            },
          });

          // 8. Client Acknowledgement & Model Notification
          this._send(clientWs, {
            type: "decision_rejected",
            decisionId,
            projectId: decision.projectId,
            revoked: true,
          });

          const rejectionText = `[System Action: The human operator has rejected confirmation for project decision "${decisionId}".]`;
          if (typeof session?.sendClientContent === "function") {
            session.sendClientContent({
              turns: [{ role: "user", parts: [{ text: rejectionText }] }],
              turnComplete: true,
            });
          } else if (typeof session?.sendRealtimeInput === "function") {
            session.sendRealtimeInput({ text: rejectionText });
          }
        }
      } catch (e) {
        console.error("Error editing/forwarding client frame message:", e);
      }
    });

    clientWs.on("close", () => {
      flags.isClientClosed = true;
      invalidateActiveDrainWorker();
      audioBuffer.clear();
      currentGeminiState = "CLOSED";
      persistContextSnapshot();
      console.log("Client disconnected, closing Gemini session");
      try {
        session?.close();
      } catch (_e) {}
    });

    try {
      await createOrRotateGeminiSession(false);
    } catch (err: any) {
      const sanitized = sanitizeGeminiErrorReason(err?.message || String(err));
      console.error("Error connecting to Gemini Live API:", sanitized);
      const liveModel =
        process.env.GEMINI_LIVE_MODEL || "gemini-3.1-flash-live-preview";
      const { categorizedError, isAuthFailure } = classifyGeminiLiveCloseError(
        undefined,
        sanitized,
        liveModel,
        flags,
      );
      if (isAuthFailure) {
        currentGeminiState = "FAILED";
        persistContextSnapshot();
        this._send(clientWs, {
          type: "error",
          error: categorizedError || `Could not connect to Gemini: ${sanitized}`,
        });
        clientWs.close();
        return;
      }
      // For transient Gemini startup errors, keep the authenticated MYRAA WebSocket open
      // and notify the client that Gemini is closed/recreatable rather than dropping /remote-live.
      currentGeminiState = "CLOSED";
      persistContextSnapshot();
      this._send(clientWs, {
        type: "status",
        status: "session_closed",
        geminiState: "CLOSED",
        reason: `Could not connect to Gemini: ${sanitized}`,
      });
    }
  }

  private _send(ws: any, payload: unknown): void {
    if (ws && ws.readyState === 1) {
      try {
        ws.send(
          typeof payload === "string" ? payload : JSON.stringify(payload),
        );
      } catch (e) {
        console.warn("[WS] Error sending to client:", e);
      }
    }
  }
}
