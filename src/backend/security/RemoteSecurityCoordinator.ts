/**
 * MYRAA — RemoteSecurityCoordinator (Phase 17)
 *
 * Secure Android ↔ MYRAA Core Communication Bridge:
 *   • Unifies Remote Companion devices with the Phase 10A–10F Security Architecture.
 *   • Integrates with IdentityAuthManager for short-lived access tokens (15m TTL),
 *     rotating refresh tokens, and strict token-family replay-attack detection.
 *   • Binds sessions strictly to authenticated device IDs.
 *   • Enforces server-side device revocation with instantaneous session termination.
 *   • Provides sliding-window nonce and timestamp replay protection for sensitive requests.
 *   • Monitors remote request rates and feeds anomalies into the SecurityMonitor and
 *     ThreatContainmentManager pipeline.
 *   • Integrates with NetworkSecurityManager & DataProtectionService to enforce TLS/WSS.
 *
 * CRITICAL INVARIANT:
 *   Zero duplicate security logic. Reuses IdentityAuthManager, SecurityPolicyEngine,
 *   SecurityRiskEngine, ToolExecutionFirewall, NetworkSecurityManager, SecurityMonitor,
 *   ThreatContainmentManager, and SecurityAuditLogger.
 */

import crypto from "crypto";
import type {
  IdentityRole,
  SessionRecord,
  TokenPair,
  ThreatReport,
  SecurityContext,
} from "./SecurityTypes.ts";
import { identityAuthManager } from "./IdentityAuthManager.ts";
import { securityPolicyEngine } from "./SecurityPolicyEngine.ts";
import { securityAuditLogger } from "./SecurityAuditLogger.ts";
import { securityEventStream } from "./SecurityEventStream.ts";
import { threatContainmentManager } from "./ThreatContainmentManager.ts";
import { dataProtectionService } from "./DataProtectionService.ts";
import { remoteStore } from "../remote/RemoteStore.ts";
import { pairingManager } from "../remote/PairingManager.ts";
import { remoteSessionManager } from "../remote/RemoteSessionManager.ts";
import type { PairedDevice, DeviceRole } from "../remote/RemoteTypes.ts";

export interface RemoteDeviceSession {
  device: PairedDevice;
  session: SessionRecord;
  tokens: TokenPair;
}

export interface ReplayNonceRecord {
  timestamp: number;
}

export class RemoteSecurityCoordinator {
  // Sliding-window replay protection cache: nonce -> timestamp
  private _seenNonces = new Map<string, ReplayNonceRecord>();
  private _nonceMaxAgeMs = 60_000; // 60 seconds nonce validity window

  // Anomaly tracking: deviceId/ip -> array of recent event timestamps
  private _remoteActivityWindows = new Map<string, number[]>();
  private _anomalyThreshold = 50; // max 50 requests per 10-second window
  private _anomalyWindowMs = 10_000;

  constructor() {
    this.resetForTesting();
  }

  resetForTesting(): void {
    this._seenNonces.clear();
    this._remoteActivityWindows.clear();
  }

  // ---------------------------------------------------------------------------
  // 1. Device Authentication & Session Binding
  // ---------------------------------------------------------------------------

  /**
   * Authenticate a remote client credential.
   * Supports both short-lived IdentityAuthManager access tokens ("myraa_at_...")
   * and long-lived signed pairing tokens ("sora_dev_...").
   * Binds the session strictly to the authenticated device.
   */
  async authenticateRemoteCredential(
    rawToken: string,
    ipAddress = "unknown",
    userAgent = "unknown",
  ): Promise<{ authenticated: boolean; device?: PairedDevice; session?: SessionRecord; error?: string }> {
    if (!rawToken || typeof rawToken !== "string") {
      return { authenticated: false, error: "INVALID_CREDENTIAL: Token is missing or empty." };
    }

    const token = rawToken.startsWith("Bearer ") ? rawToken.slice(7).trim() : rawToken.trim();

    // Check IP lockout in IdentityAuthManager
    try {
      identityAuthManager.checkIpLockout(ipAddress);
    } catch (e: any) {
      return { authenticated: false, error: e.message };
    }

    // ── Case A: Short-Lived Access Token (myraa_at_...) ────────────────────────
    if (token.startsWith("myraa_at_")) {
      let validation = identityAuthManager.validateAccessToken(token, ipAddress);

      // If in-memory session table was cleared by a Render sleep/restart, verify
      // the cryptographic HMAC-SHA256 signature + expiration and re-hydrate if the
      // paired device is still active and non-revoked in RemoteStore.
      if (!validation.valid && validation.error?.startsWith("SESSION_NOT_FOUND")) {
        const stateless = identityAuthManager.verifyStatelessAccessTokenClaims(token);
        if (stateless.valid && stateless.payload) {
          let storedDevice = await remoteStore.getDevice(stateless.payload.did);
          if (storedDevice?.revoked) {
            return {
              authenticated: false,
              error: "DEVICE_REVOKED: This device registration has been revoked.",
            };
          }
          const lostRecord = await remoteStore.getLostDeviceRecord(stateless.payload.did);
          if (lostRecord) {
            return {
              authenticated: false,
              error: "DEVICE_REVOKED: This device registration has been revoked.",
            };
          }
          if (!storedDevice) {
            // Ephemeral container filesystem was wiped while the signed access token is still valid.
            // Re-hydrate the device registration preserving its signed role claim, without
            // allowing a second unauthorized admin if an active admin already exists.
            const existingDevices = await remoteStore.listDevices({ skipAutoAdminPromotion: true });
            const hasExistingAdmin = existingDevices.some((d) => d.role === "admin" && !d.revoked);
            const claimRole = stateless.payload.role;
            const resolvedRole: DeviceRole =
              claimRole === "admin"
                ? hasExistingAdmin
                  ? "standard"
                  : "admin"
                : claimRole === "read_only"
                ? "read_only"
                : "standard";
            storedDevice = {
              id: stateless.payload.did,
              name: userAgent?.includes("Android") ? "Android Companion" : "Paired Companion",
              deviceType: userAgent?.includes("Android") ? "mobile" : "browser",
              role: resolvedRole,
              roleExplicit: true,
              tokenHash: "",
              pairedAt: new Date().toISOString(),
              lastSeenAt: new Date().toISOString(),
              lastIp: ipAddress,
              userAgent,
              revoked: false,
            };
            await remoteStore.saveDevice(storedDevice);
          }
          try {
            const restoredSession = identityAuthManager.restoreSessionFromVerifiedClaims(
              {
                ...stateless.payload,
                role: this._mapDeviceRoleToIdentityRole(storedDevice.role),
              },
              ipAddress,
              userAgent,
            );
            validation = { valid: true, session: restoredSession };
          } catch (restoreErr: any) {
            return {
              authenticated: false,
              error: restoreErr?.message || "SESSION_REVOKED",
            };
          }
        }
      }

      if (!validation.valid || !validation.session) {
        this._recordAnomalyEvent(ipAddress, "INVALID_ACCESS_TOKEN", validation.error);
        return { authenticated: false, error: validation.error || "INVALID_ACCESS_TOKEN" };
      }

      const session = validation.session;
      const device = await remoteStore.getDevice(session.deviceId);
      if (!device || device.revoked) {
        // Device was revoked; invalidate session in IdentityAuthManager
        identityAuthManager.revokeSession(session.sessionId, "Associated device has been revoked.");
        return { authenticated: false, error: "DEVICE_REVOKED: This device registration has been revoked." };
      }

      // Update device last seen
      device.lastSeenAt = new Date().toISOString();
      device.lastIp = ipAddress;
      device.userAgent = userAgent;
      await remoteStore.saveDevice(device);

      securityAuditLogger.logEvent({
        eventType: "AUTH_SUCCESS",
        actor: {
          identityId: session.identityId,
          role: session.role,
          ipAddress,
          sessionId: session.sessionId,
          deviceId: session.deviceId,
        },
        decision: "ALLOW",
        reason: "Remote device authenticated via access token.",
        riskLevel: "LOW",
      });

      return { authenticated: true, device, session };
    }

    // ── Case B: Paired Device Token (sora_dev_...) ────────────────────────────
    if (token.startsWith("sora_dev_")) {
      const device = await remoteSessionManager.authenticateToken(token, ipAddress, userAgent);
      if (!device) {
        this._recordAnomalyEvent(ipAddress, "INVALID_DEVICE_TOKEN", "Paired token verification failed.");
        return { authenticated: false, error: "UNAUTHORIZED: Device token invalid or revoked." };
      }

      // Verify or establish associated IdentityAuthManager session
      const role = this._mapDeviceRoleToIdentityRole(device.role);
      const sessionResult = identityAuthManager.createSession({
        deviceId: device.id,
        identityId: `device:${device.id}`,
        role,
        ipAddress,
        userAgent,
      });

      return { authenticated: true, device, session: sessionResult.session };
    }

    return { authenticated: false, error: "UNSUPPORTED_TOKEN_TYPE: Token format unrecognized." };
  }

  // ---------------------------------------------------------------------------
  // 2. Session Management & Token Issuance
  // ---------------------------------------------------------------------------

  /**
   * Establish an authenticated session with token pair for a paired Android device.
   */
  createDeviceSession(
    device: PairedDevice,
    ipAddress: string,
    userAgent = "unknown",
  ): RemoteDeviceSession {
    if (device.revoked) {
      throw new Error("DEVICE_REVOKED: Cannot create session for a revoked device.");
    }

    const role = this._mapDeviceRoleToIdentityRole(device.role);
    const { session, tokens } = identityAuthManager.createSession({
      deviceId: device.id,
      identityId: `device:${device.id}`,
      role,
      ipAddress,
      userAgent,
    });

    return { device, session, tokens };
  }

  // ---------------------------------------------------------------------------
  // 3. Token Rotation with Strict Replay Detection
  // ---------------------------------------------------------------------------

  /**
   * Rotate session credentials using rotating refresh token.
   * If an old refresh token is reused, IdentityAuthManager detects the replay attack,
   * revokes the entire token family, and triggers automated containment.
   */
  async rotateSessionToken(
    compositeRefreshToken: string,
    ipAddress = "unknown",
  ): Promise<{ tokens: TokenPair; session: SessionRecord }> {
    try {
      const result = identityAuthManager.refreshSession(compositeRefreshToken, ipAddress);

      // Verify device is still valid
      const device = await remoteStore.getDevice(result.session.deviceId);
      if (!device || device.revoked) {
        identityAuthManager.revokeSession(result.session.sessionId, "Device revoked during token refresh.");
        throw new Error("DEVICE_REVOKED: Device has been revoked.");
      }

      securityAuditLogger.logEvent({
        eventType: "TOKEN_REFRESH",
        actor: {
          identityId: result.session.identityId,
          role: result.session.role,
          ipAddress,
          sessionId: result.session.sessionId,
          deviceId: result.session.deviceId,
        },
        decision: "ALLOW",
        reason: "Remote device refreshed session tokens successfully.",
        riskLevel: "LOW",
      });

      return result;
    } catch (err: any) {
      // Replay attack handling
      if (err.message && (err.message.includes("REPLAY") || err.message.includes("TOKEN_REPLAY"))) {
        const threat: ThreatReport = {
          threatName: "CREDENTIAL_REPLAY_ATTACK",
          severity: "CRITICAL",
          triggerEvent: "TOKEN_REUSE",
          occurrences: 1,
          windowMs: 60_000,
          actor: {
            identityId: "unknown",
            ipAddress,
          },
          target: {
            resource: "/api/remote/token/refresh",
          },
          reason: "Stale or reused refresh token detected from remote client.",
          recommendedAction: "INITIATE_LOCKDOWN",
          mitigationAction: "DEVICE_QUARANTINED",
        };

        // Trigger containment pipeline
        await threatContainmentManager.containThreat(threat);
      }

      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // 4. Device Revocation & Immediate Termination
  // ---------------------------------------------------------------------------

  /**
   * Revoke a remote device server-side immediately.
   *  - Marks device as revoked in remoteStore.
   *  - Revokes all sessions in IdentityAuthManager.
   *  - Terminates all active WebSocket connections for this device in RemoteSessionManager.
   *  - Emits audit log entry.
   */
  async revokeRemoteDevice(deviceId: string, reason = "Revoked by operator", ipAddress = "127.0.0.1"): Promise<boolean> {
    const device = await remoteStore.getDevice(deviceId);
    if (!device) return false;

    // 1. Mark device revoked in store
    device.revoked = true;
    device.revokedAt = new Date().toISOString();
    device.revokedReason = reason;
    await remoteStore.saveDevice(device);

    // 2. Invalidate all device sessions in IdentityAuthManager
    identityAuthManager.revokeDevice(deviceId, reason);

    // 3. Terminate active WebSocket connections in RemoteSessionManager
    await remoteSessionManager.revokeDevice(deviceId, reason);

    // 3b. Purge any persisted session snapshot for revoked device
    await remoteStore.deleteSessionSnapshot(deviceId);

    // 4. Audit Log
    securityAuditLogger.logEvent({
      eventType: "DEVICE_REVOKED",
      actor: {
        identityId: `device:${deviceId}`,
        role: this._mapDeviceRoleToIdentityRole(device.role),
        deviceId,
        ipAddress,
      },
      decision: "REVOKE",
      reason: `Remote device revoked: ${reason}`,
      riskLevel: "MEDIUM",
    });

    console.warn(`[RemoteSecurityCoordinator] Device '${device.name}' (ID: ${deviceId}) revoked and sessions terminated.`);
    return true;
  }

  // ---------------------------------------------------------------------------
  // 5. Replay Protection for Remote Sensitive Operations
  // ---------------------------------------------------------------------------

  /**
   * Validate request freshness and anti-replay nonce for sensitive remote commands.
   * Rejects duplicate nonces or requests older than 60 seconds.
   */
  validateRequestNonce(nonce: string, timestampMs: number): { valid: boolean; error?: string } {
    if (!nonce || typeof nonce !== "string" || nonce.length < 8) {
      return { valid: false, error: "REPLAY_PROTECTION: A valid cryptographic nonce (min 8 chars) is required." };
    }

    const now = Date.now();
    const ageMs = Math.abs(now - timestampMs);

    if (ageMs > this._nonceMaxAgeMs) {
      return {
        valid: false,
        error: `REPLAY_PROTECTION: Request timestamp is stale (age: ${Math.round(ageMs / 1000)}s, max: 60s).`,
      };
    }

    this._cleanExpiredNonces();

    if (this._seenNonces.has(nonce)) {
      securityAuditLogger.logEvent({
        eventType: "TOKEN_REPLAY_DETECTED",
        actor: { identityId: "unknown", role: "guest", ipAddress: "unknown" },
        decision: "BLOCK",
        reason: `Duplicate request nonce '${nonce}' detected. Replay attack blocked.`,
        riskLevel: "HIGH",
      });
      return { valid: false, error: "REPLAY_ATTACK_DETECTED: Duplicate request nonce. Operation rejected." };
    }

    this._seenNonces.set(nonce, { timestamp: timestampMs });
    return { valid: true };
  }

  private _cleanExpiredNonces(): void {
    const now = Date.now();
    for (const [nonce, record] of this._seenNonces.entries()) {
      if (now - record.timestamp > this._nonceMaxAgeMs * 2) {
        this._seenNonces.delete(nonce);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 6. Network Security & Transport Verification
  // ---------------------------------------------------------------------------

  /**
   * Enforce production transport security (WSS/HTTPS) for all non-local connections.
   */
  validateTransport(ipAddress: string, protocol: string, targetName = "/remote-live"): boolean {
    const isLocal = ipAddress === "127.0.0.1" || ipAddress === "::1" || ipAddress === "::ffff:127.0.0.1";
    if (isLocal) return true;

    const check = dataProtectionService.validateTransport({
      protocol,
      ipAddress,
      targetName,
    });
    return check.secure;
  }

  // ---------------------------------------------------------------------------
  // 7. Remote Anomaly Detection
  // ---------------------------------------------------------------------------

  /**
   * Monitor remote request arrival rate per IP/device.
   * If a burst exceeds the anomaly threshold, triggers an incident report to SecurityMonitor.
   */
  recordRemoteActivity(key: string, actor: { ipAddress: string; deviceId?: string; sessionId?: string }): boolean {
    const now = Date.now();
    const timestamps = this._remoteActivityWindows.get(key) || [];
    const recent = timestamps.filter((t) => now - t < this._anomalyWindowMs);
    recent.push(now);
    this._remoteActivityWindows.set(key, recent);

    if (recent.length > this._anomalyThreshold) {
      this._reportAnomaly(actor, `Remote activity burst detected (${recent.length} msgs / 10s)`);
      return false; // Rate limit exceeded
    }

    return true;
  }

  private _recordAnomalyEvent(ipAddress: string, type: string, detail?: string): void {
    securityEventStream.publish({
      eventType: "REMOTE_SESSION_ANOMALY",
      actor: { identityId: "remote_actor", role: "guest", ipAddress, isLocal: false },
      summary: `Remote anomaly: ${type} - ${detail || "Suspicious remote client behavior"}`,
      severity: "MEDIUM",
      timestamp: Date.now(),
    });
  }

  private _reportAnomaly(actor: { ipAddress: string; deviceId?: string; sessionId?: string }, reason: string): void {
    const threat: ThreatReport = {
      threatName: "SUSPICIOUS_REMOTE_ACTIVITY",
      severity: "HIGH",
      triggerEvent: "REMOTE_SESSION_ANOMALY",
      occurrences: 51,
      windowMs: this._anomalyWindowMs,
      actor: {
        identityId: actor.deviceId || "unknown",
        ipAddress: actor.ipAddress,
        deviceId: actor.deviceId,
        sessionId: actor.sessionId,
      },
      target: {
        resource: "/remote-live",
      },
      reason,
      recommendedAction: "Investigate client network and throttle connections.",
      mitigationAction: "DEVICE_QUARANTINED",
    };

    threatContainmentManager.containThreat(threat);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private _mapDeviceRoleToIdentityRole(role: DeviceRole): IdentityRole {
    switch (role) {
      case "admin":
        return "admin";
      case "standard":
        return "standard";
      case "read_only":
        return "read_only";
      default:
        return "standard";
    }
  }
}

export const remoteSecurityCoordinator = new RemoteSecurityCoordinator();
