import { describe, it, expect, beforeEach } from "vitest";
import { actionContextManager, parseOrdinalOrIndex } from "../../backend/orchestrator/ActionContext.ts";
import { intentResolver } from "../../backend/orchestrator/IntentResolver.ts";
import { languageManager } from "../../backend/voice/LanguageManager.ts";
import { buildCompleteSystemInstructions } from "../../backend/projects/ContextManager.ts";

describe("Voice Language & Ordinal Song Selection Test Suite", () => {
  beforeEach(() => {
    actionContextManager.resetForTesting("test-ordinal");
  });

  describe("Ordinal & Number Parsing (parseOrdinalOrIndex)", () => {
    it("correctly parses English ordinals to 0-based indices", () => {
      expect(parseOrdinalOrIndex("1st")).toBe(0);
      expect(parseOrdinalOrIndex("first")).toBe(0);
      expect(parseOrdinalOrIndex("2nd")).toBe(1);
      expect(parseOrdinalOrIndex("second")).toBe(1);
      expect(parseOrdinalOrIndex("3rd")).toBe(2);
      expect(parseOrdinalOrIndex("third")).toBe(2);
      expect(parseOrdinalOrIndex("4th")).toBe(3);
      expect(parseOrdinalOrIndex("fourth")).toBe(3);
      expect(parseOrdinalOrIndex("5th")).toBe(4);
      expect(parseOrdinalOrIndex("fifth")).toBe(4);
      expect(parseOrdinalOrIndex("10th")).toBe(9);
    });

    it("correctly parses Hindi ordinals to 0-based indices", () => {
      expect(parseOrdinalOrIndex("pehla")).toBe(0);
      expect(parseOrdinalOrIndex("pehle")).toBe(0);
      expect(parseOrdinalOrIndex("dusra")).toBe(1);
      expect(parseOrdinalOrIndex("doosra")).toBe(1);
      expect(parseOrdinalOrIndex("teesra")).toBe(2);
      expect(parseOrdinalOrIndex("tisra")).toBe(2);
      expect(parseOrdinalOrIndex("chautha")).toBe(3);
      expect(parseOrdinalOrIndex("chauthe")).toBe(3);
      expect(parseOrdinalOrIndex("paanchwa")).toBe(4);
      expect(parseOrdinalOrIndex("panchwa")).toBe(4);
    });

    it("correctly handles colloquial phrases like '4th no wala', 'tum 4th no wala sonng'", () => {
      expect(parseOrdinalOrIndex("4th no wala")).toBe(3);
      expect(parseOrdinalOrIndex("tum 4th no wala sonng")).toBe(3);
      expect(parseOrdinalOrIndex("4 number wala gaana")).toBe(3);
      expect(parseOrdinalOrIndex("dusra song")).toBe(1);
      expect(parseOrdinalOrIndex("chautha gaana")).toBe(3);
      expect(parseOrdinalOrIndex("#4")).toBe(3);
      expect(parseOrdinalOrIndex("video-3")).toBe(3);
      expect(parseOrdinalOrIndex(3)).toBe(3);
    });
  });

  describe("Ordinal Song Play Intent Resolution (IntentResolver & ActionContext)", () => {
    it("selects the 4th item when user says 'tum 4th no wala sonng play karo'", () => {
      // Mock search results
      actionContextManager.recordMediaSearch(
        "test-ordinal",
        "Arijit Singh",
        [
          { videoId: "v1", title: "Song 1", url: "https://youtube.com/watch?v=v1", index: 0 },
          { videoId: "v2", title: "Song 2", url: "https://youtube.com/watch?v=v2", index: 1 },
          { videoId: "v3", title: "Song 3", url: "https://youtube.com/watch?v=v3", index: 2 },
          { videoId: "v4", title: "Song 4", url: "https://youtube.com/watch?v=v4", index: 3 },
          { videoId: "v5", title: "Song 5", url: "https://youtube.com/watch?v=v5", index: 4 },
        ],
        "youtube",
      );

      const intent = intentResolver.resolveFromUtterance(
        "tum 4th no wala sonng play karo",
        "test-ordinal",
      );

      expect(intent.intent).toBe("PLAY_MEDIA");
      expect(intent.arguments.action).toBe("play");
      expect(intent.arguments.index).toBe(3);
      expect(intent.arguments.videoId).toBe("v4");
      expect(intent.arguments.title).toBe("Song 4");
    });

    it("selects the 2nd item when user says 'dusra song play karo'", () => {
      actionContextManager.recordMediaSearch(
        "test-ordinal",
        "Arijit Singh",
        [
          { videoId: "v1", title: "Song 1", url: "https://youtube.com/watch?v=v1", index: 0 },
          { videoId: "v2", title: "Song 2", url: "https://youtube.com/watch?v=v2", index: 1 },
          { videoId: "v3", title: "Song 3", url: "https://youtube.com/watch?v=v3", index: 2 },
        ],
        "youtube",
      );

      const intent = intentResolver.resolveFromUtterance(
        "dusra song play karo",
        "test-ordinal",
      );

      expect(intent.intent).toBe("PLAY_MEDIA");
      expect(intent.arguments.index).toBe(1);
      expect(intent.arguments.videoId).toBe("v2");
      expect(intent.arguments.title).toBe("Song 2");
    });

    it("resolves browserClick on '4th' or 'chautha' to PLAY_MEDIA with index 3", () => {
      actionContextManager.recordMediaSearch(
        "test-ordinal",
        "Bollywood Hits",
        [
          { videoId: "v1", title: "Song 1", url: "https://youtube.com/watch?v=v1", index: 0 },
          { videoId: "v2", title: "Song 2", url: "https://youtube.com/watch?v=v2", index: 1 },
          { videoId: "v3", title: "Song 3", url: "https://youtube.com/watch?v=v3", index: 2 },
          { videoId: "v4", title: "Song 4", url: "https://youtube.com/watch?v=v4", index: 3 },
        ],
        "youtube",
      );

      const intent = intentResolver.resolveFromToolCall(
        "browserClick",
        { selector: "4th" },
        "test-ordinal",
      );

      expect(intent.intent).toBe("PLAY_MEDIA");
      expect(intent.arguments.index).toBe(3);
      expect(intent.arguments.videoId).toBe("v4");
    });
  });

  describe("Starting Conversational Language (Hindi Default)", () => {
    it("defaults starting conversation language to Hindi", async () => {
      languageManager.resetState();
      expect(languageManager.getActiveLanguage()).toBe("hindi");

      const prompt = await buildCompleteSystemInstructions([]);
      expect(prompt).toContain("MANDATORY STARTING VOICE LANGUAGE (STRICT)");
      expect(prompt).toContain("ACTIVE CONVERSATIONAL LANGUAGE DIRECTIVE: HINDI");
      expect(prompt).not.toContain("ACTIVE CONVERSATIONAL LANGUAGE DIRECTIVE: BENGALI");
    });
  });

  describe("YouTube Open Resolution", () => {
    it("resolves 'youtube open karo' to OPEN_APPLICATION with isWebsiteApp=true and BROWSER target", () => {
      const intent = intentResolver.resolveFromUtterance(
        "youtube open karo",
        "test-ordinal",
      );

      expect(intent.intent).toBe("OPEN_APPLICATION");
      expect(intent.entity).toBe("youtube");
      expect(intent.arguments.isWebsiteApp).toBe(true);
      expect(intent.targetDevice).toBe("BROWSER");
    });

    it("resolves tool call openApplication(name='youtube') with aliasResolved=true", () => {
      const intent = intentResolver.resolveFromToolCall(
        "openApplication",
        { name: "youtube" },
        "test-ordinal",
      );

      expect(intent.intent).toBe("OPEN_APPLICATION");
      expect(intent.arguments.aliasResolved).toBe(true);
      expect(intent.arguments.isWebsiteApp).toBe(true);
    });
  });

  describe("Anti-Echo Greeting Invariant & Volume Directives", () => {
    it("system prompt enforces strict anti-echo greeting invariant for hello myraa", async () => {
      const prompt = await buildCompleteSystemInstructions([]);
      expect(prompt).toContain("ANTI-ECHO INVARIANT");
      expect(prompt).toContain("NEVER say 'hello myraa'");
      expect(prompt).toContain("Haan Sandeep! Kahiye, main aapki kya madad kar sakti hoon?");
    });

    it("system prompt specifies gentle 5% volume adjustments", async () => {
      const prompt = await buildCompleteSystemInstructions([]);
      expect(prompt).toContain("amount=0.05");
      expect(prompt).toContain("NEVER make sudden drastic jumps");
    });
  });

  describe("High Ordinal Song Selection (4th, 5th, 9th) & Context Sync", () => {
    it("correctly parses 4th, 5th, and 9th ordinals with action verbs", () => {
      expect(parseOrdinalOrIndex("4th play karo")).toBe(3);
      expect(parseOrdinalOrIndex("5th play karo")).toBe(4);
      expect(parseOrdinalOrIndex("9th play karo")).toBe(8);
      expect(parseOrdinalOrIndex("nauwa gaana play karo")).toBe(8);
      expect(parseOrdinalOrIndex("paanchwa song chalao")).toBe(4);
      expect(parseOrdinalOrIndex("chautha play karo")).toBe(3);
    });

    it("correctly parses exact user utterances '3 wala play karo' and '9th no pe jo sonngs hai usko play karo'", () => {
      expect(parseOrdinalOrIndex("3 wala play karo")).toBe(2);
      expect(parseOrdinalOrIndex("9th no pe jo sonngs hai usko play karo")).toBe(8);
      expect(parseOrdinalOrIndex("3rd wala play karo")).toBe(2);
      expect(parseOrdinalOrIndex("teesra gaana play karo")).toBe(2);
      expect(parseOrdinalOrIndex("9 number wala play karo")).toBe(8);
      expect(parseOrdinalOrIndex("9 no pe jo gaana hai")).toBe(8);
    });

    it("overrides tool call index=0 when user utterance specifies 3rd or 9th song", () => {
      actionContextManager.recordMediaSearch(
        "test-ordinal",
        "Top Songs",
        Array.from({ length: 10 }, (_, i) => ({
          videoId: `song_${i + 1}`,
          title: `Track ${i + 1}`,
          url: `https://youtube.com/watch?v=song_${i + 1}`,
          index: i,
        })),
        "youtube",
      );

      // Simulate Gemini calling browserMediaControl with default action: "play", but user utterance was "3 wala play karo"
      const intent3 = intentResolver.resolveFromToolCall(
        "browserMediaControl",
        {
          action: "play",
          _userUtterance: "3 wala play karo",
        },
        "test-ordinal",
      );

      expect(intent3.intent).toBe("PLAY_MEDIA");
      expect(intent3.arguments.index).toBe(2);
      expect(intent3.arguments.videoId).toBe("song_3");
      expect(intent3.arguments.title).toBe("Track 3");

      // Simulate Gemini calling browserMediaControl with songNumber: 9
      const intent9 = intentResolver.resolveFromToolCall(
        "browserMediaControl",
        {
          action: "play",
          songNumber: 9,
          _userUtterance: "9th no pe jo sonngs hai usko play karo",
        },
        "test-ordinal",
      );

      expect(intent9.intent).toBe("PLAY_MEDIA");
      expect(intent9.arguments.index).toBe(8);
      expect(intent9.arguments.videoId).toBe("song_9");
      expect(intent9.arguments.title).toBe("Track 9");

      // Simulate generic browserClick on "play-button" with user utterance asking for 3rd song
      const clickIntent = intentResolver.resolveFromToolCall(
        "browserClick",
        {
          selector: "play-button",
          _userUtterance: "3 wala play karo",
        },
        "test-ordinal",
      );

      expect(clickIntent.intent).toBe("PLAY_MEDIA");
      expect(clickIntent.arguments.index).toBe(2);
      expect(clickIntent.arguments.videoId).toBe("song_3");
    });

    it("returns synthetic item with exact requested index even when backend only has dummy search result", () => {
      // Simulate backend having only 1 dummy item
      actionContextManager.recordMediaSearch("test-ordinal", "test", [
        { videoId: "yt_top_dummy", title: "Top Hit", url: "https://youtube.com/watch?v=yt_top_dummy", index: 0 },
      ]);

      const selected3 = actionContextManager.selectMediaResult("test-ordinal", "3 wala play karo");
      expect(selected3).toBeDefined();
      expect(selected3?.index).toBe(2);

      const selected9 = actionContextManager.selectMediaResult("test-ordinal", "9th no pe jo sonngs hai usko play karo");
      expect(selected9).toBeDefined();
      expect(selected9?.index).toBe(8);
    });

    it("selects 5th and 9th items accurately across multiple context sessions", () => {
      const searchItems = Array.from({ length: 15 }, (_, i) => ({
        videoId: `vid_${i + 1}`,
        title: `Song Number ${i + 1}`,
        url: `https://youtube.com/watch?v=vid_${i + 1}`,
        index: i,
      }));

      // Recorded under default
      actionContextManager.recordMediaSearch("default", "test query", searchItems, "youtube");

      // Selected from an independent WebSocket session context
      const selected5th = actionContextManager.selectMediaResult("ws-session-xyz", "5th");
      expect(selected5th).toBeDefined();
      expect(selected5th?.index).toBe(4);
      expect(selected5th?.videoId).toBe("vid_5");

      const selected9th = actionContextManager.selectMediaResult("ws-session-xyz", "9th");
      expect(selected9th).toBeDefined();
      expect(selected9th?.index).toBe(8);
      expect(selected9th?.videoId).toBe("vid_9");
    });
  });
});
