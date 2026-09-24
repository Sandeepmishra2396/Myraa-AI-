/**
 * MYRAA — ConversationManager
 *
 * Manages the full lifecycle of a single client WebSocket connection to the
 * /live endpoint:
 *
 *   1. Validates the API key
 *   2. Opens a Gemini Live session via GeminiSessionFactory
 *   3. Forwards client messages (audio PCM, video frames, toolResponses)
 *   4. Handles GoAway seamless rotation (delegates back to factory)
 *   5. Cleans up on client disconnect
 *
 * One ConversationManager instance is created per WebSocket connection.
 */

import { resolveApiKeyWithMetadata } from "../../../server_paths.ts";
import { GeminiSessionFactory } from "../ai/GeminiSessionFactory.ts";

export class ConversationManager {
  private factory = new GeminiSessionFactory();

  /**
   * Handle a new client WebSocket connection.
   * Call this from the wss "connection" event.
   */
  async handleConnection(clientWs: any): Promise<void> {
    console.log("Client WebSocket connected to /live");
    const keyMeta = resolveApiKeyWithMetadata();

    if (!keyMeta.isValid || !keyMeta.key) {
      const isCloud = process.env.NODE_ENV === "production" || keyMeta.source === "GEMINI_API_KEY";
      const isPlaceholder = Boolean(keyMeta.isPlaceholder || (keyMeta.masked && keyMeta.masked.endsWith("HERE")));
      const errMsg = isPlaceholder
        ? "SERVER_API_KEY_PLACEHOLDER: The server environment variable GEMINI_API_KEY on Render contains an unconfigured template placeholder (ends in HERE). Please update GEMINI_API_KEY in the Render Dashboard with a valid Google Gemini API key from Google AI Studio."
        : isCloud
        ? "NO_SERVER_API_KEY: Server environment variable GEMINI_API_KEY is missing or invalid. Please configure your Google Gemini API key in the Render Dashboard."
        : "NO_API_KEY: Please configure a valid Gemini API key (starts with AIzaSy) in Settings to start talking to MYRAA.";

      console.warn(
        `[Gemini Auth] Connection rejected: ${errMsg} (Source: ${keyMeta.source}, Prefix: ${keyMeta.prefix}, Length: ${keyMeta.length})`,
      );
      this._send(clientWs, {
        type: "error",
        error: errMsg,
      });
      clientWs.close();
      return;
    }

    const apiKey = keyMeta.key;
    console.log(
      `[Gemini Auth] Using active key from ${keyMeta.source} (Prefix: ${keyMeta.prefix}, Length: ${keyMeta.length}, Masked: ${keyMeta.masked})`,
    );

    // Synchronize process.env so SDK doesn't warn about conflicting env vars
    process.env.GEMINI_API_KEY = apiKey;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GOOGLE_GENAI_API_KEY;

    // Mutable per-connection state
    const flags = { isRotating: false, isClientClosed: false };
    const dialogueHistory: { role: string; text: string }[] = [];
    const currentModelResponseRef = { text: "" };

    // session holder — reassigned on GoAway rotation
    let session: any = null;

    this._send(clientWs, { type: "status", status: "connecting_gemini" });

    const rotate = async () => {
      session = await this.factory.createSession({
        apiKey,
        clientWs,
        flags,
        dialogueHistory,
        currentModelResponseRef,
        onRotate: rotate,
      });
    };

    try {
      session = await this.factory.createSession({
        apiKey,
        clientWs,
        flags,
        dialogueHistory,
        currentModelResponseRef,
        onRotate: rotate,
      });
    } catch (err: any) {
      console.error("Error connecting to Gemini Live API:", err);
      clientWs.send(
        JSON.stringify({
          type: "error",
          error: `Could not connect to Gemini: ${err.message || err}`,
        }),
      );
      clientWs.close();
      return;
    }

    // Forward client messages to the active session
    let audioFramesIn = 0;
    clientWs.on("message", (rawMsg: any) => {
      try {
        const msg = JSON.parse(rawMsg.toString());
        if (msg.audio) {
          audioFramesIn++;
          const buf = Buffer.from(msg.audio, "base64");
          let peak = 0;
          for (let i = 0; i < buf.length; i += 2) {
            const s = Math.abs(buf.readInt16LE(i));
            if (s > peak) peak = s;
          }
          if (audioFramesIn === 1 || audioFramesIn % 15 === 0) {
            console.log(`[ConversationManager] Forwarding user audio frame #${audioFramesIn} (${msg.audio.length} chars, peak: ${peak})`);
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
          if (typeof session?.sendClientContent === "function") {
            session.sendClientContent({
              turns: [{ role: "user", parts: [{ text: String(msg.text) }] }],
              turnComplete: true,
            });
          } else if (typeof session?.sendRealtimeInput === "function") {
            session.sendRealtimeInput({ text: String(msg.text) });
          }
        } else if (msg.type === "toolResponse") {
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
      } catch (e) {
        console.error("Error editing/forwarding client frame message:", e);
      }
    });

    clientWs.on("close", () => {
      flags.isClientClosed = true;
      console.log("Client disconnected, closing Gemini session");
      try {
        session?.close();
      } catch (_e) {}
    });
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
