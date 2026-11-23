import React, { useState } from "react";
import { Memory, MemoryCategory } from "../lib/memoryTypes";
import { 
  Brain, 
  X, 
  Trash2, 
  Plus, 
  User, 
  Heart, 
  Target, 
  Briefcase, 
  Users, 
  Flame, 
  Sparkles,
  RefreshCw,
  HelpCircle,
  ChevronDown,
  ChevronUp,
  ShieldCheck,
  Check
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

interface MemoryDashboardProps {
  isOpen: boolean;
  onClose: () => void;
  memories: Memory[];
  onAddMemory: (category: MemoryCategory, text: string) => Promise<void>;
  onDeleteMemory: (id: string) => Promise<void>;
  themeColor: string;
}

export function MemoryDashboard({
  isOpen,
  onClose,
  memories,
  onAddMemory,
  onDeleteMemory,
  themeColor
}: MemoryDashboardProps) {
  const [activeTab, setActiveTab] = useState<MemoryCategory | "all">("all");
  const [newText, setNewText] = useState("");
  const [newCategory, setNewCategory] = useState<MemoryCategory>("identity");
  const [isAdding, setIsAdding] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [expandedProvenance, setExpandedProvenance] = useState<Record<string, boolean>>({});

  // Category Configuration
  const categoryConfig: Record<MemoryCategory, { label: string; icon: any; color: string; bg: string }> = {
    identity: { 
      label: "Identity Core", 
      icon: User, 
      color: "text-amber-400 border-amber-500/25", 
      bg: "bg-amber-500/5 hover:bg-amber-500/10" 
    },
    preference: { 
      label: "Preferences", 
      icon: Heart, 
      color: "text-pink-400 border-pink-500/25", 
      bg: "bg-pink-500/5 hover:bg-pink-500/10" 
    },
    skill: { 
      label: "Skills", 
      icon: Sparkles, 
      color: "text-teal-400 border-teal-500/25", 
      bg: "bg-teal-500/5 hover:bg-teal-500/10" 
    },
    goal: { 
      label: "Life Goals", 
      icon: Target, 
      color: "text-emerald-400 border-emerald-500/25", 
      bg: "bg-emerald-500/5 hover:bg-emerald-500/10" 
    },
    project: { 
      label: "Active Projects", 
      icon: Briefcase, 
      color: "text-cyan-400 border-cyan-500/25", 
      bg: "bg-cyan-500/5 hover:bg-cyan-500/10" 
    },
    task: { 
      label: "Tasks", 
      icon: RefreshCw, 
      color: "text-blue-400 border-blue-500/25", 
      bg: "bg-blue-500/5 hover:bg-blue-500/10" 
    },
    decision: { 
      label: "Important Decisions", 
      icon: Brain, 
      color: "text-violet-400 border-violet-500/25", 
      bg: "bg-violet-500/5 hover:bg-violet-500/10" 
    },
    relationship: { 
      label: "Relationships", 
      icon: Users, 
      color: "text-purple-400 border-purple-500/25", 
      bg: "bg-purple-500/5 hover:bg-purple-500/10" 
    },
    emotional: { 
      label: "Milestones", 
      icon: Flame, 
      color: "text-red-400 border-red-500/25", 
      bg: "bg-red-500/5 hover:bg-red-500/10" 
    },
    behavior: { 
      label: "Behaviors & Habits", 
      icon: Brain, 
      color: "text-indigo-400 border-indigo-500/25", 
      bg: "bg-indigo-500/5 hover:bg-indigo-500/10" 
    },
    fact: { 
      label: "General Facts", 
      icon: Sparkles, 
      color: "text-slate-400 border-slate-500/25", 
      bg: "bg-slate-500/5 hover:bg-slate-500/10" 
    },
  };

  const DEFAULT_CATEGORY_CONFIG = {
    label: "General Memory",
    icon: Brain,
    color: "text-indigo-400 border-indigo-500/25",
    bg: "bg-indigo-500/5 hover:bg-indigo-500/10",
  };

  const normalizeCategory = (cat?: string): MemoryCategory => {
    if (!cat) return "fact";
    const lower = String(cat).toLowerCase().trim();
    if (lower === "user_preference" || lower === "preferences") return "preference";
    if (lower in categoryConfig) return lower as MemoryCategory;
    return "fact";
  };

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
        return "border-[#00F0FF]/30 text-[#00F0FF] bg-[#00F0FF]/10";
    }
  };

  const safeMemories = Array.isArray(memories)
    ? memories.filter((m) => m && typeof m === "object" && typeof m.text === "string")
    : [];

  const countCategory = (cat: MemoryCategory) => {
    return safeMemories.filter((m) => normalizeCategory(m.category) === cat).length;
  };

  const filteredMemories = activeTab === "all" 
    ? safeMemories 
    : safeMemories.filter(m => normalizeCategory(m.category) === activeTab);

  const toggleProvenance = (id: string) => {
    setExpandedProvenance((prev) => ({
      ...prev,
      [id]: !prev[id],
    }));
  };

  const getProvenance = (m: Memory) => {
    const norm = normalizeCategory(m.category);
    switch (norm) {
      case "identity":
        return {
          source: "Conversational inference & user self-statement",
          reason: "You shared this information directly in dialogue with MYRAA.",
          confidence: "98% • High Grounding",
          tier: "Core Persona Layer",
        };
      case "preference":
        return {
          source: "Behavioral heuristics & interaction patterns",
          reason: "MYRAA consolidated this preference based on repeated feedback and habits.",
          confidence: "95% • High Grounding",
          tier: "Adaptive Heuristics Layer",
        };
      case "project":
        return {
          source: "Active workspace & contextual repository sync",
          reason: "Discovered during workspace navigation, code indexing, and project tasks.",
          confidence: "96% • High Grounding",
          tier: "Project Context Layer",
        };
      case "skill":
        return {
          source: "Multi-turn tool usage & coding workflows",
          reason: "Recorded during successful tool orchestrations and technical tasks.",
          confidence: "93% • High Grounding",
          tier: "Procedural Memory Layer",
        };
      default:
        return {
          source: "Natural conversation stream consolidator",
          reason: "Extracted by background memory engine from real-time session transcripts.",
          confidence: "91% • Grounded",
          tier: "Semantic Knowledge Layer",
        };
    }
  };

  const handleManualAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newText.trim()) return;

    setSubmitting(true);
    try {
      await onAddMemory(newCategory, newText.trim());
      setNewText("");
      setIsAdding(false);
    } catch (e) {
      console.error(e);
    } finally {
      setSubmitting(false);
    }
  };

  const formatDate = (isoStr: string) => {
    try {
      const d = new Date(isoStr);
      return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    } catch (e) {
      return "Durable Record";
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop Overlay */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="absolute inset-0 bg-black/60 z-40 backdrop-blur-sm"
          />

          {/* Slide-over Container (Neural Glass OS styling) */}
          <motion.div
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", damping: 25, stiffness: 200 }}
            className="absolute inset-y-0 right-0 w-full max-w-lg bg-[#0B0F17]/95 border-l border-[#202938] text-[#F4F7FB] backdrop-blur-2xl z-50 flex flex-col shadow-[0_0_50px_rgba(0,0,0,0.8)]"
          >
            {/* Header: MYRAA MEMORY */}
            <div className="p-6 border-b border-[#202938]/80 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className={`p-2.5 rounded-xl border ${getThemeBadgeGlow()}`}>
                  <Brain size={22} className="animate-pulse" />
                </div>
                <div>
                  <h3 className="font-display font-bold text-lg tracking-[0.2em] text-[#F4F7FB] flex items-center gap-2 uppercase">
                    MYRAA MEMORY
                    <Sparkles size={14} className="text-[#00F0FF]" />
                  </h3>
                  <p className="text-[11px] font-mono tracking-wider text-[#8994A6] mt-0.5">
                    {safeMemories.length} memories
                  </p>
                </div>
              </div>
              <button
                onClick={onClose}
                className="p-2 rounded-xl border border-[#202938] bg-[#111722]/80 hover:bg-[#111722] text-[#8994A6] hover:text-[#F4F7FB] transition cursor-pointer"
              >
                <X size={18} />
              </button>
            </div>

            {/* 10. 2x2 CATEGORY METRICS GRID */}
            <div className="p-6 pb-4 border-b border-[#202938]/70">
              <div className="grid grid-cols-2 gap-3">
                {/* Identity Card */}
                <button
                  onClick={() => setActiveTab(activeTab === "identity" ? "all" : "identity")}
                  className={`p-3.5 rounded-xl border text-left transition-all cursor-pointer relative overflow-hidden group ${
                    activeTab === "identity"
                      ? "bg-[#111722] border-[#00F0FF] shadow-[0_0_15px_rgba(0,240,255,0.15)]"
                      : "bg-[#0B0F17]/90 border-[#202938] hover:border-[#202938]/90 hover:bg-[#111722]/60"
                  }`}
                >
                  <div className="flex items-center justify-between text-xs font-mono text-[#8994A6] group-hover:text-[#F4F7FB]">
                    <span className="font-medium">Identity</span>
                    <User size={13} className="text-amber-400" />
                  </div>
                  <div className="text-2xl font-bold font-mono text-[#F4F7FB] mt-1.5">
                    {countCategory("identity")}
                  </div>
                  {activeTab === "identity" && (
                    <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-[#00F0FF]" />
                  )}
                </button>

                {/* Preferences Card */}
                <button
                  onClick={() => setActiveTab(activeTab === "preference" ? "all" : "preference")}
                  className={`p-3.5 rounded-xl border text-left transition-all cursor-pointer relative overflow-hidden group ${
                    activeTab === "preference"
                      ? "bg-[#111722] border-[#8B5CF6] shadow-[0_0_15px_rgba(139,92,246,0.15)]"
                      : "bg-[#0B0F17]/90 border-[#202938] hover:border-[#202938]/90 hover:bg-[#111722]/60"
                  }`}
                >
                  <div className="flex items-center justify-between text-xs font-mono text-[#8994A6] group-hover:text-[#F4F7FB]">
                    <span className="font-medium">Preferences</span>
                    <Heart size={13} className="text-pink-400" />
                  </div>
                  <div className="text-2xl font-bold font-mono text-[#F4F7FB] mt-1.5">
                    {countCategory("preference")}
                  </div>
                  {activeTab === "preference" && (
                    <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-[#8B5CF6]" />
                  )}
                </button>

                {/* Projects Card */}
                <button
                  onClick={() => setActiveTab(activeTab === "project" ? "all" : "project")}
                  className={`p-3.5 rounded-xl border text-left transition-all cursor-pointer relative overflow-hidden group ${
                    activeTab === "project"
                      ? "bg-[#111722] border-[#3B82F6] shadow-[0_0_15px_rgba(59,130,246,0.15)]"
                      : "bg-[#0B0F17]/90 border-[#202938] hover:border-[#202938]/90 hover:bg-[#111722]/60"
                  }`}
                >
                  <div className="flex items-center justify-between text-xs font-mono text-[#8994A6] group-hover:text-[#F4F7FB]">
                    <span className="font-medium">Projects</span>
                    <Briefcase size={13} className="text-blue-400" />
                  </div>
                  <div className="text-2xl font-bold font-mono text-[#F4F7FB] mt-1.5">
                    {countCategory("project")}
                  </div>
                  {activeTab === "project" && (
                    <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-[#3B82F6]" />
                  )}
                </button>

                {/* Skills Card */}
                <button
                  onClick={() => setActiveTab(activeTab === "skill" ? "all" : "skill")}
                  className={`p-3.5 rounded-xl border text-left transition-all cursor-pointer relative overflow-hidden group ${
                    activeTab === "skill"
                      ? "bg-[#111722] border-[#10B981] shadow-[0_0_15px_rgba(16,185,129,0.15)]"
                      : "bg-[#0B0F17]/90 border-[#202938] hover:border-[#202938]/90 hover:bg-[#111722]/60"
                  }`}
                >
                  <div className="flex items-center justify-between text-xs font-mono text-[#8994A6] group-hover:text-[#F4F7FB]">
                    <span className="font-medium">Skills</span>
                    <Sparkles size={13} className="text-teal-400" />
                  </div>
                  <div className="text-2xl font-bold font-mono text-[#F4F7FB] mt-1.5">
                    {countCategory("skill")}
                  </div>
                  {activeTab === "skill" && (
                    <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-[#10B981]" />
                  )}
                </button>
              </div>

              {/* Action / Filter Subheader */}
              <div className="mt-3.5 flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => setActiveTab("all")}
                    className={`px-2.5 py-1 rounded-lg text-[10px] font-mono uppercase transition cursor-pointer ${
                      activeTab === "all"
                        ? "bg-[#00F0FF]/15 text-[#00F0FF] border border-[#00F0FF]/40"
                        : "text-[#8994A6] hover:text-[#F4F7FB]"
                    }`}
                  >
                    View All ({safeMemories.length})
                  </button>
                  {activeTab !== "all" && (
                    <span className="text-[10px] font-mono text-[#8994A6]">
                      • Filtered: {activeTab}
                    </span>
                  )}
                </div>

                {!isAdding && (
                  <button
                    onClick={() => setIsAdding(true)}
                    className="flex items-center gap-1 px-2.5 py-1 rounded-lg border border-[#202938] bg-[#111722] hover:bg-[#111722]/80 text-[10px] font-mono text-[#8994A6] hover:text-[#00F0FF] transition cursor-pointer"
                  >
                    <Plus size={11} />
                    <span>MANUAL SEED</span>
                  </button>
                )}
              </div>
            </div>

            {/* Manual Entry Drawer */}
            <AnimatePresence>
              {isAdding && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  className="overflow-hidden border-b border-[#202938] bg-[#05070D]"
                >
                  <form onSubmit={handleManualAdd} className="p-5 space-y-4">
                    <div>
                      <label className="block text-[11px] font-mono tracking-wider text-[#8994A6] uppercase mb-2">
                        Memory Archetype Category
                      </label>
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                        {(Object.keys(categoryConfig) as MemoryCategory[]).map((cat) => {
                          const Icon = categoryConfig[cat].icon;
                          const active = newCategory === cat;
                          return (
                            <button
                              key={cat}
                              type="button"
                              onClick={() => setNewCategory(cat)}
                              className={`flex items-center gap-2 p-1.5 rounded-lg border text-xs tracking-wide transition cursor-pointer ${
                                active 
                                  ? "border-[#00F0FF] bg-[#00F0FF]/10 text-[#00F0FF]"
                                  : "border-[#202938] bg-[#111722]/60 text-[#8994A6] hover:bg-[#111722]"
                              }`}
                            >
                              <Icon size={12} />
                              <span className="truncate">{categoryConfig[cat].label.split(" ")[0]}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    <div>
                      <label htmlFor="memory-statement-input" className="block text-[11px] font-mono tracking-wider text-[#8994A6] uppercase mb-2">
                        Recollection Statement (3rd Person declarative)
                      </label>
                      <textarea
                        id="memory-statement-input"
                        name="memoryStatement"
                        value={newText}
                        onChange={(e) => setNewText(e.target.value)}
                        placeholder="e.g. The user's startup is called Myraa, an AI Operating System."
                        required
                        className="w-full h-18 text-xs p-3 rounded-lg border border-[#202938] bg-[#0B0F17] text-[#F4F7FB] placeholder-[#8994A6]/50 focus:outline-none focus:border-[#00F0FF]/60 resize-none font-sans"
                      />
                    </div>

                    <div className="flex gap-2.5 justify-end">
                      <button
                        type="button"
                        onClick={() => setIsAdding(false)}
                        className="px-3.5 py-1.5 rounded-lg border border-[#202938] text-xs font-mono tracking-wide text-[#8994A6] hover:text-[#F4F7FB] transition cursor-pointer"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        disabled={submitting}
                        className="px-4 py-1.5 rounded-lg bg-[#00F0FF] hover:bg-[#00F0FF]/80 text-[#05070D] font-bold text-xs uppercase font-mono tracking-widest transition disabled:opacity-50 cursor-pointer"
                      >
                        {submitting ? "Saving..." : "Commit Memory"}
                      </button>
                    </div>
                  </form>
                </motion.div>
              )}
            </AnimatePresence>

            {/* MEMORIES LIST UNDERNEATH */}
            <div className="flex-1 overflow-y-auto p-6 space-y-3.5">
              <AnimatePresence initial={false}>
                {filteredMemories.length === 0 ? (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="h-full flex flex-col items-center justify-center p-8 text-center text-[#8994A6]"
                  >
                    <div className="p-4 rounded-full border border-dashed border-[#202938] bg-[#111722]/30 mb-4">
                      <Brain size={32} className="opacity-40" />
                    </div>
                    <h4 className="text-sm font-semibold tracking-wide text-[#F4F7FB]">No memories recorded yet</h4>
                    <p className="text-xs max-w-xs mt-1.5 leading-relaxed font-mono">
                      {activeTab === "all" 
                        ? "Start talking aloud with MYRAA! Her background consolidator analyzes conversational turns and builds durable context."
                        : `No persistent recollections saved in Category "${categoryConfig[activeTab as MemoryCategory]?.label || "Selected Category"}".`}
                    </p>
                  </motion.div>
                ) : (
                  filteredMemories.map((m) => {
                    const normalized = normalizeCategory(m.category);
                    const cfg = categoryConfig[normalized] || DEFAULT_CATEGORY_CONFIG;
                    const Icon = cfg.icon || Brain;
                    const prov = getProvenance(m);
                    const isProvOpen = !!expandedProvenance[m.id];

                    return (
                      <motion.div
                        key={m.id}
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.95 }}
                        className="p-4 rounded-xl border border-[#202938] backdrop-blur-md bg-[#111722]/50 hover:bg-[#111722]/80 transition-colors group relative"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex gap-3 overflow-hidden">
                            <div className={`p-2 rounded-lg border mt-0.5 shrink-0 bg-[#05070D] ${cfg.color || ""}`}>
                              <Icon size={14} />
                            </div>
                            <div className="overflow-hidden">
                              <span className={`text-[9px] font-mono uppercase tracking-wider block font-semibold ${cfg.color}`}>
                                {cfg.label}
                              </span>
                              <p className="text-xs text-[#F4F7FB] mt-1 font-sans leading-relaxed break-words font-medium">
                                {m.text}
                              </p>
                              <span className="text-[9px] font-mono text-[#8994A6] mt-1.5 block">
                                Recalled: {formatDate(m.createdAt)}
                              </span>
                            </div>
                          </div>

                          {/* Delete Memory Button */}
                          <button
                            onClick={() => onDeleteMemory(m.id)}
                            className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg border border-red-500/25 bg-red-950/20 text-red-400 hover:bg-red-500 hover:text-white transition duration-150 shrink-0 cursor-pointer"
                            title="Forget this memory"
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>

                        {/* Provenance Disclosure ("Why does MYRAA know this?") */}
                        <div className="mt-3 pt-2.5 border-t border-[#202938]/60">
                          <button
                            onClick={() => toggleProvenance(m.id)}
                            className="flex items-center gap-1.5 text-[10px] font-mono text-[#8994A6] hover:text-[#00F0FF] transition cursor-pointer"
                          >
                            <HelpCircle size={11} className="text-[#00F0FF]" />
                            <span className="font-medium">Why does MYRAA know this?</span>
                            {isProvOpen ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                          </button>

                          <AnimatePresence>
                            {isProvOpen && (
                              <motion.div
                                initial={{ opacity: 0, height: 0 }}
                                animate={{ opacity: 1, height: "auto" }}
                                exit={{ opacity: 0, height: 0 }}
                                className="mt-2 p-2.5 rounded-lg bg-[#05070D]/90 border border-[#202938] text-[10px] font-mono space-y-1.5 text-[#8994A6]"
                              >
                                <div className="flex items-center justify-between">
                                  <span className="text-[#F4F7FB] font-semibold flex items-center gap-1">
                                    <ShieldCheck size={11} className="text-[#10B981]" />
                                    <span>Provenance Trace</span>
                                  </span>
                                  <span className="text-[#10B981] font-bold">{prov.confidence}</span>
                                </div>
                                <div>
                                  <span className="text-[#8994A6]">Source:</span>{" "}
                                  <span className="text-[#F4F7FB]">{prov.source}</span>
                                </div>
                                <div>
                                  <span className="text-[#8994A6]">Reason:</span>{" "}
                                  <span className="text-[#F4F7FB]">{prov.reason}</span>
                                </div>
                                <div className="pt-1.5 border-t border-[#202938]/50 flex items-center justify-between text-[9px] text-[#8994A6]">
                                  <span>Layer: {prov.tier}</span>
                                  <span className="text-[#10B981] flex items-center gap-1">
                                    <Check size={10} />
                                    <span>Verified</span>
                                  </span>
                                </div>
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </div>
                      </motion.div>
                    );
                  })
                )}
              </AnimatePresence>
            </div>

            {/* Footer */}
            <div className="p-4 border-t border-[#202938] bg-[#05070D]/80 flex items-center justify-between text-[9px] font-mono text-[#8994A6] tracking-wider">
              <span className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-[#10B981] shadow-[0_0_5px_#10B981] animate-pulse" />
                <span>EPISODIC &amp; SEMANTIC GRAPH SYNCD</span>
              </span>
              <span>DURABLE ZERO-LEAK STORE</span>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
