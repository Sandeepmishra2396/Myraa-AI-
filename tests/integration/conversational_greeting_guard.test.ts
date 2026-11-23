import { describe, it, expect, beforeEach } from "vitest";
import {
  ToolOrchestrator,
  isConversationalGreetingOrChat,
  MEDIA_BROWSER_TOOLS,
} from "../../backend/tools/ToolOrchestrator.ts";
import { actionContextManager } from "../../backend/orchestrator/ActionContext.ts";
import { intentResolver } from "../../backend/orchestrator/IntentResolver.ts";

describe("Conversational Greeting & Ordinal Song Guardrail Test Suite", () => {
  const orchestrator = new ToolOrchestrator();
  const SID = "test-greeting-session";

  beforeEach(() => {
    actionContextManager.resetForTesting(SID);
  });

  describe("Conversational Greeting Classifier (isConversationalGreetingOrChat)", () => {
    it("detects English greetings without actions as true", () => {
      expect(isConversationalGreetingOrChat("Hello Myra.")).toBe(true);
      expect(isConversationalGreetingOrChat("Hello Myra")).toBe(true);
      expect(isConversationalGreetingOrChat("Hi")).toBe(true);
      expect(isConversationalGreetingOrChat("Hey Myra")).toBe(true);
      expect(isConversationalGreetingOrChat("Good morning Myra")).toBe(true);
      expect(isConversationalGreetingOrChat("How are you?")).toBe(true);
      expect(isConversationalGreetingOrChat("What are you doing?")).toBe(true);
      expect(isConversationalGreetingOrChat("Who are you")).toBe(true);
    });

    it("detects Hinglish & Hindi transliterated greetings without actions as true", () => {
      expect(isConversationalGreetingOrChat("लो मायरा।")).toBe(true);
      expect(isConversationalGreetingOrChat("क्या कर रही हो?")).toBe(true);
      expect(isConversationalGreetingOrChat("नमस्ते")).toBe(true);
      expect(isConversationalGreetingOrChat("हेलो मायरा")).toBe(true);
      expect(isConversationalGreetingOrChat("namaste")).toBe(true);
      expect(isConversationalGreetingOrChat("kya haal hai")).toBe(true);
      expect(isConversationalGreetingOrChat("kya kar rahi ho")).toBe(true);
      expect(isConversationalGreetingOrChat("kaisi ho")).toBe(true);
      expect(isConversationalGreetingOrChat("suno")).toBe(true);
      expect(isConversationalGreetingOrChat("sun rahi ho")).toBe(true);
      expect(isConversationalGreetingOrChat("lo myra")).toBe(true);
      expect(isConversationalGreetingOrChat("arre myra")).toBe(true);
    });

    it("detects action commands as false (never suppresses real commands)", () => {
      expect(isConversationalGreetingOrChat("3 wala play karo")).toBe(false);
      expect(isConversationalGreetingOrChat("9th no pe jo sonngs hai usko play karo")).toBe(false);
      expect(isConversationalGreetingOrChat("Arijit Singh song search karo")).toBe(false);
      expect(isConversationalGreetingOrChat("YouTube open karo")).toBe(false);
      expect(isConversationalGreetingOrChat("Tu Bhi Sataya Jayega play karo")).toBe(false);
      expect(isConversationalGreetingOrChat("Play karo")).toBe(false);
      expect(isConversationalGreetingOrChat("Pause karo")).toBe(false);
      expect(isConversationalGreetingOrChat("Next song")).toBe(false);
      expect(isConversationalGreetingOrChat("chautha gaana play karo")).toBe(false);
      expect(isConversationalGreetingOrChat("dusra gaana bajao")).toBe(false);
    });
  });

  describe("ToolOrchestrator Suppression on Greetings", () => {
    it("suppresses browserSearch and does NOT forward to client when user greets", async () => {
      let clientDispatched = false;
      let toolResponseSent = false;
      let toolResponseOutput: any = null;

      const mockSession = {
        sendToolResponse: (payload: any) => {
          toolResponseSent = true;
          toolResponseOutput = payload.functionResponses?.[0]?.response?.output;
        },
      };

      const mockSendToClient = () => {
        clientDispatched = true;
      };

      await orchestrator.dispatch(
        {
          name: "browserSearch",
          args: {
            query: "Arijit Singh song",
            _userUtterance: "Hello Myra.",
          },
          id: "call-1",
        },
        mockSession as any,
        mockSendToClient,
        "test-key",
      );

      // Tool call MUST NOT reach frontend (browser MUST NOT open)
      expect(clientDispatched).toBe(false);
      // Tool response MUST indicate suppression
      expect(toolResponseSent).toBe(true);
      expect(toolResponseOutput?.suppressed).toBe(true);
      expect(toolResponseOutput?.reason).toBe("CONVERSATIONAL_GREETING_DETECTED");
    });

    it("suppresses browserMediaControl when user speaks a Hindi greeting", async () => {
      let clientDispatched = false;
      let toolResponseOutput: any = null;

      const mockSession = {
        sendToolResponse: (payload: any) => {
          toolResponseOutput = payload.functionResponses?.[0]?.response?.output;
        },
      };

      await orchestrator.dispatch(
        {
          name: "browserMediaControl",
          args: {
            action: "play",
            index: 6,
            songNumber: 7,
            _userUtterance: "क्या कर रही हो?",
          },
          id: "call-2",
        },
        mockSession as any,
        () => {
          clientDispatched = true;
        },
        "test-key",
      );

      expect(clientDispatched).toBe(false);
      expect(toolResponseOutput?.suppressed).toBe(true);
      expect(toolResponseOutput?.reason).toBe("CONVERSATIONAL_GREETING_DETECTED");
    });

    it("suppresses browserGoBack when user says 'लो मायरा।'", async () => {
      let clientDispatched = false;
      let toolResponseOutput: any = null;

      const mockSession = {
        sendToolResponse: (payload: any) => {
          toolResponseOutput = payload.functionResponses?.[0]?.response?.output;
        },
      };

      await orchestrator.dispatch(
        {
          name: "browserGoBack",
          args: {
            _userUtterance: "लो मायरा।",
          },
          id: "call-3",
        },
        mockSession as any,
        () => {
          clientDispatched = true;
        },
        "test-key",
      );

      expect(clientDispatched).toBe(false);
      expect(toolResponseOutput?.suppressed).toBe(true);
    });
  });

  describe("Ordinal Song Playback Precision (3rd and 9th Song)", () => {
    it("correctly resolves 3rd song ('3 wala play karo') to index 2 and songNumber 3", () => {
      // Seed 10 mock search results into actionContext
      const mockResults = Array.from({ length: 10 }, (_, i) => ({
        index: i,
        videoId: `video_id_${i + 1}`,
        title: `Arijit Singh Track ${i + 1}`,
        url: `https://youtube.com/watch?v=video_id_${i + 1}`,
      }));
      actionContextManager.recordMediaSearch(SID, "Arijit Singh songs", mockResults, "youtube");
      actionContextManager.recordUserUtterance(SID, "3 wala play karo");

      const resolved = intentResolver.resolveFromToolCall(
        "browserMediaControl",
        {
          action: "play",
          _userUtterance: "3 wala play karo",
        },
        SID,
      );

      expect(resolved.arguments.index).toBe(2);
      expect(resolved.arguments.songNumber).toBe(3);
      expect(resolved.arguments.videoId).toBe("video_id_3");
      expect(resolved.arguments.title).toBe("Arijit Singh Track 3");
    });

    it("correctly resolves 9th song ('9th no pe jo sonngs hai usko play karo') to index 8 and songNumber 9", () => {
      const mockResults = Array.from({ length: 10 }, (_, i) => ({
        index: i,
        videoId: `video_id_${i + 1}`,
        title: `Arijit Singh Track ${i + 1}`,
        url: `https://youtube.com/watch?v=video_id_${i + 1}`,
      }));
      actionContextManager.recordMediaSearch(SID, "Arijit Singh songs", mockResults, "youtube");
      actionContextManager.recordUserUtterance(SID, "9th no pe jo sonngs hai usko play karo");

      const resolved = intentResolver.resolveFromToolCall(
        "browserMediaControl",
        {
          action: "play",
          _userUtterance: "9th no pe jo sonngs hai usko play karo",
        },
        SID,
      );

      expect(resolved.arguments.index).toBe(8);
      expect(resolved.arguments.songNumber).toBe(9);
      expect(resolved.arguments.videoId).toBe("video_id_9");
      expect(resolved.arguments.title).toBe("Arijit Singh Track 9");
    });
  });
});
