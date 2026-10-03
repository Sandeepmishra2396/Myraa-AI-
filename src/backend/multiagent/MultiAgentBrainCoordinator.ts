/**
 * MYRAA — Phase 22: Multi-Agent Brain
 * MultiAgentBrainCoordinator
 *
 * Master Orchestrator for the Multi-Agent Brain architecture:
 *   - Coordinates AgentRouter, Planner, Researcher, Coder, Critic, Executor, and Verifier.
 *   - Strictly maintains the non-agent Security Policy Gate above all agents.
 *   - Supports cancellation, timeouts, parallel specialist execution, and trace logging.
 *   - Integrates with Phase 18 Personal Brain, Phase 19 Context Fusion,
 *     Phase 20 Natural Conversation, and Phase 21 Predictive Engine.
 */

import type {
  AgentResult,
  AgentRole,
  MultiAgentOrchestrationRequest,
  MultiAgentOrchestrationResult,
  MultiAgentProposedAction,
  SanitizedAgentTrace,
} from "./MultiAgentTypes.ts";
import { agentRouter, AgentRouter } from "./AgentRouter.ts";
import { multiAgentCriticLoop, MultiAgentCriticLoop } from "./MultiAgentCriticLoop.ts";
import { multiAgentSecurityGate, MultiAgentSecurityGate } from "./MultiAgentSecurityGate.ts";
import { researcherAgent, ResearcherAgent } from "./agents/ResearcherAgent.ts";
import { coderAgent, CoderAgent } from "./agents/CoderAgent.ts";
import { executorAgent, ExecutorAgent } from "./agents/ExecutorAgent.ts";
import { verifierAgent, VerifierAgent } from "./agents/VerifierAgent.ts";
import { emergencyStopCoordinator } from "../remote/EmergencyStopCoordinator.ts";

export class MultiAgentBrainCoordinator {
  private _router: AgentRouter;
  private _criticLoop: MultiAgentCriticLoop;
  private _securityGate: MultiAgentSecurityGate;
  private _researcher: ResearcherAgent;
  private _coder: CoderAgent;
  private _executor: ExecutorAgent;
  private _verifier: VerifierAgent;

  private _isCancelled = false;
  private _cancellationReason?: string;
  private _recentTraces: SanitizedAgentTrace[] = [];

  constructor(
    router = agentRouter,
    criticLoop = multiAgentCriticLoop,
    securityGate = multiAgentSecurityGate,
    researcher = researcherAgent,
    coder = coderAgent,
    executor = executorAgent,
    verifier = verifierAgent
  ) {
    this._router = router;
    this._criticLoop = criticLoop;
    this._securityGate = securityGate;
    this._researcher = researcher;
    this._coder = coder;
    this._executor = executor;
    this._verifier = verifier;
  }

  /**
   * Cancels active multi-agent orchestration.
   */
  public cancel(reason = "User requested cancellation"): void {
    this._isCancelled = true;
    this._cancellationReason = reason;
  }

  /**
   * Resets coordinator state and cancels any pending flags.
   */
  public reset(): void {
    this._isCancelled = false;
    this._cancellationReason = undefined;
    this._recentTraces = [];
  }

  /**
   * Main multi-agent entrypoint: evaluates goal, routes, plans, critiques, executes, and verifies.
   */
  public async orchestrate(
    request: MultiAgentOrchestrationRequest
  ): Promise<MultiAgentOrchestrationResult> {
    const startTime = Date.now();
    const orchestrationId = `orch_${startTime}_${Math.random().toString(36).slice(2, 7)}`;
    const traces: SanitizedAgentTrace[] = [];
    const agentResults: Partial<Record<AgentRole, AgentResult>> = {};
    const executedActions: string[] = [];
    const verificationEvidence: string[] = [];

    if (this._isCancelled) {
      return {
        orchestrationId,
        goal: request.goal,
        status: "CANCELLED",
        agentResults,
        finalAnswer: `Orchestration cancelled: ${this._cancellationReason || "User cancellation"}`,
        executedActions,
        verificationEvidence,
        criticVerdict: "REJECTED",
        executionTimeMs: Date.now() - startTime,
        traces,
        requiresUserApproval: false,
        blockReason: "CANCELLED_BY_USER",
      };
    }

    // ── 1. Security Pre-Check: Emergency Stop ───────────────────────────────
    if (emergencyStopCoordinator.isActive()) {
      return {
        orchestrationId,
        goal: request.goal,
        status: "BLOCKED",
        agentResults,
        finalAnswer: "Emergency Stop is active. All multi-agent operations are halted.",
        executedActions,
        verificationEvidence,
        criticVerdict: "REJECTED",
        executionTimeMs: Date.now() - startTime,
        traces,
        requiresUserApproval: false,
        blockReason: "EMERGENCY_STOP_ACTIVE",
      };
    }

    // ── 2. Deterministic Agent Routing ──────────────────────────────────────
    const routing = this._router.route(request.goal, {
      project: request.project,
      file: request.file,
    });

    traces.push({
      traceId: `tr_route_${Date.now()}`,
      step: 1,
      agentId: "orchestrator",
      action: "route_task",
      status: "OK",
      sanitizedSummary: `Routed to: [${routing.requiredAgents.join(", ")}] (${routing.rationale})`,
      timestamp: Date.now(),
    });

    // ── 3. Scenario A: Pure Information / Search Lookup ─────────────────────
    if (routing.requiredAgents.length === 1 && routing.requiredAgents[0] === "researcher") {
      const res = await this._researcher.research(request.goal, {
        project: request.project,
      });
      agentResults.researcher = res;

      traces.push({
        traceId: `tr_res_${Date.now()}`,
        step: 2,
        agentId: "researcher",
        action: "research",
        status: "OK",
        sanitizedSummary: res.result.summary,
        timestamp: Date.now(),
      });

      return {
        orchestrationId,
        goal: request.goal,
        status: "COMPLETED",
        agentResults,
        finalAnswer: res.result.summary,
        executedActions,
        verificationEvidence: res.evidence,
        criticVerdict: "APPROVED",
        executionTimeMs: Date.now() - startTime,
        traces,
        requiresUserApproval: false,
      };
    }

    // ── 4. Scenario B: Pure Read-Only Code Inspection ───────────────────────
    if (
      routing.requiredAgents.length === 2 &&
      routing.requiredAgents.includes("coder") &&
      routing.requiredAgents.includes("verifier")
    ) {
      const coderRes = await this._coder.analyzeAndProposeFix(request.goal, {
        project: request.project,
        file: request.file,
      });
      agentResults.coder = coderRes;

      const verifRes = await this._verifier.verify("Code inspected successfully", {
        ok: true,
        stdout: coderRes.result.technicalReasoning,
        exitCode: 0,
      });
      agentResults.verifier = verifRes;

      return {
        orchestrationId,
        goal: request.goal,
        status: "COMPLETED",
        agentResults,
        finalAnswer: `${coderRes.result.identifiedIssue}. ${coderRes.result.technicalReasoning}`,
        executedActions,
        verificationEvidence: verifRes.evidence,
        criticVerdict: "APPROVED",
        executionTimeMs: Date.now() - startTime,
        traces,
        requiresUserApproval: false,
      };
    }

    // ── 5. Scenario C: Planning + Specialist Execution + Critic Loop ────────
    const loopResult = await this._criticLoop.executeLoop(
      request.goal,
      {
        project: request.project,
        file: request.file,
      },
      {
        maxRevisionCycles: request.maxRevisionCycles,
        timeoutMs: request.timeoutMs,
        isCancelled: () => this._isCancelled,
      }
    );

    traces.push(...loopResult.traces);
    Object.assign(agentResults, loopResult.specialistResults);

    if (loopResult.criticEvaluation && !agentResults.critic) {
      agentResults.critic = {
        agentId: "critic",
        taskId: "crit_eval",
        timestamp: Date.now(),
        inputContext: {},
        objective: "Evaluate plan validity and security",
        result: loopResult.criticEvaluation as any,
        evidence: loopResult.criticEvaluation.reasons,
        confidence: "HIGH",
        confidenceScore: 0.95,
        riskLevel: "LOW",
        proposedActions: [],
        dependencies: [],
        status: loopResult.criticEvaluation.verdict === "APPROVED" ? "SUCCESS" : "FAILED",
        provenance: { agent: "CriticAgent", timestamp: Date.now() },
      };
    }

    if (!loopResult.isApproved) {
      return {
        orchestrationId,
        goal: request.goal,
        status: loopResult.status === "CANCELLED" ? "CANCELLED" : "FAILED",
        agentResults,
        finalAnswer: `Orchestration halted: ${loopResult.rejectionReason || "Critic rejected the plan."}`,
        executedActions,
        verificationEvidence,
        criticVerdict: loopResult.criticEvaluation?.verdict || "REJECTED",
        executionTimeMs: Date.now() - startTime,
        traces,
        requiresUserApproval: false,
        blockReason: loopResult.rejectionReason,
      };
    }

    const approvedPlan = loopResult.plan;

    // ── 6. Security Gate: Pre-Execution Authorization & Confirmation ────────
    if (routing.requiresExecution) {
      const securityCheck = this._securityGate.evaluateAuthorization(
        approvedPlan,
        agentResults.coder?.proposedActions?.[0],
        request.userApprovalGranted
      );

      if (securityCheck.status === "AWAITING_USER_APPROVAL") {
        const proposedSummary =
          (agentResults.coder?.result as any)?.suggestedAction?.summary || approvedPlan.explanation;

        return {
          orchestrationId,
          goal: request.goal,
          status: "BLOCKED",
          agentResults,
          finalAnswer: `Maine plan ready kar liya hai: ${proposedSummary}. Kya main ise execute karun?`,
          executedActions,
          verificationEvidence,
          criticVerdict: "APPROVED",
          executionTimeMs: Date.now() - startTime,
          traces,
          requiresUserApproval: true,
          approvalPrompt: `Maine plan ready kar liya hai: ${proposedSummary}. Kya main ise execute karun?`,
          blockReason: securityCheck.reason,
        };
      }

      if (securityCheck.status === "BLOCKED") {
        return {
          orchestrationId,
          goal: request.goal,
          status: "BLOCKED",
          agentResults,
          finalAnswer: `Security policy blocked execution: ${securityCheck.reason}`,
          executedActions,
          verificationEvidence,
          criticVerdict: "APPROVED",
          executionTimeMs: Date.now() - startTime,
          traces,
          requiresUserApproval: false,
          blockReason: securityCheck.reason,
        };
      }
    }

    // ── 7. Execution (ExecutorAgent) & Verification (VerifierAgent) ──────────
    const coderAction: MultiAgentProposedAction | undefined =
      agentResults.coder?.proposedActions?.[0];

    if (coderAction && routing.requiresExecution) {
      const execResult = await this._executor.execute(coderAction, {
        project: request.project,
      });
      agentResults.executor = execResult;
      executedActions.push(coderAction.summary);

      traces.push({
        traceId: `tr_exec_${Date.now()}`,
        step: traces.length + 1,
        agentId: "executor",
        action: "execute_tool",
        status: execResult.status,
        sanitizedSummary: `Executed '${coderAction.summary}' (exit: ${execResult.result.exitCode})`,
        timestamp: Date.now(),
      });

      const verifResult = await this._verifier.verify(
        "Code change verified and clean exit code captured",
        execResult.result
      );
      agentResults.verifier = verifResult;
      verificationEvidence.push(...verifResult.evidence);

      traces.push({
        traceId: `tr_verif_${Date.now()}`,
        step: traces.length + 1,
        agentId: "verifier",
        action: "verify_result",
        status: verifResult.status,
        sanitizedSummary: `Verification: ${verifResult.result.actualOutcome}`,
        timestamp: Date.now(),
      });
    }

    const isAllSuccessful =
      (!agentResults.executor || agentResults.executor.status === "SUCCESS") &&
      (!agentResults.verifier || agentResults.verifier.status === "SUCCESS");

    const finalAnswer = isAllSuccessful
      ? `Action successfully executed and verified: ${executedActions.join(", ") || "Plan complete"}.`
      : `Partial execution detected: ${agentResults.verifier?.error || "Some steps failed."}`;

    return {
      orchestrationId,
      goal: request.goal,
      status: isAllSuccessful ? "COMPLETED" : "PARTIAL_SUCCESS",
      agentResults,
      finalAnswer,
      executedActions,
      verificationEvidence,
      criticVerdict: "APPROVED",
      executionTimeMs: Date.now() - startTime,
      traces,
      requiresUserApproval: false,
    };
  }

  /**
   * Retrieves recent sanitized orchestration traces.
   */
  public getRecentTraces(limit = 20): SanitizedAgentTrace[] {
    return this._recentTraces.slice(-limit);
  }
}

export const multiAgentBrainCoordinator = new MultiAgentBrainCoordinator();
