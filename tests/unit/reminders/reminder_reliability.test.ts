/**
 * MYRAA — Phase 11.2: Reminder Runtime Reliability & Crash Recovery Test Suite
 *
 * Validates:
 *   1. Persistent Delivery Claims & Atomicity
 *   2. Occurrence Lifecycle & State Transitions
 *   3. Scenario A: Normal Application & Scheduler Restart
 *   4. Scenario B: Pending / Overdue Occurrence Recovery
 *   5. Scenario C: Interrupted Claim & Crash Recovery (with duplicate-prevention reconciliation)
 *   6. Scenario D: Repeated Scheduler Scans (Tick deduplication)
 *   7. Scenario E: Temporary Notification Failure & Retry Recovery
 *   8. Concurrency & Security Invariants (129 LIVE_TOOLS preserved)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";

// ── Module imports ──────────────────────────────────────────────────────────
import {
  ReminderService,
  ReminderStore,
  ReminderGovernance,
  ReminderScheduler,
  ReminderDeliveryManager,
  validateOccurrenceTransition,
  validateReminderTransition,
  DEFAULT_CLAIM_LEASE_MS,
  MAX_DELIVERY_ATTEMPTS,
  DEFAULT_RETRY_BACKOFF_MS,
  type Reminder,
  type ReminderOccurrence,
  type DeliveryResult,
} from "../../../backend/reminders/index.ts";
import { notificationManager } from "../../../backend/companion/NotificationManager.ts";
import { companionStore } from "../../../backend/companion/CompanionStore.ts";
import { emergencyStopCoordinator } from "../../../backend/remote/EmergencyStopCoordinator.ts";
import { securityPolicyEngine } from "../../../backend/security/SecurityPolicyEngine.ts";
import { LIVE_TOOLS } from "../../../backend/ai/GeminiSessionFactory.ts";

describe("Phase 11.2 — Reminder Runtime Reliability & Crash Recovery", () => {
  let tmpDir: string;
  let originalEnv: string | undefined;
  let store: ReminderStore;
  let governance: ReminderGovernance;
  let delivery: ReminderDeliveryManager;
  let scheduler: ReminderScheduler;
  let service: ReminderService;

  const testUser = "user_reliability_001";

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "myraa-reliability-test-"));
    originalEnv = process.env.SORA_DATA_DIR;
    process.env.SORA_DATA_DIR = tmpDir;

    store = new ReminderStore();
    governance = new ReminderGovernance();
    delivery = new ReminderDeliveryManager();
    scheduler = new ReminderScheduler(store, governance, delivery, "worker_primary");
    service = new ReminderService(store, governance, scheduler);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    scheduler.stop();
    delivery.clearClaimsForTesting();
    if (originalEnv === undefined) {
      delete process.env.SORA_DATA_DIR;
    } else {
      process.env.SORA_DATA_DIR = originalEnv;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // 1. Persistent Delivery Claims & Atomicity
  // -------------------------------------------------------------------------
  describe("1. Persistent Delivery Claims & Atomicity", () => {
    it("atomically creates a persistent claim with worker ID and expiration lease on disk", async () => {
      const dueTime = new Date(Date.now() + 60_000).toISOString();
      const reminder = await service.proposeReminder(testUser, {
        text: "Atomic claim test",
        dueTime,
      });
      await service.approveAndSchedule(testUser, reminder.id);

      const loaded = (await store.getReminder(reminder.id))!;
      const occ = loaded.occurrences[0];
      expect(occ).toBeDefined();

      const claimResult = await store.claimOccurrenceAtomic(
        reminder.id,
        occ.occurrenceId,
        "worker_alpha",
        15_000,
      );

      expect(claimResult.claimed).toBe(true);
      expect(claimResult.occurrence?.claimedBy).toBe("worker_alpha");
      expect(claimResult.occurrence?.status).toBe("claimed");
      expect(claimResult.occurrence?.deliveryAttempts).toBe(1);
      expect(claimResult.occurrence?.claimLeaseExpiresAt).toBeDefined();

      // Verify state was durably written to disk
      const fromDisk = (await store.getReminder(reminder.id))!;
      const occOnDisk = fromDisk.occurrences[0];
      expect(occOnDisk.status).toBe("claimed");
      expect(occOnDisk.claimedBy).toBe("worker_alpha");
      expect(occOnDisk.deliveryAttempts).toBe(1);
    });

    it("rejects concurrent worker claims while active lease is unexpired", async () => {
      const dueTime = new Date(Date.now() + 60_000).toISOString();
      const reminder = await service.proposeReminder(testUser, {
        text: "Concurrent claim conflict test",
        dueTime,
      });
      await service.approveAndSchedule(testUser, reminder.id);

      const loaded = (await store.getReminder(reminder.id))!;
      const occId = loaded.occurrences[0].occurrenceId;

      // Worker 1 claims with 30s lease
      const claim1 = await store.claimOccurrenceAtomic(reminder.id, occId, "worker_1", 30_000);
      expect(claim1.claimed).toBe(true);

      // Worker 2 attempts concurrent claim
      const claim2 = await store.claimOccurrenceAtomic(reminder.id, occId, "worker_2", 30_000);
      expect(claim2.claimed).toBe(false);
      expect(claim2.reason).toContain("OCCURRENCE_ALREADY_CLAIMED");
      expect(claim2.reason).toContain("worker_1");
    });

    it("allows another worker to recover claim once lease has expired", async () => {
      const dueTime = new Date(Date.now() + 60_000).toISOString();
      const reminder = await service.proposeReminder(testUser, {
        text: "Expired lease recovery test",
        dueTime,
      });
      await service.approveAndSchedule(testUser, reminder.id);

      const loaded = (await store.getReminder(reminder.id))!;
      const occId = loaded.occurrences[0].occurrenceId;

      // Worker 1 claims with expired lease (in the past)
      const pastExpires = new Date(Date.now() - 1000).toISOString();
      loaded.occurrences[0].status = "claimed";
      loaded.occurrences[0].claimedBy = "worker_crashed";
      loaded.occurrences[0].claimLeaseExpiresAt = pastExpires;
      loaded.occurrences[0].deliveryAttempts = 1;
      await store.saveReminder(loaded);

      // Worker 2 attempts claim on expired lease -> succeeds!
      const claim2 = await store.claimOccurrenceAtomic(reminder.id, occId, "worker_2", 30_000);
      expect(claim2.claimed).toBe(true);
      expect(claim2.occurrence?.claimedBy).toBe("worker_2");
      expect(claim2.occurrence?.deliveryAttempts).toBe(2);
    });

    it("rejects claims on terminal reminders and terminal occurrences", async () => {
      const dueTime = new Date(Date.now() + 60_000).toISOString();
      const reminder = await service.proposeReminder(testUser, {
        text: "Terminal claim test",
        dueTime,
      });
      await service.approveAndSchedule(testUser, reminder.id);

      // Cancel reminder
      await service.cancelReminder(testUser, reminder.id);

      const loaded = (await store.getReminder(reminder.id))!;
      const occId = loaded.occurrences[0].occurrenceId;

      const claimResult = await store.claimOccurrenceAtomic(reminder.id, occId, "worker_test");
      expect(claimResult.claimed).toBe(false);
      expect(claimResult.reason).toContain("REMINDER_TERMINAL");
    });

    it("verifies persistence boundary: independent ReminderStore instances without shared queue race on concurrent claims", async () => {
      const dueTime = new Date(Date.now() + 60_000).toISOString();
      const reminder = await service.proposeReminder(testUser, {
        text: "Independent store instances boundary test",
        dueTime,
      });
      await service.approveAndSchedule(testUser, reminder.id);

      const loaded = (await store.getReminder(reminder.id))!;
      const occId = loaded.occurrences[0].occurrenceId;

      // Two uncoordinated ReminderStore instances
      const unsharedStoreA = new ReminderStore();
      const unsharedStoreB = new ReminderStore();

      // When executed concurrently without a shared in-process queue
      const [resA, resB] = await Promise.all([
        unsharedStoreA.claimOccurrenceAtomic(reminder.id, occId, "worker_unshared_A"),
        unsharedStoreB.claimOccurrenceAtomic(reminder.id, occId, "worker_unshared_B"),
      ]);

      // Both instances read disk before either committed claim, demonstrating the boundary:
      // In-process serialization requires sharing the same ReminderStore singleton or shared mutex.
      expect(resA.claimed).toBe(true);
      expect(resB.claimed).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Occurrence Delivery Lifecycle & State Transitions
  // -------------------------------------------------------------------------
  describe("2. Occurrence Delivery Lifecycle & State Transitions", () => {
    it("validates allowable occurrence lifecycle transitions", () => {
      expect(validateOccurrenceTransition("scheduled", "due").allowed).toBe(true);
      expect(validateOccurrenceTransition("due", "claimed").allowed).toBe(true);
      expect(validateOccurrenceTransition("claimed", "delivered").allowed).toBe(true);
      expect(validateOccurrenceTransition("claimed", "retryable_failure").allowed).toBe(true);
      expect(validateOccurrenceTransition("retryable_failure", "due").allowed).toBe(true);
      expect(validateOccurrenceTransition("retryable_failure", "claimed").allowed).toBe(true);
      expect(validateOccurrenceTransition("claimed", "failed").allowed).toBe(true);

      // Delivered and skipped are strictly terminal
      expect(validateOccurrenceTransition("delivered", "due").allowed).toBe(false);
      expect(validateOccurrenceTransition("delivered", "claimed").allowed).toBe(false);
      expect(validateOccurrenceTransition("skipped", "due").allowed).toBe(false);
    });

    it("commits delivered outcome atomically and clears lease", async () => {
      const dueTime = new Date(Date.now() + 60_000).toISOString();
      const reminder = await service.proposeReminder(testUser, {
        text: "Delivery commit test",
        dueTime,
      });
      await service.approveAndSchedule(testUser, reminder.id);

      const loaded = (await store.getReminder(reminder.id))!;
      const occId = loaded.occurrences[0].occurrenceId;

      await store.claimOccurrenceAtomic(reminder.id, occId, "worker_1");

      const deliveryResult: DeliveryResult = {
        success: true,
        deliveryKey: loaded.occurrences[0].deliveryKey,
        status: "delivered",
        timestamp: new Date().toISOString(),
        notificationId: "notif_123",
      };

      const committed = await store.commitDeliveryOutcomeAtomic(reminder.id, occId, deliveryResult);
      expect(committed.status).toBe("delivered");
      const occ = committed.occurrences[0];
      expect(occ.status).toBe("delivered");
      expect(occ.deliveredAt).toBe(deliveryResult.timestamp);
      expect(occ.claimLeaseExpiresAt).toBeUndefined();
    });

    it("records retryable_failure with exponential backoff nextRetryAt", async () => {
      const dueTime = new Date(Date.now() + 60_000).toISOString();
      const reminder = await service.proposeReminder(testUser, {
        text: "Retryable failure test",
        dueTime,
      });
      await service.approveAndSchedule(testUser, reminder.id);

      const loaded = (await store.getReminder(reminder.id))!;
      const occId = loaded.occurrences[0].occurrenceId;

      await store.claimOccurrenceAtomic(reminder.id, occId, "worker_1");

      const failureResult: DeliveryResult = {
        success: false,
        deliveryKey: loaded.occurrences[0].deliveryKey,
        status: "retryable_failure",
        retryable: true,
        retryAfterMs: 4_000,
        timestamp: new Date().toISOString(),
        error: "NETWORK_TIMEOUT: Remote provider unreachable",
      };

      const committed = await store.commitDeliveryOutcomeAtomic(reminder.id, occId, failureResult);
      expect(committed.status).toBe("scheduled"); // Re-queued for retry
      const occ = committed.occurrences[0];
      expect(occ.status).toBe("retryable_failure");
      expect(occ.error).toBe("NETWORK_TIMEOUT: Remote provider unreachable");
      expect(occ.nextRetryAt).toBeDefined();
      expect(new Date(occ.nextRetryAt!).getTime()).toBeGreaterThan(Date.now());
    });

    it("escalates to terminal failed when maximum delivery attempts are exceeded", async () => {
      const dueTime = new Date(Date.now() + 60_000).toISOString();
      const reminder = await service.proposeReminder(testUser, {
        text: "Max attempts exhaustion test",
        dueTime,
      });
      await service.approveAndSchedule(testUser, reminder.id);

      const loaded = (await store.getReminder(reminder.id))!;
      const occId = loaded.occurrences[0].occurrenceId;

      // Set attempts already at max (3)
      loaded.occurrences[0].deliveryAttempts = MAX_DELIVERY_ATTEMPTS;
      await store.saveReminder(loaded);

      const failureResult: DeliveryResult = {
        success: false,
        deliveryKey: loaded.occurrences[0].deliveryKey,
        status: "retryable_failure",
        retryable: true,
        timestamp: new Date().toISOString(),
        error: "PROVIDER_DOWN: Consecutive timeout",
      };

      const committed = await store.commitDeliveryOutcomeAtomic(reminder.id, occId, failureResult);
      expect(committed.status).toBe("failed");
      const occ = committed.occurrences[0];
      expect(occ.status).toBe("failed");
      expect(occ.error).toContain(`maximum of ${MAX_DELIVERY_ATTEMPTS} attempts`);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Scenario A: Normal Application & Scheduler Restart
  // -------------------------------------------------------------------------
  describe("3. Scenario A: Normal Application & Scheduler Restart", () => {
    it("reconstructs and schedules active reminders after application restart", async () => {
      const futureDue = new Date(Date.now() + 3_600_000).toISOString(); // +1 hour
      const reminder = await service.proposeReminder(testUser, {
        text: "Future reminder across restart",
        dueTime: futureDue,
      });
      await service.approveAndSchedule(testUser, reminder.id);

      // Stop original scheduler (simulating shutdown)
      scheduler.stop();

      // Create new scheduler instance with fresh memory (simulating restart)
      const restartedScheduler = new ReminderScheduler(store, governance, delivery, "worker_restarted");

      const recoveredCount = await restartedScheduler.recoverAndScheduleAll();
      expect(recoveredCount).toBe(1);

      const loaded = (await store.getReminder(reminder.id))!;
      expect(loaded.status).toBe("scheduled");
      expect(loaded.occurrences[0].status).toBe("scheduled");

      restartedScheduler.stop();
    });
  });

  // -------------------------------------------------------------------------
  // 4. Scenario B: Pending / Overdue Occurrence Recovery
  // -------------------------------------------------------------------------
  describe("4. Scenario B: Pending / Overdue Occurrence Recovery", () => {
    it("detects and delivers overdue reminder occurrences on startup", async () => {
      const pastDue = new Date(Date.now() - 30_000).toISOString(); // 30s ago
      const reminder = await service.proposeReminder(testUser, {
        text: "Offline missed reminder",
        dueTime: pastDue,
      });

      // Manually approve in store without scheduler immediately processing
      governance.approveProposal(reminder, testUser);
      reminder.status = "scheduled";
      await store.saveReminder(reminder);

      const notifySpy = vi.spyOn(notificationManager, "notify");

      // New scheduler starts and recovers
      const newScheduler = new ReminderScheduler(store, governance, delivery, "worker_catchup");
      await newScheduler.recoverAndScheduleAll();

      expect(notifySpy).toHaveBeenCalledTimes(1);
      const updated = (await store.getReminder(reminder.id))!;
      expect(updated.status).toBe("delivered");
      expect(updated.occurrences[0].status).toBe("delivered");

      newScheduler.stop();
    });
  });

  // -------------------------------------------------------------------------
  // 5. Scenario C: Interrupted Claim & Crash Recovery
  // -------------------------------------------------------------------------
  describe("5. Scenario C: Interrupted Claim & Crash Recovery", () => {
    it("resets expired claim to 'due' when worker crashed before notification dispatch", async () => {
      const futureDue = new Date(Date.now() + 3_600_000).toISOString();
      const reminder = await service.proposeReminder(testUser, {
        text: "Crashed before dispatch test",
        dueTime: futureDue,
      });
      await service.approveAndSchedule(testUser, reminder.id);

      const loaded = (await store.getReminder(reminder.id))!;
      const occ = loaded.occurrences[0];

      // Simulate worker crash: claim recorded on disk, but lease expired and notification never sent
      occ.status = "claimed";
      occ.claimedBy = "worker_crashed_before_dispatch";
      occ.claimLeaseExpiresAt = new Date(Date.now() - 5000).toISOString(); // expired
      occ.deliveryAttempts = 1;
      await store.saveReminder(loaded);

      // Verify no notification exists in companion store
      const notifs = await companionStore.listNotifications();
      expect(notifs.find((n) => n.dedupKey === occ.deliveryKey)).toBeUndefined();

      // Recovery runs
      const recovery = await store.recoverInterruptedClaims("worker_recovery");
      expect(recovery.resetToDue).toBe(1);
      expect(recovery.reconciledDelivered).toBe(0);

      const recoveredReminder = (await store.getReminder(reminder.id))!;
      expect(recoveredReminder.status).toBe("due");
      expect(recoveredReminder.occurrences[0].status).toBe("due");
      expect(recoveredReminder.occurrences[0].claimLeaseExpiresAt).toBeUndefined();
    });

    it("reconciles expired claim to 'delivered' when notification was sent before crash", async () => {
      const dueTime = new Date(Date.now() - 10_000).toISOString();
      const reminder = await service.proposeReminder(testUser, {
        text: "Crashed after dispatch before commit test",
        dueTime,
      });
      await service.approveAndSchedule(testUser, reminder.id);

      const loaded = (await store.getReminder(reminder.id))!;
      const occ = loaded.occurrences[0];

      // Simulate notification was sent and saved in companionStore
      await companionStore.saveNotification({
        id: "notif_sent_before_crash",
        title: "Reminder: Crashed after dispatch before commit test",
        message: "Crashed after dispatch before commit test",
        level: "info",
        source: "companion",
        timestamp: new Date().toISOString(),
        read: false,
        dismissed: false,
        dedupKey: occ.deliveryKey,
        voiceText: "Reminder: Crashed after dispatch before commit test",
      });

      // Simulate crash: claim lease expired before ReminderStore committed 'delivered'
      occ.status = "claimed";
      occ.claimedBy = "worker_crashed_after_dispatch";
      occ.claimLeaseExpiresAt = new Date(Date.now() - 5000).toISOString(); // expired
      occ.deliveryAttempts = 1;
      await store.saveReminder(loaded);

      const notifySpy = vi.spyOn(notificationManager, "notify");

      // Recovery runs
      const recovery = await store.recoverInterruptedClaims("worker_recovery");
      expect(recovery.reconciledDelivered).toBe(1);
      expect(recovery.resetToDue).toBe(0);

      const reconciledReminder = (await store.getReminder(reminder.id))!;
      expect(reconciledReminder.status).toBe("delivered");
      expect(reconciledReminder.occurrences[0].status).toBe("delivered");

      // Verify NO duplicate notification was sent during recovery!
      expect(notifySpy).not.toHaveBeenCalled();
    });

    it("preserves an active worker's valid unexpired lease without stealing or resetting during recovery", async () => {
      const futureDue = new Date(Date.now() + 3_600_000).toISOString();
      const reminder = await service.proposeReminder(testUser, {
        text: "Unexpired lease active worker test",
        dueTime: futureDue,
      });
      await service.approveAndSchedule(testUser, reminder.id);

      const loaded = (await store.getReminder(reminder.id))!;
      const occ = loaded.occurrences[0];

      // Simulate active claim with lease expiring 25 seconds in the future
      const futureLease = new Date(Date.now() + 25_000).toISOString();
      occ.status = "claimed";
      occ.claimedBy = "worker_active_in_flight";
      occ.claimLeaseExpiresAt = futureLease;
      occ.deliveryAttempts = 1;
      await store.saveReminder(loaded);

      // Another scheduler starts and runs recovery
      const recovery = await store.recoverInterruptedClaims("worker_restarted_fresh");
      expect(recovery.reconciledDelivered).toBe(0);
      expect(recovery.resetToDue).toBe(0);
      expect(recovery.markedFailed).toBe(0);

      // Verify the active worker's lease was NOT stolen or overwritten
      const stillActive = (await store.getReminder(reminder.id))!;
      expect(stillActive.occurrences[0].status).toBe("claimed");
      expect(stillActive.occurrences[0].claimedBy).toBe("worker_active_in_flight");
      expect(stillActive.occurrences[0].claimLeaseExpiresAt).toBe(futureLease);

      // And attempting to claim it while lease is unexpired is rejected
      const stealAttempt = await store.claimOccurrenceAtomic(
        reminder.id,
        occ.occurrenceId,
        "worker_restarted_fresh",
      );
      expect(stealAttempt.claimed).toBe(false);
      expect(stealAttempt.reason).toContain("OCCURRENCE_ALREADY_CLAIMED");
      expect(stealAttempt.reason).toContain("worker_active_in_flight");
    });
  });

  // -------------------------------------------------------------------------
  // 6. Scenario D: Repeated Scheduler Scans (Tick Deduplication)
  // -------------------------------------------------------------------------
  describe("6. Scenario D: Repeated Scheduler Scans (Tick Deduplication)", () => {
    it("ensures repeated scheduler ticks do not cause duplicate notifications", async () => {
      const pastDue = new Date(Date.now() - 10_000).toISOString();
      const reminder = await service.proposeReminder(testUser, {
        text: "Tick deduplication test",
        dueTime: pastDue,
      });

      const notifySpy = vi.spyOn(notificationManager, "notify");

      // Approve and schedule -> triggers first due delivery
      await service.approveAndSchedule(testUser, reminder.id);
      expect(notifySpy).toHaveBeenCalledTimes(1);

      // Execute 5 consecutive ticks in rapid succession
      for (let i = 0; i < 5; i++) {
        await scheduler.tick();
      }

      // Still exactly 1 notification must have been dispatched (ticks did not re-dispatch)
      expect(notifySpy).toHaveBeenCalledTimes(1);

      const loaded = (await store.getReminder(reminder.id))!;
      expect(loaded.status).toBe("delivered");
      expect(loaded.occurrences[0].status).toBe("delivered");
    });
  });

  // -------------------------------------------------------------------------
  // 7. Scenario E: Temporary Notification Failure & Retry Recovery
  // -------------------------------------------------------------------------
  describe("7. Scenario E: Temporary Notification Failure & Retry Recovery", () => {
    it("handles temporary delivery failure, schedules backoff, and recovers on subsequent tick", async () => {
      let attempts = 0;
      vi.spyOn(notificationManager, "notify").mockImplementation(async () => {
        attempts++;
        if (attempts === 1) {
          const err = new Error("NETWORK_TIMEOUT: Temporary socket failure");
          (err as any).isRetryable = true;
          throw err;
        }
        return {
          id: "notif_retry_success",
          title: "Reminder",
          message: "Temporary failure recovery test",
          level: "info",
          source: "companion",
          timestamp: new Date().toISOString(),
          read: false,
          dismissed: false,
          dedupKey: "dedup_retry_success",
          voiceText: "Reminder: Temporary failure recovery test",
        };
      });

      const pastDue = new Date(Date.now() - 10_000).toISOString();
      const reminder = await service.proposeReminder(testUser, {
        text: "Temporary failure recovery test",
        dueTime: pastDue,
      });
      // approveAndSchedule will attempt first delivery and encounter temporary error
      await service.approveAndSchedule(testUser, reminder.id);

      const afterFirstAttempt = (await store.getReminder(reminder.id))!;
      expect(afterFirstAttempt.occurrences[0].status).toBe("retryable_failure");
      expect(afterFirstAttempt.occurrences[0].deliveryAttempts).toBe(1);
      expect(afterFirstAttempt.occurrences[0].nextRetryAt).toBeDefined();

      // 2. Tick while still within backoff window -> does not retry prematurely
      await scheduler.tick();
      expect(attempts).toBe(1);

      // 3. Fast-forward backoff time
      afterFirstAttempt.occurrences[0].nextRetryAt = new Date(Date.now() - 1000).toISOString();
      await store.saveReminder(afterFirstAttempt);

      // 4. Next tick -> retries and succeeds!
      await scheduler.tick();
      expect(attempts).toBe(2);

      const afterSuccess = (await store.getReminder(reminder.id))!;
      expect(afterSuccess.status).toBe("delivered");
      expect(afterSuccess.occurrences[0].status).toBe("delivered");
      expect(afterSuccess.occurrences[0].deliveryAttempts).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // 8. Concurrency & Integrity Invariants
  // -------------------------------------------------------------------------
  describe("8. Concurrency & Integrity Invariants", () => {
    it("ensures two concurrent scheduler workers process due reminder with zero duplicate dispatches", async () => {
      const pastDue = new Date(Date.now() - 10_000).toISOString();
      const reminder = await service.proposeReminder(testUser, {
        text: "Concurrent scheduler workers test",
        dueTime: pastDue,
      });

      // Manually set reminder to due on disk without scheduling in memory
      governance.approveProposal(reminder, testUser);
      reminder.status = "due";
      const occIndex = 1;
      const occId = `${reminder.id}:${occIndex}:${Date.now()}`;
      reminder.occurrences = [
        {
          occurrenceId: occId,
          reminderId: reminder.id,
          occurrenceIndex: occIndex,
          scheduledTime: pastDue,
          status: "due",
          deliveryKey: `delivery_${reminder.id}_${occId}`,
        },
      ];
      reminder.currentOccurrenceId = occId;
      await store.saveReminder(reminder);

      const worker1 = new ReminderScheduler(store, governance, delivery, "worker_1");
      const worker2 = new ReminderScheduler(store, governance, delivery, "worker_2");

      const notifySpy = vi.spyOn(notificationManager, "notify");

      // Simulate simultaneous execution of processDueReminder by both workers
      const [res1, res2] = await Promise.all([
        worker1.processDueReminder(reminder.id),
        worker2.processDueReminder(reminder.id),
      ]);

      // Exactly one worker must have successfully claimed and delivered
      const deliveredCount = [res1, res2].filter((r) => r?.status === "delivered").length;
      const rejectedCount = [res1, res2].filter((r) => r === null).length;

      expect(deliveredCount).toBe(1);
      expect(rejectedCount).toBe(1);
      expect(notifySpy).toHaveBeenCalledTimes(1);

      const finalState = (await store.getReminder(reminder.id))!;
      expect(finalState.status).toBe("delivered");
      expect(finalState.occurrences[0].status).toBe("delivered");
    });

    it("strictly preserves LIVE_TOOLS invariant at 129 tools", () => {
      expect(LIVE_TOOLS).toBeDefined();
      expect(Array.isArray(LIVE_TOOLS)).toBe(true);
      const decls = LIVE_TOOLS[0].functionDeclarations;
      expect(decls).toHaveLength(129);
      const names = new Set(decls.map((d: any) => d.name));
      expect(names.size).toBe(129);
    });
  });
});
