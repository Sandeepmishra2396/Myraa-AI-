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

import { resolveApiKeyWithMetadata } from "../../../server_paths.ts";
import {
  GeminiSessionFactory,
  classifyGeminiLiveCloseError,
  sanitizeGeminiErrorReason,
} from "../ai/GeminiSessionFactory.ts";
import { remoteSessionManager } from "../remote/RemoteSessionManager.ts";
import { remoteStore } from "../remote/RemoteStore.ts";
import type { GeminiSessionState } from "../../lib/connectionStateMachine.ts";

export class ConversationManager {
  private factory: GeminiSessionFactory;

  constructor(factory?: GeminiSessionFactory) {
    this.factory = factory || new GeminiSessionFactory();
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

    console.log("Client WebSocket connected to /live");
    const keyMeta = resolveApiKeyWithMetadata();

    if (!keyMeta.isValid || !keyMeta.key) {
      const isCloud =
        (process.env.NODE_ENV === "production" || keyMeta.source === "GEMINI_API_KEY") &&
        process.env.SORA_LAUNCHED_BY !== "electron";
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
          if (turn && (turn.role === "user" || turn.role === "model") && turn.text) {
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

    let currentGeminiState: GeminiSessionState = "STARTING_GEMINI";
    let inFlightCreatePromise: Promise<any> | null = null;
    let session: any = null;
    const currentModelResponseRef = { text: "" };

    const persistContextSnapshot = () => {
      const safeTurns = dialogueHistory.slice(-10).map((t) => ({
        role: (t.role === "model" ? "model" : "user") as "user" | "model",
        text: t.text,
      }));
      remoteSessionManager
        .updateDeviceSessionState(deviceId, {
          connectionState: currentGeminiState === "READY" ? "READY" : "CONNECTED",
          geminiState: currentGeminiState,
          lastGeminiTimestamp:
            currentGeminiState === "READY" ? new Date().toISOString() : undefined,
          recentContext: safeTurns,
        })
        .catch(() => {});
    };

    const flags = {
      isRotating: false,
      isClientClosed: false,
      geminiRecreateAttempts: 0,
      maxGeminiRecreateAttempts: 3,
      onGeminiStateChange: (
        nextState: "STARTING_GEMINI" | "READY" | "RECREATING" | "CLOSED" | "FAILED",
      ) => {
        currentGeminiState = nextState;
        persistContextSnapshot();
      },
    };

    this._send(clientWs, {
      type: "status",
      status: "connecting_gemini",
      geminiState: "STARTING_GEMINI",
    });

    const createOrRotateGeminiSession = async (isRecreation = false): Promise<any> => {
      if (flags.isClientClosed || clientWs.readyState !== 1) return null;
      if (inFlightCreatePromise) {
        return inFlightCreatePromise;
      }

      inFlightCreatePromise = (async () => {
        try {
          const newSession = await this.factory.createSession({
            apiKey,
            clientWs,
            flags,
            dialogueHistory,
            currentModelResponseRef,
            onRotate: () => createOrRotateGeminiSession(true),
          });
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
    clientWs.on("message", (rawMsg: any) => {
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
            currentGeminiState = "RECREATING";
            this._send(clientWs, {
              type: "status",
              status: "connecting_gemini",
              geminiState: "RECREATING",
            });
            createOrRotateGeminiSession(true).catch((err: any) => {
              const sanitized = sanitizeGeminiErrorReason(err?.message || String(err));
              this._send(clientWs, {
                type: "status",
                status: "session_closed",
                geminiState: "CLOSED",
                reason: `Could not recreate Gemini session: ${sanitized}`,
              });
            });
          }
          return;
        }

        if (msg.audio) {
          audioFramesIn++;
          const buf = Buffer.from(msg.audio, "base64");
          let peak = 0;
          for (let i = 0; i < buf.length; i += 2) {
            const s = Math.abs(buf.readInt16LE(i));
            if (s > peak) peak = s;
          }
          if (audioFramesIn === 1 || audioFramesIn % 15 === 0) {
            console.log(
              `[ConversationManager] Forwarding user audio frame #${audioFramesIn} (${msg.audio.length} chars, peak: ${peak})`,
            );
          }
          if (!session && currentGeminiState === "CLOSED" && !inFlightCreatePromise) {
            createOrRotateGeminiSession(true).catch(() => {});
          }
          const blob = { data: msg.audio, mimeType: "audio/pcm;rate=16000" };
          session?.sendRealtimeInput?.({
            audio: blob,
          });
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
        }
      } catch (e) {
        console.error("Error editing/forwarding client frame message:", e);
      }
    });

    clientWs.on("close", () => {
      flags.isClientClosed = true;
      currentGeminiState = "CLOSED";
      persistContextSnapshot();
      console.log("Client disconnected, closing Gemini session");
      try {
        session?.close();
      } catch (_e) {}
    });

    try {
      await createOrRotateGeminiSession(dialogueHistory.length > 0);
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
