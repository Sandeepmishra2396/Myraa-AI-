/**
 * MYRAA — Frontend Project Intelligence Types
 * Defines data structures for projects, tasks, git metrics, and architecture.
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

export type TaskStatus = "todo" | "in_progress" | "done" | "blocked";

export interface ProjectTask {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  priority?: "high" | "medium" | "low";
  dueDate?: string;
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

export interface ProjectManifest {
  name?: string;
  version?: string;
  description?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  packageManager?: string;
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
  status?: "active" | "completed" | "archived";
}
