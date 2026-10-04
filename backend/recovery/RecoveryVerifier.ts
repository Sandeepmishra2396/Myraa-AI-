/**
 * MYRAA — Phase 25: Self-Correction & Failure Recovery Engine
 * RecoveryVerifier
 *
 * Enforces Core Principle 8: "Never claim success without evidence."
 * Verifies actual post-recovery state rather than blindly trusting exit codes.
 * Distinguishes SUCCESS, PARTIAL_SUCCESS, FAILED, BLOCKED, CANCELLED, and UNVERIFIED.
 */

import * as fs from "fs";
import type {
  RecoveryStatus,
  VerificationEvidence,
  VerificationRequirement,
} from "./SelfCorrectionTypes.ts";

export interface VerificationEvaluation {
  status: RecoveryStatus;
  verified: boolean;
  evidence: VerificationEvidence[];
  explanation: string;
}

export class RecoveryVerifier {
  /**
   * Verifies an operation outcome against explicit verification requirements.
   */
  public verify(params: {
    exitCode?: number;
    stdout?: string;
    stderr?: string;
    requirements?: VerificationRequirement[];
    expectedStateCheck?: () => Promise<boolean> | boolean;
    processRunningCheck?: (target: string) => boolean;
  }): VerificationEvaluation {
    const evidenceList: VerificationEvidence[] = [];
    const exitCode = params.exitCode;
    const requirements = params.requirements || [];

    // ── 1. Check Exit Code ──────────────────────────────────────────────────
    const exitCodeOk = typeof exitCode === "number" ? exitCode === 0 : true;
    evidenceList.push({
      verified: exitCodeOk,
      checkType: "EXIT_CODE",
      observedValue: exitCode ?? "N/A",
      expectedValue: 0,
      timestamp: Date.now(),
      failureReason: exitCodeOk ? undefined : `Non-zero exit code: ${exitCode}`,
    });

    // If exit code itself failed, status is FAILED
    if (!exitCodeOk) {
      return {
        status: "FAILED",
        verified: false,
        evidence: evidenceList,
        explanation: `Execution failed with exit code ${exitCode}.`,
      };
    }

    // ── 2. Check Specific Requirements (Process, File, State) ───────────────
    let allRequirementsMet = true;
    let anyRequirementMet = false;

    for (const req of requirements) {
      if (req.type === "FILE_EXISTS") {
        const fileExists = fs.existsSync(req.target);
        evidenceList.push({
          verified: fileExists,
          checkType: "FILE_EXISTS",
          observedValue: fileExists,
          expectedValue: true,
          evidenceSnippet: req.target,
          timestamp: Date.now(),
          failureReason: fileExists ? undefined : `File does not exist: ${req.target}`,
        });
        if (fileExists) anyRequirementMet = true;
        else allRequirementsMet = false;
      } else if (req.type === "PROCESS_RUNNING") {
        const running = params.processRunningCheck ? params.processRunningCheck(req.target) : false;
        evidenceList.push({
          verified: running,
          checkType: "PROCESS_RUNNING",
          observedValue: running,
          expectedValue: true,
          evidenceSnippet: req.target,
          timestamp: Date.now(),
          failureReason: running ? undefined : `Expected process '${req.target}' is not running.`,
        });
        if (running) anyRequirementMet = true;
        else allRequirementsMet = false;
      } else if (req.type === "TEST_PASSED") {
        const passed = !(params.stderr || "").includes("FAIL") && !(params.stdout || "").includes("FAIL");
        evidenceList.push({
          verified: passed,
          checkType: "TEST_PASSED",
          observedValue: passed,
          expectedValue: true,
          timestamp: Date.now(),
          failureReason: passed ? undefined : "Test output indicates assertion failure.",
        });
        if (passed) anyRequirementMet = true;
        else allRequirementsMet = false;
      }
    }

    // Custom state check if provided
    if (params.expectedStateCheck) {
      const statePassed = Boolean(params.expectedStateCheck());
      evidenceList.push({
        verified: statePassed,
        checkType: "CUSTOM_STATE_CHECK",
        observedValue: statePassed,
        expectedValue: true,
        timestamp: Date.now(),
        failureReason: statePassed ? undefined : "Custom post-condition verification check failed.",
      });
      if (statePassed) anyRequirementMet = true;
      else allRequirementsMet = false;
    }

    // ── 3. Evaluate Verification Status ──────────────────────────────────────
    // If no explicit state checks were defined, exitCode 0 is UNVERIFIED (never blindly SUCCESS)
    if (requirements.length === 0 && !params.expectedStateCheck) {
      return {
        status: "UNVERIFIED",
        verified: false,
        evidence: evidenceList,
        explanation: "Command completed with exit code 0, but no post-state verification requirements were provided.",
      };
    }

    if (allRequirementsMet) {
      return {
        status: "SUCCESS",
        verified: true,
        evidence: evidenceList,
        explanation: "All post-recovery verification requirements verified successfully with evidence.",
      };
    }

    if (anyRequirementMet) {
      return {
        status: "PARTIAL_SUCCESS",
        verified: false,
        evidence: evidenceList,
        explanation: "Some verification requirements passed, but one or more expected conditions failed.",
      };
    }

    return {
      status: "FAILED",
      verified: false,
      evidence: evidenceList,
      explanation: "All post-recovery state verification requirements failed.",
    };
  }
}

export const recoveryVerifier = new RecoveryVerifier();
