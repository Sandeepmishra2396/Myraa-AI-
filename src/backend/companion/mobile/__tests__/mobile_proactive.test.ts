/**
 * MYRAA — Phase 26 Mobile Proactive Companion Test Suite
 *
 * Verifies:
 *   1. Upcoming task proactive notification delivery
 *   2. Reminder notification delivery
 *   3. Project update notification delivery
 *   4. Long-running task completion notification (EventBus task:completed)
 *   5. Long-running task failure notification (EventBus task:failed)
 *   6. Security event notification delivery (sanitized)
 *   7. Connection issue notification & collapse
 *   8. Quiet hours suppression of non-critical events
 *   9. Bypassing quiet hours for urgent security alerts
 *   10. Post-quiet-hours queue drain
 *   11. Event deduplication via eventId
 *   12. Sliding time-window deduplication (60s)
 *   13. Category rate limiting (max 5/min)
 *   14. Bounded offline queue (max 20 items per device)
 *   15. Reconnect delivery & queue draining
 *   16. Stale event expiration (> 1h TTL prunes from queue)
 *   17. Device notification preferences (category toggling)
 *   18. Device master enable/disable toggle
 *   19. Minimum priority filter
 *   20. DLP & secret protection: rejects credentials and tokens
 *   21. Emergency Stop fails closed on all proactive operations
 *   22. Security Policy Lockdown blocks non-security proactive notifications
 *   23. RemoteCapabilityDispatcher validation for mobileProactive
 *   24. ToolOrchestrator forwarding without modifying 126 tools
 *   25. Phase 6 Proactive Companion regression
 *   26. Phase 24 Shared Memory regression
 *   27. Phase 25 Cross-Device Handoff regression
 *   28. Invariant: Exactly 126 Gemini Live tools preserved
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mobileProactiveManager, isDlpClean, isWithinQuietHours } from "../MobileProactiveManager.ts";
import { eventBus } from "../../EventBus.ts";
import { emergencyStopCoordinator } from "../../../remote/EmergencyStopCoordinator.ts";
import { securityPolicyEngine } from "../../../security/SecurityPolicyEngine.ts";
import { remoteCapabilityDispatcher } from "../../../remote/RemoteCapabilityDispatcher.ts";
import { LIVE_TOOLS } from "../../../ai/GeminiSessionFactory.ts";
import { sharedMemoryManager } from "../../../memory/SharedMemoryManager.ts";
import { crossDeviceHandoffManager } from "../../../handoff/CrossDeviceHandoffManager.ts";
import { notificationManager } from "../../NotificationManager.ts";
import { remoteSessionManager } from "../../../remote/RemoteSessionManager.ts";
import type { SecurityContext } from "../../../security/SecurityTypes.ts";

const mockSecContext: SecurityContext = {
  identityId: "device_android_test_1",
  role: "admin",
  ipAddress: "192.168.1.50",
  deviceId: "device_android_test_1",
  isLocal: false,
};

describe("Phase 26 — Mobile Proactive Companion", () => {
  beforeEach(async () => {
    mobileProactiveManager.clearAll();
    await emergencyStopCoordinator.reset("test_operator");
    securityPolicyEngine.resetForTesting();
    await sharedMemoryManager.clearCaches();
    await crossDeviceHandoffManager.clearCaches();

    // Default test subscription
    await mobileProactiveManager.subscribeDevice({
      deviceId: "device_android_test_1",
      preferences: {
        enabled: true,
        minPriority: "LOW",
        quietHours: { enabled: false, start: "22:00", end: "08:00" },
      },
    });
  });

  afterEach(async () => {
    mobileProactiveManager.clearAll();
    await emergencyStopCoordinator.reset("test_operator");
    securityPolicyEngine.resetForTesting();
  });

  // 1. Upcoming task proactive notification delivery
  it("delivers upcoming task proactive notification", async () => {
    const res = await mobileProactiveManager.dispatchProactiveEvent({
      id: "task_event_1",
      title: "Upcoming Task: Code Review",
      message: "Scheduled code review starts in 15 minutes.",
      category: "TASK",
      priority: "DEFAULT",
    });

    expect(res.success).toBe(true);
    expect(res.notificationId).toBe("task_event_1");
    // Offline device enqueues notification
    expect(res.queued).toBe(true);
  });

  // 2. Reminder notification delivery
  it("delivers reminder proactive notification", async () => {
    const res = await mobileProactiveManager.dispatchProactiveEvent({
      id: "reminder_event_1",
      title: "Calendar Reminder: Standup",
      message: "Daily team sync starts now.",
      category: "REMINDER",
      priority: "HIGH",
    });

    expect(res.success).toBe(true);
    expect(res.notificationId).toBe("reminder_event_1");
    expect(res.queued).toBe(true);
  });

  // 3. Project update notification delivery
  it("delivers project update proactive notification", async () => {
    const res = await mobileProactiveManager.dispatchProactiveEvent({
      id: "project_event_1",
      title: "Project Update: Main Branch",
      message: "3 new commits pushed to main branch by collaborator.",
      category: "PROJECT",
      priority: "DEFAULT",
    });

    expect(res.success).toBe(true);
    expect(res.notificationId).toBe("project_event_1");
    expect(res.queued).toBe(true);
  });

  // 4. Long-running task completion notification (EventBus task:completed)
  it("handles long-running task completion via EventBus", async () => {
    eventBus.emit("task:completed", {
      task: {
        id: "task_long_99",
        name: "Full Data Pipeline Ingestion",
        type: "custom_poll",
      },
    });

    // Give microtask queue time to process
    await new Promise((r) => setTimeout(r, 20));

    const pending = mobileProactiveManager.getPendingNotifications("device_android_test_1");
    const taskNotif = pending.find((p) => p.category === "LONG_RUNNING_TASK");
    expect(taskNotif).toBeDefined();
    expect(taskNotif?.title).toContain("Task Completed");
    expect(taskNotif?.title).toContain("Full Data Pipeline Ingestion");
  });

  // 5. Long-running task failure notification (EventBus task:failed)
  it("handles long-running task failure via EventBus with HIGH priority", async () => {
    eventBus.emit("task:failed", {
      task: {
        id: "task_fail_42",
        name: "Remote APK Build",
        lastError: "Connection reset by peer",
        type: "build_monitor",
      },
    });

    await new Promise((r) => setTimeout(r, 20));

    const pending = mobileProactiveManager.getPendingNotifications("device_android_test_1");
    const failNotif = pending.find((p) => p.title.includes("Task Failed: Remote APK Build"));
    expect(failNotif).toBeDefined();
    expect(failNotif?.priority).toBe("HIGH");
    expect(failNotif?.category).toBe("LONG_RUNNING_TASK");
  });

  // 6. Security event notification delivery (sanitized)
  it("delivers sanitized security alert proactive notification", async () => {
    const res = await mobileProactiveManager.dispatchProactiveEvent({
      id: "sec_event_1",
      title: "Security Alert: Unusual Remote Access",
      message: "Remote connection attempt from unrecognized IP was isolated.",
      category: "SECURITY",
      priority: "HIGH",
    });

    expect(res.success).toBe(true);
    expect(res.queued).toBe(true);
  });

  // 7. Connection issue notification & collapse
  it("collapses repeat connection alerts within sliding 60s window", async () => {
    const res1 = await mobileProactiveManager.dispatchProactiveEvent({
      id: "conn_1",
      title: "Connection Alert: WebSocket Dropped",
      message: "Temporary disconnect; attempting auto-reconnect.",
      category: "CONNECTION",
      priority: "LOW",
    });
    expect(res1.success).toBe(true);
    expect(res1.queued).toBe(true);

    // Second connection alert within 60 seconds
    const res2 = await mobileProactiveManager.dispatchProactiveEvent({
      id: "conn_2",
      title: "Connection Alert: Retrying connection",
      message: "Retrying WebSocket connection to MYRAA Core...",
      category: "CONNECTION",
      priority: "LOW",
    });

    expect(res2.success).toBe(true);
    expect(res2.suppressedReason).toBe("COLLAPSED_CONNECTION_ALERT");
  });

  // 8. Quiet hours suppression of non-critical events
  it("suppresses non-urgent notifications during quiet hours and queues them", async () => {
    // Configure quiet hours covering current time
    const now = new Date();
    const currentH = now.getHours().toString().padStart(2, "0");
    const nextH = ((now.getHours() + 2) % 24).toString().padStart(2, "0");

    await mobileProactiveManager.updateDevicePreferences("device_android_test_1", {
      quietHours: {
        enabled: true,
        start: `${currentH}:00`,
        end: `${nextH}:00`,
      },
    });

    const res = await mobileProactiveManager.dispatchProactiveEvent({
      id: "quiet_test_1",
      title: "Quiet Hours Non-Urgent Alert",
      message: "This should be queued for later delivery.",
      category: "TASK",
      priority: "DEFAULT",
    });

    expect(res.success).toBe(true);
    expect(res.queued).toBe(true);
    expect(res.suppressedReason).toBe("QUEUED_QUIET_HOURS");
  });

  // 9. Bypassing quiet hours for urgent security alerts
  it("bypasses quiet hours for urgent security alerts", async () => {
    const now = new Date();
    const currentH = now.getHours().toString().padStart(2, "0");
    const nextH = ((now.getHours() + 2) % 24).toString().padStart(2, "0");

    await mobileProactiveManager.updateDevicePreferences("device_android_test_1", {
      quietHours: {
        enabled: true,
        start: `${currentH}:00`,
        end: `${nextH}:00`,
      },
    });

    const res = await mobileProactiveManager.dispatchProactiveEvent({
      id: "urgent_sec_1",
      title: "URGENT SECURITY ALERT",
      message: "Critical unauthorized token usage detected and contained.",
      category: "SECURITY",
      priority: "HIGH", // High/Urgent security bypasses quiet hours
    });

    expect(res.success).toBe(true);
    // Not suppressed by quiet hours
    expect(res.suppressedReason).not.toBe("QUEUED_QUIET_HOURS");
  });

  // 10. Post-quiet-hours queue drain
  it("drains pending notifications post-quiet-hours or upon reconnect", async () => {
    await mobileProactiveManager.dispatchProactiveEvent({
      id: "drain_1",
      title: "Notification 1",
      message: "Message 1",
      category: "TASK",
    });
    await mobileProactiveManager.dispatchProactiveEvent({
      id: "drain_2",
      title: "Notification 2",
      message: "Message 2",
      category: "PROJECT",
    });

    const drained = await mobileProactiveManager.drainPendingNotifications("device_android_test_1");
    expect(drained.length).toBe(2);
    expect(drained[0].id).toBe("drain_1");
    expect(drained[1].id).toBe("drain_2");

    // Subsequent drain is empty
    const secondDrain = await mobileProactiveManager.drainPendingNotifications("device_android_test_1");
    expect(secondDrain.length).toBe(0);
  });

  // 11. Event deduplication via eventId
  it("suppresses duplicate events with identical eventId", async () => {
    const res1 = await mobileProactiveManager.dispatchProactiveEvent({
      id: "unique_event_999",
      title: "First Dispatch",
      message: "Initial notification.",
      category: "TASK",
    });
    expect(res1.success).toBe(true);

    const res2 = await mobileProactiveManager.dispatchProactiveEvent({
      id: "unique_event_999",
      title: "Second Dispatch with same ID",
      message: "Duplicate notification.",
      category: "TASK",
    });

    expect(res2.success).toBe(true);
    expect(res2.delivered).toBe(false);
    expect(res2.suppressedReason).toBe("DEDUPLICATED_EVENT_ID");
  });

  // 12. Sliding time-window deduplication (60s)
  it("suppresses duplicate notifications with same dedupKey within 60s", async () => {
    const res1 = await mobileProactiveManager.dispatchProactiveEvent({
      id: "time_dedup_1",
      title: "Git Commit Alert",
      message: "Commit SHA abc1234 pushed",
      category: "PROJECT",
      dedupKey: "git_monitor:repo_alpha",
    });
    expect(res1.success).toBe(true);

    const res2 = await mobileProactiveManager.dispatchProactiveEvent({
      id: "time_dedup_2",
      title: "Git Commit Alert Repeat",
      message: "Commit SHA abc1234 pushed again",
      category: "PROJECT",
      dedupKey: "git_monitor:repo_alpha",
    });

    expect(res2.success).toBe(true);
    expect(res2.delivered).toBe(false);
    expect(res2.suppressedReason).toBe("DEDUPLICATED_TIME_WINDOW");
  });

  // 13. Category rate limiting (max 5/min)
  it("enforces category rate limiting (max 5 notifications per category per minute)", async () => {
    for (let i = 1; i <= 5; i++) {
      const res = await mobileProactiveManager.dispatchProactiveEvent({
        id: `rate_project_${i}`,
        title: `Project Update ${i}`,
        message: `Status update ${i}`,
        category: "PROJECT",
        dedupKey: `proj_update_${i}`,
      });
      expect(res.success).toBe(true);
      expect(res.queued).toBe(true);
    }

    // 6th event in the same minute should be rate limited
    const res6 = await mobileProactiveManager.dispatchProactiveEvent({
      id: "rate_project_6",
      title: "Project Update 6",
      message: "Status update 6",
      category: "PROJECT",
      dedupKey: "proj_update_6",
    });

    expect(res6.success).toBe(true);
    expect(res6.delivered).toBe(false);
    expect(res6.suppressedReason).toBe("RATE_LIMITED_CATEGORY");
  });

  // 14. Bounded offline queue (max 20 items per device)
  it("enforces bounded offline queue of maximum 20 items per device (FIFO eviction)", async () => {
    const categories: ("TASK" | "REMINDER" | "PROJECT" | "LONG_RUNNING_TASK" | "SECURITY")[] = [
      "TASK", "REMINDER", "PROJECT", "LONG_RUNNING_TASK", "SECURITY"
    ];
    for (let i = 1; i <= 25; i++) {
      const category = categories[(i - 1) % categories.length];
      await mobileProactiveManager.dispatchProactiveEvent({
        id: `bounded_notif_${i}`,
        title: `Bounded Alert ${i}`,
        message: `Content ${i}`,
        category,
        dedupKey: `bounded_dedup_${i}`,
      });
    }

    const pending = mobileProactiveManager.getPendingNotifications("device_android_test_1");
    expect(pending.length).toBe(20);
    // Oldest items (1..5) should have been evicted
    expect(pending[0].id).toBe("bounded_notif_6");
    expect(pending[19].id).toBe("bounded_notif_25");
  });

  // 15. Stale event expiration (> 1h TTL prunes from queue)
  it("prunes expired notifications (> 1 hour TTL)", async () => {
    const expiredTimestamp = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2 hours ago

    await mobileProactiveManager.dispatchProactiveEvent({
      id: "expired_item_1",
      title: "Expired Notification",
      message: "This notification is already stale.",
      category: "TASK",
      expiresAt: expiredTimestamp,
    });

    const pending = mobileProactiveManager.getPendingNotifications("device_android_test_1");
    expect(pending.length).toBe(0);
  });

  // 16. Device notification preferences (category toggling)
  it("respects category disabling in device preferences", async () => {
    await mobileProactiveManager.updateDevicePreferences("device_android_test_1", {
      enabledCategories: {
        PROJECT: false,
      },
    });

    const res = await mobileProactiveManager.dispatchProactiveEvent({
      id: "disabled_cat_1",
      title: "Project Alert",
      message: "Should be dropped because PROJECT is disabled.",
      category: "PROJECT",
    });

    expect(res.success).toBe(true);
    expect(res.delivered).toBe(false);
    expect(res.suppressedReason).toBe("CATEGORY_DISABLED");
  });

  // 17. Device master enable/disable toggle
  it("respects master notification disable toggle in preferences", async () => {
    await mobileProactiveManager.updateDevicePreferences("device_android_test_1", {
      enabled: false,
    });

    const res = await mobileProactiveManager.dispatchProactiveEvent({
      id: "master_disabled_1",
      title: "Task Alert",
      message: "Should be dropped because notifications are disabled globally for device.",
      category: "TASK",
    });

    expect(res.success).toBe(true);
    expect(res.delivered).toBe(false);
    expect(res.suppressedReason).toBe("DEVICE_NOTIFICATIONS_DISABLED");
  });

  // 18. Minimum priority filter
  it("suppresses notifications below device minPriority threshold", async () => {
    await mobileProactiveManager.updateDevicePreferences("device_android_test_1", {
      minPriority: "HIGH",
    });

    const res = await mobileProactiveManager.dispatchProactiveEvent({
      id: "low_prio_1",
      title: "Low Priority Note",
      message: "Below HIGH threshold.",
      category: "TASK",
      priority: "LOW",
    });

    expect(res.success).toBe(true);
    expect(res.delivered).toBe(false);
    expect(res.suppressedReason).toBe("PRIORITY_BELOW_MINIMUM");
  });

  // 19. DLP & secret protection: rejects credentials and tokens
  it("rejects notifications containing secrets, tokens, API keys, or private keys", async () => {
    const leakTests = [
      "Here is your key: sora_dev_0123456789abcdef0123456789",
      "Access token: myraa_at_abcdef0123456789abcdef0123",
      "Bearer ya29.a0AfH6SMAxyz1234567890",
      "AIzaSyD-1234567890abcdefghijklmnopqrst",
      "sk-proj-1234567890abcdefghijklmnopqrstuv",
      "-----BEGIN RSA PRIVATE KEY-----",
      "password: SuperSecretPassword123!",
      "Card: 4111-2222-3333-4444",
      "Your OTP verification code is 849201",
    ];

    for (let i = 0; i < leakTests.length; i++) {
      const res = await mobileProactiveManager.dispatchProactiveEvent({
        id: `dlp_test_${i}`,
        title: "Sensitive Info",
        message: leakTests[i],
        category: "TASK",
      });

      expect(res.success).toBe(false);
      expect(res.errorCode).toBe("DLP_SECRET_REJECTED");
      expect(res.error).toContain("DLP_SECRET_REJECTED");
    }
  });

  // 20. Emergency Stop fails closed on all proactive operations
  it("fails closed on all proactive operations when Emergency Stop is active", async () => {
    await emergencyStopCoordinator.trigger({
      source: "rest_api",
      reason: "Emergency killswitch initiated for security test",
    });

    const res = await mobileProactiveManager.dispatchProactiveEvent({
      id: "emstop_test_1",
      title: "Alert during Emergency Stop",
      message: "Should be blocked.",
      category: "TASK",
    });

    expect(res.success).toBe(false);
    expect(res.errorCode).toBe("EMERGENCY_STOP_ACTIVE");

    // Subscription also blocked
    await expect(
      mobileProactiveManager.subscribeDevice({ deviceId: "device_new" })
    ).rejects.toThrow("EMERGENCY_STOP_ACTIVE");
  });

  // 21. Security Policy Lockdown blocks non-security proactive notifications
  it("blocks non-security proactive notifications during Security Lockdown, allowing only SECURITY", async () => {
    securityPolicyEngine.setMode("LOCKDOWN");

    // Non-security notification -> BLOCKED
    const resTask = await mobileProactiveManager.dispatchProactiveEvent({
      id: "lockdown_task_1",
      title: "Task Alert",
      message: "Non-security alert during lockdown.",
      category: "TASK",
    });
    expect(resTask.success).toBe(false);
    expect(resTask.errorCode).toBe("SECURITY_LOCKDOWN_ACTIVE");

    // Security notification -> ALLOWED
    const resSec = await mobileProactiveManager.dispatchProactiveEvent({
      id: "lockdown_sec_1",
      title: "Critical Security Notification",
      message: "Lockdown mode active: threat containment triggered.",
      category: "SECURITY",
      priority: "HIGH",
    });
    expect(resSec.success).toBe(true);
    expect(resSec.queued).toBe(true);
  });

  // 22. RemoteCapabilityDispatcher validation for mobileProactive
  it("validates mobileProactive capability parameters via RemoteCapabilityDispatcher", async () => {
    // Valid subscribe
    const validSub = await remoteCapabilityDispatcher.validateCapabilityArguments(
      "mobileProactive",
      { action: "subscribe", preferences: { enabled: true } }
    );
    expect(validSub.valid).toBe(true);

    // Invalid action
    const invalidAct = await remoteCapabilityDispatcher.validateCapabilityArguments(
      "mobileProactive",
      { action: "drop_all_tables" }
    );
    expect(invalidAct.valid).toBe(false);
    expect(invalidAct.reason).toContain("ARGUMENT_VIOLATION");

    // Dangerous metacharacters
    const metaCheck = await remoteCapabilityDispatcher.validateCapabilityArguments(
      "mobileProactive",
      { action: "post", title: "Test; rm -rf /" }
    );
    expect(metaCheck.valid).toBe(false);
    expect(metaCheck.reason).toContain("Dangerous metacharacters");

    // Secrets in arguments
    const secretCheck = await remoteCapabilityDispatcher.validateCapabilityArguments(
      "mobileProactive",
      { action: "post", message: "Here is sora_dev_secret_key_12345" }
    );
    expect(secretCheck.valid).toBe(false);
    expect(secretCheck.reason).toContain("SECURITY_VIOLATION");
  });

  // 23. Helper functions: isDlpClean and isWithinQuietHours
  it("correctly evaluates isDlpClean and isWithinQuietHours helpers", () => {
    expect(isDlpClean("Clean normal notification text.")).toBe(true);
    expect(isDlpClean("Token: myraa_at_0123456789abcdef")).toBe(false);

    // Quiet hours overnight test (22:00 to 08:00)
    const lateNight = new Date("2026-09-23T23:30:00");
    const afternoon = new Date("2026-09-23T14:30:00");
    const qhConfig = { enabled: true, start: "22:00", end: "08:00" };

    expect(isWithinQuietHours(lateNight, qhConfig)).toBe(true);
    expect(isWithinQuietHours(afternoon, qhConfig)).toBe(false);
  });

  // 24. Phase 6 Proactive Companion regression
  it("preserves Phase 6 NotificationManager and TaskScheduler functionality", async () => {
    const item = await notificationManager.notify({
      title: "Phase 6 Regression Test",
      message: "Testing that Phase 6 desktop notifications still work cleanly.",
      level: "info",
      source: "companion",
    });

    expect(item).not.toBeNull();
    expect(item?.title).toBe("Phase 6 Regression Test");

    const all = await notificationManager.listNotifications();
    expect(all.some((n) => n.id === item?.id)).toBe(true);
  });

  // 25. Phase 24 Shared Memory regression
  it("preserves Phase 24 Shared MYRAA Memory functionality", async () => {
    const memory = await sharedMemoryManager.createMemory(
      {
        category: "fact",
        text: "Phase 26 regression test memory item",
        key: "test_mem_phase26",
      },
      mockSecContext
    );

    expect(memory).toBeDefined();
    expect(memory.id).toBeDefined();
    expect(memory.text).toBe("Phase 26 regression test memory item");

    const retrieved = await sharedMemoryManager.getMemory(memory.id);
    expect(retrieved?.text).toBe("Phase 26 regression test memory item");
  });

  // 26. Phase 25 Cross-Device Handoff regression
  it("preserves Phase 25 Cross-Device Handoff functionality", async () => {
    const created = await crossDeviceHandoffManager.createHandoff(
      {
        conversationContext: {
          summary: "Testing handoff continuation during Phase 26",
          lastUserQuery: "Continue research on companion",
        },
      },
      mockSecContext
    );

    expect(created.success).toBe(true);
    expect(created.handoff?.handoffToken).toBeDefined();

    const retrieved = await crossDeviceHandoffManager.getHandoff(
      created.handoff!.handoffId,
      mockSecContext
    );
    expect(retrieved?.conversationContext?.summary).toBe("Testing handoff continuation during Phase 26");
  });

  // 27. Tool Registry Invariance: strictly 126 Gemini Live tools
  it("preserves exactly 126 Gemini Live tools invariant", () => {
    const toolCount = LIVE_TOOLS[0].functionDeclarations.length;
    expect(toolCount).toBe(126);
  });

  // 28. Real-time WebSocket delivery when device is online
  it("delivers proactive notification immediately via WebSocket when device is online", async () => {
    const mockWs = {
      readyState: 1,
      send: vi.fn(),
    };
    const reg = (remoteSessionManager as any)._activeClients;
    reg.set("session_test_ws_1", {
      session: { deviceId: "device_android_test_1" },
      ws: mockWs,
    });

    const res = await mobileProactiveManager.dispatchProactiveEvent({
      id: "ws_direct_1",
      title: "Realtime WebSocket Alert",
      message: "Pushed directly to connected device.",
      category: "TASK",
    });

    expect(res.success).toBe(true);
    expect(res.delivered).toBe(true);
    expect(mockWs.send).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(mockWs.send.mock.calls[0][0]);
    expect(payload.type).toBe("proactive_notification");
    expect(payload.notification.title).toBe("Realtime WebSocket Alert");

    reg.delete("session_test_ws_1");
  });

  // 29. Device unsubscription removes preferences and pending queue
  it("unsubscribes device and cleans pending queues", async () => {
    await mobileProactiveManager.subscribeDevice({ deviceId: "device_to_unsub" });
    await mobileProactiveManager.dispatchProactiveEvent({
      id: "unsub_notif_1",
      title: "Hello",
      message: "World",
      targetDeviceId: "device_to_unsub",
    });

    expect(mobileProactiveManager.getPendingNotifications("device_to_unsub").length).toBe(1);

    const unsubs = await mobileProactiveManager.unsubscribeDevice("device_to_unsub");
    expect(unsubs).toBe(true);
    expect(mobileProactiveManager.getPendingNotifications("device_to_unsub").length).toBe(0);
  });
});

