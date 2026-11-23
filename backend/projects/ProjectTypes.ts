/**
 * MYRAA — Phase 3 Project Intelligence Types
 *
 * Defines the schemas for project contexts, manifests, architecture maps,
 * task tracking, scanner results, and code search.
 */

export type ProjectType =
  | "node_typescript"
  | "node_javascript"
  | "python"
  | "rust"
  | "go"
  | "java"
  | "web_static"
  | "polyglot"
  | "unknown";

export interface ProjectManifest {
  name?: string;
  version?: string;
  description?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  packageManager?: string;
}

export type TaskStatus = "todo" | "in_progress" | "done" | "blocked";

export interface ProjectTask {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ArchitectureLayer {
  name: string;
  description: string;
  paths: string[];
}

export interface KeyComponent {
  name: string;
  path: string;
  purpose: string;
}

export interface ArchitectureMap {
  layers: ArchitectureLayer[];
  entryPoints: string[];
  keyComponents: KeyComponent[];
}

export interface LastSessionContext {
  timestamp: string;
  summary: string;
  nextSteps?: string;
  activeTaskId?: string;
}

export interface ProjectGitInfo {
  isGitRepo: boolean;
  branch?: string;
  uncommittedChanges?: number;
  recentCommits?: Array<{
    hash: string;
    message: string;
    date?: string;
    author?: string;
  }>;
  diffSummary?: string;
}

export interface ProjectContext {
  id: string;
  name: string;
  rootPath: string;
  type: ProjectType;
  primaryLanguage: string;
  frameworks: string[];
  summary: string;
  manifest?: ProjectManifest;
  architectureMap?: ArchitectureMap;
  git?: ProjectGitInfo;
  tasks: ProjectTask[];
  lastSession?: LastSessionContext;
  lastAnalyzedAt?: string;
}

export interface CodeSearchResult {
  file: string;
  line: number;
  column?: number;
  content: string;
  snippet: string;
}

export interface ScanOptions {
  maxDepth?: number;
  maxFiles?: number;
  customIgnore?: string[];
}

export interface ScannedFileTree {
  totalFiles: number;
  totalDirectories: number;
  truncated: boolean;
  directories: string[];
  files: string[];
  extensionCounts: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Phase 10.3 — Project Continuity Engine types (additive, backward-compatible)
// ---------------------------------------------------------------------------

export interface ProjectDecision {
  id: string;
  projectId: string;
  description: string;
  timestamp: string;
  type: "decision" | "milestone";
  source: "user_confirmed" | "ai_proposed";
  confirmed: boolean;
  confirmedAt?: string;
}

export type ProjectResolutionResult =
  | { status: "resolved"; project: ProjectContext }
  | { status: "ambiguous"; candidates: Pick<ProjectContext, "id" | "name">[]; reason: string }
  | { status: "not_found"; reason: string }
  | { status: "unavailable"; reason: string };

export interface PendingTaskSummary {
  taskId: string;
  title: string;
  status: TaskStatus;
  priority?: string;
  dueDate?: string;
  dependencies?: string[];
}

export interface ProjectContinuityContext {
  resolvedAt: string;
  project: {
    id: string;
    name: string;
    description?: string;
    status: "active" | "archived";
  };
  goal?: {
    objective: string;
    expectedOutcome?: string;
    scope?: string;
  };
  currentStatus?: {
    phase?: string;
    progress?: string;
    lastUpdated: string;
    source: string;
  };
  pendingTasks: PendingTaskSummary[];
  recentDecisions: ProjectDecision[];
  completedMilestones: ProjectDecision[];
  historicalLimitation?: string;
  planSummary?: {
    activePlans: number;
    recentGoals: string[];
  };
}

export interface HistoricalTaskSummary {
  taskId: string;
  title: string;
  currentStatus: TaskStatus | string;
  createdAt?: string;
  updatedAt?: string;
  historicalStatus: "unknown";
}

export interface HistoricalTasksResult {
  project: Pick<ProjectContext, "id" | "name">;
  targetDate: string;
  tasksCreatedOnOrBeforeDate: HistoricalTaskSummary[];
  historicalStatus: "unknown";
  historicalLimitation: string;
  pendingOnDate: PendingTaskSummary[];
  completedOnDate: PendingTaskSummary[];
  hasHistoricalEvidence: boolean;
}

