/**
 * MYRAA — GitMonitor (Phase 6)
 *
 * Proactively checks repository git status:
 *   - Current branch and commit hash
 *   - Uncommitted modifications / staged files count
 *   - Detects state transitions (clean <-> dirty, branch switches, new commits)
 *   - Read-only execution via ProjectGit
 *   - Fires notifications and voice alerts on meaningful git events
 */

import type { GitMonitorReport } from "./CompanionTypes.ts";
import { ProjectGit } from "../projects/ProjectGit.ts";
import { eventBus } from "./EventBus.ts";
import { notificationManager } from "./NotificationManager.ts";

const WORKSPACE = process.env.SORA_WORKSPACE_DIR || process.cwd();

export class GitMonitor {
  private _lastReport?: GitMonitorReport;

  /** Inspect git status in the active workspace. */
  async check(): Promise<GitMonitorReport> {
    const timestamp = new Date().toISOString();
    const gitInfo = await ProjectGit.getInfo(WORKSPACE);

    if (!gitInfo.isGitRepo) {
      const emptyReport: GitMonitorReport = {
        timestamp,
        branch: "none",
        commitHash: "",
        clean: true,
        uncommittedFilesCount: 0,
        modifiedFiles: [],
        changedSinceLastCheck: false,
        summary: "Workspace is not a git repository.",
      };
      this._lastReport = emptyReport;
      return emptyReport;
    }

    const branch = gitInfo.branch || "main";
    const commitHash = gitInfo.recentCommits?.[0]?.hash || "";
    const uncommittedCount = gitInfo.uncommittedChanges || 0;
    const clean = uncommittedCount === 0;

    const changed =
      !this._lastReport ||
      this._lastReport.branch !== branch ||
      this._lastReport.commitHash !== commitHash ||
      this._lastReport.uncommittedFilesCount !== uncommittedCount;

    const summary = clean
      ? `Git repository is clean on branch '${branch}' at commit ${commitHash.slice(0, 7)}.`
      : `Branch '${branch}' has ${uncommittedCount} uncommitted change(s).`;

    const report: GitMonitorReport = {
      timestamp,
      branch,
      commitHash,
      clean,
      uncommittedFilesCount: uncommittedCount,
      modifiedFiles: [],
      changedSinceLastCheck: changed,
      summary,
    };

    if (changed && this._lastReport) {
      eventBus.emit("monitor:git_changed", report);

      // Notification on branch change
      if (this._lastReport.branch !== branch) {
        await notificationManager.notify({
          title: "Git Branch Switched",
          message: `Switched git branch to '${branch}'.`,
          level: "info",
          source: "git_monitor",
          voiceText: `Sandeep, aapka git branch switch ho gaya hai branch ${branch} par.`,
        });
      }

      // Notification when uncommitted files appear
      if (uncommittedCount > 0 && this._lastReport.uncommittedFilesCount === 0) {
        await notificationManager.notify({
          title: "Uncommitted Git Changes",
          message: `Detected ${uncommittedCount} uncommitted change(s) on branch '${branch}'.`,
          level: "info",
          source: "git_monitor",
          voiceText: `Sandeep, git me ${uncommittedCount} uncommitted changes detect hue hain.`,
        });
      }
    }

    this._lastReport = report;
    return report;
  }

  getLastReport(): GitMonitorReport | undefined {
    return this._lastReport;
  }
}

/** Global singleton git monitor. */
export const gitMonitor = new GitMonitor();
