/**
 * MYRAA — DeviceTypes
 *
 * Canonical type system for the multi-device product architecture.
 *
 * CORE PRINCIPLE:
 *   PHONE ≠ REMOTE DESKTOP
 *   DESKTOP ≠ PHONE
 *   ACCOUNT ≠ DEVICE
 *   SAME ACCOUNT ≠ AUTOMATIC REMOTE CONNECTION
 *   MEMORY MAY BE SHARED — DEVICE EXECUTION MUST REMAIN DEVICE-SCOPED
 *
 * Every capability has a CapabilityScope that determines which engine can execute it.
 * RemoteBridge is OPTIONAL and must be explicitly activated by the user.
 */

// ---------------------------------------------------------------------------
// Product Type — first-class product identity (distinct from DeviceRole)
// ---------------------------------------------------------------------------

/**
 * First-class product type. Each MYRAA product is independently functional.
 *
 * MYRAA_MOBILE  — Android app; phone-local capabilities; works without desktop.
 * MYRAA_DESKTOP — Electron/Windows; desktop-local capabilities; works without phone.
 * MYRAA_BROWSER — Web companion tab; browser-scoped capabilities.
 */
export type ProductType = "MYRAA_MOBILE" | "MYRAA_DESKTOP" | "MYRAA_BROWSER";

// ---------------------------------------------------------------------------
// Capability Scope — where a capability can execute
// ---------------------------------------------------------------------------

/**
 * CapabilityScope defines which device(s) can execute a capability.
 *
 * desktop-local   — Requires MYRAA Desktop. Cannot run on phone.
 * mobile-local    — Requires MYRAA Mobile. Cannot run on desktop.
 * shared-cloud    — Runs on whichever MYRAA product is issuing the request.
 * remote-bridged  — Cross-device. Requires RemoteBridge to be explicitly active.
 */
export type CapabilityScope =
  | "desktop-local"
  | "mobile-local"
  | "shared-cloud"
  | "remote-bridged";

// ---------------------------------------------------------------------------
// Device Identity — enriched first-class device record
// ---------------------------------------------------------------------------

/**
 * DeviceIdentity is the first-class device record in the DeviceRegistry.
 * It extends the existing PairedDevice concept with product-level identity.
 *
 * NOTE: productType is independent of DeviceRole (admin/standard/read_only).
 * A phone can be admin. A desktop can be standard. These are orthogonal concerns.
 */
export interface DeviceIdentity {
  /** Matches PairedDevice.id — same UUID used in RemoteStore */
  deviceId: string;

  /** Friendly name, e.g. "Sandeep's Phone" or "Gaming PC" */
  deviceName: string;

  /** First-class product type */
  productType: ProductType;

  /** Account/user that owns this device registration */
  accountId: string;

  /** Whether this device has completed initial setup and capability handshake */
  registered: boolean;

  /** ISO timestamp of first registration */
  registeredAt: string;

  /** ISO timestamp of last seen */
  lastSeenAt: string;

  /** True only when this device has been explicitly connected to the remote bridge */
  bridgeConnected: boolean;

  /** The paired target device ID when bridge is active (null when bridge is inactive) */
  bridgeTargetDeviceId: string | null;

  /** Device-level capability overrides (e.g. user disabled specific capabilities) */
  disabledCapabilities: string[];
}

// ---------------------------------------------------------------------------
// Capability Engine Contract
// ---------------------------------------------------------------------------

/**
 * ProductCapabilityEngine defines the interface that both AndroidCapabilityEngine
 * and DesktopCapabilityEngine must implement.
 *
 * Each engine is responsible for:
 *   - Declaring which capabilities it supports (capability → scope mapping)
 *   - Executing capabilities with device-local context
 *   - Reporting whether a given capability can execute NOW (device state)
 */
export interface ProductCapabilityEngine {
  readonly productType: ProductType;

  /**
   * Returns true if this engine can execute the given capability right now.
   * Checks device-local state (e.g. app installed, permission granted).
   *
   * Does NOT check security policy — that stays in CapabilityRegistry.
   */
  canExecute(capability: string): boolean;

  /**
   * Returns the CapabilityScope for a given capability name.
   * Returns undefined if this engine doesn't know about the capability.
   */
  getScopeFor(capability: string): CapabilityScope | undefined;

  /**
   * Execute a capability by name with the given arguments.
   * Returns a structured result envelope.
   */
  execute(
    capability: string,
    args: Record<string, unknown>,
    context: DeviceExecutionContext,
  ): Promise<DeviceCapabilityResult>;
}

// ---------------------------------------------------------------------------
// Execution Context — passed to engine.execute()
// ---------------------------------------------------------------------------

/**
 * Device-scoped execution context passed to each capability engine.
 * Intentionally minimal — security evaluation happens in CapabilityRegistry,
 * not here.
 */
export interface DeviceExecutionContext {
  /** The device issuing the request */
  deviceId: string;
  productType: ProductType;

  /** Current session ID (from RemoteSession) */
  sessionId?: string;

  /** Whether the RemoteBridge is currently active for this device */
  bridgeActive: boolean;

  /** The bridge target device ID (only meaningful if bridgeActive === true) */
  bridgeTargetDeviceId?: string;

  /** Arbitrary per-capability options */
  options?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Capability Result Envelope
// ---------------------------------------------------------------------------

/**
 * Uniform result envelope returned by ProductCapabilityEngine.execute().
 */
export interface DeviceCapabilityResult {
  /** Whether the capability executed successfully */
  success: boolean;

  /** Human-readable result text for Gemini / UI display */
  message: string;

  /** Structured payload (capability-specific) */
  payload?: Record<string, unknown>;

  /**
   * If success is false and the reason is a missing capability on this device,
   * bridgeRequired is true to signal that the RemoteBridge should be offered.
   */
  bridgeRequired?: boolean;

  /**
   * If bridgeRequired is true, this is the ProductType of the device that
   * CAN execute this capability.
   */
  bridgeTargetProduct?: ProductType;

  /** Error code for programmatic handling */
  errorCode?: string;
}

// ---------------------------------------------------------------------------
// Remote Bridge State
// ---------------------------------------------------------------------------

/**
 * State of the RemoteBridge between two MYRAA devices.
 *
 * INACTIVE — default state. No cross-device execution occurs.
 * PENDING  — user requested bridge activation; awaiting confirmation on target device.
 * ACTIVE   — bridge is live; remote-bridged capabilities can execute.
 * ERROR    — bridge failed; user must re-activate.
 */
export type BridgeState = "INACTIVE" | "PENDING" | "ACTIVE" | "ERROR";

export interface RemoteBridgeStatus {
  state: BridgeState;
  sourceDeviceId: string;
  targetDeviceId: string | null;
  activatedAt: string | null;
  lastError: string | null;
}
