/**
 * MYRAA — CapabilityAwarenessEngine
 *
 * Evaluates capability support, device readiness, authorization, and constraints
 * for candidate actions.
 */

import { capabilityRegistry } from "../orchestrator/CapabilityRegistry.ts";
import { securityPolicyEngine } from "../security/SecurityPolicyEngine.ts";
import type { CapabilityAssessment, FusedContext, ResolvedGoal } from "./IntelligenceTypes.ts";
import type { TargetDevice } from "../orchestrator/OrchestratorTypes.ts";
import type { SecurityContext, RiskLevel } from "../security/SecurityTypes.ts";

export class CapabilityAwarenessEngine {
  /**
   * Assess capability readiness for a given tool and target device.
   */
  public assessCapability(
    toolName: string,
    args: Record<string, unknown>,
    targetDevice: TargetDevice,
    context: FusedContext,
    secContext?: SecurityContext
  ): CapabilityAssessment {
    const callerSec: SecurityContext = secContext || {
      identityId: "local-user",
      role: "admin",
      isLocal: true,
      deviceId: "local-desktop",
      ipAddress: "127.0.0.1",
    };

    const targetAvailability = capabilityRegistry.verifyTargetDeviceAvailability(targetDevice, callerSec);
    const authDecision = capabilityRegistry.authorizeCapability(toolName, toolName, args, callerSec, targetDevice);

    const constraints: string[] = [];
    if (!targetAvailability.available) {
      constraints.push(`Target device '${targetDevice}' is unavailable: ${targetAvailability.reason}`);
    }

    if (securityPolicyEngine.getMode() === "LOCKDOWN") {
      constraints.push("Security Lockdown is active: privileged tools are suspended.");
    }

    // Path boundaries check
    const pathArg = (args?.path || args?.filePath || args?.cwd) as string | undefined;
    if (pathArg && typeof pathArg === "string") {
      if (pathArg.includes("..") && !pathArg.startsWith("D:") && !pathArg.startsWith("C:")) {
        constraints.push("Path contains suspicious relative directory traversal.");
      }
    }

    const riskLevel: RiskLevel = authDecision.riskLevel || "LOW";
    const confirmationRequired = authDecision.confirmationRequired || riskLevel === "HIGH" || riskLevel === "CRITICAL";

    return {
      targetDevice,
      deviceOnline: targetAvailability.available,
      capabilitySupported: authDecision.authorized && targetAvailability.available,
      toolName,
      requiredRole: authDecision.permissionRequired || "standard",
      isAuthorized: authDecision.authorized,
      riskLevel,
      confirmationRequired,
      constraints,
    };
  }

  /**
   * Get all capabilities available in the current system state.
   */
  public getAvailableCapabilities(): string[] {
    return [
      "desktop.openApplication",
      "desktop.closeApplication",
      "desktop.openFile",
      "desktop.openFolder",
      "desktop.modifyFile",
      "desktop.createFile",
      "desktop.runShellCommand",
      "desktop.runPythonScript",
      "youtube.search",
      "youtube.play",
      "youtube.pause",
      "youtube.resume",
      "browser.open",
      "browser.mediaControl",
      "code.inspect",
      "code.runTests",
      "code.compare",
    ];
  }
}

export const capabilityAwarenessEngine = new CapabilityAwarenessEngine();
