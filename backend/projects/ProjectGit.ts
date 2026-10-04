/**
 * MYRAA — ProjectGit
 *
 * Safe read-only git integration for active workspaces.
 * Security guarantees:
 *   - Read-only commands only (branch, status, log, diff --stat)
 *   - Bounded execution with strict 5000ms timeout
 *   - Fails safely if git is not installed, repo uninitialized, or workspace detached
 */

import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import { assertWithinWorkspace } from "../security/PermissionManager.ts";
import type { ProjectGitInfo } from "./ProjectTypes.ts";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 5000;

export class ProjectGit {
  /**
   * Runs a read-only git command in the target workspace.
   */
  private static async runGit(
    workspaceRoot: string,
    args: string[],
  ): Promise<string> {
    const root = assertWithinWorkspace(workspaceRoot, workspaceRoot);

    try {
      const { stdout } = await execFileAsync("git", args, {
        cwd: root,
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 1024 * 512, // 512 KB max output
      });
      return stdout.trim();
    } catch {
      return "";
    }
  }

  private static cache = new Map<string, { expiresAt: number; info: ProjectGitInfo }>();

  /**
   * Gathers git status, current branch, uncommitted count, and recent commits.
   */
  static async getInfo(workspaceRoot: string): Promise<ProjectGitInfo> {
    const root = assertWithinWorkspace(workspaceRoot, workspaceRoot);
    const cacheKey = root.toLowerCase();
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.info;
    }

    const hasGitEntry = await fs.stat(path.join(root, ".git")).then(() => true).catch(() => false);
    if (!hasGitEntry) {
      const toplevel = await this.runGit(root, ["rev-parse", "--show-toplevel"]);
      const isExactRepo =
        Boolean(toplevel) &&
        path.resolve(toplevel).toLowerCase() === path.resolve(root).toLowerCase();
      if (!isExactRepo) {
        const notRepo: ProjectGitInfo = { isGitRepo: false };
        this.cache.set(cacheKey, { expiresAt: Date.now() + 1000, info: notRepo });
        return notRepo;
      }
    }

    const [branchOut, statusOutput, logOutput, diffSummary] = await Promise.all([
      this.runGit(root, ["branch", "--show-current"]),
      this.runGit(root, ["status", "--porcelain"]),
      this.runGit(root, ["log", "-n", "5", "--pretty=format:%h|%an|%cr|%s"]),
      this.runGit(root, ["diff", "--stat"]),
    ]);

    let branch = branchOut;
    if (!branch) {
      branch = await this.runGit(root, ["rev-parse", "--short", "HEAD"]);
    }

    const uncommittedChanges = statusOutput
      ? statusOutput.split(/\r?\n/).filter((l) => l.trim().length > 0).length
      : 0;

    const recentCommits: ProjectGitInfo["recentCommits"] = [];
    if (logOutput) {
      logOutput.split(/\r?\n/).forEach((line) => {
        const [hash, author, date, message] = line.split("|");
        if (hash && message) {
          recentCommits.push({ hash, author, date, message });
        }
      });
    }

    const info: ProjectGitInfo = {
      isGitRepo: true,
      branch: branch || undefined,
      uncommittedChanges,
      recentCommits,
      diffSummary: diffSummary || undefined,
    };
    this.cache.set(cacheKey, { expiresAt: Date.now() + 1000, info });
    return info;
  }
}
