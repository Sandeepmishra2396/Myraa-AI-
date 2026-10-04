/**
 * MYRAA — Phase 25: Self-Correction & Failure Recovery Engine
 * FailureAnalysisEngine
 *
 * Performs evidence-backed Root-Cause Analysis (RCA) on failure events.
 * Distinguishes OBSERVED_FACT from INFERENCE and RECOVERY_HYPOTHESIS.
 * Detects recurring failure patterns (e.g., 3 consecutive failures on the same resource)
 * and escalates to deeper diagnosis.
 */

import type {
  FailureEvent,
  RootCauseAnalysis,
  FailureSeverity,
} from "./SelfCorrectionTypes.ts";

export class FailureAnalysisEngine {
  // In-memory record of failure signatures to detect recurring patterns
  private _failureHistory: Map<string, number> = new Map();

  /**
   * Generates a stable signature for grouping repeated failures.
   */
  public getSignature(failure: FailureEvent): string {
    const res = failure.targetResource || failure.operation;
    return `${failure.errorType}::${res}`;
  }

  /**
   * Resets the failure history.
   */
  public resetHistory(): void {
    this._failureHistory.clear();
  }

  /**
   * Analyzes a FailureEvent and formulates a structured RootCauseAnalysis.
   */
  public analyze(failure: FailureEvent): RootCauseAnalysis {
    const signature = this.getSignature(failure);
    const count = (this._failureHistory.get(signature) || 0) + 1;
    this._failureHistory.set(signature, count);

    const isRecurringPattern = count >= 3;

    // Gather observed evidence snippets
    const observedFacts = failure.evidence
      .filter((e) => e.epistemicStatus === "OBSERVED_FACT")
      .map((e) => `${e.key}: ${typeof e.value === "string" ? e.value : JSON.stringify(e.value)}`);

    let problem = `Operation '${failure.operation}' failed`;
    if (failure.targetResource) {
      problem += ` on resource '${failure.targetResource}'`;
    }

    let likelyCause = "Unknown runtime condition.";
    const alternativeCauses: string[] = [];
    let recommendedRecovery = "Inspect logs and retry manually.";
    let confidence = failure.confidence;
    let risk: FailureSeverity = failure.severity;

    switch (failure.errorType) {
      case "SECURITY_BOUNDARY_PROTECTED":
        likelyCause = "Requested operation attempts to bypass or self-modify immutable security boundaries.";
        alternativeCauses.push("Adversarial prompt injection", "Misconfigured recovery script");
        recommendedRecovery = "SECURITY_BOUNDARY_PROTECTED: Operation is blocked; security policies cannot be modified.";
        confidence = 1.0;
        risk = "CRITICAL";
        break;

      case "NOT_FOUND":
        likelyCause = `Target resource or executable is missing at configured location.`;
        alternativeCauses.push(
          "Resource not installed on the system",
          "Path exists in another directory or environment variable PATH",
          "Typo in executable name or path"
        );
        recommendedRecovery = isRecurringPattern
          ? "Repeated NOT_FOUND: Search system installation roots and prompt user for verified path."
          : "Discover actual path via PATH inspection and standard installation locations.";
        confidence = 0.95;
        break;

      case "PATH_INVALID":
        likelyCause = "Target path syntax is malformed or invalid for the current OS.";
        alternativeCauses.push("Incorrect slash directions", "Illegal characters or unescaped spaces");
        recommendedRecovery = "Normalize path formatting for Windows/POSIX filesystem.";
        confidence = 0.9;
        break;

      case "PERMISSION_DENIED":
        likelyCause = "Current execution context lacks file system or process privileges (EACCES/EPERM).";
        alternativeCauses.push(
          "File is locked by another running process",
          "Elevated administrator permissions required",
          "Read-only filesystem attribute set"
        );
        recommendedRecovery = "Check file lock status, verify file permissions, or request user elevation.";
        confidence = 0.95;
        risk = "HIGH";
        break;

      case "TIMEOUT":
        likelyCause = "Operation exceeded allotted execution time limit.";
        alternativeCauses.push(
          "Network latency or unreachable host",
          "Process hung or waiting for interactive input",
          "Deadlock in execution"
        );
        recommendedRecovery = "Retry with exponential backoff and verify external endpoint responsiveness.";
        confidence = 0.9;
        break;

      case "NETWORK_ERROR":
        likelyCause = "Remote service or local port unreachable.";
        alternativeCauses.push(
          "Target server is down or restarting",
          "Firewall or proxy blocking connection",
          "Incorrect port or hostname"
        );
        recommendedRecovery = "Verify local server is running, check connection status, and retry with backoff.";
        confidence = 0.9;
        break;

      case "BUILD_ERROR":
        likelyCause = "Code syntax error, TypeScript compilation failure, or missing type definitions.";
        alternativeCauses.push(
          "Breaking changes in recent edits",
          "Outdated compiler cache",
          "Missing package declaration"
        );
        recommendedRecovery = "Inspect error diagnostics, propose targeted syntax patch via CoderAgent.";
        confidence = 0.95;
        risk = "HIGH";
        break;

      case "TEST_FAILURE":
        likelyCause = "Test assertion mismatch between expected and actual behavior.";
        alternativeCauses.push(
          "Regression introduced by recent change",
          "Flaky or timing-dependent test",
          "Outdated test expectation"
        );
        recommendedRecovery = "Run targeted test file with diagnostic logging and analyze failure trace.";
        confidence = 0.95;
        break;

      case "DEPENDENCY_ERROR":
        likelyCause = "Required package or module is not installed in the current environment.";
        alternativeCauses.push(
          "npm install not run after package.json update",
          "Wrong workspace directory",
          "Version mismatch"
        );
        recommendedRecovery = "Verify package.json dependencies and run package installation within project scope.";
        confidence = 0.9;
        break;

      case "INVALID_ARGUMENT":
        likelyCause = "Tool or command was invoked with unexpected parameter types or flags.";
        alternativeCauses.push("Schema mismatch", "Deprecated parameter name");
        recommendedRecovery = "Adjust invocation arguments to match strict tool schema.";
        confidence = 0.85;
        break;

      default:
        likelyCause = failure.errorMessage || "Unexpected process execution failure.";
        alternativeCauses.push("Intermittent OS glitch", "Resource exhaustion");
        recommendedRecovery = "Examine recent logs and perform clean retry.";
        confidence = 0.6;
        break;
    }

    if (isRecurringPattern) {
      likelyCause += ` [RECURRING_FAILURE_PATTERN: Observed ${count} times]`;
      recommendedRecovery = `[ESCALATE] ${recommendedRecovery} (Consecutive failures: ${count}). Deep diagnosis required.`;
    }

    return {
      problem,
      observedEvidence: observedFacts,
      likelyCause,
      alternativeCauses,
      confidence,
      affectedResource: failure.targetResource,
      risk,
      recommendedRecovery,
      isRecurringPattern,
      recurrenceCount: count,
    };
  }
}

export const failureAnalysisEngine = new FailureAnalysisEngine();
