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

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import fs from "fs/promises";
import os from "os";
import { isPathWithinWorkspace, assertWithinWorkspace } from "../../backend/security/PermissionManager.ts";
import { ProjectScanner } from "../../backend/projects/ProjectScanner.ts";
import { ProjectDetector } from "../../backend/projects/ProjectDetector.ts";
import { ProjectSearch } from "../../backend/projects/ProjectSearch.ts";
import { ProjectGit } from "../../backend/projects/ProjectGit.ts";
import { ProjectStore } from "../../backend/projects/ProjectStore.ts";
import { ProjectManager } from "../../backend/projects/ProjectManager.ts";

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

  it("AUD-P1-01 Test 1: cold load does not clobber a concurrent committed write or cause lost updates", async () => {
    const baseProj = {
      id: "base-0",
      name: "Baseline Project",
      rootPath: path.join(path.dirname(tempFile), "ws-base"),
      type: "node_typescript" as const,
      primaryLanguage: "TypeScript",
      frameworks: ["Node.js"],
      summary: "Baseline",
      tasks: [],
    };
    const projA = {
      id: "proj-a",
      name: "Project A",
      rootPath: path.join(path.dirname(tempFile), "ws-a"),
      type: "node_typescript" as const,
      primaryLanguage: "TypeScript",
      frameworks: ["React"],
      summary: "Project A summary",
      tasks: [],
    };
    const projB = {
      id: "proj-b",
      name: "Project B",
      rootPath: path.join(path.dirname(tempFile), "ws-b"),
      type: "node_typescript" as const,
      primaryLanguage: "TypeScript",
      frameworks: ["Express"],
      summary: "Project B summary",
      tasks: [],
    };

    // Establish baseline on disk and reset cache to cold
    await store.saveProject(baseProj);
    store.clearCache();

    // Deterministic barrier pausing the cold load's disk read
    let signalReadEntered!: () => void;
    const readEntered = new Promise<void>((r) => {
      signalReadEntered = r;
    });
    let releaseRead!: () => void;
    const readGate = new Promise<void>((r) => {
      releaseRead = r;
    });

    const origReadFile = fs.readFile.bind(fs);
    let interceptedFirstRead = false;
    const readSpy = vi.spyOn(fs, "readFile").mockImplementation((async (p: any, ...rest: any[]) => {
      if (!interceptedFirstRead && path.resolve(String(p)) === path.resolve(tempFile)) {
        interceptedFirstRead = true;
        const content = await (origReadFile as any)(p, ...rest);
        signalReadEntered();
        await readGate;
        return content;
      }
      return (origReadFile as any)(p, ...rest);
    }) as any);

    const store2 = new ProjectStore(tempFile);
    try {
      const coldLoadP = store.load();
      await readEntered;

      // Concurrently schedule saveProject(A) from another instance targeting the same canonical file
      const saveAP = store2.saveProject(projA);

      releaseRead();
      await Promise.all([coldLoadP, saveAP]);
    } finally {
      readSpy.mockRestore();
    }

    // Save Project B after concurrent cold load + saveProject(A) settled
    await store.saveProject(projB);

    const diskJson = JSON.parse(await fs.readFile(tempFile, "utf-8"));
    const memState = await store.load();
    const diskIds = diskJson.projects.map((p: any) => p.id);
    const memIds = memState.projects.map((p: any) => p.id);

    expect(diskIds).toContain("base-0");
    expect(diskIds).toContain("proj-a");
    expect(diskIds).toContain("proj-b");
    expect(memIds).toEqual(diskIds);
    expect(memState).toEqual(diskJson);
  });

  it("AUD-P1-01 Test 2: waiting cold load observes preceding committed write via cache re-check without stale disk overwrite", async () => {
    const baseProj = {
      id: "base-w",
      name: "Base Waiting",
      rootPath: path.join(path.dirname(tempFile), "ws-base-w"),
      type: "node_typescript" as const,
      primaryLanguage: "TypeScript",
      frameworks: [],
      summary: "Base",
      tasks: [],
    };
    const projA = {
      id: "proj-ahead",
      name: "Project Ahead",
      rootPath: path.join(path.dirname(tempFile), "ws-ahead"),
      type: "node_typescript" as const,
      primaryLanguage: "TypeScript",
      frameworks: [],
      summary: "Committed before waiting load",
      tasks: [],
    };

    await store.saveProject(baseProj);
    store.clearCache();

    let signalRenameEntered!: () => void;
    const renameEntered = new Promise<void>((r) => {
      signalRenameEntered = r;
    });
    let releaseRename!: () => void;
    const renameGate = new Promise<void>((r) => {
      releaseRename = r;
    });

    const origRename = fs.rename.bind(fs);
    let pausedRename = false;
    const renameSpy = vi.spyOn(fs, "rename").mockImplementation((async (oldP: any, newP: any) => {
      if (!pausedRename && path.resolve(String(newP)) === path.resolve(tempFile)) {
        pausedRename = true;
        signalRenameEntered();
        await renameGate;
      }
      return origRename(oldP, newP);
    }) as any);

    const origReadFile = fs.readFile.bind(fs);
    let readsAfterWriteEntered = 0;
    let countingReads = false;
    const readSpy = vi.spyOn(fs, "readFile").mockImplementation((async (p: any, ...rest: any[]) => {
      if (countingReads && path.resolve(String(p)) === path.resolve(tempFile)) {
        readsAfterWriteEntered++;
      }
      return (origReadFile as any)(p, ...rest);
    }) as any);

    try {
      // Start write first and pause it mid-rename (before cache publication)
      const saveAP = store.saveProject(projA);
      await renameEntered;

      // Clear cache before starting waiting cold load so load() misses warm fast path
      // and queues behind the in-flight saveProject(projA) transaction
      store.clearCache();
      countingReads = true;
      const waitingLoadP = store.load();

      releaseRename();
      const [, loaded] = await Promise.all([saveAP, waitingLoadP]);

      // Waiting load re-checked cache inside transaction -> observed proj-ahead without re-reading disk
      expect(loaded.projects.map((p) => p.id)).toEqual(["base-w", "proj-ahead"]);
      expect(readsAfterWriteEntered).toBe(0);

      const diskJson = JSON.parse(await fs.readFile(tempFile, "utf-8"));
      expect(loaded).toEqual(diskJson);
      expect(await store.load()).toEqual(diskJson);
    } finally {
      renameSpy.mockRestore();
      readSpy.mockRestore();
    }
  });

  it("AUD-P1-01 Test 3: concurrent cold loads serialize hydration, read disk once, and return isolated defensive clones", async () => {
    const baseProj = {
      id: "cold-multi",
      name: "Cold Multi",
      rootPath: path.join(path.dirname(tempFile), "ws-cm"),
      type: "node_typescript" as const,
      primaryLanguage: "TypeScript",
      frameworks: ["Vite"],
      summary: "Shared disk state",
      tasks: [
        {
          id: "t-1",
          title: "Original Task",
          status: "todo" as const,
          createdAt: "2026-11-18T10:00:00.000Z",
          updatedAt: "2026-11-18T10:00:00.000Z",
        },
      ],
    };

    await store.saveProject(baseProj);
    store.clearCache();

    let signalFirstRead!: () => void;
    const firstReadEntered = new Promise<void>((r) => {
      signalFirstRead = r;
    });
    let releaseFirstRead!: () => void;
    const firstReadGate = new Promise<void>((r) => {
      releaseFirstRead = r;
    });

    const origReadFile = fs.readFile.bind(fs);
    let targetReadCount = 0;
    const readSpy = vi.spyOn(fs, "readFile").mockImplementation((async (p: any, ...rest: any[]) => {
      if (path.resolve(String(p)) === path.resolve(tempFile)) {
        targetReadCount++;
        const res = await (origReadFile as any)(p, ...rest);
        if (targetReadCount === 1) {
          signalFirstRead();
          await firstReadGate;
        }
        return res;
      }
      return (origReadFile as any)(p, ...rest);
    }) as any);

    try {
      const p1 = store.load();
      await firstReadEntered;
      // Enqueue 4 additional concurrent cold loads while the first hydration is in progress
      const p2 = store.load();
      const p3 = store.load();
      const p4 = store.load();
      const p5 = store.load();
      releaseFirstRead();

      const results = await Promise.all([p1, p2, p3, p4, p5]);
      // Hydration read disk strictly once; remaining callers reused the published cache inside the queue
      expect(targetReadCount).toBe(1);

      // Verify all callers received equivalent defensive clones
      const diskJson = JSON.parse(await origReadFile(tempFile, "utf-8"));
      for (const r of results) {
        expect(r).toEqual(diskJson);
      }

      // Mutate results[0] deeply -> other snapshots and warm cache must remain completely unaffected
      results[0].projects[0].name = "MUTATED_CLONE";
      results[0].projects[0].tasks.push({
        id: "t-mut",
        title: "Mutated",
        status: "done",
        createdAt: "2026-11-18T12:00:00.000Z",
        updatedAt: "2026-11-18T12:00:00.000Z",
      });
      expect(results[1].projects[0].name).toBe("Cold Multi");
      expect(results[1].projects[0].tasks.length).toBe(1);

      // Warm-cache fast path does not hit disk again
      const warm = await store.load();
      expect(targetReadCount).toBe(1);
      expect(warm.projects[0].name).toBe("Cold Multi");
      expect(warm.projects[0].tasks.length).toBe(1);
    } finally {
      readSpy.mockRestore();
    }
  });

  it("AUD-P1-01 Test 4: cold load read error does not poison queue or publish partial state, and preserves ENOENT initialization", async () => {
    const baseProj = {
      id: "err-base",
      name: "Error Recovery Base",
      rootPath: path.join(path.dirname(tempFile), "ws-err-base"),
      type: "node_typescript" as const,
      primaryLanguage: "TypeScript",
      frameworks: [],
      summary: "Persisted baseline",
      tasks: [],
    };
    const nextProj = {
      id: "err-next",
      name: "After Read Error",
      rootPath: path.join(path.dirname(tempFile), "ws-err-next"),
      type: "node_typescript" as const,
      primaryLanguage: "TypeScript",
      frameworks: [],
      summary: "Saved after transient read error",
      tasks: [],
    };

    await store.saveProject(baseProj);
    store.clearCache();

    // 1. Simulate a transient non-ENOENT read failure (EACCES) during cold hydration
    const origReadFile = fs.readFile.bind(fs);
    let failOnce = true;
    const readSpy = vi.spyOn(fs, "readFile").mockImplementation((async (p: any, ...rest: any[]) => {
      if (failOnce && path.resolve(String(p)) === path.resolve(tempFile)) {
        failOnce = false;
        const err: any = new Error("Simulated EACCES during cold load");
        err.code = "EACCES";
        throw err;
      }
      return (origReadFile as any)(p, ...rest);
    }) as any);

    try {
      const fallback = await store.load();
      expect(fallback).toEqual({ activeProjectId: null, projects: [] });
    } finally {
      readSpy.mockRestore();
    }

    // Failed hydration MUST NOT have cached empty state -> next load reads real persisted baseline
    const recoveredLoad = await store.load();
    expect(recoveredLoad.projects.map((p) => p.id)).toEqual(["err-base"]);

    // Queue is healthy -> subsequent save preserves both baseline and new project
    await store.saveProject(nextProj);
    const diskJson = JSON.parse(await fs.readFile(tempFile, "utf-8"));
    expect(diskJson.projects.map((p: any) => p.id)).toEqual(["err-base", "err-next"]);
    expect(await store.load()).toEqual(diskJson);

    // 2. Existing ENOENT missing-file initialization behavior is preserved
    const missingFile = path.join(path.dirname(tempFile), "brand-new-projects.json");
    const freshStore = new ProjectStore(missingFile);
    try {
      const emptyInit = await freshStore.load();
      expect(emptyInit).toEqual({ activeProjectId: null, projects: [] });
      await freshStore.saveProject(nextProj);
      const freshDisk = JSON.parse(await fs.readFile(missingFile, "utf-8"));
      expect(freshDisk.projects.map((p: any) => p.id)).toEqual(["err-next"]);
      expect(await freshStore.load()).toEqual(freshDisk);
    } finally {
      freshStore.clearCache();
    }
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
