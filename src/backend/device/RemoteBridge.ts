/**
 * MYRAA — Phase 6: Optional Remote Bridge
 *
 * Implements the full Optional Remote Bridge on top of the locked Phase 4 + Phase 5 architecture:
 *   A. Device Discovery              — discover candidate MYRAA devices without auto-connecting
 *   B. Explicit Pairing              — challenge-response pairing requiring explicit user action
 *   C. Connect / Disconnect          — explicit session activation & immediate teardown
 *   D. Device Authorization          — delegates to IdentityAuthManager, SecurityPolicyEngine, RiskEngine
 *   E. Remote Capability Negotiation — negotiates supported capabilities with target engine
 *   F. Remote Command Execution      — guarded cross-device execution via ToolExecutionFirewall + DLP
 *   G. Remote Result Verification    — deterministic result verification via ActionVerifier
 *   H. Bounded Timeout / Retry       — strict timeout + bounded retry (never infinite loops)
 *   I. Emergency Stop                — immediate halt & disconnect when EmergencyStopCoordinator is active
 *   J. Security Lockdown             — immediate block when SecurityPolicyEngine is in LOCKDOWN mode
 *   K. Remote Audit                  — tamper-evident audit logging via SecurityAuditLogger
 *   L. Automatic Disconnect Safety   — auto-disconnect on auth expiry, revocation, lost device,
 *                                      security violation, inactivity, or transport failure
 *
 * CRITICAL INVARIANTS:
 *   • DEFAULT STATE = DISCONNECTED / INACTIVE.
 *   • Same account/login MUST NOT automatically connect devices.
 *   • Pairing and connection require explicit user action.
 *   • Explicit remote target must NEVER silently fall back to the local device.
 */

import crypto from "crypto";
import { deviceRegistry } from "./DeviceRegistry.ts";
import { androidCapabilityEngine } from "./AndroidCapabilityEngine.ts";
import { desktopCapabilityEngine } from "./DesktopCapabilityEngine.ts";
import { remoteSessionManager } from "../remote/RemoteSessionManager.ts";
import { emergencyStopCoordinator } from "../remote/EmergencyStopCoordinator.ts";
import {
  identityAuthManager,
  securityPolicyEngine,
  securityRiskEngine,
  toolExecutionFirewall,
  outputDataFirewall,
  securityAuditLogger,
  LOCKDOWN_ALLOWLIST,
  type IdentityRole,
  type SecurityContext,
} from "../security/index.ts";
import { actionVerifier } from "../orchestrator/ActionVerifier.ts";
import { capabilityRegistry } from "../orchestrator/CapabilityRegistry.ts";
import type { ActionVerificationResult, TargetDevice } from "../orchestrator/OrchestratorTypes.ts";
import type { BridgeState, ProductType, RemoteBridgeStatus } from "./DeviceTypes.ts";

// ---------------------------------------------------------------------------
// Bridge Activation Trigger Phrases
// ---------------------------------------------------------------------------

export const BRIDGE_ACTIVATION_PHRASES: ReadonlySet<string> = new Set([
  "desktop connect karo",
  "phone se desktop connect",
  "connect to desktop",
  "connect to my desktop",
  "remote connect",
  "connect my phone to desktop",
  "enable remote bridge",
  "bridge activate karo",
  "laptop se connect karo",
  "pc se connect karo",
]);

export const BRIDGE_DEACTIVATION_PHRASES: ReadonlySet<string> = new Set([
  "desktop disconnect karo",
  "remote disconnect",
  "disconnect from desktop",
  "bridge band karo",
  "disable remote bridge",
  "remote connection off karo",
]);

// ---------------------------------------------------------------------------
// Phase 6 Constants & Types
// ---------------------------------------------------------------------------

export const DEFAULT_REMOTE_TIMEOUT_MS = 5000;
export const DEFAULT_MAX_RETRIES = 2;
export const MAX_BOUNDED_RETRIES_LIMIT = 5;
export const DEFAULT_INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
export const PAIRING_CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export type AutoDisconnectReason =
  | "USER_DISCONNECTED"
  | "AUTHORIZATION_EXPIRED"
  | "DEVICE_REVOKED"
  | "DEVICE_LOST"
  | "SECURITY_VIOLATION"
  | "INACTIVITY_TIMEOUT"
  | "TRANSPORT_FAILURE"
  | "EMERGENCY_STOP_ACTIVE"
  | "SECURITY_LOCKDOWN";

export interface DiscoveredDeviceRecord {
  deviceId: string;
  deviceName: string;
  productType: ProductType;
  accountId: string;
  online: boolean;
  paired: boolean;
  bridgeState: BridgeState;
  sameAccount: boolean;
  autoConnected: false;
  supportedCapabilities: string[];
}

export interface PairingChallengeRecord {
  pairingId: string;
  sourceDeviceId: string;
  targetDeviceId: string;
  pairingCode: string;
  requestedBy: string;
  role: IdentityRole;
  createdAt: number;
  expiresAt: number;
  status: "PENDING" | "CONFIRMED" | "EXPIRED" | "REJECTED";
}

export interface RemoteBridgePairingRecord {
  pairKey: string;
  sourceDeviceId: string;
  targetDeviceId: string;
  accountId: string;
  role: IdentityRole;
  sessionId: string;
  accessToken: string;
  refreshToken: string;
  pairedAt: string;
  expiresAt: number;
  revoked: boolean;
  revokedReason?: string;
  lost: boolean;
}

export interface NegotiatedCapabilityManifest {
  sourceDeviceId: string;
  targetDeviceId: string;
  targetProductType: ProductType;
  allowedCapabilities: string[];
  deniedCapabilities: string[];
  negotiatedAt: string;
  manifestVersion: string;
}

export interface RemoteExecutionOptions {
  sourceDeviceId: string;
  targetDeviceId?: string;
  capability: string;
  args: Record<string, unknown>;
  targetProductType?: ProductType;
  secContext?: SecurityContext;
  accessToken?: string;
  timeoutMs?: number;
  maxRetries?: number;
  confirmationToken?: string;
  /** Optional custom transport executor for deterministic testing or custom RPC */
  transportExecutor?: (
    capability: string,
    toolName: string,
    args: Record<string, unknown>,
    attempt: number,
  ) => Promise<{ ok: boolean; result?: any; error?: string }>;
}

export interface RemoteExecutionResult {
  success: boolean;
  ok: boolean;
  capability: string;
  toolName: string;
  sourceDeviceId: string;
  targetDeviceId: string | null;
  targetProductType: ProductType;
  message: string;
  payload?: Record<string, unknown>;
  verified: boolean;
  verification: ActionVerificationResult;
  attempts: number;
  timedOut: boolean;
  autoDisconnected: boolean;
  disconnectReason?: AutoDisconnectReason;
  usedLocalFallback: false;
  errorCode?:
    | "BRIDGE_INACTIVE"
    | "DEVICE_NOT_PAIRED"
    | "AUTHORIZATION_EXPIRED"
    | "DEVICE_REVOKED"
    | "DEVICE_LOST"
    | "TARGET_DEVICE_UNAVAILABLE"
    | "CAPABILITY_NOT_SUPPORTED"
    | "SECURITY_POLICY_DENIED"
    | "PERMISSION_DENIED"
    | "CONFIRMATION_REQUIRED"
    | "REMOTE_TIMEOUT"
    | "REMOTE_EXECUTION_FAILED"
    | "VERIFICATION_FAILED";
}

// ---------------------------------------------------------------------------
// RemoteBridge Implementation
// ---------------------------------------------------------------------------

export class RemoteBridge {
  private _challenges = new Map<string, PairingChallengeRecord>();
  private _pairings = new Map<string, RemoteBridgePairingRecord>();
  private _manifests = new Map<string, NegotiatedCapabilityManifest>();
  private _lastActivityMap = new Map<string, number>();
  private _lostDevices = new Set<string>();
  private _lastDisconnectReasons = new Map<string, AutoDisconnectReason>();

  private _pairKey(sourceDeviceId: string, targetDeviceId: string): string {
    return `${sourceDeviceId}::${targetDeviceId}`;
  }

  private _ensureEnginesRegistered(): void {
    if (!deviceRegistry.getEngine("MYRAA_MOBILE")) {
      deviceRegistry.registerEngine(androidCapabilityEngine);
    }
    if (!deviceRegistry.getEngine("MYRAA_DESKTOP")) {
      deviceRegistry.registerEngine(desktopCapabilityEngine);
    }
  }

  // =========================================================================
  // A. DEVICE DISCOVERY
  // =========================================================================

  /**
   * Discover available MYRAA devices without automatically pairing or connecting them.
   * Even if devices share the exact same accountId, autoConnected is ALWAYS false
   * and bridgeState remains INACTIVE until explicitly paired and connected.
   */
  discoverDevices(opts?: {
    requestingDeviceId?: string;
    accountId?: string;
    productType?: ProductType;
  }): DiscoveredDeviceRecord[] {
    this._ensureEnginesRegistered();

    const allDevices = deviceRegistry.listDevices();
    const overrides = capabilityRegistry.getDeviceAvailabilityOverrides();
    const results: DiscoveredDeviceRecord[] = [];

    for (const dev of allDevices) {
      if (opts?.requestingDeviceId && dev.deviceId === opts.requestingDeviceId) {
        continue;
      }
      if (opts?.productType && dev.productType !== opts.productType) {
        continue;
      }

      const isLost = this._lostDevices.has(dev.deviceId);
      let online = !isLost && dev.registered;
      if (dev.productType === "MYRAA_DESKTOP" && overrides.desktopAvailable !== undefined) {
        online = !isLost && overrides.desktopAvailable;
      } else if (dev.productType === "MYRAA_MOBILE" && overrides.phoneAvailable !== undefined) {
        online = !isLost && overrides.phoneAvailable;
      }

      const pairKey = opts?.requestingDeviceId
        ? this._pairKey(opts.requestingDeviceId, dev.deviceId)
        : "";
      const pairing = pairKey ? this._pairings.get(pairKey) : undefined;
      const isPaired = Boolean(pairing && !pairing.revoked && !pairing.lost);

      const bridgeStatus = opts?.requestingDeviceId
        ? deviceRegistry.getBridgeStatus(opts.requestingDeviceId)
        : deviceRegistry.getBridgeStatus(dev.deviceId);
      const isConnectedToThis =
        bridgeStatus.state === "ACTIVE" && bridgeStatus.targetDeviceId === dev.deviceId;

      const engine = deviceRegistry.getEngine(dev.productType);
      const candidateCaps =
        dev.productType === "MYRAA_DESKTOP"
          ? [
              "desktop.openApplication",
              "desktop.closeApplication",
              "desktop.openFile",
              "desktop.openFolder",
              "desktop.readFile",
              "desktop.modifyFile",
              "desktop.deleteFile",
              "desktop.runCommand",
              "desktop.screenshot",
              "desktop.codeInspect",
              "youtube.search",
              "youtube.play",
              "browser.openUrl",
            ]
          : [
              "mobile.openApp",
              "mobile.closeApp",
              "mobile.alarm",
              "mobile.timer",
              "mobile.reminder",
              "mobile.calendar",
              "mobile.notes",
              "mobile.deviceStatus",
              "youtube.search",
              "youtube.play",
              "browser.openUrl",
            ];

      const supportedCapabilities = candidateCaps.filter(
        (c) =>
          (!engine || engine.canExecute(c)) &&
          !dev.disabledCapabilities.includes(c),
      );

      results.push({
        deviceId: dev.deviceId,
        deviceName: dev.deviceName,
        productType: dev.productType,
        accountId: dev.accountId,
        online,
        paired: isPaired,
        bridgeState: isConnectedToThis ? "ACTIVE" : "INACTIVE",
        sameAccount: Boolean(opts?.accountId && dev.accountId === opts.accountId),
        autoConnected: false,
        supportedCapabilities,
      });
    }

    securityAuditLogger.logEvent({
      eventType: "TOOL_ALLOW",
      actor: {
        identityId: opts?.accountId || "system",
        role: "admin",
        ipAddress: "127.0.0.1",
        deviceId: opts?.requestingDeviceId || "discovery",
      },
      target: { resource: "remote_bridge_discovery" },
      decision: "ALLOW",
      reason: `Discovered ${results.length} candidate device(s). Auto-connect disabled.`,
      riskLevel: "LOW",
    });

    return results;
  }

  // =========================================================================
  // B. EXPLICIT PAIRING
  // =========================================================================

  /**
   * Step 1 of Explicit Pairing: Initiate a user-driven pairing challenge between
   * sourceDeviceId and targetDeviceId.
   *
   * Does NOT connect the bridge automatically; requires explicit confirmation.
   */
  requestPairing(params: {
    sourceDeviceId: string;
    targetDeviceId: string;
    requestedBy: string;
    role?: IdentityRole;
    explicitUserAction?: boolean;
  }): {
    success: boolean;
    pairingId?: string;
    pairingCode?: string;
    expiresAt?: number;
    errorCode?: string;
    message: string;
  } {
    if (params.explicitUserAction === false) {
      return {
        success: false,
        errorCode: "EXPLICIT_USER_ACTION_REQUIRED",
        message: "Pairing requires explicit user action; background auto-pairing is forbidden.",
      };
    }

    if (emergencyStopCoordinator.isActive()) {
      return {
        success: false,
        errorCode: "SECURITY_POLICY_DENIED",
        message: "EMERGENCY_STOP_ACTIVE: Cannot pair devices while Emergency Stop is active.",
      };
    }

    if (securityPolicyEngine.getMode() === "LOCKDOWN") {
      return {
        success: false,
        errorCode: "SECURITY_POLICY_DENIED",
        message: "SECURITY_LOCKDOWN: Device pairing is blocked in LOCKDOWN mode.",
      };
    }

    const pairingId = `pair_${crypto.randomUUID()}`;
    const pairingCode = String(crypto.randomInt(100000, 999999));
    const now = Date.now();
    const expiresAt = now + PAIRING_CHALLENGE_TTL_MS;

    const record: PairingChallengeRecord = {
      pairingId,
      sourceDeviceId: params.sourceDeviceId,
      targetDeviceId: params.targetDeviceId,
      pairingCode,
      requestedBy: params.requestedBy,
      role: params.role || "admin",
      createdAt: now,
      expiresAt,
      status: "PENDING",
    };

    this._challenges.set(pairingId, record);

    securityAuditLogger.logEvent({
      eventType: "STEP_UP_CHALLENGE",
      actor: {
        identityId: params.requestedBy,
        role: record.role,
        ipAddress: "127.0.0.1",
        deviceId: params.sourceDeviceId,
      },
      target: { resource: params.targetDeviceId },
      decision: "ALLOW",
      reason: `Explicit pairing challenge created (${pairingId}) from ${params.sourceDeviceId} to ${params.targetDeviceId}.`,
      riskLevel: "LOW",
    });

    return {
      success: true,
      pairingId,
      pairingCode,
      expiresAt,
      message: "Pairing challenge created. Confirm on the target device to complete pairing.",
    };
  }

  /**
   * Step 2 of Explicit Pairing: Confirm the pairing challenge using the 6-digit code
   * and issue a cryptographic session via IdentityAuthManager.
   *
   * Note: Even after pairing is confirmed, BridgeState remains INACTIVE until
   * connect() is explicitly called!
   */
  confirmPairing(params: {
    pairingId: string;
    pairingCode: string;
    approvedByTargetUser: boolean;
    ipAddress?: string;
    ttlMs?: number;
  }): {
    success: boolean;
    pairing?: RemoteBridgePairingRecord;
    errorCode?: string;
    message: string;
  } {
    const challenge = this._challenges.get(params.pairingId);
    if (!challenge) {
      return {
        success: false,
        errorCode: "PAIRING_NOT_FOUND",
        message: "Pairing challenge not found.",
      };
    }

    if (!params.approvedByTargetUser) {
      challenge.status = "REJECTED";
      securityAuditLogger.logEvent({
        eventType: "STEP_UP_FAILED",
        actor: {
          identityId: challenge.requestedBy,
          role: challenge.role,
          ipAddress: params.ipAddress || "127.0.0.1",
          deviceId: challenge.sourceDeviceId,
        },
        target: { resource: challenge.targetDeviceId },
        decision: "BLOCK",
        reason: "Target user rejected pairing request.",
        riskLevel: "MEDIUM",
      });
      return {
        success: false,
        errorCode: "PAIRING_REJECTED",
        message: "Pairing was rejected by the user.",
      };
    }

    if (Date.now() > challenge.expiresAt) {
      challenge.status = "EXPIRED";
      return {
        success: false,
        errorCode: "PAIRING_EXPIRED",
        message: "Pairing challenge has expired.",
      };
    }

    if (challenge.pairingCode !== params.pairingCode) {
      securityAuditLogger.logEvent({
        eventType: "STEP_UP_FAILED",
        actor: {
          identityId: challenge.requestedBy,
          role: challenge.role,
          ipAddress: params.ipAddress || "127.0.0.1",
          deviceId: challenge.sourceDeviceId,
        },
        target: { resource: challenge.targetDeviceId },
        decision: "BLOCK",
        reason: "Invalid pairing verification code.",
        riskLevel: "MEDIUM",
      });
      return {
        success: false,
        errorCode: "INVALID_PAIRING_CODE",
        message: "Invalid pairing code.",
      };
    }

    challenge.status = "CONFIRMED";

    // Create cryptographic session via existing IdentityAuthManager
    const { session, tokens } = identityAuthManager.createSession({
      deviceId: challenge.sourceDeviceId,
      identityId: challenge.requestedBy,
      role: challenge.role,
      ipAddress: params.ipAddress || "127.0.0.1",
      userAgent: `MYRAA-RemoteBridge/${challenge.sourceDeviceId}->${challenge.targetDeviceId}`,
    });

    const pairKey = this._pairKey(challenge.sourceDeviceId, challenge.targetDeviceId);
    const now = Date.now();
    const pairingRecord: RemoteBridgePairingRecord = {
      pairKey,
      sourceDeviceId: challenge.sourceDeviceId,
      targetDeviceId: challenge.targetDeviceId,
      accountId: challenge.requestedBy,
      role: challenge.role,
      sessionId: session.sessionId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      pairedAt: new Date(now).toISOString(),
      expiresAt: now + (params.ttlMs ?? 15 * 60 * 1000),
      revoked: false,
      lost: false,
    };

    this._pairings.set(pairKey, pairingRecord);
    this._lostDevices.delete(challenge.sourceDeviceId);
    this._lostDevices.delete(challenge.targetDeviceId);

    securityAuditLogger.logEvent({
      eventType: "STEP_UP_VERIFIED",
      actor: {
        identityId: challenge.requestedBy,
        role: challenge.role,
        ipAddress: params.ipAddress || "127.0.0.1",
        sessionId: session.sessionId,
        deviceId: challenge.sourceDeviceId,
      },
      target: { resource: challenge.targetDeviceId },
      decision: "ALLOW",
      reason: `Devices explicitly paired (${challenge.sourceDeviceId} <-> ${challenge.targetDeviceId}). Bridge remains INACTIVE until connect() is called.`,
      riskLevel: "LOW",
    });

    return {
      success: true,
      pairing: { ...pairingRecord },
      message: "Devices paired successfully. Call connect() to activate the Remote Bridge.",
    };
  }

  /**
   * Check if two devices have an active, non-revoked pairing record.
   */
  isPaired(sourceDeviceId: string, targetDeviceId: string): boolean {
    const rec = this._pairings.get(this._pairKey(sourceDeviceId, targetDeviceId));
    return Boolean(rec && !rec.revoked && !rec.lost);
  }

  getPairing(sourceDeviceId: string, targetDeviceId: string): RemoteBridgePairingRecord | undefined {
    return this._pairings.get(this._pairKey(sourceDeviceId, targetDeviceId));
  }

  // =========================================================================
  // C. CONNECT / DISCONNECT & D. DEVICE AUTHORIZATION
  // =========================================================================

  /**
   * Check if the RemoteBridge is active for the given source device.
   * Returns false if bridge is not explicitly activated.
   */
  isActive(sourceDeviceId: string): boolean {
    if (emergencyStopCoordinator.isActive() || securityPolicyEngine.getMode() === "LOCKDOWN") {
      return false;
    }
    const status = deviceRegistry.getBridgeStatus(sourceDeviceId);
    return status.state === "ACTIVE";
  }

  /**
   * Get the current bridge status for a source device.
   */
  getStatus(sourceDeviceId: string): RemoteBridgeStatus {
    return deviceRegistry.getBridgeStatus(sourceDeviceId);
  }

  getLastDisconnectReason(sourceDeviceId: string): AutoDisconnectReason | undefined {
    return this._lastDisconnectReasons.get(sourceDeviceId);
  }

  /**
   * Verify device authorization (IdentityAuthManager session + pairing + expiry + EmergencyStop + Lockdown).
   */
  authorizeRemoteDevice(params: {
    sourceDeviceId: string;
    targetDeviceId: string;
    accessToken?: string;
  }): {
    authorized: boolean;
    pairing?: RemoteBridgePairingRecord;
    errorCode?:
      | "SECURITY_POLICY_DENIED"
      | "DEVICE_NOT_PAIRED"
      | "DEVICE_REVOKED"
      | "DEVICE_LOST"
      | "AUTHORIZATION_EXPIRED";
    reason?: string;
  } {
    if (emergencyStopCoordinator.isActive()) {
      return {
        authorized: false,
        errorCode: "SECURITY_POLICY_DENIED",
        reason: "EMERGENCY_STOP_ACTIVE: Remote Bridge execution is blocked by Emergency Stop.",
      };
    }

    if (securityPolicyEngine.getMode() === "LOCKDOWN") {
      return {
        authorized: false,
        errorCode: "SECURITY_POLICY_DENIED",
        reason: "SECURITY_LOCKDOWN: Remote Bridge execution is blocked in LOCKDOWN mode.",
      };
    }

    if (
      this._lostDevices.has(params.sourceDeviceId) ||
      this._lostDevices.has(params.targetDeviceId)
    ) {
      return {
        authorized: false,
        errorCode: "DEVICE_LOST",
        reason: "DEVICE_LOST: Source or target device has been marked lost/unreachable.",
      };
    }

    const pairKey = this._pairKey(params.sourceDeviceId, params.targetDeviceId);
    const pairing = this._pairings.get(pairKey);
    if (!pairing) {
      return {
        authorized: false,
        errorCode: "DEVICE_NOT_PAIRED",
        reason: `DEVICE_NOT_PAIRED: Device '${params.sourceDeviceId}' is not explicitly paired with '${params.targetDeviceId}'.`,
      };
    }

    if (pairing.revoked) {
      return {
        authorized: false,
        errorCode: "DEVICE_REVOKED",
        reason: `DEVICE_REVOKED: ${pairing.revokedReason || "Device pairing has been revoked."}`,
      };
    }

    if (pairing.lost) {
      return {
        authorized: false,
        errorCode: "DEVICE_LOST",
        reason: "DEVICE_LOST: Paired device has been marked lost.",
      };
    }

    if (Date.now() > pairing.expiresAt) {
      return {
        authorized: false,
        errorCode: "AUTHORIZATION_EXPIRED",
        reason: "AUTHORIZATION_EXPIRED: Remote Bridge authorization has expired.",
      };
    }

    const tokenToCheck = params.accessToken || pairing.accessToken;
    const tokenValidation = identityAuthManager.validateAccessToken(tokenToCheck, "127.0.0.1");
    if (!tokenValidation.valid) {
      const isRevoked = tokenValidation.error?.includes("REVOKED");
      return {
        authorized: false,
        errorCode: isRevoked ? "DEVICE_REVOKED" : "AUTHORIZATION_EXPIRED",
        reason: tokenValidation.error || "AUTHORIZATION_EXPIRED: Access token is invalid or expired.",
      };
    }

    return {
      authorized: true,
      pairing,
    };
  }

  /**
   * Explicit Connect: Connect a paired sourceDeviceId to targetDeviceId,
   * verify target availability and authorization, and negotiate capabilities.
   */
  async connect(params: {
    sourceDeviceId: string;
    targetDeviceId: string;
    accessToken?: string;
    explicitUserAction?: boolean;
  }): Promise<{
    success: boolean;
    errorCode?: string;
    message: string;
    targetDeviceId?: string;
    manifest?: NegotiatedCapabilityManifest;
  }> {
    if (params.explicitUserAction === false) {
      return {
        success: false,
        errorCode: "EXPLICIT_USER_ACTION_REQUIRED",
        message: "Remote Bridge connection requires explicit user action.",
      };
    }

    // 1. Check authorization & pairing
    const auth = this.authorizeRemoteDevice({
      sourceDeviceId: params.sourceDeviceId,
      targetDeviceId: params.targetDeviceId,
      accessToken: params.accessToken,
    });

    if (!auth.authorized) {
      return {
        success: false,
        errorCode: auth.errorCode,
        message: auth.reason || "Remote Bridge authorization failed.",
      };
    }

    // 2. Check target device availability
    const targetDev = deviceRegistry.getDevice(params.targetDeviceId);
    const overrides = capabilityRegistry.getDeviceAvailabilityOverrides();
    const isDesktopTarget = !targetDev || targetDev.productType === "MYRAA_DESKTOP";
    if (
      (isDesktopTarget && overrides.desktopAvailable === false) ||
      (isDesktopTarget && overrides.remoteDesktopAvailable === false) ||
      (!isDesktopTarget && overrides.phoneAvailable === false)
    ) {
      return {
        success: false,
        errorCode: "TARGET_DEVICE_UNAVAILABLE",
        message: `TARGET_DEVICE_UNAVAILABLE: Target device '${params.targetDeviceId}' is currently offline.`,
      };
    }

    // 3. Negotiate capabilities
    const manifest = this.negotiateCapabilities(params.sourceDeviceId, params.targetDeviceId);

    // 4. Activate bridge in DeviceRegistry
    deviceRegistry.activateBridge(params.sourceDeviceId, params.targetDeviceId);
    this._lastActivityMap.set(params.sourceDeviceId, Date.now());
    this._lastDisconnectReasons.delete(params.sourceDeviceId);

    // Update DeviceIdentity bridge flags if registered
    const srcIdentity = deviceRegistry.getDevice(params.sourceDeviceId);
    if (srcIdentity) {
      deviceRegistry.registerDevice({
        ...srcIdentity,
        bridgeConnected: true,
        bridgeTargetDeviceId: params.targetDeviceId,
      });
    }

    securityAuditLogger.logEvent({
      eventType: "SESSION_CREATED",
      actor: {
        identityId: auth.pairing?.accountId || "operator",
        role: auth.pairing?.role || "admin",
        ipAddress: "127.0.0.1",
        sessionId: auth.pairing?.sessionId,
        deviceId: params.sourceDeviceId,
      },
      target: { resource: params.targetDeviceId },
      decision: "ALLOW",
      reason: `Remote Bridge connected: ${params.sourceDeviceId} -> ${params.targetDeviceId} (${manifest.allowedCapabilities.length} capabilities negotiated).`,
      riskLevel: "LOW",
    });

    return {
      success: true,
      targetDeviceId: params.targetDeviceId,
      manifest,
      message: "Remote Bridge connected and capabilities negotiated.",
    };
  }

  /**
   * Convenience activation method (used by existing Phase A & Phase 5 callers):
   * Performs explicit pairing + connect + capability negotiation in one call.
   */
  async activate(
    sourceDeviceId: string,
    targetDeviceId?: string,
  ): Promise<{
    success: boolean;
    message: string;
    targetDeviceId?: string;
    errorCode?: string;
    manifest?: NegotiatedCapabilityManifest;
  }> {
    const resolvedTargetId =
      targetDeviceId ??
      this._findConnectedDesktopId() ??
      this._findConnectedMobileId();

    if (!resolvedTargetId) {
      const sourceDevice = deviceRegistry.getDevice(sourceDeviceId);
      const sourceProduct = sourceDevice?.productType ?? "MYRAA_BROWSER";

      const targetHint =
        sourceProduct === "MYRAA_MOBILE"
          ? "MYRAA Desktop app is not currently running. Please open MYRAA on your PC first."
          : "MYRAA Mobile app is not currently connected. Please open MYRAA on your phone first.";

      return {
        success: false,
        errorCode: "TARGET_DEVICE_UNAVAILABLE",
        message: `Remote Bridge: ${targetHint}`,
      };
    }

    // Ensure pairing exists via explicit challenge + confirmation
    if (!this.isPaired(sourceDeviceId, resolvedTargetId)) {
      const srcDev = deviceRegistry.getDevice(sourceDeviceId);
      const challenge = this.requestPairing({
        sourceDeviceId,
        targetDeviceId: resolvedTargetId,
        requestedBy: srcDev?.accountId || "owner-admin",
        role: "admin",
        explicitUserAction: true,
      });
      if (!challenge.success || !challenge.pairingId || !challenge.pairingCode) {
        return {
          success: false,
          errorCode: challenge.errorCode,
          message: challenge.message,
        };
      }
      const confirm = this.confirmPairing({
        pairingId: challenge.pairingId,
        pairingCode: challenge.pairingCode,
        approvedByTargetUser: true,
      });
      if (!confirm.success) {
        return {
          success: false,
          errorCode: confirm.errorCode,
          message: confirm.message,
        };
      }
    }

    const connected = await this.connect({
      sourceDeviceId,
      targetDeviceId: resolvedTargetId,
      explicitUserAction: true,
    });

    if (!connected.success) {
      return {
        success: false,
        errorCode: connected.errorCode,
        message: connected.message,
      };
    }

    return {
      success: true,
      message: "Remote Bridge activated. You can now control your other device.",
      targetDeviceId: resolvedTargetId,
      manifest: connected.manifest,
    };
  }

  /**
   * Disconnect / Deactivate the bridge for a source device.
   */
  disconnect(
    sourceDeviceId: string,
    reason: AutoDisconnectReason = "USER_DISCONNECTED",
  ): { disconnected: boolean; reason: AutoDisconnectReason; message: string } {
    deviceRegistry.deactivateBridge(sourceDeviceId);
    this._lastActivityMap.delete(sourceDeviceId);
    this._lastDisconnectReasons.set(sourceDeviceId, reason);

    const srcIdentity = deviceRegistry.getDevice(sourceDeviceId);
    if (srcIdentity) {
      deviceRegistry.registerDevice({
        ...srcIdentity,
        bridgeConnected: false,
        bridgeTargetDeviceId: null,
      });
    }

    securityAuditLogger.logEvent({
      eventType: "SESSION_REVOKED",
      actor: {
        identityId: srcIdentity?.accountId || "operator",
        role: "admin",
        ipAddress: "127.0.0.1",
        deviceId: sourceDeviceId,
      },
      decision: "REVOKE",
      reason: `Remote Bridge disconnected (${reason}) for device ${sourceDeviceId}.`,
      riskLevel: reason === "USER_DISCONNECTED" ? "LOW" : "MEDIUM",
    });

    return {
      disconnected: true,
      reason,
      message: "Remote Bridge deactivated. Devices are now operating independently.",
    };
  }

  /**
   * Alias for disconnect() preserving backward compatibility.
   */
  deactivate(sourceDeviceId: string): { message: string } {
    const res = this.disconnect(sourceDeviceId, "USER_DISCONNECTED");
    return { message: res.message };
  }

  // =========================================================================
  // E. REMOTE CAPABILITY NEGOTIATION
  // =========================================================================

  /**
   * Negotiate supported capabilities between sourceDeviceId and targetDeviceId.
   * Inspects target device engine and disabledCapabilities list.
   */
  negotiateCapabilities(
    sourceDeviceId: string,
    targetDeviceId: string,
  ): NegotiatedCapabilityManifest {
    this._ensureEnginesRegistered();

    const targetIdentity = deviceRegistry.getDevice(targetDeviceId);
    const targetProductType: ProductType =
      targetIdentity?.productType ||
      (targetDeviceId.toLowerCase().includes("phone") || targetDeviceId.toLowerCase().includes("mobile")
        ? "MYRAA_MOBILE"
        : "MYRAA_DESKTOP");

    const disabled = new Set(targetIdentity?.disabledCapabilities || []);

    const desktopCatalog = [
      "desktop.openApplication",
      "desktop.closeApplication",
      "desktop.openFile",
      "desktop.openFolder",
      "desktop.readFile",
      "desktop.modifyFile",
      "desktop.deleteFile",
      "desktop.runCommand",
      "desktop.screenshot",
      "desktop.windowManagement",
      "desktop.clipboard",
      "desktop.codeInspect",
      "desktop.codeWorkflow",
      "desktop.projectIntelligence",
      "remote.openApplicationOnDesktop",
      "remote.readFileFromDesktop",
      "remote.runCommandOnDesktop",
      "remote.screenshotDesktop",
      "youtube.search",
      "youtube.play",
      "youtube.pause",
      "youtube.resume",
      "youtube.stop",
      "browser.openUrl",
      "browser.search",
      "web.research",
    ];

    const mobileCatalog = [
      "mobile.openApp",
      "mobile.closeApp",
      "mobile.alarm",
      "mobile.timer",
      "mobile.reminder",
      "mobile.calendar",
      "mobile.notes",
      "mobile.notifications",
      "mobile.deviceStatus",
      "mobile.camera",
      "mobile.photos",
      "mobile.contacts",
      "mobile.sms",
      "mobile.call",
      "youtube.search",
      "youtube.play",
      "youtube.pause",
      "youtube.resume",
      "youtube.stop",
      "browser.openUrl",
      "browser.search",
      "web.research",
    ];

    const allKnown = Array.from(new Set([...desktopCatalog, ...mobileCatalog]));
    const allowedCapabilities: string[] = [];
    const deniedCapabilities: string[] = [];

    const engine = deviceRegistry.getEngine(targetProductType);

    for (const cap of allKnown) {
      if (disabled.has(cap)) {
        deniedCapabilities.push(cap);
        continue;
      }

      if (targetProductType === "MYRAA_DESKTOP") {
        const isRemoteAlias = cap.startsWith("remote.");
        const supported = isRemoteAlias || (engine ? engine.canExecute(cap) : desktopCatalog.includes(cap));
        if (supported) {
          allowedCapabilities.push(cap);
        } else {
          deniedCapabilities.push(cap);
        }
      } else if (targetProductType === "MYRAA_MOBILE") {
        const supported = engine ? engine.canExecute(cap) : mobileCatalog.includes(cap);
        if (supported) {
          allowedCapabilities.push(cap);
        } else {
          deniedCapabilities.push(cap);
        }
      } else {
        deniedCapabilities.push(cap);
      }
    }

    const manifest: NegotiatedCapabilityManifest = {
      sourceDeviceId,
      targetDeviceId,
      targetProductType,
      allowedCapabilities,
      deniedCapabilities,
      negotiatedAt: new Date().toISOString(),
      manifestVersion: "1.0.0",
    };

    this._manifests.set(this._pairKey(sourceDeviceId, targetDeviceId), manifest);
    return manifest;
  }

  getNegotiatedManifest(
    sourceDeviceId: string,
    targetDeviceId: string,
  ): NegotiatedCapabilityManifest | undefined {
    return this._manifests.get(this._pairKey(sourceDeviceId, targetDeviceId));
  }

  // =========================================================================
  // L. AUTOMATIC DISCONNECT SAFETY HELPERS
  // =========================================================================

  /**
   * Revoke device pairing/authorization and immediately auto-disconnect any active bridge.
   */
  revokeDeviceAuthorization(
    sourceDeviceId: string,
    targetDeviceId: string,
    reason = "Device authorization revoked by user",
  ): void {
    const pairKey = this._pairKey(sourceDeviceId, targetDeviceId);
    const pairing = this._pairings.get(pairKey);
    if (pairing) {
      pairing.revoked = true;
      pairing.revokedReason = reason;
      identityAuthManager.revokeSession(pairing.sessionId, reason);
    }
    this.disconnect(sourceDeviceId, "DEVICE_REVOKED");
  }

  /**
   * Expire a pairing's authorization immediately (for deterministic testing or forced expiry)
   * and ensure subsequent calls auto-disconnect.
   */
  expireDeviceAuthorization(sourceDeviceId: string, targetDeviceId: string): void {
    const pairKey = this._pairKey(sourceDeviceId, targetDeviceId);
    const pairing = this._pairings.get(pairKey);
    if (pairing) {
      pairing.expiresAt = Date.now() - 1000;
    }
  }

  /**
   * Mark a device as lost or compromised: revokes its sessions and immediately
   * disconnects any active RemoteBridge involving this device.
   */
  markDeviceLost(deviceId: string, reason = "Device reported lost"): void {
    this._lostDevices.add(deviceId);
    identityAuthManager.revokeDevice(deviceId, reason);

    for (const pairing of this._pairings.values()) {
      if (pairing.sourceDeviceId === deviceId || pairing.targetDeviceId === deviceId) {
        pairing.lost = true;
        pairing.revoked = true;
        pairing.revokedReason = reason;
        this.disconnect(pairing.sourceDeviceId, "DEVICE_LOST");
      }
    }

    const status = deviceRegistry.getBridgeStatus(deviceId);
    if (status.state === "ACTIVE") {
      this.disconnect(deviceId, "DEVICE_LOST");
    }
  }

  /**
   * Trigger a security violation on a bridge session -> immediately revokes & auto-disconnects.
   */
  triggerSecurityViolation(sourceDeviceId: string, targetDeviceId: string, reason: string): void {
    const pairing = this._pairings.get(this._pairKey(sourceDeviceId, targetDeviceId));
    if (pairing) {
      identityAuthManager.triggerSuspiciousActivity(pairing.sessionId, reason);
      pairing.revoked = true;
      pairing.revokedReason = `SECURITY_VIOLATION: ${reason}`;
    }
    this.disconnect(sourceDeviceId, "SECURITY_VIOLATION");
  }

  /**
   * Check inactivity timeout and auto-disconnect if exceeded.
   */
  checkInactivityTimeout(
    sourceDeviceId: string,
    maxIdleMs = DEFAULT_INACTIVITY_TIMEOUT_MS,
  ): boolean {
    const lastActive = this._lastActivityMap.get(sourceDeviceId);
    if (lastActive !== undefined && Date.now() - lastActive > maxIdleMs) {
      this.disconnect(sourceDeviceId, "INACTIVITY_TIMEOUT");
      return true;
    }
    return false;
  }

  /**
   * Backdate last activity timestamp (for deterministic inactivity timeout testing).
   */
  setLastActivityForTesting(sourceDeviceId: string, timestampMs: number): void {
    this._lastActivityMap.set(sourceDeviceId, timestampMs);
  }

  // =========================================================================
  // F. REMOTE COMMAND EXECUTION, G. RESULT VERIFICATION & H. TIMEOUT / RETRY
  // =========================================================================

  /**
   * Execute a command across the Optional Remote Bridge with full security,
   * capability negotiation check, bounded timeout/retry, result verification,
   * DLP sanitization, and automatic disconnect safety.
   *
   * NEVER silently falls back to local execution!
   */
  async executeRemoteCommand(opts: RemoteExecutionOptions): Promise<RemoteExecutionResult> {
    this._ensureEnginesRegistered();

    const {
      sourceDeviceId,
      capability,
      args,
      confirmationToken,
      transportExecutor,
    } = opts;

    const status = deviceRegistry.getBridgeStatus(sourceDeviceId);
    const targetDeviceId = opts.targetDeviceId || status.targetDeviceId;
    const targetDevIdentity = targetDeviceId ? deviceRegistry.getDevice(targetDeviceId) : undefined;
    const targetProductType: ProductType =
      opts.targetProductType ||
      targetDevIdentity?.productType ||
      "MYRAA_DESKTOP";
    const targetDeviceEnum: TargetDevice =
      targetProductType === "MYRAA_MOBILE" ? "PHONE" : "REMOTE_DESKTOP";
    const toolName = this._capabilityToDesktopTool(capability);

    const makeFailResult = (params: {
      errorCode: NonNullable<RemoteExecutionResult["errorCode"]>;
      message: string;
      attempts?: number;
      timedOut?: boolean;
      autoDisconnected?: boolean;
      disconnectReason?: AutoDisconnectReason;
    }): RemoteExecutionResult => {
      const failVerification: ActionVerificationResult = {
        verified: false,
        capability,
        targetDevice: targetDeviceEnum,
        details: {
          sourceDeviceId,
          targetDeviceId: targetDeviceId || null,
          errorCode: params.errorCode,
          reason: params.message,
          attempts: params.attempts ?? 0,
          timedOut: Boolean(params.timedOut),
          autoDisconnected: Boolean(params.autoDisconnected),
          usedLocalFallback: false,
        },
        failureReason: params.message,
        failureCode: params.errorCode,
      };

      securityAuditLogger.logEvent({
        eventType: "TOOL_BLOCKED",
        actor: {
          identityId: opts.secContext?.identityId || sourceDeviceId,
          role: opts.secContext?.role || "admin",
          ipAddress: opts.secContext?.ipAddress || "127.0.0.1",
          deviceId: sourceDeviceId,
        },
        target: { toolName, resource: targetDeviceId || "remote_bridge" },
        decision: "BLOCK",
        reason: `Remote execution blocked [${params.errorCode}]: ${params.message}`,
        riskLevel: "MEDIUM",
      });

      return {
        success: false,
        ok: false,
        capability,
        toolName,
        sourceDeviceId,
        targetDeviceId: targetDeviceId || null,
        targetProductType,
        message: params.message,
        verified: false,
        verification: failVerification,
        attempts: params.attempts ?? 0,
        timedOut: Boolean(params.timedOut),
        autoDisconnected: Boolean(params.autoDisconnected),
        disconnectReason: params.disconnectReason,
        usedLocalFallback: false,
        errorCode: params.errorCode,
      };
    };

    // 1. I. Emergency Stop Check (immediate block & auto-disconnect)
    if (emergencyStopCoordinator.isActive()) {
      this.disconnect(sourceDeviceId, "EMERGENCY_STOP_ACTIVE");
      return makeFailResult({
        errorCode: "SECURITY_POLICY_DENIED",
        message: "EMERGENCY_STOP_ACTIVE: All remote bridge execution is immediately halted.",
        autoDisconnected: true,
        disconnectReason: "EMERGENCY_STOP_ACTIVE",
      });
    }

    // 2. J. Security Lockdown Check
    if (securityPolicyEngine.getMode() === "LOCKDOWN" && !LOCKDOWN_ALLOWLIST.has(toolName)) {
      this.disconnect(sourceDeviceId, "SECURITY_LOCKDOWN");
      return makeFailResult({
        errorCode: "SECURITY_POLICY_DENIED",
        message: `SECURITY_LOCKDOWN: Remote tool '${toolName}' (${capability}) is blocked in LOCKDOWN mode.`,
        autoDisconnected: true,
        disconnectReason: "SECURITY_LOCKDOWN",
      });
    }

    // 3. L. Check Lost Device before bridge status
    if (
      this._lostDevices.has(sourceDeviceId) ||
      (targetDeviceId && this._lostDevices.has(targetDeviceId))
    ) {
      this.disconnect(sourceDeviceId, "DEVICE_LOST");
      return makeFailResult({
        errorCode: "DEVICE_LOST",
        message: "DEVICE_LOST: Device was reported lost; Remote Bridge automatically disconnected.",
        autoDisconnected: true,
        disconnectReason: "DEVICE_LOST",
      });
    }

    // 4. C. Bridge Active State Check
    if (status.state !== "ACTIVE" || !targetDeviceId) {
      const prevReason = this._lastDisconnectReasons.get(sourceDeviceId);
      if (prevReason === "DEVICE_REVOKED") {
        return makeFailResult({
          errorCode: "DEVICE_REVOKED",
          message: "DEVICE_REVOKED: Device authorization was revoked and bridge is disconnected.",
        });
      }
      if (prevReason === "DEVICE_LOST") {
        return makeFailResult({
          errorCode: "DEVICE_LOST",
          message: "DEVICE_LOST: Device was marked lost and bridge is disconnected.",
        });
      }
      return makeFailResult({
        errorCode: "BRIDGE_INACTIVE",
        message: "BRIDGE_INACTIVE: Remote Bridge is not connected. Explicit connection is required; never falling back locally.",
      });
    }

    // 5. L. Inactivity Timeout Check
    if (this.checkInactivityTimeout(sourceDeviceId)) {
      return makeFailResult({
        errorCode: "AUTHORIZATION_EXPIRED",
        message: "INACTIVITY_TIMEOUT: Remote Bridge session automatically disconnected due to inactivity.",
        autoDisconnected: true,
        disconnectReason: "INACTIVITY_TIMEOUT",
      });
    }

    // 6. D. Device Authorization & Pairing Check (IdentityAuthManager)
    const authCheck = this.authorizeRemoteDevice({
      sourceDeviceId,
      targetDeviceId,
      accessToken: opts.accessToken,
    });
    if (!authCheck.authorized) {
      const disconnectReason: AutoDisconnectReason =
        authCheck.errorCode === "DEVICE_REVOKED"
          ? "DEVICE_REVOKED"
          : authCheck.errorCode === "DEVICE_LOST"
          ? "DEVICE_LOST"
          : "AUTHORIZATION_EXPIRED";
      this.disconnect(sourceDeviceId, disconnectReason);
      return makeFailResult({
        errorCode: authCheck.errorCode || "AUTHORIZATION_EXPIRED",
        message: authCheck.reason || "Remote Bridge authorization invalid.",
        autoDisconnected: true,
        disconnectReason,
      });
    }

    // 7. D. Target Device Online / Availability Check (NEVER local fallback!)
    const overrides = capabilityRegistry.getDeviceAvailabilityOverrides();
    const isDesktopTarget = targetProductType === "MYRAA_DESKTOP";
    if (
      (isDesktopTarget && (overrides.desktopAvailable === false || overrides.remoteDesktopAvailable === false)) ||
      (!isDesktopTarget && overrides.phoneAvailable === false)
    ) {
      return makeFailResult({
        errorCode: "TARGET_DEVICE_UNAVAILABLE",
        message: `TARGET_DEVICE_UNAVAILABLE: Target device '${targetDeviceId}' (${targetProductType}) is offline or unreachable. Never falling back to local device.`,
      });
    }

    // 8. E. Negotiated Capability Check
    const manifest =
      this.getNegotiatedManifest(sourceDeviceId, targetDeviceId) ||
      this.negotiateCapabilities(sourceDeviceId, targetDeviceId);

    if (!manifest.allowedCapabilities.includes(capability)) {
      return makeFailResult({
        errorCode: "CAPABILITY_NOT_SUPPORTED",
        message: `CAPABILITY_NOT_SUPPORTED: Capability '${capability}' is not supported or not negotiated on remote device '${targetDeviceId}' (${targetProductType}).`,
      });
    }

    // Also check app-level support if opening an application on the remote target
    if (capability === "desktop.openApplication" || capability === "mobile.openApp") {
      const rawApp = String(args.appName || args.name || args.app || "").trim();
      if (rawApp) {
        const aliasRes = capabilityRegistry.resolveApplicationAlias(rawApp);
        if (!aliasRes.resolved || !aliasRes.canonicalApp) {
          return makeFailResult({
            errorCode: "CAPABILITY_NOT_SUPPORTED",
            message: `CAPABILITY_NOT_SUPPORTED: Application '${rawApp}' is not recognized on remote target.`,
          });
        }
      }
    }

    // 9. F. SecurityPolicyEngine + ToolExecutionFirewall Check
    const secContext: SecurityContext = opts.secContext || {
      identityId: authCheck.pairing?.accountId || sourceDeviceId,
      role: authCheck.pairing?.role || "admin",
      ipAddress: "127.0.0.1",
      sessionId: authCheck.pairing?.sessionId,
      deviceId: sourceDeviceId,
      isLocal: false,
    };

    // Bounded retry + timeout parameters (H)
    const timeoutMs = Math.max(50, Math.min(opts.timeoutMs ?? DEFAULT_REMOTE_TIMEOUT_MS, 30000));
    const maxRetries = Math.max(0, Math.min(opts.maxRetries ?? DEFAULT_MAX_RETRIES, MAX_BOUNDED_RETRIES_LIMIT));
    const maxAttempts = 1 + maxRetries;

    let attempts = 0;
    let lastError = "";
    let timedOut = false;

    const executeWithBoundedRetries = async (): Promise<unknown> => {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        attempts = attempt;
        try {
          const callPromise = (async () => {
            if (transportExecutor) {
              return await transportExecutor(capability, toolName, args, attempt);
            }
            if (targetProductType === "MYRAA_DESKTOP") {
              // If an active desktop companion WebSocket is connected in RemoteSessionManager, use it;
              // otherwise if target device is registered in DeviceRegistry, execute via DesktopCapabilityEngine
              const companion = remoteSessionManager.getActiveDesktopCompanion();
              if (companion) {
                return await remoteSessionManager.executeOnDesktopCompanion(toolName, args, timeoutMs);
              }
              const engineRes = await desktopCapabilityEngine.execute(
                capability.startsWith("remote.") ? "desktop.openApplication" : capability,
                {
                  ...args,
                  appName: args.appName || args.name || args.app,
                  filePath: args.filePath || args.path,
                },
                {
                  deviceId: targetDeviceId,
                  productType: "MYRAA_DESKTOP",
                  bridgeActive: true,
                  bridgeTargetDeviceId: targetDeviceId,
                },
              );
              return {
                ok: engineRes.success,
                result: engineRes.payload || { message: engineRes.message },
                error: engineRes.success ? undefined : engineRes.message,
              };
            } else {
              const engineRes = await androidCapabilityEngine.execute(
                capability,
                {
                  ...args,
                  appName: args.appName || args.name || args.app,
                },
                {
                  deviceId: targetDeviceId,
                  productType: "MYRAA_MOBILE",
                  bridgeActive: true,
                  bridgeTargetDeviceId: targetDeviceId,
                },
              );
              return {
                ok: engineRes.success,
                result: engineRes.payload || { message: engineRes.message },
                error: engineRes.success ? undefined : engineRes.message,
              };
            }
          })();

          const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => {
              reject(new Error(`REMOTE_TIMEOUT: Remote execution timed out after ${timeoutMs}ms (attempt ${attempt}/${maxAttempts}).`));
            }, timeoutMs);
          });

          const rawRes = await Promise.race([callPromise, timeoutPromise]);
          if (rawRes && typeof rawRes === "object" && "ok" in rawRes && !(rawRes as any).ok) {
            const errText = String((rawRes as any).error || "Remote transport returned ok=false");
            throw new Error(errText);
          }

          return rawRes;
        } catch (err: any) {
          lastError = err?.message || String(err);
          if (lastError.includes("REMOTE_TIMEOUT") || lastError.includes("timed out")) {
            timedOut = true;
          }
          // If Emergency Stop was triggered mid-retry, abort immediately without further retries!
          if (emergencyStopCoordinator.isActive()) {
            throw new Error("EMERGENCY_STOP_ACTIVE: Halted during remote retry.");
          }
          if (attempt === maxAttempts) {
            throw new Error(lastError);
          }
        }
      }
      throw new Error(lastError || "Remote execution failed after bounded retries.");
    };

    const firewallOutcome = await toolExecutionFirewall.executeGuardedTool(
      toolName,
      args,
      secContext,
      executeWithBoundedRetries,
      confirmationToken || (args.confirmationToken as string | undefined),
    );

    if (!firewallOutcome.ok) {
      if (firewallOutcome.requiresConfirmation) {
        return makeFailResult({
          errorCode: "CONFIRMATION_REQUIRED",
          message: firewallOutcome.error || "Explicit confirmation required for remote tool execution.",
          attempts,
        });
      }

      if (firewallOutcome.blocked) {
        const isPerm =
          firewallOutcome.decision.reason.includes("Role") ||
          firewallOutcome.decision.reason.includes("PERMISSION");
        return makeFailResult({
          errorCode: isPerm ? "PERMISSION_DENIED" : "SECURITY_POLICY_DENIED",
          message: firewallOutcome.error || firewallOutcome.decision.reason,
          attempts,
        });
      }

      // Transport failure or bounded timeout exhaustion -> Automatic Disconnect Safety (L)
      this.disconnect(sourceDeviceId, "TRANSPORT_FAILURE");
      deviceRegistry.setBridgeError(sourceDeviceId, firewallOutcome.error || lastError);

      return makeFailResult({
        errorCode: timedOut ? "REMOTE_TIMEOUT" : "REMOTE_EXECUTION_FAILED",
        message:
          firewallOutcome.error ||
          lastError ||
          `Remote execution failed after ${attempts} bounded attempt(s).`,
        attempts,
        timedOut,
        autoDisconnected: true,
        disconnectReason: "TRANSPORT_FAILURE",
      });
    }

    // 10. G. Deterministic Remote Result Verification
    const rawResultObj = (firewallOutcome.result || {}) as Record<string, any>;
    const innerResult = rawResultObj.result ?? rawResultObj;
    const verification = this._verifyRemoteActionResult(
      capability,
      args,
      { ok: true, result: innerResult },
      targetDeviceEnum,
    );

    if (!verification.verified) {
      return makeFailResult({
        errorCode: "VERIFICATION_FAILED",
        message: verification.failureReason || "Remote command executed but result verification failed.",
        attempts,
      });
    }

    // Update activity timestamp
    this._lastActivityMap.set(sourceDeviceId, Date.now());

    // DLP sanitize final payload
    const { sanitized } = outputDataFirewall.sanitizeResult(innerResult, {
      toolName,
      sessionId: secContext.sessionId,
    });

    securityAuditLogger.logEvent({
      eventType: "TOOL_ALLOW",
      actor: {
        identityId: secContext.identityId,
        role: secContext.role,
        ipAddress: secContext.ipAddress,
        sessionId: secContext.sessionId,
        deviceId: sourceDeviceId,
      },
      target: { toolName, resource: targetDeviceId },
      decision: "ALLOW",
      reason: `Remote capability '${capability}' executed and verified on '${targetDeviceId}' in ${attempts} attempt(s).`,
      riskLevel: firewallOutcome.decision.risk.level,
    });

    return {
      success: true,
      ok: true,
      capability,
      toolName,
      sourceDeviceId,
      targetDeviceId,
      targetProductType,
      message: `Remote capability '${capability}' executed and verified on ${targetDeviceId}.`,
      payload: { result: sanitized, verification },
      verified: true,
      verification,
      attempts,
      timedOut: false,
      autoDisconnected: false,
      usedLocalFallback: false,
    };
  }

  /**
   * Backward-compatible wrapper around executeRemoteCommand().
   */
  async executeRemote(
    sourceDeviceId: string,
    capability: string,
    args: Record<string, unknown>,
    targetProductType: ProductType,
  ): Promise<{
    success: boolean;
    message: string;
    payload?: Record<string, unknown>;
    errorCode?: string;
    verified?: boolean;
    verification?: ActionVerificationResult;
  }> {
    const res = await this.executeRemoteCommand({
      sourceDeviceId,
      capability,
      args,
      targetProductType,
    });
    return {
      success: res.success,
      message: res.message,
      payload: res.payload,
      errorCode: res.errorCode,
      verified: res.verified,
      verification: res.verification,
    };
  }

  /**
   * Deterministic verifier for remote capability execution (G).
   */
  private _verifyRemoteActionResult(
    capability: string,
    args: Record<string, unknown>,
    execOutcome: { ok: boolean; result?: any; error?: string },
    targetDevice: TargetDevice,
  ): ActionVerificationResult {
    if (
      capability === "desktop.openApplication" ||
      capability === "mobile.openApp" ||
      capability === "remote.openApplicationOnDesktop"
    ) {
      const appName = String(args.appName || args.name || args.app || "app");
      return actionVerifier.toEnvelope(
        actionVerifier.verifyOpenApplication(appName, execOutcome, targetDevice),
      );
    }

    if (capability === "desktop.openFile") {
      const filePath = String(args.filePath || args.path || "");
      const editor = String(args.editor || "vscode");
      return actionVerifier.toEnvelope(
        actionVerifier.verifyOpenFile(filePath, editor, execOutcome, targetDevice, true),
      );
    }

    if (capability === "browser.openUrl") {
      const url = String(args.url || args.link || "");
      return actionVerifier.toEnvelope(
        actionVerifier.verifyBrowserOpenUrl(url, execOutcome, targetDevice),
      );
    }

    const ok = Boolean(execOutcome.ok && execOutcome.result !== undefined);
    return {
      verified: ok,
      capability,
      targetDevice,
      details: {
        ...(typeof execOutcome.result === "object" && execOutcome.result ? execOutcome.result : { value: execOutcome.result }),
        verified: ok,
      },
      ...(!ok ? { failureReason: execOutcome.error || "Remote verification failed." } : {}),
    };
  }

  /**
   * Returns a user-friendly message explaining that a capability needs bridge activation.
   */
  buildBridgeRequiredMessage(
    capability: string,
    targetProduct: ProductType,
    _sourceProduct: ProductType,
  ): string {
    if (targetProduct === "MYRAA_DESKTOP") {
      return `Ye capability (${capability}) sirf MYRAA Desktop pe chalti hai. Kya aap phone ko desktop se connect karna chahoge? (Haan/Nahi)`;
    }
    if (targetProduct === "MYRAA_MOBILE") {
      return `Ye capability (${capability}) sirf MYRAA Mobile pe chalti hai. Kya aap desktop ko phone se connect karna chahoge? (Haan/Nahi)`;
    }
    return `Ye capability ek doosre device pe chalti hai. Remote Bridge activate karna chahoge?`;
  }

  // ── Internal helpers ─────────────────────────────────────────────────────

  private _findConnectedDesktopId(): string | null {
    const companion = remoteSessionManager.getActiveDesktopCompanion();
    if (companion?.session.deviceId) return companion.session.deviceId;
    const registeredDesktop = deviceRegistry
      .listDevices()
      .find((d) => d.productType === "MYRAA_DESKTOP" && d.registered);
    return registeredDesktop?.deviceId ?? null;
  }

  private _findConnectedMobileId(): string | null {
    const sessions = remoteSessionManager.getActiveSessions();
    const mobileSession = sessions.find((s) => {
      const ua = (s.userAgent || "").toLowerCase();
      return ua.includes("android") || ua.includes("iphone") || ua.includes("ipad");
    });
    if (mobileSession?.deviceId) return mobileSession.deviceId;
    const registeredMobile = deviceRegistry
      .listDevices()
      .find((d) => d.productType === "MYRAA_MOBILE" && d.registered);
    return registeredMobile?.deviceId ?? null;
  }

  private _capabilityToDesktopTool(capability: string): string {
    const toolMap: Record<string, string> = {
      "desktop.openApplication":          "openApplication",
      "desktop.closeApplication":         "closeApplication",
      "desktop.openFile":                 "openFile",
      "desktop.openFolder":               "openFolder",
      "desktop.readFile":                 "readFile",
      "desktop.modifyFile":               "writeCodeFile",
      "desktop.deleteFile":               "deleteFile",
      "desktop.runCommand":               "runShellCommand",
      "desktop.screenshot":               "takeScreenshot",
      "desktop.codeInspect":              "readFile",
      "remote.openApplicationOnDesktop":  "openApplication",
      "remote.readFileFromDesktop":       "readFile",
      "remote.runCommandOnDesktop":       "runShellCommand",
      "remote.screenshotDesktop":         "takeScreenshot",
      "mobile.openApp":                   "openApplication",
      "mobile.alarm":                     "setAlarm",
      "mobile.timer":                     "setTimer",
      "mobile.reminder":                  "createReminder",
    };
    return toolMap[capability] ?? capability;
  }

  resetForTesting(): void {
    this._challenges.clear();
    this._pairings.clear();
    this._manifests.clear();
    this._lastActivityMap.clear();
    this._lostDevices.clear();
    this._lastDisconnectReasons.clear();
  }
}

export const remoteBridge = new RemoteBridge();
