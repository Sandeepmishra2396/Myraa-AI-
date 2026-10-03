/**
 * MYRAA — Phase 25: Self-Correction & Failure Recovery Engine
 * FailureClassifier
 *
 * Deterministically classifies execution failures, errors, status codes, and exceptions.
 * Identifies attempts to violate or weaken immutable security boundaries and marks
 * them strictly as SECURITY_BOUNDARY_PROTECTED.
 * Enforces distinction between OBSERVED_FACT, INFERENCE, and RECOVERY_HYPOTHESIS.
 */

import type {
  FailureErrorType,
  FailureSeverity,
  EpistemicStatus,
} from "./SelfCorrectionTypes.ts";

export interface ClassificationResult {
  errorType: FailureErrorType;
  severity: FailureSeverity;
  confidence: number;
  reason: string;
  isSecurityBoundary: boolean;
  epistemicStatus: EpistemicStatus;
}

export class FailureClassifier {
  /**
   * Deterministically classifies an error or failure signal.
   */
  public classify(params: {
    errorMessage?: string;
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    operation?: string;
  }): ClassificationResult {
    const combined = [
      params.errorMessage || "",
      params.stderr || "",
      params.stdout || "",
      params.operation || "",
    ]
      .join(" ")
      .toLowerCase();

    // ── 1. Immutable Security Boundary Protection Check ────────────────────────
    // Rejects requests to weaken, bypass, or alter security policies, confirmation, RBAC, lockdown, or killswitches
    if (
      /\b(disable|bypass|ignore|modify|override)\s+(security|permission|confirmation|rbac|lockdown|emergency\s*stop|securitypolicy\w*|firewall)\b/i.test(
        combined
      ) ||
      /\b(security_boundary_protected|policy_engine_override|disable_firewall)\b/i.test(
        combined
      )
    ) {
      return {
        errorType: "SECURITY_BOUNDARY_PROTECTED",
        severity: "CRITICAL",
        confidence: 1.0,
        reason: "Request attempts to violate or self-modify immutable security boundaries.",
        isSecurityBoundary: true,
        epistemicStatus: "OBSERVED_FACT",
      };
    }

    // ── 2. Missing Executable or File Not Found (ENOENT) ────────────────────────
    if (
      combined.includes("enoent") ||
      combined.includes("cannot find path") ||
      combined.includes("file not found") ||
      combined.includes("command not found") ||
      combined.includes("is not recognized as an internal or external command") ||
      combined.includes("no such file or directory")
    ) {
      return {
        errorType: "NOT_FOUND",
        severity: "MEDIUM",
        confidence: 0.95,
        reason: "Resource or executable was not found at the specified path (ENOENT).",
        isSecurityBoundary: false,
        epistemicStatus: "OBSERVED_FACT",
      };
    }

    // ── 3. Path Invalid / Malformed ──────────────────────────────────────────
    if (
      combined.includes("enotdir") ||
      combined.includes("invalid path") ||
      combined.includes("illegal character in path") ||
      combined.includes("path syntax error")
    ) {
      return {
        errorType: "PATH_INVALID",
        severity: "MEDIUM",
        confidence: 0.9,
        reason: "Target path is malformed or invalid.",
        isSecurityBoundary: false,
        epistemicStatus: "OBSERVED_FACT",
      };
    }

    // ── 4. Permission Denied (EACCES / EPERM) ─────────────────────────────────
    if (
      combined.includes("eacces") ||
      combined.includes("eperm") ||
      combined.includes("permission denied") ||
      combined.includes("access is denied") ||
      combined.includes("operation not permitted")
    ) {
      return {
        errorType: "PERMISSION_DENIED",
        severity: "HIGH",
        confidence: 0.95,
        reason: "OS or system returned permission denied (EACCES/EPERM).",
        isSecurityBoundary: false,
        epistemicStatus: "OBSERVED_FACT",
      };
    }

    // ── 5. Timeout (ETIMEDOUT / Timeout / Abort) ─────────────────────────────
    if (
      combined.includes("etimedout") ||
      combined.includes("timeout") ||
      combined.includes("timed out") ||
      combined.includes("esockettimedout") ||
      combined.includes("operation timed out") ||
      combined.includes("abort error")
    ) {
      return {
        errorType: "TIMEOUT",
        severity: "MEDIUM",
        confidence: 0.95,
        reason: "Operation or request timed out.",
        isSecurityBoundary: false,
        epistemicStatus: "OBSERVED_FACT",
      };
    }

    // ── 6. Network Errors (ECONNREFUSED / ENOTFOUND / HTTP 5xx / 4xx) ─────────
    if (
      combined.includes("econnrefused") ||
      combined.includes("ehostunreach") ||
      combined.includes("enetunreach") ||
      combined.includes("network error") ||
      combined.includes("fetch failed") ||
      combined.includes("http 5") ||
      combined.includes("status 5") ||
      combined.includes("502 bad gateway") ||
      combined.includes("503 service unavailable") ||
      combined.includes("504 gateway timeout")
    ) {
      return {
        errorType: "NETWORK_ERROR",
        severity: "MEDIUM",
        confidence: 0.9,
        reason: "Network connectivity or remote server communication failure.",
        isSecurityBoundary: false,
        epistemicStatus: "OBSERVED_FACT",
      };
    }

    // ── 7. Build & Compilation Errors (TSxxxx / SyntaxError / Babel) ─────────
    if (
      /ts\d{4}/i.test(combined) ||
      combined.includes("syntaxerror") ||
      combined.includes("compilation error") ||
      combined.includes("build failed") ||
      combined.includes("transform failed") ||
      combined.includes("failed to compile")
    ) {
      return {
        errorType: "BUILD_ERROR",
        severity: "HIGH",
        confidence: 0.95,
        reason: "TypeScript, compiler, or build syntax error detected.",
        isSecurityBoundary: false,
        epistemicStatus: "OBSERVED_FACT",
      };
    }

    // ── 8. Test Failures ─────────────────────────────────────────────────────
    if (
      combined.includes("assertionerror") ||
      combined.includes("tests failed") ||
      combined.includes("failed tests") ||
      combined.includes("vitest failed") ||
      combined.includes("jest failed") ||
      combined.includes("expect(") ||
      (params.operation && /test/i.test(params.operation) && params.exitCode !== 0)
    ) {
      return {
        errorType: "TEST_FAILURE",
        severity: "MEDIUM",
        confidence: 0.95,
        reason: "Automated test assertions failed during execution.",
        isSecurityBoundary: false,
        epistemicStatus: "OBSERVED_FACT",
      };
    }

    // ── 9. Dependency & Package Errors ───────────────────────────────────────
    if (
      combined.includes("cannot find module") ||
      combined.includes("module not found") ||
      combined.includes("err_module_not_found") ||
      combined.includes("package not found") ||
      combined.includes("unresolved dependency")
    ) {
      return {
        errorType: "DEPENDENCY_ERROR",
        severity: "MEDIUM",
        confidence: 0.9,
        reason: "External dependency or package import is missing.",
        isSecurityBoundary: false,
        epistemicStatus: "OBSERVED_FACT",
      };
    }

    // ── 10. Invalid Argument ─────────────────────────────────────────────────
    if (
      combined.includes("invalid argument") ||
      combined.includes("unknown option") ||
      combined.includes("unrecognized flag") ||
      combined.includes("missing required option") ||
      combined.includes("typeerror: expected")
    ) {
      return {
        errorType: "INVALID_ARGUMENT",
        severity: "LOW",
        confidence: 0.9,
        reason: "Operation provided invalid arguments or missing flags.",
        isSecurityBoundary: false,
        epistemicStatus: "OBSERVED_FACT",
      };
    }

    // ── 11. Specific Runtime Error (TypeError, ReferenceError, Unhandled Exception) ──
    if (
      combined.includes("typeerror") ||
      combined.includes("referenceerror") ||
      combined.includes("rangeerror") ||
      combined.includes("uncaught exception") ||
      combined.includes("unhandled rejection") ||
      combined.includes("nullpointerexception")
    ) {
      return {
        errorType: "RUNTIME_ERROR",
        severity: "MEDIUM",
        confidence: 0.9,
        reason: "Runtime error or unhandled exception encountered.",
        isSecurityBoundary: false,
        epistemicStatus: "OBSERVED_FACT",
      };
    }

    // ── 12. Process Exit ─────────────────────────────────────────────────────
    if (typeof params.exitCode === "number" && params.exitCode !== 0) {
      return {
        errorType: "PROCESS_EXIT",
        severity: "MEDIUM",
        confidence: 0.85,
        reason: `Process exited with non-zero exit code ${params.exitCode}.`,
        isSecurityBoundary: false,
        epistemicStatus: "OBSERVED_FACT",
      };
    }

    // ── 13. Generic Runtime Error ────────────────────────────────────────────
    if (combined.includes("error") || combined.includes("exception") || combined.includes("failed")) {
      return {
        errorType: "RUNTIME_ERROR",
        severity: "MEDIUM",
        confidence: 0.7,
        reason: "Runtime error or unhandled exception encountered.",
        isSecurityBoundary: false,
        epistemicStatus: "OBSERVED_FACT",
      };
    }

    // ── 13. Default Unknown ──────────────────────────────────────────────────
    return {
      errorType: "UNKNOWN",
      severity: "LOW",
      confidence: 0.3,
      reason: "Could not determine exact failure cause from available telemetry.",
      isSecurityBoundary: false,
      epistemicStatus: "OBSERVED_FACT",
    };
  }
}

export const failureClassifier = new FailureClassifier();
