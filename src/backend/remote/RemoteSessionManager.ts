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
import { emergencyStopCoordinator } from "./EmergencyStopCoordinator.ts";
import { securityPolicyEngine } from "../security/SecurityPolicyEngine.ts";
import { securityAuditLogger } from "../security/SecurityAuditLogger.ts";

import {
  hashDeviceIdSafe,
  classifyDisconnectFailure,
  sanitizeDiagnosticString,
  type CanonicalConnectionState,
  type GeminiSessionState,
  type RemoteFailureClass,
} from "../../lib/connectionStateMachine.ts";

export interface ActiveRemoteClient {
  session: RemoteSession;
  ws: any;
  lastHeartbeatMs: number;
  heartbeatTimeoutMs: number;
  geminiState: GeminiSessionState;
}

export interface DeviceConnectionTelemetry {
  deviceId: string;
  connectionState: CanonicalConnectionState;
  geminiState: GeminiSessionState;
  lastHeartbeat: string | null;
  lastGeminiTimestamp: string | null;
  reconnectAttempt: number;
  lastCloseCode: number | null;
  lastFailureClass: RemoteFailureClass;
}

export class RemoteSessionManager {
  private _activeClients = new Map<string, ActiveRemoteClient>(); // sessionId -> client
  private _deviceTelemetry = new Map<string, DeviceConnectionTelemetry>(); // deviceId -> telemetry
  private _pendingDesktopCalls = new Map<string, {
    targetSessionId: string;
    targetDeviceId: string;
    tool: string;
    resolve: (res: { ok: boolean; result?: unknown; error?: string }) => void;
    timer: NodeJS.Timeout;
  }>();

  resetForTesting(): void {
    this._activeClients.clear();
    this._deviceTelemetry.clear();
    for (const pending of this._pendingDesktopCalls.values()) {
      clearTimeout(pending.timer);
    }
    this._pendingDesktopCalls.clear();
  }

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

    let device = await remoteStore.getDevice(verification.deviceId);
    if (!device) {
      // Check if device was recorded as lost/revoked before allowing recovery
      const lostRecord = await remoteStore.getLostDeviceRecord(verification.deviceId);
      if (lostRecord) {
        return null;
      }

      // If the token was authentically signed by this server's persistent HMAC secret,
      // recover the device registration preserving its signed role claim so ephemeral
      // container restarts neither lock out legitimate devices nor invert admin/standard roles.
      const existingDevices = await remoteStore.listDevices({ skipAutoAdminPromotion: true });
      const hasExistingAdmin = existingDevices.some((d) => d.role === "admin" && !d.revoked);
      const resolvedRole: DeviceRole = verification.role
        ? verification.role === "admin" && hasExistingAdmin
          ? "standard"
          : verification.role
        : existingDevices.length === 0
        ? "admin"
        : "standard";

      const restoredDevice: PairedDevice = {
        id: verification.deviceId,
        name: userAgent?.includes("Android") ? "Android Companion" : "Paired Companion",
        deviceType: verification.deviceType || (userAgent?.includes("Android") ? "mobile" : "browser"),
        role: resolvedRole,
        roleExplicit: true,
        tokenHash: pairingManager.hashToken(cleanToken),
        pairedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        lastIp: ipAddress,
        userAgent,
        revoked: false,
      };
      await remoteStore.saveDevice(restoredDevice);
      device = restoredDevice;
    }

    if (device.revoked) {
      return null;
    }

    // Verify token hash matches stored hash (or bind hash if provisionally restored from signed access token)
    const inputHash = pairingManager.hashToken(cleanToken);
    if (!device.tokenHash) {
      device.tokenHash = inputHash;
    } else {
      const inputBuf = Buffer.from(inputHash);
      const storedBuf = Buffer.from(device.tokenHash);
      if (inputBuf.length !== storedBuf.length || !crypto.timingSafeEqual(inputBuf, storedBuf)) {
        return null;
      }
    }

    // Update last seen metadata
    device.lastSeenAt = new Date().toISOString();
    device.lastIp = ipAddress;
    device.userAgent = userAgent;
    await remoteStore.saveDevice(device);

    return device;
  }

  // ---------------------------------------------------------------------------
  // Active Connection Management & Platform-Aware Heartbeat
  // ---------------------------------------------------------------------------

  registerClient(
    ws: any,
    device: PairedDevice,
    ipAddress: string,
    userAgent: string,
    options?: { heartbeatTimeoutMs?: number },
  ): RemoteSession {
    const sessionId = crypto.randomUUID();
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();

    const isMobile =
      device.deviceType === "mobile" ||
      /android|iphone|ipad|mobile/i.test(userAgent || "");
    const defaultTimeout = isMobile
      ? parseInt(process.env.MYRAA_WS_HEARTBEAT_TIMEOUT_MOBILE_MS || "60000", 10)
      : parseInt(process.env.MYRAA_WS_HEARTBEAT_TIMEOUT_MS || "45000", 10);
    const heartbeatTimeoutMs = options?.heartbeatTimeoutMs ?? defaultTimeout;

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

    (ws as any).remoteSession = session;
    (ws as any).remoteSessionId = sessionId;

    this._activeClients.set(sessionId, {
      session,
      ws,
      lastHeartbeatMs: nowMs,
      heartbeatTimeoutMs,
      geminiState: "STARTING_GEMINI",
    });

    const prevTelemetry = this._deviceTelemetry.get(device.id);
    this._deviceTelemetry.set(device.id, {
      deviceId: device.id,
      connectionState: "CONNECTED",
      geminiState: "STARTING_GEMINI",
      lastHeartbeat: now,
      lastGeminiTimestamp: prevTelemetry?.lastGeminiTimestamp ?? null,
      reconnectAttempt: 0,
      lastCloseCode: prevTelemetry?.lastCloseCode ?? null,
      lastFailureClass: "NONE",
    });

    // Persist safe session snapshot asynchronously
    remoteStore
      .saveSessionSnapshot({
        deviceId: device.id,
        deviceType: device.deviceType,
        sessionId,
        conversationId: `conv_${device.id}`,
        connectionState: "CONNECTED",
        geminiState: "STARTING_GEMINI",
        lastHeartbeat: now,
        reconnectAttempt: 0,
        lastFailureClass: "NONE",
      })
      .catch(() => {});

    if (typeof ws.on === "function") {
      ws.on("pong", () => {
        this.recordHeartbeat(sessionId);
      });

      ws.on("close", (code?: number, reasonBuf?: Buffer | string) => {
        this._activeClients.delete(sessionId);
        const closeCode = typeof code === "number" ? code : 1006;
        const rawReason = reasonBuf ? String(reasonBuf) : "";
        const { failureClass } = classifyDisconnectFailure(closeCode, rawReason);
        const currentTel = this._deviceTelemetry.get(device.id);
        this._deviceTelemetry.set(device.id, {
          deviceId: device.id,
          connectionState: "DISCONNECTED",
          geminiState: "CLOSED",
          lastHeartbeat: currentTel?.lastHeartbeat || now,
          lastGeminiTimestamp: currentTel?.lastGeminiTimestamp ?? null,
          reconnectAttempt: (currentTel?.reconnectAttempt ?? 0) + (closeCode === 1000 ? 0 : 1),
          lastCloseCode: closeCode,
          lastFailureClass: closeCode === 1000 ? "NONE" : failureClass,
        });
        remoteStore
          .saveSessionSnapshot({
            deviceId: device.id,
            deviceType: device.deviceType,
            sessionId,
            connectionState: "DISCONNECTED",
            geminiState: "CLOSED",
            lastCloseCode: closeCode,
            lastFailureClass: closeCode === 1000 ? "NONE" : failureClass,
          })
          .catch(() => {});
        console.log(
          `[RemoteSession] Session '${sessionId}' disconnected (deviceHash=${hashDeviceIdSafe(device.id)} code=${closeCode} failureClass=${closeCode === 1000 ? "NONE" : failureClass}).`,
        );
      });
    }

    console.log(
      `[RemoteSession] Registered active remote session '${sessionId}' (deviceHash=${hashDeviceIdSafe(device.id)} role=${device.role}).`,
    );
    return session;
  }

  /**
   * Updates heartbeat timestamp for an active session (called on ping, pong, or incoming client frames).
   */
  recordHeartbeat(sessionIdOrDeviceId: string, nowMs = Date.now()): boolean {
    const iso = new Date(nowMs).toISOString();
    const bySession = this._activeClients.get(sessionIdOrDeviceId);
    if (bySession) {
      bySession.lastHeartbeatMs = nowMs;
      bySession.session.lastHeartbeatAt = iso;
      const tel = this._deviceTelemetry.get(bySession.session.deviceId);
      if (tel) {
        tel.lastHeartbeat = iso;
      }
      return true;
    }

    for (const client of this._activeClients.values()) {
      if (client.session.deviceId === sessionIdOrDeviceId) {
        client.lastHeartbeatMs = nowMs;
        client.session.lastHeartbeatAt = iso;
        const tel = this._deviceTelemetry.get(sessionIdOrDeviceId);
        if (tel) {
          tel.lastHeartbeat = iso;
        }
        return true;
      }
    }
    return false;
  }

  /**
   * Sweeps active connections, sends protocol ping frames, and closes any dead connections
   * that have exceeded their platform-specific heartbeat timeout.
   */
  checkHeartbeats(nowMs = Date.now()): { pinged: number; terminated: string[] } {
    let pinged = 0;
    const terminated: string[] = [];

    for (const [sessionId, client] of this._activeClients.entries()) {
      const elapsed = nowMs - client.lastHeartbeatMs;
      if (elapsed > client.heartbeatTimeoutMs) {
        terminated.push(sessionId);
        const deviceId = client.session.deviceId;
        const tel = this._deviceTelemetry.get(deviceId);
        this._deviceTelemetry.set(deviceId, {
          deviceId,
          connectionState: "DISCONNECTED",
          geminiState: "CLOSED",
          lastHeartbeat: tel?.lastHeartbeat || client.session.lastHeartbeatAt,
          lastGeminiTimestamp: tel?.lastGeminiTimestamp ?? null,
          reconnectAttempt: (tel?.reconnectAttempt ?? 0) + 1,
          lastCloseCode: 4000,
          lastFailureClass: "HEARTBEAT_TIMEOUT",
        });
        try {
          client.ws.close(4000, "HEARTBEAT_TIMEOUT: Connection unresponsive");
        } catch {
          /* ignore */
        }
        this._activeClients.delete(sessionId);
        console.warn(
          `[RemoteSession] Terminated unresponsive session '${sessionId}' (deviceHash=${hashDeviceIdSafe(deviceId)} elapsedMs=${elapsed}).`,
        );
        continue;
      }

      if (client.ws && client.ws.readyState === 1) {
        try {
          if (typeof client.ws.ping === "function") {
            client.ws.ping();
          }
          pinged++;
        } catch {
          /* ignore */
        }
      }
    }

    return { pinged, terminated };
  }

  /**
   * Updates the Gemini Live state and connection state for a device and persists a safe snapshot.
   */
  async updateDeviceSessionState(
    deviceId: string,
    updates: {
      connectionState?: CanonicalConnectionState;
      geminiState?: GeminiSessionState;
      lastGeminiTimestamp?: string;
      lastCloseCode?: number | null;
      lastFailureClass?: RemoteFailureClass;
      reconnectAttempt?: number;
      recentContext?: { role: "user" | "model"; text: string }[];
    },
  ): Promise<void> {
    if (!deviceId) return;
    const now = new Date().toISOString();
    const existing = this._deviceTelemetry.get(deviceId) || {
      deviceId,
      connectionState: "CONNECTED",
      geminiState: "IDLE",
      lastHeartbeat: now,
      lastGeminiTimestamp: null,
      reconnectAttempt: 0,
      lastCloseCode: null,
      lastFailureClass: "NONE",
    };

    const nextTelemetry: DeviceConnectionTelemetry = {
      ...existing,
      connectionState: updates.connectionState ?? existing.connectionState,
      geminiState: updates.geminiState ?? existing.geminiState,
      lastGeminiTimestamp: updates.lastGeminiTimestamp ?? existing.lastGeminiTimestamp,
      lastCloseCode: updates.lastCloseCode !== undefined ? updates.lastCloseCode : existing.lastCloseCode,
      lastFailureClass: updates.lastFailureClass ?? existing.lastFailureClass,
      reconnectAttempt: updates.reconnectAttempt ?? existing.reconnectAttempt,
      lastHeartbeat: now,
    };
    this._deviceTelemetry.set(deviceId, nextTelemetry);

    for (const client of this._activeClients.values()) {
      if (client.session.deviceId === deviceId && updates.geminiState) {
        client.geminiState = updates.geminiState;
      }
    }

    await remoteStore.saveSessionSnapshot({
      deviceId,
      connectionState: nextTelemetry.connectionState,
      geminiState: nextTelemetry.geminiState,
      lastHeartbeat: nextTelemetry.lastHeartbeat || now,
      lastGeminiTimestamp: nextTelemetry.lastGeminiTimestamp,
      lastCloseCode: nextTelemetry.lastCloseCode,
      lastFailureClass: nextTelemetry.lastFailureClass,
      reconnectAttempt: nextTelemetry.reconnectAttempt,
      recentContext: updates.recentContext,
    });
  }

  /**
   * Returns safe, token-free connection observability status for GET /api/remote/connection-status.
   */
  async getConnectionStatus(params: {
    deviceId?: string;
    authenticated: boolean;
    deviceAuthorized: boolean;
    accessTokenExpiry: string | null;
    failureReason?: string;
  }): Promise<{
    connectionState: CanonicalConnectionState;
    authenticated: boolean;
    deviceAuthorized: boolean;
    accessTokenExpiry: string | null;
    lastHeartbeat: string | null;
    reconnectAttempt: number;
    lastCloseCode: number | null;
    lastFailureClass: RemoteFailureClass;
    geminiState: GeminiSessionState;
  }> {
    const { deviceId, authenticated, deviceAuthorized, accessTokenExpiry, failureReason } = params;
    if (!deviceId) {
      const failure = failureReason
        ? classifyDisconnectFailure(null, failureReason, /TOKEN_EXPIRED/i.test(failureReason)).failureClass
        : "NONE";
      return {
        connectionState: authenticated ? "CONNECTED" : "DISCONNECTED",
        authenticated,
        deviceAuthorized,
        accessTokenExpiry,
        lastHeartbeat: null,
        reconnectAttempt: 0,
        lastCloseCode: null,
        lastFailureClass: failure,
        geminiState: "IDLE",
      };
    }

    const activeClient = this.getClientForDevice(deviceId);
    const telemetry = this._deviceTelemetry.get(deviceId);
    const snapshot = await remoteStore.getSessionSnapshot(deviceId);

    const geminiState: GeminiSessionState =
      activeClient?.geminiState ||
      telemetry?.geminiState ||
      (snapshot?.geminiState as GeminiSessionState) ||
      "IDLE";

    const connectionState: CanonicalConnectionState = activeClient
      ? geminiState === "READY"
        ? "READY"
        : geminiState === "STARTING_GEMINI" || geminiState === "RECREATING"
        ? "STARTING_GEMINI"
        : "CONNECTED"
      : (telemetry?.connectionState as CanonicalConnectionState) ||
        (snapshot?.connectionState as CanonicalConnectionState) ||
        "DISCONNECTED";

    return {
      connectionState,
      authenticated,
      deviceAuthorized,
      accessTokenExpiry,
      lastHeartbeat:
        activeClient?.session.lastHeartbeatAt ||
        telemetry?.lastHeartbeat ||
        snapshot?.lastHeartbeat ||
        null,
      reconnectAttempt: telemetry?.reconnectAttempt ?? snapshot?.reconnectAttempt ?? 0,
      lastCloseCode: telemetry?.lastCloseCode ?? snapshot?.lastCloseCode ?? null,
      lastFailureClass:
        (telemetry?.lastFailureClass as RemoteFailureClass) ||
        (snapshot?.lastFailureClass as RemoteFailureClass) ||
        "NONE",
      geminiState,
    };
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
    await remoteStore.deleteSessionSnapshot(deviceId);

    this._deviceTelemetry.set(deviceId, {
      deviceId,
      connectionState: "FAILED",
      geminiState: "CLOSED",
      lastHeartbeat: new Date().toISOString(),
      lastGeminiTimestamp: null,
      reconnectAttempt: 0,
      lastCloseCode: 4401,
      lastFailureClass: "DEVICE_REVOKED",
    });

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
   * Find an active connected Windows / Desktop companion client.
   * Matches Windows OS user-agent, desktop device types, or non-mobile companions.
   */
  getActiveDesktopCompanion(): ActiveRemoteClient | null {
    for (const client of this._activeClients.values()) {
      if (client.ws && client.ws.readyState === 1) {
        const ua = (client.session.userAgent || "").toLowerCase();
        const name = (client.session.deviceName || "").toLowerCase();
        const isMobile = ua.includes("android") || ua.includes("iphone") || ua.includes("ipad") || ua.includes("mobile");
        const isDesktop =
          ua.includes("windows") ||
          ua.includes("win64") ||
          ua.includes("win32") ||
          ua.includes("electron") ||
          ua.includes("macintosh") ||
          ua.includes("x11") ||
          name.includes("pc") ||
          name.includes("desktop") ||
          name.includes("windows");
        if (isDesktop && !isMobile) {
          return client;
        }
      }
    }
    // Fallback: any active client that is not explicitly mobile
    for (const client of this._activeClients.values()) {
      if (client.ws && client.ws.readyState === 1) {
        const ua = (client.session.userAgent || "").toLowerCase();
        const isMobile = ua.includes("android") || ua.includes("iphone") || ua.includes("ipad") || ua.includes("mobile");
        if (!isMobile) {
          return client;
        }
      }
    }
    return null;
  }

  /**
   * Forward a desktop tool execution request to an authenticated Windows desktop companion.
   * Waits for the desktop companion to execute locally and return the result over WebSocket.
   */
  async executeOnDesktopCompanion(
    tool: string,
    args: Record<string, unknown>,
    timeoutMs = 15000
  ): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    // 1. Emergency Stop Check
    if (emergencyStopCoordinator.isActive()) {
      return {
        ok: false,
        error: "EMERGENCY_STOP_ACTIVE: Desktop RPC blocked — killswitch is active.",
      };
    }

    // 2. Security Lockdown Check
    if (securityPolicyEngine.getMode() === "LOCKDOWN") {
      return {
        ok: false,
        error: "SECURITY_LOCKDOWN: Desktop RPC suspended due to active security lockdown.",
      };
    }

    const desktopClient = this.getActiveDesktopCompanion();
    if (!desktopClient) {
      return {
        ok: false,
        error: "Windows desktop companion is not currently connected. Please ensure MYRAA is running on your PC.",
      };
    }

    // 3. Verify target device registration & non-revocation
    const device = await remoteStore.getDevice(desktopClient.session.deviceId);
    if (!device || device.revoked) {
      return {
        ok: false,
        error: "DEVICE_REVOKED: Target desktop companion is revoked or no longer authorized.",
      };
    }

    const callId = `dtc_${crypto.randomUUID()}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._pendingDesktopCalls.delete(callId);
        resolve({
          ok: false,
          error: `Desktop tool '${tool}' timed out after ${Math.round(timeoutMs / 1000)}s on Windows companion.`,
        });
      }, timeoutMs);

      this._pendingDesktopCalls.set(callId, {
        targetSessionId: desktopClient.session.sessionId,
        targetDeviceId: desktopClient.session.deviceId,
        tool,
        resolve,
        timer,
      });

      // Audit dispatch
      try {
        securityAuditLogger.logEvent({
          eventType: "TOOL_ALLOW",
          actor: {
            identityId: desktopClient.session.deviceId,
            role: desktopClient.session.role,
            sessionId: desktopClient.session.sessionId,
            deviceId: desktopClient.session.deviceId,
            ipAddress: desktopClient.session.ipAddress,
            isLocal: false,
          },
          target: {
            toolName: tool,
            resource: `desktop_agent:${tool}`,
          },
          decision: "ALLOW",
          reason: `Cross-device desktop RPC call '${tool}' dispatched to Windows companion.`,
          riskLevel: "LOW",
          metadata: {
            callId,
            tool,
            deviceName: desktopClient.session.deviceName,
          },
        });
      } catch {}

      try {
        desktopClient.ws.send(
          JSON.stringify({
            type: "desktop_tool_call",
            callId,
            name: tool,
            args,
          })
        );
      } catch (err: any) {
        clearTimeout(timer);
        this._pendingDesktopCalls.delete(callId);
        resolve({
          ok: false,
          error: `Failed to transmit command to Windows desktop companion: ${err?.message || err}`,
        });
      }
    });
  }

  /**
   * Process incoming desktop tool execution responses from a desktop companion client.
   */
  handleDesktopToolResponse(msg: any, fromSessionId?: string): boolean {
    const callId = msg.id || msg.callId;
    if (!callId) return false;
    const pending = this._pendingDesktopCalls.get(callId);
    if (pending) {
      // Validate response arrives from the designated recipient session
      if (fromSessionId && pending.targetSessionId && fromSessionId !== pending.targetSessionId) {
        console.warn(
          `[RemoteSessionManager] Rejecting desktop tool response: sessionId mismatch (${fromSessionId} !== ${pending.targetSessionId})`
        );
        return false;
      }

      clearTimeout(pending.timer);
      this._pendingDesktopCalls.delete(callId);

      const isOk = msg.ok !== false && !msg.error;
      pending.resolve({
        ok: isOk,
        result: msg.result ?? msg.output,
        error: msg.error,
      });

      try {
        securityAuditLogger.logEvent({
          eventType: isOk ? "TOOL_ALLOW" : "TOOL_BLOCKED",
          actor: {
            identityId: pending.targetDeviceId,
            role: "standard",
            sessionId: pending.targetSessionId,
            deviceId: pending.targetDeviceId,
            ipAddress: "127.0.0.1",
            isLocal: false,
          },
          target: {
            toolName: pending.tool,
            resource: `desktop_agent:${pending.tool}`,
          },
          decision: isOk ? "ALLOW" : "BLOCK",
          reason: isOk ? "Desktop RPC completed successfully." : `Desktop RPC returned error: ${msg.error}`,
          riskLevel: "LOW",
          metadata: {
            callId,
            tool: pending.tool,
            ok: isOk,
          },
        });
      } catch {}

      return true;
    }
    return false;
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
