/**
 * MYRAA — Phase 20: Advanced Natural Conversation Engine
 * ConversationStateManager
 *
 * Maintains bounded short-term conversational state:
 *   - current topic, active entity, active project, active file, active application, active task
 *   - previous intent & current intent
 *   - pending confirmation (with single-use consumption and strict TTL)
 *   - recent user references and assistant actions
 *   - state expiration / stale-context protection: NEVER treats expired state as current fact
 */

import type { ConversationState, PendingConfirmation } from "./ConversationTypes.ts";

export const DEFAULT_CONVERSATION_TTL_MS = 300_000; // 5 minutes
export const DEFAULT_CONFIRMATION_TTL_MS = 60_000;  // 60 seconds

export class ConversationStateManager {
  private _states = new Map<string, ConversationState>();
  private readonly _defaultTtlMs: number;
  private readonly _confirmationTtlMs: number;

  constructor(
    defaultTtlMs = DEFAULT_CONVERSATION_TTL_MS,
    confirmationTtlMs = DEFAULT_CONFIRMATION_TTL_MS
  ) {
    this._defaultTtlMs = defaultTtlMs;
    this._confirmationTtlMs = confirmationTtlMs;
  }

  /**
   * Retrieves conversation state, automatically evaluating freshness and expiration.
   */
  public getConversationState(contextId = "default", now = Date.now()): ConversationState {
    let state = this._states.get(contextId);

    if (!state) {
      state = this._createInitialState(contextId, now);
      this._states.set(contextId, state);
      return state;
    }

    // Evaluate expiration
    const age = now - state.conversationTimestamp;
    const isExpired = age > state.stateExpiration;

    if (isExpired) {
      // Degrade expired conversational state to stale
      state.isStale = true;
      state.confidence = Math.max(0.1, state.confidence * 0.3);
      // Stale active entities are cleared so expired state is NEVER treated as current fact
      state.activeEntity = null;
      state.activeFile = null;
      state.activeApplication = null;
      state.pendingConfirmation = null;
    } else {
      state.isStale = false;
    }

    return state;
  }

  /**
   * Updates conversation state with new observations.
   */
  public updateConversationState(
    contextId = "default",
    updates: Partial<ConversationState>,
    now = Date.now()
  ): ConversationState {
    const current = this.getConversationState(contextId, now);

    const updated: ConversationState = {
      ...current,
      ...updates,
      conversationTimestamp: now,
      isStale: false,
      confidence: updates.confidence !== undefined ? updates.confidence : Math.max(0.85, current.confidence),
    };

    if (updates.recentUserReferences) {
      const merged = [...updates.recentUserReferences, ...current.recentUserReferences];
      updated.recentUserReferences = Array.from(new Set(merged)).slice(0, 10);
    }

    if (updates.recentAssistantActions) {
      const merged = [...updates.recentAssistantActions, ...current.recentAssistantActions];
      updated.recentAssistantActions = Array.from(new Set(merged)).slice(0, 10);
    }

    this._states.set(contextId, updated);
    return updated;
  }

  /**
   * Sets an active entity across topic, file, project, or app.
   */
  public setActiveEntity(
    contextId = "default",
    entity: string,
    type: "file" | "project" | "app" | "media" | "url",
    now = Date.now()
  ): ConversationState {
    const updates: Partial<ConversationState> = {
      activeEntity: entity,
    };

    if (type === "file") updates.activeFile = entity;
    if (type === "project") updates.activeProject = entity;
    if (type === "app") updates.activeApplication = entity;

    return this.updateConversationState(contextId, updates, now);
  }

  /**
   * Sets a pending confirmation requirement for a sensitive or mutating action.
   */
  public setPendingConfirmation(
    contextId = "default",
    confirmation: Omit<PendingConfirmation, "createdAt" | "expiresAt" | "isConfirmed" | "isCancelled">,
    ttlMs = this._confirmationTtlMs,
    now = Date.now()
  ): PendingConfirmation {
    const pending: PendingConfirmation = {
      ...confirmation,
      createdAt: now,
      expiresAt: now + ttlMs,
      isConfirmed: false,
      isCancelled: false,
    };

    const state = this.getConversationState(contextId, now);
    state.pendingConfirmation = pending;
    state.conversationTimestamp = now;
    state.isStale = false;
    this._states.set(contextId, state);

    return pending;
  }

  /**
   * Consumes or clears the pending confirmation.
   */
  public clearPendingConfirmation(contextId = "default"): void {
    const state = this._states.get(contextId);
    if (state) {
      state.pendingConfirmation = null;
    }
  }

  /**
   * Resets conversation state for testing or clean restart.
   */
  public resetState(contextId = "default"): void {
    this._states.delete(contextId);
  }

  /**
   * Clears all states across all contexts.
   */
  public clearAll(): void {
    this._states.clear();
  }

  private _createInitialState(contextId: string, now: number): ConversationState {
    return {
      conversationId: contextId,
      currentTopic: null,
      activeEntity: null,
      activeProject: null,
      activeFile: null,
      activeApplication: null,
      activeTask: null,
      previousIntent: null,
      currentIntent: null,
      pendingConfirmation: null,
      recentUserReferences: [],
      recentAssistantActions: [],
      conversationTimestamp: now,
      confidence: 1.0,
      stateExpiration: this._defaultTtlMs,
      isStale: false,
    };
  }
}

export const conversationStateManager = new ConversationStateManager();
