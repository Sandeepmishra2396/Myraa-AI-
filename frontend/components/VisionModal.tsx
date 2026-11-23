import React, { useRef, useEffect } from "react";
import { Eye, EyeOff, X, Monitor, CheckCircle2, Shield, RefreshCw } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

interface VisionModalProps {
  isOpen: boolean;
  onClose: () => void;
  isScreenSharing: boolean;
  continuousScreenEnabled: boolean;
  currentApp?: string;
  onStartShare: () => Promise<void> | void;
  onStopShare: () => void;
  videoRef?: React.RefObject<HTMLVideoElement | null>;
}

export function VisionModal({
  isOpen,
  onClose,
  isScreenSharing,
  continuousScreenEnabled,
  currentApp = "Chrome",
  onStartShare,
  onStopShare,
  videoRef,
}: VisionModalProps) {
  const modalRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (modalRef.current && !modalRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen, onClose]);

  const isLive = isScreenSharing || continuousScreenEnabled;

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <motion.div
            ref={modalRef}
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            transition={{ type: "spring", damping: 25, stiffness: 250 }}
            className="w-full max-w-sm rounded-2xl bg-[#0B0F17]/95 border border-[#202938] text-[#F4F7FB] p-5 shadow-2xl space-y-4 backdrop-blur-2xl"
          >
            {/* Header: VISION */}
            <div className="flex items-center justify-between pb-3 border-b border-[#202938]">
              <div className="flex items-center gap-2.5">
                <div className={`p-2 rounded-xl border ${isLive ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400" : "border-[#00F0FF]/30 bg-[#00F0FF]/10 text-[#00F0FF]"}`}>
                  <Eye size={16} className={isLive ? "animate-pulse" : ""} />
                </div>
                <div>
                  <h3 className="font-display font-bold text-sm tracking-[0.2em] text-[#F4F7FB] uppercase">
                    VISION
                  </h3>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <span
                      className={`w-1.5 h-1.5 rounded-full ${
                        isLive
                          ? "bg-emerald-400 shadow-[0_0_8px_#10B981] animate-pulse"
                          : "bg-[#00F0FF] shadow-[0_0_6px_#00F0FF]"
                      }`}
                    />
                    <span className="text-[10px] font-mono font-medium text-[#8994A6]">
                      {isLive ? "Screen Active" : "Screen Ready"}
                    </span>
                  </div>
                </div>
              </div>

              <button
                onClick={onClose}
                className="p-1.5 rounded-xl border border-[#202938] hover:bg-[#111722] text-[#8994A6] hover:text-[#F4F7FB] transition cursor-pointer"
              >
                <X size={15} />
              </button>
            </div>

            {/* Current Application */}
            <div className="p-3.5 rounded-xl bg-[#05070D] border border-[#202938] space-y-1">
              <div className="text-[10px] font-mono text-[#8994A6] uppercase tracking-wider">
                Current:
              </div>
              <div className="text-sm font-semibold text-[#F4F7FB] flex items-center justify-between">
                <span>{currentApp}</span>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-[#111722] text-[#00F0FF] border border-[#202938]">
                  ACTIVE WINDOW
                </span>
              </div>
            </div>

            {/* Capabilities: OCR, Vision, Context */}
            <div className="p-3 rounded-xl bg-[#05070D]/70 border border-[#202938]/80 space-y-2 text-xs font-mono">
              <div className="flex items-center justify-between">
                <span className="text-[#8994A6]">OCR</span>
                <span className="flex items-center gap-1.5 text-emerald-400 font-medium">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_#10B981]" />
                  Ready
                </span>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-[#8994A6]">Vision</span>
                <span className="flex items-center gap-1.5 text-emerald-400 font-medium">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_#10B981]" />
                  Ready
                </span>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-[#8994A6]">Context</span>
                <span className="flex items-center gap-1.5 text-emerald-400 font-medium">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_#10B981]" />
                  Ready
                </span>
              </div>
            </div>

            {/* Action Button: [ Share Screen ] */}
            <div className="pt-1">
              {isLive ? (
                <button
                  onClick={() => {
                    onStopShare();
                  }}
                  className="w-full py-2.5 rounded-xl bg-red-500/20 hover:bg-red-500/30 border border-red-500/40 text-red-300 font-mono font-semibold text-xs tracking-wider transition flex items-center justify-center gap-2 cursor-pointer"
                >
                  <EyeOff size={14} />
                  <span>[ Stop Sharing ]</span>
                </button>
              ) : (
                <button
                  onClick={async () => {
                    await onStartShare();
                  }}
                  className="w-full py-2.5 rounded-xl bg-[#00F0FF] hover:bg-[#00F0FF]/90 text-[#05070D] font-mono font-bold text-xs tracking-wider transition flex items-center justify-center gap-2 cursor-pointer shadow-[0_0_20px_rgba(0,240,255,0.25)]"
                >
                  <Monitor size={14} />
                  <span>[ Share Screen ]</span>
                </button>
              )}
            </div>

            {/* Subtle footer notice */}
            <div className="pt-2 border-t border-[#202938]/60 flex items-center justify-between text-[9px] font-mono text-[#8994A6]">
              <span>NATIVE BROWSER CAPTURE</span>
              <span className="text-emerald-400">100% PRIVATE &amp; SECURE</span>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
