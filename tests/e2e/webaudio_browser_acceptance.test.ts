/**
 * MYRAA — Phase 11.4.1: Real Browser WebAudio E2E Acceptance Test Runner
 *
 * Spawns Electron's Chromium browser engine to execute real WebAudio tests:
 *   1. User-gesture audio activation
 *   2. Real AudioContext creation & resume (suspended -> running)
 *   3. PCM audio decoding (Int16 LE -> Float32Array [-1.0, 1.0])
 *   4. Actual AudioBuffer creation at 24kHz
 *   5. AudioBufferSourceNode scheduling with 25ms lead anchor
 *   6. Playback timeline progression
 *   7. Audio interruption and cancellation (source.stop(), flush)
 *   8. Resource cleanup (audioContext.close(), state: closed)
 *   9. No duplicate playback after reconnect (monotonic sequential scheduling)
 *  10. No unexpected buffer underruns
 *  11. Programmatic browser output capture (non-silent waveform through limiter graph)
 */

import { describe, it, expect } from "vitest";
import { execFile } from "child_process";
import path from "path";
import electronPath from "electron";

describe("MYRAA — Phase 11.4.1: Real Browser WebAudio E2E Acceptance", () => {
  it(
    "executes real WebAudio pipeline inside Electron Chromium and verifies all 10 browser playback requirements",
    { timeout: 25000 },
    async () => {
      const scriptPath = path.resolve(__dirname, "webaudio_browser_acceptance.cjs");

      const runResult = await new Promise<{ stdout: string; stderr: string; exitCode: number }>(
        (resolve) => {
          execFile(
            electronPath as unknown as string,
            [scriptPath],
            {
              cwd: path.resolve(__dirname, "../.."),
              env: { ...process.env, ELECTRON_ENABLE_LOGGING: "1" },
            },
            (error, stdout, stderr) => {
              resolve({
                stdout,
                stderr,
                exitCode: error ? (error.code as number) || 1 : 0,
              });
            }
          );
        }
      );

      expect(runResult.exitCode).toBe(0);

      // Parse JSON output from the browser
      const jsonStart = runResult.stdout.indexOf("{");
      const jsonEnd = runResult.stdout.lastIndexOf("}");
      expect(jsonStart).toBeGreaterThanOrEqual(0);
      expect(jsonEnd).toBeGreaterThan(jsonStart);

      const parsed = JSON.parse(runResult.stdout.slice(jsonStart, jsonEnd + 1));
      expect(parsed.success).toBe(true);

      const a = parsed.assertions;
      // 1. Browser user-gesture audio activation
      expect(a.userGestureTriggered).toBe(true);

      // 2. Real AudioContext creation and resume
      expect(a.hasRealAudioContextClass).toBe(true);
      expect(a.isRealAudioContextInstance).toBe(true);
      expect(a.sampleRate).toBe(24000);
      expect(a.contextRunning).toBe(true);

      // 3. PCM audio decoding
      expect(a.pcmDecodedSampleCount).toBe(1200);
      expect(a.pcmDecodedWithinBounds).toBe(true);
      expect(a.pcmDecodedNonZero).toBe(true);

      // 4. Actual AudioBuffer creation
      expect(a.isRealAudioBuffer).toBe(true);
      expect(a.audioBufferDuration).toBeCloseTo(0.05, 2);
      expect(a.audioBufferChannels).toBe(1);

      // 5. Audio graph routing & AudioBufferSourceNode scheduling with 25ms lead anchor
      expect(a.graphConnected).toBe(true);
      expect(a.sourceScheduled).toBe(true);
      expect(a.scheduledStartTime).toBe(0.025);

      // 6. Playback timeline progression
      expect(a.timelineProgressed).toBe(true);
      expect(a.renderedSampleCount).toBe(24000);

      // 11. Programmatic browser output capture
      expect(a.outputAudioEmergence).toBe(true);
      expect(a.maxPeakClampedBelowCeiling).toBe(true);
      expect(a.maxPeakLevel).toBeGreaterThan(0.05);
      expect(a.maxPeakLevel).toBeLessThanOrEqual(1.0);

      // 7. Audio interruption and cancellation
      expect(a.interruptionStopSucceeded).toBe(true);

      // 9. No duplicate playback after reconnect
      expect(a.monotonicScheduling).toBe(true);

      // 10. No unexpected buffer underruns
      expect(a.noUnderrun).toBe(true);

      // 8. Resource cleanup
      expect(a.contextClosed).toBe(true);
    }
  );
});
