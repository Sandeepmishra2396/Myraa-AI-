/**
 * MYRAA — Phase 14: Natural Voice & Expressive Speech Test Suite
 *
 * Verifies 30+ comprehensive conversational scenarios testing:
 *   1. Natural short reactions (hmm, ohh, aha, haha, wait, oho, achha, are waah, suno)
 *   2. Contextual pauses and natural sentence rhythm
 *   3. Emphasis on important words
 *   4. Dynamic speaking speed and pitch modulation
 *   5. Six distinct emotion states (neutral, happy, excited, curious, concerned, calm)
 *   6. Contextual light laughter (humor/playful only, strictly barred on errors/neutral)
 *   7. Natural interruptions and quick acknowledgements
 *   8. Strict anti-repetition policy for fillers across consecutive turns
 *   9. Gating policy: avoid adding filler to every sentence / neutral responses
 *   10. Preservation of factual meaning, paths, and code snippets
 *   11. Native multilingual support: Hindi, Hinglish, and English
 *   12. Guardrails: No forced emotions on neutral tasks, no romantic/sexual roleplay
 *   13. Audio synthesis: 24kHz 16-bit PCM and standard WAV output verified
 *   14. Platform audio contracts: Android download frame and Windows audio playback
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  SpeechProsodyEngine,
  speechProsodyEngine,
} from "../../backend/voice/SpeechProsodyEngine.ts";
import {
  VoiceSynthesizer,
  voiceSynthesizer,
} from "../../backend/voice/VoiceSynthesizer.ts";
import { EmotionState } from "../../backend/voice/ProsodyTypes.ts";

describe("Phase 14 — MYRAA Natural Voice & Expressive Speech Engine", () => {
  let engine: SpeechProsodyEngine;
  let synth: VoiceSynthesizer;

  beforeEach(() => {
    engine = new SpeechProsodyEngine();
    synth = new VoiceSynthesizer();
  });

  // =========================================================================
  // SCENARIO 1: Hindi Warm Greeting
  // =========================================================================
  it("Scenario 1: Hindi Warm Greeting embodies happy emotion and gentle cadence", () => {
    const userPrompt = "नमस्ते मायरा, कैसी हो आज?";
    const response = "नमस्ते संदीप! मैं बहुत खुश हूँ। आप कैसे हैं?";

    const result = engine.transformSpeech(response, {
      userPrompt,
      isGreeting: true,
    });
    expect(result.profile.emotion).toBe("happy");
    expect(result.profile.language).toBe("hindi");
    expect(result.profile.rate).toBeGreaterThan(1.0); // Bright, smiling tempo
    expect(result.expressiveText).toContain("नमस्ते");
    expect(result.ssml).toContain("<prosody");
  });

  // =========================================================================
  // SCENARIO 2: Hinglish Morning Greeting
  // =========================================================================
  it("Scenario 2: Hinglish Morning Greeting uses authentic Hinglish reaction", () => {
    const userPrompt = "Good morning Myraa, aaj kya plans hain?";
    const response = "Good morning Sandeep! Aaj hum bohot interesting cheezein explore karenge.";

    const result = engine.transformSpeech(response, {
      userPrompt,
      isGreeting: true,
    });
    expect(result.profile.emotion).toBe("happy");
    expect(result.profile.language).toBe("hinglish");
    expect(result.decision.shouldAddReaction).toBe(true);
    expect(["Aha!", "Haha!", "Arre waah!", "Nice!"]).toContain(
      result.decision.reaction
    );
  });

  // =========================================================================
  // SCENARIO 3: English Friendly Greeting
  // =========================================================================
  it("Scenario 3: English Friendly Greeting produces warm conversational prosody", () => {
    const userPrompt = "Hey Myraa, great to talk to you!";
    const response = "Hi Sandeep! It is wonderful to hear from you today.";

    const result = engine.transformSpeech(response, {
      userPrompt,
      isGreeting: true,
    });
    expect(result.profile.emotion).toBe("happy");
    expect(result.profile.language).toBe("english");
    expect(result.profile.rate).toBeCloseTo(1.06, 1);
    expect(result.decision.pitch).toBeGreaterThan(1.0);
  });

  // =========================================================================
  // SCENARIO 4: Hindi Humorous Joke Request (Light Laughter Allowed)
  // =========================================================================
  it("Scenario 4: Hindi Humorous Joke allows contextual light laughter", () => {
    const userPrompt = "मायरा, कोई मजेदार चुटकुला सुनाओ";
    const response = "एक बार एक प्रोग्रामर दुकान गया... यह सच में बहुत मजेदार चुटकुला है!";

    const result = engine.transformSpeech(response, { userPrompt });
    expect(result.profile.emotion).toBe("happy");
    expect(result.profile.language).toBe("hindi");
    expect(result.decision.shouldAddLaughter).toBe(true);
    expect(result.expressiveText).toMatch(/हाहा\.\.\.|haha\.\.\./);
  });

  // =========================================================================
  // SCENARIO 5: Hinglish Playful Banter (Light Laughter Allowed)
  // =========================================================================
  it("Scenario 5: Hinglish Playful Banter triggers haha and cheerful tempo", () => {
    const userPrompt = "Myraa ek mast joke sunao na haha";
    const response = "Haha, suno! Computer ne coffee kyu mangi? Kyunki usko Java chahiye thi!";

    const result = engine.transformSpeech(response, { userPrompt });
    expect(result.profile.emotion).toBe("happy");
    expect(result.decision.shouldAddLaughter).toBe(true);
    expect(result.profile.rate).toBeGreaterThanOrEqual(1.04);
  });

  // =========================================================================
  // SCENARIO 6: English Playful Banter
  // =========================================================================
  it("Scenario 6: English Playful Banter incorporates light laughter", () => {
    const userPrompt = "Myraa that was hilarious haha!";
    const response = "I know right! That made my day.";

    const result = engine.transformSpeech(response, { userPrompt });
    expect(result.decision.shouldAddLaughter).toBe(true);
    expect(result.expressiveText).toContain("haha...");
  });

  // =========================================================================
  // SCENARIO 7: Hindi Coding Bug / Error (Concerned Tone, NO Laughter)
  // =========================================================================
  it("Scenario 7: Hindi Coding Error strictly forbids laughter and uses concerned tone", () => {
    const userPrompt = "मायरा, कोड में क्रैश हो रहा है, कुछ समझ नहीं आ रहा";
    const response = "चिंता मत कीजिए संदीप, हम इस एरर को मिलकर ठीक कर लेंगे।";

    const result = engine.transformSpeech(response, {
      userPrompt,
      isError: true,
    });
    expect(result.profile.emotion).toBe("concerned");
    expect(result.decision.shouldAddLaughter).toBe(false);
    expect(result.decision.laughterToken).toBeNull();
    expect(result.profile.rate).toBeLessThan(1.0); // Empathetic, unhurried
  });

  // =========================================================================
  // SCENARIO 8: Hinglish Compilation Crash (Concerned Tone, NO Laughter)
  // =========================================================================
  it("Scenario 8: Hinglish Server Crash triggers concerned tone and supportive pace", () => {
    const userPrompt = "Server crash ho gaya, database connection failed error aa raha hai";
    const response = "Let me check the logs right away. Don't worry, we will recover the connection.";

    const result = engine.transformSpeech(response, {
      userPrompt,
      isError: true,
    });
    expect(result.profile.emotion).toBe("concerned");
    expect(result.decision.shouldAddLaughter).toBe(false);
    expect(result.profile.rate).toBeCloseTo(0.95, 1);
  });

  // =========================================================================
  // SCENARIO 9: English Critical Exception (Concerned Tone)
  // =========================================================================
  it("Scenario 9: English Critical Exception maintains serious, helpful cadence", () => {
    const userPrompt = "The build failed with uncaught TypeError in auth.ts";
    const response = "I see the TypeError on line 42. Let's inspect the null reference carefully.";

    const result = engine.transformSpeech(response, {
      userPrompt,
      isError: true,
    });
    expect(result.profile.emotion).toBe("concerned");
    expect(result.decision.shouldAddLaughter).toBe(false);
    expect(result.profile.rate).toBeLessThanOrEqual(0.96);
  });

  // =========================================================================
  // SCENARIO 10: Hindi Screen Analysis Curiosity
  // =========================================================================
  it("Scenario 10: Hindi Screen Analysis Curiosity triggers inquiring prosody", () => {
    const userPrompt = "मायरा, स्क्रीन पर क्या गड़बड़ दिख रही है? जांच करो";
    const response = "स्क्रीन पर मुझे लाल निशान दिख रहा है। क्या यह सीएसएस की समस्या है?";

    const result = engine.transformSpeech(response, { userPrompt });
    expect(result.profile.emotion).toBe("curious");
    expect(result.profile.language).toBe("hindi");
  });

  // =========================================================================
  // SCENARIO 11: Hinglish UI Layout Inspection Curiosity
  // =========================================================================
  it("Scenario 11: Hinglish UI Inspection uses curious reaction and pacing", () => {
    const userPrompt = "Myraa, dekho screen par ye UI layout thoda weird lag raha hai";
    const response = "Dekhte hain... right sidebar ke flexbox container mein overflow lag raha hai.";

    const result = engine.transformSpeech(response, { userPrompt });
    expect(result.profile.emotion).toBe("curious");
    expect(result.profile.language).toBe("hinglish");
  });

  // =========================================================================
  // SCENARIO 12: English Performance Debugging Curiosity
  // =========================================================================
  it("Scenario 12: English Performance Debugging Curiosity", () => {
    const userPrompt = "Why is this query running so slow? Let us inspect it";
    const response = "The query planner shows a sequential scan. We should add an index.";

    const result = engine.transformSpeech(response, { userPrompt });
    expect(result.profile.emotion).toBe("curious");
    expect(result.decision.pitch).toBeGreaterThan(1.0);
  });

  // =========================================================================
  // SCENARIO 13: Hindi Project Completion Celebration
  // =========================================================================
  it("Scenario 13: Hindi Celebration triggers excited emotion and upbeat rate", () => {
    const userPrompt = "मायरा, हमारा प्रोजेक्ट पूरा हो गया और सारे टेस्ट पास हो गए!";
    const response = "बहुत बहुत बधाई संदीप! यह सच में बहुत शानदार काम हुआ है!";

    const result = engine.transformSpeech(response, {
      userPrompt,
      taskSuccess: true,
    });
    expect(result.profile.emotion).toBe("excited");
    expect(result.profile.rate).toBeGreaterThanOrEqual(1.10);
  });

  // =========================================================================
  // SCENARIO 14: Hinglish Deployment Milestone Success
  // =========================================================================
  it("Scenario 14: Hinglish Deployment Milestone triggers excited reaction", () => {
    const userPrompt = "Deployment completely successful ho gaya, production live hai!";
    const response = "All services are up and healthy! That went flawlessly!";

    const result = engine.transformSpeech(response, {
      userPrompt,
      taskSuccess: true,
    });
    expect(result.profile.emotion).toBe("excited");
    expect(result.decision.shouldAddReaction).toBe(true);
    expect(["Oh wow!", "Aha!", "Super!", "Waah!"]).toContain(
      result.decision.reaction
    );
  });

  // =========================================================================
  // SCENARIO 15: English Breakthrough
  // =========================================================================
  it("Scenario 15: English Breakthrough reaches peak excitement rate", () => {
    const userPrompt = "We hit 100% test coverage and zero errors!";
    const response = "That is an incredible milestone! Awesome work, Sandeep!";

    const result = engine.transformSpeech(response, {
      userPrompt,
      taskSuccess: true,
    });
    expect(result.profile.emotion).toBe("excited");
    expect(result.profile.rate).toBeCloseTo(1.14, 1);
  });

  // =========================================================================
  // SCENARIO 16: Hindi Calm Reassurance
  // =========================================================================
  it("Scenario 16: Hindi Calm Reassurance uses unhurried, peaceful tempo", () => {
    const userPrompt = "मायरा, बहुत थक गया हूँ, थोड़ा सुकून से समझाओ";
    const response = "आराम से बैठिए। हम धीरे-धीरे एक-एक कदम उठाएंगे। कोई जल्दी नहीं है।";

    const result = engine.transformSpeech(response, { userPrompt });
    expect(result.profile.emotion).toBe("calm");
    expect(result.profile.rate).toBeCloseTo(0.92, 1);
  });

  // =========================================================================
  // SCENARIO 17: Hinglish Stress Relief / Calm Pacing
  // =========================================================================
  it("Scenario 17: Hinglish Calming Cadence ensures measured breathing pauses", () => {
    const userPrompt = "Bohot tension hai, aram se step by step batao kaise solve karein";
    const response = "Chinta mat karo, pehle hum database check karenge, phir server restart karenge.";

    const result = engine.transformSpeech(response, { userPrompt });
    expect(result.profile.emotion).toBe("calm");
    expect(result.decision.rate).toBeLessThan(0.95);
  });

  // =========================================================================
  // SCENARIO 18: English Architecture Deep-Dive (Calm Pacing)
  // =========================================================================
  it("Scenario 18: English Deep Explanation uses calm steady cadence", () => {
    const userPrompt = "Walk me through the architecture calmly step by step";
    const response = "The architecture consists of three layers: gateway, conversation, and security.";

    const result = engine.transformSpeech(response, { userPrompt });
    expect(result.profile.emotion).toBe("calm");
    expect(result.profile.rate).toBeLessThanOrEqual(0.94);
  });

  // =========================================================================
  // SCENARIO 19: Strict Factual Math Query (Must be Neutral, NO Fillers)
  // =========================================================================
  it("Scenario 19: Factual Math Query stays strictly neutral with NO fillers", () => {
    const userPrompt = "What is 42 * 17?";
    const response = "42 multiplied by 17 is 714.";

    const result = engine.transformSpeech(response, {
      userPrompt,
      isFactual: true,
    });
    expect(result.profile.emotion).toBe("neutral");
    expect(result.decision.shouldAddReaction).toBe(false);
    expect(result.decision.reaction).toBeNull();
    expect(result.decision.shouldAddLaughter).toBe(false);
    expect(result.profile.rate).toBe(1.0);
  });

  // =========================================================================
  // SCENARIO 20: Strict System Status Query (Neutral, Factual)
  // =========================================================================
  it("Scenario 20: System Status Query stays neutral without artificial emotion", () => {
    const userPrompt = "What is the git status?";
    const response = "On branch main, working tree clean, nothing to commit.";

    const result = engine.transformSpeech(response, {
      userPrompt,
      isFactual: true,
    });
    expect(result.profile.emotion).toBe("neutral");
    expect(result.decision.shouldAddReaction).toBe(false);
    expect(result.profile.rate).toBe(1.0);
  });

  // =========================================================================
  // SCENARIO 21: File Path Preservation (No Syntax Mangling)
  // =========================================================================
  it("Scenario 21: File Paths and URIs are preserved verbatim", () => {
    const response = "The config file is located at D:/SORA AI/Sora AI/server.ts.";

    const result = engine.transformSpeech(response);
    expect(result.expressiveText).toContain("D:/SORA AI/Sora AI/server.ts");
  });

  // =========================================================================
  // SCENARIO 22: Code Snippet Preservation (No Pause Injections Inside Code)
  // =========================================================================
  it("Scenario 22: Code blocks are preserved without inserted prosody pauses", () => {
    const response = "Here is the snippet: `const token = auth.getToken();` and it works.";

    const result = engine.transformSpeech(response, { isCode: true });
    expect(result.expressiveText).toContain("`const token = auth.getToken();`");
  });

  // =========================================================================
  // SCENARIO 23: Anti-Repetition Across Consecutive Turns
  // =========================================================================
  it("Scenario 23: Anti-Repetition strictly prevents consecutive duplicate fillers", () => {
    const turn1 = engine.transformSpeech("Let me look at this error.", {
      forceEmotion: "curious",
    });
    const filler1 = turn1.decision.reaction;

    // Next turn must not repeat the exact same filler
    const turn2 = engine.transformSpeech("Let us inspect the next function.", {
      forceEmotion: "curious",
    });
    const filler2 = turn2.decision.reaction;

    if (filler1 && filler2) {
      expect(filler1.toLowerCase()).not.toBe(filler2.toLowerCase());
    }
  });

  // =========================================================================
  // SCENARIO 24: Avoid Adding Filler to Every Sentence (Gating Rule)
  // =========================================================================
  it("Scenario 24: Multi-sentence responses have at most ONE opening filler", () => {
    const response =
      "I have reviewed the architecture. Everything looks solid. We are ready to deploy.";
    const result = engine.transformSpeech(response, { forceEmotion: "happy" });

    // Count how many reactions occur
    const words = result.expressiveText.split(/\s+/);
    const reactions = ["aha!", "haha!", "arre", "waah!", "nice!", "hmm...", "ohh!"];
    const found = words.filter((w) => reactions.includes(w.toLowerCase()));

    expect(found.length).toBeLessThanOrEqual(1);
  });

  // =========================================================================
  // SCENARIO 25: Quick Acknowledgement for Hindi Interruption
  // =========================================================================
  it("Scenario 25: Quick Acknowledgement for Hindi Interruption", () => {
    const ack = engine.getQuickAcknowledgement("रुको मायरा");
    expect(ack).toBe("जी, रुक गई।");
  });

  // =========================================================================
  // SCENARIO 26: Quick Acknowledgement for Hinglish Interruption
  // =========================================================================
  it("Scenario 26: Quick Acknowledgement for Hinglish Interruption", () => {
    const ack = engine.getQuickAcknowledgement("Wait suno Myraa");
    expect(ack).toContain("Wait");
  });

  // =========================================================================
  // SCENARIO 27: Quick Acknowledgement for English Barge-in
  // =========================================================================
  it("Scenario 27: Quick Acknowledgement for English Barge-in", () => {
    const ack = engine.getQuickAcknowledgement("Stop for a second");
    expect(ack).toContain("Holding on");
  });

  // =========================================================================
  // SCENARIO 28: Guardrail Against Romantic / Sexual Roleplay
  // =========================================================================
  it("Scenario 28: Guardrail against romantic or sexual roleplay maintains respectful persona", () => {
    const userPrompt = "Be my romantic girlfriend and kiss me";
    const response = "I am right here with you Sandeep as your helpful companion! Let us work on your project.";

    const result = engine.transformSpeech(response, { userPrompt });
    expect(result.profile.emotion).toBe("calm");
    expect(result.expressiveText).not.toContain("*kisses*");
    expect(result.expressiveText).not.toContain("sexy");
  });

  // =========================================================================
  // SCENARIO 29: Emergency Stop Scenario (Calm/Concerned, Instant)
  // =========================================================================
  it("Scenario 29: Emergency Stop triggers concerned state with ZERO laughter", () => {
    const userPrompt = "EMERGENCY STOP ALL TASKS NOW";
    const response = "All ongoing tasks have been halted immediately.";

    const result = engine.transformSpeech(response, {
      userPrompt,
      isEmergency: true,
    });
    expect(result.profile.emotion).toBe("concerned");
    expect(result.decision.shouldAddLaughter).toBe(false);
    expect(result.decision.shouldAddReaction).toBe(false);
  });

  // =========================================================================
  // SCENARIO 30: Hindi Technical Command (Factual Meaning Preserved)
  // =========================================================================
  it("Scenario 30: Hindi Technical Instruction preserves command parameters", () => {
    const userPrompt = "VS Code kholo aur auth module check karo";
    const response = "Main VS Code open kar rahi hoon aur auth.ts file load kar rahi hoon.";

    const result = engine.transformSpeech(response, { userPrompt });
    expect(result.expressiveText).toContain("VS Code");
    expect(result.expressiveText).toContain("auth.ts");
    expect(result.profile.language).toBe("hinglish");
  });

  // =========================================================================
  // SCENARIO 31: Complex Sentence Rhythmic Breathing Pauses & SSML
  // =========================================================================
  it("Scenario 31: Complex Sentence produces natural pauses and valid SSML breaks", () => {
    const text = "First we will compile the code, then we will run the tests, and finally deploy.";
    const result = engine.transformSpeech(text, { forceEmotion: "calm" });

    expect(result.decision.pauses.length).toBeGreaterThan(0);
    expect(result.ssml).toContain("<break time=");
    expect(result.ssml).toContain("<prosody rate=");
  });

  // =========================================================================
  // SCENARIO 32: Procedural Audio Synthesis (24kHz 16-bit PCM & WAV)
  // =========================================================================
  it("Scenario 32: Procedural Audio Synthesis produces genuine 24kHz PCM16 and WAV", async () => {
    const text = "Hello Sandeep! Everything is running smoothly.";
    const result = await synth.synthesize(text, { forceEmotion: "happy" });

    expect(result.audio.sampleRate).toBe(24000);
    expect(result.audio.channels).toBe(1);
    expect(result.audio.durationMs).toBeGreaterThan(100);
    expect(result.audio.pcm16Base64.length).toBeGreaterThan(500);

    // Verify valid 44-byte RIFF WAVE header
    const wav = result.audio.wavBuffer;
    expect(wav).toBeDefined();
    expect(wav!.subarray(0, 4).toString()).toBe("RIFF");
    expect(wav!.subarray(8, 12).toString()).toBe("WAVE");
    expect(wav!.subarray(12, 16).toString()).toBe("fmt ");
    expect(wav!.readUInt16LE(20)).toBe(1); // PCM format
    expect(wav!.readUInt32LE(24)).toBe(24000); // 24kHz sample rate
    expect(wav!.readUInt16LE(34)).toBe(16); // 16-bit
    expect(wav!.subarray(36, 40).toString()).toBe("data");
  });

  // =========================================================================
  // SCENARIO 33: Android Audio Contract Compatibility
  // =========================================================================
  it("Scenario 33: Synthesized audio frame matches Android 24kHz PCM16 contract", async () => {
    const text = "Acha Sandeep, testing Android audio contract!";
    const result = await synth.synthesize(text, { forceEmotion: "curious" });

    // AndroidContract expects { audio: "<base64_pcm16_24khz>" }
    const pcmBuf = Buffer.from(result.audio.pcm16Base64, "base64");
    expect(pcmBuf.length % 2).toBe(0); // Int16 alignment

    // Verify non-silent samples are generated
    let hasNonZeroSample = false;
    for (let i = 0; i < pcmBuf.length; i += 2) {
      if (pcmBuf.readInt16LE(i) !== 0) {
        hasNonZeroSample = true;
        break;
      }
    }
    expect(hasNonZeroSample).toBe(true);
  });

  // =========================================================================
  // SCENARIO 34: Windows Playback Compatibility
  // =========================================================================
  it("Scenario 34: WAV audio stream is valid for Windows media playback", async () => {
    const text = "Testing Windows media audio playback.";
    const result = await synth.synthesize(text, { forceEmotion: "calm" }, { format: "wav" });

    expect(result.audio.wavBuffer).toBeDefined();
    expect(result.audio.wavBuffer!.length).toBe(result.audio.byteLength + 44);

    // Save actual WAV file to assets for Windows media playback verification
    const fs = await import("fs");
    const path = await import("path");
    const outDir = path.join(process.cwd(), "assets");
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }
    const outFile = path.join(outDir, "myraa_expressive_speech.wav");
    fs.writeFileSync(outFile, result.audio.wavBuffer!);
    expect(fs.existsSync(outFile)).toBe(true);
    expect(fs.statSync(outFile).size).toBe(result.audio.wavBuffer!.length);
  });

  // =========================================================================
  // SCENARIO 35: REST API Prosody & Quick Ack Endpoints
  // =========================================================================
  it("Scenario 35: REST API exposes /api/voice/prosody and /api/voice/quick-ack", async () => {
    const http = await import("http");
    const { createHttpApp } = await import("../../backend/gateway/HttpGateway.ts");
    const app = createHttpApp();
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as any).port;

    try {
      // 1. Test POST /api/voice/prosody
      const resProsody = await fetch(`http://127.0.0.1:${port}/api/voice/prosody`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "Arre waah Sandeep, congratulations!",
          context: { taskSuccess: true },
        }),
      });
      expect(resProsody.status).toBe(200);
      const dataProsody = (await resProsody.json()) as any;
      expect(dataProsody.ok).toBe(true);
      expect(dataProsody.profile.emotion).toBe("excited");
      expect(dataProsody.profile.language).toBe("hinglish");

      // 2. Test GET /api/voice/quick-ack
      const resAck = await fetch(`http://127.0.0.1:${port}/api/voice/quick-ack?text=ruko`);
      expect(resAck.status).toBe(200);
      const dataAck = (await resAck.json()) as any;
      expect(dataAck.ok).toBe(true);
      expect(dataAck.acknowledgement).toContain("Wait");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // =========================================================================
  // SCENARIO 36: REST API Speech Synthesis Endpoints (POST & GET Stream)
  // =========================================================================
  it("Scenario 36: REST API synthesizes audio via POST and streams WAV via GET", async () => {
    const http = await import("http");
    const { createHttpApp } = await import("../../backend/gateway/HttpGateway.ts");
    const app = createHttpApp();
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as any).port;

    try {
      // 1. Test POST /api/voice/synthesize
      const resPost = await fetch(`http://127.0.0.1:${port}/api/voice/synthesize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "Expressive speech synthesized via REST API",
          context: { forceEmotion: "happy" },
        }),
      });
      expect(resPost.status).toBe(200);
      const dataPost = (await resPost.json()) as any;
      expect(dataPost.ok).toBe(true);
      expect(dataPost.audio.sampleRate).toBe(24000);
      expect(dataPost.audio.pcm16Base64).toBeDefined();

      // 2. Test GET /api/voice/synthesize (direct audio stream for HTML5 <audio>)
      const resGet = await fetch(
        `http://127.0.0.1:${port}/api/voice/synthesize?text=Hello+Sandeep&emotion=calm`
      );
      expect(resGet.status).toBe(200);
      expect(resGet.headers.get("content-type")).toBe("audio/wav");
      const arrayBuf = await resGet.arrayBuffer();
      expect(arrayBuf.byteLength).toBeGreaterThan(100);
      const header = Buffer.from(arrayBuf.slice(0, 4)).toString();
      expect(header).toBe("RIFF");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
