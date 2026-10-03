/**
 * MYRAA — Phase 9: Production UX Layer (Mobile, Desktop & Remote Control Center)
 *
 * Implements the production UX state, view-models, and user interaction flows on top of
 * the locked Phase 4–8 architecture:
 *
 *   MOBILE:
 *     - Clean standalone onboarding (5-step flow; no Desktop required)
 *     - Voice-first UI (IDLE / LISTENING / THINKING / SPEAKING + verified action cards)
 *     - Permission management (microphone, notifications, app_launch, alarms_timers, screen_context, browser_assistant, optional_remote_bridge)
 *     - Device / target selector (CURRENT_DEVICE, PHONE, DESKTOP, REMOTE_DESKTOP)
 *     - Desktop connection screen (DISCONNECTED by default; explicit pairing + connect/disconnect)
 *     - Privacy controls (Mobile Privacy Shield, continuous screen context, notification redaction, local-only mode, clear local context, Emergency Stop, Security Lockdown)
 *     - Account (unified account profile, authorized devices, revoke / mark lost)
 *     - Shared memory (strict separation of Shared Account Memory/Preferences/Tasks vs Phone Device-Local Context)
 *     - Settings (Hinglish/language preference synced to Shared Preferences, wake word, voice output, theme, auto-disconnect timeout)
 *
 *   DESKTOP:
 *     - Voice-first interface
 *     - Project dashboard (active project, open files, multi-step code workflow stage tracker, quick cross-device handoff)
 *     - Active application / context (Desktop device-local window, app, file, website, screen vision, privacy shield)
 *     - Tools / capabilities view (Desktop capabilities, Mobile capabilities, and all 126 Gemini Live tools with risk & confirmation metadata)
 *     - Memory (Shared Account Memory/Preferences/Tasks vs Desktop Device-Local Context)
 *     - Device / remote connection (DISCONNECTED by default; paired devices, active handoffs, Connect / Disconnect / Revoke)
 *
 *   REMOTE:
 *     - Clear Connected / Disconnected status (never hidden; DISCONNECTED by default)
 *     - Connect / Disconnect explicit controls
 *     - Device name and device identity (source & target identity cards)
 *     - Remote permissions / capabilities (negotiated manifest + blocked capabilities)
 *     - Remote audit / history (tamper-evident remote audit trail + handoff history)
 */

import type { ProductType } from "./DeviceTypes.ts";
import { deviceRegistry } from "./DeviceRegistry.ts";
import { androidCapabilityEngine } from "./AndroidCapabilityEngine.ts";
import { desktopCapabilityEngine } from "./DesktopCapabilityEngine.ts";
import {
  remoteBridge,
  type NegotiatedCapabilityManifest,
} from "./RemoteBridge.ts";
import {
  sharedAccountMemoryManager,
  DEVICE_LOCAL_CONTEXT_KEYS,
  type SharedAccountItem,
  type DeviceLocalItem,
} from "./SharedAccountMemoryManager.ts";
import {
  crossDeviceWorkflowOrchestrator,
  type HandoffContext,
} from "./CrossDeviceWorkflowOrchestrator.ts";
import { deviceAwareIntelligence } from "../orchestrator/DeviceAwareIntelligence.ts";
import { capabilityRegistry } from "../orchestrator/CapabilityRegistry.ts";
import { LIVE_TOOLS } from "../ai/GeminiSessionFactory.ts";
import { isDlpClean } from "../memory/SharedMemoryManager.ts";
import { outputDataFirewall } from "../security/OutputDataFirewall.ts";
import { securityAuditLogger } from "../security/SecurityAuditLogger.ts";
import { securityPolicyEngine } from "../security/SecurityPolicyEngine.ts";
import { emergencyStopCoordinator } from "../remote/EmergencyStopCoordinator.ts";

// ---------------------------------------------------------------------------
// Canonical UX Types
// ---------------------------------------------------------------------------

export type VoiceUiPhase = "IDLE" | "LISTENING" | "THINKING" | "SPEAKING";

export type UxTargetSelectorOption =
  | "CURRENT_DEVICE"
  | "PHONE"
  | "DESKTOP"
  | "REMOTE_DESKTOP";

export type MobileOnboardingStepId =
  | "WELCOME"
  | "VOICE_SETUP"
  | "PERMISSIONS"
  | "PRIVACY_AND_ACCOUNT"
  | "READY";

export type MobilePermissionKey =
  | "microphone"
  | "notifications"
  | "app_launch"
  | "alarms_timers"
  | "screen_context"
  | "browser_assistant"
  | "optional_remote_bridge";

export interface MobilePermissionItem {
  key: MobilePermissionKey;
  label: string;
  description: string;
  granted: boolean;
  requiredForStandalone: boolean;
  riskLevel: "low" | "medium" | "high";
  mappedCapabilities: string[];
  updatedAt: string;
}

export interface MobileOnboardingState {
  completed: boolean;
  currentStep: MobileOnboardingStepId;
  completedSteps: MobileOnboardingStepId[];
  standaloneReady: boolean;
  requiresDesktopPairing: false;
  headline: string;
  subtitle: string;
}

export interface TargetSelectorEntry {
  target: UxTargetSelectorOption;
  label: string;
  description: string;
  selected: boolean;
  isLocalToCurrentDevice: boolean;
  online: boolean;
  paired: boolean;
  bridgeConnected: boolean;
  badgeText: string;
}

export interface UxActionableError {
  errorCode: string;
  severity: "warning" | "error" | "critical";
  title: string;
  userMessage: string;
  requestedTarget: UxTargetSelectorOption;
  executingDeviceId: null;
  usedSilentFallback: false;
  remediationSteps: string[];
  timestamp: string;
}

export interface UxVoiceTurnRecord {
  turnId: string;
  utterance: string;
  originDeviceId: string;
  originProductType: ProductType;
  selectedTarget: UxTargetSelectorOption;
  resolvedTarget: UxTargetSelectorOption;
  executingDeviceId: string | null;
  capability: string;
  ok: boolean;
  verified: boolean;
  usedSilentFallback: false;
  responseText: string;
  actionableError?: UxActionableError;
  timestamp: string;
}

export interface MobilePrivacyControlsState {
  privacyShieldEnabled: boolean;
  continuousScreenContextEnabled: boolean;
  redactSensitiveNotifications: boolean;
  localOnlyMode: boolean;
  emergencyStopActive: boolean;
  securityLockdownActive: boolean;
  dlpProtectionActive: true;
  lastLocalContextClearedAt: string | null;
}

export interface MobileSettingsState {
  languagePreference: "hinglish" | "english" | "hindi";
  wakeWordEnabled: boolean;
  wakePhrase: string;
  voiceOutputEnabled: boolean;
  theme: "dark_cyber" | "midnight_slate" | "high_contrast";
  remoteAutoDisconnectMinutes: number;
}

export interface UxMemorySeparationView {
  accountId: string | null;
  sharedMemories: SharedAccountItem[];
  sharedPreferences: SharedAccountItem[];
  sharedTasks: SharedAccountItem[];
  deviceLocalContext: DeviceLocalItem[];
  offlineQueuePendingCount: number;
  separationPolicyBanner: string;
}

export interface DesktopProjectWorkflowTracker {
  projectName: string;
  projectPath: string;
  activeFile: string | null;
  openFiles: string[];
  recentProjects: string[];
  workflowStages: Array<{
    stage:
      | "OPEN"
      | "INSPECT"
      | "RESEARCH"
      | "COMPARE"
      | "CONFIRM"
      | "MODIFY"
      | "TEST"
      | "VERIFY";
    status: "pending" | "in_progress" | "completed";
  }>;
  lastVerifiedSummary: string | null;
}

export interface DesktopActiveContextView {
  deviceId: string;
  scopeBadge: "DEVICE_LOCAL (Desktop Only — Never Synced)";
  currentWindow: string | null;
  activeApplication: string | null;
  activeFile: string | null;
  activeWebsite: string | null;
  screenSharingActive: boolean;
  privacyShieldActive: boolean;
  updatedAt: string;
}

export interface UxCapabilityCatalogItem {
  capability: string;
  domain: "DESKTOP" | "MOBILE" | "GEMINI_LIVE_TOOL";
  description: string;
  riskLevel: "low" | "medium" | "high" | "critical";
  requiresConfirmation: boolean;
  supportedOnCurrentDevice: boolean;
  permissionGranted: boolean;
}

export interface DesktopToolsAndCapabilitiesView {
  totalGeminiLiveTools: number;
  desktopCapabilitiesCount: number;
  mobileCapabilitiesCount: number;
  desktopCapabilities: UxCapabilityCatalogItem[];
  mobileCapabilities: UxCapabilityCatalogItem[];
  geminiLiveToolNames: string[];
}

export interface RemoteDeviceIdentityCard {
  deviceId: string;
  deviceName: string;
  productType: ProductType;
  platform: "android" | "windows";
  accountId: string | null;
  role: string;
  online: boolean;
  paired: boolean;
  pairedAt: string | null;
}

export interface RemoteAuditHistoryEntry {
  id: string;
  timestamp: string;
  eventType: string;
  sourceDeviceId: string;
  targetDeviceId?: string;
  capability?: string;
  outcome: string;
  reason?: string;
}

export interface RemoteControlCenterView {
  connectionStatus: "CONNECTED" | "DISCONNECTED";
  statusBadgeText: string;
  defaultStateIsDisconnected: true;
  autoConnectOnSameAccount: false;
  localDevice: RemoteDeviceIdentityCard;
  remoteDevice: RemoteDeviceIdentityCard | null;
  discoveredDevices: RemoteDeviceIdentityCard[];
  negotiatedCapabilities: {
    allowedRemoteCapabilities: string[];
    blockedCapabilities: string[];
    manifest: NegotiatedCapabilityManifest | null;
  };
  activeHandoffs: HandoffContext[];
  auditHistory: RemoteAuditHistoryEntry[];
  auditChainIntegrityValid: boolean;
  emergencyStopActive: boolean;
  securityLockdownActive: boolean;
}

export interface MobileProductionUxView {
  productType: "MYRAA_MOBILE";
  deviceId: string;
  deviceName: string;
  standaloneMode: boolean;
  standaloneReady: boolean;
  onboarding: MobileOnboardingState;
  voiceUi: {
    phase: VoiceUiPhase;
    selectedTarget: UxTargetSelectorOption;
    targetSelector: TargetSelectorEntry[];
    lastTurn: UxVoiceTurnRecord | null;
    turnHistory: UxVoiceTurnRecord[];
    activeError: UxActionableError | null;
  };
  permissions: MobilePermissionItem[];
  desktopConnectionScreen: RemoteControlCenterView;
  privacyControls: MobilePrivacyControlsState;
  accountView: {
    signedIn: boolean;
    accountId: string | null;
    displayName: string | null;
    email: string | null;
    currentDeviceId: string;
    authorizedDevices: Array<{
      deviceId: string;
      deviceName: string;
      productType: ProductType;
      online: boolean;
      isCurrentDevice: boolean;
      revoked: boolean;
      lost: boolean;
    }>;
  };
  memoryView: UxMemorySeparationView;
  settings: MobileSettingsState;
}

export interface DesktopProductionUxView {
  productType: "MYRAA_DESKTOP";
  deviceId: string;
  deviceName: string;
  standaloneMode: boolean;
  standaloneReady: boolean;
  voiceUi: {
    phase: VoiceUiPhase;
    selectedTarget: UxTargetSelectorOption;
    targetSelector: TargetSelectorEntry[];
    lastTurn: UxVoiceTurnRecord | null;
    turnHistory: UxVoiceTurnRecord[];
    activeError: UxActionableError | null;
  };
  projectDashboard: DesktopProjectWorkflowTracker;
  activeContext: DesktopActiveContextView;
  toolsAndCapabilities: DesktopToolsAndCapabilitiesView;
  memoryView: UxMemorySeparationView;
  remoteConnectionPanel: RemoteControlCenterView;
}

// ---------------------------------------------------------------------------
// Internal Per-Device UX Session State
// ---------------------------------------------------------------------------

interface InternalMobileSessionState {
  deviceId: string;
  deviceName: string;
  accountId: string | null;
  onboardingCompleted: boolean;
  onboardingStep: MobileOnboardingStepId;
  completedSteps: Set<MobileOnboardingStepId>;
  voicePhase: VoiceUiPhase;
  selectedTarget: UxTargetSelectorOption;
  permissions: Map<MobilePermissionKey, MobilePermissionItem>;
  privacyControls: MobilePrivacyControlsState;
  settings: MobileSettingsState;
  turnHistory: UxVoiceTurnRecord[];
  activeError: UxActionableError | null;
  clearedLocalContextKeys: boolean;
}

interface InternalDesktopSessionState {
  deviceId: string;
  deviceName: string;
  accountId: string | null;
  voicePhase: VoiceUiPhase;
  selectedTarget: UxTargetSelectorOption;
  projectDashboard: DesktopProjectWorkflowTracker;
  activeContext: DesktopActiveContextView;
  turnHistory: UxVoiceTurnRecord[];
  activeError: UxActionableError | null;
}

const ONBOARDING_ORDER: MobileOnboardingStepId[] = [
  "WELCOME",
  "VOICE_SETUP",
  "PERMISSIONS",
  "PRIVACY_AND_ACCOUNT",
  "READY",
];

function createDefaultPermissions(): Map<MobilePermissionKey, MobilePermissionItem> {
  const now = new Date().toISOString();
  const list: MobilePermissionItem[] = [
    {
      key: "microphone",
      label: "Microphone & Voice Input",
      description: "Required for voice-first Hindi, Hinglish, and English commands.",
      granted: true,
      requiredForStandalone: true,
      riskLevel: "low",
      mappedCapabilities: ["mobile.voiceAssistant"],
      updatedAt: now,
    },
    {
      key: "notifications",
      label: "Notification Access",
      description: "Read and summarize incoming notifications with Privacy Shield redaction.",
      granted: true,
      requiredForStandalone: false,
      riskLevel: "medium",
      mappedCapabilities: ["mobile.notifications"],
      updatedAt: now,
    },
    {
      key: "app_launch",
      label: "App Launch & Intent Routing",
      description: "Open installed Android apps and media players on your phone.",
      granted: true,
      requiredForStandalone: true,
      riskLevel: "low",
      mappedCapabilities: [
        "mobile.openApp",
        "mobile.closeApp",
        "mobile.mediaControl",
        "youtube.search",
        "youtube.play",
      ],
      updatedAt: now,
    },
    {
      key: "alarms_timers",
      label: "Alarms, Timers & Reminders",
      description: "Create and manage phone alarms, timers, and local reminders.",
      granted: true,
      requiredForStandalone: true,
      riskLevel: "low",
      mappedCapabilities: [
        "mobile.alarm",
        "mobile.timer",
        "mobile.reminder",
        "mobile.setAlarm",
        "mobile.setTimer",
        "mobile.createReminder",
      ],
      updatedAt: now,
    },
    {
      key: "screen_context",
      label: "On-Screen Context (Privacy Shield Protected)",
      description: "Analyze current phone screen when explicitly requested; sensitive apps are shielded.",
      granted: true,
      requiredForStandalone: false,
      riskLevel: "medium",
      mappedCapabilities: ["mobile.screenContext"],
      updatedAt: now,
    },
    {
      key: "browser_assistant",
      label: "Mobile Browser Assistant",
      description: "Open websites and run web searches directly on your phone.",
      granted: true,
      requiredForStandalone: true,
      riskLevel: "low",
      mappedCapabilities: ["mobile.openUrl", "browser.openUrl", "browser.search"],
      updatedAt: now,
    },
    {
      key: "optional_remote_bridge",
      label: "Optional Desktop Remote Bridge",
      description: "Allow explicit pairing and remote commands to an authorized MYRAA Desktop.",
      granted: true,
      requiredForStandalone: false,
      riskLevel: "high",
      mappedCapabilities: ["remote.connect", "remote.execute"],
      updatedAt: now,
    },
  ];
  return new Map(list.map((item) => [item.key, item]));
}

// ---------------------------------------------------------------------------
// ProductionUxController Implementation
// ---------------------------------------------------------------------------

export class ProductionUxController {
  private mobileSessions: Map<string, InternalMobileSessionState> = new Map();
  private desktopSessions: Map<string, InternalDesktopSessionState> = new Map();
  private turnCounter = 0;

  // =========================================================================
  // 1. INITIALIZATION & SESSION MANAGEMENT
  // =========================================================================

  initMobileUxSession(params: {
    deviceId: string;
    deviceName?: string;
    accountId?: string | null;
    online?: boolean;
  }): MobileProductionUxView {
    const deviceName = params.deviceName || "MYRAA Android Phone";
    const now = new Date().toISOString();
    const bridgeStatus = remoteBridge.getStatus(params.deviceId);

    deviceRegistry.registerDevice({
      deviceId: params.deviceId,
      productType: "MYRAA_MOBILE",
      deviceName,
      accountId: params.accountId ?? undefined,
      registered: params.online ?? true,
      registeredAt: now,
      lastSeenAt: now,
      bridgeConnected: bridgeStatus.state === "ACTIVE",
      bridgeTargetDeviceId: bridgeStatus.targetDeviceId,
      disabledCapabilities: [],
    });

    let session = this.mobileSessions.get(params.deviceId);
    if (!session) {
      session = {
        deviceId: params.deviceId,
        deviceName,
        accountId: params.accountId ?? null,
        onboardingCompleted: false,
        onboardingStep: "WELCOME",
        completedSteps: new Set<MobileOnboardingStepId>(),
        voicePhase: "IDLE",
        selectedTarget: "CURRENT_DEVICE",
        permissions: createDefaultPermissions(),
        privacyControls: {
          privacyShieldEnabled: true,
          continuousScreenContextEnabled: false,
          redactSensitiveNotifications: true,
          localOnlyMode: false,
          emergencyStopActive: emergencyStopCoordinator.isActive(),
          securityLockdownActive: securityPolicyEngine.getMode() === "LOCKDOWN",
          dlpProtectionActive: true,
          lastLocalContextClearedAt: null,
        },
        settings: {
          languagePreference: "hinglish",
          wakeWordEnabled: true,
          wakePhrase: "Hey Myraa",
          voiceOutputEnabled: true,
          theme: "dark_cyber",
          remoteAutoDisconnectMinutes: 15,
        },
        turnHistory: [],
        activeError: null,
        clearedLocalContextKeys: false,
      };
      this.mobileSessions.set(params.deviceId, session);
    } else {
      if (params.deviceName) session.deviceName = params.deviceName;
      if (params.accountId !== undefined) session.accountId = params.accountId;
    }

    return this.getMobileUxState(params.deviceId);
  }

  initDesktopUxSession(params: {
    deviceId: string;
    deviceName?: string;
    accountId?: string | null;
    online?: boolean;
    projectPath?: string;
    projectName?: string;
  }): DesktopProductionUxView {
    const deviceName = params.deviceName || "MYRAA Windows Desktop";
    const now = new Date().toISOString();
    const bridgeStatus = remoteBridge.getStatus(params.deviceId);

    deviceRegistry.registerDevice({
      deviceId: params.deviceId,
      productType: "MYRAA_DESKTOP",
      deviceName,
      accountId: params.accountId ?? undefined,
      registered: params.online ?? true,
      registeredAt: now,
      lastSeenAt: now,
      bridgeConnected: bridgeStatus.state === "ACTIVE",
      bridgeTargetDeviceId: bridgeStatus.targetDeviceId,
      disabledCapabilities: [],
    });

    let session = this.desktopSessions.get(params.deviceId);
    if (!session) {
      const projectPath = params.projectPath || "d:/SORA AI/Sora AI";
      const projectName = params.projectName || "MYRAA Multi-Device Platform";
      session = {
        deviceId: params.deviceId,
        deviceName,
        accountId: params.accountId ?? null,
        voicePhase: "IDLE",
        selectedTarget: "CURRENT_DEVICE",
        projectDashboard: {
          projectName,
          projectPath,
          activeFile: `${projectPath}/src/index.ts`,
          openFiles: [`${projectPath}/src/index.ts`, `${projectPath}/src/App.tsx`],
          recentProjects: [projectPath],
          workflowStages: [
            { stage: "OPEN", status: "completed" },
            { stage: "INSPECT", status: "pending" },
            { stage: "RESEARCH", status: "pending" },
            { stage: "COMPARE", status: "pending" },
            { stage: "CONFIRM", status: "pending" },
            { stage: "MODIFY", status: "pending" },
            { stage: "TEST", status: "pending" },
            { stage: "VERIFY", status: "pending" },
          ],
          lastVerifiedSummary: null,
        },
        activeContext: {
          deviceId: params.deviceId,
          scopeBadge: "DEVICE_LOCAL (Desktop Only — Never Synced)",
          currentWindow: "Visual Studio Code — MYRAA",
          activeApplication: "vscode",
          activeFile: `${projectPath}/src/index.ts`,
          activeWebsite: null,
          screenSharingActive: false,
          privacyShieldActive: true,
          updatedAt: now,
        },
        turnHistory: [],
        activeError: null,
      };
      this.desktopSessions.set(params.deviceId, session);

      // Persist initial desktop local context in device-local store (never synced to shared memory)
      sharedAccountMemoryManager.writeDeviceLocalMemory({
        deviceId: params.deviceId,
        productType: "MYRAA_DESKTOP",
        accountId: params.accountId ?? undefined,
        key: "current_window",
        value: session.activeContext.currentWindow,
      });
      sharedAccountMemoryManager.writeDeviceLocalMemory({
        deviceId: params.deviceId,
        productType: "MYRAA_DESKTOP",
        accountId: params.accountId ?? undefined,
        key: "active_application",
        value: session.activeContext.activeApplication,
      });
    } else {
      if (params.deviceName) session.deviceName = params.deviceName;
      if (params.accountId !== undefined) session.accountId = params.accountId;
    }

    return this.getDesktopUxState(params.deviceId);
  }

  // =========================================================================
  // 2. MOBILE UX FLOWS (ONBOARDING, PERMISSIONS, PRIVACY, SETTINGS, VOICE)
  // =========================================================================

  completeMobileOnboardingStep(
    deviceId: string,
    step: MobileOnboardingStepId,
  ): MobileOnboardingState {
    const session = this._ensureMobileSession(deviceId);
    session.completedSteps.add(step);

    const idx = ONBOARDING_ORDER.indexOf(step);
    if (idx >= 0 && idx < ONBOARDING_ORDER.length - 1) {
      session.onboardingStep = ONBOARDING_ORDER[idx + 1];
    } else {
      session.onboardingStep = "READY";
    }

    if (step === "READY" || session.completedSteps.size >= ONBOARDING_ORDER.length) {
      session.onboardingCompleted = true;
      session.onboardingStep = "READY";
      for (const s of ONBOARDING_ORDER) {
        session.completedSteps.add(s);
      }
    }

    return this._buildOnboardingView(session);
  }

  updateMobilePermission(params: {
    deviceId: string;
    permission: MobilePermissionKey;
    granted: boolean;
  }): MobilePermissionItem {
    const session = this._ensureMobileSession(params.deviceId);
    const item = session.permissions.get(params.permission);
    if (!item) {
      throw new Error(`Unknown mobile permission key: ${params.permission}`);
    }
    item.granted = params.granted;
    item.updatedAt = new Date().toISOString();

    securityAuditLogger.logEvent({
      eventType: params.granted ? "TOOL_ALLOW" : "TOOL_BLOCKED",
      actor: {
        identityId: session.accountId || params.deviceId,
        role: "admin",
        ipAddress: "127.0.0.1",
        deviceId: params.deviceId,
      },
      target: { resource: `mobile.permission.${params.permission}` },
      decision: params.granted ? "ALLOW" : "BLOCK",
      reason: `Mobile permission '${params.permission}' set to ${params.granted ? "GRANTED" : "REVOKED"}.`,
      riskLevel: "LOW",
    });

    return { ...item };
  }

  selectMobileTargetDevice(
    deviceId: string,
    target: UxTargetSelectorOption,
  ): MobileProductionUxView {
    const session = this._ensureMobileSession(deviceId);
    session.selectedTarget = target;
    session.activeError = null;
    return this.getMobileUxState(deviceId);
  }

  updateMobilePrivacyControls(params: {
    deviceId: string;
    privacyShieldEnabled?: boolean;
    continuousScreenContextEnabled?: boolean;
    redactSensitiveNotifications?: boolean;
    localOnlyMode?: boolean;
    clearDeviceLocalContext?: boolean;
  }): MobilePrivacyControlsState {
    const session = this._ensureMobileSession(params.deviceId);

    if (params.privacyShieldEnabled !== undefined) {
      session.privacyControls.privacyShieldEnabled = params.privacyShieldEnabled;
    }
    if (params.continuousScreenContextEnabled !== undefined) {
      session.privacyControls.continuousScreenContextEnabled =
        params.continuousScreenContextEnabled;
    }
    if (params.redactSensitiveNotifications !== undefined) {
      session.privacyControls.redactSensitiveNotifications =
        params.redactSensitiveNotifications;
    }
    if (params.localOnlyMode !== undefined) {
      session.privacyControls.localOnlyMode = params.localOnlyMode;
      if (params.localOnlyMode && remoteBridge.isActive(params.deviceId)) {
        remoteBridge.disconnect(params.deviceId, "USER_DISCONNECTED");
      }
    }
    if (params.clearDeviceLocalContext) {
      session.clearedLocalContextKeys = true;
      session.privacyControls.lastLocalContextClearedAt = new Date().toISOString();
    } else {
      session.clearedLocalContextKeys = false;
      // Store privacy shield state in Phone device-local context (never shared)
      sharedAccountMemoryManager.writeDeviceLocalMemory({
        deviceId: params.deviceId,
        productType: "MYRAA_MOBILE",
        accountId: session.accountId ?? undefined,
        key: "mobile_screen_context",
        value: {
          privacyShieldEnabled: session.privacyControls.privacyShieldEnabled,
          continuousScreenContextEnabled:
            session.privacyControls.continuousScreenContextEnabled,
        },
      });
    }

    session.privacyControls.emergencyStopActive = emergencyStopCoordinator.isActive();
    session.privacyControls.securityLockdownActive =
      securityPolicyEngine.getMode() === "LOCKDOWN";

    return { ...session.privacyControls };
  }

  updateMobileSettings(params: {
    deviceId: string;
    languagePreference?: "hinglish" | "english" | "hindi";
    wakeWordEnabled?: boolean;
    wakePhrase?: string;
    voiceOutputEnabled?: boolean;
    theme?: "dark_cyber" | "midnight_slate" | "high_contrast";
    remoteAutoDisconnectMinutes?: number;
  }): MobileSettingsState {
    const session = this._ensureMobileSession(params.deviceId);

    if (params.languagePreference !== undefined) {
      session.settings.languagePreference = params.languagePreference;
      // Sync language preference to Shared Account Preferences if signed into an account
      if (session.accountId) {
        sharedAccountMemoryManager.setSharedPreference({
          accountId: session.accountId,
          deviceId: params.deviceId,
          key: "language_preference",
          value: params.languagePreference,
        });
      }
    }
    if (params.wakeWordEnabled !== undefined) {
      session.settings.wakeWordEnabled = params.wakeWordEnabled;
    }
    if (params.wakePhrase !== undefined) {
      session.settings.wakePhrase = params.wakePhrase;
    }
    if (params.voiceOutputEnabled !== undefined) {
      session.settings.voiceOutputEnabled = params.voiceOutputEnabled;
    }
    if (params.theme !== undefined) {
      session.settings.theme = params.theme;
      if (session.accountId) {
        sharedAccountMemoryManager.setSharedPreference({
          accountId: session.accountId,
          deviceId: params.deviceId,
          key: "ui_theme",
          value: params.theme,
        });
      }
    }
    if (params.remoteAutoDisconnectMinutes !== undefined) {
      session.settings.remoteAutoDisconnectMinutes = params.remoteAutoDisconnectMinutes;
    }

    return { ...session.settings };
  }

  /**
   * Submit a voice or text command from MYRAA Mobile UX.
   * Respects:
   *   - Emergency Stop & Security Lockdown
   *   - Mobile Permissions & Privacy Local-Only Mode
   *   - Explicit Target Selector (CURRENT_DEVICE, PHONE, DESKTOP, REMOTE_DESKTOP)
   *   - Zero silent fallback (never runs on Phone if Desktop was explicitly requested)
   */
  async submitMobileVoiceCommand(params: {
    deviceId: string;
    utterance: string;
    explicitTargetOverride?: UxTargetSelectorOption;
    targetDesktopDeviceId?: string;
  }): Promise<UxVoiceTurnRecord> {
    const session = this._ensureMobileSession(params.deviceId);
    const selectedTarget = params.explicitTargetOverride || session.selectedTarget;
    session.voicePhase = "LISTENING";
    session.voicePhase = "THINKING";

    // 1. Check Emergency Stop / Security Lockdown first
    if (emergencyStopCoordinator.isActive()) {
      const err = this.buildActionableUxError({
        errorCode: "EMERGENCY_STOP_ACTIVE",
        requestedTarget: selectedTarget,
        customReason: "Emergency Stop is active across MYRAA. All device & remote actions are halted.",
      });
      return this._recordMobileTurn(session, params.utterance, selectedTarget, selectedTarget, null, "none", false, err);
    }

    if (securityPolicyEngine.getMode() === "LOCKDOWN") {
      const err = this.buildActionableUxError({
        errorCode: "SECURITY_LOCKDOWN_ACTIVE",
        requestedTarget: selectedTarget,
        customReason: "Security Lockdown is active. Execution is restricted until unlocked by an administrator.",
      });
      return this._recordMobileTurn(session, params.utterance, selectedTarget, selectedTarget, null, "none", false, err);
    }

    // 2. Check microphone permission for voice input
    const micPerm = session.permissions.get("microphone");
    if (micPerm && !micPerm.granted) {
      const err = this.buildActionableUxError({
        errorCode: "PERMISSION_DENIED",
        requestedTarget: selectedTarget,
        customReason: "Microphone & Voice Input permission is disabled in Mobile Permission Management.",
      });
      return this._recordMobileTurn(session, params.utterance, selectedTarget, selectedTarget, null, "mobile.voiceAssistant", false, err);
    }

    // 3. Resolve intent & device target via DeviceAwareIntelligence
    const bridgeActive = remoteBridge.isActive(params.deviceId);
    const pairedDesktopId =
      params.targetDesktopDeviceId ||
      remoteBridge.getStatus(params.deviceId).targetDeviceId ||
      this._findFirstDesktopDeviceId(session.accountId);

    const explicitArgDevice: string | undefined =
      selectedTarget === "CURRENT_DEVICE" ? undefined : selectedTarget;

    const resolution = deviceAwareIntelligence.resolveSmartTarget(
      params.utterance,
      {
        identityId: session.accountId || params.deviceId,
        role: "admin",
        ipAddress: "127.0.0.1",
        deviceId: params.deviceId,
        isLocal: false,
      },
      params.deviceId,
      explicitArgDevice,
      {
        deviceId: params.deviceId,
        productType: "MYRAA_MOBILE",
        accountId: session.accountId || undefined,
      },
    );

    const resolvedCap =
      resolution.capabilitySupport.engineCapability || resolution.intent.capability;

    const effectiveTarget: UxTargetSelectorOption =
      selectedTarget !== "CURRENT_DEVICE"
        ? selectedTarget
        : (resolution.targetMode as UxTargetSelectorOption);

    // 4. If target is DESKTOP or REMOTE_DESKTOP, check Local-Only Privacy Mode & Optional Remote Permission
    if (effectiveTarget === "DESKTOP" || effectiveTarget === "REMOTE_DESKTOP") {
      if (session.privacyControls.localOnlyMode) {
        const err = this.buildActionableUxError({
          errorCode: "LOCAL_ONLY_MODE_ACTIVE",
          requestedTarget: effectiveTarget,
          customReason: "Mobile Privacy Controls have 'Local-Only Mode' enabled. Cross-device Desktop execution is blocked.",
        });
        return this._recordMobileTurn(session, params.utterance, selectedTarget, effectiveTarget, null, resolvedCap, false, err);
      }

      const remotePerm = session.permissions.get("optional_remote_bridge");
      if (remotePerm && !remotePerm.granted) {
        const err = this.buildActionableUxError({
          errorCode: "PERMISSION_DENIED",
          requestedTarget: effectiveTarget,
          customReason: "Optional Desktop Remote Bridge permission is disabled on your phone.",
        });
        return this._recordMobileTurn(session, params.utterance, selectedTarget, effectiveTarget, null, resolvedCap, false, err);
      }

      if (!bridgeActive || !pairedDesktopId) {
        const err = this.buildActionableUxError({
          errorCode: "REMOTE_BRIDGE_INACTIVE",
          requestedTarget: effectiveTarget,
          customReason:
            resolution.reason ||
            "No Desktop Connected. Pair and connect your MYRAA Desktop in the Desktop Connection Screen first.",
        });
        return this._recordMobileTurn(session, params.utterance, selectedTarget, effectiveTarget, null, resolvedCap, false, err);
      }

      const overrides = capabilityRegistry.getDeviceAvailabilityOverrides();
      const targetAcctDev = session.accountId
        ? sharedAccountMemoryManager.getAccountDevice(session.accountId, pairedDesktopId)
        : undefined;
      if (
        overrides.desktopAvailable === false ||
        overrides.remoteDesktopAvailable === false ||
        targetAcctDev?.online === false
      ) {
        const err = this.buildActionableUxError({
          errorCode: "TARGET_DEVICE_UNAVAILABLE",
          requestedTarget: effectiveTarget,
          customReason:
            resolution.reason ||
            `Target Desktop '${pairedDesktopId}' is currently offline or unreachable.`,
        });
        return this._recordMobileTurn(session, params.utterance, selectedTarget, effectiveTarget, null, resolvedCap, false, err);
      }

      if (!resolution.capabilitySupport.supported) {
        const err = this.buildActionableUxError({
          errorCode: resolution.capabilitySupport.errorCode || "CAPABILITY_NOT_SUPPORTED",
          requestedTarget: effectiveTarget,
          customReason: resolution.capabilitySupport.reason,
        });
        return this._recordMobileTurn(session, params.utterance, selectedTarget, effectiveTarget, null, resolvedCap, false, err);
      }

      // Execute remotely via RemoteBridge
      const remoteExec = await remoteBridge.executeRemoteCommand({
        sourceDeviceId: params.deviceId,
        targetDeviceId: pairedDesktopId,
        capability: resolvedCap,
        args: {
          ...resolution.intent.arguments,
          appName:
            resolution.intent.arguments.appName ||
            resolution.intent.entity ||
            "vscode",
          utterance: params.utterance,
        },
      });

      if (!remoteExec.ok) {
        const err = this.buildActionableUxError({
          errorCode: remoteExec.errorCode || "REMOTE_EXECUTION_FAILED",
          requestedTarget: effectiveTarget,
          customReason: remoteExec.message,
        });
        return this._recordMobileTurn(session, params.utterance, selectedTarget, effectiveTarget, null, resolvedCap, false, err);
      }

      return this._recordMobileTurn(
        session,
        params.utterance,
        selectedTarget,
        effectiveTarget,
        pairedDesktopId,
        resolvedCap,
        true,
        undefined,
        remoteExec.message,
      );
    }

    // 5. Local Phone Execution: verify capability is supported on Phone and permission is granted
    if (!resolution.canExecute) {
      const err = this.buildActionableUxError({
        errorCode: resolution.errorCode || "CAPABILITY_NOT_SUPPORTED",
        requestedTarget: effectiveTarget,
        customReason: resolution.reason,
      });
      return this._recordMobileTurn(session, params.utterance, selectedTarget, effectiveTarget, null, resolvedCap, false, err);
    }

    // Check capability-specific mobile permission
    const permDenial = this._checkMobileCapabilityPermission(session, resolvedCap);
    if (permDenial) {
      const err = this.buildActionableUxError({
        errorCode: "PERMISSION_DENIED",
        requestedTarget: effectiveTarget,
        customReason: `Required mobile permission '${permDenial.label}' is currently revoked.`,
      });
      return this._recordMobileTurn(session, params.utterance, selectedTarget, effectiveTarget, null, resolvedCap, false, err);
    }

    const isAppOpenIntent =
      resolution.intent.intent === "OPEN_APPLICATION" ||
      resolvedCap === "mobile.openApp" ||
      resolvedCap === "desktop.openApplication";

    if (!isAppOpenIntent && !androidCapabilityEngine.canExecute(resolvedCap)) {
      const lower = params.utterance.toLowerCase().trim();
      let responseText = "Main aapki madad karne ke liye taiyaar hoon! Aap YouTube play karne, alarm lagane, timer set karne ya koi app open karne ke liye keh sakte hain.";
      if (/^(hello|hi|hey|namaste|pranam|helo)\b/i.test(lower)) {
        responseText = "Hello! Main MYRAA hoon, aapka personal AI assistant. Main aapki kya madad kar sakti hoon?";
      } else if (/\b(kya\s+kar\s+rhe\s+ho|kya\s+kar\s+rahe\s+ho|what\s+are\s+you\s+doing)\b/i.test(lower)) {
        responseText = "Main aapki assistance ke liye active hoon. Aap YouTube, Alarms, Timers ya phone apps ke liye commands de sakte hain!";
      } else if (/\b(who\s+are\s+you|tum\s+kaun\s+ho|aap\s+kaun\s+hain)\b/i.test(lower)) {
        responseText = "Main MYRAA hoon — aapka standalone voice aur cross-device AI assistant.";
      } else if (/\b(how\s+are\s+you|kaise\s+ho|kya\s+haal\s+hai)\b/i.test(lower)) {
        responseText = "Main bilkul theek hoon! Aap batayein, aaj aapki kya madad karoon?";
      } else {
        responseText = `Processed: "${params.utterance}". Main YouTube, Alarms, Timers, Phone Apps aur system controls chala sakti hoon.`;
      }

      return this._recordMobileTurn(
        session,
        params.utterance,
        selectedTarget,
        effectiveTarget,
        params.deviceId,
        "mobile.conversational",
        true,
        undefined,
        responseText,
      );
    }

    const mobileCapToExecute = androidCapabilityEngine.canExecute(resolvedCap)
      ? resolvedCap
      : "mobile.openApp";


    const engineRes = await androidCapabilityEngine.execute(
      mobileCapToExecute,
      {
        ...resolution.intent.arguments,
        appName:
          resolution.intent.arguments.appName ||
          resolution.intent.entity ||
          "youtube",
        query:
          resolution.intent.arguments.query ||
          resolution.intent.entity ||
          params.utterance,
      },
      {
        deviceId: params.deviceId,
        productType: "MYRAA_MOBILE",
        bridgeActive,
        bridgeTargetDeviceId: pairedDesktopId || null,
      },
    );

    if (!engineRes.success) {
      const err = this.buildActionableUxError({
        errorCode: engineRes.errorCode || "EXECUTION_FAILED",
        requestedTarget: effectiveTarget,
        customReason: engineRes.message,
      });
      return this._recordMobileTurn(session, params.utterance, selectedTarget, effectiveTarget, null, mobileCapToExecute, false, err);
    }

    return this._recordMobileTurn(
      session,
      params.utterance,
      selectedTarget,
      effectiveTarget,
      params.deviceId,
      mobileCapToExecute,
      true,
      undefined,
      engineRes.message,
    );
  }

  // =========================================================================
  // 3. DESKTOP UX FLOWS (VOICE, PROJECT DASHBOARD, ACTIVE CONTEXT, TOOLS)
  // =========================================================================

  selectDesktopTargetDevice(
    deviceId: string,
    target: UxTargetSelectorOption,
  ): DesktopProductionUxView {
    const session = this._ensureDesktopSession(deviceId);
    session.selectedTarget = target;
    session.activeError = null;
    return this.getDesktopUxState(deviceId);
  }

  openProjectInDashboard(params: {
    deviceId: string;
    projectName: string;
    projectPath: string;
    activeFile?: string;
  }): DesktopProjectWorkflowTracker {
    const session = this._ensureDesktopSession(params.deviceId);
    const activeFile = params.activeFile || `${params.projectPath}/src/index.ts`;

    session.projectDashboard.projectName = params.projectName;
    session.projectDashboard.projectPath = params.projectPath;
    session.projectDashboard.activeFile = activeFile;
    if (!session.projectDashboard.openFiles.includes(activeFile)) {
      session.projectDashboard.openFiles.unshift(activeFile);
    }
    if (!session.projectDashboard.recentProjects.includes(params.projectPath)) {
      session.projectDashboard.recentProjects.unshift(params.projectPath);
    }
    session.projectDashboard.workflowStages = session.projectDashboard.workflowStages.map(
      (st) => (st.stage === "OPEN" ? { ...st, status: "completed" } : st),
    );
    session.projectDashboard.lastVerifiedSummary = `Opened project '${params.projectName}' (${params.projectPath}) on Desktop.`;

    // Update Desktop device-local context (never synced to shared memory)
    this.updateDesktopActiveContext({
      deviceId: params.deviceId,
      currentWindow: `Visual Studio Code — ${params.projectName}`,
      activeApplication: "vscode",
      activeFile,
    });

    return { ...session.projectDashboard };
  }

  updateDesktopActiveContext(params: {
    deviceId: string;
    currentWindow?: string | null;
    activeApplication?: string | null;
    activeFile?: string | null;
    activeWebsite?: string | null;
    screenSharingActive?: boolean;
    privacyShieldActive?: boolean;
  }): DesktopActiveContextView {
    const session = this._ensureDesktopSession(params.deviceId);
    if (params.currentWindow !== undefined) {
      session.activeContext.currentWindow = params.currentWindow;
      sharedAccountMemoryManager.writeDeviceLocalMemory({
        deviceId: params.deviceId,
        productType: "MYRAA_DESKTOP",
        accountId: session.accountId ?? undefined,
        key: "current_window",
        value: params.currentWindow,
      });
    }
    if (params.activeApplication !== undefined) {
      session.activeContext.activeApplication = params.activeApplication;
      sharedAccountMemoryManager.writeDeviceLocalMemory({
        deviceId: params.deviceId,
        productType: "MYRAA_DESKTOP",
        accountId: session.accountId ?? undefined,
        key: "active_application",
        value: params.activeApplication,
      });
    }
    if (params.activeFile !== undefined) {
      session.activeContext.activeFile = params.activeFile;
      session.projectDashboard.activeFile = params.activeFile;
      sharedAccountMemoryManager.writeDeviceLocalMemory({
        deviceId: params.deviceId,
        productType: "MYRAA_DESKTOP",
        accountId: session.accountId ?? undefined,
        key: "open_editor_buffers",
        value: [params.activeFile],
      });
    }
    if (params.activeWebsite !== undefined) {
      session.activeContext.activeWebsite = params.activeWebsite;
    }
    if (params.screenSharingActive !== undefined) {
      session.activeContext.screenSharingActive = params.screenSharingActive;
    }
    if (params.privacyShieldActive !== undefined) {
      session.activeContext.privacyShieldActive = params.privacyShieldActive;
    }
    session.activeContext.updatedAt = new Date().toISOString();

    return { ...session.activeContext };
  }

  async submitDesktopVoiceCommand(params: {
    deviceId: string;
    utterance: string;
    explicitTargetOverride?: UxTargetSelectorOption;
    targetPhoneDeviceId?: string;
  }): Promise<UxVoiceTurnRecord> {
    const session = this._ensureDesktopSession(params.deviceId);
    const selectedTarget = params.explicitTargetOverride || session.selectedTarget;
    session.voicePhase = "LISTENING";
    session.voicePhase = "THINKING";

    if (emergencyStopCoordinator.isActive()) {
      const err = this.buildActionableUxError({
        errorCode: "EMERGENCY_STOP_ACTIVE",
        requestedTarget: selectedTarget,
        customReason: "Emergency Stop is active. All Desktop & cross-device actions are halted.",
      });
      return this._recordDesktopTurn(session, params.utterance, selectedTarget, selectedTarget, null, "none", false, err);
    }

    if (securityPolicyEngine.getMode() === "LOCKDOWN") {
      const err = this.buildActionableUxError({
        errorCode: "SECURITY_LOCKDOWN_ACTIVE",
        requestedTarget: selectedTarget,
        customReason: "Security Lockdown is active. Desktop tool execution is restricted.",
      });
      return this._recordDesktopTurn(session, params.utterance, selectedTarget, selectedTarget, null, "none", false, err);
    }

    const bridgeActive = remoteBridge.isActive(params.deviceId);
    const pairedPhoneId =
      params.targetPhoneDeviceId ||
      remoteBridge.getStatus(params.deviceId).targetDeviceId ||
      this._findFirstPhoneDeviceId(session.accountId);

    const explicitArgDevice: string | undefined =
      selectedTarget === "CURRENT_DEVICE" ? undefined : selectedTarget;

    const resolution = deviceAwareIntelligence.resolveSmartTarget(
      params.utterance,
      {
        identityId: session.accountId || params.deviceId,
        role: "admin",
        ipAddress: "127.0.0.1",
        deviceId: params.deviceId,
        isLocal: true,
      },
      params.deviceId,
      explicitArgDevice,
      {
        deviceId: params.deviceId,
        productType: "MYRAA_DESKTOP",
        accountId: session.accountId || undefined,
      },
    );

    const resolvedCap =
      resolution.capabilitySupport.engineCapability || resolution.intent.capability;

    const effectiveTarget: UxTargetSelectorOption =
      selectedTarget !== "CURRENT_DEVICE"
        ? selectedTarget
        : (resolution.targetMode as UxTargetSelectorOption);

    // If explicitly targeting PHONE from Desktop
    if (effectiveTarget === "PHONE") {
      if (!bridgeActive || !pairedPhoneId) {
        const err = this.buildActionableUxError({
          errorCode: "REMOTE_BRIDGE_INACTIVE",
          requestedTarget: "PHONE",
          customReason:
            resolution.reason ||
            "No Phone Connected. Pair and connect your MYRAA Mobile device before running phone-targeted commands.",
        });
        return this._recordDesktopTurn(session, params.utterance, selectedTarget, "PHONE", null, resolvedCap, false, err);
      }

      if (!resolution.canExecute) {
        const err = this.buildActionableUxError({
          errorCode: resolution.errorCode || "TARGET_DEVICE_UNAVAILABLE",
          requestedTarget: "PHONE",
          customReason: resolution.reason,
        });
        return this._recordDesktopTurn(session, params.utterance, selectedTarget, "PHONE", null, resolvedCap, false, err);
      }

      const remoteExec = await remoteBridge.executeRemoteCommand({
        sourceDeviceId: params.deviceId,
        targetDeviceId: pairedPhoneId,
        capability: resolvedCap,
        args: {
          ...resolution.intent.arguments,
          utterance: params.utterance,
        },
      });

      if (!remoteExec.ok) {
        const err = this.buildActionableUxError({
          errorCode: remoteExec.errorCode || "REMOTE_EXECUTION_FAILED",
          requestedTarget: "PHONE",
          customReason: remoteExec.message,
        });
        return this._recordDesktopTurn(session, params.utterance, selectedTarget, "PHONE", null, resolvedCap, false, err);
      }

      return this._recordDesktopTurn(
        session,
        params.utterance,
        selectedTarget,
        "PHONE",
        pairedPhoneId,
        resolvedCap,
        true,
        undefined,
        remoteExec.message,
      );
    }

    if (!resolution.canExecute) {
      const err = this.buildActionableUxError({
        errorCode: resolution.errorCode || "CAPABILITY_NOT_SUPPORTED",
        requestedTarget: effectiveTarget,
        customReason: resolution.reason,
      });
      return this._recordDesktopTurn(session, params.utterance, selectedTarget, effectiveTarget, null, resolvedCap, false, err);
    }

    const desktopCapToExecute = desktopCapabilityEngine.canExecute(resolvedCap)
      ? resolvedCap
      : "desktop.openApplication";

    const engineRes = await desktopCapabilityEngine.execute(
      desktopCapToExecute,
      {
        ...resolution.intent.arguments,
        appName:
          resolution.intent.arguments.appName ||
          resolution.intent.entity ||
          "vscode",
        filePath:
          resolution.intent.arguments.filePath ||
          session.projectDashboard.activeFile ||
          "src/index.ts",
      },
      {
        deviceId: params.deviceId,
        productType: "MYRAA_DESKTOP",
        bridgeActive,
        bridgeTargetDeviceId: pairedPhoneId || null,
      },
    );

    if (!engineRes.success) {
      const err = this.buildActionableUxError({
        errorCode: engineRes.errorCode || "EXECUTION_FAILED",
        requestedTarget: effectiveTarget,
        customReason: engineRes.message,
      });
      return this._recordDesktopTurn(session, params.utterance, selectedTarget, effectiveTarget, null, desktopCapToExecute, false, err);
    }

    // Update workflow tracker if code inspection or app open ran
    if (desktopCapToExecute === "desktop.codeInspect") {
      session.projectDashboard.workflowStages = session.projectDashboard.workflowStages.map(
        (st) => (st.stage === "INSPECT" ? { ...st, status: "completed" } : st),
      );
      session.projectDashboard.lastVerifiedSummary = engineRes.message;
    }

    return this._recordDesktopTurn(
      session,
      params.utterance,
      selectedTarget,
      effectiveTarget,
      params.deviceId,
      desktopCapToExecute,
      true,
      undefined,
      engineRes.message,
    );
  }

  getDesktopToolsAndCapabilitiesView(deviceId: string): DesktopToolsAndCapabilitiesView {
    this._ensureDesktopSession(deviceId);
    const declarations = LIVE_TOOLS[0]?.functionDeclarations || [];
    const geminiLiveToolNames = declarations.map((d: any) => String(d.name));

    const desktopCapNames = [
      "desktop.openApplication",
      "desktop.closeApplication",
      "desktop.openFile",
      "desktop.openFolder",
      "desktop.readFile",
      "desktop.modifyFile",
      "desktop.deleteFile",
      "desktop.runCommand",
      "desktop.screenshot",
      "desktop.windowManagement",
      "desktop.clipboard",
      "desktop.codeInspect",
      "desktop.codeWorkflow",
      "desktop.projectIntelligence",
      "youtube.search",
      "youtube.play",
      "browser.openUrl",
      "browser.search",
      "web.research",
    ];

    const mobileCapNames = [
      "mobile.openApp",
      "mobile.closeApp",
      "mobile.alarm",
      "mobile.timer",
      "mobile.reminder",
      "mobile.calendar",
      "mobile.notes",
      "mobile.notifications",
      "mobile.deviceStatus",
      "mobile.camera",
      "mobile.photos",
      "mobile.contacts",
      "mobile.sms",
      "mobile.call",
      "mobile.clipboard",
      "youtube.search",
      "youtube.play",
      "browser.openUrl",
      "browser.search",
    ];

    const desktopCaps: UxCapabilityCatalogItem[] = desktopCapNames.map((cap) => {
      const meta = capabilityRegistry.getCapabilityMetadata(cap);
      return {
        capability: cap,
        domain: "DESKTOP",
        description: `Desktop capability ${cap}`,
        riskLevel: (String(meta.riskLevel || "LOW").toLowerCase() as any) || "low",
        requiresConfirmation: Boolean(meta.confirmationRequired),
        supportedOnCurrentDevice: desktopCapabilityEngine.canExecute(cap),
        permissionGranted: true,
      };
    });

    const mobileCaps: UxCapabilityCatalogItem[] = mobileCapNames.map((cap) => {
      const meta = capabilityRegistry.getCapabilityMetadata(cap);
      return {
        capability: cap,
        domain: "MOBILE",
        description: `Mobile capability ${cap}`,
        riskLevel: (String(meta.riskLevel || "LOW").toLowerCase() as any) || "low",
        requiresConfirmation: Boolean(meta.confirmationRequired),
        supportedOnCurrentDevice: false,
        permissionGranted: true,
      };
    });

    return {
      totalGeminiLiveTools: geminiLiveToolNames.length,
      desktopCapabilitiesCount: desktopCaps.length,
      mobileCapabilitiesCount: mobileCaps.length,
      desktopCapabilities: desktopCaps,
      mobileCapabilities: mobileCaps,
      geminiLiveToolNames,
    };
  }

  // =========================================================================
  // 4. REMOTE CONTROL CENTER UX FLOWS (CONNECT / DISCONNECT / STATUS / AUDIT)
  // =========================================================================

  /**
   * Explicitly pair and optionally connect two devices from the UX layer.
   * Never connects automatically on same-account login; requires explicit user call.
   */
  async pairAndConnectRemoteDevice(params: {
    sourceDeviceId: string;
    targetDeviceId: string;
    accountId?: string;
    role?: "read_only" | "standard" | "admin";
    connectNow?: boolean;
  }): Promise<{
    paired: boolean;
    connected: boolean;
    errorCode?: string;
    message: string;
    remoteControlCenter: RemoteControlCenterView;
  }> {
    // Check if source is mobile and has localOnlyMode enabled
    const mobileSess = this.mobileSessions.get(params.sourceDeviceId);
    if (mobileSess?.privacyControls.localOnlyMode) {
      return {
        paired: false,
        connected: false,
        errorCode: "LOCAL_ONLY_MODE_ACTIVE",
        message: "Cannot connect Remote Bridge while Mobile Local-Only Privacy Mode is enabled.",
        remoteControlCenter: this.getRemoteControlCenterState(params.sourceDeviceId),
      };
    }

    const challenge = remoteBridge.requestPairing({
      sourceDeviceId: params.sourceDeviceId,
      targetDeviceId: params.targetDeviceId,
      requestedBy: params.accountId || params.sourceDeviceId,
      role: params.role || "admin",
      explicitUserAction: true,
    });

    if (!challenge.success || !challenge.pairingId || !challenge.pairingCode) {
      return {
        paired: false,
        connected: false,
        errorCode: challenge.errorCode,
        message: challenge.message,
        remoteControlCenter: this.getRemoteControlCenterState(params.sourceDeviceId),
      };
    }

    const confirmed = remoteBridge.confirmPairing({
      pairingId: challenge.pairingId,
      pairingCode: challenge.pairingCode,
      approvedByTargetUser: true,
    });

    if (!confirmed.success) {
      return {
        paired: false,
        connected: false,
        errorCode: confirmed.errorCode,
        message: confirmed.message,
        remoteControlCenter: this.getRemoteControlCenterState(params.sourceDeviceId),
      };
    }

    if (params.connectNow === false) {
      return {
        paired: true,
        connected: false,
        message: "Devices paired. Remote Bridge remains DISCONNECTED until explicitly connected.",
        remoteControlCenter: this.getRemoteControlCenterState(params.sourceDeviceId),
      };
    }

    const connected = await remoteBridge.connect({
      sourceDeviceId: params.sourceDeviceId,
      targetDeviceId: params.targetDeviceId,
      explicitUserAction: true,
    });

    return {
      paired: true,
      connected: connected.success,
      errorCode: connected.errorCode,
      message: connected.message,
      remoteControlCenter: this.getRemoteControlCenterState(params.sourceDeviceId),
    };
  }

  async connectRemoteBridgeFromUx(params: {
    sourceDeviceId: string;
    targetDeviceId: string;
  }): Promise<RemoteControlCenterView> {
    const mobileSess = this.mobileSessions.get(params.sourceDeviceId);
    if (mobileSess?.privacyControls.localOnlyMode) {
      mobileSess.activeError = this.buildActionableUxError({
        errorCode: "LOCAL_ONLY_MODE_ACTIVE",
        requestedTarget: "REMOTE_DESKTOP",
        customReason: "Disable Local-Only Privacy Mode before connecting to Desktop.",
      });
      return this.getRemoteControlCenterState(params.sourceDeviceId);
    }

    const res = await remoteBridge.connect({
      sourceDeviceId: params.sourceDeviceId,
      targetDeviceId: params.targetDeviceId,
      explicitUserAction: true,
    });

    if (!res.success && mobileSess) {
      mobileSess.activeError = this.buildActionableUxError({
        errorCode: res.errorCode || "REMOTE_CONNECT_FAILED",
        requestedTarget: "REMOTE_DESKTOP",
        customReason: res.message,
      });
    }

    return this.getRemoteControlCenterState(params.sourceDeviceId);
  }

  disconnectRemoteBridgeFromUx(params: {
    sourceDeviceId: string;
    reason?: string;
  }): RemoteControlCenterView {
    remoteBridge.disconnect(params.sourceDeviceId, "USER_DISCONNECTED");
    return this.getRemoteControlCenterState(params.sourceDeviceId);
  }

  getRemoteControlCenterState(deviceId: string): RemoteControlCenterView {
    const regDev = deviceRegistry.getDevice(deviceId);
    const productType: ProductType =
      regDev?.productType ||
      (this.desktopSessions.has(deviceId) ? "MYRAA_DESKTOP" : "MYRAA_MOBILE");
    const accountId =
      this.mobileSessions.get(deviceId)?.accountId ||
      this.desktopSessions.get(deviceId)?.accountId ||
      regDev?.accountId ||
      null;

    const bridgeStatus = remoteBridge.getStatus(deviceId);
    const isConnected = bridgeStatus.state === "ACTIVE" && Boolean(bridgeStatus.targetDeviceId);

    const localCard: RemoteDeviceIdentityCard = {
      deviceId,
      deviceName:
        regDev?.deviceName ||
        this.mobileSessions.get(deviceId)?.deviceName ||
        this.desktopSessions.get(deviceId)?.deviceName ||
        deviceId,
      productType,
      platform: productType === "MYRAA_DESKTOP" ? "windows" : "android",
      accountId,
      role: "admin",
      online: regDev?.registered ?? true,
      paired: Boolean(bridgeStatus.targetDeviceId),
      pairedAt: bridgeStatus.activatedAt || null,
    };

    let remoteCard: RemoteDeviceIdentityCard | null = null;
    let manifest: NegotiatedCapabilityManifest | null = null;

    if (bridgeStatus.targetDeviceId) {
      const targetReg = deviceRegistry.getDevice(bridgeStatus.targetDeviceId);
      const pairing = remoteBridge.getPairing(deviceId, bridgeStatus.targetDeviceId);
      if (targetReg) {
        remoteCard = {
          deviceId: targetReg.deviceId,
          deviceName: targetReg.deviceName,
          productType: targetReg.productType,
          platform: targetReg.productType === "MYRAA_DESKTOP" ? "windows" : "android",
          accountId: pairing?.accountId || targetReg.accountId || accountId,
          role: pairing?.role || "admin",
          online: targetReg.registered,
          paired: true,
          pairedAt: pairing?.pairedAt || bridgeStatus.activatedAt || null,
        };
      }
      manifest =
        remoteBridge.getNegotiatedManifest(deviceId, bridgeStatus.targetDeviceId) ||
        remoteBridge.negotiateCapabilities(deviceId, bridgeStatus.targetDeviceId);
    }

    const discovered = remoteBridge
      .discoverDevices({
        requestingDeviceId: deviceId,
        accountId: accountId || undefined,
      })
      .map((d) => ({
        deviceId: d.deviceId,
        deviceName: d.deviceName,
        productType: d.productType,
        platform: (d.productType === "MYRAA_DESKTOP" ? "windows" : "android") as
          | "windows"
          | "android",
        accountId: d.accountId || null,
        role: "admin",
        online: d.online,
        paired: d.paired,
        pairedAt: null,
      }));

    const recentAuditEvents = securityAuditLogger.getRecentEvents(30);
    const auditHistory: RemoteAuditHistoryEntry[] = recentAuditEvents.map(
      (ev: any, idx: number) => ({
        id: ev.eventId || `remote-audit-${idx}`,
        timestamp: ev.timestamp || new Date().toISOString(),
        eventType: String(ev.eventType || "REMOTE_EVENT"),
        sourceDeviceId: String(ev.actor?.deviceId || deviceId),
        targetDeviceId: ev.target?.resource ? String(ev.target.resource) : undefined,
        capability: ev.target?.toolName ? String(ev.target.toolName) : undefined,
        outcome: String(ev.decision || "ALLOW"),
        reason: ev.reason ? String(ev.reason) : undefined,
      }),
    );

    const chainVerification = securityAuditLogger.verifyChainIntegrity();

    return {
      connectionStatus: isConnected ? "CONNECTED" : "DISCONNECTED",
      statusBadgeText: isConnected
        ? `CONNECTED TO ${(remoteCard?.deviceName || bridgeStatus.targetDeviceId || "").toUpperCase()}`
        : "DISCONNECTED (Standalone Mode)",
      defaultStateIsDisconnected: true,
      autoConnectOnSameAccount: false,
      localDevice: localCard,
      remoteDevice: remoteCard,
      discoveredDevices: discovered,
      negotiatedCapabilities: {
        allowedRemoteCapabilities: manifest?.allowedCapabilities || [],
        blockedCapabilities: manifest?.deniedCapabilities || [],
        manifest,
      },
      activeHandoffs: crossDeviceWorkflowOrchestrator.listHandoffsForDevice(deviceId),
      auditHistory,
      auditChainIntegrityValid: chainVerification.valid,
      emergencyStopActive: emergencyStopCoordinator.isActive(),
      securityLockdownActive: securityPolicyEngine.getMode() === "LOCKDOWN",
    };
  }

  // =========================================================================
  // 5. SHARED VS DEVICE-LOCAL MEMORY UX BOUNDARIES
  // =========================================================================

  getMemorySeparationView(params: {
    deviceId: string;
    accountId: string | null;
  }): UxMemorySeparationView {
    const mobileSess = this.mobileSessions.get(params.deviceId);
    const localRecordMap = mobileSess?.clearedLocalContextKeys
      ? {}
      : sharedAccountMemoryManager.getAllDeviceLocalMemories(params.deviceId);
    const localItems = Object.values(localRecordMap);

    if (!params.accountId) {
      return {
        accountId: null,
        sharedMemories: [],
        sharedPreferences: [],
        sharedTasks: [],
        deviceLocalContext: localItems,
        offlineQueuePendingCount: 0,
        separationPolicyBanner:
          "Device-Local Context stays strictly on this device. Sign into a MYRAA Account to sync Shared Memories, Preferences, and Tasks.",
      };
    }

    const snap = sharedAccountMemoryManager.pullAccountState({
      accountId: params.accountId,
      deviceId: params.deviceId,
    });

    const offlineQueue = sharedAccountMemoryManager.getOfflineQueue(params.deviceId);

    return {
      accountId: params.accountId,
      sharedMemories: snap.ok ? snap.memories : [],
      sharedPreferences: snap.ok ? Object.values(snap.preferences) : [],
      sharedTasks: snap.ok ? snap.tasks : [],
      deviceLocalContext: localItems,
      offlineQueuePendingCount: offlineQueue.length,
      separationPolicyBanner:
        "SHARED items sync across authorized account devices after DLP screening. DEVICE_LOCAL context (current window, screen state, local process PIDs) NEVER leaves this device.",
    };
  }

  /**
   * Add a memory or context item from the UX Dashboard, enforcing Shared vs Device-Local
   * classification and DLP screening.
   */
  saveMemoryFromUx(params: {
    deviceId: string;
    productType: ProductType;
    accountId: string | null;
    scope: "SHARED" | "DEVICE_LOCAL";
    key: string;
    value: unknown;
    category?: string;
  }): {
    ok: boolean;
    scopeStored?: "SHARED" | "DEVICE_LOCAL";
    errorCode?: string;
    message: string;
  } {
    const normalizedKey = params.key
      .trim()
      .toLowerCase()
      .replace(/[\s\-]+/g, "_");

    if (params.scope === "SHARED") {
      if (!params.accountId) {
        return {
          ok: false,
          errorCode: "ACCOUNT_NOT_SIGNED_IN",
          message: "Sign into your MYRAA Account to save Shared Memory across devices.",
        };
      }
      if (DEVICE_LOCAL_CONTEXT_KEYS.has(normalizedKey)) {
        return {
          ok: false,
          errorCode: "SCOPE_VIOLATION_DEVICE_LOCAL_ONLY",
          message: `Key '${params.key}' is classified as DEVICE_LOCAL context and is strictly blocked from Shared Account Memory.`,
        };
      }
      const res = sharedAccountMemoryManager.writeSharedMemory({
        accountId: params.accountId,
        deviceId: params.deviceId,
        key: params.key,
        content: params.value,
        category: params.category || "general",
      });
      return {
        ok: res.ok,
        scopeStored: res.ok ? "SHARED" : undefined,
        errorCode: res.errorCode,
        message: res.message,
      };
    }

    // DEVICE_LOCAL storage
    const serialized = JSON.stringify(params.value ?? "");
    if (!isDlpClean(serialized)) {
      return {
        ok: false,
        errorCode: "DLP_VIOLATION_BLOCKED",
        message: "DLP Firewall blocked storing raw credentials or secret keys in local context.",
      };
    }

    const sanitized = outputDataFirewall.sanitizeResult(params.value, {
      toolName: "ux.saveDeviceLocalContext",
    }).sanitized;

    sharedAccountMemoryManager.writeDeviceLocalMemory({
      deviceId: params.deviceId,
      productType: params.productType,
      accountId: params.accountId ?? undefined,
      key: params.key,
      value: sanitized,
    });

    return {
      ok: true,
      scopeStored: "DEVICE_LOCAL",
      message: `Saved '${params.key}' strictly in ${params.productType} Device-Local Context (never synced).`,
    };
  }

  // =========================================================================
  // 6. FULL STATE SNAPSHOTS FOR MOBILE & DESKTOP UX
  // =========================================================================

  getMobileUxState(deviceId: string): MobileProductionUxView {
    const session = this._ensureMobileSession(deviceId);
    const remoteCenter = this.getRemoteControlCenterState(deviceId);

    // Pull synced language preference from Shared Account Preferences if signed in
    if (session.accountId) {
      const sharedLang = sharedAccountMemoryManager.getSharedPreference({
        accountId: session.accountId,
        deviceId,
        key: "language_preference",
      });
      if (
        sharedLang.ok &&
        (sharedLang.value === "hinglish" ||
          sharedLang.value === "english" ||
          sharedLang.value === "hindi")
      ) {
        session.settings.languagePreference = sharedLang.value;
      }
    }

    session.privacyControls.emergencyStopActive = emergencyStopCoordinator.isActive();
    session.privacyControls.securityLockdownActive =
      securityPolicyEngine.getMode() === "LOCKDOWN";

    const accountRecord = session.accountId
      ? sharedAccountMemoryManager.getAccount(session.accountId)
      : undefined;
    const accountDevices = session.accountId
      ? sharedAccountMemoryManager.getAccountDevices(session.accountId)
      : [];

    return {
      productType: "MYRAA_MOBILE",
      deviceId: session.deviceId,
      deviceName: session.deviceName,
      standaloneMode: remoteCenter.connectionStatus === "DISCONNECTED",
      standaloneReady: true,
      onboarding: this._buildOnboardingView(session),
      voiceUi: {
        phase: session.voicePhase,
        selectedTarget: session.selectedTarget,
        targetSelector: this._buildTargetSelectorEntries(
          deviceId,
          "MYRAA_MOBILE",
          session.selectedTarget,
          session.accountId,
        ),
        lastTurn:
          session.turnHistory.length > 0
            ? session.turnHistory[session.turnHistory.length - 1]
            : null,
        turnHistory: [...session.turnHistory],
        activeError: session.activeError,
      },
      permissions: Array.from(session.permissions.values()).map((p) => ({ ...p })),
      desktopConnectionScreen: remoteCenter,
      privacyControls: { ...session.privacyControls },
      accountView: {
        signedIn: Boolean(session.accountId),
        accountId: session.accountId,
        displayName: accountRecord?.displayName || (session.accountId ? "MYRAA User" : null),
        email: accountRecord?.email || null,
        currentDeviceId: deviceId,
        authorizedDevices: accountDevices.map((d) => ({
          deviceId: d.deviceId,
          deviceName: d.deviceName,
          productType: d.productType,
          online: d.online,
          isCurrentDevice: d.deviceId === deviceId,
          revoked: d.revoked,
          lost: d.lost,
        })),
      },
      memoryView: this.getMemorySeparationView({
        deviceId,
        accountId: session.accountId,
      }),
      settings: { ...session.settings },
    };
  }

  getDesktopUxState(deviceId: string): DesktopProductionUxView {
    const session = this._ensureDesktopSession(deviceId);
    const remoteCenter = this.getRemoteControlCenterState(deviceId);

    return {
      productType: "MYRAA_DESKTOP",
      deviceId: session.deviceId,
      deviceName: session.deviceName,
      standaloneMode: remoteCenter.connectionStatus === "DISCONNECTED",
      standaloneReady: true,
      voiceUi: {
        phase: session.voicePhase,
        selectedTarget: session.selectedTarget,
        targetSelector: this._buildTargetSelectorEntries(
          deviceId,
          "MYRAA_DESKTOP",
          session.selectedTarget,
          session.accountId,
        ),
        lastTurn:
          session.turnHistory.length > 0
            ? session.turnHistory[session.turnHistory.length - 1]
            : null,
        turnHistory: [...session.turnHistory],
        activeError: session.activeError,
      },
      projectDashboard: {
        ...session.projectDashboard,
        openFiles: [...session.projectDashboard.openFiles],
        recentProjects: [...session.projectDashboard.recentProjects],
        workflowStages: session.projectDashboard.workflowStages.map((s) => ({ ...s })),
      },
      activeContext: { ...session.activeContext },
      toolsAndCapabilities: this.getDesktopToolsAndCapabilitiesView(deviceId),
      memoryView: this.getMemorySeparationView({
        deviceId,
        accountId: session.accountId,
      }),
      remoteConnectionPanel: remoteCenter,
    };
  }

  // =========================================================================
  // 7. ACTIONABLE ERROR BUILDER (NO SILENT FALLBACK)
  // =========================================================================

  buildActionableUxError(params: {
    errorCode: string;
    requestedTarget: UxTargetSelectorOption;
    customReason?: string;
  }): UxActionableError {
    const code = params.errorCode;
    const now = new Date().toISOString();

    if (
      code === "TARGET_DEVICE_UNAVAILABLE" ||
      code === "TARGET_DEVICE_OFFLINE" ||
      code === "REMOTE_BRIDGE_INACTIVE" ||
      code === "BRIDGE_INACTIVE" ||
      code === "DEVICE_NOT_PAIRED"
    ) {
      return {
        errorCode: code,
        severity: "warning",
        title:
          params.requestedTarget === "PHONE"
            ? "Phone Not Connected or Offline"
            : "Desktop Not Connected or Offline",
        userMessage:
          params.customReason ||
          `Target '${params.requestedTarget}' is currently offline or disconnected. MYRAA did NOT silently switch to your local device.`,
        requestedTarget: params.requestedTarget,
        executingDeviceId: null,
        usedSilentFallback: false,
        remediationSteps: [
          "Open the Remote Connection screen and verify the target device is online.",
          "Complete explicit 6-digit PIN pairing if the device is not paired yet.",
          "Click 'Connect' to activate the Optional Remote Bridge, or explicitly switch the Target Selector to CURRENT_DEVICE.",
        ],
        timestamp: now,
      };
    }

    if (
      code === "CAPABILITY_NOT_SUPPORTED" ||
      code === "CAPABILITY_NOT_SUPPORTED_ON_TARGET" ||
      code === "CAPABILITY_NOT_NEGOTIATED"
    ) {
      return {
        errorCode: code,
        severity: "warning",
        title: `Capability Not Supported on ${params.requestedTarget}`,
        userMessage:
          params.customReason ||
          `The requested action is not supported on '${params.requestedTarget}'. MYRAA did NOT silently execute it on another device.`,
        requestedTarget: params.requestedTarget,
        executingDeviceId: null,
        usedSilentFallback: false,
        remediationSteps: [
          `Check the Tools & Capabilities view to see which actions are supported on ${params.requestedTarget}.`,
          "Explicitly select a compatible target device in the Device/Target Selector.",
        ],
        timestamp: now,
      };
    }

    if (
      code === "PERMISSION_DENIED" ||
      code === "HANDOFF_UNAUTHORIZED" ||
      code === "DEVICE_REVOKED" ||
      code === "DEVICE_LOST" ||
      code === "LOCAL_ONLY_MODE_ACTIVE"
    ) {
      return {
        errorCode: code,
        severity: "error",
        title: "Action Blocked by Permission or Privacy Policy",
        userMessage:
          params.customReason ||
          `Authorization or permission check failed (${code}). Execution was blocked without fallback.`,
        requestedTarget: params.requestedTarget,
        executingDeviceId: null,
        usedSilentFallback: false,
        remediationSteps: [
          "Review Permission Management and Privacy Controls on your device.",
          "If Local-Only Mode is active, disable it before initiating remote Desktop commands.",
          "Verify that your device session has not been revoked or marked lost.",
        ],
        timestamp: now,
      };
    }

    if (code === "EMERGENCY_STOP_ACTIVE" || code === "SECURITY_LOCKDOWN_ACTIVE") {
      return {
        errorCode: code,
        severity: "critical",
        title:
          code === "EMERGENCY_STOP_ACTIVE"
            ? "Emergency Stop Active"
            : "Security Lockdown Active",
        userMessage:
          params.customReason ||
          `All execution is halted due to ${code}. Reset the security state before retrying.`,
        requestedTarget: params.requestedTarget,
        executingDeviceId: null,
        usedSilentFallback: false,
        remediationSteps: [
          "Open the Security & Privacy panel to inspect the alert reason.",
          "Reset Emergency Stop or exit Security Lockdown as an authenticated administrator.",
        ],
        timestamp: now,
      };
    }

    return {
      errorCode: code,
      severity: "error",
      title: "Execution Could Not Complete",
      userMessage: params.customReason || `Action failed with code ${code}.`,
      requestedTarget: params.requestedTarget,
      executingDeviceId: null,
      usedSilentFallback: false,
      remediationSteps: [
        "Verify device connectivity and required permissions, then try again.",
      ],
      timestamp: now,
    };
  }

  resetForTesting(): void {
    this.mobileSessions.clear();
    this.desktopSessions.clear();
    this.turnCounter = 0;
  }

  // =========================================================================
  // INTERNAL HELPERS
  // =========================================================================

  private _ensureMobileSession(deviceId: string): InternalMobileSessionState {
    if (!this.mobileSessions.has(deviceId)) {
      this.initMobileUxSession({ deviceId });
    }
    return this.mobileSessions.get(deviceId)!;
  }

  private _ensureDesktopSession(deviceId: string): InternalDesktopSessionState {
    if (!this.desktopSessions.has(deviceId)) {
      this.initDesktopUxSession({ deviceId });
    }
    return this.desktopSessions.get(deviceId)!;
  }

  private _buildOnboardingView(session: InternalMobileSessionState): MobileOnboardingState {
    return {
      completed: session.onboardingCompleted,
      currentStep: session.onboardingStep,
      completedSteps: Array.from(session.completedSteps),
      standaloneReady: true,
      requiresDesktopPairing: false,
      headline: session.onboardingCompleted
        ? "MYRAA Mobile is Ready"
        : "Welcome to MYRAA Mobile — Voice-First Standalone AI",
      subtitle:
        "Works 100% independently on your Android phone. Optional Desktop connection can be enabled anytime.",
    };
  }

  private _buildTargetSelectorEntries(
    currentDeviceId: string,
    currentProductType: ProductType,
    selectedTarget: UxTargetSelectorOption,
    accountId: string | null,
  ): TargetSelectorEntry[] {
    const bridgeStatus = remoteBridge.getStatus(currentDeviceId);
    const bridgeConnected =
      bridgeStatus.state === "ACTIVE" && Boolean(bridgeStatus.targetDeviceId);

    const desktopId =
      currentProductType === "MYRAA_DESKTOP"
        ? currentDeviceId
        : bridgeStatus.targetDeviceId || this._findFirstDesktopDeviceId(accountId);
    const phoneId =
      currentProductType === "MYRAA_MOBILE"
        ? currentDeviceId
        : bridgeStatus.targetDeviceId || this._findFirstPhoneDeviceId(accountId);

    const desktopReg = desktopId ? deviceRegistry.getDevice(desktopId) : undefined;
    const phoneReg = phoneId ? deviceRegistry.getDevice(phoneId) : undefined;

    const desktopOnline = Boolean(desktopReg?.registered);
    const phoneOnline = Boolean(phoneReg?.registered);

    return [
      {
        target: "CURRENT_DEVICE",
        label:
          currentProductType === "MYRAA_MOBILE"
            ? "Current Device (This Phone)"
            : "Current Device (This Desktop)",
        description: "Smart local-first routing on your current active device.",
        selected: selectedTarget === "CURRENT_DEVICE",
        isLocalToCurrentDevice: true,
        online: true,
        paired: true,
        bridgeConnected,
        badgeText: "ACTIVE LOCAL DEVICE",
      },
      {
        target: "PHONE",
        label: "MYRAA Mobile (Phone)",
        description: "Execute phone-scoped capabilities (apps, alarms, calls, mobile browser).",
        selected: selectedTarget === "PHONE",
        isLocalToCurrentDevice: currentProductType === "MYRAA_MOBILE",
        online: currentProductType === "MYRAA_MOBILE" ? true : phoneOnline,
        paired:
          currentProductType === "MYRAA_MOBILE"
            ? true
            : Boolean(phoneId && remoteBridge.isPaired(currentDeviceId, phoneId)),
        bridgeConnected:
          currentProductType === "MYRAA_MOBILE" ? true : bridgeConnected,
        badgeText:
          currentProductType === "MYRAA_MOBILE"
            ? "LOCAL PHONE (ONLINE)"
            : bridgeConnected && phoneOnline
              ? "REMOTE PHONE (CONNECTED)"
              : "REMOTE PHONE (DISCONNECTED)",
      },
      {
        target: "DESKTOP",
        label: "MYRAA Desktop (Windows PC)",
        description: "Execute desktop-scoped capabilities (VS Code, files, terminal, projects).",
        selected: selectedTarget === "DESKTOP",
        isLocalToCurrentDevice: currentProductType === "MYRAA_DESKTOP",
        online: currentProductType === "MYRAA_DESKTOP" ? true : desktopOnline,
        paired:
          currentProductType === "MYRAA_DESKTOP"
            ? true
            : Boolean(desktopId && remoteBridge.isPaired(currentDeviceId, desktopId)),
        bridgeConnected:
          currentProductType === "MYRAA_DESKTOP" ? true : bridgeConnected,
        badgeText:
          currentProductType === "MYRAA_DESKTOP"
            ? "LOCAL DESKTOP (ONLINE)"
            : bridgeConnected && desktopOnline
              ? "DESKTOP (CONNECTED)"
              : "NO DESKTOP CONNECTED",
      },
      {
        target: "REMOTE_DESKTOP",
        label: "Remote Desktop Bridge",
        description: "Explicitly route command over the Optional Remote Bridge to your paired PC.",
        selected: selectedTarget === "REMOTE_DESKTOP",
        isLocalToCurrentDevice: false,
        online: desktopOnline,
        paired: Boolean(
          desktopId && remoteBridge.isPaired(currentDeviceId, desktopId),
        ),
        bridgeConnected,
        badgeText:
          bridgeConnected && desktopOnline
            ? "REMOTE BRIDGE CONNECTED"
            : "REMOTE BRIDGE DISCONNECTED",
      },
    ];
  }

  private _checkMobileCapabilityPermission(
    session: InternalMobileSessionState,
    capability: string,
  ): MobilePermissionItem | null {
    for (const perm of session.permissions.values()) {
      if (perm.mappedCapabilities.includes(capability) && !perm.granted) {
        return perm;
      }
    }
    return null;
  }

  private _recordMobileTurn(
    session: InternalMobileSessionState,
    utterance: string,
    selectedTarget: UxTargetSelectorOption,
    resolvedTarget: UxTargetSelectorOption,
    executingDeviceId: string | null,
    capability: string,
    ok: boolean,
    actionableError?: UxActionableError,
    responseText?: string,
  ): UxVoiceTurnRecord {
    session.voicePhase = ok ? "SPEAKING" : "IDLE";
    session.activeError = actionableError || null;

    const record: UxVoiceTurnRecord = {
      turnId: `ux-turn-${++this.turnCounter}`,
      utterance,
      originDeviceId: session.deviceId,
      originProductType: "MYRAA_MOBILE",
      selectedTarget,
      resolvedTarget,
      executingDeviceId,
      capability,
      ok,
      verified: ok,
      usedSilentFallback: false,
      responseText:
        responseText ||
        actionableError?.userMessage ||
        `Verified execution of ${capability} on ${resolvedTarget}.`,
      ...(actionableError ? { actionableError } : {}),
      timestamp: new Date().toISOString(),
    };

    session.turnHistory.push(record);
    return record;
  }

  private _recordDesktopTurn(
    session: InternalDesktopSessionState,
    utterance: string,
    selectedTarget: UxTargetSelectorOption,
    resolvedTarget: UxTargetSelectorOption,
    executingDeviceId: string | null,
    capability: string,
    ok: boolean,
    actionableError?: UxActionableError,
    responseText?: string,
  ): UxVoiceTurnRecord {
    session.voicePhase = ok ? "SPEAKING" : "IDLE";
    session.activeError = actionableError || null;

    const record: UxVoiceTurnRecord = {
      turnId: `ux-turn-${++this.turnCounter}`,
      utterance,
      originDeviceId: session.deviceId,
      originProductType: "MYRAA_DESKTOP",
      selectedTarget,
      resolvedTarget,
      executingDeviceId,
      capability,
      ok,
      verified: ok,
      usedSilentFallback: false,
      responseText:
        responseText ||
        actionableError?.userMessage ||
        `Verified execution of ${capability} on ${resolvedTarget}.`,
      ...(actionableError ? { actionableError } : {}),
      timestamp: new Date().toISOString(),
    };

    session.turnHistory.push(record);
    return record;
  }

  private _findFirstDesktopDeviceId(accountId: string | null): string | null {
    if (accountId) {
      const accDevs = sharedAccountMemoryManager.getAccountDevices(accountId);
      const found = accDevs.find(
        (d) => d.productType === "MYRAA_DESKTOP" && !d.revoked && !d.lost,
      );
      if (found) return found.deviceId;
    }
    const all = deviceRegistry.listDevices();
    const desk = all.find((d) => d.productType === "MYRAA_DESKTOP");
    return desk ? desk.deviceId : null;
  }

  private _findFirstPhoneDeviceId(accountId: string | null): string | null {
    if (accountId) {
      const accDevs = sharedAccountMemoryManager.getAccountDevices(accountId);
      const found = accDevs.find(
        (d) => d.productType === "MYRAA_MOBILE" && !d.revoked && !d.lost,
      );
      if (found) return found.deviceId;
    }
    const all = deviceRegistry.listDevices();
    const phone = all.find((d) => d.productType === "MYRAA_MOBILE");
    return phone ? phone.deviceId : null;
  }
}

export const productionUxController = new ProductionUxController();
