/**
 * MYRAA — ToolExecutionFirewall (Phase 10A)
 *
 * Enforces the mandatory security pipeline between MYRAA AI and all 126 tools:
 *
 *   AI/User Request
 *          │
 *          ▼
 *    Policy Engine
 *          │
 *          ▼
 *    Risk Analysis (LOW / MEDIUM / HIGH / CRITICAL)
 *          │
 *          ▼
 *   Permission Check (Role-based access)
 *          │
 *          ▼
 *  Argument Validation (Path boundaries, SSRF, dangerous shell tokens)
 *          │
 *          ▼
 *   [Confirmation Gate] (HIGH/CRITICAL requires cryptographic token)
 *          │
 *          ▼
 *    Tool Execution
 *          │
 *          ▼
 *  Result Validation (DLP & Secret Redaction)
 *          │
 *          ▼
 *     Audit Record
 */

import type { SecurityContext, PolicyDecision } from "./SecurityTypes.ts";
import { securityPolicyEngine } from "./SecurityPolicyEngine.ts";
import { outputDataFirewall } from "./OutputDataFirewall.ts";
import { securityAuditLogger } from "./SecurityAuditLogger.ts";
import { contentSanitizer } from "./ContentSanitizer.ts";

export interface GuardedExecutionResult {
  ok: boolean;
  result?: unknown;
  error?: string;
  decision: PolicyDecision;
  blocked?: boolean;
  requiresConfirmation?: boolean;
  confirmationToken?: string;
}

export class ToolExecutionFirewall {
  /**
   * Execute a tool through the deterministic security pipeline.
   */
  async executeGuardedTool(
    toolName: string,
    args: Record<string, unknown>,
    context: SecurityContext,
    executor: () => Promise<unknown>,
    confirmationToken?: string,
  ): Promise<GuardedExecutionResult> {
    // ── 1. Policy Engine Evaluation (Risk, Role Permission, Argument Validation) ──
    const decision = await securityPolicyEngine.evaluateRequest(
      toolName,
      args,
      context,
      confirmationToken,
    );

    // If decision is NOT allowed (BLOCK or REQUIRE_CONFIRMATION), halt immediately!
    if (!decision.allowed) {
      if (decision.decision === "REQUIRE_CONFIRMATION" || decision.decision === "CONFIRMATION_REQUIRED") {
        return {
          ok: false,
          error: decision.reason,
          decision,
          blocked: true,
          requiresConfirmation: true,
          confirmationToken: decision.confirmationToken,
        };
      }

      return {
        ok: false,
        error: decision.reason,
        decision,
        blocked: true,
        requiresConfirmation: false,
      };
    }

    // ── 2. Tool Execution ────────────────────────────────────────────────
    let rawResult: unknown;
    try {
      rawResult = await executor();
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      securityAuditLogger.logEvent({
        eventType: "ARGUMENT_VIOLATION",
        actor: {
          identityId: context.identityId,
          role: context.role,
          ipAddress: context.ipAddress,
          sessionId: context.sessionId,
        },
        target: { toolName },
        decision: "BLOCK",
        reason: `Tool execution failed with error: ${errMsg}`,
        riskLevel: decision.risk.level,
      });

      return {
        ok: false,
        error: errMsg,
        decision,
      };
    }

    // ── 3. Result Validation & DLP ───────────────────────────────────────
    const { sanitized } = outputDataFirewall.sanitizeResult(rawResult, {
      toolName,
      sessionId: context.sessionId,
      ipAddress: context.ipAddress,
    });

    // ── 4. Prompt Injection Scan & Defanging ────────────────────────────
    let finalResult = sanitized;
    if (typeof sanitized === "string") {
      const scan = contentSanitizer.scanForPromptInjection(sanitized, {
        source: "tool_result",
        identifier: toolName,
      });
      finalResult = scan.sanitizedText;
    }

    return {
      ok: true,
      result: finalResult,
      decision,
    };
  }
}

export const toolExecutionFirewall = new ToolExecutionFirewall();
