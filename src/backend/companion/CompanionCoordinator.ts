/**
 * MYRAA — CompanionCoordinator (Phase 6)
 *
 * Master orchestrator for the Proactive Companion engine:
 *   - Starts and stops background daemons on server lifecycle events
 *   - Restores persisted tasks on startup (without auto-executing destructive operations)
 *   - Routes proactive monitor events to NotificationManager
 *   - Broadcasts real-time events to connected WebSocket clients
 *   - Validates all task parameters, intervals, and URLs at entry boundaries
 *   - Provides unified interface for tools, REST APIs, and the Gemini Live session
 */

import type {
  BackgroundTask,
  TaskType,
  NotificationItem,
  CompanionPreferences,
  BuildStatusReport,
  GitMonitorReport,
  DeploymentMonitorReport,
} from "./CompanionTypes.ts";
import { MIN_POLL_INTERVAL_MS } from "./CompanionTypes.ts";
import { companionStore } from "./CompanionStore.ts";
import { taskScheduler } from "./TaskScheduler.ts";
import { eventBus } from "./EventBus.ts";
import { notificationManager } from "./NotificationManager.ts";
import { projectMonitor } from "./ProjectMonitor.ts";
import { gitMonitor } from "./GitMonitor.ts";
import { deploymentMonitor } from "./DeploymentMonitor.ts";
import { emergencyStopCoordinator } from "../remote/EmergencyStopCoordinator.ts";

export type ClientBroadcastFn = (payload: unknown) => void;

export class CompanionCoordinator {
  private _running = false;
  private _clientBroadcasts = new Set<ClientBroadcastFn>();
  private _unsubscribers: Array<() => void> = [];

  /** Register a callback to broadcast companion events to browser WebSocket clients. */
  registerClientBroadcast(fn: ClientBroadcastFn): () => void {
    this._clientBroadcasts.add(fn);
    return () => {
      this._clientBroadcasts.delete(fn);
    };
  }

  private _broadcast(payload: unknown): void {
    for (const fn of this._clientBroadcasts) {
      try { fn(payload); } catch { /* ignore dropped frames */ }
    }
  }

  /**
   * Start the proactive companion daemon.
   * Loads preferences, wires event bus listeners, and restores scheduled tasks.
   */
  async start(): Promise<void> {
    if (this._running) return;
    this._running = true;

    console.log("[Companion] Starting Proactive Companion background daemon...");

    // ── 1. Wire internal event bus to client broadcast ───────────────────
    this._unsubscribers.push(
      eventBus.on("notification:created", (event) => {
        this._broadcast({
          type: "companion_notification",
          notification: (event.data as any).notification,
          voiceAnnouncement: (event.data as any).voiceAnnouncement,
          suppressedByQuietHours: (event.data as any).suppressedByQuietHours,
        });
      }),
    );

    this._unsubscribers.push(
      eventBus.on("notification:voice", (event) => {
        this._broadcast({
          type: "companion_voice",
          announcement: event.data,
        });
      }),
    );

    this._unsubscribers.push(
      eventBus.on("task:iteration", (event) => {
        this._broadcast({
          type: "companion_task_update",
          task: event.data,
        });
      }),
    );

    // ── 2. Restore active background tasks from disk ──────────────────────
    try {
      const tasks = await companionStore.listTasks();
      for (const t of tasks.slice(0, 20)) {
        if (t.status === "scheduled" || t.status === "running") {
          // Re-arm scheduled tasks with minimum interval
          await taskScheduler.schedule({
            id: t.id,
            name: t.name,
            type: t.type,
            intervalMs: Math.max(MIN_POLL_INTERVAL_MS, t.schedule.intervalMs),
            params: t.params,
            maxIterations: t.schedule.maxIterations,
            timeoutMs: t.schedule.timeoutMs,
          });
        }
      }
    } catch (err) {
      console.warn("[Companion] Failed to restore background tasks from store:", err);
    }

    console.log("[Companion] Proactive Companion daemon online.");
  }

  /** Stop the companion daemon and clear all active timers. */
  stop(): void {
    if (!this._running) return;
    this._running = false;
    console.log("[Companion] Stopping Proactive Companion daemon...");

    taskScheduler.stopAll();
    for (const unsub of this._unsubscribers) {
      try { unsub(); } catch { /* ignore */ }
    }
    this._unsubscribers = [];
    eventBus.clear();
    console.log("[Companion] Proactive Companion daemon stopped.");
  }

  isRunning(): boolean {
    return this._running;
  }

  // ---------------------------------------------------------------------------
  // Task Scheduling & Management
  // ---------------------------------------------------------------------------

  /** Schedule a background task with input validation. */
  async scheduleTask(opts: {
    name: string;
    type: TaskType;
    intervalMs?: number;
    delayMs?: number;
    maxIterations?: number;
    timeoutMs?: number;
    params?: Record<string, unknown>;
  }): Promise<BackgroundTask> {
    if (emergencyStopCoordinator.isActive()) {
      throw new Error("EMERGENCY_STOP_ACTIVE: Cannot schedule background tasks while emergency stop is active.");
    }
    if (!opts.name || typeof opts.name !== "string" || !opts.name.trim()) {
      throw new Error("Task name is required.");
    }

    const validTypes: TaskType[] = [
      "build_monitor",
      "git_monitor",
      "deployment_monitor",
      "event_waiter",
      "custom_poll",
    ];
    if (!validTypes.includes(opts.type)) {
      throw new Error(`Invalid task type '${opts.type}'. Must be one of: ${validTypes.join(", ")}`);
    }

    // SSRF / URL validation for deployment tasks
    if (opts.type === "deployment_monitor") {
      const targetUrl = (opts.params?.targetUrl as string) || "http://localhost:3000";
      const validation = await deploymentMonitor.validateTargetUrl(targetUrl);
      if (!validation.allowed) {
        throw new Error(`Cannot schedule deployment monitor: ${validation.reason}`);
      }
    }

    return taskScheduler.schedule({
      name: opts.name.trim(),
      type: opts.type,
      intervalMs: opts.intervalMs,
      delayMs: opts.delayMs,
      maxIterations: opts.maxIterations,
      timeoutMs: opts.timeoutMs,
      params: opts.params,
    });
  }

  async listTasks(): Promise<BackgroundTask[]> {
    return taskScheduler.listTasks();
  }

  async cancelTask(taskId: string): Promise<BackgroundTask | undefined> {
    if (!taskId || typeof taskId !== "string") throw new Error("Task ID is required.");
    return taskScheduler.cancelTask(taskId);
  }

  async pauseTask(taskId: string): Promise<BackgroundTask | undefined> {
    return taskScheduler.pauseTask(taskId);
  }

  async resumeTask(taskId: string): Promise<BackgroundTask | undefined> {
    return taskScheduler.resumeTask(taskId);
  }

  // ---------------------------------------------------------------------------
  // Immediate Proactive Diagnostics
  // ---------------------------------------------------------------------------

  /** Run an immediate diagnostic check without waiting for a scheduled tick. */
  async triggerCheck(type: "build" | "git" | "deployment", targetUrl?: string): Promise<
    BuildStatusReport | GitMonitorReport | DeploymentMonitorReport
  > {
    if (emergencyStopCoordinator.isActive()) {
      throw new Error("EMERGENCY_STOP_ACTIVE: Cannot trigger diagnostics while emergency stop is active.");
    }
    if (type === "build") {
      return projectMonitor.check();
    }
    if (type === "git") {
      return gitMonitor.check();
    }
    if (type === "deployment") {
      const url = targetUrl || "http://localhost:3000";
      return deploymentMonitor.check(url);
    }
    throw new Error(`Unknown check type '${type}'. Must be 'build', 'git', or 'deployment'.`);
  }

  /** Pause all running and scheduled background tasks when an Emergency Stop is triggered. */
  async emergencyStop(): Promise<void> {
    const tasks = await this.listTasks();
    for (const task of tasks) {
      if (task.status === "scheduled" || task.status === "running") {
        await this.pauseTask(task.id);
      }
    }
    console.log("[Companion] Paused all active background tasks due to EMERGENCY STOP.");
  }

  // ---------------------------------------------------------------------------
  // Notifications & Preferences
  // ---------------------------------------------------------------------------

  async listNotifications(): Promise<NotificationItem[]> {
    return notificationManager.listNotifications();
  }

  async dismissNotification(id: string): Promise<NotificationItem | undefined> {
    return notificationManager.dismissNotification(id);
  }

  async clearNotifications(): Promise<void> {
    return notificationManager.clearNotifications();
  }

  async getPreferences(): Promise<CompanionPreferences> {
    return companionStore.getPreferences();
  }

  async updatePreferences(patch: Partial<CompanionPreferences>): Promise<CompanionPreferences> {
    // Validate quiet hours format if provided
    if (patch.quietHours) {
      const { start, end } = patch.quietHours;
      const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;
      if (start && !timeRegex.test(start)) {
        throw new Error(`Invalid quiet hours start format '${start}'. Expected 'HH:mm' (e.g. '22:00').`);
      }
      if (end && !timeRegex.test(end)) {
        throw new Error(`Invalid quiet hours end format '${end}'. Expected 'HH:mm' (e.g. '08:00').`);
      }
    }

    // Validate polling intervals (minimum 5,000ms floor)
    if (patch.pollIntervals) {
      for (const [k, v] of Object.entries(patch.pollIntervals)) {
        if (typeof v === "number" && v < MIN_POLL_INTERVAL_MS) {
          throw new Error(
            `Poll interval '${k}' cannot be less than ${MIN_POLL_INTERVAL_MS}ms (5 seconds).`,
          );
        }
      }
    }

    const updated = await companionStore.savePreferences(patch);
    eventBus.emit("preferences:updated", updated);
    return updated;
  }
}

/** Global singleton companion coordinator. */
export const companionCoordinator = new CompanionCoordinator();
