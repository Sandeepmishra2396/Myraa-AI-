/**
 * MYRAA — CompanionStore (Phase 6)
 *
 * Atomic, BOM-safe persistence of:
 *   - Background tasks (companion_tasks.json)
 *   - Notifications (companion_notifications.json)
 *   - Companion preferences (companion_preferences.json)
 *
 * Persistence pattern:
 *   - Unique temporary file per write (`.tmp`)
 *   - Up to 5 retries on Windows `EPERM` / `EBUSY`
 *   - Strips UTF-8 BOM on load
 *   - Never crashes on missing files (safe ENOENT fallback)
 */

import fs from "fs/promises";
import { dataFile } from "../../../server_paths.ts";
import type {
  BackgroundTask,
  NotificationItem,
  CompanionPreferences,
} from "./CompanionTypes.ts";
import { DEFAULT_COMPANION_PREFERENCES } from "./CompanionTypes.ts";

const TASKS_FILE = dataFile("companion_tasks.json");
const NOTIFICATIONS_FILE = dataFile("companion_notifications.json");
const PREFERENCES_FILE = dataFile("companion_preferences.json");

// ---------------------------------------------------------------------------
// Low-level atomic file IO with Windows-safe serialization
// ---------------------------------------------------------------------------

const _writeQueues = new Map<string, Promise<void>>();

async function safeReadFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    let raw = await fs.readFile(filePath, "utf-8");
    raw = raw.replace(/^\uFEFF/, "").trim();
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch (err: any) {
    if (err.code === "ENOENT") return fallback;
    console.error(`[CompanionStore] Error reading '${filePath}':`, err);
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
      console.error(`[CompanionStore] Error writing '${filePath}':`, err);
      try { await fs.unlink(tmpFile); } catch { /* ignore */ }
      throw err;
    }
  });

  _writeQueues.set(filePath, nextWrite.catch(() => {}));
  return nextWrite;
}

// ---------------------------------------------------------------------------
// CompanionStore
// ---------------------------------------------------------------------------

export class CompanionStore {
  // ── Tasks ────────────────────────────────────────────────────────────────
  async listTasks(): Promise<BackgroundTask[]> {
    const arr = await safeReadFile<BackgroundTask[]>(TASKS_FILE, []);
    return Array.isArray(arr) ? arr : [];
  }

  async getTask(id: string): Promise<BackgroundTask | undefined> {
    const tasks = await this.listTasks();
    return tasks.find((t) => t.id === id);
  }

  async saveTask(task: BackgroundTask): Promise<void> {
    const tasks = await this.listTasks();
    const index = tasks.findIndex((t) => t.id === task.id);
    const now = new Date().toISOString();
    const entry = { ...task, updatedAt: now };

    if (index >= 0) {
      tasks[index] = entry;
    } else {
      tasks.unshift(entry);
    }
    // Bound task list to 100 items to prevent unbounded file growth
    const bounded = tasks.slice(0, 100);
    await safeWriteFile(TASKS_FILE, bounded);
  }

  async deleteTask(id: string): Promise<boolean> {
    const tasks = await this.listTasks();
    const filtered = tasks.filter((t) => t.id !== id);
    if (filtered.length !== tasks.length) {
      await safeWriteFile(TASKS_FILE, filtered);
      return true;
    }
    return false;
  }

  async clearTasks(): Promise<void> {
    await safeWriteFile(TASKS_FILE, []);
  }

  // ── Notifications ────────────────────────────────────────────────────────
  async listNotifications(): Promise<NotificationItem[]> {
    const arr = await safeReadFile<NotificationItem[]>(NOTIFICATIONS_FILE, []);
    return Array.isArray(arr) ? arr : [];
  }

  async saveNotification(item: NotificationItem, maxSize = 200): Promise<void> {
    const notifications = await this.listNotifications();
    // Prepend new item
    notifications.unshift(item);
    // Enforce bounded queue size
    const bounded = notifications.slice(0, Math.max(10, maxSize));
    await safeWriteFile(NOTIFICATIONS_FILE, bounded);
  }

  async updateNotification(id: string, patch: Partial<NotificationItem>): Promise<NotificationItem | undefined> {
    const notifications = await this.listNotifications();
    const item = notifications.find((n) => n.id === id);
    if (!item) return undefined;
    Object.assign(item, patch);
    await safeWriteFile(NOTIFICATIONS_FILE, notifications);
    return item;
  }

  async clearNotifications(): Promise<void> {
    await safeWriteFile(NOTIFICATIONS_FILE, []);
  }

  // ── Preferences ──────────────────────────────────────────────────────────
  async getPreferences(): Promise<CompanionPreferences> {
    const prefs = await safeReadFile<CompanionPreferences>(PREFERENCES_FILE, DEFAULT_COMPANION_PREFERENCES);
    return {
      ...DEFAULT_COMPANION_PREFERENCES,
      ...prefs,
      pollIntervals: {
        ...DEFAULT_COMPANION_PREFERENCES.pollIntervals,
        ...(prefs.pollIntervals || {}),
      },
      quietHours: {
        ...DEFAULT_COMPANION_PREFERENCES.quietHours,
        ...(prefs.quietHours || {}),
      },
    };
  }

  async savePreferences(patch: Partial<CompanionPreferences>): Promise<CompanionPreferences> {
    const current = await this.getPreferences();
    const updated: CompanionPreferences = {
      ...current,
      ...patch,
      pollIntervals: {
        ...current.pollIntervals,
        ...(patch.pollIntervals || {}),
      },
      quietHours: {
        ...current.quietHours,
        ...(patch.quietHours || {}),
      },
      updatedAt: new Date().toISOString(),
    };
    await safeWriteFile(PREFERENCES_FILE, updated);
    return updated;
  }
}

/** Module-level singleton. */
export const companionStore = new CompanionStore();
