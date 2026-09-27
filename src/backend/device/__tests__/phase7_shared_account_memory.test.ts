/**
 * MYRAA — Phase 7: Shared Account + Cross-Device Memory Test Suite
 *
 * Covers all mandatory Phase 7 requirements & test scenarios (1–10):
 *   1. Phone writes shared preference -> Desktop receives it ("Hinglish preference")
 *   2. Desktop writes shared memory & shared task -> Phone receives it
 *   3. Device-local "current_window" stays strictly local on Desktop (never synced)
 *   4. Both devices modify the same shared item -> deterministic conflict resolution
 *   5. Offline mutation -> queued in bounded persistent queue -> reconnect -> synced
 *   6. Duplicate sync request -> idempotent, zero duplicate tasks/memories/preferences
 *   7. Revoked / lost / unauthorized device -> sync blocked immediately
 *   8. Same account -> shared data allowed, RemoteBridge remains DISCONNECTED / INACTIVE
 *   9. Emergency Stop / Security Lockdown -> sync mutations fail closed
 *  10. Shared vs Device-Local boundary classification, DLP secret rejection,
 *      tamper-evident audit chain, standalone Mobile/Desktop independence & 126 Gemini tools
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  sharedAccountMemoryManager,
  SharedAccountMemoryManager,
  deviceRegistry,
  remoteBridge,
  androidCapabilityEngine,
  desktopCapabilityEngine,
} from "../index.ts";
import { intentCapabilityOrchestrator } from "../../orchestrator/IntentCapabilityOrchestrator.ts";
import { identityAuthManager } from "../../security/IdentityAuthManager.ts";
import { securityPolicyEngine } from "../../security/SecurityPolicyEngine.ts";
import { securityAuditLogger } from "../../security/SecurityAuditLogger.ts";
import { emergencyStopCoordinator } from "../../remote/EmergencyStopCoordinator.ts";
import { LIVE_TOOLS } from "../../ai/GeminiSessionFactory.ts";

const ACCOUNT_ID = "account-sandeep-01";
const PHONE_ID = "myraa-phone-01";
const DESKTOP_ID = "myraa-desktop-01";

describe("Phase 7 — Shared Account + Cross-Device Memory", () => {
  beforeEach(async () => {
    await emergencyStopCoordinator.reset("test-admin");
    securityPolicyEngine.resetForTesting();
    identityAuthManager.resetForTesting();
    securityAuditLogger.clearForTesting();
    deviceRegistry.resetForTesting();
    deviceRegistry.registerEngine(androidCapabilityEngine);
    deviceRegistry.registerEngine(desktopCapabilityEngine);
    intentCapabilityOrchestrator.resetForTesting();
    sharedAccountMemoryManager.resetForTesting();

    // Register Unified Account + both first-class products (Phone & Desktop)
    sharedAccountMemoryManager.registerAccount({
      accountId: ACCOUNT_ID,
      displayName: "Sandeep Mishra",
      email: "sandeep@example.com",
      role: "admin",
    });

    sharedAccountMemoryManager.registerAccountDevice({
      accountId: ACCOUNT_ID,
      deviceId: PHONE_ID,
      deviceName: "Sandeep's Android Phone",
      productType: "MYRAA_MOBILE",
      role: "admin",
      online: true,
    });

    sharedAccountMemoryManager.registerAccountDevice({
      accountId: ACCOUNT_ID,
      deviceId: DESKTOP_ID,
      deviceName: "Sandeep's Windows Desktop",
      productType: "MYRAA_DESKTOP",
      role: "admin",
      online: true,
    });
  });

  afterEach(async () => {
    await emergencyStopCoordinator.reset("test-admin");
    securityPolicyEngine.resetForTesting();
    identityAuthManager.resetForTesting();
    remoteBridge.resetForTesting();
    sharedAccountMemoryManager.resetForTesting();
  });

  // ===========================================================================
  // TEST 1: Phone writes shared preference -> Desktop receives it
  // ===========================================================================
  describe("1. Phone writes shared preference → Desktop receives it", () => {
    it("syncs 'Hinglish preference' saved on Phone so Desktop immediately receives it", () => {
      const writeRes = sharedAccountMemoryManager.setSharedPreference({
        accountId: ACCOUNT_ID,
        deviceId: PHONE_ID,
        key: "hinglish_preference",
        value: { language: "Hinglish", script: "Latin", voiceStyle: "conversational" },
      });

      expect(writeRes.ok).toBe(true);
      expect(writeRes.status).toBe("APPLIED");
      expect(writeRes.scope).toBe("SHARED");
      expect(writeRes.domain).toBe("PREFERENCE");
      expect(writeRes.item?.version).toBe(1);
      expect(writeRes.item?.originDeviceId).toBe(PHONE_ID);
      expect(writeRes.item?.originProductType).toBe("MYRAA_MOBILE");
      expect(writeRes.bridgeRemainsDisconnected).toBe(true);

      // Desktop reads the preference directly
      const desktopRead = sharedAccountMemoryManager.getSharedPreference<{
        language: string;
        script: string;
        voiceStyle: string;
      }>({
        accountId: ACCOUNT_ID,
        deviceId: DESKTOP_ID,
        key: "hinglish_preference",
      });

      expect(desktopRead.ok).toBe(true);
      expect(desktopRead.value).toEqual({
        language: "Hinglish",
        script: "Latin",
        voiceStyle: "conversational",
      });
      expect(desktopRead.item?.originDeviceId).toBe(PHONE_ID);

      // Desktop also sees it in full account pull
      const desktopSnapshot = sharedAccountMemoryManager.pullAccountState({
        accountId: ACCOUNT_ID,
        deviceId: DESKTOP_ID,
      });
      expect(desktopSnapshot.ok).toBe(true);
      expect(desktopSnapshot.preferences["hinglish_preference"]?.value).toEqual({
        language: "Hinglish",
        script: "Latin",
        voiceStyle: "conversational",
      });
    });
  });

  // ===========================================================================
  // TEST 2: Desktop writes shared memory (& shared task) -> Phone receives it
  // ===========================================================================
  describe("2. Desktop writes shared memory & shared task → Phone receives it", () => {
    it("syncs shared memory and shared tasks written on Desktop to Phone", () => {
      const memWrite = sharedAccountMemoryManager.writeSharedMemory({
        accountId: ACCOUNT_ID,
        deviceId: DESKTOP_ID,
        key: "architecture_principle",
        content: "MYRAA Mobile and MYRAA Desktop are two independent first-class products.",
        category: "architecture",
      });

      expect(memWrite.ok).toBe(true);
      expect(memWrite.scope).toBe("SHARED");
      expect(memWrite.domain).toBe("MEMORY");
      expect(memWrite.item?.originDeviceId).toBe(DESKTOP_ID);
      expect(memWrite.item?.originProductType).toBe("MYRAA_DESKTOP");

      const taskWrite = sharedAccountMemoryManager.upsertSharedTask({
        accountId: ACCOUNT_ID,
        deviceId: DESKTOP_ID,
        taskKey: "review_phase7_architecture",
        task: {
          title: "Review Phase 7 Shared Account Sync",
          description: "Verify conflict resolution and offline queue on mobile",
        },
        status: "pending",
      });

      expect(taskWrite.ok).toBe(true);
      expect(taskWrite.scope).toBe("SHARED");
      expect(taskWrite.domain).toBe("TASK");

      // Phone pulls shared memories & tasks
      const phoneMemories = sharedAccountMemoryManager.getSharedMemories({
        accountId: ACCOUNT_ID,
        deviceId: PHONE_ID,
      });
      expect(phoneMemories.ok).toBe(true);
      expect(phoneMemories.memories).toHaveLength(1);
      expect(phoneMemories.memories[0].key).toBe("architecture_principle");
      expect(phoneMemories.memories[0].value).toBe(
        "MYRAA Mobile and MYRAA Desktop are two independent first-class products.",
      );

      const phoneTasks = sharedAccountMemoryManager.getSharedTasks({
        accountId: ACCOUNT_ID,
        deviceId: PHONE_ID,
      });
      expect(phoneTasks.ok).toBe(true);
      expect(phoneTasks.tasks).toHaveLength(1);
      expect(phoneTasks.tasks[0].key).toBe("review_phase7_architecture");
      expect(phoneTasks.tasks[0].status).toBe("pending");
    });
  });

  // ===========================================================================
  // TEST 3: Device-local "current window" stays local
  // ===========================================================================
  describe("3. Device-local 'current window' stays strictly local", () => {
    it("keeps Desktop 'current_window' local and never exposes or syncs it to Phone", () => {
      // Desktop writes "current_window" via smart classified writer
      const classifiedRes = sharedAccountMemoryManager.writeClassifiedData({
        accountId: ACCOUNT_ID,
        deviceId: DESKTOP_ID,
        key: "current_window",
        value: { title: "VS Code - SharedAccountMemoryManager.ts", processId: 9420 },
      });

      expect(classifiedRes.ok).toBe(true);
      expect(classifiedRes.scope).toBe("DEVICE_LOCAL");
      expect(classifiedRes.domain).toBe("DEVICE_LOCAL");
      expect(classifiedRes.localItem?.deviceId).toBe(DESKTOP_ID);

      // Desktop can read its own "current_window"
      const desktopLocal = sharedAccountMemoryManager.getDeviceLocalMemory(
        DESKTOP_ID,
        "current_window",
      );
      expect(desktopLocal?.value).toEqual({
        title: "VS Code - SharedAccountMemoryManager.ts",
        processId: 9420,
      });

      // Phone CANNOT see Desktop's "current_window" in local or shared state
      expect(sharedAccountMemoryManager.getDeviceLocalMemory(PHONE_ID, "current_window")).toBeUndefined();
      const phoneSnapshot = sharedAccountMemoryManager.pullAccountState({
        accountId: ACCOUNT_ID,
        deviceId: PHONE_ID,
      });
      expect(phoneSnapshot.ok).toBe(true);
      expect(phoneSnapshot.deviceLocal["current_window"]).toBeUndefined();
      expect(phoneSnapshot.preferences["current_window"]).toBeUndefined();
      expect(phoneSnapshot.memories.find((m) => m.key === "current_window")).toBeUndefined();

      // Attempting to force-write "current_window" as a Shared Memory or Shared Preference is rejected!
      const forcedSharedMem = sharedAccountMemoryManager.writeSharedMemory({
        accountId: ACCOUNT_ID,
        deviceId: DESKTOP_ID,
        key: "current_window",
        content: "VS Code - secret local window",
      });
      expect(forcedSharedMem.ok).toBe(false);
      expect(forcedSharedMem.errorCode).toBe("DEVICE_LOCAL_SCOPE_VIOLATION");

      const forcedSharedPref = sharedAccountMemoryManager.setSharedPreference({
        accountId: ACCOUNT_ID,
        deviceId: DESKTOP_ID,
        key: "current_window",
        value: "Chrome",
      });
      expect(forcedSharedPref.ok).toBe(false);
      expect(forcedSharedPref.errorCode).toBe("DEVICE_LOCAL_SCOPE_VIOLATION");
    });
  });

  // ===========================================================================
  // TEST 4: Both devices modify the same shared item -> deterministic conflict resolution
  // ===========================================================================
  describe("4. Both devices modify the same shared item → deterministic conflict resolution", () => {
    it("never overwrites newer data with older stale data (timestamp LWW rule)", () => {
      // Initial creation at t = 1000 on Phone (v1)
      const init = sharedAccountMemoryManager.setSharedPreference({
        accountId: ACCOUNT_ID,
        deviceId: PHONE_ID,
        key: "language_preference",
        value: "Hindi",
        mutationId: "mut_init_v1",
        timestampMs: 1000,
      });
      expect(init.ok).toBe(true);
      expect(init.item?.version).toBe(1);

      // Desktop updates based on baseVersion 1 at t = 3000 -> becomes v2 ("Hinglish")
      const desktopNewer = sharedAccountMemoryManager.setSharedPreference({
        accountId: ACCOUNT_ID,
        deviceId: DESKTOP_ID,
        key: "language_preference",
        value: "Hinglish",
        baseVersion: 1,
        mutationId: "mut_desktop_t3000",
        timestampMs: 3000,
      });
      expect(desktopNewer.ok).toBe(true);
      expect(desktopNewer.item?.version).toBe(2);
      expect(desktopNewer.item?.value).toBe("Hinglish");

      // Phone submits a delayed concurrent mutation based on baseVersion 1 at t = 2000 ("English")
      const phoneStale = sharedAccountMemoryManager.setSharedPreference({
        accountId: ACCOUNT_ID,
        deviceId: PHONE_ID,
        key: "language_preference",
        value: "English",
        baseVersion: 1,
        mutationId: "mut_phone_t2000",
        timestampMs: 2000,
      });

      expect(phoneStale.ok).toBe(true);
      expect(phoneStale.status).toBe("CONFLICT_RESOLVED");
      expect(phoneStale.conflict?.conflictDetected).toBe(true);
      expect(phoneStale.conflict?.winner).toBe("EXISTING");
      expect(phoneStale.conflict?.tieBreakerUsed).toBe("TIMESTAMP");
      // Canonical value MUST remain Desktop's newer "Hinglish" at v2!
      expect(phoneStale.item?.value).toBe("Hinglish");
      expect(phoneStale.item?.version).toBe(2);
    });

    it("resolves identical-timestamp concurrent writes deterministically regardless of arrival order", () => {
      // Run in two independent manager instances in opposite order to prove order-independence
      const runScenario = (order: "PHONE_FIRST" | "DESKTOP_FIRST") => {
        const mgr = new SharedAccountMemoryManager();
        mgr.registerAccount({ accountId: ACCOUNT_ID });
        mgr.registerAccountDevice({
          accountId: ACCOUNT_ID,
          deviceId: PHONE_ID,
          deviceName: "Phone",
          productType: "MYRAA_MOBILE",
        });
        mgr.registerAccountDevice({
          accountId: ACCOUNT_ID,
          deviceId: DESKTOP_ID,
          deviceName: "Desktop",
          productType: "MYRAA_DESKTOP",
        });

        mgr.writeSharedMemory({
          accountId: ACCOUNT_ID,
          deviceId: PHONE_ID,
          key: "study_goal",
          content: "Initial Goal",
          mutationId: "mut_000",
          timestampMs: 1000,
        });

        const phoneMut = () =>
          mgr.writeSharedMemory({
            accountId: ACCOUNT_ID,
            deviceId: PHONE_ID,
            key: "study_goal",
            content: "Master System Design (Phone)",
            baseVersion: 1,
            clientVersion: 2,
            mutationId: "mut_alpha",
            timestampMs: 5000,
          });

        const desktopMut = () =>
          mgr.writeSharedMemory({
            accountId: ACCOUNT_ID,
            deviceId: DESKTOP_ID,
            key: "study_goal",
            content: "Master Distributed Systems (Desktop)",
            baseVersion: 1,
            clientVersion: 2,
            mutationId: "mut_zeta",
            timestampMs: 5000,
          });

        if (order === "PHONE_FIRST") {
          phoneMut();
          desktopMut();
        } else {
          desktopMut();
          phoneMut();
        }

        const finalMems = mgr.getSharedMemories({ accountId: ACCOUNT_ID, deviceId: PHONE_ID });
        return finalMems.memories[0];
      };

      const resPhoneFirst = runScenario("PHONE_FIRST");
      const resDesktopFirst = runScenario("DESKTOP_FIRST");

      // Both arrival orders must converge to the exact same winning value ("mut_zeta" > "mut_alpha")
      expect(resPhoneFirst.value).toBe("Master Distributed Systems (Desktop)");
      expect(resDesktopFirst.value).toBe("Master Distributed Systems (Desktop)");
      expect(resPhoneFirst.lastMutationId).toBe("mut_zeta");
      expect(resDesktopFirst.lastMutationId).toBe("mut_zeta");
    });
  });

  // ===========================================================================
  // TEST 5: Offline mutation -> queued -> reconnect -> synced
  // ===========================================================================
  describe("5. Offline mutation → queued → reconnect → synced", () => {
    it("queues shared writes while Phone is offline, persists snapshot, and syncs to Desktop on reconnect", () => {
      // Take Phone offline
      sharedAccountMemoryManager.setDeviceOnline(ACCOUNT_ID, PHONE_ID, false);

      // Phone writes a preference, a memory, and a task while offline
      const prefRes = sharedAccountMemoryManager.setSharedPreference({
        accountId: ACCOUNT_ID,
        deviceId: PHONE_ID,
        key: "hinglish_preference",
        value: "Hinglish",
        mutationId: "mut_off_pref_1",
        timestampMs: 2001,
      });
      const memRes = sharedAccountMemoryManager.writeSharedMemory({
        accountId: ACCOUNT_ID,
        deviceId: PHONE_ID,
        key: "offline_note",
        content: "Captured on flight mode",
        mutationId: "mut_off_mem_1",
        timestampMs: 2002,
      });
      const taskRes = sharedAccountMemoryManager.upsertSharedTask({
        accountId: ACCOUNT_ID,
        deviceId: PHONE_ID,
        taskKey: "flight_followup",
        task: { title: "Send summary after landing" },
        mutationId: "mut_off_task_1",
        timestampMs: 2003,
      });

      expect(prefRes.status).toBe("QUEUED_OFFLINE");
      expect(memRes.status).toBe("QUEUED_OFFLINE");
      expect(taskRes.status).toBe("QUEUED_OFFLINE");
      expect(sharedAccountMemoryManager.getOfflineQueue(PHONE_ID)).toHaveLength(3);

      // Verify persistent queue snapshot export/import works
      const snapshotJson = sharedAccountMemoryManager.exportOfflineQueueSnapshot(PHONE_ID);
      expect(JSON.parse(snapshotJson)).toHaveLength(3);

      // While Phone is still offline, Desktop has NOT received these items yet
      const desktopBefore = sharedAccountMemoryManager.pullAccountState({
        accountId: ACCOUNT_ID,
        deviceId: DESKTOP_ID,
      });
      expect(desktopBefore.preferences["hinglish_preference"]).toBeUndefined();
      expect(desktopBefore.memories).toHaveLength(0);
      expect(desktopBefore.tasks).toHaveLength(0);

      // Phone reconnects and flushes its offline queue
      const syncRes = sharedAccountMemoryManager.reconnectAndSync({
        accountId: ACCOUNT_ID,
        deviceId: PHONE_ID,
      });

      expect(syncRes.ok).toBe(true);
      expect(syncRes.appliedCount).toBe(3);
      expect(sharedAccountMemoryManager.getOfflineQueue(PHONE_ID)).toHaveLength(0);

      // Desktop now receives all 3 items!
      const desktopAfter = sharedAccountMemoryManager.pullAccountState({
        accountId: ACCOUNT_ID,
        deviceId: DESKTOP_ID,
      });
      expect(desktopAfter.preferences["hinglish_preference"]?.value).toBe("Hinglish");
      expect(desktopAfter.memories.find((m) => m.key === "offline_note")?.value).toBe(
        "Captured on flight mode",
      );
      expect(desktopAfter.tasks.find((t) => t.key === "flight_followup")?.value).toEqual({
        title: "Send summary after landing",
      });
    });

    it("enforces a bounded offline queue limit and coalesces same-key offline writes", () => {
      sharedAccountMemoryManager.setMaxOfflineQueueSize(2);
      sharedAccountMemoryManager.setDeviceOnline(ACCOUNT_ID, PHONE_ID, false);

      // Two updates to the SAME key coalesce into 1 queue slot
      sharedAccountMemoryManager.setSharedPreference({
        accountId: ACCOUNT_ID,
        deviceId: PHONE_ID,
        key: "theme",
        value: "light",
      });
      sharedAccountMemoryManager.setSharedPreference({
        accountId: ACCOUNT_ID,
        deviceId: PHONE_ID,
        key: "theme",
        value: "dark",
      });
      expect(sharedAccountMemoryManager.getOfflineQueue(PHONE_ID)).toHaveLength(1);

      // Second distinct key fills slot 2/2
      const second = sharedAccountMemoryManager.setSharedPreference({
        accountId: ACCOUNT_ID,
        deviceId: PHONE_ID,
        key: "timezone",
        value: "Asia/Kolkata",
      });
      expect(second.ok).toBe(true);
      expect(sharedAccountMemoryManager.getOfflineQueue(PHONE_ID)).toHaveLength(2);

      // Third distinct key exceeds maxOfflineQueueSize (2) -> rejected with OFFLINE_QUEUE_FULL
      const overflow = sharedAccountMemoryManager.setSharedPreference({
        accountId: ACCOUNT_ID,
        deviceId: PHONE_ID,
        key: "voice",
        value: "Aoede",
      });
      expect(overflow.ok).toBe(false);
      expect(overflow.errorCode).toBe("OFFLINE_QUEUE_FULL");
    });
  });

  // ===========================================================================
  // TEST 6: Duplicate sync request -> no duplicate data
  // ===========================================================================
  describe("6. Duplicate sync request → idempotent, no duplicate data", () => {
    it("deduplicates repeated mutationIds and identical reconnect payloads without creating duplicates", () => {
      const batchMutations = [
        {
          mutationId: "mut_dup_pref_1",
          accountId: ACCOUNT_ID,
          deviceId: PHONE_ID,
          domain: "PREFERENCE" as const,
          key: "hinglish_preference",
          value: "Hinglish",
          timestampMs: 4000,
        },
        {
          mutationId: "mut_dup_mem_1",
          accountId: ACCOUNT_ID,
          deviceId: PHONE_ID,
          domain: "MEMORY" as const,
          key: "favorite_editor",
          value: "VS Code",
          timestampMs: 4001,
        },
        {
          mutationId: "mut_dup_task_1",
          accountId: ACCOUNT_ID,
          deviceId: PHONE_ID,
          domain: "TASK" as const,
          key: "daily_revision",
          value: { title: "Complete DSA practice" },
          status: "pending" as const,
          timestampMs: 4002,
        },
      ];

      // First batch sync
      const firstSync = sharedAccountMemoryManager.syncAccountDevice({
        accountId: ACCOUNT_ID,
        deviceId: PHONE_ID,
        mutations: batchMutations,
      });
      expect(firstSync.ok).toBe(true);
      expect(firstSync.appliedCount).toBe(3);
      expect(firstSync.deduplicatedCount).toBe(0);

      // Second batch sync with the exact same mutations (simulating network retry / reconnect)
      const secondSync = sharedAccountMemoryManager.syncAccountDevice({
        accountId: ACCOUNT_ID,
        deviceId: PHONE_ID,
        mutations: batchMutations,
      });
      expect(secondSync.ok).toBe(true);
      expect(secondSync.appliedCount).toBe(0);
      expect(secondSync.deduplicatedCount).toBe(3);

      // Third write with a NEW mutationId but identical task/memory content (no baseVersion)
      const dupTaskWrite = sharedAccountMemoryManager.upsertSharedTask({
        accountId: ACCOUNT_ID,
        deviceId: DESKTOP_ID,
        taskKey: "daily_revision",
        task: { title: "Complete DSA practice" },
        status: "pending",
        mutationId: "mut_new_id_same_content",
      });
      expect(dupTaskWrite.ok).toBe(true);
      expect(dupTaskWrite.status).toBe("DEDUPLICATED");
      expect(dupTaskWrite.deduplicated).toBe(true);

      // Verify zero duplicate records exist
      const snapshot = sharedAccountMemoryManager.pullAccountState({
        accountId: ACCOUNT_ID,
        deviceId: DESKTOP_ID,
      });
      expect(Object.keys(snapshot.preferences)).toHaveLength(1);
      expect(snapshot.memories).toHaveLength(1);
      expect(snapshot.tasks).toHaveLength(1);
      expect(snapshot.tasks[0].version).toBe(1);
    });
  });

  // ===========================================================================
  // TEST 7: Revoked / Lost / Unauthorized device -> sync blocked
  // ===========================================================================
  describe("7. Revoked or Lost device → sync blocked", () => {
    it("immediately blocks shared writes, pulls, and offline queue flushes from a revoked device", () => {
      // Queue an offline mutation on Phone first, then revoke Phone before it reconnects
      sharedAccountMemoryManager.setDeviceOnline(ACCOUNT_ID, PHONE_ID, false);
      sharedAccountMemoryManager.setSharedPreference({
        accountId: ACCOUNT_ID,
        deviceId: PHONE_ID,
        key: "hinglish_preference",
        value: "Hinglish",
      });
      expect(sharedAccountMemoryManager.getOfflineQueue(PHONE_ID)).toHaveLength(1);

      // Revoke Phone
      const revokeRes = sharedAccountMemoryManager.revokeAccountDevice(
        ACCOUNT_ID,
        PHONE_ID,
        "Suspected token compromise",
      );
      expect(revokeRes.ok).toBe(true);
      expect(sharedAccountMemoryManager.getOfflineQueue(PHONE_ID)).toHaveLength(0);

      // Attempt to reconnect & sync from revoked Phone -> blocked with DEVICE_REVOKED
      const reconnectRes = sharedAccountMemoryManager.reconnectAndSync({
        accountId: ACCOUNT_ID,
        deviceId: PHONE_ID,
      });
      expect(reconnectRes.ok).toBe(false);
      expect(reconnectRes.errorCode).toBe("DEVICE_REVOKED");

      // Attempt to write shared memory from revoked Phone -> blocked with DEVICE_REVOKED
      const writeRes = sharedAccountMemoryManager.writeSharedMemory({
        accountId: ACCOUNT_ID,
        deviceId: PHONE_ID,
        key: "compromised_note",
        content: "Should never be stored",
      });
      expect(writeRes.ok).toBe(false);
      expect(writeRes.errorCode).toBe("DEVICE_REVOKED");

      // Desktop remains authorized and unaffected
      const desktopWrite = sharedAccountMemoryManager.writeSharedMemory({
        accountId: ACCOUNT_ID,
        deviceId: DESKTOP_ID,
        key: "trusted_note",
        content: "Written by authorized desktop",
      });
      expect(desktopWrite.ok).toBe(true);
    });

    it("blocks a device marked lost with DEVICE_LOST and blocks unregistered devices with DEVICE_NOT_REGISTERED", () => {
      sharedAccountMemoryManager.markAccountDeviceLost(ACCOUNT_ID, PHONE_ID, "Phone lost");

      const lostRes = sharedAccountMemoryManager.setSharedPreference({
        accountId: ACCOUNT_ID,
        deviceId: PHONE_ID,
        key: "theme",
        value: "dark",
      });
      expect(lostRes.ok).toBe(false);
      expect(lostRes.errorCode).toBe("DEVICE_LOST");

      const unknownDeviceRes = sharedAccountMemoryManager.setSharedPreference({
        accountId: ACCOUNT_ID,
        deviceId: "rogue-device-99",
        key: "theme",
        value: "dark",
      });
      expect(unknownDeviceRes.ok).toBe(false);
      expect(unknownDeviceRes.errorCode).toBe("DEVICE_NOT_REGISTERED");
    });
  });

  // ===========================================================================
  // TEST 8: Same account -> shared data allowed, remote connection remains DISCONNECTED
  // ===========================================================================
  describe("8. Same account → shared data allowed, remote connection remains DISCONNECTED", () => {
    it("allows full cross-device account sync while keeping RemoteBridge INACTIVE/DISCONNECTED", async () => {
      // Verify RemoteBridge is INACTIVE before sync
      expect(remoteBridge.isActive(PHONE_ID)).toBe(false);
      expect(remoteBridge.isActive(DESKTOP_ID)).toBe(false);
      expect(deviceRegistry.getBridgeStatus(PHONE_ID).state).toBe("INACTIVE");
      expect(deviceRegistry.getBridgeStatus(DESKTOP_ID).state).toBe("INACTIVE");

      // Sync preferences, memories, and tasks across Phone and Desktop
      const prefRes = sharedAccountMemoryManager.setSharedPreference({
        accountId: ACCOUNT_ID,
        deviceId: PHONE_ID,
        key: "hinglish_preference",
        value: "Hinglish",
      });
      const memRes = sharedAccountMemoryManager.writeSharedMemory({
        accountId: ACCOUNT_ID,
        deviceId: DESKTOP_ID,
        key: "shared_project_goal",
        content: "Ship MYRAA Multi-Device Platform",
      });
      const syncRes = sharedAccountMemoryManager.syncAccountDevice({
        accountId: ACCOUNT_ID,
        deviceId: PHONE_ID,
      });

      expect(prefRes.ok).toBe(true);
      expect(memRes.ok).toBe(true);
      expect(syncRes.ok).toBe(true);
      expect(prefRes.bridgeRemainsDisconnected).toBe(true);
      expect(memRes.bridgeRemainsDisconnected).toBe(true);
      expect(syncRes.bridgeRemainsDisconnected).toBe(true);

      // RemoteBridge MUST still be INACTIVE — account sync never auto-connects RemoteBridge!
      expect(remoteBridge.isActive(PHONE_ID)).toBe(false);
      expect(remoteBridge.isActive(DESKTOP_ID)).toBe(false);
      expect(remoteBridge.getStatus(PHONE_ID).state).toBe("INACTIVE");
      expect(deviceRegistry.getDevice(PHONE_ID)?.bridgeConnected).toBe(false);
      expect(deviceRegistry.getDevice(DESKTOP_ID)?.bridgeConnected).toBe(false);

      // Attempting a remote command from Phone to Desktop still fails with BRIDGE_INACTIVE
      const remoteAttempt = await remoteBridge.executeRemoteCommand({
        sourceDeviceId: PHONE_ID,
        targetDeviceId: DESKTOP_ID,
        capability: "desktop.openApplication",
        args: { appName: "vscode" },
      });
      expect(remoteAttempt.ok).toBe(false);
      expect(remoteAttempt.errorCode).toBe("BRIDGE_INACTIVE");
    });
  });

  // ===========================================================================
  // TEST 9: Emergency Stop / Security Lockdown -> sync mutations fail closed
  // ===========================================================================
  describe("9. Emergency Stop & Security Lockdown → sync mutations fail closed", () => {
    it("fails closed with EMERGENCY_STOP_ACTIVE when Emergency Stop is triggered", async () => {
      await emergencyStopCoordinator.trigger({
        source: "remote_device",
        deviceId: PHONE_ID,
        reason: "Phase 7 Emergency Stop test",
      });

      const prefWrite = sharedAccountMemoryManager.setSharedPreference({
        accountId: ACCOUNT_ID,
        deviceId: PHONE_ID,
        key: "hinglish_preference",
        value: "Hinglish",
      });
      expect(prefWrite.ok).toBe(false);
      expect(prefWrite.errorCode).toBe("EMERGENCY_STOP_ACTIVE");

      const syncAttempt = sharedAccountMemoryManager.syncAccountDevice({
        accountId: ACCOUNT_ID,
        deviceId: DESKTOP_ID,
      });
      expect(syncAttempt.ok).toBe(false);
      expect(syncAttempt.errorCode).toBe("EMERGENCY_STOP_ACTIVE");
    });

    it("fails closed with SECURITY_LOCKDOWN_ACTIVE when SecurityPolicyEngine is in LOCKDOWN mode", () => {
      securityPolicyEngine.setMode("LOCKDOWN");

      const memWrite = sharedAccountMemoryManager.writeSharedMemory({
        accountId: ACCOUNT_ID,
        deviceId: DESKTOP_ID,
        key: "lockdown_test",
        content: "Blocked during lockdown",
      });
      expect(memWrite.ok).toBe(false);
      expect(memWrite.errorCode).toBe("SECURITY_LOCKDOWN_ACTIVE");

      const pullAttempt = sharedAccountMemoryManager.pullAccountState({
        accountId: ACCOUNT_ID,
        deviceId: PHONE_ID,
      });
      expect(pullAttempt.ok).toBe(false);
      expect(pullAttempt.errorCode).toBe("SECURITY_LOCKDOWN_ACTIVE");
    });
  });

  // ===========================================================================
  // TEST 10: Verify shared vs device-local boundaries, DLP, Audit & 126 Gemini Tools
  // ===========================================================================
  describe("10. Shared vs Device-Local Boundaries, DLP Screening, Audit & 126 Tools", () => {
    it("accurately classifies SHARED vs DEVICE_LOCAL across all canonical keys", () => {
      // SHARED keys
      expect(
        sharedAccountMemoryManager.classifyDataScope({ key: "hinglish_preference" }),
      ).toMatchObject({ scope: "SHARED", domain: "PREFERENCE" });
      expect(
        sharedAccountMemoryManager.classifyDataScope({ key: "language_preference" }),
      ).toMatchObject({ scope: "SHARED", domain: "PREFERENCE" });
      expect(
        sharedAccountMemoryManager.classifyDataScope({ key: "user_bio", domain: "MEMORY" }),
      ).toMatchObject({ scope: "SHARED", domain: "MEMORY" });
      expect(
        sharedAccountMemoryManager.classifyDataScope({ key: "task_prepare_slides" }),
      ).toMatchObject({ scope: "SHARED", domain: "TASK" });

      // DEVICE_LOCAL keys
      for (const localKey of [
        "current_window",
        "active_window",
        "open_tab",
        "open_file",
        "vscode_workspace",
        "terminal_cwd",
        "clipboard_buffer",
        "foreground_app",
        "battery_level",
        "gps_coordinates",
        "local.temp_state",
      ]) {
        const res = sharedAccountMemoryManager.classifyDataScope({
          key: localKey,
          domain: "MEMORY", // Even if caller passes MEMORY, must force DEVICE_LOCAL!
        });
        expect(res.scope).toBe("DEVICE_LOCAL");
        expect(res.domain).toBe("DEVICE_LOCAL");
      }
    });

    it("rejects sensitive credentials/secrets via DLP screening before storing in shared state", () => {
      const secretAttempt = sharedAccountMemoryManager.writeSharedMemory({
        accountId: ACCOUNT_ID,
        deviceId: DESKTOP_ID,
        key: "gemini_api_key",
        content: "My key is AIzaSyD1234567890abcdefghijklmnopqrstuv",
      });
      expect(secretAttempt.ok).toBe(false);
      expect(secretAttempt.errorCode).toBe("DLP_SECRET_REJECTED");

      const otpAttempt = sharedAccountMemoryManager.setSharedPreference({
        accountId: ACCOUNT_ID,
        deviceId: PHONE_ID,
        key: "saved_auth_note",
        value: "my otp code is 482910",
      });
      expect(otpAttempt.ok).toBe(false);
      expect(otpAttempt.errorCode).toBe("DLP_SECRET_REJECTED");
    });

    it("maintains tamper-evident audit chain, standalone engine operation, and 126 Gemini tools", async () => {
      sharedAccountMemoryManager.setSharedPreference({
        accountId: ACCOUNT_ID,
        deviceId: PHONE_ID,
        key: "hinglish_preference",
        value: "Hinglish",
      });

      const chainCheck = securityAuditLogger.verifyChainIntegrity();
      expect(chainCheck.valid).toBe(true);

      // Standalone Mobile & Desktop capability engines work independently
      const mobileExec = await androidCapabilityEngine.execute(
        "mobile.alarm",
        { time: "06:30", label: "Morning Workout" },
        { deviceId: PHONE_ID, productType: "MYRAA_MOBILE", bridgeActive: false },
      );
      expect(mobileExec.success).toBe(true);

      const desktopExec = await desktopCapabilityEngine.execute(
        "desktop.openApplication",
        { appName: "vscode" },
        { deviceId: DESKTOP_ID, productType: "MYRAA_DESKTOP", bridgeActive: false },
      );
      expect(desktopExec.success).toBe(true);

      // Verify 126 Gemini Live tools invariant
      expect(LIVE_TOOLS[0].functionDeclarations.length).toBe(126);
    });
  });
});
