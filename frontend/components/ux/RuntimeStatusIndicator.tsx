import React, { useState, useEffect } from "react";
import {
  Server,
  Cpu,
  Cloud,
  CloudOff,
  Shield,
  Sparkles,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  X,
  ExternalLink,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import {
  getRuntimeMode,
  isDesktopLocal,
  getBackendBaseUrl,
  getDesktopAgentUrl,
  getCloudBackendUrl,
  RuntimeSystemStatus,
} from "../../../platform/runtimeMode";

export const RuntimeStatusIndicator: React.FC = () => {
  const [showModal, setShowModal] = useState<boolean>(false);
  const [isRetryingAgent, setIsRetryingAgent] = useState<boolean>(false);
  const [status, setStatus] = useState<RuntimeSystemStatus>(() => {
    const isDesk = isDesktopLocal();
    return {
      runtimeMode: getRuntimeMode(),
      isDesktop: isDesk,
      backend: isDesk ? "LOCAL" : "CLOUD",
      backendUrl: getBackendBaseUrl(),
      localBackendPort: (window as any).myraa?.localBackendPort ?? (isDesk ? 3000 : null),
      desktopAgent: isDesk ? "STARTING" : "OFFLINE",
      desktopAgentUrl: getDesktopAgentUrl(),
      desktopAgentToolCount: 0,
      gemini: "CONNECTING",
      cloudServices: "CONNECTING",
      cloudUrl: getCloudBackendUrl(),
      security: "ACTIVE",
      isOfflineMode: false,
    };
  });

  const pollSystemStatus = async () => {
    try {
      if ((window as any).myraa?.getSystemStatus) {
        const sys = await (window as any).myraa.getSystemStatus();
        if (sys) {
          setStatus((prev) => ({
            ...prev,
            ...sys,
            runtimeMode: sys.runtimeMode || prev.runtimeMode,
            backendUrl: sys.backendUrl || prev.backendUrl,
          }));
          return;
        }
      }

      // Web/Cloud fallback polling
      const isDesk = isDesktopLocal();
      let agentOnline = false;
      let toolCount = 0;
      let agentVer = "";

      // Probe agent if on desktop
      if (isDesk) {
        try {
          const agentRes = await fetch("http://127.0.0.1:8765/health", { cache: "no-store" });
          if (agentRes.ok) {
            const data = await agentRes.json();
            agentOnline = true;
            toolCount = data.tool_count || (Array.isArray(data.tools) ? data.tools.length : 0);
            agentVer = data.version || "1.0.0";
          }
        } catch {
          agentOnline = false;
        }
      }

      // Probe local or cloud backend /health
      let backendOk = false;
      try {
        const healthRes = await fetch("/health", { cache: "no-store" });
        backendOk = healthRes.ok;
      } catch {
        backendOk = false;
      }

      // Probe cloud internet connectivity
      let cloudConnected = false;
      try {
        const cloudRes = await fetch("https://myraa-ai-q0h3.onrender.com/health", {
          cache: "no-store",
          mode: "cors",
        });
        cloudConnected = cloudRes.ok;
      } catch {
        cloudConnected = false;
      }

      setStatus((prev) => ({
        ...prev,
        runtimeMode: getRuntimeMode(),
        isDesktop: isDesk,
        backend: backendOk ? (isDesk ? "LOCAL" : "CLOUD") : "OFFLINE",
        desktopAgent: isDesk ? (agentOnline ? "ONLINE" : "ERROR") : "OFFLINE",
        desktopAgentToolCount: toolCount,
        desktopAgentVersion: agentVer,
        cloudServices: cloudConnected ? "CONNECTED" : "OFFLINE",
        gemini: cloudConnected ? "READY" : "OFFLINE",
        isOfflineMode: !cloudConnected,
      }));
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    pollSystemStatus();
    const interval = setInterval(pollSystemStatus, 6000);

    let cleanupIpc: (() => void) | undefined;
    if ((window as any).myraa?.onSystemStatus) {
      cleanupIpc = (window as any).myraa.onSystemStatus((updated: any) => {
        if (updated) setStatus((prev) => ({ ...prev, ...updated }));
      });
    }

    return () => {
      clearInterval(interval);
      cleanupIpc?.();
    };
  }, []);

  const handleRetryAgent = async () => {
    setIsRetryingAgent(true);
    try {
      if ((window as any).myraa?.retryDesktopAgent) {
        const updated = await (window as any).myraa.retryDesktopAgent();
        if (updated) setStatus((prev) => ({ ...prev, ...updated }));
      } else {
        await pollSystemStatus();
      }
    } finally {
      setTimeout(() => setIsRetryingAgent(false), 800);
    }
  };

  const isLocal = status.runtimeMode === "DESKTOP_LOCAL";
  const isAgentWarning = isLocal && (status.desktopAgent === "ERROR" || status.desktopAgent === "OFFLINE");
  const isCloudOffline = status.cloudServices === "OFFLINE";

  return (
    <>
      {/* Top Header Status Pill */}
      <button
        onClick={() => setShowModal(true)}
        className={`flex items-center gap-2 px-2.5 py-1 rounded-full text-[11px] font-mono tracking-wider border transition-all cursor-pointer select-none ${
          isAgentWarning
            ? "bg-rose-950/40 border-rose-500/40 text-rose-300 hover:border-rose-400"
            : isCloudOffline
            ? "bg-amber-950/40 border-amber-500/40 text-amber-300 hover:border-amber-400"
            : "bg-slate-900/60 border-slate-700/50 text-slate-300 hover:border-cyan-500/50 hover:text-white"
        }`}
        title="View MYRAA Runtime & Diagnostics HUD"
      >
        <span className="flex items-center gap-1.5">
          <span
            className={`w-2 h-2 rounded-full ${
              isAgentWarning
                ? "bg-rose-400 animate-pulse"
                : isCloudOffline
                ? "bg-amber-400"
                : "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)]"
            }`}
          />
          <span className="font-semibold text-white/90">
            {isLocal ? "MYRAA Desktop" : "MYRAA Cloud"}
          </span>
          <span className="text-white/40">●</span>
          <span
            className={
              isLocal
                ? "text-emerald-400 font-bold"
                : "text-cyan-400 font-bold"
            }
          >
            {isLocal ? "LOCAL" : "CLOUD"}
          </span>
        </span>

        {isAgentWarning && (
          <span className="text-[10px] px-1.5 py-0.2 bg-rose-500/20 text-rose-300 rounded font-sans">
            AGENT OFFLINE
          </span>
        )}

        {isCloudOffline && !isAgentWarning && (
          <span className="text-[10px] px-1.5 py-0.2 bg-amber-500/20 text-amber-300 rounded font-sans">
            OFFLINE
          </span>
        )}
      </button>

      {/* Runtime & Diagnostics Modal */}
      <AnimatePresence>
        {showModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-md"
            onClick={() => setShowModal(false)}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              onClick={(e) => e.stopPropagation()}
              className="relative w-full max-w-lg bg-[#0c0d14] border border-slate-700/70 rounded-2xl p-6 shadow-[0_0_50px_rgba(0,0,0,0.8)] text-white select-none"
            >
              {/* Header */}
              <div className="flex items-center justify-between pb-4 border-b border-slate-800">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-xl bg-cyan-950/60 border border-cyan-500/40 flex items-center justify-center text-cyan-400">
                    <Server size={18} />
                  </div>
                  <div>
                    <h3 className="text-base font-bold tracking-wide">
                      MYRAA Runtime Diagnostics
                    </h3>
                    <p className="text-xs text-slate-400 font-mono">
                      Phase 13A-WIN.6 • Hybrid Cloud/Local Shell
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => setShowModal(false)}
                  className="p-1 rounded-lg hover:bg-white/10 text-slate-400 hover:text-white transition"
                >
                  <X size={18} />
                </button>
              </div>

              {/* Runtime Mode Banner */}
              <div className="mt-4 p-3 rounded-xl bg-slate-900/80 border border-slate-800 flex items-center justify-between">
                <div>
                  <div className="text-[10px] uppercase tracking-widest text-slate-400 font-mono">
                    Active Runtime Mode
                  </div>
                  <div className="text-sm font-bold text-cyan-400 font-mono mt-0.5">
                    {status.runtimeMode}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-[10px] uppercase tracking-widest text-slate-400 font-mono">
                    Environment
                  </div>
                  <div className="text-xs font-semibold text-white/90 font-mono mt-0.5">
                    {isLocal ? "Windows Desktop (Installed/Portable)" : "Browser Cloud Web"}
                  </div>
                </div>
              </div>

              {/* Subsystems Matrix */}
              <div className="mt-4 space-y-2.5 font-mono text-xs">
                {/* 1. Backend */}
                <div className="flex items-center justify-between p-3 rounded-lg bg-black/40 border border-slate-800/80">
                  <div className="flex items-center gap-2.5">
                    <Server size={15} className="text-slate-400" />
                    <div>
                      <span className="text-slate-300 font-medium">Backend Gateway</span>
                      <div className="text-[10px] text-slate-500">
                        {status.backendUrl || "http://127.0.0.1:3000"}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 font-bold">
                    <span
                      className={`w-2 h-2 rounded-full ${
                        status.backend === "LOCAL"
                          ? "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)]"
                          : status.backend === "CLOUD"
                          ? "bg-cyan-400"
                          : "bg-rose-500"
                      }`}
                    />
                    <span
                      className={
                        status.backend === "LOCAL"
                          ? "text-emerald-400"
                          : status.backend === "CLOUD"
                          ? "text-cyan-400"
                          : "text-rose-400"
                      }
                    >
                      {status.backend}
                    </span>
                  </div>
                </div>

                {/* 2. Desktop Agent */}
                <div className="flex items-center justify-between p-3 rounded-lg bg-black/40 border border-slate-800/80">
                  <div className="flex items-center gap-2.5">
                    <Cpu size={15} className="text-slate-400" />
                    <div>
                      <span className="text-slate-300 font-medium">Desktop Agent</span>
                      <div className="text-[10px] text-slate-500">
                        {isLocal ? "127.0.0.1:8765 (Bundled Python OS Agent)" : "Remote / Not Applicable"}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 font-bold">
                    <span
                      className={`w-2 h-2 rounded-full ${
                        status.desktopAgent === "ONLINE"
                          ? "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)]"
                          : status.desktopAgent === "STARTING"
                          ? "bg-amber-400 animate-pulse"
                          : "bg-rose-500"
                      }`}
                    />
                    <span
                      className={
                        status.desktopAgent === "ONLINE"
                          ? "text-emerald-400"
                          : status.desktopAgent === "STARTING"
                          ? "text-amber-400"
                          : "text-rose-400"
                      }
                    >
                      {status.desktopAgent}
                      {status.desktopAgentToolCount ? ` (${status.desktopAgentToolCount} tools)` : ""}
                    </span>
                  </div>
                </div>

                {/* 3. Gemini Live */}
                <div className="flex items-center justify-between p-3 rounded-lg bg-black/40 border border-slate-800/80">
                  <div className="flex items-center gap-2.5">
                    <Sparkles size={15} className="text-slate-400" />
                    <div>
                      <span className="text-slate-300 font-medium">Gemini Live Voice</span>
                      <div className="text-[10px] text-slate-500">
                        126 Native Tools • Direct Bidirectional Streaming
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 font-bold">
                    <span
                      className={`w-2 h-2 rounded-full ${
                        status.gemini === "READY"
                          ? "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)]"
                          : status.gemini === "CONNECTING"
                          ? "bg-amber-400 animate-pulse"
                          : "bg-slate-500"
                      }`}
                    />
                    <span
                      className={
                        status.gemini === "READY"
                          ? "text-emerald-400"
                          : status.gemini === "CONNECTING"
                          ? "text-amber-400"
                          : "text-slate-400"
                      }
                    >
                      {status.gemini}
                    </span>
                  </div>
                </div>

                {/* 4. Cloud Services */}
                <div className="flex items-center justify-between p-3 rounded-lg bg-black/40 border border-slate-800/80">
                  <div className="flex items-center gap-2.5">
                    {status.cloudServices === "CONNECTED" ? (
                      <Cloud size={15} className="text-slate-400" />
                    ) : (
                      <CloudOff size={15} className="text-amber-400" />
                    )}
                    <div>
                      <span className="text-slate-300 font-medium">Cloud Services</span>
                      <div className="text-[10px] text-slate-500">
                        https://myraa-ai-q0h3.onrender.com
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 font-bold">
                    <span
                      className={`w-2 h-2 rounded-full ${
                        status.cloudServices === "CONNECTED"
                          ? "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)]"
                          : "bg-amber-400"
                      }`}
                    />
                    <span
                      className={
                        status.cloudServices === "CONNECTED"
                          ? "text-emerald-400"
                          : "text-amber-400"
                      }
                    >
                      {status.cloudServices}
                    </span>
                  </div>
                </div>

                {/* 5. Security Architecture */}
                <div className="flex items-center justify-between p-3 rounded-lg bg-black/40 border border-slate-800/80">
                  <div className="flex items-center gap-2.5">
                    <Shield size={15} className="text-slate-400" />
                    <div>
                      <span className="text-slate-300 font-medium">Security & Firewalls</span>
                      <div className="text-[10px] text-slate-500">
                        RiskEngine • OutputDataFirewall • Audit
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 font-bold text-emerald-400">
                    <span className="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)]" />
                    <span>ACTIVE</span>
                  </div>
                </div>
              </div>

              {/* Diagnostic Alert if Desktop Agent Offline */}
              {isAgentWarning && (
                <div className="mt-4 p-3.5 rounded-xl bg-rose-950/40 border border-rose-500/50 text-xs">
                  <div className="flex items-start gap-2.5">
                    <AlertTriangle size={18} className="text-rose-400 shrink-0 mt-0.5" />
                    <div className="space-y-1">
                      <div className="font-bold text-rose-300">
                        Desktop Agent Not Responding (127.0.0.1:8765)
                      </div>
                      <p className="text-rose-200/80 leading-relaxed font-sans">
                        Local OS automation tools (launching apps, opening VS Code, file manager,
                        screenshots, and shell) are currently paused until the agent process starts.
                      </p>
                      <button
                        onClick={handleRetryAgent}
                        disabled={isRetryingAgent}
                        className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 text-rose-200 border border-rose-500/40 font-mono text-[11px] font-semibold transition cursor-pointer"
                      >
                        <RefreshCw size={12} className={isRetryingAgent ? "animate-spin" : ""} />
                        <span>{isRetryingAgent ? "Re-probing Agent..." : "Retry Desktop Agent"}</span>
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* Offline notice */}
              {isCloudOffline && (
                <div className="mt-4 p-3 rounded-xl bg-amber-950/30 border border-amber-500/40 text-xs text-amber-200/90 font-sans">
                  <span className="font-bold text-amber-300">Offline Resilience Active:</span> Local
                  UI and desktop automation remain fully functional without internet. Cloud sync and
                  Gemini Live will automatically reconnect when network returns.
                </div>
              )}

              {/* Footer */}
              <div className="mt-5 pt-3 border-t border-slate-800 flex items-center justify-between text-xs font-mono text-slate-500">
                <span>Mishtron Labs • MYRAA v1.0.0</span>
                <button
                  onClick={pollSystemStatus}
                  className="flex items-center gap-1 text-slate-400 hover:text-white transition cursor-pointer"
                >
                  <RefreshCw size={12} />
                  <span>Refresh</span>
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
};
