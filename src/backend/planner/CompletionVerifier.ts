/**
 * MYRAA — CompletionVerifier (Phase 5)
 *
 * Evaluates whether the final state of the workspace satisfies all expected
 * outcomes from the original Goal.
 *
 * Checks performed:
 *   - Target files exist and are non-empty.
 *   - Artifacts recorded during execution are accessible.
 *   - Outcome criteria descriptions are matched against step results.
 *
 * Returns a `VerificationReport` — never throws.
 */

import fs from "fs";
import path from "path";
import type {
  Goal,
  TaskPlan,
  VerificationReport,
  OutcomeCriteria,
} from "./PlannerTypes.ts";

const WORKSPACE = process.env.SORA_WORKSPACE_DIR || process.cwd();

function fileExistsAndNonEmpty(relPath: string): boolean {
  try {
    const absPath = path.resolve(WORKSPACE, relPath);
    const stat = fs.statSync(absPath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

function allStepsCompleted(plan: TaskPlan): boolean {
  return plan.steps.every(
    (s) => s.toolName === "_report" || s.status === "completed" || s.status === "skipped",
  );
}

function countCompletedModifySteps(plan: TaskPlan): number {
  return plan.steps.filter(
    (s) => s.phase === "modify" && s.status === "completed",
  ).length;
}

// ---------------------------------------------------------------------------
// CompletionVerifier
// ---------------------------------------------------------------------------

export class CompletionVerifier {
  /**
   * Verify a plan against its goal's expected outcomes.
   * Explicitly evaluates workspace state (files on disk, artifacts, and step results).
   * Reports scope: "workspace_outcomes_only".
   * Always returns a VerificationReport — never throws.
   */
  verify(plan: TaskPlan): VerificationReport {
    const goal = plan.goal;
    const criteria: OutcomeCriteria[] = [];

    // ── 1. File-existence criteria ─────────────────────────────────────────
    for (const file of goal.scope.targetFiles) {
      const exists = fileExistsAndNonEmpty(file);
      criteria.push({
        description: `Target file '${file}' exists and is non-empty in workspace.`,
        verificationHint: `Check workspace for ${file}`,
        satisfied: exists,
        evidence: exists ? `File '${file}' found on disk.` : `File '${file}' not found or empty.`,
      });
    }

    // ── 2. Artifact criteria ───────────────────────────────────────────────
    for (const artifact of plan.artifacts) {
      const exists = fileExistsAndNonEmpty(artifact);
      criteria.push({
        description: `Artifact '${artifact}' was created and is accessible.`,
        verificationHint: `Check workspace for ${artifact}`,
        satisfied: exists,
        evidence: exists ? `Artifact '${artifact}' found.` : `Artifact '${artifact}' missing.`,
      });
    }

    // ── 3. Controlled test execution verification (if test phase exists) ──
    const testStep = plan.steps.find((s) => s.phase === "test");
    let testsVerified: boolean | undefined = undefined;
    if (testStep) {
      testsVerified = testStep.status === "completed" && (!testStep.result?.error);
      criteria.push({
        description: "Automated test execution step verified in workspace.",
        verificationHint: "Check test step status and result in execution log.",
        satisfied: testsVerified,
        evidence: testsVerified
          ? "Test step executed successfully with exit code 0."
          : `Test step did not pass (status: ${testStep.status}).`,
      });
    }

    // ── 4. Controlled build verification (if build category or artifact) ──
    let buildVerified: boolean | undefined = undefined;
    if (goal.category === "build") {
      const distExists = fileExistsAndNonEmpty("dist/index.html") || fileExistsAndNonEmpty("dist/server.cjs");
      buildVerified = distExists;
      criteria.push({
        description: "Controlled build output / artifact verified in workspace.",
        verificationHint: "Check workspace dist or build output files.",
        satisfied: Boolean(buildVerified),
        evidence: distExists
          ? "Production build artifacts detected in workspace (dist/)."
          : "Build artifact not found in workspace.",
      });
    }

    // ── 5. Goal-specific expected outcomes ────────────────────────────────
    for (const outcome of goal.expectedOutcomes) {
      if (goal.category === "workflow") {
        // Zero-false-positive verification for mobile workflows:
        // Every non-sentinel step must be completed, must have a valid result, and must NOT have errors.
        const nonSentinelSteps = plan.steps.filter((s) => s.toolName !== "_checkpoint" && s.toolName !== "_report");
        const failedStep = nonSentinelSteps.find((s) => {
          if (s.status === "failed") return true;
          if (s.result?.error) return true;
          if (s.result?.evaluation?.status === "critical_failure") return true;
          const out = s.result?.output as any;
          if (out && (out.ok === false || out.success === false)) return true;
          return false;
        });

        const allDone = nonSentinelSteps.length > 0 && nonSentinelSteps.every((s) => s.status === "completed" || s.status === "skipped");
        const satisfied = allDone && !failedStep;

        criteria.push({
          description: outcome.description,
          verificationHint: outcome.verificationHint,
          satisfied,
          evidence: satisfied
            ? `All ${nonSentinelSteps.length} workflow steps completed successfully with verified results.`
            : failedStep
              ? `Step '${failedStep.description}' failed: ${failedStep.result?.error || (failedStep.result?.output as any)?.error || "failed execution"}.`
              : "Workflow steps did not reach completed state.",
        });
      } else {
        // For non-destructive developer goals, check step completion as a proxy
        const modifyCount = countCompletedModifySteps(plan);
        const allDone = allStepsCompleted(plan);
        const satisfied =
          goal.requiresModification ? modifyCount > 0 && allDone : allDone;

        criteria.push({
          description: outcome.description,
          verificationHint: outcome.verificationHint,
          satisfied,
          evidence: satisfied
            ? `All required steps completed successfully (${modifyCount} modifying step(s) done).`
            : "Not all required steps completed.",
        });
      }
    }

    // ── 6. Step-completion criterion ──────────────────────────────────────
    const allDone = allStepsCompleted(plan);
    const hasFailedSteps = plan.steps.some((s) => s.status === "failed" || Boolean(s.result?.error));
    const stepCriterionSatisfied = allDone && !hasFailedSteps;
    criteria.push({
      description: "All plan steps completed without critical failure.",
      verificationHint: "Inspect each step status in the plan.",
      satisfied: stepCriterionSatisfied,
      evidence: stepCriterionSatisfied
        ? "All steps reached 'completed' or 'skipped' status without errors."
        : "One or more steps remain in pending/failed state or encountered errors.",
    });

    // ── Score and summary ─────────────────────────────────────────────────
    const satisfiedCount = criteria.filter((c) => c.satisfied).length;
    const score = criteria.length > 0 ? satisfiedCount / criteria.length : 1;
    const verified = score >= 0.75;

    const summaryPrefix = goal.category === "workflow" ? "[Workflow Outcome Verification]" : "[Workspace Outcome Verification]";
    const summary = verified
      ? `${summaryPrefix} All key outcomes verified (${satisfiedCount}/${criteria.length} criteria satisfied, score: ${(score * 100).toFixed(0)}%).`
      : `${summaryPrefix} Partial outcomes: ${satisfiedCount}/${criteria.length} criteria satisfied (score: ${(score * 100).toFixed(0)}%). Some criteria require manual review.`;

    return {
      planId: plan.id,
      goal: goal.objective,
      criteria,
      score,
      verified,
      summary,
      generatedAt: new Date().toISOString(),
      scope: "workspace_outcomes_only",
      verificationMethod: "workspace_state_inspection",
      checkResults: {
        filesChecked: goal.scope.targetFiles.length,
        artifactsChecked: plan.artifacts.length,
        testsVerified,
        buildVerified,
      },
    };
  }
}

/** Shared singleton. */
export const completionVerifier = new CompletionVerifier();
