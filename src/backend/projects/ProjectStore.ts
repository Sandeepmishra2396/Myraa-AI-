/**
 * MYRAA — ProjectStore
 *
 * Single source-of-truth for persisting project contexts to `projects.json`.
 * Features:
 *   - Atomic write operations (.tmp + rename)
 *   - In-memory caching
 *   - Active project pointer tracking
 *   - Storage location: DATA_DIR via dataFile("projects.json")
 */

import fs from "fs/promises";
import path from "path";
import { dataFile } from "../../../server_paths.ts";
import type { ProjectContext } from "./ProjectTypes.ts";

const PROJECTS_FILE = dataFile("projects.json");

interface ProjectsStoreData {
  activeProjectId: string | null;
  projects: ProjectContext[];
}

let _cache: ProjectsStoreData | null = null;

export class ProjectStore {
  private filePath: string;

  constructor(customFilePath?: string) {
    this.filePath = customFilePath || PROJECTS_FILE;
  }

  /**
   * Loads all stored project contexts from disk.
   */
  async load(): Promise<ProjectsStoreData> {
    if (_cache !== null) {
      return _cache;
    }

    try {
      const content = await fs.readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(content);
      const data: ProjectsStoreData = {
        activeProjectId: parsed.activeProjectId ?? null,
        projects: Array.isArray(parsed.projects) ? parsed.projects : [],
      };
      _cache = data;
      return data;
    } catch (err: any) {
      if (err.code === "ENOENT") {
        const empty: ProjectsStoreData = { activeProjectId: null, projects: [] };
        _cache = empty;
        return empty;
      }
      console.error("[ProjectStore] Failed to read projects file:", err);
      const fallback: ProjectsStoreData = { activeProjectId: null, projects: [] };
      _cache = fallback;
      return fallback;
    }
  }

  /**
   * Atomically saves the projects store to disk.
   */
  async save(data: ProjectsStoreData): Promise<void> {
    const tmpFile = `${this.filePath}.tmp`;
    try {
      await fs.writeFile(tmpFile, JSON.stringify(data, null, 2), "utf-8");
      await fs.rename(tmpFile, this.filePath);
      _cache = data;
    } catch (err) {
      console.error("[ProjectStore] Failed to save projects atomically:", err);
      try {
        await fs.unlink(tmpFile);
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Retrieves a project by ID or root path.
   */
  async getProject(idOrPath: string): Promise<ProjectContext | undefined> {
    const data = await this.load();
    const needle = idOrPath.trim().toLowerCase();
    return data.projects.find(
      (p) =>
        p.id.toLowerCase() === needle ||
        path.resolve(p.rootPath).toLowerCase() === path.resolve(needle).toLowerCase(),
    );
  }

  /**
   * Retrieves the currently active project context.
   */
  async getActiveProject(): Promise<ProjectContext | undefined> {
    const data = await this.load();
    if (!data.activeProjectId) {
      return data.projects[0];
    }
    return data.projects.find((p) => p.id === data.activeProjectId);
  }

  /**
   * Sets the active project by ID or path.
   */
  async setActiveProject(idOrPath: string): Promise<void> {
    const data = await this.load();
    const found = await this.getProject(idOrPath);
    if (found) {
      data.activeProjectId = found.id;
      await this.save(data);
    }
  }

  /**
   * Upserts a project context into the store.
   */
  async saveProject(project: ProjectContext): Promise<void> {
    const data = await this.load();
    const idx = data.projects.findIndex(
      (p) =>
        p.id === project.id ||
        path.resolve(p.rootPath).toLowerCase() === path.resolve(project.rootPath).toLowerCase(),
    );

    if (idx >= 0) {
      data.projects[idx] = project;
    } else {
      data.projects.push(project);
    }

    if (!data.activeProjectId) {
      data.activeProjectId = project.id;
    }

    await this.save(data);
  }

  /**
   * Deletes a project context from the store.
   */
  async deleteProject(id: string): Promise<boolean> {
    const data = await this.load();
    const prevLen = data.projects.length;
    data.projects = data.projects.filter((p) => p.id !== id);
    if (data.activeProjectId === id) {
      data.activeProjectId = data.projects[0]?.id ?? null;
    }
    if (data.projects.length !== prevLen) {
      await this.save(data);
      return true;
    }
    return false;
  }

  /**
   * Clears the in-memory cache (useful for testing).
   */
  clearCache(): void {
    _cache = null;
  }
}

export const projectStore = new ProjectStore();
