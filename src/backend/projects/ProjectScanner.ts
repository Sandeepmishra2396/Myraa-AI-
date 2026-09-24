/**
 * MYRAA — ProjectScanner
 *
 * Scans a workspace directory structure safely.
 * Security & Reliability guarantees:
 *   - Confined to workspaceRoot via assertWithinWorkspace
 *   - Bounded depth (maxDepth default 5)
 *   - Bounded file count (maxFiles default 500) to prevent memory exhaustion
 *   - Comprehensive ignore lists (node_modules, .git, build, dist, venv, binaries, etc.)
 */

import fs from "fs/promises";
import path from "path";
import { assertWithinWorkspace } from "../security/PermissionManager.ts";
import type { ScanOptions, ScannedFileTree } from "./ProjectTypes.ts";

export const DEFAULT_IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  ".nuxt",
  ".venv",
  "venv",
  "env",
  "__pycache__",
  ".idea",
  ".vscode",
  "coverage",
  ".turbo",
  "release",
  ".cache",
  ".svn",
  ".hg",
  "bower_components",
  ".electron",
]);

export const BINARY_EXTENSIONS = new Set([
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".bin",
  ".iso",
  ".zip",
  ".tar",
  ".gz",
  ".7z",
  ".rar",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".mp3",
  ".mp4",
  ".wav",
  ".ogg",
  ".vrm",
  ".glb",
  ".gltf",
  ".pdf",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".pyc",
  ".pyo",
  ".pyd",
  ".map",
]);

export class ProjectScanner {
  /**
   * Recursively scans the workspace directory.
   */
  static async scan(
    workspaceRoot: string,
    options: ScanOptions = {},
  ): Promise<ScannedFileTree> {
    const root = path.resolve(workspaceRoot);
    assertWithinWorkspace(root, root);

    const maxDepth = options.maxDepth ?? 5;
    const maxFiles = options.maxFiles ?? 500;
    const ignoreDirs = new Set([...DEFAULT_IGNORE_DIRS, ...(options.customIgnore ?? [])]);

    const result: ScannedFileTree = {
      totalFiles: 0,
      totalDirectories: 0,
      truncated: false,
      directories: [],
      files: [],
      extensionCounts: {},
    };

    async function walk(currentDir: string, depth: number) {
      if (depth > maxDepth || result.totalFiles >= maxFiles) {
        if (result.totalFiles >= maxFiles) {
          result.truncated = true;
        }
        return;
      }

      assertWithinWorkspace(currentDir, root);

      let entries;
      try {
        entries = await fs.readdir(currentDir, { withFileTypes: true });
      } catch (err) {
        // Skip unreadable directories
        return;
      }

      for (const entry of entries) {
        if (result.totalFiles >= maxFiles) {
          result.truncated = true;
          break;
        }

        const name = entry.name;
        const fullPath = path.join(currentDir, name);
        const relPath = path.relative(root, fullPath).replace(/\\/g, "/");

        if (entry.isDirectory()) {
          if (ignoreDirs.has(name) || name.startsWith(".")) {
            continue;
          }
          result.totalDirectories++;
          result.directories.push(relPath);
          await walk(fullPath, depth + 1);
        } else if (entry.isFile()) {
          const ext = path.extname(name).toLowerCase();
          result.totalFiles++;
          result.files.push(relPath);
          result.extensionCounts[ext] = (result.extensionCounts[ext] || 0) + 1;
        }
      }
    }

    await walk(root, 1);
    return result;
  }
}
