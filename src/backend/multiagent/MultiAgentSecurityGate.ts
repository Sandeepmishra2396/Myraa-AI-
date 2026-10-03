/**
 * MYRAA — Phase 22: Multi-Agent Brain
 * MultiAgentSecurityGate
 *
 * Authoritative security gate sitting ABOVE all agents:
 *   - Security is NOT an agent.
 *   - Agents cannot self-authorize or treat another agent's approval as security clearance.
 *   - Emergency Stop halts all execution immediately.
 *   - Security Lockdown blocks any state-changing operations.
 *   - Enforces user approval requirements for state-changing plans.
 */

import type { MultiAgentExecutionPlan, MultiAgentProposedAction } from "./MultiAgentTypes.ts";
import { emergencyStopCoordinator } from "../remote/EmergencyStopCoordinator.ts";
import { securityPolicyEngine } from "../security/SecurityPolicyEngine.ts";

export interface SecurityGateCheckResult {
  authorized: boolean;
  status: "AUTHORIZED" | "BLOCKED" | "AWAITING_USER_APPROVAL";
  reason: string;
}

export class MultiAgentSecurityGate {
  /**
   * Evaluates security policy before executing an action or multi-agent plan.
   */
  public evaluateAuthorization(
    plan: MultiAgentExecutionPlan,
    action?: MultiAgentProposedAction,
    userApprovalGranted = false
  ): SecurityGateCheckResult {
    // ── 1. Emergency Stop Check ─────────────────────────────────────────────
    if (emergencyStopCoordinator.isActive()) {
      return {
        authorized: false,
        status: "BLOCKED",
        reason: "EMERGENCY_STOP_ACTIVE: All multi-agent execution is halted by emergency killswitch.",
      };
    }

    // ── 2. Security Lockdown Check ──────────────────────────────────────────
    const isStateChanging = action ? action.isStateChanging : plan.subtasks.some((s) => s.isStateChanging);
    if (securityPolicyEngine.getMode() === "LOCKDOWN" && isStateChanging) {
      return {
        authorized: false,
        status: "BLOCKED",
        reason: "SECURITY_LOCKDOWN_ACTIVE: State-changing operations are strictly blocked under Lockdown mode.",
      };
    }

    // ── 3. User Approval Requirement for State Changes ──────────────────────
    if (isStateChanging && !userApprovalGranted) {
      return {
        authorized: false,
        status: "AWAITING_USER_APPROVAL",
        reason: "USER_APPROVAL_REQUIRED: State-changing operations require explicit user approval before execution.",
      };
    }

    // ── 4. Protected Path Boundaries ────────────────────────────────────────
    if (action && action.args?.filePath) {
      const filePath = String(action.args.filePath).toLowerCase();
      if (
        filePath.includes(".env") ||
        filePath.includes(".git") ||
        filePath.includes("id_rsa") ||
        filePath.includes("windows/system32")
      ) {
        return {
          authorized: false,
          status: "BLOCKED",
          reason: `PROTECTED_PATH_VIOLATION: Direct modification of '${action.args.filePath}' is forbidden.`,
        };
      }
    }

    return {
      authorized: true,
      status: "AUTHORIZED",
      reason: "All security invariants and risk evaluations verified.",
    };
  }
}

export const multiAgentSecurityGate = new MultiAgentSecurityGate();
