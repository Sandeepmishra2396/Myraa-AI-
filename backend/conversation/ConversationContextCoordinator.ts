/**
 * MYRAA — Phase 20: Advanced Natural Conversation Engine
 * ConversationContextCoordinator
 *
 * Master multi-turn conversation coordinator that seamlessly integrates:
 *   - Phase 16: Natural voice pacing & acknowledgements (HumanConversationEngine, NaturalReactionEngine)
 *   - Phase 17: Goal resolution & decision engine (SituationUnderstandingEngine, GoalResolver, DecisionEngine)
 *   - Phase 18: Personal brain directives & learned communication style
 *   - Phase 19: Unified perception context & deictic reference resolution (UnifiedMyraaContext)
 *   - Phase 20: Short-term conversation state, follow-up continuity, barge-in, and natural confirmation
 */

import type { SecurityContext } from "../security/SecurityTypes.ts";
import type {
  ConversationState,
  NaturalConversationResponse,
  InterruptionEvent,
} from "./ConversationTypes.ts";
import { conversationStateManager, ConversationStateManager } from "./ConversationStateManager.ts";
import { conversationTurnTracker, ConversationTurnTracker } from "./ConversationTurnTracker.ts";
import { conversationEntityTracker, ConversationEntityTracker } from "./ConversationEntityTracker.ts";
import { followUpIntentResolver, FollowUpIntentResolver } from "./FollowUpIntentResolver.ts";
import { conversationalReferenceResolver, ConversationalReferenceResolver } from "./ConversationalReferenceResolver.ts";
import { confirmationContextManager, ConfirmationContextManager } from "./ConfirmationContextManager.ts";
import { bargeInController, BargeInController } from "./BargeInController.ts";
import { contextFusionCoordinator, ContextFusionCoordinator } from "../intelligence/ContextFusionCoordinator.ts";
import { situationUnderstandingEngine, SituationUnderstandingEngine } from "../intelligence/SituationUnderstandingEngine.ts";
import { goalResolver, GoalResolver } from "../intelligence/GoalResolver.ts";
import { decisionEngine, DecisionEngine } from "../intelligence/DecisionEngine.ts";
import { HumanConversationEngine } from "../voice/HumanConversationEngine.ts";
import { emergencyStopCoordinator } from "../remote/EmergencyStopCoordinator.ts";
import { securityPolicyEngine } from "../security/SecurityPolicyEngine.ts";
import { predictiveContextCoordinator } from "../proactive/PredictiveContextCoordinator.ts";

export class ConversationContextCoordinator {
  private _stateManager: ConversationStateManager;
  private _turnTracker: ConversationTurnTracker;
  private _entityTracker: ConversationEntityTracker;
  private _followUpResolver: FollowUpIntentResolver;
  private _referenceResolver: ConversationalReferenceResolver;
  private _confirmationManager: ConfirmationContextManager;
  private _bargeInController: BargeInController;
  private _fusionCoordinator: ContextFusionCoordinator;
  private _situationEngine: SituationUnderstandingEngine;
  private _goalResolver: GoalResolver;
  private _decisionEngine: DecisionEngine;
  private _humanConversation: HumanConversationEngine;

  constructor(
    stateManager = conversationStateManager,
    turnTracker = conversationTurnTracker,
    entityTracker = conversationEntityTracker,
    followUpResolver = followUpIntentResolver,
    refResolver = conversationalReferenceResolver,
    confManager = confirmationContextManager,
    bargeIn = bargeInController,
    fusionCoordinator = contextFusionCoordinator,
    situationEngine = situationUnderstandingEngine,
    goalResolverEngine = goalResolver,
    decisionEngineInstance = decisionEngine,
    humanConversation = HumanConversationEngine.getInstance()
  ) {
    this._stateManager = stateManager;
    this._turnTracker = turnTracker;
    this._entityTracker = entityTracker;
    this._followUpResolver = followUpResolver;
    this._referenceResolver = refResolver;
    this._confirmationManager = confManager;
    this._bargeInController = bargeIn;
    this._fusionCoordinator = fusionCoordinator;
    this._situationEngine = situationEngine;
    this._goalResolver = goalResolverEngine;
    this._decisionEngine = decisionEngineInstance;
    this._humanConversation = humanConversation;
  }

  /**
   * Main conversational turn processor:
   * Takes raw user speech/text, orchestrates multi-turn state, enforces security gates,
   * and produces natural, context-aware conversational outcomes.
   */
  public async processTurn(
    userInput: string,
    contextId = "default",
    secContext?: SecurityContext,
    now = Date.now()
  ): Promise<NaturalConversationResponse> {
    const raw = (userInput || "").trim();
    let interruptionEvent: InterruptionEvent | undefined;

    // ── 1. Interruption / Barge-In Gate ─────────────────────────────────────
    if (this._bargeInController.isSpeaking(contextId)) {
      const lastModelTurn = this._turnTracker.getLastTurn(contextId, "model");
      interruptionEvent = this._bargeInController.handleInterruption(
        raw,
        contextId,
        lastModelTurn?.text,
        now
      );
    }

    // ── 2. Retrieve & Validate Multi-Turn Conversation State ────────────────
    const state = this._stateManager.getConversationState(contextId, now);

    // ── 3. Natural Confirmation & Cancellation Gate ─────────────────────────
    const confirmation = this._confirmationManager.evaluateConfirmation(raw, contextId, now);

    if (confirmation.isConfirmed && confirmation.matchedPendingAction) {
      const action = confirmation.matchedPendingAction;
      this._stateManager.updateConversationState(
        contextId,
        {
          previousIntent: state.currentIntent,
          currentIntent: action.capability,
          pendingConfirmation: null,
          recentAssistantActions: [action.summary, ...state.recentAssistantActions],
        },
        now
      );

      this._turnTracker.recordTurn(contextId, "user", raw, [], "confirm", false, now);

      const responseSpeech = `Haan Sandeep, maine ${action.summary} execute kar diya hai.`;
      this._turnTracker.recordTurn(contextId, "model", responseSpeech, [], action.capability, false, now);

      const decision = this._decisionEngine.evaluateDecision(
        action.summary,
        this._goalResolver.resolveGoal(action.summary, this._situationEngine.analyzeSituation(action.summary, { contextId } as any), { contextId } as any),
        this._situationEngine.analyzeSituation(action.summary, { contextId } as any),
        { contextId } as any,
        secContext
      );

      return {
        decision: {
          ...decision,
          intent: action.capability,
          reason: `Action '${action.summary}' confirmed and authorized.`,
          requiresConfirmation: false,
        },
        conversationState: this._stateManager.getConversationState(contextId, now),
        responseSpeech,
        acknowledgement: "Haan, bilkul.",
        pacing: "short",
        requiresConfirmation: false,
        requiresClarification: false,
        interruptionHandled: Boolean(interruptionEvent),
        interruptionEvent,
      };
    }

    if (confirmation.isCancelled) {
      this._stateManager.updateConversationState(
        contextId,
        {
          pendingConfirmation: null,
          previousIntent: state.currentIntent,
          currentIntent: "CANCELLED",
        },
        now
      );

      this._turnTracker.recordTurn(contextId, "user", raw, [], "cancel", false, now);
      const responseSpeech = "Theek hai, maine cancel kar diya hai. Kuch aur karna hai?";
      this._turnTracker.recordTurn(contextId, "model", responseSpeech, [], "cancel", false, now);

      return {
        decision: {
          decisionId: `dec_cancel_${now}`,
          timestamp: now,
          userInput: raw,
          intent: "CANCELLED",
          targetDevice: "DESKTOP",
          targetEntity: null,
          goal: {
            goalId: "cancel_goal",
            rawInput: raw,
            primaryGoal: "Cancel active operation",
            subGoals: [],
            expectedOutcome: "Action cancelled",
            isImplicit: false,
            referenceResolved: true,
            targetEntity: null,
            targetDevice: "DESKTOP",
            confidence: 1.0,
            isFollowUp: true,
            followUpType: "cancel",
          },
          contextSnapshot: { device: "DESKTOP", application: null, file: null, project: null, task: null },
          availableCapabilities: [],
          constraints: [],
          risk: "LOW",
          confidence: "HIGH",
          confidenceScore: 1.0,
          candidateActions: [],
          selectedAction: null,
          reason: "User explicitly cancelled the pending operation.",
          verificationMethod: "none",
          requiresClarification: false,
          requiresConfirmation: false,
        },
        conversationState: this._stateManager.getConversationState(contextId, now),
        responseSpeech,
        acknowledgement: "Achha, theek hai.",
        pacing: "short",
        requiresConfirmation: false,
        requiresClarification: false,
        interruptionHandled: Boolean(interruptionEvent),
        interruptionEvent,
      };
    }

    // ── 3b. Proactive Suggestion Confirmation Gate ────────────────────────
    const pendingProactive = predictiveContextCoordinator.getPendingProactiveEvent(now);
    const isProactiveAffirmative =
      /\b(haan|ha|yes|kar do|chalo kar do|theek hai|bilkul|proceed|confirm|go ahead|yep|sure|wahi)\b/i.test(raw) &&
      !/\b(nahi|not|cancel|mat|dont|don't|no)\b/i.test(raw);
    const isProactiveNegative =
      /\b(nahi|ruk jao|ruko|cancel|mat karo|chhodo|stop|no|abort|leave it)\b/i.test(raw);
    const isProactiveSnooze =
      /\b(baad mein|baad me|later|snooze|fir kabhi|phir kabhi)\b/i.test(raw);

    if (pendingProactive && (isProactiveAffirmative || isProactiveNegative || isProactiveSnooze)) {
      const proactiveResolution = await predictiveContextCoordinator.handleUserResponse(raw, contextId, now);
      this._turnTracker.recordTurn(contextId, "user", raw, [], "proactive_response", false, now);
      this._turnTracker.recordTurn(contextId, "model", proactiveResolution.responseSpeech, [], "proactive_result", false, now);

      return {
        decision: {
          decisionId: `dec_proactive_${now}`,
          timestamp: now,
          userInput: raw,
          intent: pendingProactive.suggestedAction?.capability || "general.assist",
          targetDevice: pendingProactive.suggestedAction?.targetDevice || "DESKTOP",
          targetEntity: pendingProactive.file || pendingProactive.project || null,
          goal: {
            goalId: `goal_proactive_${now}`,
            rawInput: raw,
            primaryGoal: pendingProactive.analysis.summary,
            subGoals: [],
            expectedOutcome: proactiveResolution.reason,
            isImplicit: false,
            referenceResolved: true,
            targetEntity: pendingProactive.file || pendingProactive.project || null,
            targetDevice: pendingProactive.suggestedAction?.targetDevice || "DESKTOP",
            confidence: pendingProactive.confidenceScore,
            isFollowUp: true,
            followUpType: isProactiveAffirmative ? "confirm" : "cancel",
          },
          contextSnapshot: {
            device: "DESKTOP",
            application: null,
            file: pendingProactive.file,
            project: pendingProactive.project,
            task: pendingProactive.task,
          },
          availableCapabilities: [],
          constraints: [],
          risk: pendingProactive.riskLevel,
          confidence: pendingProactive.confidence,
          confidenceScore: pendingProactive.confidenceScore,
          candidateActions: [],
          selectedAction: pendingProactive.suggestedAction
            ? {
                id: pendingProactive.suggestedAction.id,
                capability: pendingProactive.suggestedAction.capability,
                toolName: pendingProactive.suggestedAction.toolName,
                args: pendingProactive.suggestedAction.args,
                targetDevice: pendingProactive.suggestedAction.targetDevice,
                score: 0.98,
                risk: pendingProactive.riskLevel,
                requiresConfirmation: false,
                reason: pendingProactive.analysis.summary,
                verificationMethod: "proactive_verification",
              }
            : null,
          reason: proactiveResolution.reason,
          verificationMethod: "proactive_verification",
          requiresClarification: false,
          requiresConfirmation: false,
          blockedBySecurity: proactiveResolution.actionTaken === "BLOCKED",
          securityBlockReason: proactiveResolution.reason,
        },
        conversationState: this._stateManager.getConversationState(contextId, now),
        responseSpeech: proactiveResolution.responseSpeech,
        acknowledgement: isProactiveAffirmative ? "Haan, bilkul." : "Achha, theek hai.",
        pacing: "short",
        requiresConfirmation: false,
        requiresClarification: false,
        interruptionHandled: Boolean(interruptionEvent),
        interruptionEvent,
      };
    }

    // Guard against ghost affirmations when no confirmation was pending
    const isAffirmative =
      /\b(haan|ha|yes|kar do|chalo kar do|theek hai|bilkul|proceed)\b/i.test(raw) &&
      !/\b(nahi|not|cancel|mat|dont|don't|no)\b/i.test(raw);

    if (isAffirmative && !state.pendingConfirmation && raw.split(/\s+/).length <= 4 && !/\b(kholo|open|inspect|check|run)\b/i.test(raw)) {
      this._turnTracker.recordTurn(contextId, "user", raw, [], "affirmation_without_pending", false, now);
      const responseSpeech = "Haan Sandeep, lekin abhi koi pending action nahi hai jise confirm karna ho. Aap kya karna chahte hain?";
      this._turnTracker.recordTurn(contextId, "model", responseSpeech, [], "info", false, now);

      return {
        decision: {
          decisionId: `dec_noop_${now}`,
          timestamp: now,
          userInput: raw,
          intent: "NOOP",
          targetDevice: "DESKTOP",
          targetEntity: null,
          goal: {
            goalId: "noop_goal",
            rawInput: raw,
            primaryGoal: "None",
            subGoals: [],
            expectedOutcome: "No action",
            isImplicit: false,
            referenceResolved: false,
            targetEntity: null,
            targetDevice: "DESKTOP",
            confidence: 1.0,
            isFollowUp: false,
            followUpType: null,
          },
          contextSnapshot: { device: "DESKTOP", application: null, file: null, project: null, task: null },
          availableCapabilities: [],
          constraints: ["No pending action was awaiting confirmation."],
          risk: "LOW",
          confidence: "HIGH",
          confidenceScore: 1.0,
          candidateActions: [],
          selectedAction: null,
          reason: "INVARIANT: Affirmation received with no pending confirmation; ghost actions strictly rejected.",
          verificationMethod: "none",
          requiresClarification: false,
          requiresConfirmation: false,
        },
        conversationState: state,
        responseSpeech,
        acknowledgement: "Hmm, samajh gayi.",
        pacing: "short",
        requiresConfirmation: false,
        requiresClarification: false,
        interruptionHandled: Boolean(interruptionEvent),
        interruptionEvent,
      };
    }

    // ── 4. Entity Extraction & Contextual Tracking ──────────────────────────
    const extractedEntities = this._entityTracker.trackEntitiesFromUtterance(
      raw,
      "user",
      this._turnTracker.getTurns(contextId).length,
      contextId,
      now
    );

    // ── 5. Multi-Source Context Fusion (Phase 19 Integration) ────────────────
    const unifiedContext = await this._fusionCoordinator.fuseUnifiedContext(contextId, undefined, undefined, raw);

    // ── 6. Conversational Reference Resolution ──────────────────────────────
    const refResult = this._referenceResolver.resolveReference(raw, state, unifiedContext, now);

    // Check if ambiguity requires clarification (NEVER GUESS)
    if (refResult.isAmbiguous && refResult.clarificationPrompt) {
      this._turnTracker.recordTurn(contextId, "user", raw, extractedEntities, "ambiguous_query", false, now);
      const responseSpeech = refResult.clarificationPrompt;
      this._turnTracker.recordTurn(contextId, "model", responseSpeech, [], "clarification", false, now);

      return {
        decision: {
          decisionId: `dec_clarify_${now}`,
          timestamp: now,
          userInput: raw,
          intent: "CLARIFICATION_NEEDED",
          targetDevice: "DESKTOP",
          targetEntity: null,
          goal: {
            goalId: `goal_clarify_${now}`,
            rawInput: raw,
            primaryGoal: "Clarify ambiguous reference",
            subGoals: [],
            expectedOutcome: "Clarified reference from user",
            isImplicit: true,
            referenceResolved: false,
            targetEntity: null,
            targetDevice: "DESKTOP",
            confidence: refResult.confidence,
            isFollowUp: false,
            followUpType: null,
          },
          contextSnapshot: {
            device: unifiedContext.deviceState.deviceType,
            application: unifiedContext.currentApplication,
            file: unifiedContext.currentFile,
            project: unifiedContext.currentProject,
            task: unifiedContext.currentTask?.goal || null,
          },
          availableCapabilities: [],
          constraints: ["Ambiguity detected: multiple candidates exist with similar confidence."],
          risk: "LOW",
          confidence: "LOW",
          confidenceScore: refResult.confidence,
          candidateActions: [],
          selectedAction: null,
          reason: "AMBIGUITY_GATE: Refused to guess without user clarification.",
          verificationMethod: "none",
          requiresClarification: true,
          clarificationQuestion: refResult.clarificationPrompt,
          clarificationOptions: refResult.candidateAlternatives,
          requiresConfirmation: false,
        },
        conversationState: state,
        responseSpeech,
        acknowledgement: "Achha, ek second...",
        pacing: "short",
        requiresConfirmation: false,
        requiresClarification: true,
        clarificationQuestion: refResult.clarificationPrompt,
        clarificationOptions: refResult.candidateAlternatives,
        interruptionHandled: Boolean(interruptionEvent),
        interruptionEvent,
      };
    }

    // ── 7. Follow-Up Intent Resolution ──────────────────────────────────────
    const followUp = this._followUpResolver.resolveFollowUp(
      raw,
      state,
      refResult.candidateAlternatives
    );

    // If reference was resolved, update target in unified context
    const resolvedTarget = refResult.resolvedEntity || followUp.resolvedTarget || state.activeEntity;

    const effectiveContext = {
      ...unifiedContext,
      currentFile: refResult.resolvedType === "file" ? (resolvedTarget || unifiedContext.currentFile) : (state.activeFile || unifiedContext.currentFile),
      currentProject: refResult.resolvedType === "project" ? (resolvedTarget || unifiedContext.currentProject) : (state.activeProject || unifiedContext.currentProject),
      currentApplication: refResult.resolvedType === "app" ? (resolvedTarget || unifiedContext.currentApplication) : (state.activeApplication || unifiedContext.currentApplication),
    };

    const situation = this._situationEngine.analyzeSituation(raw, effectiveContext);

    const goal = this._goalResolver.resolveGoal(raw, situation, effectiveContext);
    if (resolvedTarget && !goal.targetEntity) {
      goal.targetEntity = resolvedTarget;
      goal.referenceResolved = true;
    }

    // ── 8. Decision Evaluation & Security Gates (Phase 17/19) ───────────────
    const decision = this._decisionEngine.evaluateDecision(raw, goal, situation, effectiveContext, secContext);

    // ── 9. Response Formulation, Pacing & Acknowledgements ──────────────────
    const pacing = this._humanConversation.selectPacing(raw);
    const acknowledgement = this._selectAcknowledgement(raw, decision.intent, decision.risk);

    let responseSpeech = "";
    if (decision.blockedBySecurity) {
      responseSpeech = `Yeh action security policy ki wajah se block ho gaya hai: ${decision.securityBlockReason}.`;
    } else if (decision.requiresConfirmation) {
      responseSpeech = decision.confirmationPrompt || `Main ${decision.reason} karne jaa rahi hoon. Kya main aage badhoon?`;
      // Register pending confirmation in conversation state
      if (decision.selectedAction) {
        this._stateManager.setPendingConfirmation(contextId, {
          confirmationId: `conf_${now}`,
          actionId: decision.selectedAction.id,
          capability: decision.selectedAction.capability,
          toolName: decision.selectedAction.toolName,
          targetEntity: resolvedTarget,
          targetDevice: decision.targetDevice,
          args: decision.selectedAction.args,
          summary: decision.selectedAction.reason,
          risk: decision.risk,
        });
      }
    } else if (decision.requiresClarification) {
      responseSpeech = decision.clarificationQuestion || "Aap kis cheez ki baat kar rahe hain? Kripya clear kijiye.";
    } else {
      responseSpeech = `${acknowledgement} Maine '${decision.intent}' prepare kar liya hai: ${decision.reason}`;
    }

    // ── 10. Update Conversation State & History ─────────────────────────────
    const updatedState = this._stateManager.updateConversationState(
      contextId,
      {
        previousIntent: state.currentIntent,
        currentIntent: decision.intent,
        activeEntity: resolvedTarget || state.activeEntity,
        activeFile: refResult.resolvedType === "file" ? resolvedTarget : state.activeFile,
        activeProject: refResult.resolvedType === "project" ? resolvedTarget : state.activeProject,
        activeApplication: refResult.resolvedType === "app" ? resolvedTarget : state.activeApplication,
        recentUserReferences: resolvedTarget ? [resolvedTarget] : [],
        recentAssistantActions: [decision.reason],
      },
      now
    );

    this._turnTracker.recordTurn(contextId, "user", raw, extractedEntities, decision.intent, false, now);
    this._turnTracker.recordTurn(contextId, "model", responseSpeech, [], decision.intent, false, now);

    return {
      decision,
      conversationState: updatedState,
      responseSpeech,
      acknowledgement,
      pacing,
      requiresConfirmation: decision.requiresConfirmation,
      confirmationPrompt: decision.confirmationPrompt,
      requiresClarification: decision.requiresClarification,
      clarificationQuestion: decision.clarificationQuestion,
      clarificationOptions: decision.clarificationOptions,
      interruptionHandled: Boolean(interruptionEvent),
      interruptionEvent,
    };
  }

  private _selectAcknowledgement(text: string, intent: string, risk: string): string {
    if (risk === "HIGH" || risk === "CRITICAL") return "Ek second...";
    if (/\b(kholo|open|chalao|play|start)\b/i.test(text)) return "Haan, bilkul.";
    if (/\b(check|inspect|bug|error|problem)\b/i.test(text)) return "Hmm, samajh gayi.";
    if (/\b(theek|done|wahi)\b/i.test(text)) return "Theek hai.";
    return "Haan Sandeep,";
  }
}

export const conversationContextCoordinator = new ConversationContextCoordinator();
