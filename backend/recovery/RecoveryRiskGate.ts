/**
 * MYRAA — Phase 25: Self-Correction & Failure Recovery Engine
 * RecoveryRiskGate
 *
 * Absolute security and safety policy gate for all recovery proposals.
 * Enforces:
 *   - Immutability of Security Policies, Firewall, RBAC, Confirmation, and Killswitches
 *   - Emergency Stop halting (cannot be bypassed)
 *   - Security Lockdown restrictions (no state-altering recovery during lockdown)
 *   - Rejection of adversarial attempts to relax or disable safety thresholds
 *   - Strict Autonomy Level adherence (a failed action does NOT grant higher autonomy)
 */

import { emergencyStopCoordinator } from "../remote/EmergencyStopCoordinator.ts";
import { securityPolicyEngine } from "../security/SecurityPolicyEngine.ts";
import type {
  RecoveryCandidate,
  FailureSeverity,
} from "./SelfCorrectionTypes.ts";

export interface RiskGateEvaluation {
  allowed: boolean;
  status: "ALLOWED" | "BLOCKED" | "REQUIRES_CONFIRMATION" | "SECURITY_BOUNDARY_PROTECTED";
  reason?: string;
  autonomyLevel: number; // 0 to 5
  requiresUserToken: boolean;
}

export class RecoveryRiskGate {
  private _defaultAutonomyLevel = 4; // Level 4: Execute permitted recovery

  /**
   * Evaluates whether a proposed recovery strategy is permitted by security policies.
   */
  public evaluate(
    candidate: RecoveryCandidate,
    currentAutonomy = this._defaultAutonomyLevel
  ): RiskGateEvaluation {
    // ── 1. Emergency Stop Check (Absolute Highest Priority) ─────────────────
    if (emergencyStopCoordinator.isActive()) {
      return {
        allowed: false,
        status: "BLOCKED",
        reason: "[EmergencyStop] Recovery blocked: System Emergency Stop is currently active.",
        autonomyLevel: currentAutonomy,
        requiresUserToken: false,
      };
    }

    // ── 2. Security Policy Lockdown Check ────────────────────────────────────
    if (securityPolicyEngine.getMode() === "LOCKDOWN") {
      // During lockdown, state-changing actions are strictly prohibited
      const hasMutations = candidate.requiredActions.length > 0;
      if (hasMutations) {
        return {
          allowed: false,
          status: "BLOCKED",
          reason: "[SecurityLockdown] State-changing recovery blocked in LOCKDOWN mode.",
          autonomyLevel: currentAutonomy,
          requiresUserToken: false,
        };
      }
    }

    // ── 3. Immutable Security Boundary Protection ───────────────────────────
    // Rejects any strategy or action attempting to modify security, bypass confirmation, or alter RBAC
    const candidateText = [
      candidate.strategyId,
      candidate.description,
      ...candidate.requiredActions.map((a) => `${a.toolName} ${JSON.stringify(a.parameters)}`),
    ]
      .join(" ")
      .toLowerCase();

    if (
      /\b(disable security|bypass permission|ignore confirmation|bypass rbac|disable lockdown|ignore emergency stop|modify securitypolicy|override security policy|bypass firewall)\b/i.test(
        candidateText
      ) ||
      candidate.strategyId === "SECURITY_BOUNDARY_ENFORCED"
    ) {
      return {
        allowed: false,
        status: "SECURITY_BOUNDARY_PROTECTED",
        reason: "Self-correction cannot modify or bypass immutable security boundaries.",
        autonomyLevel: currentAutonomy,
        requiresUserToken: false,
      };
    }

    // ── 4. Autonomy Level Boundaries ─────────────────────────────────────────
    // Level 0: Observe only
    if (currentAutonomy === 0) {
      return {
        allowed: false,
        status: "BLOCKED",
        reason: "Autonomy Level 0 (Observe Only): Autonomous recovery execution is disabled.",
        autonomyLevel: 0,
        requiresUserToken: false,
      };
    }

    // Level 1: Notify only
    if (currentAutonomy === 1) {
      return {
        allowed: false,
        status: "BLOCKED",
        reason: "Autonomy Level 1 (Notify Only): Recovery proposals require manual intervention.",
        autonomyLevel: 1,
        requiresUserToken: false,
      };
    }

    // Level 2 & 3: Require explicit user confirmation
    if (currentAutonomy <= 3 || candidate.requiresApproval || candidate.risk === "HIGH" || candidate.risk === "CRITICAL") {
      return {
        allowed: true,
        status: "REQUIRES_CONFIRMATION",
        reason: candidate.approvalPrompt || "Recovery action requires user confirmation.",
        autonomyLevel: currentAutonomy,
        requiresUserToken: true,
      };
    }

    // ── 5. Permitted Execution ───────────────────────────────────────────────
    return {
      allowed: true,
      status: "ALLOWED",
      reason: "Recovery proposal passed security risk evaluation.",
      autonomyLevel: currentAutonomy,
      requiresUserToken: false,
    };
  }
}

export const recoveryRiskGate = new RecoveryRiskGate();
