/**
 * MYRAA — Phase 21: Predictive / Proactive Engine
 * ProactiveVerificationManager
 *
 * Verifies the actual outcome of executed proactive actions (Autonomy Level 5).
 * Strictly enforces Core Principle 8: "Never claim success without evidence."
 */

import type {
  ProactiveEvent,
  ProactiveExecutionResult,
  ProactiveSuggestedAction,
} from "./ProactiveTypes.ts";
import { intelligenceActionVerifier } from "../intelligence/ActionVerifier.ts";

export class ProactiveVerificationManager {
  /**
   * Evaluates the raw outcome of a proactive action execution and produces
   * a verified result with objective evidence.
   */
  public verifyExecution(
    action: ProactiveSuggestedAction,
    rawResult: {
      ok: boolean;
      exitCode?: number;
      stdout?: string;
      stderr?: string;
      content?: string;
      error?: string;
    },
    now = Date.now()
  ): ProactiveExecutionResult {
    // ── 1. Shell Command / Build / Test Verifications ─────────────────────────
    if (action.toolName === "runShellCommand" || action.capability === "project.build") {
      const shellVerification = intelligenceActionVerifier.verifyShellCommand(
        (action.args?.command as string) || "command",
        rawResult
      );

      return {
        success: shellVerification.verified,
        verified: shellVerification.verified,
        output: shellVerification.stdoutSnippet,
        error: shellVerification.failureReason,
        verificationEvidence: `Process exit code: ${shellVerification.exitCode}`,
        timestamp: now,
      };
    }

    // ── 2. File / Code Inspection Verifications ──────────────────────────────
    if (action.toolName === "readFile" || action.capability.startsWith("code.")) {
      const hasContent = Boolean(rawResult.content || rawResult.stdout);
      const isOk = rawResult.ok && hasContent;

      return {
        success: isOk,
        verified: isOk,
        output: (rawResult.content || rawResult.stdout || "").slice(0, 500),
        error: isOk ? undefined : rawResult.error || "File could not be read or was empty",
        verificationEvidence: isOk
          ? `File content verified (${(rawResult.content || rawResult.stdout || "").length} bytes read)`
          : "File read failed",
        timestamp: now,
      };
    }

    // ── 3. General Capability Verification ───────────────────────────────────
    const success = Boolean(rawResult.ok);
    return {
      success,
      verified: success,
      output: (rawResult.stdout || rawResult.content || "").slice(0, 500),
      error: success ? undefined : rawResult.error || "Action execution reported non-ok status",
      verificationEvidence: success ? "Operation completed with ok: true" : "Operation failed",
      timestamp: now,
    };
  }
}

export const proactiveVerificationManager = new ProactiveVerificationManager();
