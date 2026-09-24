/**
 * MYRAA — PlanStore (Phase 5)
 *
 * Atomic, BOM-safe persistence of task plans in DATA_DIR/agent_plans.json.
 *
 * Write pattern: write to .tmp → rename (atomic replacement).
 * On load: strips UTF-8 BOM and leading/trailing whitespace.
 * Plans in status `waiting_for_approval` are loaded with that status preserved —
 * they do NOT auto-resume; the coordinator must wait for explicit user confirmation.
 */

import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { dataFile } from "../../../server_paths.ts";
import type { TaskPlan, PlanStatus } from "./PlannerTypes.ts";

const PLANS_FILE = dataFile("agent_plans.json");
const TMP_FILE = PLANS_FILE + ".tmp";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function readPlans(): Promise<Map<string, TaskPlan>> {
  try {
    let raw = await fs.readFile(PLANS_FILE, "utf-8");
    // Strip BOM and whitespace (same defence as MemoryStore / server_memory.ts)
    raw = raw.replace(/^\uFEFF/, "").trim();
    if (!raw) return new Map();
    const arr: TaskPlan[] = JSON.parse(raw);
    if (!Array.isArray(arr)) return new Map();
    return new Map(arr.map((p) => [p.id, p]));
  } catch (err: any) {
    if (err.code === "ENOENT") return new Map();
    console.error("[PlanStore] Error reading agent_plans.json:", err);
    return new Map();
  }
}

async function writePlans(plans: Map<string, TaskPlan>): Promise<void> {
  const arr = Array.from(plans.values());
  const json = JSON.stringify(arr, null, 2);
  const tmpFile = `${PLANS_FILE}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await fs.writeFile(tmpFile, json, "utf-8");
    let renamed = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await fs.rename(tmpFile, PLANS_FILE);
        renamed = true;
        break;
      } catch (err: any) {
        if ((err.code === "EPERM" || err.code === "EBUSY") && attempt < 4) {
          await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
          continue;
        }
        throw err;
      }
    }
    if (!renamed) {
      await fs.rename(tmpFile, PLANS_FILE);
    }
  } catch (err) {
    console.error("[PlanStore] Error writing agent_plans.json:", err);
    // Attempt cleanup of orphaned tmp file
    try { await fs.unlink(tmpFile); } catch { /* ignore */ }
    throw err;
  }
}


// ---------------------------------------------------------------------------
// PlanStore
// ---------------------------------------------------------------------------

export class PlanStore {
  /** Save (create or replace) a plan. */
  async savePlan(plan: TaskPlan): Promise<void> {
    const plans = await readPlans();
    plans.set(plan.id, { ...plan, updatedAt: new Date().toISOString() });
    await writePlans(plans);
  }

  /** Return a single plan by ID, or undefined if not found. */
  async getPlan(id: string): Promise<TaskPlan | undefined> {
    const plans = await readPlans();
    return plans.get(id);
  }

  /** Return all stored plans ordered by createdAt descending. */
  async listPlans(): Promise<TaskPlan[]> {
    const plans = await readPlans();
    return Array.from(plans.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }

  /**
   * Partially update a plan. Only the supplied fields are overwritten.
   * Returns the updated plan, or undefined if the plan was not found.
   *
   * IMPORTANT: status `waiting_for_approval` is never auto-cleared here.
   * Only `PlannerCoordinator._resolveCheckpoint()` may advance that status.
   */
  async updatePlan(id: string, patch: Partial<TaskPlan>): Promise<TaskPlan | undefined> {
    const plans = await readPlans();
    const existing = plans.get(id);
    if (!existing) return undefined;
    const updated: TaskPlan = { ...existing, ...patch, id, updatedAt: new Date().toISOString() };
    plans.set(id, updated);
    await writePlans(plans);
    return updated;
  }

  /** Delete a plan by ID. Returns true if it existed, false otherwise. */
  async deletePlan(id: string): Promise<boolean> {
    const plans = await readPlans();
    const existed = plans.has(id);
    if (existed) {
      plans.delete(id);
      await writePlans(plans);
    }
    return existed;
  }

  /**
   * Return all plans whose status matches any of the given values.
   * Useful for the coordinator to locate orphaned `waiting_for_approval` plans
   * after a restart (to present them to the user rather than auto-resuming).
   */
  async findByStatus(...statuses: PlanStatus[]): Promise<TaskPlan[]> {
    const all = await this.listPlans();
    const set = new Set<PlanStatus>(statuses);
    return all.filter((p) => set.has(p.status));
  }
}

/** Module-level singleton. Tests may instantiate their own PlanStore. */
export const planStore = new PlanStore();
