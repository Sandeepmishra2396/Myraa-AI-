/**
 * MYRAA — Phase 5: Device-Aware Intelligence Test Suite
 *
 * Covers all Phase 5 scope requirements (A–G):
 *   A. Current Device Awareness
 *   B. Capability Awareness
 *   C. Target Awareness
 *   D. Device Availability
 *   E. "No Desktop Connected" handling
 *   F. No Silent Fallback
 *   G. Smart Target Mode (PHONE | DESKTOP | CURRENT_DEVICE | REMOTE_DESKTOP)
 *
 * Also verifies:
 *   • Exact user examples:
 *       - "Phone mein WhatsApp kholo" → PHONE
 *       - "Laptop par VS Code kholo" → DESKTOP
 *       - "YouTube kholo" → CURRENT_DEVICE
 *       - "Desktop par VS Code kholo" + desktop offline → TARGET_DEVICE_UNAVAILABLE
 *       - "VS Code kholo" → resolve using CURRENT_DEVICE/capability availability; never silently switch devices
 *   • Same account/login NEVER auto-activates RemoteBridge
 *   • RemoteBridge remains INACTIVE unless explicitly connected by the user
 *   • Phase 4 ActionContext, ExecutionContext, security pipeline, and 126 Gemini tools preserved
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  actionContextManager,
  capabilityRegistry,
  intentResolver,
  intentCapabilityOrchestrator,
  deviceAwareIntelligence,
} from "../index.ts";
import {
  deviceRegistry,
  androidCapabilityEngine,
  desktopCapabilityEngine,
  remoteBridge,
  type DeviceIdentity,
} from "../../device/index.ts";
import {
  securityPolicyEngine,
  securityAuditLogger,
  type SecurityContext,
} from "../../security/index.ts";
import { emergencyStopCoordinator } from "../../remote/EmergencyStopCoordinator.ts";
import { LIVE_TOOLS } from "../../ai/GeminiSessionFactory.ts";

// ---------------------------------------------------------------------------
// Test Fixtures
// ---------------------------------------------------------------------------

const DESKTOP_SEC_CTX: SecurityContext = {
  identityId: "account-sandeep",
  role: "admin",
  ipAddress: "127.0.0.1",
  deviceId: "sandeep-desktop-pc",
  isLocal: true,
};

const PHONE_SEC_CTX: SecurityContext = {
  identityId: "account-sandeep",
  role: "admin",
  ipAddress: "192.168.1.42",
  deviceId: "sandeep-android-phone",
  isLocal: false,
};

const DESKTOP_IDENTITY: DeviceIdentity = {
  deviceId: "sandeep-desktop-pc",
  deviceName: "Sandeep's Windows PC",
  productType: "MYRAA_DESKTOP",
  accountId: "account-sandeep",
  registered: true,
  registeredAt: "2026-01-01T00:00:00.000Z",
  lastSeenAt: "2026-09-26T12:00:00.000Z",
  bridgeConnected: false,
  bridgeTargetDeviceId: null,
  disabledCapabilities: [],
};

const PHONE_IDENTITY: DeviceIdentity = {
  deviceId: "sandeep-android-phone",
  deviceName: "Sandeep's Android Phone",
  productType: "MYRAA_MOBILE",
  accountId: "account-sandeep",
  registered: true,
  registeredAt: "2026-01-01T00:00:00.000Z",
  lastSeenAt: "2026-09-26T12:00:00.000Z",
  bridgeConnected: false,
  bridgeTargetDeviceId: null,
  disabledCapabilities: [],
};

describe("Phase 5 — Device-Aware Intelligence", () => {
  const SID = "phase5-session";

  beforeEach(async () => {
    deviceRegistry.resetForTesting();
    deviceRegistry.registerEngine(androidCapabilityEngine);
    deviceRegistry.registerEngine(desktopCapabilityEngine);
    intentCapabilityOrchestrator.resetForTesting();
    actionContextManager.resetForTesting();
    capabilityRegistry.resetForTesting();
    deviceAwareIntelligence.resetForTesting();
    securityPolicyEngine.resetForTesting();
    securityAuditLogger.clearForTesting();
    if (emergencyStopCoordinator.isActive()) {
      await emergencyStopCoordinator.reset("account-sandeep");
    }
  });

  afterEach(async () => {
    deviceRegistry.resetForTesting();
    deviceRegistry.registerEngine(androidCapabilityEngine);
    deviceRegistry.registerEngine(desktopCapabilityEngine);
    capabilityRegistry.resetForTesting();
    deviceAwareIntelligence.resetForTesting();
    securityPolicyEngine.resetForTesting();
    if (emergencyStopCoordinator.isActive()) {
      await emergencyStopCoordinator.reset("account-sandeep");
    }
  });

  // ===========================================================================
  // A. CURRENT DEVICE AWARENESS
  // ===========================================================================
  describe("A. Current Device Awareness", () => {
    it("A.1 detects MYRAA_DESKTOP (DESKTOP) for local desktop session", () => {
      deviceRegistry.registerDevice(DESKTOP_IDENTITY);
      const profile = deviceAwareIntelligence.detectCurrentDevice(DESKTOP_SEC_CTX);
      expect(profile.deviceId).toBe("sandeep-desktop-pc");
      expect(profile.productType).toBe("MYRAA_DESKTOP");
      expect(profile.deviceClass).toBe("DESKTOP");
      expect(profile.isLocal).toBe(true);
      expect(profile.online).toBe(true);
      expect(profile.bridgeState).toBe("INACTIVE");
      expect(profile.bridgeActive).toBe(false);
    });

    it("A.2 detects MYRAA_MOBILE (PHONE) for registered Android phone session", () => {
      deviceRegistry.registerDevice(PHONE_IDENTITY);
      const profile = deviceAwareIntelligence.detectCurrentDevice(PHONE_SEC_CTX);
      expect(profile.deviceId).toBe("sandeep-android-phone");
      expect(profile.productType).toBe("MYRAA_MOBILE");
      expect(profile.deviceClass).toBe("PHONE");
      expect(profile.isLocal).toBe(false);
      expect(profile.bridgeState).toBe("INACTIVE");
      expect(profile.bridgeActive).toBe(false);
    });

    it("A.3 detects MYRAA_MOBILE from Android User-Agent session hint even if unregistered", () => {
      const profile = deviceAwareIntelligence.detectCurrentDevice(
        {
          identityId: "account-sandeep",
          role: "admin",
          ipAddress: "192.168.1.77",
          deviceId: "custom-session-99",
          isLocal: false,
        },
        { userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile" },
      );
      expect(profile.productType).toBe("MYRAA_MOBILE");
      expect(profile.deviceClass).toBe("PHONE");
    });

    it("A.4 detects MYRAA_BROWSER for web companion session", () => {
      const profile = deviceAwareIntelligence.detectCurrentDevice(
        {
          identityId: "account-sandeep",
          role: "admin",
          ipAddress: "127.0.0.1",
          deviceId: "web-browser-tab-1",
          isLocal: true,
        },
        { productType: "MYRAA_BROWSER" },
      );
      expect(profile.productType).toBe("MYRAA_BROWSER");
      expect(profile.deviceClass).toBe("BROWSER");
    });

    it("A.5 SAME ACCOUNT across Phone and Desktop NEVER auto-activates RemoteBridge", () => {
      // Both devices share accountId: "account-sandeep"
      deviceRegistry.registerDevice(DESKTOP_IDENTITY);
      deviceRegistry.registerDevice(PHONE_IDENTITY);

      const phoneProfile = deviceAwareIntelligence.detectCurrentDevice(PHONE_SEC_CTX);
      const desktopProfile = deviceAwareIntelligence.detectCurrentDevice(DESKTOP_SEC_CTX);

      expect(phoneProfile.accountId).toBe("account-sandeep");
      expect(desktopProfile.accountId).toBe("account-sandeep");
      expect(phoneProfile.bridgeActive).toBe(false);
      expect(phoneProfile.bridgeState).toBe("INACTIVE");
      expect(desktopProfile.bridgeActive).toBe(false);
      expect(desktopProfile.bridgeState).toBe("INACTIVE");
      expect(remoteBridge.isActive(PHONE_IDENTITY.deviceId)).toBe(false);
    });

    it("A.6 RemoteBridge is active ONLY when explicitly activated by user", async () => {
      deviceRegistry.registerDevice(DESKTOP_IDENTITY);
      deviceRegistry.registerDevice(PHONE_IDENTITY);

      expect(deviceAwareIntelligence.detectCurrentDevice(PHONE_SEC_CTX).bridgeActive).toBe(false);

      const actRes = await remoteBridge.activate(PHONE_IDENTITY.deviceId, DESKTOP_IDENTITY.deviceId);
      expect(actRes.success).toBe(true);

      const activeProfile = deviceAwareIntelligence.detectCurrentDevice(PHONE_SEC_CTX);
      expect(activeProfile.bridgeActive).toBe(true);
      expect(activeProfile.bridgeState).toBe("ACTIVE");
      expect(activeProfile.bridgeTargetDeviceId).toBe(DESKTOP_IDENTITY.deviceId);

      remoteBridge.deactivate(PHONE_IDENTITY.deviceId);
      expect(deviceAwareIntelligence.detectCurrentDevice(PHONE_SEC_CTX).bridgeActive).toBe(false);
    });
  });

  // ===========================================================================
  // B. CAPABILITY AWARENESS
  // ===========================================================================
  describe("B. Capability Awareness", () => {
    it("B.1 desktop-only apps (vscode, cursor, explorer, powershell) are supported on DESKTOP and NOT on PHONE", () => {
      for (const app of ["vscode", "cursor", "explorer", "powershell"]) {
        const onDesktop = deviceAwareIntelligence.checkCapabilitySupport({
          capability: "desktop.openApplication",
          intentType: "OPEN_APPLICATION",
          appName: app,
          targetDevice: "DESKTOP",
        });
        expect(onDesktop.supported).toBe(true);
        expect(onDesktop.bridgeRequired).toBe(false);

        const onPhone = deviceAwareIntelligence.checkCapabilitySupport({
          capability: "desktop.openApplication",
          intentType: "OPEN_APPLICATION",
          appName: app,
          targetDevice: "PHONE",
        });
        expect(onPhone.supported).toBe(false);
        expect(onPhone.errorCode).toBe("CAPABILITY_NOT_SUPPORTED");
        expect(onPhone.requiredProductType).toBe("MYRAA_DESKTOP");
        expect(onPhone.bridgeRequired).toBe(true);
      }
    });

    it("B.2 mobile-only capabilities (mobile.alarm, mobile.timer, mobile.reminder, camera) are supported on PHONE and NOT on DESKTOP", () => {
      for (const cap of ["mobile.alarm", "mobile.timer", "mobile.reminder"]) {
        const onPhone = deviceAwareIntelligence.checkCapabilitySupport({
          capability: cap,
          targetDevice: "PHONE",
        });
        expect(onPhone.supported).toBe(true);

        const onDesktop = deviceAwareIntelligence.checkCapabilitySupport({
          capability: cap,
          targetDevice: "DESKTOP",
        });
        expect(onDesktop.supported).toBe(false);
        expect(onDesktop.errorCode).toBe("CAPABILITY_NOT_SUPPORTED");
        expect(onDesktop.requiredProductType).toBe("MYRAA_MOBILE");
      }

      const cameraOnDesktop = deviceAwareIntelligence.checkCapabilitySupport({
        capability: "desktop.openApplication",
        intentType: "OPEN_APPLICATION",
        appName: "camera",
        targetDevice: "DESKTOP",
      });
      expect(cameraOnDesktop.supported).toBe(false);
      expect(cameraOnDesktop.errorCode).toBe("CAPABILITY_NOT_SUPPORTED");
    });

    it("B.3 shared capabilities (youtube, whatsapp, chrome, youtube.search, youtube.play) are supported on BOTH PHONE and DESKTOP", () => {
      for (const app of ["youtube", "whatsapp", "chrome", "spotify"]) {
        const onPhone = deviceAwareIntelligence.checkCapabilitySupport({
          capability: "desktop.openApplication",
          intentType: "OPEN_APPLICATION",
          appName: app,
          targetDevice: "PHONE",
        });
        expect(onPhone.supported).toBe(true);

        const onDesktop = deviceAwareIntelligence.checkCapabilitySupport({
          capability: "desktop.openApplication",
          intentType: "OPEN_APPLICATION",
          appName: app,
          targetDevice: "DESKTOP",
        });
        expect(onDesktop.supported).toBe(true);
      }

      for (const cap of ["youtube.search", "youtube.play", "browser.openUrl", "web.research"]) {
        expect(
          deviceAwareIntelligence.checkCapabilitySupport({ capability: cap, targetDevice: "PHONE" }).supported,
        ).toBe(true);
        expect(
          deviceAwareIntelligence.checkCapabilitySupport({ capability: cap, targetDevice: "DESKTOP" }).supported,
        ).toBe(true);
      }
    });

    it("B.4 respects per-device disabledCapabilities in DeviceIdentity", () => {
      deviceRegistry.registerDevice({
        ...DESKTOP_IDENTITY,
        disabledCapabilities: ["desktop.openApplication"],
      });

      const check = deviceAwareIntelligence.checkCapabilitySupport({
        capability: "desktop.openApplication",
        intentType: "OPEN_APPLICATION",
        appName: "vscode",
        targetDevice: "DESKTOP",
        targetDeviceId: DESKTOP_IDENTITY.deviceId,
      });

      expect(check.supported).toBe(false);
      expect(check.errorCode).toBe("CAPABILITY_NOT_SUPPORTED");
      expect(check.reason).toContain("disabled on device");
    });

    it("B.5 returns UNRECOGNIZED_APPLICATION for unknown application names", () => {
      const check = deviceAwareIntelligence.checkCapabilitySupport({
        capability: "desktop.openApplication",
        intentType: "OPEN_APPLICATION",
        appName: "nonexistent-super-app-999",
        targetDevice: "DESKTOP",
      });
      expect(check.supported).toBe(false);
      expect(check.errorCode).toBe("UNRECOGNIZED_APPLICATION");
    });
  });

  // ===========================================================================
  // C. TARGET AWARENESS & G. SMART TARGET MODE (USER EXAMPLES)
  // ===========================================================================
  describe("C & G. Target Awareness & Smart Target Mode", () => {
    it('C.1 Example 1: "Phone mein WhatsApp kholo" → resolves to PHONE', async () => {
      deviceRegistry.registerDevice(PHONE_IDENTITY);
      capabilityRegistry.setDeviceAvailabilityOverrides({ phoneAvailable: true });

      const smart = intentCapabilityOrchestrator.resolveSmartTarget(
        "Phone mein WhatsApp kholo",
        PHONE_SEC_CTX,
        SID,
      );
      expect(smart.targetMode).toBe("PHONE");
      expect(smart.effectiveTargetDevice).toBe("PHONE");
      expect(smart.isExplicitTarget).toBe(true);
      expect(smart.intent.entity).toBe("whatsapp");
      expect(smart.canExecute).toBe(true);

      const res = await intentCapabilityOrchestrator.orchestrateUtterance(
        "Phone mein WhatsApp kholo",
        SID,
        PHONE_SEC_CTX,
      );
      expect(res.ok).toBe(true);
      expect(res.targetMode).toBe("PHONE");
      expect(res.targetDevice).toBe("PHONE");
      expect(res.verified).toBe(true);
    });

    it('C.2 Example 2: "Laptop par VS Code kholo" → resolves to DESKTOP', async () => {
      deviceRegistry.registerDevice(DESKTOP_IDENTITY);
      capabilityRegistry.setDeviceAvailabilityOverrides({ desktopAvailable: true });

      const smart = intentCapabilityOrchestrator.resolveSmartTarget(
        "Laptop par VS Code kholo",
        DESKTOP_SEC_CTX,
        SID,
      );
      expect(smart.targetMode).toBe("DESKTOP");
      expect(smart.effectiveTargetDevice).toBe("DESKTOP");
      expect(smart.isExplicitTarget).toBe(true);
      expect(smart.intent.entity).toBe("vscode");
      expect(smart.canExecute).toBe(true);

      const res = await intentCapabilityOrchestrator.orchestrateUtterance(
        "Laptop par VS Code kholo",
        SID,
        DESKTOP_SEC_CTX,
      );
      expect(res.ok).toBe(true);
      expect(res.targetMode).toBe("DESKTOP");
      expect(res.targetDevice).toBe("DESKTOP");
      expect(res.verified).toBe(true);
    });

    it('C.3 Example 3: "YouTube kholo" → resolves to CURRENT_DEVICE (works on both Phone and Desktop)', async () => {
      // On Phone: CURRENT_DEVICE -> PHONE
      deviceRegistry.registerDevice(PHONE_IDENTITY);
      capabilityRegistry.setDeviceAvailabilityOverrides({ phoneAvailable: true });

      const smartPhone = intentCapabilityOrchestrator.resolveSmartTarget(
        "YouTube kholo",
        PHONE_SEC_CTX,
        SID,
      );
      expect(smartPhone.targetMode).toBe("CURRENT_DEVICE");
      expect(smartPhone.effectiveTargetDevice).toBe("PHONE");
      expect(smartPhone.isExplicitTarget).toBe(false);
      expect(smartPhone.canExecute).toBe(true);

      const phoneRes = await intentCapabilityOrchestrator.orchestrateUtterance(
        "YouTube kholo",
        SID,
        PHONE_SEC_CTX,
      );
      expect(phoneRes.ok).toBe(true);
      expect(phoneRes.targetMode).toBe("CURRENT_DEVICE");
      expect(phoneRes.targetDevice).toBe("PHONE");

      // On Desktop: CURRENT_DEVICE -> DESKTOP
      deviceRegistry.registerDevice(DESKTOP_IDENTITY);
      const smartDesktop = intentCapabilityOrchestrator.resolveSmartTarget(
        "YouTube kholo",
        DESKTOP_SEC_CTX,
        SID,
      );
      expect(smartDesktop.targetMode).toBe("CURRENT_DEVICE");
      expect(smartDesktop.effectiveTargetDevice).toBe("DESKTOP");
      expect(smartDesktop.isExplicitTarget).toBe(false);
      expect(smartDesktop.canExecute).toBe(true);
    });

    it('C.4 Example 4: "Desktop par VS Code kholo" + desktop offline → TARGET_DEVICE_UNAVAILABLE', async () => {
      deviceRegistry.registerDevice(PHONE_IDENTITY);
      capabilityRegistry.setDeviceAvailabilityOverrides({ desktopAvailable: false });

      const openSpy = vi.fn();
      const res = await intentCapabilityOrchestrator.orchestrateUtterance(
        "Desktop par VS Code kholo",
        SID,
        PHONE_SEC_CTX,
        { openApplication: openSpy },
      );

      expect(res.ok).toBe(false);
      expect(res.targetMode).toBe("DESKTOP");
      expect(res.targetDevice).toBe("DESKTOP");
      expect(res.isDeviceUnavailable).toBe(true);
      expect(res.noDesktopConnected).toBe(true);
      expect(res.errorCode).toBe("TARGET_DEVICE_UNAVAILABLE");
      expect(res.error).toContain("TARGET_DEVICE_UNAVAILABLE");
      expect(openSpy).not.toHaveBeenCalled();
    });

    it('C.5 Example 5a: "VS Code kholo" on DESKTOP → resolves using CURRENT_DEVICE (DESKTOP) and executes', async () => {
      deviceRegistry.registerDevice(DESKTOP_IDENTITY);
      capabilityRegistry.setDeviceAvailabilityOverrides({ desktopAvailable: true });

      const smart = intentCapabilityOrchestrator.resolveSmartTarget(
        "VS Code kholo",
        DESKTOP_SEC_CTX,
        SID,
      );
      expect(smart.targetMode).toBe("CURRENT_DEVICE");
      expect(smart.effectiveTargetDevice).toBe("DESKTOP");
      expect(smart.canExecute).toBe(true);

      const openSpy = vi.fn().mockResolvedValue({
        ok: true,
        result: { launched: true, appName: "vscode", pid: 5150 },
      });

      const res = await intentCapabilityOrchestrator.orchestrateUtterance(
        "VS Code kholo",
        SID,
        DESKTOP_SEC_CTX,
        { openApplication: openSpy },
      );
      expect(res.ok).toBe(true);
      expect(res.targetMode).toBe("CURRENT_DEVICE");
      expect(res.targetDevice).toBe("DESKTOP");
      expect(openSpy).toHaveBeenCalledWith("vscode", expect.any(Object), "DESKTOP");
    });

    it('C.6 Example 5b: "VS Code kholo" on PHONE → resolves using CURRENT_DEVICE (PHONE), sees unsupported capability, and NEVER silently switches to DESKTOP', async () => {
      // Register BOTH Phone and Desktop under the same account!
      deviceRegistry.registerDevice(PHONE_IDENTITY);
      deviceRegistry.registerDevice(DESKTOP_IDENTITY);
      capabilityRegistry.setDeviceAvailabilityOverrides({
        phoneAvailable: true,
        desktopAvailable: true,
      });

      const openSpy = vi.fn();
      const res = await intentCapabilityOrchestrator.orchestrateUtterance(
        "VS Code kholo",
        SID,
        PHONE_SEC_CTX,
        { openApplication: openSpy },
      );

      expect(res.ok).toBe(false);
      expect(res.targetMode).toBe("CURRENT_DEVICE");
      expect(res.targetDevice).toBe("PHONE");
      expect(res.isCapabilityUnsupported).toBe(true);
      expect(res.bridgeRequired).toBe(true);
      expect(res.errorCode).toBe("CAPABILITY_NOT_SUPPORTED");
      // Must NEVER silently execute on Desktop!
      expect(openSpy).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // D. DEVICE AVAILABILITY & E. "NO DESKTOP CONNECTED" HANDLING
  // ===========================================================================
  describe('D & E. Device Availability & "No Desktop Connected" Handling', () => {
    it("D.1 returns available=true when target DESKTOP is online", () => {
      deviceRegistry.registerDevice(DESKTOP_IDENTITY);
      capabilityRegistry.setDeviceAvailabilityOverrides({ desktopAvailable: true });
      const current = deviceAwareIntelligence.detectCurrentDevice(DESKTOP_SEC_CTX);
      const status = deviceAwareIntelligence.checkDeviceAvailability("DESKTOP", current, DESKTOP_SEC_CTX);
      expect(status.available).toBe(true);
      expect(status.noDesktopConnected).toBe(false);
    });

    it("D.2 returns TARGET_DEVICE_UNAVAILABLE + noDesktopConnected=true when DESKTOP is offline", () => {
      deviceRegistry.registerDevice(PHONE_IDENTITY);
      capabilityRegistry.setDeviceAvailabilityOverrides({ desktopAvailable: false });
      const current = deviceAwareIntelligence.detectCurrentDevice(PHONE_SEC_CTX);
      const status = deviceAwareIntelligence.checkDeviceAvailability("DESKTOP", current, PHONE_SEC_CTX);
      expect(status.available).toBe(false);
      expect(status.noDesktopConnected).toBe(true);
      expect(status.errorCode).toBe("TARGET_DEVICE_UNAVAILABLE");
      expect(status.reason).toContain("No Desktop Connected");
    });

    it("D.3 returns TARGET_DEVICE_UNAVAILABLE + noPhoneConnected=true when PHONE is offline", () => {
      deviceRegistry.registerDevice(DESKTOP_IDENTITY);
      capabilityRegistry.setDeviceAvailabilityOverrides({ phoneAvailable: false });
      const current = deviceAwareIntelligence.detectCurrentDevice(DESKTOP_SEC_CTX);
      const status = deviceAwareIntelligence.checkDeviceAvailability("PHONE", current, DESKTOP_SEC_CTX);
      expect(status.available).toBe(false);
      expect(status.noPhoneConnected).toBe(true);
      expect(status.errorCode).toBe("TARGET_DEVICE_UNAVAILABLE");
    });

    it('E.1 "No Desktop Connected" when Phone requests "Laptop par VS Code kholo" with no desktop registered or connected', async () => {
      // Only Phone is registered; no Desktop companion exists
      deviceRegistry.registerDevice(PHONE_IDENTITY);

      const openSpy = vi.fn();
      const res = await intentCapabilityOrchestrator.orchestrateUtterance(
        "Laptop par VS Code kholo",
        SID,
        PHONE_SEC_CTX,
        { openApplication: openSpy },
      );

      expect(res.ok).toBe(false);
      expect(res.targetMode).toBe("DESKTOP");
      expect(res.isDeviceUnavailable).toBe(true);
      expect(res.noDesktopConnected).toBe(true);
      expect(res.errorCode).toBe("TARGET_DEVICE_UNAVAILABLE");
      expect(res.error).toContain("No Desktop Connected");
      expect(openSpy).not.toHaveBeenCalled();
    });

    it('E.2 "No Desktop Connected" when Phone requests "VS Code kholo" and Desktop is offline', async () => {
      deviceRegistry.registerDevice(PHONE_IDENTITY);
      capabilityRegistry.setDeviceAvailabilityOverrides({
        phoneAvailable: true,
        desktopAvailable: false,
      });

      const res = await intentCapabilityOrchestrator.orchestrateUtterance(
        "VS Code kholo",
        SID,
        PHONE_SEC_CTX,
      );

      expect(res.ok).toBe(false);
      expect(res.targetMode).toBe("CURRENT_DEVICE");
      expect(res.noDesktopConnected).toBe(true);
      expect(res.errorCode).toBe("CAPABILITY_NOT_SUPPORTED");
      expect(res.error).toContain("no Desktop is currently connected");
    });
  });

  // ===========================================================================
  // F. NO SILENT FALLBACK GUARANTEES
  // ===========================================================================
  describe("F. No Silent Fallback Enforcement", () => {
    it("F.1 NEVER falls back to PHONE when DESKTOP is explicitly requested and offline", async () => {
      deviceRegistry.registerDevice(PHONE_IDENTITY);
      capabilityRegistry.setDeviceAvailabilityOverrides({
        phoneAvailable: true,
        desktopAvailable: false,
      });

      const openSpy = vi.fn();
      // Even though Chrome is supported on Phone, user explicitly said "Desktop par Chrome kholo"!
      const res = await intentCapabilityOrchestrator.orchestrateUtterance(
        "Desktop par Chrome kholo",
        SID,
        PHONE_SEC_CTX,
        { openApplication: openSpy },
      );

      expect(res.ok).toBe(false);
      expect(res.targetMode).toBe("DESKTOP");
      expect(res.targetDevice).toBe("DESKTOP");
      expect(res.isDeviceUnavailable).toBe(true);
      expect(res.errorCode).toBe("TARGET_DEVICE_UNAVAILABLE");
      // Must NOT fall back to opening Chrome on Phone!
      expect(openSpy).not.toHaveBeenCalled();
    });

    it("F.2 NEVER falls back to DESKTOP when PHONE is explicitly requested and offline", async () => {
      deviceRegistry.registerDevice(DESKTOP_IDENTITY);
      capabilityRegistry.setDeviceAvailabilityOverrides({
        desktopAvailable: true,
        phoneAvailable: false,
      });

      const openSpy = vi.fn();
      // Even though WhatsApp is supported on Desktop, user explicitly said "Phone mein WhatsApp kholo"!
      const res = await intentCapabilityOrchestrator.orchestrateUtterance(
        "Phone mein WhatsApp kholo",
        SID,
        DESKTOP_SEC_CTX,
        { openApplication: openSpy },
      );

      expect(res.ok).toBe(false);
      expect(res.targetMode).toBe("PHONE");
      expect(res.targetDevice).toBe("PHONE");
      expect(res.isDeviceUnavailable).toBe(true);
      expect(res.errorCode).toBe("TARGET_DEVICE_UNAVAILABLE");
      // Must NOT fall back to opening WhatsApp on Desktop!
      expect(openSpy).not.toHaveBeenCalled();
    });

    it("F.3 NEVER silently switches from DESKTOP to PHONE when user says 'Camera kholo' on Desktop", async () => {
      deviceRegistry.registerDevice(DESKTOP_IDENTITY);
      deviceRegistry.registerDevice(PHONE_IDENTITY);
      capabilityRegistry.setDeviceAvailabilityOverrides({
        desktopAvailable: true,
        phoneAvailable: true,
      });

      const openSpy = vi.fn();
      const res = await intentCapabilityOrchestrator.orchestrateUtterance(
        "Camera kholo",
        SID,
        DESKTOP_SEC_CTX,
        { openApplication: openSpy },
      );

      expect(res.ok).toBe(false);
      expect(res.targetMode).toBe("CURRENT_DEVICE");
      expect(res.targetDevice).toBe("DESKTOP");
      expect(res.isCapabilityUnsupported).toBe(true);
      expect(res.errorCode).toBe("CAPABILITY_NOT_SUPPORTED");
      expect(openSpy).not.toHaveBeenCalled();
    });

    it("F.4 blocks REMOTE_DESKTOP execution from Phone when RemoteBridge is INACTIVE, and allows when ACTIVE", async () => {
      deviceRegistry.registerDevice(PHONE_IDENTITY);
      deviceRegistry.registerDevice(DESKTOP_IDENTITY);
      capabilityRegistry.setDeviceAvailabilityOverrides({
        phoneAvailable: true,
        desktopAvailable: true,
        remoteDesktopAvailable: true,
      });

      const openSpy = vi.fn().mockResolvedValue({
        ok: true,
        result: { launched: true, appName: "vscode", pid: 7777 },
      });

      // Bridge is INACTIVE by default -> blocked with BRIDGE_INACTIVE
      const blockedRes = await intentCapabilityOrchestrator.orchestrateUtterance(
        "remote desktop par VS Code kholo",
        SID,
        PHONE_SEC_CTX,
        { openApplication: openSpy },
      );
      expect(blockedRes.ok).toBe(false);
      expect(blockedRes.targetMode).toBe("REMOTE_DESKTOP");
      expect(blockedRes.bridgeRequired).toBe(true);
      expect(blockedRes.errorCode).toBe("BRIDGE_INACTIVE");
      expect(openSpy).not.toHaveBeenCalled();

      // Explicitly activate RemoteBridge -> now allowed!
      await remoteBridge.activate(PHONE_IDENTITY.deviceId, DESKTOP_IDENTITY.deviceId);
      const allowedRes = await intentCapabilityOrchestrator.orchestrateUtterance(
        "remote desktop par VS Code kholo",
        SID,
        PHONE_SEC_CTX,
        { openApplication: openSpy },
      );
      expect(allowedRes.ok).toBe(true);
      expect(allowedRes.targetMode).toBe("REMOTE_DESKTOP");
      expect(allowedRes.verified).toBe(true);
      expect(openSpy).toHaveBeenCalledWith("vscode", expect.any(Object), "REMOTE_DESKTOP");
    });
  });

  // ===========================================================================
  // H. PHASE 4 CONTEXT, SECURITY PIPELINE & 126 GEMINI TOOLS PRESERVATION
  // ===========================================================================
  describe("H. Phase 4 Context, Security Pipeline & 126 Tools Invariants", () => {
    it("H.1 preserves Phase 4 ActionContext & YouTube Search -> Play karo semantics with Smart Target Mode", async () => {
      deviceRegistry.registerDevice(PHONE_IDENTITY);
      capabilityRegistry.setDeviceAvailabilityOverrides({ phoneAvailable: true });

      const sampleMedia = [
        {
          index: 0,
          videoId: "arijit_01",
          title: "Apna Bana Le - Bhediya | Arijit Singh",
          url: "https://www.youtube.com/watch?v=arijit_01",
          author: "Zee Music Company",
        },
      ];

      const searchRes = await intentCapabilityOrchestrator.orchestrateUtterance(
        "YouTube par Apna Bana Le search karo",
        SID,
        PHONE_SEC_CTX,
        { searchYouTube: async () => ({ ok: true, results: sampleMedia }) },
      );
      expect(searchRes.ok).toBe(true);
      expect(searchRes.targetMode).toBe("CURRENT_DEVICE");

      const controlSpy = vi.fn().mockResolvedValue({ ok: true });
      const playRes = await intentCapabilityOrchestrator.orchestrateUtterance(
        "Play karo",
        SID,
        PHONE_SEC_CTX,
        { controlMedia: controlSpy },
      );
      expect(playRes.ok).toBe(true);
      expect(playRes.targetMode).toBe("CURRENT_DEVICE");
      expect(controlSpy).toHaveBeenCalledWith(
        "play",
        expect.objectContaining({ videoId: "arijit_01" }),
        expect.any(Object),
        "BROWSER",
      );
    });

    it("H.2 SecurityPolicyEngine and Emergency Stop always take priority over device routing", async () => {
      deviceRegistry.registerDevice(DESKTOP_IDENTITY);
      await emergencyStopCoordinator.trigger({
        source: "desktop_ui",
        deviceId: DESKTOP_IDENTITY.deviceId,
        reason: "Phase 5 emergency stop test",
      });

      const res = await intentCapabilityOrchestrator.orchestrateUtterance(
        "VS Code kholo",
        SID,
        DESKTOP_SEC_CTX,
      );
      expect(res.ok).toBe(false);
      expect(res.isPermissionDenied).toBe(true);
      expect(res.errorCode).toBe("SECURITY_POLICY_DENIED");
      expect(res.error).toContain("EMERGENCY_STOP_ACTIVE");
    });

    it("H.3 preserves exact 126 Gemini Live tools count", () => {
      expect(LIVE_TOOLS[0].functionDeclarations.length).toBe(126);
    });
  });
});
