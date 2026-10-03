/**
 * MYRAA — Step 8: Advanced Browser Research Agent
 * ProjectResearchBridge
 *
 * Bridges the research engine with Phase 23 Project Intelligence.
 * Reads project structure, relevant source files, tests, and runtime
 * context to create a ProjectResearchContext.
 *
 * Security invariants:
 *   - Only reads files within the declared project workspace (path boundary check)
 *   - Never executes project code
 *   - File content is treated as trusted project data (not external content)
 *   - Max 20 files read per session to prevent context flooding
 */

import fs from "fs";
import path from "path";
import type { ProjectResearchContext } from "./AdvancedResearchTypes.ts";
import { isPathWithinWorkspace } from "../security/PermissionManager.ts";

const MAX_FILES = 20;
const MAX_FILE_SIZE = 50_000; // 50KB per file
const RELEVANT_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".py", ".java", ".go", ".rs",
  ".json", ".yaml", ".yml", ".md", ".txt",
]);
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "__pycache__", "release"]);

export class ProjectResearchBridge {
  /**
   * Build a ProjectResearchContext from a project path.
   * Scans key files relevant to the research topic.
   */
  public async buildContext(
    projectPath: string,
    topic: string
  ): Promise<ProjectResearchContext | null> {
    try {
      const resolvedPath = path.resolve(projectPath);
      if (!fs.existsSync(resolvedPath)) {
        console.warn(`[ProjectResearchBridge] Project path not found: ${resolvedPath}`);
        return null;
      }

      // Read package.json / manifest
      const packageJson = this._readPackageJson(resolvedPath);
      const dependencies = packageJson?.dependencies as Record<string, string> | undefined;

      // Scan for relevant files matching the topic
      const relevantFiles = this._scanRelevantFiles(resolvedPath, topic);

      return {
        projectName: path.basename(resolvedPath),
        projectPath: resolvedPath,
        packageJson,
        dependencies,
        relevantFiles,
        runtimeErrors: [],
        testResults: undefined,
      };
    } catch (err: any) {
      console.warn(`[ProjectResearchBridge] Error building context: ${err?.message}`);
      return null;
    }
  }

  /**
   * Find specific files by name pattern within the project.
   * Used by DocumentationComparator to target exact files for comparison.
   */
  public findFiles(projectPath: string, pattern: RegExp): string[] {
    const results: string[] = [];
    this._walkDir(path.resolve(projectPath), results, (filePath) => pattern.test(filePath));
    return results.slice(0, MAX_FILES);
  }

  /**
   * Read a specific file's content with workspace boundary check.
   */
  public readFile(projectPath: string, filePath: string): string | null {
    try {
      const resolved = path.resolve(projectPath, filePath);

      // Security: enforce workspace boundary
      if (!isPathWithinWorkspace(resolved, path.resolve(projectPath))) {
        console.warn(`[ProjectResearchBridge] Path traversal blocked: ${filePath}`);
        return null;
      }

      if (!fs.existsSync(resolved)) return null;

      const stat = fs.statSync(resolved);
      if (stat.size > MAX_FILE_SIZE) {
        // Read first 50KB only
        const fd = fs.openSync(resolved, "r");
        const buf = Buffer.alloc(MAX_FILE_SIZE);
        fs.readSync(fd, buf, 0, MAX_FILE_SIZE, 0);
        fs.closeSync(fd);
        return buf.toString("utf8") + "\n[FILE_TRUNCATED]";
      }

      return fs.readFileSync(resolved, "utf8");
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _readPackageJson(projectPath: string): Record<string, unknown> | undefined {
    try {
      const pkgPath = path.join(projectPath, "package.json");
      if (fs.existsSync(pkgPath)) {
        return JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      }
    } catch { /* ignore */ }
    return undefined;
  }

  private _scanRelevantFiles(
    projectPath: string,
    topic: string
  ): ProjectResearchContext["relevantFiles"] {
    const topicTokens = topic
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3);

    const candidates: Array<{ path: string; content: string; relevanceScore: number }> = [];
    const allFiles: string[] = [];
    this._walkDir(projectPath, allFiles, (filePath) => {
      const ext = path.extname(filePath).toLowerCase();
      return RELEVANT_EXTENSIONS.has(ext);
    });

    for (const filePath of allFiles) {
      if (candidates.length >= MAX_FILES) break;

      try {
        const stat = fs.statSync(filePath);
        if (stat.size > MAX_FILE_SIZE) continue;

        const content = fs.readFileSync(filePath, "utf8");
        const lower = content.toLowerCase();
        const matchCount = topicTokens.filter((t) => lower.includes(t)).length;
        const relevanceScore = matchCount / Math.max(1, topicTokens.length);

        if (relevanceScore > 0.15) {
          candidates.push({
            path: path.relative(projectPath, filePath),
            content,
            relevanceScore,
          });
        }
      } catch { /* skip unreadable files */ }
    }

    return candidates.sort((a, b) => b.relevanceScore - a.relevanceScore).slice(0, 10);
  }

  private _walkDir(
    dir: string,
    results: string[],
    filter: (filePath: string) => boolean
  ): void {
    if (results.length >= MAX_FILES * 5) return; // Early exit
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          this._walkDir(fullPath, results, filter);
        } else if (entry.isFile() && filter(fullPath)) {
          results.push(fullPath);
        }
      }
    } catch { /* permission denied etc. — skip */ }
  }
}

export const projectResearchBridge = new ProjectResearchBridge();
