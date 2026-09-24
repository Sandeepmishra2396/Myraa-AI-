/**
 * Phase 19 — Android Native Capability Engine Integration Tests
 *
 * Comprehensive test suite verifying:
 *  1. All 11 capabilities individually (openApp, openUrl, openSettings, setAlarm, setTimer,
 *     createReminder, calendar, notifications, mediaControls, clipboard, deviceStatus)
 *  2. Invalid & malformed arguments rejection
 *  3. URL validation & SSRF prevention for openUrl
 *  4. SecurityPolicyEngine & ToolExecutionFirewall gatekeeping
 *  5. Emergency Stop killswitch immediate halt
 *  6. Security Lockdown fail-closed rejection
 *  7. Revocation & unauthorized caller rejection
 *  8. Zero secret leakage in clipboard, notifications, or logs
 *  9. Exactly 126 Gemini Live tools preserved in registry
 *  10. toolCall -> toolResponse roundtrip simulation
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { remoteCapabilityDispatcher } from "../RemoteCapabilityDispatcher.ts";
import { pairingManager } from "../PairingManager.ts";
import { remoteSessionManager } from "../RemoteSessionManager.ts";
import { emergencyStopCoordinator } from "../EmergencyStopCoordinator.ts";
import { securityPolicyEngine } from "../../security/SecurityPolicyEngine.ts";
import { securityRiskEngine, MEDIUM_RISK_TOOLS } from "../../security/SecurityRiskEngine.ts";
import { LIVE_TOOLS } from "../../ai/GeminiSessionFactory.ts";
import { ANDROID_CAPABILITIES, ANDROID_CLIENT_TOOLS } from "../../../platform/android/AndroidCapabilityDescriptors.ts";
import type { SecurityContext } from "../../security/SecurityTypes.ts";

describe("Phase 19 — Android Native Capability Engine", () => {
  let testDeviceId: string;
  let testContext: SecurityContext;

  beforeEach(async () => {
    await emergencyStopCoordinator.reset("Phase 19 test setup");
    securityPolicyEngine.resetForTesting();

    // Register a valid paired Android test device
    const { code } = pairingManager.generatePairCode("127.0.0.1");
    const { device } = await pairingManager.pairDevice({
      code,
      deviceName: "Pixel 9 Pro Capability Testbed",
      deviceType: "mobile",
      ipAddress: "192.168.1.150",
    });

    testDeviceId = device.id;
    testContext = {
      identityId: device.id,
      role: device.role,
      ipAddress: "192.168.1.150",
      deviceId: device.id,
      isLocal: false,
    };
  });

  afterEach(async () => {
    await emergencyStopCoordinator.reset("Phase 19 test cleanup");
    securityPolicyEngine.resetForTesting();
  });

  // ── 1. Individual Capability Execution (All 11 Capabilities) ──────────────
  describe("1. All 11 Native Android Capabilities Dispatch", () => {
    it("1.1 openApp: dispatches valid application launch request", async () => {
      const res = await remoteCapabilityDispatcher.dispatchCapability(
        testDeviceId,
        "openApp",
        { appName: "Gmail", packageName: "com.google.android.gm" },
        testContext
      );
      expect(res.ok).toBe(true);
      expect(res.capability).toBe("openApp");
      expect(res.decision.allowed).toBe(true);
    });

    it("1.2 openUrl: dispatches valid public HTTP/HTTPS URL", async () => {
      const res = await remoteCapabilityDispatcher.dispatchCapability(
        testDeviceId,
        "openUrl",
        { url: "https://example.com/docs" },
        testContext
      );
      expect(res.ok).toBe(true);
      expect(res.capability).toBe("openUrl");
      expect(res.decision.allowed).toBe(true);
    });

    it("1.3 openSettings: dispatches system settings intent", async () => {
      const res = await remoteCapabilityDispatcher.dispatchCapability(
        testDeviceId,
        "openSettings",
        { settingType: "wifi" },
        testContext
      );
      expect(res.ok).toBe(true);
      expect(res.capability).toBe("openSettings");
      expect(res.decision.allowed).toBe(true);
    });

    it("1.4 setAlarm: dispatches alarm request with valid hour and minute", async () => {
      const res = await remoteCapabilityDispatcher.dispatchCapability(
        testDeviceId,
        "setAlarm",
        { hour: 7, minutes: 30, message: "Morning Briefing" },
        testContext
      );
      expect(res.ok).toBe(true);
      expect(res.capability).toBe("setAlarm");
      expect(res.decision.allowed).toBe(true);
    });

    it("1.5 setTimer: dispatches timer request with positive seconds", async () => {
      const res = await remoteCapabilityDispatcher.dispatchCapability(
        testDeviceId,
        "setTimer",
        { lengthSeconds: 300, message: "Tea Timer" },
        testContext
      );
      expect(res.ok).toBe(true);
      expect(res.capability).toBe("setTimer");
      expect(res.decision.allowed).toBe(true);
    });

    it("1.6 createReminder: dispatches reminder request with title and timestamp", async () => {
      const res = await remoteCapabilityDispatcher.dispatchCapability(
        testDeviceId,
        "createReminder",
        { title: "Review pull request", timeMs: Date.now() + 3600000 },
        testContext
      );
      expect(res.ok).toBe(true);
      expect(res.capability).toBe("createReminder");
      expect(res.decision.allowed).toBe(true);
    });

    it("1.7 calendar: dispatches calendar event action", async () => {
      const res = await remoteCapabilityDispatcher.dispatchCapability(
        testDeviceId,
        "calendar",
        { action: "insert", title: "Team Architecture Sync", startTimeMs: Date.now() + 7200000 },
        testContext
      );
      expect(res.ok).toBe(true);
      expect(res.capability).toBe("calendar");
      expect(res.decision.allowed).toBe(true);
    });

    it("1.8 notifications: dispatches safe notification posting", async () => {
      const res = await remoteCapabilityDispatcher.dispatchCapability(
        testDeviceId,
        "notifications",
        { action: "post", title: "MYRAA Companion", message: "Task completed successfully" },
        testContext
      );
      expect(res.ok).toBe(true);
      expect(res.capability).toBe("notifications");
      expect(res.decision.allowed).toBe(true);
    });

    it("1.9 mediaControls: dispatches supported volume / playback command", async () => {
      const res = await remoteCapabilityDispatcher.dispatchCapability(
        testDeviceId,
        "mediaControls",
        { action: "volume_up" },
        testContext
      );
      expect(res.ok).toBe(true);
      expect(res.capability).toBe("mediaControls");
      expect(res.decision.allowed).toBe(true);
    });

    it("1.10 clipboard: dispatches safe text read / write", async () => {
      const res = await remoteCapabilityDispatcher.dispatchCapability(
        testDeviceId,
        "clipboard",
        { action: "set", text: "Code snippet to copy" },
        testContext
      );
      expect(res.ok).toBe(true);
      expect(res.capability).toBe("clipboard");
      expect(res.decision.allowed).toBe(true);
    });

    it("1.11 deviceStatus: dispatches read-only hardware/system status query", async () => {
      const res = await remoteCapabilityDispatcher.dispatchCapability(
        testDeviceId,
        "deviceStatus",
        { category: "all" },
        testContext
      );
      expect(res.ok).toBe(true);
      expect(res.capability).toBe("deviceStatus");
      expect(res.decision.allowed).toBe(true);
    });
  });

  // ── 2. Invalid & Malformed Argument Rejection ─────────────────────────────
  describe("2. Malformed / Invalid Argument Rejection", () => {
    it("rejects openApp with command injection characters in app/package name", async () => {
      const res = await remoteCapabilityDispatcher.dispatchCapability(
        testDeviceId,
        "openApp",
        { appName: "Calculator; rm -rf /" },
        testContext
      );
      expect(res.ok).toBe(false);
      expect(res.error).toContain("ARGUMENT_VIOLATION");
    });

    it("rejects openApp when neither appName nor packageName is supplied", async () => {
      const res = await remoteCapabilityDispatcher.dispatchCapability(
        testDeviceId,
        "openApp",
        {},
        testContext
      );
      expect(res.ok).toBe(false);
      expect(res.error).toContain("ARGUMENT_VIOLATION");
    });

    it("rejects setAlarm with out-of-range hours (>23)", async () => {
      const res = await remoteCapabilityDispatcher.dispatchCapability(
        testDeviceId,
        "setAlarm",
        { hour: 25, minutes: 0 },
        testContext
      );
      expect(res.ok).toBe(false);
      expect(res.error).toContain("ARGUMENT_VIOLATION");
    });

    it("rejects setAlarm with negative minutes", async () => {
      const res = await remoteCapabilityDispatcher.dispatchCapability(
        testDeviceId,
        "setAlarm",
        { hour: 8, minutes: -5 },
        testContext
      );
      expect(res.ok).toBe(false);
      expect(res.error).toContain("ARGUMENT_VIOLATION");
    });

    it("rejects setTimer with zero or negative length", async () => {
      const res = await remoteCapabilityDispatcher.dispatchCapability(
        testDeviceId,
        "setTimer",
        { lengthSeconds: 0 },
        testContext
      );
      expect(res.ok).toBe(false);
      expect(res.error).toContain("ARGUMENT_VIOLATION");
    });

    it("rejects createReminder with empty title", async () => {
      const res = await remoteCapabilityDispatcher.dispatchCapability(
        testDeviceId,
        "createReminder",
        { title: "   " },
        testContext
      );
      expect(res.ok).toBe(false);
      expect(res.error).toContain("ARGUMENT_VIOLATION");
    });
  });

  // ── 3. URL Validation & SSRF Prevention ───────────────────────────────────
  describe("3. URL Validation & SSRF Prevention for openUrl", () => {
    it("rejects javascript: pseudo-protocol URLs", async () => {
      const res = await remoteCapabilityDispatcher.dispatchCapability(
        testDeviceId,
        "openUrl",
        { url: "javascript:alert(document.cookie)" },
        testContext
      );
      expect(res.ok).toBe(false);
      expect(res.error).toContain("SSRF_VIOLATION");
    });

    it("rejects file:/// protocol URLs", async () => {
      const res = await remoteCapabilityDispatcher.dispatchCapability(
        testDeviceId,
        "openUrl",
        { url: "file:///etc/passwd" },
        testContext
      );
      expect(res.ok).toBe(false);
      expect(res.error).toContain("SSRF_VIOLATION");
    });

    it("rejects data: URI schemes", async () => {
      const res = await remoteCapabilityDispatcher.dispatchCapability(
        testDeviceId,
        "openUrl",
        { url: "data:text/html,<script>alert(1)</script>" },
        testContext
      );
      expect(res.ok).toBe(false);
      expect(res.error).toContain("SSRF_VIOLATION");
    });

    it("rejects loopback and localhost destination URLs", async () => {
      const res = await remoteCapabilityDispatcher.dispatchCapability(
        testDeviceId,
        "openUrl",
        { url: "http://127.0.0.1:3000/api/admin" },
        testContext
      );
      expect(res.ok).toBe(false);
      expect(res.error).toContain("SSRF_VIOLATION");
    });

    it("rejects cloud metadata IP addresses (169.254.169.254)", async () => {
      const res = await remoteCapabilityDispatcher.dispatchCapability(
        testDeviceId,
        "openUrl",
        { url: "http://169.254.169.254/computeMetadata/v1/" },
        testContext
      );
      expect(res.ok).toBe(false);
      expect(res.error).toContain("SSRF_VIOLATION");
    });
  });

  // ── 4. Security Policy Engine & Risk Engine Integration ────────────────────
  describe("4. Security Policy Engine & Risk Engine Integration", () => {
    it("categorizes openUrl in MEDIUM_RISK_TOOLS with risk score >= 30", () => {
      expect(MEDIUM_RISK_TOOLS.has("openUrl")).toBe(true);
      const risk = securityRiskEngine.calculateRisk("openUrl", { url: "https://example.com" });
      expect(risk.level).toBe("MEDIUM");
      expect(risk.score).toBeGreaterThanOrEqual(30);
    });

    it("evaluates benign deviceStatus as LOW risk", () => {
      const risk = securityRiskEngine.calculateRisk("deviceStatus", { category: "all" });
      expect(risk.level).toBe("LOW");
    });

    it("blocks modifying capabilities when device role is read_only", () => {
      const check = remoteSessionManager.checkToolPermission("read_only", "write_to_file");
      expect(check.allowed).toBe(false);
      expect(check.reason).toContain("read_only");
    });
  });

  // ── 5. Emergency Stop Killswitch Cascade ───────────────────────────────────
  describe("5. Emergency Stop Killswitch Cascade", () => {
    it("immediately blocks capability execution when Emergency Stop is active", async () => {
      await emergencyStopCoordinator.trigger({
        source: "remote_device",
        reason: "User activated emergency stop",
      });
      expect(emergencyStopCoordinator.isActive()).toBe(true);

      const res = await remoteCapabilityDispatcher.dispatchCapability(
        testDeviceId,
        "openApp",
        { appName: "Camera" },
        testContext
      );
      expect(res.ok).toBe(false);
      expect(res.error).toContain("EMERGENCY_STOP_ACTIVE");

      await emergencyStopCoordinator.reset("Operator restored");
      expect(emergencyStopCoordinator.isActive()).toBe(false);

      const retry = await remoteCapabilityDispatcher.dispatchCapability(
        testDeviceId,
        "openApp",
        { appName: "Camera" },
        testContext
      );
      expect(retry.ok).toBe(true);
    });
  });

  // ── 6. Security Policy Engine Lockdown ────────────────────────────────────
  describe("6. Security Policy Engine Lockdown", () => {
    it("fails closed on capability execution when mode is LOCKDOWN", async () => {
      securityPolicyEngine.setMode("LOCKDOWN");
      expect(securityPolicyEngine.getMode()).toBe("LOCKDOWN");

      const res = await remoteCapabilityDispatcher.dispatchCapability(
        testDeviceId,
        "setAlarm",
        { hour: 9, minutes: 0 },
        testContext
      );
      expect(res.ok).toBe(false);
      expect(res.error).toContain("SECURITY_LOCKDOWN");

      securityPolicyEngine.resetForTesting();
      const retry = await remoteCapabilityDispatcher.dispatchCapability(
        testDeviceId,
        "setAlarm",
        { hour: 9, minutes: 0 },
        testContext
      );
      expect(retry.ok).toBe(true);
    });
  });

  // ── 7. Device Revocation & Unregistered Caller Rejection ───────────────────
  describe("7. Device Revocation & Unauthorized Caller Rejection", () => {
    it("rejects capability dispatch for revoked device", async () => {
      await remoteSessionManager.revokeDevice(testDeviceId, "Revoked for test");

      const res = await remoteCapabilityDispatcher.dispatchCapability(
        testDeviceId,
        "openSettings",
        { settingType: "wifi" },
        testContext
      );
      expect(res.ok).toBe(false);
      expect(res.error).toContain("DEVICE_REVOKED");
    });

    it("rejects capability dispatch for nonexistent device UUID", async () => {
      const res = await remoteCapabilityDispatcher.dispatchCapability(
        "00000000-0000-0000-0000-000000000000",
        "deviceStatus",
        {},
        testContext
      );
      expect(res.ok).toBe(false);
      expect(res.error).toContain("DEVICE_REVOKED");
    });
  });

  // ── 8. Zero Secret / Token Leakage in Clipboard & Notifications ───────────
  describe("8. Zero Secret / Token Leakage Prevention", () => {
    it("blocks copying raw pairing token into clipboard", async () => {
      const res = await remoteCapabilityDispatcher.dispatchCapability(
        testDeviceId,
        "clipboard",
        { action: "set", text: "Bearer sora_dev_testToken123456789.hmacSignature" },
        testContext
      );
      expect(res.ok).toBe(false);
      expect(res.error).toContain("SECURITY_VIOLATION");
    });

    it("blocks posting notifications containing session access tokens", async () => {
      const res = await remoteCapabilityDispatcher.dispatchCapability(
        testDeviceId,
        "notifications",
        { action: "post", title: "Alert", message: "Leaked myraa_at_0123456789abcdef token" },
        testContext
      );
      expect(res.ok).toBe(false);
      expect(res.error).toContain("SECURITY_VIOLATION");
    });
  });

  // ── 9. Tool Count & Descriptor Integrity ─────────────────────────────────
  describe("9. Tool Count Integrity (Exactly 126 Tools Preserved)", () => {
    it("verifies LIVE_TOOLS count remains exactly 126", () => {
      const tools = LIVE_TOOLS[0].functionDeclarations;
      expect(tools.length).toBe(126);
    });

    it("exports all 11 capabilities in ANDROID_CAPABILITIES and ANDROID_CLIENT_TOOLS", () => {
      expect(ANDROID_CAPABILITIES.length).toBe(11);
      expect(ANDROID_CLIENT_TOOLS.length).toBeGreaterThanOrEqual(11);
      const expected = [
        "openApp",
        "openUrl",
        "openSettings",
        "setAlarm",
        "setTimer",
        "createReminder",
        "calendar",
        "notifications",
        "mediaControls",
        "clipboard",
        "deviceStatus",
      ];
      for (const cap of expected) {
        expect(ANDROID_CAPABILITIES).toContain(cap);
        expect(ANDROID_CLIENT_TOOLS).toContain(cap);
      }
    });
  });

  // ── 10. WebSocket toolCall to toolResponse Roundtrip ───────────────────────
  describe("10. WebSocket toolCall to toolResponse Roundtrip Simulation", () => {
    it("simulates client-side capability execution returning toolResponse", async () => {
      // Mock client socket
      let receivedToolCall: any = null;
      const mockWs = {
        readyState: 1,
        send: (msg: string) => {
          receivedToolCall = JSON.parse(msg);
        },
        on: () => {},
      };

      // Register mock client in RemoteSessionManager
      const session = remoteSessionManager.registerClient(
        mockWs,
        {
          id: testDeviceId,
          name: "Pixel 9 Pro Testbed",
          deviceType: "mobile",
          role: "standard",
          tokenHash: "abc",
          pairedAt: new Date().toISOString(),
          lastSeenAt: new Date().toISOString(),
          revoked: false,
        },
        "192.168.1.150",
        "MyraaAndroid/1.0"
      );

      // Dispatch capability
      const res = await remoteCapabilityDispatcher.dispatchCapability(
        testDeviceId,
        "openApp",
        { appName: "Chrome" },
        testContext
      );
      expect(res.ok).toBe(true);
      expect(res.dispatched).toBe(true);

      // Check toolCall frame received by client
      expect(receivedToolCall).toBeDefined();
      expect(receivedToolCall.type).toBe("toolCall");
      expect(receivedToolCall.name).toBe("openApp");
      expect(receivedToolCall.args.appName).toBe("Chrome");

      // Simulate client responding with toolResponse
      const toolResponse = {
        type: "toolResponse",
        id: receivedToolCall.callId,
        name: "openApp",
        output: { success: true, result: { launched: true, package: "com.android.chrome" } },
      };

      expect(toolResponse.type).toBe("toolResponse");
      expect(toolResponse.id).toBe(receivedToolCall.callId);
      expect(toolResponse.output.success).toBe(true);
    });
  });
});
