/**
 * MYRAA — Phase 9 & 10: Production UX React Components & Live Control Hub
 *
 * Provides clean, modular React UI surfaces for:
 *   1. RemoteBridgeStatusCard (Clear Connected/Disconnected status, 6-digit PIN Pairing, Connect/Disconnect, Device Identity, Remote Capabilities, Remote Audit History)
 *   2. MobileProductionUxSurface (Clean Onboarding, Voice-First UI, Target Selector, Permissions, Desktop Connection, Privacy Controls, Account, Shared vs Local Memory, Settings)
 *   3. DesktopProductionUxSurface (Voice-First Interface, Project Dashboard, Active Application/Context, Tools & Capabilities View, Memory, Device/Remote Connection, Cross-Device Handoff, Emergency Stop & Security Lockdown)
 *   4. ProductionControlHubModal (Unified live interactive modal backed by /api/ux/* for Desktop & Mobile)
 */

import React, { useState, useEffect, useCallback } from "react";
import type {
  DesktopProductionUxView,
  MobilePermissionKey,
  MobileProductionUxView,
  RemoteControlCenterView,
  UxActionableError,
  UxTargetSelectorOption,
} from "../../../backend/device/ProductionUxController";

export interface RemoteBridgeStatusCardProps {
  remoteState: RemoteControlCenterView;
  onConnect?: (targetDeviceId: string) => void;
  onDisconnect?: () => void;
  onRequestPairPin?: () => void;
  onConfirmPairPin?: (pin: string) => void;
  activePairPin?: string | null;
}

export const RemoteBridgeStatusCard: React.FC<RemoteBridgeStatusCardProps> = ({
  remoteState,
  onConnect,
  onDisconnect,
  onRequestPairPin,
  onConfirmPairPin,
  activePairPin,
}) => {
  const isConnected = remoteState.connectionStatus === "CONNECTED";
  const [pinInput, setPinInput] = useState("");

  useEffect(() => {
    if (activePairPin) {
      setPinInput(activePairPin);
    }
  }, [activePairPin]);

  return (
    <div
      data-testid="remote-bridge-status-card"
      className="rounded-2xl border border-slate-800 bg-slate-950/90 p-4 text-slate-100 shadow-xl"
    >
      <div className="flex items-center justify-between gap-3 border-b border-slate-800 pb-3">
        <div>
          <div className="text-xs font-mono uppercase tracking-wider text-slate-400">
            Optional Remote Bridge
          </div>
          <div className="mt-0.5 text-sm font-bold text-white" data-testid="remote-bridge-badge-text">
            {remoteState.statusBadgeText}
          </div>
        </div>
        <span
          data-testid="remote-bridge-connection-status"
          className={`rounded-full px-3 py-1 text-xs font-mono font-bold ${
            isConnected
              ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40"
              : "bg-slate-800 text-slate-300 border border-slate-700"
          }`}
        >
          {remoteState.connectionStatus}
        </span>
      </div>

      {/* Device Identity Section */}
      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 text-xs">
        <div className="rounded-xl bg-slate-900/80 p-2.5 border border-slate-800">
          <div className="text-[10px] font-mono uppercase text-slate-400">Local Device</div>
          <div className="font-semibold text-white">{remoteState.localDevice.deviceName}</div>
          <div className="text-slate-400 font-mono">
            {remoteState.localDevice.deviceId} · {remoteState.localDevice.productType}
          </div>
        </div>

        <div className="rounded-xl bg-slate-900/80 p-2.5 border border-slate-800">
          <div className="text-[10px] font-mono uppercase text-slate-400">Remote Target</div>
          {remoteState.remoteDevice ? (
            <>
              <div className="font-semibold text-white">{remoteState.remoteDevice.deviceName}</div>
              <div className="text-slate-400 font-mono">
                {remoteState.remoteDevice.deviceId} ·{" "}
                {remoteState.remoteDevice.online ? "ONLINE" : "OFFLINE"}
              </div>
            </>
          ) : (
            <div className="text-slate-400">
              No Remote Device Connected (Standalone Mode Active)
            </div>
          )}
        </div>
      </div>

      {/* Pairing & Connect / Disconnect Controls */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {isConnected ? (
          <button
            type="button"
            data-testid="remote-bridge-disconnect-btn"
            onClick={() => onDisconnect?.()}
            className="rounded-xl bg-rose-600/20 border border-rose-500/40 px-3 py-1.5 text-xs font-semibold text-rose-300 hover:bg-rose-600/30 cursor-pointer"
          >
            Disconnect Remote Bridge
          </button>
        ) : (
          <>
            {remoteState.discoveredDevices.map((dev) => (
              <button
                key={dev.deviceId}
                type="button"
                data-testid={`remote-bridge-connect-${dev.deviceId}`}
                onClick={() => onConnect?.(dev.deviceId)}
                className="rounded-xl bg-cyan-600/20 border border-cyan-500/40 px-3 py-1.5 text-xs font-semibold text-cyan-300 hover:bg-cyan-600/30 cursor-pointer"
              >
                Connect to {dev.deviceName}
              </button>
            ))}
            {onRequestPairPin && (
              <button
                type="button"
                data-testid="remote-bridge-generate-pin-btn"
                onClick={() => onRequestPairPin()}
                className="rounded-xl bg-indigo-600/20 border border-indigo-500/40 px-3 py-1.5 text-xs font-semibold text-indigo-300 hover:bg-indigo-600/30 cursor-pointer"
              >
                Generate 6-Digit Pairing PIN
              </button>
            )}
          </>
        )}
      </div>

      {/* Explicit 6-Digit Pairing Confirmation Box */}
      {!isConnected && onConfirmPairPin && (
        <div className="mt-2.5 flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-900/60 p-2 text-xs">
          <input
            id="remote-bridge-pin-input"
            name="remoteBridgePin"
            aria-label="6-digit pairing PIN"
            type="text"
            data-testid="remote-bridge-pin-input"
            value={pinInput}
            onChange={(e) => setPinInput(e.target.value)}
            placeholder="6-digit PIN"
            maxLength={6}
            className="w-28 rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1 font-mono text-xs text-white"
          />
          <button
            type="button"
            data-testid="remote-bridge-confirm-pin-btn"
            onClick={() => {
              if (pinInput.trim()) onConfirmPairPin(pinInput.trim());
            }}
            className="rounded-lg bg-emerald-600/30 border border-emerald-500/40 px-2.5 py-1 text-xs font-semibold text-emerald-200 hover:bg-emerald-600/40 cursor-pointer"
          >
            Confirm Pairing & Connect
          </button>
          {activePairPin && (
            <span
              data-testid="remote-bridge-active-pin"
              className="ml-auto font-mono text-[11px] text-amber-300"
            >
              PIN: <strong>{activePairPin}</strong>
            </span>
          )}
        </div>
      )}

      {/* Negotiated Remote Capabilities */}
      {remoteState.negotiatedCapabilities.allowedRemoteCapabilities.length > 0 && (
        <div className="mt-3 border-t border-slate-800 pt-2.5">
          <div className="text-[10px] font-mono uppercase text-slate-400 mb-1">
            Allowed Remote Capabilities (
            {remoteState.negotiatedCapabilities.allowedRemoteCapabilities.length}) · Blocked Local-Only (
            {remoteState.negotiatedCapabilities.blockedCapabilities?.length ?? 0})
          </div>
          <div className="flex flex-wrap gap-1">
            {remoteState.negotiatedCapabilities.allowedRemoteCapabilities.slice(0, 10).map((cap) => (
              <span
                key={cap}
                className="rounded bg-slate-900 px-2 py-0.5 text-[10px] font-mono text-cyan-300 border border-slate-800"
              >
                {cap}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Remote Audit Trail */}
      <div className="mt-3 border-t border-slate-800 pt-2.5">
        <div className="flex items-center justify-between text-[10px] font-mono uppercase text-slate-400">
          <span>Remote Audit History ({remoteState.auditHistory.length})</span>
          <span data-testid="remote-audit-integrity">
            Chain Integrity: {remoteState.auditChainIntegrityValid ? "VERIFIED" : "ALERT"}
          </span>
        </div>
        {remoteState.auditHistory.length > 0 && (
          <div className="mt-1.5 max-h-24 overflow-y-auto space-y-1">
            {remoteState.auditHistory.slice(-4).map((entry) => (
              <div
                key={entry.id}
                className="flex items-center justify-between rounded bg-slate-900/70 px-2 py-1 text-[10px] font-mono text-slate-300"
              >
                <span>
                  {entry.eventType} ({entry.sourceDeviceId} → {entry.targetDeviceId || "local"})
                </span>
                <span className={entry.outcome === "ALLOW" ? "text-emerald-400" : "text-rose-400"}>
                  {entry.outcome}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export interface MobileProductionUxSurfaceProps {
  view: MobileProductionUxView;
  onSelectTarget?: (target: UxTargetSelectorOption) => void;
  onTogglePermission?: (key: MobilePermissionKey, granted: boolean) => void;
  onSubmitVoice?: (utterance: string) => void;
  onConnectDesktop?: (desktopDeviceId: string) => void;
  onDisconnectDesktop?: () => void;
  onCompleteOnboardingStep?: (stepId?: string, completeAll?: boolean) => void;
  onUpdatePrivacy?: (patch: {
    privacyShieldEnabled?: boolean;
    localOnlyMode?: boolean;
    redactNotificationsInSharedContext?: boolean;
    allowCrossDeviceHandoff?: boolean;
  }) => void;
  onAccountAction?: (action: "login" | "logout" | "revoke_device" | "mark_lost", targetDeviceId?: string) => void;
  onSaveMemory?: (scope: "SHARED" | "DEVICE_LOCAL", key: string, value: string) => void;
  onOfflineMemoryAction?: (action: "queue_offline" | "sync_offline", key?: string, value?: string) => void;
  onUpdateSettings?: (patch: {
    languagePreference?: "hinglish" | "english" | "hindi";
    wakePhrase?: string;
    theme?: "dark_cyber" | "midnight_slate" | "high_contrast";
  }) => void;
  onRequestPairPin?: () => void;
  onConfirmPairPin?: (pin: string) => void;
  activePairPin?: string | null;
}

export const MobileProductionUxSurface: React.FC<MobileProductionUxSurfaceProps> = ({
  view,
  onSelectTarget,
  onTogglePermission,
  onSubmitVoice,
  onConnectDesktop,
  onDisconnectDesktop,
  onCompleteOnboardingStep,
  onUpdatePrivacy,
  onAccountAction,
  onSaveMemory,
  onOfflineMemoryAction,
  onUpdateSettings,
  onRequestPairPin,
  onConfirmPairPin,
  activePairPin,
}) => {
  const [activeTab, setActiveTab] = useState<
    "voice" | "onboarding" | "permissions" | "desktop" | "privacy" | "account" | "memory" | "settings"
  >("voice");
  const [commandInput, setCommandInput] = useState("");
  const [memScope, setMemScope] = useState<"SHARED" | "DEVICE_LOCAL">("SHARED");
  const [memKey, setMemKey] = useState("");
  const [memValue, setMemValue] = useState("");

  return (
    <div
      data-testid="mobile-production-ux-surface"
      className="mx-auto max-w-md rounded-3xl border border-slate-800 bg-slate-950 p-4 text-slate-100 shadow-2xl"
    >
      {/* Header & Standalone Status */}
      <div className="flex items-center justify-between border-b border-slate-800 pb-3">
        <div>
          <div className="text-xs font-mono uppercase tracking-widest text-cyan-400">
            MYRAA MOBILE · {view.standaloneMode ? "STANDALONE" : "BRIDGE ACTIVE"}
          </div>
          <h2 className="text-base font-bold text-white">{view.deviceName}</h2>
        </div>
        <span
          data-testid="mobile-selected-target-badge"
          className="rounded-full bg-slate-900 px-2.5 py-1 text-[10px] font-mono text-slate-300 border border-slate-800"
        >
          Target: {view.voiceUi.selectedTarget}
        </span>
      </div>

      {/* Device / Target Selector Strip */}
      <div className="mt-3 grid grid-cols-2 gap-1.5">
        {view.voiceUi.targetSelector.map((entry) => (
          <button
            key={entry.target}
            type="button"
            data-testid={`mobile-target-${entry.target}`}
            onClick={() => onSelectTarget?.(entry.target)}
            className={`rounded-xl p-2 text-left text-xs transition border cursor-pointer ${
              entry.selected
                ? "border-cyan-500/60 bg-cyan-950/40 text-white"
                : "border-slate-800 bg-slate-900/60 text-slate-400"
            }`}
          >
            <div className="font-mono font-bold text-[10px]">{entry.target}</div>
            <div className="truncate text-[11px]">{entry.badgeText}</div>
          </button>
        ))}
      </div>

      {/* Actionable Error Banner (Never Hidden) */}
      {view.voiceUi.activeError && (
        <div
          data-testid="mobile-actionable-error"
          className="mt-3 rounded-2xl border border-rose-500/40 bg-rose-950/40 p-3 text-xs text-rose-200"
        >
          <div className="font-bold text-rose-300">
            {view.voiceUi.activeError.title} ({view.voiceUi.activeError.errorCode})
          </div>
          <p className="mt-1">{view.voiceUi.activeError.userMessage}</p>
          <ul className="mt-1.5 list-disc pl-4 text-[11px] text-rose-300/90">
            {view.voiceUi.activeError.remediationSteps.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Navigation Tabs */}
      <div className="mt-3 flex flex-wrap gap-1 border-b border-slate-800 pb-2 text-[11px]">
        {(
          [
            "voice",
            "onboarding",
            "permissions",
            "desktop",
            "privacy",
            "account",
            "memory",
            "settings",
          ] as const
        ).map((tab) => (
          <button
            key={tab}
            type="button"
            data-testid={`mobile-tab-${tab}`}
            onClick={() => setActiveTab(tab)}
            className={`rounded-lg px-2.5 py-1 font-mono uppercase cursor-pointer ${
              activeTab === tab
                ? "bg-cyan-500/20 text-cyan-300 border border-cyan-500/40"
                : "text-slate-400 hover:text-white"
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div className="mt-3">
        {activeTab === "voice" && (
          <div className="space-y-3">
            <div className="rounded-xl bg-slate-900 p-3 text-xs">
              <div className="font-mono text-[10px] uppercase text-slate-400">
                Voice-First Status: {view.voiceUi.phase}
              </div>
              <div className="mt-1 text-slate-200" data-testid="mobile-voice-response">
                {view.voiceUi.lastTurn
                  ? view.voiceUi.lastTurn.responseText
                  : view.onboarding.subtitle}
              </div>
              {view.voiceUi.lastTurn && (
                <div className="mt-1 font-mono text-[10px] text-cyan-400">
                  Executed on: {view.voiceUi.lastTurn.executingDeviceId || view.deviceId} (
                  {view.voiceUi.lastTurn.resolvedTarget})
                </div>
              )}
            </div>
            <div className="flex gap-2">
              <input
                id="mobile-voice-input"
                name="mobileVoiceCommand"
                aria-label="Mobile voice or text command"
                type="text"
                data-testid="mobile-voice-input"
                value={commandInput}
                onChange={(e) => setCommandInput(e.target.value)}
                placeholder="Bolkar ya likhkar command dein..."
                className="flex-1 rounded-xl border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-white"
              />
              <button
                type="button"
                data-testid="mobile-voice-send-btn"
                onClick={() => {
                  if (commandInput.trim()) {
                    onSubmitVoice?.(commandInput.trim());
                    setCommandInput("");
                  }
                }}
                className="rounded-xl bg-cyan-600 px-3 py-2 text-xs font-bold text-white cursor-pointer"
              >
                Send
              </button>
            </div>
          </div>
        )}

        {activeTab === "onboarding" && (
          <div className="space-y-2 text-xs" data-testid="mobile-onboarding-panel">
            <div className="flex items-center justify-between rounded-xl bg-slate-900 p-2.5 border border-slate-800">
              <div>
                <div className="font-bold text-white">{view.onboarding.headline}</div>
                <div className="text-[11px] text-slate-400">{view.onboarding.subtitle}</div>
              </div>
              <span className="rounded-full bg-cyan-500/20 px-2.5 py-0.5 font-mono text-[10px] text-cyan-300">
                {view.onboarding.completed ? "COMPLETED" : "IN PROGRESS"}
              </span>
            </div>
            {(
              ["WELCOME", "VOICE_SETUP", "PERMISSIONS", "PRIVACY_AND_ACCOUNT", "READY"] as const
            ).map((stepId) => {
              const isCompleted = view.onboarding.completedSteps.includes(stepId);
              return (
                <div
                  key={stepId}
                  className="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-900/70 p-2.5"
                >
                  <div className="font-semibold text-white">{stepId}</div>
                  <button
                    type="button"
                    data-testid={`onboarding-step-${stepId}`}
                    onClick={() => onCompleteOnboardingStep?.(stepId, false)}
                    className={`rounded-lg px-2.5 py-1 text-[10px] font-mono font-bold cursor-pointer ${
                      isCompleted
                        ? "bg-emerald-500/20 text-emerald-300"
                        : "bg-cyan-500/20 text-cyan-300"
                    }`}
                  >
                    {isCompleted ? "DONE" : "COMPLETE"}
                  </button>
                </div>
              );
            })}
            {!view.onboarding.completed && (
              <button
                type="button"
                data-testid="onboarding-complete-all-btn"
                onClick={() => onCompleteOnboardingStep?.(undefined, true)}
                className="w-full rounded-xl bg-emerald-600/30 border border-emerald-500/40 py-2 text-xs font-bold text-emerald-200 cursor-pointer"
              >
                Finish Onboarding (Standalone Ready)
              </button>
            )}
          </div>
        )}

        {activeTab === "permissions" && (
          <div className="space-y-2" data-testid="mobile-permissions-panel">
            {view.permissions.map((perm) => (
              <div
                key={perm.key}
                className="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-900/70 p-2.5 text-xs"
              >
                <div>
                  <div className="font-semibold text-white">{perm.label}</div>
                  <div className="text-[11px] text-slate-400">{perm.description}</div>
                </div>
                <button
                  type="button"
                  data-testid={`mobile-perm-${perm.key}`}
                  onClick={() => onTogglePermission?.(perm.key, !perm.granted)}
                  className={`rounded-lg px-2.5 py-1 text-[10px] font-mono font-bold cursor-pointer ${
                    perm.granted
                      ? "bg-emerald-500/20 text-emerald-300"
                      : "bg-rose-500/20 text-rose-300"
                  }`}
                >
                  {perm.granted ? "GRANTED" : "REVOKED"}
                </button>
              </div>
            ))}
          </div>
        )}

        {activeTab === "desktop" && (
          <RemoteBridgeStatusCard
            remoteState={view.desktopConnectionScreen}
            onConnect={onConnectDesktop}
            onDisconnect={onDisconnectDesktop}
            onRequestPairPin={onRequestPairPin}
            onConfirmPairPin={onConfirmPairPin}
            activePairPin={activePairPin}
          />
        )}

        {activeTab === "privacy" && (
          <div
            data-testid="mobile-privacy-panel"
            className="space-y-2 rounded-xl border border-slate-800 bg-slate-900/70 p-3 text-xs"
          >
            <div className="flex items-center justify-between">
              <span>
                Privacy Shield:{" "}
                <strong>{view.privacyControls.privacyShieldEnabled ? "ACTIVE" : "OFF"}</strong>
              </span>
              <button
                type="button"
                data-testid="toggle-privacy-shield"
                onClick={() =>
                  onUpdatePrivacy?.({
                    privacyShieldEnabled: !view.privacyControls.privacyShieldEnabled,
                  })
                }
                className="rounded-lg bg-slate-800 px-2.5 py-1 font-mono text-[10px] text-cyan-300 cursor-pointer"
              >
                Toggle Shield
              </button>
            </div>
            <div className="flex items-center justify-between">
              <span>
                Local-Only Mode:{" "}
                <strong>{view.privacyControls.localOnlyMode ? "ENABLED" : "DISABLED"}</strong>
              </span>
              <button
                type="button"
                data-testid="toggle-local-only-mode"
                onClick={() =>
                  onUpdatePrivacy?.({
                    localOnlyMode: !view.privacyControls.localOnlyMode,
                  })
                }
                className="rounded-lg bg-slate-800 px-2.5 py-1 font-mono text-[10px] text-amber-300 cursor-pointer"
              >
                Toggle Local-Only
              </button>
            </div>
            <div>
              DLP Firewall:{" "}
              <strong>ACTIVE ({view.privacyControls.dlpProtectionActive ? "ENFORCED" : "OFF"})</strong>
            </div>
          </div>
        )}

        {activeTab === "account" && (
          <div
            data-testid="mobile-account-panel"
            className="space-y-2.5 rounded-xl border border-slate-800 bg-slate-900/70 p-3 text-xs"
          >
            <div>
              Account:{" "}
              <strong data-testid="mobile-account-status">
                {view.accountView.signedIn
                  ? `${view.accountView.displayName} (${view.accountView.accountId})`
                  : "Standalone Local Mode (Not Signed In)"}
              </strong>
            </div>
            <div>Authorized Devices: {view.accountView.authorizedDevices.length}</div>
            <div className="text-[11px] text-slate-400">
              Same account syncs Shared Memory & Preferences only; Remote Bridge never auto-connects.
            </div>
            <div className="flex flex-wrap gap-2 pt-1">
              {view.accountView.signedIn ? (
                <button
                  type="button"
                  data-testid="mobile-account-logout-btn"
                  onClick={() => onAccountAction?.("logout")}
                  className="rounded-lg bg-rose-600/20 border border-rose-500/40 px-2.5 py-1 text-[11px] font-semibold text-rose-300 cursor-pointer"
                >
                  Sign Out (Return to Local Standalone)
                </button>
              ) : (
                <button
                  type="button"
                  data-testid="mobile-account-login-btn"
                  onClick={() => onAccountAction?.("login")}
                  className="rounded-lg bg-cyan-600/20 border border-cyan-500/40 px-2.5 py-1 text-[11px] font-semibold text-cyan-300 cursor-pointer"
                >
                  Sign In Shared Account
                </button>
              )}
            </div>
          </div>
        )}

        {activeTab === "memory" && (
          <div className="space-y-2.5 text-xs" data-testid="mobile-memory-panel">
            <div className="rounded-xl border border-cyan-500/30 bg-cyan-950/20 p-2.5">
              <div className="font-mono text-[10px] uppercase text-cyan-300">
                Shared Account Memory ({view.memoryView.sharedMemories.length}) & Preferences (
                {view.memoryView.sharedPreferences.length})
              </div>
              {view.memoryView.sharedMemories.slice(0, 4).map((m) => (
                <div key={m.key} className="mt-1 font-mono text-[11px] text-slate-200">
                  {m.key}: {String(m.value)}
                </div>
              ))}
            </div>
            <div className="rounded-xl border border-amber-500/30 bg-amber-950/20 p-2.5">
              <div className="font-mono text-[10px] uppercase text-amber-300">
                Device-Local Mobile Context ({view.memoryView.deviceLocalContext.length}) — Never
                Synced
              </div>
              {view.memoryView.deviceLocalContext.slice(0, 4).map((c) => (
                <div key={c.key} className="mt-1 font-mono text-[11px] text-slate-200">
                  {c.key}: {String(c.value)}
                </div>
              ))}
            </div>

            {onSaveMemory && (
              <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-2.5 space-y-2">
                <div className="flex items-center gap-2">
                  <select
                    id="mobile-memory-scope-select"
                    name="mobileMemoryScope"
                    aria-label="Memory scope"
                    data-testid="mobile-memory-scope-select"
                    value={memScope}
                    onChange={(e) => setMemScope(e.target.value as "SHARED" | "DEVICE_LOCAL")}
                    className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 text-[11px] text-white"
                  >
                    <option value="SHARED">SHARED (Account)</option>
                    <option value="DEVICE_LOCAL">DEVICE_LOCAL (Phone Only)</option>
                  </select>
                  <input
                    id="mobile-memory-key-input"
                    name="mobileMemoryKey"
                    aria-label="Memory key"
                    type="text"
                    data-testid="mobile-memory-key-input"
                    value={memKey}
                    onChange={(e) => setMemKey(e.target.value)}
                    placeholder="Key (e.g. coding_style)"
                    className="flex-1 rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 text-[11px] text-white"
                  />
                </div>
                <div className="flex gap-2">
                  <input
                    id="mobile-memory-value-input"
                    name="mobileMemoryValue"
                    aria-label="Memory value"
                    type="text"
                    data-testid="mobile-memory-value-input"
                    value={memValue}
                    onChange={(e) => setMemValue(e.target.value)}
                    placeholder="Value..."
                    className="flex-1 rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 text-[11px] text-white"
                  />
                  <button
                    type="button"
                    data-testid="mobile-memory-save-btn"
                    onClick={() => {
                      if (memKey.trim() && memValue.trim()) {
                        onSaveMemory(memScope, memKey.trim(), memValue.trim());
                        setMemKey("");
                        setMemValue("");
                      }
                    }}
                    className="rounded-lg bg-cyan-600 px-3 py-1 text-[11px] font-bold text-white cursor-pointer"
                  >
                    Save
                  </button>
                </div>
                {onOfflineMemoryAction && (
                  <div className="flex gap-2 pt-1">
                    <button
                      type="button"
                      data-testid="mobile-memory-queue-offline-btn"
                      onClick={() =>
                        onOfflineMemoryAction(
                          "queue_offline",
                          memKey.trim() || "offline_note",
                          memValue.trim() || "Queued while offline",
                        )
                      }
                      className="rounded-lg bg-amber-600/20 border border-amber-500/40 px-2.5 py-1 text-[10px] font-mono text-amber-300 cursor-pointer"
                    >
                      Queue Offline Write ({view.memoryView.offlineQueuePendingCount})
                    </button>
                    <button
                      type="button"
                      data-testid="mobile-memory-sync-offline-btn"
                      onClick={() => onOfflineMemoryAction("sync_offline")}
                      className="rounded-lg bg-emerald-600/20 border border-emerald-500/40 px-2.5 py-1 text-[10px] font-mono text-emerald-300 cursor-pointer"
                    >
                      Sync Offline Queue
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {activeTab === "settings" && (
          <div
            data-testid="mobile-settings-panel"
            className="space-y-2 rounded-xl border border-slate-800 bg-slate-900/70 p-3 text-xs"
          >
            <div className="flex items-center justify-between">
              <span>Language Preference: {view.settings.languagePreference}</span>
              {onUpdateSettings && (
                <div className="flex gap-1">
                  {(["hinglish", "english", "hindi"] as const).map((lang) => (
                    <button
                      key={lang}
                      type="button"
                      data-testid={`mobile-lang-${lang}`}
                      onClick={() => onUpdateSettings({ languagePreference: lang })}
                      className={`rounded px-2 py-0.5 font-mono text-[10px] cursor-pointer ${
                        view.settings.languagePreference === lang
                          ? "bg-cyan-500/30 text-cyan-200 border border-cyan-500/40"
                          : "bg-slate-800 text-slate-400"
                      }`}
                    >
                      {lang}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div>Wake Word: {view.settings.wakePhrase}</div>
            <div className="flex items-center justify-between">
              <span>Theme: {view.settings.theme}</span>
              {onUpdateSettings && (
                <div className="flex gap-1">
                  {(["dark_cyber", "midnight_slate", "high_contrast"] as const).map((thm) => (
                    <button
                      key={thm}
                      type="button"
                      data-testid={`mobile-theme-${thm}`}
                      onClick={() => onUpdateSettings({ theme: thm })}
                      className={`rounded px-2 py-0.5 font-mono text-[10px] cursor-pointer ${
                        view.settings.theme === thm
                          ? "bg-indigo-500/30 text-indigo-200 border border-indigo-500/40"
                          : "bg-slate-800 text-slate-400"
                      }`}
                    >
                      {thm}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export interface DesktopProductionUxSurfaceProps {
  view: DesktopProductionUxView;
  onSelectTarget?: (target: UxTargetSelectorOption) => void;
  onSubmitVoice?: (utterance: string) => void;
  onConnectRemote?: (targetDeviceId: string) => void;
  onDisconnectRemote?: () => void;
  onUpdateProject?: (patch: {
    projectPath?: string;
    projectName?: string;
    activeFile?: string;
  }) => void;
  onUpdateContext?: (patch: {
    currentWindow?: string;
    activeApplication?: string;
    activeFile?: string;
    privacyShieldActive?: boolean;
  }) => void;
  onRequestPairPin?: () => void;
  onConfirmPairPin?: (pin: string) => void;
  activePairPin?: string | null;
}

export const DesktopProductionUxSurface: React.FC<DesktopProductionUxSurfaceProps> = ({
  view,
  onSelectTarget,
  onSubmitVoice,
  onConnectRemote,
  onDisconnectRemote,
  onUpdateProject,
  onUpdateContext,
  onRequestPairPin,
  onConfirmPairPin,
  activePairPin,
}) => {
  const [commandInput, setCommandInput] = useState("");
  const [showToolsCatalog, setShowToolsCatalog] = useState(false);

  return (
    <div
      data-testid="desktop-production-ux-surface"
      className="rounded-3xl border border-slate-800 bg-slate-950 p-6 text-slate-100 shadow-2xl"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-4">
        <div>
          <div className="text-xs font-mono uppercase tracking-widest text-cyan-400">
            MYRAA DESKTOP · {view.standaloneMode ? "STANDALONE" : "REMOTE BRIDGE ACTIVE"}
          </div>
          <h1 className="text-lg font-bold text-white">{view.deviceName}</h1>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {view.voiceUi.targetSelector.map((entry) => (
            <button
              key={entry.target}
              type="button"
              data-testid={`desktop-target-${entry.target}`}
              onClick={() => onSelectTarget?.(entry.target)}
              className={`rounded-xl px-3 py-1.5 text-xs font-mono border cursor-pointer ${
                entry.selected
                  ? "border-cyan-500/60 bg-cyan-950/40 text-cyan-200"
                  : "border-slate-800 bg-slate-900 text-slate-400"
              }`}
            >
              {entry.target}
            </button>
          ))}
        </div>
      </div>

      {view.voiceUi.activeError && (
        <div
          data-testid="desktop-actionable-error"
          className="mt-4 rounded-2xl border border-rose-500/40 bg-rose-950/40 p-3 text-xs text-rose-200"
        >
          <div className="font-bold text-rose-300">
            {view.voiceUi.activeError.title} ({view.voiceUi.activeError.errorCode})
          </div>
          <p className="mt-1">{view.voiceUi.activeError.userMessage}</p>
        </div>
      )}

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Project Dashboard */}
        <div
          data-testid="desktop-project-dashboard"
          className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 text-xs"
        >
          <div className="flex items-center justify-between">
            <span className="font-mono text-[10px] uppercase text-cyan-400">Project Dashboard</span>
            <span className="font-mono text-[10px] text-slate-400">
              Stages: {view.projectDashboard.workflowStages.length}
            </span>
          </div>
          <div className="mt-1 text-sm font-bold text-white">
            {view.projectDashboard.projectName}
          </div>
          <div className="mt-0.5 font-mono text-slate-400">
            {view.projectDashboard.projectPath}
          </div>
          <div className="mt-2 text-slate-300">
            Active File: <span className="font-mono">{view.projectDashboard.activeFile}</span>
          </div>
          {onUpdateProject && (
            <div className="mt-2 flex gap-1.5">
              <button
                type="button"
                data-testid="desktop-switch-file-btn"
                onClick={() =>
                  onUpdateProject({
                    activeFile:
                      view.projectDashboard.activeFile === "src/App.tsx"
                        ? "src/backend/device/ProductionUxController.ts"
                        : "src/App.tsx",
                  })
                }
                className="rounded-lg bg-slate-800 px-2 py-1 font-mono text-[10px] text-cyan-300 hover:bg-slate-700 cursor-pointer"
              >
                Switch Active File
              </button>
            </div>
          )}
        </div>

        {/* Active Application / Local Context */}
        <div
          data-testid="desktop-active-context"
          className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 text-xs"
        >
          <div className="font-mono text-[10px] uppercase text-amber-400">
            {view.activeContext.scopeBadge}
          </div>
          <div className="mt-1 font-semibold text-white">
            Window: {view.activeContext.currentWindow || "None"}
          </div>
          <div className="mt-1 text-slate-300">
            Application: {view.activeContext.activeApplication || "None"}
          </div>
          {onUpdateContext && (
            <div className="mt-2 flex gap-1.5">
              <button
                type="button"
                data-testid="desktop-context-privacy-btn"
                onClick={() =>
                  onUpdateContext({
                    privacyShieldActive: !view.activeContext.privacyShieldActive,
                  })
                }
                className="rounded-lg bg-slate-800 px-2 py-1 font-mono text-[10px] text-amber-300 hover:bg-slate-700 cursor-pointer"
              >
                Privacy Shield: {view.activeContext.privacyShieldActive ? "ON" : "OFF"}
              </button>
            </div>
          )}
        </div>

        {/* Tools & Capabilities Summary */}
        <div
          data-testid="desktop-tools-capabilities"
          className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 text-xs"
        >
          <div className="flex items-center justify-between">
            <span className="font-mono text-[10px] uppercase text-emerald-400">
              Tools & Capabilities View
            </span>
            <button
              type="button"
              data-testid="desktop-toggle-tools-catalog-btn"
              onClick={() => setShowToolsCatalog(!showToolsCatalog)}
              className="rounded bg-slate-800 px-2 py-0.5 font-mono text-[10px] text-emerald-300 cursor-pointer"
            >
              {showToolsCatalog ? "Hide Catalog" : "Inspect 126 Tools"}
            </button>
          </div>
          <div className="mt-1 font-semibold text-white" data-testid="desktop-gemini-live-tools-count">
            Gemini Live Tools: {view.toolsAndCapabilities.totalGeminiLiveTools}
          </div>
          <div className="mt-1 text-slate-300">
            Desktop Capabilities: {view.toolsAndCapabilities.desktopCapabilitiesCount} · Mobile
            Capabilities: {view.toolsAndCapabilities.mobileCapabilitiesCount}
          </div>
          {showToolsCatalog && (
            <div
              data-testid="desktop-tools-catalog-list"
              className="mt-2 max-h-28 overflow-y-auto rounded-lg border border-slate-800 bg-slate-950 p-2 font-mono text-[10px] text-slate-300"
            >
              <div className="text-cyan-300 mb-1">
                Gemini Live Tools ({view.toolsAndCapabilities.geminiLiveToolNames.length} registered):
              </div>
              <div className="flex flex-wrap gap-1">
                {view.toolsAndCapabilities.geminiLiveToolNames.slice(0, 24).map((t) => (
                  <span key={t} className="rounded bg-slate-900 px-1.5 py-0.5 text-slate-200">
                    {t}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Voice Command Input & Remote Connection Panel */}
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
          <div className="text-xs font-mono uppercase text-slate-400 mb-2">
            Desktop Voice-First Interface ({view.voiceUi.phase})
          </div>
          {view.voiceUi.lastTurn && (
            <div
              data-testid="desktop-voice-response"
              className="mb-2 rounded-xl bg-slate-950 p-2.5 text-xs text-slate-200 border border-slate-800"
            >
              <div>{view.voiceUi.lastTurn.responseText}</div>
              <div className="mt-0.5 font-mono text-[10px] text-cyan-400">
                Executed on: {view.voiceUi.lastTurn.executingDeviceId || view.deviceId} (
                {view.voiceUi.lastTurn.resolvedTarget})
              </div>
            </div>
          )}
          <div className="flex gap-2">
            <input
              id="desktop-voice-input"
              name="desktopVoiceCommand"
              aria-label="Desktop voice or text command"
              type="text"
              data-testid="desktop-voice-input"
              value={commandInput}
              onChange={(e) => setCommandInput(e.target.value)}
              placeholder="VS Code open karo, project inspect karo..."
              className="flex-1 rounded-xl border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-white"
            />
            <button
              type="button"
              data-testid="desktop-voice-execute-btn"
              onClick={() => {
                if (commandInput.trim()) {
                  onSubmitVoice?.(commandInput.trim());
                  setCommandInput("");
                }
              }}
              className="rounded-xl bg-cyan-600 px-4 py-2 text-xs font-bold text-white cursor-pointer"
            >
              Execute
            </button>
          </div>
        </div>

        <RemoteBridgeStatusCard
          remoteState={view.remoteConnectionPanel}
          onConnect={onConnectRemote}
          onDisconnect={onDisconnectRemote}
          onRequestPairPin={onRequestPairPin}
          onConfirmPairPin={onConfirmPairPin}
          activePairPin={activePairPin}
        />
      </div>
    </div>
  );
};

export interface ProductionControlHubModalProps {
  isOpen: boolean;
  onClose: () => void;
  defaultSurface?: "desktop" | "mobile" | "handoff_security";
}

export const ProductionControlHubModal: React.FC<ProductionControlHubModalProps> = ({
  isOpen,
  onClose,
  defaultSurface = "desktop",
}) => {
  const [surface, setSurface] = useState<"desktop" | "mobile" | "handoff_security">(defaultSurface);
  const [uxState, setUxState] = useState<{
    mobile: MobileProductionUxView;
    desktop: DesktopProductionUxView;
    activeWorkflows: any[];
    emergencyStop: { active: boolean; reason?: string };
    securityMode: string;
    totalGeminiLiveTools: number;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [statusBanner, setStatusBanner] = useState<string | null>(null);
  const [errorBanner, setErrorBanner] = useState<UxActionableError | null>(null);
  const [activePairPin, setActivePairPin] = useState<string | null>(null);
  const [handoffUtterance, setHandoffUtterance] = useState(
    "Desktop par mera project kholo",
  );

  const fetchUxState = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch("/api/ux/state");
      if (res.ok) {
        const data = await res.json();
        setUxState(data);
      }
    } catch {
      // ignore transient network errors
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      fetchUxState();
    }
  }, [isOpen, fetchUxState]);

  if (!isOpen) return null;

  const postUxAction = async (url: string, body: Record<string, any>) => {
    setErrorBanner(null);
    setStatusBanner(null);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.actionableError) {
      setErrorBanner(data.actionableError);
    } else if (!res.ok || data.ok === false || data.handoffOutcome?.ok === false) {
      setStatusBanner(
        data.error ||
          data.errorCode ||
          data.handoffOutcome?.message ||
          data.handoffOutcome?.errorCode ||
          "Action blocked by policy",
      );
    } else if (data.message || data.responseText || data.handoffOutcome?.message) {
      setStatusBanner(data.message || data.responseText || data.handoffOutcome?.message);
    }
    await fetchUxState();
    return data;
  };

  return (
    <div
      data-testid="production-control-hub-modal"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4 backdrop-blur-md overflow-y-auto"
    >
      <div className="relative my-auto w-full max-w-5xl rounded-3xl border border-slate-800 bg-slate-950 p-6 text-slate-100 shadow-2xl max-h-[92vh] overflow-y-auto">
        {/* Top Bar */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-4">
          <div>
            <div className="text-xs font-mono uppercase tracking-widest text-cyan-400">
              MYRAA PRODUCTION CONTROL HUB · DUAL-PRODUCT ARCHITECTURE
            </div>
            <h2 className="text-lg font-bold text-white">
              Standalone Mobile + Standalone Desktop + Optional Remote Bridge
            </h2>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="hub-tab-desktop"
              onClick={() => setSurface("desktop")}
              className={`rounded-xl px-3 py-1.5 text-xs font-mono uppercase cursor-pointer border ${
                surface === "desktop"
                  ? "border-cyan-500/60 bg-cyan-950/50 text-cyan-200"
                  : "border-slate-800 bg-slate-900 text-slate-400"
              }`}
            >
              Desktop UX
            </button>
            <button
              type="button"
              data-testid="hub-tab-mobile"
              onClick={() => setSurface("mobile")}
              className={`rounded-xl px-3 py-1.5 text-xs font-mono uppercase cursor-pointer border ${
                surface === "mobile"
                  ? "border-cyan-500/60 bg-cyan-950/50 text-cyan-200"
                  : "border-slate-800 bg-slate-900 text-slate-400"
              }`}
            >
              Mobile UX
            </button>
            <button
              type="button"
              data-testid="hub-tab-handoff-security"
              onClick={() => setSurface("handoff_security")}
              className={`rounded-xl px-3 py-1.5 text-xs font-mono uppercase cursor-pointer border ${
                surface === "handoff_security"
                  ? "border-cyan-500/60 bg-cyan-950/50 text-cyan-200"
                  : "border-slate-800 bg-slate-900 text-slate-400"
              }`}
            >
              Handoff & Security
            </button>
            <button
              type="button"
              data-testid="hub-close-btn"
              onClick={onClose}
              className="rounded-xl border border-slate-800 bg-slate-900 px-3 py-1.5 text-xs font-mono text-slate-300 hover:text-white cursor-pointer"
            >
              Close
            </button>
          </div>
        </div>

        {/* Status / Actionable Error Banners */}
        {statusBanner && (
          <div
            data-testid="hub-status-banner"
            className="mt-3 rounded-2xl border border-cyan-500/40 bg-cyan-950/30 p-3 text-xs text-cyan-200"
          >
            {statusBanner}
          </div>
        )}
        {errorBanner && (
          <div
            data-testid="hub-error-banner"
            className="mt-3 rounded-2xl border border-rose-500/40 bg-rose-950/40 p-3 text-xs text-rose-200"
          >
            <div className="font-bold text-rose-300">
              {errorBanner.title} ({errorBanner.errorCode})
            </div>
            <p className="mt-1">{errorBanner.userMessage}</p>
          </div>
        )}

        {!uxState ? (
          <div className="py-12 text-center text-xs font-mono text-slate-400">
            {loading ? "Loading MYRAA Production UX State..." : "Initializing..."}
          </div>
        ) : (
          <div className="mt-4">
            {surface === "desktop" && (
              <DesktopProductionUxSurface
                view={uxState.desktop}
                activePairPin={activePairPin}
                onSelectTarget={(target) => postUxAction("/api/ux/desktop/target", { target })}
                onSubmitVoice={(utterance) => postUxAction("/api/ux/desktop/voice", { utterance })}
                onUpdateProject={(patch) => postUxAction("/api/ux/desktop/project", patch)}
                onUpdateContext={(patch) => postUxAction("/api/ux/desktop/context", patch)}
                onRequestPairPin={async () => {
                  const res = await postUxAction("/api/ux/remote/pair-request", {});
                  if (res?.pairingCode) setActivePairPin(res.pairingCode);
                }}
                onConfirmPairPin={(pin) =>
                  postUxAction("/api/ux/remote/pair-confirm", { pairingCode: pin })
                }
                onConnectRemote={(targetDeviceId) =>
                  postUxAction("/api/ux/remote/connect", {
                    sourceDeviceId: uxState.desktop.deviceId,
                    targetDeviceId,
                  })
                }
                onDisconnectRemote={() =>
                  postUxAction("/api/ux/remote/disconnect", {
                    deviceId: uxState.desktop.deviceId,
                  })
                }
              />
            )}

            {surface === "mobile" && (
              <MobileProductionUxSurface
                view={uxState.mobile}
                activePairPin={activePairPin}
                onSelectTarget={(target) => postUxAction("/api/ux/mobile/target", { target })}
                onTogglePermission={(permission, granted) =>
                  postUxAction("/api/ux/mobile/permission", { permission, granted })
                }
                onSubmitVoice={(utterance) => postUxAction("/api/ux/mobile/voice", { utterance })}
                onCompleteOnboardingStep={(stepId, completeAll) =>
                  postUxAction("/api/ux/mobile/onboarding", { stepId, completeAll })
                }
                onUpdatePrivacy={(patch) => postUxAction("/api/ux/mobile/privacy", patch)}
                onAccountAction={(action, targetDeviceId) =>
                  postUxAction("/api/ux/account/auth", { action, targetDeviceId })
                }
                onSaveMemory={(scope, key, value) =>
                  postUxAction("/api/ux/memory", {
                    deviceId: uxState.mobile.deviceId,
                    productType: "MYRAA_MOBILE",
                    scope,
                    key,
                    value,
                  })
                }
                onOfflineMemoryAction={(action, key, value) =>
                  postUxAction("/api/ux/memory", {
                    action,
                    deviceId: uxState.mobile.deviceId,
                    key,
                    value,
                  })
                }
                onUpdateSettings={(patch) => postUxAction("/api/ux/mobile/settings", patch)}
                onRequestPairPin={async () => {
                  const res = await postUxAction("/api/ux/remote/pair-request", {});
                  if (res?.pairingCode) setActivePairPin(res.pairingCode);
                }}
                onConfirmPairPin={(pin) =>
                  postUxAction("/api/ux/remote/pair-confirm", { pairingCode: pin })
                }
                onConnectDesktop={(desktopDeviceId) =>
                  postUxAction("/api/ux/remote/connect", {
                    sourceDeviceId: uxState.mobile.deviceId,
                    targetDeviceId: desktopDeviceId,
                  })
                }
                onDisconnectDesktop={() =>
                  postUxAction("/api/ux/remote/disconnect", {
                    deviceId: uxState.mobile.deviceId,
                  })
                }
              />
            )}

            {surface === "handoff_security" && (
              <div
                data-testid="hub-handoff-security-surface"
                className="space-y-4 rounded-3xl border border-slate-800 bg-slate-900/50 p-5 text-xs"
              >
                {/* Cross-Device Handoff Controls */}
                <div className="rounded-2xl border border-slate-800 bg-slate-950 p-4 space-y-3">
                  <div className="font-mono text-[10px] uppercase text-cyan-400">
                    Cross-Device Workflow Handoff (Phone ↔ Desktop)
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <input
                      id="handoff-utterance-input"
                      name="handoffUtterance"
                      aria-label="Cross-device handoff utterance"
                      type="text"
                      data-testid="handoff-utterance-input"
                      value={handoffUtterance}
                      onChange={(e) => setHandoffUtterance(e.target.value)}
                      className="flex-1 rounded-xl border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-white"
                    />
                    <button
                      type="button"
                      data-testid="handoff-phone-to-desktop-btn"
                      onClick={() =>
                        postUxAction("/api/ux/handoff", {
                          action: "conversational",
                          sourceDeviceId: uxState.mobile.deviceId,
                          targetDeviceId: uxState.desktop.deviceId,
                          utterance: handoffUtterance,
                        })
                      }
                      className="rounded-xl bg-cyan-600 px-3 py-2 font-bold text-white cursor-pointer"
                    >
                      Handoff Phone → Desktop
                    </button>
                    <button
                      type="button"
                      data-testid="handoff-desktop-to-phone-btn"
                      onClick={() =>
                        postUxAction("/api/ux/handoff", {
                          action: "continue",
                          sourceDeviceId: uxState.desktop.deviceId,
                          targetDeviceId: uxState.mobile.deviceId,
                          utterance: "Ye task phone par continue karo",
                        })
                      }
                      className="rounded-xl bg-indigo-600 px-3 py-2 font-bold text-white cursor-pointer"
                    >
                      Continue Desktop → Phone
                    </button>
                  </div>

                  {/* Active Cross-Device Workflows */}
                  <div className="space-y-2 pt-2">
                    <div className="font-mono text-[10px] uppercase text-slate-400">
                      Active Workflows ({uxState.activeWorkflows.length})
                    </div>
                    {uxState.activeWorkflows.map((wf: any) => (
                      <div
                        key={wf.workflowId}
                        data-testid={`workflow-item-${wf.workflowId}`}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-800 bg-slate-900 p-2.5"
                      >
                        <div>
                          <div className="font-semibold text-white">
                            {wf.title} · <span className="text-cyan-300 font-mono">{wf.state}</span>
                          </div>
                          <div className="font-mono text-[10px] text-slate-400">
                            {wf.initiatingDeviceId} → {wf.currentExecutingDeviceId} ({wf.workflowId})
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          <button
                            type="button"
                            data-testid={`wf-pause-${wf.workflowId}`}
                            onClick={() =>
                              postUxAction("/api/ux/handoff", {
                                action: "pause",
                                workflowId: wf.workflowId,
                              })
                            }
                            className="rounded bg-amber-600/20 px-2 py-1 font-mono text-[10px] text-amber-300 cursor-pointer"
                          >
                            Pause
                          </button>
                          <button
                            type="button"
                            data-testid={`wf-resume-${wf.workflowId}`}
                            onClick={() =>
                              postUxAction("/api/ux/handoff", {
                                action: "resume",
                                workflowId: wf.workflowId,
                              })
                            }
                            className="rounded bg-emerald-600/20 px-2 py-1 font-mono text-[10px] text-emerald-300 cursor-pointer"
                          >
                            Resume
                          </button>
                          <button
                            type="button"
                            data-testid={`wf-disconnect-${wf.workflowId}`}
                            onClick={() =>
                              postUxAction("/api/ux/handoff", {
                                action: "disconnect",
                                workflowId: wf.workflowId,
                              })
                            }
                            className="rounded bg-rose-600/20 px-2 py-1 font-mono text-[10px] text-rose-300 cursor-pointer"
                          >
                            Simulate Disconnect
                          </button>
                          <button
                            type="button"
                            data-testid={`wf-recover-${wf.workflowId}`}
                            onClick={() =>
                              postUxAction("/api/ux/handoff", {
                                action: "recover",
                                workflowId: wf.workflowId,
                              })
                            }
                            className="rounded bg-cyan-600/20 px-2 py-1 font-mono text-[10px] text-cyan-300 cursor-pointer"
                          >
                            Recover & Resume
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Emergency Stop & Security Lockdown Controls */}
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="rounded-2xl border border-rose-500/30 bg-rose-950/20 p-4 space-y-2">
                    <div className="font-mono text-[10px] uppercase text-rose-300">
                      Global Emergency Stop (Killswitch)
                    </div>
                    <div className="text-sm font-bold text-white" data-testid="hub-emergency-status">
                      Status: {uxState.emergencyStop.active ? "HALTED (ACTIVE)" : "READY (INACTIVE)"}
                    </div>
                    <div className="flex gap-2 pt-1">
                      <button
                        type="button"
                        data-testid="hub-emergency-trigger-btn"
                        onClick={() =>
                          postUxAction("/api/ux/security/emergency-stop", {
                            action: "trigger",
                            reason: "Manual Emergency Stop from Control Hub",
                          })
                        }
                        className="rounded-xl bg-rose-600 px-3 py-1.5 text-xs font-bold text-white cursor-pointer"
                      >
                        Trigger Emergency Stop
                      </button>
                      <button
                        type="button"
                        data-testid="hub-emergency-reset-btn"
                        onClick={() =>
                          postUxAction("/api/ux/security/emergency-stop", {
                            action: "reset",
                          })
                        }
                        className="rounded-xl bg-slate-800 px-3 py-1.5 text-xs font-semibold text-slate-200 cursor-pointer"
                      >
                        Reset Emergency Stop
                      </button>
                    </div>
                  </div>

                  <div className="rounded-2xl border border-amber-500/30 bg-amber-950/20 p-4 space-y-2">
                    <div className="font-mono text-[10px] uppercase text-amber-300">
                      Security Policy Lockdown Mode
                    </div>
                    <div className="text-sm font-bold text-white" data-testid="hub-security-mode">
                      Current Mode: {uxState.securityMode}
                    </div>
                    <div className="flex flex-wrap gap-2 pt-1">
                      {(["NORMAL", "ELEVATED", "LOCKDOWN"] as const).map((mode) => (
                        <button
                          key={mode}
                          type="button"
                          data-testid={`hub-security-mode-${mode}`}
                          onClick={() => postUxAction("/api/ux/security/lockdown", { mode })}
                          className={`rounded-xl px-3 py-1.5 text-xs font-mono font-bold cursor-pointer ${
                            uxState.securityMode === mode
                              ? "bg-amber-500 text-slate-950"
                              : "bg-slate-800 text-slate-300"
                          }`}
                        >
                          {mode}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
