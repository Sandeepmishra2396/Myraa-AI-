/**
 * MYRAA — Phase 21: Predictive / Proactive Engine
 * ProactiveSuggestionEngine
 *
 * Formulates non-destructive suggestions, patch proposals, and execution actions
 * according to the strict 6-tier Autonomy Level hierarchy:
 *   Level 0: Observe only
 *   Level 1: Analyze and notify
 *   Level 2: Prepare proposed action
 *   Level 3: Ask for approval (Mandatory for any state-changing action)
 *   Level 4: Execute approved action
 *   Level 5: Verify result
 */

import type {
  ProactiveAnalysis,
  ProactiveConfidence,
  ProactiveEventType,
  ProactiveEvidence,
  ProactiveSuggestedAction,
} from "./ProactiveTypes.ts";
import type { RiskLevel } from "../security/SecurityTypes.ts";

export class ProactiveSuggestionEngine {
  /**
   * Generates a candidate proactive action based on the diagnosed issue.
   * Enforces that state-changing operations ALWAYS require approval (Level 3+).
   */
  public generateSuggestion(
    eventType: ProactiveEventType,
    analysis: ProactiveAnalysis,
    evidence: ProactiveEvidence,
    confidence: ProactiveConfidence,
    project: string | null = null,
    file: string | null = null
  ): {
    suggestedAction: ProactiveSuggestedAction | null;
    approvalRequired: boolean;
    riskLevel: RiskLevel;
  } {
    // ── INVARIANT: LOW confidence NEVER triggers autonomous actions ──────────
    if (confidence === "LOW") {
      return {
        suggestedAction: null,
        approvalRequired: false,
        riskLevel: "LOW",
      };
    }

    const targetFile = evidence.filePath || file || "workspace";

    switch (eventType) {
      case "TYPE_ERROR": {
        // Read-only inspection is Level 2 (safe)
        // Code change / patch proposal is Level 3 (requires user approval)
        return {
          suggestedAction: {
            id: `act_proactive_fix_ts_${Date.now()}`,
            capability: "code.inspectAndFix",
            toolName: "readFile",
            args: { filePath: targetFile, lineNumber: evidence.lineNumber },
            summary: `Inspect and prepare fix for ${analysis.summary} in '${targetFile}'`,
            isStateChanging: true, // The follow-up fix will modify code
            autonomyLevel: 3, // Level 3: Ask for approval before writing
            riskLevel: "MEDIUM",
            targetDevice: "DESKTOP",
          },
          approvalRequired: true,
          riskLevel: "MEDIUM",
        };
      }

      case "TEST_FAILED": {
        return {
          suggestedAction: {
            id: `act_proactive_diagnose_tests_${Date.now()}`,
            capability: "code.inspect",
            toolName: "readFile",
            args: { filePath: targetFile },
            summary: `Inspect failing test suite in '${targetFile}'`,
            isStateChanging: false,
            autonomyLevel: 2, // Level 2: Propose inspection
            riskLevel: "LOW",
            targetDevice: "DESKTOP",
          },
          approvalRequired: true, // Ask user before executing inspection or re-run
          riskLevel: "LOW",
        };
      }

      case "BUILD_FAILED": {
        return {
          suggestedAction: {
            id: `act_proactive_rebuild_${Date.now()}`,
            capability: "project.build",
            toolName: "runShellCommand",
            args: { command: "npm run build" },
            summary: `Re-run production build to verify compiler status for '${project || "workspace"}'`,
            isStateChanging: true,
            autonomyLevel: 3,
            riskLevel: "MEDIUM",
            targetDevice: "DESKTOP",
          },
          approvalRequired: true,
          riskLevel: "MEDIUM",
        };
      }

      case "RUNTIME_ERROR": {
        if (evidence.errorCode === "EADDRINUSE") {
          return {
            suggestedAction: {
              id: `act_proactive_free_port_${Date.now()}`,
              capability: "system.killPortProcess",
              toolName: "runShellCommand",
              args: { command: "npx kill-port 3000" },
              summary: "Terminate process occupying development port",
              isStateChanging: true,
              autonomyLevel: 3,
              riskLevel: "HIGH",
              targetDevice: "DESKTOP",
            },
            approvalRequired: true,
            riskLevel: "HIGH",
          };
        }

        return {
          suggestedAction: {
            id: `act_proactive_runtime_diag_${Date.now()}`,
            capability: "code.inspect",
            toolName: "readFile",
            args: { filePath: targetFile },
            summary: `Inspect source code in '${targetFile}' around runtime error`,
            isStateChanging: false,
            autonomyLevel: 2,
            riskLevel: "LOW",
            targetDevice: "DESKTOP",
          },
          approvalRequired: true,
          riskLevel: "LOW",
        };
      }

      case "REPEATED_FAILURE": {
        return {
          suggestedAction: {
            id: `act_proactive_deep_diag_${Date.now()}`,
            capability: "code.inspect",
            toolName: "readFile",
            args: { filePath: targetFile },
            summary: `Deep diagnostic report on recurring failure in '${targetFile}'`,
            isStateChanging: false,
            autonomyLevel: 2,
            riskLevel: "LOW",
            targetDevice: "DESKTOP",
          },
          approvalRequired: true,
          riskLevel: "LOW",
        };
      }

      case "TASK_STALLED": {
        return {
          suggestedAction: {
            id: `act_proactive_abort_task_${Date.now()}`,
            capability: "tasks.cancelTask",
            toolName: "cancelTask",
            args: { taskId: evidence.command || "stalled_task" },
            summary: `Cancel stalled task '${evidence.command || "stalled_task"}'`,
            isStateChanging: true,
            autonomyLevel: 3,
            riskLevel: "MEDIUM",
            targetDevice: "DESKTOP",
          },
          approvalRequired: true,
          riskLevel: "MEDIUM",
        };
      }

      case "PROJECT_WARNING":
      case "SAFE_SUGGESTION":
      default: {
        return {
          suggestedAction: {
            id: `act_proactive_general_assist_${Date.now()}`,
            capability: "general.assist",
            toolName: "generalAssist",
            args: { prompt: analysis.summary },
            summary: analysis.summary,
            isStateChanging: false,
            autonomyLevel: 1,
            riskLevel: "LOW",
            targetDevice: "DESKTOP",
          },
          approvalRequired: false,
          riskLevel: "LOW",
        };
      }
    }
  }
}

export const proactiveSuggestionEngine = new ProactiveSuggestionEngine();
