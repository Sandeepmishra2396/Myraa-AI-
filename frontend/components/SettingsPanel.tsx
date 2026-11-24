import React, { useEffect, useState } from "react";
import {
  Settings,
  X,
  Power,
  Mic,
  Cpu,
  Info,
  Check,
  AlertTriangle,
  Volume2,
  Sparkles,
  KeyRound,
  Loader2,
  Trash2,
  Eye,
  EyeOff,
  ExternalLink,
  Shield,
  ShieldCheck,
  Globe,
  Brain,
  Lock,
  Database,
  Radio,
  Sliders,
  SlidersHorizontal,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { MyraaSettings, SupportedLanguageSetting, DEFAULT_SETTINGS, loadSettings, saveSettings } from "../lib/settingsStore";
import { StoredRemoteSession, STORAGE_KEY } from "./remote/CloudPairingModal";
import { authenticatedRemoteFetch } from "../lib/remoteAuth";

interface SettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
  /** Current settings (owned by App so wake-word state stays in sync). */
  settings: MyraaSettings;
  /** Persist a settings patch (also notifies App of changes). */
  onChange: (patch: Partial<MyraaSettings>) => void;
  themeColor: string;
  remoteSession?: StoredRemoteSession | null;
  onUnpair?: () => void;
  onSessionUpdate?: (session: StoredRemoteSession) => void;
  memories?: any[];
  onOpenMemoryDashboard?: () => void;
}

type SettingsTab = "general" | "voice" | "system" | "security" | "memory" | "about";

/** A single toggle row styled with Light Blue and Dark theme tokens. */
function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="pt-3 pb-1 border-t border-slate-200 dark:border-[#202938]/60 flex items-center justify-between text-left">
      <div className="flex flex-col pr-4">
        <span className="text-xs font-mono font-bold tracking-wider text-slate-900 dark:text-[#F4F7FB]">{label}</span>
        <span className="text-[11px] text-slate-600 dark:text-[#8994A6] font-sans mt-0.5 leading-snug">
          {description}
        </span>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`w-11 h-6 rounded-full p-0.5 transition-colors duration-200 focus:outline-none cursor-pointer shrink-0 ${
          checked ? "bg-[#0284C7] shadow-[0_0_10px_rgba(2,132,199,0.35)]" : "bg-slate-300 dark:bg-white/10"
        }`}
      >
        <div
          className={`bg-white w-5 h-5 rounded-full shadow-md transform duration-200 ease-in-out ${
            checked ? "translate-x-5" : "translate-x-0"
          }`}
        />
      </button>
    </div>
  );
}

export function SettingsPanel({
  isOpen,
  onClose,
  settings,
  onChange,
  themeColor,
  remoteSession,
  onUnpair,
  onSessionUpdate,
  memories,
  onOpenMemoryDashboard,
}: SettingsPanelProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>("general");
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [agentHealth, setAgentHealth] = useState<{
    online: boolean;
    toolCount?: number;
    cpu?: string;
    ram?: string;
  }>({ online: false });

  const isLocalOrigin =
    typeof window !== "undefined" &&
    (window.location.hostname === "localhost" ||
      window.location.hostname === "127.0.0.1" ||
      window.location.hostname === "::1");

  // Cloud Companion Live Role & Secondary Pairing State
  const [liveRole, setLiveRole] = useState<string | null>(remoteSession?.role || null);
  const [isGeneratingPairCode, setIsGeneratingPairCode] = useState(false);
  const [generatedPairCode, setGeneratedPairCode] = useState<{
    code: string;
    expiresAt: string;
    ttlSeconds: number;
  } | null>(null);
  const [countdownSeconds, setCountdownSeconds] = useState(300);
  const [pairCodeError, setPairCodeError] = useState<string | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);

  // Synchronize remote session role with live server endpoint (GET /api/remote/session)
  useEffect(() => {
    if (!remoteSession?.token && !remoteSession?.accessToken) {
      setLiveRole(null);
      return;
    }
    let cancelled = false;

    const syncSession = async () => {
      try {
        const { response: res } = await authenticatedRemoteFetch(
          "/api/remote/session",
          { method: "GET" },
          remoteSession,
          (updated) => onSessionUpdate?.(updated),
        );
        if (res.ok && !cancelled) {
          const data = await res.json();
          const fetchedRole = data.device?.role || data.role;
          if (fetchedRole) {
            setLiveRole(fetchedRole);
            if (fetchedRole !== remoteSession.role) {
              const updated: StoredRemoteSession = { ...remoteSession, role: fetchedRole };
              try {
                localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
              } catch {}
              onSessionUpdate?.(updated);
            }
          }
        }
      } catch {
        /* best effort */
      }
    };

    syncSession();
    return () => {
      cancelled = true;
    };
  }, [remoteSession?.token, remoteSession?.accessToken, isOpen]);

  // Countdown timer for active pairing PIN
  useEffect(() => {
    if (!generatedPairCode) return;
    const interval = setInterval(() => {
      setCountdownSeconds((prev) => {
        if (prev <= 1) {
          clearInterval(interval);
          setGeneratedPairCode(null);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [generatedPairCode]);

  const handleGeneratePairCode = async () => {
    if (!remoteSession) return;
    setIsGeneratingPairCode(true);
    setPairCodeError(null);
    setCopiedCode(false);
    try {
      const { response: res } = await authenticatedRemoteFetch(
        "/api/remote/pair-code",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        },
        remoteSession,
        (updated) => {
          onSessionUpdate?.(updated);
        },
      );
      if (res.ok) {
        const data = await res.json();
        setGeneratedPairCode(data);
        setCountdownSeconds(data.ttlSeconds || 300);
      } else {
        const err = await res.json().catch(() => ({}));
        setPairCodeError(err.error || `Failed to generate pairing PIN (HTTP ${res.status})`);
      }
    } catch (e: any) {
      setPairCodeError(e.message || "Network error generating pairing PIN.");
    } finally {
      setIsGeneratingPairCode(false);
    }
  };

  const [apiKeyMeta, setApiKeyMeta] = useState<{
    hasApiKey: boolean;
    source?: string;
    masked?: string;
    prefix?: string;
    isPlaceholder?: boolean;
  }>({ hasApiKey: false });
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [savingKey, setSavingKey] = useState(false);
  const [keyStatusMsg, setKeyStatusMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // Fetch API key status whenever Settings panel opens
  const fetchKeyStatus = async () => {
    try {
      const res = await fetch("/api/config", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        setApiKeyMeta(data);
      }
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchKeyStatus();
    }
  }, [isOpen]);

  const handleSaveApiKey = async (e: React.FormEvent) => {
    e.preventDefault();
    const k = apiKeyInput.trim();
    if (!k || savingKey) return;
    setSavingKey(true);
    setKeyStatusMsg(null);
    try {
      const res = await fetch("/api/config/apikey", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: k }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to validate/save API key.");
      }
      setApiKeyInput("");
      setKeyStatusMsg({ type: "success", text: "Key verified & saved successfully! MYRAA is ready." });
      await fetchKeyStatus();
    } catch (err: any) {
      setKeyStatusMsg({ type: "error", text: err.message || "Failed to save key." });
    } finally {
      setSavingKey(false);
    }
  };

  const handleClearApiKey = async () => {
    if (!confirm("Are you sure you want to remove your saved Gemini API key?")) return;
    try {
      const res = await fetch("/api/config/apikey", { method: "DELETE" });
      if (res.ok) {
        setApiKeyInput("");
        setKeyStatusMsg({ type: "success", text: "API key removed." });
        await fetchKeyStatus();
      }
    } catch (err: any) {
      setKeyStatusMsg({ type: "error", text: err.message || "Failed to remove key." });
    }
  };

  // Enumerate microphones (mirrors how audio.ts grabs getUserMedia).
  useEffect(() => {
    if (!isOpen) return;
    const enumerate = async () => {
      try {
        if (!navigator.mediaDevices?.enumerateDevices) return;
        const devices = await navigator.mediaDevices.enumerateDevices();
        setMics(devices.filter((d) => d.kind === "audioinput"));
      } catch {
        /* permission may be needed first */
      }
    };
    enumerate();
  }, [isOpen]);

  // Probe desktop agent health (port 8765) via the server-side logs/health proxy.
  useEffect(() => {
    if (!isOpen) return;
    const probe = async () => {
      const isLocalOrigin =
        typeof window !== "undefined" &&
        (window.location.hostname === "localhost" ||
          window.location.hostname === "127.0.0.1" ||
          window.location.hostname === "::1");

      if (isLocalOrigin) {
        try {
          // Re-use the local agent directly (same machine, same browser).
          const res = await fetch("http://127.0.0.1:8765/health", { cache: "no-store" });
          if (res.ok) {
            const data = await res.json();
            setAgentHealth({ online: true, toolCount: data.tool_count });
            return;
          }
        } catch {
          // fall through to server proxy
        }
      }

      // Remote / Cloud web companion mode: use server proxy to avoid mixed-content / private-network CORS errors
      try {
        const res2 = await fetch("/api/agent-health", { cache: "no-store" });
        if (res2.ok) {
          const d = await res2.json();
          setAgentHealth({ online: !!d.online, toolCount: d.tool_count });
          return;
        }
      } catch {
        /* ignore */
      }
      setAgentHealth({ online: false });
    };
    probe();
    const id = setInterval(probe, 5000);
    return () => clearInterval(id);
  }, [isOpen]);

  const getThemeBadgeGlow = () => {
    switch (themeColor) {
      case "violet": return "border-purple-500/30 text-purple-400 bg-purple-500/10";
      case "crimson": return "border-rose-500/30 text-rose-400 bg-rose-500/10";
      case "emerald": return "border-emerald-500/30 text-emerald-400 bg-emerald-500/10";
      case "celestial": return "border-sky-500/30 text-sky-400 bg-sky-500/10";
      case "gold": return "border-amber-500/30 text-amber-400 bg-amber-500/10";
      case "rose": return "border-pink-500/30 text-pink-400 bg-pink-500/10";
      case "charcoal":
      default:
        return "border-blue-500/30 text-[#0284C7] bg-[#0284C7]/10";
    }
  };

  const tabs: { id: SettingsTab; label: string; icon: any }[] = [
    { id: "general", label: "GENERAL", icon: Power },
    { id: "voice", label: "VOICE", icon: Mic },
    { id: "system", label: "SYSTEM", icon: Cpu },
    { id: "security", label: "SECURITY", icon: ShieldCheck },
    { id: "memory", label: "MEMORY", icon: Brain },
    { id: "about", label: "ABOUT", icon: Info },
  ];

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop Overlay */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="absolute inset-0 bg-black/40 z-40 backdrop-blur-sm"
          />

          {/* Slide-over Container — Right side panel matching Light Blue theme */}
          <motion.div
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ duration: 0.25, ease: "easeInOut" }}
            className="absolute inset-y-0 right-0 w-full max-w-xl neural-glass-panel border-l border-slate-200 dark:border-[#202938] text-slate-900 dark:text-[#F4F7FB] backdrop-blur-3xl z-50 flex flex-col shadow-2xl"
          >
            {/* Header */}
            <div className="p-5 sm:p-6 border-b border-slate-200 dark:border-[#202938]/60 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className={`p-2.5 rounded-xl border ${getThemeBadgeGlow()}`}>
                  <Settings size={22} className="animate-spin [animation-duration:6s]" />
                </div>
                <div>
                  <h3 className="font-display font-medium text-lg tracking-tight text-slate-900 dark:text-[#F4F7FB] flex items-center gap-2">
                    Myraa Configuration
                    <Sparkles size={14} className="text-[#0284C7]" />
                  </h3>
                  <p className="text-[10px] font-mono uppercase tracking-widest text-slate-500 dark:text-[#8994A6] mt-0.5">
                    System settings &amp; preferences
                  </p>
                </div>
              </div>
              <button
                onClick={onClose}
                className="p-2 rounded-xl neural-pill hover:bg-rose-500/10 hover:border-rose-500/30 text-slate-500 hover:text-rose-500 dark:text-[#8994A6] dark:hover:text-rose-400 transition cursor-pointer"
                title="Close Settings"
                data-testid="close-settings-btn"
              >
                <X size={18} />
              </button>
            </div>

            {/* Navigation Tabs row */}
            <div className="px-5 sm:px-6 py-3 border-b border-slate-200 dark:border-[#202938]/60 flex items-center gap-2 overflow-x-auto no-scrollbar">
              {tabs.map((t) => {
                const Icon = t.icon;
                const active = activeTab === t.id;
                return (
                  <button
                    key={t.id}
                    data-testid={`settings-tab-${t.id}`}
                    onClick={() => setActiveTab(t.id)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-xs font-mono tracking-wider transition shrink-0 cursor-pointer ${
                      active
                        ? "border-[#0284C7] bg-[#0284C7]/15 text-[#0284C7] font-semibold shadow-sm"
                        : "border-slate-200 dark:border-[#202938]/60 bg-transparent text-slate-600 dark:text-[#8994A6] hover:bg-slate-100 dark:hover:bg-[#111722]/80 hover:text-slate-900 dark:hover:text-[#F4F7FB]"
                    }`}
                  >
                    <Icon size={13} className={active ? "text-[#0284C7]" : "text-slate-500 dark:text-[#8994A6]"} />
                    <span>{t.label}</span>
                  </button>
                );
              })}
            </div>

            {/* Scrollable content area */}
            <div className="flex-1 overflow-y-auto p-5 sm:p-6 space-y-5">
              {/* ---------------- 1. GENERAL ---------------- */}
              {activeTab === "general" && (
                <div className="space-y-4">
                  <div className="text-xs font-mono font-bold uppercase tracking-widest text-[#0284C7] flex items-center gap-1.5">
                    <Power size={13} />
                    <span>Startup &amp; Appearance</span>
                  </div>

                  {/* Startup & Animations Card */}
                  <div className="neural-glass-subtle rounded-2xl p-4 border border-slate-200 dark:border-[#202938]/60 space-y-3">
                    <ToggleRow
                      label="LAUNCH AT STARTUP"
                      description="Start Myraa silently when Windows logs in"
                      checked={settings.autoStart}
                      onChange={(v) => {
                        onChange({ autoStart: v });
                        void fetch("/api/settings", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ autoStart: v }),
                        }).catch(() => {});
                      }}
                    />

                    <ToggleRow
                      label="UI ANIMATIONS"
                      description="Enable smooth motion, holographic glow, and transitions"
                      checked={settings.animations}
                      onChange={(v) => onChange({ animations: v })}
                    />

                    {settings.autoStart && (
                      <div className="mt-2 p-3 rounded-xl border border-emerald-500/20 bg-emerald-500/10 flex items-center gap-2">
                        <Check size={14} className="text-emerald-500 shrink-0" />
                        <span className="text-[11px] font-mono text-emerald-600 dark:text-emerald-300">
                          Myraa will auto-launch on next Windows login.
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Gemini Credentials Card */}
                  <div className="neural-glass-subtle rounded-2xl p-4 border border-slate-200 dark:border-[#202938]/60 space-y-3.5">
                    <div className="text-xs font-mono font-bold uppercase tracking-widest text-[#0284C7] flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <KeyRound size={13} />
                        <span>Gemini Live Credentials</span>
                      </div>
                      <a
                        href="https://aistudio.google.com/apikey"
                        target="_blank"
                        rel="noreferrer"
                        className="text-[10px] text-[#0284C7] hover:underline flex items-center gap-1 normal-case font-sans"
                      >
                        Get free key <ExternalLink size={10} />
                      </a>
                    </div>

                    {/* Status Badge */}
                    <div
                      className={`p-3 rounded-xl border flex items-center justify-between ${
                        apiKeyMeta.hasApiKey
                          ? "border-emerald-500/30 bg-emerald-500/10"
                          : "border-rose-500/30 bg-rose-500/10"
                      }`}
                    >
                      <div className="flex items-center gap-2.5">
                        <div
                          className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                            apiKeyMeta.hasApiKey ? "bg-emerald-500 shadow-[0_0_8px_#10B981] animate-pulse" : "bg-rose-500"
                          }`}
                        />
                        <div>
                          <div className="text-xs font-mono font-semibold text-slate-900 dark:text-[#F4F7FB]">
                            {apiKeyMeta.hasApiKey
                              ? !isLocalOrigin
                                ? "Server Gemini API Key Active"
                                : "API Key Configured"
                              : !isLocalOrigin
                              ? apiKeyMeta.isPlaceholder
                                ? "Server Key Is Unconfigured Placeholder"
                                : "No Server Gemini API Key Configured"
                              : "No Valid API Key"}
                          </div>
                          <div className="text-[10px] font-mono text-slate-600 dark:text-[#8994A6] mt-0.5">
                            {apiKeyMeta.hasApiKey
                              ? `Active: ${apiKeyMeta.masked || "Configured"} (${apiKeyMeta.source || "server"})`
                              : !isLocalOrigin
                              ? "Configure GEMINI_API_KEY in Render Dashboard (Environment)"
                              : "Enter your Google Gemini API key below"}
                          </div>
                        </div>
                      </div>
                      {apiKeyMeta.hasApiKey && isLocalOrigin && (
                        <button
                          type="button"
                          onClick={handleClearApiKey}
                          title="Remove API Key"
                          className="p-1.5 rounded-lg border border-slate-200 dark:border-[#202938]/60 hover:border-rose-500/40 hover:bg-rose-500/10 text-slate-500 dark:text-[#8994A6] hover:text-rose-500 transition cursor-pointer"
                        >
                          <Trash2 size={13} />
                        </button>
                      )}
                    </div>

                    {!isLocalOrigin ? (
                      <div className="p-3.5 rounded-xl border border-blue-500/20 bg-blue-500/5 text-xs font-mono space-y-2">
                        <div className="text-[#0284C7] font-semibold flex items-center gap-1.5 text-[11px]">
                          <Shield size={13} />
                          <span>Server-Side Cloud Key Management</span>
                        </div>
                        <p className="text-[11px] text-slate-600 dark:text-[#8994A6] leading-relaxed">
                          In Cloud Companion mode, the Gemini API key is configured strictly on the server host (Render Dashboard → Environment) to protect secret credentials from client exposure.
                        </p>
                        {(!apiKeyMeta.hasApiKey || apiKeyMeta.isPlaceholder) && (
                          <div className="p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/20 text-[10px] text-amber-600 dark:text-amber-300 space-y-1">
                            <div className="font-semibold text-amber-700 dark:text-amber-200">Action Required in Render Dashboard:</div>
                            <div>1. Open Render → Your Web Service (<span className="font-bold">myraa-ai-q0h3</span>).</div>
                            <div>2. Go to the <span className="font-semibold">Environment</span> tab.</div>
                            <div>3. Set <span className="font-semibold">GEMINI_API_KEY</span> to your real Google Gemini API key (starts with <span className="font-bold">AIzaSy</span>).</div>
                            <div>4. Save Changes to trigger automated redeployment.</div>
                          </div>
                        )}
                      </div>
                    ) : (
                      <>
                        {/* Input form for local desktop Electron / development */}
                        <form onSubmit={handleSaveApiKey} className="space-y-2.5">
                          <div className="relative">
                            <input
                              id="gemini-api-key-input"
                              name="geminiApiKey"
                              autoComplete="new-password"
                              aria-label="Gemini API Key"
                              type={showApiKey ? "text" : "password"}
                              value={apiKeyInput}
                              onChange={(e) => setApiKeyInput(e.target.value)}
                              placeholder={apiKeyMeta.hasApiKey ? "Replace with new API or Auth key" : "Paste API key (AIza… or AQ.…)"}
                              className="w-full pl-3 pr-10 py-2.5 rounded-xl border border-slate-300 dark:border-[#202938] bg-white dark:bg-white/5 text-xs text-slate-900 dark:text-[#F4F7FB] font-mono focus:outline-none focus:border-[#0284C7] transition placeholder-slate-400 dark:placeholder-slate-500"
                            />
                            <button
                              type="button"
                              onClick={() => setShowApiKey(!showApiKey)}
                              className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 dark:text-[#8994A6] hover:text-slate-900 dark:hover:text-[#F4F7FB] transition cursor-pointer"
                            >
                              {showApiKey ? <EyeOff size={14} /> : <Eye size={14} />}
                            </button>
                          </div>

                          {keyStatusMsg && (
                            <div
                              className={`p-2.5 rounded-xl border text-[11px] font-mono leading-relaxed ${
                                keyStatusMsg.type === "success"
                                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300"
                                  : "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-300"
                              }`}
                            >
                              {keyStatusMsg.text}
                            </div>
                          )}

                          <button
                            type="submit"
                            disabled={savingKey || !apiKeyInput.trim()}
                            className="w-full py-2.5 rounded-xl bg-gradient-to-r from-blue-600 via-sky-500 to-cyan-500 text-xs font-mono font-semibold text-white shadow-md hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed transition flex items-center justify-center gap-1.5 cursor-pointer"
                          >
                            {savingKey ? (
                              <>
                                <Loader2 size={13} className="animate-spin" />
                                <span>Validating with Google...</span>
                              </>
                            ) : (
                              <>
                                <KeyRound size={13} />
                                <span>Save &amp; Activate Key</span>
                              </>
                            )}
                          </button>
                        </form>

                        <p className="text-[10px] text-slate-600 dark:text-[#8994A6] font-mono leading-relaxed">
                          Supports Google Gemini API keys (<span className="text-[#0284C7] font-bold">AIza...</span>) and AI Studio Auth keys (<span className="text-[#0284C7] font-bold">AQ....</span>). Stored securely and never exposed.
                        </p>
                      </>
                    )}
                  </div>

                  {/* Cloud Companion Device Card */}
                  {remoteSession && (
                    <div className="neural-glass-subtle rounded-2xl p-4 border border-slate-200 dark:border-[#202938]/60 space-y-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Shield size={14} className="text-[#0284C7]" />
                          <span className="text-xs font-mono font-bold text-slate-900 dark:text-[#F4F7FB]">Cloud Companion Device</span>
                        </div>
                        <span className="text-[10px] font-mono text-emerald-600 dark:text-emerald-400 font-semibold px-2 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/20">
                          Authenticated
                        </span>
                      </div>
                      <div className="space-y-1.5 text-[11px] font-mono text-slate-600 dark:text-[#8994A6]">
                        <div className="flex justify-between">
                          <span>DEVICE NAME</span>
                          <span className="text-slate-900 dark:text-[#F4F7FB] font-medium">{remoteSession.deviceName}</span>
                        </div>
                        <div className="flex justify-between">
                          <span>ROLE</span>
                          <span className="text-[#0284C7] uppercase font-bold">{liveRole || remoteSession.role}</span>
                        </div>
                        <div className="flex justify-between">
                          <span>DEVICE ID</span>
                          <span className="text-slate-500 dark:text-[#8994A6] font-mono">{remoteSession.deviceId.slice(0, 10)}...</span>
                        </div>
                      </div>

                      {/* Admin-Only Secondary Device Pairing Button */}
                      {(liveRole || remoteSession.role) === "admin" && (
                        <div className="pt-2 border-t border-slate-200 dark:border-[#202938]/60 space-y-2.5">
                          <button
                            onClick={handleGeneratePairCode}
                            disabled={isGeneratingPairCode}
                            type="button"
                            className="w-full py-2 px-3 rounded-xl border border-[#0284C7]/40 bg-[#0284C7]/15 hover:bg-[#0284C7]/25 text-xs font-mono text-[#0284C7] font-semibold flex items-center justify-center gap-2 transition cursor-pointer shadow-sm"
                          >
                            {isGeneratingPairCode ? (
                              <>
                                <Loader2 size={13} className="animate-spin text-[#0284C7]" />
                                <span>Generating Pairing PIN...</span>
                              </>
                            ) : (
                              <>
                                <KeyRound size={13} className="text-[#0284C7]" />
                                <span>Pair Another Device</span>
                              </>
                            )}
                          </button>

                          {/* Active Generated Pairing PIN Display */}
                          {generatedPairCode && (
                            <div className="p-3.5 rounded-xl border border-[#0284C7]/30 bg-[#0284C7]/10 space-y-2">
                              <div className="flex items-center justify-between">
                                <span className="text-[10px] font-mono font-bold text-[#0284C7] uppercase tracking-wider">
                                  Secondary Device PIN
                                </span>
                                <span className="text-[10px] font-mono text-[#0284C7] font-semibold bg-[#0284C7]/10 px-2 py-0.5 rounded border border-[#0284C7]/20">
                                  {Math.floor(countdownSeconds / 60)}:{(countdownSeconds % 60).toString().padStart(2, "0")}
                                </span>
                              </div>
                              <div className="flex items-center justify-center py-2 bg-white/60 dark:bg-black/40 rounded-lg border border-[#0284C7]/20">
                                <span className="text-2xl font-mono font-bold tracking-[0.3em] text-slate-900 dark:text-[#F4F7FB] select-all">
                                  {generatedPairCode.code}
                                </span>
                              </div>
                              <div className="flex gap-2">
                                <button
                                  type="button"
                                  onClick={() => {
                                    navigator.clipboard?.writeText(generatedPairCode.code);
                                    setCopiedCode(true);
                                    setTimeout(() => setCopiedCode(false), 2000);
                                  }}
                                  className="flex-1 py-1.5 px-2 rounded-lg border border-[#0284C7]/30 bg-[#0284C7]/10 hover:bg-[#0284C7]/20 text-[11px] font-mono text-[#0284C7] flex items-center justify-center gap-1.5 transition cursor-pointer"
                                >
                                  {copiedCode ? <Check size={12} className="text-emerald-500" /> : <Sparkles size={12} />}
                                  <span>{copiedCode ? "Copied!" : "Copy PIN"}</span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setGeneratedPairCode(null)}
                                  className="py-1.5 px-3 rounded-lg border border-slate-200 dark:border-[#202938]/60 bg-transparent text-[11px] font-mono text-slate-600 dark:text-[#8994A6] hover:text-slate-900 dark:hover:text-[#F4F7FB] transition cursor-pointer"
                                >
                                  Dismiss
                                </button>
                              </div>
                              <p className="text-[10px] font-mono text-slate-600 dark:text-[#8994A6] text-center leading-tight">
                                Enter this 6-character PIN on your PC to pair as a standard companion device. Single-use PIN.
                              </p>
                            </div>
                          )}

                          {pairCodeError && (
                            <div className="p-2.5 rounded-lg border border-rose-500/30 bg-rose-500/10 text-[10px] font-mono text-rose-600 dark:text-rose-300 flex items-center gap-1.5">
                              <AlertTriangle size={12} className="shrink-0 text-rose-500" />
                              <span>{pairCodeError}</span>
                            </div>
                          )}
                        </div>
                      )}

                      {onUnpair && (
                        <button
                          onClick={onUnpair}
                          type="button"
                          className="w-full py-2 px-3 rounded-xl border border-rose-500/30 bg-rose-500/10 hover:bg-rose-500/20 text-xs font-mono text-rose-500 flex items-center justify-center gap-1.5 transition cursor-pointer"
                        >
                          <Trash2 size={12} />
                          <span>Unpair Device</span>
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* ---------------- 2. VOICE ---------------- */}
              {activeTab === "voice" && (
                <div className="space-y-4">
                  <div className="text-xs font-mono font-bold uppercase tracking-widest text-[#0284C7] flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      <Globe size={13} />
                      <span>Language &amp; Voice Engine</span>
                    </div>
                    <span className="text-[10px] text-[#0284C7] font-mono">10 Languages</span>
                  </div>

                  {/* Language Selection Card */}
                  <div className="neural-glass-subtle rounded-2xl p-4 border border-slate-200 dark:border-[#202938]/60 space-y-3">
                    <div className="space-y-1.5">
                      <label htmlFor="language-select" className="block text-[11px] font-mono font-semibold tracking-wider text-slate-900 dark:text-[#F4F7FB] uppercase">
                        Conversation Language
                      </label>
                      <select
                        id="language-select"
                        name="languagePreference"
                        aria-label="Conversation Language"
                        value={settings.languagePreference || "auto"}
                        onChange={(e) => {
                          const lang = e.target.value as SupportedLanguageSetting;
                          onChange({ languagePreference: lang });
                          void fetch("/api/voice/language", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ language: lang }),
                          }).catch(() => {});
                        }}
                        className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 dark:border-[#202938] bg-white dark:bg-white/5 text-xs text-slate-900 dark:text-[#F4F7FB] font-mono focus:outline-none focus:border-[#0284C7] transition cursor-pointer"
                      >
                        <option value="auto">🌐 Auto Detect (Real-Time)</option>
                        <option value="hindi">🇮🇳 Hindi (हिन्दी)</option>
                        <option value="english">🇺🇸 English</option>
                        <option value="hinglish">🇮🇳 Hinglish (Hindi + English)</option>
                        <option value="bengali">🇮🇳 Bengali (বাংলা)</option>
                        <option value="bhojpuri">🇮🇳 Bhojpuri (भोजपुरी)</option>
                        <option value="maithili">🇮🇳 Maithili (मैथिली)</option>
                        <option value="japanese">🇯🇵 Japanese (日本語)</option>
                        <option value="tamil">🇮🇳 Tamil (தமிழ்)</option>
                        <option value="telugu">🇮🇳 Telugu (తెలుగు)</option>
                        <option value="russian">🇷🇺 Russian (Русский)</option>
                      </select>
                      <div className="text-[10px] font-mono text-slate-600 dark:text-[#8994A6] flex items-center justify-between mt-1">
                        <span>
                          {settings.languagePreference === "auto" || !settings.languagePreference
                            ? "Auto-detects spoken language dynamically"
                            : `Locked to ${settings.languagePreference.toUpperCase()}`}
                        </span>
                        <span className="text-[#0284C7] font-semibold">
                          {settings.languagePreference === "bhojpuri" || settings.languagePreference === "maithili"
                            ? "Dialectal Prosody Active"
                            : "Native Voice Engine Active"}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Wake Word & Hardware Card */}
                  <div className="text-xs font-mono font-bold uppercase tracking-widest text-[#0284C7] flex items-center gap-1.5 pt-2">
                    <Mic size={13} />
                    <span>Wake Word &amp; Microphone</span>
                  </div>

                  <div className="neural-glass-subtle rounded-2xl p-4 border border-slate-200 dark:border-[#202938]/60 space-y-3.5">
                    <ToggleRow
                      label="WAKE WORD DETECTION"
                      description="Always listen for the hands-free activation phrase"
                      checked={settings.wakeWordEnabled}
                      onChange={(v) => onChange({ wakeWordEnabled: v })}
                    />

                    <div className="space-y-1.5 pt-1">
                      <label htmlFor="wake-phrase-input" className="block text-[11px] font-mono font-semibold tracking-wider text-slate-900 dark:text-[#F4F7FB] uppercase">
                        Wake Phrase
                      </label>
                      <input
                        id="wake-phrase-input"
                        name="wakePhrase"
                        type="text"
                        value={settings.wakePhrase}
                        onChange={(e) => onChange({ wakePhrase: e.target.value })}
                        placeholder="hey myraa"
                        className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 dark:border-[#202938] bg-white dark:bg-white/5 text-xs text-slate-900 dark:text-[#F4F7FB] font-mono focus:outline-none focus:border-[#0284C7] transition placeholder-slate-400 dark:placeholder-slate-500"
                      />
                      <span className="text-[10px] text-slate-600 dark:text-[#8994A6] uppercase font-mono">
                        Say this phrase to activate MYRAA voice processing
                      </span>
                    </div>

                    <div className="space-y-1.5 pt-1">
                      <label htmlFor="mic-device-select" className="block text-[11px] font-mono font-semibold tracking-wider text-slate-900 dark:text-[#F4F7FB] uppercase">
                        Microphone Input Device
                      </label>
                      <select
                        id="mic-device-select"
                        name="micDeviceId"
                        value={settings.micDeviceId}
                        onChange={(e) => onChange({ micDeviceId: e.target.value })}
                        className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 dark:border-[#202938] bg-white dark:bg-white/5 text-xs text-slate-900 dark:text-[#F4F7FB] font-mono focus:outline-none focus:border-[#0284C7] transition cursor-pointer"
                      >
                        <option value="">System Default</option>
                        {mics.map((m, i) => (
                          <option key={m.deviceId || i} value={m.deviceId}>
                            {m.label || `Microphone ${i + 1}`}
                          </option>
                        ))}
                      </select>
                      <span className="text-[10px] text-slate-600 dark:text-[#8994A6] uppercase font-mono">
                        {mics.length === 0
                          ? "Grant mic permission to list available devices"
                          : `${mics.length} audio input device(s) detected`}
                      </span>
                    </div>

                    <div className="space-y-1.5 pt-1">
                      <div className="flex items-center justify-between">
                        <label htmlFor="sensitivity-slider" className="block text-[11px] font-mono font-semibold tracking-wider text-slate-900 dark:text-[#F4F7FB] uppercase">
                          Wake Sensitivity
                        </label>
                        <span className="text-xs font-mono text-[#0284C7] font-bold">
                          {settings.sensitivity}%
                        </span>
                      </div>
                      <input
                        id="sensitivity-slider"
                        name="sensitivity"
                        type="range"
                        min={0}
                        max={100}
                        value={settings.sensitivity}
                        onChange={(e) => onChange({ sensitivity: Number(e.target.value) })}
                        className="w-full accent-[#0284C7] cursor-pointer"
                      />
                      <span className="text-[10px] text-slate-600 dark:text-[#8994A6] uppercase font-mono">
                        Higher = faster re-arm &amp; more matches
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {/* ---------------- 3. SYSTEM ---------------- */}
              {activeTab === "system" && (
                <div className="space-y-4">
                  <div className="text-xs font-mono font-bold uppercase tracking-widest text-[#0284C7] flex items-center gap-1.5">
                    <Cpu size={13} />
                    <span>Desktop Control Agent</span>
                  </div>

                  {/* Agent Health Card */}
                  <div
                    className={`p-4 rounded-2xl border flex items-center gap-3.5 ${
                      agentHealth.online
                        ? "border-emerald-500/30 bg-emerald-500/10"
                        : "border-rose-500/30 bg-rose-500/10"
                    }`}
                  >
                    <div
                      className={`w-3 h-3 rounded-full shrink-0 ${
                        agentHealth.online ? "bg-emerald-500 shadow-[0_0_8px_#10B981] animate-pulse" : "bg-rose-500"
                      }`}
                    />
                    <div className="flex-1">
                      <div className="text-xs font-mono font-bold text-slate-900 dark:text-[#F4F7FB]">
                        {agentHealth.online ? "Desktop Agent Online" : "Desktop Agent Offline"}
                      </div>
                      <div className="text-[10px] font-mono text-slate-600 dark:text-[#8994A6] mt-0.5">
                        {agentHealth.online
                          ? `${agentHealth.toolCount ?? 0} native OS tools registered`
                          : "FastAPI agent service listening on port 8765"}
                      </div>
                    </div>
                    <Cpu size={18} className="text-slate-500 dark:text-[#8994A6]" />
                  </div>

                  {/* Capabilities Card */}
                  <div className="neural-glass-subtle rounded-2xl p-4 border border-slate-200 dark:border-[#202938]/60 space-y-3">
                    <div className="flex items-center gap-2 text-xs font-mono text-[#0284C7] font-semibold uppercase tracking-wider">
                      <Volume2 size={13} /> Native System Capabilities
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-xs font-mono text-slate-800 dark:text-[#F4F7FB]">
                      <div className="flex items-center gap-1.5">
                        <Check size={12} className="text-emerald-500 shrink-0" />
                        <span>App control</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Check size={12} className="text-emerald-500 shrink-0" />
                        <span>Browser execution</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Check size={12} className="text-emerald-500 shrink-0" />
                        <span>Volume &amp; Audio</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Check size={12} className="text-emerald-500 shrink-0" />
                        <span>Brightness</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Check size={12} className="text-emerald-500 shrink-0" />
                        <span>Power controls</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Check size={12} className="text-emerald-500 shrink-0" />
                        <span>File operations</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Check size={12} className="text-emerald-500 shrink-0" />
                        <span>Screenshot perception</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Check size={12} className="text-emerald-500 shrink-0" />
                        <span>Clipboard sync</span>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* ---------------- 4. SECURITY ---------------- */}
              {activeTab === "security" && (
                <div className="space-y-4">
                  <div className="text-xs font-mono font-bold uppercase tracking-widest text-[#0284C7] flex items-center gap-1.5">
                    <ShieldCheck size={13} />
                    <span>Zero-Trust Security &amp; Guardrails</span>
                  </div>

                  {/* System Status Card */}
                  <div className="p-4 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <ShieldCheck size={16} className="text-emerald-500" />
                        <span className="text-xs font-mono font-bold text-slate-900 dark:text-[#F4F7FB] uppercase tracking-wider">
                          Zero-Trust Policy Core
                        </span>
                      </div>
                      <span className="text-[10px] font-mono text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20 font-semibold">
                        ACTIVE
                      </span>
                    </div>
                    <p className="text-[11px] font-sans text-slate-600 dark:text-[#8994A6] leading-relaxed">
                      Every tool invocation, desktop agent task, and memory query is evaluated against strict real-time safety policies and confirmation tiers.
                    </p>
                  </div>

                  {/* Active Defense Tiers */}
                  <div className="neural-glass-subtle rounded-2xl p-4 border border-slate-200 dark:border-[#202938]/60 space-y-3">
                    <div className="text-xs font-mono font-bold text-[#0284C7] uppercase tracking-wider">
                      Active Defense Tiers
                    </div>
                    <div className="space-y-2 text-xs font-mono">
                      <div className="flex items-center justify-between">
                        <span className="text-slate-600 dark:text-[#8994A6]">Policy Engine</span>
                        <span className="text-emerald-600 dark:text-emerald-400 font-medium">● Enforced</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-slate-600 dark:text-[#8994A6]">Risk Evaluator</span>
                        <span className="text-emerald-600 dark:text-emerald-400 font-medium">● 3-Tier Guard</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-slate-600 dark:text-[#8994A6]">Tool Firewall</span>
                        <span className="text-emerald-600 dark:text-emerald-400 font-medium">● 129 Tools Protected</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-slate-600 dark:text-[#8994A6]">Data Loss Prevention (DLP)</span>
                        <span className="text-emerald-600 dark:text-emerald-400 font-medium">● Token Redaction On</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-slate-600 dark:text-[#8994A6]">Audit Trail</span>
                        <span className="text-emerald-600 dark:text-emerald-400 font-medium">● Cryptographic Log</span>
                      </div>
                    </div>
                  </div>

                  {/* Toggles */}
                  <div className="neural-glass-subtle rounded-2xl p-4 border border-slate-200 dark:border-[#202938]/60 space-y-3">
                    <ToggleRow
                      label="STRICT TOOL CONFIRMATION"
                      description="Require confirmation prompt before executing high-risk file modifications or system bash commands"
                      checked={true}
                      onChange={() => {}}
                    />

                    <ToggleRow
                      label="AUTOMATIC SECRET MASKING"
                      description="Redact API keys, tokens, and credentials from terminal and screen context before cloud processing"
                      checked={true}
                      onChange={() => {}}
                    />
                  </div>

                  {/* Emergency Stop Safe Halt */}
                  <div className="neural-glass-subtle rounded-2xl p-4 border border-rose-500/20 bg-rose-500/5 flex items-center justify-between">
                    <div>
                      <div className="text-xs font-mono font-bold text-slate-900 dark:text-[#F4F7FB]">Emergency Safe Halt</div>
                      <div className="text-[10px] font-mono text-slate-600 dark:text-[#8994A6]">Instantly pause all active background agents</div>
                    </div>
                    <button
                      onClick={async () => {
                        if (confirm("Trigger Emergency Stop? All active background tasks and agents will halt immediately.")) {
                          try {
                            await fetch("/api/remote/emergency-stop", {
                              method: "POST",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ reason: "Manual Emergency Halt via Settings" }),
                            });
                            alert("Emergency Stop activated.");
                          } catch {}
                        }
                      }}
                      className="px-3.5 py-2 rounded-xl border border-rose-500/40 text-rose-500 hover:bg-rose-500/10 text-xs font-mono font-semibold transition cursor-pointer"
                    >
                      Safe Halt
                    </button>
                  </div>
                </div>
              )}

              {/* ---------------- 5. MEMORY ---------------- */}
              {activeTab === "memory" && (
                <div className="space-y-4">
                  <div className="text-xs font-mono font-bold uppercase tracking-widest text-[#0284C7] flex items-center gap-1.5">
                    <Brain size={13} />
                    <span>Persistent Recollections &amp; Brain</span>
                  </div>

                  {/* Memory Subsystem Card */}
                  <div className="p-4 rounded-2xl border border-[#0284C7]/30 bg-[#0284C7]/10 space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Brain size={16} className="text-[#0284C7]" />
                        <span className="text-xs font-mono font-bold text-slate-900 dark:text-[#F4F7FB] uppercase tracking-wider">
                          Neural Knowledge Core
                        </span>
                      </div>
                      <span className="text-[10px] font-mono text-[#0284C7] bg-[#0284C7]/15 px-2 py-0.5 rounded-full border border-[#0284C7]/30 font-semibold">
                        {memories ? `${memories.length} STORED` : "ONLINE"}
                      </span>
                    </div>
                    <p className="text-[11px] font-sans text-slate-600 dark:text-[#8994A6] leading-relaxed">
                      MYRAA preserves long-term project context, developer preferences, and conversational insights across sessions.
                    </p>
                  </div>

                  {/* Architecture Details */}
                  <div className="neural-glass-subtle rounded-2xl p-4 border border-slate-200 dark:border-[#202938]/60 space-y-3">
                    <div className="text-xs font-mono font-bold text-[#0284C7] uppercase tracking-wider">
                      Memory Subsystems
                    </div>
                    <div className="space-y-2 text-xs font-mono">
                      <div className="flex items-center justify-between">
                        <span className="text-slate-600 dark:text-[#8994A6]">Episodic Memory</span>
                        <span className="text-emerald-600 dark:text-emerald-400 font-medium">● Active</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-slate-600 dark:text-[#8994A6]">Semantic Knowledge</span>
                        <span className="text-emerald-600 dark:text-emerald-400 font-medium">● Connected</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-slate-600 dark:text-[#8994A6]">Working Workspace Cache</span>
                        <span className="text-[#0284C7] font-medium">● 12 Sources Sync</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-slate-600 dark:text-[#8994A6]">Device Boundary</span>
                        <span className="text-slate-900 dark:text-[#F4F7FB] font-medium">Isolated / Encrypted</span>
                      </div>
                    </div>
                  </div>

                  {/* Toggles */}
                  <div className="neural-glass-subtle rounded-2xl p-4 border border-slate-200 dark:border-[#202938]/60 space-y-3">
                    <ToggleRow
                      label="AUTO-LEARN PREFERENCES"
                      description="Automatically extract key facts, coding patterns, and project habits"
                      checked={true}
                      onChange={() => {}}
                    />

                    <ToggleRow
                      label="STRICT LOCAL MEMORY ISOLATION"
                      description="Prevent memory synchronization to remote cloud companion devices"
                      checked={false}
                      onChange={() => {}}
                    />
                  </div>

                  {/* Actions */}
                  <div className="neural-glass-subtle rounded-2xl p-4 border border-slate-200 dark:border-[#202938]/60 flex items-center justify-between">
                    <button
                      onClick={() => {
                        onClose();
                        onOpenMemoryDashboard?.();
                      }}
                      className="px-4 py-2 rounded-xl bg-[#0284C7]/15 border border-[#0284C7]/40 text-[#0284C7] hover:bg-[#0284C7]/25 text-xs font-mono font-semibold transition cursor-pointer flex items-center gap-1.5"
                    >
                      <Database size={13} />
                      <span>Open Memory Database</span>
                    </button>
                    <span className="text-[10px] font-mono text-slate-600 dark:text-[#8994A6]">Encrypted on disk</span>
                  </div>
                </div>
              )}

              {/* ---------------- 6. ABOUT ---------------- */}
              {activeTab === "about" && (
                <div className="space-y-4">
                  <div className="text-xs font-mono font-bold uppercase tracking-widest text-[#0284C7] flex items-center gap-1.5">
                    <Info size={13} />
                    <span>About Myraa</span>
                  </div>

                  <div className="neural-glass-subtle rounded-2xl p-4 border border-slate-200 dark:border-[#202938]/60 space-y-3.5">
                    <div className="flex items-center gap-2">
                      <Info size={16} className="text-[#0284C7]" />
                      <span className="text-sm font-display font-semibold text-slate-900 dark:text-[#F4F7FB]">MYRAA AI Assistant</span>
                    </div>
                    <div className="space-y-2 text-xs font-mono text-slate-600 dark:text-[#8994A6]">
                      <div className="flex justify-between border-b border-slate-200 dark:border-[#202938]/40 pb-1.5">
                        <span>VERSION</span>
                        <span className="text-slate-900 dark:text-[#F4F7FB] font-semibold">V2.0.0</span>
                      </div>
                      <div className="flex justify-between border-b border-slate-200 dark:border-[#202938]/40 pb-1.5">
                        <span>ENGINE</span>
                        <span className="text-slate-900 dark:text-[#F4F7FB] font-semibold">Gemini Live</span>
                      </div>
                      <div className="flex justify-between border-b border-slate-200 dark:border-[#202938]/40 pb-1.5">
                        <span>DESKTOP</span>
                        <span className="text-slate-900 dark:text-[#F4F7FB] font-semibold">FastAPI Agent</span>
                      </div>
                      <div className="flex justify-between border-b border-slate-200 dark:border-[#202938]/40 pb-1.5">
                        <span>WAKE WORD</span>
                        <span className="text-slate-900 dark:text-[#F4F7FB] font-semibold">Web Speech API</span>
                      </div>
                      <div className="flex justify-between border-b border-slate-200 dark:border-[#202938]/40 pb-1.5">
                        <span>DEVELOPER</span>
                        <span className="text-[#0284C7] font-semibold">Sandeep Mishra</span>
                      </div>
                      <div className="flex justify-between">
                        <span>COMPANY</span>
                        <span className="text-[#0284C7] font-semibold">Mishtron Labs</span>
                      </div>
                    </div>
                  </div>

                  <div className="p-3.5 rounded-2xl border border-amber-500/20 bg-amber-500/10 flex items-start gap-2.5">
                    <AlertTriangle size={14} className="text-amber-500 shrink-0 mt-0.5" />
                    <span className="text-[11px] font-mono text-amber-700 dark:text-amber-300 leading-relaxed">
                      Keep this desktop application active for wake-word detection. Microphone permission is required for real-time voice activation.
                    </span>
                  </div>
                </div>
              )}
            </div>

            {/* Footer status bar */}
            <div className="px-6 py-3 border-t border-slate-200 dark:border-[#202938]/60 neural-glass-subtle flex items-center justify-between">
              <span className="text-[10px] font-mono uppercase tracking-widest text-slate-500 dark:text-[#8994A6]">
                Preferences auto-save
              </span>
              <span className="text-[10px] font-mono uppercase tracking-widest text-[#0284C7] font-semibold">
                Myraa V2 · Light Blue System
              </span>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
