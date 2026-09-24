import React, { useState, useEffect, useRef, useCallback } from "react";
import { AvatarRenderer } from "./AvatarRenderer";
import { LiveState } from "../lib/audio";
import { MyraaEmotion } from "./MyraaCoreVisualizer";
import { Mic, Power, Volume2, Maximize2, X, Sparkles } from "lucide-react";

// Electron window.myraa interface definition
declare global {
  interface Window {
    myraa?: {
      isDesktop?: boolean;
      platform?: string;
      version?: string;
      openFloating?: () => void;
      closeFloating?: () => void;
      toggleFloating?: () => void;
      focusMain?: () => void;
      moveFloatingWindow?: (dx: number, dy: number) => void;
      setAlwaysOnTop?: (val: boolean) => void;
      syncFloatingState?: (state: any) => void;
      requestFloatingState?: () => void;
      onFloatingState?: (callback: (state: any) => void) => () => void;
      onFloatingStateRequest?: (callback: () => void) => () => void;
      toggleMic?: () => void;
      onToggleMic?: (callback: () => void) => () => void;
      showFloatingContextMenu?: (options: any) => void;
      onFloatingSetting?: (callback: (setting: any) => void) => () => void;
    };
  }
}

export const FloatingAvatarApp: React.FC = () => {
  const [characterState, setCharacterState] = useState<"idle" | "thinking" | "talking">("idle");
  const [liveState, setLiveState] = useState<LiveState>("disconnected");
  const [activeEmotion, setActiveEmotion] = useState<MyraaEmotion>("idle");
  const [themeColor, setThemeColor] = useState<string>("charcoal");
  const [, setAudioLevel] = useState<number>(0);
  const [, setAlwaysOnTop] = useState<boolean>(true);
  const [transparentBackground, setTransparentBackground] = useState<boolean>(false);
  const [isHovered, setIsHovered] = useState<boolean>(false);

  // Mouse drag tracking for smooth high-DPI movement
  const isDraggingRef = useRef(false);
  const lastMousePosRef = useRef({ x: 0, y: 0 });

  // Subscribe to state updates from the authoritative Main Window via IPC
  useEffect(() => {
    // Make sure html and body have transparent backgrounds
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";

    if (!window.myraa?.onFloatingState) return;

    const cleanupState = window.myraa.onFloatingState((state) => {
      if (!state) return;
      if (state.characterState) setCharacterState(state.characterState);
      if (state.liveState) setLiveState(state.liveState);
      if (state.activeEmotion) setActiveEmotion(state.activeEmotion);
      if (state.themeColor) setThemeColor(state.themeColor);
      if (typeof state.audioLevel === "number") setAudioLevel(state.audioLevel);
    });

    const cleanupSettings = window.myraa.onFloatingSetting?.((setting) => {
      if (!setting) return;
      if (typeof setting.alwaysOnTop === "boolean") {
        setAlwaysOnTop(setting.alwaysOnTop);
      }
      if (typeof setting.transparentBackground === "boolean") {
        setTransparentBackground(setting.transparentBackground);
      }
    });

    // Request latest state immediately on mount
    window.myraa.requestFloatingState?.();

    return () => {
      cleanupState?.();
      cleanupSettings?.();
    };
  }, []);

  // Window drag handlers (combines native -webkit-app-region with delta fallback)
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return; // only left click drags
    isDraggingRef.current = true;
    lastMousePosRef.current = { x: e.screenX, y: e.screenY };
  }, []);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current) return;
      const dx = e.screenX - lastMousePosRef.current.x;
      const dy = e.screenY - lastMousePosRef.current.y;
      lastMousePosRef.current = { x: e.screenX, y: e.screenY };

      if (Math.abs(dx) > 0 || Math.abs(dy) > 0) {
        window.myraa?.moveFloatingWindow?.(dx, dy);
      }
    };

    const handleMouseUp = () => {
      isDraggingRef.current = false;
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  // Double click avatar focuses the main MYRAA app
  const handleDoubleClick = () => {
    window.myraa?.focusMain?.();
  };

  // Right-click opens native context menu
  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    window.myraa?.showFloatingContextMenu?.({
      transparentBackground,
    });
  };

  // Toggle mic action relays to main window
  const handleToggleMic = () => {
    window.myraa?.toggleMic?.();
  };

  const toggleBackgroundRemoval = () => {
    setTransparentBackground((prev) => !prev);
  };

  return (
    <div
      className="relative w-screen h-screen overflow-hidden bg-transparent select-none flex flex-col items-center justify-between p-2"
      style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      onMouseDown={handleMouseDown}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* 1. Subtle Radial Background Atmosphere behind avatar (Only in feathered mode) */}
      {!transparentBackground && (
        <div className="absolute inset-2 rounded-full blur-2xl opacity-20 pointer-events-none bg-indigo-600/30" />
      )}

      {/* 2. AVATAR STAGE */}
      <div className="relative w-full flex-1 flex items-center justify-center pointer-events-none">
        <div className="w-[280px] h-[310px] relative flex items-center justify-center">
          <AvatarRenderer
            characterState={characterState}
            liveState={liveState}
            activeEmotion={activeEmotion}
            themeColor={themeColor}
            isFloatingMode={true}
            enableChromaKey={transparentBackground}
          />
        </div>
      </div>

      {/* 3. MINIMALIST FLOATING GLASS PILL HUD (Bottom Controls) */}
      <div
        className={`relative z-30 transition-all duration-300 flex items-center gap-2 px-3 py-1.5 rounded-full border border-white/10 bg-slate-950/75 backdrop-blur-xl shadow-lg ${
          isHovered || liveState !== "disconnected" ? "opacity-95 translate-y-0" : "opacity-35 translate-y-1"
        }`}
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        onMouseDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        {/* Mic / Connection Toggle */}
        <button
          onClick={handleToggleMic}
          className={`w-7 h-7 rounded-full flex items-center justify-center transition-all cursor-pointer ${
            liveState === "disconnected"
              ? "bg-white/10 hover:bg-white/20 text-white/70"
              : liveState === "listening"
              ? "bg-cyan-500/25 border border-cyan-400/80 text-cyan-300 shadow-[0_0_15px_rgba(34,211,238,0.4)] animate-pulse"
              : liveState === "speaking"
              ? "bg-purple-500/80 hover:bg-purple-600 text-white shadow-[0_0_15px_rgba(168,85,247,0.5)]"
              : "bg-amber-600 text-white animate-spin"
          }`}
          title={
            liveState === "disconnected"
              ? "Awake Myraa Voice"
              : liveState === "listening"
              ? "Listening (Click to sleep)"
              : "Speaking"
          }
        >
          {liveState === "disconnected" ? (
            <Power size={13} />
          ) : liveState === "connecting" ? (
            <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
          ) : liveState === "listening" ? (
            <Mic size={13} />
          ) : (
            <Volume2 size={13} />
          )}
        </button>

        {/* State Label */}
        <span className="text-[10px] font-mono tracking-wider uppercase text-white/70 px-1 font-semibold">
          {characterState === "talking"
            ? "TALKING"
            : characterState === "thinking"
            ? "THINKING"
            : liveState === "listening"
            ? "LISTENING"
            : "IDLE"}
        </span>

        {/* Transparent Background Toggle Button */}
        <button
          onClick={toggleBackgroundRemoval}
          className={`p-1.5 rounded-full transition cursor-pointer ${
            transparentBackground
              ? "text-cyan-400 bg-cyan-500/20 hover:bg-cyan-500/30"
              : "text-white/40 hover:text-white/80 hover:bg-white/10"
          }`}
          title={
            transparentBackground
              ? "Transparent Background: ON (Chroma Key)"
              : "Transparent Background: OFF (Feathered Mask)"
          }
        >
          <Sparkles size={12} />
        </button>

        {/* Open Main Window */}
        <button
          onClick={() => window.myraa?.focusMain?.()}
          className="p-1.5 rounded-full text-white/40 hover:text-white/80 hover:bg-white/10 transition cursor-pointer"
          title="Open Full MYRAA Application"
        >
          <Maximize2 size={12} />
        </button>

        {/* Close/Hide Floating Window */}
        <button
          onClick={() => window.myraa?.closeFloating?.()}
          className="p-1.5 rounded-full text-white/40 hover:text-rose-400 hover:bg-rose-500/10 transition cursor-pointer"
          title="Hide Floating Avatar"
        >
          <X size={12} />
        </button>
      </div>
    </div>
  );
};
export default FloatingAvatarApp;
