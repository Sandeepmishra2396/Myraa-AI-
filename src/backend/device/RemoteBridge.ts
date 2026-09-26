/**
 * MYRAA — RemoteBridge
 *
 * OPTIONAL cross-device bridge between MYRAA Mobile and MYRAA Desktop.
 *
 * CRITICAL DESIGN RULE:
 *   - Bridge is INACTIVE by default.
 *   - Bridge NEVER auto-activates on login, session start, or account match.
 *   - Bridge is ONLY activated when the user EXPLICITLY says so:
 *       e.g. "phone se desktop connect karo"
 *       or   "connect to my desktop"
 *       or   opens Settings → Remote Bridge → Enable
 *   - Same account ≠ automatic remote connection.
 *
 * Responsibilities:
 *   - Tracks bridge activation state per device pair
 *   - Delegates cross-device tool execution to RemoteSessionManager
 *   - Provides clean error messages when bridge is inactive but user needs cross-device capability
 *   - Wraps RemoteSessionManager.executeOnDesktopCompanion() for phone→desktop calls
 *
 * Security:
 *   - All cross-device calls still go through SecurityPolicyEngine + EmergencyStopCoordinator
 *     (enforced inside RemoteSessionManager.executeOnDesktopCompanion())
 *   - Bridge activation itself requires explicit user command (not silent)
 */

import { deviceRegistry } from "./DeviceRegistry.ts";
import { remoteSessionManager } from "../remote/RemoteSessionManager.ts";
import type { BridgeState, ProductType, RemoteBridgeStatus } from "./DeviceTypes.ts";

// ---------------------------------------------------------------------------
// Bridge Activation Trigger Phrases
// Used by IntentResolver to detect explicit bridge activation intent
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
// RemoteBridge
// ---------------------------------------------------------------------------

export class RemoteBridge {

  /**
   * Check if the RemoteBridge is active for the given source device.
   * Returns false if bridge is not explicitly activated.
   */
  isActive(sourceDeviceId: string): boolean {
    const status = deviceRegistry.getBridgeStatus(sourceDeviceId);
    return status.state === "ACTIVE";
  }

  /**
   * Get the current bridge status for a source device.
   */
  getStatus(sourceDeviceId: string): RemoteBridgeStatus {
    return deviceRegistry.getBridgeStatus(sourceDeviceId);
  }

  /**
   * Activate the bridge between sourceDevice and targetDevice.
   * MUST only be called when user explicitly requests cross-device connection.
   *
   * If targetDeviceId is not provided, attempts to find an active connected
   * desktop companion via RemoteSessionManager.
   */
  async activate(
    sourceDeviceId: string,
    targetDeviceId?: string,
  ): Promise<{ success: boolean; message: string; targetDeviceId?: string }> {
    // Attempt to find the target device if not specified
    const resolvedTargetId = targetDeviceId
      ?? this._findConnectedDesktopId()
      ?? this._findConnectedMobileId();

    if (!resolvedTargetId) {
      const sourceDevice = deviceRegistry.getDevice(sourceDeviceId);
      const sourceProduct = sourceDevice?.productType ?? "MYRAA_BROWSER";

      const targetHint = sourceProduct === "MYRAA_MOBILE"
        ? "MYRAA Desktop app is not currently running. Please open MYRAA on your PC first."
        : "MYRAA Mobile app is not currently connected. Please open MYRAA on your phone first.";

      return {
        success: false,
        message: `Remote Bridge: ${targetHint}`,
      };
    }

    deviceRegistry.activateBridge(sourceDeviceId, resolvedTargetId);

    return {
      success: true,
      message: "Remote Bridge activated. You can now control your other device.",
      targetDeviceId: resolvedTargetId,
    };
  }

  /**
   * Deactivate the bridge for a source device.
   */
  deactivate(sourceDeviceId: string): { message: string } {
    deviceRegistry.deactivateBridge(sourceDeviceId);
    return { message: "Remote Bridge deactivated. Devices are now operating independently." };
  }

  /**
   * Execute a capability on the remote device through the bridge.
   *
   * Only call this if:
   *   1. The capability is remote-bridged or desktop-local (requested from phone)
   *   2. isActive(sourceDeviceId) === true
   *
   * Internally delegates to RemoteSessionManager.executeOnDesktopCompanion()
   * which enforces SecurityPolicyEngine + EmergencyStopCoordinator checks.
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
  }> {
    const status = deviceRegistry.getBridgeStatus(sourceDeviceId);

    if (status.state !== "ACTIVE") {
      return {
        success: false,
        message: "Remote Bridge is not active. Please activate it first.",
        errorCode: "BRIDGE_INACTIVE",
      };
    }

    if (targetProductType === "MYRAA_DESKTOP") {
      // Map capability to desktop tool name
      const toolName = this._capabilityToDesktopTool(capability);
      const result = await remoteSessionManager.executeOnDesktopCompanion(toolName, args);

      if (!result.ok) {
        // If desktop companion disconnected, mark bridge as error
        if (result.error?.includes("not currently connected") || result.error?.includes("DEVICE_REVOKED")) {
          deviceRegistry.setBridgeError(sourceDeviceId, result.error || "Desktop disconnected");
        }
        return {
          success: false,
          message: result.error ?? "Remote execution failed.",
          errorCode: "REMOTE_EXECUTION_FAILED",
          payload: { result },
        };
      }

      return {
        success: true,
        message: `Remote capability '${capability}' executed on desktop.`,
        payload: { result: result.result },
      };
    }

    // Mobile-to-mobile or other targets — future implementation
    return {
      success: false,
      message: `Remote execution to ${targetProductType} not yet implemented.`,
      errorCode: "NOT_IMPLEMENTED",
    };
  }

  /**
   * Returns a user-friendly message explaining that a capability needs bridge activation.
   * Used by CapabilityRegistry and IntentCapabilityOrchestrator when bridge is inactive
   * but user attempts a cross-device capability.
   */
  buildBridgeRequiredMessage(
    capability: string,
    targetProduct: ProductType,
    sourceProduct: ProductType,
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

  /**
   * Find an active desktop companion session from RemoteSessionManager.
   * Returns deviceId if found, null otherwise.
   */
  private _findConnectedDesktopId(): string | null {
    const companion = remoteSessionManager.getActiveDesktopCompanion();
    return companion?.session.deviceId ?? null;
  }

  /**
   * Find an active mobile session from RemoteSessionManager.
   */
  private _findConnectedMobileId(): string | null {
    const sessions = remoteSessionManager.getActiveSessions();
    const mobileSession = sessions.find((s) => {
      const ua = (s.userAgent || "").toLowerCase();
      return ua.includes("android") || ua.includes("iphone") || ua.includes("ipad");
    });
    return mobileSession?.deviceId ?? null;
  }

  /**
   * Map a canonical capability name to the desktop_agent tool name.
   */
  private _capabilityToDesktopTool(capability: string): string {
    const toolMap: Record<string, string> = {
      "desktop.openApplication":     "openApplication",
      "desktop.closeApplication":    "closeApplication",
      "desktop.openFile":            "openFile",
      "desktop.openFolder":          "openFolder",
      "desktop.readFile":            "readFile",
      "desktop.modifyFile":          "writeCodeFile",
      "desktop.deleteFile":          "deleteFile",
      "desktop.runCommand":          "runShellCommand",
      "desktop.screenshot":          "takeScreenshot",
      "desktop.codeInspect":         "readFile",
      "remote.openApplicationOnDesktop": "openApplication",
      "remote.readFileFromDesktop":      "readFile",
      "remote.runCommandOnDesktop":      "runShellCommand",
      "remote.screenshotDesktop":        "takeScreenshot",
    };
    return toolMap[capability] ?? capability;
  }

  resetForTesting(): void {
    // Bridge state is in DeviceRegistry — call deviceRegistry.resetForTesting()
  }
}

export const remoteBridge = new RemoteBridge();
