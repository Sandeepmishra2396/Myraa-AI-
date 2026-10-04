/**
 * MYRAA — Phase 22: Multi-Agent Brain
 * PlannerAgent
 *
 * Responsibilities:
 *   - Understand the goal and decompose into deterministic subtasks.
 *   - Map dependency graphs between subtasks.
 *   - Identify required capabilities and specialist agents.
 *   - Assign initial risk classifications.
 *   - INVARIANT: Planner NEVER executes actions directly!
 */

import type {
  AgentResult,
  MultiAgentExecutionPlan,
  MultiAgentSubtask,
  AgentRole,
} from "../MultiAgentTypes.ts";
import { multiAgentContextManager } from "../MultiAgentContextManager.ts";

export class PlannerAgent {
  public readonly role: AgentRole = "planner";

  /**
   * Plans the execution for a given user goal.
   */
  public async plan(
    goal: string,
    context: Record<string, unknown>,
    revisionFeedback?: string[],
    now = Date.now()
  ): Promise<AgentResult<MultiAgentExecutionPlan>> {
    const scopedContext = multiAgentContextManager.prepareScopedContext("planner", {
      ...context,
      goal,
    });

    const lower = goal.toLowerCase();
    const subtasks: MultiAgentSubtask[] = [];
    const requiredAgents: AgentRole[] = ["planner"];

    // ── 1. Decompose Goal into Subtasks ──────────────────────────────────────
    if (/\b(research|compare|documentation|find out|search)\b/i.test(lower)) {
      requiredAgents.push("researcher");
      subtasks.push({
        id: "task_research_1",
        description: `Research documentation and best practices for '${goal}'`,
        assignedAgent: "researcher",
        dependencies: [],
        status: "PENDING",
        expectedOutcome: "Sourced technical findings and recommendations",
        isStateChanging: false,
      });
    }

    if (/\b(code|build|bug|error|ts\d+|syntax|fix|improve|inspect|refactor)\b/i.test(lower)) {
      requiredAgents.push("coder");
      const coderDeps = subtasks.map((s) => s.id);
      subtasks.push({
        id: "task_code_analysis_1",
        description: `Inspect code and prepare proposed fix or diff for '${goal}'`,
        assignedAgent: "coder",
        dependencies: coderDeps,
        status: "PENDING",
        expectedOutcome: "Diagnosed root cause and proposed patch/diff",
        isStateChanging: false, // Preparation is read-only
      });
    }

    // Always include Critic if there are technical subtasks
    if (subtasks.length > 0) {
      requiredAgents.push("critic");
      const criticDeps = subtasks.map((s) => s.id);
      subtasks.push({
        id: "task_critique_1",
        description: "Critically review proposed plan, security boundaries, and specialist solutions",
        assignedAgent: "critic",
        dependencies: criticDeps,
        status: "PENDING",
        expectedOutcome: "Critic approval or structured revision request",
        isStateChanging: false,
      });
    }

    // Include Execution and Verification if task requires state changes or build fixes
    const isExecutionRequired =
      /\b(fix|apply|modify|edit|build|run|install|update|theek karo)\b/i.test(lower);

    if (isExecutionRequired) {
      requiredAgents.push("executor", "verifier");
      subtasks.push({
        id: "task_execute_1",
        description: "Execute approved actions through Security Gate and ToolExecutionFirewall",
        assignedAgent: "executor",
        dependencies: ["task_critique_1"],
        status: "PENDING",
        expectedOutcome: "Action executed with captured process output and exit code",
        isStateChanging: true,
      });

      subtasks.push({
        id: "task_verify_1",
        description: "Verify actual execution output and confirm resolution of issue",
        assignedAgent: "verifier",
        dependencies: ["task_execute_1"],
        status: "PENDING",
        expectedOutcome: "Objective evidence-based verification report",
        isStateChanging: false,
      });
    }

    // Fallback simple subtask if nothing was matched
    if (subtasks.length === 0) {
      requiredAgents.push("researcher");
      subtasks.push({
        id: "task_info_1",
        description: `Fulfill informational query: '${goal}'`,
        assignedAgent: "researcher",
        dependencies: [],
        status: "PENDING",
        expectedOutcome: "Direct conversational answer",
        isStateChanging: false,
      });
    }

    const isStateChanging = subtasks.some((s) => s.isStateChanging);
    const planId = `plan_${now}_${Math.random().toString(36).slice(2, 7)}`;

    const executionPlan: MultiAgentExecutionPlan = {
      planId,
      goal,
      subtasks,
      requiredAgents,
      revisionCount: revisionFeedback ? 1 : 0,
      isCriticApproved: false,
      requiresUserApproval: isStateChanging,
      riskLevel: isStateChanging ? "MEDIUM" : "LOW",
      explanation: revisionFeedback
        ? `Revised plan addressing critic feedback: ${revisionFeedback.join("; ")}`
        : `Generated ${subtasks.length}-step execution plan for '${goal}'`,
    };

    return {
      agentId: "planner",
      taskId: planId,
      timestamp: now,
      inputContext: scopedContext,
      objective: `Decompose '${goal}' into structured, dependency-ordered subtasks`,
      result: executionPlan,
      evidence: [
        `Identified ${subtasks.length} subtasks with ${requiredAgents.length} assigned agents.`,
        isStateChanging ? "State-changing operations flagged: user approval strictly required." : "All subtasks are read-only.",
      ],
      confidence: "HIGH",
      confidenceScore: 0.95,
      riskLevel: executionPlan.riskLevel,
      proposedActions: [],
      dependencies: [],
      status: "SUCCESS",
      provenance: {
        agent: "PlannerAgent",
        version: "22.0.0",
        timestamp: now,
      },
    };
  }
}

export const plannerAgent = new PlannerAgent();
