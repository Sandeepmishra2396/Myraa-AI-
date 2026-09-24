import React, { useState, useEffect } from "react";
import {
  Sparkles,
  Lock,
  KeyRound,
  Loader2,
  AlertCircle,
  CheckCircle2,
  Shield,
  Smartphone,
  Laptop,
} from "lucide-react";

export interface StoredRemoteSession {
  deviceId: string;
  token: string;
  deviceName: string;
  role: "read_only" | "standard" | "admin";
  pairedAt: number;
  accessToken?: string;
  refreshToken?: string;
}

export const STORAGE_KEY = "sora_remote_session";

interface CloudPairingModalProps {
  isOpen: boolean;
  onPairSuccess: (session: StoredRemoteSession) => void;
  onClose?: () => void;
}

export const CloudPairingModal: React.FC<CloudPairingModalProps> = ({
  isOpen,
  onPairSuccess,
  onClose,
}) => {
  const [pinCode, setPinCode] = useState("");
  const [deviceName, setDeviceName] = useState(() => {
    if (typeof navigator === "undefined") return "Web Dashboard";
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    const isAndroid = /Android/.test(navigator.userAgent);
    if (isIOS) return "iPhone Companion";
    if (isAndroid) return "Android Companion";
    return `Web Client (${navigator.platform || "Browser"})`;
  });
  const [isPairing, setIsPairing] = useState(false);
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [canBootstrap, setCanBootstrap] = useState(false);
  const [bootstrapCode, setBootstrapCode] = useState<string | null>(null);

  // Check pairing code status and whether initial bootstrap is available
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;

    const checkStatus = async () => {
      try {
        const res = await fetch("/api/remote/pair-code/status");
        if (res.ok && !cancelled) {
          const data = await res.json();
          setCanBootstrap(Boolean(data.canBootstrap));
        }
      } catch {
        /* best-effort status check */
      }
    };

    checkStatus();
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  if (!isOpen) return null;

  // Handle bootstrap PIN generation for initial instance claiming
  const handleGenerateBootstrapPin = async () => {
    setIsGenerating(true);
    setPairingError(null);
    try {
      const res = await fetch("/api/remote/pair-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to generate initial setup PIN.");
      }
      if (data.code) {
        setPinCode(data.code);
        setBootstrapCode(data.code);
      }
    } catch (err: any) {
      setPairingError(err.message || "Failed to generate initial setup PIN.");
    } finally {
      setIsGenerating(false);
    }
  };

  // Submit pairing code to POST /api/remote/pair
  const handlePairSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanPin = pinCode.trim().toUpperCase();
    if (cleanPin.length !== 6) {
      setPairingError("Please enter a valid 6-character pairing code.");
      return;
    }

    setIsPairing(true);
    setPairingError(null);

    try {
      const res = await fetch("/api/remote/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: cleanPin,
          deviceName: deviceName.trim() || "Web Dashboard",
          deviceType: "web",
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || `Pairing failed with status ${res.status}`);
      }

      const newSession: StoredRemoteSession = {
        deviceId: data.device.id,
        token: data.device.token,
        deviceName: data.device.name,
        role: data.device.role,
        pairedAt: Date.now(),
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
      };

      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(newSession));
      } catch {
        /* storage may be quota-restricted */
      }

      onPairSuccess(newSession);
    } catch (err: any) {
      setPairingError(err.message || "Failed to pair with Myraa.");
    } finally {
      setIsPairing(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-xl p-4 font-sans text-slate-100">
      {/* Ambient background glows */}
      <div className="pointer-events-none absolute -left-32 -top-32 h-96 w-96 rounded-full bg-indigo-600/15 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-32 -right-32 h-96 w-96 rounded-full bg-purple-600/15 blur-3xl" />

      <div className="relative z-10 w-full max-w-md rounded-3xl border border-white/10 bg-slate-900/90 p-6 md:p-8 shadow-2xl">
        {/* Header Icon */}
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-tr from-indigo-500 to-purple-600 shadow-lg shadow-indigo-500/25">
            <Shield className="h-7 w-7 text-white" />
          </div>
          <h2 className="text-xl font-bold tracking-tight text-white">
            {canBootstrap ? "Cloud Instance Setup" : "Cloud Device Pairing"}
          </h2>
          <p className="mt-1.5 text-xs leading-relaxed text-slate-400">
            {canBootstrap
              ? "Welcome to your deployed MYRAA instance. Generate your initial setup PIN to claim admin ownership."
              : "This cloud MYRAA instance requires device authentication before voice streaming can connect."}
          </p>
        </div>

        {/* Error Notice */}
        {pairingError && (
          <div className="mb-4 rounded-xl border border-rose-500/30 bg-rose-950/40 p-3 text-xs text-rose-300 flex items-start gap-2">
            <AlertCircle className="h-4 w-4 shrink-0 text-rose-400 mt-0.5" />
            <span className="leading-snug">{pairingError}</span>
          </div>
        )}

        {/* Bootstrap One-Click Generation Banner */}
        {canBootstrap && !bootstrapCode && (
          <div className="mb-5 rounded-2xl border border-indigo-500/30 bg-indigo-950/30 p-4">
            <div className="flex items-center gap-2 text-xs font-semibold text-indigo-300 mb-1.5">
              <Sparkles className="h-4 w-4 text-indigo-400" />
              <span>First-Device Admin Claim</span>
            </div>
            <p className="text-[11px] leading-relaxed text-slate-300 mb-3">
              No devices are currently registered. Click below to atomically generate your one-time initial setup PIN.
            </p>
            <button
              type="button"
              onClick={handleGenerateBootstrapPin}
              disabled={isGenerating}
              className="w-full py-2 px-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold tracking-wide transition-all shadow-md shadow-indigo-600/20 flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
            >
              {isGenerating ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span>Generating One-Time Setup PIN...</span>
                </>
              ) : (
                <>
                  <KeyRound className="h-3.5 w-3.5" />
                  <span>Generate Setup PIN</span>
                </>
              )}
            </button>
          </div>
        )}

        {/* Pairing Form */}
        <form onSubmit={handlePairSubmit} className="space-y-4">
          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-1.5">
              6-Character Pairing Code
            </label>
            <input
              type="text"
              maxLength={6}
              value={pinCode}
              onChange={(e) => setPinCode(e.target.value.toUpperCase().replace(/[^0-9A-Z]/g, ""))}
              placeholder="e.g. K9W4MZ"
              className="w-full rounded-xl border border-slate-700 bg-slate-950/70 px-4 py-3 text-center text-xl font-mono font-bold tracking-[0.3em] text-white uppercase placeholder:text-slate-600 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
              autoFocus
              required
            />
          </div>

          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-1.5">
              Device Name
            </label>
            <input
              type="text"
              value={deviceName}
              onChange={(e) => setDeviceName(e.target.value)}
              placeholder="My Browser"
              className="w-full rounded-xl border border-slate-700 bg-slate-950/70 px-3 py-2 text-xs text-slate-200 placeholder:text-slate-600 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
              required
            />
          </div>

          <button
            type="submit"
            disabled={isPairing || pinCode.trim().length !== 6}
            className="w-full py-3 px-4 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white font-semibold text-xs uppercase tracking-wider shadow-lg shadow-indigo-600/30 transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {isPairing ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Authorizing Device...</span>
              </>
            ) : (
              <>
                <CheckCircle2 className="h-4 w-4" />
                <span>Pair & Activate Session</span>
              </>
            )}
          </button>
        </form>

        {/* Informational Footer */}
        <div className="mt-6 pt-4 border-t border-slate-800 text-[11px] text-slate-400 space-y-1">
          <div className="font-semibold text-slate-300 flex items-center gap-1.5">
            <Lock className="h-3 w-3 text-indigo-400" />
            <span>Transport & Session Security</span>
          </div>
          <p className="leading-relaxed">
            All non-localhost audio streaming routes exclusively via{" "}
            <span className="font-mono text-slate-300">/remote-live</span> over encrypted WSS.
          </p>
        </div>
      </div>
    </div>
  );
};
