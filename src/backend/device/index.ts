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
export {
  remoteBridge,
  RemoteBridge,
  BRIDGE_ACTIVATION_PHRASES,
  BRIDGE_DEACTIVATION_PHRASES,
  DEFAULT_REMOTE_TIMEOUT_MS,
  DEFAULT_MAX_RETRIES,
  MAX_BOUNDED_RETRIES_LIMIT,
  DEFAULT_INACTIVITY_TIMEOUT_MS,
  PAIRING_CHALLENGE_TTL_MS,
  type AutoDisconnectReason,
  type DiscoveredDeviceRecord,
  type PairingChallengeRecord,
  type RemoteBridgePairingRecord,
  type NegotiatedCapabilityManifest,
  type RemoteExecutionOptions,
  type RemoteExecutionResult,
} from "./RemoteBridge.ts";

export {
  sharedAccountMemoryManager,
  SharedAccountMemoryManager,
  MAX_OFFLINE_QUEUE_SIZE,
  DEVICE_LOCAL_CONTEXT_KEYS,
  type DataScope,
  type SharedItemDomain,
  type DataClassificationDomain,
  type AccountSyncErrorCode,
  type DataScopeClassification,
  type AccountDeviceRegistration,
  type UnifiedAccountRecord,
  type SharedAccountItem,
  type DeviceLocalItem,
  type ConflictResolutionDetail,
  type AccountMutationOperation,
  type AccountSyncMutation,
  type QueuedOfflineMutation,
  type SharedWriteResult,
  type AccountSyncBatchResult,
  type AccountStateSnapshot,
} from "./SharedAccountMemoryManager.ts";

export {
  crossDeviceWorkflowOrchestrator,
  CrossDeviceWorkflowOrchestrator,
  DEFAULT_HANDOFF_TTL_MS,
  MIN_HANDOFF_TTL_MS,
  MAX_HANDOFF_TTL_MS,
  FORBIDDEN_HANDOFF_LOCAL_KEYS,
  type HandoffLifecycleStatus,
  type CrossDeviceHandoffErrorCode,
  type HandoffDeviceEndpoint,
  type HandoffRelevantContext,
  type HandoffPendingActionSpec,
  type HandoffWorkflowStep,
  type HandoffFinalResult,
  type HandoffContext,
  type StepCustomExecutor,
  type HandoffOperationOutcome,
} from "./CrossDeviceWorkflowOrchestrator.ts";

export {
  productionUxController,
  ProductionUxController,
  type VoiceUiPhase,
  type UxTargetSelectorOption,
  type MobileOnboardingStepId,
  type MobilePermissionKey,
  type MobilePermissionItem,
  type MobileOnboardingState,
  type TargetSelectorEntry,
  type UxActionableError,
  type UxVoiceTurnRecord,
  type MobilePrivacyControlsState,
  type MobileSettingsState,
  type UxMemorySeparationView,
  type DesktopProjectWorkflowTracker,
  type DesktopActiveContextView,
  type UxCapabilityCatalogItem,
  type DesktopToolsAndCapabilitiesView,
  type RemoteDeviceIdentityCard,
  type RemoteAuditHistoryEntry,
  type RemoteControlCenterView,
  type MobileProductionUxView,
  type DesktopProductionUxView,
} from "./ProductionUxController.ts";

// ── Auto-register engines with the registry ────────────────────────────────
// This runs once at module import time. Safe to import multiple times (idempotent).

import { deviceRegistry } from "./DeviceRegistry.ts";
import { androidCapabilityEngine } from "./AndroidCapabilityEngine.ts";
import { desktopCapabilityEngine } from "./DesktopCapabilityEngine.ts";

deviceRegistry.registerEngine(androidCapabilityEngine);
deviceRegistry.registerEngine(desktopCapabilityEngine);
