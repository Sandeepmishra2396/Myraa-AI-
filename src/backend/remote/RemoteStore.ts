/**
 * MYRAA — RemoteStore (Phase 7 + Phase 28)
 *
 * Windows-safe, atomic, serialized JSON persistence for:
 *   - Paired devices (remote_devices.json)
 *   - Emergency stop state (remote_emergency_stop.json)
 *   - Lost-device records (remote_lost_devices.json) [Phase 28]
 *
 * Implements:
 *   - In-process per-file write serialization queue
 *   - 10-attempt exponential backoff for Windows EPERM/EBUSY
 *   - copyFile + unlink fallback on persistent rename locks
 *   - UTF-8 BOM stripping
 */

import fs from "fs/promises";
import { dataFile } from "../../../server_paths.ts";
import type { PairedDevice, EmergencyStopState } from "./RemoteTypes.ts";
import type { LostDeviceRecord } from "../security/AndroidSecurityTypes.ts";

const DEVICES_FILE = dataFile("remote_devices.json");
const EMERGENCY_FILE = dataFile("remote_emergency_stop.json");
const LOST_DEVICES_FILE = dataFile("remote_lost_devices.json"); // Phase 28

const _writeQueues = new Map<string, Promise<void>>();

async function safeReadFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    let raw = await fs.readFile(filePath, "utf-8");
    raw = raw.replace(/^\uFEFF/, "").trim();
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch (err: any) {
    if (err.code === "ENOENT") return fallback;
    console.error(`[RemoteStore] Error reading '${filePath}':`, err);
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
      console.error(`[RemoteStore] Error writing '${filePath}':`, err);
      try { await fs.unlink(tmpFile); } catch { /* ignore */ }
      throw err;
    }
  });

  _writeQueues.set(filePath, nextWrite.catch(() => {}));
  return nextWrite;
}

export class RemoteStore {
  // ── Devices ──────────────────────────────────────────────────────────────
  async listDevices(): Promise<PairedDevice[]> {
    const arr = await safeReadFile<PairedDevice[]>(DEVICES_FILE, []);
    return Array.isArray(arr) ? arr : [];
  }

  async getDevice(id: string): Promise<PairedDevice | undefined> {
    const devices = await this.listDevices();
    return devices.find((d) => d.id === id);
  }

  async saveDevice(device: PairedDevice): Promise<void> {
    const devices = await this.listDevices();
    const index = devices.findIndex((d) => d.id === device.id);
    const now = new Date().toISOString();
    const entry: PairedDevice = { ...device, lastSeenAt: now };

    if (index >= 0) {
      devices[index] = entry;
    } else {
      devices.unshift(entry);
    }
    // Cap stored paired devices at 50 to prevent unbounded file growth
    const bounded = devices.slice(0, 50);
    await safeWriteFile(DEVICES_FILE, bounded);
  }

  async deleteDevice(id: string): Promise<boolean> {
    const devices = await this.listDevices();
    const filtered = devices.filter((d) => d.id !== id);
    if (filtered.length !== devices.length) {
      await safeWriteFile(DEVICES_FILE, filtered);
      return true;
    }
    return false;
  }

  // ── Emergency Stop State ─────────────────────────────────────────────────
  async getEmergencyStopState(): Promise<EmergencyStopState> {
    const fallback: EmergencyStopState = { active: false };
    const state = await safeReadFile<EmergencyStopState>(EMERGENCY_FILE, fallback);
    return state && typeof state.active === "boolean" ? state : fallback;
  }

  async saveEmergencyStopState(state: EmergencyStopState): Promise<void> {
    await safeWriteFile(EMERGENCY_FILE, state);
  }

  // ── Lost-Device Records (Phase 28) ──────────────────────────────────────
  async listLostDeviceRecords(): Promise<LostDeviceRecord[]> {
    const arr = await safeReadFile<LostDeviceRecord[]>(LOST_DEVICES_FILE, []);
    return Array.isArray(arr) ? arr : [];
  }

  async getLostDeviceRecord(deviceId: string): Promise<LostDeviceRecord | undefined> {
    const records = await this.listLostDeviceRecords();
    return records.find((r) => r.deviceId === deviceId);
  }

  async saveLostDeviceRecord(record: LostDeviceRecord): Promise<void> {
    const records = await this.listLostDeviceRecords();
    const index = records.findIndex((r) => r.deviceId === record.deviceId);
    if (index >= 0) {
      records[index] = record;
    } else {
      records.unshift(record);
    }
    await safeWriteFile(LOST_DEVICES_FILE, records.slice(0, 200));
  }

  async deleteLostDeviceRecord(deviceId: string): Promise<boolean> {
    const records = await this.listLostDeviceRecords();
    const filtered = records.filter((r) => r.deviceId !== deviceId);
    if (filtered.length !== records.length) {
      await safeWriteFile(LOST_DEVICES_FILE, filtered);
      return true;
    }
    return false;
  }

  // ── Maintenance ──────────────────────────────────────────────────────────
  async clearStore(): Promise<void> {
    await safeWriteFile(DEVICES_FILE, []);
    await safeWriteFile(EMERGENCY_FILE, { active: false });
    await safeWriteFile(LOST_DEVICES_FILE, []);
  }
}

export const remoteStore = new RemoteStore();
