/**
 * MYRAA — DeviceRegistry
 *
 * Central registry for device identity in the multi-device architecture.
 *
 * Responsibilities:
 *   - Maps deviceId → DeviceIdentity (productType, accountId, bridge state)
 *   - Resolves which ProductCapabilityEngine handles a given capability
 *   - Manages RemoteBridge activation state (INACTIVE by default)
 *   - Provides capability routing decisions to CapabilityRegistry
 *
 * Security boundary:
 *   DeviceRegistry does NOT perform security policy evaluation.
 *   That remains in SecurityPolicyEngine + CapabilityRegistry.
 *   DeviceRegistry only answers "which engine can execute this?" and
 *   "is this device's bridge currently active?"
 */

import type {
  ProductType,
  CapabilityScope,
  DeviceIdentity,
  ProductCapabilityEngine,
  BridgeState,
  RemoteBridgeStatus,
} from "./DeviceTypes.ts";

// ---------------------------------------------------------------------------
// Capability Scope Map — canonical scope for every known capability name
// ---------------------------------------------------------------------------

/**
 * Maps capability names to their CapabilityScope.
 * Used by DeviceRegistry.getScopeFor() to route capabilities to the correct engine.
 *
 * Rules:
 *   desktop-local   → only DesktopCapabilityEngine can execute
 *   mobile-local    → only AndroidCapabilityEngine can execute
 *   shared-cloud    → any engine (whichever product is asking)
 *   remote-bridged  → needs RemoteBridge (OPTIONAL)
 */
const CAPABILITY_SCOPE_MAP: Readonly<Record<string, CapabilityScope>> = {
  // ── Desktop-local (require MYRAA Desktop) ──────────────────────────────
  "desktop.openApplication":     "desktop-local",
  "desktop.closeApplication":    "desktop-local",
  "desktop.openFile":            "desktop-local",
  "desktop.openFolder":          "desktop-local",
  "desktop.readFile":            "desktop-local",
  "desktop.modifyFile":          "desktop-local",
  "desktop.deleteFile":          "desktop-local",
  "desktop.runCommand":          "desktop-local",
  "desktop.screenshot":          "desktop-local",
  "desktop.windowManagement":    "desktop-local",
  "desktop.clipboard":           "desktop-local",
  "desktop.codeInspect":         "desktop-local",
  "desktop.codeWorkflow":        "desktop-local",
  "desktop.projectIntelligence": "desktop-local",

  // ── Mobile-local (require MYRAA Mobile) ───────────────────────────────
  "mobile.openApp":              "mobile-local",
  "mobile.closeApp":             "mobile-local",
  "mobile.alarm":                "mobile-local",
  "mobile.timer":                "mobile-local",
  "mobile.reminder":             "mobile-local",
  "mobile.calendar":             "mobile-local",
  "mobile.notes":                "mobile-local",
  "mobile.notifications":        "mobile-local",
  "mobile.deviceStatus":         "mobile-local",
  "mobile.camera":               "mobile-local",
  "mobile.photos":               "mobile-local",
  "mobile.contacts":             "mobile-local",
  "mobile.sms":                  "mobile-local",
  "mobile.call":                 "mobile-local",

  // ── Shared cloud (any MYRAA product) ──────────────────────────────────
  "youtube.search":              "shared-cloud",
  "youtube.play":                "shared-cloud",
  "youtube.pause":               "shared-cloud",
  "youtube.resume":              "shared-cloud",
  "youtube.stop":                "shared-cloud",
  "youtube.next":                "shared-cloud",
  "youtube.previous":            "shared-cloud",
  "youtube.volume":              "shared-cloud",
  "browser.openUrl":             "shared-cloud",
  "browser.search":              "shared-cloud",
  "web.research":                "shared-cloud",
  "ai.chat":                     "shared-cloud",
  "ai.summarize":                "shared-cloud",
  "memory.read":                 "shared-cloud",
  "memory.write":                "shared-cloud",

  // ── Remote-bridged (cross-device, requires active RemoteBridge) ───────
  "remote.openApplicationOnDesktop":  "remote-bridged",
  "remote.readFileFromDesktop":       "remote-bridged",
  "remote.runCommandOnDesktop":       "remote-bridged",
  "remote.screenshotDesktop":         "remote-bridged",
};

// ---------------------------------------------------------------------------
// DeviceRegistry
// ---------------------------------------------------------------------------

export class DeviceRegistry {
  /** In-memory device identity map — keyed by deviceId */
  private _devices = new Map<string, DeviceIdentity>();

  /** Registered capability engines — keyed by ProductType */
  private _engines = new Map<ProductType, ProductCapabilityEngine>();

  /** Bridge state per source device */
  private _bridgeStatus = new Map<string, RemoteBridgeStatus>();

  // ── Engine Registration ────────────────────────────────────────────────

  /**
   * Register a capability engine for a ProductType.
   * Replaces any previously registered engine for the same ProductType.
   */
  registerEngine(engine: ProductCapabilityEngine): void {
    this._engines.set(engine.productType, engine);
  }

  getEngine(productType: ProductType): ProductCapabilityEngine | undefined {
    return this._engines.get(productType);
  }

  // ── Device Identity ────────────────────────────────────────────────────

  /**
   * Register or update a device identity.
   * Called when a device authenticates (connects via WebSocket or HTTP).
   */
  registerDevice(identity: DeviceIdentity): void {
    this._devices.set(identity.deviceId, { ...identity });
  }

  getDevice(deviceId: string): DeviceIdentity | undefined {
    return this._devices.get(deviceId);
  }

  listDevices(): DeviceIdentity[] {
    return Array.from(this._devices.values());
  }

  /**
   * Infer the ProductType from an existing PairedDevice record.
   * Used during the migration period when devices don't yet carry productType.
   */
  inferProductType(opts: {
    deviceType: string;   // RemoteTypes.DeviceType
    userAgent?: string;
  }): ProductType {
    const ua = (opts.userAgent || "").toLowerCase();
    const dt = opts.deviceType;

    if (dt === "desktop_client" || ua.includes("electron") || ua.includes("windows")) {
      return "MYRAA_DESKTOP";
    }
    if (dt === "mobile" || dt === "tablet" || ua.includes("android") || ua.includes("iphone")) {
      return "MYRAA_MOBILE";
    }
    return "MYRAA_BROWSER";
  }

  // ── Capability Routing ─────────────────────────────────────────────────

  /**
   * Returns the CapabilityScope for a given capability name.
   */
  getScopeFor(capability: string): CapabilityScope | undefined {
    return CAPABILITY_SCOPE_MAP[capability];
  }

  /**
   * Determine the ProductType that should execute a capability, given the
   * requesting device and current bridge state.
   *
   * Returns:
   *   { canExecute: true, executingProductType, scope }
   *     — capability can be executed; use the returned engine
   *   { canExecute: false, reason, bridgeRequired, bridgeTargetProduct }
   *     — capability cannot execute; optionally offer bridge activation
   */
  resolveExecutor(opts: {
    capability: string;
    requestingDeviceId: string;
    requestingProductType: ProductType;
  }): {
    canExecute: boolean;
    executingProductType?: ProductType;
    scope?: CapabilityScope;
    reason?: string;
    bridgeRequired?: boolean;
    bridgeTargetProduct?: ProductType;
  } {
    const scope = CAPABILITY_SCOPE_MAP[opts.capability];

    if (!scope) {
      // Unknown capability — let CapabilityRegistry handle it (may be a tool name not in our map)
      return { canExecute: true, executingProductType: opts.requestingProductType, scope: "shared-cloud" };
    }

    if (scope === "shared-cloud") {
      // Any product can handle it
      return { canExecute: true, executingProductType: opts.requestingProductType, scope };
    }

    if (scope === "desktop-local") {
      if (opts.requestingProductType === "MYRAA_DESKTOP") {
        return { canExecute: true, executingProductType: "MYRAA_DESKTOP", scope };
      }
      // Phone or Browser requesting a desktop-local capability
      const bridge = this._bridgeStatus.get(opts.requestingDeviceId);
      if (bridge?.state === "ACTIVE" && bridge.targetDeviceId) {
        return {
          canExecute: true,
          executingProductType: "MYRAA_DESKTOP",
          scope: "remote-bridged",
        };
      }
      return {
        canExecute: false,
        reason: `Ye capability sirf MYRAA Desktop pe chalti hai. Desktop connect karna chahoge?`,
        bridgeRequired: true,
        bridgeTargetProduct: "MYRAA_DESKTOP",
        scope,
      };
    }

    if (scope === "mobile-local") {
      if (opts.requestingProductType === "MYRAA_MOBILE") {
        return { canExecute: true, executingProductType: "MYRAA_MOBILE", scope };
      }
      const bridge = this._bridgeStatus.get(opts.requestingDeviceId);
      if (bridge?.state === "ACTIVE" && bridge.targetDeviceId) {
        return {
          canExecute: true,
          executingProductType: "MYRAA_MOBILE",
          scope: "remote-bridged",
        };
      }
      return {
        canExecute: false,
        reason: `Ye capability sirf MYRAA Mobile pe chalti hai. Phone connect karna chahoge?`,
        bridgeRequired: true,
        bridgeTargetProduct: "MYRAA_MOBILE",
        scope,
      };
    }

    if (scope === "remote-bridged") {
      const bridge = this._bridgeStatus.get(opts.requestingDeviceId);
      if (bridge?.state === "ACTIVE") {
        // Determine target engine based on capability name
        const targetProduct: ProductType = opts.capability.startsWith("remote.openApplication") ||
          opts.capability.startsWith("remote.readFile") ||
          opts.capability.startsWith("remote.runCommand") ||
          opts.capability.startsWith("remote.screenshot")
          ? "MYRAA_DESKTOP"
          : "MYRAA_MOBILE";
        return { canExecute: true, executingProductType: targetProduct, scope };
      }
      return {
        canExecute: false,
        reason: `Cross-device capability ke liye Remote Bridge activate karo. Karna chahoge?`,
        bridgeRequired: true,
        scope,
      };
    }

    return { canExecute: false, reason: "Unknown capability scope", scope };
  }

  // ── Remote Bridge Management ───────────────────────────────────────────

  /**
   * Get the current bridge status for a device.
   * Default state is INACTIVE — bridge must be EXPLICITLY activated.
   */
  getBridgeStatus(deviceId: string): RemoteBridgeStatus {
    return this._bridgeStatus.get(deviceId) ?? {
      state: "INACTIVE",
      sourceDeviceId: deviceId,
      targetDeviceId: null,
      activatedAt: null,
      lastError: null,
    };
  }

  /**
   * Activate the remote bridge between source and target devices.
   * MUST only be called when the user explicitly requests cross-device connection.
   *
   * This does NOT auto-trigger on login, session start, or account match.
   */
  activateBridge(sourceDeviceId: string, targetDeviceId: string): void {
    this._bridgeStatus.set(sourceDeviceId, {
      state: "ACTIVE",
      sourceDeviceId,
      targetDeviceId,
      activatedAt: new Date().toISOString(),
      lastError: null,
    });
    console.log(
      `[DeviceRegistry] Remote bridge ACTIVATED: ${sourceDeviceId} → ${targetDeviceId}`
    );
  }

  /**
   * Deactivate the remote bridge for a device.
   * Returns to INACTIVE state — default.
   */
  deactivateBridge(sourceDeviceId: string): void {
    const existing = this._bridgeStatus.get(sourceDeviceId);
    if (existing) {
      this._bridgeStatus.set(sourceDeviceId, {
        ...existing,
        state: "INACTIVE",
        targetDeviceId: null,
        activatedAt: null,
      });
    }
    console.log(`[DeviceRegistry] Remote bridge DEACTIVATED: ${sourceDeviceId}`);
  }

  setBridgeError(sourceDeviceId: string, error: string): void {
    const existing = this._bridgeStatus.get(sourceDeviceId) ?? {
      state: "ERROR" as BridgeState,
      sourceDeviceId,
      targetDeviceId: null,
      activatedAt: null,
      lastError: null,
    };
    this._bridgeStatus.set(sourceDeviceId, {
      ...existing,
      state: "ERROR",
      lastError: error,
    });
  }

  // ── Testing Support ────────────────────────────────────────────────────

  resetForTesting(): void {
    this._devices.clear();
    this._engines.clear();
    this._bridgeStatus.clear();
  }
}

export const deviceRegistry = new DeviceRegistry();
