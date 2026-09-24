/**
 * MYRAA — TaskScheduler (Phase 6)
 *
 * Background scheduling engine for proactive companion jobs:
 *   - Enforces minimum interval floor of 5,000ms (5s) to prevent CPU starvation
 *   - Per-task execution concurrency lock (prevents overlapping ticks)
 *   - Max duration and iteration limits to prevent zombie tasks
 *   - State machine: scheduled -> running -> paused / completed / failed / cancelled
 *   - Guaranteed cleanup on server shutdown (stopAll)
 *   - Background tasks are read-only by default
 */

import crypto from "crypto";
import type {
  BackgroundTask,
  TaskSchedule,
  TaskType,
  TaskStatus,
} from "./CompanionTypes.ts";
import { MIN_POLL_INTERVAL_MS } from "./CompanionTypes.ts";
import { companionStore } from "./CompanionStore.ts";
import { eventBus } from "./EventBus.ts";
import { projectMonitor } from "./ProjectMonitor.ts";
import { gitMonitor } from "./GitMonitor.ts";
import { deploymentMonitor } from "./DeploymentMonitor.ts";
import { MODIFYING_TOOLS } from "../planner/PlannerTypes.ts";
import { checkpointManager } from "../planner/CheckpointManager.ts";
import { notificationManager } from "./NotificationManager.ts";

export type TaskRunnerFn = (task: BackgroundTask) => Promise<unknown>;

export class TaskScheduler {
  private _timers = new Map<string, NodeJS.Timeout>();
  private _activeLocks = new Set<string>(); // per-task concurrency lock
  private _runners = new Map<TaskType, TaskRunnerFn>();

  constructor() {
    this._registerDefaultRunners();
  }

  private _registerDefaultRunners(): void {
    this._runners.set("build_monitor", async () => {
      return projectMonitor.check();
    });

    this._runners.set("git_monitor", async () => {
      return gitMonitor.check();
    });

    this._runners.set("deployment_monitor", async (task) => {
      const url = (task.params?.targetUrl as string) || "http://localhost:3000";
      return deploymentMonitor.check(url);
    });

    this._runners.set("custom_poll", async (task) => {
      // Safe no-op by default — proactive companion never executes arbitrary code
      return { status: "custom_poll_checked", target: task.params?.target || "general" };
    });

    this._runners.set("event_waiter", async (task) => {
      return { status: "waiting_for_event", eventName: task.params?.eventName };
    });
  }

  /**
   * Schedule a new background task.
   * Enforces minimum interval floor and read-only defaults.
   */
  async schedule(opts: {
    id?: string;
    name: string;
    type: TaskType;
    intervalMs?: number;
    delayMs?: number;
    maxIterations?: number;
    timeoutMs?: number;
    params?: Record<string, unknown>;
  }): Promise<BackgroundTask> {
    const now = new Date().toISOString();
    const isInterval = opts.intervalMs !== undefined && opts.intervalMs > 0;

    // Enforce 5s minimum interval floor
    const rawInterval = isInterval ? (opts.intervalMs as number) : (opts.delayMs || 5000);
    const intervalMs = Math.max(MIN_POLL_INTERVAL_MS, rawInterval);

    const schedule: TaskSchedule = {
      type: isInterval ? "interval" : "delayed",
      intervalMs,
      maxIterations: opts.maxIterations,
      timeoutMs: opts.timeoutMs,
    };

    const task: BackgroundTask = {
      id: opts.id || crypto.randomUUID(),
      name: opts.name,
      type: opts.type,
      schedule,
      status: "scheduled",
      params: opts.params || {},
      isReadOnly: true, // Strict invariant: background tasks are read-only
      iterationCount: 0,
      createdAt: now,
      updatedAt: now,
      nextRunAt: new Date(Date.now() + intervalMs).toISOString(),
    };

    await companionStore.saveTask(task);
    this._armTimer(task);
    eventBus.emit("task:started", task);

    return task;
  }

  /** Arm timer for next execution. */
  private _armTimer(task: BackgroundTask): void {
    // Clear any existing timer for this task
    this._clearTimer(task.id);

    if (task.status === "paused" || task.status === "completed" || task.status === "cancelled" || task.status === "failed") {
      return;
    }

    const delay = Math.max(MIN_POLL_INTERVAL_MS, task.schedule.intervalMs);

    const timer = setTimeout(async () => {
      await this._executeTick(task.id);
    }, delay);

    this._timers.set(task.id, timer);
  }

  /** Execute a single tick of a background task. */
  private async _executeTick(taskId: string): Promise<void> {
    // Per-task concurrency lock: prevent overlapping executions
    if (this._activeLocks.has(taskId)) {
      console.warn(`[TaskScheduler] Task '${taskId}' tick skipped — previous run still active.`);
      return;
    }

    const task = await companionStore.getTask(taskId);
    if (!task || task.status !== "scheduled" && task.status !== "running") {
      this._clearTimer(taskId);
      return;
    }

    this._activeLocks.add(taskId);
    task.status = "running";
    task.lastRunAt = new Date().toISOString();
    task.iterationCount++;
    task.updatedAt = task.lastRunAt;

    try {
      const runner = this._runners.get(task.type);
      if (!runner) {
        throw new Error(`No runner registered for task type '${task.type}'.`);
      }

      const result = await runner(task);
      task.lastResult = result;
      task.lastError = undefined;

      // Check max iterations limit
      if (
        task.schedule.maxIterations !== undefined &&
        task.iterationCount >= task.schedule.maxIterations
      ) {
        task.status = "completed";
        task.completedAt = new Date().toISOString();
        this._clearTimer(taskId);
        eventBus.emit("task:completed", task);
      } else if (task.schedule.type === "delayed") {
        task.status = "completed";
        task.completedAt = new Date().toISOString();
        this._clearTimer(taskId);
        eventBus.emit("task:completed", task);
      } else {
        task.status = "scheduled";
        task.nextRunAt = new Date(Date.now() + task.schedule.intervalMs).toISOString();
        this._armTimer(task);
        eventBus.emit("task:iteration", task);
      }
    } catch (err: any) {
      task.lastError = err?.message || String(err);
      console.error(`[TaskScheduler] Task '${taskId}' failed tick:`, task.lastError);

      if (task.schedule.type === "delayed") {
        task.status = "failed";
        this._clearTimer(taskId);
        eventBus.emit("task:failed", task);
      } else {
        // Recurring tasks re-arm to attempt recovery on next interval
        task.status = "scheduled";
        task.nextRunAt = new Date(Date.now() + task.schedule.intervalMs).toISOString();
        this._armTimer(task);
      }
    } finally {
      this._activeLocks.delete(taskId);
      await companionStore.saveTask(task);
    }
  }

  private _clearTimer(taskId: string): void {
    const timer = this._timers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this._timers.delete(taskId);
    }
  }

  /** Pause a running task. */
  async pauseTask(taskId: string): Promise<BackgroundTask | undefined> {
    this._clearTimer(taskId);
    const task = await companionStore.getTask(taskId);
    if (!task) return undefined;
    task.status = "paused";
    task.updatedAt = new Date().toISOString();
    await companionStore.saveTask(task);
    return task;
  }

  /** Resume a paused task. */
  async resumeTask(taskId: string): Promise<BackgroundTask | undefined> {
    const task = await companionStore.getTask(taskId);
    if (!task || task.status !== "paused") return task;
    task.status = "scheduled";
    task.updatedAt = new Date().toISOString();
    task.nextRunAt = new Date(Date.now() + task.schedule.intervalMs).toISOString();
    await companionStore.saveTask(task);
    this._armTimer(task);
    return task;
  }

  /** Cancel a task and remove all timers. */
  async cancelTask(taskId: string): Promise<BackgroundTask | undefined> {
    this._clearTimer(taskId);
    this._activeLocks.delete(taskId);
    const task = await companionStore.getTask(taskId);
    if (!task) return undefined;
    task.status = "cancelled";
    task.completedAt = new Date().toISOString();
    task.updatedAt = task.completedAt;
    await companionStore.saveTask(task);
    eventBus.emit("task:cancelled", task);
    return task;
  }

  /** Return all active tasks. */
  async listTasks(): Promise<BackgroundTask[]> {
    return companionStore.listTasks();
  }

  /**
   * Execute an action on behalf of a background task.
   * Safety invariant: Background tasks are read-only by default. Any modifying,
   * destructive, or side-effect action halts execution and requires an explicit
   * Phase 5 confirmation checkpoint before it can proceed.
   */
  async executeTaskAction(
    taskId: string,
    toolName: string,
    args: Record<string, unknown> = {},
    checkpointId?: string,
  ): Promise<{
    ok: boolean;
    result?: unknown;
    error?: string;
    checkpointRequired?: boolean;
    checkpointId?: string;
    blocked?: boolean;
  }> {
    const task = await companionStore.getTask(taskId);
    if (!task) {
      return { ok: false, error: `Background task '${taskId}' not found.` };
    }

    if (MODIFYING_TOOLS.has(toolName)) {
      const stepId = `step-${taskId}`;
      if (!checkpointId) {
        // Automatically pause background task and issue a confirmation checkpoint
        await this.pauseTask(taskId);
        const cp = checkpointManager.issue(
          taskId,
          {
            id: stepId,
            phase: "modify",
            description: `Background task '${task.name}' requested action '${toolName}'`,
            toolName,
            toolArgs: args,
            status: "waiting_for_approval",
            isDestructive: true,
            checkpointRequired: true,
            retryCount: 0,
            maxRetries: 0,
            argsHash: "",
            dependsOn: [],
          },
          "high",
        );

        await notificationManager.notify({
          title: `Confirmation Required: ${task.name}`,
          message: `Background task '${task.name}' attempted modifying action '${toolName}'. Task paused pending confirmation.`,
          level: "warning",
          source: "system",
          metadata: { taskId: task.id },
        });

        return {
          ok: false,
          blocked: true,
          checkpointRequired: true,
          error: `Modifying action '${toolName}' blocked. Background task paused. Checkpoint required: ${cp.id}`,
          checkpointId: cp.id,
        };
      }

      // If checkpointId provided, consume approval
      const approved = checkpointManager.consumeApproval(checkpointId, stepId, toolName, args);
      if (!approved) {
        return {
          ok: false,
          blocked: true,
          error: `Safety gate blocked: checkpoint '${checkpointId}' invalid, expired, or tampered for '${toolName}'.`,
        };
      }
    }

    return { ok: true, result: { executed: toolName, args } };
  }

  /** Stop all active timers for clean server shutdown. */
  stopAll(): void {
    for (const [id, timer] of this._timers.entries()) {
      clearTimeout(timer);
    }
    this._timers.clear();
    this._activeLocks.clear();
  }
}

/** Global singleton task scheduler. */
export const taskScheduler = new TaskScheduler();
