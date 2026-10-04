/**
 * MYRAA — Phase 9: Production UX Layer Test Suite
 *
 * Verifies:
 *   1. Mobile UX flows (Clean onboarding, Voice-first UI, Device/target selector, Desktop connection screen, Account, Settings)
 *   2. Desktop UX flows (Voice-first interface, Project dashboard, Active application/context, Tools/capabilities view, Memory, Device/remote connection)
 *   3. Remote connect/disconnect/status flows (Default DISCONNECTED, Connect/Disconnect, Device identity, Remote capabilities, Remote audit/history)
 *   4. Permissions, privacy & settings flows (Permission grant/revoke, Privacy Shield, Local-Only Mode, Hinglish preference sync, Emergency Stop & Security Lockdown)
 *   5. Standalone behavior with no paired device (Mobile and Desktop remain 100% standalone products)
 *   6. Shared vs local memory boundaries & DLP protection in UX
 *   7. Actionable errors for offline/unsupported/unauthorized targets with zero silent fallback
 *   8. Exactly 126 Gemini Live tools preserved
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  deviceRegistry,
  androidCapabilityEngine,
  desktopCapabilityEngine,
  sharedAccountMemoryManager,
  productionUxController,
} from "../../backend/device/index.ts";
import { intentCapabilityOrchestrator } from "../../backend/orchestrator/IntentCapabilityOrchestrator.ts";
import { LIVE_TOOLS } from "../../backend/ai/GeminiSessionFactory.ts";
import { securityPolicyEngine } from "../../backend/security/SecurityPolicyEngine.ts";
import { emergencyStopCoordinator } from "../../backend/remote/EmergencyStopCoordinator.ts";

describe("Phase 9 — Production UX Layer (Mobile, Desktop & Remote Control Center)", () => {
  const ACCOUNT_ID = "acct-myraa-phase9";
  const PHONE_ID = "myraa-phone-ux-01";
  const DESKTOP_ID = "myraa-desktop-ux-01";

  beforeEach(async () => {
    deviceRegistry.resetForTesting();
    deviceRegistry.registerEngine(androidCapabilityEngine);
    deviceRegistry.registerEngine(desktopCapabilityEngine);
    intentCapabilityOrchestrator.resetForTesting();
    securityPolicyEngine.setMode("BALANCED");
    await emergencyStopCoordinator.reset("test-admin");
  });

  afterEach(async () => {
    securityPolicyEngine.setMode("BALANCED");
    await emergencyStopCoordinator.reset("test-admin");
  });

  // =========================================================================
  // 1. MOBILE UX FLOWS
  // =========================================================================
  describe("1. Mobile UX Flows (Onboarding, Voice-First UI, Target Selector, Desktop Connection Screen)", () => {
    it("completes clean 5-step standalone Mobile onboarding without requiring a Desktop connection", () => {
      const initialView = productionUxController.initMobileUxSession({
        deviceId: PHONE_ID,
        deviceName: "Sandeep's Pixel 9 Pro",
        online: true,
      });

      expect(initialView.productType).toBe("MYRAA_MOBILE");
      expect(initialView.standaloneMode).toBe(true);
      expect(initialView.standaloneReady).toBe(true);
      expect(initialView.onboarding.completed).toBe(false);
      expect(initialView.onboarding.currentStep).toBe("WELCOME");
      expect(initialView.onboarding.requiresDesktopPairing).toBe(false);
      expect(initialView.desktopConnectionScreen.connectionStatus).toBe("DISCONNECTED");

      // Step through onboarding
      productionUxController.completeMobileOnboardingStep(PHONE_ID, "WELCOME");
      productionUxController.completeMobileOnboardingStep(PHONE_ID, "VOICE_SETUP");
      productionUxController.completeMobileOnboardingStep(PHONE_ID, "PERMISSIONS");
      productionUxController.completeMobileOnboardingStep(PHONE_ID, "PRIVACY_AND_ACCOUNT");
      const finalOnboarding = productionUxController.completeMobileOnboardingStep(
        PHONE_ID,
        "READY",
      );

      expect(finalOnboarding.completed).toBe(true);
      expect(finalOnboarding.currentStep).toBe("READY");
      expect(finalOnboarding.completedSteps).toEqual([
        "WELCOME",
        "VOICE_SETUP",
        "PERMISSIONS",
        "PRIVACY_AND_ACCOUNT",
        "READY",
      ]);
    });

    it("clearly distinguishes CURRENT_DEVICE, PHONE, DESKTOP, and REMOTE_DESKTOP in the Mobile Target Selector", () => {
      const view = productionUxController.initMobileUxSession({
        deviceId: PHONE_ID,
        deviceName: "MYRAA Android Phone",
      });

      const targets = view.voiceUi.targetSelector.map((t) => t.target);
      expect(targets).toEqual(["CURRENT_DEVICE", "PHONE", "DESKTOP", "REMOTE_DESKTOP"]);

      const currentEntry = view.voiceUi.targetSelector.find(
        (t) => t.target === "CURRENT_DEVICE",
      )!;
      const desktopEntry = view.voiceUi.targetSelector.find((t) => t.target === "DESKTOP")!;
      const remoteEntry = view.voiceUi.targetSelector.find(
        (t) => t.target === "REMOTE_DESKTOP",
      )!;

      expect(currentEntry.selected).toBe(true);
      expect(currentEntry.online).toBe(true);
      expect(desktopEntry.bridgeConnected).toBe(false);
      expect(desktopEntry.badgeText).toBe("NO DESKTOP CONNECTED");
      expect(remoteEntry.bridgeConnected).toBe(false);
      expect(remoteEntry.badgeText).toBe("REMOTE BRIDGE DISCONNECTED");

      // Switch target selector to PHONE explicitly
      const updated = productionUxController.selectMobileTargetDevice(PHONE_ID, "PHONE");
      expect(updated.voiceUi.selectedTarget).toBe("PHONE");
      expect(
        updated.voiceUi.targetSelector.find((t) => t.target === "PHONE")?.selected,
      ).toBe(true);
    });

    it("executes voice-first Mobile commands locally and shows actionable error (never silent fallback) when Desktop target is disconnected", async () => {
      productionUxController.initMobileUxSession({
        deviceId: PHONE_ID,
        deviceName: "MYRAA Android Phone",
      });

      // Local phone command succeeds standalone
      const localTurn = await productionUxController.submitMobileVoiceCommand({
        deviceId: PHONE_ID,
        utterance: "YouTube open karo",
      });

      expect(localTurn.ok).toBe(true);
      expect(localTurn.verified).toBe(true);
      expect(localTurn.executingDeviceId).toBe(PHONE_ID);
      expect(localTurn.usedSilentFallback).toBe(false);

      // Explicitly select DESKTOP while no desktop is connected -> actionable error, NO silent fallback
      productionUxController.selectMobileTargetDevice(PHONE_ID, "DESKTOP");
      const desktopTurn = await productionUxController.submitMobileVoiceCommand({
        deviceId: PHONE_ID,
        utterance: "VS Code open karo",
      });

      expect(desktopTurn.ok).toBe(false);
      expect(desktopTurn.executingDeviceId).toBeNull();
      expect(desktopTurn.usedSilentFallback).toBe(false);
      expect(desktopTurn.actionableError).toBeDefined();
      expect(desktopTurn.actionableError?.errorCode).toBe("REMOTE_BRIDGE_INACTIVE");
      expect(desktopTurn.actionableError?.remediationSteps.length).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // 2. DESKTOP UX FLOWS
  // =========================================================================
  describe("2. Desktop UX Flows (Voice-First Interface, Project Dashboard, Active Context, Tools View)", () => {
    it("renders Desktop Project Dashboard, Active Application/Context (DEVICE_LOCAL), and Voice-First execution", async () => {
      const desktopView = productionUxController.initDesktopUxSession({
        deviceId: DESKTOP_ID,
        deviceName: "MYRAA Workstation PC",
        projectPath: "d:/SORA AI/Sora AI",
        projectName: "MYRAA Core",
      });

      expect(desktopView.productType).toBe("MYRAA_DESKTOP");
      expect(desktopView.standaloneMode).toBe(true);
      expect(desktopView.standaloneReady).toBe(true);
      expect(desktopView.projectDashboard.projectName).toBe("MYRAA Core");
      expect(desktopView.activeContext.scopeBadge).toBe(
        "DEVICE_LOCAL (Desktop Only — Never Synced)",
      );
      expect(desktopView.activeContext.activeApplication).toBe("vscode");

      // Open a new project in Project Dashboard
      const dashboard = productionUxController.openProjectInDashboard({
        deviceId: DESKTOP_ID,
        projectName: "MYRAA Phase 9 UX",
        projectPath: "d:/SORA AI/Sora AI",
        activeFile: "d:/SORA AI/Sora AI/src/App.tsx",
      });

      expect(dashboard.projectName).toBe("MYRAA Phase 9 UX");
      expect(dashboard.activeFile).toBe("d:/SORA AI/Sora AI/src/App.tsx");

      // Execute a Desktop voice command locally
      const voiceTurn = await productionUxController.submitDesktopVoiceCommand({
        deviceId: DESKTOP_ID,
        utterance: "VS Code open karo",
      });

      expect(voiceTurn.ok).toBe(true);
      expect(voiceTurn.verified).toBe(true);
      expect(voiceTurn.executingDeviceId).toBe(DESKTOP_ID);
      expect(voiceTurn.usedSilentFallback).toBe(false);
    });

    it("exposes Tools & Capabilities View with Desktop capabilities, Mobile capabilities, and all 129 Gemini Live tools", () => {
      const view = productionUxController.initDesktopUxSession({
        deviceId: DESKTOP_ID,
      });

      expect(view.toolsAndCapabilities.totalGeminiLiveTools).toBe(129);
      expect(LIVE_TOOLS[0].functionDeclarations.length).toBe(129);
      expect(view.toolsAndCapabilities.desktopCapabilitiesCount).toBeGreaterThan(10);
      expect(view.toolsAndCapabilities.mobileCapabilitiesCount).toBeGreaterThan(10);

      const modifyFileCap = view.toolsAndCapabilities.desktopCapabilities.find(
        (c) => c.capability === "desktop.modifyFile",
      );
      expect(modifyFileCap).toBeDefined();
      expect(modifyFileCap?.requiresConfirmation).toBe(true);
    });
  });

  // =========================================================================
  // 3. REMOTE CONNECT / DISCONNECT / STATUS / AUDIT FLOWS
  // =========================================================================
  describe("3. Remote Connect / Disconnect / Status / Capabilities / Audit Flows", () => {
    it("defaults to DISCONNECTED even on same account, supports explicit Connect/Disconnect, and shows device identity, capabilities, and tamper-evident audit history", async () => {
      // Register both devices under the same Unified Account
      sharedAccountMemoryManager.registerAccount({
        accountId: ACCOUNT_ID,
        displayName: "Sandeep Mishra",
        email: "sandeep@mishtron.ai",
        role: "admin",
      });
      sharedAccountMemoryManager.registerAccountDevice({
        accountId: ACCOUNT_ID,
        deviceId: PHONE_ID,
        deviceName: "Sandeep's Android Phone",
        productType: "MYRAA_MOBILE",
        role: "admin",
        online: true,
      });
      sharedAccountMemoryManager.registerAccountDevice({
        accountId: ACCOUNT_ID,
        deviceId: DESKTOP_ID,
        deviceName: "Sandeep's Windows PC",
        productType: "MYRAA_DESKTOP",
        role: "admin",
        online: true,
      });

      productionUxController.initMobileUxSession({
        deviceId: PHONE_ID,
        deviceName: "Sandeep's Android Phone",
        accountId: ACCOUNT_ID,
      });
      productionUxController.initDesktopUxSession({
        deviceId: DESKTOP_ID,
        deviceName: "Sandeep's Windows PC",
        accountId: ACCOUNT_ID,
      });

      // Verify Remote Bridge is STILL DISCONNECTED by default despite same account!
      const initialRemote = productionUxController.getRemoteControlCenterState(PHONE_ID);
      expect(initialRemote.connectionStatus).toBe("DISCONNECTED");
      expect(initialRemote.defaultStateIsDisconnected).toBe(true);
      expect(initialRemote.autoConnectOnSameAccount).toBe(false);
      expect(initialRemote.discoveredDevices.some((d) => d.deviceId === DESKTOP_ID)).toBe(
        true,
      );

      // Explicitly pair and connect from UX
      const connectOutcome = await productionUxController.pairAndConnectRemoteDevice({
        sourceDeviceId: PHONE_ID,
        targetDeviceId: DESKTOP_ID,
        accountId: ACCOUNT_ID,
        role: "admin",
        connectNow: true,
      });

      expect(connectOutcome.paired).toBe(true);
      expect(connectOutcome.connected).toBe(true);
      expect(connectOutcome.remoteControlCenter.connectionStatus).toBe("CONNECTED");
      expect(connectOutcome.remoteControlCenter.remoteDevice?.deviceId).toBe(DESKTOP_ID);
      expect(connectOutcome.remoteControlCenter.remoteDevice?.deviceName).toBe(
        "Sandeep's Windows PC",
      );
      expect(
        connectOutcome.remoteControlCenter.negotiatedCapabilities.allowedRemoteCapabilities
          .length,
      ).toBeGreaterThan(0);

      // Execute remote desktop command from Mobile UX while connected
      productionUxController.selectMobileTargetDevice(PHONE_ID, "REMOTE_DESKTOP");
      const remoteTurn = await productionUxController.submitMobileVoiceCommand({
        deviceId: PHONE_ID,
        utterance: "Desktop par VS Code open karo",
        targetDesktopDeviceId: DESKTOP_ID,
      });

      expect(remoteTurn.ok).toBe(true);
      expect(remoteTurn.verified).toBe(true);
      expect(remoteTurn.executingDeviceId).toBe(DESKTOP_ID);
      expect(remoteTurn.usedSilentFallback).toBe(false);

      // Verify Remote Audit History & Chain Integrity
      const afterExecRemote = productionUxController.getRemoteControlCenterState(PHONE_ID);
      expect(afterExecRemote.auditHistory.length).toBeGreaterThan(0);
      expect(afterExecRemote.auditChainIntegrityValid).toBe(true);

      // Explicitly Disconnect
      const disconnectedState = productionUxController.disconnectRemoteBridgeFromUx({
        sourceDeviceId: PHONE_ID,
      });
      expect(disconnectedState.connectionStatus).toBe("DISCONNECTED");

      // Subsequent remote command fails deterministically with REMOTE_BRIDGE_INACTIVE
      const blockedTurn = await productionUxController.submitMobileVoiceCommand({
        deviceId: PHONE_ID,
        utterance: "Desktop par VS Code open karo",
        targetDesktopDeviceId: DESKTOP_ID,
      });
      expect(blockedTurn.ok).toBe(false);
      expect(blockedTurn.executingDeviceId).toBeNull();
      expect(blockedTurn.usedSilentFallback).toBe(false);
      expect(blockedTurn.actionableError?.errorCode).toBe("REMOTE_BRIDGE_INACTIVE");
    });
  });

  // =========================================================================
  // 4. PERMISSIONS, PRIVACY & SETTINGS FLOWS
  // =========================================================================
  describe("4. Permissions, Privacy Controls, Settings, Emergency Stop & Lockdown", () => {
    it("enforces Mobile Permission revoke/grant and Privacy Local-Only Mode deterministically", async () => {
      productionUxController.initMobileUxSession({
        deviceId: PHONE_ID,
        accountId: ACCOUNT_ID,
      });
      productionUxController.initDesktopUxSession({
        deviceId: DESKTOP_ID,
        accountId: ACCOUNT_ID,
      });

      // Revoke app_launch permission on Mobile
      const revokedPerm = productionUxController.updateMobilePermission({
        deviceId: PHONE_ID,
        permission: "app_launch",
        granted: false,
      });
      expect(revokedPerm.granted).toBe(false);

      const deniedTurn = await productionUxController.submitMobileVoiceCommand({
        deviceId: PHONE_ID,
        utterance: "YouTube open karo",
      });
      expect(deniedTurn.ok).toBe(false);
      expect(deniedTurn.actionableError?.errorCode).toBe("PERMISSION_DENIED");

      // Re-grant app_launch permission -> succeeds
      productionUxController.updateMobilePermission({
        deviceId: PHONE_ID,
        permission: "app_launch",
        granted: true,
      });
      const allowedTurn = await productionUxController.submitMobileVoiceCommand({
        deviceId: PHONE_ID,
        utterance: "YouTube open karo",
      });
      expect(allowedTurn.ok).toBe(true);

      // Enable Local-Only Privacy Mode -> blocks pairing/connecting to Desktop and blocks remote commands
      const privacy = productionUxController.updateMobilePrivacyControls({
        deviceId: PHONE_ID,
        localOnlyMode: true,
        privacyShieldEnabled: true,
      });
      expect(privacy.localOnlyMode).toBe(true);
      expect(privacy.privacyShieldEnabled).toBe(true);

      const pairAttempt = await productionUxController.pairAndConnectRemoteDevice({
        sourceDeviceId: PHONE_ID,
        targetDeviceId: DESKTOP_ID,
      });
      expect(pairAttempt.connected).toBe(false);
      expect(pairAttempt.errorCode).toBe("LOCAL_ONLY_MODE_ACTIVE");
    });

    it("syncs Hinglish language preference across account devices via Settings and enforces Emergency Stop & Security Lockdown", async () => {
      sharedAccountMemoryManager.registerAccount({
        accountId: ACCOUNT_ID,
        displayName: "Sandeep",
        role: "admin",
      });
      sharedAccountMemoryManager.registerAccountDevice({
        accountId: ACCOUNT_ID,
        deviceId: PHONE_ID,
        deviceName: "Phone",
        productType: "MYRAA_MOBILE",
        role: "admin",
        online: true,
      });
      sharedAccountMemoryManager.registerAccountDevice({
        accountId: ACCOUNT_ID,
        deviceId: DESKTOP_ID,
        deviceName: "Desktop",
        productType: "MYRAA_DESKTOP",
        role: "admin",
        online: true,
      });

      productionUxController.initMobileUxSession({
        deviceId: PHONE_ID,
        accountId: ACCOUNT_ID,
      });
      productionUxController.initDesktopUxSession({
        deviceId: DESKTOP_ID,
        accountId: ACCOUNT_ID,
      });

      // Update language preference on Phone -> synced to Shared Account Preferences
      productionUxController.updateMobileSettings({
        deviceId: PHONE_ID,
        languagePreference: "hinglish",
        theme: "midnight_slate",
      });

      const desktopView = productionUxController.getDesktopUxState(DESKTOP_ID);
      const syncedLang = desktopView.memoryView.sharedPreferences.find(
        (p) => p.key === "language_preference",
      );
      expect(syncedLang?.value).toBe("hinglish");

      // Trigger Emergency Stop -> blocks voice execution on both Mobile and Desktop with actionable error
      await emergencyStopCoordinator.trigger({
        source: "remote_device",
        deviceId: PHONE_ID,
        reason: "UX Emergency Stop button pressed",
      });

      const mobileBlocked = await productionUxController.submitMobileVoiceCommand({
        deviceId: PHONE_ID,
        utterance: "YouTube open karo",
      });
      expect(mobileBlocked.ok).toBe(false);
      expect(mobileBlocked.actionableError?.errorCode).toBe("EMERGENCY_STOP_ACTIVE");

      await emergencyStopCoordinator.reset("test-admin");

      // Activate Security Lockdown -> blocks execution with SECURITY_LOCKDOWN_ACTIVE
      securityPolicyEngine.setMode("LOCKDOWN");
      const desktopBlocked = await productionUxController.submitDesktopVoiceCommand({
        deviceId: DESKTOP_ID,
        utterance: "VS Code open karo",
      });
      expect(desktopBlocked.ok).toBe(false);
      expect(desktopBlocked.actionableError?.errorCode).toBe("SECURITY_LOCKDOWN_ACTIVE");
    });
  });

  // =========================================================================
  // 5. STANDALONE BEHAVIOR WITH NO PAIRED DEVICE
  // =========================================================================
  describe("5. Standalone Product Independence (Zero Paired Devices)", () => {
    it("allows Mobile and Desktop to operate 100% independently with no paired device and no account signed in", async () => {
      const mobileState = productionUxController.initMobileUxSession({
        deviceId: "standalone-phone-only",
        deviceName: "Standalone Android",
      });
      expect(mobileState.standaloneMode).toBe(true);
      expect(mobileState.standaloneReady).toBe(true);
      expect(mobileState.accountView.signedIn).toBe(false);
      expect(mobileState.desktopConnectionScreen.connectionStatus).toBe("DISCONNECTED");

      const mobileTurn = await productionUxController.submitMobileVoiceCommand({
        deviceId: "standalone-phone-only",
        utterance: "WhatsApp open karo",
      });
      expect(mobileTurn.ok).toBe(true);
      expect(mobileTurn.executingDeviceId).toBe("standalone-phone-only");

      const desktopState = productionUxController.initDesktopUxSession({
        deviceId: "standalone-desktop-only",
        deviceName: "Standalone Windows PC",
      });
      expect(desktopState.standaloneMode).toBe(true);
      expect(desktopState.standaloneReady).toBe(true);
      expect(desktopState.remoteConnectionPanel.connectionStatus).toBe("DISCONNECTED");

      const desktopTurn = await productionUxController.submitDesktopVoiceCommand({
        deviceId: "standalone-desktop-only",
        utterance: "VS Code open karo",
      });
      expect(desktopTurn.ok).toBe(true);
      expect(desktopTurn.executingDeviceId).toBe("standalone-desktop-only");
    });
  });

  // =========================================================================
  // 6. SHARED VS DEVICE-LOCAL MEMORY BOUNDARIES & DLP
  // =========================================================================
  describe("6. Shared vs Device-Local Memory Boundaries & DLP in UX", () => {
    it("strictly separates Shared Account Memory from Device-Local Context and blocks DLP secrets", () => {
      sharedAccountMemoryManager.registerAccount({
        accountId: ACCOUNT_ID,
        displayName: "Sandeep",
        role: "admin",
      });
      sharedAccountMemoryManager.registerAccountDevice({
        accountId: ACCOUNT_ID,
        deviceId: PHONE_ID,
        deviceName: "Phone",
        productType: "MYRAA_MOBILE",
        role: "admin",
        online: true,
      });
      sharedAccountMemoryManager.registerAccountDevice({
        accountId: ACCOUNT_ID,
        deviceId: DESKTOP_ID,
        deviceName: "Desktop",
        productType: "MYRAA_DESKTOP",
        role: "admin",
        online: true,
      });

      productionUxController.initMobileUxSession({
        deviceId: PHONE_ID,
        accountId: ACCOUNT_ID,
      });
      productionUxController.initDesktopUxSession({
        deviceId: DESKTOP_ID,
        accountId: ACCOUNT_ID,
      });

      // 1. Save a valid Shared Memory on Phone -> visible on Desktop
      const sharedRes = productionUxController.saveMemoryFromUx({
        deviceId: PHONE_ID,
        productType: "MYRAA_MOBILE",
        accountId: ACCOUNT_ID,
        scope: "SHARED",
        key: "coding_style",
        value: "Prefer TypeScript strict mode and deterministic tests",
      });
      expect(sharedRes.ok).toBe(true);
      expect(sharedRes.scopeStored).toBe("SHARED");

      // 2. Attempt to save device-local key 'current_window' as SHARED -> rejected!
      const boundaryViolation = productionUxController.saveMemoryFromUx({
        deviceId: DESKTOP_ID,
        productType: "MYRAA_DESKTOP",
        accountId: ACCOUNT_ID,
        scope: "SHARED",
        key: "current_window",
        value: "Visual Studio Code — secret project",
      });
      expect(boundaryViolation.ok).toBe(false);
      expect(boundaryViolation.errorCode).toBe("SCOPE_VIOLATION_DEVICE_LOCAL_ONLY");

      // 3. Attempt to save a DLP secret (API key) -> blocked!
      const dlpBlocked = productionUxController.saveMemoryFromUx({
        deviceId: PHONE_ID,
        productType: "MYRAA_MOBILE",
        accountId: ACCOUNT_ID,
        scope: "DEVICE_LOCAL",
        key: "temp_note",
        value: "My Gemini key is AIzaSyD1234567890abcdefghijklmnopqrstuvwx",
      });
      expect(dlpBlocked.ok).toBe(false);
      expect(dlpBlocked.errorCode).toBe("DLP_VIOLATION_BLOCKED");

      // 4. Verify Desktop sees the shared memory, while Phone NEVER sees Desktop's current_window
      const phoneMemoryView = productionUxController.getMobileUxState(PHONE_ID).memoryView;
      const desktopMemoryView =
        productionUxController.getDesktopUxState(DESKTOP_ID).memoryView;

      expect(
        desktopMemoryView.sharedMemories.some((m) => m.key === "coding_style"),
      ).toBe(true);
      expect(
        desktopMemoryView.deviceLocalContext.some((c) => c.key === "current_window"),
      ).toBe(true);
      expect(
        phoneMemoryView.deviceLocalContext.some((c) => c.key === "current_window"),
      ).toBe(false);
    });
  });
});
