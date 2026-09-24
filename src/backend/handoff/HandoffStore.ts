/**
 * MYRAA — HandoffStore (Phase 25)
 *
 * Single source-of-truth for persisting handoffs.json.
 * Provides atomic file writes and an in-memory cache for fast access.
 */

import fs from "fs/promises";
import path from "path";
import { dataFile } from "../../../server_paths.ts";
import type { HandoffSnapshot } from "./HandoffTypes.ts";

const HANDOFF_FILE = dataFile("handoffs.json");

export interface IHandoffStore {
  load(): Promise<HandoffSnapshot[]>;
  save(snapshots: HandoffSnapshot[]): Promise<void>;
  clear(): Promise<void>;
}

export class FileHandoffStore implements IHandoffStore {
  private _cache: HandoffSnapshot[] | null = null;
  private _filePath: string;

  constructor(filePath = HANDOFF_FILE) {
    this._filePath = filePath;
  }

  async load(): Promise<HandoffSnapshot[]> {
    if (this._cache !== null) {
      return [...this._cache];
    }

    try {
      const raw = await fs.readFile(this._filePath, "utf-8");
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        this._cache = [];
        return [];
      }
      this._cache = parsed as HandoffSnapshot[];
      return [...this._cache];
    } catch (err: any) {
      if (err.code === "ENOENT") {
        this._cache = [];
        return [];
      }
      console.warn(`[HandoffStore] Could not read ${this._filePath}:`, err.message);
      this._cache = [];
      return [];
    }
  }

  async save(snapshots: HandoffSnapshot[]): Promise<void> {
    this._cache = [...snapshots];

    const dir = path.dirname(this._filePath);
    await fs.mkdir(dir, { recursive: true });

    const tmpPath = `${this._filePath}.tmp.${Date.now()}`;
    await fs.writeFile(tmpPath, JSON.stringify(snapshots, null, 2), "utf-8");
    await fs.rename(tmpPath, this._filePath);
  }

  async clear(): Promise<void> {
    this._cache = [];
    try {
      await fs.unlink(this._filePath);
    } catch (err: any) {
      if (err.code !== "ENOENT") {
        console.warn(`[HandoffStore] Error clearing ${this._filePath}:`, err.message);
      }
    }
  }

  invalidateCache(): void {
    this._cache = null;
  }
}

export class MockHandoffStore implements IHandoffStore {
  private _data: HandoffSnapshot[] = [];

  async load(): Promise<HandoffSnapshot[]> {
    return [...this._data];
  }

  async save(snapshots: HandoffSnapshot[]): Promise<void> {
    this._data = [...snapshots];
  }

  async clear(): Promise<void> {
    this._data = [];
  }
}

export const defaultHandoffStore: IHandoffStore = new FileHandoffStore();
