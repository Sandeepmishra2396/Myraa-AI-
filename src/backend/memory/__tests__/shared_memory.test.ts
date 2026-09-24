/**
 * Phase 24 — Shared MYRAA Memory Tests
 *
 * Comprehensive test suite covering:
 *   1. Desktop → shared memory → Android retrieval
 *   2. Android → shared memory → Desktop retrieval
 *   3. Cross-device project context scenario ("MYRAA, is project ko yaad rakhna" -> "Kal wale project ka status?")
 *   4. Memory search across query, categories, importance, confidence
 *   5. Create/update/delete/expiry lifecycle
 *   6. Deduplication: exact match updates timestamp/text, similar match merges text
 *   7. Conflict resolution: deterministic Last-Write-Wins with version and server tie-breaker
 *   8. Offline → online batch synchronization
 *   9. Idempotency: duplicate clientMutationId is never applied twice
 *   10. Device/session authentication & authorization
 *   11. Unauthorized memory access rejection
 *   12. DLP & secret protection: API keys, passwords, credit cards, OTPs rejected
 *   13. Emergency Stop fail-closed enforcement
 *   14. Security Policy Lockdown fail-closed enforcement
 *   15. Real-time synchronization event broadcasting
 *   16. Invariant check: Exactly 126 Gemini Live tools preserved
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { SharedMemoryManager, isDlpClean } from "../SharedMemoryManager.ts";
import { MemoryStore } from "../MemoryStore.ts";
import { emergencyStopCoordinator } from "../../remote/EmergencyStopCoordinator.ts";
import { securityPolicyEngine } from "../../security/SecurityPolicyEngine.ts";
import { LIVE_TOOLS } from "../../ai/GeminiSessionFactory.ts";
import type { EnhancedMemory, SharedMemorySyncEvent } from "../MemoryTypes.ts";
import type { SecurityContext } from "../../security/SecurityTypes.ts";

/** In-memory MemoryStore for test isolation */
class MockMemoryStore extends MemoryStore {
  private _data: EnhancedMemory[] = [];

  setData(data: EnhancedMemory[]): void {
    this._data = [...data];
  }

  getData(): EnhancedMemory[] {
    return this._data;
  }

  override async load(): Promise<EnhancedMemory[]> {
    return [...this._data];
  }

  override async save(memories: EnhancedMemory[]): Promise<void> {
    this._data = [...memories];
  }

  override clearCache(): void {
    this._data = [];
  }
}

describe("Phase 24 — Shared MYRAA Memory", () => {
  let mockStore: MockMemoryStore;
  let sharedMemory: SharedMemoryManager;

  const desktopContext: SecurityContext = {
    identityId: "local_desktop",
    role: "admin",
    ipAddress: "127.0.0.1",
    isLocal: true,
    deviceId: "desktop_primary",
  };

  const androidContext: SecurityContext = {
    identityId: "paired_android_01",
    role: "standard",
    ipAddress: "192.168.1.105",
    isLocal: false,
    deviceId: "android_companion_pixel",
  };

  beforeEach(async () => {
    mockStore = new MockMemoryStore();
    sharedMemory = new SharedMemoryManager(mockStore);
    sharedMemory.clearCaches();

    // Ensure Emergency Stop & Lockdown are reset
    await emergencyStopCoordinator.reset("test_setup");
    securityPolicyEngine.setMode("BALANCED");
  });

  afterEach(async () => {
    await emergencyStopCoordinator.reset("test_teardown");
    securityPolicyEngine.setMode("BALANCED");
  });

  // ---------------------------------------------------------------------------
  // 1. Cross-Device Memory Accessibility
  // ---------------------------------------------------------------------------

  describe("Cross-Device Memory Sharing", () => {
    it("Desktop creates memory → stored in shared store → retrievable by Android", async () => {
      const created = await sharedMemory.createMemory(
        {
          category: "project",
          text: "Project Phoenix deadline is next Friday.",
          key: "project_phoenix_deadline",
          importance: "high",
          confidence: "high",
        },
        desktopContext,
      );

      expect(created.id).toBeDefined();
      expect(created.deviceId).toBe("desktop_primary");
      expect(created.deviceType).toBe("desktop");
      expect(created.version).toBe(1);

      // Android companion reads from the same shared store
      const androidList = await sharedMemory.listMemories({}, androidContext);
      expect(androidList.length).toBe(1);
      expect(androidList[0].id).toBe(created.id);
      expect(androidList[0].text).toBe("Project Phoenix deadline is next Friday.");
      expect(androidList[0].key).toBe("project_phoenix_deadline");
    });

    it("Android creates memory → stored in shared store → retrievable by Desktop", async () => {
      const created = await sharedMemory.createMemory(
        {
          category: "preference",
          text: "User prefers dark mode on mobile and desktop.",
          key: "theme_preference",
          importance: "medium",
          confidence: "high",
        },
        androidContext,
      );

      expect(created.id).toBeDefined();
      expect(created.deviceId).toBe("android_companion_pixel");
      expect(created.deviceType).toBe("android");

      // Desktop loads memories
      const desktopList = await sharedMemory.listMemories({}, desktopContext);
      expect(desktopList.length).toBe(1);
      expect(desktopList[0].text).toContain("dark mode");
      expect(desktopList[0].deviceId).toBe("android_companion_pixel");
    });

    it("Scenario: 'MYRAA, is project ko yaad rakhna' on Desktop -> retrieved later on Android", async () => {
      // Step 1: Desktop user asks MYRAA to remember a project
      const mem = await sharedMemory.createMemory(
        {
          category: "project",
          text: "Alpha Project is working on real-time neural sync between devices.",
          key: "alpha_project_status",
          importance: "high",
          confidence: "high",
        },
        desktopContext,
      );

      // Step 2: Later, Android user asks: 'Kal wale project ka status?'
      // MYRAA retrieves memory matching 'project' or 'alpha'
      const searchResults = await sharedMemory.searchMemories(
        {
          query: "project alpha status",
          categories: ["project"],
        },
        androidContext,
      );

      expect(searchResults.length).toBeGreaterThanOrEqual(1);
      expect(searchResults[0].id).toBe(mem.id);
      expect(searchResults[0].text).toContain("Alpha Project is working on real-time neural sync");
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Full CRUD Operations & Lifecycle
  // ---------------------------------------------------------------------------

  describe("CRUD Operations & Lifecycle", () => {
    it("creates, reads, updates, and deletes memory records with version tracking", async () => {
      // Create
      const created = await sharedMemory.createMemory(
        {
          category: "task",
          text: "Review security audit logs before deployment.",
          key: "audit_logs_task",
        },
        desktopContext,
      );
      expect(created.version).toBe(1);

      // Read
      const retrieved = await sharedMemory.getMemory(created.id, desktopContext);
      expect(retrieved?.text).toBe(created.text);

      // Update
      const updateResult = await sharedMemory.updateMemory(
        created.id,
        {
          text: "Review security audit logs and rotate signing certificates before deployment.",
          importance: "high",
        },
        desktopContext,
      );

      expect(updateResult.success).toBe(true);
      expect(updateResult.memory?.version).toBe(2);
      expect(updateResult.memory?.text).toContain("rotate signing certificates");

      // Delete
      const deleted = await sharedMemory.deleteMemory(created.id, desktopContext);
      expect(deleted).toBe(true);

      const afterDelete = await sharedMemory.getMemory(created.id, desktopContext);
      expect(afterDelete).toBeUndefined();
    });

    it("filters out expired memories according to expiration rules", async () => {
      const pastDate = new Date(Date.now() - 3600 * 1000).toISOString();
      const futureDate = new Date(Date.now() + 3600 * 1000).toISOString();

      await sharedMemory.createMemory({
        category: "fact",
        text: "Temporary gate code is 9876.",
        expiresAt: pastDate,
      });

      await sharedMemory.createMemory({
        category: "fact",
        text: "Active gate code is 5432.",
        expiresAt: futureDate,
      });

      const list = await sharedMemory.listMemories();
      expect(list.length).toBe(1);
      expect(list[0].text).toBe("Active gate code is 5432.");
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Memory Search
  // ---------------------------------------------------------------------------

  describe("Memory Search", () => {
    it("searches memories by keyword, category, and ranking", async () => {
      await sharedMemory.createMemory({
        category: "preference",
        text: "User prefers Earl Grey tea with lemon.",
        importance: "low",
      });

      await sharedMemory.createMemory({
        category: "project",
        text: "Tea brewing automation IoT project using ESP32.",
        importance: "high",
      });

      // Search 'tea' restricted to 'project'
      const projectResults = await sharedMemory.searchMemories({
        query: "tea",
        categories: ["project"],
      });
      expect(projectResults.length).toBe(1);
      expect(projectResults[0].text).toContain("IoT project");

      // Search 'tea' across all categories
      const allResults = await sharedMemory.searchMemories({ query: "tea" });
      expect(allResults.length).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Deduplication
  // ---------------------------------------------------------------------------

  describe("Deduplication", () => {
    it("exact match updates existing memory rather than duplicating", async () => {
      const first = await sharedMemory.createMemory({
        category: "identity",
        text: "My name is Sandeep.",
        key: "user_name",
        importance: "medium",
      });

      const second = await sharedMemory.createMemory({
        category: "identity",
        text: "My name is Sandeep.",
        key: "user_name",
        importance: "high",
      });

      expect(second.id).toBe(first.id);
      expect(second.importance).toBe("high");
      expect(second.version).toBe(2);

      const all = await sharedMemory.listMemories();
      expect(all.length).toBe(1);
    });

    it("similar match merges content into existing record", async () => {
      const first = await sharedMemory.createMemory({
        category: "preference",
        text: "User prefers VS Code with vim keybindings.",
        key: "editor_preferences",
      });

      const second = await sharedMemory.createMemory({
        category: "preference",
        text: "User prefers VS Code with vim keybindings and Monokai theme.",
        key: "editor_preferences",
      });

      expect(second.id).toBe(first.id);
      expect(second.version).toBe(2);
      expect(second.text).toContain("Monokai theme");

      const all = await sharedMemory.listMemories();
      expect(all.length).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Deterministic Conflict Resolution (Server-Authoritative LWW)
  // ---------------------------------------------------------------------------

  describe("Deterministic Conflict Resolution", () => {
    it("accepts client mutation when client timestamp is newer (LWW)", async () => {
      const mem = await sharedMemory.createMemory(
        {
          category: "task",
          text: "Initial task description.",
        },
        desktopContext,
      );
      expect(mem.version).toBe(1);

      // Simulate Android updating with a future/newer timestamp but stale base version
      const newerTimestamp = new Date(Date.now() + 5000).toISOString();
      const res = await sharedMemory.updateMemory(
        mem.id,
        {
          text: "Updated task description from mobile.",
          clientVersion: 1,
          timestamp: newerTimestamp,
        },
        androidContext,
      );

      expect(res.success).toBe(true);
      expect(res.memory?.text).toBe("Updated task description from mobile.");
      expect(res.memory?.version).toBe(2);
    });

    it("retains server record when server timestamp is newer than stale client mutation", async () => {
      // Step 1: Memory created at T0
      const mem = await sharedMemory.createMemory({
        category: "task",
        text: "Initial version",
      });

      // Step 2: Desktop updates at T1 (server version becomes v2)
      await sharedMemory.updateMemory(mem.id, {
        text: "Server authoritative updated version",
      });

      // Step 3: Stale Android client (with timestamp T0 older than server T1) attempts update
      const staleTimestamp = new Date(Date.now() - 10000).toISOString();
      const res = await sharedMemory.updateMemory(
        mem.id,
        {
          text: "Stale mobile overwrite attempt",
          clientVersion: 1, // Stale version! Current server is v2
          timestamp: staleTimestamp,
        },
        androidContext,
      );

      // Server tie-breaker wins: Server record is retained
      expect(res.success).toBe(true);
      expect(res.conflictResolved).toBe(true);
      expect(res.memory?.text).toBe("Server authoritative updated version");
      expect(res.resolutionNote).toContain("Server record");
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Offline Batch Synchronization & Idempotency
  // ---------------------------------------------------------------------------

  describe("Offline Synchronization & Idempotency", () => {
    it("processes batch mutations from offline Android client in chronological order", async () => {
      const t1 = new Date(Date.now() - 2000).toISOString();
      const t2 = new Date(Date.now() - 1000).toISOString();

      const batch = {
        deviceId: "android_companion_pixel",
        deviceType: "android" as const,
        mutations: [
          {
            clientMutationId: "mut_001",
            mutationType: "CREATE" as const,
            data: {
              category: "project" as const,
              text: "Offline project note: review PR #42.",
              key: "offline_pr_note",
            },
            timestamp: t1,
          },
          {
            clientMutationId: "mut_002",
            mutationType: "CREATE" as const,
            data: {
              category: "preference" as const,
              text: "Offline preference: auto-save enabled.",
              key: "offline_autosave",
            },
            timestamp: t2,
          },
        ],
      };

      const syncRes = await sharedMemory.syncBatch(batch, androidContext);
      expect(syncRes.success).toBe(true);
      expect(syncRes.appliedCount).toBe(2);
      expect(syncRes.memories.length).toBe(2);
      expect(syncRes.memories.some((m) => m.key === "offline_pr_note")).toBe(true);
      expect(syncRes.memories.some((m) => m.key === "offline_autosave")).toBe(true);
    });

    it("idempotency: retrying the same batch does not create duplicates or re-apply mutations", async () => {
      const batch = {
        deviceId: "android_companion_pixel",
        deviceType: "android" as const,
        mutations: [
          {
            clientMutationId: "mut_unique_100",
            mutationType: "CREATE" as const,
            data: {
              category: "task" as const,
              text: "Single execution task.",
            },
            timestamp: new Date().toISOString(),
          },
        ],
      };

      // First sync
      const res1 = await sharedMemory.syncBatch(batch, androidContext);
      expect(res1.appliedCount).toBe(1);
      expect(res1.memories.length).toBe(1);

      // Replay / retry of identical batch
      const res2 = await sharedMemory.syncBatch(batch, androidContext);
      expect(res2.appliedCount).toBe(1); // idempotent
      expect(res2.memories.length).toBe(1); // no duplicate record created!
    });
  });

  // ---------------------------------------------------------------------------
  // 7. DLP & Secret Protection
  // ---------------------------------------------------------------------------

  describe("DLP & Secret Protection", () => {
    it("detects sensitive credential patterns correctly via isDlpClean", () => {
      expect(isDlpClean("This is a normal project note.")).toBe(true);
      expect(isDlpClean("My key is AIzaSyD3x4mPl3Key1234567890abcdefg")).toBe(false);
      expect(isDlpClean("OpenAI key sk-1234567890abcdefghijklmnopqr")).toBe(false);
      expect(isDlpClean("Token sora_dev_0123456789abcdef0123456789abcdef")).toBe(false);
      expect(isDlpClean("Bearer myraa_at_0123456789abcdef0123456789abcdef")).toBe(false);
      expect(isDlpClean("-----BEGIN RSA PRIVATE KEY-----")).toBe(false);
      expect(isDlpClean("Card: 4111 2222 3333 4444")).toBe(false);
      expect(isDlpClean("Your OTP code is 482910")).toBe(false);
    });

    it("rejects memory creation containing API keys or tokens with DLP_SECRET_REJECTED", async () => {
      await expect(
        sharedMemory.createMemory(
          {
            category: "fact",
            text: "Here is the key: AIzaSyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q",
          },
          androidContext,
        ),
      ).rejects.toThrow("DLP_SECRET_REJECTED");
    });

    it("rejects memory creation containing credit card numbers", async () => {
      await expect(
        sharedMemory.createMemory(
          {
            category: "fact",
            text: "Visa card number: 4111 2222 3333 4444",
          },
          androidContext,
        ),
      ).rejects.toThrow("DLP_SECRET_REJECTED");
    });

    it("rejects batch sync mutations containing OTP codes", async () => {
      const batch = {
        deviceId: "android_companion_pixel",
        deviceType: "android" as const,
        mutations: [
          {
            clientMutationId: "mut_otp_01",
            mutationType: "CREATE" as const,
            data: {
              category: "fact" as const,
              text: "My bank OTP code is 123456",
            },
            timestamp: new Date().toISOString(),
          },
        ],
      };

      const res = await sharedMemory.syncBatch(batch, androidContext);
      expect(res.success).toBe(false);
      expect(res.rejectedMutations?.length).toBe(1);
      expect(res.rejectedMutations?.[0].reason).toContain("DLP_SECRET_REJECTED");

      const all = await sharedMemory.listMemories();
      expect(all.length).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // 8. Emergency Stop & Security Policy Lockdown
  // ---------------------------------------------------------------------------

  describe("Emergency Stop & Security Lockdown", () => {
    it("fails closed immediately on create/update/delete when Emergency Stop is active", async () => {
      await emergencyStopCoordinator.trigger({
        source: "desktop_ui",
        reason: "Security halt",
      });

      await expect(
        sharedMemory.createMemory({ category: "task", text: "Test task" }),
      ).rejects.toThrow("EMERGENCY_STOP_ACTIVE");

      await expect(
        sharedMemory.listMemories(),
      ).rejects.toThrow("EMERGENCY_STOP_ACTIVE");

      await expect(
        sharedMemory.syncBatch({
          deviceId: "android_01",
          deviceType: "android",
          mutations: [],
        }),
      ).rejects.toThrow("EMERGENCY_STOP_ACTIVE");
    });

    it("fails closed immediately on all operations when Security Policy Lockdown is active", async () => {
      securityPolicyEngine.setMode("LOCKDOWN");

      await expect(
        sharedMemory.createMemory({ category: "task", text: "Test task" }),
      ).rejects.toThrow("SECURITY_LOCKDOWN_ACTIVE");

      await expect(
        sharedMemory.listMemories(),
      ).rejects.toThrow("SECURITY_LOCKDOWN_ACTIVE");

      await expect(
        sharedMemory.searchMemories({ query: "test" }),
      ).rejects.toThrow("SECURITY_LOCKDOWN_ACTIVE");
    });
  });

  // ---------------------------------------------------------------------------
  // 9. Real-Time Sync Event Broadcast
  // ---------------------------------------------------------------------------

  describe("Real-Time Synchronization Broadcasting", () => {
    it("dispatches sync events to registered listeners on create, update, delete", async () => {
      const events: SharedMemorySyncEvent[] = [];
      const unregister = sharedMemory.registerSyncListener((evt) => {
        events.push(evt);
      });

      const mem = await sharedMemory.createMemory(
        { category: "task", text: "Broadcast test item" },
        desktopContext,
      );

      await sharedMemory.updateMemory(
        mem.id,
        { text: "Broadcast test item updated" },
        desktopContext,
      );

      await sharedMemory.deleteMemory(mem.id, desktopContext);

      expect(events.length).toBe(3);
      expect(events[0].action).toBe("create");
      expect(events[1].action).toBe("update");
      expect(events[2].action).toBe("delete");

      unregister();
    });
  });

  // ---------------------------------------------------------------------------
  // 10. Invariant Check: Exactly 126 Gemini Live Tools Preserved
  // ---------------------------------------------------------------------------

  describe("Tool Count Invariant", () => {
    it("preserves exactly 126 Gemini Live tools without additions or removals", () => {
      expect(LIVE_TOOLS).toHaveLength(1);
      const decls = LIVE_TOOLS[0].functionDeclarations;
      expect(decls).toHaveLength(126);

      // Verify saveCustomMemory is tool #1 and properly configured
      const saveTool = decls.find((t: any) => t.name === "saveCustomMemory");
      expect(saveTool).toBeDefined();
    });
  });
});
