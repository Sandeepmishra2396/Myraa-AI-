/**
 * MYRAA — ProjectSearch
 *
 * Fast and secure in-workspace code search.
 * Features:
 *   - Confined to workspace boundary via assertWithinWorkspace
 *   - Literal and regex matching
 *   - File extension & pattern filtering
 *   - Bounded result count (default 25) & max file size (default 500 KB)
 *   - Line number, column, and contextual snippet output
 */

import fs from "fs/promises";
import path from "path";
import { assertWithinWorkspace } from "../security/PermissionManager.ts";
import { DEFAULT_IGNORE_DIRS, BINARY_EXTENSIONS } from "./ProjectScanner.ts";
import type { CodeSearchResult } from "./ProjectTypes.ts";

export interface SearchOptions {
  caseSensitive?: boolean;
  isRegex?: boolean;
  filePattern?: string; // e.g. "*.ts" or "ts,tsx"
  maxResults?: number;
  maxFileSize?: number;
}

export class ProjectSearch {
  /**
   * Searches for query inside all eligible workspace code files.
   */
  static async search(
    workspaceRoot: string,
    query: string,
    options: SearchOptions = {},
  ): Promise<CodeSearchResult[]> {
    const root = assertWithinWorkspace(workspaceRoot, workspaceRoot);

    if (!query || query.trim().length === 0) {
      return [];
    }

    const maxResults = options.maxResults ?? 25;
    const maxFileSize = options.maxFileSize ?? 500 * 1024; // 500 KB
    const caseSensitive = options.caseSensitive ?? false;
    const isRegex = options.isRegex ?? false;

    // Build regex matcher
    let matcher: RegExp;
    try {
      if (isRegex) {
        matcher = new RegExp(query, caseSensitive ? "g" : "gi");
      } else {
        const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        matcher = new RegExp(escaped, caseSensitive ? "g" : "gi");
      }
    } catch {
      return [];
    }

    // Parse file pattern extensions
    let allowedExts: Set<string> | null = null;
    if (options.filePattern) {
      const parts = options.filePattern
        .split(",")
        .map((p) => p.trim().replace(/^\*/, "").toLowerCase());
      allowedExts = new Set(parts.map((p) => (p.startsWith(".") ? p : `.${p}`)));
    }

    const results: CodeSearchResult[] = [];

    async function searchDir(currentDir: string) {
      if (results.length >= maxResults) return;

      assertWithinWorkspace(currentDir, root);

      let entries;
      try {
        entries = await fs.readdir(currentDir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (results.length >= maxResults) break;

        const name = entry.name;
        const fullPath = path.join(currentDir, name);

        if (entry.isDirectory()) {
          if (DEFAULT_IGNORE_DIRS.has(name) || name.startsWith(".")) {
            continue;
          }
          await searchDir(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(name).toLowerCase();
          if (BINARY_EXTENSIONS.has(ext)) {
            continue;
          }
          if (allowedExts && !allowedExts.has(ext)) {
            continue;
          }

          try {
            const stat = await fs.stat(fullPath);
            if (stat.size > maxFileSize) {
              continue;
            }

            const content = await fs.readFile(fullPath, "utf-8");
            const lines = content.split(/\r?\n/);
            const relPath = path.relative(root, fullPath).replace(/\\/g, "/");

            for (let i = 0; i < lines.length; i++) {
              if (results.length >= maxResults) break;

              const lineContent = lines[i];
              matcher.lastIndex = 0;
              const match = matcher.exec(lineContent);

              if (match) {
                const prevLine = i > 0 ? lines[i - 1] : "";
                const nextLine = i < lines.length - 1 ? lines[i + 1] : "";
                const snippet = [
                  prevLine ? `${i}: ${prevLine}` : "",
                  `${i + 1}: ${lineContent}`,
                  nextLine ? `${i + 2}: ${nextLine}` : "",
                ]
                  .filter(Boolean)
                  .join("\n");

                results.push({
                  file: relPath,
                  line: i + 1,
                  column: match.index + 1,
                  content: lineContent.trim(),
                  snippet,
                });
              }
            }
          } catch {
            // Skip unreadable files
          }
        }
      }
    }

    await searchDir(root);
    return results;
  }
}
