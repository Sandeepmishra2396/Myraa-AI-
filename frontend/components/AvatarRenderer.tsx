import React, { useMemo, useState, useRef, useEffect } from "react";
import { MyraaEmotion } from "./MyraaCoreVisualizer";
import { Avatar3DRenderer } from "./avatar3d/Avatar3DRenderer";
import { VRMCapabilities } from "./avatar3d/VRMLoader";
import { MyraAudioSession, LiveState } from "../lib/audio";

export interface AvatarRendererProps {
  characterState: "idle" | "thinking" | "talking" | "sitting" | "walking";
  liveState?: LiveState;
  activeEmotion?: MyraaEmotion;
  themeColor: string;
  session?: MyraAudioSession | null;
  mouseNorm?: { x: number; y: number };
  avatarMode?: "video" | "vrm";
  isFloatingMode?: boolean;
  enableChromaKey?: boolean;
}

export const AvatarRenderer: React.FC<AvatarRendererProps> = ({
  characterState,
  liveState = "disconnected",
  activeEmotion = "idle",
  themeColor,
  session = null,
  mouseNorm = { x: 0.5, y: 0.4 },
  avatarMode = "video",
  isFloatingMode = false,
  enableChromaKey = false,
}) => {
  // Video element refs for MP4 playback
  const idleVideoRef = useRef<HTMLVideoElement | null>(null);
  const thinkingVideoRef = useRef<HTMLVideoElement | null>(null);
  const talkingVideoRef = useRef<HTMLVideoElement | null>(null);
  const [videoError, setVideoError] = useState<boolean>(false);

  // 3D state for VRM mode
  const [is3DLoaded, setIs3DLoaded] = useState(false);
  const [has3DError, setHas3DError] = useState(false);

  // Theme color definitions for ambient aura and particle glows
  const themeStyles = useMemo(() => {
    switch (themeColor) {
      case "violet":
        return {
          glow: "rgba(168, 85, 247, 0.4)",
          accent: "#c084fc",
          ring: "border-purple-500/40",
          aura: "from-purple-600/30 via-fuchsia-500/20 to-transparent",
        };
      case "crimson":
        return {
          glow: "rgba(244, 63, 94, 0.4)",
          accent: "#fb7185",
          ring: "border-rose-500/40",
          aura: "from-rose-600/30 via-orange-500/20 to-transparent",
        };
      case "emerald":
        return {
          glow: "rgba(16, 185, 129, 0.4)",
          accent: "#34d399",
          ring: "border-emerald-500/40",
          aura: "from-emerald-600/30 via-teal-500/20 to-transparent",
        };
      case "celestial":
        return {
          glow: "rgba(14, 165, 233, 0.4)",
          accent: "#38bdf8",
          ring: "border-sky-500/40",
          aura: "from-sky-600/30 via-cyan-500/20 to-transparent",
        };
      case "gold":
        return {
          glow: "rgba(234, 179, 8, 0.4)",
          accent: "#facc15",
          ring: "border-amber-500/40",
          aura: "from-amber-600/30 via-yellow-500/20 to-transparent",
        };
      case "rose":
        return {
          glow: "rgba(236, 72, 153, 0.4)",
          accent: "#f472b6",
          ring: "border-pink-500/40",
          aura: "from-pink-600/30 via-rose-500/20 to-transparent",
        };
      default:
        return {
          glow: "rgba(99, 102, 241, 0.4)",
          accent: "#818cf8",
          ring: "border-indigo-500/40",
          aura: "from-indigo-600/30 via-cyan-500/20 to-transparent",
        };
    }
  }, [themeColor]);

  // Mask style matching original aesthetic (or tailored for floating mode)
  const maskStyle: React.CSSProperties = useMemo(() => {
    if (isFloatingMode) {
      return {
        maskImage: "radial-gradient(ellipse at 50% 50%, rgba(0,0,0,1) 50%, rgba(0,0,0,0) 78%)",
        WebkitMaskImage: "radial-gradient(ellipse at 50% 50%, rgba(0,0,0,1) 50%, rgba(0,0,0,0) 78%)",
      };
    }
    return {
      maskImage: "radial-gradient(circle, rgba(0,0,0,1) 55%, rgba(0,0,0,0) 80%)",
      WebkitMaskImage: "radial-gradient(circle, rgba(0,0,0,1) 55%, rgba(0,0,0,0) 80%)",
    };
  }, [isFloatingMode]);

  const chromaCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // Real-time canvas chroma processor when enableChromaKey is toggled ON
  useEffect(() => {
    if (!enableChromaKey || avatarMode !== "video") return;

    const canvas = chromaCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;

    let animId: number;

    const getActiveVideo = () => {
      if (characterState === "talking") return talkingVideoRef.current;
      if (characterState === "thinking") return thinkingVideoRef.current;
      return idleVideoRef.current;
    };

    const processFrame = () => {
      const activeVideo = getActiveVideo();
      if (activeVideo && activeVideo.readyState >= 2 && !activeVideo.paused) {
        const w = 480;
        const h = Math.round(w * (activeVideo.videoHeight / activeVideo.videoWidth || 0.57));
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
        }

        ctx.drawImage(activeVideo, 0, 0, w, h);
        const frame = ctx.getImageData(0, 0, w, h);
        const data = frame.data;
        const total = data.length;

        // Chroma key targeting the slate-blue vignette background [26, 34, 53]
        for (let i = 0; i < total; i += 4) {
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];

          const dist = Math.sqrt((r - 26) ** 2 + (g - 34) ** 2 + (b - 53) ** 2);

          if (dist < 20) {
            data[i + 3] = 0;
          } else if (dist < 36) {
            const alpha = (dist - 20) / 16;
            data[i + 3] = Math.round(data[i + 3] * alpha);
          }
        }
        ctx.putImageData(frame, 0, 0);
      }
      animId = requestAnimationFrame(processFrame);
    };

    animId = requestAnimationFrame(processFrame);
    return () => cancelAnimationFrame(animId);
  }, [enableChromaKey, characterState, avatarMode]);

  // Safe reference to audio output analyser for VRM lip-sync
  const audioAnalyser = session?.outputAnalyser || null;

  // Synchronized video playback manager for MP4 mode
  useEffect(() => {
    if (avatarMode !== "video") return;

    const playVideo = (videoEl: HTMLVideoElement | null) => {
      if (!videoEl) return;
      try {
        videoEl.currentTime = 0;
        const playPromise = videoEl.play();
        if (playPromise !== undefined) {
          playPromise.catch((error: any) => {
            // AbortError occurs naturally when pause() interrupts play() during fast state switches
            if (error?.name === "AbortError") {
              return;
            }
            console.warn("[AvatarRenderer] Video play failed:", error);
          });
        }
      } catch (err) {}
    };

    const pauseVideo = (videoEl: HTMLVideoElement | null) => {
      if (!videoEl) return;
      try {
        if (!videoEl.paused) {
          videoEl.pause();
        }
      } catch (err) {}
    };

    if (characterState === "idle" || characterState === "sitting" || characterState === "walking") {
      playVideo(idleVideoRef.current);
      pauseVideo(thinkingVideoRef.current);
      pauseVideo(talkingVideoRef.current);
    } else if (characterState === "thinking") {
      playVideo(thinkingVideoRef.current);
      pauseVideo(idleVideoRef.current);
      pauseVideo(talkingVideoRef.current);
    } else if (characterState === "talking") {
      playVideo(talkingVideoRef.current);
      pauseVideo(idleVideoRef.current);
      pauseVideo(thinkingVideoRef.current);
    }
  }, [characterState, avatarMode]);

  const handleVideoError = (videoName: string) => {
    console.warn(`[AvatarRenderer] Failed to load video source for: ${videoName}`);
    setVideoError(true);
  };

  const handle3DSuccess = (capabilities: VRMCapabilities) => {
    console.log("[AvatarRenderer] 3D VRM Avatar initialized:", capabilities);
    setIs3DLoaded(true);
    setHas3DError(false);
  };

  const handle3DError = (error: Error) => {
    console.info("[AvatarRenderer] 3D model unavailable, using 2D fallback:", error.message);
    setIs3DLoaded(false);
    setHas3DError(true);
  };

  return (
    <div className="relative w-full h-full flex items-center justify-center select-none">
      {/* 1. Behind Avatar: Live Voice-Reactive Audio Aura */}
      <div
        className={`absolute rounded-full blur-[60px] pointer-events-none bg-gradient-to-tr ${themeStyles.aura} transition-all duration-150`}
        style={{
          width: "280px",
          height: "280px",
          opacity: characterState === "talking" ? "calc(0.3 + var(--audio-level, 0) * 0.6)" : "0.2",
          transform: characterState === "talking" ? "scale(calc(1 + var(--audio-level, 0) * 0.35))" : "scale(1)",
        }}
      />

      {/* 2. Thinking State: Holographic Neural Rings */}
      {characterState === "thinking" && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10 animate-fade-in">
          {/* Outer Pulsing Ring */}
          <div
            className={`absolute w-72 h-72 sm:w-96 sm:h-96 rounded-full border border-dashed ${themeStyles.ring} animate-spin-slow opacity-60`}
          />
          {/* Inner Resonant Ring */}
          <div
            className="absolute w-56 h-56 sm:w-72 sm:h-72 rounded-full border border-cyan-400/30 animate-pulse-ring"
          />
          {/* Concentric Halo */}
          <div
            className="absolute w-40 h-40 rounded-full bg-cyan-400/10 blur-xl animate-pulse"
          />
        </div>
      )}

      {/* 3. Talking State: Live Audio Waveform Rings */}
      {characterState === "talking" && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
          <div
            className="absolute rounded-full border border-indigo-400/30 transition-all duration-100"
            style={{
              width: "calc(240px + var(--audio-level, 0) * 140px)",
              height: "calc(240px + var(--audio-level, 0) * 140px)",
              opacity: "calc(var(--audio-level, 0) * 1.5)",
            }}
          />
          <div
            className="absolute rounded-full border border-cyan-400/20 transition-all duration-150"
            style={{
              width: "calc(290px + var(--audio-level, 0) * 180px)",
              height: "calc(290px + var(--audio-level, 0) * 180px)",
              opacity: "calc(var(--audio-level, 0) * 1.2)",
            }}
          />
        </div>
      )}

      {/* ================================================================ */}
      {/* 4. ACTIVE AVATAR: MP4 Video Mode (Primary Default)                */}
      {/* ================================================================ */}
      {avatarMode === "video" && !videoError && (
        <div
          className="relative w-full h-full flex items-center justify-center transition-transform duration-100 ease-out"
          style={{
            transform:
              characterState === "talking"
                ? "scale(calc(1 + var(--audio-level, 0) * 0.03)) translateY(calc(var(--audio-level, 0) * -6px))"
                : "scale(1) translateY(0px)",
          }}
        >
          {/* Optional Canvas Chroma-Key Render Layer (Active when enableChromaKey is true) */}
          {enableChromaKey && (
            <canvas
              ref={chromaCanvasRef}
              className="absolute inset-0 w-full h-full object-contain pointer-events-none z-15 rounded-[2.5rem]"
              style={maskStyle}
            />
          )}

          {/* IDLE VIDEO */}
          <video
            ref={idleVideoRef}
            src="/assets/idle.mp4"
            loop
            muted
            playsInline
            autoPlay
            className={`absolute inset-0 w-full h-full object-cover rounded-[2.5rem] transition-opacity duration-700 ease-in-out ${
              enableChromaKey
                ? "opacity-0 pointer-events-none"
                : characterState === "idle" || characterState === "sitting" || characterState === "walking"
                ? "opacity-100 z-10 animate-fade-in"
                : "opacity-0 z-0 pointer-events-none"
            }`}
            style={maskStyle}
            onError={() => handleVideoError("idle")}
          />

          {/* THINKING VIDEO */}
          <video
            ref={thinkingVideoRef}
            src="/assets/thinking.mp4"
            loop
            muted
            playsInline
            className={`absolute inset-0 w-full h-full object-cover rounded-[2.5rem] transition-opacity duration-700 ease-in-out ${
              enableChromaKey
                ? "opacity-0 pointer-events-none"
                : characterState === "thinking"
                ? "opacity-100 z-10 animate-fade-in"
                : "opacity-0 z-0 pointer-events-none"
            }`}
            style={maskStyle}
            onError={() => handleVideoError("thinking")}
          />

          {/* TALKING VIDEO */}
          <video
            ref={talkingVideoRef}
            src="/assets/talking.mp4"
            loop
            muted
            playsInline
            className={`absolute inset-0 w-full h-full object-cover rounded-[2.5rem] transition-opacity duration-700 ease-in-out ${
              enableChromaKey
                ? "opacity-0 pointer-events-none"
                : characterState === "talking"
                ? "opacity-100 z-10 animate-fade-in"
                : "opacity-0 z-0 pointer-events-none"
            }`}
            style={maskStyle}
            onError={() => handleVideoError("talking")}
          />
        </div>
      )}

      {/* ================================================================ */}
      {/* 5. 3D VRM Avatar Mode (Available for future replacement testing) */}
      {/* ================================================================ */}
      {avatarMode === "vrm" && (
        <div
          className={`absolute inset-0 z-20 transition-opacity duration-700 ease-in-out ${
            is3DLoaded ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
          }`}
          style={maskStyle}
        >
          <Avatar3DRenderer
            modelUrl="/models/myraa.vrm"
            characterState={characterState}
            liveState={liveState}
            activeEmotion={activeEmotion}
            themeColor={themeColor}
            audioAnalyser={audioAnalyser}
            mouseNorm={mouseNorm}
            onLoadSuccess={handle3DSuccess}
            onLoadError={handle3DError}
          />
        </div>
      )}

      {/* ================================================================ */}
      {/* 6. FALLBACK LAYER: 2D PNG Avatar                                 */}
      {/*    Active if videoError is true or when 3D is still loading      */}
      {/* ================================================================ */}
      {((avatarMode === "video" && videoError) || (avatarMode === "vrm" && !is3DLoaded)) && (
        <div
          className="relative w-full h-full flex items-center justify-center transition-all duration-700 ease-in-out pointer-events-none z-15"
          style={{
            transform:
              characterState === "talking"
                ? "scale(calc(1 + var(--audio-level, 0) * 0.03)) translateY(calc(var(--audio-level, 0) * -6px))"
                : "scale(1) translateY(0px)",
          }}
        >
          {/* IDLE 2D LAYER */}
          <div
            className={`absolute inset-0 flex items-center justify-center transition-opacity duration-500 ease-in-out ${
              characterState === "idle" || characterState === "sitting" || characterState === "walking"
                ? "opacity-100 z-20 animate-breathe"
                : "opacity-0 z-10 pointer-events-none"
            }`}
          >
            <img
              src="/assets/avatar_idle.png"
              alt="Myraa Idle"
              className="w-full h-full object-cover rounded-[2.5rem]"
              style={maskStyle}
              draggable={false}
            />
          </div>

          {/* THINKING 2D LAYER */}
          <div
            className={`absolute inset-0 flex items-center justify-center transition-opacity duration-500 ease-in-out ${
              characterState === "thinking" ? "opacity-100 z-20" : "opacity-0 z-10 pointer-events-none"
            }`}
          >
            <img
              src="/assets/avatar_thinking.png"
              alt="Myraa Thinking"
              className="w-full h-full object-cover rounded-[2.5rem]"
              style={maskStyle}
              draggable={false}
            />
          </div>

          {/* TALKING 2D LAYER */}
          <div
            className={`absolute inset-0 flex items-center justify-center transition-opacity duration-300 ease-in-out ${
              characterState === "talking" ? "opacity-100 z-20" : "opacity-0 z-10 pointer-events-none"
            }`}
          >
            <img
              src="/assets/avatar_talking.png"
              alt="Myraa Talking"
              className="w-full h-full object-cover rounded-[2.5rem]"
              style={maskStyle}
              draggable={false}
            />
          </div>
        </div>
      )}
    </div>
  );
};
