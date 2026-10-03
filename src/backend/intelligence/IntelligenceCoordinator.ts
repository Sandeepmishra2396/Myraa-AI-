/**
 * MYRAA — IntelligenceCoordinator
 *
 * Master Coordinator for Phase 17: MYRAA Intelligence 2.0
 * Context-Aware Decision & Action Engine.
 *
 * Sits directly ABOVE the existing execution layer:
 * User
 *  ↓
 * Intelligence 2.0 (Context Fusion → Situation → Goal → Preference → Capabilities → Decision)
 *  ↓
 * Intent / Goal Resolution
 *  ↓
 * Existing Orchestrator (IntentCapabilityOrchestrator / ToolOrchestrator)
 *  ↓
 * Security Pipeline (SecurityPolicyEngine, RiskEngine, Firewall)
 *  ↓
 * Tool Execution
 *  ↓
 * Action Verification (ActionVerifier)
 *  ↓
 * Context & Task Memory Update (ContextMemoryUpdater)
 */

import { contextFusionEngine } from "./ContextFusionEngine.ts";
import { situationUnderstandingEngine } from "./SituationUnderstandingEngine.ts";
import { goalResolver } from "./GoalResolver.ts";
import { userPreferenceResolver } from "./UserPreferenceResolver.ts";
import { capabilityAwarenessEngine } from "./CapabilityAwarenessEngine.ts";
import { decisionEngine } from "./DecisionEngine.ts";
import { actionPlanningEngine } from "./ActionPlanningEngine.ts";
import { intelligenceActionVerifier } from "./ActionVerifier.ts";
import { contextMemoryUpdater } from "./ContextMemoryUpdater.ts";
import { intelligenceTrace } from "./IntelligenceTrace.ts";
import { contextFusionCoordinator } from "./ContextFusionCoordinator.ts";
import { referenceResolver } from "./ReferenceResolver.ts";
import {
  intentCapabilityOrchestrator,
  type OrchestratorExecutors,
} from "../orchestrator/IntentCapabilityOrchestrator.ts";
import type {
  DecisionEvaluation,
  FusedContext,
  IntelligenceTraceRecord,
  ResolvedGoal,
  SituationUnderstanding,
  TaskState,
  UnifiedMyraaContext,
} from "./IntelligenceTypes.ts";
import type { SecurityContext } from "../security/SecurityTypes.ts";
import type { TargetDevice } from "../orchestrator/OrchestratorTypes.ts";

export interface IntelligenceExecutionResult {
  ok: boolean;
  decision: DecisionEvaluation;
  executionOutcome?: unknown;
  verification?: {
    verified: boolean;
    failureReason?: string;
    details?: Record<string, unknown>;
  };
  clarification?: {
    required: boolean;
    question?: string;
    options?: string[];
  };
  confirmation?: {
    required: boolean;
    prompt?: string;
  };
  trace: IntelligenceTraceRecord;
}

export class IntelligenceCoordinator {
  public fusion = contextFusionEngine;
  public situation = situationUnderstandingEngine;
  public goals = goalResolver;
  public preferences = userPreferenceResolver;
  public capabilities = capabilityAwarenessEngine;
  public decision = decisionEngine;
  public planning = actionPlanningEngine;
  public verifier = intelligenceActionVerifier;
  public updater = contextMemoryUpdater;
  public trace = intelligenceTrace;
  public fusionCoordinator = contextFusionCoordinator;
  public references = referenceResolver;

  /**
   * Evaluates user input and produces a context-aware decision without immediate side-effects.
   */
  public evaluate(
    userInput: string,
    contextId = "default",
    secContext?: SecurityContext,
    deviceHint?: TargetDevice
  ): DecisionEvaluation {
    const startTime = Date.now();

    // 1. Context Fusion (7-tier priority + 5min transient decay)
    const fusedContext = this.fusion.fuseContext(contextId, deviceHint);

    // 2. Situation Understanding (Pronoun resolution + active entity binding + ambiguity check)
    const situation = this.situation.analyzeSituation(userInput, fusedContext);

    // 3. Goal Identification (Follow-up detection + expected outcome)
    const goal = this.goals.resolveGoal(userInput, situation, fusedContext);

    // 4. Decision Engine (Confidence scoring + risk check + action selection)
    const decision = this.decision.evaluateDecision(userInput, goal, situation, fusedContext, secContext);

    const durationMs = Date.now() - startTime;

    // 5. Intelligence Trace (Sanitized audit trail)
    this.trace.recordTrace({
      timestamp: startTime,
      durationMs,
      userInput,
      intent: decision.intent,
      context: {
        device: decision.contextSnapshot.device,
        app: decision.contextSnapshot.application,
        file: decision.contextSnapshot.file,
        project: decision.contextSnapshot.project,
        taskGoal: decision.contextSnapshot.task,
      },
      goal: {
        primary: goal.primaryGoal,
        confidence: goal.confidence,
      },
      candidateActions: decision.candidateActions.map((c) => ({
        tool: c.toolName,
        score: c.score,
        reason: c.reason,
      })),
      selectedAction: decision.selectedAction
        ? {
            tool: decision.selectedAction.toolName,
            args: decision.selectedAction.args,
            confidence: decision.confidence,
            confidenceScore: decision.confidenceScore,
          }
        : null,
      verification: {
        method: decision.verificationMethod,
        verified: false,
      },
      result: {
        ok: !decision.blockedBySecurity && !decision.requiresClarification,
        summary: decision.reason,
      },
    });

    return decision;
  }

  /**
   * Phase 19: Evaluates user input using full Unified Context Fusion.
   */
  public async evaluateUnified(
    userInput: string,
    contextId = "default",
    secContext?: SecurityContext,
    deviceHint?: TargetDevice
  ): Promise<{ decision: DecisionEvaluation; unifiedContext: UnifiedMyraaContext }> {
    const unifiedContext = await this.fusionCoordinator.fuseUnifiedContext(contextId, undefined, deviceHint, userInput);
    const situation = this.situation.analyzeSituation(userInput, unifiedContext);
    const goal = this.goals.resolveGoal(userInput, situation, unifiedContext);
    const decision = this.decision.evaluateDecision(userInput, goal, situation, unifiedContext, secContext);
    return { decision, unifiedContext };
  }

  /**
   * Executes a user request with full Intelligence 2.0 lifecycle:
   * Evaluate -> Gate Security -> Plan/Orchestrate -> Verify -> Remember
   */
  public async execute(
    userInput: string,
    contextId = "default",
    secContext?: SecurityContext,
    executors?: OrchestratorExecutors,
    deviceHint?: TargetDevice
  ): Promise<IntelligenceExecutionResult> {
    const startTime = Date.now();

    // 1. Evaluate Decision
    const decision = this.evaluate(userInput, contextId, secContext, deviceHint);

    // Case A: Blocked by Security (Emergency Stop / Lockdown / Security Policy)
    if (decision.blockedBySecurity) {
      const trace = this.trace.recordTrace({
        timestamp: startTime,
        durationMs: Date.now() - startTime,
        userInput,
        intent: decision.intent,
        context: {
          device: decision.contextSnapshot.device,
          app: decision.contextSnapshot.application,
          file: decision.contextSnapshot.file,
          project: decision.contextSnapshot.project,
          taskGoal: decision.contextSnapshot.task,
        },
        goal: {
          primary: decision.goal.primaryGoal,
          confidence: decision.goal.confidence,
        },
        candidateActions: [],
        selectedAction: null,
        verification: { method: "security_gate", verified: false },
        result: { ok: false, summary: `BLOCKED: ${decision.securityBlockReason}` },
      });

      return {
        ok: false,
        decision,
        trace,
      };
    }

    // Case B: High Ambiguity -> Requires Clarification
    if (decision.requiresClarification) {
      const trace = this.trace.recordTrace({
        timestamp: startTime,
        durationMs: Date.now() - startTime,
        userInput,
        intent: decision.intent,
        context: {
          device: decision.contextSnapshot.device,
          app: decision.contextSnapshot.application,
          file: decision.contextSnapshot.file,
          project: decision.contextSnapshot.project,
          taskGoal: decision.contextSnapshot.task,
        },
        goal: {
          primary: decision.goal.primaryGoal,
          confidence: decision.goal.confidence,
        },
        candidateActions: [],
        selectedAction: null,
        verification: { method: "clarification", verified: false },
        result: { ok: false, summary: "Clarification requested from user" },
      });

      return {
        ok: false,
        decision,
        clarification: {
          required: true,
          question: decision.clarificationQuestion,
          options: decision.clarificationOptions,
        },
        trace,
      };
    }

    // Case C: High Risk -> Requires Verbal/Interactive Confirmation
    if (decision.requiresConfirmation) {
      const trace = this.trace.recordTrace({
        timestamp: startTime,
        durationMs: Date.now() - startTime,
        userInput,
        intent: decision.intent,
        context: {
          device: decision.contextSnapshot.device,
          app: decision.contextSnapshot.application,
          file: decision.contextSnapshot.file,
          project: decision.contextSnapshot.project,
          taskGoal: decision.contextSnapshot.task,
        },
        goal: {
          primary: decision.goal.primaryGoal,
          confidence: decision.goal.confidence,
        },
        candidateActions: decision.candidateActions.map((c) => ({
          tool: c.toolName,
          score: c.score,
          reason: c.reason,
        })),
        selectedAction: decision.selectedAction
          ? {
              tool: decision.selectedAction.toolName,
              args: decision.selectedAction.args,
              confidence: decision.confidence,
              confidenceScore: decision.confidenceScore,
            }
          : null,
        verification: { method: "confirmation_gate", verified: false },
        result: { ok: false, summary: "Action paused awaiting user confirmation" },
      });

      return {
        ok: false,
        decision,
        confirmation: {
          required: true,
          prompt: decision.confirmationPrompt,
        },
        trace,
      };
    }

    // Case D: Safe & Confident Execution via Existing Orchestrator
    const selected = decision.selectedAction;
    if (!selected) {
      const trace = this.trace.recordTrace({
        timestamp: startTime,
        durationMs: Date.now() - startTime,
        userInput,
        intent: decision.intent,
        context: {
          device: decision.contextSnapshot.device,
          app: decision.contextSnapshot.application,
          file: decision.contextSnapshot.file,
          project: decision.contextSnapshot.project,
          taskGoal: decision.contextSnapshot.task,
        },
        goal: { primary: decision.goal.primaryGoal, confidence: decision.goal.confidence },
        candidateActions: [],
        selectedAction: null,
        verification: { method: "none", verified: false },
        result: { ok: false, summary: "No candidate action available" },
      });

      return {
        ok: false,
        decision,
        trace,
      };
    }

    // Execute through existing IntentCapabilityOrchestrator
    const orchestratorOutcome = await intentCapabilityOrchestrator.orchestrateToolCall(
      selected.toolName,
      selected.args,
      contextId,
      secContext,
      executors
    );

    // 5. Action Verification
    const verification = this.verifier.verifyCapabilityResult(
      selected.capability,
      selected.toolName,
      { ok: orchestratorOutcome.ok, result: orchestratorOutcome.output, error: orchestratorOutcome.error },
      selected.targetDevice
    );

    // 6. Context & Task Result Learning
    this.updater.recordExecutionResult(
      contextId,
      selected,
      orchestratorOutcome.output,
      verification.verified,
      verification.failureReason
    );

    // 7. Intelligence Trace
    const durationMs = Date.now() - startTime;
    const trace = this.trace.recordTrace({
      timestamp: startTime,
      durationMs,
      userInput,
      intent: selected.capability,
      context: {
        device: decision.contextSnapshot.device,
        app: decision.contextSnapshot.application,
        file: decision.contextSnapshot.file,
        project: decision.contextSnapshot.project,
        taskGoal: decision.contextSnapshot.task,
      },
      goal: {
        primary: decision.goal.primaryGoal,
        confidence: decision.goal.confidence,
      },
      candidateActions: decision.candidateActions.map((c) => ({
        tool: c.toolName,
        score: c.score,
        reason: c.reason,
      })),
      selectedAction: {
        tool: selected.toolName,
        args: selected.args,
        confidence: decision.confidence,
        confidenceScore: decision.confidenceScore,
      },
      verification: {
        method: decision.verificationMethod,
        verified: verification.verified,
        details: verification.failureReason,
      },
      result: {
        ok: verification.verified,
        summary: verification.verified
          ? `Successfully executed and verified '${selected.toolName}'`
          : `Execution failed verification: ${verification.failureReason}`,
      },
    });

    return {
      ok: verification.verified,
      decision,
      executionOutcome: orchestratorOutcome.output,
      verification: {
        verified: verification.verified,
        failureReason: verification.failureReason,
        details: verification.details,
      },
      trace,
    };
  }

  /**
   * Utility for testing and session resets.
   */
  public resetForTesting(): void {
    this.trace.clearTraces();
  }
}

export const intelligenceCoordinator = new IntelligenceCoordinator();
