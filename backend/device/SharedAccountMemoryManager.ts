/**
 * MYRAA — Phase 7: Shared Account & Cross-Device Memory
 *
 * Implements Shared Account & Cross-Device Memory on top of the locked Phase 4–6
 * multi-device architecture:
 *   A. Unified Account (same account works independently on MYRAA Mobile & MYRAA Desktop)
 *   B. Shared Memory (cross-device facts, notes, long-term context)
 *   C. Shared Preferences (e.g. "Hinglish preference" saved on Phone -> available on Desktop)
 *   D. Shared Tasks (eligible cross-device tasks & reminders)
 *   E. Device-Local Memory (e.g. "current_window" stays strictly on Desktop; never synced)
 *   F. Deterministic Conflict Resolution (timestamp -> clientVersion -> mutationId -> deviceId)
 *   G. Idempotent Cross-Device Sync (mutationId deduplication + content deduplication)
 *   H. Bounded Persistent Offline Queue (queues writes while offline, flushes on reconnect)
 *
 * Core Invariants:
 *   - PHONE != REMOTE DESKTOP, DESKTOP != PHONE, ACCOUNT != DEVICE
 *   - SAME ACCOUNT != AUTOMATIC REMOTE CONNECTION (RemoteBridge remains INACTIVE/DISCONNECTED)
 *   - Device-local context MUST remain device-scoped and NEVER leak into shared memory.
 *   - Only authorized, non-revoked, non-lost account devices may mutate or sync shared state.
 *   - Reuses IdentityAuthManager, OutputDataFirewall (DLP), isDlpClean, SecurityAuditLogger,
 *     EmergencyStopCoordinator, and SecurityPolicyEngine.
 */

import crypto from "crypto";
import type { ProductType } from "./DeviceTypes.ts";
import { deviceRegistry } from "./DeviceRegistry.ts";
import { remoteBridge } from "./RemoteBridge.ts";
import { isDlpClean } from "../memory/SharedMemoryManager.ts";
import { identityAuthManager } from "../security/IdentityAuthManager.ts";
import { outputDataFirewall } from "../security/OutputDataFirewall.ts";
import { securityAuditLogger } from "../security/SecurityAuditLogger.ts";
import { securityPolicyEngine } from "../security/SecurityPolicyEngine.ts";
import { emergencyStopCoordinator } from "../remote/EmergencyStopCoordinator.ts";
import type { IdentityRole, SecurityContext } from "../security/SecurityTypes.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MAX_OFFLINE_QUEUE_SIZE = 100;

/**
 * Keys that represent strictly device-local runtime/hardware state and MUST NEVER
 * be stored in or synced through Shared Account Memory.
 */
export const DEVICE_LOCAL_CONTEXT_KEYS: ReadonlySet<string> = new Set([
  // Desktop-local window / editor / process / browser tab state
  "current_window",
  "active_window",
  "focused_window",
  "window_title",
  "window_handle",
  "window_bounds",
  "open_tab",
  "active_tab",
  "browser_tab_id",
  "youtube_results",
  "selected_search_result",
  "open_file",
  "current_file",
  "active_file",
  "cursor_position",
  "editor_selection",
  "vscode_workspace",
  "terminal_cwd",
  "local_process_pid",
  "clipboard_buffer",
  "screen_capture",
  "desktop_screenshot",

  // Mobile-local hardware / foreground / sensor state
  "foreground_app",
  "current_app_activity",
  "battery_level",
  "charging_state",
  "network_ssid",
  "cell_signal_strength",
  "gps_coordinates",
  "sensor_state",
  "ringer_mode",
  "screen_lock_state",
  "local_alarm_ringing",
  "mobile_screen_ocr",
]);

/**
 * Prefixes that always classify a key as DEVICE_LOCAL.
 */
const DEVICE_LOCAL_PREFIXES: readonly string[] = [
  "local.",
  "device_local.",
  "desktop_local.",
  "mobile_local.",
  "window.",
  "process.",
  "hardware.",
  "sensor.",
];

// ---------------------------------------------------------------------------
// Types & Interfaces
// ---------------------------------------------------------------------------

export type DataScope = "SHARED" | "DEVICE_LOCAL";

export type SharedItemDomain = "PREFERENCE" | "MEMORY" | "TASK";

export type DataClassificationDomain = SharedItemDomain | "DEVICE_LOCAL";

export type AccountSyncErrorCode =
  | "ACCOUNT_NOT_FOUND"
  | "DEVICE_NOT_REGISTERED"
  | "DEVICE_UNAUTHORIZED"
  | "DEVICE_REVOKED"
  | "DEVICE_LOST"
  | "DEVICE_LOCAL_SCOPE_VIOLATION"
  | "DLP_SECRET_REJECTED"
  | "EMERGENCY_STOP_ACTIVE"
  | "SECURITY_LOCKDOWN_ACTIVE"
  | "OFFLINE_QUEUE_FULL"
  | "DEVICE_OFFLINE"
  | "INVALID_MUTATION";

export interface DataScopeClassification {
  scope: DataScope;
  domain: DataClassificationDomain;
  normalizedKey: string;
  reason: string;
}

export interface AccountDeviceRegistration {
  deviceId: string;
  deviceName: string;
  productType: ProductType;
  accountId: string;
  role: IdentityRole;
  sessionId: string;
  accessToken: string;
  refreshToken: string;
  authorized: boolean;
  revoked: boolean;
  lost: boolean;
  online: boolean;
  registeredAt: string;
  lastSeenAt: string;
  lastSyncedVersion: number;
  lastSyncedAt: string | null;
}

export interface UnifiedAccountRecord {
  accountId: string;
  displayName: string;
  email?: string;
  role: IdentityRole;
  createdAt: string;
  updatedAt: string;
  ledgerVersion: number;
}

export interface SharedAccountItem<T = unknown> {
  itemId: string;
  accountId: string;
  domain: SharedItemDomain;
  scope: "SHARED";
  key: string;
  value: T;
  category?: string;
  status?: "pending" | "in_progress" | "completed" | "cancelled" | "active";
  version: number;
  ledgerSequence: number;
  updatedAt: string;
  updatedAtMs: number;
  originDeviceId: string;
  originProductType: ProductType;
  lastMutationId: string;
  deleted?: boolean;
}

export interface DeviceLocalItem<T = unknown> {
  itemId: string;
  deviceId: string;
  productType: ProductType;
  accountId?: string;
  scope: "DEVICE_LOCAL";
  key: string;
  value: T;
  updatedAt: string;
  updatedAtMs: number;
}

export interface ConflictResolutionDetail {
  conflictDetected: boolean;
  winner: "INCOMING" | "EXISTING";
  tieBreakerUsed: "NONE" | "TIMESTAMP" | "CLIENT_VERSION" | "MUTATION_ID" | "DEVICE_ID";
  previousVersion: number;
  resolvedVersion: number;
  reason: string;
}

export type AccountMutationOperation = "UPSERT" | "DELETE";

export interface AccountSyncMutation<T = unknown> {
  mutationId: string;
  accountId: string;
  deviceId: string;
  productType?: ProductType;
  domain: SharedItemDomain;
  operation?: AccountMutationOperation;
  key: string;
  value: T;
  category?: string;
  status?: "pending" | "in_progress" | "completed" | "cancelled" | "active";
  baseVersion?: number;
  clientVersion?: number;
  timestamp?: string;
  timestampMs?: number;
  explicitScope?: DataScope;
}

export interface QueuedOfflineMutation<T = unknown> {
  queueEntryId: string;
  queuedAt: string;
  queuedAtMs: number;
  mutation: AccountSyncMutation<T>;
}

export interface SharedWriteResult<T = unknown> {
  ok: boolean;
  status: "APPLIED" | "QUEUED_OFFLINE" | "DEDUPLICATED" | "CONFLICT_RESOLVED" | "REJECTED";
  scope: DataScope;
  domain: DataClassificationDomain;
  item?: SharedAccountItem<T>;
  localItem?: DeviceLocalItem<T>;
  queuedMutation?: QueuedOfflineMutation<T>;
  conflict?: ConflictResolutionDetail;
  deduplicated?: boolean;
  bridgeRemainsDisconnected: boolean;
  errorCode?: AccountSyncErrorCode;
  message: string;
}

export interface AccountSyncBatchResult {
  ok: boolean;
  accountId: string;
  deviceId: string;
  appliedCount: number;
  deduplicatedCount: number;
  conflictsResolvedCount: number;
  rejectedCount: number;
  rejectedMutations: Array<{
    mutationId: string;
    key: string;
    errorCode: AccountSyncErrorCode;
    reason: string;
  }>;
  preferences: Record<string, SharedAccountItem>;
  memories: SharedAccountItem[];
  tasks: SharedAccountItem[];
  ledgerVersion: number;
  bridgeRemainsDisconnected: boolean;
  errorCode?: AccountSyncErrorCode;
  message: string;
}

export interface AccountStateSnapshot {
  ok: boolean;
  accountId: string;
  deviceId: string;
  ledgerVersion: number;
  preferences: Record<string, SharedAccountItem>;
  memories: SharedAccountItem[];
  tasks: SharedAccountItem[];
  deviceLocal: Record<string, DeviceLocalItem>;
  bridgeRemainsDisconnected: boolean;
  errorCode?: AccountSyncErrorCode;
  message: string;
}

// ---------------------------------------------------------------------------
// Internal Per-Account Store State
// ---------------------------------------------------------------------------

interface AccountInternalState {
  record: UnifiedAccountRecord;
  devices: Map<string, AccountDeviceRegistration>;
  preferences: Map<string, SharedAccountItem>;
  memories: Map<string, SharedAccountItem>;
  tasks: Map<string, SharedAccountItem>;
  appliedMutations: Map<string, SharedAccountItem>;
  contentFingerprints: Map<string, SharedAccountItem>;
}

// ---------------------------------------------------------------------------
// SharedAccountMemoryManager Implementation
// ---------------------------------------------------------------------------

export class SharedAccountMemoryManager {
  private _accounts = new Map<string, AccountInternalState>();
  private _deviceLocalStore = new Map<string, Map<string, DeviceLocalItem>>();
  private _offlineQueues = new Map<string, QueuedOfflineMutation[]>();
  private _persistedQueueSnapshots = new Map<string, string>();
  private _maxOfflineQueueSize = MAX_OFFLINE_QUEUE_SIZE;

  // =========================================================================
  // E. DATA SCOPE CLASSIFICATION (SHARED vs DEVICE_LOCAL)
  // =========================================================================

  /**
   * Deterministically classifies a data item as SHARED or DEVICE_LOCAL before
   * storing or syncing.
   *
   * Examples:
   *   - "hinglish_preference" / "language_preference" -> SHARED (PREFERENCE)
   *   - "current_window" / "active_tab" / "open_file" / "battery_level" -> DEVICE_LOCAL
   */
  classifyDataScope(params: {
    key: string;
    domain?: DataClassificationDomain;
    category?: string;
    explicitScope?: DataScope;
  }): DataScopeClassification {
    const rawKey = String(params.key || "").trim();
    const normalizedKey = rawKey
      .toLowerCase()
      .replace(/[\s\-]+/g, "_")
      .replace(/[^a-z0-9_.:]/g, "");

    const normCategory = String(params.category || "")
      .trim()
      .toLowerCase()
      .replace(/[\s\-]+/g, "_");

    // 1. Check hard DEVICE_LOCAL key list and prefixes first (even if caller asked for SHARED!)
    if (
      DEVICE_LOCAL_CONTEXT_KEYS.has(normalizedKey) ||
      DEVICE_LOCAL_CONTEXT_KEYS.has(normCategory) ||
      DEVICE_LOCAL_PREFIXES.some((prefix) => normalizedKey.startsWith(prefix)) ||
      normalizedKey.includes("current_window") ||
      normalizedKey.includes("active_window") ||
      normalizedKey.includes("window_handle") ||
      normalizedKey.includes("foreground_app") ||
      normalizedKey.includes("clipboard_buffer")
    ) {
      return {
        scope: "DEVICE_LOCAL",
        domain: "DEVICE_LOCAL",
        normalizedKey,
        reason: `Key '${rawKey}' represents device-local runtime/hardware state and must never sync across devices.`,
      };
    }

    // 2. If caller explicitly requested DEVICE_LOCAL scope or domain
    if (params.explicitScope === "DEVICE_LOCAL" || params.domain === "DEVICE_LOCAL") {
      return {
        scope: "DEVICE_LOCAL",
        domain: "DEVICE_LOCAL",
        normalizedKey,
        reason: `Key '${rawKey}' was explicitly classified as DEVICE_LOCAL.`,
      };
    }

    // 3. Determine SHARED domain (PREFERENCE, MEMORY, or TASK)
    let domain: SharedItemDomain = "MEMORY";
    if (
      params.domain === "PREFERENCE" ||
      params.domain === "MEMORY" ||
      params.domain === "TASK"
    ) {
      domain = params.domain;
    } else if (
      normalizedKey.endsWith("_preference") ||
      normalizedKey.startsWith("pref_") ||
      normalizedKey.startsWith("preference.") ||
      normCategory === "preference" ||
      normCategory === "preferences" ||
      normalizedKey === "language" ||
      normalizedKey === "hinglish" ||
      normalizedKey === "theme" ||
      normalizedKey === "voice" ||
      normalizedKey === "timezone"
    ) {
      domain = "PREFERENCE";
    } else if (
      normalizedKey.startsWith("task_") ||
      normalizedKey.startsWith("task.") ||
      normCategory === "task" ||
      normCategory === "tasks" ||
      normCategory === "reminder" ||
      normCategory === "todo"
    ) {
      domain = "TASK";
    }

    return {
      scope: "SHARED",
      domain,
      normalizedKey,
      reason: `Key '${rawKey}' is classified as SHARED (${domain}) for cross-device account sync.`,
    };
  }

  // =========================================================================
  // A. UNIFIED ACCOUNT & AUTHORIZED DEVICE REGISTRATION
  // =========================================================================

  /**
   * Create or update a Unified Account record.
   */
  registerAccount(params: {
    accountId: string;
    displayName?: string;
    email?: string;
    role?: IdentityRole;
  }): UnifiedAccountRecord {
    const existing = this._accounts.get(params.accountId);
    const now = new Date().toISOString();
    if (existing) {
      existing.record.displayName = params.displayName || existing.record.displayName;
      existing.record.email = params.email ?? existing.record.email;
      existing.record.role = params.role || existing.record.role;
      existing.record.updatedAt = now;
      return { ...existing.record };
    }

    const record: UnifiedAccountRecord = {
      accountId: params.accountId,
      displayName: params.displayName || params.accountId,
      email: params.email,
      role: params.role || "admin",
      createdAt: now,
      updatedAt: now,
      ledgerVersion: 0,
    };

    this._accounts.set(params.accountId, {
      record,
      devices: new Map(),
      preferences: new Map(),
      memories: new Map(),
      tasks: new Map(),
      appliedMutations: new Map(),
      contentFingerprints: new Map(),
    });

    return { ...record };
  }

  /**
   * Register and authorize a MYRAA Mobile or MYRAA Desktop device under a Unified Account.
   *
   * CRITICAL INVARIANT:
   *   Same account login/registration NEVER activates RemoteBridge.
   *   Both MYRAA_MOBILE and MYRAA_DESKTOP work independently with shared account state
   *   while RemoteBridge remains INACTIVE / DISCONNECTED.
   */
  registerAccountDevice(params: {
    accountId: string;
    deviceId: string;
    deviceName: string;
    productType: ProductType;
    role?: IdentityRole;
    online?: boolean;
    ipAddress?: string;
  }): AccountDeviceRegistration {
    if (!this._accounts.has(params.accountId)) {
      this.registerAccount({
        accountId: params.accountId,
        role: params.role || "admin",
      });
    }

    const account = this._accounts.get(params.accountId)!;
    const role = params.role || account.record.role || "admin";
    const now = new Date().toISOString();

    // Issue cryptographic session via existing IdentityAuthManager
    const { session, tokens } = identityAuthManager.createSession({
      deviceId: params.deviceId,
      identityId: params.accountId,
      role,
      ipAddress: params.ipAddress || "127.0.0.1",
      userAgent: `MYRAA-AccountSync/${params.productType}/${params.deviceId}`,
    });

    const registration: AccountDeviceRegistration = {
      deviceId: params.deviceId,
      deviceName: params.deviceName,
      productType: params.productType,
      accountId: params.accountId,
      role,
      sessionId: session.sessionId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      authorized: true,
      revoked: false,
      lost: false,
      online: params.online ?? true,
      registeredAt: now,
      lastSeenAt: now,
      lastSyncedVersion: 0,
      lastSyncedAt: null,
    };

    account.devices.set(params.deviceId, registration);

    // Ensure device is registered in DeviceRegistry with bridgeConnected = false!
    const existingIdentity = deviceRegistry.getDevice(params.deviceId);
    const currentBridge = deviceRegistry.getBridgeStatus(params.deviceId);
    deviceRegistry.registerDevice({
      deviceId: params.deviceId,
      deviceName: params.deviceName,
      productType: params.productType,
      accountId: params.accountId,
      registered: true,
      registeredAt: existingIdentity?.registeredAt || now,
      lastSeenAt: now,
      bridgeConnected: currentBridge.state === "ACTIVE",
      bridgeTargetDeviceId: currentBridge.targetDeviceId,
      disabledCapabilities: existingIdentity?.disabledCapabilities || [],
    });

    securityAuditLogger.logEvent({
      eventType: "SESSION_CREATED",
      actor: {
        identityId: params.accountId,
        role,
        ipAddress: params.ipAddress || "127.0.0.1",
        sessionId: session.sessionId,
        deviceId: params.deviceId,
      },
      target: { resource: `account:${params.accountId}` },
      decision: "ALLOW",
      reason: `Device '${params.deviceId}' (${params.productType}) registered to account '${params.accountId}'. RemoteBridge remains INACTIVE.`,
      riskLevel: "LOW",
    });

    return { ...registration };
  }

  getAccount(accountId: string): UnifiedAccountRecord | undefined {
    const acc = this._accounts.get(accountId);
    return acc ? { ...acc.record } : undefined;
  }

  getAccountDevices(accountId: string): AccountDeviceRegistration[] {
    const acc = this._accounts.get(accountId);
    if (!acc) return [];
    return Array.from(acc.devices.values()).map((d) => ({ ...d }));
  }

  getAccountDevice(accountId: string, deviceId: string): AccountDeviceRegistration | undefined {
    const acc = this._accounts.get(accountId);
    const dev = acc?.devices.get(deviceId);
    return dev ? { ...dev } : undefined;
  }

  // =========================================================================
  // DEVICE ONLINE / OFFLINE & REVOCATION / LOST SAFETY
  // =========================================================================

  /**
   * Toggle online/offline connectivity state for a device.
   * Does NOT automatically flush offline queue unless reconnectAndSync() is called,
   * or autoSyncOnReconnect is passed as true.
   */
  setDeviceOnline(
    accountId: string,
    deviceId: string,
    online: boolean,
  ): { ok: boolean; online: boolean; queuedCount: number } {
    const acc = this._accounts.get(accountId);
    const dev = acc?.devices.get(deviceId);
    if (dev) {
      dev.online = online;
      dev.lastSeenAt = new Date().toISOString();
    }
    const queue = this._offlineQueues.get(deviceId) || [];
    return {
      ok: Boolean(dev),
      online,
      queuedCount: queue.length,
    };
  }

  /**
   * Revoke a device from the account.
   * Immediately blocks all future shared writes, reads, and offline syncs from this device,
   * revokes its session in IdentityAuthManager, and disconnects RemoteBridge if active.
   */
  revokeAccountDevice(
    accountId: string,
    deviceId: string,
    reason = "Device revoked by account owner",
  ): { ok: boolean; deviceId: string; reason: string } {
    const acc = this._accounts.get(accountId);
    const dev = acc?.devices.get(deviceId);
    if (dev) {
      dev.authorized = false;
      dev.revoked = true;
      identityAuthManager.revokeSession(dev.sessionId, reason);
    }
    identityAuthManager.revokeDevice(deviceId, accountId);
    remoteBridge.revokeDeviceAuthorization(deviceId, reason);

    // Clear or quarantine any pending offline mutations from the revoked device
    this._offlineQueues.delete(deviceId);
    this._persistedQueueSnapshots.delete(deviceId);

    securityAuditLogger.logEvent({
      eventType: "DEVICE_REVOKED",
      actor: {
        identityId: accountId,
        role: dev?.role || "admin",
        ipAddress: "127.0.0.1",
        deviceId,
      },
      target: { resource: `account:${accountId}` },
      decision: "REVOKE",
      reason: `Account device '${deviceId}' revoked from shared sync: ${reason}`,
      riskLevel: "HIGH",
    });

    return { ok: true, deviceId, reason };
  }

  /**
   * Mark an account device as lost.
   * Immediately blocks all shared writes/syncs and disconnects RemoteBridge if active.
   */
  markAccountDeviceLost(
    accountId: string,
    deviceId: string,
    reason = "Device marked lost",
  ): { ok: boolean; deviceId: string; reason: string } {
    const acc = this._accounts.get(accountId);
    const dev = acc?.devices.get(deviceId);
    if (dev) {
      dev.authorized = false;
      dev.lost = true;
      identityAuthManager.revokeSession(dev.sessionId, reason);
    }
    identityAuthManager.revokeDevice(deviceId, accountId);
    remoteBridge.markDeviceLost(deviceId, accountId);

    this._offlineQueues.delete(deviceId);
    this._persistedQueueSnapshots.delete(deviceId);

    securityAuditLogger.logEvent({
      eventType: "LOST_DEVICE_ENABLED",
      actor: {
        identityId: accountId,
        role: dev?.role || "admin",
        ipAddress: "127.0.0.1",
        deviceId,
      },
      target: { resource: `account:${accountId}` },
      decision: "REVOKE",
      reason: `Account device '${deviceId}' marked lost; shared account sync blocked: ${reason}`,
      riskLevel: "CRITICAL",
    });

    return { ok: true, deviceId, reason };
  }

  // =========================================================================
  // PRE-FLIGHT SECURITY & ACCOUNT AUTHORIZATION GATES
  // =========================================================================

  private _checkSecurityAndDeviceAuth(params: {
    accountId: string;
    deviceId: string;
    accessToken?: string;
    secContext?: SecurityContext;
  }): {
    allowed: boolean;
    account?: AccountInternalState;
    device?: AccountDeviceRegistration;
    errorCode?: AccountSyncErrorCode;
    message?: string;
  } {
    // 1. Emergency Stop Gate
    if (emergencyStopCoordinator.isActive()) {
      return {
        allowed: false,
        errorCode: "EMERGENCY_STOP_ACTIVE",
        message: "EMERGENCY_STOP_ACTIVE: Shared account sync and mutations are blocked while Emergency Stop is active.",
      };
    }

    // 2. Security Lockdown Gate
    if (securityPolicyEngine.getMode() === "LOCKDOWN") {
      return {
        allowed: false,
        errorCode: "SECURITY_LOCKDOWN_ACTIVE",
        message: "SECURITY_LOCKDOWN_ACTIVE: Shared account sync and mutations are blocked during Security Lockdown.",
      };
    }

    // 3. Account existence check
    const account = this._accounts.get(params.accountId);
    if (!account) {
      return {
        allowed: false,
        errorCode: "ACCOUNT_NOT_FOUND",
        message: `ACCOUNT_NOT_FOUND: Account '${params.accountId}' does not exist.`,
      };
    }

    // 4. Device registration & same-account membership check
    const device = account.devices.get(params.deviceId);
    if (!device || device.accountId !== params.accountId) {
      return {
        allowed: false,
        account,
        errorCode: "DEVICE_NOT_REGISTERED",
        message: `DEVICE_NOT_REGISTERED: Device '${params.deviceId}' is not registered to account '${params.accountId}'.`,
      };
    }

    // 5. Lost / Revoked checks (including cross-check with RemoteBridge)
    if (device.lost) {
      return {
        allowed: false,
        account,
        device,
        errorCode: "DEVICE_LOST",
        message: `DEVICE_LOST: Device '${params.deviceId}' is marked lost and cannot sync or mutate shared account data.`,
      };
    }

    if (device.revoked || !device.authorized) {
      return {
        allowed: false,
        account,
        device,
        errorCode: "DEVICE_REVOKED",
        message: `DEVICE_REVOKED: Device '${params.deviceId}' authorization has been revoked.`,
      };
    }

    // 6. Validate cryptographic session token via IdentityAuthManager
    const tokenToValidate = params.accessToken || device.accessToken;
    const tokenValidation = identityAuthManager.validateAccessToken(tokenToValidate);
    if (!tokenValidation.valid) {
      device.revoked = true;
      device.authorized = false;
      return {
        allowed: false,
        account,
        device,
        errorCode: "DEVICE_REVOKED",
        message: `DEVICE_REVOKED: Access token validation failed for device '${params.deviceId}': ${tokenValidation.error || "invalid token"}.`,
      };
    }

    return {
      allowed: true,
      account,
      device,
    };
  }

  /**
   * DLP & Sensitive Credential Check using SharedMemoryManager.isDlpClean + OutputDataFirewall.
   */
  private _validateAndSanitizeSharedValue<T>(
    key: string,
    value: T,
    sessionId?: string,
  ): { clean: boolean; sanitizedValue: T; reason?: string } {
    const serialized = typeof value === "string" ? value : JSON.stringify(value ?? "");
    if (!isDlpClean(key) || !isDlpClean(serialized)) {
      return {
        clean: false,
        sanitizedValue: value,
        reason: "DLP_SECRET_REJECTED: Secrets, API keys, passwords, tokens, or OTPs cannot be stored or synced in shared account state.",
      };
    }

    const { sanitized, redactedCount } = outputDataFirewall.sanitizeResult(value, {
      toolName: "shared_account_sync",
      sessionId,
    });

    if (redactedCount > 0) {
      return {
        clean: false,
        sanitizedValue: sanitized as T,
        reason: `DLP_SECRET_REJECTED: OutputDataFirewall blocked sensitive content (${redactedCount} redaction(s)).`,
      };
    }

    return {
      clean: true,
      sanitizedValue: sanitized as T,
    };
  }

  // =========================================================================
  // F. DETERMINISTIC CONFLICT RESOLUTION
  // =========================================================================

  /**
   * Deterministically resolves a concurrent modification between an existing
   * canonical SharedAccountItem and an incoming AccountSyncMutation.
   *
   * Tie-breaking hierarchy (never random, never overwrites newer data with older data):
   *   1. updatedAtMs (strictly newer timestamp wins)
   *   2. clientVersion (higher client version wins when timestamps are equal)
   *   3. mutationId (lexicographically greater mutationId wins when both above are equal)
   *   4. originDeviceId (lexicographically greater deviceId wins as final tie-breaker)
   */
  resolveConflict<T>(
    existing: SharedAccountItem<T>,
    incoming: {
      mutationId: string;
      deviceId: string;
      baseVersion?: number;
      clientVersion?: number;
      updatedAtMs: number;
    },
  ): ConflictResolutionDetail {
    const conflictDetected =
      incoming.baseVersion !== undefined
        ? incoming.baseVersion < existing.version
        : incoming.updatedAtMs < existing.updatedAtMs || existing.originDeviceId !== incoming.deviceId;

    if (!conflictDetected && incoming.updatedAtMs >= existing.updatedAtMs) {
      return {
        conflictDetected: false,
        winner: "INCOMING",
        tieBreakerUsed: "NONE",
        previousVersion: existing.version,
        resolvedVersion: existing.version + 1,
        reason: `Sequential update from base version ${existing.version} -> ${existing.version + 1}.`,
      };
    }

    // Rule 1: Timestamp comparison (strictly newer wins; never overwrite newer with older)
    if (incoming.updatedAtMs > existing.updatedAtMs) {
      return {
        conflictDetected: true,
        winner: "INCOMING",
        tieBreakerUsed: "TIMESTAMP",
        previousVersion: existing.version,
        resolvedVersion: existing.version + 1,
        reason: `Incoming mutation (${incoming.updatedAtMs}) is newer than existing version v${existing.version} (${existing.updatedAtMs}).`,
      };
    }

    if (incoming.updatedAtMs < existing.updatedAtMs) {
      return {
        conflictDetected: true,
        winner: "EXISTING",
        tieBreakerUsed: "TIMESTAMP",
        previousVersion: existing.version,
        resolvedVersion: existing.version,
        reason: `Existing record v${existing.version} (${existing.updatedAtMs}) is newer than incoming stale mutation (${incoming.updatedAtMs}). Retained newer data.`,
      };
    }

    // Rule 2: Equal timestamps -> compare clientVersion vs existing.version
    const incomingClientVer = incoming.clientVersion ?? (incoming.baseVersion ?? 0) + 1;
    if (incomingClientVer > existing.version) {
      return {
        conflictDetected: true,
        winner: "INCOMING",
        tieBreakerUsed: "CLIENT_VERSION",
        previousVersion: existing.version,
        resolvedVersion: existing.version + 1,
        reason: `Equal timestamp (${incoming.updatedAtMs}); incoming clientVersion (${incomingClientVer}) > existing version (${existing.version}).`,
      };
    }

    if (incomingClientVer < existing.version) {
      return {
        conflictDetected: true,
        winner: "EXISTING",
        tieBreakerUsed: "CLIENT_VERSION",
        previousVersion: existing.version,
        resolvedVersion: existing.version,
        reason: `Equal timestamp (${incoming.updatedAtMs}); existing version (${existing.version}) > incoming clientVersion (${incomingClientVer}).`,
      };
    }

    // Rule 3: Equal timestamps and equal versions -> lexicographical mutationId tie-breaker
    const mutCmp = incoming.mutationId.localeCompare(existing.lastMutationId);
    if (mutCmp > 0) {
      return {
        conflictDetected: true,
        winner: "INCOMING",
        tieBreakerUsed: "MUTATION_ID",
        previousVersion: existing.version,
        resolvedVersion: existing.version + 1,
        reason: `Equal timestamp & version; incoming mutationId '${incoming.mutationId}' > existing '${existing.lastMutationId}'.`,
      };
    }

    if (mutCmp < 0) {
      return {
        conflictDetected: true,
        winner: "EXISTING",
        tieBreakerUsed: "MUTATION_ID",
        previousVersion: existing.version,
        resolvedVersion: existing.version,
        reason: `Equal timestamp & version; existing mutationId '${existing.lastMutationId}' > incoming '${incoming.mutationId}'.`,
      };
    }

    // Rule 4: Device ID tie-breaker
    const devCmp = incoming.deviceId.localeCompare(existing.originDeviceId);
    const winner = devCmp >= 0 ? "INCOMING" : "EXISTING";
    return {
      conflictDetected: true,
      winner,
      tieBreakerUsed: "DEVICE_ID",
      previousVersion: existing.version,
      resolvedVersion: winner === "INCOMING" ? existing.version + 1 : existing.version,
      reason: `Deterministic deviceId tie-breaker (${incoming.deviceId} vs ${existing.originDeviceId}) -> ${winner}.`,
    };
  }

  // =========================================================================
  // CORE MUTATION APPLICATION & OFFLINE QUEUE ROUTING
  // =========================================================================

  private _getDomainMap(
    account: AccountInternalState,
    domain: SharedItemDomain,
  ): Map<string, SharedAccountItem> {
    switch (domain) {
      case "PREFERENCE":
        return account.preferences;
      case "MEMORY":
        return account.memories;
      case "TASK":
        return account.tasks;
    }
  }

  private _makeContentFingerprint(
    domain: SharedItemDomain,
    operation: AccountMutationOperation,
    normalizedKey: string,
    value: unknown,
    status?: string,
  ): string {
    const raw = JSON.stringify({
      domain,
      operation,
      key: normalizedKey,
      value,
      status: status || "active",
    });
    return crypto.createHash("sha256").update(raw).digest("hex");
  }

  /**
   * Internal engine to apply or queue a shared mutation after classification.
   */
  private _applyOrQueueSharedMutation<T>(
    mutation: AccountSyncMutation<T>,
    opts?: {
      accessToken?: string;
      secContext?: SecurityContext;
      bypassOfflineCheck?: boolean;
    },
  ): SharedWriteResult<T> {
    const bridgeDisconnected = !remoteBridge.isActive(mutation.deviceId);

    // 1. Classify scope BEFORE storing or syncing
    const classification = this.classifyDataScope({
      key: mutation.key,
      domain: mutation.domain,
      category: mutation.category,
      explicitScope: mutation.explicitScope,
    });

    if (classification.scope === "DEVICE_LOCAL") {
      securityAuditLogger.logEvent({
        eventType: "SECURITY_POLICY_VIOLATION",
        actor: {
          identityId: mutation.accountId,
          role: "admin",
          ipAddress: "127.0.0.1",
          deviceId: mutation.deviceId,
        },
        target: { resource: `shared:${mutation.domain}:${classification.normalizedKey}` },
        decision: "BLOCK",
        reason: classification.reason,
        riskLevel: "LOW",
      });

      return {
        ok: false,
        status: "REJECTED",
        scope: "DEVICE_LOCAL",
        domain: "DEVICE_LOCAL",
        bridgeRemainsDisconnected: bridgeDisconnected,
        errorCode: "DEVICE_LOCAL_SCOPE_VIOLATION",
        message: `DEVICE_LOCAL_SCOPE_VIOLATION: ${classification.reason}`,
      };
    }

    // 2. Security & Device Authorization Check
    const auth = this._checkSecurityAndDeviceAuth({
      accountId: mutation.accountId,
      deviceId: mutation.deviceId,
      accessToken: opts?.accessToken,
      secContext: opts?.secContext,
    });

    if (!auth.allowed || !auth.account || !auth.device) {
      securityAuditLogger.logEvent({
        eventType: "TOOL_BLOCKED",
        actor: {
          identityId: mutation.accountId,
          role: auth.device?.role || "admin",
          ipAddress: "127.0.0.1",
          deviceId: mutation.deviceId,
        },
        target: { resource: `account:${mutation.accountId}:${mutation.domain}:${classification.normalizedKey}` },
        decision: "BLOCK",
        reason: auth.message || "Shared account mutation blocked",
        riskLevel: "MEDIUM",
      });

      return {
        ok: false,
        status: "REJECTED",
        scope: "SHARED",
        domain: mutation.domain,
        bridgeRemainsDisconnected: bridgeDisconnected,
        errorCode: auth.errorCode || "DEVICE_UNAUTHORIZED",
        message: auth.message || "Device is not authorized for shared account sync.",
      };
    }

    const { account, device } = auth;

    // 3. DLP & OutputDataFirewall screening
    const dlp = this._validateAndSanitizeSharedValue(
      classification.normalizedKey,
      mutation.value,
      device.sessionId,
    );
    if (!dlp.clean) {
      securityAuditLogger.logEvent({
        eventType: "DLP_REDACTION",
        actor: {
          identityId: mutation.accountId,
          role: device.role,
          ipAddress: "127.0.0.1",
          sessionId: device.sessionId,
          deviceId: mutation.deviceId,
        },
        target: { resource: `account:${mutation.accountId}:${mutation.domain}:${classification.normalizedKey}` },
        decision: "BLOCK",
        reason: dlp.reason || "DLP rejected sensitive value in shared state",
        riskLevel: "HIGH",
      });

      return {
        ok: false,
        status: "REJECTED",
        scope: "SHARED",
        domain: mutation.domain,
        bridgeRemainsDisconnected: bridgeDisconnected,
        errorCode: "DLP_SECRET_REJECTED",
        message: dlp.reason || "DLP_SECRET_REJECTED",
      };
    }

    const normalizedMutation: AccountSyncMutation<T> = {
      ...mutation,
      key: classification.normalizedKey,
      value: dlp.sanitizedValue,
      productType: mutation.productType || device.productType,
      operation: mutation.operation || "UPSERT",
      timestampMs:
        mutation.timestampMs ??
        (mutation.timestamp ? new Date(mutation.timestamp).getTime() : Date.now()),
      timestamp:
        mutation.timestamp ||
        new Date(mutation.timestampMs ?? Date.now()).toISOString(),
    };

    // 4. H. Check if device is OFFLINE -> enqueue in bounded persistent offline queue
    if (!device.online && !opts?.bypassOfflineCheck) {
      return this._enqueueOfflineMutation(device, normalizedMutation, bridgeDisconnected);
    }

    // 5. G. Idempotency check by mutationId
    const existingByMutationId = account.appliedMutations.get(normalizedMutation.mutationId);
    if (existingByMutationId) {
      return {
        ok: true,
        status: "DEDUPLICATED",
        scope: "SHARED",
        domain: mutation.domain,
        item: { ...(existingByMutationId as SharedAccountItem<T>) },
        deduplicated: true,
        bridgeRemainsDisconnected: bridgeDisconnected,
        message: `Mutation '${normalizedMutation.mutationId}' already applied (idempotent no-op).`,
      };
    }

    const domainMap = this._getDomainMap(account, mutation.domain);
    const existingItem = domainMap.get(classification.normalizedKey) as
      | SharedAccountItem<T>
      | undefined;

    // 6. Content-level deduplication check (prevents duplicate tasks/memories/preferences on reconnect)
    const fingerprint = this._makeContentFingerprint(
      mutation.domain,
      normalizedMutation.operation!,
      classification.normalizedKey,
      normalizedMutation.value,
      normalizedMutation.status,
    );
    if (
      existingItem &&
      !existingItem.deleted &&
      normalizedMutation.operation !== "DELETE" &&
      JSON.stringify(existingItem.value) === JSON.stringify(normalizedMutation.value) &&
      (existingItem.status || "active") === (normalizedMutation.status || existingItem.status || "active") &&
      normalizedMutation.baseVersion === undefined
    ) {
      account.appliedMutations.set(normalizedMutation.mutationId, existingItem);
      return {
        ok: true,
        status: "DEDUPLICATED",
        scope: "SHARED",
        domain: mutation.domain,
        item: { ...existingItem },
        deduplicated: true,
        bridgeRemainsDisconnected: bridgeDisconnected,
        message: `Shared ${mutation.domain.toLowerCase()} '${classification.normalizedKey}' already has identical content (deduplicated).`,
      };
    }

    // 7. F. Conflict Resolution if item already exists
    let conflictDetail: ConflictResolutionDetail | undefined;
    let nextVersion = 1;

    if (existingItem) {
      conflictDetail = this.resolveConflict(existingItem, {
        mutationId: normalizedMutation.mutationId,
        deviceId: normalizedMutation.deviceId,
        baseVersion: normalizedMutation.baseVersion,
        clientVersion: normalizedMutation.clientVersion,
        updatedAtMs: normalizedMutation.timestampMs!,
      });

      if (conflictDetail.winner === "EXISTING") {
        // Record mutationId so replaying it remains idempotent, but retain the winning existing item!
        account.appliedMutations.set(normalizedMutation.mutationId, existingItem);
        return {
          ok: true,
          status: "CONFLICT_RESOLVED",
          scope: "SHARED",
          domain: mutation.domain,
          item: { ...existingItem },
          conflict: conflictDetail,
          bridgeRemainsDisconnected: bridgeDisconnected,
          message: conflictDetail.reason,
        };
      }

      nextVersion = conflictDetail.resolvedVersion;
    }

    // 8. Commit new/updated SharedAccountItem to canonical account ledger
    account.record.ledgerVersion += 1;
    account.record.updatedAt = normalizedMutation.timestamp!;

    const itemId = `${mutation.domain.toLowerCase()}:${classification.normalizedKey}`;
    const updatedItem: SharedAccountItem<T> = {
      itemId,
      accountId: mutation.accountId,
      domain: mutation.domain,
      scope: "SHARED",
      key: classification.normalizedKey,
      value: normalizedMutation.value,
      category: normalizedMutation.category,
      status: normalizedMutation.status || existingItem?.status || "active",
      version: nextVersion,
      ledgerSequence: account.record.ledgerVersion,
      updatedAt: normalizedMutation.timestamp!,
      updatedAtMs: normalizedMutation.timestampMs!,
      originDeviceId: normalizedMutation.deviceId,
      originProductType: normalizedMutation.productType || device.productType,
      lastMutationId: normalizedMutation.mutationId,
      deleted: normalizedMutation.operation === "DELETE",
    };

    domainMap.set(classification.normalizedKey, updatedItem);
    account.appliedMutations.set(normalizedMutation.mutationId, updatedItem);
    account.contentFingerprints.set(fingerprint, updatedItem);

    device.lastSeenAt = new Date().toISOString();
    device.lastSyncedVersion = account.record.ledgerVersion;
    device.lastSyncedAt = updatedItem.updatedAt;

    securityAuditLogger.logEvent({
      eventType: "TOOL_ALLOW",
      actor: {
        identityId: mutation.accountId,
        role: device.role,
        ipAddress: "127.0.0.1",
        sessionId: device.sessionId,
        deviceId: mutation.deviceId,
      },
      target: { resource: `${mutation.accountId}:${itemId}` },
      decision: "ALLOW",
      reason: `Synced SHARED ${mutation.domain} '${classification.normalizedKey}' (v${nextVersion}) from ${device.productType} (${mutation.deviceId}).`,
      riskLevel: "LOW",
    });

    return {
      ok: true,
      status: conflictDetail?.conflictDetected ? "CONFLICT_RESOLVED" : "APPLIED",
      scope: "SHARED",
      domain: mutation.domain,
      item: { ...updatedItem },
      conflict: conflictDetail,
      deduplicated: false,
      bridgeRemainsDisconnected: bridgeDisconnected,
      message: conflictDetail?.conflictDetected
        ? conflictDetail.reason
        : `Shared ${mutation.domain.toLowerCase()} '${classification.normalizedKey}' synced at version ${nextVersion}.`,
    };
  }

  // =========================================================================
  // H. BOUNDED PERSISTENT OFFLINE QUEUE
  // =========================================================================

  setMaxOfflineQueueSize(maxSize: number): void {
    this._maxOfflineQueueSize = Math.max(1, maxSize);
  }

  private _enqueueOfflineMutation<T>(
    device: AccountDeviceRegistration,
    mutation: AccountSyncMutation<T>,
    bridgeDisconnected: boolean,
  ): SharedWriteResult<T> {
    const queue = this._offlineQueues.get(device.deviceId) || [];

    // Idempotency inside the offline queue: if the exact mutationId is already queued, return it
    const existingById = queue.find((q) => q.mutation.mutationId === mutation.mutationId);
    if (existingById) {
      return {
        ok: true,
        status: "DEDUPLICATED",
        scope: "SHARED",
        domain: mutation.domain,
        queuedMutation: existingById as QueuedOfflineMutation<T>,
        deduplicated: true,
        bridgeRemainsDisconnected: bridgeDisconnected,
        message: `Mutation '${mutation.mutationId}' is already queued in the offline queue.`,
      };
    }

    // Coalesce if an older mutation in the offline queue targets the exact same (domain, key)
    const sameKeyIndex = queue.findIndex(
      (q) => q.mutation.domain === mutation.domain && q.mutation.key === mutation.key,
    );

    const entry: QueuedOfflineMutation<T> = {
      queueEntryId: `oq_${crypto.randomUUID()}`,
      queuedAt: new Date().toISOString(),
      queuedAtMs: Date.now(),
      mutation,
    };

    if (sameKeyIndex !== -1) {
      // Replace older pending offline write for the same key with the newer mutation
      queue[sameKeyIndex] = entry;
    } else {
      if (queue.length >= this._maxOfflineQueueSize) {
        return {
          ok: false,
          status: "REJECTED",
          scope: "SHARED",
          domain: mutation.domain,
          bridgeRemainsDisconnected: bridgeDisconnected,
          errorCode: "OFFLINE_QUEUE_FULL",
          message: `OFFLINE_QUEUE_FULL: Device '${device.deviceId}' offline queue reached bounded limit (${this._maxOfflineQueueSize}).`,
        };
      }
      queue.push(entry);
    }

    this._offlineQueues.set(device.deviceId, queue);
    this._persistedQueueSnapshots.set(device.deviceId, JSON.stringify(queue));

    return {
      ok: true,
      status: "QUEUED_OFFLINE",
      scope: "SHARED",
      domain: mutation.domain,
      queuedMutation: entry,
      bridgeRemainsDisconnected: bridgeDisconnected,
      message: `Device '${device.deviceId}' is offline. Queued ${mutation.domain.toLowerCase()} '${mutation.key}' in bounded persistent queue (${queue.length}/${this._maxOfflineQueueSize}).`,
    };
  }

  getOfflineQueue(deviceId: string): QueuedOfflineMutation[] {
    const queue = this._offlineQueues.get(deviceId) || [];
    return queue.map((q) => ({ ...q, mutation: { ...q.mutation } }));
  }

  exportOfflineQueueSnapshot(deviceId: string): string {
    return this._persistedQueueSnapshots.get(deviceId) || JSON.stringify(this.getOfflineQueue(deviceId));
  }

  importOfflineQueueSnapshot(deviceId: string, serializedQueue: string): number {
    const parsed = JSON.parse(serializedQueue) as QueuedOfflineMutation[];
    const bounded = parsed.slice(0, this._maxOfflineQueueSize);
    this._offlineQueues.set(deviceId, bounded);
    this._persistedQueueSnapshots.set(deviceId, JSON.stringify(bounded));
    return bounded.length;
  }

  /**
   * Reconnect an offline device and flush its bounded offline mutation queue
   * deterministically and idempotently.
   */
  reconnectAndSync(params: {
    accountId: string;
    deviceId: string;
    accessToken?: string;
    secContext?: SecurityContext;
  }): AccountSyncBatchResult {
    const auth = this._checkSecurityAndDeviceAuth(params);
    if (!auth.allowed || !auth.account || !auth.device) {
      return {
        ok: false,
        accountId: params.accountId,
        deviceId: params.deviceId,
        appliedCount: 0,
        deduplicatedCount: 0,
        conflictsResolvedCount: 0,
        rejectedCount: 0,
        rejectedMutations: [],
        preferences: {},
        memories: [],
        tasks: [],
        ledgerVersion: auth.account?.record.ledgerVersion ?? 0,
        bridgeRemainsDisconnected: !remoteBridge.isActive(params.deviceId),
        errorCode: auth.errorCode || "DEVICE_UNAUTHORIZED",
        message: auth.message || "Reconnect sync blocked.",
      };
    }

    // Mark device back online
    auth.device.online = true;
    auth.device.lastSeenAt = new Date().toISOString();

    const queued = this._offlineQueues.get(params.deviceId) || [];
    // Clear queue before replay; any failed items are reported in rejectedMutations
    this._offlineQueues.delete(params.deviceId);
    this._persistedQueueSnapshots.delete(params.deviceId);

    // Sort queued mutations deterministically by mutation timestamp ascending, then queueEntryId
    const sortedMutations = [...queued]
      .sort((a, b) => {
        const ta = a.mutation.timestampMs ?? a.queuedAtMs;
        const tb = b.mutation.timestampMs ?? b.queuedAtMs;
        if (ta !== tb) return ta - tb;
        return a.queueEntryId.localeCompare(b.queueEntryId);
      })
      .map((q) => q.mutation);

    return this.syncAccountDevice({
      accountId: params.accountId,
      deviceId: params.deviceId,
      mutations: sortedMutations,
      accessToken: params.accessToken,
      secContext: params.secContext,
    });
  }

  // =========================================================================
  // C. SHARED PREFERENCES API
  // =========================================================================

  /**
   * Write a Shared Preference (e.g. "hinglish_preference" = "Hinglish") from an
   * authorized device. Syncs across all devices on the same account.
   * Rejects device-local keys such as "current_window".
   */
  setSharedPreference<T = unknown>(params: {
    accountId: string;
    deviceId: string;
    key: string;
    value: T;
    mutationId?: string;
    baseVersion?: number;
    clientVersion?: number;
    timestamp?: string;
    timestampMs?: number;
    accessToken?: string;
    secContext?: SecurityContext;
  }): SharedWriteResult<T> {
    const mutationId =
      params.mutationId ||
      `mut_pref_${params.deviceId}_${params.key}_${crypto.randomUUID()}`;

    return this._applyOrQueueSharedMutation<T>(
      {
        mutationId,
        accountId: params.accountId,
        deviceId: params.deviceId,
        domain: "PREFERENCE",
        operation: "UPSERT",
        key: params.key,
        value: params.value,
        baseVersion: params.baseVersion,
        clientVersion: params.clientVersion,
        timestamp: params.timestamp,
        timestampMs: params.timestampMs,
      },
      {
        accessToken: params.accessToken,
        secContext: params.secContext,
      },
    );
  }

  getSharedPreference<T = unknown>(params: {
    accountId: string;
    deviceId: string;
    key: string;
    accessToken?: string;
  }): {
    ok: boolean;
    item?: SharedAccountItem<T>;
    value?: T;
    errorCode?: AccountSyncErrorCode;
    message?: string;
  } {
    const auth = this._checkSecurityAndDeviceAuth(params);
    if (!auth.allowed || !auth.account) {
      return {
        ok: false,
        errorCode: auth.errorCode,
        message: auth.message,
      };
    }

    const classification = this.classifyDataScope({
      key: params.key,
      domain: "PREFERENCE",
    });
    const item = auth.account.preferences.get(classification.normalizedKey) as
      | SharedAccountItem<T>
      | undefined;

    if (!item || item.deleted) {
      return {
        ok: true,
        item: undefined,
        value: undefined,
      };
    }

    return {
      ok: true,
      item: { ...item },
      value: item.value,
    };
  }

  // =========================================================================
  // B. SHARED MEMORY API
  // =========================================================================

  /**
   * Write a Shared Memory item (e.g. long-term fact, study goal, user context)
   * from an authorized device. Rejects device-local keys such as "current_window".
   */
  writeSharedMemory<T = string>(params: {
    accountId: string;
    deviceId: string;
    key: string;
    content: T;
    category?: string;
    mutationId?: string;
    baseVersion?: number;
    clientVersion?: number;
    timestamp?: string;
    timestampMs?: number;
    accessToken?: string;
    secContext?: SecurityContext;
  }): SharedWriteResult<T> {
    const mutationId =
      params.mutationId ||
      `mut_mem_${params.deviceId}_${params.key}_${crypto.randomUUID()}`;

    return this._applyOrQueueSharedMutation<T>(
      {
        mutationId,
        accountId: params.accountId,
        deviceId: params.deviceId,
        domain: "MEMORY",
        operation: "UPSERT",
        key: params.key,
        value: params.content,
        category: params.category || "general",
        baseVersion: params.baseVersion,
        clientVersion: params.clientVersion,
        timestamp: params.timestamp,
        timestampMs: params.timestampMs,
      },
      {
        accessToken: params.accessToken,
        secContext: params.secContext,
      },
    );
  }

  getSharedMemories(params: {
    accountId: string;
    deviceId: string;
    category?: string;
    accessToken?: string;
  }): {
    ok: boolean;
    memories: SharedAccountItem[];
    errorCode?: AccountSyncErrorCode;
    message?: string;
  } {
    const auth = this._checkSecurityAndDeviceAuth(params);
    if (!auth.allowed || !auth.account) {
      return {
        ok: false,
        memories: [],
        errorCode: auth.errorCode,
        message: auth.message,
      };
    }

    const list = Array.from(auth.account.memories.values())
      .filter((m) => !m.deleted && (!params.category || m.category === params.category))
      .map((m) => ({ ...m }));

    return {
      ok: true,
      memories: list,
    };
  }

  // =========================================================================
  // D. SHARED TASKS API
  // =========================================================================

  /**
   * Create or update a Shared Task across authorized account devices.
   * Rejects device-local hardware/process tasks if marked DEVICE_LOCAL.
   */
  upsertSharedTask<
    T = { title: string; description?: string; dueAt?: string }
  >(params: {
    accountId: string;
    deviceId: string;
    taskKey: string;
    task: T;
    status?: "pending" | "in_progress" | "completed" | "cancelled";
    explicitScope?: DataScope;
    mutationId?: string;
    baseVersion?: number;
    clientVersion?: number;
    timestamp?: string;
    timestampMs?: number;
    accessToken?: string;
    secContext?: SecurityContext;
  }): SharedWriteResult<T> {
    const mutationId =
      params.mutationId ||
      `mut_task_${params.deviceId}_${params.taskKey}_${crypto.randomUUID()}`;

    return this._applyOrQueueSharedMutation<T>(
      {
        mutationId,
        accountId: params.accountId,
        deviceId: params.deviceId,
        domain: "TASK",
        operation: "UPSERT",
        key: params.taskKey,
        value: params.task,
        status: params.status || "pending",
        explicitScope: params.explicitScope,
        baseVersion: params.baseVersion,
        clientVersion: params.clientVersion,
        timestamp: params.timestamp,
        timestampMs: params.timestampMs,
      },
      {
        accessToken: params.accessToken,
        secContext: params.secContext,
      },
    );
  }

  getSharedTasks(params: {
    accountId: string;
    deviceId: string;
    status?: "pending" | "in_progress" | "completed" | "cancelled";
    accessToken?: string;
  }): {
    ok: boolean;
    tasks: SharedAccountItem[];
    errorCode?: AccountSyncErrorCode;
    message?: string;
  } {
    const auth = this._checkSecurityAndDeviceAuth(params);
    if (!auth.allowed || !auth.account) {
      return {
        ok: false,
        tasks: [],
        errorCode: auth.errorCode,
        message: auth.message,
      };
    }

    const tasks = Array.from(auth.account.tasks.values())
      .filter((t) => !t.deleted && (!params.status || t.status === params.status))
      .map((t) => ({ ...t }));

    return {
      ok: true,
      tasks,
    };
  }

  // =========================================================================
  // E. DEVICE-LOCAL MEMORY API (Strictly Device-Scoped, Never Synced)
  // =========================================================================

  /**
   * Store device-local context (e.g. "current_window" on Desktop or "battery_level" on Phone).
   * Guaranteed to stay strictly on `deviceId` and NEVER sync to other devices on the account.
   */
  writeDeviceLocalMemory<T = unknown>(params: {
    deviceId: string;
    productType?: ProductType;
    accountId?: string;
    key: string;
    value: T;
  }): DeviceLocalItem<T> {
    const normalizedKey = String(params.key || "")
      .trim()
      .toLowerCase()
      .replace(/[\s\-]+/g, "_");

    const devIdentity = deviceRegistry.getDevice(params.deviceId);
    const productType = params.productType || devIdentity?.productType || "MYRAA_DESKTOP";
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();

    const item: DeviceLocalItem<T> = {
      itemId: `local:${params.deviceId}:${normalizedKey}`,
      deviceId: params.deviceId,
      productType,
      accountId: params.accountId || devIdentity?.accountId,
      scope: "DEVICE_LOCAL",
      key: normalizedKey,
      value: params.value,
      updatedAt: nowIso,
      updatedAtMs: nowMs,
    };

    if (!this._deviceLocalStore.has(params.deviceId)) {
      this._deviceLocalStore.set(params.deviceId, new Map());
    }
    this._deviceLocalStore.get(params.deviceId)!.set(normalizedKey, item);

    return { ...item };
  }

  getDeviceLocalMemory<T = unknown>(
    deviceId: string,
    key: string,
  ): DeviceLocalItem<T> | undefined {
    const normalizedKey = String(key || "")
      .trim()
      .toLowerCase()
      .replace(/[\s\-]+/g, "_");
    const devMap = this._deviceLocalStore.get(deviceId);
    const item = devMap?.get(normalizedKey) as DeviceLocalItem<T> | undefined;
    return item ? { ...item } : undefined;
  }

  getAllDeviceLocalMemories(deviceId: string): Record<string, DeviceLocalItem> {
    const devMap = this._deviceLocalStore.get(deviceId);
    if (!devMap) return {};
    const out: Record<string, DeviceLocalItem> = {};
    for (const [k, v] of devMap.entries()) {
      out[k] = { ...v };
    }
    return out;
  }

  /**
   * Smart Context Writer: Automatically classifies `key` as SHARED or DEVICE_LOCAL.
   *   - If `DEVICE_LOCAL` (e.g. "current_window"), stores it ONLY in the requesting device's
   *     local memory store and NEVER syncs it to the shared account store.
   *   - If `SHARED` (e.g. "hinglish_preference"), routes through the shared account store.
   */
  writeClassifiedData<T = unknown>(params: {
    accountId: string;
    deviceId: string;
    key: string;
    value: T;
    domain?: DataClassificationDomain;
    category?: string;
    explicitScope?: DataScope;
    mutationId?: string;
    baseVersion?: number;
    timestampMs?: number;
    accessToken?: string;
  }): SharedWriteResult<T> {
    const classification = this.classifyDataScope({
      key: params.key,
      domain: params.domain,
      category: params.category,
      explicitScope: params.explicitScope,
    });

    if (classification.scope === "DEVICE_LOCAL") {
      const localItem = this.writeDeviceLocalMemory({
        deviceId: params.deviceId,
        accountId: params.accountId,
        key: classification.normalizedKey,
        value: params.value,
      });

      return {
        ok: true,
        status: "APPLIED",
        scope: "DEVICE_LOCAL",
        domain: "DEVICE_LOCAL",
        localItem,
        bridgeRemainsDisconnected: !remoteBridge.isActive(params.deviceId),
        message: `Stored '${classification.normalizedKey}' in device-local memory for '${params.deviceId}' (not synced across account).`,
      };
    }

    const sharedDomain = classification.domain as SharedItemDomain;
    return this._applyOrQueueSharedMutation<T>(
      {
        mutationId:
          params.mutationId ||
          `mut_${sharedDomain.toLowerCase()}_${params.deviceId}_${classification.normalizedKey}_${crypto.randomUUID()}`,
        accountId: params.accountId,
        deviceId: params.deviceId,
        domain: sharedDomain,
        operation: "UPSERT",
        key: classification.normalizedKey,
        value: params.value,
        category: params.category,
        baseVersion: params.baseVersion,
        timestampMs: params.timestampMs,
      },
      {
        accessToken: params.accessToken,
      },
    );
  }

  // =========================================================================
  // G. CROSS-DEVICE SYNC & SNAPSHOT PULL
  // =========================================================================

  /**
   * Synchronize a batch of mutations from an authorized device and return the
   * latest canonical shared account state.
   *
   * Guarantees:
   *   - Idempotent: duplicate mutationIds or duplicate batch replays never create duplicate data.
   *   - Deterministic conflict resolution.
   *   - Device-local items are never included in shared sync.
   *   - RemoteBridge remains INACTIVE/DISCONNECTED.
   */
  syncAccountDevice(params: {
    accountId: string;
    deviceId: string;
    mutations?: AccountSyncMutation[];
    accessToken?: string;
    secContext?: SecurityContext;
  }): AccountSyncBatchResult {
    const bridgeDisconnected = !remoteBridge.isActive(params.deviceId);
    const auth = this._checkSecurityAndDeviceAuth({
      accountId: params.accountId,
      deviceId: params.deviceId,
      accessToken: params.accessToken,
      secContext: params.secContext,
    });

    if (!auth.allowed || !auth.account || !auth.device) {
      return {
        ok: false,
        accountId: params.accountId,
        deviceId: params.deviceId,
        appliedCount: 0,
        deduplicatedCount: 0,
        conflictsResolvedCount: 0,
        rejectedCount: 0,
        rejectedMutations: [],
        preferences: {},
        memories: [],
        tasks: [],
        ledgerVersion: auth.account?.record.ledgerVersion ?? 0,
        bridgeRemainsDisconnected: bridgeDisconnected,
        errorCode: auth.errorCode || "DEVICE_UNAUTHORIZED",
        message: auth.message || "Device is not authorized to sync.",
      };
    }

    if (!auth.device.online) {
      return {
        ok: false,
        accountId: params.accountId,
        deviceId: params.deviceId,
        appliedCount: 0,
        deduplicatedCount: 0,
        conflictsResolvedCount: 0,
        rejectedCount: 0,
        rejectedMutations: [],
        preferences: {},
        memories: [],
        tasks: [],
        ledgerVersion: auth.account.record.ledgerVersion,
        bridgeRemainsDisconnected: bridgeDisconnected,
        errorCode: "DEVICE_OFFLINE",
        message: `DEVICE_OFFLINE: Device '${params.deviceId}' is currently offline. Call reconnectAndSync() when online.`,
      };
    }

    let appliedCount = 0;
    let deduplicatedCount = 0;
    let conflictsResolvedCount = 0;
    const rejectedMutations: Array<{
      mutationId: string;
      key: string;
      errorCode: AccountSyncErrorCode;
      reason: string;
    }> = [];

    const incomingMutations = params.mutations || [];
    for (const mut of incomingMutations) {
      const res = this._applyOrQueueSharedMutation(
        {
          ...mut,
          accountId: params.accountId,
          deviceId: params.deviceId,
        },
        {
          accessToken: params.accessToken,
          secContext: params.secContext,
          bypassOfflineCheck: true,
        },
      );

      if (!res.ok) {
        rejectedMutations.push({
          mutationId: mut.mutationId,
          key: mut.key,
          errorCode: res.errorCode || "INVALID_MUTATION",
          reason: res.message,
        });
      } else if (res.status === "DEDUPLICATED" || res.deduplicated) {
        deduplicatedCount++;
      } else if (res.status === "CONFLICT_RESOLVED") {
        conflictsResolvedCount++;
        if (res.conflict?.winner === "INCOMING") {
          appliedCount++;
        }
      } else if (res.status === "APPLIED") {
        appliedCount++;
      }
    }

    const snapshot = this.pullAccountState({
      accountId: params.accountId,
      deviceId: params.deviceId,
      accessToken: params.accessToken,
      secContext: params.secContext,
    });

    auth.device.lastSyncedVersion = auth.account.record.ledgerVersion;
    auth.device.lastSyncedAt = new Date().toISOString();

    return {
      ok: rejectedMutations.length === 0 && snapshot.ok,
      accountId: params.accountId,
      deviceId: params.deviceId,
      appliedCount,
      deduplicatedCount,
      conflictsResolvedCount,
      rejectedCount: rejectedMutations.length,
      rejectedMutations,
      preferences: snapshot.preferences,
      memories: snapshot.memories,
      tasks: snapshot.tasks,
      ledgerVersion: auth.account.record.ledgerVersion,
      bridgeRemainsDisconnected: !remoteBridge.isActive(params.deviceId),
      message: `Sync complete for '${params.deviceId}': ${appliedCount} applied, ${deduplicatedCount} deduplicated, ${conflictsResolvedCount} conflict(s) resolved, ${rejectedMutations.length} rejected.`,
    };
  }

  /**
   * Pull the full view for a specific authorized device:
   *   - Shared Preferences (synced across account)
   *   - Shared Memories (synced across account)
   *   - Shared Tasks (synced across account)
   *   - Device-Local items belonging ONLY to `deviceId` (never from other devices)
   */
  pullAccountState(params: {
    accountId: string;
    deviceId: string;
    accessToken?: string;
    secContext?: SecurityContext;
  }): AccountStateSnapshot {
    const bridgeDisconnected = !remoteBridge.isActive(params.deviceId);
    const auth = this._checkSecurityAndDeviceAuth(params);
    if (!auth.allowed || !auth.account || !auth.device) {
      return {
        ok: false,
        accountId: params.accountId,
        deviceId: params.deviceId,
        ledgerVersion: auth.account?.record.ledgerVersion ?? 0,
        preferences: {},
        memories: [],
        tasks: [],
        deviceLocal: {},
        bridgeRemainsDisconnected: bridgeDisconnected,
        errorCode: auth.errorCode || "DEVICE_UNAUTHORIZED",
        message: auth.message || "Unauthorized to pull shared account state.",
      };
    }

    const preferences: Record<string, SharedAccountItem> = {};
    for (const [k, v] of auth.account.preferences.entries()) {
      if (!v.deleted) {
        preferences[k] = { ...v };
      }
    }

    const memories = Array.from(auth.account.memories.values())
      .filter((m) => !m.deleted)
      .map((m) => ({ ...m }));

    const tasks = Array.from(auth.account.tasks.values())
      .filter((t) => !t.deleted)
      .map((t) => ({ ...t }));

    const deviceLocal = this.getAllDeviceLocalMemories(params.deviceId);

    return {
      ok: true,
      accountId: params.accountId,
      deviceId: params.deviceId,
      ledgerVersion: auth.account.record.ledgerVersion,
      preferences,
      memories,
      tasks,
      deviceLocal,
      bridgeRemainsDisconnected: bridgeDisconnected,
      message: "Pulled canonical shared account state + device-scoped local context.",
    };
  }

  // =========================================================================
  // TESTING & RESET SUPPORT
  // =========================================================================

  resetForTesting(): void {
    this._accounts.clear();
    this._deviceLocalStore.clear();
    this._offlineQueues.clear();
    this._persistedQueueSnapshots.clear();
    this._maxOfflineQueueSize = MAX_OFFLINE_QUEUE_SIZE;
  }
}

export const sharedAccountMemoryManager = new SharedAccountMemoryManager();
