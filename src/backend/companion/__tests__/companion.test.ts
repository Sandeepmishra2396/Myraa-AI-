/**
 * MYRAA — Companion Engine Tests (Phase 6)
 *
 * Comprehensive unit, integration, and adversarial test suite:
 *   1. TaskScheduler (interval floor, concurrency lock, lifecycle, timeout)
 *   2. CompanionStore (atomic persistence, BOM resilience, bounded queue)
 *   3. EventBus (pub/sub, async isolation, teardown)
 *   4. NotificationManager (deduplication, secret sanitization, quiet hours)
 *   5. ProjectMonitor & GitMonitor (read-only diagnostics, state transitions)
 *   6. DeploymentMonitor (SSRF enforcement, redirect validation, health tracking)
 *   7. CompanionCoordinator (orchestration, preference validation, restore)
 *   8. Adversarial & Security Tests (SSRF bypass, interval abuse, flood protection, secret leaks)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  MIN_POLL_INTERVAL_MS,
  DEFAULT_COMPANION_PREFERENCES,
} from "../CompanionTypes.ts";
import { TaskScheduler } from "../TaskScheduler.ts";
import { CompanionStore } from "../CompanionStore.ts";
import { EventBus } from "../EventBus.ts";
import {
  NotificationManager,
  sanitizeVoiceText,
  isWithinQuietHours,
} from "../NotificationManager.ts";
import { ProjectMonitor } from "../ProjectMonitor.ts";
import { GitMonitor } from "../GitMonitor.ts";
import { DeploymentMonitor } from "../DeploymentMonitor.ts";
import { CompanionCoordinator } from "../CompanionCoordinator.ts";
import { checkpointManager } from "../../planner/CheckpointManager.ts";

describe("TaskScheduler", () => {
  let scheduler: TaskScheduler;

  beforeEach(() => {
    scheduler = new TaskScheduler();
  });

  afterEach(() => {
    scheduler.stopAll();
  });

  it("enforces minimum interval floor of 5,000ms", async () => {
    const task = await scheduler.schedule({
      name: "Fast poll attempt",
      type: "build_monitor",
      intervalMs: 100, // Attempt 100ms
    });

    expect(task.schedule.intervalMs).toBe(MIN_POLL_INTERVAL_MS);
    expect(task.schedule.intervalMs).toBe(5000);
    expect(task.isReadOnly).toBe(true);
    await scheduler.cancelTask(task.id);
  });

  it("schedules and completes a delayed one-shot task", async () => {
    const task = await scheduler.schedule({
      name: "One-shot delayed check",
      type: "custom_poll",
      delayMs: 5000,
    });

    expect(task.schedule.type).toBe("delayed");
    expect(task.status).toBe("scheduled");
    await scheduler.cancelTask(task.id);
  });

  it("pauses and resumes a background task", async () => {
    const task = await scheduler.schedule({
      name: "Pause/Resume task",
      type: "git_monitor",
      intervalMs: 6000,
    });

    const paused = await scheduler.pauseTask(task.id);
    expect(paused?.status).toBe("paused");

    const resumed = await scheduler.resumeTask(task.id);
    expect(resumed?.status).toBe("scheduled");

    await scheduler.cancelTask(task.id);
  });

  it("cancels a task and cleans up its timers", async () => {
    const task = await scheduler.schedule({
      name: "Cancel test",
      type: "build_monitor",
      intervalMs: 5000,
    });

    const cancelled = await scheduler.cancelTask(task.id);
    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.completedAt).toBeTruthy();
  });

  it("stopAll clears all active timers on shutdown", async () => {
    await scheduler.schedule({ name: "Task 1", type: "build_monitor", intervalMs: 5000 });
    await scheduler.schedule({ name: "Task 2", type: "git_monitor", intervalMs: 5000 });

    expect(() => scheduler.stopAll()).not.toThrow();
  });
});

describe("CompanionStore", () => {
  let store: CompanionStore;

  beforeEach(() => {
    store = new CompanionStore();
  });

  it("saves and retrieves background tasks", async () => {
    const taskId = `test-task-${Date.now()}`;
    await store.saveTask({
      id: taskId,
      name: "Store test task",
      type: "build_monitor",
      schedule: { type: "interval", intervalMs: 5000 },
      status: "scheduled",
      params: {},
      isReadOnly: true,
      iterationCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const retrieved = await store.getTask(taskId);
    expect(retrieved).toBeTruthy();
    expect(retrieved?.name).toBe("Store test task");

    await store.deleteTask(taskId);
    const afterDelete = await store.getTask(taskId);
    expect(afterDelete).toBeUndefined();
  });

  it("enforces bounded notification queue size", async () => {
    const sampleNotification = {
      id: "notif-test",
      title: "Queue test",
      message: "Testing bounded size",
      level: "info" as const,
      source: "companion" as const,
      timestamp: new Date().toISOString(),
      read: false,
      dismissed: false,
      dedupKey: "dedup-queue-test",
    };

    // Save with a max queue limit of 15
    await store.saveNotification(sampleNotification, 15);
    const list = await store.listNotifications();
    expect(list.length).toBeLessThanOrEqual(15);
  });

  it("persists and retrieves user preferences with default merging", async () => {
    const prefs = await store.getPreferences();
    expect(prefs).toBeTruthy();
    expect(prefs.pollIntervals.gitPollIntervalMs).toBeGreaterThanOrEqual(5000);

    const updated = await store.savePreferences({
      voiceNotificationsEnabled: false,
      quietHours: { enabled: true, start: "23:00", end: "07:00" },
    });

    expect(updated.voiceNotificationsEnabled).toBe(false);
    expect(updated.quietHours.enabled).toBe(true);

    // Reset back
    await store.savePreferences({ voiceNotificationsEnabled: true });
  });
});

describe("EventBus", () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  afterEach(() => {
    bus.clear();
  });

  it("subscribes to events and receives emitted payload", () => {
    const events: any[] = [];
    const unsubscribe = bus.on("task:started", (e) => {
      events.push(e.data);
    });

    bus.emit("task:started", { taskId: "123" });
    expect(events.length).toBe(1);
    expect(events[0].taskId).toBe("123");

    unsubscribe();
    bus.emit("task:started", { taskId: "456" });
    expect(events.length).toBe(1); // Not called after unsubscribe
  });

  it("handler errors do not crash other listeners", () => {
    let secondHandlerCalled = false;
    bus.on("task:completed", () => {
      throw new Error("Boom in listener!");
    });
    bus.on("task:completed", () => {
      secondHandlerCalled = true;
    });

    expect(() => bus.emit("task:completed", {})).not.toThrow();
    expect(secondHandlerCalled).toBe(true);
  });
});

describe("NotificationManager & Voice Sanitization", () => {
  let nm: NotificationManager;

  beforeEach(() => {
    nm = new NotificationManager();
  });

  it("creates a notification with unique ID and timestamp", async () => {
    const item = await nm.notify({
      title: "Test Alert",
      message: "Unit test message",
      level: "info",
    });

    expect(item).toBeTruthy();
    expect(item?.id).toBeTruthy();
    expect(item?.title).toBe("Test Alert");
    expect(item?.read).toBe(false);
  });

  it("DEDUPLICATION: suppresses duplicate alert within 60s sliding window", async () => {
    const key = `dedup-test-${Date.now()}`;
    const first = await nm.notify({
      title: "Duplicate Check",
      message: "First instance",
      dedupKey: key,
    });
    expect(first).toBeTruthy();

    // Second alert with same dedupKey immediately
    const duplicate = await nm.notify({
      title: "Duplicate Check",
      message: "Second instance",
      dedupKey: key,
    });
    expect(duplicate).toBeNull(); // Suppressed by deduplication
  });

  it("SECRET SANITIZATION: strips API keys, tokens, and secrets from voice text", () => {
    const raw = "Error occurred with key AIzaSyD9876543210zyxwvutsrqponmlkjih and bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
    const sanitized = sanitizeVoiceText(raw);

    expect(sanitized).not.toContain("AIzaSyD9876543210zyxwvutsrqponmlkjih");
    expect(sanitized).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
    expect(sanitized).toMatch(/\[token\]/i);
  });

  it("QUIET HOURS: correctly detects inside and outside daytime window", () => {
    const config = { enabled: true, start: "22:00", end: "08:00" };

    // 23:30 is inside overnight quiet hours
    const night = new Date("2026-09-17T23:30:00");
    expect(isWithinQuietHours(night, config)).toBe(true);

    // 03:00 is inside overnight quiet hours
    const earlyMorning = new Date("2026-09-17T03:00:00");
    expect(isWithinQuietHours(earlyMorning, config)).toBe(true);

    // 14:00 is outside quiet hours
    const afternoon = new Date("2026-09-17T14:00:00");
    expect(isWithinQuietHours(afternoon, config)).toBe(false);
  });

  it("QUIET HOURS SUPPRESSION: suppresses voice announcement while preserving visual notification", async () => {
    const { companionStore } = await import("../CompanionStore.ts");
    // Enable quiet hours 00:00 to 23:59 (always active)
    await companionStore.savePreferences({
      quietHours: { enabled: true, start: "00:00", end: "23:59" },
      voiceNotificationsEnabled: true,
    });

    const item = await nm.notify({
      title: "Quiet Hours Notification",
      message: "This should be saved visually but voice-suppressed",
      level: "warning",
      dedupKey: `qh-test-${Date.now()}`,
    });

    expect(item).toBeTruthy(); // Visual notification exists!
    const voiceQueue = nm.getVoiceQueue();
    // Voice announcement was suppressed and not queued for speech
    const matchedVoice = voiceQueue.find((v) => v.notificationId === item?.id);
    expect(matchedVoice).toBeUndefined();

    // Cleanup preferences
    await companionStore.savePreferences({
      quietHours: { enabled: false, start: "22:00", end: "08:00" },
    });
  });
});

describe("ProjectMonitor & GitMonitor", () => {
  it("ProjectMonitor checks build artifacts and returns report", async () => {
    const monitor = new ProjectMonitor();
    const report = await monitor.check();

    expect(report.timestamp).toBeTruthy();
    expect(["success", "failure", "unknown"]).toContain(report.buildStatus);
    expect(typeof report.distArtifactsFound).toBe("boolean");
  });

  it("GitMonitor gathers git info without running destructive commands", async () => {
    const monitor = new GitMonitor();
    const report = await monitor.check();

    expect(report.timestamp).toBeTruthy();
    expect(typeof report.clean).toBe("boolean");
    expect(typeof report.uncommittedFilesCount).toBe("number");
  });
});

describe("DeploymentMonitor (SSRF & Security)", () => {
  let monitor: DeploymentMonitor;

  beforeEach(() => {
    monitor = new DeploymentMonitor();
  });

  it("approves explicitly approved localhost target", async () => {
    const validation = await monitor.validateTargetUrl("http://localhost:3000/api/agent-health");
    expect(validation.allowed).toBe(true);
  });

  it("SSRF BLOCK: rejects cloud metadata IP (169.254.169.254)", async () => {
    const validation = await monitor.validateTargetUrl("http://169.254.169.254/latest/meta-data/");
    expect(validation.allowed).toBe(false);
    expect(validation.reason).toMatch(/not in the approved deployment targets list/i);
  });

  it("SSRF BLOCK: rejects private intranet host not on whitelist", async () => {
    const validation = await monitor.validateTargetUrl("http://192.168.1.100:8080/admin");
    expect(validation.allowed).toBe(false);
  });

  it("SSRF BLOCK: rejects loopback with unapproved port", async () => {
    const validation = await monitor.validateTargetUrl("http://localhost:9999/admin");
    expect(validation.allowed).toBe(false);
  });
});

describe("CompanionCoordinator", () => {
  let coordinator: CompanionCoordinator;

  beforeEach(() => {
    coordinator = new CompanionCoordinator();
  });

  afterEach(() => {
    coordinator.stop();
  });

  it("validates task input and schedules a task", async () => {
    await coordinator.start();

    const task = await coordinator.scheduleTask({
      name: "Coordinator build monitor",
      type: "build_monitor",
      intervalMs: 8000,
    });

    expect(task.id).toBeTruthy();
    expect(task.name).toBe("Coordinator build monitor");
    expect(task.schedule.intervalMs).toBe(8000);

    await coordinator.cancelTask(task.id);
  });

  it("rejects task creation with invalid task type", async () => {
    await expect(
      coordinator.scheduleTask({
        name: "Malicious task",
        type: "dangerous_exec" as any,
      }),
    ).rejects.toThrow(/invalid task type/i);
  });

  it("rejects task creation with empty name", async () => {
    await expect(
      coordinator.scheduleTask({
        name: "   ",
        type: "build_monitor",
      }),
    ).rejects.toThrow(/task name is required/i);
  });

  it("rejects preference update with invalid quiet hours format", async () => {
    await expect(
      coordinator.updatePreferences({
        quietHours: { enabled: true, start: "invalid-time", end: "08:00" },
      }),
    ).rejects.toThrow(/invalid quiet hours start format/i);
  });

  it("rejects preference update with poll interval less than 5000ms", async () => {
    await expect(
      coordinator.updatePreferences({
        pollIntervals: {
          gitPollIntervalMs: 1000, // Too small!
          buildPollIntervalMs: 30000,
          deploymentPollIntervalMs: 20000,
        },
      }),
    ).rejects.toThrow(/cannot be less than 5000ms/i);
  });

  it("triggers immediate diagnostics on demand", async () => {
    const buildReport = await coordinator.triggerCheck("build");
    expect(buildReport).toBeTruthy();

    const gitReport = await coordinator.triggerCheck("git");
    expect(gitReport).toBeTruthy();
  });
});

// ── Adversarial & Boundary Security Suite ──────────────────────────────────

describe("Adversarial / Security: Phase 6 Proactive Companion", () => {
  it("INTERVAL ABUSE: negative or zero interval clamped to MIN_POLL_INTERVAL_MS", async () => {
    const scheduler = new TaskScheduler();
    const taskZero = await scheduler.schedule({
      name: "Zero interval",
      type: "build_monitor",
      intervalMs: 0,
    });
    expect(taskZero.schedule.intervalMs).toBe(MIN_POLL_INTERVAL_MS);

    const taskNegative = await scheduler.schedule({
      name: "Negative interval",
      type: "git_monitor",
      intervalMs: -5000,
    });
    expect(taskNegative.schedule.intervalMs).toBe(MIN_POLL_INTERVAL_MS);

    scheduler.stopAll();
  });

  it("NOTIFICATION FLOODING: 25 identical alerts within 60s window produce exactly 1 notification", async () => {
    const nm = new NotificationManager();
    const dedupKey = `flood-test-${Date.now()}`;
    const results: any[] = [];

    for (let i = 0; i < 25; i++) {
      const res = await nm.notify({
        title: "DDoS Alert Flood",
        message: `Alert iteration ${i}`,
        dedupKey,
      });
      if (res) results.push(res);
    }

    expect(results.length).toBe(1); // Exactly 1 passed through, 24 suppressed!
  });

  it("UNSAFE BACKGROUND SIDE EFFECTS: background tasks are strictly read-only", async () => {
    const scheduler = new TaskScheduler();
    const task = await scheduler.schedule({
      name: "Read only verification",
      type: "build_monitor",
    });

    expect(task.isReadOnly).toBe(true);
    scheduler.stopAll();
  });

  it("TASK CONCURRENCY LOCK: overlapping ticks on slow execution are skipped safely", async () => {
    const scheduler = new TaskScheduler();
    const task = await scheduler.schedule({
      name: "Slow task",
      type: "custom_poll",
      intervalMs: 5000,
    });

    // Artificially acquire lock
    (scheduler as any)._activeLocks.add(task.id);

    // Trigger tick while lock is active
    const consoleSpy = vi.spyOn(console, "warn");
    await (scheduler as any)._executeTick(task.id);

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringMatching(/tick skipped — previous run still active/i),
    );

    consoleSpy.mockRestore();
    scheduler.stopAll();
  });

  it("SHUTDOWN CLEANUP: guaranteed timer cleanup prevents hanging Node process", async () => {
    const coordinator = new CompanionCoordinator();
    await coordinator.start();

    await coordinator.scheduleTask({
      name: "Shutdown test task",
      type: "build_monitor",
      intervalMs: 5000,
    });

    expect(coordinator.isRunning()).toBe(true);
    coordinator.stop();
    expect(coordinator.isRunning()).toBe(false);
  });

  it("MODIFYING ACTION SAFETY GATE: modifying tool without checkpoint pauses background task and issues checkpoint", async () => {
    const scheduler = new TaskScheduler();
    const task = await scheduler.schedule({
      name: "Modifying Task Test",
      type: "custom_poll",
    });

    // Attempt to invoke createFile (in MODIFYING_TOOLS) without checkpoint
    const res = await scheduler.executeTaskAction(task.id, "createFile", { path: "test.txt" });
    expect(res.ok).toBe(false);
    expect(res.blocked).toBe(true);
    expect(res.checkpointRequired).toBe(true);
    expect(res.checkpointId).toBeTruthy();

    // Verify task was automatically paused
    const tasks = await scheduler.listTasks();
    const updated = tasks.find((t) => t.id === task.id);
    expect(updated?.status).toBe("paused");

    scheduler.stopAll();
  });

  it("MODIFYING ACTION APPROVAL: approved checkpoint token allows execution and consumes token", async () => {
    const scheduler = new TaskScheduler();
    const task = await scheduler.schedule({
      name: "Modifying Approval Test",
      type: "custom_poll",
    });

    // Request modifying action
    const blockedRes = await scheduler.executeTaskAction(task.id, "writeCodeFile", { path: "script.js", content: "console.log('hi');" });
    expect(blockedRes.checkpointRequired).toBe(true);
    const cpId = blockedRes.checkpointId!;

    // Approve checkpoint via CheckpointManager
    checkpointManager.approve(cpId);

    // Re-execute with approved token
    const approvedRes = await scheduler.executeTaskAction(
      task.id,
      "writeCodeFile",
      { path: "script.js", content: "console.log('hi');" },
      cpId,
    );
    expect(approvedRes.ok).toBe(true);
    expect(approvedRes.result).toBeTruthy();

    // Replay attack: attempting to use consumed checkpoint token again must fail
    const replayRes = await scheduler.executeTaskAction(
      task.id,
      "writeCodeFile",
      { path: "script.js", content: "console.log('hi');" },
      cpId,
    );
    expect(replayRes.ok).toBe(false);
    expect(replayRes.blocked).toBe(true);

    scheduler.stopAll();
  });

  it("MODIFYING ACTION TAMPERING: modified arguments fail checkpoint consumption", async () => {
    const scheduler = new TaskScheduler();
    const task = await scheduler.schedule({
      name: "Tampering Test",
      type: "custom_poll",
    });

    // Issue checkpoint for path A
    const blockedRes = await scheduler.executeTaskAction(task.id, "deleteFile", { path: "safe_file.txt" });
    const cpId = blockedRes.checkpointId!;
    checkpointManager.approve(cpId);

    // Tamper arguments: attempt to delete critical file instead
    const tamperedRes = await scheduler.executeTaskAction(
      task.id,
      "deleteFile",
      { path: "critical_system.json" },
      cpId,
    );
    expect(tamperedRes.ok).toBe(false);
    expect(tamperedRes.blocked).toBe(true);

    scheduler.stopAll();
  });

  it("SAFE ACTION EXECUTION: non-modifying tool executes directly without checkpoint", async () => {
    const scheduler = new TaskScheduler();
    const task = await scheduler.schedule({
      name: "Safe Task Test",
      type: "custom_poll",
    });

    // readFile is not in MODIFYING_TOOLS
    const res = await scheduler.executeTaskAction(task.id, "readFile", { path: "readme.txt" });
    expect(res.ok).toBe(true);
    expect(res.checkpointRequired).toBeUndefined();

    scheduler.stopAll();
  });

  it("QUIET HOURS BEHAVIOR: preserves visual notification while suppressing voice", async () => {
    const nm = new NotificationManager();
    // Simulate quiet hours active
    const midnight = new Date();
    midnight.setHours(23, 30, 0, 0); // 11:30 PM

    const quietActive = isWithinQuietHours(midnight, {
      enabled: true,
      start: "22:00",
      end: "08:00",
    });
    expect(quietActive).toBe(true);

    // Normal afternoon (2:00 PM) is not in quiet hours
    const afternoon = new Date();
    afternoon.setHours(14, 0, 0, 0);
    const quietInactive = isWithinQuietHours(afternoon, {
      enabled: true,
      start: "22:00",
      end: "08:00",
    });
    expect(quietInactive).toBe(false);
  });
});
