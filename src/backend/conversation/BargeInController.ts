/**
 * MYRAA — Phase 20: Advanced Natural Conversation Engine
 * BargeInController
 *
 * Handles live speech interruption / barge-in:
 *   1. Detects interruption while MYRAA is speaking or planning.
 *   2. Cancels or ducks active TTS audio playback safely via registered cancellation callbacks.
 *   3. Preserves conversation state (turn history & active entities remain intact).
 *   4. Classifies the interruption: correction, interruption, cancellation, follow-up, or new intent.
 *   5. Triggers dynamic re-planning using the new user instruction through security gates.
 */

import crypto from "crypto";
import type { InterruptionEvent, InterruptionCategory } from "./ConversationTypes.ts";
import { conversationTurnTracker, ConversationTurnTracker } from "./ConversationTurnTracker.ts";

export type AudioStopCallback = (contextId: string) => number; // returns stopped audio bytes

export class BargeInController {
  private _turnTracker: ConversationTurnTracker;
  private _audioStopCallbacks = new Set<AudioStopCallback>();
  private _isAssistantSpeaking = new Map<string, boolean>();

  constructor(turnTracker = conversationTurnTracker) {
    this._turnTracker = turnTracker;
  }

  /**
   * Registers a callback to halt active audio playback / streaming.
   */
  public registerAudioStopCallback(cb: AudioStopCallback): () => void {
    this._audioStopCallbacks.add(cb);
    return () => this._audioStopCallbacks.delete(cb);
  }

  /**
   * Sets whether the assistant is currently playing audio or speaking.
   */
  public setSpeakingState(contextId = "default", isSpeaking: boolean): void {
    this._isAssistantSpeaking.set(contextId, isSpeaking);
  }

  /**
   * Checks whether the assistant is currently speaking for this context.
   */
  public isSpeaking(contextId = "default"): boolean {
    return Boolean(this._isAssistantSpeaking.get(contextId));
  }

  /**
   * Stops/ducks active audio playback across all registered audio sinks.
   */
  public cancelPlayback(contextId = "default"): { cancelled: boolean; stoppedAudioBytes: number } {
    let totalBytes = 0;
    for (const cb of this._audioStopCallbacks) {
      try {
        totalBytes += cb(contextId);
      } catch {
        /* best-effort audio cancellation */
      }
    }
    this._isAssistantSpeaking.set(contextId, false);
    return { cancelled: true, stoppedAudioBytes: totalBytes };
  }

  /**
   * Handles user barge-in while assistant was speaking.
   */
  public handleInterruption(
    newUserUtterance: string,
    contextId = "default",
    interruptedModelText?: string,
    now = Date.now()
  ): InterruptionEvent {
    const raw = (newUserUtterance || "").trim();

    // 1. Immediately cancel active TTS playback
    const playbackResult = this.cancelPlayback(contextId);

    // 2. Mark last model turn as interrupted
    this._turnTracker.markLastModelTurnInterrupted(contextId);

    // 3. Classify interruption intent
    const category = this._classifyInterruption(raw);
    const targetEntity = this._extractCorrectionEntity(raw);

    const event: InterruptionEvent = {
      interruptionId: `barge_${now}_${crypto.randomBytes(3).toString("hex")}`,
      timestamp: now,
      userUtterance: raw,
      interruptedModelTurnText: interruptedModelText,
      interruptionType: category,
      targetCorrectionEntity: targetEntity,
      cancelledAudioBytes: playbackResult.stoppedAudioBytes,
      audioStopped: true,
      replanRequired: category !== "cancellation",
    };

    return event;
  }

  private _classifyInterruption(text: string): InterruptionCategory {
    const lower = text.toLowerCase();

    // 1. Correction: "nahi wo nahi, doosra wala", "not that one, use main.py"
    if (/\b(nahi wo nahi|nahi ye nahi|ye nahi|not that one|not this|instead use|doosra wala|wrong file)\b/i.test(lower)) {
      return "correction";
    }

    // 2. Interruption with priority override: "ruko, pehle git status check karo", "wait, first check..."
    if (
      /\b(ruko[,.\s]+pehle|wait[,.\s]+first|pehle ye karo|before that|first check|ek second)\b/i.test(lower) ||
      (/\b(ruko|wait|ek minute)\b/i.test(lower) && /\b(check|test|run|karo|dekho|open|kholo|status)\b/i.test(lower))
    ) {
      return "interruption";
    }

    // 3. Cancellation: "ruk jao", "cancel", "stop", "chhodo", "mat karo"
    if (/\b(ruk jao|ruko|cancel|stop|chhodo|mat karo|chhod do|halt|quiet|chup)\b/i.test(lower)) {
      return "cancellation";
    }

    // Follow-up
    if (/\b(aur suno|also|aur ye bhi|one more thing|wait and|and also)\b/i.test(lower)) {
      return "follow_up";
    }

    // Novel / new intent
    return "new_intent";
  }

  private _extractCorrectionEntity(text: string): string | null {
    const fileMatch = text.match(/[\w.-]+\.(ts|tsx|js|jsx|py|json|md|html|css|txt|log|yaml|yml)/i);
    if (fileMatch) return fileMatch[0];

    const appMatch = text.match(/\b(vscode|explorer|notepad|chrome|terminal)\b/i);
    if (appMatch) return appMatch[0];

    return null;
  }
}

export const bargeInController = new BargeInController();
