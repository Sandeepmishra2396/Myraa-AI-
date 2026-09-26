/**
 * MYRAA — device/index.ts
 *
 * Barrel export for the multi-device architecture layer.
 *
 * Re-exports:
 *   - DeviceTypes  — canonical types (ProductType, CapabilityScope, etc.)
 *   - DeviceRegistry — central device identity + capability routing
 *   - AndroidCapabilityEngine — MYRAA Mobile phone-local engine
 *   - DesktopCapabilityEngine — MYRAA Desktop Windows-local engine
 *   - RemoteBridge — OPTIONAL explicit cross-device bridge
 *
 * Startup registration:
 *   Both engines are registered with the deviceRegistry singleton at import time,
 *   so any module that imports from this barrel gets a fully wired registry.
 */

export type {
  ProductType,
  CapabilityScope,
  DeviceIdentity,
  ProductCapabilityEngine,
  DeviceExecutionContext,
  DeviceCapabilityResult,
  BridgeState,
  RemoteBridgeStatus,
} from "./DeviceTypes.ts";

export { deviceRegistry } from "./DeviceRegistry.ts";
export { androidCapabilityEngine, AndroidCapabilityEngine } from "./AndroidCapabilityEngine.ts";
export { desktopCapabilityEngine, DesktopCapabilityEngine } from "./DesktopCapabilityEngine.ts";
export { remoteBridge, RemoteBridge, BRIDGE_ACTIVATION_PHRASES, BRIDGE_DEACTIVATION_PHRASES } from "./RemoteBridge.ts";

// ── Auto-register engines with the registry ────────────────────────────────
// This runs once at module import time. Safe to import multiple times (idempotent).

import { deviceRegistry } from "./DeviceRegistry.ts";
import { androidCapabilityEngine } from "./AndroidCapabilityEngine.ts";
import { desktopCapabilityEngine } from "./DesktopCapabilityEngine.ts";

deviceRegistry.registerEngine(androidCapabilityEngine);
deviceRegistry.registerEngine(desktopCapabilityEngine);
