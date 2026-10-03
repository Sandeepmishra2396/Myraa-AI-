/**
 * MYRAA — Phase 20: Advanced Natural Conversation Engine
 * ConfirmationContextManager
 *
 * Natural Confirmation & Cancellation Gate:
 *   - Evaluates "haan", "kar do", "theek hai", "bilkul", "yes" vs "nahi", "ruk jao", "cancel", "chhodo".
 *   - Strictly binds confirmations to the currently pending action.
 *   - INVARIANT: If user says "haan kar do" with NO pending confirmation -> MUST NOT invent an action!
 *   - Enforces TTL expiration (default 60s); rejects expired confirmations.
 *   - Enforces single-use consumption: old confirmation cannot be reused for a new action.
 *   - Security Invariant: Conversational "haan" never bypasses required security policy tokens for sensitive actions.
 */

import type { PendingConfirmation, ConfirmationResult, ConversationState } from "./ConversationTypes.ts";
import { conversationStateManager, ConversationStateManager } from "./ConversationStateManager.ts";

export class ConfirmationContextManager {
  private _stateManager: ConversationStateManager;

  constructor(stateManager = conversationStateManager) {
    this._stateManager = stateManager;
  }

  /**
   * Evaluates user utterance for confirmation or cancellation signals against pending confirmation.
   */
  public evaluateConfirmation(
    userInput: string,
    contextId = "default",
    now = Date.now()
  ): ConfirmationResult {
    const raw = (userInput || "").trim();
    const lower = raw.toLowerCase();
    const state = this._stateManager.getConversationState(contextId, now);
    const pending = state.pendingConfirmation;

    const isAffirmative =
      /\b(haan|ha|yes|kar do|chalo kar do|theek hai|bilkul|proceed|confirm|go ahead|yep|sure|wahi)\b/i.test(
        lower
      ) && !/\b(nahi|not|cancel|mat|dont|don't|no)\b/i.test(lower);

    const isNegative = /\b(nahi|ruk jao|ruko|cancel|mat karo|chhodo|stop|no|abort|leave it)\b/i.test(lower);

    // Case 1: Affirmative signal detected
    if (isAffirmative) {
      if (!pending) {
        // INVARIANT ENFORCEMENT: Never invent an action without a pending confirmation!
        return {
          isConfirmed: false,
          isCancelled: false,
          isPending: false,
          matchedPendingAction: null,
          reason: "NO_PENDING_CONFIRMATION: User affirmed, but no action is currently pending confirmation.",
          userUtterance: raw,
        };
      }

      // Check TTL expiration
      if (now > pending.expiresAt) {
        this._stateManager.clearPendingConfirmation(contextId);
        return {
          isConfirmed: false,
          isCancelled: true,
          isPending: false,
          matchedPendingAction: pending,
          reason: "CONFIRMATION_EXPIRED: The confirmation window has expired.",
          userUtterance: raw,
        };
      }

      // Valid confirmation: consume single-use token and clear pending
      const confirmedAction: PendingConfirmation = {
        ...pending,
        isConfirmed: true,
      };
      this._stateManager.clearPendingConfirmation(contextId);

      return {
        isConfirmed: true,
        isCancelled: false,
        isPending: false,
        matchedPendingAction: confirmedAction,
        reason: `CONFIRMED: Action '${confirmedAction.summary}' successfully confirmed by user.`,
        userUtterance: raw,
      };
    }

    // Case 2: Negative / cancellation signal detected
    if (isNegative) {
      if (pending) {
        const cancelledAction: PendingConfirmation = {
          ...pending,
          isCancelled: true,
        };
        this._stateManager.clearPendingConfirmation(contextId);

        return {
          isConfirmed: false,
          isCancelled: true,
          isPending: false,
          matchedPendingAction: cancelledAction,
          reason: `CANCELLED: Action '${cancelledAction.summary}' cancelled by user instruction.`,
          userUtterance: raw,
        };
      }

      return {
        isConfirmed: false,
        isCancelled: true,
        isPending: false,
        matchedPendingAction: null,
        reason: "CANCELLED: Cancellation signal received without active pending action.",
        userUtterance: raw,
      };
    }

    // Case 3: Neither confirmation nor cancellation
    return {
      isConfirmed: false,
      isCancelled: false,
      isPending: Boolean(pending),
      matchedPendingAction: pending,
      reason: "NEUTRAL: Input contains no affirmative or negative confirmation signal.",
      userUtterance: raw,
    };
  }

  /**
   * Registers a pending confirmation for an action requiring user approval.
   */
  public registerPendingConfirmation(
    contextId = "default",
    pending: Omit<PendingConfirmation, "createdAt" | "expiresAt" | "isConfirmed" | "isCancelled">,
    ttlMs = 60_000,
    now = Date.now()
  ): PendingConfirmation {
    return this._stateManager.setPendingConfirmation(contextId, pending, ttlMs, now);
  }

  /**
   * Clears pending confirmation.
   */
  public clearPending(contextId = "default"): void {
    this._stateManager.clearPendingConfirmation(contextId);
  }
}

export const confirmationContextManager = new ConfirmationContextManager();
