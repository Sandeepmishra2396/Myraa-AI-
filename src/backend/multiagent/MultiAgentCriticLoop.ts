/**
 * MYRAA — Phase 22: Multi-Agent Brain
 * MultiAgentCriticLoop
 *
 * Manages the iterative refinement loop:
 *   PLANNER ──► SPECIALISTS (Researcher/Coder) ──► CRITIC
 * Strictly enforces bounded execution to prevent infinite agent loops:
 *   - maxRevisionCycles: 3
 *   - maxAgentCalls: 15
 *   - execution timeout: 30,000ms
 *   - cancellation support
 */

import type {
  AgentResult,
  CriticEvaluation,
  MultiAgentExecutionPlan,
  SanitizedAgentTrace,
} from "./MultiAgentTypes.ts";
import {
  DEFAULT_MAX_AGENT_CALLS,
  DEFAULT_MAX_EXECUTION_TIME_MS,
  DEFAULT_MAX_REVISION_CYCLES,
} from "./MultiAgentTypes.ts";
import { plannerAgent, PlannerAgent } from "./agents/PlannerAgent.ts";
import { criticAgent, CriticAgent } from "./agents/CriticAgent.ts";
import { researcherAgent, ResearcherAgent } from "./agents/ResearcherAgent.ts";
import { coderAgent, CoderAgent } from "./agents/CoderAgent.ts";

export interface CriticLoopResult {
  plan: MultiAgentExecutionPlan;
  criticEvaluation: CriticEvaluation;
  specialistResults: Record<string, AgentResult>;
  revisionCount: number;
  totalAgentCalls: number;
  isApproved: boolean;
  status: "APPROVED" | "REJECTED" | "NEEDS_REVISION" | "TIMEOUT" | "CANCELLED";
  rejectionReason?: string;
  traces: SanitizedAgentTrace[];
}

export class MultiAgentCriticLoop {
  private _planner: PlannerAgent;
  private _critic: CriticAgent;
  private _researcher: ResearcherAgent;
  private _coder: CoderAgent;

  constructor(
    planner = plannerAgent,
    critic = criticAgent,
    researcher = researcherAgent,
    coder = coderAgent
  ) {
    this._planner = planner;
    this._critic = critic;
    this._researcher = researcher;
    this._coder = coder;
  }

  /**
   * Executes the bounded planning and critique refinement loop.
   */
  public async executeLoop(
    goal: string,
    context: Record<string, unknown> = {},
    options?: {
      maxRevisionCycles?: number;
      maxAgentCalls?: number;
      timeoutMs?: number;
      isCancelled?: () => boolean;
    }
  ): Promise<CriticLoopResult> {
    const startTime = Date.now();
    const maxRevisions = options?.maxRevisionCycles ?? DEFAULT_MAX_REVISION_CYCLES;
    const maxCalls = options?.maxAgentCalls ?? DEFAULT_MAX_AGENT_CALLS;
    const timeout = options?.timeoutMs ?? DEFAULT_MAX_EXECUTION_TIME_MS;
    const isCancelled = options?.isCancelled ?? (() => false);

    let revisionCount = 0;
    let totalAgentCalls = 0;
    let feedback: string[] | undefined;
    const traces: SanitizedAgentTrace[] = [];
    const specialistResults: Record<string, AgentResult> = {};

    let currentPlan: MultiAgentExecutionPlan | null = null;
    let lastCriticEval: CriticEvaluation | null = null;

    while (revisionCount <= maxRevisions) {
      const now = Date.now();

      // ── Cancellation & Timeout Gates ───────────────────────────────────────
      if (isCancelled()) {
        return {
          plan: currentPlan!,
          criticEvaluation: lastCriticEval!,
          specialistResults,
          revisionCount,
          totalAgentCalls,
          isApproved: false,
          status: "CANCELLED",
          rejectionReason: "Orchestration cancelled by user.",
          traces,
        };
      }

      if (now - startTime >= timeout) {
        return {
          plan: currentPlan!,
          criticEvaluation: lastCriticEval!,
          specialistResults,
          revisionCount,
          totalAgentCalls,
          isApproved: false,
          status: "TIMEOUT",
          rejectionReason: `Exceeded maximum execution timeout of ${timeout}ms.`,
          traces,
        };
      }

      if (totalAgentCalls >= maxCalls) {
        return {
          plan: currentPlan!,
          criticEvaluation: lastCriticEval!,
          specialistResults,
          revisionCount,
          totalAgentCalls,
          isApproved: false,
          status: "NEEDS_REVISION",
          rejectionReason: `Exceeded maximum agent call limit of ${maxCalls}.`,
          traces,
        };
      }

      // ── Step 1: Planner ───────────────────────────────────────────────────
      totalAgentCalls++;
      const planResult = await this._planner.plan(goal, context, feedback, now);
      currentPlan = planResult.result;
      specialistResults.planner = planResult;

      traces.push({
        traceId: `tr_plan_${now}`,
        step: traces.length + 1,
        agentId: "planner",
        action: "plan",
        status: "OK",
        sanitizedSummary: `Plan generated (${currentPlan.subtasks.length} subtasks, revision ${revisionCount})`,
        timestamp: now,
      });

      // ── Step 2: Specialists (Parallel Read-Only Execution) ─────────────────
      const specialistPromises: Promise<void>[] = [];

      if (currentPlan.requiredAgents.includes("researcher")) {
        specialistPromises.push(
          (async () => {
            totalAgentCalls++;
            const res = await this._researcher.research(goal, context);
            specialistResults.researcher = res;
            traces.push({
              traceId: `tr_res_${Date.now()}`,
              step: traces.length + 1,
              agentId: "researcher",
              action: "research",
              status: "OK",
              sanitizedSummary: `Research completed for '${res.result.topic}'`,
              timestamp: Date.now(),
            });
          })()
        );
      }

      if (currentPlan.requiredAgents.includes("coder")) {
        specialistPromises.push(
          (async () => {
            totalAgentCalls++;
            const res = await this._coder.analyzeAndProposeFix(goal, context);
            specialistResults.coder = res;
            traces.push({
              traceId: `tr_code_${Date.now()}`,
              step: traces.length + 1,
              agentId: "coder",
              action: "propose_patch",
              status: "OK",
              sanitizedSummary: `Coder proposed fix for '${res.result.targetFile}'`,
              timestamp: Date.now(),
            });
          })()
        );
      }

      await Promise.all(specialistPromises);

      // ── Step 3: Critic Challenge ──────────────────────────────────────────
      totalAgentCalls++;
      const criticResult = await this._critic.evaluate(
        currentPlan,
        specialistResults,
        context,
        Date.now()
      );
      lastCriticEval = criticResult.result;
      specialistResults.critic = criticResult;

      traces.push({
        traceId: `tr_crit_${Date.now()}`,
        step: traces.length + 1,
        agentId: "critic",
        action: "evaluate",
        status: lastCriticEval.verdict === "APPROVED" ? "OK" : "NEEDS_REVISION",
        sanitizedSummary: `Critic evaluated: ${lastCriticEval.verdict} (${lastCriticEval.critique})`,
        timestamp: Date.now(),
      });

      if (lastCriticEval.verdict === "APPROVED") {
        currentPlan.isCriticApproved = true;
        return {
          plan: currentPlan,
          criticEvaluation: lastCriticEval,
          specialistResults,
          revisionCount,
          totalAgentCalls,
          isApproved: true,
          status: "APPROVED",
          traces,
        };
      }

      if (lastCriticEval.verdict === "REJECTED") {
        return {
          plan: currentPlan,
          criticEvaluation: lastCriticEval,
          specialistResults,
          revisionCount,
          totalAgentCalls,
          isApproved: false,
          status: "REJECTED",
          rejectionReason: lastCriticEval.reasons.join("; "),
          traces,
        };
      }

      // Verdict is NEEDS_REVISION -> Prepare feedback for next iteration
      feedback = [
        ...lastCriticEval.missingSteps,
        ...lastCriticEval.securityConcerns,
        ...lastCriticEval.suggestedRevisions,
      ];
      revisionCount++;
    }

    // Exceeded maximum revision iterations
    return {
      plan: currentPlan!,
      criticEvaluation: lastCriticEval!,
      specialistResults,
      revisionCount,
      totalAgentCalls,
      isApproved: false,
      status: "NEEDS_REVISION",
      rejectionReason: `Exceeded maximum of ${maxRevisions} revision cycles without approval.`,
      traces,
    };
  }
}

export const multiAgentCriticLoop = new MultiAgentCriticLoop();
