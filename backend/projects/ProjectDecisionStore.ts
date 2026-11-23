/**
 * MYRAA — ProjectDecisionStore (Phase 10.3 Project Continuity Engine)
 *
 * Thin atomic-write persistence layer for project decisions and milestones.
 * Pattern: mirrors ProjectStore but persists ProjectDecision[].
 * Storage location: DATA_DIR via dataFile("project_decisions.json")
 *
 * Security:
 *   - All writes are atomic (tmp → rename with backoff)
 *   - Reads are always fresh from disk (no stale global cache across instances)
 *   - Cross-project access is strictly prevented by projectId ownership validation
 *   - Concurrent writes are serialized via write queue to prevent race conditions
 *   - Confirmed decisions are immutable (cannot silently alter description after confirmation)
 *   - Confirmations are idempotent (does not overwrite original confirmation timestamp)
 */

import fs from "fs/promises";
import { dataFile } from "../server_paths.ts";
import type { ProjectDecision } from "./ProjectTypes.ts";

const DECISIONS_FILE = dataFile("project_decisions.json");

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function readDecisions(filePath: string): Promise<ProjectDecision[]> {
  try {
    let raw = await fs.readFile(filePath, "utf-8");
    // Strip BOM (same defense as PlanStore / MemoryStore)
    raw = raw.replace(/^\uFEFF/, "").trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as ProjectDecision[];
  } catch (err: any) {
    if (err.code === "ENOENT") return [];
    console.error("[ProjectDecisionStore] Error reading decisions file:", err);
    return [];
  }
}

async function writeDecisions(decisions: ProjectDecision[], filePath: string): Promise<void> {
  const tmpFile = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await fs.writeFile(tmpFile, JSON.stringify(decisions, null, 2), "utf-8");
    // Retry rename with backoff (same pattern as PlanStore)
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await fs.rename(tmpFile, filePath);
        return;
      } catch (err: any) {
        if ((err.code === "EPERM" || err.code === "EBUSY") && attempt < 4) {
          await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
          continue;
        }
        throw err;
      }
    }
  } catch (err) {
    console.error("[ProjectDecisionStore] Error writing decisions file:", err);
    try {
      await fs.unlink(tmpFile);
    } catch {
      /* ignore cleanup failure */
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// ProjectDecisionStore
// ---------------------------------------------------------------------------

export class ProjectDecisionStore {
  private filePath: string;
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(customFilePath?: string) {
    this.filePath = customFilePath || DECISIONS_FILE;
  }

  /**
   * Serializes mutating operations on this store instance to prevent write races.
   */
  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(operation, operation);
    this.writeQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  /**
   * Save (create or replace) a decision by ID.
   */
  async saveDecision(decision: ProjectDecision): Promise<void> {
    return this.serialize(async () => {
      const decisions = await readDecisions(this.filePath);
      const idx = decisions.findIndex((d) => d.id === decision.id);
      if (idx >= 0) {
        // Enforce project ownership constancy: cannot move decision to another project
        if (decisions[idx].projectId !== decision.projectId) {
          throw new Error(
            `[ProjectDecisionStore] Cross-project mutation denied: cannot change projectId of decision ${decision.id}`,
          );
        }
        // GAP-10.3-07: Immutability — cannot overwrite an already-confirmed decision via saveDecision
        if (decisions[idx].confirmed) {
          throw new Error(
            `[ProjectDecisionStore] Immutability violation: cannot overwrite already confirmed decision '${decision.id}'.`,
          );
        }
        decisions[idx] = decision;
      } else {
        decisions.push(decision);
      }
      await writeDecisions(decisions, this.filePath);
    });
  }

  /**
   * Retrieve a single decision by ID. Returns undefined if not found.
   */
  async getDecision(id: string): Promise<ProjectDecision | undefined> {
    const decisions = await readDecisions(this.filePath);
    return decisions.find((d) => d.id === id);
  }

  /**
   * List all decisions, ordered by timestamp descending.
   */
  async listDecisions(): Promise<ProjectDecision[]> {
    const decisions = await readDecisions(this.filePath);
    return decisions.sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );
  }

  /**
   * List decisions for a specific project, ordered by timestamp descending.
   * Enforces cross-project isolation — only returns decisions matching projectId.
   */
  async listByProject(projectId: string): Promise<ProjectDecision[]> {
    const decisions = await readDecisions(this.filePath);
    return decisions
      .filter((d) => d.projectId === projectId)
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }

  /**
   * List decisions for a project filtered by type.
   */
  async listByProjectAndType(
    projectId: string,
    type: "decision" | "milestone",
  ): Promise<ProjectDecision[]> {
    const all = await this.listByProject(projectId);
    return all.filter((d) => d.type === type);
  }

  /**
   * Confirms a decision under strict project ownership validation.
   * Idempotent: if already confirmed, returns without modifying original timestamp.
   */
  async confirmDecision(id: string, expectedProjectId: string): Promise<ProjectDecision | undefined> {
    return this.serialize(async () => {
      const decisions = await readDecisions(this.filePath);
      const idx = decisions.findIndex((d) => d.id === id);
      if (idx < 0) return undefined;

      const current = decisions[idx];
      if (current.projectId !== expectedProjectId) {
        throw new Error(
          `[ProjectDecisionStore] Cross-project confirmation rejected: decision '${id}' belongs to project '${current.projectId}', not '${expectedProjectId}'.`,
        );
      }

      // Idempotency: if already confirmed, do not rewrite confirmedAt timestamp
      if (current.confirmed) {
        return current;
      }

      const updated: ProjectDecision = {
        ...current,
        confirmed: true,
        confirmedAt: new Date().toISOString(),
        source: "user_confirmed",
      };
      decisions[idx] = updated;
      await writeDecisions(decisions, this.filePath);
      return updated;
    });
  }

  /**
   * Update a decision (partial patch) under project ownership validation.
   * Confirmed decisions cannot alter description (immutable once confirmed).
   */
  async updateDecision(
    id: string,
    patch: Partial<Omit<ProjectDecision, "id" | "projectId">>,
    expectedProjectId?: string,
  ): Promise<ProjectDecision | undefined> {
    return this.serialize(async () => {
      const decisions = await readDecisions(this.filePath);
      const idx = decisions.findIndex((d) => d.id === id);
      if (idx < 0) return undefined;

      const current = decisions[idx];
      if (expectedProjectId && current.projectId !== expectedProjectId) {
        throw new Error(
          `[ProjectDecisionStore] Cross-project update rejected: decision '${id}' belongs to project '${current.projectId}', not '${expectedProjectId}'.`,
        );
      }

      // Cannot silently mutate confirmed state through generic update
      if (patch.confirmed !== undefined && patch.confirmed !== current.confirmed) {
        throw new Error(
          `[ProjectDecisionStore] Direct confirmation modification rejected: use confirmDecision() with authorized verification.`,
        );
      }

      // Immutability: cannot alter description, type, source, timestamp, or confirmedAt of an already-confirmed decision (GAP-10.3-07)
      if (current.confirmed) {
        if (patch.description !== undefined && patch.description !== current.description) {
          throw new Error(
            `[ProjectDecisionStore] Immutability violation: cannot modify description of an already confirmed decision.`,
          );
        }
        if (
          (patch.type !== undefined && patch.type !== current.type) ||
          (patch.source !== undefined && patch.source !== current.source) ||
          (patch.timestamp !== undefined && patch.timestamp !== current.timestamp) ||
          (patch.confirmedAt !== undefined && patch.confirmedAt !== current.confirmedAt)
        ) {
          throw new Error(
            `[ProjectDecisionStore] Immutability violation: cannot modify fields of an already confirmed decision.`,
          );
        }
      }

      const updated: ProjectDecision = { ...current, ...patch };
      decisions[idx] = updated;
      await writeDecisions(decisions, this.filePath);
      return updated;
    });
  }

  /**
   * Delete a decision by ID under optional project ownership validation.
   */
  async deleteDecision(id: string, expectedProjectId?: string): Promise<boolean> {
    return this.serialize(async () => {
      const decisions = await readDecisions(this.filePath);
      const idx = decisions.findIndex((d) => d.id === id);
      if (idx < 0) return false;

      if (expectedProjectId && decisions[idx].projectId !== expectedProjectId) {
        throw new Error(
          `[ProjectDecisionStore] Cross-project deletion rejected: decision '${id}' belongs to project '${decisions[idx].projectId}', not '${expectedProjectId}'.`,
        );
      }

      decisions.splice(idx, 1);
      await writeDecisions(decisions, this.filePath);
      return true;
    });
  }

  /**
   * Atomically deletes all decisions belonging to a project.
   * Used during project deletion lifecycle to avoid orphaned decisions.
   */
  async deleteByProject(projectId: string): Promise<number> {
    return this.serialize(async () => {
      const decisions = await readDecisions(this.filePath);
      const remaining = decisions.filter((d) => d.projectId !== projectId);
      const removedCount = decisions.length - remaining.length;
      if (removedCount > 0) {
        await writeDecisions(remaining, this.filePath);
      }
      return removedCount;
    });
  }
}

/** Module-level singleton. Tests may instantiate their own ProjectDecisionStore. */
export const projectDecisionStore = new ProjectDecisionStore();
