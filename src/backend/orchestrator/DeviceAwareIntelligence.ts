/**
 * MYRAA — Phase 5: Device-Aware Intelligence
 *
 * Implements Device-Aware Intelligence on top of the Phase 4 Intent & Capability Orchestrator:
 *   A. Current Device Awareness   — detects requesting device/session (MYRAA_MOBILE, MYRAA_DESKTOP, MYRAA_BROWSER)
 *   B. Capability Awareness       — checks whether capability/app is supported on target device engine
 *   C. Target Awareness           — distinguishes explicit target cues from implicit/contextual requests
 *   D. Device Availability        — verifies whether target device is online before execution
 *   E. "No Desktop Connected"     — deterministic handling when desktop/companion is offline or unreachable
 *   F. No Silent Fallback         — strictly forbids silently switching to another device
 *   G. Smart Target Mode          — resolves every request to PHONE | DESKTOP | CURRENT_DEVICE | REMOTE_DESKTOP
 *
 * Core Invariants:
 *   • PHONE ≠ REMOTE DESKTOP
 *   • DESKTOP ≠ PHONE
 *   • ACCOUNT ≠ DEVICE
 *   • SAME ACCOUNT ≠ AUTOMATIC REMOTE CONNECTION
 *   • RemoteBridge remains INACTIVE unless explicitly connected by the user.
 *   • Preserves Phase 4 ActionContext, ExecutionContext, SecurityPolicyEngine pipeline, and 126 Gemini tools.
 */

import {
  deviceRegistry,
  androidCapabilityEngine,
  desktopCapabilityEngine,
  remoteBridge,
  BRIDGE_ACTIVATION_PHRASES,
  BRIDGE_DEACTIVATION_PHRASES,
  type ProductType,
  type CapabilityScope,
  type BridgeState,
} from "../device/index.ts";
import { remoteSessionManager } from "../remote/RemoteSessionManager.ts";
import { actionContextManager } from "./ActionContext.ts";
import {
  capabilityRegistry,
  DESKTOP_NATIVE_APPS,
  MOBILE_SUPPORTED_APPS,
} from "./CapabilityRegistry.ts";
import { intentResolver } from "./IntentResolver.ts";
import { actionVerifier } from "./ActionVerifier.ts";
import type { SecurityContext } from "../security/SecurityTypes.ts";
import type {
  ActionVerificationResult,
  CanonicalIntent,
  ExecutionContext,
  SmartTargetMode,
  TargetDevice,
} from "./OrchestratorTypes.ts";
import type {
  OrchestratedActionOutcome,
  OrchestratorExecutors,
} from "./IntentCapabilityOrchestrator.ts";

// ---------------------------------------------------------------------------
// Desktop-only vs Mobile-only Application Sets
// ---------------------------------------------------------------------------

export const DESKTOP_ONLY_APPS: ReadonlySet<string> = new Set([
  "vscode",
  "cursor",
  "explorer",
  "edge",
  "brave",
  "firefox",
  "notepad",
  "terminal",
  "cmd",
  "powershell",
  "task manager",
  "paint",
  "snipping tool",
  "word",
  "excel",
  "powerpoint",
]);

export const MOBILE_ONLY_APPS: ReadonlySet<string> = new Set([
  "camera",
  "gallery",
  "contacts",
  "messages",
  "clock",
  "alarm",
  "telegram",
  "instagram",
  "facebook",
]);

export const SHARED_CROSS_DEVICE_APPS: ReadonlySet<string> = new Set([
  "youtube",
  "chrome",
  "spotify",
  "whatsapp",
  "gmail",
  "maps",
  "calendar",
  "settings",
  "calculator",
  "photos",
  "drive",
  "meet",
  "keep",
  "notes",
]);

// ---------------------------------------------------------------------------
// Phase 5 Types
// ---------------------------------------------------------------------------

export interface CurrentDeviceProfile {
  deviceId: string;
  deviceName: string;
  accountId: string | null;
  productType: ProductType;
  deviceClass: "PHONE" | "DESKTOP" | "BROWSER";
  isLocal: boolean;
  online: boolean;
  bridgeState: BridgeState;
  bridgeActive: boolean;
  bridgeTargetDeviceId: string | null;
}

export interface CapabilitySupportEvaluation {
  supported: boolean;
  capability: string;
  engineCapability: string;
  appName: string | null;
  targetDevice: "PHONE" | "DESKTOP" | "BROWSER" | "REMOTE_DESKTOP";
  targetProductType: ProductType;
  scope: CapabilityScope;
  requiredProductType?: ProductType;
  bridgeRequired: boolean;
  errorCode?: "CAPABILITY_NOT_SUPPORTED" | "UNRECOGNIZED_APPLICATION";
  reason?: string;
}

export interface DeviceAvailabilityStatus {
  available: boolean;
  targetDevice: TargetDevice;
  effectiveDevice: "PHONE" | "DESKTOP" | "BROWSER" | "REMOTE_DESKTOP";
  noDesktopConnected: boolean;
  noPhoneConnected: boolean;
  errorCode?: "TARGET_DEVICE_UNAVAILABLE";
  reason?: string;
}

export interface SmartTargetResolution {
  /** Phase 5 canonical target mode: PHONE | DESKTOP | CURRENT_DEVICE | REMOTE_DESKTOP */
  targetMode: SmartTargetMode;
  /** Concrete physical/logical target device for execution */
  effectiveTargetDevice: "PHONE" | "DESKTOP" | "BROWSER" | "REMOTE_DESKTOP";
  /** True when the user explicitly specified the target device ("Phone mein...", "Laptop par...", "Desktop par...") */
  isExplicitTarget: boolean;
  /** Current requesting device profile */
  currentDevice: CurrentDeviceProfile;
  /** Canonical intent resolved from utterance or tool call */
  intent: CanonicalIntent;
  /** Capability support evaluation on the target device */
  capabilitySupport: CapabilitySupportEvaluation;
  /** Target device online/connectivity status */
  availability: DeviceAvailabilityStatus;
  /** True when execution can proceed on the resolved target device */
  canExecute: boolean;
  /** True when desktop is required or targeted but not connected/online */
  noDesktopConnected: boolean;
  /** True when cross-device execution would require activating RemoteBridge */
  bridgeRequired: boolean;
  /** Deterministic failure code when canExecute is false */
  errorCode?:
    | "TARGET_DEVICE_UNAVAILABLE"
    | "CAPABILITY_NOT_SUPPORTED"
    | "BRIDGE_INACTIVE"
    | "UNRECOGNIZED_APPLICATION";
  /** Human-readable deterministic explanation */
  reason?: string;
}

export interface SessionDeviceHint {
  deviceId?: string;
  productType?: ProductType;
  userAgent?: string;
  accountId?: string;
}

// ---------------------------------------------------------------------------
// DeviceAwareIntelligence Class
// ---------------------------------------------------------------------------

export class DeviceAwareIntelligence {
  private _currentDeviceOverride: Partial<CurrentDeviceProfile> | null = null;

  /**
   * Ensure both capability engines are registered in DeviceRegistry
   * (even after deviceRegistry.resetForTesting() is called in tests).
   */
  private _ensureEnginesRegistered(): void {
    if (!deviceRegistry.getEngine("MYRAA_MOBILE")) {
      deviceRegistry.registerEngine(androidCapabilityEngine);
    }
    if (!deviceRegistry.getEngine("MYRAA_DESKTOP")) {
      deviceRegistry.registerEngine(desktopCapabilityEngine);
    }
  }

  /**
   * Configure an optional test/session override for the current requesting device.
   */
  setCurrentDeviceOverride(override: Partial<CurrentDeviceProfile> | null): void {
    this._currentDeviceOverride = override ? { ...override } : null;
  }

  resetForTesting(): void {
    this._currentDeviceOverride = null;
    this._ensureEnginesRegistered();
  }

  // =========================================================================
  // A. CURRENT DEVICE AWARENESS
  // =========================================================================

  /**
   * Detect the current requesting device/session from SecurityContext, DeviceRegistry,
   * active RemoteSessionManager sessions, or explicit session hints.
   *
   * Enforces:
   *   • Same accountId across multiple devices NEVER auto-activates RemoteBridge.
   *   • RemoteBridge is only active if explicitly activated in DeviceRegistry.
   */
  detectCurrentDevice(
    secContext?: SecurityContext,
    sessionHint?: SessionDeviceHint,
  ): CurrentDeviceProfile {
    this._ensureEnginesRegistered();

    const deviceId =
      this._currentDeviceOverride?.deviceId ||
      sessionHint?.deviceId ||
      secContext?.deviceId ||
      (secContext?.isLocal === false ? "mobile_session" : "desktop_local");

    // 1. Check DeviceRegistry for registered DeviceIdentity
    const registered = deviceRegistry.getDevice(deviceId);

    // 2. Determine ProductType
    let productType: ProductType = "MYRAA_DESKTOP";
    let accountId: string | null = sessionHint?.accountId ?? registered?.accountId ?? secContext?.identityId ?? null;
    let deviceName = registered?.deviceName || deviceId;

    if (this._currentDeviceOverride?.productType) {
      productType = this._currentDeviceOverride.productType;
    } else if (sessionHint?.productType) {
      productType = sessionHint.productType;
    } else if (registered?.productType) {
      productType = registered.productType;
    } else if (sessionHint?.userAgent) {
      productType = deviceRegistry.inferProductType({
        deviceType: "unknown",
        userAgent: sessionHint.userAgent,
      });
    } else {
      const idLower = deviceId.toLowerCase();
      if (
        idLower.includes("mobile") ||
        idLower.includes("phone") ||
        idLower.includes("android") ||
        idLower.includes("iphone") ||
        idLower.includes("ios")
      ) {
        productType = "MYRAA_MOBILE";
      } else if (idLower.includes("browser") || idLower.includes("web")) {
        productType = "MYRAA_BROWSER";
      } else if (secContext && !secContext.isLocal) {
        // Check active remote sessions for user agent
        const activeSession = remoteSessionManager
          .getActiveSessions()
          .find((s) => s.deviceId === deviceId);
        if (activeSession) {
          productType = deviceRegistry.inferProductType({
            deviceType: "mobile",
            userAgent: activeSession.userAgent,
          });
        } else {
          productType = "MYRAA_MOBILE";
        }
      } else {
        productType = "MYRAA_DESKTOP";
      }
    }

    const deviceClass: "PHONE" | "DESKTOP" | "BROWSER" =
      this._currentDeviceOverride?.deviceClass ??
      (productType === "MYRAA_MOBILE"
        ? "PHONE"
        : productType === "MYRAA_BROWSER"
        ? "BROWSER"
        : "DESKTOP");

    // 3. Check RemoteBridge status (INACTIVE by default — never auto-enabled by same account!)
    const bridgeStatus = remoteBridge.getStatus(deviceId);
    const bridgeActive =
      this._currentDeviceOverride?.bridgeActive ??
      (bridgeStatus.state === "ACTIVE" && Boolean(bridgeStatus.targetDeviceId));

    // 4. Check online state of current device
    const overrides = capabilityRegistry.getDeviceAvailabilityOverrides();
    let online = true;
    if (deviceClass === "DESKTOP" && overrides.desktopAvailable === false) {
      online = false;
    } else if (deviceClass === "PHONE" && overrides.phoneAvailable === false) {
      online = false;
    } else if (deviceClass === "BROWSER" && overrides.browserAvailable === false) {
      online = false;
    }
    if (this._currentDeviceOverride?.online !== undefined) {
      online = this._currentDeviceOverride.online;
    }

    return {
      deviceId,
      deviceName,
      accountId,
      productType,
      deviceClass,
      isLocal: this._currentDeviceOverride?.isLocal ?? (secContext?.isLocal ?? (deviceClass === "DESKTOP")),
      online,
      bridgeState: bridgeActive ? "ACTIVE" : bridgeStatus.state,
      bridgeActive,
      bridgeTargetDeviceId: bridgeActive ? bridgeStatus.targetDeviceId : null,
    };
  }

  // =========================================================================
  // B. CAPABILITY AWARENESS
  // =========================================================================

  /**
   * Check whether a capability (and optional application entity) is supported
   * on the specified target device.
   */
  checkCapabilitySupport(params: {
    capability: string;
    intentType?: string;
    appName?: string | null;
    targetDevice: "PHONE" | "DESKTOP" | "BROWSER" | "REMOTE_DESKTOP";
    targetDeviceId?: string;
  }): CapabilitySupportEvaluation {
    this._ensureEnginesRegistered();

    const { capability, intentType, appName, targetDevice, targetDeviceId } = params;
    const targetProductType: ProductType =
      targetDevice === "PHONE"
        ? "MYRAA_MOBILE"
        : targetDevice === "BROWSER"
        ? "MYRAA_BROWSER"
        : "MYRAA_DESKTOP";

    // Check per-device disabledCapabilities if targetDeviceId is registered
    if (targetDeviceId) {
      const devIdentity = deviceRegistry.getDevice(targetDeviceId);
      if (devIdentity?.disabledCapabilities?.includes(capability)) {
        return {
          supported: false,
          capability,
          engineCapability: capability,
          appName: appName || null,
          targetDevice,
          targetProductType,
          scope: deviceRegistry.getScopeFor(capability) || "desktop-local",
          bridgeRequired: false,
          errorCode: "CAPABILITY_NOT_SUPPORTED",
          reason: `CAPABILITY_NOT_SUPPORTED: Capability '${capability}' is disabled on device '${targetDeviceId}'.`,
        };
      }
    }

    // 1. Application Open Capability Awareness
    if (
      intentType === "OPEN_APPLICATION" ||
      capability === "desktop.openApplication" ||
      capability === "mobile.openApp"
    ) {
      const rawApp = (appName || "").trim();
      if (rawApp) {
        const aliasRes = capabilityRegistry.resolveApplicationAlias(rawApp);
        if (!aliasRes.resolved || !aliasRes.canonicalApp) {
          return {
            supported: false,
            capability,
            engineCapability: targetDevice === "PHONE" ? "mobile.openApp" : "desktop.openApplication",
            appName: rawApp,
            targetDevice,
            targetProductType,
            scope: targetDevice === "PHONE" ? "mobile-local" : "desktop-local",
            bridgeRequired: false,
            errorCode: "UNRECOGNIZED_APPLICATION",
            reason: aliasRes.reason || `UNRECOGNIZED_APPLICATION: '${rawApp}' is not recognized.`,
          };
        }

        const canonicalApp = aliasRes.canonicalApp;

        // Shared cross-device apps (YouTube, Chrome, WhatsApp, Spotify, Gmail, Maps, etc.)
        if (SHARED_CROSS_DEVICE_APPS.has(canonicalApp) || aliasRes.isWebsiteApp) {
          const engineCap = targetDevice === "PHONE" ? "mobile.openApp" : "desktop.openApplication";
          return {
            supported: true,
            capability,
            engineCapability: engineCap,
            appName: canonicalApp,
            targetDevice,
            targetProductType,
            scope: "shared-cloud",
            bridgeRequired: false,
          };
        }

        // Desktop-only apps (VS Code, Cursor, File Explorer, PowerShell, etc.)
        if (DESKTOP_ONLY_APPS.has(canonicalApp)) {
          if (targetDevice === "PHONE") {
            return {
              supported: false,
              capability,
              engineCapability: "desktop.openApplication",
              appName: canonicalApp,
              targetDevice: "PHONE",
              targetProductType: "MYRAA_MOBILE",
              scope: "desktop-local",
              requiredProductType: "MYRAA_DESKTOP",
              bridgeRequired: true,
              errorCode: "CAPABILITY_NOT_SUPPORTED",
              reason: `CAPABILITY_NOT_SUPPORTED: Application '${canonicalApp}' is a desktop-only application and cannot run natively on PHONE (MYRAA_MOBILE).`,
            };
          }
          return {
            supported: true,
            capability,
            engineCapability: "desktop.openApplication",
            appName: canonicalApp,
            targetDevice,
            targetProductType: "MYRAA_DESKTOP",
            scope: "desktop-local",
            bridgeRequired: false,
          };
        }

        // Mobile-only apps (Camera, Contacts, Messages, Clock/Alarm, Instagram, etc.)
        if (MOBILE_ONLY_APPS.has(canonicalApp) || MOBILE_SUPPORTED_APPS.has(canonicalApp)) {
          if (
            (targetDevice === "DESKTOP" || targetDevice === "REMOTE_DESKTOP") &&
            !DESKTOP_NATIVE_APPS.has(canonicalApp)
          ) {
            return {
              supported: false,
              capability,
              engineCapability: "mobile.openApp",
              appName: canonicalApp,
              targetDevice,
              targetProductType: "MYRAA_DESKTOP",
              scope: "mobile-local",
              requiredProductType: "MYRAA_MOBILE",
              bridgeRequired: true,
              errorCode: "CAPABILITY_NOT_SUPPORTED",
              reason: `CAPABILITY_NOT_SUPPORTED: Application '${canonicalApp}' is a mobile-only application and is not supported on DESKTOP.`,
            };
          }
          return {
            supported: true,
            capability,
            engineCapability: targetDevice === "PHONE" ? "mobile.openApp" : "desktop.openApplication",
            appName: canonicalApp,
            targetDevice,
            targetProductType,
            scope: targetDevice === "PHONE" ? "mobile-local" : "desktop-local",
            bridgeRequired: false,
          };
        }
      }
    }

    // 2. Non-application capabilities — check scope & engine support
    const normalizedCap =
      capability === "code.inspect"
        ? "desktop.codeInspect"
        : capability === "code.research"
        ? "web.research"
        : capability === "phone.interactApp"
        ? "mobile.openApp"
        : capability;

    const scope = deviceRegistry.getScopeFor(normalizedCap) || "shared-cloud";

    if (scope === "shared-cloud") {
      return {
        supported: true,
        capability,
        engineCapability: normalizedCap,
        appName: appName || null,
        targetDevice,
        targetProductType,
        scope: "shared-cloud",
        bridgeRequired: false,
      };
    }

    if (scope === "desktop-local") {
      const supported =
        targetDevice === "DESKTOP" ||
        targetDevice === "REMOTE_DESKTOP" ||
        desktopCapabilityEngine.canExecute(normalizedCap);
      const isOnDesktop = targetDevice === "DESKTOP" || targetDevice === "REMOTE_DESKTOP";
      if (!isOnDesktop || !supported) {
        return {
          supported: false,
          capability,
          engineCapability: normalizedCap,
          appName: appName || null,
          targetDevice,
          targetProductType,
          scope: "desktop-local",
          requiredProductType: "MYRAA_DESKTOP",
          bridgeRequired: true,
          errorCode: "CAPABILITY_NOT_SUPPORTED",
          reason: `CAPABILITY_NOT_SUPPORTED: Capability '${capability}' requires MYRAA_DESKTOP and is not supported on ${targetDevice}.`,
        };
      }
      return {
        supported: true,
        capability,
        engineCapability: normalizedCap,
        appName: appName || null,
        targetDevice,
        targetProductType: "MYRAA_DESKTOP",
        scope: "desktop-local",
        bridgeRequired: false,
      };
    }

    if (scope === "mobile-local") {
      const isOnPhone = targetDevice === "PHONE";
      const supported = isOnPhone && androidCapabilityEngine.canExecute(normalizedCap);
      if (!supported) {
        return {
          supported: false,
          capability,
          engineCapability: normalizedCap,
          appName: appName || null,
          targetDevice,
          targetProductType,
          scope: "mobile-local",
          requiredProductType: "MYRAA_MOBILE",
          bridgeRequired: true,
          errorCode: "CAPABILITY_NOT_SUPPORTED",
          reason: `CAPABILITY_NOT_SUPPORTED: Capability '${capability}' requires MYRAA_MOBILE (PHONE) and is not supported on ${targetDevice}.`,
        };
      }
      return {
        supported: true,
        capability,
        engineCapability: normalizedCap,
        appName: appName || null,
        targetDevice: "PHONE",
        targetProductType: "MYRAA_MOBILE",
        scope: "mobile-local",
        bridgeRequired: false,
      };
    }

    return {
      supported: true,
      capability,
      engineCapability: normalizedCap,
      appName: appName || null,
      targetDevice,
      targetProductType,
      scope,
      bridgeRequired: false,
    };
  }

  // =========================================================================
  // D. DEVICE AVAILABILITY & E. "NO DESKTOP CONNECTED" HANDLING
  // =========================================================================

  /**
   * Check whether a target device is online and reachable.
   * Specifically identifies "No Desktop Connected" scenarios when DESKTOP or
   * REMOTE_DESKTOP is targeted while offline/disconnected.
   */
  checkDeviceAvailability(
    targetDevice: TargetDevice,
    currentDevice: CurrentDeviceProfile,
    secContext: SecurityContext,
  ): DeviceAvailabilityStatus {
    const effectiveDevice: "PHONE" | "DESKTOP" | "BROWSER" | "REMOTE_DESKTOP" =
      targetDevice === "CURRENT_DEVICE" ? currentDevice.deviceClass : targetDevice;

    const overrides = capabilityRegistry.getDeviceAvailabilityOverrides();

    // 1. Check explicit overrides first
    if (effectiveDevice === "DESKTOP") {
      if (overrides.desktopAvailable === false) {
        return {
          available: false,
          targetDevice,
          effectiveDevice: "DESKTOP",
          noDesktopConnected: true,
          noPhoneConnected: false,
          errorCode: "TARGET_DEVICE_UNAVAILABLE",
          reason:
            "TARGET_DEVICE_UNAVAILABLE: No Desktop Connected — Target device 'DESKTOP' is currently offline or unreachable.",
        };
      }
      if (overrides.desktopAvailable === true) {
        return {
          available: true,
          targetDevice,
          effectiveDevice: "DESKTOP",
          noDesktopConnected: false,
          noPhoneConnected: false,
        };
      }
    }

    if (effectiveDevice === "REMOTE_DESKTOP") {
      if (overrides.remoteDesktopAvailable === false || overrides.desktopAvailable === false) {
        return {
          available: false,
          targetDevice,
          effectiveDevice: "REMOTE_DESKTOP",
          noDesktopConnected: true,
          noPhoneConnected: false,
          errorCode: "TARGET_DEVICE_UNAVAILABLE",
          reason:
            "TARGET_DEVICE_UNAVAILABLE: No Desktop Connected — Remote desktop companion is offline or not connected.",
        };
      }
      if (overrides.remoteDesktopAvailable === true || overrides.desktopAvailable === true) {
        return {
          available: true,
          targetDevice,
          effectiveDevice: "REMOTE_DESKTOP",
          noDesktopConnected: false,
          noPhoneConnected: false,
        };
      }
    }

    if (effectiveDevice === "PHONE") {
      if (overrides.phoneAvailable === false) {
        return {
          available: false,
          targetDevice,
          effectiveDevice: "PHONE",
          noDesktopConnected: false,
          noPhoneConnected: true,
          errorCode: "TARGET_DEVICE_UNAVAILABLE",
          reason:
            "TARGET_DEVICE_UNAVAILABLE: Target device 'PHONE' (MYRAA Mobile) is currently offline or not connected.",
        };
      }
      if (overrides.phoneAvailable === true) {
        return {
          available: true,
          targetDevice,
          effectiveDevice: "PHONE",
          noDesktopConnected: false,
          noPhoneConnected: false,
        };
      }
    }

    // 2. If requesting from PHONE and targeting DESKTOP / REMOTE_DESKTOP without overrides:
    //    Check if a desktop companion is actually connected or registered as online
    if (
      currentDevice.deviceClass === "PHONE" &&
      (effectiveDevice === "DESKTOP" || effectiveDevice === "REMOTE_DESKTOP")
    ) {
      const desktopCompanion = remoteSessionManager.getActiveDesktopCompanion();
      const registeredDesktop = deviceRegistry
        .listDevices()
        .find((d) => d.productType === "MYRAA_DESKTOP" && d.registered);

      if (!desktopCompanion && !registeredDesktop && !secContext.isLocal) {
        return {
          available: false,
          targetDevice,
          effectiveDevice,
          noDesktopConnected: true,
          noPhoneConnected: false,
          errorCode: "TARGET_DEVICE_UNAVAILABLE",
          reason:
            "TARGET_DEVICE_UNAVAILABLE: No Desktop Connected — MYRAA Desktop is not connected.",
        };
      }
    }

    // 3. Delegate to CapabilityRegistry's runtime check
    const baseCheck = capabilityRegistry.verifyTargetDeviceAvailability(effectiveDevice, secContext);
    if (!baseCheck.available) {
      const isDesktopTarget =
        effectiveDevice === "DESKTOP" || effectiveDevice === "REMOTE_DESKTOP";
      return {
        available: false,
        targetDevice,
        effectiveDevice,
        noDesktopConnected: isDesktopTarget,
        noPhoneConnected: effectiveDevice === "PHONE",
        errorCode: "TARGET_DEVICE_UNAVAILABLE",
        reason: isDesktopTarget
          ? `TARGET_DEVICE_UNAVAILABLE: No Desktop Connected — ${baseCheck.reason}`
          : baseCheck.reason,
      };
    }

    return {
      available: true,
      targetDevice,
      effectiveDevice,
      noDesktopConnected: false,
      noPhoneConnected: false,
    };
  }

  // =========================================================================
  // C. TARGET AWARENESS, F. NO SILENT FALLBACK & G. SMART TARGET MODE
  // =========================================================================

  /**
   * Resolve any utterance into the canonical Phase 5 Smart Target Model:
   *   targetMode: "PHONE" | "DESKTOP" | "CURRENT_DEVICE" | "REMOTE_DESKTOP"
   *
   * Examples:
   *   • "Phone mein WhatsApp kholo" → targetMode: "PHONE"
   *   • "Laptop par VS Code kholo"  → targetMode: "DESKTOP"
   *   • "YouTube kholo"             → targetMode: "CURRENT_DEVICE"
   *   • "Desktop par VS Code kholo" + desktop offline → TARGET_DEVICE_UNAVAILABLE
   *   • "VS Code kholo"             → resolves using CURRENT_DEVICE & capability availability;
   *                                   NEVER silently switches devices!
   */
  resolveSmartTarget(
    utterance: string,
    secContext: SecurityContext = {
      identityId: "local_operator",
      role: "admin",
      ipAddress: "127.0.0.1",
      deviceId: "desktop_local",
      isLocal: true,
    },
    contextId = "default",
    explicitArgDevice?: string,
    sessionHint?: SessionDeviceHint,
  ): SmartTargetResolution {
    this._ensureEnginesRegistered();

    // Step 1: Detect Current Device (A)
    const currentDevice = this.detectCurrentDevice(secContext, sessionHint);

    // Step 2: Parse Canonical Intent from Utterance (Phase 4 IntentResolver)
    const intent = intentResolver.resolveFromUtterance(utterance, contextId, secContext);

    // Step 3: Detect whether the user explicitly named a target device (C)
    const explicitCue = intentResolver.detectExplicitTargetCue(utterance, explicitArgDevice);
    const isExplicitTarget =
      explicitCue === "PHONE" ||
      explicitCue === "DESKTOP" ||
      explicitCue === "REMOTE_DESKTOP";

    // Step 4: Determine SmartTargetMode (G)
    //   - If user explicitly specified PHONE, DESKTOP, or REMOTE_DESKTOP -> use that mode
    //   - Otherwise -> Smart Target Mode uses CURRENT_DEVICE!
    let targetMode: SmartTargetMode;
    let effectiveTargetDevice: "PHONE" | "DESKTOP" | "BROWSER" | "REMOTE_DESKTOP";

    if (explicitCue === "PHONE") {
      targetMode = "PHONE";
      effectiveTargetDevice = "PHONE";
    } else if (explicitCue === "REMOTE_DESKTOP") {
      targetMode = "REMOTE_DESKTOP";
      effectiveTargetDevice = "REMOTE_DESKTOP";
    } else if (explicitCue === "DESKTOP") {
      targetMode = "DESKTOP";
      effectiveTargetDevice = "DESKTOP";
    } else {
      // No explicit physical device cue ("YouTube kholo", "VS Code kholo", "Play karo", etc.)
      // Smart Target Mode resolves against CURRENT_DEVICE!
      targetMode = "CURRENT_DEVICE";
      effectiveTargetDevice = currentDevice.deviceClass;
    }

    const appName =
      intent.intent === "OPEN_APPLICATION" || intent.intent === "OPEN_FOLDER"
        ? String(intent.arguments.name || intent.entity || "")
        : null;

    // Step 5: Check Capability Support on effectiveTargetDevice (B)
    const capabilitySupport = this.checkCapabilitySupport({
      capability: intent.capability,
      intentType: intent.intent,
      appName,
      targetDevice: effectiveTargetDevice,
      targetDeviceId: currentDevice.deviceId,
    });

    // Step 6: Check Device Availability on effectiveTargetDevice (D & E)
    const availability = this.checkDeviceAvailability(
      effectiveTargetDevice,
      currentDevice,
      secContext,
    );

    // Also check if desktop is offline when a desktop capability is requested
    const desktopAvailCheck = this.checkDeviceAvailability("DESKTOP", currentDevice, secContext);

    // Step 7: Enforce No Silent Fallback (F) & Cross-Device Bridge Rules
    // Case 7a: Unrecognized application
    if (capabilitySupport.errorCode === "UNRECOGNIZED_APPLICATION") {
      return {
        targetMode,
        effectiveTargetDevice,
        isExplicitTarget,
        currentDevice,
        intent,
        capabilitySupport,
        availability,
        canExecute: false,
        noDesktopConnected: false,
        bridgeRequired: false,
        errorCode: "UNRECOGNIZED_APPLICATION",
        reason: capabilitySupport.reason,
      };
    }

    // Case 7b: Explicit target device is offline/unavailable (e.g. "Desktop par VS Code kholo" + desktop offline)
    if (!availability.available) {
      return {
        targetMode,
        effectiveTargetDevice,
        isExplicitTarget,
        currentDevice,
        intent: { ...intent, targetDevice: effectiveTargetDevice },
        capabilitySupport,
        availability,
        canExecute: false,
        noDesktopConnected: availability.noDesktopConnected,
        bridgeRequired: false,
        errorCode: "TARGET_DEVICE_UNAVAILABLE",
        reason: availability.reason,
      };
    }

    // Case 7c: Implicit target (CURRENT_DEVICE), but capability is NOT supported on CURRENT_DEVICE
    //   e.g. User is on PHONE and says "VS Code kholo" (which requires DESKTOP).
    //   RULE (F & G): NEVER silently switch to DESKTOP!
    if (!capabilitySupport.supported) {
      const needsDesktop = capabilitySupport.requiredProductType === "MYRAA_DESKTOP";
      const noDesktop = needsDesktop && !desktopAvailCheck.available;

      // If user is on PHONE and asked for "VS Code kholo" while Desktop is offline,
      // report both that capability is unsupported on PHONE and whether Desktop is connected.
      const reason = noDesktop
        ? `CAPABILITY_NOT_SUPPORTED: '${appName || intent.capability}' is not supported on ${currentDevice.deviceClass} (${currentDevice.productType}), and no Desktop is currently connected. Never silently switching devices.`
        : `${capabilitySupport.reason} ${remoteBridge.buildBridgeRequiredMessage(
            intent.capability,
            capabilitySupport.requiredProductType || "MYRAA_DESKTOP",
            currentDevice.productType,
          )}`;

      return {
        targetMode,
        effectiveTargetDevice,
        isExplicitTarget,
        currentDevice,
        intent: { ...intent, targetDevice: effectiveTargetDevice },
        capabilitySupport,
        availability,
        canExecute: false,
        noDesktopConnected: noDesktop,
        bridgeRequired: true,
        errorCode: "CAPABILITY_NOT_SUPPORTED",
        reason,
      };
    }

    // Case 7d: Cross-device explicit target (e.g. user is on PHONE and says "Laptop par VS Code kholo"
    //   or user is on DESKTOP and says "Phone mein WhatsApp kholo"):
    //   If requesting device is registered in DeviceRegistry with a different deviceClass than effectiveTargetDevice,
    //   check if RemoteBridge is required & active when strict cross-device isolation is enabled.
    const isCrossDeviceExplicit =
      isExplicitTarget &&
      ((currentDevice.deviceClass === "PHONE" &&
        (effectiveTargetDevice === "DESKTOP" || effectiveTargetDevice === "REMOTE_DESKTOP")) ||
        (currentDevice.deviceClass === "DESKTOP" && effectiveTargetDevice === "PHONE"));

    const sourceRegisteredInRegistry = Boolean(deviceRegistry.getDevice(currentDevice.deviceId));
    if (
      isCrossDeviceExplicit &&
      sourceRegisteredInRegistry &&
      !currentDevice.bridgeActive &&
      effectiveTargetDevice === "REMOTE_DESKTOP"
    ) {
      return {
        targetMode,
        effectiveTargetDevice,
        isExplicitTarget,
        currentDevice,
        intent: { ...intent, targetDevice: effectiveTargetDevice },
        capabilitySupport,
        availability,
        canExecute: false,
        noDesktopConnected: false,
        bridgeRequired: true,
        errorCode: "BRIDGE_INACTIVE",
        reason:
          "BRIDGE_INACTIVE: RemoteBridge is INACTIVE. Cross-device execution requires explicit RemoteBridge activation.",
      };
    }

    // Step 8: Target is available and capability is supported!
    // Preserve BROWSER targetDevice on intent when intent is media/website so existing verifiers match
    const finalIntentTarget: TargetDevice =
      targetMode === "CURRENT_DEVICE" &&
      (intent.targetDevice === "BROWSER" ||
        intent.intent === "SEARCH_MEDIA" ||
        intent.intent === "PLAY_MEDIA" ||
        intent.intent === "PAUSE_MEDIA" ||
        intent.intent === "RESUME_MEDIA" ||
        intent.intent === "STOP_MEDIA" ||
        intent.intent === "NEXT_MEDIA" ||
        intent.intent === "PREVIOUS_MEDIA" ||
        intent.intent === "OPEN_WEBSITE")
        ? "BROWSER"
        : effectiveTargetDevice;

    return {
      targetMode,
      effectiveTargetDevice,
      isExplicitTarget,
      currentDevice,
      intent: {
        ...intent,
        targetDevice: finalIntentTarget,
      },
      capabilitySupport,
      availability,
      canExecute: true,
      noDesktopConnected: false,
      bridgeRequired: false,
    };
  }

  /**
   * Detect if an utterance is an explicit RemoteBridge activation/deactivation command.
   */
  detectBridgeCommand(utterance: string): "ACTIVATE" | "DEACTIVATE" | null {
    const clean = (utterance || "").trim().toLowerCase().replace(/\s+/g, " ");
    for (const phrase of BRIDGE_ACTIVATION_PHRASES) {
      if (clean.includes(phrase)) return "ACTIVATE";
    }
    for (const phrase of BRIDGE_DEACTIVATION_PHRASES) {
      if (clean.includes(phrase)) return "DEACTIVATE";
    }
    return null;
  }
}

export const deviceAwareIntelligence = new DeviceAwareIntelligence();
