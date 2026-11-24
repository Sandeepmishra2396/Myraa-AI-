import React, { useState, useRef, useEffect, useCallback } from "react";
import {
  X,
  Send,
  Mic,
  MicOff,
  Paperclip,
  Volume2,
  VolumeX,
  Copy,
  Check,
  RotateCcw,
  Sparkles,
  Bot,
  User,
  FileText,
  Image as ImageIcon,
  ThumbsUp,
  ArrowDown,
  CornerDownLeft,
  Share2,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

export interface ChatAttachment {
  id: string;
  name: string;
  size: number;
  type: string;
  url?: string;
  dataBase64?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "model" | "system";
  content: string;
  timestamp: number;
  attachments?: ChatAttachment[];
  status?: "sending" | "sent" | "streaming" | "error";
  emotion?: string;
}

export interface ChatInterfaceProps {
  isOpen: boolean;
  onClose: () => void;
  messages: ChatMessage[];
  onClearMessages: () => void;
  sessionState: "disconnected" | "connecting" | "connected" | "listening" | "speaking";
  characterState: "idle" | "thinking" | "talking";
  onToggleVoice: () => void;
  onSendMessage: (text: string, attachments?: ChatAttachment[]) => void;
  themeColor?: string;
  onOpenVision?: () => void;
  onOpenMemory?: () => void;
}

const QUICK_PROMPTS = [
  { label: "Analyze screen", icon: "👁️", prompt: "Analyze my current screen and tell me what you see." },
  { label: "Project overview", icon: "📁", prompt: "Give me an overview of our current project status." },
  { label: "Recall memories", icon: "🧠", prompt: "What recent preferences or context do you remember about me?" },
  { label: "What can you do?", icon: "✨", prompt: "What are your core capabilities as MYRAA AI?" },
];

export const ChatInterface: React.FC<ChatInterfaceProps> = ({
  isOpen,
  onClose,
  messages,
  onClearMessages,
  sessionState,
  characterState,
  onToggleVoice,
  onSendMessage,
}) => {
  const [inputText, setInputText] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [isVoiceMuted, setIsVoiceMuted] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copiedTranscript, setCopiedTranscript] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  const [likedMessageIds, setLikedMessageIds] = useState<Set<string>>(new Set());

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll to bottom on new messages or streaming chunks
  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    messagesEndRef.current?.scrollIntoView({ behavior, block: "end" });
  }, []);

  useEffect(() => {
    if (isOpen) {
      scrollToBottom("auto");
      setTimeout(() => {
        textareaRef.current?.focus();
      }, 150);
    }
  }, [isOpen, scrollToBottom]);

  useEffect(() => {
    if (!showScrollBottom) {
      scrollToBottom();
    }
  }, [messages, showScrollBottom, scrollToBottom]);

  // Handle scroll events to detect if user has scrolled up
  const handleScroll = () => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setShowScrollBottom(!isAtBottom);
  };

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isOpen) {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  // Handle file additions
  const handleFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const newAttachments: ChatAttachment[] = [];

    Array.from(files).forEach((file) => {
      const reader = new FileReader();
      const isImg = file.type.startsWith("image/");
      const attachObj: ChatAttachment = {
        id: `att-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
        name: file.name,
        size: file.size,
        type: file.type,
      };

      if (isImg) {
        reader.onload = () => {
          attachObj.url = reader.result as string;
          attachObj.dataBase64 = (reader.result as string).split(",")[1];
          setAttachments((prev) => [...prev, attachObj]);
        };
        reader.readAsDataURL(file);
      } else {
        newAttachments.push(attachObj);
      }
    });

    if (newAttachments.length > 0) {
      setAttachments((prev) => [...prev, ...newAttachments]);
    }
  };

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  // Handle message sending
  const handleSend = (textToSend?: string) => {
    const text = (textToSend !== undefined ? textToSend : inputText).trim();
    if (!text && attachments.length === 0) return;

    onSendMessage(text, attachments.length > 0 ? [...attachments] : undefined);
    setInputText("");
    setAttachments([]);
    setShowScrollBottom(false);

    // Auto-resize textarea back to single row
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Adjust textarea height dynamically
  const handleTextareaInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInputText(e.target.value);
    const target = e.target;
    target.style.height = "auto";
    target.style.height = `${Math.min(target.scrollHeight, 140)}px`;
  };

  // Copy single message
  const handleCopyMessage = (id: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  // Copy full transcript
  const handleCopyTranscript = () => {
    const transcript = messages
      .map((m) => `[${new Date(m.timestamp).toLocaleTimeString()}] ${m.role === "user" ? "User" : "MYRAA"}: ${m.content}`)
      .join("\n\n");
    navigator.clipboard.writeText(transcript);
    setCopiedTranscript(true);
    setTimeout(() => setCopiedTranscript(false), 2000);
  };

  // Read message aloud using SpeechSynthesis if not voice-muted
  const handleSpeakAloud = (text: string) => {
    if (isVoiceMuted || typeof window === "undefined" || !("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const cleanText = text.replace(/[*#`_~[\]()]/g, " ").trim();
    const utterance = new SpeechSynthesisUtterance(cleanText);
    utterance.rate = 1.05;
    utterance.pitch = 1.0;
    window.speechSynthesis.speak(utterance);
  };

  const toggleLike = (id: string) => {
    setLikedMessageIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const formatTime = (ts: number): string => {
    return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          key="chat-modal-root"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="fixed inset-0 z-50 pointer-events-none overflow-hidden"
        >
          {/* Backdrop Overlay */}
          <motion.div
            key="chat-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm transition-opacity pointer-events-auto"
            data-testid="chat-backdrop"
          />

          {/* Slide-over Container — Light Blue and White Aurora Glass Panel */}
          <motion.div
            key="chat-slideover-panel"
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
            className="absolute inset-y-0 right-0 w-full max-w-xl md:max-w-2xl neural-glass-panel border-l border-[#38bdf8]/20 dark:border-[#202938] text-slate-900 dark:text-slate-100 backdrop-blur-3xl flex flex-col shadow-2xl pointer-events-auto"
            data-testid="myraa-chat-interface"
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setIsDragging(false);
              handleFiles(e.dataTransfer.files);
            }}
          >
            {/* DRAG-AND-DROP OVERLAY INDICATOR */}
            {isDragging && (
              <div className="absolute inset-0 bg-sky-500/10 backdrop-blur-md border-2 border-dashed border-sky-400 z-50 flex flex-col items-center justify-center pointer-events-none">
                <Paperclip size={40} className="text-sky-500 animate-bounce mb-2" />
                <p className="font-semibold text-sky-700 dark:text-sky-300">Drop files to attach to chat</p>
                <p className="text-xs text-sky-600/80 dark:text-sky-400/80">Images, documents, code files supported</p>
              </div>
            )}

            {/* 1. PREMIUM CHAT HEADER */}
            <div className="px-5 py-4 border-b border-[#38bdf8]/20 dark:border-[#202938] flex items-center justify-between shrink-0 bg-white/40 dark:bg-[#0B0F17]/40 backdrop-blur-md">
              <div className="flex items-center gap-3">
                {/* Glowing Avatar Hologram Badge */}
                <div className="relative">
                  <div className="w-10 h-10 rounded-2xl bg-gradient-to-tr from-sky-400/20 via-sky-300/30 to-blue-500/20 border border-sky-400/40 flex items-center justify-center shadow-[0_0_15px_rgba(14,165,233,0.2)]">
                    <Sparkles size={20} className="text-sky-600 dark:text-sky-400 animate-pulse" />
                  </div>
                  {/* Status Ring Dot */}
                  <span
                    className={`absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full border-2 border-white dark:border-[#0B0F17] ${
                      sessionState === "speaking"
                        ? "bg-purple-500 shadow-[0_0_8px_#a855f7]"
                        : sessionState === "listening"
                        ? "bg-sky-400 shadow-[0_0_8px_#38bdf8] animate-ping"
                        : characterState === "thinking"
                        ? "bg-blue-500 animate-spin"
                        : "bg-emerald-400 shadow-[0_0_6px_#34d399]"
                    }`}
                  />
                </div>

                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-sm font-bold tracking-tight text-slate-900 dark:text-white font-sans">
                      MYRAA AI
                    </h2>
                    <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-sky-500/10 text-sky-700 dark:text-sky-400 border border-sky-400/30 font-semibold tracking-wider">
                      {sessionState === "speaking"
                        ? "SPEAKING"
                        : sessionState === "listening"
                        ? "LISTENING"
                        : characterState === "thinking"
                        ? "THINKING"
                        : "READY"}
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-600 dark:text-slate-400 font-mono">
                    Gemini 2.0 Live Multimodal Voice & Reasoning
                  </p>
                </div>
              </div>

              {/* Header Action Controls */}
              <div className="flex items-center gap-1">
                {/* Voice Audio Mute Toggle */}
                <button
                  type="button"
                  onClick={() => setIsVoiceMuted(!isVoiceMuted)}
                  className={`p-2 rounded-xl transition cursor-pointer ${
                    isVoiceMuted
                      ? "bg-rose-500/10 text-rose-500 border border-rose-400/30"
                      : "text-slate-500 hover:text-sky-600 hover:bg-sky-500/10"
                  }`}
                  title={isVoiceMuted ? "Unmute spoken voice response" : "Mute spoken voice response"}
                  data-testid="chat-voice-mute-btn"
                >
                  {isVoiceMuted ? <VolumeX size={16} /> : <Volume2 size={16} />}
                </button>

                {/* Copy Full Transcript */}
                <button
                  type="button"
                  onClick={handleCopyTranscript}
                  className="p-2 rounded-xl text-slate-500 hover:text-sky-600 hover:bg-sky-500/10 transition cursor-pointer"
                  title="Copy complete transcript to clipboard"
                  data-testid="chat-copy-transcript-btn"
                >
                  {copiedTranscript ? <Check size={16} className="text-emerald-500" /> : <Share2 size={16} />}
                </button>

                {/* Clear Conversation */}
                <button
                  type="button"
                  onClick={onClearMessages}
                  className="p-2 rounded-xl text-slate-500 hover:text-rose-500 hover:bg-rose-500/10 transition cursor-pointer"
                  title="Clear conversation"
                  data-testid="chat-clear-btn"
                >
                  <RotateCcw size={16} />
                </button>

                {/* Close Slide-Over */}
                <button
                  type="button"
                  onClick={onClose}
                  className="p-2 rounded-xl text-slate-500 hover:text-slate-900 dark:hover:text-white hover:bg-slate-200/50 dark:hover:bg-slate-800 transition cursor-pointer"
                  title="Close Chat panel (Esc)"
                  data-testid="chat-close-btn"
                >
                  <X size={18} className="pointer-events-none" />
                </button>
              </div>
            </div>

            {/* 2. CONVERSATION MESSAGES CONTAINER */}
            <div
              ref={scrollContainerRef}
              onScroll={handleScroll}
              className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-4 relative scroll-smooth"
            >
              {/* Session Start Watermark */}
              <div className="flex items-center justify-center my-2">
                <span className="text-[10px] font-mono uppercase tracking-widest text-slate-600 dark:text-slate-400 bg-sky-50/80 dark:bg-slate-900/50 px-3 py-1 rounded-full border border-sky-200/80 dark:border-[#38bdf8]/15 font-medium">
                  Today · Aurora Neural Live Session
                </span>
              </div>

              {/* Message Bubbles List */}
              {messages.map((message) => {
                const isUser = message.role === "user";
                const isLiked = likedMessageIds.has(message.id);
                const isCopied = copiedId === message.id;

                return (
                  <motion.div
                    key={message.id}
                    initial={{ opacity: 0, y: 10, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    transition={{ duration: 0.2 }}
                    className={`flex flex-col ${isUser ? "items-end" : "items-start"}`}
                    data-testid={isUser ? "chat-message-user" : "chat-message-model"}
                  >
                    {/* Role Label & Timestamp Header */}
                    <div className="flex items-center gap-1.5 mb-1 px-1 text-[10px] font-mono text-slate-600 dark:text-slate-400 font-medium">
                      {isUser ? (
                        <>
                          <span>{formatTime(message.timestamp)}</span>
                          <span className="font-semibold text-sky-700 dark:text-sky-400">YOU</span>
                          <User size={11} className="text-sky-600" />
                        </>
                      ) : (
                        <>
                          <Bot size={11} className="text-sky-600" />
                          <span className="font-semibold text-sky-700 dark:text-sky-400">MYRAA</span>
                          <span>·</span>
                          <span>{formatTime(message.timestamp)}</span>
                        </>
                      )}
                    </div>

                    {/* Message Bubble Body */}
                    <div
                      className={`relative group max-w-[88%] sm:max-w-[82%] text-sm font-sans leading-relaxed transition-all duration-200 ${
                        isUser
                          ? "bg-gradient-to-r from-sky-500 via-sky-600 to-blue-600 text-white shadow-md shadow-sky-500/15 rounded-2xl rounded-tr-xs p-3.5 sm:p-4"
                          : "neural-glass-elevated border border-sky-200/80 dark:border-[#38bdf8]/25 text-slate-900 dark:text-slate-100 shadow-md shadow-sky-400/5 rounded-2xl rounded-tl-xs p-3.5 sm:p-4"
                      }`}
                    >
                      {/* Attached Files inside Message Bubble */}
                      {message.attachments && message.attachments.length > 0 && (
                        <div className="mb-2.5 flex flex-wrap gap-2">
                          {message.attachments.map((att) => (
                            <div
                              key={att.id}
                              className={`flex items-center gap-2 px-2.5 py-1.5 rounded-xl text-xs font-mono border ${
                                isUser
                                  ? "bg-white/15 border-white/25 text-white"
                                  : "bg-sky-50/80 dark:bg-slate-800/80 border-[#38bdf8]/30 text-slate-700 dark:text-slate-200"
                              }`}
                            >
                              {att.type.startsWith("image/") ? (
                                <ImageIcon size={13} className="shrink-0 text-sky-300" />
                              ) : (
                                <FileText size={13} className="shrink-0 text-sky-300" />
                              )}
                              <span className="max-w-[140px] truncate font-medium">{att.name}</span>
                              <span className="text-[10px] opacity-75">({formatFileSize(att.size)})</span>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Main Message Text */}
                      <div className="whitespace-pre-wrap break-words">{message.content}</div>

                      {/* Streaming Indicator */}
                      {message.status === "streaming" && (
                        <div className="mt-2 flex items-center gap-1.5 text-xs text-sky-500">
                          <span className="w-1.5 h-1.5 rounded-full bg-sky-500 animate-ping" />
                          <span className="font-mono text-[11px] animate-pulse">Generating response...</span>
                        </div>
                      )}

                      {/* Assistant Bubble Actions Bar */}
                      {!isUser && (
                        <div className="mt-2.5 pt-2 border-t border-[#38bdf8]/15 dark:border-slate-800 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
                          <div className="flex items-center gap-1">
                            {/* Copy button */}
                            <button
                              type="button"
                              onClick={() => handleCopyMessage(message.id, message.content)}
                              className="p-1 rounded-md hover:bg-sky-500/10 hover:text-sky-700 dark:hover:text-sky-400 transition cursor-pointer"
                              title="Copy message"
                            >
                              {isCopied ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
                            </button>

                            {/* Speak Aloud button */}
                            <button
                              type="button"
                              onClick={() => handleSpeakAloud(message.content)}
                              className="p-1 rounded-md hover:bg-sky-500/10 hover:text-sky-700 dark:hover:text-sky-400 transition cursor-pointer"
                              title="Read response aloud"
                            >
                              <Volume2 size={12} />
                            </button>
                          </div>

                          {/* Like reaction */}
                          <button
                            type="button"
                            onClick={() => toggleLike(message.id)}
                            className={`p-1 rounded-md transition cursor-pointer ${
                              isLiked
                                ? "text-sky-600 dark:text-sky-400 font-bold bg-sky-500/10"
                                : "hover:bg-sky-500/10 hover:text-sky-700 dark:hover:text-sky-400"
                            }`}
                            title={isLiked ? "Helpful" : "Mark as helpful"}
                          >
                            <ThumbsUp size={12} />
                          </button>
                        </div>
                      )}
                    </div>
                  </motion.div>
                );
              })}

              {/* Dynamic Thinking State Indicator */}
              {characterState === "thinking" && messages[messages.length - 1]?.role === "user" && (
                <motion.div
                  initial={{ opacity: 0, y: 5 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="flex items-center gap-2 neural-glass-subtle px-3.5 py-2.5 rounded-2xl max-w-xs border border-sky-400/25"
                >
                  <div className="flex gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-sky-400 animate-bounce" style={{ animationDelay: "0ms" }} />
                    <span className="w-1.5 h-1.5 rounded-full bg-sky-500 animate-bounce" style={{ animationDelay: "150ms" }} />
                    <span className="w-1.5 h-1.5 rounded-full bg-blue-600 animate-bounce" style={{ animationDelay: "300ms" }} />
                  </div>
                  <span className="text-xs font-mono text-sky-700 dark:text-sky-400 font-medium">MYRAA is thinking...</span>
                </motion.div>
              )}

              <div ref={messagesEndRef} />
            </div>

            {/* Scroll-To-Bottom Floating Pill */}
            {showScrollBottom && (
              <div className="absolute bottom-36 right-6 z-20">
                <button
                  type="button"
                  onClick={() => scrollToBottom("smooth")}
                  className="neural-glass-elevated p-2 rounded-full shadow-lg border border-sky-400/30 text-sky-700 dark:text-sky-400 hover:scale-105 transition cursor-pointer flex items-center gap-1.5 text-xs font-mono font-medium"
                  title="Scroll to latest messages"
                >
                  <ArrowDown size={14} />
                  <span>Latest</span>
                </button>
              </div>
            )}

            {/* 3. QUICK PROMPT PILLS SHELF */}
            <div className="px-5 py-2 border-t border-[#38bdf8]/15 dark:border-[#202938] bg-white/30 dark:bg-[#0B0F17]/30 shrink-0 overflow-x-auto no-scrollbar">
              <div className="flex items-center gap-2 min-w-max">
                <span className="text-[10px] font-mono text-slate-600 dark:text-slate-400 flex items-center gap-1 font-semibold">
                  <Sparkles size={11} className="text-sky-600 dark:text-sky-500" />
                  SUGGESTIONS:
                </span>
                {QUICK_PROMPTS.map((qp, idx) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => handleSend(qp.prompt)}
                    className="neural-pill text-xs font-sans px-2.5 py-1 rounded-xl text-slate-800 dark:text-slate-200 hover:text-sky-700 dark:hover:text-sky-400 hover:border-sky-400/40 transition cursor-pointer flex items-center gap-1.5 font-medium"
                  >
                    <span>{qp.icon}</span>
                    <span>{qp.label}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* 4. REDESIGNED MESSAGE INPUT AREA */}
            <div className="p-4 sm:p-5 border-t border-[#38bdf8]/20 dark:border-[#202938] shrink-0 bg-white/50 dark:bg-[#0B0F17]/50 backdrop-blur-lg">
              {/* Attachment Preview Tray */}
              {attachments.length > 0 && (
                <div className="mb-2.5 flex flex-wrap gap-2">
                  {attachments.map((att) => (
                    <div
                      key={att.id}
                      className="neural-glass-subtle px-2.5 py-1.5 rounded-xl border border-sky-400/30 flex items-center gap-2 text-xs text-slate-800 dark:text-slate-200"
                    >
                      {att.type.startsWith("image/") ? (
                        <ImageIcon size={13} className="text-sky-500" />
                      ) : (
                        <FileText size={13} className="text-sky-500" />
                      )}
                      <span className="max-w-[130px] truncate font-medium">{att.name}</span>
                      <span className="text-[10px] text-slate-500 dark:text-slate-400 font-medium">({formatFileSize(att.size)})</span>
                      <button
                        type="button"
                        onClick={() => removeAttachment(att.id)}
                        className="text-slate-500 hover:text-rose-500 transition cursor-pointer p-0.5"
                        title="Remove attachment"
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Input Capsule */}
              <div className="neural-glass-elevated rounded-2xl border border-[#38bdf8]/30 dark:border-[#202938] focus-within:border-sky-500 focus-within:ring-2 focus-within:ring-sky-500/20 p-2 sm:p-2.5 transition-all shadow-lg flex items-end gap-2">
                {/* Hidden File Input */}
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  onChange={(e) => handleFiles(e.target.files)}
                  className="hidden"
                  data-testid="chat-file-input"
                />

                {/* Attachment Button */}
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="p-2 rounded-xl text-slate-500 hover:text-sky-600 hover:bg-sky-500/10 transition cursor-pointer shrink-0"
                  title="Attach file or image"
                  data-testid="chat-attachment-btn"
                >
                  <Paperclip size={18} />
                </button>

                {/* Expanding Textarea */}
                <textarea
                  ref={textareaRef}
                  value={inputText}
                  onChange={handleTextareaInput}
                  onKeyDown={handleKeyDown}
                  placeholder="Ask MYRAA anything, or press mic to speak..."
                  rows={1}
                  className="flex-1 bg-transparent border-none text-slate-900 dark:text-slate-100 placeholder-slate-500 dark:placeholder-slate-400 text-sm font-sans resize-none focus:outline-none max-h-36 py-1 leading-normal"
                  data-testid="chat-input"
                />

                {/* Voice Interaction Mic Hero Button */}
                <button
                  type="button"
                  onClick={onToggleVoice}
                  className={`p-2 rounded-xl transition cursor-pointer shrink-0 relative ${
                    sessionState === "listening"
                      ? "bg-sky-500 text-white shadow-[0_0_15px_rgba(14,165,233,0.5)]"
                      : sessionState === "speaking"
                      ? "bg-purple-600 text-white shadow-[0_0_15px_rgba(168,85,247,0.5)]"
                      : "text-slate-500 hover:text-sky-600 hover:bg-sky-500/10"
                  }`}
                  title={
                    sessionState === "disconnected"
                      ? "Start live voice conversation with MYRAA"
                      : "Pause voice session"
                  }
                  data-testid="chat-mic-btn"
                >
                  {sessionState === "listening" || sessionState === "speaking" ? (
                    <>
                      <Mic size={18} className="animate-pulse" />
                      <span className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-emerald-400 animate-ping" />
                    </>
                  ) : (
                    <Mic size={18} />
                  )}
                </button>

                {/* Send Button */}
                <button
                  type="button"
                  onClick={() => handleSend()}
                  disabled={!inputText.trim() && attachments.length === 0}
                  className={`p-2 rounded-xl transition cursor-pointer shrink-0 flex items-center justify-center ${
                    inputText.trim() || attachments.length > 0
                      ? "bg-gradient-to-r from-sky-500 to-blue-600 text-white shadow-md shadow-sky-500/25 hover:from-sky-600 hover:to-blue-700 active:scale-95"
                      : "bg-slate-200 dark:bg-slate-800 text-slate-500 dark:text-slate-400 cursor-not-allowed"
                  }`}
                  title="Send message (Enter)"
                  data-testid="chat-send-btn"
                >
                  <Send size={16} />
                </button>
              </div>

              {/* Bottom Keyboard Hint */}
              <div className="mt-2 px-1 flex items-center justify-between text-[10px] font-mono text-slate-600 dark:text-slate-400 font-medium">
                <span className="flex items-center gap-1">
                  <CornerDownLeft size={10} />
                  <span>Enter to send · Shift+Enter for newline</span>
                </span>
                <span>Powered by Gemini Live & Neural Audio</span>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
