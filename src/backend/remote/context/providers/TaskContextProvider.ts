/**
 * TaskContextProvider
 * Phase 22 — Mobile Context Intelligence
 *
 * Provides current active user task / plan context.
 */

import type { IContextProvider, TaskContextData } from "../MobileContextTypes.ts";

export class TaskContextProvider implements IContextProvider<TaskContextData> {
  readonly category = "task" as const;

  private currentTask: TaskContextData = {};

  setActiveTask(task: TaskContextData): void {
    this.currentTask = { ...task };
  }

  clearActiveTask(): void {
    this.currentTask = {};
  }

  getContext(options?: { rawPayload?: unknown }): TaskContextData {
    const raw = (options?.rawPayload as Partial<TaskContextData>) || {};
    return {
      activeTaskId: raw.activeTaskId || this.currentTask.activeTaskId,
      taskName: raw.taskName || this.currentTask.taskName,
      status: raw.status || this.currentTask.status,
      currentGoal: raw.currentGoal || this.currentTask.currentGoal,
    };
  }
}
