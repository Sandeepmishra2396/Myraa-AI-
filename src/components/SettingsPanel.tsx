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
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { MyraaSettings, DEFAULT_SETTINGS, loadSettings, saveSettings } from "../lib/settingsStore";
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
}

type SettingsTab = "general" | "voice" | "system" | "about";

/** A single toggle row matching the existing "Screen Vision Mode" switch style. */
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
    <div className="pt-2 border-t border-white/5 flex items-center justify-between text-left">
      <div className="flex flex-col">
        <span className="text-[10px] font-bold font-mono text-slate-200">{label}</span>
        <span className="text-[8px] text-slate-400 uppercase font-mono max-w-[200px]">
          {description}
        </span>
      </div>
      <button
        onClick={() => onChange(!checked)}
        className={`w-10 h-5 rounded-full p-0.5 transition-colors duration-200 focus:outline-none cursor-pointer ${
          checked ? "bg-cyan-500" : "bg-white/10"
        }`}
      >
        <div
          className={`bg-white w-4 h-4 rounded-full shadow-md transform duration-200 ease-in-out ${
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
        return "border-indigo-500/30 text-indigo-400 bg-indigo-500/10";
    }
  };

  const tabs: { id: SettingsTab; label: string; icon: any }[] = [
    { id: "general", label: "GENERAL", icon: Power },
    { id: "voice", label: "VOICE", icon: Mic },
    { id: "system", label: "SYSTEM", icon: Cpu },
    { id: "about", label: "ABOUT", icon: Info },
  ];

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop Overlay — identical to MemoryDashboard */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="absolute inset-0 bg-black/60 z-40 backdrop-blur-sm"
          />

          {/* Slide-over Container — identical shell to MemoryDashboard */}
          <motion.div
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", damping: 25, stiffness: 200 }}
            className="absolute inset-y-0 right-0 w-full max-w-lg bg-[#020206]/95 border-l border-white/15 backdrop-blur-2xl z-50 flex flex-col shadow-[0_0_50px_rgba(0,0,0,0.8)]"
          >
            {/* Header */}
            <div className="p-6 border-b border-white/10 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className={`p-2.5 rounded-xl border ${getThemeBadgeGlow()}`}>
                  <Settings size={22} className="animate-spin [animation-duration:6s]" />
                </div>
                <div>
                  <h3 className="font-display font-medium text-lg tracking-tight text-white flex items-center gap-2">
                    Myraa Configuration
                    <Sparkles size={14} className="text-cyan-400" />
                  </h3>
                  <p className="text-[10px] font-mono uppercase tracking-widest text-slate-400 mt-0.5">
                    System settings &amp; preferences
                  </p>
                </div>
              </div>
              <button
                onClick={onClose}
                className="p-2 rounded-xl border border-white/5 bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white transition cursor-pointer"
              >
                <X size={18} />
              </button>
            </div>

            {/* Tab selector row — mirrors MemoryDashboard pill style */}
            <div className="px-6 py-4 border-b border-white/5 flex items-center gap-2 overflow-x-auto">
              {tabs.map((t) => {
                const Icon = t.icon;
                const active = activeTab === t.id;
                return (
                  <button
                    key={t.id}
                    onClick={() => setActiveTab(t.id)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-xs font-mono tracking-wider transition shrink-0 cursor-pointer ${
                      active
                        ? "border-cyan-400 bg-cyan-400/10 text-cyan-300"
                        : "border-white/5 bg-white/5 text-slate-400 hover:bg-white/10"
                    }`}
                  >
                    <Icon size={12} />
                    <span>{t.label}</span>
                  </button>
                );
              })}
            </div>

            {/* Scrollable content area */}
            <div className="flex-1 overflow-y-auto p-6 space-y-5">
              {/* ---------------- GENERAL ---------------- */}
              {activeTab === "general" && (
                <div className="space-y-4">
                  <div className="text-[10px] font-mono uppercase tracking-widest text-slate-500">
                    Startup &amp; Appearance
                  </div>

                  <ToggleRow
                    label="LAUNCH AT STARTUP"
                    description="Start Myraa silently when Windows logs in"
                    checked={settings.autoStart}
                    onChange={(v) => {
                      onChange({ autoStart: v });
                      // Persist + push to backend; the desktop agent flips the
                      // HKCU Run registry key. We just record intent here.
                      void fetch("/api/settings", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ autoStart: v }),
                      }).catch(() => {});
                    }}
                  />

                  <ToggleRow
                    label="UI ANIMATIONS"
                    description="Enable motion and orb transitions"
                    checked={settings.animations}
                    onChange={(v) => onChange({ animations: v })}
                  />

                  {settings.autoStart && (
                    <div className="mt-2 p-3 rounded-xl border border-emerald-500/20 bg-emerald-500/5 flex items-center gap-2">
                      <Check size={14} className="text-emerald-400 shrink-0" />
                      <span className="text-[10px] font-mono text-emerald-300/80">
                        Myraa will auto-launch on next Windows login.
                      </span>
                    </div>
                  )}

                  {/* --- Gemini Credentials Section --- */}
                  <div className="pt-4 border-t border-white/10 space-y-3">
                    <div className="text-[10px] font-mono uppercase tracking-widest text-slate-500 flex items-center justify-between">
                      <span>Gemini Live Credentials</span>
                      <a
                        href="https://aistudio.google.com/apikey"
                        target="_blank"
                        rel="noreferrer"
                        className="text-[9px] text-cyan-400 hover:text-cyan-300 flex items-center gap-1 normal-case font-sans"
                      >
                        Get free key <ExternalLink size={10} />
                      </a>
                    </div>

                    {/* Status Badge */}
                    <div
                      className={`p-3 rounded-xl border flex items-center justify-between ${
                        apiKeyMeta.hasApiKey
                          ? "border-emerald-500/20 bg-emerald-500/5"
                          : "border-rose-500/20 bg-rose-500/5"
                      }`}
                    >
                      <div className="flex items-center gap-2.5">
                        <div
                          className={`w-2 h-2 rounded-full shrink-0 ${
                            apiKeyMeta.hasApiKey ? "bg-emerald-400 animate-pulse" : "bg-rose-400"
                          }`}
                        />
                        <div>
                          <div className="text-xs font-mono text-white">
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
                          <div className="text-[10px] font-mono text-slate-400">
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
                          className="p-1.5 rounded-lg border border-white/10 hover:border-rose-500/40 bg-white/5 hover:bg-rose-500/10 text-slate-400 hover:text-rose-300 transition cursor-pointer"
                        >
                          <Trash2 size={13} />
                        </button>
                      )}
                    </div>

                    {!isLocalOrigin ? (
                      <div className="p-3.5 rounded-xl border border-indigo-500/20 bg-indigo-500/5 text-xs font-mono space-y-2">
                        <div className="text-indigo-300 font-semibold flex items-center gap-1.5 text-[11px]">
                          <Shield size={13} />
                          <span>Server-Side Cloud Key Management</span>
                        </div>
                        <p className="text-[10px] text-slate-400 leading-relaxed">
                          In Cloud Companion mode, the Gemini API key is configured strictly on the server host (Render Dashboard → Environment) to protect secret credentials from client exposure.
                        </p>
                        {(!apiKeyMeta.hasApiKey || apiKeyMeta.isPlaceholder) && (
                          <div className="p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/20 text-[10px] text-amber-300 space-y-1">
                            <div className="font-semibold text-amber-200">Action Required in Render Dashboard:</div>
                            <div>1. Open Render → Your Web Service (<span className="text-white">myraa-ai-q0h3</span>).</div>
                            <div>2. Go to the <span className="text-white font-semibold">Environment</span> tab.</div>
                            <div>3. Set <span className="text-white font-semibold">GEMINI_API_KEY</span> to your real Google Gemini API key (starts with <span className="text-white">AIzaSy</span>).</div>
                            <div>4. Save Changes to trigger automated redeployment.</div>
                          </div>
                        )}
                      </div>
                    ) : (
                      <>
                        {/* Input form for local desktop Electron / development */}
                        <form onSubmit={handleSaveApiKey} className="space-y-2">
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
                              className="w-full pl-3 pr-10 py-2 rounded-xl border border-white/10 bg-white/5 text-xs text-white font-mono focus:outline-none focus:border-cyan-400/50 transition"
                            />
                            <button
                              type="button"
                              onClick={() => setShowApiKey(!showApiKey)}
                              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white transition cursor-pointer"
                            >
                              {showApiKey ? <EyeOff size={14} /> : <Eye size={14} />}
                            </button>
                          </div>

                          {keyStatusMsg && (
                            <div
                              className={`p-2.5 rounded-xl border text-[10px] font-mono leading-relaxed ${
                                keyStatusMsg.type === "success"
                                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                                  : "border-rose-500/30 bg-rose-500/10 text-rose-300"
                              }`}
                            >
                              {keyStatusMsg.text}
                            </div>
                          )}

                          <button
                            type="submit"
                            disabled={savingKey || !apiKeyInput.trim()}
                            className="w-full py-2 rounded-xl bg-gradient-to-r from-indigo-500 to-cyan-500 text-xs font-mono font-semibold text-white hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed transition flex items-center justify-center gap-1.5 cursor-pointer"
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

                        <p className="text-[9px] text-slate-500 font-mono leading-relaxed">
                          Supports Google Gemini API keys (<span className="text-slate-300 font-bold">AIza...</span>) and AI Studio Auth keys (<span className="text-slate-300 font-bold">AQ....</span>). Stored locally and never exposed.
                        </p>
                      </>
                    )}
                  </div>

                  {remoteSession && (
                    <div className="p-4 rounded-xl border border-indigo-500/20 bg-indigo-500/5 space-y-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Shield size={14} className="text-indigo-400" />
                          <span className="text-xs font-mono text-white">Cloud Companion Device</span>
                        </div>
                        <span className="text-[10px] font-mono text-emerald-400 font-semibold px-2 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/20">
                          Authenticated
                        </span>
                      </div>
                      <div className="space-y-1 text-[10px] font-mono text-slate-400">
                        <div className="flex justify-between">
                          <span>DEVICE NAME</span>
                          <span className="text-slate-200">{remoteSession.deviceName}</span>
                        </div>
                        <div className="flex justify-between">
                          <span>ROLE</span>
                          <span className="text-indigo-300 uppercase font-bold">{liveRole || remoteSession.role}</span>
                        </div>
                        <div className="flex justify-between">
                          <span>DEVICE ID</span>
                          <span className="text-slate-300 font-mono">{remoteSession.deviceId.slice(0, 10)}...</span>
                        </div>
                      </div>

                      {/* Admin-Only Secondary Device Pairing Button */}
                      {(liveRole || remoteSession.role) === "admin" && (
                        <div className="pt-2 border-t border-indigo-500/20 space-y-2.5">
                          <button
                            onClick={handleGeneratePairCode}
                            disabled={isGeneratingPairCode}
                            type="button"
                            className="w-full py-2 px-3 rounded-lg border border-cyan-500/40 bg-cyan-500/15 hover:bg-cyan-500/25 text-xs font-mono text-cyan-200 font-semibold flex items-center justify-center gap-2 transition cursor-pointer shadow-sm shadow-cyan-500/10"
                          >
                            {isGeneratingPairCode ? (
                              <>
                                <Loader2 size={13} className="animate-spin text-cyan-400" />
                                <span>Generating Pairing PIN...</span>
                              </>
                            ) : (
                              <>
                                <KeyRound size={13} className="text-cyan-400" />
                                <span>Pair Another Device</span>
                              </>
                            )}
                          </button>

                          {/* Active Generated Pairing PIN Display */}
                          {generatedPairCode && (
                            <div className="p-3 rounded-xl border border-cyan-500/30 bg-cyan-950/40 space-y-2">
                              <div className="flex items-center justify-between">
                                <span className="text-[10px] font-mono font-bold text-cyan-300 uppercase tracking-wider">
                                  Secondary Device PIN
                                </span>
                                <span className="text-[10px] font-mono text-cyan-400 font-semibold bg-cyan-500/10 px-2 py-0.5 rounded border border-cyan-500/20">
                                  {Math.floor(countdownSeconds / 60)}:{(countdownSeconds % 60).toString().padStart(2, "0")}
                                </span>
                              </div>
                              <div className="flex items-center justify-center py-2 bg-black/40 rounded-lg border border-cyan-500/20">
                                <span className="text-2xl font-mono font-bold tracking-[0.3em] text-white select-all">
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
                                  className="flex-1 py-1.5 px-2 rounded-lg border border-cyan-500/30 bg-cyan-500/10 hover:bg-cyan-500/20 text-[11px] font-mono text-cyan-300 flex items-center justify-center gap-1.5 transition cursor-pointer"
                                >
                                  {copiedCode ? <Check size={12} className="text-emerald-400" /> : <Sparkles size={12} />}
                                  <span>{copiedCode ? "Copied!" : "Copy PIN"}</span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setGeneratedPairCode(null)}
                                  className="py-1.5 px-3 rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 text-[11px] font-mono text-slate-400 hover:text-white transition cursor-pointer"
                                >
                                  Dismiss
                                </button>
                              </div>
                              <p className="text-[9px] font-mono text-slate-400 text-center leading-tight">
                                Enter this 6-character PIN on your PC to pair as a standard companion device. Single-use PIN.
                              </p>
                            </div>
                          )}

                          {pairCodeError && (
                            <div className="p-2.5 rounded-lg border border-rose-500/30 bg-rose-500/10 text-[10px] font-mono text-rose-300 flex items-center gap-1.5">
                              <AlertTriangle size={12} className="shrink-0 text-rose-400" />
                              <span>{pairCodeError}</span>
                            </div>
                          )}
                        </div>
                      )}

                      {onUnpair && (
                        <button
                          onClick={onUnpair}
                          type="button"
                          className="w-full py-1.5 px-3 rounded-lg border border-rose-500/30 bg-rose-500/10 hover:bg-rose-500/20 text-xs font-mono text-rose-300 flex items-center justify-center gap-1.5 transition cursor-pointer"
                        >
                          <Trash2 size={12} />
                          <span>Unpair Device</span>
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* ---------------- VOICE ---------------- */}
              {activeTab === "voice" && (
                <div className="space-y-4">
                  <div className="text-[10px] font-mono uppercase tracking-widest text-slate-500">
                    Wake Word &amp; Microphone
                  </div>

                  <ToggleRow
                    label="WAKE WORD"
                    description="Always-listen for the activation phrase"
                    checked={settings.wakeWordEnabled}
                    onChange={(v) => onChange({ wakeWordEnabled: v })}
                  />

                  <div className="space-y-1.5">
                    <label htmlFor="wake-phrase-input" className="block text-[10px] font-mono tracking-wider text-slate-300 uppercase">
                      Wake Phrase
                    </label>
                    <input
                      id="wake-phrase-input"
                      name="wakePhrase"
                      type="text"
                      value={settings.wakePhrase}
                      onChange={(e) => onChange({ wakePhrase: e.target.value })}
                      placeholder="hey myraa"
                      className="w-full px-3 py-2 rounded-xl border border-white/10 bg-white/5 text-sm text-white font-mono focus:outline-none focus:border-cyan-400/50 transition"
                    />
                    <span className="text-[8px] text-slate-500 uppercase font-mono">
                      Say this phrase to activate Myraa
                    </span>
                  </div>

                  <div className="space-y-1.5">
                    <label htmlFor="mic-device-select" className="block text-[10px] font-mono tracking-wider text-slate-300 uppercase">
                      Microphone
                    </label>
                    <select
                      id="mic-device-select"
                      name="micDeviceId"
                      value={settings.micDeviceId}
                      onChange={(e) => onChange({ micDeviceId: e.target.value })}
                      className="w-full px-3 py-2 rounded-xl border border-white/10 bg-white/5 text-sm text-white font-mono focus:outline-none focus:border-cyan-400/50 transition cursor-pointer"
                    >
                      <option value="">System Default</option>
                      {mics.map((m, i) => (
                        <option key={m.deviceId || i} value={m.deviceId}>
                          {m.label || `Microphone ${i + 1}`}
                        </option>
                      ))}
                    </select>
                    <span className="text-[8px] text-slate-500 uppercase font-mono">
                      {mics.length === 0
                        ? "Grant mic permission to list devices"
                        : `${mics.length} device(s) detected`}
                    </span>
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <label htmlFor="sensitivity-slider" className="block text-[10px] font-mono tracking-wider text-slate-300 uppercase">
                        Sensitivity
                      </label>
                      <span className="text-[10px] font-mono text-cyan-300">
                        {settings.sensitivity}
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
                      className="w-full accent-cyan-500 cursor-pointer"
                    />
                    <span className="text-[8px] text-slate-500 uppercase font-mono">
                      Higher = faster re-arm &amp; more matches
                    </span>
                  </div>
                </div>
              )}

              {/* ---------------- SYSTEM ---------------- */}
              {activeTab === "system" && (
                <div className="space-y-4">
                  <div className="text-[10px] font-mono uppercase tracking-widest text-slate-500">
                    Desktop Control Agent
                  </div>

                  <div
                    className={`p-4 rounded-xl border flex items-center gap-3 ${
                      agentHealth.online
                        ? "border-emerald-500/20 bg-emerald-500/5"
                        : "border-rose-500/20 bg-rose-500/5"
                    }`}
                  >
                    <div
                      className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                        agentHealth.online ? "bg-emerald-400 animate-pulse" : "bg-rose-400"
                      }`}
                    />
                    <div className="flex-1">
                      <div className="text-xs font-mono text-white">
                        {agentHealth.online ? "Agent Online" : "Agent Offline"}
                      </div>
                      <div className="text-[10px] font-mono text-slate-400">
                        {agentHealth.online
                          ? `${agentHealth.toolCount ?? 0} tools registered`
                          : "Start the Python agent on port 8765"}
                      </div>
                    </div>
                    <Cpu size={16} className="text-slate-500" />
                  </div>

                  <div className="p-3 rounded-xl border border-white/5 bg-white/5 space-y-2">
                    <div className="flex items-center gap-2 text-[10px] font-mono text-slate-400 uppercase tracking-wider">
                      <Volume2 size={12} /> Capabilities
                    </div>
                    <div className="grid grid-cols-2 gap-1.5 text-[10px] font-mono text-slate-300">
                      <span>✓ App control</span>
                      <span>✓ Browser</span>
                      <span>✓ Volume</span>
                      <span>✓ Brightness</span>
                      <span>✓ Power</span>
                      <span>✓ Files</span>
                      <span>✓ Screenshot</span>
                      <span>✓ Clipboard</span>
                    </div>
                  </div>
                </div>
              )}

              {/* ---------------- ABOUT ---------------- */}
              {activeTab === "about" && (
                <div className="space-y-4">
                  <div className="text-[10px] font-mono uppercase tracking-widest text-slate-500">
                    About Myraa
                  </div>

                  <div className="p-4 rounded-xl border border-white/5 bg-white/5 space-y-3">
                    <div className="flex items-center gap-2">
                      <Info size={14} className="text-cyan-400" />
                      <span className="text-sm font-display text-white">MYRAA AI Assistant</span>
                    </div>
                    <div className="space-y-1.5 text-[10px] font-mono text-slate-400">
                      <div className="flex justify-between">
                        <span>VERSION</span>
                        <span className="text-slate-300">V2.0.0</span>
                      </div>
                      <div className="flex justify-between">
                        <span>ENGINE</span>
                        <span className="text-slate-300">Gemini Live</span>
                      </div>
                      <div className="flex justify-between">
                        <span>DESKTOP</span>
                        <span className="text-slate-300">FastAPI Agent</span>
                      </div>
                      <div className="flex justify-between">
                        <span>WAKE WORD</span>
                        <span className="text-slate-300">Web Speech API</span>
                      </div>
                      <div className="flex justify-between">
                        <span>DEVELOPER</span>
                        <span className="text-cyan-300">Sandeep Mishra</span>
                      </div>
                      <div className="flex justify-between">
                        <span>COMPANY</span>
                        <span className="text-cyan-300">Mishtron Labs</span>
                      </div>
                    </div>
                  </div>

                  <div className="p-3 rounded-xl border border-amber-500/15 bg-amber-500/5 flex items-start gap-2">
                    <AlertTriangle size={12} className="text-amber-400 shrink-0 mt-0.5" />
                    <span className="text-[10px] font-mono text-amber-300/70 leading-relaxed">
                      Keep this tab active for wake-word detection. Microphone access
                      is required for voice activation.
                    </span>
                  </div>
                </div>
              )}
            </div>

            {/* Footer status bar — mirrors MemoryDashboard */}
            <div className="px-6 py-3 border-t border-white/5 bg-white/5 flex items-center justify-between">
              <span className="text-[9px] font-mono uppercase tracking-widest text-slate-500">
                Preferences auto-save
              </span>
              <span className="text-[9px] font-mono uppercase tracking-widest text-slate-500">
                Myraa V2
              </span>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
