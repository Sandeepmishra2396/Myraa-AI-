/**
 * MYRAA — CompanionPersonaStore (Stage 10 Phase 1)
 *
 * Atomic, Windows-safe persistence for MYRAA persona identity and communication preferences.
 * Storage: Tier 2 (companion_persona.json)
 *
 * Invariants:
 *  - Strips UTF-8 BOM on load
 *  - Atomic write via unique .tmp file and safe rename with Windows EPERM retries
 *  - Fails open with DEFAULT_COMPANION_PERSONA on ENOENT or corrupted file
 *  - Completely isolated from MemorySearch, MemoryExtractor, and memories.json
 */

import fs from "fs/promises";
import { dataFile } from "../server_paths.ts";
import type { CompanionPersona } from "./CompanionPersonaTypes.ts";
import { DEFAULT_COMPANION_PERSONA } from "./CompanionPersonaTypes.ts";

const PERSONA_FILE = dataFile("companion_persona.json");

const _writeQueues = new Map<string, Promise<void>>();

async function safeReadFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    let raw = await fs.readFile(filePath, "utf-8");
    raw = raw.replace(/^\uFEFF/, "").trim();
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch (err: any) {
    if (err.code === "ENOENT") return fallback;
    console.error(`[CompanionPersonaStore] Error reading '${filePath}':`, err?.message || err);
    return fallback;
  }
}

async function safeWriteFile(filePath: string, data: unknown): Promise<void> {
  const currentQueue = _writeQueues.get(filePath) || Promise.resolve();
  const nextWrite = currentQueue.then(async () => {
    const json = JSON.stringify(data, null, 2);
    const tmpFile = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      await fs.writeFile(tmpFile, json, "utf-8");
      let renamed = false;
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          await fs.rename(tmpFile, filePath);
          renamed = true;
          break;
        } catch (err: any) {
          if ((err.code === "EPERM" || err.code === "EBUSY") && attempt < 9) {
            await new Promise((r) => setTimeout(r, 25 * (attempt + 1)));
            continue;
          }
          // Windows fallback: copyFile + unlink
          try {
            await fs.copyFile(tmpFile, filePath);
            await fs.unlink(tmpFile);
            renamed = true;
            break;
          } catch {
            throw err;
          }
        }
      }
      if (!renamed) {
        await fs.copyFile(tmpFile, filePath);
        try { await fs.unlink(tmpFile); } catch { /* ignore */ }
      }
    } catch (err) {
      console.error(`[CompanionPersonaStore] Error writing '${filePath}':`, err);
      try { await fs.unlink(tmpFile); } catch { /* ignore */ }
      throw err;
    }
  });

  _writeQueues.set(filePath, nextWrite.catch(() => {}));
  return nextWrite;
}

export class CompanionPersonaStore {
  private _cached: CompanionPersona | null = null;
  private _filePath: string;

  constructor(customPath?: string) {
    this._filePath = customPath || PERSONA_FILE;
  }

  /**
   * Retrieves current persona profile. If no file exists, loads and persists default persona.
   */
  async getPersona(): Promise<CompanionPersona> {
    const loaded = await safeReadFile<CompanionPersona | null>(this._filePath, null);
    if (!loaded) {
      const initial = {
        ...DEFAULT_COMPANION_PERSONA,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await safeWriteFile(this._filePath, initial);
      this._cached = initial;
      return { ...initial };
    }

    const merged: CompanionPersona = {
      ...DEFAULT_COMPANION_PERSONA,
      ...loaded,
      communicationStyle: {
        ...DEFAULT_COMPANION_PERSONA.communicationStyle,
        ...(loaded.communicationStyle || {}),
      },
    };
    this._cached = merged;
    return { ...merged };
  }

  /**
   * Updates persona fields and atomically saves to companion_persona.json.
   */
  async savePersona(updates: Partial<CompanionPersona>): Promise<CompanionPersona> {
    const current = await this.getPersona();
    const updated: CompanionPersona = {
      ...current,
      ...updates,
      id: "persona_default",
      communicationStyle: {
        ...current.communicationStyle,
        ...(updates.communicationStyle || {}),
      },
      updatedAt: new Date().toISOString(),
    };

    await safeWriteFile(this._filePath, updated);
    this._cached = updated;
    return { ...updated };
  }

  /**
   * Resets persona back to factory defaults.
   */
  async resetDefaults(): Promise<CompanionPersona> {
    const reset = {
      ...DEFAULT_COMPANION_PERSONA,
      updatedAt: new Date().toISOString(),
    };
    await safeWriteFile(this._filePath, reset);
    this._cached = reset;
    return { ...reset };
  }

  /**
   * Helper to inspect current cached value synchronously without disk IO.
   */
  getCachedPersona(): CompanionPersona {
    return this._cached ? { ...this._cached } : { ...DEFAULT_COMPANION_PERSONA };
  }
}

export const companionPersonaStore = new CompanionPersonaStore();
