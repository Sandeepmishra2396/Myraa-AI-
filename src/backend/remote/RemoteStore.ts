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
import type {
  PairedDevice,
  EmergencyStopState,
  RemoteSessionSnapshot,
  SafeConversationTurn,
} from "./RemoteTypes.ts";
import {
  MAX_SNAPSHOT_CONTEXT_TURNS,
  MAX_SNAPSHOT_TURN_CHARS,
} from "./RemoteTypes.ts";
import type { LostDeviceRecord } from "../security/AndroidSecurityTypes.ts";
import { sanitizeDiagnosticString } from "../../lib/connectionStateMachine.ts";

const devicesFile = () => dataFile("remote_devices.json");
const emergencyFile = () => dataFile("remote_emergency_stop.json");
const lostDevicesFile = () => dataFile("remote_lost_devices.json"); // Phase 28
const sessionSnapshotsFile = () => dataFile("remote_session_snapshots.json");

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
  async listDevices(options?: { skipAutoAdminPromotion?: boolean }): Promise<PairedDevice[]> {
    const arr = await safeReadFile<PairedDevice[]>(devicesFile(), []);
    const devices = Array.isArray(arr) ? arr : [];

    // Auto-recover legacy sole device ONLY if it was not explicitly assigned a non-admin role
    if (
      !options?.skipAutoAdminPromotion &&
      devices.length === 1 &&
      devices[0].role !== "admin" &&
      !devices[0].revoked &&
      !devices[0].roleExplicit
    ) {
      await this.recoverSoleAdminDevice();
      const updated = await safeReadFile<PairedDevice[]>(devicesFile(), []);
      return Array.isArray(updated) ? updated : devices;
    }

    return devices;
  }

  /**
   * Deterministic, idempotent, server-authoritative recovery for the initial legacy device:
   * If exactly one device exists, no device holds the 'admin' role, and that sole device
   * is active (not revoked) and was not explicitly paired/recovered as a non-admin role,
   * promote it to 'admin'.
   * Safe across restarts and audited in the security audit ledger.
   */
  async recoverSoleAdminDevice(): Promise<{ recovered: boolean; deviceId?: string }> {
    const arr = await safeReadFile<PairedDevice[]>(devicesFile(), []);
    const devices = Array.isArray(arr) ? arr : [];
    if (devices.length !== 1) {
      return { recovered: false };
    }

    const soleDevice = devices[0];
    if (soleDevice.role === "admin") {
      return { recovered: false };
    }
    if (soleDevice.revoked || soleDevice.roleExplicit) {
      return { recovered: false };
    }

    soleDevice.role = "admin";
    soleDevice.lastSeenAt = new Date().toISOString();
    await safeWriteFile(devicesFile(), [soleDevice]);

    try {
      const { securityAuditLogger } = await import("../security/SecurityAuditLogger.ts");
      securityAuditLogger.logEvent({
        eventType: "ADMIN_RECOVERY",
        actor: {
          identityId: soleDevice.id,
          role: "admin",
          ipAddress: soleDevice.lastIp || "127.0.0.1",
          deviceId: soleDevice.id,
        },
        target: {
          resource: `device:${soleDevice.id}`,
        },
        decision: "ALLOW",
        reason: "Sole active device promoted to admin",
        metadata: {
          deviceName: soleDevice.name,
          deviceId: soleDevice.id,
        },
      });
    } catch {
      /* audit logging best-effort */
    }

    console.log(`[RemoteStore] Sole device '${soleDevice.name}' (ID: ${soleDevice.id}) safely promoted to admin.`);
    return { recovered: true, deviceId: soleDevice.id };
  }

  async getDevice(id: string): Promise<PairedDevice | undefined> {
    const devices = await this.listDevices();
    return devices.find((d) => d.id === id);
  }

  async saveDevice(device: PairedDevice): Promise<void> {
    const raw = await safeReadFile<PairedDevice[]>(devicesFile(), []);
    const devices = Array.isArray(raw) ? raw : [];
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
    await safeWriteFile(devicesFile(), bounded);
  }

  async deleteDevice(id: string): Promise<boolean> {
    const raw = await safeReadFile<PairedDevice[]>(devicesFile(), []);
    const devices = Array.isArray(raw) ? raw : [];
    const filtered = devices.filter((d) => d.id !== id);
    if (filtered.length !== devices.length) {
      await safeWriteFile(devicesFile(), filtered);
      return true;
    }
    return false;
  }

  // ── Emergency Stop State ─────────────────────────────────────────────────
  async getEmergencyStopState(): Promise<EmergencyStopState> {
    const fallback: EmergencyStopState = { active: false };
    const state = await safeReadFile<EmergencyStopState>(emergencyFile(), fallback);
    return state && typeof state.active === "boolean" ? state : fallback;
  }

  async saveEmergencyStopState(state: EmergencyStopState): Promise<void> {
    await safeWriteFile(emergencyFile(), state);
  }

  // ── Lost-Device Records (Phase 28) ──────────────────────────────────────
  async listLostDeviceRecords(): Promise<LostDeviceRecord[]> {
    const arr = await safeReadFile<LostDeviceRecord[]>(lostDevicesFile(), []);
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
    await safeWriteFile(lostDevicesFile(), records.slice(0, 200));
  }

  async deleteLostDeviceRecord(deviceId: string): Promise<boolean> {
    const records = await this.listLostDeviceRecords();
    const filtered = records.filter((r) => r.deviceId !== deviceId);
    if (filtered.length !== records.length) {
      await safeWriteFile(lostDevicesFile(), filtered);
      return true;
    }
    return false;
  }

  // ── Safe Session Snapshots ───────────────────────────────────────────────
  /**
   * Sanitizes conversation context turns and strips any forbidden secret/audio fields.
   * Ensures snapshots never persist raw audio, tokens, API keys, or secrets.
   */
  sanitizeSessionSnapshot(snapshot: Partial<RemoteSessionSnapshot> & { deviceId: string }): RemoteSessionSnapshot {
    const rawTurns = Array.isArray(snapshot.recentContext) ? snapshot.recentContext : [];
    const safeTurns: SafeConversationTurn[] = rawTurns
      .filter((t) => t && (t.role === "user" || t.role === "model") && typeof t.text === "string" && t.text.trim().length > 0)
      .slice(-MAX_SNAPSHOT_CONTEXT_TURNS)
      .map((t) => ({
        role: t.role,
        text: sanitizeDiagnosticString(t.text.trim()).slice(0, MAX_SNAPSHOT_TURN_CHARS),
        timestamp: t.timestamp || new Date().toISOString(),
      }));

    const now = new Date().toISOString();
    return {
      deviceId: String(snapshot.deviceId),
      deviceType: snapshot.deviceType || "browser",
      sessionId: String(snapshot.sessionId || "restored_session"),
      conversationId: String(snapshot.conversationId || `conv_${snapshot.deviceId}`),
      taskId: snapshot.taskId ? String(snapshot.taskId) : undefined,
      recentContext: safeTurns,
      activeTaskMetadata: snapshot.activeTaskMetadata
        ? {
            taskId: String(snapshot.activeTaskMetadata.taskId),
            title: snapshot.activeTaskMetadata.title
              ? sanitizeDiagnosticString(snapshot.activeTaskMetadata.title).slice(0, 200)
              : undefined,
            status: snapshot.activeTaskMetadata.status || "running",
            stepIndex: snapshot.activeTaskMetadata.stepIndex,
            updatedAt: snapshot.activeTaskMetadata.updatedAt || now,
          }
        : null,
      connectionState: String(snapshot.connectionState || "CONNECTED"),
      geminiState: String(snapshot.geminiState || "IDLE"),
      lastHeartbeat: snapshot.lastHeartbeat || now,
      lastGeminiTimestamp: snapshot.lastGeminiTimestamp ?? null,
      lastCloseCode: snapshot.lastCloseCode ?? null,
      lastFailureClass: snapshot.lastFailureClass || "NONE",
      reconnectAttempt: snapshot.reconnectAttempt ?? 0,
      version: typeof snapshot.version === "number" && snapshot.version > 0 ? snapshot.version : 1,
      updatedAt: now,
    };
  }

  async listSessionSnapshots(): Promise<RemoteSessionSnapshot[]> {
    const arr = await safeReadFile<RemoteSessionSnapshot[]>(sessionSnapshotsFile(), []);
    return Array.isArray(arr) ? arr : [];
  }

  async getSessionSnapshot(deviceId: string): Promise<RemoteSessionSnapshot | undefined> {
    if (!deviceId) return undefined;
    const list = await this.listSessionSnapshots();
    return list.find((s) => s.deviceId === deviceId);
  }

  async saveSessionSnapshot(
    snapshotInput: Partial<RemoteSessionSnapshot> & { deviceId: string },
  ): Promise<RemoteSessionSnapshot> {
    const list = await this.listSessionSnapshots();
    const existingIdx = list.findIndex((s) => s.deviceId === snapshotInput.deviceId);
    const existing = existingIdx >= 0 ? list[existingIdx] : undefined;

    const merged: Partial<RemoteSessionSnapshot> & { deviceId: string } = {
      ...(existing || {}),
      ...snapshotInput,
      recentContext: snapshotInput.recentContext !== undefined
        ? snapshotInput.recentContext
        : existing?.recentContext || [],
      version: (existing?.version || 0) + 1,
    };

    const clean = this.sanitizeSessionSnapshot(merged);
    if (existingIdx >= 0) {
      list[existingIdx] = clean;
    } else {
      list.unshift(clean);
    }

    await safeWriteFile(sessionSnapshotsFile(), list.slice(0, 50));
    return clean;
  }

  async deleteSessionSnapshot(deviceId: string): Promise<boolean> {
    const list = await this.listSessionSnapshots();
    const filtered = list.filter((s) => s.deviceId !== deviceId);
    if (filtered.length !== list.length) {
      await safeWriteFile(sessionSnapshotsFile(), filtered);
      return true;
    }
    return false;
  }

  // ── Maintenance ──────────────────────────────────────────────────────────
  async clearStore(): Promise<void> {
    await safeWriteFile(devicesFile(), []);
    await safeWriteFile(emergencyFile(), { active: false });
    await safeWriteFile(lostDevicesFile(), []);
    await safeWriteFile(sessionSnapshotsFile(), []);
  }
}

export const remoteStore = new RemoteStore();

