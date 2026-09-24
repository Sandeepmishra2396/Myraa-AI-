/**
 * MYRAA — AndroidSecurityTypes (Phase 28)
 *
 * Type contracts for the Mobile Emergency & Security Layer.
 * These types describe the sanitized, non-executable security state surfaces
 * that the Android client is permitted to observe.
 *
 * CRITICAL INVARIANTS:
 *   - No raw tokens, credentials, secrets, session IDs, or private IPs in any response.
 *   - Android observes security state; the backend remains the security authority.
 *   - All mutations are server-authoritative (Phase 10A–10F + Phase 17).
 */

// ---------------------------------------------------------------------------
// Sanitized Security Status (read-only observable by Android)
// ---------------------------------------------------------------------------

export interface SuspiciousEventSummary {
  /** Category label — no raw token/session data. */
  eventCategory:
    | "AUTH_FAILURE"
    | "TOKEN_REPLAY"
    | "UNKNOWN_DEVICE"
    | "REMOTE_ANOMALY"
    | "SUSPICIOUS_ACTIVITY"
    | "BRUTE_FORCE"
    | "NONCE_REPLAY";
  /** Human-readable severity. */
  severityLabel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  /** ISO 8601 approximate timestamp (minute-floored for privacy). */
  approximateTime: string;
  /** How many times this category was observed in the recent window. */
  count: number;
  /** Generic description — no credentials, IPs, or tokens. */
  description: string;
}

export interface ActiveSessionSummary {
  /** Server-assigned session ID (safe to surface to admin). */
  sessionId: string;
  /** Display name of the device owning this session. */
  deviceName: string;
  /** DeviceType: mobile | tablet | browser | desktop_client. */
  deviceType: string;
  /** Role: admin | standard | read_only. */
  role: string;
  /** ISO 8601 connection time. */
  connectedAt: string;
  /** Masked IP: e.g. "192.168.*.*" or "::ffff:127.*.*.*". */
  maskedIp: string;
}

export interface SecurityStatusResponse {
  /** True if the global Emergency Stop is currently active. */
  emergencyStopActive: boolean;
  /** ISO 8601 time Emergency Stop was triggered (null if not active). */
  emergencyStopTriggeredAt?: string;
  /** Source that triggered Emergency Stop (sanitized). */
  emergencyStopSource?: string;

  /** True if Security Lockdown is active. */
  lockdownActive: boolean;

  /** True if this device is flagged as lost. */
  thisDeviceLostMode: boolean;

  /** Total active WebSocket sessions at time of query. */
  activeSessionCount: number;

  /** Sanitized summary of recent suspicious security events (max 10). */
  recentSuspiciousEvents: SuspiciousEventSummary[];

  /** ISO 8601 timestamp of this status snapshot. */
  snapshotAt: string;
}

// ---------------------------------------------------------------------------
// Lost-Device Record (server-authoritative persistence)
// ---------------------------------------------------------------------------

export interface LostDeviceRecord {
  deviceId: string;
  enabledAt: string;    // ISO 8601
  enabledBy: string;    // "admin" | "localhost" | deviceId of admin
  reason: string;
  recovered: boolean;
  recoveredAt?: string; // ISO 8601
  recoveredBy?: string;
}

// ---------------------------------------------------------------------------
// Security Control Requests & Results
// ---------------------------------------------------------------------------

/**
 * Common request envelope for sensitive security control actions.
 * Nonce + timestamp provide idempotent replay-protection.
 */
export interface SecurityControlRequest {
  /** Cryptographic nonce (min 16 chars UUID). */
  nonce: string;
  /** Client wall-clock in milliseconds. */
  timestampMs: number;
  /** Human-readable reason for audit trail. */
  reason?: string;
}

export interface SecurityControlResult {
  success: boolean;
  errorCode?:
    | "UNAUTHORIZED"
    | "DEVICE_NOT_FOUND"
    | "DEVICE_ALREADY_LOST"
    | "DEVICE_NOT_LOST"
    | "ALREADY_IN_LOCKDOWN"
    | "NOT_IN_LOCKDOWN"
    | "ALREADY_IN_EMERGENCY_STOP"
    | "REPLAY_ATTACK"
    | "EMERGENCY_STOP_ACTIVE"
    | "INTERNAL_ERROR";
  message: string;
  /** Updated snapshot after the action (may be absent on error). */
  updatedStatus?: Partial<SecurityStatusResponse>;
}
