import React, { useState, useEffect, useRef, FormEvent } from "react";
import { MyraAudioSession, LiveState } from "./lib/audio";
import { MyraaCoreVisualizer, MyraaEmotion } from "./components/MyraaCoreVisualizer";
import { BrowserAgent } from "./components/BrowserAgent";
import { 
  Power, 
  Volume2, 
  Info, 
  Sparkles, 
  Globe, 
  Maximize2, 
  MessageSquareOff, 
  Compass, 
  CircleAlert,
  MicOff,
  Mic,
  X,
  Brain,
  Monitor,
  Play,
  Pause,
  Square,
  RefreshCw,
  Settings as SettingsIcon,
  PictureInPicture2,
  Eye,
  EyeOff,
  ShieldCheck,
  MessageSquare,
  Terminal,
  Send,
  ChevronRight,
  Check,
  Bot,
  MoreVertical,
  ChevronDown,
  ChevronUp,
  PanelRight,
  Sun,
  Moon,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { Memory, MemoryCategory } from "./lib/memoryTypes";
import { MemoryDashboard } from "./components/MemoryDashboard";
import { SettingsPanel } from "./components/SettingsPanel";
import { ChatInterface, ChatMessage, ChatAttachment } from "./components/ChatInterface";
import { ProjectsDashboard } from "./components/ProjectsDashboard";
import { ResearchWorkspace } from "./components/ResearchWorkspace";
import { AgentWorkspace } from "./components/AgentWorkspace";
import { VisionModal } from "./components/VisionModal";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { MyraaSettings, DEFAULT_SETTINGS, loadSettings, saveSettings } from "./lib/settingsStore";
import { MyraaWakeWordDetector } from "./lib/wakeWord";
import { CloudPairingModal, StoredRemoteSession, STORAGE_KEY } from "./components/remote/CloudPairingModal";
import { authenticatedRemoteFetch, getAccessTokenExpiryInfo } from "./lib/remoteAuth";
import { ProductionControlHubModal } from "./components/ux/ProductionUxPanels";
import { RuntimeStatusIndicator } from "./components/ux/RuntimeStatusIndicator";
import {
  DecisionConfirmationModal,
  DecisionConfirmationData,
  evaluateConfirmationActionSend,
  sanitizeConfirmationUiError,
} from "./components/DecisionConfirmationModal";
function getStoredRemoteAuthHeaders(): Record<string, string> {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const sess = JSON.parse(raw);
      const expiry = getAccessTokenExpiryInfo(sess);
      const token = (sess.accessToken && !expiry.isExpired) ? sess.accessToken : sess.token;
      if (token) return { Authorization: `Bearer ${token}` };
    }
  } catch {}
  return {};
}

export default function App() {
  const [state, setState] = useState<LiveState>("disconnected");
  const [showControlHub, setShowControlHub] = useState<boolean>(false);

  const isRemoteHost =
    typeof window !== "undefined" &&
    window.location.hostname !== "localhost" &&
    window.location.hostname !== "127.0.0.1" &&
    window.location.hostname !== "::1";

  const [remoteSession, setRemoteSession] = useState<StoredRemoteSession | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  });

  const [operatorToken, setOperatorToken] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    try {
      const stored = localStorage.getItem("myraa_operator_session");
      if (stored) {
        const parsed = JSON.parse(stored);
        return parsed?.tokens?.accessToken || "";
      }
    } catch {}
    return "";
  });

  // Ensure valid desktop operator session or remote session
  useEffect(() => {
    const initSession = async () => {
      if (remoteSession?.accessToken) {
        const expiry = getAccessTokenExpiryInfo(remoteSession);
        if (!expiry.isExpired) return;
      }
      if (operatorToken) {
        const expiry = getAccessTokenExpiryInfo(operatorToken);
        if (!expiry.isExpired) return;
      }
      try {
        const stored = localStorage.getItem("myraa_operator_session");
        if (stored) {
          const parsed = JSON.parse(stored);
          if (parsed?.tokens?.accessToken) {
            const exp = getAccessTokenExpiryInfo(parsed.tokens.accessToken);
            if (!exp.isExpired) {
              setOperatorToken(parsed.tokens.accessToken);
              return;
            }
          }
        }
      } catch {}

      try {
        const res = await fetch("/api/security/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            deviceId: "desktop_local",
            identityId: "local_operator",
            role: "admin",
          }),
        });
        if (res.ok) {
          const data = await res.json();
          if (data?.tokens?.accessToken) {
            localStorage.setItem("myraa_operator_session", JSON.stringify(data));
            setOperatorToken(data.tokens.accessToken);
          }
        }
      } catch (err) {
        console.warn("Operator session auto-init deferred:", err);
      }
    };

    initSession();
  }, []);

  const getAuthHeaders = (): Record<string, string> => {
    if (remoteSession) {
      const expiry = getAccessTokenExpiryInfo(remoteSession);
      const token = (remoteSession.accessToken && !expiry.isExpired)
        ? remoteSession.accessToken
        : remoteSession.token;
      if (token) return { Authorization: `Bearer ${token}` };
    }
    if (operatorToken) {
      const expiry = getAccessTokenExpiryInfo(operatorToken);
      if (!expiry.isExpired) {
        return { Authorization: `Bearer ${operatorToken}` };
      }
    }
    try {
      const stored = localStorage.getItem("myraa_operator_session");
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed?.tokens?.accessToken) {
          return { Authorization: `Bearer ${parsed.tokens.accessToken}` };
        }
      }
    } catch {}
    return getStoredRemoteAuthHeaders();
  };

  // Phase 8 Multimodal Vision & Suggestion States
  const [continuousScreenEnabled, setContinuousScreenEnabled] = useState<boolean>(false);
  const [continuousScreenPaused, setContinuousScreenPaused] = useState<boolean>(false);
  const [privacyShieldActive, setPrivacyShieldActive] = useState<boolean>(false);
  const [contextSuggestions, setContextSuggestions] = useState<Array<{
    id: string;
    title: string;
    description: string;
    category: string;
    confidence: number;
    isModifying: boolean;
  }>>([]);

  // Real-time Screen Sharing states
  const [isScreenSharing, setIsScreenSharing] = useState<boolean>(false);
  const [isScreenSharingPaused, setIsScreenSharingPaused] = useState<boolean>(false);
  const [screenVisionMode, setScreenVisionMode] = useState<boolean>(true);

  // References to preserve state across intervals
  const screenStreamRef = useRef<MediaStream | null>(null);
  const screenVideoRef = useRef<HTMLVideoElement | null>(null);
  const screenCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const screenIntervalRef = useRef<any>(null);

  const isPausedRef = useRef<boolean>(false);
  const screenVisionRef = useRef<boolean>(true);
  const stateRef = useRef<LiveState>("disconnected");

  // Sync state changes with refs to totally prevent stale closures in callbacks
  useEffect(() => {
    isPausedRef.current = isScreenSharingPaused;
  }, [isScreenSharingPaused]);

  useEffect(() => {
    screenVisionRef.current = screenVisionMode;
  }, [screenVisionMode]);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // Clean up streaming intervals on unmount
  useEffect(() => {
    return () => {
      if (screenIntervalRef.current) {
        clearInterval(screenIntervalRef.current);
      }
    };
  }, []);

  // Multimodal status polling & sync (Phase 8)
  useEffect(() => {
    let timer: any;
    const fetchMultimodalStatus = async () => {
      const doFetch = async (url: string): Promise<Response> => {
        if (isRemoteHost && remoteSession) {
          const { response } = await authenticatedRemoteFetch(url, {}, remoteSession, setRemoteSession);
          return response;
        }
        return fetch(url, { headers: getAuthHeaders() });
      };
      try {
        const res = await doFetch("/api/multimodal/screen/continuous/status");
        if (res.ok) {
          const data = await res.json();
          setContinuousScreenEnabled(!!data.enabled);
          setContinuousScreenPaused(!!data.isPaused);
          setPrivacyShieldActive(!!data.privacyShieldActive);
        }
      } catch {}
      try {
        const sugRes = await doFetch("/api/multimodal/suggestions?limit=3");
        if (sugRes.ok) {
          const sugData = await sugRes.json();
          if (sugData.suggestions) {
            setContextSuggestions(sugData.suggestions);
          }
        }
      } catch {}
    };

    fetchMultimodalStatus();
    timer = setInterval(fetchMultimodalStatus, 8000);
    return () => clearInterval(timer);
  }, [remoteSession, isRemoteHost]);

  const handleToggleContinuousScreen = async () => {
    try {
      const action = continuousScreenEnabled ? "stop" : "start";
      const authHeaders = getAuthHeaders();
      const res = await fetch("/api/multimodal/screen/continuous", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({ action }),
      });
      if (res.ok) {
        const data = await res.json();
        setContinuousScreenEnabled(!!data.enabled);
        setContinuousScreenPaused(!!data.isPaused);
      } else {
        const errJson = await res.json().catch(() => ({}));
        console.warn("[Screen/Vision] /api/multimodal/screen/continuous status:", res.status, errJson);
      }

      // Synchronize visual capture: if turning on Vision, ensure feed is streaming; if turning off, stop stream
      if (action === "start" && !isScreenSharing) {
        await startScreenSharing();
      } else if (action === "stop" && isScreenSharing) {
        stopScreenSharing();
      }
    } catch (e) {
      console.error("Failed to toggle continuous screen perception:", e);
    }
  };

  const handleApplySuggestion = async (sugId: string) => {
    try {
      const authHeaders = getAuthHeaders();
      const res = await fetch(`/api/multimodal/suggestions/${sugId}/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
      });
      const data = await res.json();
      if (data.checkpointRequired) {
        alert(data.message);
      } else if (data.success) {
        setContextSuggestions((prev) => prev.filter((s) => s.id !== sugId));
      }
    } catch (e) {
      console.error("Failed to apply suggestion:", e);
    }
  };

  const captureFrameAndSend = () => {
    const video = screenVideoRef.current;
    if (!video || isPausedRef.current || !screenVisionRef.current) {
      return;
    }

    if (stateRef.current === "disconnected") {
      return;
    }

    try {
      if (video.videoWidth === 0 || video.videoHeight === 0) return;

      if (!screenCanvasRef.current) {
        screenCanvasRef.current = document.createElement("canvas");
      }
      const canvas = screenCanvasRef.current;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      // Restrict maximum resolution size to keep payload light for Gemini Live
      const maxDim = 960;
      let width = video.videoWidth;
      let height = video.videoHeight;

      if (width > maxDim || height > maxDim) {
        if (width > height) {
          height = Math.round((height * maxDim) / width);
          width = maxDim;
        } else {
          width = Math.round((width * maxDim) / height);
          height = maxDim;
        }
      }

      canvas.width = width;
      canvas.height = height;

      ctx.drawImage(video, 0, 0, width, height);

      // Highly compressed JPEG standard is optimized and preserves details perfectly
      const dataUrl = canvas.toDataURL("image/jpeg", 0.55);
      const base64 = dataUrl.split(",")[1];

      if (sessionRef.current && stateRef.current !== "disconnected") {
        sessionRef.current.sendVideoFrame(base64);
      }
    } catch (err) {
      console.error("[Screen Capture] Failed drawing frame to canvas:", err);
    }
  };

  const startScreenSharing = async () => {
    setErrorText(null);
    try {
      let stream: MediaStream;
      const isMobile = typeof navigator !== "undefined" && /android|iphone|ipad|mobile/i.test(navigator.userAgent);

      if (isMobile || !navigator.mediaDevices?.getDisplayMedia) {
        // Mobile or unsupported display capture: use device camera
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: {
              facingMode: { ideal: "environment" },
              width: { ideal: 1280 },
              height: { ideal: 720 },
            },
            audio: false,
          });
        } catch {
          stream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: false,
          });
        }
      } else {
        try {
          stream = await navigator.mediaDevices.getDisplayMedia({
            video: {
              width: { ideal: 1280 },
              height: { ideal: 720 },
              frameRate: { ideal: 5 },
            },
            audio: false,
          });
        } catch (displayErr: any) {
          // If screen capture was rejected or unavailable, try camera fallback
          if (
            displayErr?.name === "NotAllowedError" ||
            displayErr?.name === "NotFoundError" ||
            !navigator.mediaDevices?.getDisplayMedia
          ) {
            console.log("[Screen/Vision] Screen share denied or unavailable. Falling back to camera stream...");
            stream = await navigator.mediaDevices.getUserMedia({
              video: {
                facingMode: { ideal: "environment" },
                width: { ideal: 1280 },
                height: { ideal: 720 },
              },
              audio: false,
            });
          } else {
            throw displayErr;
          }
        }
      }

      screenStreamRef.current = stream;

      const video = document.createElement("video");
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      video.play().catch(e => console.error("Video play warning:", e));
      screenVideoRef.current = video;

      setIsScreenSharing(true);
      setIsScreenSharingPaused(false);
      setContinuousScreenEnabled(true);

      // Stop handling when native stop sharing bar button ends
      stream.getVideoTracks()[0].onended = () => {
        stopScreenSharing();
      };

      // Set up frame capture interval (one frame every 2 seconds is highly robust, preventing overload)
      if (screenIntervalRef.current) {
        clearInterval(screenIntervalRef.current);
      }
      screenIntervalRef.current = setInterval(() => {
        captureFrameAndSend();
      }, 2000);

      // Promptly capture first frame immediately
      setTimeout(() => {
        captureFrameAndSend();
      }, 500);

    } catch (e: any) {
      console.error("Screen/Vision permission declined or missing API:", e);
      if (e.name !== "NotAllowedError") {
        setErrorText(`Could not start Vision feed: ${e.message || e}`);
      }
    }
  };

  const stopScreenSharing = () => {
    if (screenIntervalRef.current) {
      clearInterval(screenIntervalRef.current);
      screenIntervalRef.current = null;
    }

    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch (e) {}
      });
      screenStreamRef.current = null;
    }

    if (screenVideoRef.current) {
      screenVideoRef.current.pause();
      screenVideoRef.current = null;
    }

    setIsScreenSharing(false);
    setIsScreenSharingPaused(false);
    setContinuousScreenEnabled(false);
  };

  const pauseScreenSharing = () => {
    setIsScreenSharingPaused(true);
  };

  const resumeScreenSharing = () => {
    setIsScreenSharingPaused(false);
    // Refresh first frame immediately
    setTimeout(() => {
      captureFrameAndSend();
    }, 100);
  };

  const switchScreenShare = async () => {
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch (e) {}
      });
    }
    await startScreenSharing();
  };

  const [activeEmotion, setActiveEmotion] = useState<MyraaEmotion>("idle");
  const [themeColor, setThemeColor] = useState<string>("charcoal");
  const [userCaption, setUserCaption] = useState<string>("");
  const [characterState, setCharacterState] = useState<"idle" | "thinking" | "talking">("idle");

  const detectEmotionFromText = (text: string): MyraaEmotion => {
    const lower = text.toLowerCase();
    if (lower.includes("haha") || lower.includes("lol") || lower.includes("funny") || lower.includes("joke") || lower.includes("hehe") || lower.includes("wink")) return "playful";
    if (lower.includes("happy") || lower.includes("harmony") || lower.includes("glad") || lower.includes("joy") || lower.includes("wonderful") || lower.includes("love") || lower.includes("smile")) return "happy";
    if (lower.includes("wow") || lower.includes("awesome") || lower.includes("excited") || lower.includes("amazing") || lower.includes("yay") || lower.includes("incredible") || lower.includes("hype")) return "excited";
    if (lower.includes("really?") || lower.includes("curious") || lower.includes("interest") || lower.includes("tell me more") || lower.includes("why") || lower.includes("how") || lower.includes("wonder")) return "curious";
    if (lower.includes("think") || lower.includes("calculat") || lower.includes("analyz") || lower.includes("hmmm") || lower.includes("process") || lower.includes("let me see") || lower.includes("conclude")) return "thinking";
    if (lower.includes("proud") || lower.includes("achieved") || lower.includes("expert") || lower.includes("skill") || lower.includes("confidence") || lower.includes("succeed")) return "proud";
    if (lower.includes("sad") || lower.includes("sorry") || lower.includes("unfortunate") || lower.includes("grief") || lower.includes("bad") || lower.includes("regret") || lower.includes("alas") || lower.includes("cry")) return "sad";
    if (lower.includes("shock") || lower.includes("surprise") || lower.includes("gasp") || lower.includes("unexpected") || lower.includes("seriously") || lower.includes("oh my")) return "surprised";
    if (lower.includes("blush") || lower.includes("shy") || lower.includes("embarrass") || lower.includes("nervous") || lower.includes("oops") || lower.includes("sorry about")) return "embarrassed";
    if (lower.includes("what?") || lower.includes("confus") || lower.includes("puzzled") || lower.includes("dont know") || lower.includes("not sure") || lower.includes("wait")) return "confused";
    return "idle";
  };
  const [modelCaption, setModelCaption] = useState<string>("");
  const [showChat, setShowChat] = useState<boolean>(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([
    {
      id: "greeting",
      role: "model",
      content: "Hello! I am MYRAA, your personal AI voice companion. You can talk to me directly using your voice, or type prompts and share files right here. How can I assist you today?",
      timestamp: Date.now(),
    },
  ]);
  const [activeProjectorUrl, setActiveProjectorUrl] = useState<string | null>(null);
  const activeProjectorUrlRef = useRef<string | null>(null);
  useEffect(() => {
    activeProjectorUrlRef.current = activeProjectorUrl;
  }, [activeProjectorUrl]);
  const [showGuide, setShowGuide] = useState<boolean>(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  // Reconnect status — shown as a soft indicator, not the alarming error banner.
  const [reconnectStatus, setReconnectStatus] = useState<string | null>(null);

  // Real-time code change tracking for line-by-line visual feedback
  const [lastCodeChange, setLastCodeChange] = useState<{
    summary: string;
    filePath: string;
    linesChanged: number;
    previewSnippet?: string;
    timestamp: string;
  } | null>(null);

  // Myraa Autopilot system controller state
  const [browserTrigger, setBrowserTrigger] = useState<{
    type: string;
    args: any;
    id: string;
    callback: (res: any) => void;
  } | null>(null);

  // Myraa recollections database core state
  const [memories, setMemories] = useState<Memory[]>([]);
  const [showMemoryDashboard, setShowMemoryDashboard] = useState<boolean>(false);
  const [showProjectsDashboard, setShowProjectsDashboard] = useState<boolean>(false);
  const [showResearchWorkspace, setShowResearchWorkspace] = useState<boolean>(false);
  const [showAgentWorkspace, setShowAgentWorkspace] = useState<boolean>(false);
  const [showVisionModal, setShowVisionModal] = useState<boolean>(false);
  const [pendingConfirmation, setPendingConfirmation] = useState<DecisionConfirmationData | null>(null);
  const [confirmationError, setConfirmationError] = useState<string | null>(null);
  useEffect(() => {
    if (!pendingConfirmation) {
      setConfirmationError(null);
    }
  }, [pendingConfirmation]);

  // V2: Settings + wake word state
  const [settings, setSettings] = useState<MyraaSettings>(() => loadSettings());
  const [showSettings, setShowSettings] = useState<boolean>(false);
  const showSettingsRef = useRef<boolean>(false);
  useEffect(() => { showSettingsRef.current = showSettings; }, [showSettings]);

  // V2: Wake word detector instance (Web Speech API, lives for the app lifetime)
  const wakeDetectorRef = useRef<MyraaWakeWordDetector | null>(null);
  // Ref indirection so the wake-word callback always calls the latest connect
  // handler, regardless of where it's declared in the component body.
  const connectHandlerRef = useRef<() => void>(() => {});

  // Initialize wake detector once on mount.
  useEffect(() => {
    const det = new MyraaWakeWordDetector();
    wakeDetectorRef.current = det;
    return () => {
      det.stop();
    };
  }, []);

  // Start / stop wake word detection when the setting changes.
  useEffect(() => {
    const det = wakeDetectorRef.current;
    if (!det) return;
    if (settings.wakeWordEnabled && state === "disconnected" && !errorText) {
      det.start({
        phrase: settings.wakePhrase,
        sensitivity: settings.sensitivity,
        onTriggered: () => {
          // When wake word fires, stop detector and connect MYRAA.
          det.stop();
          connectHandlerRef.current();
        },
      });
    } else {
      det.stop();
    }
  }, [settings.wakeWordEnabled, settings.wakePhrase, settings.sensitivity, state, errorText]);

  // Handle settings changes: persist to localStorage + update state.
  const handleSettingsChange = (patch: Partial<MyraaSettings>) => {
    const next = saveSettings(patch);
    setSettings(next);
  };

  const handleUnpairDevice = async () => {
    if (remoteSession?.deviceId) {
      try {
        await fetch(`/api/remote/devices/${remoteSession.deviceId}`, {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${remoteSession.token || remoteSession.accessToken}`,
          },
        });
      } catch {
        /* best effort */
      }
    }
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
    setRemoteSession(null);
    if (sessionRef.current) {
      sessionRef.current.disconnect();
      sessionRef.current.setToken("");
    }
  };

  const sessionRef = useRef<MyraAudioSession | null>(null);

  // Sync token to audio session whenever remoteSession changes
  useEffect(() => {
    if (sessionRef.current) {
      sessionRef.current.setToken(remoteSession?.accessToken || remoteSession?.token || "");
    }
  }, [remoteSession]);

  // Listen for real-time code change events
  useEffect(() => {
    let dismissTimer: any = null;
    const handleCodeChange = (e: any) => {
      const detail = e.detail;
      if (detail) {
        setLastCodeChange({
          summary: detail.summary || `Modified ${detail.filePath}`,
          filePath: detail.filePath || "",
          linesChanged: detail.linesChanged || 0,
          previewSnippet: detail.previewSnippet,
          timestamp: detail.timestamp || new Date().toISOString(),
        });
        if (dismissTimer) clearTimeout(dismissTimer);
        dismissTimer = setTimeout(() => {
          setLastCodeChange(null);
        }, 8000);
      }
    };
    window.addEventListener("myraa:code_change", handleCodeChange);
    return () => {
      window.removeEventListener("myraa:code_change", handleCodeChange);
      if (dismissTimer) clearTimeout(dismissTimer);
    };
  }, []);

  // Synchronize remoteSession role with live server authoritative state (GET /api/remote/session)
  useEffect(() => {
    if (!remoteSession?.token && !remoteSession?.accessToken) return;
    let cancelled = false;

    authenticatedRemoteFetch(
      "/api/remote/session",
      { method: "GET" },
      remoteSession,
      (updated) => setRemoteSession(updated),
    )
      .then(async ({ response: res }) => {
        if (res.ok && !cancelled) {
          const data = await res.json();
          const fetchedRole = data.device?.role || data.role;
          if (fetchedRole && fetchedRole !== remoteSession.role) {
            const updated: StoredRemoteSession = { ...remoteSession, role: fetchedRole };
            setRemoteSession(updated);
            try {
              localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
            } catch {}
          }
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [remoteSession?.token, remoteSession?.accessToken]);

  // Fetch initial recollections from backend database
  useEffect(() => {
    const token = operatorToken || remoteSession?.accessToken;
    if (!token) return; // Wait until operator or device token is available to prevent 401 Unauthorized
    const loadMemories = async () => {
      try {
        const res = await fetch("/api/memories", { headers: getAuthHeaders() });
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data)) {
            setMemories(data);
          }
        }
      } catch (err) {
        console.error("Initial persistent recollections load failure:", err);
      }
    };
    loadMemories();
  }, [operatorToken, remoteSession?.accessToken]);

  const handleAddManualMemory = async (category: MemoryCategory, text: string) => {
    try {
      const resp = await fetch("/api/memories", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ category, text })
      });
      if (resp.ok || resp.status === 202) {
        const refreshed = await fetch("/api/memories", { headers: getAuthHeaders() });
        if (refreshed.ok) {
          const data = await refreshed.json();
          if (Array.isArray(data)) {
            setMemories(data);
          }
        }
      }
    } catch (err) {
      console.error("Manual database recollect upload error:", err);
    }
  };

  const handleDeleteMemory = async (id: string) => {
    try {
      const resp = await fetch(`/api/memories/${id}`, {
        method: "DELETE",
        headers: getAuthHeaders(),
      });
      if (resp.ok || resp.status === 202) {
        setMemories((prev) => prev.filter(m => m.id !== id));
        const refreshed = await fetch("/api/memories", { headers: getAuthHeaders() });
        if (refreshed.ok) {
          const data = await refreshed.json();
          if (Array.isArray(data)) {
            setMemories(data);
          }
        }
      }
    } catch (err) {
      console.error("Manual memory delete execution failed:", err);
    }
  };

  const handleUpdateMemory = async (id: string, text: string, category?: MemoryCategory) => {
    try {
      const resp = await fetch(`/api/memories/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ text, category }),
      });
      if (resp.ok || resp.status === 202) {
        setMemories((prev) =>
          prev.map((m) =>
            m.id === id ? { ...m, text, category: category || m.category, updatedAt: new Date().toISOString() } : m
          )
        );
      }
    } catch (err) {
      console.error("Manual memory update execution failed:", err);
    }
  };

  // Initialize the audio session handlers once on mount
  useEffect(() => {
    sessionRef.current = new MyraAudioSession({
      token: remoteSession?.accessToken || remoteSession?.token,
      onSessionUpdate: (updated) => setRemoteSession(updated),
      onStateChange: (newState) => {
        setState(newState);
        if (newState === "disconnected") {
          // Reset captions on disconnect
          setUserCaption("");
          setModelCaption("");
          setActiveEmotion("idle");
          setCharacterState("idle");
        } else if (newState === "listening") {
          // Return to receptive resting state
          setActiveEmotion("idle");
          setCharacterState("idle");
        } else if (newState === "speaking") {
          setCharacterState("talking");
        }
      },
      onTranscription: (role, text) => {
        if (role === "user") {
          setUserCaption(text);
          // Auto-clear the other caption when user starts talking
          setModelCaption("");
          setCharacterState("thinking");
          setChatMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last && last.role === "user" && Date.now() - last.timestamp < 3500 && !last.attachments) {
              return [...prev.slice(0, -1), { ...last, content: text }];
            }
            return [
              ...prev,
              {
                id: `user-voice-${Date.now()}`,
                role: "user",
                content: text,
                timestamp: Date.now(),
                status: "sent",
              },
            ];
          });
        } else if (role === "model") {
          setModelCaption((prev) => {
            const next = prev + text;
            const newEmotion = detectEmotionFromText(next);
            setActiveEmotion(newEmotion);
            return next;
          });
          // Clear user caption when model replies
          setUserCaption("");
          setChatMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last && last.role === "model" && last.status === "streaming") {
              return [...prev.slice(0, -1), { ...last, content: last.content + text }];
            }
            return [
              ...prev,
              {
                id: `model-voice-${Date.now()}`,
                role: "model",
                content: text,
                timestamp: Date.now(),
                status: "streaming",
              },
            ];
          });
        }
      },
      onProsodyChange: (prosody: any) => {
        if (prosody?.emotion) {
          const map: Record<string, MyraaEmotion> = {
            happy: "happy",
            excited: "excited",
            curious: "curious",
            concerned: "confused",
            calm: "idle",
            neutral: "idle",
          };
          const mapped = map[prosody.emotion];
          if (mapped) setActiveEmotion(mapped);
        }
      },
      onNotification: (data: any) => {
        if (data.type === "companion_notification" && data.notification) {
          const notif = data.notification;
          if (notif.action === "browserSearch" || notif.type === "browser_action") {
            const q = notif.query || "";
            if (q) {
              const searchUrl = `https://youtube.com/results?search_query=${encodeURIComponent(q)}`;
              activeProjectorUrlRef.current = searchUrl;
              setActiveProjectorUrl(searchUrl);
              setBrowserTrigger({
                type: "browserSearch",
                args: { query: q, target: "youtube" },
                id: Math.random().toString(),
                callback: () => {}
              });
            }
          }
        }
      },
      onToolCall: (name, args, callback) => {
        console.log(`[App] Tool call triggered: ${name}`, args);
        
        const browserTools = [
          "browserOpen",
          "browserSearch",
          "browserClick",
          "browserMediaControl",
          "browserScroll",
          "browserType",
          "browserGoBack",
          "browserTabAction",
          "openWebsite",
          "searchYouTube"
        ];

        if (browserTools.includes(name)) {
          // Bring up the Holographic Browser Controller if it is not active
          if (!activeProjectorUrlRef.current) {
            let startingUrl = "https://youtube.com/results?search_query=Trending+Songs";
            if ((name === "browserOpen" || name === "openWebsite") && args.url) {
              startingUrl = args.url;
            } else if ((name === "browserSearch" || name === "searchYouTube") && args.query) {
              startingUrl = `https://youtube.com/results?search_query=${encodeURIComponent(args.query)}`;
            } else if (args.url) {
              startingUrl = args.url;
            } else if (args.videoId) {
              startingUrl = `https://www.youtube.com/watch?v=${args.videoId}`;
            } else if (args.query) {
              startingUrl = `https://youtube.com/results?search_query=${encodeURIComponent(args.query)}`;
            }

            // Normalize bare YouTube homepage to Trending Songs portal
            if (/^https?:\/\/(www\.)?youtube\.com\/?$/i.test(startingUrl) || /^https?:\/\/youtu\.be\/?$/i.test(startingUrl)) {
              startingUrl = "https://youtube.com/results?search_query=Trending+Songs";
            }

            activeProjectorUrlRef.current = startingUrl;
            setActiveProjectorUrl(startingUrl);
          }

          // Map instructions directly onto Browser Agent
          setBrowserTrigger({
            type: name === "openWebsite" ? "browserOpen" : name === "searchYouTube" ? "browserSearch" : name,
            args: name === "searchYouTube" ? { ...args, target: "youtube" } : args,
            id: Math.random().toString(),
            callback: (res) => {
              callback(res);
              setBrowserTrigger(null);
            }
          });
        } else if (name === "changeBackground") {
          const colorName = args.color?.toLowerCase();
          const validColors = ["violet", "crimson", "emerald", "celestial", "gold", "rose", "charcoal"];
          
          if (colorName && validColors.includes(colorName)) {
            setThemeColor(colorName);
            callback({ result: `Successfully shifted aesthetic atmosphere to ${colorName}.` });
          } else {
            callback({ error: `Unsupported color '${colorName}'. Supported themes are: ${validColors.join(", ")}` });
          }
        } else {
          // If running in Electron companion or on desktop, dispatch to local agent.
          // IMPORTANT: When loaded from the Render cloud URL (isRemoteHost), we cannot reach
          // localhost:8765 from the browser — Chrome's Private Network Access policy blocks it.
          // In that case, return a clear error immediately so Gemini can respond gracefully.
          const isDesktopEnv = typeof window !== "undefined" && !/android|iphone|ipad|mobile/i.test(navigator.userAgent);
          if ((window as any).myraa?.executeDesktopTool) {
            (window as any).myraa.executeDesktopTool(name, args).then(callback).catch((err: any) => {
              callback({ error: err?.message || `Desktop execution failed for ${name}` });
            });
          } else if (isRemoteHost) {
            // Running in the Render-hosted web client — localhost:8765 is unreachable
            // due to Chrome's Private Network Access policy.
            //
            // DEDUP: Track which desktop tools have already returned UNAVAILABLE so we
            // do not feed Gemini a new error on every retry — that causes a 20+ call loop.
            // On the first call: send a strongly-worded stop-retry instruction.
            // On subsequent calls (within 60s): return a silent minimal error.
            const failKey = `__myraaDesktopUnavailable_${name}`;
            const alreadyNotified = !!(window as any)[failKey];
            if (!alreadyNotified) {
              (window as any)[failKey] = true;
              setTimeout(() => { delete (window as any)[failKey]; }, 60000);
              console.warn(`[App] Desktop tool '${name}' requires Desktop Companion — first call, notifying Gemini to stop retrying.`);
              callback({
                ok: false,
                error: `PERMANENT_UNAVAILABLE: The MYRAA Desktop Companion is not running on the user's Windows PC. `
                  + `You MUST NOT call '${name}' or any other desktop tool (readScreen, takeScreenshot, openInVsCode, openFileManager, etc.) again this session. `
                  + `Instead, tell the user clearly: "To control your Windows PC I need the Desktop Companion app running. `
                  + `Please open Chrome on your PC and go to ${typeof window !== "undefined" ? window.location.hostname : "the MYRAA URL"}, `
                  + `or run the Desktop Companion app on your PC." Then wait for the user to respond.`,
              });
            } else {
              // Gemini is retrying despite the stop instruction — absorb silently to break the loop.
              console.warn(`[App] Desktop tool '${name}' called again on remote host — absorbing duplicate (loop prevention).`);
              callback({ ok: false, error: `Desktop Companion not available. Do not retry.` });
            }
          } else if (isDesktopEnv) {
            fetch("http://127.0.0.1:8765/execute", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ tool: name, args }),
            })
              .then(async (res) => {
                if (!res.ok) {
                  const txt = await res.text().catch(() => "");
                  callback({ ok: false, error: `Desktop agent error ${res.status}: ${txt}` });
                } else {
                  const json = await res.json();
                  callback(json);
                }
              })
              .catch(() => {
                callback({ error: `Desktop agent is not reachable on your PC. Please run: uvicorn desktop_agent.main:app --port 8765` });
              });
          } else {
            callback({ error: `Tool ${name} is not implemented on this device.` });
          }
        }
      },
      onError: (err) => {
        // RECONNECTING: prefix is sent by the WS auto-reconnect logic — show
        // a gentle status indicator rather than the alarming error banner.
        if (err.startsWith("RECONNECTING:")) {
          setReconnectStatus(err.replace("RECONNECTING:", "").trim());
        } else {
          setReconnectStatus(null);
          if (/operation was aborted/i.test(err)) {
            console.log("[App] Suppressing expected abort/close notification:", err);
            return;
          }
          setErrorText(err);
        }
      },
      onMemorySync: (updatedMemories) => {
        console.log("[App] WebSocket memories sync triggered:", updatedMemories);
        if (Array.isArray(updatedMemories)) {
          setMemories(updatedMemories);
        }
      },
      onConfirmationRequired: (data) => {
        // SEC-P3-R1.3-01: Never log raw confirmationToken or signature
        console.log("[App] Human confirmation required event received:", {
          tool: data?.tool,
          decisionId: data?.decisionId,
          projectId: data?.projectId,
        });
        setConfirmationError(null);
        setPendingConfirmation(data);
      },
      onDecisionResult: (result) => {
        if (result?.type === "decision_rejected" || result?.type === "decision_confirmed") {
          setConfirmationError(null);
          setPendingConfirmation((prev) =>
            prev?.decisionId === result.decisionId ? null : prev,
          );
        } else if (result?.type === "decision_rejection_failed" || result?.type === "decision_confirmation_failed") {
          const safeMsg = sanitizeConfirmationUiError(result.error);
          setConfirmationError(safeMsg);
          setErrorText(safeMsg);
        }
      },
    });

    const handleConfirmationEvent = (e: any) => {
      if (e?.detail) {
        console.log("[App] Custom event myraa:confirmation_required received:", {
          tool: e.detail?.tool,
          decisionId: e.detail?.decisionId,
          projectId: e.detail?.projectId,
        });
        setConfirmationError(null);
        setPendingConfirmation(e.detail);
      }
    };
    if (typeof window !== "undefined") {
      window.addEventListener("myraa:confirmation_required", handleConfirmationEvent);
    }

    return () => {
      if (typeof window !== "undefined") {
        window.removeEventListener("myraa:confirmation_required", handleConfirmationEvent);
      }
      if (sessionRef.current) {
        sessionRef.current.disconnect();
      }
    };
  }, []);

  const handleToggleConnection = async () => {
    setErrorText(null);
    setReconnectStatus(null);
    if (!sessionRef.current) return;

    if (state === "disconnected") {
      await sessionRef.current.connect();
    } else {
      sessionRef.current.disconnect();
    }
  };
  // V2: keep the ref in sync so the wake-word callback calls this exact handler.
  connectHandlerRef.current = handleToggleConnection;

  // Floating desktop companion state sync
  const floatingStateRef = useRef({ characterState, state, activeEmotion, themeColor });
  useEffect(() => {
    floatingStateRef.current = { characterState, state, activeEmotion, themeColor };
    if (window.myraa?.syncFloatingState) {
      window.myraa.syncFloatingState({
        characterState,
        liveState: state,
        activeEmotion,
        themeColor,
      });
    }
  }, [characterState, state, activeEmotion, themeColor]);

  useEffect(() => {
    if (!window.myraa) return;

    const cleanupReq = window.myraa.onFloatingStateRequest?.(() => {
      const cur = floatingStateRef.current;
      window.myraa?.syncFloatingState?.({
        characterState: cur.characterState,
        liveState: cur.state,
        activeEmotion: cur.activeEmotion,
        themeColor: cur.themeColor,
      });
    });

    const cleanupMic = window.myraa.onToggleMic?.(() => {
      connectHandlerRef.current();
    });

    return () => {
      cleanupReq?.();
      cleanupMic?.();
    };
  }, []);

  // Maps theme colors to CSS ambient light spots
  const getAmbientStyles = () => {
    switch (themeColor) {
      case "violet":
        return "from-purple-950/40 via-violet-950/20 to-slate-950";
      case "crimson":
        return "from-red-950/40 via-orange-950/20 to-slate-950";
      case "emerald":
        return "from-emerald-950/40 via-teal-950/20 to-slate-950";
      case "celestial":
        return "from-sky-950/45 via-indigo-950/25 to-slate-950";
      case "gold":
        return "from-amber-950/30 via-yellow-950/15 to-slate-950";
      case "rose":
        return "from-rose-950/40 via-pink-950/20 to-slate-950";
      case "charcoal":
      default:
        return "from-slate-900/50 via-slate-950/30 to-slate-950";
    }
  };

  const getThemeTextGlow = () => {
    switch (themeColor) {
      case "violet": return "text-purple-400 drop-shadow-[0_0_12px_rgba(168,85,247,0.5)]";
      case "crimson": return "text-rose-400 drop-shadow-[0_0_12px_rgba(244,63,94,0.5)]";
      case "emerald": return "text-emerald-400 drop-shadow-[0_0_12px_rgba(16,185,129,0.5)]";
      case "celestial": return "text-sky-400 drop-shadow-[0_0_12px_rgba(14,165,233,0.5)]";
      case "gold": return "text-amber-400 drop-shadow-[0_0_12px_rgba(245,158,11,0.5)]";
      case "rose": return "text-pink-400 drop-shadow-[0_0_12px_rgba(244,63,94,0.5)]";
      case "charcoal":
      default:
        return "text-indigo-400 drop-shadow-[0_0_12px_rgba(99,102,241,0.5)]";
    }
  };

  const getOrbRingColor = () => {
    switch (state) {
      case "listening": return "border-indigo-500/50 shadow-[0_0_30px_rgba(99,102,241,0.3)] bg-indigo-500/10";
      case "speaking": return "border-purple-500/70 shadow-[0_0_40px_rgba(168,85,247,0.4)] bg-purple-500/10";
      case "connecting": return "border-amber-500/50 animate-pulse bg-amber-500/10";
      case "disconnected":
      default:
        return "border-white/10 hover:border-indigo-500/30 bg-white/5";
    }
  };

  // Unified Neural Glass OS command & chat prompt state
  const [textInput, setTextInput] = useState<string>("");
  const [showTextInput, setShowTextInput] = useState<boolean>(false);
  const promptInputRef = useRef<HTMLInputElement | null>(null);
  const [showCodeDetails, setShowCodeDetails] = useState<boolean>(false);
  const [dismissNotice, setDismissNotice] = useState<boolean>(false);

  // Navigation panel toggle state (3-dots toggle on top left)
  const [showNavigation, setShowNavigation] = useState<boolean>(true);

  // Live Context panel toggle state (PanelRight toggle on top right header)
  const [showLiveContext, setShowLiveContext] = useState<boolean>(true);

  // Theme Mode: Light Blue Theme (Active Default) / Dark Theme (Fallback)
  const [themeMode, setThemeMode] = useState<"light" | "dark">(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("myraa_theme_mode");
      if (saved === "dark" || saved === "light") return saved;
    }
    return "light";
  });

  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("myraa_theme_mode", themeMode);
      document.documentElement.setAttribute("data-theme", themeMode);
      if (themeMode === "dark") {
        document.documentElement.classList.add("dark");
      } else {
        document.documentElement.classList.remove("dark");
      }
    }
  }, [themeMode]);

  // Compact Context Card detailed accordion toggle state
  const [showDetailedContext, setShowDetailedContext] = useState<boolean>(false);

  // 4. MYRAA CORE Architecture Status Popover State
  const [showCoreStatus, setShowCoreStatus] = useState<boolean>(false);
  const coreStatusRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (coreStatusRef.current && !coreStatusRef.current.contains(e.target as Node)) {
        setShowCoreStatus(false);
      }
    };
    if (showCoreStatus) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [showCoreStatus]);

  // 7. Phase 19 Live Context Fusion State
  const [liveContext, setLiveContext] = useState<{
    app: string;
    project: string;
    file: string;
    task: string;
    confidence: string;
  }>({
    app: "Chrome",
    project: "MYRAA AI",
    file: "frontend/App.tsx",
    task: "UI redesign",
    confidence: "94% • HIGH",
  });

  // 8. Security Indicator & Security Center Popover State
  const [showSecurityCenter, setShowSecurityCenter] = useState<boolean>(false);
  const securityCenterRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (securityCenterRef.current && !securityCenterRef.current.contains(e.target as Node)) {
        setShowSecurityCenter(false);
      }
    };
    if (showSecurityCenter) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [showSecurityCenter]);

  // Sync Phase 19 Live Context from backend
  useEffect(() => {
    let timer: any;
    const syncContext = async () => {
      try {
        const doFetch = async (url: string, opts?: any): Promise<Response> => {
          if (isRemoteHost && remoteSession) {
            const { response } = await authenticatedRemoteFetch(url, opts || {}, remoteSession, setRemoteSession);
            return response;
          }
          return fetch(url, { ...opts, headers: { "Content-Type": "application/json", ...getAuthHeaders() } });
        };

        const res = await doFetch("/api/context/unified", {
          method: "POST",
          body: JSON.stringify({ contextId: "ctx_dashboard_sync" }),
        });
        if (res.ok) {
          const data = await res.json();
          if (data.ok && data.unifiedContext) {
            const ctx = data.unifiedContext;
            setLiveContext((prev) => ({
              ...prev,
              app: ctx.currentApplication || prev.app,
              project: ctx.currentProject ? ctx.currentProject.split(/[\/\\]/).pop() || prev.project : prev.project,
              file: ctx.currentFile || prev.file,
              task: ctx.currentTask || prev.task,
            }));
          }
        }
      } catch {}
    };

    syncContext();
    timer = setInterval(syncContext, 15000);
    return () => clearInterval(timer);
  }, [remoteSession, isRemoteHost]);

  // 6. Phase 21 Proactive AI Card state & anti-spam cooldown management
  const [proactiveCard, setProactiveCard] = useState<{
    eventId?: string;
    message: string;
    verified?: boolean;
    confidence?: string;
  } | null>(null);
  const proactiveCooldownUntilRef = useRef<number>(0);
  const dismissedEventIdsRef = useRef<Set<string>>(new Set());

  // Proactive suggestion polling (GET /api/proactive/pending) with strict anti-spam cooldown
  useEffect(() => {
    let timer: any;
    const fetchPendingProactive = async () => {
      if (Date.now() < proactiveCooldownUntilRef.current) return;
      if (proactiveCard) return;

      try {
        const doFetch = async (url: string): Promise<Response> => {
          if (isRemoteHost && remoteSession) {
            const { response } = await authenticatedRemoteFetch(url, {}, remoteSession, setRemoteSession);
            return response;
          }
          return fetch(url, { headers: getAuthHeaders() });
        };

        const res = await doFetch("/api/proactive/pending");
        if (res.ok) {
          const data = await res.json();
          if (data.ok && data.pending) {
            const p = data.pending;
            if (p.eventId && dismissedEventIdsRef.current.has(p.eventId)) {
              return;
            }
            const message =
              p.analysis?.naturalEnglishExplanation ||
              p.analysis?.summary ||
              p.promptQuestion ||
              (p.file ? `Issue detected in ${p.file}. Would you like me to inspect it?` : "I noticed a pending optimization.");

            setProactiveCard({
              eventId: p.eventId,
              message,
              confidence: p.confidence || "HIGH",
            });
          }
        }
      } catch {}
    };

    fetchPendingProactive();
    timer = setInterval(fetchPendingProactive, 10000);
    return () => clearInterval(timer);
  }, [proactiveCard, remoteSession, isRemoteHost]);

  // Frontend build / code change trigger for Proactive AI Card
  useEffect(() => {
    if (!lastCodeChange) return;
    if (Date.now() < proactiveCooldownUntilRef.current) return;
    if (proactiveCard) return;

    setProactiveCard({
      message: "I noticed your frontend build finished.",
      confidence: "HIGH",
    });
    // Strict 60-second cooldown so it never constantly pops up
    proactiveCooldownUntilRef.current = Date.now() + 60000;
  }, [lastCodeChange]);

  const handleVerifyProactive = async () => {
    if (!proactiveCard) return;
    const eventId = proactiveCard.eventId;
    
    // Set verified visual feedback
    setProactiveCard((prev) => prev ? { ...prev, verified: true } : null);

    if (eventId) {
      try {
        await fetch("/api/proactive/respond", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...getAuthHeaders() },
          body: JSON.stringify({ userUtterance: "verify", eventId }),
        });
      } catch (e) {
        console.error("Failed to verify proactive event:", e);
      }
    }

    // Cooldown for 60 seconds
    proactiveCooldownUntilRef.current = Date.now() + 60000;
    setTimeout(() => {
      setProactiveCard(null);
    }, 1200);
  };

  const handleDismissProactive = async () => {
    if (!proactiveCard) return;
    const eventId = proactiveCard.eventId;
    if (eventId) {
      dismissedEventIdsRef.current.add(eventId);
      try {
        await fetch("/api/proactive/respond", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...getAuthHeaders() },
          body: JSON.stringify({ userUtterance: "dismiss", eventId }),
        });
      } catch (e) {
        console.error("Failed to dismiss proactive event:", e);
      }
    }

    // Cooldown for 60 seconds
    proactiveCooldownUntilRef.current = Date.now() + 60000;
    setProactiveCard(null);
  };

  useEffect(() => {
    if (lastCodeChange || contextSuggestions.length > 0) {
      setDismissNotice(false);
    }
  }, [lastCodeChange, contextSuggestions]);

  const handleSendTextMessage = (e?: React.FormEvent, customText?: string, attachments?: ChatAttachment[]) => {
    if (e) e.preventDefault();
    const text = (customText !== undefined ? customText : textInput).trim();
    if (!text && (!attachments || attachments.length === 0)) return;

    const messageContent = text || (attachments && attachments.length > 0 ? `[Attached ${attachments.length} file(s)]` : "");

    // Synchronize to chatMessages
    const newMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content: messageContent,
      timestamp: Date.now(),
      attachments: attachments && attachments.length > 0 ? attachments : undefined,
      status: "sent",
    };
    setChatMessages((prev) => [...prev, newMsg]);

    if (sessionRef.current) {
      if (state === "disconnected") {
        sessionRef.current.connect().then(() => {
          sessionRef.current?.sendTextMessage(messageContent);
        });
      } else {
        sessionRef.current.sendTextMessage(messageContent);
      }
    }
    setUserCaption(messageContent);
    setModelCaption("");
    setCharacterState("thinking");
    setTextInput("");
  };

  // Finalize streaming messages when speaking/thinking ends
  useEffect(() => {
    if (characterState !== "thinking" && state !== "speaking") {
      setChatMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last && last.role === "model" && last.status === "streaming") {
          return [...prev.slice(0, -1), { ...last, status: "sent" }];
        }
        return prev;
      });
    }
  }, [characterState, state]);

  const handleFocusChat = () => {
    setShowChat(true);
  };

  return (
    <div
      id="myraa-holographic-desktop"
      data-theme={themeMode}
      className="relative w-full h-screen overflow-hidden bg-gradient-to-b from-black via-[#030712] to-[#0A101D] text-[#F4F7FB] flex flex-col justify-between p-3 sm:p-5 select-none font-sans theme-transition"
    >
      {/* Ambient Atmospheric Glow (Black -> Deep Navy -> Subtle Violet/Cyan Glow, Item 15) */}
      <div className={`ambient-glow-1 absolute top-[-10%] left-[-5%] w-[550px] h-[550px] rounded-full blur-[160px] pointer-events-none transition-all duration-1000 ${
        state === "speaking" ? "bg-violet-900/18" :
        state === "listening" ? "bg-cyan-900/16" :
        characterState === "thinking" ? "bg-blue-900/14" :
        "bg-blue-950/12"
      }`} />
      <div className={`ambient-glow-2 absolute bottom-[-10%] right-[-5%] w-[650px] h-[650px] rounded-full blur-[180px] pointer-events-none transition-all duration-1000 ${
        state === "speaking" ? "bg-purple-900/16" :
        state === "listening" ? "bg-sky-950/14" :
        characterState === "thinking" ? "bg-indigo-950/14" :
        "bg-violet-950/10"
      }`} />
      <div className={`ambient-glow-3 absolute top-[35%] right-[20%] w-[450px] h-[450px] rounded-full blur-[150px] pointer-events-none transition-all duration-1000 ${
        state === "speaking" ? "bg-violet-900/12" :
        state === "listening" ? "bg-cyan-950/10" :
        characterState === "thinking" ? "bg-blue-950/10" :
        "bg-indigo-950/8"
      }`} />

      {/* Decorative subtle OS grid pattern */}
      <div className="os-grid-pattern absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.012)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.012)_1px,transparent_1px)] bg-[size:36px_36px] pointer-events-none opacity-25" />

      {/* 1. HEADER SECTION (Top Bar: MYRAA ● ONLINE) */}
      <header className="relative z-30 flex items-center justify-between w-full max-w-7xl mx-auto px-2 pb-2.5 pt-1 select-none border-b border-[#202938]/60">
        <div className="relative flex items-center gap-2">
          {/* 3-dots navigation toggle button */}
          <button
            onClick={() => setShowNavigation(!showNavigation)}
            className={`p-2 rounded-xl transition cursor-pointer flex items-center justify-center ${
              showNavigation
                ? "text-[#0284C7] dark:text-[#00F0FF] bg-sky-50 dark:bg-[#111722] border border-[#0284C7]/40 dark:border-[#00F0FF]/30 hover:border-[#0284C7]/70"
                : "text-slate-600 hover:text-slate-900 dark:text-[#8994A6] dark:hover:text-[#F4F7FB] hover:bg-slate-100 dark:hover:bg-[#111722]/80 border border-transparent"
            }`}
            title={showNavigation ? "Hide Navigation (Collapse)" : "Show Navigation (Expand)"}
            data-testid="toggle-navigation-btn"
          >
            <MoreVertical size={16} />
          </button>

          <button
            data-testid="core-status-btn"
            onClick={() => setShowCoreStatus(!showCoreStatus)}
            className="flex items-center gap-2.5 p-1.5 rounded-xl hover:bg-slate-100 dark:hover:bg-[#111722]/80 transition cursor-pointer text-left group"
            title="MYRAA Core Architecture Status"
          >
            <div className="flex items-center gap-3">
              <span className="text-base sm:text-lg font-bold tracking-[0.25em] text-slate-900 dark:text-[#F4F7FB] uppercase font-display group-hover:text-[#0284C7] dark:group-hover:text-[#00F0FF] transition-colors">
                MYRAA
              </span>
              <div className="flex items-center gap-1.5 text-xs font-mono">
                <span
                  className={`w-2 h-2 rounded-full ${
                    state === "listening" || state === "speaking"
                      ? "bg-[#0284C7] dark:bg-[#00F0FF] shadow-[0_0_8px_#0284C7] animate-pulse"
                      : state === "connecting"
                      ? "bg-[#F59E0B] shadow-[0_0_8px_#F59E0B] animate-pulse"
                      : "bg-[#10B981] shadow-[0_0_8px_#10B981]"
                  }`}
                />
                <span className="tracking-widest uppercase font-semibold text-emerald-600 dark:text-emerald-400">
                  {state === "listening"
                    ? "LISTENING"
                    : state === "speaking"
                    ? "SPEAKING"
                    : state === "connecting"
                    ? "CONNECTING"
                    : "ONLINE"}
                </span>
              </div>
            </div>
          </button>

          {/* MYRAA CORE Architecture Popover Modal */}
          <AnimatePresence>
            {showCoreStatus && (
              <motion.div
                ref={coreStatusRef}
                initial={{ opacity: 0, y: 8, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 8, scale: 0.96 }}
                className="absolute left-0 top-full mt-2 z-50 w-80 p-4 rounded-2xl neural-glass-elevated border border-slate-200 dark:border-[#202938] text-slate-900 dark:text-[#F4F7FB] shadow-2xl space-y-3.5 backdrop-blur-2xl"
              >
                <div className="flex items-center justify-between pb-2.5 border-b border-slate-200 dark:border-[#202938]/70">
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-[#0284C7] dark:bg-[#00F0FF] shadow-[0_0_8px_#0284C7]" />
                    <h3 className="text-xs font-mono font-bold tracking-widest text-slate-900 dark:text-[#F4F7FB] uppercase">
                      MYRAA CORE
                    </h3>
                  </div>
                  <span className="text-[10px] font-mono text-slate-500 dark:text-[#8994A6]">ARCH v2.5</span>
                </div>

                <div className="space-y-2.5 text-xs font-mono">
                  {/* Voice Engine */}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-slate-600 dark:text-[#8994A6]">
                      <span className={`w-1.5 h-1.5 rounded-full ${
                        state === "listening" ? "bg-[#0284C7] dark:bg-[#00F0FF] shadow-[0_0_6px_#0284C7] animate-pulse" :
                        state === "speaking" ? "bg-[#8B5CF6] shadow-[0_0_6px_#8B5CF6] animate-pulse" :
                        "bg-emerald-500 dark:bg-emerald-400 shadow-[0_0_6px_#10B981]"
                      }`} />
                      <span>Voice Engine</span>
                    </div>
                    <span className="text-slate-900 dark:text-[#F4F7FB] font-medium">
                      {state === "listening" ? "Listening" : state === "speaking" ? "Speaking" : "Ready"}
                    </span>
                  </div>

                  {/* Adaptive Brain */}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-slate-600 dark:text-[#8994A6]">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 dark:bg-emerald-400 shadow-[0_0_6px_#10B981]" />
                      <span>Adaptive Brain</span>
                    </div>
                    <span className="text-emerald-600 dark:text-emerald-400 font-medium">Active</span>
                  </div>

                  {/* Memory */}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-slate-600 dark:text-[#8994A6]">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 dark:bg-emerald-400 shadow-[0_0_6px_#10B981]" />
                      <span>Memory</span>
                    </div>
                    <span className="text-emerald-600 dark:text-emerald-400 font-medium">
                      {memories.length > 0 ? `${memories.length} recollections` : "Active"}
                    </span>
                  </div>

                  {/* Context */}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-slate-600 dark:text-[#8994A6]">
                      <span className="w-1.5 h-1.5 rounded-full bg-[#0284C7] dark:bg-[#00F0FF] shadow-[0_0_6px_#0284C7]" />
                      <span>Context</span>
                    </div>
                    <span className="text-[#0284C7] dark:text-[#00F0FF] font-medium">12 sources</span>
                  </div>

                  {/* Knowledge Graph */}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-slate-600 dark:text-[#8994A6]">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 dark:bg-emerald-400 shadow-[0_0_6px_#10B981]" />
                      <span>Knowledge Graph</span>
                    </div>
                    <span className="text-emerald-600 dark:text-emerald-400 font-medium">Connected</span>
                  </div>

                  {/* Security */}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-slate-600 dark:text-[#8994A6]">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 dark:bg-emerald-400 shadow-[0_0_6px_#10B981]" />
                      <span>Security</span>
                    </div>
                    <span className="text-emerald-600 dark:text-emerald-400 font-medium">Protected</span>
                  </div>
                </div>

                <div className="pt-2 border-t border-[#202938]/60 flex items-center justify-between text-[10px] font-mono text-[#8994A6]">
                  <span>LATENCY: ~180ms</span>
                  <span className="text-emerald-400">ZERO TRUST ACTIVE</span>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Nav / Tools: Security Center, Settings */}
        <div className="flex items-center gap-2 sm:gap-2.5">
          <RuntimeStatusIndicator />
          {/* 8. Security Indicator & Security Center Popover */}
          <div className="relative">
            <button
              data-testid="security-center-btn"
              onClick={() => setShowSecurityCenter(!showSecurityCenter)}
              className={`neural-pill px-2.5 py-1.5 rounded-xl flex items-center gap-1.5 text-xs font-mono transition cursor-pointer ${
                showSecurityCenter
                  ? "border-emerald-500/60 text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-[#111722]"
                  : "text-slate-600 dark:text-[#8994A6] hover:text-slate-900 dark:hover:text-[#F4F7FB]"
              }`}
              title="Security Center"
            >
              <ShieldCheck size={13} className="text-emerald-500 dark:text-emerald-400" />
              <span className="text-slate-800 dark:text-[#F4F7FB] font-medium hidden xs:inline">Protected</span>
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 dark:bg-emerald-400 shadow-[0_0_6px_#10B981]" />
            </button>

            {/* SECURITY CENTER POPOVER */}
            <AnimatePresence>
              {showSecurityCenter && (
                <motion.div
                  ref={securityCenterRef}
                  initial={{ opacity: 0, y: 8, scale: 0.96 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 8, scale: 0.96 }}
                  className="absolute right-0 top-full mt-2.5 z-50 w-80 p-4 rounded-2xl neural-glass-elevated border border-slate-200 dark:border-[#202938] text-slate-900 dark:text-[#F4F7FB] shadow-2xl space-y-3.5 backdrop-blur-2xl"
                >
                  <div className="flex items-center justify-between pb-2.5 border-b border-slate-200 dark:border-[#202938]/70">
                    <div className="flex items-center gap-2">
                      <ShieldCheck size={15} className="text-emerald-500 dark:text-emerald-400" />
                      <h3 className="text-xs font-mono font-bold tracking-widest text-slate-900 dark:text-[#F4F7FB] uppercase">
                        SECURITY CENTER
                      </h3>
                    </div>
                    <span className="text-[10px] font-mono text-emerald-700 dark:text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20">
                      ZERO TRUST
                    </span>
                  </div>

                  <div className="space-y-2.5 text-xs font-mono">
                    <div className="flex items-center justify-between">
                      <span className="text-slate-600 dark:text-[#8994A6]">Policy Engine</span>
                      <span className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400 font-medium">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 dark:bg-emerald-400 shadow-[0_0_6px_#10B981]" />
                        Active
                      </span>
                    </div>

                    <div className="flex items-center justify-between">
                      <span className="text-slate-600 dark:text-[#8994A6]">Risk Engine</span>
                      <span className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400 font-medium">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 dark:bg-emerald-400 shadow-[0_0_6px_#10B981]" />
                        Active
                      </span>
                    </div>

                    <div className="flex items-center justify-between">
                      <span className="text-slate-600 dark:text-[#8994A6]">Tool Firewall</span>
                      <span className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400 font-medium">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 dark:bg-emerald-400 shadow-[0_0_6px_#10B981]" />
                        Active
                      </span>
                    </div>

                    <div className="flex items-center justify-between">
                      <span className="text-slate-600 dark:text-[#8994A6]">Confirmation</span>
                      <span className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400 font-medium">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 dark:bg-emerald-400 shadow-[0_0_6px_#10B981]" />
                        Active
                      </span>
                    </div>

                    <div className="flex items-center justify-between">
                      <span className="text-slate-600 dark:text-[#8994A6]">Audit</span>
                      <span className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400 font-medium">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 dark:bg-emerald-400 shadow-[0_0_6px_#10B981]" />
                        Active
                      </span>
                    </div>
                  </div>

                  {/* SYSTEM STATUS Banner */}
                  <div className="p-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/25 flex items-center justify-between font-mono">
                    <span className="text-[10px] text-slate-600 dark:text-[#8994A6] uppercase tracking-wider">
                      SYSTEM STATUS
                    </span>
                    <span className="text-xs font-bold text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
                      <span>SECURE</span>
                      <Check size={12} />
                    </span>
                  </div>

                  {/* Safe Controls footer (Discreet, not a huge red button on Home screen!) */}
                  <div className="pt-2 border-t border-slate-200 dark:border-[#202938]/60 flex items-center justify-between text-[10px] font-mono">
                    <button
                      onClick={() => {
                        setShowSecurityCenter(false);
                        setShowControlHub(true);
                      }}
                      className="text-[#0284C7] dark:text-[#00F0FF] hover:underline cursor-pointer font-medium"
                    >
                      Open Full Hub →
                    </button>
                    <button
                      onClick={async () => {
                        if (confirm("Trigger Emergency Stop? All active agent tasks will halt immediately.")) {
                          try {
                            await fetch("/api/remote/emergency-stop", {
                              method: "POST",
                              headers: { "Content-Type": "application/json", ...getAuthHeaders() },
                              body: JSON.stringify({ reason: "Manual Emergency Halt via Security Center" })
                            });
                            alert("Emergency Stop activated.");
                          } catch {}
                        }
                      }}
                      className="text-rose-600 hover:text-rose-700 dark:text-rose-400/80 dark:hover:text-rose-300 transition cursor-pointer"
                    >
                      Safe Halt
                    </button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Live Context Toggle Button */}
          <button
            onClick={() => setShowLiveContext(!showLiveContext)}
            className={`neural-pill px-2.5 py-1.5 rounded-xl flex items-center gap-1.5 text-xs font-mono transition cursor-pointer ${
              showLiveContext
                ? "border-[#00F0FF]/60 text-[#00F0FF] bg-[#111722]"
                : "text-[#8994A6] hover:text-[#F4F7FB]"
            }`}
            title={showLiveContext ? "Hide Live Context (Collapse)" : "Show Live Context (Expand)"}
            data-testid="toggle-live-context-btn"
          >
            <PanelRight size={13} className={showLiveContext ? "text-[#00F0FF]" : "text-[#8994A6]"} />
            <span className="hidden xs:inline">Context</span>
          </button>

          <button
            onClick={() => setShowSettings(!showSettings)}
            className={`neural-pill px-2.5 py-1.5 rounded-xl flex items-center gap-1.5 text-xs font-mono transition cursor-pointer ${
              showSettings
                ? "border-[#00F0FF]/60 text-[#00F0FF] bg-[#111722]"
                : "text-[#8994A6] hover:text-[#F4F7FB]"
            }`}
            title="Myraa Configuration"
            data-testid="toggle-settings-btn"
          >
            <SettingsIcon size={13} className={showSettings ? "animate-spin [animation-duration:6s] text-[#00F0FF]" : "text-[#8994A6]"} />
            <span className="hidden xs:inline">Settings</span>
          </button>

          {/* Theme Mode Toggle (Light Blue / Dark Fallback) */}
          <button
            onClick={() => setThemeMode(themeMode === "light" ? "dark" : "light")}
            className="neural-pill p-2 rounded-xl flex items-center justify-center transition cursor-pointer text-[#8994A6] hover:text-[#00F0FF]"
            title={themeMode === "light" ? "Switch to Dark Theme (Fallback)" : "Switch to Light Blue Theme"}
            data-testid="toggle-theme-mode-btn"
          >
            {themeMode === "light" ? <Moon size={14} className="text-slate-600 hover:text-blue-600" /> : <Sun size={14} className="text-amber-400" />}
          </button>

          {window.myraa?.isDesktop && (
            <button
              onClick={() => window.myraa?.toggleFloating?.()}
              className="neural-pill p-2 rounded-xl flex items-center justify-center transition cursor-pointer text-[#8994A6] hover:text-[#F4F7FB]"
              title="Toggle Floating Desktop Companion"
            >
              <PictureInPicture2 size={14} />
            </button>
          )}
        </div>
      </header>

      {/* 2. MAIN 3-COLUMN DASHBOARD STAGE */}
      <main className="relative z-20 flex-1 w-full max-w-7xl mx-auto grid grid-cols-1 md:grid-cols-12 gap-3 lg:gap-4 items-stretch py-1 sm:py-2 min-h-0 overflow-hidden">
        
        {/* LEFT COLUMN: NAVIGATION (Item 17: HOME, CHAT, MEMORY, PROJECTS, RESEARCH, VISION, AGENTS, CONTROL, SETTINGS) */}
        {showNavigation && (
          <div
            className="hidden md:flex md:col-span-3 h-full flex-col justify-between neural-glass-panel rounded-2xl p-4 overflow-y-auto transition-all duration-300"
          >
              <div className="space-y-3">
                <div className="flex items-center justify-between pb-2 border-b border-slate-200 dark:border-[#202938]/60">
                  <div className="flex items-center gap-2">
                    <span className="w-1.5 h-1.5 rounded-full bg-[#0284C7] dark:bg-[#00F0FF] shadow-[0_0_6px_#0284C7]" />
                    <span className="text-[11px] font-mono font-bold tracking-wider text-slate-500 dark:text-[#8994A6] uppercase">
                      NAVIGATION
                    </span>
                  </div>
                  <span className="text-[10px] font-mono text-slate-500 dark:text-[#8994A6]">OS READY</span>
                </div>

                {/* The Navigation Items */}
                <div className="space-y-1 pt-0.5 text-xs">
                  {/* 1. HOME */}
                  <button
                    onClick={() => {
                      setShowChat(false);
                      setShowResearchWorkspace(false);
                      setShowAgentWorkspace(false);
                      setShowMemoryDashboard(false);
                      setShowProjectsDashboard(false);
                      setShowSettings(false);
                      setShowControlHub(false);
                      setShowVisionModal(false);
                      setShowCodeDetails(false);
                    }}
                    className="w-full px-3 py-2 rounded-xl hover:bg-slate-100 dark:hover:bg-[#111722]/80 text-slate-600 dark:text-[#8994A6] hover:text-slate-900 dark:hover:text-[#F4F7FB] text-left transition-all flex items-center justify-between group cursor-pointer"
                  >
                    <div className="flex items-center gap-2.5">
                      <span className="text-xs text-[#0284C7] dark:text-[#00F0FF]">🏠</span>
                      <span className="font-mono font-semibold tracking-wider text-slate-900 dark:text-[#F4F7FB] text-[11px] group-hover:text-[#0284C7] dark:group-hover:text-[#00F0FF]">HOME</span>
                    </div>
                    <span className="text-[9px] font-mono text-slate-500 dark:text-[#8994A6]">DASHBOARD</span>
                  </button>

                  {/* 2. CHAT */}
                  <button
                    onClick={() => setShowChat(!showChat)}
                    className={`w-full px-3 py-2 rounded-xl text-left transition-all flex items-center justify-between group cursor-pointer ${
                      showChat
                        ? "bg-sky-50 dark:bg-[#111722] border border-[#0284C7]/40 dark:border-[#3B82F6]/50 text-slate-900 dark:text-[#F4F7FB]"
                        : "hover:bg-slate-100 dark:hover:bg-[#111722]/80 text-slate-600 dark:text-[#8994A6] hover:text-slate-900 dark:hover:text-[#F4F7FB]"
                    }`}
                    data-testid="nav-chat-btn"
                  >
                    <div className="flex items-center gap-2.5">
                      <span className="text-xs text-[#0284C7] dark:text-[#3B82F6]">💬</span>
                      <span className="font-mono font-semibold tracking-wider text-slate-900 dark:text-[#F4F7FB] text-[11px] group-hover:text-[#0284C7] dark:group-hover:text-[#3B82F6]">CHAT</span>
                    </div>
                    <span className="text-[9px] font-mono text-slate-500 dark:text-[#8994A6]">{chatMessages.length > 1 ? `${chatMessages.length} MSGS` : "READY"}</span>
                  </button>

                  {/* 3. MEMORY */}
                  <button
                    onClick={() => setShowMemoryDashboard(true)}
                    className={`w-full px-3 py-2 rounded-xl text-left transition-all flex items-center justify-between group cursor-pointer ${
                      showMemoryDashboard ? "bg-purple-50 dark:bg-[#111722] border border-purple-400/40 dark:border-[#00F0FF]/40 text-slate-900 dark:text-[#F4F7FB]" : "hover:bg-slate-100 dark:hover:bg-[#111722]/80 text-slate-600 dark:text-[#8994A6] hover:text-slate-900 dark:hover:text-[#F4F7FB]"
                    }`}
                    data-testid="nav-memory-btn"
                  >
                    <div className="flex items-center gap-2.5">
                      <span className="text-xs text-[#8B5CF6]">🧠</span>
                      <span className="font-mono font-semibold tracking-wider text-slate-900 dark:text-[#F4F7FB] text-[11px] group-hover:text-[#8B5CF6]">MEMORY</span>
                    </div>
                    <span className="text-[9px] font-mono text-slate-500 dark:text-[#8994A6]">{memories.length > 0 ? `${memories.length} REC` : "SYNC"}</span>
                  </button>

                  {/* 4. PROJECTS */}
                  <button
                    onClick={() => setShowProjectsDashboard(true)}
                    className={`w-full px-3 py-2 rounded-xl text-left transition-all flex items-center justify-between group cursor-pointer ${
                      showProjectsDashboard ? "bg-sky-50 dark:bg-[#111722] border border-[#0284C7]/40 dark:border-[#3B82F6]/40 text-slate-900 dark:text-[#F4F7FB]" : "hover:bg-slate-100 dark:hover:bg-[#111722]/80 text-slate-600 dark:text-[#8994A6] hover:text-slate-900 dark:hover:text-[#F4F7FB]"
                    }`}
                    data-testid="nav-projects-btn"
                  >
                    <div className="flex items-center gap-2.5">
                      <span className="text-xs text-blue-600 dark:text-blue-400">📁</span>
                      <span className="font-mono font-semibold tracking-wider text-slate-900 dark:text-[#F4F7FB] text-[11px] group-hover:text-blue-600 dark:group-hover:text-blue-400">PROJECTS</span>
                    </div>
                    <span className="text-[9px] font-mono text-slate-500 dark:text-[#8994A6]">{lastCodeChange ? "ACTIVE" : "LIVE"}</span>
                  </button>

                  {/* 5. RESEARCH */}
                  <button
                    onClick={() => setShowResearchWorkspace(true)}
                    className={`w-full px-3 py-2 rounded-xl text-left transition-all flex items-center justify-between group cursor-pointer ${
                      showResearchWorkspace ? "bg-sky-50 dark:bg-[#111722] border border-[#0284C7]/40 dark:border-[#00F0FF]/40 text-slate-900 dark:text-[#F4F7FB]" : "hover:bg-slate-100 dark:hover:bg-[#111722]/80 text-slate-600 dark:text-[#8994A6] hover:text-slate-900 dark:hover:text-[#F4F7FB]"
                    }`}
                    data-testid="nav-research-btn"
                  >
                    <div className="flex items-center gap-2.5">
                      <span className="text-xs text-[#0284C7] dark:text-[#00F0FF]">🔎</span>
                      <span className="font-mono font-semibold tracking-wider text-slate-900 dark:text-[#F4F7FB] text-[11px] group-hover:text-[#0284C7] dark:group-hover:text-[#00F0FF]">RESEARCH</span>
                    </div>
                    <span className="text-[9px] font-mono text-slate-500 dark:text-[#8994A6]">EVIDENCE</span>
                  </button>

                  {/* 6. VISION */}
                  <button
                    data-testid="nav-vision-btn"
                    onClick={() => setShowVisionModal(true)}
                    className={`w-full px-3 py-2 rounded-xl text-left transition-all flex items-center justify-between group cursor-pointer ${
                      continuousScreenEnabled || isScreenSharing
                        ? "bg-emerald-50 dark:bg-[#111722] border border-emerald-500/40 text-slate-900 dark:text-[#F4F7FB]"
                        : "hover:bg-slate-100 dark:hover:bg-[#111722]/80 text-slate-600 dark:text-[#8994A6] hover:text-slate-900 dark:hover:text-[#F4F7FB]"
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
                      <span className={`text-xs ${continuousScreenEnabled || isScreenSharing ? "text-emerald-500" : "text-slate-400 dark:text-[#8994A6]"}`}>👁</span>
                      <span className="font-mono font-semibold tracking-wider text-slate-900 dark:text-[#F4F7FB] text-[11px] group-hover:text-emerald-500">VISION</span>
                    </div>
                    <span className="text-[9px] font-mono text-emerald-600 dark:text-emerald-400">{continuousScreenEnabled || isScreenSharing ? "ACTIVE" : "READY"}</span>
                  </button>

                  {/* 7. AGENTS */}
                  <button
                    data-testid="nav-agents-btn"
                    onClick={() => setShowAgentWorkspace(true)}
                    className={`w-full px-3 py-2 rounded-xl text-left transition-all flex items-center justify-between group cursor-pointer ${
                      showAgentWorkspace ? "bg-purple-50 dark:bg-[#111722] border border-[#8B5CF6]/40 text-slate-900 dark:text-[#F4F7FB]" : "hover:bg-slate-100 dark:hover:bg-[#111722]/80 text-slate-600 dark:text-[#8994A6] hover:text-slate-900 dark:hover:text-[#F4F7FB]"
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
                      <span className="text-xs text-[#8B5CF6]">🤖</span>
                      <span className="font-mono font-semibold tracking-wider text-slate-900 dark:text-[#F4F7FB] text-[11px] group-hover:text-[#8B5CF6]">AGENTS</span>
                    </div>
                    <span className="text-[9px] font-mono text-[#8B5CF6]">PIPELINE</span>
                  </button>

                  {/* 8. CONTROL */}
                  <button
                    data-testid="nav-control-btn"
                    onClick={() => setShowControlHub(true)}
                    className={`w-full px-3 py-2 rounded-xl text-left transition-all flex items-center justify-between group cursor-pointer ${
                      showControlHub ? "bg-amber-50 dark:bg-[#111722] border border-amber-500/40 text-slate-900 dark:text-[#F4F7FB]" : "hover:bg-slate-100 dark:hover:bg-[#111722]/80 text-slate-600 dark:text-[#8994A6] hover:text-slate-900 dark:hover:text-[#F4F7FB]"
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
                      <span className="text-xs text-amber-500">⚡</span>
                      <span className="font-mono font-semibold tracking-wider text-slate-900 dark:text-[#F4F7FB] text-[11px] group-hover:text-amber-500">CONTROL</span>
                    </div>
                    <span className="text-[9px] font-mono text-slate-500 dark:text-[#8994A6]">HUB</span>
                  </button>

                  {/* 9. SETTINGS */}
                  <button
                    onClick={() => setShowSettings(true)}
                    className={`w-full px-3 py-2 rounded-xl text-left transition-all flex items-center justify-between group cursor-pointer ${
                      showSettings ? "bg-purple-50 dark:bg-[#111722] border border-[#8B5CF6]/40 text-slate-900 dark:text-[#F4F7FB]" : "hover:bg-slate-100 dark:hover:bg-[#111722]/80 text-slate-600 dark:text-[#8994A6] hover:text-slate-900 dark:hover:text-[#F4F7FB]"
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
                      <span className="text-xs text-slate-500 group-hover:text-slate-900 dark:text-[#8994A6] dark:group-hover:text-[#F4F7FB]">⚙</span>
                      <span className="font-mono font-semibold tracking-wider text-slate-900 dark:text-[#F4F7FB] text-[11px] group-hover:text-slate-900 dark:group-hover:text-[#F4F7FB]">SETTINGS</span>
                    </div>
                    <span className="text-[9px] font-mono text-slate-500 dark:text-[#8994A6]">CONFIG</span>
                  </button>
                </div>
              </div>

              <div className="pt-3 border-t border-slate-200 dark:border-[#202938]/60 flex items-center justify-between text-[10px] font-mono text-slate-500 dark:text-[#8994A6]">
                <span>SYSTEM</span>
                <span className="text-[#0284C7] dark:text-[#00F0FF]/90 font-medium">9 MODULES ONLINE</span>
              </div>
            </div>
          )}

        {/* CENTER COLUMN: MYRAA AVATAR STAGE */}
        <div
          className={`col-span-12 ${
            showNavigation && showLiveContext
              ? "md:col-span-6"
              : showNavigation || showLiveContext
              ? "md:col-span-9"
              : "md:col-span-12"
          } h-full flex flex-col items-center justify-center neural-glass-panel rounded-2xl p-2 sm:p-3 overflow-hidden transition-all duration-300 relative`}
        >
          {/* Holographic Projector Screen Widget (if website opened) */}
          <AnimatePresence>
            {activeProjectorUrl && (
              <div className="absolute inset-x-0 top-3 z-40 flex justify-center p-2">
                <motion.div
                  initial={{ opacity: 0, y: -20, scale: 0.95 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -20, scale: 0.95 }}
                  className="neural-glass-elevated flex items-center justify-between gap-4 p-3 rounded-2xl w-full max-w-md shadow-2xl"
                >
                  <div className="flex items-center gap-3 overflow-hidden text-left">
                    <div className="p-2 ml-1 rounded-xl bg-[#3B82F6]/15 text-[#3B82F6]">
                      <Globe size={16} />
                    </div>
                    <div className="overflow-hidden">
                      <h4 className="text-[11px] font-bold font-mono tracking-wide text-[#F4F7FB] uppercase">Holographic Projection Broadcast</h4>
                      <p className="text-[11px] text-[#8994A6] truncate max-w-[200px]">{activeProjectorUrl}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => setActiveProjectorUrl(activeProjectorUrl)}
                      className="p-1.5 rounded-lg bg-[#3B82F6] text-white hover:bg-[#2563EB] transition cursor-pointer"
                      title="View Frame"
                    >
                      <Maximize2 size={13} />
                    </button>
                    <button
                      onClick={() => setActiveProjectorUrl(null)}
                      className="p-1.5 rounded-lg hover:bg-white/5 text-[#8994A6] hover:text-white transition cursor-pointer"
                    >
                      <X size={13} />
                    </button>
                  </div>
                </motion.div>
              </div>
            )}
          </AnimatePresence>

          {/* AVATAR RENDERER STAGE CONTAINER
               flex-1 + min-h-0 let the stage stretch to fill all available
               vertical space. The status pill floats as absolute overlay
               so it never consumes layout height from the stage. */}
          <div className="relative w-full h-full flex-1 min-h-0 flex items-center justify-center">
            <MyraaCoreVisualizer
              session={sessionRef.current}
              state={state}
              themeColor={themeColor}
              activeEmotion={activeEmotion}
              characterState={characterState}
              avatarMode="video"
              isResearching={showResearchWorkspace}
              hasError={!!errorText}
              errorText={errorText}
            />

            {/* AVATAR STATE PILL & CAPTION OVERLAY — absolute so they don't
                shrink the stage. Anchored to bottom-centre of the stage. */}
            <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-30 flex flex-col items-center gap-2 w-full max-w-md px-4 pointer-events-none">
              {/* Status Pill: ● Listening / ● Speaking / ● Standby */}
              <div className="neural-pill px-3.5 py-1.5 rounded-full flex items-center gap-2 shadow-lg pointer-events-auto">
                <span className={`w-2 h-2 rounded-full ${
                  state === "speaking" ? "bg-[#8B5CF6] shadow-[0_0_8px_#8B5CF6] animate-pulse" :
                  state === "listening" ? "bg-[#00F0FF] shadow-[0_0_8px_#00F0FF] animate-pulse" :
                  state === "connecting" ? "bg-[#F59E0B] animate-spin" :
                  "bg-emerald-400 shadow-[0_0_6px_#10B981]"
                }`} />
                <span className="text-xs font-mono uppercase tracking-wider text-[#F4F7FB] font-medium">
                  {state === "speaking" ? "Speaking" :
                   state === "listening" ? "Listening" :
                   state === "connecting" ? "Connecting..." :
                   "Standby"}
                </span>
                {characterState === "thinking" && (
                  <span className="text-[10px] font-mono text-[#00F0FF] animate-pulse">· Thinking</span>
                )}
              </div>

              {/* User Caption / Model Caption Fading Stream */}
              <AnimatePresence>
                {userCaption && (
                  <motion.div
                    initial={{ opacity: 0, y: 5 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -5 }}
                    className="neural-glass-subtle px-3.5 py-2 rounded-xl text-xs font-sans text-[#F4F7FB] border border-[#202938] max-w-sm text-center pointer-events-none"
                  >
                    <span className="text-[10px] font-mono text-[#8994A6] mr-1.5 uppercase">You:</span>
                    &quot;{userCaption}&quot;
                  </motion.div>
                )}
                {modelCaption && (
                  <motion.div
                    initial={{ opacity: 0, y: 5 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -5 }}
                    className="neural-glass-elevated px-4 py-2.5 rounded-xl text-xs font-sans text-[#F4F7FB] border border-[#00F0FF]/25 max-w-md text-center shadow-xl pointer-events-none"
                  >
                    <span className="text-[10px] font-mono text-[#00F0FF] mr-1.5 uppercase font-semibold">MYRAA:</span>
                    &quot;{modelCaption}&quot;
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>

        </div>

        {/* RIGHT COLUMN: COMPACT CONTEXT CARD (Neural Glass OS) */}
        {showLiveContext && (
          <div
            className="hidden md:flex md:col-span-3 h-full flex-col justify-between neural-glass-panel rounded-2xl p-4 overflow-y-auto transition-all duration-300"
          >
              <div className="space-y-3.5">
                <div className="flex items-center justify-between pb-2.5 border-b border-slate-200 dark:border-[#202938]/70">
                  <div className="flex items-center gap-2">
                    <span className="w-1.5 h-1.5 rounded-full bg-[#10B981] shadow-[0_0_6px_#10B981] animate-pulse" />
                    <span className="text-[11px] font-mono font-bold tracking-widest text-slate-900 dark:text-[#F4F7FB] uppercase">
                      LIVE CONTEXT
                    </span>
                  </div>
                  <button
                    onClick={() => setShowDetailedContext(!showDetailedContext)}
                    className="flex items-center gap-1 text-[10px] font-mono text-slate-600 hover:text-[#0284C7] dark:text-[#8994A6] dark:hover:text-[#00F0FF] transition cursor-pointer bg-slate-100 dark:bg-[#111722] px-2 py-0.5 rounded-lg border border-slate-200 dark:border-[#202938] hover:border-[#0284C7]/40"
                    title={showDetailedContext ? "Collapse detailed telemetry" : "Expand detailed telemetry"}
                    data-testid="toggle-detailed-context-btn"
                  >
                    <span>{showDetailedContext ? "LESS" : "MORE"}</span>
                    {showDetailedContext ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                  </button>
                </div>

                {/* The 5 Core Items Prominently Displayed on Home Screen */}
                <div className="space-y-3 text-xs">
                  {/* 1. Current App */}
                  <div>
                    <div className="text-[10px] font-mono font-semibold text-slate-500 dark:text-[#8994A6] uppercase tracking-wider">
                      CURRENT APP
                    </div>
                    <div className="text-sm font-semibold text-slate-900 dark:text-[#F4F7FB] mt-0.5 flex items-center justify-between">
                      <span>{liveContext.app}</span>
                      <span className="text-[9px] font-mono text-emerald-700 dark:text-emerald-400 bg-emerald-500/10 px-1.5 py-0.2 rounded border border-emerald-500/20">ACTIVE</span>
                    </div>
                  </div>

                  {/* 2. Current Project */}
                  <div>
                    <div className="text-[10px] font-mono font-semibold text-slate-500 dark:text-[#8994A6] uppercase tracking-wider">
                      CURRENT PROJECT
                    </div>
                    <div className="text-sm font-semibold text-slate-900 dark:text-[#F4F7FB] mt-0.5">
                      {liveContext.project}
                    </div>
                  </div>

                  {/* 3. Current File */}
                  <div>
                    <div className="text-[10px] font-mono font-semibold text-slate-500 dark:text-[#8994A6] uppercase tracking-wider">
                      CURRENT FILE
                    </div>
                    <div className="text-xs font-mono text-[#0284C7] dark:text-[#00F0FF] mt-0.5 truncate font-medium" title={lastCodeChange?.filePath || liveContext.file}>
                      {lastCodeChange?.filePath || liveContext.file}
                    </div>
                  </div>

                  {/* 4. Current Task */}
                  <div>
                    <div className="text-[10px] font-mono font-semibold text-slate-500 dark:text-[#8994A6] uppercase tracking-wider">
                      CURRENT TASK
                    </div>
                    <div className="text-xs font-medium text-slate-900 dark:text-[#F4F7FB] mt-0.5">
                      {liveContext.task}
                    </div>
                  </div>

                  {/* 5. Confidence */}
                  <div className="pt-2 border-t border-slate-200 dark:border-[#202938]/60">
                    <div className="text-[10px] font-mono font-semibold text-slate-500 dark:text-[#8994A6] uppercase tracking-wider">
                      CONFIDENCE
                    </div>
                    <div className="text-sm font-mono font-bold text-emerald-600 dark:text-[#10B981] mt-0.5 flex items-center gap-1.5">
                      <span>{liveContext.confidence}</span>
                    </div>
                  </div>
                </div>

                {/* Expandable detailed context accordion */}
                <AnimatePresence>
                  {showDetailedContext && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={{ duration: 0.2 }}
                      className="pt-2.5 border-t border-slate-200 dark:border-[#202938]/60 space-y-2.5 overflow-hidden text-xs font-mono"
                    >
                      <div className="flex items-center justify-between text-slate-600 dark:text-[#8994A6]">
                        <span>Screen Perception</span>
                        <span className={continuousScreenEnabled || isScreenSharing ? "text-emerald-600 dark:text-emerald-400 font-medium" : "text-slate-500 dark:text-[#8994A6]"}>
                          {continuousScreenEnabled || isScreenSharing ? "ACTIVE (OCR)" : "STANDBY"}
                        </span>
                      </div>

                      <div className="flex items-center justify-between text-slate-600 dark:text-[#8994A6]">
                        <span>Fusion Latency</span>
                        <span className="text-[#0284C7] dark:text-[#00F0FF] font-medium">~180ms</span>
                      </div>

                      <div className="flex items-center justify-between text-slate-600 dark:text-[#8994A6]">
                        <span>Unified Sources</span>
                        <span className="text-emerald-600 dark:text-emerald-400 font-medium">12 Connected</span>
                      </div>

                      {lastCodeChange && (
                        <div className="mt-2 p-2 rounded-xl bg-slate-100 dark:bg-[#111722] border border-slate-200 dark:border-[#202938] space-y-1">
                          <div className="flex items-center justify-between text-[10px]">
                            <span className="text-slate-600 dark:text-[#8994A6]">DIFF LINES</span>
                            <span className="text-amber-600 dark:text-amber-400 font-bold">+{lastCodeChange.linesChanged}</span>
                          </div>
                          <p className="text-[10px] text-slate-600 dark:text-[#8994A6] truncate">{lastCodeChange.summary}</p>
                        </div>
                      )}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              <div className="pt-3 border-t border-slate-200 dark:border-[#202938]/60 flex items-center justify-between text-[10px] font-mono text-slate-500 dark:text-[#8994A6]">
                <span>CONTEXT FUSION</span>
                <span className="text-emerald-600 dark:text-emerald-400 font-medium">ACTIVE · SYNCD</span>
              </div>
            </div>
          )}

      </main>

      {/* 3. PROACTIVE AI SUGGESTION CARD (Phase 21) & PERCEPTION BAR */}
      <div className="relative z-20 w-full max-w-3xl mx-auto px-2 py-0.5 shrink-0">
        <AnimatePresence>
          {proactiveCard ? (
            <motion.div
              initial={{ opacity: 0, y: 10, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 10, scale: 0.98 }}
              className="neural-glass-elevated rounded-2xl p-4 border border-slate-200 dark:border-[#202938] shadow-2xl space-y-3 relative backdrop-blur-xl"
            >
              {/* Header: ⚡ MYRAA SUGGESTION */}
              <div className="flex items-center justify-between pb-2 border-b border-slate-200 dark:border-[#202938]/60">
                <div className="flex items-center gap-2">
                  <span className="text-[#0284C7] dark:text-[#00F0FF] animate-pulse">⚡</span>
                  <span className="text-xs font-mono font-bold tracking-wider text-slate-900 dark:text-[#F4F7FB] uppercase">
                    MYRAA SUGGESTION
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-mono text-emerald-700 dark:text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20">
                    {proactiveCard.confidence ? `${proactiveCard.confidence} CONFIDENCE` : "PREDICTIVE AI"}
                  </span>
                  <button
                    onClick={handleDismissProactive}
                    className="text-slate-500 hover:text-slate-900 dark:text-[#8994A6] dark:hover:text-[#F4F7FB] transition cursor-pointer p-0.5"
                    title="Dismiss"
                  >
                    <X size={14} />
                  </button>
                </div>
              </div>

              {/* Message */}
              <div className="text-xs sm:text-sm font-sans text-slate-800 dark:text-[#F4F7FB] leading-relaxed">
                {proactiveCard.message}
              </div>

              {/* Action Buttons: [ Verify ] [ Dismiss ] */}
              <div className="flex items-center justify-end gap-2.5 pt-1">
                <button
                  onClick={handleDismissProactive}
                  className="px-3.5 py-1.5 rounded-xl text-xs font-mono text-slate-600 dark:text-[#8994A6] hover:text-slate-900 dark:hover:text-[#F4F7FB] hover:bg-slate-100 dark:hover:bg-white/5 border border-transparent transition cursor-pointer"
                >
                  Dismiss
                </button>
                <button
                  onClick={handleVerifyProactive}
                  disabled={proactiveCard.verified}
                  className={`px-4 py-1.5 rounded-xl text-xs font-mono font-medium transition cursor-pointer flex items-center gap-1.5 ${
                    proactiveCard.verified
                      ? "bg-emerald-500 text-white"
                      : "bg-[#0284C7] hover:bg-sky-600 text-white shadow-[0_0_15px_rgba(2,132,199,0.35)]"
                  }`}
                >
                  {proactiveCard.verified ? (
                    <>
                      <span>Verified</span>
                      <Check size={13} />
                    </>
                  ) : (
                    <>
                      <span>Verify</span>
                      <ChevronRight size={13} />
                    </>
                  )}
                </button>
              </div>
            </motion.div>
          ) : (
            !dismissNotice && (
              <motion.div
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 6 }}
                className="neural-glass-subtle py-2 px-3.5 rounded-xl flex items-center justify-between text-xs font-mono border border-slate-200 dark:border-[#202938] text-slate-600 dark:text-[#8994A6]"
              >
                <div className="flex items-center gap-2 overflow-hidden">
                  <span className="text-[#0284C7] dark:text-[#00F0FF] animate-pulse">⚡</span>
                  {lastCodeChange ? (
                    <span className="truncate text-slate-800 dark:text-[#F4F7FB]">
                      MYRAA noticed code modifications in <strong className="text-[#0284C7] dark:text-[#00F0FF]">{lastCodeChange.filePath}</strong> ({lastCodeChange.linesChanged} lines)
                    </span>
                  ) : contextSuggestions.length > 0 ? (
                    <span className="truncate text-slate-800 dark:text-[#F4F7FB]">
                      MYRAA noticed: <strong className="text-[#0284C7] dark:text-[#00F0FF]">{contextSuggestions[0].title}</strong> — {contextSuggestions[0].description}
                    </span>
                  ) : (
                    <span className="truncate text-slate-600 dark:text-[#8994A6]">
                      MYRAA noticed active session: neural glass perception engine tracking workspace context in real-time.
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {lastCodeChange && (
                    <button
                      onClick={() => setShowCodeDetails(true)}
                      className="text-[10px] font-mono uppercase px-2 py-0.5 rounded bg-sky-50 dark:bg-[#111722] border border-sky-300 dark:border-[#202938] text-[#0284C7] dark:text-[#00F0FF] hover:bg-sky-100 dark:hover:bg-[#00F0FF]/10 transition cursor-pointer"
                    >
                      View Diff
                    </button>
                  )}
                  {contextSuggestions.length > 0 && (
                    <button
                      onClick={() => handleApplySuggestion(contextSuggestions[0].id)}
                      className="text-[10px] font-mono uppercase px-2 py-0.5 rounded bg-[#0284C7]/15 border border-[#0284C7]/40 text-[#0284C7] hover:bg-[#0284C7]/25 transition cursor-pointer"
                    >
                      Apply
                    </button>
                  )}
                  <button
                    onClick={() => setDismissNotice(true)}
                    className="text-slate-500 hover:text-slate-900 dark:text-[#8994A6] dark:hover:text-[#F4F7FB] text-xs px-1 cursor-pointer"
                  >
                    ×
                  </button>
                </div>
              </motion.div>
            )
          )}
        </AnimatePresence>
      </div>

      {/* 4. BOTTOM INTERACTION DOCK — VOICE AS HERO FEATURE */}
      <footer className="relative z-30 w-full max-w-3xl mx-auto flex flex-col items-center gap-2 mb-0.5 shrink-0">

        {/* Optional Collapsible Text Prompt Bar */}
        <AnimatePresence>
          {showTextInput && (
            <motion.form
              initial={{ opacity: 0, y: 8, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.98 }}
              onSubmit={handleSendTextMessage}
              className="w-full max-w-xl flex items-center gap-2 neural-glass-elevated px-3 py-2 rounded-2xl border border-slate-200 dark:border-[#202938] shadow-2xl mb-1"
            >
              <input
                ref={promptInputRef}
                type="text"
                value={textInput}
                onChange={(e) => setTextInput(e.target.value)}
                placeholder="Type a prompt for MYRAA..."
                className="w-full bg-transparent border-none text-xs sm:text-sm font-sans text-slate-900 dark:text-[#F4F7FB] placeholder-slate-400 dark:placeholder-[#8994A6]/60 focus:outline-none px-1"
              />
              {textInput.trim() && (
                <button
                  type="submit"
                  className="p-1.5 rounded-lg bg-[#3B82F6] text-white hover:bg-[#2563EB] transition cursor-pointer shrink-0"
                  title="Send Prompt"
                >
                  <Send size={13} />
                </button>
              )}
              <button
                type="button"
                onClick={() => setShowTextInput(false)}
                className="text-[#8994A6] hover:text-[#F4F7FB] p-1 cursor-pointer"
                title="Close text prompt"
              >
                <X size={13} />
              </button>
            </motion.form>
          )}
        </AnimatePresence>
        
        {/* Floating unified interaction dock */}
        <div className="neural-glass-dock w-full rounded-2xl p-2 sm:p-2.5 flex items-center justify-between gap-3 shadow-2xl">
          
          {/* Left: Chat Prompt Toggle */}
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setShowChat(!showChat)}
              className={`p-2 sm:px-3 sm:py-2 rounded-xl text-xs font-mono transition flex items-center gap-1.5 cursor-pointer ${
                showChat
                  ? "bg-[#0284C7]/15 border border-[#0284C7]/60 text-[#0284C7] dark:bg-[#111722] dark:border-[#00F0FF]/50 dark:text-[#00F0FF]"
                  : "bg-white/80 dark:bg-[#111722]/80 border border-slate-200 dark:border-[#202938] text-slate-600 dark:text-[#8994A6] hover:text-slate-900 dark:hover:text-[#F4F7FB]"
              }`}
              title="Toggle MYRAA Chat Interface"
              data-testid="dock-chat-toggle-btn"
            >
              <MessageSquare size={13} className={showChat ? "text-[#0284C7] dark:text-[#00F0FF]" : "text-slate-500 dark:text-[#8994A6]"} />
              <span className="hidden sm:inline">Chat</span>
            </button>
          </div>

          {/* Center: HERO VOICE CAPSULE */}
          <button
            onClick={handleToggleConnection}
            className={`flex-1 max-w-sm sm:max-w-md py-2.5 px-4 sm:px-6 rounded-2xl flex flex-col items-center justify-center transition-all duration-300 cursor-pointer select-none group relative overflow-hidden ${
              state === "speaking"
                ? "bg-[#8B5CF6]/15 border border-[#8B5CF6]/70 shadow-[0_0_35px_rgba(139,92,246,0.35)]"
                : state === "listening"
                ? "bg-[#0284C7]/15 border border-[#0284C7]/70 shadow-[0_0_35px_rgba(2,132,199,0.35)]"
                : characterState === "thinking" || state === "connecting"
                ? "bg-[#0284C7]/15 border border-[#0284C7]/70 shadow-[0_0_30px_rgba(2,132,199,0.3)]"
                : "bg-white/90 dark:bg-[#111722]/90 border border-slate-200 dark:border-[#202938] hover:border-[#0284C7]/40 dark:hover:border-[#00F0FF]/40 shadow-lg hover:shadow-[0_0_20px_rgba(2,132,199,0.15)]"
            }`}
            title={state === "disconnected" ? "Tap to speak with MYRAA" : "Tap to pause voice session"}
          >
            {/* Top Prompt / Status label */}
            <div className="flex items-center gap-2 text-xs sm:text-sm font-medium transition-colors">
              <span className={`text-sm sm:text-base transition-transform group-hover:scale-110 ${
                state === "speaking" ? "text-[#8B5CF6]" :
                state === "listening" ? "text-[#0284C7] dark:text-[#00F0FF]" :
                characterState === "thinking" ? "text-[#0284C7] dark:text-[#3B82F6]" :
                "text-slate-800 dark:text-[#F4F7FB] group-hover:text-[#0284C7]"
              }`}>
                🎙
              </span>
              <span className="text-slate-900 dark:text-[#F4F7FB] font-sans tracking-wide">
                {state === "speaking"
                  ? "MYRAA is speaking..."
                  : state === "listening"
                  ? "Listening to you..."
                  : characterState === "thinking"
                  ? "Thinking..."
                  : state === "connecting"
                  ? "Connecting..."
                  : "Talk to MYRAA..."}
              </span>
            </div>

            {/* Bottom State Indicator Pill */}
            <div className="mt-0.5 flex items-center justify-center text-[10px] sm:text-[11px] font-mono">
              {state === "speaking" ? (
                <span className="flex items-center gap-1.5 text-[#8B5CF6] font-semibold tracking-wider">
                  <span className="tracking-tight text-xs font-bold animate-pulse">)))</span>
                  <span>Speaking...</span>
                </span>
              ) : characterState === "thinking" || state === "connecting" ? (
                <span className="flex items-center gap-1.5 text-[#0284C7] dark:text-[#3B82F6] font-semibold tracking-wider">
                  <span className="w-2.5 h-2.5 rounded-full border-2 border-[#0284C7] dark:border-[#3B82F6] border-t-transparent animate-spin" />
                  <span>Thinking...</span>
                </span>
              ) : state === "listening" ? (
                <span className="flex items-center gap-1.5 text-[#0284C7] dark:text-[#00F0FF] font-semibold tracking-wider">
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#0284C7] dark:bg-[#00F0FF] opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-[#0284C7] dark:bg-[#00F0FF]"></span>
                  </span>
                  <span>Listening...</span>
                </span>
              ) : (
                <span className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400 font-semibold tracking-wider">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 dark:bg-emerald-400 shadow-[0_0_6px_#10B981]" />
                  <span>Ready</span>
                </span>
              )}
            </div>
          </button>

          {/* Right Dock Controls: Vision, Screen & Waveform */}
          <div className="flex items-center gap-1.5 sm:gap-2 shrink-0 border-l border-slate-200 dark:border-[#202938] pl-2 sm:pl-3">
            {/* Vision Pill */}
            <button
              onClick={() => setShowVisionModal(true)}
              className={`px-2.5 py-1.5 sm:px-3 sm:py-2 rounded-xl text-xs font-mono transition flex items-center gap-1.5 cursor-pointer ${
                continuousScreenEnabled || isScreenSharing
                  ? "bg-emerald-50 dark:bg-emerald-500/15 border border-emerald-500/40 text-emerald-700 dark:text-emerald-300 font-semibold"
                  : "bg-white/80 dark:bg-[#111722]/80 border border-slate-200 dark:border-[#202938] text-slate-600 dark:text-[#8994A6] hover:text-slate-900 dark:hover:text-[#F4F7FB]"
              }`}
              title="Continuous Vision"
            >
              <Eye size={12} className={continuousScreenEnabled || isScreenSharing ? "text-emerald-500" : "text-slate-500 dark:text-[#8994A6]"} />
              <span className="hidden sm:inline">Vision</span>
            </button>

            {/* Screen Pill */}
            <button
              onClick={isScreenSharing ? stopScreenSharing : startScreenSharing}
              className={`px-2.5 py-1.5 sm:px-3 sm:py-2 rounded-xl text-xs font-mono transition flex items-center gap-1.5 cursor-pointer ${
                isScreenSharing
                  ? "bg-sky-50 dark:bg-[#00F0FF]/15 border border-sky-400 dark:border-[#00F0FF]/40 text-[#0284C7] dark:text-[#00F0FF] font-semibold"
                  : "bg-white/80 dark:bg-[#111722]/80 border border-slate-200 dark:border-[#202938] text-slate-600 dark:text-[#8994A6] hover:text-slate-900 dark:hover:text-[#F4F7FB]"
              }`}
              title="Share Screen"
            >
              <Monitor size={12} className={isScreenSharing ? "text-[#0284C7] dark:text-[#00F0FF] animate-pulse" : "text-slate-500 dark:text-[#8994A6]"} />
              <span className="hidden sm:inline">Screen</span>
            </button>

            {/* Minimalist Waveform visualizer */}
            <div className="hidden sm:flex items-center gap-0.5 h-6 w-10 justify-center pl-1">
              {[10, 20, 14, 24, 16, 8].map((baseH, idx) => {
                let factor = 0.3;
                if (state === "speaking") {
                  factor = 0.3 + Math.sin(Date.now() * 0.02 + idx * 0.9) * 0.7;
                } else if (state === "listening") {
                  factor = 0.2 + Math.sin(Date.now() * 0.01 + idx * 0.5) * 0.4;
                }
                const h = Math.max(3, baseH * factor);
                return (
                  <div
                    key={idx}
                    className={`w-0.5 rounded-full transition-all duration-200 ${
                      state === "speaking" ? "bg-[#8B5CF6]" : state === "listening" ? "bg-[#00F0FF]" : "bg-[#202938]"
                    }`}
                    style={{ height: `${h}px` }}
                  />
                );
              })}
            </div>
          </div>

        </div>

        {/* Floating Error or Reconnect Banner */}
        <AnimatePresence>
          {reconnectStatus && !errorText && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 10 }}
              className="neural-glass-subtle flex items-center gap-2 px-3 py-1.5 rounded-xl border border-amber-500/30 text-amber-300 text-xs font-mono"
            >
              <span className="animate-spin text-amber-400">↻</span>
              <span>Reconnecting {reconnectStatus}…</span>
            </motion.div>
          )}
          {errorText && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 10 }}
              className="neural-glass-elevated flex items-center justify-between gap-3 px-3.5 py-2 rounded-xl border border-rose-500/30 text-rose-300 text-xs font-mono max-w-lg w-full"
            >
              <div className="flex items-center gap-2 overflow-hidden">
                <CircleAlert size={14} className="text-rose-400 shrink-0" />
                <span className="truncate">{errorText}</span>
              </div>
              <button
                onClick={() => setErrorText(null)}
                className="text-rose-400 hover:text-white transition cursor-pointer"
              >
                Dismiss
              </button>
            </motion.div>
          )}
        </AnimatePresence>

      </footer>

      {/* Code Inspector Diff Modal */}
      <AnimatePresence>
        {showCodeDetails && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-md">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="neural-glass-elevated p-5 rounded-2xl max-w-lg w-full text-left shadow-2xl border border-[#202938]"
            >
              <div className="flex items-center justify-between pb-3 border-b border-[#202938]">
                <div className="flex items-center gap-2">
                  <Terminal size={16} className="text-[#00F0FF]" />
                  <h4 className="text-xs font-bold font-mono uppercase tracking-wider text-[#F4F7FB]">Workspace Code Inspector</h4>
                </div>
                <button onClick={() => setShowCodeDetails(false)} className="text-[#8994A6] hover:text-white cursor-pointer">
                  <X size={15} />
                </button>
              </div>
              <div className="mt-3 space-y-2 text-xs font-mono">
                <div className="text-[#8994A6]">Target: <span className="text-[#F4F7FB]">{lastCodeChange?.filePath || "frontend/App.tsx"}</span></div>
                <div className="text-[#8994A6]">Status: <span className="text-[#10B981] font-semibold">{lastCodeChange ? `${lastCodeChange.linesChanged} lines modified` : "Synchronized"}</span></div>
                {lastCodeChange?.previewSnippet && (
                  <pre className="mt-2 text-[11px] text-[#F4F7FB] bg-[#05070D]/90 p-3 rounded-xl overflow-x-auto max-h-48 border border-[#202938] leading-relaxed scrollbar-thin">
                    {lastCodeChange.previewSnippet}
                  </pre>
                )}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Holographic Website frame projections */}
      <AnimatePresence>
        {activeProjectorUrl && (
          <ErrorBoundary
            fallbackTitle="Browser Agent Recovered"
            onReset={() => {
              activeProjectorUrlRef.current = null;
              setActiveProjectorUrl(null);
              setBrowserTrigger(null);
            }}
          >
            <BrowserAgent
              url={activeProjectorUrl}
              onClose={() => {
                activeProjectorUrlRef.current = null;
                setActiveProjectorUrl(null);
                setBrowserTrigger(null);
              }}
              actionTrigger={browserTrigger}
            />
          </ErrorBoundary>
        )}
      </AnimatePresence>

      {/* Dynamic Floating Glassmorphic Screen Sharing Control Hub */}
      <AnimatePresence>
        {isScreenSharing && (
          <motion.div
            initial={{ opacity: 0, scale: 0.85, x: 50 }}
            animate={{ opacity: 1, scale: 1, x: 0 }}
            exit={{ opacity: 0, scale: 0.85, x: 50 }}
            className={`absolute bottom-6 md:bottom-10 right-6 md:right-10 z-50 w-72 p-4 rounded-2xl border ${
              isScreenSharingPaused 
                ? "border-amber-300 bg-white/95 text-slate-900 shadow-2xl dark:border-amber-500/20 dark:bg-slate-950/70 dark:text-slate-200" 
                : "border-sky-300 bg-white/95 text-slate-900 shadow-2xl dark:border-cyan-500/20 dark:bg-slate-950/70 dark:text-slate-200"
            } backdrop-blur-2xl shadow-2xl overflow-hidden`}
          >
            {/* Header / Indicator */}
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <div className={`w-2 h-2 rounded-full ${isScreenSharingPaused ? "bg-amber-500 dark:bg-amber-400" : "bg-sky-500 dark:bg-cyan-400 animate-pulse"}`} />
                <span className="text-[10px] font-bold font-mono tracking-widest text-slate-800 dark:text-slate-200">
                  {isScreenSharingPaused ? "SCREEN VISION PAUSED" : "SCREEN VISION ACTIVE"}
                </span>
              </div>
              <button 
                onClick={stopScreenSharing}
                className="text-slate-400 hover:text-slate-800 dark:hover:text-white transition-colors duration-150 p-1 rounded-lg hover:bg-slate-100 dark:hover:bg-white/5 cursor-pointer"
                title="Stop Sharing"
              >
                <X size={14} />
              </button>
            </div>

            {/* Smart Video PIP Preview Holder */}
            <div className="relative aspect-video w-full rounded-xl overflow-hidden bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-white/5 mb-3 flex items-center justify-center group select-none">
              <video
                ref={(el) => {
                  if (el && screenStreamRef.current && el.srcObject !== screenStreamRef.current) {
                    el.srcObject = screenStreamRef.current;
                    el.muted = true;
                    el.play().catch(err => console.log("Mini preview stream play issue:", err));
                  }
                }}
                className={`w-full h-full object-cover transition-opacity duration-300 ${
                  isScreenSharingPaused ? "opacity-30 blur-sm" : "opacity-90"
                }`}
                autoPlay
                playsInline
                muted
              />

              {isScreenSharingPaused && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <span className="text-[10px] uppercase tracking-widest font-mono text-amber-700 dark:text-amber-400 font-bold px-2 py-1 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-500/20 rounded-md">
                    Transmission Paused
                  </span>
                </div>
              )}
              
              {!isScreenSharingPaused && screenVisionMode && (
                <div className="absolute top-2 left-2 flex items-center gap-1.5 px-2 py-0.5 rounded bg-sky-100/90 dark:bg-cyan-950/50 border border-sky-300 dark:border-cyan-400/20 text-[9px] font-mono text-sky-800 dark:text-cyan-300">
                  <span className="w-1.5 h-1.5 bg-sky-500 dark:bg-cyan-400 rounded-full animate-ping" />
                  <span>Streaming FPS: 0.5</span>
                </div>
              )}
            </div>

            {/* Quick Action Control Strip */}
            <div className="flex items-center justify-between gap-1.5 mb-2.5">
              {isScreenSharingPaused ? (
                <button
                  onClick={resumeScreenSharing}
                  className="flex-1 py-1.5 px-2 bg-sky-50 hover:bg-sky-100 border border-sky-200 dark:bg-cyan-500/10 dark:hover:bg-cyan-500/20 dark:border-cyan-500/20 rounded-lg text-xs font-mono font-semibold text-sky-700 dark:text-cyan-300 flex items-center justify-center gap-1.5 transition-all cursor-pointer"
                  title="Resume Streaming Feed"
                >
                  <Play size={10} />
                  <span>Resume</span>
                </button>
              ) : (
                <button
                  onClick={pauseScreenSharing}
                  className="flex-1 py-1.5 px-2 bg-amber-50 hover:bg-amber-100 border border-amber-200 dark:bg-amber-500/10 dark:hover:bg-amber-500/20 dark:border-amber-500/20 rounded-lg text-xs font-mono font-semibold text-amber-700 dark:text-amber-300 flex items-center justify-center gap-1.5 transition-all cursor-pointer"
                  title="Pause Streaming Feed"
                >
                  <Pause size={10} />
                  <span>Pause</span>
                </button>
              )}

              <button
                onClick={switchScreenShare}
                className="py-1.5 px-2 bg-slate-100 hover:bg-slate-200 border border-slate-200 text-slate-700 hover:text-slate-900 dark:bg-white/5 dark:hover:bg-white/10 dark:border-white/10 dark:text-slate-300 dark:hover:text-white rounded-lg text-xs font-mono flex items-center justify-center gap-1 transition-all cursor-pointer"
                title="Choose Another Screen or Window"
              >
                <RefreshCw size={11} />
                <span>Switch</span>
              </button>

              <button
                onClick={stopScreenSharing}
                className="py-1.5 px-2 bg-rose-50 hover:bg-rose-100 border border-rose-200 text-rose-700 dark:bg-rose-500/10 dark:hover:bg-rose-500/20 dark:border-rose-500/20 dark:text-rose-400 rounded-lg text-xs font-mono flex items-center justify-center gap-1 transition-all cursor-pointer hover:scale-[1.02] active:scale-[0.98]"
                title="Terminate Stream"
              >
                <Square size={9} />
                <span>Stop</span>
              </button>
            </div>

            {/* Core Mode Configuration Toggle */}
            <div className="pt-2 border-t border-slate-200 dark:border-white/5 flex items-center justify-between text-left">
              <div className="flex flex-col">
                <span className="text-[10px] font-bold font-mono text-slate-800 dark:text-slate-200">SCREEN VISION MODE</span>
                <span className="text-[8px] text-slate-500 dark:text-slate-400 uppercase font-mono max-w-[150px]">Gemini Auto-Analysis</span>
              </div>
              <button
                onClick={() => setScreenVisionMode(!screenVisionMode)}
                className={`w-10 h-5 rounded-full p-0.5 transition-colors duration-200 focus:outline-none cursor-pointer ${
                  screenVisionMode ? "bg-sky-500 dark:bg-cyan-500" : "bg-slate-300 dark:bg-white/10"
                }`}
              >
                <div
                  className={`bg-white w-4 h-4 rounded-full shadow-md transform duration-200 ease-in-out ${
                    screenVisionMode ? "translate-x-5" : "translate-x-0"
                  }`}
                />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Recollections sliding core panel */}
      <ErrorBoundary fallbackTitle="Recollections Database Recovered">
        <MemoryDashboard
          isOpen={showMemoryDashboard}
          onClose={() => setShowMemoryDashboard(false)}
          memories={memories}
          onAddMemory={handleAddManualMemory}
          onDeleteMemory={handleDeleteMemory}
          onUpdateMemory={handleUpdateMemory}
          themeColor={themeColor}
        />
      </ErrorBoundary>

      {/* Phase 5B: Projects sliding core panel */}
      <ErrorBoundary fallbackTitle="Projects Dashboard Recovered">
        <ProjectsDashboard
          isOpen={showProjectsDashboard}
          onClose={() => setShowProjectsDashboard(false)}
          themeColor={themeColor}
        />
      </ErrorBoundary>

      {/* V2: Settings sliding core panel */}
      <ErrorBoundary fallbackTitle="Settings Panel Recovered">
        <SettingsPanel
          isOpen={showSettings}
          onClose={() => setShowSettings(false)}
          settings={settings}
          onChange={handleSettingsChange}
          themeColor={themeColor}
          remoteSession={remoteSession}
          onUnpair={handleUnpairDevice}
          onSessionUpdate={(updated) => setRemoteSession(updated)}
          memories={memories}
          onOpenMemoryDashboard={() => setShowMemoryDashboard(true)}
        />
      </ErrorBoundary>

      {/* Phase 4: Light Theme Chat Interface */}
      <ErrorBoundary fallbackTitle="Chat Interface Recovered">
        <ChatInterface
          isOpen={showChat}
          onClose={() => setShowChat(false)}
          messages={chatMessages}
          onClearMessages={() =>
            setChatMessages([
              {
                id: "greeting",
                role: "model",
                content: "Conversation cleared. How can I help you next?",
                timestamp: Date.now(),
              },
            ])
          }
          sessionState={state}
          characterState={characterState}
          onToggleVoice={handleToggleConnection}
          onSendMessage={(text, attachments) => handleSendTextMessage(undefined, text, attachments)}
          themeColor={themeColor}
          onOpenVision={() => setShowVisionModal(true)}
          onOpenMemory={() => setShowMemoryDashboard(true)}
        />
      </ErrorBoundary>

      {/* 11. Research Workspace Modal */}
      <ErrorBoundary fallbackTitle="Research Workspace Recovered">
        <ResearchWorkspace
          isOpen={showResearchWorkspace}
          onClose={() => setShowResearchWorkspace(false)}
          themeColor={themeColor}
        />
      </ErrorBoundary>

      {/* 12. Agent Workspace Modal */}
      <ErrorBoundary fallbackTitle="Agent Workspace Recovered">
        <AgentWorkspace
          isOpen={showAgentWorkspace}
          onClose={() => setShowAgentWorkspace(false)}
          themeColor={themeColor}
        />
      </ErrorBoundary>

      {/* 13. Vision Modal (Native Screen Share Controller) */}
      <ErrorBoundary fallbackTitle="Vision Modal Recovered">
        <VisionModal
          isOpen={showVisionModal}
          onClose={() => setShowVisionModal(false)}
          isScreenSharing={isScreenSharing}
          continuousScreenEnabled={continuousScreenEnabled}
          currentApp={liveContext.app || "Chrome"}
          onStartShare={async () => {
            setShowVisionModal(false);
            await startScreenSharing();
          }}
          onStopShare={() => {
            stopScreenSharing();
          }}
        />
      </ErrorBoundary>

      {/* Phase 9/10 Production UX Control Hub Modal */}
      <ErrorBoundary fallbackTitle="Production Control Hub Recovered">
        <ProductionControlHubModal
          isOpen={showControlHub}
          onClose={() => setShowControlHub(false)}
          defaultSurface="desktop"
        />
      </ErrorBoundary>

      {/* Cloud Remote Companion Authentication Modal for non-localhost hosts */}
      {isRemoteHost && (
        <CloudPairingModal
          isOpen={!remoteSession}
          onPairSuccess={(sess) => {
            setRemoteSession(sess);
            if (sessionRef.current) {
              sessionRef.current.setToken(sess.token || sess.accessToken || "");
            }
          }}
          onOpenControlHub={() => setShowControlHub(true)}
        />
      )}

      {/* 14. Project Decision Human Confirmation Modal (SEC-P3-R1.2-03 + SEC-P3-R1.3-01) */}
      <DecisionConfirmationModal
        data={pendingConfirmation}
        connectionError={confirmationError}
        onConfirm={(decisionId, projectId, token) => {
          const sent = Boolean(sessionRef.current?.confirmDecision(decisionId, projectId, token));
          const outcome = evaluateConfirmationActionSend("confirm", sent);
          if (!outcome.shouldCloseModal) {
            setConfirmationError(outcome.errorMessage);
            setErrorText(outcome.errorMessage);
            return;
          }
          setConfirmationError(null);
          setPendingConfirmation(null);
        }}
        onReject={(decisionId, projectId, token) => {
          const sent = Boolean(sessionRef.current?.rejectDecision(decisionId, projectId, token));
          const outcome = evaluateConfirmationActionSend("reject", sent);
          if (!outcome.shouldCloseModal) {
            setConfirmationError(outcome.errorMessage);
            setErrorText(outcome.errorMessage);
            return;
          }
          setConfirmationError(null);
          setPendingConfirmation(null);
        }}
        onDismiss={() => setPendingConfirmation(null)}
      />
    </div>
  );
}
