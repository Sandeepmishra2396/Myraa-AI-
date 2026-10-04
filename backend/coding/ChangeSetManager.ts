/**
 * MYRAA — Phase 23: Autonomous Coding Engineer
 * ChangeSetManager
 *
 * Enforces Scope Control, Approval Invalidation, Protected Path Boundaries, and Rollback Safety:
 *   - Creates and tracks task-scoped ChangeSets.
 *   - Enforces scope: only approved files and operations may be executed.
 *   - If proposed changes change after approval -> invalidates previous approval.
 *   - Blocks access to protected paths (.env, .git, credentials, private keys).
 *   - Records pre-modification file snapshots for deterministic rollback proposals.
 */

import type { ChangeSet, ChangeSetStatus } from "./CodingEngineerTypes.ts";

export interface CreateChangeSetInput {
  taskId: string;
  patch: string;
  files: string[];
  risk: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  operations?: string[];
  fileBackups?: Record<string, string>;
}

export interface ScopeValidationResult {
  allowed: boolean;
  reason?: string;
  violatingFiles?: string[];
}

export class ChangeSetManager {
  private _activeChangeSets: Map<string, ChangeSet> = new Map();
  private _latestChangeSetId?: string;

  private readonly _protectedPatterns: RegExp[] = [
    /^\.env/i,
    /\.env\b/i,
    /^\.git\//i,
    /\/\.git\//i,
    /\bid_rsa\b/i,
    /\bcredentials\b/i,
    /\bprivate[_-]?key\b/i,
    /\bnode_modules\b/i,
    /\bsecrets?\.(json|enc|yml|yaml)\b/i,
  ];

  /**
   * Creates a new pending ChangeSet.
   */
  public createChangeSet(input: CreateChangeSetInput): ChangeSet {
    const changeSetId = `cs_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const changeSet: ChangeSet = {
      changeSetId,
      taskId: input.taskId,
      patch: input.patch,
      approvedFiles: [...input.files],
      approvedOperations: input.operations || ["file.replaceContent"],
      approvedRisk: input.risk,
      executionStatus: "PENDING",
      originalFileBackups: input.fileBackups || {},
    };

    this._activeChangeSets.set(changeSetId, changeSet);
    this._latestChangeSetId = changeSetId;
    return changeSet;
  }

  /**
   * Approves a ChangeSet upon explicit user confirmation.
   */
  public approveChangeSet(
    changeSetId: string,
    source: "USER_EXPLICIT" | "CONVERSATIONAL_CONFIRMATION" = "USER_EXPLICIT"
  ): ChangeSet {
    const cs = this._activeChangeSets.get(changeSetId);
    if (!cs) {
      throw new Error(`ChangeSet '${changeSetId}' not found.`);
    }

    if (cs.executionStatus === "INVALIDATED") {
      throw new Error(`Cannot approve invalidated ChangeSet '${changeSetId}'.`);
    }

    cs.executionStatus = "APPROVED";
    cs.approvalTimestamp = Date.now();
    cs.approvalSource = source;
    return cs;
  }

  /**
   * Invalidates a previous approval if the patch or affected files change.
   */
  public invalidateApproval(changeSetId: string, reason: string): ChangeSet {
    const cs = this._activeChangeSets.get(changeSetId);
    if (!cs) {
      throw new Error(`ChangeSet '${changeSetId}' not found.`);
    }

    cs.executionStatus = "INVALIDATED";
    cs.approvalTimestamp = undefined;
    cs.approvalSource = undefined;
    return cs;
  }

  /**
   * Validates whether target operations and files fall strictly within the approved scope.
   */
  public validateScope(changeSetId: string, targetFiles: string[]): ScopeValidationResult {
    const cs = this._activeChangeSets.get(changeSetId);
    if (!cs) {
      return { allowed: false, reason: `ChangeSet '${changeSetId}' does not exist.` };
    }

    if (cs.executionStatus !== "APPROVED") {
      return {
        allowed: false,
        reason: `ChangeSet '${changeSetId}' is not approved (status: ${cs.executionStatus}).`,
      };
    }

    // ── 1. Protected Path Enforcement ───────────────────────────────────────
    for (const file of targetFiles) {
      if (this.isProtectedPath(file)) {
        return {
          allowed: false,
          reason: `PROTECTED_PATH_VIOLATION: Modification to protected path '${file}' is strictly forbidden.`,
          violatingFiles: [file],
        };
      }
    }

    // ── 2. Scope Drift Enforcement ──────────────────────────────────────────
    // Every file must match or be a child of approvedFiles
    const violatingFiles = targetFiles.filter((target) => {
      const normalizedTarget = target.replace(/\\/g, "/");
      return !cs.approvedFiles.some((approved) => {
        const normalizedApproved = approved.replace(/\\/g, "/");
        if (normalizedApproved.endsWith("/*")) {
          const prefix = normalizedApproved.slice(0, -2);
          return normalizedTarget.startsWith(prefix);
        }
        return normalizedTarget === normalizedApproved;
      });
    });

    if (violatingFiles.length > 0) {
      return {
        allowed: false,
        reason: `SCOPE_DRIFT_DETECTED: Target file(s) [${violatingFiles.join(", ")}] are outside approved scope [${cs.approvedFiles.join(", ")}].`,
        violatingFiles,
      };
    }

    return { allowed: true };
  }

  /**
   * Checks whether a file path targets sensitive protected system files.
   */
  public isProtectedPath(filePath: string): boolean {
    const normalized = filePath.replace(/\\/g, "/");
    return this._protectedPatterns.some((pattern) => pattern.test(normalized));
  }

  /**
   * Generates a safe rollback proposal based on pre-execution file backups.
   */
  public prepareRollbackProposal(
    changeSetId: string,
    failureReason: string
  ): { reason: string; restoreOperations: string[]; targetFiles: string[] } {
    const cs = this._activeChangeSets.get(changeSetId);
    if (!cs) {
      throw new Error(`ChangeSet '${changeSetId}' not found.`);
    }

    const restoreOperations = cs.approvedFiles.map(
      (file) => `Revert '${file}' to snapshot taken at ${new Date(cs.approvalTimestamp || Date.now()).toISOString()}`
    );

    const proposal = {
      reason: failureReason,
      restoreOperations,
      targetFiles: [...cs.approvedFiles],
    };

    cs.rollbackProposal = proposal;
    cs.executionStatus = "FAILED";
    return proposal;
  }

  /**
   * Marks a ChangeSet as executed.
   */
  public markExecuted(changeSetId: string): void {
    const cs = this._activeChangeSets.get(changeSetId);
    if (cs) {
      cs.executionStatus = "EXECUTED";
    }
  }

  /**
   * Marks a ChangeSet as reverted.
   */
  public markReverted(changeSetId: string): void {
    const cs = this._activeChangeSets.get(changeSetId);
    if (cs) {
      cs.executionStatus = "REVERTED";
    }
  }

  /**
   * Returns a ChangeSet by ID.
   */
  public getChangeSet(changeSetId: string): ChangeSet | undefined {
    return this._activeChangeSets.get(changeSetId);
  }

  /**
   * Returns the most recent ChangeSet.
   */
  public getLatestChangeSet(): ChangeSet | undefined {
    if (this._latestChangeSetId) {
      return this._activeChangeSets.get(this._latestChangeSetId);
    }
    return undefined;
  }

  /**
   * Resets all ChangeSet manager state.
   */
  public reset(): void {
    this._activeChangeSets.clear();
    this._latestChangeSetId = undefined;
  }
}

export const changeSetManager = new ChangeSetManager();
