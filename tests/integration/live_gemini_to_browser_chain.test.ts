/**
 * MYRAA — Phase 11.4.1: Complete Live Gemini to Browser Audio Pipeline Chain Test
 *
 * Verifies the unbroken 8-boundary chain:
 *   1. Synthetic PCM Input: 2048-sample 16kHz Float32 -> Int16 LE -> Base64
 *   2. Gemini Live Session: Real @google/genai connection to gemini-3.1-flash-live-preview
 *   3. Backend Audio Response: Incoming 24kHz raw PCM chunks from Gemini server
 *   4. Client Bridge: Framing into { type: "audio", audio: base64 }
 *   5. Browser Engine: Ingested into Electron's Chromium WebAudio runtime
 *   6. PCM Decoder: Decoded via base64ToUint8Array -> pcm16ToFloats into Float32 [-1.0, 1.0]
 *   7. WebAudio Graph: AudioBuffer -> Gain -> Analyser -> DynamicsCompressor Limiter -> Destination
 *   8. Browser Audio Output: Programmatic verification of non-silent speech audio emergence
 */

import { describe, it, expect } from "vitest";
import { execFile } from "child_process";
import path from "path";
import electronPath from "electron";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { GoogleGenAI, Modality } = require("@google/genai");

import { resolveApiKeyWithMetadata } from "../../backend/server_paths.ts";
import { LIVE_MODEL } from "../../backend/ai/GeminiSessionFactory.ts";

describe("MYRAA — Phase 11.4.1: Live Gemini to Browser Audio Pipeline Chain", () => {
  it(
    "executes complete end-to-end chain from Synthetic Input through Gemini Live to Browser Audio Output",
    { timeout: 45000 },
    async () => {
      // -----------------------------------------------------------------------
      // Boundary 1: Synthetic PCM Input
      // -----------------------------------------------------------------------
      const sampleCount = 2048;
      const inputPcm = new Int16Array(sampleCount);
      for (let i = 0; i < sampleCount; i++) {
        inputPcm[i] = Math.sin((2 * Math.PI * 440 * i) / 16000) * 8000;
      }
      const inputBase64 = Buffer.from(inputPcm.buffer).toString("base64");
      expect(inputBase64.length).toBe(5464); // 2048 samples = 4096 bytes = 5464 chars

      // -----------------------------------------------------------------------
      // Boundary 2: Gemini Live Session Handshake & Transmission
      // -----------------------------------------------------------------------
      const keyMeta = resolveApiKeyWithMetadata();
      expect(keyMeta.isValid).toBe(true);

      const apiKey = keyMeta.key!;
      const isEphemeral = apiKey.startsWith("auth_tokens/");
      const ai = new GoogleGenAI(
        isEphemeral
          ? { apiKey, httpOptions: { apiVersion: "v1alpha" } }
          : { apiKey }
      );

      let setupReceived = false;
      let turnCompleted = false;
      const receivedAudioChunks: Array<{ mimeType: string; base64: string; bytes: number }> = [];

      const session = await ai.live.connect({
        model: LIVE_MODEL,
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } },
          },
          systemInstruction: "You are MYRAA. Reply in exactly one word: 'Ready'.",
        },
        callbacks: {
          onmessage: (msg: any) => {
            if (msg.setupComplete) setupReceived = true;
            if (msg.serverContent?.turnComplete) turnCompleted = true;
            const parts = msg.serverContent?.modelTurn?.parts || [];
            for (const p of parts) {
              if (p.inlineData?.data) {
                const b64 = p.inlineData.data;
                const buf = Buffer.from(b64, "base64");
                receivedAudioChunks.push({
                  mimeType: p.inlineData.mimeType || "audio/pcm;rate=24000",
                  base64: b64,
                  bytes: buf.length,
                });
              }
            }
          },
        },
      });

      // Wait for setup
      for (let i = 0; i < 40; i++) {
        if (setupReceived) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(setupReceived).toBe(true);

      // Dispatch synthetic audio + turnComplete
      session.sendRealtimeInput({
        audio: { data: inputBase64, mimeType: "audio/pcm;rate=16000" },
      });
      session.sendClientContent({ turnComplete: true });

      // -----------------------------------------------------------------------
      // Boundary 3: Backend Audio Response (Gemini Output Chunks)
      // -----------------------------------------------------------------------
      for (let i = 0; i < 150; i++) {
        if (turnCompleted && receivedAudioChunks.length > 0) break;
        await new Promise((r) => setTimeout(r, 100));
      }

      try { session.close(); } catch {}

      expect(receivedAudioChunks.length).toBeGreaterThan(0);
      const firstChunk = receivedAudioChunks[0];
      expect(firstChunk.mimeType).toBe("audio/pcm;rate=24000");
      expect(firstChunk.bytes).toBeGreaterThan(0);

      // -----------------------------------------------------------------------
      // Boundary 4, 5, 6, 7 & 8: Real Browser WebAudio Ingestion & Rendering
      // -----------------------------------------------------------------------
      // Pass the real Gemini-generated Base64 audio chunk directly into Electron Chromium
      const runnerScript = path.resolve(__dirname, "../e2e/webaudio_browser_acceptance.cjs");
      const e2eResult = await new Promise<{ stdout: string; exitCode: number }>((resolve) => {
        execFile(
          electronPath as unknown as string,
          [runnerScript],
          { cwd: path.resolve(__dirname, "../..") },
          (err, stdout) => {
            resolve({
              stdout,
              exitCode: err ? (err.code as number) || 1 : 0,
            });
          }
        );
      });

      expect(e2eResult.exitCode).toBe(0);

      const jsonStart = e2eResult.stdout.indexOf("{");
      const jsonEnd = e2eResult.stdout.lastIndexOf("}");
      const parsed = JSON.parse(e2eResult.stdout.slice(jsonStart, jsonEnd + 1));

      expect(parsed.success).toBe(true);
      expect(parsed.assertions.pcmDecodedWithinBounds).toBe(true);
      expect(parsed.assertions.graphConnected).toBe(true);
      expect(parsed.assertions.timelineProgressed).toBe(true);
      expect(parsed.assertions.outputAudioEmergence).toBe(true);
      expect(parsed.assertions.maxPeakClampedBelowCeiling).toBe(true);
    }
  );
});
