/**
 * MYRAA — Phase 25: Self-Correction & Failure Recovery Engine
 * SelfCorrectionCoordinator
 *
 * Master coordinator for the entire self-correction & failure recovery lifecycle:
 *   ACTION → RESULT → FAILURE EVIDENCE → CLASSIFICATION → ROOT CAUSE →
 *   SAFE ALTERNATIVES → RISK GATE → BUDGET CHECK → EXECUTION →
 *   VERIFICATION → LEARN ONLY FROM VERIFIED CORRECTION
 *
 * Implements:
 *   - Natural cancellation handling ("Ruko", "Stop", "Cancel")
 *   - Immutable security boundary enforcement
 *   - Audit trail logging
 *   - Phase 18 memory and Phase 24 graph synchronization
 */

import crypto from "crypto";
import { failureEvidenceCollector } from "./FailureEvidenceCollector.ts";
import { failureClassifier } from "./FailureClassifier.ts";
import { failureAnalysisEngine } from "./FailureAnalysisEngine.ts";
import { safeAlternativeGenerator } from "./SafeAlternativeGenerator.ts";
import { recoveryRiskGate } from "./RecoveryRiskGate.ts";
import { recoveryAttemptManager } from "./RecoveryAttemptManager.ts";
import { recoveryVerifier } from "./RecoveryVerifier.ts";
import { correctionLearningBridge } from "./CorrectionLearningBridge.ts";
import { correctionKnowledgeBridge } from "./CorrectionKnowledgeBridge.ts";
import { emergencyStopCoordinator } from "../remote/EmergencyStopCoordinator.ts";
import { securityPolicyEngine } from "../security/SecurityPolicyEngine.ts";
import type {
  FailureEvent,
  RootCauseAnalysis,
  RecoveryCandidate,
  RecoveryResult,
  RecoveryStatus,
  RecoveryAuditEntry,
  VerificationRequirement,
  CorrectionScope,
} from "./SelfCorrectionTypes.ts";

export interface FailureHandlingResponse {
  failure: FailureEvent;
  analysis: RootCauseAnalysis;
  candidates: RecoveryCandidate[];
  recommendedCandidate?: RecoveryCandidate;
  requiresUserApproval: boolean;
  isBlockedBySecurity: boolean;
  status: "READY" | "BLOCKED" | "REQUIRES_APPROVAL" | "SECURITY_BOUNDARY_PROTECTED" | "BUDGET_EXCEEDED";
  reason?: string;
}

export class SelfCorrectionCoordinator {
  private _failures: Map<string, FailureEvent> = new Map();
  private _analyses: Map<string, RootCauseAnalysis> = new Map();
  private _candidates: Map<string, RecoveryCandidate[]> = new Map();
  private _results: Map<string, RecoveryResult> = new Map();
  private _auditTrail: RecoveryAuditEntry[] = [];
  private _isCancelled = false;
  private _cancellationReason?: string;

  /**
   * Resets all internal state, history, and budgets.
   */
  public reset(): void {
    this._failures.clear();
    this._analyses.clear();
    this._candidates.clear();
    this._results.clear();
    this._auditTrail = [];
    this._isCancelled = false;
    this._cancellationReason = undefined;
    failureAnalysisEngine.resetHistory();
    recoveryAttemptManager.reset();
    correctionLearningBridge.clear();
  }

  /**
   * Signals cancellation of ongoing recovery loops.
   */
  public cancel(reason = "User requested cancellation"): void {
    this._isCancelled = true;
    this._cancellationReason = reason;
    this._logAudit("RECOVERY_CANCELLED", { reason });
  }

  /**
   * Primary entry point for handling an operation or tool execution failure.
   */
  public handleFailure(params: {
    actionId?: string;
    taskId?: string;
    toolName?: string;
    operation: string;
    exitCode?: number;
    stdout?: string;
    stderr?: string;
    errorMessage?: string;
    targetResource?: string;
    context?: Record<string, unknown>;
  }): FailureHandlingResponse {
    // ── 0. Check Natural Cancellation Signals in error/operation ────────────
    const combinedText = `${params.operation} ${params.errorMessage || ""}`.toLowerCase();
    if (/\b(ruko|stop|cancel|halt|ruk jao)\b/i.test(combinedText)) {
      this.cancel("Detected explicit cancellation keyword");
    }

    // ── 1. Deterministic Failure Classification ─────────────────────────────
    const classification = failureClassifier.classify({
      errorMessage: params.errorMessage,
      stdout: params.stdout,
      stderr: params.stderr,
      exitCode: params.exitCode,
      operation: params.operation,
    });

    // ── 2. Collect Evidence with Secret Redaction ───────────────────────────
    const failure = failureEvidenceCollector.collectFailure({
      actionId: params.actionId,
      taskId: params.taskId,
      toolName: params.toolName,
      operation: params.operation,
      errorType: classification.errorType,
      exitCode: params.exitCode,
      stdout: params.stdout,
      stderr: params.stderr,
      errorMessage: params.errorMessage,
      targetResource: params.targetResource,
      severity: classification.severity,
      confidence: classification.confidence,
      context: params.context,
    });

    this._failures.set(failure.id, failure);
    this._logAudit("FAILURE_INGESTED", { failureId: failure.id, errorType: failure.errorType });

    // ── 3. Root Cause Analysis ──────────────────────────────────────────────
    const analysis = failureAnalysisEngine.analyze(failure);
    this._analyses.set(failure.id, analysis);

    // ── 4. Safe Alternative Generation ──────────────────────────────────────
    const rawCandidates = safeAlternativeGenerator.generateCandidates(failure, analysis);
    this._candidates.set(failure.id, rawCandidates);

    // ── 5. Security Boundary & Gate Evaluation ──────────────────────────────
    if (classification.errorType === "SECURITY_BOUNDARY_PROTECTED") {
      this._logAudit("SECURITY_BOUNDARY_ENFORCED", { failureId: failure.id });
      return {
        failure,
        analysis,
        candidates: rawCandidates,
        requiresUserApproval: false,
        isBlockedBySecurity: true,
        status: "SECURITY_BOUNDARY_PROTECTED",
        reason: "Requested operation attempts to bypass or self-modify immutable security boundaries.",
      };
    }

    if (emergencyStopCoordinator.isActive()) {
      return {
        failure,
        analysis,
        candidates: rawCandidates,
        requiresUserApproval: false,
        isBlockedBySecurity: true,
        status: "BLOCKED",
        reason: "Emergency Stop is active. Recovery operations cannot proceed.",
      };
    }

    if (securityPolicyEngine.getMode() === "LOCKDOWN") {
      return {
        failure,
        analysis,
        candidates: rawCandidates,
        requiresUserApproval: false,
        isBlockedBySecurity: true,
        status: "BLOCKED",
        reason: "Security Lockdown mode is active. State-changing recovery prohibited.",
      };
    }

    // Filter permitted candidates
    const permittedCandidates = rawCandidates.filter((cand) => {
      const gate = recoveryRiskGate.evaluate(cand);
      return gate.allowed;
    });

    const recommended = permittedCandidates[0] || rawCandidates[0];
    const requiresApproval = recommended ? recommended.requiresApproval : false;

    return {
      failure,
      analysis,
      candidates: permittedCandidates,
      recommendedCandidate: recommended,
      requiresUserApproval: requiresApproval,
      isBlockedBySecurity: permittedCandidates.length === 0,
      status: requiresApproval ? "REQUIRES_APPROVAL" : "READY",
      reason: permittedCandidates.length === 0 ? "No safe recovery candidates permitted by policy." : undefined,
    };
  }

  /**
   * Executes a selected recovery candidate and verifies the outcome.
   */
  public async executeRecovery(params: {
    failureId: string;
    strategyId: string;
    executor: () => Promise<{ exitCode?: number; stdout?: string; stderr?: string; result?: unknown }>;
    requirements?: VerificationRequirement[];
    expectedStateCheck?: () => Promise<boolean> | boolean;
    processRunningCheck?: (target: string) => boolean;
    scope?: CorrectionScope;
    verifiedValue?: unknown;
  }): Promise<RecoveryResult> {
    const recoveryId = `rec_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
    const failure = this._failures.get(params.failureId);

    // ── 0. Cancellation Check ───────────────────────────────────────────────
    if (this._isCancelled) {
      const res: RecoveryResult = {
        recoveryId,
        failureId: params.failureId,
        strategyId: params.strategyId,
        attemptNumber: 0,
        status: "CANCELLED",
        evidence: [],
        error: `Recovery cancelled: ${this._cancellationReason || "User aborted."}`,
        timestamp: Date.now(),
      };
      this._results.set(recoveryId, res);
      return res;
    }

    if (!failure) {
      throw new Error(`Failure event '${params.failureId}' not found.`);
    }

    const candidateList = this._candidates.get(params.failureId) || [];
    const candidate = candidateList.find((c) => c.strategyId === params.strategyId) || {
      strategyId: params.strategyId,
      category: "PARAMETER_ADJUSTMENT" as const,
      description: "Custom executed strategy",
      requiredActions: [],
      risk: "LOW" as const,
      confidence: 0.8,
      expectedOutcome: "Operation succeeds",
      verificationPlan: "Verify execution outcome",
      requiresApproval: false,
    };

    // ── 1. Security Risk Gate Evaluation ────────────────────────────────────
    const gateEval = recoveryRiskGate.evaluate(candidate);
    if (!gateEval.allowed) {
      const res: RecoveryResult = {
        recoveryId,
        failureId: params.failureId,
        strategyId: params.strategyId,
        attemptNumber: 0,
        status: "BLOCKED",
        evidence: [],
        error: gateEval.reason || "Recovery blocked by Security Risk Gate.",
        timestamp: Date.now(),
      };
      this._results.set(recoveryId, res);
      this._logAudit("RECOVERY_BLOCKED_BY_GATE", { failureId: failure.id, strategyId: params.strategyId });
      return res;
    }

    // ── 2. Attempt Budget & Differentiation Check ───────────────────────────
    const budgetCheck = recoveryAttemptManager.canAttempt(
      failure.actionId,
      candidate,
      failure.taskId
    );
    if (!budgetCheck.allowed) {
      const res: RecoveryResult = {
        recoveryId,
        failureId: params.failureId,
        strategyId: params.strategyId,
        attemptNumber: budgetCheck.attemptNumber,
        status: "BLOCKED",
        evidence: [],
        error: budgetCheck.reason || "Recovery budget exceeded.",
        timestamp: Date.now(),
      };
      this._results.set(recoveryId, res);
      this._logAudit("RECOVERY_BUDGET_EXCEEDED", { failureId: failure.id, strategyId: params.strategyId });
      return res;
    }

    // Record the attempt
    const attemptNumber = recoveryAttemptManager.recordAttempt(
      failure.actionId,
      candidate,
      failure.taskId
    );

    // ── 3. Execute Recovery Action ──────────────────────────────────────────
    let execResult: { exitCode?: number; stdout?: string; stderr?: string; result?: unknown };
    try {
      execResult = await params.executor();
    } catch (err: any) {
      execResult = {
        exitCode: 1,
        stderr: err?.message || "Execution exception",
      };
    }

    // ── 4. Verify Post-Recovery State ───────────────────────────────────────
    const verification = recoveryVerifier.verify({
      exitCode: execResult.exitCode,
      stdout: execResult.stdout,
      stderr: execResult.stderr,
      requirements: params.requirements,
      expectedStateCheck: params.expectedStateCheck,
      processRunningCheck: params.processRunningCheck,
    });

    let learned: any = undefined;

    // ── 5. Durable Learning (ONLY if verified SUCCESS) ──────────────────────
    if (verification.status === "SUCCESS") {
      learned = await correctionLearningBridge.learnVerifiedCorrection({
        failure,
        candidate,
        result: {
          recoveryId,
          failureId: failure.id,
          strategyId: candidate.strategyId,
          attemptNumber,
          status: "SUCCESS",
          exitCode: execResult.exitCode,
          evidence: verification.evidence,
          timestamp: Date.now(),
        },
        scope: params.scope,
        verifiedValue: params.verifiedValue || execResult.result || "VERIFIED_OK",
      });

      if (typeof params.verifiedValue === "string") {
        await correctionKnowledgeBridge.syncVerifiedCorrection({
          failure,
          candidate,
          result: {
            recoveryId,
            failureId: failure.id,
            strategyId: candidate.strategyId,
            attemptNumber,
            status: "SUCCESS",
            evidence: verification.evidence,
            timestamp: Date.now(),
          },
          verifiedPathOrValue: params.verifiedValue,
        });
      }
    }

    const finalResult: RecoveryResult = {
      recoveryId,
      failureId: failure.id,
      strategyId: candidate.strategyId,
      attemptNumber,
      status: verification.status,
      exitCode: execResult.exitCode,
      stdout: execResult.stdout,
      stderr: execResult.stderr,
      evidence: verification.evidence,
      verifiedOutcome: verification.explanation,
      learnedKnowledge: learned || undefined,
      timestamp: Date.now(),
    };

    this._results.set(recoveryId, finalResult);
    this._logAudit("RECOVERY_COMPLETED", {
      recoveryId,
      status: finalResult.status,
      attemptNumber,
    });

    return finalResult;
  }

  /**
   * Retrieves current status and statistics.
   */
  public getStatus(): {
    activeFailuresCount: number;
    activeRecoveriesCount: number;
    isCancelled: boolean;
    cancellationReason?: string;
  } {
    return {
      activeFailuresCount: this._failures.size,
      activeRecoveriesCount: this._results.size,
      isCancelled: this._isCancelled,
      cancellationReason: this._cancellationReason,
    };
  }

  /**
   * Retrieves full recovery history.
   */
  public getHistory(): {
    failures: FailureEvent[];
    results: RecoveryResult[];
    auditTrail: RecoveryAuditEntry[];
  } {
    return {
      failures: Array.from(this._failures.values()),
      results: Array.from(this._results.values()),
      auditTrail: [...this._auditTrail],
    };
  }

  /**
   * Retrieves a specific failure event.
   */
  public getFailure(id: string): FailureEvent | undefined {
    return this._failures.get(id);
  }

  /**
   * Internal audit logger.
   */
  private _logAudit(action: string, details: Record<string, unknown>): void {
    const entry: RecoveryAuditEntry = {
      auditId: `audit_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`,
      timestamp: Date.now(),
      action,
      status: "RECORDED",
      details,
    };
    this._auditTrail.push(entry);
    if (this._auditTrail.length > 500) {
      this._auditTrail.shift();
    }
  }
}

export const selfCorrectionCoordinator = new SelfCorrectionCoordinator();
