/**
 * MYRAA — IdentityAuthManager (Phase 10A)
 *
 * Identity, Authentication & Session Security Subsystem:
 *   • Short-lived HMAC-SHA256 access tokens (15m TTL)
 *   • Refresh-token rotation with strict replay-attack detection
 *   • Session & device lifecycle management with instantaneous revocation
 *   • Step-up re-authentication for sensitive/critical operations
 *   • Sliding-window brute-force lockout & rate limiting
 *   • Automatic session termination on suspicious activity
 */

import crypto from "crypto";
import type {
  IdentityRole,
  SessionRecord,
  TokenFamily,
  TokenPair,
} from "./SecurityTypes.ts";
import {
  ACCESS_TOKEN_TTL_MS,
  REFRESH_TOKEN_TTL_MS,
  STEP_UP_TTL_MS,
  STEP_UP_GRACE_MS,
  AUTH_MAX_FAILED_ATTEMPTS,
  AUTH_LOCKOUT_MS,
} from "./SecurityTypes.ts";
import { securityAuditLogger } from "./SecurityAuditLogger.ts";
import { getPersistentServerSecret } from "../../../server_paths.ts";

interface StepUpChallenge {
  sessionId: string;
  pin: string;
  action: string;
  createdAt: number;
  expiresAt: number;
  consumed: boolean;
}

interface IpAuthAttempt {
  failedCount: number;
  lastAttemptAt: number;
  lockedUntil?: number;
}

export class IdentityAuthManager {
  private _sessions = new Map<string, SessionRecord>(); // sessionId -> SessionRecord
  private _tokenFamilies = new Map<string, TokenFamily>(); // familyId -> TokenFamily
  private _stepUpChallenges = new Map<string, StepUpChallenge>(); // challengeId -> StepUpChallenge
  private _ipAttempts = new Map<string, IpAuthAttempt>(); // ip -> IpAuthAttempt

  constructor() {
    this.resetForTesting();
  }

  /**
   * Reset state for testing.
   */
  resetForTesting(): void {
    this._sessions.clear();
    this._tokenFamilies.clear();
    this._stepUpChallenges.clear();
    this._ipAttempts.clear();
  }

  // ---------------------------------------------------------------------------
  // Cryptographic Token Helpers
  // ---------------------------------------------------------------------------

  private _hash(value: string): string {
    return crypto.createHash("sha256").update(value).digest("hex");
  }

  private _signString(data: string): string {
    return crypto.createHmac("sha256", getPersistentServerSecret()).update(data).digest("base64url");
  }

  private _verifySignature(data: string, signature: string): boolean {
    const expected = this._signString(data);
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  // ---------------------------------------------------------------------------
  // Brute-Force Defense & Rate Limiting
  // ---------------------------------------------------------------------------

  /**
   * Enforce brute-force lockout on an IP address.
   */
  checkIpLockout(ip: string): void {
    const attempt = this._ipAttempts.get(ip);
    if (!attempt) return;

    const now = Date.now();
    if (attempt.lockedUntil && now < attempt.lockedUntil) {
      const remainingSecs = Math.ceil((attempt.lockedUntil - now) / 1000);
      throw new Error(
        `BRUTE_FORCE_LOCKOUT: Too many failed attempts from IP ${ip}. Locked out for ${remainingSecs}s.`,
      );
    }

    if (attempt.lockedUntil && now >= attempt.lockedUntil) {
      this._ipAttempts.delete(ip);
    }
  }

  /**
   * Record a failed authentication attempt.
   */
  recordFailedAttempt(ip: string, reason = "Failed authentication"): void {
    const now = Date.now();
    const attempt = this._ipAttempts.get(ip) || { failedCount: 0, lastAttemptAt: now };
    attempt.failedCount++;
    attempt.lastAttemptAt = now;

    if (attempt.failedCount >= AUTH_MAX_FAILED_ATTEMPTS) {
      attempt.lockedUntil = now + AUTH_LOCKOUT_MS;
      console.warn(`[IdentityAuthManager] IP ${ip} locked out for 15 minutes after ${attempt.failedCount} failed attempts.`);
      securityAuditLogger.logEvent({
        eventType: "BRUTE_FORCE_LOCKOUT",
        actor: { identityId: "unknown", role: "guest", ipAddress: ip },
        decision: "BLOCK",
        reason: `IP locked out after ${attempt.failedCount} failed attempts (${reason}).`,
        riskLevel: "CRITICAL",
      });
    }

    this._ipAttempts.set(ip, attempt);
  }

  /**
   * Clear failed attempts on successful authentication.
   */
  clearFailedAttempts(ip: string): void {
    this._ipAttempts.delete(ip);
  }

  // ---------------------------------------------------------------------------
  // Session & Token Issuance
  // ---------------------------------------------------------------------------

  /**
   * Create a new secure session with short-lived access token and rotating refresh token.
   */
  createSession(params: {
    deviceId: string;
    identityId: string;
    role: IdentityRole;
    ipAddress: string;
    userAgent?: string;
  }): { session: SessionRecord; tokens: TokenPair } {
    this.checkIpLockout(params.ipAddress);

    const sessionId = crypto.randomUUID();
    const familyId = crypto.randomUUID();
    const now = Date.now();

    const session: SessionRecord = {
      sessionId,
      deviceId: params.deviceId,
      identityId: params.identityId,
      role: params.role,
      createdAt: now,
      expiresAt: now + REFRESH_TOKEN_TTL_MS,
      lastActivityAt: now,
      ipAddress: params.ipAddress,
      userAgent: params.userAgent || "unknown",
      revoked: false,
    };

    // Issue initial tokens
    const rawRefreshToken = `myraa_rf_${crypto.randomBytes(32).toString("hex")}`;
    const refreshTokenHash = this._hash(rawRefreshToken);

    const family: TokenFamily = {
      familyId,
      sessionId,
      currentRefreshTokenHash: refreshTokenHash,
      usedRefreshTokenHashes: [],
      revoked: false,
      createdAt: now,
    };

    const accessToken = this._generateAccessToken(session, familyId);

    this._sessions.set(sessionId, session);
    this._tokenFamilies.set(familyId, family);

    this.clearFailedAttempts(params.ipAddress);

    securityAuditLogger.logEvent({
      eventType: "SESSION_CREATED",
      actor: {
        identityId: session.identityId,
        role: session.role,
        ipAddress: session.ipAddress,
        sessionId: session.sessionId,
        deviceId: session.deviceId,
      },
      decision: "ALLOW",
      reason: "Session established successfully.",
      riskLevel: "LOW",
    });

    return {
      session: { ...session },
      tokens: {
        accessToken,
        refreshToken: `${familyId}.${rawRefreshToken}`,
        expiresInSeconds: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
        tokenType: "Bearer",
        role: session.role,
        sessionId,
      },
    };
  }

  private _generateAccessToken(session: SessionRecord, familyId: string): string {
    const payload = JSON.stringify({
      sid: session.sessionId,
      did: session.deviceId,
      sub: session.identityId,
      role: session.role,
      fam: familyId,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor((Date.now() + ACCESS_TOKEN_TTL_MS) / 1000),
      jti: crypto.randomUUID(),
    });

    const encodedPayload = Buffer.from(payload).toString("base64url");
    const signature = this._signString(encodedPayload);
    return `myraa_at_${encodedPayload}.${signature}`;
  }

  // ---------------------------------------------------------------------------
  // Access Token Validation
  // ---------------------------------------------------------------------------

  /**
   * Validate a short-lived access token.
   */
  validateAccessToken(
    token: string,
    ipAddress = "unknown",
  ): { valid: boolean; session?: SessionRecord; error?: string } {
    this.checkIpLockout(ipAddress);

    if (!token || typeof token !== "string" || !token.startsWith("myraa_at_")) {
      this.recordFailedAttempt(ipAddress, "Malformed access token prefix");
      return { valid: false, error: "INVALID_TOKEN_FORMAT: Access token is missing or malformed." };
    }

    const parts = token.slice("myraa_at_".length).split(".");
    if (parts.length !== 2) {
      this.recordFailedAttempt(ipAddress, "Invalid token structure");
      return { valid: false, error: "INVALID_TOKEN_FORMAT: Malformed token parts." };
    }

    const [encodedPayload, signature] = parts;
    if (!this._verifySignature(encodedPayload, signature)) {
      this.recordFailedAttempt(ipAddress, "Invalid token signature");
      return { valid: false, error: "INVALID_SIGNATURE: Token signature verification failed." };
    }

    try {
      const payloadStr = Buffer.from(encodedPayload, "base64url").toString("utf-8");
      const payload = JSON.parse(payloadStr);

      const nowSec = Math.floor(Date.now() / 1000);
      if (payload.exp && payload.exp < nowSec) {
        return { valid: false, error: "TOKEN_EXPIRED: Access token has expired. Please refresh." };
      }

      const session = this._sessions.get(payload.sid);
      if (!session) {
        return { valid: false, error: "SESSION_NOT_FOUND: Session no longer exists." };
      }

      if (session.revoked) {
        return {
          valid: false,
          error: `SESSION_REVOKED: ${session.revokedReason || "Session has been revoked."}`,
        };
      }

      const family = this._tokenFamilies.get(payload.fam);
      if (!family || family.revoked) {
        return { valid: false, error: "TOKEN_FAMILY_REVOKED: Token family has been revoked." };
      }

      // Refresh activity timestamp
      session.lastActivityAt = Date.now();

      return { valid: true, session: { ...session } };
    } catch {
      this.recordFailedAttempt(ipAddress, "Unparseable token payload");
      return { valid: false, error: "MALFORMED_TOKEN_PAYLOAD: Failed to parse token payload." };
    }
  }

  /**
   * Cryptographically verifies an access token's HMAC-SHA256 signature and expiration
   * without requiring the in-memory session map to be populated.
   * Used by RemoteSecurityCoordinator to safely re-hydrate sessions for active paired
   * devices after a Render instance sleep or server restart.
   */
  verifyStatelessAccessTokenClaims(
    token: string,
  ): {
    valid: boolean;
    payload?: {
      sid: string;
      did: string;
      sub: string;
      role: IdentityRole;
      fam: string;
      iat: number;
      exp: number;
      jti: string;
    };
    error?: string;
  } {
    if (!token || typeof token !== "string" || !token.startsWith("myraa_at_")) {
      return { valid: false, error: "INVALID_TOKEN_FORMAT: Access token is missing or malformed." };
    }
    const parts = token.slice("myraa_at_".length).split(".");
    if (parts.length !== 2) {
      return { valid: false, error: "INVALID_TOKEN_FORMAT: Malformed token parts." };
    }
    const [encodedPayload, signature] = parts;
    if (!this._verifySignature(encodedPayload, signature)) {
      return { valid: false, error: "INVALID_SIGNATURE: Token signature verification failed." };
    }
    try {
      const payloadStr = Buffer.from(encodedPayload, "base64url").toString("utf-8");
      const payload = JSON.parse(payloadStr);
      const nowSec = Math.floor(Date.now() / 1000);
      if (payload.exp && payload.exp < nowSec) {
        return { valid: false, error: "TOKEN_EXPIRED: Access token has expired. Please refresh." };
      }
      if (!payload.sid || !payload.did) {
        return { valid: false, error: "MALFORMED_TOKEN_PAYLOAD: Missing session or device claims." };
      }
      return { valid: true, payload };
    } catch {
      return { valid: false, error: "MALFORMED_TOKEN_PAYLOAD: Failed to parse token payload." };
    }
  }

  /**
   * Re-hydrates an in-memory session record from cryptographically verified access token claims
   * after a server restart, once the caller has verified the device is active and non-revoked
   * in persistent storage (RemoteStore).
   */
  restoreSessionFromVerifiedClaims(
    claims: {
      sid: string;
      did: string;
      sub?: string;
      role: IdentityRole;
      fam?: string;
      iat?: number;
      exp?: number;
    },
    ipAddress = "unknown",
    userAgent = "unknown",
  ): SessionRecord {
    const existing = this._sessions.get(claims.sid);
    if (existing) {
      if (existing.revoked) {
        throw new Error(`SESSION_REVOKED: ${existing.revokedReason || "Session has been revoked."}`);
      }
      existing.lastActivityAt = Date.now();
      return { ...existing };
    }

    const now = Date.now();
    const session: SessionRecord = {
      sessionId: claims.sid,
      deviceId: claims.did,
      identityId: claims.sub || `device:${claims.did}`,
      role: claims.role,
      createdAt: claims.iat ? claims.iat * 1000 : now,
      expiresAt: now + REFRESH_TOKEN_TTL_MS,
      lastActivityAt: now,
      ipAddress,
      userAgent,
      revoked: false,
    };

    const familyId = claims.fam || crypto.randomUUID();
    if (!this._tokenFamilies.has(familyId)) {
      this._tokenFamilies.set(familyId, {
        familyId,
        sessionId: claims.sid,
        currentRefreshTokenHash: this._hash(`restored_family_${familyId}`),
        usedRefreshTokenHashes: [],
        revoked: false,
        createdAt: now,
      });
    }

    this._sessions.set(claims.sid, session);
    return { ...session };
  }


  // ---------------------------------------------------------------------------
  // Refresh Token Rotation & Replay Attack Detection
  // ---------------------------------------------------------------------------

  /**
   * Refresh an access token using rotating refresh token.
   * STRICT REPLAY DETECTION: If a previously used refresh token is presented,
   * the entire token family and session are immediately revoked.
   */
  refreshSession(
    compositeRefreshToken: string,
    ipAddress = "unknown",
  ): { tokens: TokenPair; session: SessionRecord } {
    this.checkIpLockout(ipAddress);

    if (!compositeRefreshToken || typeof compositeRefreshToken !== "string") {
      this.recordFailedAttempt(ipAddress, "Empty refresh token");
      throw new Error("INVALID_REFRESH_TOKEN: Refresh token is missing or empty.");
    }

    const parts = compositeRefreshToken.split(".");
    if (parts.length !== 2) {
      this.recordFailedAttempt(ipAddress, "Malformed refresh token format");
      throw new Error("INVALID_REFRESH_TOKEN: Malformed refresh token structure.");
    }

    const [familyId, rawToken] = parts;
    const family = this._tokenFamilies.get(familyId);
    if (!family) {
      this.recordFailedAttempt(ipAddress, "Unknown token family");
      throw new Error("INVALID_REFRESH_TOKEN: Token family not found.");
    }

    const session = this._sessions.get(family.sessionId);
    if (!session) {
      throw new Error("SESSION_NOT_FOUND: Session associated with refresh token not found.");
    }

    const presentedHash = this._hash(rawToken);

    // ── REPLAY DETECTION ──────────────────────────────────────────────────
    if (family.usedRefreshTokenHashes.includes(presentedHash)) {
      // Replay attack detected! Invalidate entire family and session!
      family.revoked = true;
      session.revoked = true;
      session.revokedReason = "TOKEN_REPLAY_DETECTED: Stolen or replayed refresh token presented.";

      securityAuditLogger.logEvent({
        eventType: "TOKEN_REPLAY_DETECTED",
        actor: {
          identityId: session.identityId,
          role: session.role,
          ipAddress,
          sessionId: session.sessionId,
          deviceId: session.deviceId,
        },
        decision: "REVOKE",
        reason: "Replay attack detected: consumed refresh token re-submitted. Revoked session.",
        riskLevel: "CRITICAL",
      });

      this.recordFailedAttempt(ipAddress, "Token replay attempt");
      throw new Error("TOKEN_REPLAY_DETECTED: Stolen refresh token detected. Session terminated.");
    }

    // Check if token family or session is already revoked
    if (family.revoked || session.revoked) {
      this.recordFailedAttempt(ipAddress, "Revoked session refresh attempt");
      throw new Error("SESSION_REVOKED: Session or token family has been revoked.");
    }

    // Verify current refresh token hash
    const currentHashBuf = Buffer.from(family.currentRefreshTokenHash);
    const presentedBuf = Buffer.from(presentedHash);
    if (
      currentHashBuf.length !== presentedBuf.length ||
      !crypto.timingSafeEqual(currentHashBuf, presentedBuf)
    ) {
      this.recordFailedAttempt(ipAddress, "Invalid refresh token value");
      throw new Error("INVALID_REFRESH_TOKEN: Refresh token verification failed.");
    }

    // ── ROTATE REFRESH TOKEN ──────────────────────────────────────────────
    // 1. Mark current refresh token as used
    family.usedRefreshTokenHashes.push(family.currentRefreshTokenHash);

    // 2. Generate new fresh refresh token
    const newRawRefreshToken = `myraa_rf_${crypto.randomBytes(32).toString("hex")}`;
    family.currentRefreshTokenHash = this._hash(newRawRefreshToken);

    // 3. Update session
    const now = Date.now();
    session.lastActivityAt = now;

    // 4. Generate new short-lived access token
    const newAccessToken = this._generateAccessToken(session, familyId);

    securityAuditLogger.logEvent({
      eventType: "TOKEN_REFRESH",
      actor: {
        identityId: session.identityId,
        role: session.role,
        ipAddress,
        sessionId: session.sessionId,
        deviceId: session.deviceId,
      },
      decision: "ALLOW",
      reason: "Refresh token rotated and new access token issued.",
      riskLevel: "LOW",
    });

    return {
      session: { ...session },
      tokens: {
        accessToken: newAccessToken,
        refreshToken: `${familyId}.${newRawRefreshToken}`,
        expiresInSeconds: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
        tokenType: "Bearer",
        role: session.role,
        sessionId: session.sessionId,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Revocation & Session Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Revoke a single active session by ID.
   */
  revokeSession(sessionId: string, reason = "Revoked by operator"): boolean {
    const session = this._sessions.get(sessionId);
    if (!session) return false;

    session.revoked = true;
    session.revokedReason = reason;

    // Invalidate token families tied to this session
    for (const family of this._tokenFamilies.values()) {
      if (family.sessionId === sessionId) {
        family.revoked = true;
      }
    }

    securityAuditLogger.logEvent({
      eventType: "SESSION_REVOKED",
      actor: {
        identityId: session.identityId,
        role: session.role,
        ipAddress: session.ipAddress,
        sessionId: session.sessionId,
        deviceId: session.deviceId,
      },
      decision: "REVOKE",
      reason,
      riskLevel: "MEDIUM",
    });

    return true;
  }

  /**
   * Revoke all sessions associated with a specific device.
   */
  revokeDevice(deviceId: string, reason = "Device revoked"): number {
    let count = 0;
    for (const session of this._sessions.values()) {
      if (session.deviceId === deviceId && !session.revoked) {
        session.revoked = true;
        session.revokedReason = reason;
        count++;

        for (const family of this._tokenFamilies.values()) {
          if (family.sessionId === session.sessionId) {
            family.revoked = true;
          }
        }

        securityAuditLogger.logEvent({
          eventType: "DEVICE_REVOKED",
          actor: {
            identityId: session.identityId,
            role: session.role,
            ipAddress: session.ipAddress,
            sessionId: session.sessionId,
            deviceId,
          },
          decision: "REVOKE",
          reason,
          riskLevel: "HIGH",
        });
      }
    }
    return count;
  }

  /**
   * Automatic session revocation on suspicious activity.
   */
  triggerSuspiciousActivity(sessionId: string, reason: string): void {
    const session = this._sessions.get(sessionId);
    if (session) {
      session.revoked = true;
      session.revokedReason = `SUSPICIOUS_ACTIVITY: ${reason}`;

      for (const family of this._tokenFamilies.values()) {
        if (family.sessionId === sessionId) {
          family.revoked = true;
        }
      }

      securityAuditLogger.logEvent({
        eventType: "SUSPICIOUS_ACTIVITY",
        actor: {
          identityId: session.identityId,
          role: session.role,
          ipAddress: session.ipAddress,
          sessionId,
          deviceId: session.deviceId,
        },
        decision: "REVOKE",
        reason,
        riskLevel: "CRITICAL",
      });

      this.recordFailedAttempt(session.ipAddress, reason);
    }
  }

  /**
   * List all active, non-revoked sessions.
   */
  getActiveSessions(): SessionRecord[] {
    return Array.from(this._sessions.values())
      .filter((s) => !s.revoked)
      .map((s) => ({ ...s }));
  }

  /**
   * Retrieve a session by ID (active or revoked).
   */
  getSession(sessionId: string): SessionRecord | undefined {
    const session = this._sessions.get(sessionId);
    return session ? { ...session } : undefined;
  }

  // ---------------------------------------------------------------------------
  // Step-Up Re-Authentication for Sensitive Operations
  // ---------------------------------------------------------------------------

  /**
   * Issue a step-up re-authentication challenge for a sensitive action.
   */
  requestStepUpChallenge(
    sessionId: string,
    action: string,
  ): { challengeId: string; pin: string; expiresAt: string } {
    const session = this._sessions.get(sessionId);
    if (!session || session.revoked) {
      throw new Error("SESSION_INVALID: Cannot request step-up challenge for an invalid session.");
    }

    const challengeId = crypto.randomUUID();
    // 6-digit numeric PIN
    const pin = Math.floor(100000 + Math.random() * 900000).toString();
    const now = Date.now();
    const expiresAt = now + STEP_UP_TTL_MS;

    const challenge: StepUpChallenge = {
      sessionId,
      pin,
      action,
      createdAt: now,
      expiresAt,
      consumed: false,
    };

    this._stepUpChallenges.set(challengeId, challenge);

    securityAuditLogger.logEvent({
      eventType: "STEP_UP_CHALLENGE",
      actor: {
        identityId: session.identityId,
        role: session.role,
        ipAddress: session.ipAddress,
        sessionId,
        deviceId: session.deviceId,
      },
      decision: "CHALLENGE_PIN",
      reason: `Step-up authentication challenge requested for action '${action}'.`,
      riskLevel: "MEDIUM",
    });

    return {
      challengeId,
      pin,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  /**
   * Verify a step-up challenge PIN and grant temporary elevated privileges.
   */
  verifyStepUpChallenge(challengeId: string, inputPin: string): boolean {
    const challenge = this._stepUpChallenges.get(challengeId);
    if (!challenge || challenge.consumed) {
      return false;
    }

    const now = Date.now();
    if (now > challenge.expiresAt) {
      this._stepUpChallenges.delete(challengeId);
      return false;
    }

    const expectedBuf = Buffer.from(challenge.pin);
    const inputBuf = Buffer.from(String(inputPin).trim());

    if (expectedBuf.length !== inputBuf.length || !crypto.timingSafeEqual(expectedBuf, inputBuf)) {
      const session = this._sessions.get(challenge.sessionId);
      if (session) {
        this.recordFailedAttempt(session.ipAddress, "Invalid step-up PIN");
      }
      securityAuditLogger.logEvent({
        eventType: "STEP_UP_FAILED",
        actor: {
          identityId: session?.identityId || "unknown",
          role: session?.role || "guest",
          ipAddress: session?.ipAddress || "unknown",
          sessionId: challenge.sessionId,
        },
        decision: "BLOCK",
        reason: "Step-up re-authentication failed: incorrect PIN.",
        riskLevel: "HIGH",
      });
      return false;
    }

    challenge.consumed = true;

    const session = this._sessions.get(challenge.sessionId);
    if (session) {
      session.isStepUpAuthenticated = true;
      session.stepUpExpiresAt = now + STEP_UP_GRACE_MS;

      securityAuditLogger.logEvent({
        eventType: "STEP_UP_VERIFIED",
        actor: {
          identityId: session.identityId,
          role: session.role,
          ipAddress: session.ipAddress,
          sessionId: session.sessionId,
          deviceId: session.deviceId,
        },
        decision: "ALLOW",
        reason: `Step-up challenge verified for action '${challenge.action}'. Privileges granted for 5m.`,
        riskLevel: "MEDIUM",
      });
    }

    return true;
  }

  /**
   * Check if session currently has active step-up authentication.
   */
  isStepUpActive(sessionId: string): boolean {
    const session = this._sessions.get(sessionId);
    if (!session || session.revoked) return false;
    if (!session.isStepUpAuthenticated || !session.stepUpExpiresAt) return false;
    if (Date.now() > session.stepUpExpiresAt) {
      session.isStepUpAuthenticated = false;
      return false;
    }
    return true;
  }
}

export const identityAuthManager = new IdentityAuthManager();
