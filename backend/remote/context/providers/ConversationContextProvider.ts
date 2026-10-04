/**
 * ConversationContextProvider
 * Phase 22 — Mobile Context Intelligence
 *
 * Provides conversation dialogue context: recent turns, active query, and inferred intent.
 */

import type { IContextProvider, ConversationContextData } from "../MobileContextTypes.ts";

export class ConversationContextProvider implements IContextProvider<ConversationContextData> {
  readonly category = "conversation" as const;

  private recentHistory: Array<{ role: string; text: string }> = [];

  updateHistory(turns: Array<{ role: string; text: string }>): void {
    this.recentHistory = turns.slice(-6); // Keep last 6 turns
  }

  getContext(options?: { query?: string; rawPayload?: unknown }): ConversationContextData {
    const raw = (options?.rawPayload as Partial<ConversationContextData>) || {};
    const turns = raw.recentTurns || this.recentHistory;
    const lastUserMessage = options?.query || raw.lastUserMessage || turns.filter(t => t.role === "user").pop()?.text;

    return {
      recentTurns: turns,
      activeIntent: raw.activeIntent || (lastUserMessage ? "query_context" : undefined),
      lastUserMessage: lastUserMessage,
    };
  }
}
