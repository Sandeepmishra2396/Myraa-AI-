/**
 * MYRAA — RemoteTypes (Phase 7)
 *
 * Core type definitions for Remote Voice Companion:
 *   - Device roles and permission contracts
 *   - Ephemeral pairing requests, sessions, and lockouts
 *   - Device tokens and active remote sessions
 *   - Emergency stop state and audit structures
 *   - Remote WebSocket protocol messages
 */

export type DeviceRole = "read_only" | "standard" | "admin";

export type DeviceType = "mobile" | "tablet" | "browser" | "desktop_client";

export interface PairedDevice {
  id: string;               // Unique device UUID
  name: string;             // Friendly name e.g. "Sandeep's iPhone"
  deviceType: DeviceType;
  role: DeviceRole;
  tokenHash: string;        // SHA-256 hash of the issued device token
  pairedAt: string;         // ISO timestamp
  lastSeenAt: string;       // ISO timestamp
  lastIp?: string;
  userAgent?: string;
  revoked: boolean;
  revokedAt?: string;
  revokedReason?: string;
}

export interface PairingSession {
  code: string;             // 6-character alphanumeric uppercase PIN, e.g. "SR8492"
  createdAt: number;        // Epoch ms
  expiresAt: number;        // Epoch ms (5 minutes from creation)
  consumed: boolean;
  consumedByDeviceId?: string;
  createdByIp: string;
  isBootstrap?: boolean;
}

export interface PairingAttemptRecord {
  failedAttempts: number;
  lastAttemptAt: number;
  lockedUntil?: number;     // Lockout timestamp if failedAttempts >= MAX_FAILED_ATTEMPTS
}

export interface RemoteSession {
  sessionId: string;
  deviceId: string;
  deviceName: string;
  role: DeviceRole;
  connectedAt: string;
  lastHeartbeatAt: string;
  ipAddress: string;
  userAgent: string;
  authenticated: boolean;
}

export interface EmergencyStopState {
  active: boolean;
  triggeredAt?: string;
  triggeredBy?: {
    source: "remote_device" | "desktop_ui" | "tool" | "rest_api";
    deviceId?: string;
    deviceName?: string;
    ipAddress?: string;
  };
  reason?: string;
  resetAt?: string;
  resetBy?: string;
}

export interface RemoteVoiceMessage {
  type: "auth" | "audio" | "ping" | "pong" | "emergency_stop" | "text_command";
  token?: string;
  audio?: string;           // Base64 PCM16
  text?: string;
  timestamp?: string;
}

// ---------------------------------------------------------------------------
// Security Configuration Constants
// ---------------------------------------------------------------------------

export const PAIRING_CODE_TTL_MS = 5 * 60 * 1000;       // 5 minutes
export const PAIRING_MAX_FAILED_ATTEMPTS = 5;            // Lockout after 5 failed attempts
export const PAIRING_LOCKOUT_DURATION_MS = 10 * 60 * 1000; // 10 minutes lockout
export const MAX_REMOTE_MESSAGE_SIZE = 256 * 1024;      // 256 KB max WebSocket message
export const MAX_AUDIO_FRAME_SIZE = 64 * 1024;          // 64 KB max PCM chunk
export const REMOTE_SESSION_HEARTBEAT_TIMEOUT_MS = 60 * 1000; // 60 seconds
export const DEFAULT_DEVICE_ROLE: DeviceRole = "standard";
