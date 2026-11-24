import React, { useState, useEffect, useMemo, useCallback } from "react";
import {
  Briefcase,
  X,
  Plus,
  Search,
  CheckCircle2,
  Clock,
  AlertCircle,
  GitBranch,
  GitCommit,
  Layers,
  Sparkles,
  RefreshCw,
  FolderGit2,
  ChevronRight,
  ExternalLink,
  Trash2,
  Archive,
  Check,
  FileCode,
  Terminal,
  Calendar,
  ArrowUpRight,
  BarChart3,
  Edit2,
  Save,
  CheckSquare,
  Square,
  ShieldAlert,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import type {
  ProjectContext,
  ProjectTask,
  TaskStatus,
  ProjectGitInfo,
  ArchitectureMap,
  ProjectType,
} from "../lib/projectTypes";

export interface ProjectsDashboardProps {
  isOpen: boolean;
  onClose: () => void;
  activeProject?: ProjectContext | null;
  onRefreshProject?: () => Promise<void>;
  themeColor?: string;
}

type TabType = "projects" | "tasks" | "architecture" | "git";
type ProjectFilter = "all" | "active" | "completed" | "archived";

export function ProjectsDashboard({
  isOpen,
  onClose,
  activeProject: propActiveProject,
  onRefreshProject,
  themeColor = "#0284c7",
}: ProjectsDashboardProps) {
  // Main Navigation & Filter States
  const [activeTab, setActiveTab] = useState<TabType>("projects");
  const [projectFilter, setProjectFilter] = useState<ProjectFilter>("all");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [taskStatusFilter, setTaskStatusFilter] = useState<TaskStatus | "all">("all");

  // Project Data States
  const [projectsList, setProjectsList] = useState<ProjectContext[]>([]);
  const [currentProject, setCurrentProject] = useState<ProjectContext | null>(propActiveProject || null);
  const [gitInfo, setGitInfo] = useState<ProjectGitInfo | null>(null);
  const [architecture, setArchitecture] = useState<ArchitectureMap | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // New Project / Analyze Modal State
  const [isCreatingProject, setIsCreatingProject] = useState<boolean>(false);
  const [newProjectName, setNewProjectName] = useState<string>("");
  const [newProjectPath, setNewProjectPath] = useState<string>("");
  const [newProjectSummary, setNewProjectSummary] = useState<string>("");
  const [newProjectType, setNewProjectType] = useState<ProjectType>("node_typescript");

  // New Task State
  const [isAddingTask, setIsAddingTask] = useState<boolean>(false);
  const [newTaskTitle, setNewTaskTitle] = useState<string>("");
  const [newTaskDescription, setNewTaskDescription] = useState<string>("");
  const [newTaskStatus, setNewTaskStatus] = useState<TaskStatus>("todo");
  const [newTaskPriority, setNewTaskPriority] = useState<"high" | "medium" | "low">("medium");

  // Sync prop changes to local state
  useEffect(() => {
    if (propActiveProject) {
      setCurrentProject(propActiveProject);
    }
  }, [propActiveProject]);

  // Fetch all projects and active project on open
  const fetchDashboardData = useCallback(async () => {
    setIsLoading(true);
    setErrorMsg(null);
    try {
      // 1. Fetch active project
      const activeRes = await fetch("/api/projects/active");
      if (activeRes.ok) {
        const activeData: ProjectContext = await activeRes.json();
        setCurrentProject(activeData);
      }

      // 2. Fetch all projects list
      const listRes = await fetch("/api/projects");
      if (listRes.ok) {
        const listData = await listRes.json();
        if (listData && Array.isArray(listData.projects)) {
          setProjectsList(listData.projects);
        }
      }

      // 3. Fetch git info
      const gitRes = await fetch("/api/projects/git");
      if (gitRes.ok) {
        const gitData: ProjectGitInfo = await gitRes.json();
        setGitInfo(gitData);
      }

      // 4. Fetch architecture
      const archRes = await fetch("/api/projects/architecture");
      if (archRes.ok) {
        const archData: ArchitectureMap = await archRes.json();
        setArchitecture(archData);
      }
    } catch (err: any) {
      console.warn("[ProjectsDashboard] Error loading projects data:", err);
      // Graceful fallback to default mock if offline
      if (!currentProject) {
        const fallbackProject: ProjectContext = {
          id: "sora-ai-default",
          name: "MYRAA Desktop Core",
          rootPath: "d:/SORA AI/Sora AI",
          type: "node_typescript",
          primaryLanguage: "TypeScript",
          frameworks: ["React", "Electron", "TailwindCSS", "Node.js", "Gemini 2.0"],
          summary: "Autonomous multithreaded AI companion with real-time video avatars and local project intelligence.",
          status: "active",
          tasks: [
            { id: "t-1", title: "Complete Phase 5B Projects Dashboard Redesign", description: "Design soft white glass cards and full CRUD task management", status: "in_progress", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), priority: "high" },
            { id: "t-2", title: "Verify Avatar Stage 16:9 alignment", description: "Seamless transitions between idle, thinking, and talking states", status: "done", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), priority: "medium" },
            { id: "t-3", title: "Audit Audio Reactive Latency", description: "Ensure zero audio leakage and smooth speech synthesis sync", status: "todo", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), priority: "low" },
          ],
          git: {
            isGitRepo: true,
            branch: "main",
            uncommittedChanges: 0,
            recentCommits: [
              { hash: "7f4c1a2", message: "feat: Phase 5 Memory Dashboard Redesign completed", author: "Antigravity", date: "Just now" },
              { hash: "3a9e8b1", message: "feat: Phase 4 Chat Interface Aurora Light Theme", author: "Antigravity", date: "Today" },
            ],
          },
        };
        setCurrentProject(fallbackProject);
        setProjectsList([fallbackProject]);
      }
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, [currentProject]);

  useEffect(() => {
    if (isOpen) {
      fetchDashboardData();
    }
  }, [isOpen, fetchDashboardData]);

  // Handle Refresh
  const handleRefresh = async () => {
    setIsRefreshing(true);
    if (onRefreshProject) {
      try {
        await onRefreshProject();
      } catch (e) {
        console.warn("[ProjectsDashboard] onRefreshProject warning:", e);
      }
    }
    await fetchDashboardData();
  };

  // Switch Active Project
  const handleSelectProject = async (proj: ProjectContext) => {
    try {
      await fetch("/api/projects/active", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: proj.id }),
      });
      setCurrentProject(proj);
      await fetchDashboardData();
    } catch (e) {
      console.error("[ProjectsDashboard] Error setting active project:", e);
      setCurrentProject(proj);
    }
  };

  // Add Project / Analyze Workspace
  const handleCreateOrAnalyze = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newProjectPath.trim() && !newProjectName.trim()) return;

    setIsLoading(true);
    try {
      const res = await fetch("/api/projects/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: newProjectPath.trim() || undefined,
          name: newProjectName.trim() || undefined,
          type: newProjectType,
          summary: newProjectSummary.trim() || undefined,
        }),
      });

      if (res.ok) {
        const analyzed = await res.json();
        setCurrentProject(analyzed);
        setIsCreatingProject(false);
        setNewProjectName("");
        setNewProjectPath("");
        setNewProjectSummary("");
        await fetchDashboardData();
      } else {
        // Fallback local create
        const newProj: ProjectContext = {
          id: `proj-${Date.now()}`,
          name: newProjectName || "New Workspace",
          rootPath: newProjectPath || "d:/projects/workspace",
          type: newProjectType,
          primaryLanguage: newProjectType.includes("python") ? "Python" : "TypeScript",
          frameworks: ["Node.js"],
          summary: newProjectSummary || "Custom project workspace",
          status: "active",
          tasks: [],
        };
        setProjectsList((prev) => [newProj, ...prev]);
        setCurrentProject(newProj);
        setIsCreatingProject(false);
      }
    } catch (err: any) {
      console.error("[ProjectsDashboard] Error analyzing project:", err);
    } finally {
      setIsLoading(false);
    }
  };

  // Add Task
  const handleAddTask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTaskTitle.trim()) return;

    try {
      const res = await fetch("/api/projects/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: newTaskTitle.trim(),
          description: newTaskDescription.trim(),
          status: newTaskStatus,
        }),
      });

      if (res.ok) {
        const createdTask: ProjectTask = await res.json();
        if (currentProject) {
          const updated = {
            ...currentProject,
            tasks: [...(currentProject.tasks || []), createdTask],
          };
          setCurrentProject(updated);
        }
      } else {
        // Local fallback
        const localTask: ProjectTask = {
          id: `task-${Date.now()}`,
          title: newTaskTitle.trim(),
          description: newTaskDescription.trim(),
          status: newTaskStatus,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          priority: newTaskPriority,
        };
        if (currentProject) {
          setCurrentProject({
            ...currentProject,
            tasks: [...(currentProject.tasks || []), localTask],
          });
        }
      }
      setIsAddingTask(false);
      setNewTaskTitle("");
      setNewTaskDescription("");
      setNewTaskStatus("todo");
    } catch (err) {
      console.error("[ProjectsDashboard] Error adding task:", err);
    }
  };

  // Cycle Task Status (todo -> in_progress -> done -> todo)
  const handleCycleTaskStatus = async (task: ProjectTask) => {
    const nextStatus: Record<TaskStatus, TaskStatus> = {
      todo: "in_progress",
      in_progress: "done",
      done: "todo",
      blocked: "in_progress",
    };
    const updatedStatus = nextStatus[task.status] || "todo";

    try {
      const res = await fetch(`/api/projects/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: updatedStatus }),
      });

      if (currentProject) {
        const updatedTasks = currentProject.tasks.map((t) =>
          t.id === task.id ? { ...t, status: updatedStatus, updatedAt: new Date().toISOString() } : t
        );
        setCurrentProject({ ...currentProject, tasks: updatedTasks });
      }
    } catch (err) {
      console.error("[ProjectsDashboard] Error updating task status:", err);
    }
  };

  // Delete Task
  const handleDeleteTask = async (taskId: string) => {
    try {
      await fetch(`/api/projects/tasks/${taskId}`, { method: "DELETE" });
      if (currentProject) {
        setCurrentProject({
          ...currentProject,
          tasks: currentProject.tasks.filter((t) => t.id !== taskId),
        });
      }
    } catch (err) {
      console.error("[ProjectsDashboard] Error deleting task:", err);
    }
  };

  // Archive / Delete Project
  const handleToggleArchiveProject = (projId: string) => {
    setProjectsList((prev) =>
      prev.map((p) => {
        if (p.id === projId) {
          const nextStatus = p.status === "archived" ? "active" : "archived";
          return { ...p, status: nextStatus };
        }
        return p;
      })
    );
    if (currentProject && currentProject.id === projId) {
      setCurrentProject((prev) =>
        prev ? { ...prev, status: prev.status === "archived" ? "active" : "archived" } : null
      );
    }
  };

  const handleDeleteProject = async (projId: string) => {
    try {
      await fetch(`/api/projects/${projId}`, { method: "DELETE" });
      setProjectsList((prev) => prev.filter((p) => p.id !== projId));
      if (currentProject && currentProject.id === projId) {
        const remaining = projectsList.filter((p) => p.id !== projId);
        setCurrentProject(remaining[0] || null);
      }
    } catch (err) {
      console.error("[ProjectsDashboard] Error deleting project:", err);
    }
  };

  // Derived Task Statistics
  const tasks = currentProject?.tasks || [];
  const totalTasks = tasks.length;
  const completedTasks = tasks.filter((t) => t.status === "done").length;
  const inProgressTasks = tasks.filter((t) => t.status === "in_progress").length;
  const todoTasks = tasks.filter((t) => t.status === "todo").length;
  const blockedTasks = tasks.filter((t) => t.status === "blocked").length;
  const completionPercentage = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

  // Filtered Projects List
  const displayedProjects = useMemo(() => {
    let list = projectsList.length > 0 ? projectsList : currentProject ? [currentProject] : [];

    // Filter by project state (active, completed, archived)
    if (projectFilter === "active") {
      list = list.filter((p) => (p.status || "active") === "active");
    } else if (projectFilter === "completed") {
      list = list.filter((p) => p.status === "completed");
    } else if (projectFilter === "archived") {
      list = list.filter((p) => p.status === "archived");
    }

    // Filter by category
    if (categoryFilter !== "all") {
      list = list.filter(
        (p) =>
          p.primaryLanguage?.toLowerCase() === categoryFilter.toLowerCase() ||
          p.type?.toLowerCase().includes(categoryFilter.toLowerCase())
      );
    }

    // Filter by search query
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.summary.toLowerCase().includes(q) ||
          p.rootPath.toLowerCase().includes(q) ||
          p.frameworks?.some((f) => f.toLowerCase().includes(q))
      );
    }

    return list;
  }, [projectsList, currentProject, projectFilter, categoryFilter, searchQuery]);

  // Filtered Tasks List
  const displayedTasks = useMemo(() => {
    let list = tasks;
    if (taskStatusFilter !== "all") {
      list = list.filter((t) => t.status === taskStatusFilter);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(
        (t) => t.title.toLowerCase().includes(q) || (t.description && t.description.toLowerCase().includes(q))
      );
    }
    return list;
  }, [tasks, taskStatusFilter, searchQuery]);

  // Status Badge Styling Helper
  const getStatusBadge = (status: TaskStatus) => {
    switch (status) {
      case "done":
        return {
          label: "Completed",
          color: "text-emerald-700 dark:text-emerald-300",
          bg: "bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800/40",
          icon: CheckCircle2,
        };
      case "in_progress":
        return {
          label: "In Progress",
          color: "text-sky-700 dark:text-sky-300",
          bg: "bg-sky-50 dark:bg-sky-950/40 border-sky-200 dark:border-sky-800/40",
          icon: Clock,
        };
      case "blocked":
        return {
          label: "Blocked",
          color: "text-rose-700 dark:text-rose-300",
          bg: "bg-rose-50 dark:bg-rose-950/40 border-rose-200 dark:border-rose-800/40",
          icon: AlertCircle,
        };
      default:
        return {
          label: "To Do",
          color: "text-slate-700 dark:text-slate-400",
          bg: "bg-slate-100 dark:bg-slate-800/50 border-slate-300 dark:border-slate-700",
          icon: Square,
        };
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop Overlay */}
          <motion.div
            key="projects-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-40 transition-opacity"
            data-testid="projects-backdrop"
          />

          {/* Slide-over Container — Aurora Light Blue and White Glass Panel */}
          <motion.div
            key="projects-slideover-panel"
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
            className="fixed inset-y-0 right-0 w-full max-w-2xl md:max-w-3xl neural-glass-panel border-l border-[#38bdf8]/20 dark:border-[#202938] text-slate-900 dark:text-slate-100 backdrop-blur-3xl flex flex-col shadow-2xl z-50 overflow-hidden"
            data-testid="projects-dashboard-panel"
          >
            {/* 1. TOP HEADER & CONTROLS */}
            <div className="p-5 border-b border-[#38bdf8]/15 dark:border-white/5 flex items-center justify-between shrink-0 bg-white/40 dark:bg-[#111722]/40 backdrop-blur-md">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-sky-500/20 to-blue-600/10 border border-[#38bdf8]/30 flex items-center justify-center text-sky-600 dark:text-sky-400 shadow-sm">
                  <Briefcase className="w-5 h-5 pointer-events-none" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-base font-semibold tracking-wide text-slate-900 dark:text-white">
                      Projects Intelligence
                    </h2>
                    <span className="px-2 py-0.5 text-[10px] font-mono tracking-wider font-semibold rounded-full bg-sky-50 dark:bg-sky-950/60 text-sky-700 dark:text-sky-400 border border-sky-300 dark:border-sky-800/50">
                      AURORA WORKSPACE
                    </span>
                  </div>
                  <p className="text-xs text-slate-600 dark:text-slate-400 font-normal">
                    Workspace analytics, task graphs, architecture & git synchronization
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={handleRefresh}
                  disabled={isRefreshing}
                  className="p-2 rounded-lg bg-white/60 dark:bg-[#161f30] hover:bg-sky-50 dark:hover:bg-sky-950/40 border border-slate-200 dark:border-slate-700/60 text-slate-600 dark:text-slate-300 hover:text-sky-600 transition-colors cursor-pointer"
                  title="Refresh Projects and Git Status"
                  data-testid="refresh-projects-btn"
                >
                  <RefreshCw className={`w-4 h-4 pointer-events-none ${isRefreshing ? "animate-spin text-sky-600" : ""}`} />
                </button>
                <button
                  onClick={onClose}
                  className="p-2 rounded-lg bg-white/60 dark:bg-[#161f30] hover:bg-rose-50 dark:hover:bg-rose-950/40 border border-slate-200 dark:border-slate-700/60 text-slate-500 hover:text-rose-600 transition-colors cursor-pointer"
                  title="Close Dashboard"
                  data-testid="close-projects-btn"
                >
                  <X className="w-4 h-4 pointer-events-none" />
                </button>
              </div>
            </div>

            {/* 2. OVERVIEW METRICS CARDS */}
            <div className="px-5 pt-4 pb-2 shrink-0 grid grid-cols-2 md:grid-cols-4 gap-3">
              {/* Stat 1: Active Project */}
              <div className="p-3.5 rounded-2xl neural-glass-subtle border border-[#38bdf8]/20 dark:border-white/5 shadow-xs flex flex-col justify-between">
                <div className="flex items-center justify-between text-slate-600 dark:text-slate-400 text-xs font-medium">
                  <span>Current Project</span>
                  <FolderGit2 className="w-3.5 h-3.5 text-sky-600" />
                </div>
                <div className="mt-1 font-semibold text-sm text-slate-900 dark:text-white truncate" title={currentProject?.name}>
                  {currentProject?.name || "Workspace"}
                </div>
                <div className="text-[10px] text-sky-700 dark:text-sky-400 font-mono font-medium truncate">
                  {currentProject?.primaryLanguage || "TypeScript"}
                </div>
              </div>

              {/* Stat 2: Total Tasks */}
              <div className="p-3.5 rounded-2xl neural-glass-subtle border border-[#38bdf8]/20 dark:border-white/5 shadow-xs flex flex-col justify-between">
                <div className="flex items-center justify-between text-slate-600 dark:text-slate-400 text-xs font-medium">
                  <span>Tracked Tasks</span>
                  <BarChart3 className="w-3.5 h-3.5 text-blue-600" />
                </div>
                <div className="mt-1 font-bold text-lg text-slate-900 dark:text-white">
                  {totalTasks}
                </div>
                <div className="text-[10px] text-slate-600 dark:text-slate-400 flex items-center gap-1.5 font-medium">
                  <span className="text-sky-700 dark:text-sky-400 font-semibold">{inProgressTasks} In Progress</span>
                  <span>•</span>
                  <span>{todoTasks} To Do</span>
                </div>
              </div>

              {/* Stat 3: Completion Progress */}
              <div className="p-3.5 rounded-2xl neural-glass-subtle border border-[#38bdf8]/20 dark:border-white/5 shadow-xs flex flex-col justify-between">
                <div className="flex items-center justify-between text-slate-600 dark:text-slate-400 text-xs font-medium">
                  <span>Completion</span>
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                </div>
                <div className="mt-1 font-bold text-lg text-slate-900 dark:text-white flex items-baseline gap-1">
                  {completionPercentage}%
                  <span className="text-[10px] font-medium text-slate-600 dark:text-slate-400">
                    ({completedTasks}/{totalTasks})
                  </span>
                </div>
                <div className="w-full bg-slate-200 dark:bg-slate-700/60 h-1.5 rounded-full overflow-hidden mt-1">
                  <div
                    className="bg-gradient-to-r from-sky-500 to-emerald-500 h-full rounded-full transition-all duration-500"
                    style={{ width: `${completionPercentage}%` }}
                  />
                </div>
              </div>

              {/* Stat 4: Git Status */}
              <div className="p-3.5 rounded-2xl neural-glass-subtle border border-[#38bdf8]/20 dark:border-white/5 shadow-xs flex flex-col justify-between">
                <div className="flex items-center justify-between text-slate-600 dark:text-slate-400 text-xs font-medium">
                  <span>Git Branch</span>
                  <GitBranch className="w-3.5 h-3.5 text-indigo-500" />
                </div>
                <div className="mt-1 font-semibold text-sm text-slate-900 dark:text-white flex items-center gap-1.5 font-mono">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                  <span className="truncate">{gitInfo?.branch || currentProject?.git?.branch || "main"}</span>
                </div>
                <div className="text-[10px] text-slate-600 dark:text-slate-400 truncate font-medium">
                  {(gitInfo?.uncommittedChanges ?? currentProject?.git?.uncommittedChanges ?? 0) === 0
                    ? "Working tree clean"
                    : `${gitInfo?.uncommittedChanges || currentProject?.git?.uncommittedChanges} uncommitted changes`}
                </div>
              </div>
            </div>

            {/* 3. NAVIGATION TABS */}
            <div className="px-5 pt-3 pb-2 border-b border-[#38bdf8]/15 dark:border-white/5 shrink-0 flex items-center justify-between gap-2 overflow-x-auto">
              <div className="flex items-center gap-1 bg-sky-50/70 dark:bg-[#141b26] p-1 rounded-xl border border-sky-200/50 dark:border-slate-800">
                <button
                  onClick={() => setActiveTab("projects")}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all cursor-pointer flex items-center gap-1.5 ${
                    activeTab === "projects"
                      ? "bg-white dark:bg-[#1c2636] text-sky-700 dark:text-sky-300 shadow-xs font-semibold"
                      : "text-slate-700 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white"
                  }`}
                  data-testid="tab-projects"
                >
                  <Briefcase className="w-3.5 h-3.5 pointer-events-none" />
                  Projects
                </button>
                <button
                  onClick={() => setActiveTab("tasks")}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all cursor-pointer flex items-center gap-1.5 ${
                    activeTab === "tasks"
                      ? "bg-white dark:bg-[#1c2636] text-sky-700 dark:text-sky-300 shadow-xs font-semibold"
                      : "text-slate-700 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white"
                  }`}
                  data-testid="tab-tasks"
                >
                  <CheckSquare className="w-3.5 h-3.5 pointer-events-none" />
                  Tasks & Milestones
                  {totalTasks > 0 && (
                    <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-sky-100 dark:bg-sky-900/40 text-sky-700 dark:text-sky-300 font-semibold">
                      {totalTasks}
                    </span>
                  )}
                </button>
                <button
                  onClick={() => setActiveTab("architecture")}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all cursor-pointer flex items-center gap-1.5 ${
                    activeTab === "architecture"
                      ? "bg-white dark:bg-[#1c2636] text-sky-700 dark:text-sky-300 shadow-xs font-semibold"
                      : "text-slate-700 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white"
                  }`}
                  data-testid="tab-architecture"
                >
                  <Layers className="w-3.5 h-3.5 pointer-events-none" />
                  Architecture
                </button>
                <button
                  onClick={() => setActiveTab("git")}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all cursor-pointer flex items-center gap-1.5 ${
                    activeTab === "git"
                      ? "bg-white dark:bg-[#1c2636] text-sky-700 dark:text-sky-300 shadow-xs font-semibold"
                      : "text-slate-700 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white"
                  }`}
                  data-testid="tab-git"
                >
                  <GitCommit className="w-3.5 h-3.5 pointer-events-none" />
                  Git & Activity
                </button>
              </div>

              {/* Action Button: New Project or Add Task depending on tab */}
              {activeTab === "projects" ? (
                <button
                  onClick={() => setIsCreatingProject(!isCreatingProject)}
                  className="px-3 py-1.5 rounded-xl bg-gradient-to-r from-sky-500 to-blue-600 hover:from-sky-600 hover:to-blue-700 text-white text-xs font-semibold shadow-sm hover:shadow flex items-center gap-1.5 cursor-pointer shrink-0"
                  data-testid="new-project-btn"
                >
                  <Plus className="w-3.5 h-3.5 pointer-events-none" />
                  Analyze Project
                </button>
              ) : activeTab === "tasks" ? (
                <button
                  onClick={() => setIsAddingTask(!isAddingTask)}
                  className="px-3 py-1.5 rounded-xl bg-gradient-to-r from-sky-500 to-blue-600 hover:from-sky-600 hover:to-blue-700 text-white text-xs font-semibold shadow-sm hover:shadow flex items-center gap-1.5 cursor-pointer shrink-0"
                  data-testid="add-task-btn"
                >
                  <Plus className="w-3.5 h-3.5 pointer-events-none" />
                  New Task
                </button>
              ) : null}
            </div>

            {/* 4. SEARCH & CATEGORY FILTERS */}
            <div className="px-5 py-2.5 bg-slate-50/50 dark:bg-[#111722]/30 border-b border-slate-200/60 dark:border-white/5 shrink-0 flex flex-col md:flex-row items-center justify-between gap-2.5">
              {/* Search Box */}
              <div className="relative w-full md:w-64">
                <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 dark:text-slate-400 pointer-events-none" />
                <input
                  type="text"
                  placeholder={activeTab === "tasks" ? "Search tasks..." : "Search projects..."}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full pl-8 pr-3 py-1.5 text-xs rounded-lg bg-white dark:bg-[#161f30] border border-slate-300 dark:border-slate-700 focus:outline-none focus:ring-1 focus:ring-sky-500 text-slate-900 dark:text-slate-100 placeholder-slate-500 dark:placeholder-slate-400 shadow-2xs"
                  data-testid="project-search-input"
                />
                {searchQuery && (
                  <button
                    onClick={() => setSearchQuery("")}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 text-xs"
                  >
                    ×
                  </button>
                )}
              </div>

              {/* Sub-Filters based on Active Tab */}
              {activeTab === "projects" && (
                <div className="flex items-center gap-1.5 w-full md:w-auto overflow-x-auto pb-1 md:pb-0">
                  <span className="text-[11px] text-slate-600 dark:text-slate-400 font-medium mr-1">Status:</span>
                  {(["all", "active", "completed", "archived"] as ProjectFilter[]).map((f) => (
                    <button
                      key={f}
                      onClick={() => setProjectFilter(f)}
                      className={`px-2 py-0.5 rounded-md text-[11px] font-medium capitalize transition-colors cursor-pointer ${
                        projectFilter === f
                          ? "bg-sky-100 dark:bg-sky-900/50 text-sky-700 dark:text-sky-300 font-semibold"
                          : "text-slate-600 hover:text-slate-900 dark:hover:text-slate-200"
                      }`}
                      data-testid={`filter-${f}`}
                    >
                      {f}
                    </button>
                  ))}
                </div>
              )}

              {activeTab === "tasks" && (
                <div className="flex items-center gap-1.5 w-full md:w-auto overflow-x-auto pb-1 md:pb-0">
                  <span className="text-[11px] text-slate-600 dark:text-slate-400 font-medium mr-1">Status:</span>
                  {(["all", "todo", "in_progress", "done", "blocked"] as const).map((s) => (
                    <button
                      key={s}
                      onClick={() => setTaskStatusFilter(s)}
                      className={`px-2 py-0.5 rounded-md text-[11px] font-medium capitalize transition-colors cursor-pointer ${
                        taskStatusFilter === s
                          ? "bg-sky-100 dark:bg-sky-900/50 text-sky-700 dark:text-sky-300 font-semibold"
                          : "text-slate-600 hover:text-slate-900 dark:hover:text-slate-200"
                      }`}
                      data-testid={`task-filter-${s}`}
                    >
                      {s.replace("_", " ")}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* 5. MAIN CONTENT AREA (SCROLLABLE) */}
            <div className="flex-1 overflow-y-auto p-5 space-y-4">
              {/* ─────────────────── TAB 1: PROJECTS LIST ─────────────────── */}
              {activeTab === "projects" && (
                <div className="space-y-3">
                  {/* ANALYZE / CREATE PROJECT FORM DRAWER */}
                  <AnimatePresence>
                    {isCreatingProject && (
                      <motion.form
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        exit={{ opacity: 0, height: 0 }}
                        onSubmit={handleCreateOrAnalyze}
                        className="p-4 rounded-2xl neural-glass-elevated bg-white/95 dark:bg-[#151c28] border border-sky-300/40 dark:border-sky-500/20 shadow-md space-y-3 overflow-hidden"
                        data-testid="create-project-drawer"
                      >
                        <div className="flex items-center justify-between pb-1 border-b border-slate-100 dark:border-slate-800">
                          <div className="flex items-center gap-2">
                            <Sparkles className="w-4 h-4 text-sky-600" />
                            <h3 className="text-xs font-semibold text-slate-800 dark:text-slate-100 uppercase tracking-wider">
                              Analyze New Project Workspace
                            </h3>
                          </div>
                          <button
                            type="button"
                            onClick={() => setIsCreatingProject(false)}
                            className="text-slate-400 hover:text-slate-600 p-1"
                          >
                            <X className="w-3.5 h-3.5 pointer-events-none" />
                          </button>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                          <div>
                            <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-300 mb-1">
                              Project Name
                            </label>
                            <input
                              type="text"
                              required
                              placeholder="e.g. Sora AI Companion"
                              value={newProjectName}
                              onChange={(e) => setNewProjectName(e.target.value)}
                              className="w-full px-3 py-1.5 text-xs rounded-lg bg-slate-50 dark:bg-[#1a2332] border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-sky-500"
                            />
                          </div>
                          <div>
                            <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-300 mb-1">
                              Workspace Directory Path
                            </label>
                            <input
                              type="text"
                              required
                              placeholder="e.g. d:\SORA AI\Sora AI"
                              value={newProjectPath}
                              onChange={(e) => setNewProjectPath(e.target.value)}
                              className="w-full px-3 py-1.5 text-xs rounded-lg bg-slate-50 dark:bg-[#1a2332] border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-sky-500 font-mono"
                            />
                          </div>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                          <div>
                            <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-300 mb-1">
                              Project Architecture Type
                            </label>
                            <select
                              value={newProjectType}
                              onChange={(e) => setNewProjectType(e.target.value as ProjectType)}
                              className="w-full px-3 py-1.5 text-xs rounded-lg bg-slate-50 dark:bg-[#1a2332] border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-sky-500"
                            >
                              <option value="node_typescript">Node.js + TypeScript</option>
                              <option value="node_javascript">Node.js + JavaScript</option>
                              <option value="python">Python / FastAPI</option>
                              <option value="rust">Rust</option>
                              <option value="go">Go</option>
                              <option value="polyglot">Polyglot / Fullstack</option>
                            </select>
                          </div>
                          <div>
                            <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-300 mb-1">
                              Brief Summary
                            </label>
                            <input
                              type="text"
                              placeholder="AI companion, background tasks, voice"
                              value={newProjectSummary}
                              onChange={(e) => setNewProjectSummary(e.target.value)}
                              className="w-full px-3 py-1.5 text-xs rounded-lg bg-slate-50 dark:bg-[#1a2332] border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-sky-500"
                            />
                          </div>
                        </div>

                        <div className="flex items-center justify-end gap-2 pt-2">
                          <button
                            type="button"
                            onClick={() => setIsCreatingProject(false)}
                            className="px-3 py-1 text-xs text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 cursor-pointer"
                          >
                            Cancel
                          </button>
                          <button
                            type="submit"
                            className="px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-xs font-semibold shadow-xs flex items-center gap-1.5 cursor-pointer"
                            data-testid="submit-create-project-btn"
                          >
                            <Sparkles className="w-3.5 h-3.5 pointer-events-none" />
                            Run Workspace Analysis
                          </button>
                        </div>
                      </motion.form>
                    )}
                  </AnimatePresence>

                  {displayedProjects.length === 0 ? (
                    <div className="p-8 text-center rounded-2xl bg-white/40 dark:bg-[#151c28]/40 border border-slate-200 dark:border-slate-800">
                      <Briefcase className="w-8 h-8 text-slate-300 dark:text-slate-600 mx-auto mb-2" />
                      <p className="text-sm font-medium text-slate-700 dark:text-slate-300">No projects found</p>
                      <p className="text-xs text-slate-400 mt-1">Try another search or click "Analyze Project" to import one.</p>
                    </div>
                  ) : (
                    displayedProjects.map((proj) => {
                      const isActive = currentProject?.id === proj.id;
                      const projTasks = proj.tasks || [];
                      const projDone = projTasks.filter((t) => t.status === "done").length;
                      const projPct = projTasks.length > 0 ? Math.round((projDone / projTasks.length) * 100) : 0;

                      return (
                        <div
                          key={proj.id}
                          className={`p-4 rounded-2xl transition-all border ${
                            isActive
                              ? "neural-glass-elevated border-sky-400/50 shadow-md ring-1 ring-sky-400/20"
                              : "neural-glass-subtle border-sky-100/80 dark:border-white/5 hover:border-sky-300/40 shadow-xs"
                          }`}
                          data-testid={`project-card-${proj.id}`}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="space-y-1">
                              <div className="flex items-center gap-2">
                                <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                                  {proj.name}
                                </h3>
                                {isActive && (
                                  <span className="px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800/40">
                                    ACTIVE
                                  </span>
                                )}
                                <span className="px-2 py-0.5 rounded-md text-[10px] font-mono text-sky-700 dark:text-sky-300 bg-sky-50 dark:bg-sky-950/40 border border-sky-200 dark:border-sky-800/40">
                                  {proj.primaryLanguage || "TypeScript"}
                                </span>
                              </div>
                              <p className="text-xs text-slate-700 dark:text-slate-300 line-clamp-2">
                                {proj.summary || "No description provided."}
                              </p>
                              <div className="flex items-center gap-2 pt-1 font-mono text-[11px] text-slate-600 dark:text-slate-400 font-medium">
                                <span>📁 {proj.rootPath}</span>
                              </div>
                            </div>

                            {/* Action Buttons */}
                            <div className="flex items-center gap-1.5 shrink-0">
                              {!isActive && (
                                <button
                                  onClick={() => handleSelectProject(proj)}
                                  className="px-2.5 py-1 text-xs font-semibold rounded-lg bg-sky-50 dark:bg-sky-950/50 hover:bg-sky-100 text-sky-700 dark:text-sky-300 border border-sky-200 dark:border-sky-800/40 cursor-pointer"
                                  data-testid={`set-active-btn-${proj.id}`}
                                >
                                  Set Active
                                </button>
                              )}
                              <button
                                onClick={() => handleToggleArchiveProject(proj.id)}
                                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
                                title={proj.status === "archived" ? "Unarchive" : "Archive"}
                              >
                                <Archive className="w-3.5 h-3.5 pointer-events-none" />
                              </button>
                              <button
                                onClick={() => handleDeleteProject(proj.id)}
                                className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40 transition-colors cursor-pointer"
                                title="Delete Project"
                              >
                                <Trash2 className="w-3.5 h-3.5 pointer-events-none" />
                              </button>
                            </div>
                          </div>

                          {/* Progress & Framework Badges */}
                          <div className="mt-3 pt-3 border-t border-slate-100 dark:border-slate-800/60 flex flex-col md:flex-row md:items-center justify-between gap-2">
                            <div className="flex flex-wrap items-center gap-1">
                              {proj.frameworks?.slice(0, 4).map((fw) => (
                                <span
                                  key={fw}
                                  className="px-2 py-0.5 rounded text-[10px] bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300"
                                >
                                  {fw}
                                </span>
                              ))}
                            </div>

                            {/* Progress bar */}
                            <div className="flex items-center gap-2 min-w-36">
                              <div className="flex-1 bg-slate-200 dark:bg-slate-700 h-1.5 rounded-full overflow-hidden">
                                <div
                                  className="bg-sky-500 h-full rounded-full"
                                  style={{ width: `${projPct}%` }}
                                />
                              </div>
                              <span className="text-[10px] font-mono text-slate-500 dark:text-slate-400 shrink-0">
                                {projDone}/{projTasks.length} ({projPct}%)
                              </span>
                            </div>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              )}

              {/* ─────────────────── TAB 2: TASKS & MILESTONES ─────────────────── */}
              {activeTab === "tasks" && (
                <div className="space-y-3">
                  {/* ADD TASK FORM DRAWER */}
                  <AnimatePresence>
                    {isAddingTask && (
                      <motion.form
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        exit={{ opacity: 0, height: 0 }}
                        onSubmit={handleAddTask}
                        className="p-4 rounded-2xl neural-glass-elevated bg-white/95 dark:bg-[#151c28] border border-sky-300/40 dark:border-sky-500/20 shadow-md space-y-3 overflow-hidden"
                        data-testid="add-task-drawer"
                      >
                        <div className="flex items-center justify-between pb-1 border-b border-slate-100 dark:border-slate-800">
                          <div className="flex items-center gap-2">
                            <CheckSquare className="w-4 h-4 text-sky-600" />
                            <h3 className="text-xs font-semibold text-slate-800 dark:text-slate-100 uppercase tracking-wider">
                              Create New Project Task
                            </h3>
                          </div>
                          <button
                            type="button"
                            onClick={() => setIsAddingTask(false)}
                            className="text-slate-400 hover:text-slate-600 p-1"
                          >
                            <X className="w-3.5 h-3.5 pointer-events-none" />
                          </button>
                        </div>

                        <div>
                          <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-300 mb-1">
                            Task Title
                          </label>
                          <input
                            type="text"
                            required
                            placeholder="e.g. Audit audio streaming latency"
                            value={newTaskTitle}
                            onChange={(e) => setNewTaskTitle(e.target.value)}
                            className="w-full px-3 py-1.5 text-xs rounded-lg bg-slate-50 dark:bg-[#1a2332] border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-sky-500"
                            data-testid="new-task-title-input"
                          />
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                          <div>
                            <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-300 mb-1">
                              Initial Status
                            </label>
                            <select
                              value={newTaskStatus}
                              onChange={(e) => setNewTaskStatus(e.target.value as TaskStatus)}
                              className="w-full px-3 py-1.5 text-xs rounded-lg bg-slate-50 dark:bg-[#1a2332] border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-sky-500"
                            >
                              <option value="todo">To Do</option>
                              <option value="in_progress">In Progress</option>
                              <option value="done">Completed</option>
                              <option value="blocked">Blocked</option>
                            </select>
                          </div>
                          <div>
                            <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-300 mb-1">
                              Priority
                            </label>
                            <select
                              value={newTaskPriority}
                              onChange={(e) => setNewTaskPriority(e.target.value as any)}
                              className="w-full px-3 py-1.5 text-xs rounded-lg bg-slate-50 dark:bg-[#1a2332] border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-sky-500"
                            >
                              <option value="high">High Priority</option>
                              <option value="medium">Medium Priority</option>
                              <option value="low">Low Priority</option>
                            </select>
                          </div>
                        </div>

                        <div>
                          <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-300 mb-1">
                            Description & Acceptance Criteria
                          </label>
                          <textarea
                            rows={2}
                            placeholder="Add task details, acceptance goals, or dependencies..."
                            value={newTaskDescription}
                            onChange={(e) => setNewTaskDescription(e.target.value)}
                            className="w-full px-3 py-1.5 text-xs rounded-lg bg-slate-50 dark:bg-[#1a2332] border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-sky-500 resize-none"
                          />
                        </div>

                        <div className="flex items-center justify-end gap-2 pt-1">
                          <button
                            type="button"
                            onClick={() => setIsAddingTask(false)}
                            className="px-3 py-1 text-xs text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 cursor-pointer"
                          >
                            Cancel
                          </button>
                          <button
                            type="submit"
                            className="px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-xs font-semibold shadow-xs flex items-center gap-1.5 cursor-pointer"
                            data-testid="submit-add-task-btn"
                          >
                            <Check className="w-3.5 h-3.5 pointer-events-none" />
                            Save Task
                          </button>
                        </div>
                      </motion.form>
                    )}
                  </AnimatePresence>

                  {displayedTasks.length === 0 ? (
                    <div className="p-8 text-center rounded-2xl bg-white/40 dark:bg-[#151c28]/40 border border-slate-200 dark:border-slate-800">
                      <CheckSquare className="w-8 h-8 text-slate-300 dark:text-slate-600 mx-auto mb-2" />
                      <p className="text-sm font-medium text-slate-700 dark:text-slate-300">No tasks in this category</p>
                      <p className="text-xs text-slate-400 mt-1">Click "New Task" to track a feature or bug fix.</p>
                    </div>
                  ) : (
                    displayedTasks.map((t) => {
                      const badge = getStatusBadge(t.status);
                      const Icon = badge.icon;

                      return (
                        <div
                          key={t.id}
                          className="p-3.5 rounded-2xl neural-glass-subtle border border-sky-100/80 dark:border-white/5 shadow-xs hover:shadow-sm transition-all flex items-start justify-between gap-3 group"
                          data-testid={`task-item-${t.id}`}
                        >
                          <div className="flex items-start gap-3">
                            <button
                              onClick={() => handleCycleTaskStatus(t)}
                              className="mt-0.5 p-1 rounded-md text-slate-400 hover:text-sky-600 hover:bg-sky-50 dark:hover:bg-sky-950/40 transition-colors cursor-pointer"
                              title="Click to advance status"
                              data-testid={`cycle-task-status-btn-${t.id}`}
                            >
                              <Icon className="w-4 h-4 pointer-events-none" />
                            </button>
                            <div className="space-y-1">
                              <div className="flex items-center gap-2">
                                <span
                                  className={`text-xs font-semibold ${
                                    t.status === "done"
                                      ? "line-through text-slate-500 dark:text-slate-500"
                                      : "text-slate-900 dark:text-slate-100"
                                  }`}
                                >
                                  {t.title}
                                </span>
                                <span
                                  className={`px-2 py-0.5 rounded-full text-[10px] font-medium border flex items-center gap-1 ${badge.bg} ${badge.color}`}
                                >
                                  {badge.label}
                                </span>
                                {t.priority && (
                                  <span
                                    className={`px-1.5 py-0.2 rounded text-[9px] uppercase font-mono font-semibold ${
                                      t.priority === "high"
                                        ? "bg-rose-50 text-rose-700 border border-rose-200"
                                        : "bg-slate-100 text-slate-700 dark:text-slate-400 border border-slate-200 dark:border-slate-700"
                                    }`}
                                  >
                                    {t.priority}
                                  </span>
                                )}
                              </div>
                              {t.description && (
                                <p className="text-xs text-slate-600 dark:text-slate-400 font-medium">
                                  {t.description}
                                </p>
                              )}
                              <div className="text-[10px] text-slate-500 dark:text-slate-400 font-mono flex items-center gap-2 pt-0.5 font-medium">
                                <span>Updated {new Date(t.updatedAt || t.createdAt).toLocaleDateString()}</span>
                              </div>
                            </div>
                          </div>

                          {/* Quick Actions */}
                          <div className="flex items-center gap-1 shrink-0">
                            <button
                              onClick={() => handleCycleTaskStatus(t)}
                              className="px-2 py-1 text-[11px] font-medium rounded-lg bg-slate-50 dark:bg-slate-800 hover:bg-sky-50 hover:text-sky-600 transition-colors text-slate-700 dark:text-slate-300 border border-slate-300 dark:border-slate-700 cursor-pointer"
                            >
                              Next Status
                            </button>
                            <button
                              onClick={() => handleDeleteTask(t.id)}
                              className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40 transition-colors cursor-pointer"
                              title="Delete task"
                              data-testid={`delete-task-btn-${t.id}`}
                            >
                              <Trash2 className="w-3.5 h-3.5 pointer-events-none" />
                            </button>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              )}

              {/* ─────────────────── TAB 3: ARCHITECTURE & LAYERS ─────────────────── */}
              {activeTab === "architecture" && (
                <div className="space-y-4">
                  {/* Architecture Layers Breakdown */}
                  <div className="p-4 rounded-2xl neural-glass-subtle border border-sky-100/80 dark:border-white/5 shadow-xs space-y-3">
                    <div className="flex items-center gap-2 pb-2 border-b border-slate-100 dark:border-slate-800">
                      <Layers className="w-4 h-4 text-sky-600" />
                      <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-800 dark:text-slate-100">
                        System Architecture Layers
                      </h3>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {(architecture?.layers || [
                        { name: "Frontend & UI Core", description: "React 19, TailwindCSS, Motion, Avatar Stage & Dashboards", paths: ["frontend/App.tsx", "frontend/components/"] },
                        { name: "Backend Gateway & IPC", description: "Express HTTP Gateway, Electron IPC channels, WebSocket stream", paths: ["backend/gateway/HttpGateway.ts", "electron/"] },
                        { name: "Intelligence & Agents", description: "Gemini Live API, Session Factory, Speech Recognition", paths: ["backend/gemini/", "backend/agents/"] },
                        { name: "Project & Memory Stores", description: "Atomic JSON stores, durable recollection records, transactions", paths: ["backend/projects/", "backend/memory/"] },
                      ]).map((layer) => (
                        <div key={layer.name} className="p-3 rounded-xl bg-white/70 dark:bg-[#1a2332] border border-sky-100/70 dark:border-slate-800">
                          <h4 className="text-xs font-bold text-slate-800 dark:text-slate-200 mb-0.5">{layer.name}</h4>
                          <p className="text-[11px] text-slate-500 dark:text-slate-400 mb-2">{layer.description}</p>
                          <div className="flex flex-wrap gap-1">
                            {layer.paths?.map((p) => (
                              <span key={p} className="px-1.5 py-0.5 text-[9px] font-mono bg-sky-50 dark:bg-slate-900 border border-sky-200/50 dark:border-slate-700 rounded text-slate-600 dark:text-slate-400">
                                {p}
                              </span>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Entry Points & Key Components */}
                  <div className="p-4 rounded-2xl neural-glass-subtle border border-sky-100/80 dark:border-white/5 shadow-xs space-y-3">
                    <div className="flex items-center gap-2 pb-2 border-b border-slate-100 dark:border-slate-800">
                      <FileCode className="w-4 h-4 text-sky-600" />
                      <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-800 dark:text-slate-100">
                        Key Entrypoints & Modules
                      </h3>
                    </div>

                    <div className="space-y-2">
                      {(architecture?.keyComponents || [
                        { name: "HttpGateway", path: "backend/gateway/HttpGateway.ts", purpose: "REST API endpoints for projects, memories, sessions, audio" },
                        { name: "ProjectManager", path: "backend/projects/ProjectManager.ts", purpose: "Workspace scanner, task CRUD, and git tracking engine" },
                        { name: "AvatarRenderer", path: "frontend/components/AvatarRenderer.tsx", purpose: "16:9 triple-state video playback (idle, thinking, talking)" },
                        { name: "ProjectsDashboard", path: "frontend/components/ProjectsDashboard.tsx", purpose: "Aurora light theme projects intelligence and task board" },
                      ]).map((comp) => (
                        <div key={comp.name} className="flex items-center justify-between p-2.5 rounded-xl bg-white/70 dark:bg-[#1a2332] border border-sky-100/60 dark:border-slate-800 text-xs">
                          <div>
                            <span className="font-semibold text-slate-800 dark:text-slate-200 mr-2">{comp.name}</span>
                            <span className="font-mono text-[10px] text-sky-600 dark:text-sky-400">{comp.path}</span>
                          </div>
                          <span className="text-[11px] text-slate-500 dark:text-slate-400 truncate max-w-xs">{comp.purpose}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* ─────────────────── TAB 4: GIT & ACTIVITY ─────────────────── */}
              {activeTab === "git" && (
                <div className="space-y-4">
                  {/* Current Branch & Tree Status */}
                  <div className="p-4 rounded-2xl neural-glass-subtle border border-sky-100/80 dark:border-white/5 shadow-xs flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-xl bg-indigo-50 dark:bg-indigo-950/40 border border-indigo-200 dark:border-indigo-800/40 flex items-center justify-center text-indigo-600 dark:text-indigo-400">
                        <GitBranch className="w-5 h-5 pointer-events-none" />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold font-mono text-slate-800 dark:text-slate-200">
                            branch: {gitInfo?.branch || currentProject?.git?.branch || "main"}
                          </span>
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-mono bg-emerald-50 text-emerald-600 border border-emerald-200">
                            UP TO DATE
                          </span>
                        </div>
                        <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                          {gitInfo?.uncommittedChanges ?? 0} uncommitted changes in current working tree
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* Recent Commits Feed */}
                  <div className="p-4 rounded-2xl neural-glass-subtle border border-sky-100/80 dark:border-white/5 shadow-xs space-y-3">
                    <div className="flex items-center gap-2 pb-2 border-b border-slate-100 dark:border-slate-800">
                      <GitCommit className="w-4 h-4 text-sky-600" />
                      <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-800 dark:text-slate-100">
                        Recent Commit History
                      </h3>
                    </div>

                    <div className="space-y-2">
                      {(
                        gitInfo?.recentCommits ||
                        currentProject?.git?.recentCommits || [
                          { hash: "7f4c1a2", message: "feat: Phase 5 Memory Dashboard Redesign completed", author: "Antigravity", date: "Today" },
                          { hash: "3a9e8b1", message: "feat: Phase 4 Chat Interface Aurora Light Theme", author: "Antigravity", date: "Today" },
                          { hash: "2e1d904", message: "feat: Phase 3 Light Blue Settings Configuration Redesign", author: "Antigravity", date: "Yesterday" },
                        ]
                      ).map((commit) => (
                        <div
                          key={commit.hash}
                          className="flex items-start justify-between p-2.5 rounded-xl bg-white/70 dark:bg-[#1a2332] border border-sky-100/60 dark:border-slate-800 text-xs"
                        >
                          <div className="space-y-0.5">
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-[10px] font-bold px-1.5 py-0.5 rounded bg-sky-100 dark:bg-sky-950 text-sky-700 dark:text-sky-300">
                                {commit.hash.slice(0, 7)}
                              </span>
                              <span className="text-slate-800 dark:text-slate-200 font-medium">{commit.message}</span>
                            </div>
                            <div className="text-[10px] text-slate-400 flex items-center gap-2">
                              <span>by {commit.author || "Antigravity"}</span>
                              <span>•</span>
                              <span>{commit.date || "Recent"}</span>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Last Session Resume Context Card */}
                  {currentProject?.lastSession && (
                    <div className="p-4 rounded-2xl bg-sky-50/60 dark:bg-sky-950/20 border border-sky-200/60 dark:border-sky-800/40 shadow-xs space-y-1.5">
                      <div className="flex items-center gap-2 text-sky-700 dark:text-sky-400 text-xs font-bold">
                        <Sparkles className="w-4 h-4 pointer-events-none" />
                        <span>Last Session Resume Context</span>
                      </div>
                      <p className="text-xs text-slate-700 dark:text-slate-300">
                        {currentProject.lastSession.summary}
                      </p>
                      {currentProject.lastSession.nextSteps && (
                        <div className="text-[11px] text-sky-800 dark:text-sky-300 font-medium">
                          Next Steps: {currentProject.lastSession.nextSteps}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* 6. BOTTOM DOCK FOOTER */}
            <div className="p-4 border-t border-[#38bdf8]/15 dark:border-white/5 shrink-0 bg-white/40 dark:bg-[#111722]/40 backdrop-blur-md flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                <span>Synchronized with Local Store</span>
              </div>
              <div className="font-mono text-[11px]">
                {currentProject ? `Project ID: ${currentProject.id}` : "Ready"}
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
