/**
 * MYRAA — ProjectManager
 *
 * Core coordinator for Project Intelligence:
 *   - Active workspace detection and switching
 *   - Full project analysis (scanner + detector + git + architecture mapping)
 *   - Architecture map generation
 *   - In-workspace code & symbol search
 *   - Task and session tracking ("last time hum kaha tak aaye the?")
 *   - Generation of the bounded Project Context Card for system prompt injection
 */

import path from "path";
import { assertWithinWorkspace } from "../security/PermissionManager.ts";
import { ProjectScanner } from "./ProjectScanner.ts";
import { ProjectDetector } from "./ProjectDetector.ts";
import { ProjectGit } from "./ProjectGit.ts";
import { ProjectSearch, type SearchOptions } from "./ProjectSearch.ts";
import { ProjectStore, projectStore } from "./ProjectStore.ts";
import {
  contentSanitizer,
  UNTRUSTED_DOC_START,
  UNTRUSTED_DOC_END,
  UNTRUSTED_CONTENT_DIRECTIVE,
} from "../security/ContentSanitizer.ts";

const EMBEDDED_DELIMITER_REGEX = /<<<\s*\/?\s*UNTRUSTED[^>]*>>>|<<<\/[^>]*>>>/gi;

function sanitizeCardField(raw: string | undefined | null, source: string, maxLen?: number): string {
  if (!raw || typeof raw !== "string") return "";
  const cleaned = raw
    .replace(EMBEDDED_DELIMITER_REGEX, "[DELIMITER_REDACTED]")
    .replace(/[\r\n]+/g, " ")
    .trim();
  const scan = contentSanitizer.scanForPromptInjection(cleaned, { source });
  let safe = scan.sanitizedText.replace(EMBEDDED_DELIMITER_REGEX, "[DELIMITER_REDACTED]").trim();
  if (maxLen !== undefined && safe.length > maxLen) {
    safe = safe.substring(0, maxLen);
  }
  return safe;
}
import type {
  ProjectContext,
  ArchitectureMap,
  ProjectTask,
  TaskStatus,
  LastSessionContext,
  CodeSearchResult,
  ProjectGitInfo,
} from "./ProjectTypes.ts";

export class ProjectManager {
  private store: ProjectStore;
  private currentWorkspace: string;

  constructor(store: ProjectStore = projectStore, initialWorkspace?: string) {
    this.store = store;
    this.currentWorkspace = path.resolve(
      initialWorkspace || process.env.SORA_WORKSPACE_DIR || process.cwd(),
    );
  }

  /**
   * Returns the current active workspace root.
   */
  getActiveWorkspace(): string {
    return this.currentWorkspace;
  }

  /**
   * Sets the active workspace root.
   */
  setActiveWorkspace(workspacePath: string): string {
    const resolved = path.resolve(workspacePath);
    this.currentWorkspace = resolved;
    return resolved;
  }

  /**
   * Performs an end-to-end analysis of the workspace and updates the store.
   */
  async analyzeProject(workspacePath?: string): Promise<ProjectContext> {
    const root = path.resolve(workspacePath || this.currentWorkspace);
    assertWithinWorkspace(root, root);
    this.currentWorkspace = root;

    // 1. Scan filesystem tree
    const scanned = await ProjectScanner.scan(root, { maxDepth: 5, maxFiles: 600 });

    // 2. Detect project type & manifest
    const detected = await ProjectDetector.detect(root, scanned.files);

    // 3. Inspect git
    const git = await ProjectGit.getInfo(root);

    // 4. Generate Architecture Map
    const architectureMap = this.generateArchitectureMap(scanned.files, detected.frameworks);

    // 5. Generate human-readable summary
    const projectName = detected.manifest?.name || path.basename(root);
    const summary = this.generateSummary(projectName, detected, scanned, git, architectureMap);

    // 6. Check for existing context to preserve tasks & last session
    const existing = await this.store.getProject(root);
    const projectId = existing?.id || Math.random().toString(36).substring(2, 11);

    const projectContext: ProjectContext = {
      id: projectId,
      name: projectName,
      rootPath: root,
      type: detected.type,
      primaryLanguage: detected.primaryLanguage,
      frameworks: detected.frameworks,
      summary,
      manifest: detected.manifest,
      architectureMap,
      git,
      tasks: existing?.tasks || [],
      lastSession: existing?.lastSession,
      lastAnalyzedAt: new Date().toISOString(),
    };

    await this.store.saveProject(projectContext);
    await this.store.setActiveProject(projectId);

    return projectContext;
  }

  /**
   * Searches code across project files.
   */
  async searchCode(query: string, options: SearchOptions = {}): Promise<CodeSearchResult[]> {
    return ProjectSearch.search(this.currentWorkspace, query, options);
  }

  /**
   * Returns Git status for the active workspace.
   */
  async getGitStatus(): Promise<ProjectGitInfo> {
    return ProjectGit.getInfo(this.currentWorkspace);
  }

  /**
   * Retrieves tasks for the active project.
   */
  async getTasks(): Promise<ProjectTask[]> {
    const project = await this.store.getActiveProject();
    return project?.tasks || [];
  }

  /**
   * Adds a new task to the active project.
   */
  async addTask(title: string, description?: string, status: TaskStatus = "todo"): Promise<ProjectTask> {
    let project = await this.store.getActiveProject();
    if (!project) {
      project = await this.analyzeProject();
    }

    const now = new Date().toISOString();
    const newTask: ProjectTask = {
      id: Math.random().toString(36).substring(2, 10),
      title,
      description,
      status,
      createdAt: now,
      updatedAt: now,
    };

    project.tasks.push(newTask);
    await this.store.saveProject(project);
    return newTask;
  }

  /**
   * Updates an existing project task.
   */
  async updateTask(
    taskId: string,
    patch: { title?: string; description?: string; status?: TaskStatus },
  ): Promise<ProjectTask | undefined> {
    const project = await this.store.getActiveProject();
    if (!project) return undefined;

    const task = project.tasks.find((t) => t.id === taskId);
    if (!task) return undefined;

    if (patch.title !== undefined) task.title = patch.title;
    if (patch.description !== undefined) task.description = patch.description;
    if (patch.status !== undefined) task.status = patch.status;
    task.updatedAt = new Date().toISOString();

    await this.store.saveProject(project);
    return task;
  }

  /**
   * Updates the last session resume context ("last time hum kaha tak aaye the?").
   */
  async updateLastSession(
    summary: string,
    nextSteps?: string,
    activeTaskId?: string,
  ): Promise<LastSessionContext> {
    let project = await this.store.getActiveProject();
    if (!project) {
      project = await this.analyzeProject();
    }

    const lastSession: LastSessionContext = {
      timestamp: new Date().toISOString(),
      summary,
      nextSteps,
      activeTaskId,
    };

    project.lastSession = lastSession;
    await this.store.saveProject(project);
    return lastSession;
  }

  /**
   * Retrieves the last session resume information.
   */
  async getLastSession(): Promise<LastSessionContext | undefined> {
    const project = await this.store.getActiveProject();
    return project?.lastSession;
  }

  /**
   * Builds an ArchitectureMap from scanned files and detected frameworks.
   */
  private generateArchitectureMap(
    files: string[],
    frameworks: string[],
  ): ArchitectureMap {
    const fileSet = new Set(files.map((f) => f.toLowerCase()));
    const entryPoints: string[] = [];

    // Detect common entry points
    const potentialEntries = [
      "server.ts",
      "server.js",
      "src/main.tsx",
      "src/index.tsx",
      "src/main.ts",
      "src/app.tsx",
      "index.html",
      "desktop_agent/main.py",
      "main.py",
      "app.py",
      "electron/main.cjs",
      "src/index.js",
    ];

    for (const entry of potentialEntries) {
      if (fileSet.has(entry.toLowerCase())) {
        entryPoints.push(entry);
      }
    }

    // Classify architecture layers
    const layers: ArchitectureMap["layers"] = [];

    const hasFrontend =
      files.some((f) => f.startsWith("src/components") || f.startsWith("src/views") || f.startsWith("src/pages")) ||
      frameworks.includes("React") ||
      frameworks.includes("Vue");
    if (hasFrontend) {
      layers.push({
        name: "Frontend UI & Interaction",
        description: "Interactive visual interfaces, HUDs, and components.",
        paths: files.filter((f) => f.startsWith("src/components") || f.startsWith("src/views") || f.startsWith("src/App.")).slice(0, 8),
      });
    }

    const hasBackend = files.some((f) => f.startsWith("src/backend") || f.startsWith("server."));
    if (hasBackend) {
      layers.push({
        name: "Backend Gateway & Core Engine",
        description: "Express HTTP gateway, live WebSocket channels, session management, and routing.",
        paths: files.filter((f) => f.startsWith("src/backend/gateway") || f.startsWith("src/backend/conversation") || f.startsWith("src/backend/ai")).slice(0, 8),
      });
      layers.push({
        name: "Cognitive Memory & Project Intelligence",
        description: "Structured memory store, context retrieval, and workspace intelligence.",
        paths: files.filter((f) => f.startsWith("src/backend/memory") || f.startsWith("src/backend/projects")).slice(0, 8),
      });
    }

    const hasDesktopAgent = files.some((f) => f.startsWith("desktop_agent"));
    if (hasDesktopAgent) {
      layers.push({
        name: "Desktop Control Agent",
        description: "FastAPI / Python automation engine for OS and application control.",
        paths: files.filter((f) => f.startsWith("desktop_agent")).slice(0, 8),
      });
    }

    // Key components
    const keyComponents: ArchitectureMap["keyComponents"] = [];
    if (fileSet.has("server.ts")) {
      keyComponents.push({ name: "Server Entry", path: "server.ts", purpose: "Application bootstrapping and server lifecycle" });
    }
    if (fileSet.has("src/backend/gateway/httpgateway.ts")) {
      keyComponents.push({ name: "HttpGateway", path: "src/backend/gateway/HttpGateway.ts", purpose: "REST API endpoints and logging" });
    }
    if (fileSet.has("src/backend/tools/toolorchestrator.ts")) {
      keyComponents.push({ name: "ToolOrchestrator", path: "src/backend/tools/ToolOrchestrator.ts", purpose: "Dispatches tool calls to in-process handlers or desktop agent" });
    }
    if (fileSet.has("src/backend/memory/memorymanager.ts")) {
      keyComponents.push({ name: "MemoryManager", path: "src/backend/memory/MemoryManager.ts", purpose: "Structured persistent memory and context ranking" });
    }
    if (fileSet.has("desktop_agent/main.py")) {
      keyComponents.push({ name: "Desktop Agent", path: "desktop_agent/main.py", purpose: "Python automation server for Windows controls" });
    }

    return {
      layers,
      entryPoints,
      keyComponents,
    };
  }

  /**
   * Generates a concise human-readable summary of the project.
   */
  private generateSummary(
    name: string,
    detected: { type: string; primaryLanguage: string; frameworks: string[]; manifest?: any },
    scanned: { totalFiles: number; totalDirectories: number },
    git: ProjectGitInfo,
    arch: ArchitectureMap,
  ): string {
    const fwList = detected.frameworks.length > 0 ? detected.frameworks.join(", ") : "None detected";
    const branchInfo = git.isGitRepo && git.branch ? `on branch '${git.branch}'` : "";

    return (
      `Project **${name}** is a **${detected.type}** application (${detected.primaryLanguage}) ${branchInfo}.\n` +
      `Frameworks/Tools: ${fwList}.\n` +
      `Scale: ${scanned.totalFiles} files across ${scanned.totalDirectories} directories.\n` +
      `Key Layers: ${arch.layers.map((l) => l.name).join("; ") || "Standard layout"}.\n` +
      `Entry Points: ${arch.entryPoints.join(", ") || "None found"}.`
    );
  }

  /**
   * Formats a bounded Project Context Card for injection into the system prompt.
   * Strictly respects charBudget (default 1200 characters).
   */
  async getProjectContextCard(charBudget = 1200): Promise<string> {
    let project = await this.store.getActiveProject();
    if (!project) {
      // Lazy analyze on first request
      try {
        project = await this.analyzeProject();
      } catch {
        return "";
      }
    }

    const safeId = sanitizeCardField(project.id, "projectCard_id", 100);
    const safeName = sanitizeCardField(project.name, "projectCard_name", 120);
    const safeBranch = project.git?.branch
      ? sanitizeCardField(project.git.branch, "projectCard_gitBranch", 80)
      : "";
    const gitBranch = safeBranch ? ` | Branch: ${safeBranch}` : "";
    const uncommitted = project.git?.uncommittedChanges
      ? ` (${project.git.uncommittedChanges} uncommitted changes)`
      : "";
    const safeLang = sanitizeCardField(project.primaryLanguage, "projectCard_language", 60);
    const safeFrameworks =
      project.frameworks.length > 0
        ? project.frameworks.map((f) => sanitizeCardField(f, "projectCard_framework", 40)).join(", ")
        : "none";

    const fullHeader =
      `\n\n=== MYRAA ACTIVE PROJECT INTELLIGENCE ===\n` +
      `${UNTRUSTED_DOC_START}\n` +
      `[PROJECT_CONTEXT: ${safeId}]\n` +
      `${UNTRUSTED_CONTENT_DIRECTIVE}\n`;
    const fullFooter = `\n${UNTRUSTED_DOC_END}\n========================================\n`;

    let content =
      `Project: ${safeName} (${project.type})${gitBranch}${uncommitted}\n` +
      `Primary Tech: ${safeLang} | Frameworks: ${safeFrameworks}\n`;

    // Add Architecture highlights
    if (project.architectureMap && project.architectureMap.layers.length > 0) {
      content += `Architecture Layers:\n`;
      for (const layer of project.architectureMap.layers) {
        const lName = sanitizeCardField(layer.name, "projectCard_layerName", 80);
        const lDesc = sanitizeCardField(layer.description, "projectCard_layerDesc", 140);
        content += `  * ${lName}: ${lDesc}\n`;
      }
    }

    // Add Active Tasks
    const inProgressTasks = project.tasks.filter((t) => t.status === "in_progress" || t.status === "todo");
    if (inProgressTasks.length > 0) {
      content += `Current Focus Tasks:\n`;
      for (const t of inProgressTasks.slice(0, 3)) {
        const safeTitle = sanitizeCardField(t.title, "projectCard_taskTitle", 120);
        content += `  - [${t.status.toUpperCase()}] ${safeTitle}\n`;
      }
    }

    // Add Last Session notes
    if (project.lastSession) {
      const safeSummary = sanitizeCardField(project.lastSession.summary, "projectCard_lastSession", 160);
      content += `Last Session Context: ${safeSummary}\n`;
      if (project.lastSession.nextSteps) {
        const safeNext = sanitizeCardField(project.lastSession.nextSteps, "projectCard_nextSteps", 160);
        content += `Next Steps: ${safeNext}\n`;
      }
    }

    const fullCard = `${fullHeader}${content}${fullFooter}`;
    if (fullCard.length <= charBudget) {
      return fullCard;
    }

    if (charBudget < fullHeader.length + fullFooter.length + 10) {
      const compactHeader = `\n\n=== MYRAA ACTIVE PROJECT INTELLIGENCE ===\n${UNTRUSTED_DOC_START}\n`;
      const compactFooter = `\n${UNTRUSTED_DOC_END}\n`;
      const avail = charBudget - compactHeader.length - compactFooter.length;
      const suffix = "\n[...]";
      const cutLen = Math.max(0, avail - suffix.length);
      return `${compactHeader}${content.substring(0, cutLen)}${suffix}${compactFooter}`;
    }

    const avail = charBudget - fullHeader.length - fullFooter.length;
    const suffix = "\n[...]";
    const cutLen = Math.max(0, avail - suffix.length);
    return `${fullHeader}${content.substring(0, cutLen)}${suffix}${fullFooter}`;
  }
}

export const projectManager = new ProjectManager();
