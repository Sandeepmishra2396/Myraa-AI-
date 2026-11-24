import React, { useEffect, useRef } from "react";
import { MyraAudioSession, LiveState } from "../lib/audio";
import { AvatarRenderer } from "./AvatarRenderer";

export type MyraaEmotion = 
  | "idle" 
  | "happy" 
  | "excited" 
  | "curious" 
  | "thinking" 
  | "proud" 
  | "sad" 
  | "confused" 
  | "surprised" 
  | "embarrassed" 
  | "playful";

interface MyraaCoreVisualizerProps {
  session: MyraAudioSession | null;
  state: LiveState;
  themeColor: string; // Violet, crimson, emerald, celestial, gold, rose, charcoal
  activeEmotion?: MyraaEmotion;
  characterState: "idle" | "thinking" | "talking";
  avatarMode?: "image" | "video" | "vrm";
  imageSrc?: string;
  isResearching?: boolean;
  hasError?: boolean;
  errorText?: string | null;
}

export const MyraaCoreVisualizer: React.FC<MyraaCoreVisualizerProps> = ({
  session,
  state,
  themeColor,
  activeEmotion = "idle",
  characterState,
  avatarMode = "video",
  imageSrc = "/assets/myraa-avatar.png",
  isResearching = false,
  hasError = false,
  errorText = null,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const animationRef = useRef<number | null>(null);
  const presenceRef = useRef<HTMLDivElement | null>(null);

  // Interaction and tracking references
  const mouseRef = useRef<{ x: number; y: number }>({ x: 0.5, y: 0.4 });
  const targetMouseRef = useRef<{ x: number; y: number }>({ x: 0.5, y: 0.4 });
  
  // Physics & Animation states
  const speechVolumeRef = useRef<number>(0);

  // Floating sci-fi background particle arrays
  const particlesRef = useRef<Array<{
    x: number;
    y: number;
    speed: number;
    size: number;
    opacity: number;
  }>>([]);

  // Cursor position tracking hook
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      targetMouseRef.current = {
        x: e.clientX / window.innerWidth,
        y: e.clientY / window.innerHeight,
      };
    };

    window.addEventListener("mousemove", handleMouseMove);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
    };
  }, []);

  // Theme matching mapping function (extremely beautiful cinematic color tones)
  const getGlowColors = () => {
    switch (themeColor) {
      case "violet":
        return { primary: "rgba(147, 51, 234, 1)", secondary: "rgba(192, 38, 211, 0.8)", glow: "rgba(168, 85, 247, 0.7)" };
      case "crimson":
        return { primary: "rgba(225, 29, 72, 1)", secondary: "rgba(234, 88, 12, 0.8)", glow: "rgba(244, 63, 94, 0.7)" };
      case "emerald":
        return { primary: "rgba(5, 150, 105, 1)", secondary: "rgba(13, 148, 136, 0.8)", glow: "rgba(16, 185, 129, 0.7)" };
      case "celestial":
        return { primary: "rgba(2, 132, 199, 1)", secondary: "rgba(8, 145, 178, 0.8)", glow: "rgba(14, 165, 233, 0.7)" };
      case "gold":
        return { primary: "rgba(202, 138, 4, 1)", secondary: "rgba(217, 119, 6, 0.8)", glow: "rgba(234, 179, 8, 0.7)" };
      case "rose":
        return { primary: "rgba(219, 39, 119, 1)", secondary: "rgba(220, 38, 38, 0.8)", glow: "rgba(236, 72, 153, 0.7)" };
      default:
        return { primary: "rgba(34, 211, 238, 1)", secondary: "rgba(79, 70, 229, 0.8)", glow: "rgba(6, 182, 212, 0.7)" };
    }
  };

  // Main high speed Canvas graphics rendering loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let width = canvas.width = canvas.offsetWidth;
    let height = canvas.height = canvas.offsetHeight;

    // Generate very slow, subtle background floating stardust particles (Item 15)
    const generateParticles = () => {
      const count = Math.min(18, Math.floor(width / 60));
      particlesRef.current = Array.from({ length: count }, () => ({
        x: Math.random() * width,
        y: Math.random() * height + height * 0.1,
        speed: Math.random() * 0.08 + 0.02,
        size: Math.random() * 1.2 + 0.4,
        opacity: Math.random() * 0.22 + 0.05,
      }));
    };

    generateParticles();

    const handleResize = () => {
      if (!canvas) return;
      width = canvas.width = canvas.offsetWidth;
      height = canvas.height = canvas.offsetHeight;
      generateParticles();
    };

    window.addEventListener("resize", handleResize);

    const render = () => {
      ctx.clearRect(0, 0, width, height);

      const systemTime = performance.now();
      const colors = getGlowColors();

      // Dynamic Audio analysis fetching from real voice session
      let audioLevel = 0;
      let bufferLength = 64;
      const dataArray = new Uint8Array(bufferLength);
      let activeAnalyser = null;

      if (state === "speaking" && session?.outputAnalyser) {
        activeAnalyser = session.outputAnalyser;
      } else if (state === "listening" && session?.inputAnalyser) {
        activeAnalyser = session.inputAnalyser;
      }

      if (activeAnalyser) {
        try {
          activeAnalyser.getByteFrequencyData(dataArray);
          let sum = 0;
          for (let i = 0; i < bufferLength; i++) {
            sum += dataArray[i];
          }
          audioLevel = sum / bufferLength; // 0 to 255
        } catch (e) {}
      }

      // Smooth amplitude tracking for real-time particle excitation
      speechVolumeRef.current += (audioLevel / 255 - speechVolumeRef.current) * 0.2;

      // Update live CSS audio level on avatar presence container
      if (presenceRef.current) {
        presenceRef.current.style.setProperty("--audio-level", speechVolumeRef.current.toFixed(3));
      }

      // Cinematic ambient stardust sizing
      const baseScale = height / 440;
      const s = Math.max(0.95, Math.min(1.85, baseScale)); // scale multiplier

      // Smooth cursor mouse tracking lag
      mouseRef.current.x += (targetMouseRef.current.x - mouseRef.current.x) * 0.05;
      mouseRef.current.y += (targetMouseRef.current.y - mouseRef.current.y) * 0.05;

      const centerX = width / 2;

      // ==========================================
      // 1. DRAW GRAND STAGE VOLUMETRIC PROJECTOR BEAM (Cinematic Glow Backlight)
      // ==========================================
      ctx.save();
      const projectorCenterY = height + 40;
      const baseDiameterX = 280 * s;

      // Volumetric light beams shooting up from projector base
      const conicalBeamGrad = ctx.createLinearGradient(centerX, height * 0.25, centerX, height);
      conicalBeamGrad.addColorStop(0, "rgba(0,0,0,0)");
      conicalBeamGrad.addColorStop(0.4, colors.primary.replace("1)", "0.03)"));
      conicalBeamGrad.addColorStop(0.75, colors.primary.replace("1)", "0.08)"));
      conicalBeamGrad.addColorStop(1, colors.secondary.replace("0.8)", "0.18)"));

      ctx.fillStyle = conicalBeamGrad;
      ctx.beginPath();
      ctx.moveTo(centerX - baseDiameterX * 0.35, projectorCenterY - 145);
      ctx.lineTo(centerX + baseDiameterX * 0.35, projectorCenterY - 145);
      ctx.lineTo(centerX + baseDiameterX * 1.5, height);
      ctx.lineTo(centerX - baseDiameterX * 1.5, height);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      // ==========================================
      // 2. MINIMALIST ATMOSPHERE NEURAL FIELDS (SUBTLE GLITCH)
      // ==========================================
      const applyGlitch = (state === "connecting" && Math.random() < 0.1) || (Math.random() < 0.005);
      if (applyGlitch) {
        ctx.save();
        ctx.translate((Math.random() - 0.5) * 6, (Math.random() - 0.5) * 2);
        ctx.fillStyle = Math.random() < 0.5 ? "rgba(236,72,153,0.03)" : "rgba(34,211,238,0.03)";
        ctx.fillRect(0, 0, width, height);
      }

      // ==========================================
      // 3. UPDATE AND DRAW HOLOGRAM NEURAL PARTICLES RISING (Cinematic Stardust)
      // ==========================================
      particlesRef.current.forEach((p) => {
        const riseSpeed = p.speed * (1 + speechVolumeRef.current * 1.8);
        p.y -= riseSpeed;
        
        // Horizontal drift sway
        p.x += Math.sin(p.y * 0.015 + p.size) * 0.4;
        
        // Transparency matches base lift height
        const currentOpacity = p.opacity * Math.max(0, p.y / height);

        // Recirculate particle if it reaches up too high near her crown
        if (p.y < height * 0.12) {
          p.y = height + Math.random() * 30;
          p.x = Math.random() * width;
        }

        ctx.fillStyle = colors.primary.replace("1)", `${currentOpacity * 0.45})`);
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * s, 0, Math.PI * 2);
        ctx.fill();
      });

      if (applyGlitch) {
        ctx.restore();
      }

      animationRef.current = requestAnimationFrame(render);
    };

    render();

    return () => {
      window.removeEventListener("resize", handleResize);
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [session, state, themeColor, activeEmotion, characterState]);

  // Dynamic presence aura based on voice and character state
  const getPresenceAura = () => {
    if (state === "speaking") {
      return {
        outer: "bg-purple-600/25",
        gradient: "from-purple-600/35 to-violet-600/10",
      };
    }
    if (state === "listening") {
      if (characterState === "thinking") {
        return {
          outer: "bg-blue-600/25",
          gradient: "from-blue-600/30 to-sky-600/10",
        };
      }
      return {
        outer: "bg-cyan-500/25",
        gradient: "from-cyan-500/30 to-blue-600/10",
      };
    }
    if (state === "connecting") {
      return {
        outer: "bg-amber-500/20",
        gradient: "from-amber-500/25 to-yellow-600/10",
      };
    }
    return {
      outer: "bg-indigo-600/15",
      gradient: "from-indigo-600/20 to-cyan-600/05",
    };
  };

  return (
    <div className="relative w-full h-full flex items-center justify-center overflow-hidden">
      {/* 1. Behind Overlay / Atmospheric Backlight Glow (Z-index 0) */}
      <div className="absolute inset-0 bg-transparent flex items-center justify-center pointer-events-none z-0">
        <div className={`w-[500px] h-[500px] rounded-full blur-[140px] opacity-25 bg-gradient-to-tr transition-all duration-1000 ${
          getPresenceAura().gradient
        }`} />
      </div>

      {/* 2. Modular Character Presence Renderer (Z-index 10) */}
      <div 
        id="myraa-animated-presence"
        ref={presenceRef}
        className="absolute z-10 w-full h-full flex items-center justify-center pointer-events-auto transition-all duration-700"
      >
        {/* ================================================================ */}
        {/* AVATAR STAGE: 16:9 landscape frame fills full center area       */}
        {/* Avatar image is centered+contained; video/vrm use aspect frame  */}
        {/* ================================================================ */}
        <div className={`relative ${
          avatarMode === "image"
            ? "w-full h-full"
            : "w-full max-w-full max-h-full aspect-[16/9] flex items-center justify-center"
        } select-none pointer-events-none`}>
          {/* Ambient glow aura behind avatar */}
          <div className={`absolute inset-0 blur-[30px] opacity-20 pointer-events-none mix-blend-screen transition-all duration-700 ${
            avatarMode !== "image" ? "rounded-[2rem]" : ""
          } ${getPresenceAura().outer}`} />

          {/* Subtle Cyan / Blue Holographic Aura behind character (Light & Dark theme compatible) */}
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="w-[85%] h-[85%] rounded-full blur-[45px] opacity-40 bg-gradient-to-tr from-cyan-400/40 via-sky-400/30 to-blue-500/25 pointer-events-none" />
          </div>

          {/* Modular Avatar Renderer (Living Interface States) */}
          <AvatarRenderer
            characterState={characterState}
            liveState={state}
            activeEmotion={activeEmotion}
            themeColor={themeColor}
            session={session}
            mouseNorm={mouseRef.current}
            avatarMode={avatarMode}
            imageSrc={imageSrc}
            isResearching={isResearching}
            hasError={hasError}
            errorText={errorText}
          />

          {/* Faint cybernetic visual edge grid guard (video/vrm frame only) */}
          {avatarMode !== "image" && (
            <div className="absolute inset-0 rounded-[2rem] border border-cyan-400/10 pointer-events-none" />
          )}
        </div>
      </div>

      {/* 3. Foreground Hover-Responsive Canvas for glowing particles (Holographic Overlay Z-index 20) */}
      <canvas
        id="myraa-hologram-living-canvas"
        ref={canvasRef}
        className="absolute inset-0 w-full h-full pointer-events-none z-20"
      />
    </div>
  );
};
