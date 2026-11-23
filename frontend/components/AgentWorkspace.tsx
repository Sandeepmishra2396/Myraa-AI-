import React, { useState } from "react";
import { 
  Bot, 
  X, 
  ArrowDown, 
  ArrowDownRight, 
  ArrowDownLeft, 
  ShieldCheck, 
  Cpu, 
  Code2, 
  Search, 
  Terminal, 
  CheckCircle2, 
  AlertCircle,
  FileCode,
  Layers,
  Sparkles
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

interface AgentWorkspaceProps {
  isOpen: boolean;
  onClose: () => void;
  themeColor?: string;
}

type AgentId = "PLANNER" | "RESEARCHER" | "CODER" | "CRITIC" | "VERIFIER" | "EXECUTOR";

interface AgentProfile {
  id: AgentId;
  name: string;
  role: string;
  authority: "PROPOSE_ONLY" | "GATEKEEPING" | "GATED_EXECUTION";
  status: "ACTIVE" | "READY" | "MONITORING" | "VERIFIED" | "GUARDED";
  color: string;
  border: string;
  bg: string;
  description: string;
  tools: string[];
  recentAction: string;
}

const AGENTS: Record<AgentId, AgentProfile> = {
  PLANNER: {
    id: "PLANNER",
    name: "PLANNER",
    role: "Goal Decomposition & TaskGraph Synthesis",
    authority: "PROPOSE_ONLY",
    status: "ACTIVE",
    color: "text-[#00F0FF]",
    border: "border-[#00F0FF]/40",
    bg: "bg-[#00F0FF]/10",
    description: "Breaks high-level user requests into dependency-ordered atomic plans, identifying risk gates and required tools.",
    tools: ["planGoal", "checkpointManager", "estimateCost"],
    recentAction: "Synthesized 4-stage UI & architecture execution graph for Neural Glass OS.",
  },
  RESEARCHER: {
    id: "RESEARCHER",
    name: "RESEARCHER",
    role: "Multi-Source Evidence Gathering & Grounding",
    authority: "PROPOSE_ONLY",
    status: "READY",
    color: "text-[#3B82F6]",
    border: "border-[#3B82F6]/40",
    bg: "bg-[#3B82F6]/10",
    description: "Performs autonomous browser and documentation research, extracting atomic claims, reliability scores, and citations.",
    tools: ["researchWeb", "fetchUrl", "crossCheckClaims", "sanitizeContent"],
    recentAction: "Fetched official specs for modern UI glass architecture & Gemini Live API.",
  },
  CODER: {
    id: "CODER",
    name: "CODER",
    role: "AST Code Modification & Patch Generation",
    authority: "PROPOSE_ONLY",
    status: "ACTIVE",
    color: "text-[#8B5CF6]",
    border: "border-[#8B5CF6]/40",
    bg: "bg-[#8B5CF6]/10",
    description: "Generates type-safe modifications, component additions, and bug fixes without directly bypassing the Security Gate.",
    tools: ["editFile", "createFile", "analyzeAst", "generateDiff"],
    recentAction: "Rendered Memory UI 2x2 grid, Research Workspace & Agent Pipeline flow.",
  },
  CRITIC: {
    id: "CRITIC",
    name: "CRITIC",
    role: "Security Audit, DLP & Heuristic Evaluation",
    authority: "GATEKEEPING",
    status: "MONITORING",
    color: "text-amber-400",
    border: "border-amber-500/40",
    bg: "bg-amber-500/10",
    description: "Inspects code diffs for secrets, injection vulnerabilities, unintended deletions, or policy non-compliance.",
    tools: ["dlpScanner", "policyEngine", "riskEvaluator"],
    recentAction: "Passed zero-trust check on frontend diffs. No unauthorized system calls.",
  },
  VERIFIER: {
    id: "VERIFIER",
    name: "VERIFIER",
    role: "Test Execution, Typecheck & Quality Assurance",
    authority: "GATEKEEPING",
    status: "VERIFIED",
    color: "text-[#10B981]",
    border: "border-[#10B981]/40",
    bg: "bg-[#10B981]/10",
    description: "Executes unit and integration test suites, validates TypeScript compilation, and asserts evidence before release.",
    tools: ["runVitest", "runTsc", "assertEvidence"],
    recentAction: "34 / 34 integration tests passed with exit code 0.",
  },
  EXECUTOR: {
    id: "EXECUTOR",
    name: "EXECUTOR",
    role: "Security Authority-Gated Tool Dispatch",
    authority: "GATED_EXECUTION",
    status: "GUARDED",
    color: "text-[#F4F7FB]",
    border: "border-emerald-500/40",
    bg: "bg-emerald-500/10",
    description: "Carries out real file system writes and OS executions strictly upon receiving cryptographically valid Security Decision tokens.",
    tools: ["atomicCommit", "dispatchTool", "emergencyStopGate"],
    recentAction: "Committed verified changes with safe isolation guarantees.",
  },
};

export function AgentWorkspace({
  isOpen,
  onClose,
}: AgentWorkspaceProps) {
  const [selectedAgent, setSelectedAgent] = useState<AgentId>("PLANNER");

  const agent = AGENTS[selectedAgent];

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/75 z-40 backdrop-blur-md"
          />

          {/* Full Screen Agent Workspace Modal */}
          <motion.div
            initial={{ opacity: 0, scale: 0.97, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 12 }}
            transition={{ type: "spring", damping: 25, stiffness: 220 }}
            className="fixed inset-4 sm:inset-10 z-50 rounded-2xl bg-[#05070D]/95 border border-[#202938] text-[#F4F7FB] backdrop-blur-2xl flex flex-col overflow-hidden shadow-[0_0_60px_rgba(0,0,0,0.85)] max-w-6xl mx-auto"
          >
            {/* Header: MYRAA AGENTS */}
            <div className="px-6 py-4.5 border-b border-[#202938]/80 flex items-center justify-between shrink-0 bg-[#0B0F17]/60">
              <div className="flex items-center gap-3">
                <div className="p-2.5 rounded-xl border border-[#8B5CF6]/30 bg-[#8B5CF6]/10 text-[#8B5CF6]">
                  <Bot size={20} className="animate-pulse" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="font-display font-bold text-lg tracking-[0.22em] text-[#F4F7FB] uppercase">
                      MYRAA AGENTS
                    </h2>
                    <span className="text-[9px] font-mono tracking-widest text-[#8B5CF6] px-2 py-0.5 rounded-full border border-[#8B5CF6]/30 bg-[#8B5CF6]/10">
                      MULTI-AGENT CORE
                    </span>
                  </div>
                  <p className="text-[11px] font-mono text-[#8994A6] mt-0.5">
                    Separation of Intelligence &amp; Authoritative Security Gatekeeping
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={onClose}
                  className="p-2 rounded-xl border border-[#202938] bg-[#111722]/80 hover:bg-[#111722] text-[#8994A6] hover:text-[#F4F7FB] transition cursor-pointer"
                >
                  <X size={18} />
                </button>
              </div>
            </div>

            {/* Content Area: Pipeline Flow Graph on Left/Center, Dossier on Right */}
            <div className="flex-1 overflow-y-auto p-6 grid grid-cols-1 lg:grid-cols-12 gap-6">
              {/* 12. AGENT PIPELINE VISUAL GRAPH */}
              <div className="lg:col-span-7 flex flex-col items-center justify-center p-6 rounded-2xl border border-[#202938] bg-[#0B0F17]/60 space-y-2">
                <div className="w-full flex items-center justify-between pb-3 border-b border-[#202938]/60 text-[11px] font-mono text-[#8994A6]">
                  <span>REASONING PIPELINE FLOW</span>
                  <span className="text-[#10B981]">6 SPECIALIZED AGENTS ONLINE</span>
                </div>

                {/* NODE: PLANNER */}
                <button
                  onClick={() => setSelectedAgent("PLANNER")}
                  className={`w-64 p-3.5 rounded-xl border text-center transition-all cursor-pointer relative ${
                    selectedAgent === "PLANNER"
                      ? "bg-[#111722] border-[#00F0FF] shadow-[0_0_20px_rgba(0,240,255,0.25)] scale-105"
                      : "bg-[#0B0F17] border-[#202938] hover:border-[#202938]/90"
                  }`}
                >
                  <div className="text-xs font-mono font-bold tracking-widest text-[#00F0FF]">
                    PLANNER
                  </div>
                  <div className="text-[10px] text-[#8994A6] mt-0.5">Goal Decomposition</div>
                  <div className="absolute top-2 right-2 w-1.5 h-1.5 rounded-full bg-[#00F0FF] animate-pulse" />
                </button>

                {/* Arrow */}
                <div className="flex flex-col items-center py-0.5 text-[#8994A6]">
                  <span className="text-xs font-mono">↓</span>
                </div>

                {/* NODE: RESEARCHER */}
                <button
                  onClick={() => setSelectedAgent("RESEARCHER")}
                  className={`w-64 p-3.5 rounded-xl border text-center transition-all cursor-pointer relative ${
                    selectedAgent === "RESEARCHER"
                      ? "bg-[#111722] border-[#3B82F6] shadow-[0_0_20px_rgba(59,130,246,0.25)] scale-105"
                      : "bg-[#0B0F17] border-[#202938] hover:border-[#202938]/90"
                  }`}
                >
                  <div className="text-xs font-mono font-bold tracking-widest text-[#3B82F6]">
                    RESEARCHER
                  </div>
                  <div className="text-[10px] text-[#8994A6] mt-0.5">Evidence &amp; Grounding</div>
                  <div className="absolute top-2 right-2 w-1.5 h-1.5 rounded-full bg-[#3B82F6]" />
                </button>

                {/* Arrow */}
                <div className="flex flex-col items-center py-0.5 text-[#8994A6]">
                  <span className="text-xs font-mono">↓</span>
                </div>

                {/* NODE: CODER */}
                <button
                  onClick={() => setSelectedAgent("CODER")}
                  className={`w-64 p-3.5 rounded-xl border text-center transition-all cursor-pointer relative ${
                    selectedAgent === "CODER"
                      ? "bg-[#111722] border-[#8B5CF6] shadow-[0_0_20px_rgba(139,92,246,0.25)] scale-105"
                      : "bg-[#0B0F17] border-[#202938] hover:border-[#202938]/90"
                  }`}
                >
                  <div className="text-xs font-mono font-bold tracking-widest text-[#8B5CF6]">
                    CODER
                  </div>
                  <div className="text-[10px] text-[#8994A6] mt-0.5">AST Patch Synthesis</div>
                  <div className="absolute top-2 right-2 w-1.5 h-1.5 rounded-full bg-[#8B5CF6] animate-pulse" />
                </button>

                {/* Split Branch Arrows */}
                <div className="flex items-center justify-center gap-28 py-0.5 text-[#8994A6]">
                  <span className="text-xs font-mono">↙</span>
                  <span className="text-xs font-mono">↘</span>
                </div>

                {/* NODES: CRITIC & VERIFIER (Parallel) */}
                <div className="flex items-center justify-center gap-6">
                  {/* CRITIC */}
                  <button
                    onClick={() => setSelectedAgent("CRITIC")}
                    className={`w-40 p-3 rounded-xl border text-center transition-all cursor-pointer relative ${
                      selectedAgent === "CRITIC"
                        ? "bg-[#111722] border-amber-400 shadow-[0_0_20px_rgba(245,158,11,0.25)] scale-105"
                        : "bg-[#0B0F17] border-[#202938] hover:border-[#202938]/90"
                    }`}
                  >
                    <div className="text-xs font-mono font-bold tracking-widest text-amber-400">
                      CRITIC
                    </div>
                    <div className="text-[10px] text-[#8994A6] mt-0.5">Security Audit</div>
                    <div className="absolute top-2 right-2 w-1.5 h-1.5 rounded-full bg-amber-400" />
                  </button>

                  {/* VERIFIER */}
                  <button
                    onClick={() => setSelectedAgent("VERIFIER")}
                    className={`w-40 p-3 rounded-xl border text-center transition-all cursor-pointer relative ${
                      selectedAgent === "VERIFIER"
                        ? "bg-[#111722] border-[#10B981] shadow-[0_0_20px_rgba(16,185,129,0.25)] scale-105"
                        : "bg-[#0B0F17] border-[#202938] hover:border-[#202938]/90"
                    }`}
                  >
                    <div className="text-xs font-mono font-bold tracking-widest text-[#10B981]">
                      VERIFIER
                    </div>
                    <div className="text-[10px] text-[#8994A6] mt-0.5">Tests &amp; Types</div>
                    <div className="absolute top-2 right-2 w-1.5 h-1.5 rounded-full bg-[#10B981]" />
                  </button>
                </div>

                {/* Converge Arrow */}
                <div className="flex flex-col items-center py-0.5 text-[#8994A6]">
                  <span className="text-xs font-mono">↓</span>
                </div>

                {/* NODE: EXECUTOR */}
                <button
                  onClick={() => setSelectedAgent("EXECUTOR")}
                  className={`w-64 p-3.5 rounded-xl border text-center transition-all cursor-pointer relative ${
                    selectedAgent === "EXECUTOR"
                      ? "bg-[#111722] border-emerald-400 shadow-[0_0_20px_rgba(16,185,129,0.3)] scale-105"
                      : "bg-[#0B0F17] border-[#202938] hover:border-[#202938]/90"
                  }`}
                >
                  <div className="text-xs font-mono font-bold tracking-widest text-emerald-400">
                    EXECUTOR
                  </div>
                  <div className="text-[10px] text-[#8994A6] mt-0.5">Security-Gated Apply</div>
                  <div className="absolute top-2 right-2 w-1.5 h-1.5 rounded-full bg-emerald-400" />
                </button>
              </div>

              {/* AGENT DOSSIER / INSPECTOR ON RIGHT */}
              <div className="lg:col-span-5 p-5 rounded-2xl border border-[#202938] bg-[#0B0F17]/80 flex flex-col justify-between space-y-4">
                <div className="space-y-4">
                  <div className="flex items-center justify-between pb-3 border-b border-[#202938]">
                    <div className="flex items-center gap-2">
                      <Bot size={16} className={agent.color} />
                      <h3 className="text-sm font-mono font-bold tracking-widest text-[#F4F7FB]">
                        {agent.name}
                      </h3>
                    </div>
                    <span className={`text-[10px] font-mono px-2 py-0.5 rounded-full border ${agent.border} ${agent.bg} ${agent.color}`}>
                      {agent.status}
                    </span>
                  </div>

                  <div>
                    <div className="text-[10px] font-mono text-[#8994A6] uppercase tracking-wider">Role Definition</div>
                    <p className="text-xs font-medium text-[#F4F7FB] mt-0.5 leading-relaxed">
                      {agent.role}
                    </p>
                  </div>

                  <div>
                    <div className="text-[10px] font-mono text-[#8994A6] uppercase tracking-wider">Operational Description</div>
                    <p className="text-xs text-[#8994A6] mt-1 leading-relaxed">
                      {agent.description}
                    </p>
                  </div>

                  <div>
                    <div className="text-[10px] font-mono text-[#8994A6] uppercase tracking-wider">Authority Boundary</div>
                    <div className="mt-1 flex items-center gap-1.5">
                      <ShieldCheck size={13} className={agent.authority === "PROPOSE_ONLY" ? "text-[#00F0FF]" : "text-emerald-400"} />
                      <span className="text-xs font-mono font-bold text-[#F4F7FB]">
                        {agent.authority}
                      </span>
                    </div>
                    <p className="text-[10px] text-[#8994A6] mt-0.5">
                      {agent.authority === "PROPOSE_ONLY"
                        ? "Zero authoritative permissions. Can only propose actions to Security Gate."
                        : "Authoritative decision or gated execution requiring verification signature."}
                    </p>
                  </div>

                  <div>
                    <div className="text-[10px] font-mono text-[#8994A6] uppercase tracking-wider mb-1.5">Permitted Tools</div>
                    <div className="flex flex-wrap gap-1.5">
                      {agent.tools.map((t) => (
                        <span key={t} className="px-2 py-0.5 rounded bg-[#111722] border border-[#202938] text-[10px] font-mono text-[#8994A6]">
                          {t}
                        </span>
                      ))}
                    </div>
                  </div>

                  <div className="p-3 rounded-xl bg-[#05070D] border border-[#202938]">
                    <div className="text-[10px] font-mono text-[#8994A6] uppercase tracking-wider">Recent Activity</div>
                    <div className="text-xs text-[#F4F7FB] mt-1 font-mono leading-relaxed">
                      &gt; {agent.recentAction}
                    </div>
                  </div>
                </div>

                <div className="pt-3 border-t border-[#202938] flex items-center justify-between text-[10px] font-mono text-[#8994A6]">
                  <span>INTER-AGENT IPC</span>
                  <span className="text-emerald-400">NONCE VERIFIED</span>
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="px-6 py-3 border-t border-[#202938] bg-[#0B0F17]/90 flex items-center justify-between text-[10px] font-mono text-[#8994A6]">
              <span>PHASE 26: SECURITY + INTELLIGENCE SEPARATION PROTOCOL</span>
              <span className="text-[#10B981]">PROPOSE ONLY → GATEKEEPING → EXECUTOR</span>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
