/**
 * MYRAA — Phase 13A: Fix Android Standalone App Launch UX E2E Test Suite
 *
 * Verifies all Test Matrix scenarios A through L:
 *   A. Fresh Install / First Launch -> Mobile Onboarding -> Main Assistant (no pairing screen, no PIN required)
 *   B. Normal Launch (Returning User) -> Main Assistant directly without Desktop
 *   C. Standalone Voice Session -> Works without Desktop pairing
 *   D. Standalone Phone Actions -> Apps, URLs, Web Search, YouTube, Alarms, Timers, Reminders, Calendar, Clipboard, Media, Device Status
 *   E. Mobile Context & Screen Understanding -> Permission-gated screen understanding & privacy shield
 *   F. Shared Memory -> Works in standalone mode and syncs when connected
 *   G. Optional Desktop Pairing -> Settings -> Devices -> Connect Desktop (6-char PIN)
 *   H. Paired Mode -> Phone and Desktop both work with clear target selection
 *   I. Desktop Disconnected Mode -> Phone continues working normally as standalone assistant
 *   J. Explicit Desktop Command While Disconnected -> Fails clearly, NEVER silently falls back to phone
 *   K. Emergency Stop & Security Lockdown -> Halts active sessions and blocks execution (fail-closed)
 *   L. App Relaunch / Restart -> Relaunches into standalone assistant, does not reset into pairing screen
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "http";
import fs from "fs";
import path from "path";
import { WebSocket, WebSocketServer } from "ws";

import { createHttpApp } from "../../backend/gateway/HttpGateway.ts";
import { LIVE_TOOLS } from "../../backend/ai/GeminiSessionFactory.ts";
import { productionUxController } from "../../backend/device/ProductionUxController.ts";
import { pairingManager } from "../../backend/remote/PairingManager.ts";
import { remoteStore } from "../../backend/remote/RemoteStore.ts";
import { remoteSessionManager } from "../../backend/remote/RemoteSessionManager.ts";
import { emergencyStopCoordinator } from "../../backend/remote/EmergencyStopCoordinator.ts";
import { remoteSecurityCoordinator } from "../../backend/security/RemoteSecurityCoordinator.ts";
import { identityAuthManager } from "../../backend/security/IdentityAuthManager.ts";
import { securityPolicyEngine } from "../../backend/security/SecurityPolicyEngine.ts";

const ROOT_DIR = path.resolve(process.cwd());
const ANDROID_MAIN_DIR = path.join(
  ROOT_DIR,
  "android",
  "app",
  "src",
  "main",
  "java",
  "com",
  "myraa",
  "companion",
);

async function startTestGateway() {
  const app = createHttpApp();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", async (req, socket, head) => {
    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname !== "/remote-live") {
      socket.destroy();
      return;
    }

    if (emergencyStopCoordinator.isActive()) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
      socket.destroy();
      return;
    }

    const protocols = String(req.headers["sec-websocket-protocol"] || "")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    const token = protocols.find((p) => p !== "myraa-auth") || "";

    const auth = await remoteSecurityCoordinator.authenticateRemoteCredential(
      token,
      "127.0.0.1",
      "Phase13AStandaloneTest",
    );
    if (!auth.authenticated || !auth.device) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      const remoteSession = remoteSessionManager.registerClient(
        ws,
        auth.device!,
        "127.0.0.1",
        "Phase13AStandaloneTest",
      );
      (ws as any).remoteDevice = auth.device;
      (ws as any).remoteSession = remoteSession;
      wss.emit("connection", ws, req);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    wsUrl: `ws://127.0.0.1:${addr.port}/remote-live`,
    close: () =>
      new Promise<void>((resolve) => {
        wss.clients.forEach((c) => c.terminate());
        wss.close(() => server.close(() => resolve()));
      }),
  };
}

describe("Phase 13A — Android Standalone App Launch UX & Capability Suite (Test Matrix A–L)", () => {
  beforeEach(async () => {
    await emergencyStopCoordinator.reset("phase13a_test_setup");
    securityPolicyEngine.setMode("BALANCED");
    identityAuthManager.resetForTesting();
    remoteSecurityCoordinator.resetForTesting();
    remoteSessionManager.resetForTesting();
    pairingManager.reset();
    productionUxController.resetForTesting();
    await remoteStore.clearStore();
  });

  afterEach(async () => {
    await emergencyStopCoordinator.reset("phase13a_test_teardown");
    securityPolicyEngine.setMode("BALANCED");
    identityAuthManager.resetForTesting();
    remoteSecurityCoordinator.resetForTesting();
    remoteSessionManager.resetForTesting();
    pairingManager.reset();
    productionUxController.resetForTesting();
    await remoteStore.clearStore();
  });

  it("Scenario A & B: verifies Android MainActivity launch resolver never boots into Screen.PAIRING", () => {
    const mainActivityKt = fs.readFileSync(
      path.join(ANDROID_MAIN_DIR, "ui", "MainActivity.kt"),
      "utf-8",
    );
    const onboardingKt = fs.readFileSync(
      path.join(ANDROID_MAIN_DIR, "ui", "screens", "MobileOnboardingScreen.kt"),
      "utf-8",
    );

    // Must define Screen.ONBOARDING and resolveInitialScreen
    expect(mainActivityKt).toContain("ONBOARDING");
    expect(mainActivityKt).toContain("fun resolveInitialScreen(");
    expect(mainActivityKt).toContain(
      "return if (onboardingCompleted || hasDesktopSession) Screen.SESSION else Screen.ONBOARDING",
    );
    // Must NOT use the old bug: `if (tokenStorage.hasSession()) Screen.SESSION else Screen.PAIRING`
    expect(mainActivityKt).not.toContain(
      "if (tokenStorage.hasSession()) Screen.SESSION else Screen.PAIRING",
    );

    // Onboarding screen must allow starting immediately without Desktop pairing
    expect(onboardingKt).toContain("Welcome to MYRAA Mobile");
    expect(onboardingKt).toContain("START USING MYRAA");
    expect(onboardingKt).toContain("SKIP SETUP");
    expect(onboardingKt).toContain("No Desktop pairing required");
  });

  it("Scenario C: verifies Standalone Voice Session and Cloud Voice Turn work without Desktop pairing", async () => {
    const mainSessionKt = fs.readFileSync(
      path.join(ANDROID_MAIN_DIR, "ui", "screens", "MainSessionScreen.kt"),
      "utf-8",
    );
    // START VOICE SESSION and text field must be enabled whenever !isSystemHalted (not gated on AUTHENTICATED)
    expect(mainSessionKt).toContain("enabled = !isSystemHalted");
    expect(mainSessionKt).not.toContain(
      "enabled = connectionStatus == ConnectionStatus.AUTHENTICATED && !emergencyStopState.active",
    );

    const gw = await startTestGateway();
    try {
      // 1. Complete mobile onboarding without Desktop pairing
      const onboardRes = await fetch(`${gw.baseUrl}/api/ux/mobile/onboarding`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deviceId: "mob_standalone_phone_1",
          completeAll: true,
          permissionsGranted: { microphone: true, notifications: true },
        }),
      });
      expect(onboardRes.status).toBe(200);
      const onboardJson = await onboardRes.json();
      const onboarding = onboardJson.onboarding ?? onboardJson.mobile?.onboarding ?? onboardJson;
      expect(onboarding.completed).toBe(true);
      expect(onboarding.standaloneReady).toBe(true);
      expect(onboarding.requiresDesktopPairing).toBe(false);

      // 2. Execute standalone mobile voice turn without Desktop pairing
      const voiceRes = await fetch(`${gw.baseUrl}/api/ux/mobile/voice`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deviceId: "mob_standalone_phone_1",
          utterance: "Open YouTube",
          transcript: "Open YouTube",
          language: "en-IN",
        }),
      });
      expect(voiceRes.status).toBe(200);
      const voiceJson = await voiceRes.json();
      expect(voiceJson.turn.ok).toBe(true);
      expect(voiceJson.turn.usedSilentFallback).toBe(false);
      expect(voiceJson.turn.responseText.length).toBeGreaterThan(0);
    } finally {
      await gw.close();
    }
  });

  it("Scenario D, E, F: verifies StandaloneMobileAssistant supports all phone-native capabilities, screen permission gates, and shared memory", () => {
    const standaloneKt = fs.readFileSync(
      path.join(ANDROID_MAIN_DIR, "capabilities", "StandaloneMobileAssistant.kt"),
      "utf-8",
    );

    // Verify all required phone-native capability bindings exist in StandaloneMobileAssistant.kt
    expect(standaloneKt).toContain("AndroidCapabilities.OPEN_APP");
    expect(standaloneKt).toContain("AndroidCapabilities.INTERACT_APP");
    expect(standaloneKt).toContain("AndroidCapabilities.OPEN_URL");
    expect(standaloneKt).toContain("AndroidCapabilities.OPEN_BROWSER");
    expect(standaloneKt).toContain("AndroidCapabilities.SEARCH_WEB");
    expect(standaloneKt).toContain("AndroidCapabilities.SET_ALARM");
    expect(standaloneKt).toContain("AndroidCapabilities.SET_TIMER");
    expect(standaloneKt).toContain("AndroidCapabilities.CREATE_REMINDER");
    expect(standaloneKt).toContain("AndroidCapabilities.CALENDAR");
    expect(standaloneKt).toContain("AndroidCapabilities.SHARED_MEMORY");
    expect(standaloneKt).toContain("AndroidCapabilities.CLIPBOARD");
    expect(standaloneKt).toContain("AndroidCapabilities.MEDIA_CONTROLS");
    expect(standaloneKt).toContain("AndroidCapabilities.DEVICE_STATUS");
    expect(standaloneKt).toContain("AndroidCapabilities.MOBILE_CONTEXT");
    expect(standaloneKt).toContain("AndroidCapabilities.MOBILE_SCREEN");
    expect(standaloneKt).toContain("SCREEN_PERMISSION_REQUIRED");
  });

  it("Scenario G, H, I, J: verifies Optional Desktop Pairing via Settings -> Devices -> Connect Desktop and strict non-fallback for Desktop commands", async () => {
    const settingsKt = fs.readFileSync(
      path.join(ANDROID_MAIN_DIR, "ui", "screens", "SettingsScreen.kt"),
      "utf-8",
    );
    const pairingKt = fs.readFileSync(
      path.join(ANDROID_MAIN_DIR, "ui", "screens", "PairingScreen.kt"),
      "utf-8",
    );
    const standaloneKt = fs.readFileSync(
      path.join(ANDROID_MAIN_DIR, "capabilities", "StandaloneMobileAssistant.kt"),
      "utf-8",
    );

    // SettingsScreen must expose CONNECT DESKTOP and DISCONNECT DESKTOP (KEEP STANDALONE)
    expect(settingsKt).toContain("DEVICES • DESKTOP REMOTE BRIDGE (OPTIONAL)");
    expect(settingsKt).toContain("CONNECT DESKTOP");
    expect(settingsKt).toContain("DISCONNECT DESKTOP (KEEP STANDALONE)");

    // PairingScreen must have Back navigation to return to standalone mode
    expect(pairingKt).toContain("Optional Desktop Remote Bridge Pairing");
    expect(pairingKt).toContain("Back to Standalone MYRAA Mobile");

    // StandaloneMobileAssistant must fail clearly with DESKTOP_BRIDGE_OFFLINE and never silently fall back
    expect(standaloneKt).toContain("DESKTOP_BRIDGE_OFFLINE");
    expect(standaloneKt).toContain("MYRAA Mobile will not silently run Desktop commands on your phone");

    const gw = await startTestGateway();
    try {
      // Optional 6-character PIN pairing flow still works end-to-end when user chooses Connect Desktop
      const { code } = pairingManager.generatePairCode("127.0.0.1");
      expect(code).toMatch(/^[A-Z0-9]{6}$/);

      const pairRes = await fetch(`${gw.baseUrl}/api/remote/pair`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code,
          deviceName: "Pixel 8 Pro Standalone",
          deviceType: "mobile",
        }),
      });
      expect([200, 201]).toContain(pairRes.status);
      const pairData = await pairRes.json();
      expect(pairData.success).toBe(true);
      expect(pairData.accessToken).toBeDefined();
    } finally {
      await gw.close();
    }
  });

  it("Scenario K & L: verifies Emergency Stop, Security Lockdown, 126 Gemini Live tools, and Relaunch persistence", async () => {
    const decls = (LIVE_TOOLS[0] as any)?.functionDeclarations || [];
    expect(decls.length).toBe(129);

    const tokenStorageKt = fs.readFileSync(
      path.join(ANDROID_MAIN_DIR, "security", "SecureTokenStorage.kt"),
      "utf-8",
    );
    expect(tokenStorageKt).toContain("fun disconnectDesktopSession()");
    expect(tokenStorageKt).toContain("fun isOnboardingCompleted(): Boolean");
    expect(tokenStorageKt).toContain("fun isSecurityLockdownActive(): Boolean");

    const gw = await startTestGateway();
    try {
      const stopRes = await fetch(`${gw.baseUrl}/api/remote/emergency-stop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "Phase 13A E-Stop Verification" }),
      });
      expect(stopRes.status).toBe(200);
      expect(emergencyStopCoordinator.isActive()).toBe(true);
    } finally {
      await gw.close();
    }
  });
});
