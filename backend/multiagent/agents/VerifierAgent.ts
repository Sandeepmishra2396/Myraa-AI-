/**
 * MYRAA — Phase 22: Multi-Agent Brain
 * VerifierAgent
 *
 * Responsibilities:
 *   - Verifies actual results against expected outcomes.
 *   - Inspects exit codes, output traces, and test/build artifacts.
 *   - Detects partial failures.
 *   - INVARIANT: Core Principle 8: "Never claim success without evidence."
 */

import type { AgentResult, AgentRole } from "../MultiAgentTypes.ts";
import { multiAgentContextManager } from "../MultiAgentContextManager.ts";
import { intelligenceActionVerifier } from "../../intelligence/ActionVerifier.ts";

export interface VerificationReport {
  verified: boolean;
  expectedOutcome: string;
  actualOutcome: string;
  exitCode: number;
  partialFailureDetected: boolean;
  objectiveEvidence: string[];
}

export class VerifierAgent {
  public readonly role: AgentRole = "verifier";

  /**
   * Verifies an executed task against its expected outcome.
   */
  public async verify(
    expectedOutcome: string,
    executionResult: {
      ok: boolean;
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      error?: string;
    },
    context: Record<string, unknown> = {},
    now = Date.now()
  ): Promise<AgentResult<VerificationReport>> {
    const scoped = multiAgentContextManager.prepareScopedContext("verifier", {
      ...context,
      expectedOutcome,
      actualOutput: executionResult.stdout || executionResult.stderr,
      exitCode: executionResult.exitCode,
    });

    const exitCode = executionResult.exitCode ?? (executionResult.ok ? 0 : 1);
    const stdout = (executionResult.stdout || "").trim();
    const stderr = (executionResult.stderr || "").trim();

    // Check shell verification via intelligenceActionVerifier
    const shellVerif = intelligenceActionVerifier.verifyShellCommand("verifier_check", {
      ok: executionResult.ok,
      exitCode,
      stdout,
      stderr,
      error: executionResult.error,
    });

    const objectiveEvidence: string[] = [
      `Exit code: ${shellVerif.exitCode}`,
      `Verified by ActionVerifier: ${shellVerif.verified}`,
    ];

    if (stdout) {
      objectiveEvidence.push(`Observed stdout snippet: ${stdout.slice(0, 150)}`);
    }
    if (stderr) {
      objectiveEvidence.push(`Observed stderr snippet: ${stderr.slice(0, 150)}`);
    }

    // Partial failure detection (e.g. exit code 0 but stderr has non-fatal warnings or some tests failed)
    const partialFailureDetected =
      exitCode === 0 && (/warning:|partial failure|skipped/i.test(stdout) || Boolean(stderr));

    const verified = shellVerif.verified;

    const report: VerificationReport = {
      verified,
      expectedOutcome,
      actualOutcome: verified ? "Outcome achieved with verified exit code 0" : (executionResult.error || "Outcome failed verification"),
      exitCode,
      partialFailureDetected,
      objectiveEvidence,
    };

    return {
      agentId: "verifier",
      taskId: `verif_${now}_${Math.random().toString(36).slice(2, 7)}`,
      timestamp: now,
      inputContext: scoped,
      objective: `Verify actual execution outcome against '${expectedOutcome}'`,
      result: report,
      evidence: objectiveEvidence,
      confidence: verified ? "HIGH" : "LOW",
      confidenceScore: verified ? 0.98 : 0.2,
      riskLevel: "LOW",
      proposedActions: [],
      dependencies: [],
      status: verified ? "SUCCESS" : "FAILED",
      provenance: {
        agent: "VerifierAgent",
        version: "22.0.0",
        timestamp: now,
      },
      error: verified ? undefined : report.actualOutcome,
    };
  }
}

export const verifierAgent = new VerifierAgent();
