/**
 * MYRAA — Phase 20: Advanced Natural Conversation Engine
 * ConversationTurnTracker
 *
 * Tracks sliding dialogue turns across users and model with timestamps,
 * extracted entities, detected intents, and barge-in / interruption flags.
 */

import crypto from "crypto";
import type { ConversationTurn, ConversationEntity } from "./ConversationTypes.ts";

export const MAX_TURNS_PER_CONTEXT = 20;

export class ConversationTurnTracker {
  private _history = new Map<string, ConversationTurn[]>();
  private readonly _maxTurns: number;

  constructor(maxTurns = MAX_TURNS_PER_CONTEXT) {
    this._maxTurns = maxTurns;
  }

  /**
   * Records a new dialogue turn.
   */
  public recordTurn(
    contextId = "default",
    role: "user" | "model",
    text: string,
    entities: ConversationEntity[] = [],
    detectedIntent?: string | null,
    wasInterrupted = false,
    now = Date.now()
  ): ConversationTurn {
    const list = this._history.get(contextId) || [];
    const turnIndex = list.length;
    const turnId = `turn_${now}_${crypto.randomBytes(3).toString("hex")}`;

    const turn: ConversationTurn = {
      turnId,
      turnIndex,
      role,
      text: (text || "").trim(),
      timestamp: now,
      entitiesMentioned: entities,
      detectedIntent: detectedIntent || null,
      wasInterrupted,
    };

    list.push(turn);
    if (list.length > this._maxTurns) {
      list.shift(); // Keep sliding window
    }

    this._history.set(contextId, list);
    return turn;
  }

  /**
   * Retrieves dialogue turns, optionally limited to the last N turns.
   */
  public getTurns(contextId = "default", limit?: number): ConversationTurn[] {
    const list = this._history.get(contextId) || [];
    if (!limit || limit >= list.length) {
      return [...list];
    }
    return list.slice(list.length - limit);
  }

  /**
   * Gets the last recorded turn by role, or the last turn overall if role is omitted.
   */
  public getLastTurn(contextId = "default", role?: "user" | "model"): ConversationTurn | null {
    const list = this._history.get(contextId) || [];
    if (list.length === 0) return null;

    if (!role) {
      return list[list.length - 1];
    }

    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].role === role) {
        return list[i];
      }
    }

    return null;
  }

  /**
   * Marks the most recent model turn as interrupted.
   */
  public markLastModelTurnInterrupted(contextId = "default"): void {
    const list = this._history.get(contextId) || [];
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].role === roleModel) {
        list[i].wasInterrupted = true;
        break;
      }
    }
  }

  /**
   * Clears all turn history for a context.
   */
  public clearTurns(contextId = "default"): void {
    this._history.delete(contextId);
  }

  /**
   * Clears history across all contexts.
   */
  public clearAll(): void {
    this._history.clear();
  }
}

const roleModel: "model" = "model";

export const conversationTurnTracker = new ConversationTurnTracker();
