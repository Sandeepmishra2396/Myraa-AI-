/**
 * MYRAA — Phase 22: Multi-Agent Brain
 * AgentRouter
 *
 * Deterministically routes tasks to only the necessary specialist agents.
 * Strictly avoids invoking unnecessary agents for simple queries.
 */

import type { AgentRole } from "./MultiAgentTypes.ts";

export interface RoutingDecision {
  requiredAgents: AgentRole[];
  complexity: "SIMPLE" | "MODERATE" | "COMPLEX";
  requiresPlanning: boolean;
  requiresCritic: boolean;
  requiresExecution: boolean;
  rationale: string;
}

export class AgentRouter {
  /**
   * Evaluates a user goal or prompt and routes to the appropriate specialist agents.
   */
  public route(goal: string, context?: Record<string, unknown>): RoutingDecision {
    const raw = (goal || "").trim();
    const lower = raw.toLowerCase();

    // ── 1. Pure Information / Search Queries ("Weather batao", "Explain React hooks")
    const isInfoOnly =
      /\b(batao|kya hai|weather|search|explain concept|what is|how to|docs|meaning of)\b/i.test(lower) &&
      !/\b(fix|modify|edit|build|run|create|install|delete|remove|patch|research|suggest|recommend|guide|improve)\b/i.test(lower);

    if (isInfoOnly && !/\b(code|file|function|class|method)\b/i.test(lower)) {
      return {
        requiredAgents: ["researcher"],
        complexity: "SIMPLE",
        requiresPlanning: false,
        requiresCritic: false,
        requiresExecution: false,
        rationale: "Informational lookup: Researcher alone is sufficient.",
      };
    }

    // ── 2. Pure Code Inspection / Explanation ("main.py explain karo", "review this function")
    const isCodeReadonly =
      /\b(explain|read|review|inspect|kya karta hai)\b/i.test(lower) &&
      /\b(code|file|\.ts|\.js|\.py|\.json|function|class|script)\b/i.test(lower) &&
      !/\b(fix|modify|change|edit|update|refactor|build|run|apply)\b/i.test(lower);

    if (isCodeReadonly) {
      return {
        requiredAgents: ["coder", "verifier"],
        complexity: "SIMPLE",
        requiresPlanning: false,
        requiresCritic: false,
        requiresExecution: false,
        rationale: "Read-only code inspection: Coder analyzes and Verifier confirms read correctness.",
      };
    }

    // ── 3. Research & Technical Advice ("Research karke batao authentication improve kaise karein")
    const isResearchAdvisory =
      /\b(research|suggest|recommend|guide|best practices)\b/i.test(lower) &&
      !/\b(apply|modify|edit|fix|run|improve karo|architecture improve|project architecture|refactor|overhaul|build)\b/i.test(lower);

    if (isResearchAdvisory) {
      return {
        requiredAgents: ["planner", "researcher", "critic"],
        complexity: "MODERATE",
        requiresPlanning: true,
        requiresCritic: true,
        requiresExecution: false,
        rationale: "Research advisory: Planner breaks down topic, Researcher gathers info, Critic checks validity.",
      };
    }

    // ── 4. Code / Build Fix ("Build error fix karo", "TS error fix karo", "test fail ho raha hai fix karo")
    const isCodeFix =
      /\b(fix|bug|error|repair|resolve|theek karo)\b/i.test(lower) ||
      /\b(build fail|compile error|type error|test fail)\b/i.test(lower);

    if (isCodeFix) {
      return {
        requiredAgents: ["planner", "coder", "critic", "executor", "verifier"],
        complexity: "MODERATE",
        requiresPlanning: true,
        requiresCritic: true,
        requiresExecution: true,
        rationale: "Code / Build Fix: Requires Planner, Coder proposal, Critic challenge, Executor, and Verifier.",
      };
    }

    // ── 5. Full Architecture / Refactoring / Multi-Disciplinary Workflow
    return {
      requiredAgents: ["planner", "researcher", "coder", "critic", "executor", "verifier"],
      complexity: "COMPLEX",
      requiresPlanning: true,
      requiresCritic: true,
      requiresExecution: true,
      rationale: "Complex multi-step engineering: Full multi-agent brain coordination.",
    };
  }
}

export const agentRouter = new AgentRouter();
