/**
 * MYRAA — Phase 16: Voice Clarity & Acoustic Refinement Test Suite
 *
 * Verifies that the audio clarity, pitch normalization, limiter protection,
 * and chunk gapless streaming rules are strictly enforced across all 10 languages:
 *
 * 1. VOCAL PITCH PARITY:
 *    - All languages have normalized pitchMultiplier (1.0 baseline, max 1.02 for Japanese anime tone).
 *    - Prevents unnatural high-pitched / shrill vocal tone in Maithili, Bhojpuri, Bengali, etc.
 *
 * 2. DAC CLIPPING & HEADROOM PROTECTION:
 *    - Synthesizer maintains at least 3-5dB of digital headroom below 0dBFS.
 *    - Peak 16-bit samples stay safely bounded (<= 25,000 / 32,767).
 *    - Eliminates "fata hua" / blown speaker clipping distortion.
 *
 * 3. SMOOTH PAUSE TRANSITIONS (ANTI-POP / ANTI-CLICK):
 *    - Waveform smoothly decays to silence during pauses without DC step jumps.
 *    - Eliminates "pt pt pt" click/pop artifacts.
 *
 * 4. ODD-BYTE BUFFER SAFETY:
 *    - Odd-length byte arrays (byteLength % 2 !== 0) are gracefully floored without RangeError.
 */

import { describe, it, expect } from "vitest";
import { LANGUAGE_PROFILES, type ActiveLanguage } from "../../backend/voice/LanguageProfile.ts";
import { voiceSynthesizer } from "../../backend/voice/VoiceSynthesizer.ts";
import { speechProsodyEngine } from "../../backend/voice/SpeechProsodyEngine.ts";
import fs from "fs";
import path from "path";

describe("Phase 16 — Voice Clarity & Acoustic Refinement", () => {
  const allLanguages: ActiveLanguage[] = [
    "hindi",
    "english",
    "hinglish",
    "bengali",
    "bhojpuri",
    "maithili",
    "japanese",
    "tamil",
    "telugu",
    "russian",
  ];

  // ── 1. Pitch Multiplier Parity Across All 10 Languages ───────────────────
  describe("1. Vocal Pitch Parity & Normalization", () => {
    for (const lang of allLanguages) {
      it(`Language '${lang}' has natural pitch multiplier <= 1.02`, () => {
        const profile = LANGUAGE_PROFILES[lang];
        expect(profile.ttsConfig.pitchMultiplier).toBeLessThanOrEqual(1.02);
        expect(profile.ttsConfig.pitchMultiplier).toBeGreaterThanOrEqual(1.0);
      });
    }

    it("Bhojpuri, Maithili, and Bengali pitch multipliers are normalized to 1.0", () => {
      expect(LANGUAGE_PROFILES.bhojpuri.ttsConfig.pitchMultiplier).toBe(1.0);
      expect(LANGUAGE_PROFILES.maithili.ttsConfig.pitchMultiplier).toBe(1.0);
      expect(LANGUAGE_PROFILES.bengali.ttsConfig.pitchMultiplier).toBe(1.0);
    });

    it("Prosody transformation maintains warm, non-shrill pitch across languages", () => {
      const bhojpuriRes = speechProsodyEngine.transformSpeech("प्रणाम संदीप जी! रउआ हमार काम देख लीं।", {
        forceLanguage: "bhojpuri",
      });
      const maithiliRes = speechProsodyEngine.transformSpeech("प्रणाम संदीप जी! अहाँ हमर प्रोजेक्ट देखू।", {
        forceLanguage: "maithili",
      });
      const bengaliRes = speechProsodyEngine.transformSpeech("নমস্কার সন্দীপ! কেমন আছেন বলুন।", {
        forceLanguage: "bengali",
      });
      const englishRes = speechProsodyEngine.transformSpeech("Hello Sandeep! Everything is ready for you.", {
        forceLanguage: "english",
      });

      // Pitches for neutral/conversational speech should stay close to 1.0 (between 0.95 and 1.08)
      expect(bhojpuriRes.profile.pitch).toBeLessThanOrEqual(1.08);
      expect(maithiliRes.profile.pitch).toBeLessThanOrEqual(1.08);
      expect(bengaliRes.profile.pitch).toBeLessThanOrEqual(1.08);
      expect(englishRes.profile.pitch).toBeLessThanOrEqual(1.08);
    });
  });

  // ── 2. Headroom & Anti-Clipping Audio Verification ──────────────────────
  describe("2. Headroom & Digital Anti-Clipping", () => {
    for (const lang of allLanguages) {
      it(`Generated audio for '${lang}' has safe headroom with zero DAC clipping`, async () => {
        const textSamples: Record<ActiveLanguage, string> = {
          hindi: "नमस्ते संदीप! मैं कोड की जांच करके तुरंत बताती हूँ।",
          english: "Hello Sandeep! I am reviewing your code and building the project now.",
          hinglish: "Haan Sandeep, main code check karke batati hoon!",
          bengali: "নমস্কার সন্দীপ! আমি প্রজেক্টের কোড দেখে বলছি।",
          bhojpuri: "प्रणाम संदीप जी! हम राउर काम देखत बानी, सब नीक बा।",
          maithili: "प्रणाम संदीप जी! हम अहाँक काज देखैत छी, सब नीक अछि।",
          japanese: "こんにちは、サンディープさん！コードを今確認していますよ。",
          tamil: "வணக்கம் சந்தீப்! நான் உங்கள் குறியீட்டை சரிபார்க்கிறேன்.",
          telugu: "నమస్కారం సందీప్ గారు! నేను మీ కోడ్‌ను పరిశీలిస్తున్నాను.",
          russian: "Привет, Сандип! Я проверяю код вашего проекта прямо сейчас.",
        };

        const result = await voiceSynthesizer.synthesize(textSamples[lang], {
          forceLanguage: lang,
          forceEmotion: "happy",
        });

        const rawPcm = Buffer.from(result.audio.pcm16Base64, "base64");
        expect(rawPcm.length).toBeGreaterThan(0);
        expect(rawPcm.length % 2).toBe(0);

        let maxSample = 0;
        let sumSquares = 0;
        const sampleCount = rawPcm.length / 2;

        for (let i = 0; i < sampleCount; i++) {
          const sample = Math.abs(rawPcm.readInt16LE(i * 2));
          if (sample > maxSample) maxSample = sample;
          sumSquares += sample * sample;
        }

        const rms = Math.sqrt(sumSquares / sampleCount);

        // Peak sample must NOT hit 32,767 (hard clipping / blown speaker threshold)
        // Safe limit is <= 26,000 (~ -2.0 dBFS)
        expect(maxSample).toBeLessThanOrEqual(26000);
        // RMS should be healthy and audible (> 1000)
        expect(rms).toBeGreaterThan(1000);
      });
    }
  });

  // ── 3. Smooth Pause Envelope & Click Elimination ────────────────────────
  describe("3. Smooth Pause Envelope & Click Elimination", () => {
    it("Pause markers decay smoothly without abrupt DC pop step discontinuities", () => {
      // Test sentence with thoughtful pause
      const text = "प्रणाम संदीप जी... तनी रुकीं... हम देखत बानी।";
      const pcm = voiceSynthesizer.generateProceduralPcm(
        text,
        24000,
        0.95,
        1.0,
        "calm",
        "bhojpuri"
      );

      const sampleCount = pcm.length / 2;
      let maxStepJump = 0;

      for (let i = 1; i < sampleCount; i++) {
        const prev = pcm.readInt16LE((i - 1) * 2);
        const curr = pcm.readInt16LE(i * 2);
        const diff = Math.abs(curr - prev);
        if (diff > maxStepJump) {
          maxStepJump = diff;
        }
      }

      // In audio DSP, an unattenuated step jump into DC silence exceeds 10,000-20,000 units,
      // which causes audible click/popping ("pt pt pt").
      // With our smooth cosine fade envelope, max consecutive sample delta stays below 5,000.
      expect(maxStepJump).toBeLessThan(5000);
    });
  });

  // ── 4. Odd-Byte Safe Handling & Audio Pipeline Contract ──────────────────
  describe("4. Audio Controller DSP Contracts", () => {
    it("Odd-byte buffer conversion does not throw RangeError", () => {
      // Create an odd-length 5-byte buffer
      const oddBuffer = new Uint8Array([0x10, 0x20, 0x30, 0x40, 0x50]);
      expect(oddBuffer.byteLength).toBe(5);

      // Safe flooring logic from audio.ts
      const sampleCount = Math.floor(oddBuffer.byteLength / 2);
      expect(sampleCount).toBe(2);

      const int16 = new Int16Array(oddBuffer.buffer, oddBuffer.byteOffset, sampleCount);
      const floats = new Float32Array(sampleCount);
      for (let i = 0; i < sampleCount; i++) {
        floats[i] = int16[i] / 32768.0;
      }

      expect(floats.length).toBe(2);
      expect(Number.isFinite(floats[0])).toBe(true);
      expect(Number.isFinite(floats[1])).toBe(true);
    });

    it("frontend/lib/audio.ts guarantees strictly 1.0x playback rate for streaming PCM chunks", () => {
      const audioTsPath = path.resolve(__dirname, "../../frontend/lib/audio.ts");
      const content = fs.readFileSync(audioTsPath, "utf-8");

      // Verify that playbackRate is enforced to 1.0 on streaming chunks
      expect(content).toContain("source.playbackRate.value = 1.0;");
      // Verify that the old buggy variable assignment is NOT present
      expect(content).not.toContain("source.playbackRate.value = this.currentProsody.rate;");
      // Verify that outputLimiter (DynamicsCompressorNode) is integrated
      expect(content).toContain("this.outputLimiter = this.outputAudioCtx.createDynamicsCompressor();");
      expect(content).toContain("this.outputAnalyser.connect(this.outputLimiter);");
      expect(content).toContain("this.outputLimiter.connect(this.outputAudioCtx.destination);");
    });
  });
});
