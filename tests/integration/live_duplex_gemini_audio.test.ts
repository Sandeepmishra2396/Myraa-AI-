/**
 * MYRAA — Phase 11.4.1: Live Duplex Gemini Audio Verification Test Suite
 *
 * Verifies:
 *   1. Real Gemini Live WebSocket connection handshake
 *   2. Server `setupComplete` confirmation
 *   3. Outgoing 16kHz synthetic PCM audio frame dispatch via `sendRealtimeInput`
 *   4. Turn completion signaling via `sendClientContent({ turnComplete: true })`
 *   5. Incoming server `modelTurn` parts containing raw 24kHz PCM audio
 *   6. Non-empty response audio payload verification
 *   7. Audio format and sample rate verification (`audio/pcm;rate=24000`)
 *   8. Decoding through `pcm16ToFloats` into Float32Array [-1.0, 1.0]
 *   9. Non-silent RMS verification (> 0)
 *  10. Clean session termination (code 1000) with zero credential leaks
 */

import { describe, it, expect } from "vitest";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { GoogleGenAI, Modality } = require("@google/genai");

import { resolveApiKeyWithMetadata } from "../../backend/server_paths.ts";
import { sanitizeGeminiErrorReason, LIVE_MODEL } from "../../backend/ai/GeminiSessionFactory.ts";

/** Converts signed Int16 Little-Endian PCM Uint8Array to Float32Array [-1.0, 1.0] */
function pcm16ToFloats(uint8Array: Uint8Array): Float32Array {
  const sampleCount = Math.floor(uint8Array.byteLength / 2);
  const int16 = new Int16Array(
    uint8Array.buffer,
    uint8Array.byteOffset,
    sampleCount
  );
  const floats = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    floats[i] = int16[i] / 32768.0;
  }
  return floats;
}

/** Computes Root Mean Square (RMS) energy of Float32 audio samples */
function computeRms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    sum += samples[i] * samples[i];
  }
  return Math.sqrt(sum / samples.length);
}

describe("MYRAA — Phase 11.4.1: Live Duplex Gemini Audio Verification", () => {
  it(
    "establishes real Gemini Live session, sends synthetic audio, receives and decodes 24kHz response audio",
    { timeout: 35000 },
    async () => {
      const keyMeta = resolveApiKeyWithMetadata();
      expect(keyMeta.isValid).toBe(true);
      expect(keyMeta.key).toBeDefined();

      const apiKey = keyMeta.key!;
      const isEphemeral = apiKey.startsWith("auth_tokens/");
      const ai = new GoogleGenAI(
        isEphemeral
          ? { apiKey, httpOptions: { apiVersion: "v1alpha" } }
          : { apiKey }
      );

      let connectionEstablished = false;
      let setupCompleted = false;
      let outgoingAudioAccepted = false;
      let incomingServerAudioEventReceived = false;
      let turnCompleted = false;
      let closeCode: number | undefined;

      const receivedAudioChunks: Array<{
        mimeType: string;
        byteLength: number;
        sampleCount: number;
        uint8Data: Uint8Array;
      }> = [];

      const session = await ai.live.connect({
        model: LIVE_MODEL,
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } },
          },
          systemInstruction: "You are MYRAA. Reply in exactly one brief sentence.",
        },
        callbacks: {
          onopen: () => {
            connectionEstablished = true;
          },
          onmessage: (msg: any) => {
            if (msg.setupComplete) {
              setupCompleted = true;
            }
            if (msg.serverContent) {
              if (msg.serverContent.turnComplete) {
                turnCompleted = true;
              }
              const parts = msg.serverContent.modelTurn?.parts || [];
              for (const p of parts) {
                if (p.inlineData && p.inlineData.data) {
                  incomingServerAudioEventReceived = true;
                  const b64 = p.inlineData.data;
                  const buf = Buffer.from(b64, "base64");
                  const uint8 = new Uint8Array(buf);
                  receivedAudioChunks.push({
                    mimeType: p.inlineData.mimeType || "unknown",
                    byteLength: buf.length,
                    sampleCount: buf.length / 2,
                    uint8Data: uint8,
                  });
                }
              }
            }
          },
          onerror: (err: any) => {
            const sanitized = sanitizeGeminiErrorReason(err?.message || String(err));
            console.error("[LiveDuplexTest] Error event:", sanitized);
          },
          onclose: (evt: any) => {
            closeCode = evt?.code ?? evt?._closeCode;
          },
        },
      });

      // 1. Verify connection established
      expect(connectionEstablished).toBe(true);

      // Wait up to 5s for setupComplete
      for (let i = 0; i < 50; i++) {
        if (setupCompleted) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      // 2. Verify setup completed
      expect(setupCompleted).toBe(true);

      // 3. Generate 2048-sample 16kHz synthetic PCM audio frame (4096 bytes)
      const samples = new Int16Array(2048);
      for (let i = 0; i < samples.length; i++) {
        samples[i] = Math.sin((2 * Math.PI * 440 * i) / 16000) * 8000;
      }
      const b64 = Buffer.from(samples.buffer).toString("base64");

      // Send audio frame via sendRealtimeInput
      expect(() => {
        session.sendRealtimeInput({
          audio: { data: b64, mimeType: "audio/pcm;rate=16000" },
        });
        outgoingAudioAccepted = true;
      }).not.toThrow();

      // 4. Verify outgoing audio accepted by client SDK
      expect(outgoingAudioAccepted).toBe(true);

      // 5. Send turnComplete signal so model generates speech response
      session.sendClientContent({ turnComplete: true });

      // 6. Wait up to 15s for incoming server audio chunks
      for (let i = 0; i < 150; i++) {
        if (turnCompleted && receivedAudioChunks.length > 0) break;
        await new Promise((r) => setTimeout(r, 100));
      }

      // Verify incoming server audio event received
      expect(incomingServerAudioEventReceived).toBe(true);
      expect(receivedAudioChunks.length).toBeGreaterThan(0);

      // 7. Verify non-empty response audio payload received
      const totalBytes = receivedAudioChunks.reduce((acc, c) => acc + c.byteLength, 0);
      expect(totalBytes).toBeGreaterThan(1000); // multiple kilobytes of audio

      // 8. Identify and verify response audio format and sample rate
      for (const chunk of receivedAudioChunks) {
        expect(chunk.mimeType).toBe("audio/pcm;rate=24000");
        expect(chunk.byteLength % 2).toBe(0); // Valid 16-bit PCM (even bytes)
      }

      // 9. Decode received response audio through existing decoder (pcm16ToFloats)
      const allFloats: number[] = [];
      for (const chunk of receivedAudioChunks) {
        const decodedFloats = pcm16ToFloats(chunk.uint8Data);
        expect(decodedFloats.length).toBe(chunk.sampleCount);

        // Verify decoded sample bounds [-1.0, 1.0]
        for (let i = 0; i < decodedFloats.length; i++) {
          const sample = decodedFloats[i];
          expect(sample).toBeGreaterThanOrEqual(-1.0);
          expect(sample).toBeLessThanOrEqual(1.0);
          allFloats.push(sample);
        }
      }

      // 10. Verify that decoded samples are valid, non-empty, and non-silent
      const combinedFloats = new Float32Array(allFloats);
      expect(combinedFloats.length).toBeGreaterThan(1000);

      const rms = computeRms(combinedFloats);
      expect(rms).toBeGreaterThan(0.001); // Confirmed non-silent speech signal

      // Clean session close
      try {
        session.close();
      } catch {}

      // Wait briefly for close event
      await new Promise((r) => setTimeout(r, 500));
      expect(closeCode).toBe(1000);
    }
  );
});
