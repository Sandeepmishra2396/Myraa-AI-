import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { ProjectStore } from "../../backend/projects/ProjectStore";
import { ProjectManager } from "../../backend/projects/ProjectManager";
import type { ProjectContext } from "../../backend/projects/ProjectTypes";

describe("Projects Dashboard Backend & Task Engine", () => {
  let tmpDir: string;
  let testFile: string;
  let store: ProjectStore;
  let manager: ProjectManager;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "myraa-proj-test-"));
    testFile = path.join(tmpDir, "projects.json");
    store = new ProjectStore(testFile);
    manager = new ProjectManager(store, tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it("adds and updates project tasks", async () => {
    const task = await manager.addTask("Implement Aurora Light Projects UI", "Design glass panels", "in_progress");
    expect(task.id).toBeDefined();
    expect(task.title).toBe("Implement Aurora Light Projects UI");
    expect(task.status).toBe("in_progress");

    const tasks = await manager.getTasks();
    expect(tasks.length).toBe(1);

    const updated = await manager.updateTask(task.id, { status: "done" });
    expect(updated?.status).toBe("done");

    const reloaded = await manager.getTasks();
    expect(reloaded[0].status).toBe("done");
  });

  it("deletes a project task successfully", async () => {
    const task1 = await manager.addTask("Task 1", "Desc 1", "todo");
    const task2 = await manager.addTask("Task 2", "Desc 2", "in_progress");

    let tasks = await manager.getTasks();
    expect(tasks.length).toBe(2);

    const deleted = await manager.deleteTask(task1.id);
    expect(deleted).toBe(true);

    tasks = await manager.getTasks();
    expect(tasks.length).toBe(1);
    expect(tasks[0].id).toBe(task2.id);

    // Deleting non-existent task returns false
    const deletedAgain = await manager.deleteTask("non-existent-id");
    expect(deletedAgain).toBe(false);
  });

  it("persists active project state across reloads", async () => {
    const project: ProjectContext = {
      id: "test-aurora-proj",
      name: "Aurora Project",
      rootPath: tmpDir,
      type: "node_typescript",
      primaryLanguage: "TypeScript",
      frameworks: ["React", "Electron"],
      summary: "Aurora intelligence project",
      status: "active",
      tasks: [],
    };

    await store.saveProject(project);
    await store.setActiveProject(project.id);

    const active = await store.getActiveProject();
    expect(active?.id).toBe("test-aurora-proj");
    expect(active?.name).toBe("Aurora Project");
  });
});
