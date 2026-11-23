/**
 * MYRAA - ProjectStore
 *
 * Single source-of-truth for persisting project contexts to `projects.json`.
 * Features:
 *   - Full read-modify-write transaction serialization keyed by canonical file path
 *     (shared across all ProjectStore instances targeting the same file within this process)
 *   - Copy-on-write mutation isolation: cache is published ONLY after atomic rename succeeds
 *   - Path-keyed in-memory cache with defensive cloning to prevent external mutation
 *   - Atomic write operations (unique .tmp in destination dir + retryable rename + own-tmp cleanup)
 *   - Active project pointer tracking
 *   - Automatic instruction cache invalidation strictly after successful persistence
 *   - Orphaned decision cleanup on project deletion
 *   - Storage location: DATA_DIR via dataFile("projects.json")
 */

import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { dataFile } from "../server_paths.ts";
import type { ProjectContext } from "./ProjectTypes.ts";
import { projectDecisionStore, type ProjectDecisionStore } from "./ProjectDecisionStore.ts";

const PROJECTS_FILE = dataFile("projects.json");

interface ProjectsStoreData {
  activeProjectId: string | null;
  projects: ProjectContext[];
}

// Process-local serialization queues and caches keyed by canonical resolved file path.
// Guarantees all ProjectStore instances targeting the same file share one read-modify-write
// transaction boundary and never share cache state with stores targeting different files.
const _fileQueues = new Map<string, Promise<unknown>>();
const _cacheByFile = new Map<string, ProjectsStoreData>();
let _instructionsCacheInvalidator: (() => void) | null = null;

function canonicalFileKey(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function cloneStoreData(data: ProjectsStoreData): ProjectsStoreData {
  return structuredClone(data);
}

function cloneProject(project: ProjectContext): ProjectContext {
  return structuredClone(project);
}

/**
 * Serializes an entire read-modify-write transaction per canonical file path
 * within the current Node.js process. Failures propagate to the caller without
 * poisoning subsequent queued transactions.
 */
async function runFileTransaction<T>(
  fileKey: string,
  operation: () => Promise<T>,
): Promise<T> {
  const prev = _fileQueues.get(fileKey) ?? Promise.resolve();
  const next = prev.then(operation, operation);
  const tail = next.then(
    () => undefined,
    () => undefined,
  );
  _fileQueues.set(fileKey, tail);
  tail.finally(() => {
    if (_fileQueues.get(fileKey) === tail) {
      _fileQueues.delete(fileKey);
    }
  });
  return next;
}

/**
 * Registers an optional instructions-cache invalidator callback (dependency inversion
 * to avoid a static circular ESM dependency between ProjectStore and GeminiSessionFactory — GAP-10.3-06).
 */
export function registerInstructionsCacheInvalidator(fn: (() => void) | null): void {
  _instructionsCacheInvalidator = fn;
}

export class ProjectStore {
  private filePath: string;
  private fileKey: string;
  private decisionStore: ProjectDecisionStore;

  constructor(customFilePath?: string, customDecisionStore?: ProjectDecisionStore) {
    this.filePath = path.resolve(customFilePath || PROJECTS_FILE);
    this.fileKey = canonicalFileKey(this.filePath);
    this.decisionStore = customDecisionStore || projectDecisionStore;
  }

  private async _invalidateInstructionsCache(): Promise<void> {
    if (_instructionsCacheInvalidator) {
      try {
        _instructionsCacheInvalidator();
        return;
      } catch (err: any) {
        console.warn(
          "[ProjectStore] Registered instructions cache invalidator failed; attempting lazy fallback:",
          err?.message || "unknown error",
        );
      }
    }
    try {
      const mod = await import("../ai/GeminiSessionFactory.ts");
      if (typeof mod.invalidateInstructionsCache === "function") {
        mod.invalidateInstructionsCache();
      } else {
        console.warn(
          "[ProjectStore] Instructions cache invalidation skipped: GeminiSessionFactory.invalidateInstructionsCache unavailable.",
        );
      }
    } catch (err: any) {
      console.warn(
        "[ProjectStore] Instructions cache invalidation fallback import failed:",
        err?.message || "unknown error",
      );
    }
  }

  /**
   * Reads the latest committed state for this canonical file path inside an active
   * transaction. Returns an isolated deep clone so candidate mutations never alter
   * the published cache before atomic persistence succeeds.
   */
  private async _readLatestLocked(): Promise<ProjectsStoreData> {
    const cached = _cacheByFile.get(this.fileKey);
    if (cached !== undefined) {
      return cloneStoreData(cached);
    }

    try {
      const content = await fs.readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(content);
      const loaded: ProjectsStoreData = {
        activeProjectId: parsed.activeProjectId ?? null,
        projects: Array.isArray(parsed.projects) ? parsed.projects : [],
      };
      _cacheByFile.set(this.fileKey, cloneStoreData(loaded));
      return cloneStoreData(loaded);
    } catch (err: any) {
      if (err?.code === "ENOENT") {
        return { activeProjectId: null, projects: [] };
      }
      throw err;
    }
  }

  /**
   * Atomically persists candidate state to disk and publishes it to the path-keyed
   * cache ONLY after `fs.rename` succeeds. Must be invoked only while holding the
   * file's transaction boundary via `runFileTransaction`.
   */
  private async _atomicPersistAndPublishLocked(candidate: ProjectsStoreData): Promise<void> {
    const dir = path.dirname(this.filePath);
    const base = path.basename(this.filePath);
    const tmpFile = path.join(
      dir,
      `.${base}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`,
    );
    const serialized = JSON.stringify(candidate, null, 2);

    try {
      await fs.writeFile(tmpFile, serialized, "utf-8");
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          await fs.rename(tmpFile, this.filePath);
          // Publish candidate to path-keyed cache strictly AFTER atomic rename succeeds
          _cacheByFile.set(this.fileKey, cloneStoreData(candidate));
          return;
        } catch (err: any) {
          if ((err?.code === "EPERM" || err?.code === "EBUSY") && attempt < 4) {
            await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
            continue;
          }
          throw err;
        }
      }
    } catch (err) {
      console.error("[ProjectStore] Failed to save projects atomically:", err);
      try {
        await fs.unlink(tmpFile);
      } catch {
        /* ignore if tmpFile was never created or already removed */
      }
      throw err;
    }
  }

  /**
   * Loads all stored project contexts for this store's canonical file path.
   * Warm cache hits return an immediate defensive deep clone without acquiring
   * the transaction queue. Cold cache misses hydrate inside the shared file
   * transaction boundary and re-check the cache before reading disk so a stale
   * cold load can never overwrite a newer committed transaction (AUD-P1-01).
   */
  async load(): Promise<ProjectsStoreData> {
    const cached = _cacheByFile.get(this.fileKey);
    if (cached !== undefined) {
      return cloneStoreData(cached);
    }

    return runFileTransaction(this.fileKey, async () => {
      const latestCached = _cacheByFile.get(this.fileKey);
      if (latestCached !== undefined) {
        return cloneStoreData(latestCached);
      }

      try {
        const content = await fs.readFile(this.filePath, "utf-8");
        const parsed = JSON.parse(content);
        const data: ProjectsStoreData = {
          activeProjectId: parsed.activeProjectId ?? null,
          projects: Array.isArray(parsed.projects) ? parsed.projects : [],
        };
        _cacheByFile.set(this.fileKey, cloneStoreData(data));
        return cloneStoreData(data);
      } catch (err: any) {
        if (err?.code === "ENOENT") {
          const empty: ProjectsStoreData = { activeProjectId: null, projects: [] };
          _cacheByFile.set(this.fileKey, cloneStoreData(empty));
          return cloneStoreData(empty);
        }
        console.error("[ProjectStore] Failed to read projects file:", err);
        return { activeProjectId: null, projects: [] };
      }
    });
  }

  /**
   * Atomically saves the projects store to disk within the shared file transaction
   * boundary, publishing to cache only after rename succeeds (GAP-10.3-07 / GAP-10.3-08).
   */
  async save(data: ProjectsStoreData): Promise<void> {
    const candidate = cloneStoreData({
      activeProjectId: data.activeProjectId ?? null,
      projects: Array.isArray(data.projects) ? data.projects : [],
    });
    return runFileTransaction(this.fileKey, async () => {
      await this._atomicPersistAndPublishLocked(candidate);
    });
  }

  /**
   * Retrieves a defensive clone of a project by ID or root path.
   */
  async getProject(idOrPath: string): Promise<ProjectContext | undefined> {
    const data = await this.load();
    const needle = idOrPath.trim().toLowerCase();
    const resolvedNeedle = path.resolve(needle).toLowerCase();
    return data.projects.find(
      (p) =>
        p.id.toLowerCase() === needle ||
        path.resolve(p.rootPath).toLowerCase() === resolvedNeedle,
    );
  }

  /**
   * Retrieves a defensive clone of the currently active project context.
   */
  async getActiveProject(): Promise<ProjectContext | undefined> {
    const data = await this.load();
    if (!data.activeProjectId) {
      return data.projects[0];
    }
    return data.projects.find((p) => p.id === data.activeProjectId);
  }

  /**
   * Atomically sets the active project by ID or path inside the shared file
   * transaction boundary. Invalidates instructions cache strictly after persistence.
   */
  async setActiveProject(idOrPath: string): Promise<void> {
    const mutated = await runFileTransaction(this.fileKey, async () => {
      const candidate = await this._readLatestLocked();
      const needle = idOrPath.trim().toLowerCase();
      const resolvedNeedle = path.resolve(needle).toLowerCase();
      const found = candidate.projects.find(
        (p) =>
          p.id.toLowerCase() === needle ||
          path.resolve(p.rootPath).toLowerCase() === resolvedNeedle,
      );
      if (!found) {
        return false;
      }
      candidate.activeProjectId = found.id;
      await this._atomicPersistAndPublishLocked(candidate);
      return true;
    });

    if (mutated) {
      await this._invalidateInstructionsCache();
    }
  }

  /**
   * Atomically upserts a project context inside the shared file transaction boundary.
   * Mutates only an isolated clone and publishes cache strictly after disk persistence.
   */
  async saveProject(project: ProjectContext): Promise<void> {
    const projectCopy = cloneProject(project);
    await runFileTransaction(this.fileKey, async () => {
      const candidate = await this._readLatestLocked();
      const targetRoot = path.resolve(projectCopy.rootPath).toLowerCase();
      const idx = candidate.projects.findIndex(
        (p) =>
          p.id === projectCopy.id ||
          path.resolve(p.rootPath).toLowerCase() === targetRoot,
      );

      if (idx >= 0) {
        candidate.projects[idx] = projectCopy;
      } else {
        candidate.projects.push(projectCopy);
      }

      if (!candidate.activeProjectId) {
        candidate.activeProjectId = projectCopy.id;
      }

      await this._atomicPersistAndPublishLocked(candidate);
    });

    await this._invalidateInstructionsCache();
  }

  /**
   * Atomically deletes a project context inside the shared file transaction boundary
   * and cleans up associated orphaned decisions strictly after successful persistence.
   */
  async deleteProject(id: string): Promise<boolean> {
    const deleted = await runFileTransaction(this.fileKey, async () => {
      const candidate = await this._readLatestLocked();
      const prevLen = candidate.projects.length;
      candidate.projects = candidate.projects.filter((p) => p.id !== id);
      if (candidate.activeProjectId === id) {
        candidate.activeProjectId = candidate.projects[0]?.id ?? null;
      }
      if (candidate.projects.length === prevLen) {
        return false;
      }
      await this._atomicPersistAndPublishLocked(candidate);
      return true;
    });

    if (deleted) {
      try {
        await this.decisionStore.deleteByProject(id);
      } catch (err) {
        console.warn(`[ProjectStore] Could not clean decisions for deleted project ${id}:`, err);
      }
      await this._invalidateInstructionsCache();
      return true;
    }
    return false;
  }

  /**
   * Clears the in-memory cache for this store's canonical file path (useful for testing).
   */
  clearCache(): void {
    _cacheByFile.delete(this.fileKey);
  }
}

export const projectStore = new ProjectStore();