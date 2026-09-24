/**
 * MYRAA — PairingManager (Phase 7)
 *
 * Ephemeral pairing protocol with brute-force defense:
 *   - Generates 6-character uppercase alphanumeric PINs with 5-minute TTL
 *   - Single-use: invalidates code immediately upon consumption
 *   - Brute-force lockout: max 5 failed attempts per IP -> 10-minute cooldown
 *   - Issues HMAC-SHA256 signed bearer tokens
 *   - Stores ONLY SHA-256 hash in store (zero bearer token exposure on disk)
 *   - Constant-time string comparisons to prevent timing attacks
 */

import crypto from "crypto";
import type {
  PairedDevice,
  PairingSession,
  PairingAttemptRecord,
  DeviceRole,
  DeviceType,
} from "./RemoteTypes.ts";
import {
  PAIRING_CODE_TTL_MS,
  PAIRING_MAX_FAILED_ATTEMPTS,
  PAIRING_LOCKOUT_DURATION_MS,
  DEFAULT_DEVICE_ROLE,
} from "./RemoteTypes.ts";
import { remoteStore } from "./RemoteStore.ts";

/** Server-side HMAC signing secret (generated per server lifecycle or persistent) */
const SERVER_HMAC_SECRET = process.env.SORA_REMOTE_SECRET || crypto.randomBytes(32).toString("hex");

export class PairingManager {
  private _activeSession: PairingSession | null = null;
  private _attempts = new Map<string, PairingAttemptRecord>(); // IP -> attempts

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Hash a device token with SHA-256 for secure persistence. */
  hashToken(token: string): string {
    return crypto.createHash("sha256").update(token).digest("hex");
  }

  /** Sign a device ID into a bearer token with HMAC-SHA256. */
  signDeviceToken(deviceId: string): string {
    const raw = `${deviceId}.${Date.now()}.${crypto.randomBytes(16).toString("hex")}`;
    const hmac = crypto.createHmac("sha256", SERVER_HMAC_SECRET).update(raw).digest("hex");
    return `sora_dev_${Buffer.from(raw).toString("base64url")}.${hmac}`;
  }

  /** Verify that a device token was authentically issued by this server. */
  verifyDeviceToken(token: string): { valid: boolean; deviceId?: string } {
    if (!token || !token.startsWith("sora_dev_")) return { valid: false };
    const parts = token.slice("sora_dev_".length).split(".");
    if (parts.length !== 2) return { valid: false };

    const [encodedRaw, signature] = parts;
    try {
      const raw = Buffer.from(encodedRaw, "base64url").toString("utf-8");
      const expectedHmac = crypto.createHmac("sha256", SERVER_HMAC_SECRET).update(raw).digest("hex");

      const sigBuffer = Buffer.from(signature, "hex");
      const expectedBuffer = Buffer.from(expectedHmac, "hex");
      if (sigBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(sigBuffer, expectedBuffer)) {
        return { valid: false };
      }

      const [deviceId] = raw.split(".");
      return { valid: true, deviceId };
    } catch {
      return { valid: false };
    }
  }

  // ---------------------------------------------------------------------------
  // Rate Limiting & Lockout
  // ---------------------------------------------------------------------------

  private _checkLockout(ip: string): void {
    const record = this._attempts.get(ip);
    if (!record) return;

    const now = Date.now();
    if (record.lockedUntil && now < record.lockedUntil) {
      const remainingSecs = Math.ceil((record.lockedUntil - now) / 1000);
      throw new Error(`PAIRING_LOCKED_OUT: Too many failed pairing attempts. Please wait ${remainingSecs} seconds before trying again.`);
    }

    // Reset lockout if window has passed
    if (record.lockedUntil && now >= record.lockedUntil) {
      this._attempts.delete(ip);
    }
  }

  private _recordFailedAttempt(ip: string): void {
    const now = Date.now();
    const record = this._attempts.get(ip) || { failedAttempts: 0, lastAttemptAt: now };
    record.failedAttempts++;
    record.lastAttemptAt = now;

    if (record.failedAttempts >= PAIRING_MAX_FAILED_ATTEMPTS) {
      record.lockedUntil = now + PAIRING_LOCKOUT_DURATION_MS;
      console.warn(`[PairingManager] IP ${ip} locked out for 10 minutes after ${record.failedAttempts} failed pairing attempts.`);
    }

    this._attempts.set(ip, record);
  }

  private _clearFailedAttempts(ip: string): void {
    this._attempts.delete(ip);
  }

  // ---------------------------------------------------------------------------
  // Pairing Flow
  // ---------------------------------------------------------------------------

  /** Generate a new 6-character ephemeral pairing PIN. */
  generatePairCode(createdByIp = "127.0.0.1"): { code: string; expiresAt: string; ttlSeconds: number } {
    // Generate 6 uppercase alphanumeric characters avoiding confusing chars (0/O, 1/I)
    const chars = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
    let code = "";
    const bytes = crypto.randomBytes(6);
    for (let i = 0; i < 6; i++) {
      code += chars[bytes[i] % chars.length];
    }

    const now = Date.now();
    const expiresAt = now + PAIRING_CODE_TTL_MS;

    this._activeSession = {
      code,
      createdAt: now,
      expiresAt,
      consumed: false,
      createdByIp,
    };

    console.log(`[PairingManager] Generated ephemeral pairing code (expires in 5 minutes).`);
    return {
      code,
      expiresAt: new Date(expiresAt).toISOString(),
      ttlSeconds: Math.floor(PAIRING_CODE_TTL_MS / 1000),
    };
  }

  /**
   * Generates a bootstrap pairing code for initial device setup if and only if
   * zero devices are currently registered in the database and no active bootstrap PIN exists.
   * Atomically prevents concurrent requests from creating multiple initial setup PINs.
   */
  async generateBootstrapPairCode(
    clientIp = "unknown",
  ): Promise<{ code: string; expiresAt: string; ttlSeconds: number; isBootstrap: true }> {
    const devices = await remoteStore.listDevices();
    if (devices.length > 0) {
      throw new Error(
        "BOOTSTRAP_CLOSED: Initial device bootstrap is permanently closed. Existing admin token or localhost access required.",
      );
    }

    const now = Date.now();
    if (
      this._activeSession &&
      !this._activeSession.consumed &&
      now <= this._activeSession.expiresAt
    ) {
      throw new Error(
        "BOOTSTRAP_CONFLICT: An initial bootstrap pairing code is already active. Please use the active code or wait for it to expire.",
      );
    }

    const codeInfo = this.generatePairCode(clientIp);
    if (this._activeSession) {
      this._activeSession.isBootstrap = true;
    }
    return { ...codeInfo, isBootstrap: true };
  }

  /** Return the currently active unexpired pairing code info (if any). */
  getActivePairCode(): { code: string; expiresAt: string; remainingSeconds: number } | null {
    if (!this._activeSession) return null;
    const now = Date.now();
    if (this._activeSession.consumed || now > this._activeSession.expiresAt) {
      this._activeSession = null;
      return null;
    }
    return {
      code: this._activeSession.code,
      expiresAt: new Date(this._activeSession.expiresAt).toISOString(),
      remainingSeconds: Math.max(0, Math.ceil((this._activeSession.expiresAt - now) / 1000)),
    };
  }

  /**
   * Pair a remote device using the ephemeral PIN.
   * Enforces brute-force lockout, single-use PIN, and issues signed device token.
   * If redeeming an initial bootstrap code or this is the very first registered device,
   * it is granted 'admin' role. Subsequent devices default to 'standard'.
   */
  async pairDevice(opts: {
    code: string;
    deviceName: string;
    deviceType?: DeviceType;
    ipAddress: string;
    userAgent?: string;
    role?: DeviceRole;
  }): Promise<{ device: PairedDevice; token: string }> {
    const ip = opts.ipAddress || "unknown";
    this._checkLockout(ip);

    const now = Date.now();
    if (!this._activeSession || this._activeSession.consumed || now > this._activeSession.expiresAt) {
      this._recordFailedAttempt(ip);
      throw new Error("INVALID_PAIR_CODE: No active pairing session or code has expired. Request a new PIN on desktop.");
    }

    // Constant-time code comparison
    const inputCode = (opts.code || "").trim().toUpperCase();
    const targetCode = this._activeSession.code;

    const inputBuf = Buffer.from(inputCode);
    const targetBuf = Buffer.from(targetCode);

    const codesMatch = inputBuf.length === targetBuf.length && crypto.timingSafeEqual(inputBuf, targetBuf);

    if (!codesMatch) {
      this._recordFailedAttempt(ip);
      throw new Error("INVALID_PAIR_CODE: Incorrect pairing PIN entered.");
    }

    // Determine role: initial bootstrap device or zero-device first claim MUST be admin
    const existingDevices = await remoteStore.listDevices();
    const isFirstDevice = existingDevices.length === 0;
    const isBootstrapClaim = Boolean(this._activeSession.isBootstrap);

    let assignedRole: DeviceRole = opts.role || DEFAULT_DEVICE_ROLE;
    if (isFirstDevice || isBootstrapClaim) {
      assignedRole = "admin";
    }

    // Success: consume the code immediately (single-use)
    const deviceId = crypto.randomUUID();
    this._activeSession.consumed = true;
    this._activeSession.consumedByDeviceId = deviceId;
    this._clearFailedAttempts(ip);

    const token = this.signDeviceToken(deviceId);
    const tokenHash = this.hashToken(token);

    const device: PairedDevice = {
      id: deviceId,
      name: opts.deviceName?.trim() || `Remote Device ${deviceId.slice(0, 6)}`,
      deviceType: opts.deviceType || "mobile",
      role: assignedRole,
      tokenHash,
      pairedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      lastIp: ip,
      userAgent: opts.userAgent || "Unknown",
      revoked: false,
    };

    await remoteStore.saveDevice(device);
    console.log(`[PairingManager] Device paired successfully: '${device.name}' (ID: ${device.id}, Role: ${device.role})`);

    return { device, token };
  }

  /** Reset active session and failed attempts (for tests). */
  reset(): void {
    this._activeSession = null;
    this._attempts.clear();
  }
}

export const pairingManager = new PairingManager();
