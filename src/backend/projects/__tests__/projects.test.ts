/**
 * MYRAA Phase 3 — Project Intelligence Tests
 *
 * Tests:
 *   - Security: isPathWithinWorkspace & assertWithinWorkspace boundary enforcement
 *   - ProjectScanner: safe traversal, ignore patterns, depth/file bounds
 *   - ProjectDetector: manifest parsing & type detection
 *   - ProjectSearch: in-workspace code search, line matching, snippets
 *   - ProjectGit: read-only git queries, safe fallbacks
 *   - ProjectStore: atomic persistence, active project pointer, caching
 *   - ProjectManager: full analysis, architecture map, task tracking, session resume context card
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "path";
import fs from "fs/promises";
import os from "os";
import { isPathWithinWorkspace, assertWithinWorkspace } from "../../security/PermissionManager.ts";
import { ProjectScanner } from "../ProjectScanner.ts";
import { ProjectDetector } from "../ProjectDetector.ts";
import { ProjectSearch } from "../ProjectSearch.ts";
import { ProjectGit } from "../ProjectGit.ts";
import { ProjectStore } from "../ProjectStore.ts";
import { ProjectManager } from "../ProjectManager.ts";

describe("Phase 3: Workspace Security Guards", () => {
  const root = path.resolve(process.cwd());

  it("permits paths strictly inside the workspace", () => {
    expect(isPathWithinWorkspace("package.json", root)).toBe(true);
    expect(isPathWithinWorkspace("src/backend/projects", root)).toBe(true);
    expect(isPathWithinWorkspace(path.join(root, "server.ts"), root)).toBe(true);
  });

  it("blocks directory traversal attempts (..)", () => {
    expect(isPathWithinWorkspace("../outside.txt", root)).toBe(false);
    expect(isPathWithinWorkspace("../../Windows/System32", root)).toBe(false);
    expect(isPathWithinWorkspace("src/../../..", root)).toBe(false);
  });

  it("assertWithinWorkspace throws on path escape", () => {
    expect(() => assertWithinWorkspace("../outside.txt", root)).toThrow(/outside active workspace boundary/);
  });

  it("assertWithinWorkspace returns resolved path on valid input", () => {
    const res = assertWithinWorkspace("package.json", root);
    expect(res).toBe(path.join(root, "package.json"));
  });
});

describe("Phase 3: ProjectDetector", () => {
  const root = path.resolve(process.cwd());

  it("reads and parses package.json manifest correctly", async () => {
    const manifest = await ProjectDetector.readManifest(root);
    expect(manifest).toBeDefined();
    expect(manifest?.name).toBe("myraa");
    expect(manifest?.dependencies).toBeDefined();
    expect(manifest?.dependencies?.["@google/genai"]).toBeDefined();
  });

  it("detects node_typescript project type and frameworks", async () => {
    const detected = await ProjectDetector.detect(root, [
      "package.json",
      "tsconfig.json",
      "server.ts",
      "src/App.tsx",
    ]);

    expect(detected.type).toBe("node_typescript");
    expect(detected.primaryLanguage).toBe("TypeScript");
    expect(detected.frameworks).toContain("React");
    expect(detected.frameworks).toContain("Express");
    expect(detected.frameworks).toContain("Vite");
  });
});

describe("Phase 3: ProjectScanner", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "myraa-scan-test-"));
    await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
    await fs.mkdir(path.join(tempDir, "node_modules"), { recursive: true });
    await fs.writeFile(path.join(tempDir, "package.json"), "{}");
    await fs.writeFile(path.join(tempDir, "src", "index.ts"), "console.log('hello');");
    await fs.writeFile(path.join(tempDir, "node_modules", "ignore.js"), "ignored");
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("scans workspace files and excludes ignored directories", async () => {
    const scanned = await ProjectScanner.scan(tempDir);
    expect(scanned.files).toContain("package.json");
    expect(scanned.files).toContain("src/index.ts");
    // node_modules should be ignored
    expect(scanned.files.some((f) => f.includes("node_modules"))).toBe(false);
  });

  it("respects maxFiles limit and marks truncated", async () => {
    const scanned = await ProjectScanner.scan(tempDir, { maxFiles: 1 });
    expect(scanned.totalFiles).toBe(1);
    expect(scanned.truncated).toBe(true);
  });
});

describe("Phase 3: ProjectSearch", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "myraa-search-test-"));
    await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, "src", "auth.ts"),
      "// Authentication controller\nexport function authenticateUser(token: string) {\n  return token === 'secret';\n}\n",
    );
    await fs.writeFile(
      path.join(tempDir, "src", "config.ts"),
      "export const API_CONFIG = { port: 3000 };\n",
    );
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("finds matching symbols with line numbers and snippets", async () => {
    const results = await ProjectSearch.search(tempDir, "authenticateUser");
    expect(results.length).toBe(1);
    expect(results[0].file).toBe("src/auth.ts");
    expect(results[0].line).toBe(2);
    expect(results[0].snippet).toContain("authenticateUser");
  });

  it("supports case sensitivity and extension filters", async () => {
    const caseSensitive = await ProjectSearch.search(tempDir, "AUTHENTICATEUSER", {
      caseSensitive: true,
    });
    expect(caseSensitive.length).toBe(0);

    const filtered = await ProjectSearch.search(tempDir, "authenticateUser", {
      filePattern: "*.ts",
    });
    expect(filtered.length).toBe(1);

    const noMatchExt = await ProjectSearch.search(tempDir, "authenticateUser", {
      filePattern: "*.py",
    });
    expect(noMatchExt.length).toBe(0);
  });
});

describe("Phase 3: ProjectGit", () => {
  const root = path.resolve(process.cwd());

  it("retrieves git information safely in repo", async () => {
    const git = await ProjectGit.getInfo(root);
    expect(git.isGitRepo).toBe(true);
    expect(git.branch).toBeDefined();
    expect(typeof git.uncommittedChanges).toBe("number");
  });

  it("handles non-git directories gracefully without throwing", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "myraa-nogit-"));
    const git = await ProjectGit.getInfo(tempDir);
    expect(git.isGitRepo).toBe(false);
    await fs.rm(tempDir, { recursive: true, force: true });
  });
});

describe("Phase 3: ProjectStore", () => {
  let tempFile: string;
  let store: ProjectStore;

  beforeEach(async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "myraa-store-test-"));
    tempFile = path.join(tempDir, "projects.json");
    store = new ProjectStore(tempFile);
  });

  afterEach(async () => {
    store.clearCache();
    await fs.rm(path.dirname(tempFile), { recursive: true, force: true });
  });

  it("saves and retrieves projects atomically", async () => {
    const project = {
      id: "test-proj",
      name: "Test Project",
      rootPath: "C:\\projects\\test",
      type: "node_typescript" as const,
      primaryLanguage: "TypeScript",
      frameworks: ["React"],
      summary: "Test summary",
      tasks: [],
    };

    await store.saveProject(project);
    const retrieved = await store.getProject("test-proj");
    expect(retrieved).toBeDefined();
    expect(retrieved?.name).toBe("Test Project");

    const active = await store.getActiveProject();
    expect(active?.id).toBe("test-proj");
  });
});

describe("Phase 3: ProjectManager & Task Tracking", () => {
  let tempDir: string;
  let store: ProjectStore;
  let manager: ProjectManager;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "myraa-mgr-test-"));
    const storeFile = path.join(tempDir, "projects.json");
    store = new ProjectStore(storeFile);

    // Create minimal project structure
    await fs.writeFile(path.join(tempDir, "package.json"), JSON.stringify({ name: "my-test-app" }));
    await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
    await fs.writeFile(path.join(tempDir, "src", "index.ts"), "export const x = 1;");

    manager = new ProjectManager(store, tempDir);
  });

  afterEach(async () => {
    store.clearCache();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("analyzes workspace and generates architecture & summary", async () => {
    const proj = await manager.analyzeProject();
    expect(proj.name).toBe("my-test-app");
    expect(proj.type).toBe("node_typescript");
    expect(proj.architectureMap).toBeDefined();
    expect(proj.summary).toContain("my-test-app");
  });

  it("manages tasks (add, update, list)", async () => {
    const task1 = await manager.addTask("Implement login", "OAuth flow", "in_progress");
    expect(task1.id).toBeDefined();
    expect(task1.status).toBe("in_progress");

    const tasks = await manager.getTasks();
    expect(tasks.length).toBe(1);

    const updated = await manager.updateTask(task1.id, { status: "done" });
    expect(updated?.status).toBe("done");
  });

  it("tracks last session resume context ('last time hum kaha tak aaye the?')", async () => {
    await manager.updateLastSession("Finished implementing auth tokens", "Connect front-end login form");
    const lastSession = await manager.getLastSession();

    expect(lastSession?.summary).toBe("Finished implementing auth tokens");
    expect(lastSession?.nextSteps).toBe("Connect front-end login form");
  });

  it("generates bounded Project Context Card for prompt injection", async () => {
    await manager.addTask("Active Task 1", undefined, "in_progress");
    await manager.updateLastSession("Worked on API endpoints", "Write integration tests");

    const card = await manager.getProjectContextCard(1200);
    expect(card).toContain("=== MYRAA ACTIVE PROJECT INTELLIGENCE ===");
    expect(card).toContain("my-test-app");
    expect(card).toContain("Active Task 1");
    expect(card).toContain("Worked on API endpoints");
    expect(card.length).toBeLessThanOrEqual(1200);
  });
});
