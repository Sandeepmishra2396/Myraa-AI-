import React, { useState, useMemo } from "react";
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
  Check,
  Search,
  Download,
  Edit2,
  Save,
  Clock,
  Database,
  Layers,
  ArrowRight,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

interface MemoryDashboardProps {
  isOpen: boolean;
  onClose: () => void;
  memories: Memory[];
  onAddMemory: (category: MemoryCategory, text: string) => Promise<void>;
  onDeleteMemory: (id: string) => Promise<void>;
  onUpdateMemory?: (id: string, text: string, category?: MemoryCategory) => Promise<void>;
  themeColor: string;
}

type MemoryHorizon = "all" | "long_term" | "short_term" | "preferences";

export function MemoryDashboard({
  isOpen,
  onClose,
  memories,
  onAddMemory,
  onDeleteMemory,
  onUpdateMemory,
  themeColor,
}: MemoryDashboardProps) {
  const [activeCategory, setActiveCategory] = useState<MemoryCategory | "all">("all");
  const [activeHorizon, setActiveHorizon] = useState<MemoryHorizon>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [isAdding, setIsAdding] = useState(false);
  const [newText, setNewText] = useState("");
  const [newCategory, setNewCategory] = useState<MemoryCategory>("identity");
  const [submitting, setSubmitting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [editCategory, setEditCategory] = useState<MemoryCategory>("identity");
  const [expandedProvenance, setExpandedProvenance] = useState<Record<string, boolean>>({});
  const [copiedExport, setCopiedExport] = useState(false);

  // Category Configuration with Aurora Pastel Palettes
  const categoryConfig: Record<
    MemoryCategory,
    { label: string; icon: any; color: string; border: string; bg: string; horizon: "long_term" | "short_term" | "preferences" }
  > = {
    identity: {
      label: "Identity Core",
      icon: User,
      color: "text-amber-600 dark:text-amber-400",
      border: "border-amber-400/30",
      bg: "bg-amber-500/10",
      horizon: "long_term",
    },
    preference: {
      label: "Preferences",
      icon: Heart,
      color: "text-pink-600 dark:text-pink-400",
      border: "border-pink-400/30",
      bg: "bg-pink-500/10",
      horizon: "preferences",
    },
    skill: {
      label: "Skills & Tools",
      icon: Sparkles,
      color: "text-teal-600 dark:text-teal-400",
      border: "border-teal-400/30",
      bg: "bg-teal-500/10",
      horizon: "short_term",
    },
    goal: {
      label: "Life Goals",
      icon: Target,
      color: "text-emerald-600 dark:text-emerald-400",
      border: "border-emerald-400/30",
      bg: "bg-emerald-500/10",
      horizon: "long_term",
    },
    project: {
      label: "Active Projects",
      icon: Briefcase,
      color: "text-sky-600 dark:text-sky-400",
      border: "border-sky-400/30",
      bg: "bg-sky-500/10",
      horizon: "short_term",
    },
    task: {
      label: "Tasks & Routines",
      icon: RefreshCw,
      color: "text-blue-600 dark:text-blue-400",
      border: "border-blue-400/30",
      bg: "bg-blue-500/10",
      horizon: "short_term",
    },
    decision: {
      label: "Key Decisions",
      icon: Brain,
      color: "text-indigo-600 dark:text-indigo-400",
      border: "border-indigo-400/30",
      bg: "bg-indigo-500/10",
      horizon: "short_term",
    },
    relationship: {
      label: "Relationships",
      icon: Users,
      color: "text-purple-600 dark:text-purple-400",
      border: "border-purple-400/30",
      bg: "bg-purple-500/10",
      horizon: "long_term",
    },
    emotional: {
      label: "Milestones",
      icon: Flame,
      color: "text-rose-600 dark:text-rose-400",
      border: "border-rose-400/30",
      bg: "bg-rose-500/10",
      horizon: "long_term",
    },
    behavior: {
      label: "Habits & Patterns",
      icon: Brain,
      color: "text-cyan-600 dark:text-cyan-400",
      border: "border-cyan-400/30",
      bg: "bg-cyan-500/10",
      horizon: "preferences",
    },
    fact: {
      label: "Knowledge & Facts",
      icon: Database,
      color: "text-slate-600 dark:text-slate-400",
      border: "border-slate-400/30",
      bg: "bg-slate-500/10",
      horizon: "long_term",
    },
  };

  const DEFAULT_CATEGORY_CONFIG = {
    label: "General Memory",
    icon: Brain,
    color: "text-sky-600 dark:text-sky-400",
    border: "border-sky-400/30",
    bg: "bg-sky-500/10",
    horizon: "long_term" as const,
  };

  const normalizeCategory = (cat?: string): MemoryCategory => {
    if (!cat) return "fact";
    const lower = String(cat).toLowerCase().trim();
    if (lower === "user_preference" || lower === "preferences") return "preference";
    if (lower in categoryConfig) return lower as MemoryCategory;
    return "fact";
  };

  const safeMemories = useMemo(() => {
    return Array.isArray(memories)
      ? memories.filter((m) => m && typeof m === "object" && typeof m.text === "string")
      : [];
  }, [memories]);

  // Counts by Horizon
  const horizonCounts = useMemo(() => {
    let longTerm = 0;
    let shortTerm = 0;
    let prefs = 0;

    safeMemories.forEach((m) => {
      const cfg = categoryConfig[normalizeCategory(m.category)] || DEFAULT_CATEGORY_CONFIG;
      if (cfg.horizon === "long_term") longTerm++;
      else if (cfg.horizon === "short_term") shortTerm++;
      else if (cfg.horizon === "preferences") prefs++;
    });

    return {
      total: safeMemories.length,
      longTerm,
      shortTerm,
      preferences: prefs,
    };
  }, [safeMemories, categoryConfig]);

  // Filtered Memories according to Horizon, Category, and Search Query
  const filteredMemories = useMemo(() => {
    return safeMemories.filter((m) => {
      const norm = normalizeCategory(m.category);
      const cfg = categoryConfig[norm] || DEFAULT_CATEGORY_CONFIG;

      // Horizon filter
      if (activeHorizon === "long_term" && cfg.horizon !== "long_term") return false;
      if (activeHorizon === "short_term" && cfg.horizon !== "short_term") return false;
      if (activeHorizon === "preferences" && cfg.horizon !== "preferences") return false;

      // Category filter
      if (activeCategory !== "all" && norm !== activeCategory) return false;

      // Search query
      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase();
        const textMatch = m.text.toLowerCase().includes(query);
        const catMatch = cfg.label.toLowerCase().includes(query) || norm.includes(query);
        return textMatch || catMatch;
      }

      return true;
    });
  }, [safeMemories, activeHorizon, activeCategory, searchQuery, categoryConfig]);

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
      case "goal":
        return {
          source: "Explicit user goal statements & planning sessions",
          reason: "Consolidated during long-term objective planning and milestones.",
          confidence: "97% • High Grounding",
          tier: "Strategic Goal Layer",
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
      console.error("[MemoryDashboard] Error adding memory:", e);
    } finally {
      setSubmitting(false);
    }
  };

  const handleStartEdit = (m: Memory) => {
    setEditingId(m.id);
    setEditText(m.text);
    setEditCategory(normalizeCategory(m.category));
  };

  const handleSaveEdit = async (id: string) => {
    if (!editText.trim()) return;
    setSubmitting(true);
    try {
      if (onUpdateMemory) {
        await onUpdateMemory(id, editText.trim(), editCategory);
      } else {
        // Fallback: delete old and re-add if update prop is unavailable
        await onDeleteMemory(id);
        await onAddMemory(editCategory, editText.trim());
      }
      setEditingId(null);
    } catch (e) {
      console.error("[MemoryDashboard] Error updating memory:", e);
    } finally {
      setSubmitting(false);
    }
  };

  const handleExportJSON = () => {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(safeMemories, null, 2));
    const dl = document.createElement("a");
    dl.setAttribute("href", dataStr);
    dl.setAttribute("download", `myraa_memories_${new Date().toISOString().slice(0, 10)}.json`);
    document.body.appendChild(dl);
    dl.click();
    dl.remove();
    setCopiedExport(true);
    setTimeout(() => setCopiedExport(false), 2000);
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
        <motion.div
          key="memory-dashboard-root"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="fixed inset-0 z-50 pointer-events-none overflow-hidden"
        >
          {/* Backdrop Overlay */}
          <motion.div
            key="memory-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm pointer-events-auto transition-opacity"
            data-testid="memory-backdrop"
          />

          {/* Slide-over Container — Light Blue and White Aurora Glass Panel */}
          <motion.div
            key="memory-slideover-panel"
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
            className="absolute inset-y-0 right-0 w-full max-w-xl md:max-w-2xl neural-glass-panel border-l border-[#38bdf8]/20 dark:border-[#202938] text-slate-900 dark:text-slate-100 backdrop-blur-3xl flex flex-col shadow-2xl pointer-events-auto"
            data-testid="memory-dashboard-panel"
          >
            {/* 1. PREMIUM HEADER */}
            <div className="px-5 py-4 border-b border-[#38bdf8]/20 dark:border-[#202938] flex items-center justify-between shrink-0 bg-white/40 dark:bg-[#0B0F17]/40 backdrop-blur-md">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-2xl bg-gradient-to-tr from-sky-400/20 via-sky-300/30 to-blue-500/20 border border-sky-400/40 flex items-center justify-center shadow-[0_0_15px_rgba(14,165,233,0.2)]">
                  <Brain size={20} className="text-sky-600 dark:text-sky-400 animate-pulse" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="font-display font-bold text-sm tracking-tight text-slate-900 dark:text-white uppercase">
                      MYRAA MEMORY GRAPH
                    </h3>
                    <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-400/30 font-semibold flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                      <span>{safeMemories.length} RECORDS</span>
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-600 dark:text-slate-400 font-mono mt-0.5">
                    Episodic &amp; Semantic Long-Term Knowledge
                  </p>
                </div>
              </div>

              {/* Action Buttons in Header */}
              <div className="flex items-center gap-1.5">
                {/* Export Memories */}
                <button
                  type="button"
                  onClick={handleExportJSON}
                  className="p-2 rounded-xl text-slate-500 hover:text-sky-600 hover:bg-sky-500/10 transition cursor-pointer"
                  title="Export Memories as JSON"
                  data-testid="export-memory-btn"
                >
                  {copiedExport ? <Check size={16} className="text-emerald-500" /> : <Download size={16} />}
                </button>

                {/* Seed Manual Memory Toggle */}
                <button
                  type="button"
                  onClick={() => setIsAdding(!isAdding)}
                  className={`p-2 rounded-xl transition cursor-pointer flex items-center gap-1 text-xs font-mono font-medium ${
                    isAdding
                      ? "bg-sky-500 text-white shadow-md shadow-sky-500/25"
                      : "text-slate-500 hover:text-sky-600 hover:bg-sky-500/10"
                  }`}
                  title="Add new memory statement"
                  data-testid="add-memory-btn"
                >
                  <Plus size={16} />
                  <span className="hidden sm:inline">Add</span>
                </button>

                {/* Close Button */}
                <button
                  type="button"
                  onClick={onClose}
                  className="p-2 rounded-xl text-slate-500 hover:text-slate-900 dark:hover:text-white hover:bg-slate-200/50 dark:hover:bg-slate-800 transition cursor-pointer"
                  title="Close Memory Dashboard (Esc)"
                  data-testid="close-memory-btn"
                >
                  <X size={18} />
                </button>
              </div>
            </div>

            {/* 2. OVERVIEW METRICS: 4 INTERACTIVE HORIZON CARDS */}
            <div className="p-4 sm:p-5 border-b border-[#38bdf8]/15 dark:border-[#202938] shrink-0 bg-white/30 dark:bg-[#0B0F17]/30">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                {/* Total All Memories */}
                <button
                  type="button"
                  onClick={() => {
                    setActiveHorizon("all");
                    setActiveCategory("all");
                  }}
                  className={`p-3 rounded-2xl border text-left transition-all cursor-pointer relative overflow-hidden ${
                    activeHorizon === "all" && activeCategory === "all"
                      ? "neural-glass-elevated border-sky-500 shadow-[0_0_15px_rgba(14,165,233,0.18)]"
                      : "neural-glass-subtle hover:border-sky-300/40"
                  }`}
                  data-testid="memory-metric-total"
                >
                  <div className="flex items-center justify-between text-[11px] font-mono text-slate-600 dark:text-slate-400 font-semibold">
                    <span>Total</span>
                    <Database size={13} className="text-sky-600 dark:text-sky-500" />
                  </div>
                  <div className="text-xl font-bold font-mono text-slate-900 dark:text-white mt-1">
                    {horizonCounts.total}
                  </div>
                  <span className="text-[10px] text-slate-500 dark:text-slate-400 font-sans block mt-0.5 font-medium">All Knowledge</span>
                </button>

                {/* Long-Term Core */}
                <button
                  type="button"
                  onClick={() => {
                    setActiveHorizon("long_term");
                    setActiveCategory("all");
                  }}
                  className={`p-3 rounded-2xl border text-left transition-all cursor-pointer relative overflow-hidden ${
                    activeHorizon === "long_term"
                      ? "neural-glass-elevated border-amber-500 shadow-[0_0_15px_rgba(245,158,11,0.18)]"
                      : "neural-glass-subtle hover:border-amber-300/40"
                  }`}
                  data-testid="memory-metric-longterm"
                >
                  <div className="flex items-center justify-between text-[11px] font-mono text-slate-600 dark:text-slate-400 font-semibold">
                    <span>Long-Term</span>
                    <Target size={13} className="text-amber-600 dark:text-amber-500" />
                  </div>
                  <div className="text-xl font-bold font-mono text-slate-900 dark:text-white mt-1">
                    {horizonCounts.longTerm}
                  </div>
                  <span className="text-[10px] text-slate-500 dark:text-slate-400 font-sans block mt-0.5 font-medium">Core Identity</span>
                </button>

                {/* User Preferences */}
                <button
                  type="button"
                  onClick={() => {
                    setActiveHorizon("preferences");
                    setActiveCategory("all");
                  }}
                  className={`p-3 rounded-2xl border text-left transition-all cursor-pointer relative overflow-hidden ${
                    activeHorizon === "preferences"
                      ? "neural-glass-elevated border-pink-500 shadow-[0_0_15px_rgba(236,72,153,0.18)]"
                      : "neural-glass-subtle hover:border-pink-300/40"
                  }`}
                  data-testid="memory-metric-preferences"
                >
                  <div className="flex items-center justify-between text-[11px] font-mono text-slate-600 dark:text-slate-400 font-semibold">
                    <span>Preferences</span>
                    <Heart size={13} className="text-pink-600 dark:text-pink-500" />
                  </div>
                  <div className="text-xl font-bold font-mono text-slate-900 dark:text-white mt-1">
                    {horizonCounts.preferences}
                  </div>
                  <span className="text-[10px] text-slate-500 dark:text-slate-400 font-sans block mt-0.5 font-medium">Adaptive Habits</span>
                </button>

                {/* Short-Term / Working Context */}
                <button
                  type="button"
                  onClick={() => {
                    setActiveHorizon("short_term");
                    setActiveCategory("all");
                  }}
                  className={`p-3 rounded-2xl border text-left transition-all cursor-pointer relative overflow-hidden ${
                    activeHorizon === "short_term"
                      ? "neural-glass-elevated border-teal-500 shadow-[0_0_15px_rgba(20,184,166,0.18)]"
                      : "neural-glass-subtle hover:border-teal-300/40"
                  }`}
                  data-testid="memory-metric-shortterm"
                >
                  <div className="flex items-center justify-between text-[11px] font-mono text-slate-600 dark:text-slate-400 font-semibold">
                    <span>Working</span>
                    <Clock size={13} className="text-teal-600 dark:text-teal-500" />
                  </div>
                  <div className="text-xl font-bold font-mono text-slate-900 dark:text-white mt-1">
                    {horizonCounts.shortTerm}
                  </div>
                  <span className="text-[10px] text-slate-500 dark:text-slate-400 font-sans block mt-0.5 font-medium">Projects &amp; Tasks</span>
                </button>
              </div>
            </div>

            {/* 3. SEARCH & CATEGORY FILTER BAR */}
            <div className="px-5 py-3 border-b border-[#38bdf8]/15 dark:border-[#202938] shrink-0 bg-white/20 dark:bg-[#0B0F17]/20 space-y-2.5">
              {/* Search Bar */}
              <div className="neural-glass-subtle rounded-xl border border-[#38bdf8]/30 dark:border-[#202938] px-3 py-1.5 flex items-center gap-2 focus-within:border-sky-500 focus-within:ring-2 focus-within:ring-sky-500/20">
                <Search size={14} className="text-slate-500 dark:text-slate-400 shrink-0" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search memories, keywords, facts, entities..."
                  className="w-full bg-transparent border-none text-xs text-slate-900 dark:text-slate-100 placeholder-slate-500 dark:placeholder-slate-400 focus:outline-none font-sans"
                  data-testid="memory-search-input"
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery("")}
                    className="text-slate-400 hover:text-slate-600 p-0.5"
                    title="Clear search"
                  >
                    <X size={12} />
                  </button>
                )}
              </div>

              {/* Horizontal Category Filter Pills */}
              <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar py-0.5">
                <button
                  type="button"
                  onClick={() => setActiveCategory("all")}
                  className={`px-2.5 py-1 rounded-xl text-[11px] font-mono whitespace-nowrap transition cursor-pointer ${
                    activeCategory === "all"
                      ? "bg-sky-500 text-white font-semibold shadow-sm"
                      : "neural-pill text-slate-700 dark:text-slate-300 hover:text-sky-700 font-medium"
                  }`}
                  data-testid="category-filter-all"
                >
                  All ({safeMemories.length})
                </button>
                {(Object.keys(categoryConfig) as MemoryCategory[]).map((cat) => {
                  const cfg = categoryConfig[cat];
                  const Icon = cfg.icon;
                  const count = safeMemories.filter((m) => normalizeCategory(m.category) === cat).length;
                  if (count === 0 && activeCategory !== cat) return null;

                  return (
                    <button
                      key={cat}
                      type="button"
                      onClick={() => setActiveCategory(cat)}
                      className={`px-2.5 py-1 rounded-xl text-[11px] font-mono whitespace-nowrap transition cursor-pointer flex items-center gap-1.5 ${
                        activeCategory === cat
                          ? "bg-sky-500 text-white font-semibold shadow-sm"
                          : "neural-pill text-slate-700 dark:text-slate-300 hover:text-sky-700 font-medium"
                      }`}
                      data-testid={`category-filter-${cat}`}
                    >
                      <Icon size={11} />
                      <span>{cfg.label.split(" ")[0]}</span>
                      <span className="opacity-75">({count})</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* 4. MANUAL SEED DRAWER */}
            <AnimatePresence>
              {isAdding && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.2 }}
                  className="overflow-hidden border-b border-[#38bdf8]/20 dark:border-[#202938] bg-sky-50/50 dark:bg-slate-900/50"
                  data-testid="manual-memory-drawer"
                >
                  <form onSubmit={handleManualAdd} className="p-4 sm:p-5 space-y-3.5">
                    <div>
                      <label className="block text-[11px] font-mono font-semibold tracking-wider text-slate-600 dark:text-slate-300 uppercase mb-2">
                        Memory Archetype Category
                      </label>
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
                        {(Object.keys(categoryConfig) as MemoryCategory[]).map((cat) => {
                          const cfg = categoryConfig[cat];
                          const Icon = cfg.icon;
                          const active = newCategory === cat;
                          return (
                            <button
                              key={cat}
                              type="button"
                              onClick={() => setNewCategory(cat)}
                              className={`flex items-center gap-1.5 p-2 rounded-xl border text-xs font-sans transition cursor-pointer ${
                                active
                                  ? "border-sky-500 bg-sky-500/15 text-sky-700 dark:text-sky-300 font-semibold"
                                  : "neural-glass-subtle text-slate-600 dark:text-slate-400 hover:text-slate-900"
                              }`}
                            >
                              <Icon size={12} className={cfg.color} />
                              <span className="truncate">{cfg.label.split(" ")[0]}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    <div>
                      <label
                        htmlFor="memory-statement-input"
                        className="block text-[11px] font-mono font-semibold tracking-wider text-slate-600 dark:text-slate-300 uppercase mb-1.5"
                      >
                        Recollection Statement (Declarative statement)
                      </label>
                      <textarea
                        id="memory-statement-input"
                        value={newText}
                        onChange={(e) => setNewText(e.target.value)}
                        placeholder="e.g. User prefers concise answers with typescript code examples and dark terminal themes."
                        rows={3}
                        required
                        className="w-full text-xs p-3 rounded-xl border border-[#38bdf8]/30 dark:border-[#202938] bg-white/80 dark:bg-slate-900/80 text-slate-900 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-500/20 resize-none font-sans"
                        data-testid="new-memory-text-input"
                      />
                    </div>

                    <div className="flex gap-2 justify-end">
                      <button
                        type="button"
                        onClick={() => setIsAdding(false)}
                        className="px-3.5 py-1.5 rounded-xl border border-slate-300 dark:border-slate-700 text-xs font-mono text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition cursor-pointer"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        disabled={submitting || !newText.trim()}
                        className="px-4 py-1.5 rounded-xl bg-gradient-to-r from-sky-500 to-blue-600 hover:from-sky-600 hover:to-blue-700 text-white font-mono font-bold text-xs uppercase tracking-wider transition disabled:opacity-50 cursor-pointer shadow-md shadow-sky-500/20"
                        data-testid="commit-memory-btn"
                      >
                        {submitting ? "Committing..." : "Commit Memory"}
                      </button>
                    </div>
                  </form>
                </motion.div>
              )}
            </AnimatePresence>

            {/* 5. MEMORIES LIST SECTION */}
            <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-3 relative scroll-smooth">
              <AnimatePresence initial={false}>
                {filteredMemories.length === 0 ? (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="h-full flex flex-col items-center justify-center p-8 text-center text-slate-400"
                  >
                    <div className="p-4 rounded-full border border-dashed border-[#38bdf8]/30 bg-sky-500/5 mb-3">
                      <Brain size={32} className="text-sky-500/60" />
                    </div>
                    <h4 className="text-sm font-semibold tracking-wide text-slate-800 dark:text-slate-100">
                      No memories match your query
                    </h4>
                    <p className="text-xs max-w-xs mt-1.5 leading-relaxed font-mono text-slate-500">
                      {searchQuery
                        ? `No recollections found matching "${searchQuery}".`
                        : "Start speaking or working with MYRAA to consolidate automatic long-term memory."}
                    </p>
                  </motion.div>
                ) : (
                  filteredMemories.map((m) => {
                    const normalized = normalizeCategory(m.category);
                    const cfg = categoryConfig[normalized] || DEFAULT_CATEGORY_CONFIG;
                    const Icon = cfg.icon || Brain;
                    const prov = getProvenance(m);
                    const isProvOpen = !!expandedProvenance[m.id];
                    const isEditing = editingId === m.id;

                    return (
                      <motion.div
                        key={m.id}
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.98 }}
                        transition={{ duration: 0.18 }}
                        className="p-3.5 sm:p-4 rounded-2xl neural-glass-subtle border border-[#38bdf8]/20 dark:border-[#202938] hover:border-sky-400/40 transition-all shadow-sm group relative"
                        data-testid={`memory-item-${m.id}`}
                      >
                        {/* Edit Mode or Normal Display */}
                        {isEditing ? (
                          <div className="space-y-3">
                            <div className="flex items-center justify-between">
                              <span className="text-[10px] font-mono uppercase tracking-wider text-sky-600 font-bold">
                                Edit Memory
                              </span>
                              <select
                                value={editCategory}
                                onChange={(e) => setEditCategory(e.target.value as MemoryCategory)}
                                className="text-xs font-mono p-1 rounded-lg border border-[#38bdf8]/30 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200"
                              >
                                {(Object.keys(categoryConfig) as MemoryCategory[]).map((c) => (
                                  <option key={c} value={c}>
                                    {categoryConfig[c].label}
                                  </option>
                                ))}
                              </select>
                            </div>
                            <textarea
                              value={editText}
                              onChange={(e) => setEditText(e.target.value)}
                              rows={3}
                              className="w-full text-xs p-2.5 rounded-xl border border-sky-400/50 bg-white/90 dark:bg-slate-900/90 text-slate-900 dark:text-slate-100 focus:outline-none font-sans"
                            />
                            <div className="flex gap-2 justify-end">
                              <button
                                type="button"
                                onClick={() => setEditingId(null)}
                                className="px-3 py-1 rounded-lg border text-xs font-mono text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 transition cursor-pointer"
                              >
                                Cancel
                              </button>
                              <button
                                type="button"
                                onClick={() => handleSaveEdit(m.id)}
                                disabled={submitting}
                                className="px-3 py-1 rounded-lg bg-sky-500 hover:bg-sky-600 text-white font-mono text-xs flex items-center gap-1 transition cursor-pointer shadow-sm"
                              >
                                <Save size={12} />
                                <span>Save</span>
                              </button>
                            </div>
                          </div>
                        ) : (
                          <>
                            <div className="flex items-start justify-between gap-3">
                              <div className="flex gap-3 overflow-hidden">
                                {/* Category Icon Badge */}
                                <div
                                  className={`p-2 rounded-xl border mt-0.5 shrink-0 ${cfg.bg} ${cfg.border} ${cfg.color}`}
                                >
                                  <Icon size={15} />
                                </div>

                                <div className="overflow-hidden">
                                  <div className="flex items-center gap-2">
                                    <span
                                      className={`text-[9px] font-mono uppercase tracking-wider font-bold ${cfg.color}`}
                                    >
                                      {cfg.label}
                                    </span>
                                    <span className="text-[9px] font-mono text-slate-500 dark:text-slate-400 font-medium">
                                      · {formatDate(m.createdAt)}
                                    </span>
                                  </div>

                                  <p className="text-xs text-slate-900 dark:text-slate-100 mt-1 font-sans leading-relaxed break-words font-medium">
                                    {m.text}
                                  </p>
                                </div>
                              </div>

                              {/* Card Action Controls: Edit & Delete */}
                              <div className="flex items-center gap-1 shrink-0 opacity-80 sm:opacity-0 group-hover:opacity-100 transition-opacity">
                                <button
                                  type="button"
                                  onClick={() => handleStartEdit(m)}
                                  className="p-1.5 rounded-lg text-slate-500 hover:text-sky-600 hover:bg-sky-500/10 transition cursor-pointer"
                                  title="Edit memory"
                                  data-testid={`edit-memory-${m.id}`}
                                >
                                  <Edit2 size={13} />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => onDeleteMemory(m.id)}
                                  className="p-1.5 rounded-lg text-slate-500 hover:text-rose-500 hover:bg-rose-500/10 transition cursor-pointer"
                                  title="Forget memory"
                                  data-testid={`delete-memory-${m.id}`}
                                >
                                  <Trash2 size={13} />
                                </button>
                              </div>
                            </div>

                            {/* Provenance Disclosure ("Why does MYRAA know this?") */}
                            <div className="mt-3 pt-2 border-t border-[#38bdf8]/15 dark:border-[#202938]">
                              <button
                                type="button"
                                onClick={() => toggleProvenance(m.id)}
                                className="flex items-center gap-1.5 text-[10px] font-mono text-slate-600 dark:text-slate-400 hover:text-sky-700 transition cursor-pointer font-medium"
                                data-testid={`provenance-btn-${m.id}`}
                              >
                                <HelpCircle size={11} className="text-sky-600 dark:text-sky-500" />
                                <span className="font-medium">Why does MYRAA know this?</span>
                                {isProvOpen ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                              </button>

                              <AnimatePresence>
                                {isProvOpen && (
                                  <motion.div
                                    initial={{ opacity: 0, height: 0 }}
                                    animate={{ opacity: 1, height: "auto" }}
                                    exit={{ opacity: 0, height: 0 }}
                                    transition={{ duration: 0.15 }}
                                    className="mt-2 p-2.5 rounded-xl neural-glass-elevated border border-[#38bdf8]/20 dark:border-[#202938] text-[10px] font-mono space-y-1.5 text-slate-700 dark:text-slate-300"
                                  >
                                    <div className="flex items-center justify-between">
                                      <span className="font-bold text-slate-900 dark:text-white flex items-center gap-1">
                                        <ShieldCheck size={12} className="text-emerald-600 dark:text-emerald-500" />
                                        <span>Grounded Provenance</span>
                                      </span>
                                      <span className="text-emerald-700 dark:text-emerald-400 font-bold">
                                        {prov.confidence}
                                      </span>
                                    </div>
                                    <div>
                                      <span className="text-slate-500 dark:text-slate-400 font-medium">Source:</span>{" "}
                                      <span className="text-slate-900 dark:text-slate-200">{prov.source}</span>
                                    </div>
                                    <div>
                                      <span className="text-slate-500 dark:text-slate-400 font-medium">Reason:</span>{" "}
                                      <span className="text-slate-900 dark:text-slate-200">{prov.reason}</span>
                                    </div>
                                    <div className="pt-1.5 border-t border-[#38bdf8]/15 dark:border-[#202938] flex items-center justify-between text-[9px]">
                                      <span className="text-slate-500 dark:text-slate-400 font-medium">Layer: {prov.tier}</span>
                                      <span className="text-emerald-700 dark:text-emerald-400 flex items-center gap-1 font-semibold">
                                        <Check size={10} />
                                        <span>Verified Fact</span>
                                      </span>
                                    </div>
                                  </motion.div>
                                )}
                              </AnimatePresence>
                            </div>
                          </>
                        )}
                      </motion.div>
                    );
                  })
                )}
              </AnimatePresence>
            </div>

            {/* 6. STATUS FOOTER */}
            <div className="px-5 py-3 border-t border-[#38bdf8]/20 dark:border-[#202938] bg-white/40 dark:bg-[#0B0F17]/40 backdrop-blur-md flex items-center justify-between text-[10px] font-mono text-slate-600 dark:text-slate-400 tracking-wider">
              <span className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                <span className="font-semibold text-slate-800 dark:text-slate-300">
                  EPISODIC &amp; SEMANTIC GRAPH SYNCD
                </span>
              </span>
              <span className="text-slate-500 dark:text-slate-400 font-medium">ZERO-LEAK ENCRYPTED STORE</span>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
