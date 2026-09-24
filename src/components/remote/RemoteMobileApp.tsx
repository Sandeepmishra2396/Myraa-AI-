import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  Mic,
  MicOff,
  ShieldAlert,
  AlertTriangle,
  CheckCircle2,
  Radio,
  Sparkles,
  Send,
  Smartphone,
  LogOut,
  RefreshCw,
  Bell,
  Volume2,
  Lock,
  KeyRound,
  X,
  Laptop,
  Copy,
  Check,
  Loader2,
} from "lucide-react";
import { MyraAudioSession, LiveState } from "../../lib/audio";
import { authenticatedRemoteFetch } from "../../lib/remoteAuth";

interface StoredRemoteSession {
  deviceId: string;
  token: string;
  deviceName: string;
  role: "read_only" | "standard" | "admin";
  pairedAt: number;
  accessToken?: string;
  refreshToken?: string;
}

interface ChatMessage {
  id: string;
  role: "user" | "model" | "system";
  text: string;
  timestamp: number;
}

interface NotificationItem {
  id: string;
  title: string;
  message: string;
  type: "info" | "warning" | "alert";
  timestamp: number;
}

const STORAGE_KEY = "sora_remote_session";

export const RemoteMobileApp: React.FC = () => {
  // Authentication / Pairing State
  const [session, setSession] = useState<StoredRemoteSession | null>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  });

  const [pinCode, setPinCode] = useState<string>("");
  const [deviceName, setDeviceName] = useState<string>(() => {
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    const isAndroid = /Android/.test(navigator.userAgent);
    if (isIOS) return "iPhone Companion";
    if (isAndroid) return "Android Companion";
    return "Mobile Companion";
  });
  const [isPairing, setIsPairing] = useState<boolean>(false);
  const [pairingError, setPairingError] = useState<string | null>(null);

  // Live Audio / Session State
  const [liveState, setLiveState] = useState<LiveState>("disconnected");
  const [characterState, setCharacterState] = useState<"idle" | "listening" | "thinking" | "talking">("idle");
  const [errorText, setErrorText] = useState<string | null>(null);
  const [reconnectText, setReconnectText] = useState<string | null>(null);

  // Transcript & Chat
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [currentModelTurn, setCurrentModelTurn] = useState<string>("");
  const [textInput, setTextInput] = useState<string>("");

  // Notifications
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [showNotifications, setShowNotifications] = useState<boolean>(false);

  // Emergency Stop State
  const [emergencyActive, setEmergencyActive] = useState<boolean>(false);
  const [emergencyReason, setEmergencyReason] = useState<string>("");
  const [showEmergencyModal, setShowEmergencyModal] = useState<boolean>(false);
  const [emergencyActionLoading, setEmergencyActionLoading] = useState<boolean>(false);

  // Audio Session Ref
  const audioSessionRef = useRef<MyraAudioSession | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);

  // Phase 8 Multimodal Active Window State
  const [remoteActiveWindow, setRemoteActiveWindow] = useState<{
    title: string;
    processName: string;
    category: string;
    isShielded?: boolean;
  } | null>(null);

  // Authenticated Admin "Pair Another Device" State
  const [showPairModal, setShowPairModal] = useState<boolean>(false);
  const [isGeneratingPairCode, setIsGeneratingPairCode] = useState<boolean>(false);
  const [generatedPairCode, setGeneratedPairCode] = useState<{
    code: string;
    expiresAt: string;
    ttlSeconds: number;
  } | null>(null);
  const [pairCodeError, setPairCodeError] = useState<string | null>(null);
  const [copiedCode, setCopiedCode] = useState<boolean>(false);

  // Synchronize local session role with server authoritative role (e.g. admin promotion)
  useEffect(() => {
    if (!session?.token && !session?.accessToken) return;
    const syncSessionRole = async () => {
      try {
        const { response: res } = await authenticatedRemoteFetch(
          "/api/remote/session",
          { method: "GET" },
          session as any,
          (updated) => setSession(updated),
        );
        if (res.ok) {
          const data = await res.json();
          if (data.device?.role && data.device.role !== session.role) {
            const updated = { ...session, role: data.device.role };
            localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
            setSession(updated);
          }
        }
      } catch {
        /* best effort */
      }
    };
    syncSessionRole();
  }, [session?.token, session?.accessToken]);

  const handleGeneratePairCode = async () => {
    if (!session) return;
    setIsGeneratingPairCode(true);
    setPairCodeError(null);
    setCopiedCode(false);
    setShowPairModal(true);
    try {
      const { response: res } = await authenticatedRemoteFetch(
        "/api/remote/pair-code",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        },
        session as any,
        (updated) => setSession(updated),
      );
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to generate pairing PIN.");
      }
      setGeneratedPairCode(data);
    } catch (err: any) {
      setPairCodeError(err.message || "Failed to generate pairing PIN.");
    } finally {
      setIsGeneratingPairCode(false);
    }
  };

  const handleCopyPairCode = () => {
    if (!generatedPairCode?.code) return;
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(generatedPairCode.code);
      setCopiedCode(true);
      setTimeout(() => setCopiedCode(false), 2000);
    }
  };

  // Fetch Laptop Foreground Window Status
  useEffect(() => {
    if (!session) return;
    const fetchWindowContext = async () => {
      try {
        const res = await fetch("/api/multimodal/window/active", {
          headers: { Authorization: `Bearer ${session.token}` },
        });
        if (res.ok) {
          const data = await res.json();
          if (data.activeWindow) {
            setRemoteActiveWindow(data.activeWindow);
          }
        }
      } catch {}
    };
    fetchWindowContext();
    const t = setInterval(fetchWindowContext, 10000);
    return () => clearInterval(t);
  }, [session]);

  // Auto-scroll transcript
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, currentModelTurn]);

  // Check emergency stop status on mount & interval
  const fetchEmergencyStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/remote/emergency-stop/status");
      if (res.ok) {
        const data = await res.json();
        setEmergencyActive(Boolean(data.active));
        if (data.active && data.reason) {
          setEmergencyReason(data.reason);
        }
      }
    } catch {
      // Offline / not reachable
    }
  }, []);

  useEffect(() => {
    fetchEmergencyStatus();
    const interval = setInterval(fetchEmergencyStatus, 5000);
    return () => clearInterval(interval);
  }, [fetchEmergencyStatus]);

  // Setup MyraAudioSession when authenticated
  useEffect(() => {
    if (!session?.token && !session?.accessToken) {
      if (audioSessionRef.current) {
        audioSessionRef.current.disconnect();
        audioSessionRef.current = null;
      }
      return;
    }

    const audioSession = new MyraAudioSession({
      token: session.accessToken || session.token,
      onSessionUpdate: (updated) => setSession(updated),
      onStateChange: (state) => {
        setLiveState(state);
        if (state === "disconnected") {
          setCharacterState("idle");
          setReconnectText(null);
        } else if (state === "listening") {
          setCharacterState("listening");
          setReconnectText(null);
        } else if (state === "speaking") {
          setCharacterState("talking");
        }
      },
      onTranscription: (role, text) => {
        if (role === "user") {
          setCharacterState("thinking");
          setMessages((prev) => [
            ...prev,
            { id: Math.random().toString(), role: "user", text, timestamp: Date.now() },
          ]);
        } else if (role === "model") {
          setCurrentModelTurn((prev) => prev + text);
        }
      },
      onToolCall: (name, args, callback) => {
        console.log(`[Remote] Tool call requested: ${name}`, args);
        callback({ result: `Remote client acknowledged ${name}` });
      },
      onError: (err) => {
        if (err.startsWith("RECONNECTING:")) {
          setReconnectText(err.replace("RECONNECTING:", "").trim());
        } else {
          setErrorText(err);
          setReconnectText(null);
        }
      },
      onNotification: (payload) => {
        console.log("[Remote] Notification received:", payload);
        if (payload.type === "emergency_stop") {
          const stopData = payload.emergencyStop || payload;
          setEmergencyActive(Boolean(stopData.active));
          if (stopData.reason) setEmergencyReason(stopData.reason);
          setMessages((prev) => [
            ...prev,
            {
              id: Math.random().toString(),
              role: "system",
              text: `🚨 EMERGENCY STOP ${stopData.active ? "ACTIVATED" : "RESET"}: ${stopData.reason || "Killswitch triggered"}`,
              timestamp: Date.now(),
            },
          ]);
        } else if (payload.type === "companion_notification") {
          const notif = payload.notification;
          if (notif) {
            setNotifications((prev) => [
              {
                id: notif.id || Math.random().toString(),
                title: notif.title || "Proactive Notification",
                message: notif.message || JSON.stringify(notif),
                type: notif.urgency === "high" ? "alert" : "info",
                timestamp: notif.timestamp || Date.now(),
              },
              ...prev.slice(0, 19),
            ]);
          }
        }
      },
    });

    audioSessionRef.current = audioSession;

    return () => {
      audioSession.disconnect();
      audioSessionRef.current = null;
    };
  }, [session?.token]);

  // Flush model turn into messages once model finishes speaking
  useEffect(() => {
    if (liveState === "listening" && currentModelTurn.trim()) {
      setMessages((prev) => [
        ...prev,
        { id: Math.random().toString(), role: "model", text: currentModelTurn, timestamp: Date.now() },
      ]);
      setCurrentModelTurn("");
      setCharacterState("listening");
    }
  }, [liveState, currentModelTurn]);

  // Handle Pairing Submit
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
          deviceName: deviceName.trim() || "Mobile Companion",
          deviceType: "mobile",
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

      localStorage.setItem(STORAGE_KEY, JSON.stringify(newSession));
      setSession(newSession);
      setPinCode("");
    } catch (err: any) {
      setPairingError(err.message || "Failed to pair with Myraa.");
    } finally {
      setIsPairing(false);
    }
  };

  // Handle Unpair
  const handleUnpair = async () => {
    if (!session) return;
    try {
      await fetch(`/api/remote/devices/${session.deviceId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${session.token}` },
      });
    } catch {
      // Ignore network errors during revoke
    }

    if (audioSessionRef.current) {
      audioSessionRef.current.disconnect();
    }
    localStorage.removeItem(STORAGE_KEY);
    setSession(null);
    setMessages([]);
    setNotifications([]);
  };

  // Toggle Microphone
  const toggleMicrophone = async () => {
    if (emergencyActive) {
      setErrorText("Cannot connect: Emergency Stop is currently ACTIVE.");
      return;
    }

    const audioSession = audioSessionRef.current;
    if (!audioSession) return;

    if (liveState === "disconnected") {
      setErrorText(null);
      await audioSession.connect();
    } else {
      audioSession.disconnect();
    }
  };

  // Send Text Message
  const handleSendText = (e: React.FormEvent) => {
    e.preventDefault();
    if (!textInput.trim()) return;

    if (emergencyActive) {
      setErrorText("Emergency Stop active: command blocked.");
      return;
    }

    const audioSession = audioSessionRef.current;
    const userText = textInput.trim();
    setTextInput("");

    // Optimistically add user text to transcript
    setMessages((prev) => [
      ...prev,
      { id: Math.random().toString(), role: "user", text: userText, timestamp: Date.now() },
    ]);
    setCharacterState("thinking");

    if (audioSession && liveState !== "disconnected") {
      audioSession.sendTextMessage(userText);
    } else {
      // If audio session is not connected, connect it first
      audioSession?.connect().then(() => {
        setTimeout(() => {
          audioSession?.sendTextMessage(userText);
        }, 800);
      }).catch((err) => {
        setErrorText(`Could not connect: ${err?.message || err}`);
      });
    }
  };

  // Trigger Emergency Stop
  const handleTriggerEmergencyStop = async () => {
    if (!session) return;
    setEmergencyActionLoading(true);
    try {
      const res = await fetch("/api/remote/emergency-stop", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ reason: "Triggered from mobile companion interface" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Emergency stop call failed");

      setEmergencyActive(true);
      setEmergencyReason(data.state?.reason || "Triggered from mobile companion interface");
      setShowEmergencyModal(false);

      if (audioSessionRef.current) {
        audioSessionRef.current.disconnect();
      }
    } catch (err: any) {
      setErrorText(`Emergency Stop Error: ${err.message}`);
    } finally {
      setEmergencyActionLoading(false);
    }
  };

  // Reset Emergency Stop
  const handleResetEmergencyStop = async () => {
    if (!session) return;
    setEmergencyActionLoading(true);
    try {
      const res = await fetch("/api/remote/emergency-stop/reset", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.token}`,
          "Content-Type": "application/json",
        },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Reset failed");

      setEmergencyActive(false);
      setEmergencyReason("");
      setErrorText(null);
    } catch (err: any) {
      setErrorText(`Reset failed: ${err.message}`);
    } finally {
      setEmergencyActionLoading(false);
    }
  };

  // Render Pairing Screen if not paired
  if (!session) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-slate-950 via-slate-900 to-black text-slate-100 flex flex-col items-center justify-center p-4 selection:bg-indigo-500 selection:text-white">
        <div className="w-full max-w-md bg-slate-900/80 backdrop-blur-xl border border-slate-800/80 rounded-3xl p-6 md:p-8 shadow-2xl relative overflow-hidden">
          {/* Accent glow */}
          <div className="absolute -top-24 -left-24 w-48 h-48 bg-indigo-600/20 rounded-full blur-3xl pointer-events-none" />
          <div className="absolute -bottom-24 -right-24 w-48 h-48 bg-violet-600/20 rounded-full blur-3xl pointer-events-none" />

          {/* Logo & Header */}
          <div className="text-center mb-8 relative">
            <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-gradient-to-br from-indigo-500 via-purple-500 to-pink-500 flex items-center justify-center shadow-lg shadow-indigo-500/25">
              <Smartphone className="w-8 h-8 text-white" />
            </div>
            <h1 className="text-2xl font-bold tracking-tight text-white flex items-center justify-center gap-2">
              MYRAA <span className="text-indigo-400 font-light">Remote</span>
            </h1>
            <p className="text-sm text-slate-400 mt-1">
              Pair your mobile device with your Myraa AI workstation
            </p>
          </div>

          {/* Pairing Form */}
          <form onSubmit={handlePairSubmit} className="space-y-5 relative">
            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-2">
                6-Character Pairing Code
              </label>
              <div className="relative">
                <input
                  type="text"
                  maxLength={6}
                  value={pinCode}
                  onChange={(e) => setPinCode(e.target.value.toUpperCase())}
                  placeholder="e.g. 7K4A9Z"
                  className="w-full bg-slate-950/80 border border-slate-700/80 rounded-2xl px-4 py-3 text-center text-2xl font-mono tracking-widest text-indigo-300 placeholder:text-slate-600 focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 uppercase transition-all"
                  autoCapitalize="characters"
                  autoCorrect="off"
                  spellCheck="false"
                  required
                />
                <KeyRound className="w-5 h-5 text-slate-500 absolute right-4 top-1/2 -translate-y-1/2 pointer-events-none" />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-2">
                Device Name
              </label>
              <input
                type="text"
                value={deviceName}
                onChange={(e) => setDeviceName(e.target.value)}
                placeholder="My Mobile Phone"
                className="w-full bg-slate-950/80 border border-slate-700/80 rounded-2xl px-4 py-2.5 text-sm text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 transition-all"
              />
            </div>

            {pairingError && (
              <div className="p-3.5 bg-rose-950/60 border border-rose-800/80 rounded-2xl flex items-start gap-3 text-rose-300 text-xs leading-relaxed animate-fade-in">
                <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                <span>{pairingError}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={isPairing || pinCode.length !== 6}
              className="w-full py-3.5 px-4 bg-gradient-to-r from-indigo-600 via-indigo-500 to-purple-600 hover:from-indigo-500 hover:to-purple-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium text-sm rounded-2xl shadow-lg shadow-indigo-600/30 transition-all flex items-center justify-center gap-2 cursor-pointer active:scale-[0.98]"
            >
              {isPairing ? (
                <>
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  <span>Connecting...</span>
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4" />
                  <span>Pair With Myraa</span>
                </>
              )}
            </button>
          </form>

          {/* Helper Card */}
          <div className="mt-8 pt-6 border-t border-slate-800/80 text-xs text-slate-400 space-y-2">
            <div className="font-semibold text-slate-300 flex items-center gap-1.5">
              <Lock className="w-3.5 h-3.5 text-indigo-400" />
              How to get a Pairing Code:
            </div>
            <p className="leading-relaxed">
              Say to Myraa on your laptop: <span className="text-slate-200 font-mono">"Myraa, pair my device"</span> or ask for a pairing code.
            </p>
            <p className="text-[11px] text-slate-500">
              Pairing codes expire automatically in 5 minutes.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Connected Companion View
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-indigo-500 selection:text-white">
      {/* Top Header Bar */}
      <header className="sticky top-0 z-30 bg-slate-900/90 backdrop-blur-md border-b border-slate-800 px-4 py-3 flex items-center justify-between shadow-md">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-gradient-to-tr from-indigo-500 to-purple-600 flex items-center justify-center shadow-md shadow-indigo-500/20">
            <Sparkles className="w-4 h-4 text-white" />
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <h1 className="text-sm font-bold text-white tracking-tight">MYRAA AI</h1>
              <span className="text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded-full bg-slate-800 text-indigo-300 border border-slate-700">
                {session.role}
              </span>
            </div>
            <div className="text-[11px] text-slate-400 flex items-center gap-1">
              <span
                className={`w-2 h-2 rounded-full ${
                  liveState === "listening" || liveState === "speaking"
                    ? "bg-emerald-500 animate-pulse"
                    : liveState === "connecting"
                    ? "bg-amber-500 animate-pulse"
                    : "bg-slate-600"
                }`}
              />
              <span className="capitalize">{reconnectText ? `Reconnecting (${reconnectText})` : liveState}</span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Authenticated Admin "Pair Another Device" Action */}
          {session.role === "admin" && (
            <button
              onClick={handleGeneratePairCode}
              className="px-2.5 py-1.5 rounded-xl bg-indigo-600/30 hover:bg-indigo-600/50 border border-indigo-500/40 text-indigo-200 text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer"
              title="Pair Another Companion Device"
            >
              <KeyRound className="w-3.5 h-3.5 text-indigo-400" />
              <span className="hidden sm:inline">Pair Device</span>
              <span className="sm:hidden text-[11px]">Pair</span>
            </button>
          )}

          {/* Notifications Drawer Toggle */}
          <button
            onClick={() => setShowNotifications(!showNotifications)}
            className="relative p-2 rounded-xl bg-slate-800/80 hover:bg-slate-800 text-slate-300 transition-colors cursor-pointer"
            title="Notifications"
          >
            <Bell className="w-4 h-4" />
            {notifications.length > 0 && (
              <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-indigo-500 text-[9px] font-bold flex items-center justify-center text-white">
                {notifications.length}
              </span>
            )}
          </button>

          {/* Unpair button */}
          <button
            onClick={handleUnpair}
            className="p-2 rounded-xl bg-slate-800/80 hover:bg-rose-950/60 hover:text-rose-300 text-slate-400 transition-colors cursor-pointer"
            title="Unpair Device"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* Emergency Stop Banner if active */}
      {emergencyActive && (
        <div className="bg-rose-950/90 border-b border-rose-800 px-4 py-3 flex items-center justify-between text-xs text-rose-200 animate-pulse">
          <div className="flex items-center gap-2 font-medium">
            <ShieldAlert className="w-5 h-5 text-rose-400 shrink-0" />
            <span>
              <strong>EMERGENCY STOP ACTIVE:</strong> {emergencyReason || "All background tasks, plans, and actions halted."}
            </span>
          </div>
          <button
            onClick={handleResetEmergencyStop}
            disabled={emergencyActionLoading}
            className="shrink-0 px-3 py-1 bg-rose-800 hover:bg-rose-700 text-white rounded-lg text-xs font-semibold shadow transition-colors cursor-pointer"
          >
            {emergencyActionLoading ? "Resetting..." : "Reset"}
          </button>
        </div>
      )}

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col p-4 max-xl w-full mx-auto space-y-4">
        {/* Error / Alert banner */}
        {errorText && (
          <div className="p-3 bg-rose-950/60 border border-rose-800 rounded-2xl flex items-center justify-between text-xs text-rose-300">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
              <span>{errorText}</span>
            </div>
            <button onClick={() => setErrorText(null)} className="text-rose-400 hover:text-rose-200">
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Central Orb / Visualizer Card */}
        <div className="bg-gradient-to-b from-slate-900 to-slate-950 border border-slate-800/80 rounded-3xl p-6 flex flex-col items-center justify-center relative overflow-hidden shadow-xl min-h-[220px]">
          {/* Ambient glowing circles */}
          <div
            className={`absolute w-44 h-44 rounded-full blur-3xl transition-all duration-700 pointer-events-none ${
              liveState === "speaking"
                ? "bg-purple-600/30 scale-125"
                : liveState === "listening"
                ? "bg-emerald-600/25 scale-110"
                : liveState === "connecting"
                ? "bg-amber-600/20 scale-100 animate-pulse"
                : "bg-indigo-600/10 scale-90"
            }`}
          />

          {/* Visualizer Circle / Orb */}
          <div className="relative z-10 mb-4 flex items-center justify-center">
            <div
              className={`w-28 h-28 rounded-full border-2 flex items-center justify-center transition-all duration-500 shadow-2xl ${
                characterState === "talking"
                  ? "border-purple-400 bg-purple-950/60 shadow-purple-500/30 scale-105"
                  : characterState === "thinking"
                  ? "border-amber-400 bg-amber-950/60 shadow-amber-500/30 animate-pulse"
                  : characterState === "listening"
                  ? "border-emerald-400 bg-emerald-950/60 shadow-emerald-500/30 ring-4 ring-emerald-500/20"
                  : "border-slate-700 bg-slate-900/80 text-slate-500"
              }`}
            >
              {characterState === "talking" ? (
                <Volume2 className="w-10 h-10 text-purple-400 animate-bounce" />
              ) : characterState === "thinking" ? (
                <RefreshCw className="w-10 h-10 text-amber-400 animate-spin" />
              ) : characterState === "listening" ? (
                <Mic className="w-10 h-10 text-emerald-400" />
              ) : (
                <MicOff className="w-10 h-10 text-slate-500" />
              )}
            </div>
          </div>

          <p className="relative z-10 text-xs font-medium text-slate-400 tracking-wide text-center">
            {emergencyActive
              ? "System is halted by Emergency Stop"
              : characterState === "talking"
              ? "Myraa is speaking..."
              : characterState === "thinking"
              ? "Myraa is thinking..."
              : characterState === "listening"
              ? "Myraa is listening to you..."
              : "Microphone off. Tap button below to speak."}
          </p>

          {/* Toggle Mic / Push-To-Talk Button */}
          <button
            onClick={toggleMicrophone}
            disabled={emergencyActive}
            className={`mt-4 px-6 py-2.5 rounded-full font-semibold text-xs tracking-wider uppercase transition-all shadow-lg flex items-center gap-2 cursor-pointer active:scale-95 ${
              liveState === "disconnected"
                ? "bg-indigo-600 hover:bg-indigo-500 text-white shadow-indigo-600/30"
                : "bg-rose-600 hover:bg-rose-500 text-white shadow-rose-600/30"
            }`}
          >
            {liveState === "disconnected" ? (
              <>
                <Mic className="w-4 h-4" />
                <span>Start Voice</span>
              </>
            ) : (
              <>
                <MicOff className="w-4 h-4" />
                <span>Mute Voice</span>
              </>
            )}
          </button>
        </div>

        {/* Laptop Screen & Multimodal Context Insight (Phase 8) */}
        {remoteActiveWindow && (
          <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-3 flex items-center justify-between text-xs">
            <div className="flex items-center gap-2.5 overflow-hidden">
              <div className="p-1.5 rounded-lg bg-indigo-500/20 text-indigo-300 shrink-0">
                <Laptop className="w-4 h-4" />
              </div>
              <div className="overflow-hidden">
                <div className="text-[10px] uppercase font-semibold text-slate-400 tracking-wider">Laptop Foreground Window</div>
                <div className="text-slate-200 truncate font-mono text-[11px]">{remoteActiveWindow.title || "Desktop"}</div>
              </div>
            </div>
            <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border shrink-0 ${
              remoteActiveWindow.category === "sensitive" || remoteActiveWindow.isShielded
                ? "bg-amber-500/10 text-amber-300 border-amber-500/30"
                : remoteActiveWindow.category === "code_editor"
                ? "bg-cyan-500/10 text-cyan-300 border-cyan-500/30"
                : "bg-indigo-500/10 text-indigo-300 border-indigo-500/30"
            }`}>
              {remoteActiveWindow.category}
            </span>
          </div>
        )}

        {/* Quick Suggestion Chips */}
        <div className="flex items-center gap-2 overflow-x-auto pb-1 scrollbar-none text-[11px]">
          {[
            "Myraa, laptop par VS Code kholo",
            "Current project status batao",
            "Background tasks ka status kya hai?",
            "System health check karo",
          ].map((prompt, idx) => (
            <button
              key={idx}
              onClick={() => {
                setTextInput(prompt);
              }}
              className="shrink-0 px-3 py-1.5 rounded-full bg-slate-900 border border-slate-800 text-slate-400 hover:text-indigo-300 hover:border-slate-700 transition-colors cursor-pointer"
            >
              {prompt}
            </button>
          ))}
        </div>

        {/* Live Conversation Transcript Stream */}
        <div className="flex-1 bg-slate-900/60 border border-slate-800/80 rounded-3xl p-4 flex flex-col min-h-[220px] max-h-[360px] overflow-hidden">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-2 flex items-center justify-between">
            <span>Live Transcript</span>
            <span className="text-[10px] text-slate-500 font-normal">{messages.length} messages</span>
          </div>

          <div className="flex-1 overflow-y-auto space-y-3 pr-1 text-xs">
            {messages.length === 0 && !currentModelTurn && (
              <div className="h-full flex flex-col items-center justify-center text-slate-500 text-center py-8">
                <Radio className="w-8 h-8 mb-2 opacity-40" />
                <p>No messages yet.</p>
                <p className="text-[11px] text-slate-600">Speak into microphone or type a command below.</p>
              </div>
            )}

            {messages.map((m) => (
              <div
                key={m.id}
                className={`flex flex-col ${
                  m.role === "user"
                    ? "items-end"
                    : m.role === "system"
                    ? "items-center"
                    : "items-start"
                }`}
              >
                <span className="text-[10px] text-slate-500 mb-0.5 px-1">
                  {m.role === "user" ? "You" : m.role === "system" ? "System" : "Myraa"}
                </span>
                <div
                  className={`px-3.5 py-2 rounded-2xl max-w-[85%] leading-relaxed ${
                    m.role === "user"
                      ? "bg-indigo-600 text-white rounded-tr-sm"
                      : m.role === "system"
                      ? "bg-rose-950/80 border border-rose-800 text-rose-200 text-center"
                      : "bg-slate-800 text-slate-200 rounded-tl-sm border border-slate-700/60"
                  }`}
                >
                  {m.text}
                </div>
              </div>
            ))}

            {/* Currently streaming response */}
            {currentModelTurn && (
              <div className="flex flex-col items-start">
                <span className="text-[10px] text-slate-500 mb-0.5 px-1">Myraa</span>
                <div className="px-3.5 py-2 rounded-2xl max-w-[85%] leading-relaxed bg-slate-800 text-slate-200 rounded-tl-sm border border-slate-700/60">
                  {currentModelTurn}
                  <span className="inline-block w-1.5 h-3.5 ml-1 bg-indigo-400 animate-pulse align-middle" />
                </div>
              </div>
            )}

            <div ref={transcriptEndRef} />
          </div>
        </div>

        {/* Text Input Form */}
        <form onSubmit={handleSendText} className="flex items-center gap-2">
          <input
            type="text"
            value={textInput}
            onChange={(e) => setTextInput(e.target.value)}
            disabled={emergencyActive}
            placeholder={emergencyActive ? "Disabled during Emergency Stop" : "Send instruction or ask Myraa..."}
            className="flex-1 bg-slate-900 border border-slate-800 rounded-2xl px-4 py-2.5 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-all disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={emergencyActive || !textInput.trim()}
            className="p-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-2xl shadow transition-all cursor-pointer"
          >
            <Send className="w-4 h-4" />
          </button>
        </form>

        {/* Persistent Red Emergency Stop Button */}
        <div className="pt-2">
          <button
            onClick={() => setShowEmergencyModal(true)}
            disabled={emergencyActionLoading}
            className="w-full py-3 px-4 bg-gradient-to-r from-rose-700 via-rose-600 to-red-700 hover:from-rose-600 hover:to-red-600 active:scale-[0.98] text-white font-bold text-xs uppercase tracking-wider rounded-2xl shadow-lg shadow-rose-900/30 flex items-center justify-center gap-2 cursor-pointer transition-all border border-rose-500/30"
          >
            <ShieldAlert className="w-4 h-4" />
            <span>Emergency Stop (Killswitch)</span>
          </button>
        </div>
      </main>

      {/* Notifications Drawer (Slide-Over) */}
      {showNotifications && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/50 backdrop-blur-sm">
          <div className="w-full max-w-sm bg-slate-900 border-l border-slate-800 h-full p-4 flex flex-col shadow-2xl">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <h2 className="text-sm font-bold text-white flex items-center gap-2">
                <Bell className="w-4 h-4 text-indigo-400" />
                Companion Notifications
              </h2>
              <button
                onClick={() => setShowNotifications(false)}
                className="p-1 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto py-3 space-y-2 text-xs">
              {notifications.length === 0 ? (
                <div className="text-center py-12 text-slate-500">
                  <CheckCircle2 className="w-8 h-8 mx-auto mb-2 opacity-30 text-emerald-400" />
                  <p>All quiet. No active alerts.</p>
                </div>
              ) : (
                notifications.map((n) => (
                  <div
                    key={n.id}
                    className={`p-3 rounded-2xl border ${
                      n.type === "alert"
                        ? "bg-rose-950/40 border-rose-800 text-rose-200"
                        : "bg-slate-800/60 border-slate-700/60 text-slate-300"
                    }`}
                  >
                    <div className="font-semibold text-white mb-0.5">{n.title}</div>
                    <p className="text-[11px] leading-relaxed text-slate-400">{n.message}</p>
                    <span className="text-[10px] text-slate-500 mt-1 block">
                      {new Date(n.timestamp).toLocaleTimeString()}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Emergency Stop Confirmation Modal */}
      {showEmergencyModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div className="w-full max-w-md bg-slate-900 border border-rose-800/80 rounded-3xl p-6 shadow-2xl text-center">
            <div className="w-14 h-14 mx-auto mb-4 rounded-2xl bg-rose-600/20 border border-rose-500/40 flex items-center justify-center text-rose-400">
              <ShieldAlert className="w-8 h-8" />
            </div>
            <h3 className="text-lg font-bold text-white mb-2">Trigger Emergency Stop?</h3>
            <p className="text-xs text-slate-400 mb-6 leading-relaxed">
              This will instantly halt all running Planner plans, pause proactive background tasks, cancel any in-flight desktop tool calls, and block new actions until manually reset.
            </p>
            <div className="flex items-center gap-3">
              <button
                onClick={() => setShowEmergencyModal(false)}
                className="flex-1 py-2.5 px-4 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold cursor-pointer transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleTriggerEmergencyStop}
                disabled={emergencyActionLoading}
                className="flex-1 py-2.5 px-4 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold shadow-lg shadow-rose-600/30 cursor-pointer transition-colors"
              >
                {emergencyActionLoading ? "Halting..." : "Yes, STOP ALL"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Admin Pair Another Device Modal */}
      {showPairModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md">
          <div className="relative w-full max-w-sm rounded-3xl border border-white/10 bg-slate-900 p-6 shadow-2xl">
            <button
              onClick={() => setShowPairModal(false)}
              className="absolute top-4 right-4 p-1.5 rounded-full text-slate-400 hover:text-white hover:bg-white/10 transition cursor-pointer"
              title="Close"
            >
              <X className="w-4 h-4" />
            </button>

            <div className="flex flex-col items-center text-center mb-5">
              <div className="w-12 h-12 rounded-2xl bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center mb-3 text-indigo-400">
                <Laptop className="w-6 h-6" />
              </div>
              <h2 className="text-base font-bold text-white tracking-tight">Pair Companion Device</h2>
              <p className="text-xs text-slate-400 mt-1">
                Enter this single-use 6-character PIN on your PC or secondary device to pair.
              </p>
            </div>

            {pairCodeError && (
              <div className="mb-4 rounded-xl border border-rose-500/30 bg-rose-950/40 p-3 text-xs text-rose-300">
                {pairCodeError}
              </div>
            )}

            {isGeneratingPairCode ? (
              <div className="py-8 flex flex-col items-center justify-center gap-2 text-indigo-300 text-xs">
                <Loader2 className="w-6 h-6 animate-spin text-indigo-400" />
                <span>Generating secure pairing code...</span>
              </div>
            ) : generatedPairCode ? (
              <div className="space-y-4">
                <div className="p-4 rounded-2xl bg-slate-950/80 border border-indigo-500/30 flex flex-col items-center justify-center">
                  <span className="text-[10px] uppercase font-mono tracking-widest text-slate-400 mb-1">
                    Pairing PIN (Valid 5 Mins)
                  </span>
                  <span className="text-3xl font-mono font-bold tracking-[0.25em] text-white">
                    {generatedPairCode.code}
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={handleCopyPairCode}
                    className="flex-1 py-2.5 px-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold flex items-center justify-center gap-1.5 transition cursor-pointer"
                  >
                    {copiedCode ? (
                      <>
                        <Check className="w-3.5 h-3.5" />
                        <span>Copied to Clipboard!</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        <span>Copy PIN</span>
                      </>
                    )}
                  </button>

                  <button
                    onClick={handleGeneratePairCode}
                    className="p-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 transition cursor-pointer"
                    title="Generate New Code"
                  >
                    <RefreshCw className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ) : null}

            <div className="mt-5 pt-3 border-t border-slate-800/80 text-[11px] text-slate-500 text-center">
              Single-use PIN. Automatically invalidates once redeemed.
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
