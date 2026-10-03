/**
 * MYRAA — Phase 21: Predictive / Proactive Engine
 * ProactiveNotificationManager
 *
 * Formulates user-facing proactive questions, voice announcements, and
 * companion notifications. Adapts speech style based on Phase 18 Personal Brain
 * learned preferences (concise vs detailed) and emits real-time events.
 */

import type { ProactiveEvent } from "./ProactiveTypes.ts";
import { eventBus } from "../companion/EventBus.ts";

export interface FormattedProactivePrompt {
  speechPrompt: string;
  uiTitle: string;
  uiMessage: string;
  level: "info" | "warning" | "error" | "success";
  approvalQuestion: string;
}

export class ProactiveNotificationManager {
  /**
   * Formats a user-facing dialogue prompt and notification for an active proactive event.
   */
  public formatPrompt(
    event: ProactiveEvent,
    options?: { isConcise?: boolean }
  ): FormattedProactivePrompt {
    const isConcise = Boolean(options?.isConcise);

    let speechPrompt = "";
    let uiTitle = "";
    let uiMessage = "";
    let level: "info" | "warning" | "error" | "success" = "warning";
    let approvalQuestion = "Kya main fix ya details dikhaun?";

    if (event.eventType === "REPEATED_FAILURE") {
      speechPrompt = isConcise
        ? "Ye same error repeatedly aa raha hai. Main root cause dikhaun?"
        : "Ye same error repeatedly aa raha hai. Root cause likely identify ho chuka hai. Main detailed analysis aur fix dikha sakti hoon. Dekhna hai?";
      uiTitle = "Repeated Failure Detected";
      uiMessage = event.analysis.summary;
      approvalQuestion = "Main detailed analysis dikhaun?";
      level = "error";
    } else if (event.eventType === "TYPE_ERROR") {
      speechPrompt = isConcise
        ? "Sandeep, build mein ek TypeScript error hai. Reason identify kar chuki hoon. Fix dikhaun?"
        : event.analysis.naturalHindiExplanation;
      uiTitle = "TypeScript Diagnostic";
      uiMessage = event.analysis.summary;
      approvalQuestion = "Main tumhe issue aur possible fix dikhaun?";
      level = "error";
    } else if (event.eventType === "BUILD_FAILED") {
      speechPrompt = isConcise
        ? "Sandeep, project build fail ho gaya hai. Main issue aur fix dikhaun?"
        : event.analysis.naturalHindiExplanation;
      uiTitle = "Build Failure Detected";
      uiMessage = event.analysis.summary;
      approvalQuestion = "Main tumhe issue aur possible fix dikhaun?";
      level = "error";
    } else if (event.eventType === "TEST_FAILED") {
      speechPrompt = isConcise
        ? "Sandeep, tests fail ho gaye hain. Kya main failure stack dikhaun?"
        : event.analysis.naturalHindiExplanation;
      uiTitle = "Test Suite Failure";
      uiMessage = event.analysis.summary;
      approvalQuestion = "Kya main failing tests diagnose karun?";
      level = "error";
    } else if (event.eventType === "RUNTIME_ERROR") {
      speechPrompt = isConcise
        ? "Sandeep, ek runtime error mila hai. Kya main issue inspect karun?"
        : event.analysis.naturalHindiExplanation;
      uiTitle = "Runtime Error";
      uiMessage = event.analysis.summary;
      approvalQuestion = "Kya main issue inspect karun?";
      level = "error";
    } else if (event.eventType === "TASK_STALLED") {
      speechPrompt = isConcise
        ? "Sandeep, ek task stalled lag raha hai. Kya ise cancel karun?"
        : event.analysis.naturalHindiExplanation;
      uiTitle = "Stalled Task";
      uiMessage = event.analysis.summary;
      approvalQuestion = "Kya ise cancel karun?";
      level = "warning";
    } else {
      speechPrompt = event.analysis.naturalHindiExplanation;
      uiTitle = "Proactive Suggestion";
      uiMessage = event.analysis.summary;
      approvalQuestion = "Aap isko apply karna chahte hain?";
      level = "info";
    }

    return {
      speechPrompt,
      uiTitle,
      uiMessage,
      level,
      approvalQuestion,
    };
  }

  /**
   * Broadcasts a notification to internal eventBus and WebSocket clients.
   */
  public emitNotification(event: ProactiveEvent, prompt: FormattedProactivePrompt): void {
    try {
      eventBus.emit("notification:created", {
        type: "proactive_notification",
        notification: {
          id: `notif_${event.eventId}`,
          title: prompt.uiTitle,
          message: prompt.uiMessage,
          level: prompt.level,
          source: "proactive_engine",
          createdAt: new Date().toISOString(),
          read: false,
          metadata: {
            eventId: event.eventId,
            eventType: event.eventType,
            confidence: event.confidence,
            riskLevel: event.riskLevel,
          },
        },
        voiceAnnouncement: prompt.speechPrompt,
        suppressedByQuietHours: false,
      });
    } catch {
      // Best-effort notification delivery
    }
  }
}

export const proactiveNotificationManager = new ProactiveNotificationManager();
