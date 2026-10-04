/**
 * MYRAA — Phase 25: Self-Correction & Failure Recovery Engine
 * SafeAlternativeGenerator
 *
 * Generates ranked, safe alternative recovery strategies for failed operations.
 * Produces structured recovery candidates with risk ratings, expected outcomes,
 * and explicit verification plans.
 * Rejects any relaxation or bypass of immutable security boundaries.
 */

import type {
  FailureEvent,
  RootCauseAnalysis,
  RecoveryCandidate,
  RecoveryStrategyCategory,
} from "./SelfCorrectionTypes.ts";

export class SafeAlternativeGenerator {
  /**
   * Generates a list of safe recovery candidates for a failure event.
   */
  public generateCandidates(
    failure: FailureEvent,
    analysis: RootCauseAnalysis
  ): RecoveryCandidate[] {
    // ── 0. Immutable Security Boundary Protection ───────────────────────────
    if (failure.errorType === "SECURITY_BOUNDARY_PROTECTED") {
      return [
        {
          strategyId: "SECURITY_BOUNDARY_ENFORCED",
          category: "USER_ESCALATION",
          description: "Maintain immutable security boundaries without alteration.",
          requiredActions: [],
          risk: "CRITICAL",
          confidence: 1.0,
          expectedOutcome: "Security policy remains intact; unsafe action blocked.",
          verificationPlan: "Verify security policy and confirmation remain untouched.",
          requiresApproval: false,
        },
      ];
    }

    const candidates: RecoveryCandidate[] = [];
    const resource = failure.targetResource || "target_resource";

    // ── 1. Executable / Resource NOT_FOUND (e.g. VS Code, Tool) ─────────────
    if (failure.errorType === "NOT_FOUND") {
      // Candidate A: Inspect system PATH and standard installation roots
      candidates.push({
        strategyId: "DISCOVER_EXECUTABLE_PATH",
        category: "PATH_DISCOVERY",
        description: `Search system PATH and standard installation directories for '${resource}'.`,
        requiredActions: [
          {
            actionId: "act_discover_path",
            toolName: "runShellCommand",
            parameters: {
              command: process.platform === "win32" ? `where ${resource}` : `which ${resource}`,
            },
            description: `Inspect PATH for '${resource}'`,
          },
        ],
        risk: "LOW",
        confidence: 0.9,
        expectedOutcome: `Locate actual executable binary path for '${resource}'.`,
        verificationPlan: `Verify discovered path exists on disk and has execute permissions.`,
        requiresApproval: false,
      });

      // Candidate B: Known standard installation paths fallback (Windows)
      if (process.platform === "win32") {
        candidates.push({
          strategyId: "SEARCH_STANDARD_WINDOWS_PATHS",
          category: "PATH_DISCOVERY",
          description: `Check standard Program Files and LocalAppData paths for '${resource}'.`,
          requiredActions: [
            {
              actionId: "act_check_standard_dirs",
              toolName: "runShellCommand",
              parameters: {
                command: `powershell -Command "Get-ChildItem -Path @('C:\\Program Files', $env:LOCALAPPDATA) -Filter '*${resource}*' -Recurse -Depth 2 -ErrorAction SilentlyContinue | Select-Object -First 3 FullName"`,
              },
              description: `Scan standard Windows application folders for '${resource}'`,
            },
          ],
          risk: "LOW",
          confidence: 0.85,
          expectedOutcome: `Identify verified installation root.`,
          verificationPlan: `Verify file existence at identified path.`,
          requiresApproval: false,
        });
      }

      // Candidate C: User escalation if discovery is exhausted
      candidates.push({
        strategyId: "PROMPT_USER_FOR_PATH",
        category: "USER_ESCALATION",
        description: `Ask user for the exact installation location of '${resource}'.`,
        requiredActions: [],
        risk: "LOW",
        confidence: 0.95,
        expectedOutcome: `User supplies the accurate executable path.`,
        verificationPlan: `Verify user-provided path exists before proceeding.`,
        requiresApproval: true,
        approvalPrompt: `Executable '${resource}' could not be found automatically. Please provide its installation directory.`,
      });
    }

    // ── 2. PATH_INVALID ──────────────────────────────────────────────────────
    else if (failure.errorType === "PATH_INVALID") {
      candidates.push({
        strategyId: "NORMALIZE_PATH_FORMAT",
        category: "PARAMETER_ADJUSTMENT",
        description: "Normalize file path separators and remove illegal characters.",
        requiredActions: [
          {
            actionId: "act_normalize_path",
            toolName: "normalizePath",
            parameters: { path: resource },
            description: "Apply standard OS path normalization.",
          },
        ],
        risk: "LOW",
        confidence: 0.9,
        expectedOutcome: "Well-formed file path matching host filesystem rules.",
        verificationPlan: "Verify normalized path syntax is accepted by filesystem.",
        requiresApproval: false,
      });
    }

    // ── 3. TIMEOUT / NETWORK_ERROR ───────────────────────────────────────────
    else if (failure.errorType === "TIMEOUT" || failure.errorType === "NETWORK_ERROR") {
      candidates.push({
        strategyId: "RETRY_WITH_EXPONENTIAL_BACKOFF",
        category: "RETRY_WITH_BACKOFF",
        description: "Retry the network operation after short backoff delay (1000ms).",
        requiredActions: [
          {
            actionId: "act_retry_backoff",
            toolName: failure.toolName || "retryOperation",
            parameters: { backoffMs: 1000 },
            description: "Retry operation with delay.",
          },
        ],
        risk: "LOW",
        confidence: 0.85,
        expectedOutcome: "Connection succeeds after transient network condition clears.",
        verificationPlan: "Verify HTTP status 200 or successful socket connection.",
        requiresApproval: false,
      });

      candidates.push({
        strategyId: "VERIFY_PORT_LISTENING",
        category: "ENVIRONMENT_CHECK",
        description: "Verify local server or target port is active and listening.",
        requiredActions: [
          {
            actionId: "act_check_port",
            toolName: "runShellCommand",
            parameters: {
              command: process.platform === "win32" ? "netstat -ano | findstr LISTENING" : "lsof -i -P -n | grep LISTEN",
            },
            description: "Check listening ports on host.",
          },
        ],
        risk: "LOW",
        confidence: 0.8,
        expectedOutcome: "Confirm whether destination service is running.",
        verificationPlan: "Verify socket status.",
        requiresApproval: false,
      });
    }

    // ── 4. BUILD_ERROR ───────────────────────────────────────────────────────
    else if (failure.errorType === "BUILD_ERROR") {
      candidates.push({
        strategyId: "DIAGNOSE_AND_PATCH_SYNTAX",
        category: "CODE_INVESTIGATION",
        description: "Analyze compiler diagnostic output and propose targeted syntax fix.",
        requiredActions: [
          {
            actionId: "act_code_diagnosis",
            toolName: "diagnoseCodeSyntax",
            parameters: { errorTrace: failure.stderr || failure.errorMessage },
            description: "Inspect compiler diagnostic trace.",
          },
        ],
        risk: "MEDIUM",
        confidence: 0.9,
        expectedOutcome: "Identified syntax fix without touching unrelated files.",
        verificationPlan: "Re-run compiler; verify 0 errors.",
        requiresApproval: true,
        approvalPrompt: "Syntax error detected. Shall I prepare a minimal patch for your review?",
      });
    }

    // ── 5. TEST_FAILURE ──────────────────────────────────────────────────────
    else if (failure.errorType === "TEST_FAILURE") {
      candidates.push({
        strategyId: "ISOLATE_FAILED_TEST_FILE",
        category: "CODE_INVESTIGATION",
        description: "Execute only the failing test file with isolated debugging output.",
        requiredActions: [
          {
            actionId: "act_run_isolated_test",
            toolName: "runShellCommand",
            parameters: { command: `npm test -- ${resource}` },
            description: `Run targeted test suite for '${resource}'`,
          },
        ],
        risk: "LOW",
        confidence: 0.9,
        expectedOutcome: "Pinpoint exact failing assertion and line number.",
        verificationPlan: "Verify targeted test run finishes and produces diagnostic trace.",
        requiresApproval: false,
      });
    }

    // ── 6. DEPENDENCY_ERROR ──────────────────────────────────────────────────
    else if (failure.errorType === "DEPENDENCY_ERROR") {
      candidates.push({
        strategyId: "INSPECT_PACKAGE_MANIFEST",
        category: "DEPENDENCY_INSPECTION",
        description: "Verify dependencies declared in package.json and node_modules.",
        requiredActions: [
          {
            actionId: "act_inspect_pkg",
            toolName: "readFile",
            parameters: { path: "package.json" },
            description: "Check declared dependencies.",
          },
        ],
        risk: "LOW",
        confidence: 0.85,
        expectedOutcome: "Determine missing or conflicting dependency version.",
        verificationPlan: "Verify package presence in package.json.",
        requiresApproval: false,
      });

      candidates.push({
        strategyId: "PROPOSE_PACKAGE_INSTALL",
        category: "DEPENDENCY_INSPECTION",
        description: `Install missing dependency '${resource}' within local project scope.`,
        requiredActions: [
          {
            actionId: "act_npm_install",
            toolName: "runShellCommand",
            parameters: { command: `npm install ${resource}` },
            description: `Install package '${resource}'`,
          },
        ],
        risk: "MEDIUM",
        confidence: 0.9,
        expectedOutcome: `Package '${resource}' installed in node_modules.`,
        verificationPlan: `Verify '${resource}' can be imported without ERR_MODULE_NOT_FOUND.`,
        requiresApproval: true,
        approvalPrompt: `Missing package '${resource}'. Would you like me to install it in this project?`,
      });
    }

    // ── 7. PERMISSION_DENIED ─────────────────────────────────────────────────
    else if (failure.errorType === "PERMISSION_DENIED") {
      candidates.push({
        strategyId: "CHECK_PROCESS_LOCKS",
        category: "ENVIRONMENT_CHECK",
        description: "Check if target file or port is locked by another running process.",
        requiredActions: [
          {
            actionId: "act_check_locks",
            toolName: "runShellCommand",
            parameters: {
              command: process.platform === "win32" ? "tasklist" : "ps aux",
            },
            description: "Inspect running processes for file locks.",
          },
        ],
        risk: "LOW",
        confidence: 0.8,
        expectedOutcome: "Identify conflicting process holding lock on resource.",
        verificationPlan: "Confirm locking process state.",
        requiresApproval: false,
      });

      candidates.push({
        strategyId: "REQUEST_USER_ELEVATION",
        category: "USER_ESCALATION",
        description: "Prompt user for elevated permission or to unlock the file.",
        requiredActions: [],
        risk: "HIGH",
        confidence: 0.95,
        expectedOutcome: "User grants necessary OS access or unlocks resource.",
        verificationPlan: "Retry file access after user confirms.",
        requiresApproval: true,
        approvalPrompt: `Permission denied accessing '${resource}'. Please unlock the resource or grant permission.`,
      });
    }

    // ── 8. Default Generic Strategy ──────────────────────────────────────────
    if (candidates.length === 0) {
      candidates.push({
        strategyId: "INSPECT_DIAGNOSTICS_AND_RETRY",
        category: "PARAMETER_ADJUSTMENT",
        description: "Inspect environment diagnostics, adjust parameters, and perform clean retry.",
        requiredActions: [],
        risk: "LOW",
        confidence: 0.6,
        expectedOutcome: "Operation succeeds under refined parameters.",
        verificationPlan: "Verify operation completed without errors.",
        requiresApproval: false,
      });
    }

    return candidates;
  }
}

export const safeAlternativeGenerator = new SafeAlternativeGenerator();
