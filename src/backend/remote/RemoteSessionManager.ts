/**
 * MYRAA — RemoteSessionManager (Phase 7)
 *
 * Session lifecycle and role-based access control for remote devices:
 *   - Bearer token authentication with replay-resistant cryptographic verification
 *   - Active remote WebSocket connection tracking and heartbeats
 *   - Instant session termination upon device revocation
 *   - Server-side permission policy enforcement (read_only / standard / admin)
 *   - Remote frame and payload size validations
 */

import crypto from "crypto";
import type {
  PairedDevice,
  RemoteSession,
  DeviceRole,
} from "./RemoteTypes.ts";
import {
  MAX_REMOTE_MESSAGE_SIZE,
  MAX_AUDIO_FRAME_SIZE,
} from "./RemoteTypes.ts";
import { remoteStore } from "./RemoteStore.ts";
import { pairingManager } from "./PairingManager.ts";
import { MODIFYING_TOOLS } from "../planner/PlannerTypes.ts";

export interface ActiveRemoteClient {
  session: RemoteSession;
  ws: any;
}

export class RemoteSessionManager {
  private _activeClients = new Map<string, ActiveRemoteClient>(); // sessionId -> client

  // ---------------------------------------------------------------------------
  // Authentication & Validation
  // ---------------------------------------------------------------------------

  /**
   * Authenticate a bearer token presented by a remote client.
   * Verifies signature, device existence, hash match, and non-revocation status.
   */
  async authenticateToken(
    token: string,
    ipAddress = "unknown",
    userAgent = "unknown",
  ): Promise<PairedDevice | null> {
    if (!token || typeof token !== "string") return null;

    const cleanToken = token.startsWith("Bearer ") ? token.slice(7).trim() : token.trim();
    const verification = pairingManager.verifyDeviceToken(cleanToken);
    if (!verification.valid || !verification.deviceId) {
      return null;
    }

    const device = await remoteStore.getDevice(verification.deviceId);
    if (!device || device.revoked) {
      return null;
    }

    // Verify token hash matches stored hash
    const inputHash = pairingManager.hashToken(cleanToken);
    const inputBuf = Buffer.from(inputHash);
    const storedBuf = Buffer.from(device.tokenHash);
    if (inputBuf.length !== storedBuf.length || !crypto.timingSafeEqual(inputBuf, storedBuf)) {
      return null;
    }

    // Update last seen metadata
    device.lastSeenAt = new Date().toISOString();
    device.lastIp = ipAddress;
    device.userAgent = userAgent;
    await remoteStore.saveDevice(device);

    return device;
  }

  // ---------------------------------------------------------------------------
  // Active Connection Management
  // ---------------------------------------------------------------------------

  registerClient(ws: any, device: PairedDevice, ipAddress: string, userAgent: string): RemoteSession {
    const sessionId = crypto.randomUUID();
    const now = new Date().toISOString();

    const session: RemoteSession = {
      sessionId,
      deviceId: device.id,
      deviceName: device.name,
      role: device.role,
      connectedAt: now,
      lastHeartbeatAt: now,
      ipAddress,
      userAgent,
      authenticated: true,
    };

    this._activeClients.set(sessionId, { session, ws });

    ws.on("close", () => {
      this._activeClients.delete(sessionId);
      console.log(`[RemoteSession] Session '${sessionId}' disconnected (${device.name}).`);
    });

    console.log(`[RemoteSession] Registered active remote session '${sessionId}' for device '${device.name}' (Role: ${device.role}).`);
    return session;
  }

  getActiveSessions(): RemoteSession[] {
    return Array.from(this._activeClients.values()).map((c) => ({ ...c.session }));
  }

  /**
   * Revoke a paired device by ID.
   * Immediately invalidates device in store and tears down all active WebSocket streams.
   */
  async revokeDevice(deviceId: string, reason = "Revoked by operator"): Promise<boolean> {
    const device = await remoteStore.getDevice(deviceId);
    if (!device) return false;

    device.revoked = true;
    device.revokedAt = new Date().toISOString();
    device.revokedReason = reason;
    await remoteStore.saveDevice(device);

    // Disconnect any active connections for this device immediately
    for (const [sessionId, client] of this._activeClients.entries()) {
      if (client.session.deviceId === deviceId) {
        try {
          client.ws.send(JSON.stringify({
            type: "error",
            error: "DEVICE_REVOKED: This device has been revoked by the operator.",
          }));
          client.ws.close(4401, "Device revoked");
        } catch { /* ignore */ }
        this._activeClients.delete(sessionId);
        console.warn(`[RemoteSession] Terminated active remote session '${sessionId}' for revoked device '${device.name}'.`);
      }
    }

    return true;
  }

  /**
   * Check if any active WebSocket client is connected for a device.
   */
  getClientForDevice(deviceId: string) {
    for (const client of this._activeClients.values()) {
      if (client.session.deviceId === deviceId && client.ws.readyState === 1) {
        return client;
      }
    }
    return null;
  }

  /**
   * Send a tool/capability call to an active client for a device.
   */
  sendToolCallToDevice(
    deviceId: string,
    toolCall: { callId?: string; name: string; args: Record<string, unknown> }
  ): boolean {
    let sent = false;
    for (const client of this._activeClients.values()) {
      if (client.session.deviceId === deviceId && client.ws.readyState === 1) {
        try {
          client.ws.send(JSON.stringify({
            type: "toolCall",
            callId: toolCall.callId || crypto.randomUUID(),
            name: toolCall.name,
            args: toolCall.args,
          }));
          sent = true;
        } catch { /* ignore dropped frame */ }
      }
    }
    return sent;
  }

  /**
   * Broadcast an arbitrary JSON message to all active WebSocket connections.
   */
  broadcastToAllSessions(msg: Record<string, unknown>): number {
    let sent = 0;
    const payload = JSON.stringify(msg);
    for (const client of this._activeClients.values()) {
      if (client.ws && client.ws.readyState === 1) {
        try {
          client.ws.send(payload);
          sent++;
        } catch { /* ignore dropped frame */ }
      }
    }
    return sent;
  }

  /**
   * Terminate all active remote WebSocket connections immediately (e.g. during SECURITY_LOCKDOWN).
   */
  terminateAllRemoteConnections(reason = "SECURITY_LOCKDOWN: Remote control suspended"): number {
    let count = 0;
    for (const [sessionId, client] of this._activeClients.entries()) {
      try {
        client.ws.send(JSON.stringify({
          type: "error",
          error: reason,
        }));
        client.ws.close(4403, reason);
      } catch {
        /* best-effort */
      }
      this._activeClients.delete(sessionId);
      count++;
    }
    if (count > 0) {
      console.warn(`[RemoteSession] Terminated ${count} active remote connection(s): ${reason}`);
    }
    return count;
  }

  /**
   * Terminate a specific active remote session immediately.
   */
  terminateSession(sessionId: string, reason = "Session terminated by security containment"): boolean {
    const client = this._activeClients.get(sessionId);
    if (!client) return false;
    try {
      client.ws.send(JSON.stringify({
        type: "error",
        error: reason,
      }));
      client.ws.close(4403, reason);
    } catch {
      /* best-effort */
    }
    this._activeClients.delete(sessionId);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Permission & Role Policy Enforcement
  // ---------------------------------------------------------------------------

  /**
   * Check if a remote device role is permitted to execute the requested tool.
   * Enforces server-side boundary:
   *   - read_only: blocked from all modifying tools, plan execution, and background schedules.
   *   - standard: can query and schedule; modifying tools halt at Phase 5 confirmation checkpoint.
   *   - admin: can approve checkpoints and perform operations (still subject to safety gate).
   */
  checkToolPermission(
    role: DeviceRole,
    toolName: string,
  ): { allowed: boolean; reason?: string } {
    if (role === "read_only") {
      if (
        MODIFYING_TOOLS.has(toolName) ||
        toolName === "write_to_file" ||
        toolName === "replace_file_content" ||
        toolName === "execute_command"
      ) {
        return {
          allowed: false,
          reason: `Permission Denied: Device role 'read_only' is not authorized to execute modifying tool '${toolName}'.`,
        };
      }
      if (toolName === "scheduleTask" || toolName === "executeTaskPlan" || toolName === "confirmCheckpoint") {
        return {
          allowed: false,
          reason: `Permission Denied: Device role 'read_only' cannot schedule tasks or approve execution checkpoints.`,
        };
      }
    }

    if (role === "standard") {
      // Standard role cannot bypass checkpoints for modifying tools
      if (toolName === "confirmCheckpoint") {
        return {
          allowed: false,
          reason: `Permission Denied: Standard remote device cannot self-approve checkpoints. Confirmation must be completed by an admin or on desktop.`,
        };
      }
    }

    return { allowed: true };
  }

  // ---------------------------------------------------------------------------
  // Frame & Message Validation
  // ---------------------------------------------------------------------------

  /** Validates incoming raw message size to prevent memory exhaustion attacks. */
  validateMessageSize(byteLength: number): void {
    if (byteLength > MAX_REMOTE_MESSAGE_SIZE) {
      throw new Error(`PAYLOAD_TOO_LARGE: Remote message size (${byteLength} bytes) exceeds maximum limit (${MAX_REMOTE_MESSAGE_SIZE} bytes).`);
    }
  }

  /** Validates audio frame chunk size and base64 validity. */
  validateAudioChunk(base64Audio: string): void {
    if (!base64Audio || typeof base64Audio !== "string") {
      throw new Error("MALFORMED_AUDIO: Audio chunk must be a non-empty string.");
    }
    if (base64Audio.length > MAX_AUDIO_FRAME_SIZE * 1.4) {
      throw new Error(`AUDIO_FRAME_TOO_LARGE: Audio chunk exceeds maximum size of ${MAX_AUDIO_FRAME_SIZE} bytes.`);
    }
    // Validate base64 charset
    if (!/^[A-Za-z0-9+/=]+$/.test(base64Audio)) {
      throw new Error("MALFORMED_AUDIO: Audio chunk contains invalid base64 characters.");
    }
  }
}

export const remoteSessionManager = new RemoteSessionManager();
