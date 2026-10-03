/**
 * MYRAA — Phase 20: Advanced Natural Conversation Engine
 * NaturalConversationEngine
 *
 * Clean public façade for natural multi-turn voice interaction:
 *   - converse: primary entry point for voice & text turns
 *   - handleInterruption: barge-in handler
 *   - confirmPending / cancelPending: explicit confirmation handlers
 *   - getState / reset: state inspection and lifecycle management
 */

import type { SecurityContext } from "../security/SecurityTypes.ts";
import type {
  ConversationState,
  NaturalConversationResponse,
  InterruptionEvent,
} from "./ConversationTypes.ts";
import {
  conversationContextCoordinator,
  ConversationContextCoordinator,
} from "./ConversationContextCoordinator.ts";
import { conversationStateManager, ConversationStateManager } from "./ConversationStateManager.ts";
import { bargeInController, BargeInController } from "./BargeInController.ts";
import { confirmationContextManager, ConfirmationContextManager } from "./ConfirmationContextManager.ts";

export class NaturalConversationEngine {
  private _coordinator: ConversationContextCoordinator;
  private _stateManager: ConversationStateManager;
  private _bargeIn: BargeInController;
  private _confirmation: ConfirmationContextManager;

  constructor(
    coordinator = conversationContextCoordinator,
    stateManager = conversationStateManager,
    bargeIn = bargeInController,
    confirmation = confirmationContextManager
  ) {
    this._coordinator = coordinator;
    this._stateManager = stateManager;
    this._bargeIn = bargeIn;
    this._confirmation = confirmation;
  }

  /**
   * Primary entry point for multi-turn conversation turn.
   */
  public async converse(
    userInput: string,
    contextId = "default",
    secContext?: SecurityContext
  ): Promise<NaturalConversationResponse> {
    return this._coordinator.processTurn(userInput, contextId, secContext);
  }

  /**
   * Handles user barge-in / speech interruption while assistant was speaking.
   */
  public handleInterruption(
    newUserUtterance: string,
    contextId = "default"
  ): InterruptionEvent {
    return this._bargeIn.handleInterruption(newUserUtterance, contextId);
  }

  /**
   * Confirms active pending action.
   */
  public confirmPending(
    contextId = "default",
    secContext?: SecurityContext
  ): Promise<NaturalConversationResponse> {
    return this.converse("haan kar do", contextId, secContext);
  }

  /**
   * Cancels active pending action.
   */
  public cancelPending(
    contextId = "default",
    secContext?: SecurityContext
  ): Promise<NaturalConversationResponse> {
    return this.converse("nahi cancel karo", contextId, secContext);
  }

  /**
   * Retrieves current conversation state.
   */
  public getState(contextId = "default"): ConversationState {
    return this._stateManager.getConversationState(contextId);
  }

  /**
   * Resets conversation state and cancels any pending audio/actions.
   */
  public reset(contextId = "default"): void {
    this._bargeIn.cancelPlayback(contextId);
    this._confirmation.clearPending(contextId);
    this._stateManager.resetState(contextId);
  }
}

export const naturalConversationEngine = new NaturalConversationEngine();
