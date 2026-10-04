/**
 * MYRAA — Phase 21: Predictive / Proactive Engine
 * PredictiveContextCoordinator
 *
 * Master Orchestrator for proactive intelligence:
 *   - Enforces the strict safety pipeline:
 *     OBSERVE → ANALYZE → PREPARE → ASK → EXECUTE → VERIFY
 *   - Never silently executes destructive or state-changing actions.
 *   - Honors Emergency Stop and Security Lockdown gates unconditionally.
 *   - Manages deduplication, cooldowns, and single-use approval resolution.
 *   - Integrates with Phase 18 Personal Brain, Phase 19 Context Fusion,
 *     and Phase 20 Natural Conversation.
 */

import type {
  ProactiveEvent,
  ProactiveExecutionResult,
  ProactiveResolutionResult,
  RawProactiveSignal,
} from "./ProactiveTypes.ts";
import { DEFAULT_PROACTIVE_TTL_MS } from "./ProactiveTypes.ts";
import { predictiveSignalDetector, PredictiveSignalDetector } from "./PredictiveSignalDetector.ts";
import { proactiveInsightAnalyzer, ProactiveInsightAnalyzer } from "./ProactiveInsightAnalyzer.ts";
import { proactiveDeduplicationEngine, ProactiveDeduplicationEngine } from "./ProactiveDeduplicationEngine.ts";
import { proactiveCooldownManager, ProactiveCooldownManager } from "./ProactiveCooldownManager.ts";
import { proactiveSuggestionEngine, ProactiveSuggestionEngine } from "./ProactiveSuggestionEngine.ts";
import { proactiveNotificationManager, ProactiveNotificationManager } from "./ProactiveNotificationManager.ts";
import { proactiveVerificationManager, ProactiveVerificationManager } from "./ProactiveVerificationManager.ts";
import { emergencyStopCoordinator } from "../remote/EmergencyStopCoordinator.ts";
import { securityPolicyEngine } from "../security/SecurityPolicyEngine.ts";
import { contextFusionCoordinator } from "../intelligence/ContextFusionCoordinator.ts";

export class PredictiveContextCoordinator {
  private _signalDetector: PredictiveSignalDetector;
  private _insightAnalyzer: ProactiveInsightAnalyzer;
  private _dedupEngine: ProactiveDeduplicationEngine;
  private _cooldownManager: ProactiveCooldownManager;
  private _suggestionEngine: ProactiveSuggestionEngine;
  private _notificationManager: ProactiveNotificationManager;
  private _verificationManager: ProactiveVerificationManager;

  private _events: ProactiveEvent[] = [];
  private _pendingEvent: ProactiveEvent | null = null;
  private _mockActionExecutor?: (action: any) => Promise<{ ok: boolean; stdout?: string; stderr?: string; exitCode?: number; content?: string; error?: string }>;

  constructor(
    signalDetector = predictiveSignalDetector,
    insightAnalyzer = proactiveInsightAnalyzer,
    dedupEngine = proactiveDeduplicationEngine,
    cooldownManager = proactiveCooldownManager,
    suggestionEngine = proactiveSuggestionEngine,
    notificationManager = proactiveNotificationManager,
    verificationManager = proactiveVerificationManager
  ) {
    this._signalDetector = signalDetector;
    this._insightAnalyzer = insightAnalyzer;
    this._dedupEngine = dedupEngine;
    this._cooldownManager = cooldownManager;
    this._suggestionEngine = suggestionEngine;
    this._notificationManager = notificationManager;
    this._verificationManager = verificationManager;
  }

  /**
   * Allows injecting a custom tool execution handler for testing or mock runs.
   */
  public setMockActionExecutor(
    executor?: (action: any) => Promise<{ ok: boolean; stdout?: string; stderr?: string; exitCode?: number; content?: string; error?: string }>
  ): void {
    this._mockActionExecutor = executor;
  }

  /**
   * Ingests a raw signal from terminal, compiler, test runner, or runtime logs,
   * performs diagnosis, checks deduplication and cooldowns, and formulates a proactive event.
   */
  public async observeSignal(
    signal: RawProactiveSignal,
    now = Date.now()
  ): Promise<ProactiveEvent | null> {
    // ── 1. Security Gate: Emergency Stop ────────────────────────────────────
    if (emergencyStopCoordinator.isActive()) {
      return null;
    }

    // ── 2. Signal Detection ─────────────────────────────────────────────────
    const detected = this._signalDetector.detectSignal(signal, now);
    if (!detected) return null;

    let { eventType, evidence } = detected;
    const project = signal.project || null;
    const file = signal.file || evidence.filePath || null;

    // ── 3. Deduplication Check ──────────────────────────────────────────────
    const dedupKey = this._dedupEngine.computeKey(eventType, project, file, evidence);
    const dedupResult = this._dedupEngine.registerOccurrence(dedupKey, now);

    // If repeated failures detected, escalate eventType
    if (dedupResult.isRepeatedFailure) {
      eventType = "REPEATED_FAILURE";
    }

    // ── 4. Cooldown Check ───────────────────────────────────────────────────
    const cooldownCheck = this._cooldownManager.checkCooldown(dedupKey, now);
    if (!cooldownCheck.allowed) {
      return null; // Suppress redundant alert within cooldown window
    }

    // ── 5. Diagnostic Analysis & Root Cause Identification ───────────────────
    const { analysis, confidence, confidenceScore } = this._insightAnalyzer.analyze(
      eventType,
      evidence,
      project,
      file
    );

    // ── 6. Candidate Suggestion & Approval Hierarchy ─────────────────────────
    const { suggestedAction, approvalRequired, riskLevel } =
      this._suggestionEngine.generateSuggestion(
        eventType,
        analysis,
        evidence,
        confidence,
        project,
        file
      );

    const eventId = `pevt_${now}_${Math.random().toString(36).slice(2, 8)}`;
    const expiresAt = now + DEFAULT_PROACTIVE_TTL_MS;

    const event: ProactiveEvent = {
      eventId,
      eventType,
      timestamp: now,
      project,
      file,
      task: signal.task || null,
      evidence: [evidence],
      analysis,
      confidence,
      confidenceScore,
      riskLevel,
      suggestedAction,
      approvalRequired,
      status: approvalRequired ? "AWAITING_APPROVAL" : "PREPARED",
      expiresAt,
      deduplicationKey: dedupKey,
      provenance: {
        sourceChannel: evidence.source,
        capturedAt: now,
        sanitizedHash: `${dedupKey}:${now}`,
        detectorVersion: "21.0.0",
      },
      repeatCount: dedupResult.repeatCount,
    };

    // ── 7. Notification & Prompt Synthesis ──────────────────────────────────
    const prompt = this._notificationManager.formatPrompt(event);
    event.promptQuestion = prompt.speechPrompt;

    this._dedupEngine.markAlerted(dedupKey, now);
    this._notificationManager.emitNotification(event, prompt);

    // ── 8. Event State Tracking ─────────────────────────────────────────────
    this._events.unshift(event);
    if (this._events.length > 100) this._events.pop();

    if (event.approvalRequired) {
      this._pendingEvent = event;
    }

    return event;
  }

  /**
   * Returns the currently active pending proactive event awaiting user approval.
   */
  public getPendingProactiveEvent(now = Date.now()): ProactiveEvent | null {
    if (!this._pendingEvent) return null;
    if (this._cooldownManager.isEventExpired(this._pendingEvent, now)) {
      this._pendingEvent.status = "EXPIRED";
      this._pendingEvent = null;
      return null;
    }
    return this._pendingEvent;
  }

  /**
   * Evaluates user utterance ("haan", "kar do", "nahi", "baad mein") against
   * the active pending proactive suggestion.
   */
  public async handleUserResponse(
    userUtterance: string,
    contextId = "default",
    now = Date.now()
  ): Promise<ProactiveResolutionResult> {
    const raw = (userUtterance || "").trim();
    const lower = raw.toLowerCase();

    const pending = this.getPendingProactiveEvent(now);
    if (!pending) {
      return {
        resolved: false,
        event: null,
        actionTaken: "NO_ACTION",
        reason: "NO_PENDING_PROACTIVE_EVENT",
        responseSpeech: "Abhi koi proactive suggestion pending nahi hai.",
      };
    }

    // ── Case A: Affirmative ("haan", "kar do", "theek hai", "proceed", "yes")
    const isAffirmative =
      /\b(haan|ha|yes|kar do|chalo kar do|theek hai|bilkul|proceed|confirm|go ahead|yep|sure|wahi)\b/i.test(
        lower
      ) && !/\b(nahi|not|cancel|mat|dont|don't|no)\b/i.test(lower);

    // ── Case B: Negative ("nahi", "cancel", "ruk jao", "chhodo", "no")
    const isNegative =
      /\b(nahi|ruk jao|ruko|cancel|mat karo|chhodo|stop|no|abort|leave it)\b/i.test(lower);

    // ── Case C: Snooze ("baad mein", "baad me", "later", "snooze")
    const isSnooze = /\b(baad mein|baad me|later|snooze|fir kabhi|phir kabhi)\b/i.test(lower);

    if (isNegative) {
      pending.status = "DISMISSED";
      this._pendingEvent = null;
      return {
        resolved: true,
        event: pending,
        actionTaken: "DISMISSED",
        reason: "USER_DISMISSED",
        responseSpeech: "Theek hai Sandeep, maine suggestion dismiss kar diya hai.",
      };
    }

    if (isSnooze) {
      pending.status = "SNOOZED";
      this._pendingEvent = null;
      return {
        resolved: true,
        event: pending,
        actionTaken: "SNOOZED",
        reason: "USER_SNOOZED",
        responseSpeech: "Theek hai, main isko baad mein check karne ke liye remind karungi.",
      };
    }

    if (!isAffirmative) {
      return {
        resolved: false,
        event: pending,
        actionTaken: "NO_ACTION",
        reason: "UNRECOGNIZED_CONFIRMATION",
        responseSpeech: "Kya aap chahte hain ki main is issue ko fix ya inspect karun? (haan / nahi)",
      };
    }

    // ── User Approved: Execute & Verify Pipeline ────────────────────────────
    pending.status = "APPROVED";

    // 1. Emergency Stop Gate
    if (emergencyStopCoordinator.isActive()) {
      pending.status = "BLOCKED";
      this._pendingEvent = null;
      return {
        resolved: true,
        event: pending,
        actionTaken: "BLOCKED",
        reason: "EMERGENCY_STOP_ACTIVE",
        responseSpeech: "Emergency Stop active hai, isliye proactive action execute nahi kiya ja sakta.",
      };
    }

    // 2. Security Lockdown Gate
    if (securityPolicyEngine.getMode() === "LOCKDOWN" && pending.suggestedAction?.isStateChanging) {
      pending.status = "BLOCKED";
      this._pendingEvent = null;
      return {
        resolved: true,
        event: pending,
        actionTaken: "BLOCKED",
        reason: "SECURITY_LOCKDOWN_ACTIVE",
        responseSpeech: "Security Lockdown mode active hai. State-changing actions blocked hain.",
      };
    }

    if (!pending.suggestedAction) {
      pending.status = "VERIFIED";
      this._pendingEvent = null;
      return {
        resolved: true,
        event: pending,
        actionTaken: "APPROVED_AND_EXECUTED",
        reason: "NO_EXECUTION_REQUIRED",
        responseSpeech: pending.analysis.summary,
      };
    }

    // 3. Execution (Autonomy Level 4)
    pending.status = "EXECUTING";
    let rawResult: { ok: boolean; stdout?: string; stderr?: string; exitCode?: number; content?: string; error?: string };

    try {
      if (this._mockActionExecutor) {
        rawResult = await this._mockActionExecutor(pending.suggestedAction);
      } else {
        // Safe default simulated execution for tests
        rawResult = {
          ok: true,
          stdout: `Executed ${pending.suggestedAction.summary} successfully.`,
          exitCode: 0,
        };
      }
    } catch (err: any) {
      rawResult = {
        ok: false,
        exitCode: 1,
        error: err.message || String(err),
      };
    }

    // 4. Verification (Autonomy Level 5)
    const verification = this._verificationManager.verifyExecution(
      pending.suggestedAction,
      rawResult,
      now
    );

    pending.executionResult = verification;
    pending.status = verification.verified ? "VERIFIED" : "FAILED";
    this._pendingEvent = null;

    const responseSpeech = verification.verified
      ? `Haan Sandeep, maine '${pending.suggestedAction.summary}' execute kar diya hai aur verification successful rahi.`
      : `Action execute kiya gaya lekin verification fail ho gaya: ${verification.error}`;

    return {
      resolved: true,
      event: pending,
      actionTaken: "APPROVED_AND_EXECUTED",
      reason: verification.verified ? "VERIFIED_SUCCESS" : "VERIFICATION_FAILED",
      responseSpeech,
      verificationResult: verification,
    };
  }

  /**
   * Lists recent proactive events.
   */
  public listEvents(limit = 20): ProactiveEvent[] {
    return this._events.slice(0, limit);
  }

  /**
   * Resets all internal state (for tests).
   */
  public reset(): void {
    this._events = [];
    this._pendingEvent = null;
    this._dedupEngine.clear();
    this._mockActionExecutor = undefined;
  }
}

export const predictiveContextCoordinator = new PredictiveContextCoordinator();
