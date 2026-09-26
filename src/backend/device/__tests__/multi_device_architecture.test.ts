/**
 * MYRAA — Multi-Device Architecture Tests
 *
 * Tests for DeviceRegistry, AndroidCapabilityEngine, DesktopCapabilityEngine, RemoteBridge.
 *
 * Core invariants tested:
 *   1. Phone-local capabilities route to AndroidCapabilityEngine
 *   2. Desktop-local capabilities route to DesktopCapabilityEngine
 *   3. Shared-cloud capabilities route to whichever product is asking
 *   4. Cross-device capabilities fail gracefully when bridge is INACTIVE
 *   5. RemoteBridge is INACTIVE by default — NEVER auto-activates
 *   6. Bridge activates ONLY on explicit activation call
 *   7. Each engine is fully functional independently (no cross-dependency)
 */

import { describe, it, expect, beforeEach } from "vitest";
import { DeviceRegistry } from "../DeviceRegistry.ts";
import { AndroidCapabilityEngine } from "../AndroidCapabilityEngine.ts";
import { DesktopCapabilityEngine } from "../DesktopCapabilityEngine.ts";
import { RemoteBridge } from "../RemoteBridge.ts";
import type { DeviceIdentity, DeviceExecutionContext } from "../DeviceTypes.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeviceIdentity(opts: Partial<DeviceIdentity> & { deviceId: string }): DeviceIdentity {
  return {
    deviceName: "Test Device",
    productType: "MYRAA_BROWSER",
    accountId: "test-account",
    registered: true,
    registeredAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    bridgeConnected: false,
    bridgeTargetDeviceId: null,
    disabledCapabilities: [],
    ...opts,
  };
}

function makeContext(productType: "MYRAA_MOBILE" | "MYRAA_DESKTOP" | "MYRAA_BROWSER", deviceId = "device-1"): DeviceExecutionContext {
  return {
    deviceId,
    productType,
    bridgeActive: false,
  };
}

// ---------------------------------------------------------------------------
// 1. DeviceRegistry
// ---------------------------------------------------------------------------

describe("DeviceRegistry", () => {
  let registry: DeviceRegistry;
  let android: AndroidCapabilityEngine;
  let desktop: DesktopCapabilityEngine;

  beforeEach(() => {
    registry = new DeviceRegistry();
    android = new AndroidCapabilityEngine();
    desktop = new DesktopCapabilityEngine();
    registry.registerEngine(android);
    registry.registerEngine(desktop);
  });

  it("registers and retrieves engines by ProductType", () => {
    expect(registry.getEngine("MYRAA_MOBILE")).toBe(android);
    expect(registry.getEngine("MYRAA_DESKTOP")).toBe(desktop);
    expect(registry.getEngine("MYRAA_BROWSER")).toBeUndefined();
  });

  it("stores and retrieves DeviceIdentity", () => {
    const identity = makeDeviceIdentity({ deviceId: "dev-001", productType: "MYRAA_MOBILE" });
    registry.registerDevice(identity);
    expect(registry.getDevice("dev-001")).toMatchObject({ deviceId: "dev-001", productType: "MYRAA_MOBILE" });
  });

  describe("resolveExecutor — shared-cloud capabilities", () => {
    it("routes youtube.search to MYRAA_MOBILE when requested from phone", () => {
      const result = registry.resolveExecutor({
        capability: "youtube.search",
        requestingDeviceId: "phone-1",
        requestingProductType: "MYRAA_MOBILE",
      });
      expect(result.canExecute).toBe(true);
      expect(result.executingProductType).toBe("MYRAA_MOBILE");
      expect(result.scope).toBe("shared-cloud");
    });

    it("routes youtube.search to MYRAA_DESKTOP when requested from desktop", () => {
      const result = registry.resolveExecutor({
        capability: "youtube.search",
        requestingDeviceId: "desktop-1",
        requestingProductType: "MYRAA_DESKTOP",
      });
      expect(result.canExecute).toBe(true);
      expect(result.executingProductType).toBe("MYRAA_DESKTOP");
      expect(result.scope).toBe("shared-cloud");
    });
  });

  describe("resolveExecutor — desktop-local capabilities", () => {
    it("executes desktop.openApplication on MYRAA_DESKTOP directly", () => {
      const result = registry.resolveExecutor({
        capability: "desktop.openApplication",
        requestingDeviceId: "desktop-1",
        requestingProductType: "MYRAA_DESKTOP",
      });
      expect(result.canExecute).toBe(true);
      expect(result.executingProductType).toBe("MYRAA_DESKTOP");
      expect(result.scope).toBe("desktop-local");
    });

    it("FAILS desktop.openApplication when requested from MYRAA_MOBILE with no bridge", () => {
      const result = registry.resolveExecutor({
        capability: "desktop.openApplication",
        requestingDeviceId: "phone-1",
        requestingProductType: "MYRAA_MOBILE",
      });
      expect(result.canExecute).toBe(false);
      expect(result.bridgeRequired).toBe(true);
      expect(result.bridgeTargetProduct).toBe("MYRAA_DESKTOP");
      expect(result.reason).toContain("Desktop");
    });

    it("routes desktop.openApplication via remote-bridged scope when bridge is ACTIVE", () => {
      registry.activateBridge("phone-1", "desktop-1");
      const result = registry.resolveExecutor({
        capability: "desktop.openApplication",
        requestingDeviceId: "phone-1",
        requestingProductType: "MYRAA_MOBILE",
      });
      expect(result.canExecute).toBe(true);
      expect(result.executingProductType).toBe("MYRAA_DESKTOP");
      expect(result.scope).toBe("remote-bridged");
    });
  });

  describe("resolveExecutor — mobile-local capabilities", () => {
    it("executes mobile.alarm on MYRAA_MOBILE directly", () => {
      const result = registry.resolveExecutor({
        capability: "mobile.alarm",
        requestingDeviceId: "phone-1",
        requestingProductType: "MYRAA_MOBILE",
      });
      expect(result.canExecute).toBe(true);
      expect(result.executingProductType).toBe("MYRAA_MOBILE");
    });

    it("FAILS mobile.alarm when requested from MYRAA_DESKTOP with no bridge", () => {
      const result = registry.resolveExecutor({
        capability: "mobile.alarm",
        requestingDeviceId: "desktop-1",
        requestingProductType: "MYRAA_DESKTOP",
      });
      expect(result.canExecute).toBe(false);
      expect(result.bridgeRequired).toBe(true);
      expect(result.bridgeTargetProduct).toBe("MYRAA_MOBILE");
    });
  });

  describe("RemoteBridge state management", () => {
    it("bridge is INACTIVE by default", () => {
      const status = registry.getBridgeStatus("phone-1");
      expect(status.state).toBe("INACTIVE");
      expect(status.targetDeviceId).toBeNull();
    });

    it("activateBridge sets state to ACTIVE", () => {
      registry.activateBridge("phone-1", "desktop-1");
      const status = registry.getBridgeStatus("phone-1");
      expect(status.state).toBe("ACTIVE");
      expect(status.targetDeviceId).toBe("desktop-1");
    });

    it("deactivateBridge resets to INACTIVE", () => {
      registry.activateBridge("phone-1", "desktop-1");
      registry.deactivateBridge("phone-1");
      const status = registry.getBridgeStatus("phone-1");
      expect(status.state).toBe("INACTIVE");
      expect(status.targetDeviceId).toBeNull();
    });
  });

  describe("ProductType inference", () => {
    it("infers MYRAA_DESKTOP from desktop_client deviceType", () => {
      expect(registry.inferProductType({ deviceType: "desktop_client" })).toBe("MYRAA_DESKTOP");
    });

    it("infers MYRAA_DESKTOP from electron user-agent", () => {
      expect(registry.inferProductType({ deviceType: "browser", userAgent: "Electron/30 Chrome/122" })).toBe("MYRAA_DESKTOP");
    });

    it("infers MYRAA_MOBILE from mobile deviceType", () => {
      expect(registry.inferProductType({ deviceType: "mobile" })).toBe("MYRAA_MOBILE");
    });

    it("infers MYRAA_MOBILE from Android user-agent", () => {
      expect(registry.inferProductType({ deviceType: "browser", userAgent: "Android 14 MYRAA/1.0" })).toBe("MYRAA_MOBILE");
    });

    it("defaults to MYRAA_BROWSER for unknown", () => {
      expect(registry.inferProductType({ deviceType: "browser" })).toBe("MYRAA_BROWSER");
    });
  });
});

// ---------------------------------------------------------------------------
// 2. AndroidCapabilityEngine — standalone, no desktop dependency
// ---------------------------------------------------------------------------

describe("AndroidCapabilityEngine (standalone — no desktop needed)", () => {
  const engine = new AndroidCapabilityEngine();
  const ctx = makeContext("MYRAA_MOBILE");

  it("productType is MYRAA_MOBILE", () => {
    expect(engine.productType).toBe("MYRAA_MOBILE");
  });

  it("can execute mobile-local capabilities", () => {
    expect(engine.canExecute("mobile.openApp")).toBe(true);
    expect(engine.canExecute("mobile.alarm")).toBe(true);
    expect(engine.canExecute("mobile.timer")).toBe(true);
    expect(engine.canExecute("mobile.reminder")).toBe(true);
    expect(engine.canExecute("mobile.calendar")).toBe(true);
    expect(engine.canExecute("mobile.notes")).toBe(true);
  });

  it("can execute shared-cloud capabilities", () => {
    expect(engine.canExecute("youtube.search")).toBe(true);
    expect(engine.canExecute("youtube.play")).toBe(true);
    expect(engine.canExecute("browser.openUrl")).toBe(true);
  });

  it("CANNOT execute desktop-local capabilities", () => {
    expect(engine.canExecute("desktop.openApplication")).toBe(false);
    expect(engine.canExecute("desktop.readFile")).toBe(false);
    expect(engine.canExecute("desktop.runCommand")).toBe(false);
  });

  it("opens app with resolved package ID", async () => {
    const result = await engine.execute("mobile.openApp", { appName: "youtube" }, ctx);
    expect(result.success).toBe(true);
    expect(result.payload?.packageId).toBe("com.google.android.youtube");
  });

  it("sets alarm with time and label", async () => {
    const result = await engine.execute("mobile.alarm", { time: "7:30 AM", label: "Wake up" }, ctx);
    expect(result.success).toBe(true);
    expect(result.message).toContain("7:30 AM");
    expect(result.payload?.intentAction).toBe("android.intent.action.SET_ALARM");
  });

  it("sets timer", async () => {
    const result = await engine.execute("mobile.timer", { duration: "5 minutes", label: "Tea" }, ctx);
    expect(result.success).toBe(true);
    expect(result.payload?.intentAction).toBe("android.intent.action.SET_TIMER");
  });

  it("returns error when app name missing", async () => {
    const result = await engine.execute("mobile.openApp", {}, ctx);
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("MISSING_ARG_APP_NAME");
  });

  it("returns bridgeRequired when desktop capability requested", async () => {
    const result = await engine.execute("desktop.openApplication", { appName: "vscode" }, ctx);
    expect(result.success).toBe(false);
    expect(result.bridgeRequired).toBe(true);
    expect(result.bridgeTargetProduct).toBe("MYRAA_DESKTOP");
  });

  it("searches YouTube", async () => {
    const result = await engine.execute("youtube.search", { query: "Arijit Singh songs" }, ctx);
    expect(result.success).toBe(true);
    expect(result.payload?.action).toBe("YOUTUBE_SEARCH");
    expect(result.payload?.query).toBe("Arijit Singh songs");
  });
});

// ---------------------------------------------------------------------------
// 3. DesktopCapabilityEngine — standalone, no phone dependency
// ---------------------------------------------------------------------------

describe("DesktopCapabilityEngine (standalone — no phone needed)", () => {
  const engine = new DesktopCapabilityEngine();
  const ctx = makeContext("MYRAA_DESKTOP", "desktop-1");

  it("productType is MYRAA_DESKTOP", () => {
    expect(engine.productType).toBe("MYRAA_DESKTOP");
  });

  it("can execute desktop-local capabilities", () => {
    expect(engine.canExecute("desktop.openApplication")).toBe(true);
    expect(engine.canExecute("desktop.readFile")).toBe(true);
    expect(engine.canExecute("desktop.modifyFile")).toBe(true);
    expect(engine.canExecute("desktop.runCommand")).toBe(true);
    expect(engine.canExecute("desktop.codeInspect")).toBe(true);
  });

  it("can execute shared-cloud capabilities", () => {
    expect(engine.canExecute("youtube.search")).toBe(true);
    expect(engine.canExecute("browser.openUrl")).toBe(true);
  });

  it("CANNOT execute mobile-local capabilities", () => {
    expect(engine.canExecute("mobile.alarm")).toBe(false);
    expect(engine.canExecute("mobile.openApp")).toBe(false);
    expect(engine.canExecute("mobile.calendar")).toBe(false);
  });

  it("opens VS Code with resolved executable path", async () => {
    const result = await engine.execute("desktop.openApplication", { appName: "vscode" }, ctx);
    expect(result.success).toBe(true);
    expect(result.payload?.executable).toBe("D:/Microsoft VS Code/Code.exe");
  });

  it("opens app with unknown executable (still succeeds)", async () => {
    const result = await engine.execute("desktop.openApplication", { appName: "myapp" }, ctx);
    expect(result.success).toBe(true);
    expect(result.payload?.executable).toBe("myapp");
  });

  it("returns error when app name missing", async () => {
    const result = await engine.execute("desktop.openApplication", {}, ctx);
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("MISSING_ARG_APP_NAME");
  });

  it("reads a file", async () => {
    const result = await engine.execute("desktop.readFile", { filePath: "D:/SORA AI/Sora AI/src/App.tsx" }, ctx);
    expect(result.success).toBe(true);
    expect(result.payload?.action).toBe("READ_FILE");
    expect(result.payload?.filePath).toContain("App.tsx");
  });

  it("runs a command", async () => {
    const result = await engine.execute("desktop.runCommand", { command: "echo hello" }, ctx);
    expect(result.success).toBe(true);
    expect(result.payload?.action).toBe("RUN_COMMAND");
    expect(result.payload?.shell).toBe("powershell");
  });

  it("returns bridgeRequired when mobile capability requested", async () => {
    const result = await engine.execute("mobile.alarm", { time: "7 AM" }, ctx);
    expect(result.success).toBe(false);
    expect(result.bridgeRequired).toBe(true);
    expect(result.bridgeTargetProduct).toBe("MYRAA_MOBILE");
  });
});

// ---------------------------------------------------------------------------
// 4. RemoteBridge — INACTIVE by default, NEVER auto-activates
// ---------------------------------------------------------------------------

describe("RemoteBridge", () => {
  let registry: DeviceRegistry;
  let bridge: RemoteBridge;

  beforeEach(() => {
    registry = new DeviceRegistry();
    // RemoteBridge uses the singleton deviceRegistry, so we need to test the class
    // with its internal references. We test bridge state through registry.
  });

  it("bridge is INACTIVE by default for any deviceId", () => {
    const freshRegistry = new DeviceRegistry();
    const status = freshRegistry.getBridgeStatus("any-device");
    expect(status.state).toBe("INACTIVE");
    expect(status.targetDeviceId).toBeNull();
    expect(status.activatedAt).toBeNull();
  });

  it("bridge does NOT auto-activate when two devices share same account", () => {
    const freshRegistry = new DeviceRegistry();
    // Register both devices with same accountId
    freshRegistry.registerDevice(makeDeviceIdentity({ deviceId: "phone-1", productType: "MYRAA_MOBILE", accountId: "user-123" }));
    freshRegistry.registerDevice(makeDeviceIdentity({ deviceId: "desktop-1", productType: "MYRAA_DESKTOP", accountId: "user-123" }));
    // Bridge must still be INACTIVE — same account does NOT auto-connect
    expect(freshRegistry.getBridgeStatus("phone-1").state).toBe("INACTIVE");
    expect(freshRegistry.getBridgeStatus("desktop-1").state).toBe("INACTIVE");
  });

  it("bridge activates ONLY via explicit activateBridge() call", () => {
    const freshRegistry = new DeviceRegistry();
    freshRegistry.registerDevice(makeDeviceIdentity({ deviceId: "phone-1", productType: "MYRAA_MOBILE" }));
    freshRegistry.registerDevice(makeDeviceIdentity({ deviceId: "desktop-1", productType: "MYRAA_DESKTOP" }));

    expect(freshRegistry.getBridgeStatus("phone-1").state).toBe("INACTIVE");

    // Explicit activation
    freshRegistry.activateBridge("phone-1", "desktop-1");

    expect(freshRegistry.getBridgeStatus("phone-1").state).toBe("ACTIVE");
    expect(freshRegistry.getBridgeStatus("phone-1").targetDeviceId).toBe("desktop-1");
  });

  it("deactivating bridge returns to INACTIVE", () => {
    const freshRegistry = new DeviceRegistry();
    freshRegistry.activateBridge("phone-1", "desktop-1");
    freshRegistry.deactivateBridge("phone-1");
    expect(freshRegistry.getBridgeStatus("phone-1").state).toBe("INACTIVE");
  });
});
