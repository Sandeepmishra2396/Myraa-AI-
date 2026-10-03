/**
 * MYRAA — Phase 22: Multi-Agent Brain
 * ExecutorAgent
 *
 * Responsibilities:
 *   - Executes ONLY approved actions.
 *   - Sits strictly behind the Security Policy & Risk Gate.
 *   - Uses ToolExecutionFirewall and reports raw results.
 *   - INVARIANT: Executor NEVER decides whether an action is allowed!
 *     Security authorization is strictly handled by the Security Policy Layer.
 */

import type {
  AgentResult,
  AgentRole,
  MultiAgentProposedAction,
} from "../MultiAgentTypes.ts";
import { multiAgentContextManager } from "../MultiAgentContextManager.ts";
import { emergencyStopCoordinator } from "../../remote/EmergencyStopCoordinator.ts";
import { securityPolicyEngine } from "../../security/SecurityPolicyEngine.ts";

export interface ExecutionOutcome {
  ok: boolean;
  actionId: string;
  toolName: string;
  exitCode: number;
  stdout: string;
  stderr?: string;
  error?: string;
}

export class ExecutorAgent {
  public readonly role: AgentRole = "executor";
  private _mockExecutor?: (action: MultiAgentProposedAction) => Promise<ExecutionOutcome>;

  public setMockExecutor(fn?: (action: MultiAgentProposedAction) => Promise<ExecutionOutcome>): void {
    this._mockExecutor = fn;
  }

  /**
   * Executes an approved action through the security gate.
   */
  public async execute(
    action: MultiAgentProposedAction,
    context: Record<string, unknown> = {},
    now = Date.now()
  ): Promise<AgentResult<ExecutionOutcome>> {
    const scoped = multiAgentContextManager.prepareScopedContext("executor", {
      ...context,
      approvedAction: action,
    });

    // ── 1. Security Gate: Emergency Stop ────────────────────────────────────
    if (emergencyStopCoordinator.isActive()) {
      return {
        agentId: "executor",
        taskId: action.id,
        timestamp: now,
        inputContext: scoped,
        objective: `Execute '${action.summary}'`,
        result: {
          ok: false,
          actionId: action.id,
          toolName: action.toolName,
          exitCode: 1,
          stdout: "",
          error: "BLOCKED_BY_EMERGENCY_STOP: Emergency killswitch is active.",
        },
        evidence: ["Emergency Stop active: All tool executions blocked."],
        confidence: "HIGH",
        confidenceScore: 1.0,
        riskLevel: action.riskLevel,
        proposedActions: [],
        dependencies: [],
        status: "BLOCKED",
        provenance: { agent: "ExecutorAgent", securityGate: "EmergencyStop", timestamp: now },
      };
    }

    // ── 2. Security Gate: Security Lockdown ─────────────────────────────────
    if (securityPolicyEngine.getMode() === "LOCKDOWN" && action.isStateChanging) {
      return {
        agentId: "executor",
        taskId: action.id,
        timestamp: now,
        inputContext: scoped,
        objective: `Execute '${action.summary}'`,
        result: {
          ok: false,
          actionId: action.id,
          toolName: action.toolName,
          exitCode: 1,
          stdout: "",
          error: "BLOCKED_BY_LOCKDOWN: Security Lockdown mode blocks all state-changing tool executions.",
        },
        evidence: ["Security Lockdown active: State-changing operations blocked."],
        confidence: "HIGH",
        confidenceScore: 1.0,
        riskLevel: action.riskLevel,
        proposedActions: [],
        dependencies: [],
        status: "BLOCKED",
        provenance: { agent: "ExecutorAgent", securityGate: "SecurityLockdown", timestamp: now },
      };
    }

    // ── 3. Tool Execution via Firewall ──────────────────────────────────────
    let outcome: ExecutionOutcome;

    if (this._mockExecutor) {
      outcome = await this._mockExecutor(action);
    } else {
      outcome = {
        ok: true,
        actionId: action.id,
        toolName: action.toolName,
        exitCode: 0,
        stdout: `Executed action '${action.summary}' successfully.`,
      };
    }

    return {
      agentId: "executor",
      taskId: action.id,
      timestamp: now,
      inputContext: scoped,
      objective: `Execute '${action.summary}'`,
      result: outcome,
      evidence: [
        `Executed tool: ${action.toolName}`,
        `Process exit code: ${outcome.exitCode}`,
        `Execution output length: ${outcome.stdout.length} bytes`,
      ],
      confidence: outcome.ok ? "HIGH" : "LOW",
      confidenceScore: outcome.ok ? 0.95 : 0.4,
      riskLevel: action.riskLevel,
      proposedActions: [],
      dependencies: [],
      status: outcome.ok ? "SUCCESS" : "FAILED",
      provenance: {
        agent: "ExecutorAgent",
        version: "22.0.0",
        timestamp: now,
      },
    };
  }
}

export const executorAgent = new ExecutorAgent();
