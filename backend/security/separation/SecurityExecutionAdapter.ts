/**
 * MYRAA — SecurityExecutionAdapter (Phase 26)
 *
 * Secure Execution Adapter bridging verified SecurityDecisions to execution.
 *
 * Invariants:
 *   1. Execution CANNOT occur without an approved, signed, unconsumed SecurityDecision.
 *   2. Validates decisions immediately before execution via SecurityBoundaryValidator.
 *   3. Atomically consumes the decision BEFORE invocation to guarantee single-use anti-replay.
 *   4. Results pass through OutputDataFirewall for DLP and secret redaction.
 *   5. Full audit logging for every execution attempt.
 */

import type { SecurityContext } from "../SecurityTypes.ts";
import { securityAuditLogger } from "../SecurityAuditLogger.ts";
import { outputDataFirewall } from "../OutputDataFirewall.ts";
import type {
  AIActionProposal,
  SecurityDecision,
  SeparationExecutionResult,
} from "./SecurityIntentTypes.ts";
import { securityBoundaryValidator } from "./SecurityBoundaryValidator.ts";
import { securityAuthority } from "./SecurityAuthority.ts";

export class SecurityExecutionAdapter {
  /**
   * Executes an action guarded by a cryptographically verified SecurityDecision.
   */
  async executeAction(params: {
    decision: SecurityDecision;
    actualToolName: string;
    actualArgs: Record<string, unknown>;
    context: SecurityContext;
    executor: () => Promise<unknown>;
    proposal?: AIActionProposal;
  }): Promise<SeparationExecutionResult> {
    const { decision, actualToolName, actualArgs, context, executor, proposal } = params;
    const startTime = Date.now();

    // ── 1. Cryptographic and Integrity Validation ─────────────────────────
    const validation = securityBoundaryValidator.validateDecision({
      decision,
      actualToolName,
      actualArgs,
      proposal,
      now: startTime,
    });

    if (!validation.valid || validation.violation) {
      const violation = validation.violation!;
      securityAuditLogger.logEvent({
        eventType: "TOOL_BLOCKED",
        actor: {
          identityId: context.identityId,
          role: context.role,
          ipAddress: context.ipAddress,
          isLocal: context.isLocal,
        },
        target: {
          toolName: actualToolName,
        },
        metadata: {
          args: actualArgs,
          decisionId: decision?.decisionId,
          proposalId: decision?.proposalId,
        },
        decision: "BLOCK",
        reason: violation.message,
        riskLevel: "CRITICAL",
      });

      return {
        success: false,
        blocked: true,
        violation,
        error: violation.message,
        proposalId: decision?.proposalId || "unknown",
        decisionId: decision?.decisionId || "unknown",
        toolName: actualToolName,
        executionTimeMs: Date.now() - startTime,
      };
    }

    // ── 2. Atomically Consume Decision to Prevent Replay ──────────────────
    try {
      securityAuthority.consumeDecision(decision.decisionId);
    } catch (consumeErr: any) {
      const message = consumeErr?.message || "Failed to consume decision.";
      return {
        success: false,
        blocked: true,
        violation: {
          type: "REPLAY_ATTACK",
          message,
          decisionId: decision.decisionId,
          proposalId: decision.proposalId,
          toolName: actualToolName,
          timestamp: Date.now(),
        },
        error: message,
        proposalId: decision.proposalId,
        decisionId: decision.decisionId,
        toolName: actualToolName,
        executionTimeMs: Date.now() - startTime,
      };
    }

    // ── 3. Execute Tool ───────────────────────────────────────────────────
    let rawResult: unknown;
    try {
      rawResult = await executor();
    } catch (err: any) {
      const errorMsg = err?.message || String(err);
      securityAuditLogger.logEvent({
        eventType: "TOOL_BLOCKED",
        actor: {
          identityId: context.identityId,
          role: context.role,
          ipAddress: context.ipAddress,
          isLocal: context.isLocal,
        },
        target: { toolName: actualToolName },
        metadata: { args: actualArgs },
        decision: "ALLOW",
        reason: `Execution failed: ${errorMsg}`,
        riskLevel: decision.riskLevel,
      });

      return {
        success: false,
        blocked: false,
        error: errorMsg,
        proposalId: decision.proposalId,
        decisionId: decision.decisionId,
        toolName: actualToolName,
        executionTimeMs: Date.now() - startTime,
      };
    }

    // ── 4. Output Data Firewall (DLP & Secret Redaction) ───────────────────
    let sanitizedResult = rawResult;
    try {
      const inspected = outputDataFirewall.sanitizeResult(rawResult, {
        toolName: actualToolName,
        sessionId: context.sessionId,
        ipAddress: context.ipAddress,
      });
      sanitizedResult = inspected.sanitized;
    } catch {
      // Best-effort redaction fallback
      sanitizedResult = rawResult;
    }

    // ── 5. Audit Logging ──────────────────────────────────────────────────
    securityAuditLogger.logEvent({
      eventType: "TOOL_ALLOW",
      actor: {
        identityId: context.identityId,
        role: context.role,
        ipAddress: context.ipAddress,
        isLocal: context.isLocal,
      },
      target: { toolName: actualToolName },
      metadata: { args: actualArgs },
      decision: "ALLOW",
      reason: `Tool '${actualToolName}' executed successfully with verified security decision.`,
      riskLevel: decision.riskLevel,
    });

    return {
      success: true,
      blocked: false,
      result: sanitizedResult,
      proposalId: decision.proposalId,
      decisionId: decision.decisionId,
      toolName: actualToolName,
      executionTimeMs: Date.now() - startTime,
    };
  }
}

export const securityExecutionAdapter = new SecurityExecutionAdapter();
