/**
 * MYRAA — Advanced Browser Intelligence & Adaptive Knowledge System
 * WorkflowPatternDetector.ts
 *
 * Stage 6: Bounded, deterministic workflow pattern detector.
 *
 * Core Guarantees:
 *   - Requires repeated, independently evidenced successful executions (thresholds).
 *   - Requires distinct sessions (blocks loop repetition within a single session).
 *   - Deduplicates equivalent workflows.
 *   - Rejects incomplete, contradictory, stale, low-confidence, or poorly evidenced patterns.
 *   - Never invents missing steps, triggers, or evidence.
 */

import crypto from "crypto";
import { CRITICAL_TOOLS, HIGH_RISK_TOOLS } from "../../security/SecurityRiskEngine.ts";
import {
  workflowEvidenceObserver,
  WorkflowEvidenceObserver,
} from "./WorkflowEvidenceObserver.ts";
import type {
  CandidateWorkflow,
  ObservedExecutionTrace,
  SkillRiskLevel,
  SkillStepDefinition,
  WorkflowDetectionRecord,
} from "./SkillProposalTypes.ts";

export class WorkflowPatternDetector {
  private _observer: WorkflowEvidenceObserver;

  constructor(observer = workflowEvidenceObserver) {
    this._observer = observer;
  }

  /**
   * Scans recorded observations and detects eligible workflow patterns that meet
   * deterministic repetition and confidence thresholds.
   */
  public detectCandidateWorkflows(): {
    candidates: {
      workflow: CandidateWorkflow;
      detection: WorkflowDetectionRecord;
    }[];
    evaluatedSignatures: number;
    rejectedSignatures: { signature: string; reason: string }[];
  } {
    const grouped = this._observer.getGroupedObservations();
    const config = this._observer.getConfig();
    const candidates: {
      workflow: CandidateWorkflow;
      detection: WorkflowDetectionRecord;
    }[] = [];
    const rejectedSignatures: { signature: string; reason: string }[] = [];

    for (const [signature, traces] of grouped.entries()) {
      const evaluation = this._evaluateTracesForSignature(signature, traces, config);
      if (!evaluation.accepted) {
        rejectedSignatures.push({ signature, reason: evaluation.reason });
        continue;
      }

      candidates.push({
        workflow: evaluation.workflow!,
        detection: evaluation.detection!,
      });
    }

    return {
      candidates,
      evaluatedSignatures: grouped.size,
      rejectedSignatures,
    };
  }

  private _evaluateTracesForSignature(
    signature: string,
    traces: ObservedExecutionTrace[],
    config: ReturnType<WorkflowEvidenceObserver["getConfig"]>,
  ): {
    accepted: boolean;
    reason: string;
    workflow?: CandidateWorkflow;
    detection?: WorkflowDetectionRecord;
  } {
    const totalExecutions = traces.length;
    const successfulTraces = traces.filter((t) => t.overallSuccess);
    const successfulExecutions = successfulTraces.length;
    const failedExecutions = totalExecutions - successfulExecutions;
    const successRate = totalExecutions > 0 ? successfulExecutions / totalExecutions : 0;

    // Distinct sessions check
    const distinctSessionIds = Array.from(new Set(traces.map((t) => t.sessionId)));
    const successfulSessionIds = Array.from(new Set(successfulTraces.map((t) => t.sessionId)));

    // 1. Repeated success threshold
    if (successfulExecutions < config.minSuccessfulExecutions) {
      return {
        accepted: false,
        reason: `INSUFFICIENT_SUCCESSFUL_EXECUTIONS: Required at least ${config.minSuccessfulExecutions}, found ${successfulExecutions}.`,
      };
    }

    // 2. Distinct session threshold (blocks multiple loops within the same task)
    if (successfulSessionIds.length < config.minDistinctSessions) {
      return {
        accepted: false,
        reason: `INSUFFICIENT_DISTINCT_SESSIONS: Required at least ${config.minDistinctSessions} distinct sessions, found ${successfulSessionIds.length}.`,
      };
    }

    // 3. Minimum success rate threshold
    if (successRate < config.minSuccessRate) {
      return {
        accepted: false,
        reason: `CONTRADICTORY_OR_HIGH_FAILURE_RATE: Success rate ${(successRate * 100).toFixed(1)}% is below threshold ${(config.minSuccessRate * 100).toFixed(1)}%.`,
      };
    }

    // 4. Trace consistency check (all successful traces must have same step tool order)
    const referenceTrace = successfulTraces[0];
    const refToolSequence = referenceTrace.steps.map((s) => s.toolName).join("->");

    for (let i = 1; i < successfulTraces.length; i++) {
      const currentSequence = successfulTraces[i].steps.map((s) => s.toolName).join("->");
      if (currentSequence !== refToolSequence) {
        return {
          accepted: false,
          reason: `INCONSISTENT_STEP_SEQUENCE: Traces for signature ${signature} exhibit conflicting tool sequences.`,
        };
      }
    }

    // 5. Synthesize candidate workflow from evidenced steps
    const orderedSteps: SkillStepDefinition[] = [];
    const requiredTools = Array.from(new Set(referenceTrace.steps.map((s) => s.toolName)));
    let hasCriticalTool = false;
    let hasHighRiskTool = false;

    for (let i = 0; i < referenceTrace.steps.length; i++) {
      const step = referenceTrace.steps[i];
      const isCritical = CRITICAL_TOOLS.has(step.toolName);
      const isHigh = HIGH_RISK_TOOLS.has(step.toolName);

      if (isCritical) hasCriticalTool = true;
      if (isHigh) hasHighRiskTool = true;

      // Extract generalized input template from parameters
      const template = this._generalizeParameterTemplate(step.parameters);

      orderedSteps.push({
        stepIndex: i,
        toolName: step.toolName,
        inputTemplate: template,
        preconditions: [
          i === 0 ? "Initial context and prerequisites available" : `Step ${i - 1} completed with verified outcome`,
        ],
        postconditions: [`Step ${i} executed successfully with verified state`],
        timeoutMs: Math.max(step.durationMs * 3, 5000),
        requiresConfirmation: isCritical || isHigh,
        description: `Execute ${step.toolName} as step ${i + 1} of workflow`,
      });
    }

    // Risk classification
    let riskLevel: SkillRiskLevel = "LOW";
    if (hasCriticalTool) {
      riskLevel = "CRITICAL";
    } else if (hasHighRiskTool) {
      riskLevel = "HIGH";
    } else if (orderedSteps.length > 3) {
      riskLevel = "MEDIUM";
    }

    const firstObservedAt = Math.min(...traces.map((t) => t.startedAt));
    const lastObservedAt = Math.max(...traces.map((t) => t.completedAt));

    // Confidence formula: weighted combination of success rate and session diversity
    const confidenceScore = Math.min(
      1.0,
      Math.max(0.1, successRate * 0.6 + Math.min(1.0, successfulSessionIds.length / 5) * 0.4),
    );

    const name = this._formulateWorkflowName(referenceTrace);
    const triggerPatterns = this._formulateTriggerPatterns(referenceTrace);

    const workflow: CandidateWorkflow = {
      workflowSignature: signature,
      name,
      description: `Automated reusable workflow for "${referenceTrace.taskDescription}", verified across ${successfulExecutions} executions in ${successfulSessionIds.length} sessions.`,
      triggerPatterns,
      intendedOutcome: `Reliably complete: ${referenceTrace.taskDescription}`,
      orderedSteps,
      requiredTools,
      requiredPermissions: requiredTools,
      riskLevel,
      requiresConfirmation: hasCriticalTool || hasHighRiskTool,
      failureRecoveryStrategy: "Abort remaining steps on failure and notify operator.",
      regressionTestRequirements: [
        `Verify all ${orderedSteps.length} steps execute in sequence with expected mock inputs`,
        `Verify failure in step 1 halts subsequent steps immediately`,
      ],
      estimatedDurationMs: orderedSteps.reduce((acc, s) => acc + (s.timeoutMs || 5000), 0),
    };

    const detection: WorkflowDetectionRecord = {
      signature,
      observedTraceIds: traces.map((t) => t.traceId),
      distinctSessionIds,
      totalExecutions,
      successfulExecutions,
      failedExecutions,
      successRate,
      firstObservedAt,
      lastObservedAt,
      confidenceScore,
    };

    return {
      accepted: true,
      reason: "Pattern satisfies all repetition, evidence, and session criteria.",
      workflow,
      detection,
    };
  }

  private _generalizeParameterTemplate(params: Record<string, unknown>): Record<string, unknown> {
    const template: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(params)) {
      if (typeof v === "string") {
        template[k] = v.length > 50 ? `${v.slice(0, 47)}...` : v;
      } else {
        template[k] = v;
      }
    }
    return template;
  }

  private _formulateWorkflowName(trace: ObservedExecutionTrace): string {
    const cleanDesc = trace.taskDescription
      .replace(/[^a-zA-Z0-9\s_-]/g, "")
      .trim()
      .split(/\s+/)
      .slice(0, 5)
      .join("_")
      .toLowerCase();
    return cleanDesc ? `workflow_${cleanDesc}` : `workflow_${trace.steps.map((s) => s.toolName).join("_")}`;
  }

  private _formulateTriggerPatterns(trace: ObservedExecutionTrace): string[] {
    const triggers: string[] = [];
    const desc = trace.taskDescription.toLowerCase().trim();
    if (desc.length > 3) {
      triggers.push(desc);
    }
    // Also add context tags
    if (trace.contextTags && trace.contextTags.length > 0) {
      triggers.push(...trace.contextTags.slice(0, 3));
    }
    return Array.from(new Set(triggers));
  }
}

export const workflowPatternDetector = new WorkflowPatternDetector();
