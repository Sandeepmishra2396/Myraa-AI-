/**
 * MYRAA — AndroidSecurityManager (Phase 28)
 *
 * Thin orchestration layer for Android Emergency & Security Controls.
 *
 * CRITICAL ARCHITECTURE INVARIANTS:
 *   • This class is a COORDINATOR, NOT a security authority.
 *   • All security enforcement lives in existing Phase 10A–10F + Phase 17 subsystems:
 *       EmergencyStopCoordinator, ThreatContainmentManager, RemoteSecurityCoordinator,
 *       IdentityAuthManager, SecurityMonitor, SecurityAuditLogger.
 *   • Emergency Stop remains GLOBAL via EmergencyStopCoordinator.
 *   • Lost-device mode is server-authoritative — persisted in remoteStore, not device-local.
 *   • No raw tokens, credentials, or secrets are exposed to Android UI or audit records.
 *   • Security Lockdown remains independent from Emergency Stop (Phase 10D invariant).
 *   • All mutations require authenticated admin / localhost — no client self-authorization.
 */

import type {
  SecurityControlResult,
  SecurityStatusResponse,
  SuspiciousEventSummary,
  ActiveSessionSummary,
  LostDeviceRecord,
} from "./AndroidSecurityTypes.ts";
import type { SecurityContext, AuditEventType } from "./SecurityTypes.ts";
import { emergencyStopCoordinator } from "../remote/EmergencyStopCoordinator.ts";
import { remoteSecurityCoordinator } from "./RemoteSecurityCoordinator.ts";
import { identityAuthManager } from "./IdentityAuthManager.ts";
import { securityPolicyEngine } from "./SecurityPolicyEngine.ts";
import { securityAuditLogger } from "./SecurityAuditLogger.ts";
import { threatContainmentManager } from "./ThreatContainmentManager.ts";
import { remoteSessionManager } from "../remote/RemoteSessionManager.ts";
import { remoteStore } from "../remote/RemoteStore.ts";

// Audit event types from AuditEventType (all are valid)
type Phase28AuditEvent = Extract<
  AuditEventType,
  | "EMERGENCY_STOP_TRIGGERED"
  | "LOST_DEVICE_ENABLED"
  | "LOST_DEVICE_RECOVERED"
  | "LOGOUT_ALL_DEVICES"
  | "SESSION_REVOKED"
  | "DEVICE_REVOKED"
  | "LOCKDOWN_INITIATED"
  | "LOCKDOWN_RESET"
>;

export class AndroidSecurityManager {
  // ---------------------------------------------------------------------------
  // 1. Security Status Aggregation (read-only, sanitized)
  // ---------------------------------------------------------------------------

  /**
   * Returns a sanitized aggregate of the current security state.
   * No raw tokens, IPs (masked), session IDs, or credentials are included.
   */
  async getSecurityStatus(
    requestingDeviceId: string,
    _secContext: SecurityContext,
  ): Promise<SecurityStatusResponse> {
    const now = new Date().toISOString();
    const stopState = emergencyStopCoordinator.getState();
    const policyMode = securityPolicyEngine.getMode?.() || "BALANCED";
    const lockdownActive = policyMode === "LOCKDOWN";

    // Check lost-device status for this device
    const lostRecord = await remoteStore.getLostDeviceRecord(requestingDeviceId);
    const thisDeviceLostMode = !!lostRecord && !lostRecord.recovered;

    // Active session count
    const activeSessions = remoteSessionManager.getActiveSessions();

    // Sanitized suspicious events
    const recentSuspiciousEvents = this._getSanitizedSuspiciousEvents();

    return {
      emergencyStopActive: stopState.active,
      emergencyStopTriggeredAt: stopState.triggeredAt,
      emergencyStopSource: stopState.triggeredBy?.source,
      lockdownActive,
      thisDeviceLostMode,
      activeSessionCount: activeSessions.length,
      recentSuspiciousEvents,
      snapshotAt: now,
    };
  }

  /**
   * Returns sanitized active session summaries for admin inspection.
   * IPs are masked; no raw tokens or session secrets exposed.
   */
  getActiveSessions(): ActiveSessionSummary[] {
    return remoteSessionManager.getActiveSessions().map((s) => ({
      sessionId: s.sessionId,
      deviceName: s.deviceName,
      deviceType: "mobile",
      role: s.role,
      connectedAt: s.connectedAt,
      maskedIp: this._maskIp(s.ipAddress),
    }));
  }

  // ---------------------------------------------------------------------------
  // 2. Security Lockdown (delegates to Phase 10D ThreatContainmentManager)
  // ---------------------------------------------------------------------------

  /**
   * Trigger global Security Lockdown.
   * Requires admin or localhost. Uses existing ThreatContainmentManager pipeline.
   * Independent from Emergency Stop (Phase 10D invariant preserved).
   */
  async triggerLockdown(
    reason: string,
    secContext: SecurityContext,
  ): Promise<SecurityControlResult> {
    if (!this._isAdminOrLocal(secContext)) {
      return { success: false, errorCode: "UNAUTHORIZED", message: "Only admin or localhost can trigger Security Lockdown." };
    }

    const policyMode = securityPolicyEngine.getMode?.() || "BALANCED";
    if (policyMode === "LOCKDOWN") {
      return { success: false, errorCode: "ALREADY_IN_LOCKDOWN", message: "Security Lockdown is already active." };
    }

    // Use ThreatContainmentManager (Phase 10D) to initiate lockdown
    await threatContainmentManager.containThreat({
      threatName: "MOBILE_SECURITY_LOCKDOWN_REQUEST",
      severity: "CRITICAL",
      triggerEvent: "SECURITY_POLICY_VIOLATION",
      occurrences: 1,
      windowMs: 1000,
      actor: {
        identityId: secContext.identityId,
        ipAddress: secContext.ipAddress || "127.0.0.1",
        deviceId: secContext.deviceId,
      },
      target: { resource: "global_lockdown" },
      reason: `Operator-initiated lockdown from mobile device: ${reason}`,
      recommendedAction: "INITIATE_LOCKDOWN",
      mitigationAction: "LOCKDOWN_INITIATED",
    });

    this._audit("LOCKDOWN_INITIATED", secContext, "Security Lockdown triggered from Android.");
    return { success: true, message: "Security Lockdown activated. All non-recovery operations are blocked." };
  }

  /**
   * Recover from Security Lockdown.
   * Requires admin or localhost.
   */
  async recoverFromLockdown(
    secContext: SecurityContext,
  ): Promise<SecurityControlResult> {
    if (!this._isAdminOrLocal(secContext)) {
      return { success: false, errorCode: "UNAUTHORIZED", message: "Only admin or localhost can recover from Security Lockdown." };
    }

    const policyMode = securityPolicyEngine.getMode?.() || "BALANCED";
    if (policyMode !== "LOCKDOWN") {
      return { success: false, errorCode: "NOT_IN_LOCKDOWN", message: "System is not currently in Security Lockdown." };
    }

    securityPolicyEngine.setMode("BALANCED");
    this._audit("LOCKDOWN_RESET", secContext, "Security Lockdown recovered via Android admin action.");
    return { success: true, message: "Security Lockdown lifted. System returned to BALANCED mode." };
  }

  // ---------------------------------------------------------------------------
  // 3. Lost-Device Mode (server-authoritative)
  // ---------------------------------------------------------------------------

  /**
   * Enable lost-device mode for a paired device.
   * Server-authoritative: persisted in remoteStore, not device-local.
   * Immediately revokes sessions, token families, and WebSocket connections.
   */
  async enableLostDeviceMode(
    deviceId: string,
    reason: string,
    secContext: SecurityContext,
  ): Promise<SecurityControlResult> {
    if (!this._isAdminOrLocal(secContext)) {
      return { success: false, errorCode: "UNAUTHORIZED", message: "Only admin or localhost can enable lost-device mode." };
    }

    const device = await remoteStore.getDevice(deviceId);
    if (!device) {
      return { success: false, errorCode: "DEVICE_NOT_FOUND", message: `Device '${deviceId}' not found.` };
    }

    const existing = await remoteStore.getLostDeviceRecord(deviceId);
    if (existing && !existing.recovered) {
      return { success: false, errorCode: "DEVICE_ALREADY_LOST", message: `Device '${deviceId}' is already in lost-device mode.` };
    }

    // 1. Persist lost-device record (server-authoritative)
    const record: LostDeviceRecord = {
      deviceId,
      enabledAt: new Date().toISOString(),
      enabledBy: secContext.identityId,
      reason: reason || "Lost-device mode enabled by operator.",
      recovered: false,
    };
    await remoteStore.saveLostDeviceRecord(record);

    // 2. Revoke device via existing RemoteSecurityCoordinator (Phase 17)
    // This: marks device revoked in store, revokes IdentityAuthManager sessions,
    //       terminates active WebSocket connections, emits DEVICE_REVOKED audit log.
    await remoteSecurityCoordinator.revokeRemoteDevice(
      deviceId,
      `LOST_DEVICE: ${reason}`,
      secContext.ipAddress || "127.0.0.1",
    );

    // 3. Disable proactive delivery (best-effort, Phase 26)
    try {
      const { mobileProactiveManager } = await import("../companion/mobile/MobileProactiveManager.ts");
      await mobileProactiveManager.unsubscribeDevice(deviceId, {
        identityId: "system_lost_device",
        role: "admin",
        ipAddress: "127.0.0.1",
        isLocal: true,
      });
    } catch (err) {
      console.warn("[AndroidSecurityManager] Could not unsubscribe lost device from proactive:", err);
    }

    this._audit("LOST_DEVICE_ENABLED", secContext, `Lost-device mode enabled for device '${deviceId}': ${reason}`);

    return {
      success: true,
      message: `Device '${deviceId}' placed in lost-device mode. All sessions terminated. Device cannot reconnect until recovered.`,
    };
  }

  /**
   * Recover a device from lost-device mode.
   * Removes the server-side lost-device record so the device can re-pair.
   * Does NOT re-issue tokens — device must perform fresh pairing.
   */
  async recoverLostDevice(
    deviceId: string,
    secContext: SecurityContext,
  ): Promise<SecurityControlResult> {
    if (!this._isAdminOrLocal(secContext)) {
      return { success: false, errorCode: "UNAUTHORIZED", message: "Only admin or localhost can recover a lost device." };
    }

    const record = await remoteStore.getLostDeviceRecord(deviceId);
    if (!record || record.recovered) {
      return { success: false, errorCode: "DEVICE_NOT_LOST", message: `Device '${deviceId}' is not in lost-device mode.` };
    }

    // 1. Mark record as recovered
    const updatedRecord: LostDeviceRecord = {
      ...record,
      recovered: true,
      recoveredAt: new Date().toISOString(),
      recoveredBy: secContext.identityId,
    };
    await remoteStore.saveLostDeviceRecord(updatedRecord);

    // 2. Un-revoke the device in remoteStore so it can re-pair
    const device = await remoteStore.getDevice(deviceId);
    if (device) {
      device.revoked = false;
      device.revokedAt = undefined;
      device.revokedReason = undefined;
      await remoteStore.saveDevice(device);
    }

    // Device must still perform fresh pairing — no token re-issuance here.
    this._audit("LOST_DEVICE_RECOVERED", secContext, `Lost-device mode recovered for device '${deviceId}'.`);

    return {
      success: true,
      message: `Device '${deviceId}' recovered from lost-device mode. Device must perform fresh pairing to reconnect.`,
    };
  }

  // ---------------------------------------------------------------------------
  // 4. Logout All Devices
  // ---------------------------------------------------------------------------

  /**
   * Global logout: revokes all device sessions and token families.
   * Requires admin or localhost.
   * Does NOT permanently revoke device registrations — devices must re-authenticate.
   */
  async logoutAllDevices(
    reason: string,
    secContext: SecurityContext,
  ): Promise<SecurityControlResult> {
    if (!this._isAdminOrLocal(secContext)) {
      return { success: false, errorCode: "UNAUTHORIZED", message: "Only admin or localhost can logout all devices." };
    }

    const allDevices = await remoteStore.listDevices();
    let revokedCount = 0;

    for (const device of allDevices) {
      if (!device.revoked) {
        // Revoke all sessions + token families for this device
        identityAuthManager.revokeDevice(device.id, reason || "Global logout by operator");
        revokedCount++;
      }
    }

    // Terminate all active WebSocket connections
    const closedCount = remoteSessionManager.terminateAllRemoteConnections(
      `LOGOUT_ALL: ${reason || "Operator initiated global logout"}`
    );

    this._audit("LOGOUT_ALL_DEVICES", secContext, `Global logout: ${revokedCount} device session families revoked, ${closedCount} WebSocket connections closed.`);

    return {
      success: true,
      message: `Logged out ${revokedCount} device(s). ${closedCount} active WebSocket connection(s) terminated. All devices must re-authenticate.`,
    };
  }

  // ---------------------------------------------------------------------------
  // 5. Session Termination
  // ---------------------------------------------------------------------------

  /**
   * Terminate a single active remote session.
   * Admin, localhost, or session owner (same device).
   */
  terminateSession(
    sessionId: string,
    reason: string,
    secContext: SecurityContext,
  ): SecurityControlResult {
    const sessions = remoteSessionManager.getActiveSessions();
    const target = sessions.find((s) => s.sessionId === sessionId);

    if (!target) {
      return { success: false, errorCode: "DEVICE_NOT_FOUND", message: `Session '${sessionId}' not found or already closed.` };
    }

    // Allow admin / localhost / session owner (same device)
    const isOwner = target.deviceId === secContext.deviceId;
    if (!this._isAdminOrLocal(secContext) && !isOwner) {
      return { success: false, errorCode: "UNAUTHORIZED", message: "Permission denied. You can only terminate your own sessions unless you are an admin." };
    }

    const terminated = remoteSessionManager.terminateSession(sessionId, reason || "Terminated by operator");

    if (terminated) {
      // Also revoke the session in IdentityAuthManager
      try {
        identityAuthManager.revokeSession(sessionId, reason || "Terminated by operator");
      } catch {
        /* best-effort — session may already be gone */
      }
      this._audit("SESSION_REVOKED", secContext, `Session '${sessionId}' terminated for device '${target.deviceName}'.`);
    }

    return {
      success: terminated,
      message: terminated ? `Session '${sessionId}' terminated.` : `Failed to terminate session '${sessionId}'.`,
    };
  }

  /**
   * Terminate all active remote sessions.
   * Requires admin or localhost.
   */
  terminateAllSessions(
    reason: string,
    secContext: SecurityContext,
  ): SecurityControlResult {
    if (!this._isAdminOrLocal(secContext)) {
      return { success: false, errorCode: "UNAUTHORIZED", message: "Only admin or localhost can terminate all sessions." };
    }

    const count = remoteSessionManager.terminateAllRemoteConnections(
      reason || "All sessions terminated by operator"
    );

    this._audit("SESSION_REVOKED", secContext, `All remote sessions terminated (${count} connections closed).`);

    return {
      success: true,
      message: `Terminated ${count} active remote session(s).`,
    };
  }

  // ---------------------------------------------------------------------------
  // 6. Sanitized Suspicious Event Surfacing
  // ---------------------------------------------------------------------------

  /**
   * Returns a sanitized summary of recent suspicious security events.
   * No raw IPs, session IDs, or token data are included.
   * The backend (SecurityMonitor + SecurityAuditLogger) remains the authority.
   */
  private _getSanitizedSuspiciousEvents(): SuspiciousEventSummary[] {
    const SUSPICIOUS_EVENT_TYPES = new Set([
      "AUTH_FAILURE",
      "TOKEN_REPLAY_DETECTED",
      "TOKEN_REUSE",
      "UNKNOWN_DEVICE",
      "REMOTE_SESSION_ANOMALY",
      "SUSPICIOUS_ACTIVITY",
      "BRUTE_FORCE_LOCKOUT",
    ]);

    const CATEGORY_MAP: Record<string, SuspiciousEventSummary["eventCategory"]> = {
      AUTH_FAILURE: "AUTH_FAILURE",
      LOGIN_FAILED: "AUTH_FAILURE",
      TOKEN_REPLAY_DETECTED: "TOKEN_REPLAY",
      TOKEN_REUSE: "TOKEN_REPLAY",
      UNKNOWN_DEVICE: "UNKNOWN_DEVICE",
      REMOTE_SESSION_ANOMALY: "REMOTE_ANOMALY",
      SUSPICIOUS_ACTIVITY: "SUSPICIOUS_ACTIVITY",
      BRUTE_FORCE_LOCKOUT: "BRUTE_FORCE",
    };

    const SEVERITY_MAP: Record<string, SuspiciousEventSummary["severityLabel"]> = {
      AUTH_FAILURE: "MEDIUM",
      TOKEN_REPLAY: "CRITICAL",
      UNKNOWN_DEVICE: "HIGH",
      REMOTE_ANOMALY: "HIGH",
      SUSPICIOUS_ACTIVITY: "HIGH",
      BRUTE_FORCE: "HIGH",
      NONCE_REPLAY: "CRITICAL",
    };

    try {
      const recentEvents = securityAuditLogger.getRecentEvents?.(50) || [];
      const countByCategory = new Map<string, { count: number; lastTime: number }>();

      for (const event of recentEvents) {
        if (!SUSPICIOUS_EVENT_TYPES.has(event.eventType)) continue;
        const cat = CATEGORY_MAP[event.eventType] || "SUSPICIOUS_ACTIVITY";
        const existing = countByCategory.get(cat) || { count: 0, lastTime: 0 };
        const ts = typeof event.timestamp === "number" ? event.timestamp : Date.parse(event.timestamp as string);
        countByCategory.set(cat, {
          count: existing.count + 1,
          lastTime: Math.max(existing.lastTime, ts || 0),
        });
      }

      const result: SuspiciousEventSummary[] = [];
      for (const [cat, data] of countByCategory.entries()) {
        // Floor to nearest minute for privacy
        const flooredMinute = new Date(Math.floor(data.lastTime / 60000) * 60000).toISOString();
        result.push({
          eventCategory: cat as SuspiciousEventSummary["eventCategory"],
          severityLabel: SEVERITY_MAP[cat] || "MEDIUM",
          approximateTime: flooredMinute,
          count: data.count,
          description: this._categoryDescription(cat as SuspiciousEventSummary["eventCategory"]),
        });
      }

      // Limit to 10 most severe events
      return result
        .sort((a, b) => this._severityScore(b.severityLabel) - this._severityScore(a.severityLabel))
        .slice(0, 10);
    } catch {
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private _isAdminOrLocal(secContext: SecurityContext): boolean {
    return secContext.isLocal === true || secContext.role === "admin";
  }

  private _maskIp(ip: string): string {
    if (!ip) return "unknown";
    // IPv4: show first two octets only
    const v4match = ip.match(/^(\d+\.\d+)\.\d+\.\d+$/);
    if (v4match) return `${v4match[1]}.*.*`;
    // ::ffff:x.x.x.x (IPv4 mapped)
    const mappedMatch = ip.match(/^::ffff:(\d+\.\d+)\.\d+\.\d+$/i);
    if (mappedMatch) return `::ffff:${mappedMatch[1]}.*.*`;
    // IPv6 loopback
    if (ip === "::1" || ip === "127.0.0.1") return "local";
    // Generic IPv6 — only show prefix
    if (ip.includes(":")) return ip.split(":").slice(0, 3).join(":") + ":*:*:*:*:*";
    return "masked";
  }

  private _audit(eventType: Phase28AuditEvent, secContext: SecurityContext, reason: string): void {
    securityAuditLogger.logEvent({
      eventType,
      actor: {
        identityId: secContext.identityId,
        role: secContext.role,
        ipAddress: this._maskIp(secContext.ipAddress || "127.0.0.1"),
        sessionId: secContext.sessionId,
        deviceId: secContext.deviceId,
      },
      decision: "ALLOW",
      reason,
      riskLevel: "MEDIUM",
    });
  }

  private _categoryDescription(cat: SuspiciousEventSummary["eventCategory"]): string {
    const descriptions: Record<SuspiciousEventSummary["eventCategory"], string> = {
      AUTH_FAILURE: "One or more authentication attempts failed recently.",
      TOKEN_REPLAY: "A replay attack using a stale or duplicate token was detected and blocked.",
      UNKNOWN_DEVICE: "A connection from an unrecognized or unregistered device was detected.",
      REMOTE_ANOMALY: "Unusual remote session activity was detected (burst, probing, or anomalous patterns).",
      SUSPICIOUS_ACTIVITY: "Suspicious system activity was flagged by the security monitor.",
      BRUTE_FORCE: "Brute-force authentication attempts exceeded the threshold and were locked out.",
      NONCE_REPLAY: "Duplicate cryptographic nonce detected. Possible replay attack.",
    };
    return descriptions[cat] || "Security anomaly detected.";
  }

  private _severityScore(s: SuspiciousEventSummary["severityLabel"]): number {
    return { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 }[s] ?? 0;
  }
}

export const androidSecurityManager = new AndroidSecurityManager();
