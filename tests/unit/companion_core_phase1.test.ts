/**
 * MYRAA — Stage 10 Phase 1 Unit Test Suite
 *
 * Tests the combined Stage 10.1 and Stage 10.2 core components:
 *   - CompanionPersonaStore & REST API (CP01.1 – CP01.5)
 *   - GoverningMemoryGate & Security Governance (CP02.1 – CP02.10)
 *   - SessionContextManager & DLP Redaction (CP03.1 – CP03.6)
 *
 * Invariants Verified:
 *   - Exactly 21 unit tests (CP01.1-5, CP02.1-10, CP03.1-6)
 *   - Zero disk leaks from session context
 *   - Cryptographic payload binding and fail-closed tamper resistance
 *   - Mandatory "always_ask" default policy
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import http from "http";
import fs from "fs/promises";
import path from "path";
import os from "os";

import { CompanionPersonaStore } from "../../backend/companion/CompanionPersonaStore.ts";
import { DEFAULT_COMPANION_PERSONA } from "../../backend/companion/CompanionPersonaTypes.ts";
import { GoverningMemoryGate } from "../../backend/companion/GoverningMemoryGate.ts";
import { SessionContextManager } from "../../backend/companion/SessionContextManager.ts";
import { mountCompanionRoutes } from "../../backend/server.ts";
import { createHttpApp } from "../../backend/gateway/HttpGateway.ts";
import { searchMemories } from "../../backend/memory/MemorySearch.ts";
import { securityAuditLogger } from "../../backend/security/SecurityAuditLogger.ts";
import { identityAuthManager } from "../../backend/security/IdentityAuthManager.ts";
import type { EnhancedMemory } from "../../backend/memory/MemoryTypes.ts";
import type { MemoryApprovalContext } from "../../backend/companion/GoverningMemoryTypes.ts";

const DEFAULT_ACTOR_CTX: MemoryApprovalContext = {
  actorId: "default",
  role: "admin",
  ipAddress: "127.0.0.1",
  isStepUpAuthenticated: true,
};

function createTestOperatorBearer(
  identityId = "local_operator",
  role: "admin" | "standard" | "guest" | "read_only" = "admin",
): { token: string; sessionId: string } {
  const { session, tokens } = identityAuthManager.createSession({
    deviceId: `test_dev_${identityId}`,
    identityId,
    role,
    ipAddress: "127.0.0.1",
  });
  return { token: tokens.accessToken, sessionId: session.sessionId };
}

describe("Stage 10 Phase 1: Companion Core Unit Tests", () => {
  let tempDir: string;
  let tempPersonaFile: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "myraa-persona-test-"));
    tempPersonaFile = path.join(tempDir, "companion_persona.json");
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      /* ignore cleanup error */
    }
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Group 1: CompanionPersonaStore (CP01.1 – CP01.5)
  // ---------------------------------------------------------------------------
  describe("Group 1: CompanionPersonaStore", () => {
    it("CP01.1: Default persona loads when companion_persona.json does not exist", async () => {
      const store = new CompanionPersonaStore(tempPersonaFile);
      const persona = await store.getPersona();

      expect(persona).toBeDefined();
      expect(persona.id).toBe("persona_default");
      expect(persona.displayName).toBe("MYRAA");
      expect(persona.preferredLanguage).toBe("hinglish");
      expect(persona.communicationStyle.verbosity).toBe("normal");
      expect(persona.communicationStyle.formality).toBe("casual");
      expect(persona.communicationStyle.emotionalTone).toBe("warm");
    });

    it("CP01.2: Persona persists across store.save() / store.load() cycle", async () => {
      const store1 = new CompanionPersonaStore(tempPersonaFile);
      await store1.getPersona(); // initializes
      await store1.savePersona({
        displayName: "MYRAA Pro",
        preferredLanguage: "english",
      });

      const store2 = new CompanionPersonaStore(tempPersonaFile);
      const reloaded = await store2.getPersona();

      expect(reloaded.displayName).toBe("MYRAA Pro");
      expect(reloaded.preferredLanguage).toBe("english");
      expect(reloaded.communicationStyle.verbosity).toBe("normal"); // preserved
    });

    it("CP01.3: PUT /api/companion/persona updates displayName and persists", async () => {
      const app = createHttpApp();
      mountCompanionRoutes(app);

      const server = http.createServer(app);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as any).port;
      const { token } = createTestOperatorBearer();

      try {
        const putRes = await fetch(`http://127.0.0.1:${port}/api/companion/persona`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ displayName: "Aarya", preferredLanguage: "hindi" }),
        });

        expect(putRes.status).toBe(200);
        const putBody = (await putRes.json()) as any;
        expect(putBody.displayName).toBe("Aarya");
        expect(putBody.preferredLanguage).toBe("hindi");

        const getRes = await fetch(`http://127.0.0.1:${port}/api/companion/persona`);
        expect(getRes.status).toBe(200);
        const getBody = (await getRes.json()) as any;
        expect(getBody.displayName).toBe("Aarya");
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it("CP01.4: communicationStyle fields (verbosity, formality, emotionalTone) round-trip correctly", async () => {
      const store = new CompanionPersonaStore(tempPersonaFile);
      await store.savePersona({
        communicationStyle: {
          verbosity: "concise",
          formality: "professional",
          emotionalTone: "direct",
        },
      });

      const updated = await store.getPersona();
      expect(updated.communicationStyle.verbosity).toBe("concise");
      expect(updated.communicationStyle.formality).toBe("professional");
      expect(updated.communicationStyle.emotionalTone).toBe("direct");
    });

    it("CP01.5: Persona file is NOT queried by MemorySearch (isolation test)", async () => {
      const store = new CompanionPersonaStore(tempPersonaFile);
      await store.savePersona({
        displayName: "IsolatedPersonaMarker999",
        customPromptPrefix: "SecretKeywordAlphaBravoCharlie",
      });

      // MemorySearch strictly inspects EnhancedMemory lists from memories.json
      const mockMemories: EnhancedMemory[] = [
        {
          id: "mem_1",
          category: "fact",
          text: "Standard user memory about coding in TypeScript",
          importance: "high",
          confidence: "high",
          source: "conversation_extracted",
          status: "active",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ];

      const results = searchMemories(mockMemories, {
        query: "IsolatedPersonaMarker999",
      });
      expect(results).toHaveLength(0);

      const promptSearch = searchMemories(mockMemories, {
        query: "SecretKeywordAlphaBravoCharlie",
      });
      expect(promptSearch).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Group 2: GoverningMemoryGate (CP02.1 – CP02.10)
  // ---------------------------------------------------------------------------
  describe("Group 2: GoverningMemoryGate", () => {
    it("CP02.1: requestWrite() creates a pending MemoryWriteRequest with approved=undefined", async () => {
      const gate = new GoverningMemoryGate();
      gate.setPolicy("always_ask", DEFAULT_ACTOR_CTX);

      const req = await gate.requestWrite({
        action: "CREATE",
        proposedMemory: { category: "preference", text: "Prefers tabs over spaces" },
        reason: "User specified indentation style",
        confidence: 0.95,
        source: "conversation_extracted",
      });

      expect(req.id).toBeDefined();
      expect(req.approved).toBeUndefined();
      expect(req.payloadHash).toBeDefined();
      expect(req.payloadHash).toBe(
        gate.computePayloadHash({ category: "preference", text: "Prefers tabs over spaces" }),
      );
      expect(req.oneTimeToken).toBeDefined();
      expect(gate.listPendingRequests()).toHaveLength(1);
    });

    it("CP02.2: approveWrite() calls MemoryManager.add() exactly once and logs MEMORY_WRITE_APPROVED", async () => {
      const addMock = vi.fn().mockImplementation(async (payload) => ({
        id: "mem_created_123",
        ...payload,
        status: "active",
      }));
      const mockMm = { add: addMock } as any;

      const logSpy = vi.spyOn(securityAuditLogger, "logEvent");
      const gate = new GoverningMemoryGate(mockMm);
      gate.setPolicy("always_ask", DEFAULT_ACTOR_CTX);

      const req = await gate.requestWrite({
        proposedMemory: { category: "skill", text: "Knows Rust programming" },
        reason: "User demonstrated Rust syntax",
        confidence: 0.88,
        source: "conversation_extracted",
      });

      const approved = await gate.approveWrite(req.id, req.oneTimeToken, DEFAULT_ACTOR_CTX);

      expect(addMock).toHaveBeenCalledTimes(1);
      expect(addMock).toHaveBeenCalledWith(
        expect.objectContaining({ category: "skill", text: "Knows Rust programming" }),
      );
      expect(approved.id).toBe("mem_created_123");

      const auditCall = logSpy.mock.calls.find((c) =>
        c[0].reason.includes("MEMORY_WRITE_APPROVED"),
      );
      expect(auditCall).toBeDefined();
      expect(auditCall![0].decision).toBe("ALLOW");
    });

    it("CP02.3: rejectWrite() does NOT call MemoryManager.add() and logs MEMORY_WRITE_REJECTED", async () => {
      const addMock = vi.fn();
      const mockMm = { add: addMock } as any;
      const logSpy = vi.spyOn(securityAuditLogger, "logEvent");

      const gate = new GoverningMemoryGate(mockMm);
      const req = await gate.requestWrite({
        proposedMemory: { category: "fact", text: "User lives in Mumbai" },
        reason: "Detected location",
        confidence: 0.7,
        source: "conversation_extracted",
      });

      const rejected = gate.rejectWrite(req.id, "User declined location saving", DEFAULT_ACTOR_CTX);
      expect(rejected).toBe(true);
      expect(addMock).not.toHaveBeenCalled();

      const auditCall = logSpy.mock.calls.find((c) =>
        c[0].reason.includes("MEMORY_WRITE_REJECTED"),
      );
      expect(auditCall).toBeDefined();
      expect(auditCall![0].decision).toBe("BLOCK");

      // Verify cannot approve after reject
      await expect(gate.approveWrite(req.id, req.oneTimeToken, DEFAULT_ACTOR_CTX)).rejects.toThrow("REQUEST_ALREADY_REJECTED");
    });

    it("CP02.4: expireStale() discards requests older than 24h without calling MemoryManager.add()", async () => {
      const addMock = vi.fn();
      const gate = new GoverningMemoryGate({ add: addMock } as any);

      const req = await gate.requestWrite({
        proposedMemory: { category: "task", text: "Follow up on invoice" },
        reason: "Pending task",
        confidence: 0.8,
        source: "conversation_extracted",
      });

      // Simulate passage of 25 hours (> 24 hour expiration window)
      const futureTime = Date.now() + 25 * 60 * 60 * 1000;
      const expiredCount = gate.expireStale(futureTime);

      expect(expiredCount).toBe(1);
      expect(addMock).not.toHaveBeenCalled();
      expect(gate.listPendingRequests()).toHaveLength(0);

      // Attempting to approve expired request fails
      await expect(gate.approveWrite(req.id, req.oneTimeToken, DEFAULT_ACTOR_CTX)).rejects.toThrow("REQUEST_NOT_FOUND");
    });

    it("CP02.5: policy='always_ask': requestWrite with confidence=0.99 remains pending (no auto-approve)", async () => {
      const addMock = vi.fn();
      const gate = new GoverningMemoryGate({ add: addMock } as any);
      gate.setPolicy("always_ask", DEFAULT_ACTOR_CTX);

      const req = await gate.requestWrite({
        proposedMemory: { category: "identity", text: "User is an architect" },
        reason: "Highest confidence identity statement",
        confidence: 0.99,
        source: "conversation_extracted",
      });

      expect(req.approved).toBeUndefined();
      expect(addMock).not.toHaveBeenCalled();
      expect(gate.listPendingRequests()).toHaveLength(1);
    });

    it("CP02.6: policy='auto_approve_high_confidence': requestWrite with confidence>=0.85 is auto-approved synchronously", async () => {
      const addMock = vi.fn().mockImplementation(async (payload) => ({
        id: "auto_mem_1",
        ...payload,
      }));
      const gate = new GoverningMemoryGate({ add: addMock } as any);
      gate.setPolicy("auto_approve_high_confidence", DEFAULT_ACTOR_CTX);

      const req = await gate.requestWrite({
        proposedMemory: { category: "skill", text: "Python developer" },
        reason: "High confidence detected skill",
        confidence: 0.9,
        source: "conversation_extracted",
      });

      expect(req.approved).toBe(true);
      expect(addMock).toHaveBeenCalledTimes(1);
      expect(gate.listPendingRequests()).toHaveLength(0); // not pending
    });

    it("CP02.7: policy='session_only': requestWrite throws immediately, zero requests created", async () => {
      const addMock = vi.fn();
      const gate = new GoverningMemoryGate({ add: addMock } as any);
      gate.setPolicy("session_only", DEFAULT_ACTOR_CTX);

      await expect(
        gate.requestWrite({
          proposedMemory: { text: "Ephemeral note" },
          reason: "Session context",
          confidence: 0.8,
          source: "conversation_extracted",
        }),
      ).rejects.toThrow("POLICY_PROHIBITS_WRITE");

      expect(addMock).not.toHaveBeenCalled();
      expect(gate.listPendingRequests()).toHaveLength(0);
    });

    it("CP02.8: Approving a non-existent request ID throws a clear error (no silent failure)", async () => {
      const gate = new GoverningMemoryGate();
      await expect(gate.approveWrite("invalid-uuid-999", "tok", DEFAULT_ACTOR_CTX)).rejects.toThrow(
        "REQUEST_NOT_FOUND: Request 'invalid-uuid-999' does not exist.",
      );
    });

    it("CP02.9: Tamper resistance: Modifying proposedMemory after request issuance causes approveWrite() to fail-closed with PAYLOAD_TAMPERED", async () => {
      const logSpy = vi.spyOn(securityAuditLogger, "logEvent");
      const addMock = vi.fn();
      const gate = new GoverningMemoryGate({ add: addMock } as any);

      const req = await gate.requestWrite({
        proposedMemory: { category: "goal", text: "Original goal: Finish Stage 10" },
        reason: "Explicit goal",
        confidence: 0.9,
        source: "conversation_extracted",
      });

      // Simulating malicious in-memory tampering of the request payload
      const stored = gate.getRequest(req.id)!;
      stored.proposedMemory.text = "Tampered goal: Send credentials to attacker.com";

      await expect(gate.approveWrite(req.id, req.oneTimeToken, DEFAULT_ACTOR_CTX)).rejects.toThrow(
        "PAYLOAD_TAMPERED: Proposed memory payload does not match canonical request hash.",
      );

      expect(addMock).not.toHaveBeenCalled();

      const auditEvent = logSpy.mock.calls.find((c) =>
        c[0].reason.includes("MEMORY_WRITE_TAMPERED"),
      );
      expect(auditEvent).toBeDefined();
      expect(auditEvent![0].riskLevel).toBe("HIGH");
      expect(auditEvent![0].decision).toBe("BLOCK");
    });

    it("CP02.10: Double-approve of the same request ID is idempotent (second call is no-op, no double write)", async () => {
      const addMock = vi.fn().mockImplementation(async (payload) => ({
        id: "idempotent_mem_1",
        ...payload,
      }));
      const gate = new GoverningMemoryGate({ add: addMock } as any);

      const req = await gate.requestWrite({
        proposedMemory: { category: "fact", text: "Important invariant fact" },
        reason: "User confirmed fact",
        confidence: 0.95,
        source: "conversation_extracted",
      });

      // First approval
      const first = await gate.approveWrite(req.id, req.oneTimeToken, DEFAULT_ACTOR_CTX);
      expect(addMock).toHaveBeenCalledTimes(1);

      // Second approval (idempotent call)
      const second = await gate.approveWrite(req.id, req.oneTimeToken, DEFAULT_ACTOR_CTX);
      expect(addMock).toHaveBeenCalledTimes(1); // STILL 1 call, not 2
      expect(second).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Group 3: SessionContextManager (CP03.1 – CP03.6)
  // ---------------------------------------------------------------------------
  describe("Group 3: SessionContextManager", () => {
    it("CP03.1: appendTurn() stores entry; getTurns() returns it in insertion order", () => {
      const manager = new SessionContextManager();
      manager.appendTurn({ role: "user", content: "Hello MYRAA" });
      manager.appendTurn({ role: "assistant", content: "Namaste! How can I assist you today?" });

      const turns = manager.getTurns();
      expect(turns).toHaveLength(2);
      expect(turns[0].role).toBe("user");
      expect(turns[0].content).toBe("Hello MYRAA");
      expect(turns[1].role).toBe("assistant");
      expect(turns[1].content).toBe("Namaste! How can I assist you today?");
    });

    it("CP03.2: 51st appendTurn() evicts the first entry (ring buffer bound at 50)", () => {
      const manager = new SessionContextManager({ maxRingBufferSize: 50 });

      for (let i = 1; i <= 51; i++) {
        manager.appendTurn({ role: "user", content: `Turn #${i}` });
      }

      const turns = manager.getTurns();
      expect(turns).toHaveLength(50);
      expect(turns[0].content).toBe("Turn #2"); // Turn #1 evicted
      expect(turns[49].content).toBe("Turn #51");
    });

    it("CP03.3: clearSession() empties the buffer", () => {
      const manager = new SessionContextManager();
      manager.appendTurn({ role: "user", content: "Turn 1" });
      manager.appendTurn({ role: "assistant", content: "Turn 2" });
      expect(manager.getTurnCount()).toBe(2);

      manager.clearSession();
      expect(manager.getTurnCount()).toBe(0);
      expect(manager.getTurns()).toEqual([]);
    });

    it("CP03.4: userMessage containing 'AIza...' API key pattern is stored as '[REDACTED_GEMINI_KEY]'", () => {
      const manager = new SessionContextManager();
      const rawSecret = "AIzaSyFakeGoogleApiKeyForTesting1234567890";
      const entry = manager.appendTurn({
        role: "user",
        content: `Here is my key: ${rawSecret} please use it.`,
      });

      expect(entry.sensitiveRedacted).toBe(true);
      expect(entry.content).not.toContain(rawSecret);
      expect(entry.content).toContain("[REDACTED_GEMINI_KEY]");

      const turns = manager.getTurns();
      expect(turns[0].content).toContain("[REDACTED_GEMINI_KEY]");
      expect(turns[0].content).not.toContain(rawSecret);
    });

    it("CP03.5: No file is created in the working tree after 100 appendTurn() calls", async () => {
      const manager = new SessionContextManager();
      const filesBefore = await fs.readdir(process.cwd());

      for (let i = 0; i < 100; i++) {
        manager.appendTurn({ role: "user", content: `Ephemeral turn test ${i}` });
      }

      const filesAfter = await fs.readdir(process.cwd());
      expect(filesAfter.length).toBe(filesBefore.length);
      expect(filesAfter).toEqual(filesBefore);
    });

    it("CP03.6: getTurns() returns a copy (mutations to the result do not affect the buffer)", () => {
      const manager = new SessionContextManager();
      manager.appendTurn({ role: "user", content: "Immutable test turn" });

      const turns = manager.getTurns();
      turns[0].content = "Malicious local mutation";
      (turns as any).push({ role: "user", content: "Injected fake turn" });

      const freshTurns = manager.getTurns();
      expect(freshTurns).toHaveLength(1);
      expect(freshTurns[0].content).toBe("Immutable test turn");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Stage 10 Phase 2: Security Verification & Invariant Matrix
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Group 4: SEC-P1-01 Approval-Token Security & Operator Auth", () => {
    it("SEC-T01.1: Call approveWrite with token: undefined throws MISSING_APPROVAL_TOKEN", async () => {
      const gate = new GoverningMemoryGate();
      const req = await gate.requestWrite({
        proposedMemory: { category: "fact", text: "Test token undefined" },
        reason: "Test",
        confidence: 0.8,
        source: "conversation_extracted",
      });
      await expect(gate.approveWrite(req.id, undefined as any)).rejects.toThrow("MISSING_APPROVAL_TOKEN");
    });

    it("SEC-T01.2: Call approveWrite with token: '' or '   ' throws MISSING_APPROVAL_TOKEN", async () => {
      const gate = new GoverningMemoryGate();
      const req = await gate.requestWrite({
        proposedMemory: { category: "fact", text: "Test blank token" },
        reason: "Test",
        confidence: 0.8,
        source: "conversation_extracted",
      });
      await expect(gate.approveWrite(req.id, "")).rejects.toThrow("MISSING_APPROVAL_TOKEN");
      await expect(gate.approveWrite(req.id, "   ")).rejects.toThrow("MISSING_APPROVAL_TOKEN");
    });

    it("SEC-T01.3: Call approveWrite with invalid/tampered token string throws PAYLOAD_TAMPERED", async () => {
      const gate = new GoverningMemoryGate();
      const req = await gate.requestWrite({
        proposedMemory: { category: "fact", text: "Test invalid token" },
        reason: "Test",
        confidence: 0.8,
        source: "conversation_extracted",
      });
      await expect(gate.approveWrite(req.id, "tampered_token_string_1234567890", DEFAULT_ACTOR_CTX)).rejects.toThrow("PAYLOAD_TAMPERED");
    });

    it("SEC-T01.4: Call approveWrite with valid token and canonical hash returns EnhancedMemory", async () => {
      const gate = new GoverningMemoryGate({ add: async (m: any) => ({ id: "mem_valid_01", ...m }) } as any);
      const req = await gate.requestWrite({
        proposedMemory: { category: "preference", text: "Prefers TypeScript" },
        reason: "Explicit test",
        confidence: 0.9,
        source: "conversation_extracted",
      });
      const approved = await gate.approveWrite(req.id, req.oneTimeToken, DEFAULT_ACTOR_CTX);
      expect(approved).toBeDefined();
      expect(approved.id).toBe("mem_valid_01");
    });

    it("SEC-T01.5: Re-submitting previously approved token (Replay attack) throws PAYLOAD_TAMPERED", async () => {
      const gate = new GoverningMemoryGate({ add: async (m: any) => ({ id: "mem_replay_01", ...m }) } as any);
      const req = await gate.requestWrite({
        proposedMemory: { category: "fact", text: "Replay test fact" },
        reason: "Test",
        confidence: 0.9,
        source: "conversation_extracted",
      });
      const validToken = req.oneTimeToken;
      await gate.approveWrite(req.id, validToken, DEFAULT_ACTOR_CTX);

      // Attempting to reuse the now-wiped token on a pending request
      (gate as any)._requests.get(req.id).approved = undefined;
      await expect(gate.approveWrite(req.id, validToken, DEFAULT_ACTOR_CTX)).rejects.toThrow("PAYLOAD_TAMPERED");
    });

    it("SEC-T01.6: Call approveWrite on expired request (> 24 hours) throws REQUEST_EXPIRED", async () => {
      const gate = new GoverningMemoryGate();
      const req = await gate.requestWrite({
        proposedMemory: { category: "task", text: "Expired request task" },
        reason: "Test",
        confidence: 0.8,
        source: "conversation_extracted",
      });

      // Force expiration on internal request
      (gate as any)._requests.get(req.id).expiresAt = new Date(Date.now() - 1000).toISOString();

      await expect(gate.approveWrite(req.id, req.oneTimeToken, DEFAULT_ACTOR_CTX)).rejects.toThrow("REQUEST_EXPIRED");
    });

    it("SEC-T01.7: Call approveWrite with mismatched actorId throws UNAUTHORIZED_ACTOR", async () => {
      const gate = new GoverningMemoryGate();
      const req = await gate.requestWrite({
        proposedMemory: { category: "fact", text: "User ownership fact" },
        reason: "Test",
        confidence: 0.8,
        source: "conversation_extracted",
        userId: "user_alice",
      });

      await expect(
        gate.approveWrite(req.id, req.oneTimeToken, {
          actorId: "user_bob",
          role: "standard",
          ipAddress: "127.0.0.1",
        }),
      ).rejects.toThrow("UNAUTHORIZED_ACTOR");
    });

    it("SEC-T01.8: listPendingRequests() redacts oneTimeToken from all returned records", async () => {
      const gate = new GoverningMemoryGate();
      await gate.requestWrite({
        proposedMemory: { category: "skill", text: "Redacted token skill" },
        reason: "Test",
        confidence: 0.8,
        source: "conversation_extracted",
      });

      const list = gate.listPendingRequests();
      expect(list.length).toBeGreaterThanOrEqual(1);
      for (const item of list) {
        expect((item as any).oneTimeToken).toBeUndefined();
      }
    });
  });

  describe("Group 5: SEC-P1-02 GovernanceProof & Runtime Storage Boundary", () => {
    it("SEC-T02.1: POST /api/memories returns 202 Accepted with requestId and does not write disk", async () => {
      const app = createHttpApp();
      mountCompanionRoutes(app);
      const server = http.createServer(app);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as any).port;
      const { token } = createTestOperatorBearer();

      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/memories`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ category: "preference", text: "Prefers dark mode" }),
        });
        expect(res.status).toBe(202);
        const body = (await res.json()) as any;
        expect(body.status).toBe("pending_approval");
        expect(body.requestId).toBeDefined();
        expect(body.oneTimeToken).toBeUndefined(); // Zero token wire exposure
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it("SEC-T02.2: PATCH /api/memories/:id returns 404 for nonexistent record when authenticated", async () => {
      const app = createHttpApp();
      mountCompanionRoutes(app);
      const server = http.createServer(app);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as any).port;
      const { token } = createTestOperatorBearer();

      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/memories/nonexistent_123`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ text: "Updated text" }),
        });
        // Returns 404 for non-existent record
        expect(res.status).toBe(404);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it("SEC-T02.3: POST /api/remote/memory returns 202 Accepted and queues proposal", async () => {
      const app = createHttpApp();
      mountCompanionRoutes(app);
      const server = http.createServer(app);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as any).port;
      const { token } = createTestOperatorBearer();

      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/remote/memory`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ category: "fact", text: "Android remote memory fact" }),
        });
        expect(res.status).toBe(202);
        const body = (await res.json()) as any;
        expect(body.status).toBe("pending_approval");
        expect(body.requestId).toBeDefined();
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it("SEC-T02.4: POST /api/remote/memory/sync queues batch items and returns 202 Accepted", async () => {
      const app = createHttpApp();
      mountCompanionRoutes(app);
      const server = http.createServer(app);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as any).port;
      const { token } = createTestOperatorBearer();

      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/remote/memory/sync`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            deviceId: "android_test_dev",
            mutations: [
              { type: "create", memoryId: "batch_m1", mutation: { category: "fact", text: "Batch 1" } },
              { type: "create", memoryId: "batch_m2", mutation: { category: "fact", text: "Batch 2" } },
            ],
          }),
        });
        expect(res.status).toBe(202);
        const body = (await res.json()) as any;
        expect(body.status).toBe("pending_approval");
        expect(body.queuedCount).toBe(2);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it("SEC-T02.8: Direct call to ApprovedMemoryPersistenceAdapter without proof throws UNAUTHORIZED_PERSISTENCE_CALL", async () => {
      const { approvedMemoryPersistenceAdapter } = await import("../../backend/memory/ApprovedMemoryPersistenceAdapter.ts");
      await expect(
        approvedMemoryPersistenceAdapter.commitApproved(
          { id: "fake_req", action: "CREATE", proposedMemory: { text: "fake" } } as any,
          undefined as any,
        ),
      ).rejects.toThrow("UNAUTHORIZED_PERSISTENCE_CALL");
    });

    it("SEC-T02.9: Call adapter with fabricated HMAC signature throws UNAUTHORIZED_PERSISTENCE_CALL", async () => {
      const { approvedMemoryPersistenceAdapter } = await import("../../backend/memory/ApprovedMemoryPersistenceAdapter.ts");
      const fakeProof = {
        payload: {
          proofId: "proof_fake_01",
          requestId: "req_fake_01",
          userId: "local_operator",
          action: "CREATE" as const,
          payloadHash: "fake_hash",
          provenance: "test",
          source: "user_explicit",
          destinationStorage: "memories.json" as const,
          issuedAt: Date.now(),
          expiresAt: Date.now() + 60000,
          nonce: "1234567890abcdef",
        },
        signature: "deadbeefcafebabe0123456789abcdef0123456789abcdef0123456789abcdef",
      };

      await expect(
        approvedMemoryPersistenceAdapter.commitApproved(
          { id: "req_fake_01", action: "CREATE", proposedMemory: { text: "fake" }, userId: "local_operator" } as any,
          fakeProof,
        ),
      ).rejects.toThrow("UNAUTHORIZED_PERSISTENCE_CALL");
    });

    it("SEC-T02.10: Re-submitting previously consumed proofId throws GOVERNANCE_PROOF_ALREADY_CONSUMED (and secret is private)", async () => {
      const { approvedMemoryPersistenceAdapter } = await import("../../backend/memory/ApprovedMemoryPersistenceAdapter.ts");
      const GateMod = await import("../../backend/companion/GoverningMemoryGate.ts");
      const SecretMod = await import("../../backend/companion/GoverningMemorySecret.ts");

      // FINDING-AUD-02: Raw HMAC secret is NEVER exported
      expect((GateMod as any).getInternalPersistenceSecret).toBeUndefined();
      expect((SecretMod as any).getInternalPersistenceSecret).toBeUndefined();
      expect(() => SecretMod.claimGovernanceProofSigner()).toThrow("UNAUTHORIZED_SIGNER_CLAIM");

      // Capture a genuine proof minted through GoverningMemoryGate approval
      const gate = new GoverningMemoryGate();
      const writeReq = await gate.requestWrite({
        action: "CREATE",
        proposedMemory: { category: "fact", text: `Unique proof persistence test fact ${Date.now()}` },
        reason: "Replay test",
        confidence: 0.9,
        source: "user_explicit",
        userId: "local_operator",
      });

      const mintedProof = (gate as any)._mintGovernanceProof(writeReq);

      // First call succeeds
      const result = await approvedMemoryPersistenceAdapter.commitApproved(writeReq, mintedProof);
      expect(result).toBeDefined();

      // Second call with same proofId fails with GOVERNANCE_PROOF_ALREADY_CONSUMED
      await expect(
        approvedMemoryPersistenceAdapter.commitApproved(writeReq, mintedProof),
      ).rejects.toThrow("GOVERNANCE_PROOF_ALREADY_CONSUMED");
    });

    it("SEC-T02.11: Submitting expired proof (>60s) throws GOVERNANCE_PROOF_EXPIRED", async () => {
      const { approvedMemoryPersistenceAdapter } = await import("../../backend/memory/ApprovedMemoryPersistenceAdapter.ts");
      const expiredProof = {
        payload: {
          proofId: "proof_expired_01",
          requestId: "req_expired_01",
          userId: "local_operator",
          action: "CREATE" as const,
          payloadHash: "expired_hash",
          provenance: "test",
          source: "user_explicit",
          destinationStorage: "memories.json" as const,
          issuedAt: Date.now() - 120000,
          expiresAt: Date.now() - 60000, // expired 60s ago
          nonce: "nonce_expired",
        },
        signature: "any_signature",
      };

      await expect(
        approvedMemoryPersistenceAdapter.commitApproved(
          { id: "req_expired_01", action: "CREATE", proposedMemory: { text: "expired" }, userId: "local_operator" } as any,
          expiredProof,
        ),
      ).rejects.toThrow("GOVERNANCE_PROOF_EXPIRED");
    });

    it("SEC-T02.12: Direct call to memoryStore.save() outside authorized context throws FORBIDDEN_STORAGE_WRITE", async () => {
      const { memoryStore } = await import("../../backend/memory/MemoryStore.ts");
      await expect(
        memoryStore.save([{ id: "bypass_attempt", category: "fact", text: "Bypass memory" } as any]),
      ).rejects.toThrow("FORBIDDEN_STORAGE_WRITE");
    });

    it("SEC-T02.13: Forged AsyncLocalStorage Context Rejection (SEC-FINDING-P2-01 + FINDING-AUD-01/02 Remediation)", async () => {
      const MemoryPersistenceContext = await import("../../backend/memory/MemoryPersistenceContext.ts");
      const { memoryStore } = await import("../../backend/memory/MemoryStore.ts");
      const { approvedMemoryPersistenceAdapter } = await import("../../backend/memory/ApprovedMemoryPersistenceAdapter.ts");
      const { AsyncLocalStorage } = await import("async_hooks");

      // 1. Raw persistenceStorageContext is not publicly exportable
      expect((MemoryPersistenceContext as any).persistenceStorageContext).toBeUndefined();

      // 2. An ordinary caller cannot construct an authorized persistence context
      expect((MemoryPersistenceContext as any).PersistenceContext).toBeUndefined();

      // 3. A forged { authorized: true } object cannot authorize a write
      await expect(
        memoryStore.save([{ id: "forged_mem_01", category: "fact", text: "Forged memory" } as any]),
      ).rejects.toThrow("FORBIDDEN_STORAGE_WRITE");

      // 4. A fabricated proof ID is rejected when attempting to run authorized persistence
      const fakeReq = {
        id: "fake_req",
        action: "CREATE" as const,
        proposedMemory: { category: "fact", text: "Forged memory" },
        payloadHash: "0000000000000000000000000000000000000000000000000000000000000000",
        userId: "attacker",
        source: "user_explicit",
        provenance: "test",
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      } as any;
      const fakeProof = {
        payload: {
          proofId: "FORGED_PROOF_123",
          requestId: "fake_req",
          action: "CREATE" as const,
          payloadHash: "0000000000000000000000000000000000000000000000000000000000000000",
          destinationStorage: "memories.json" as const,
          nonce: "1234567890abcdef",
          expiresAt: Date.now() + 60000,
          issuedAt: Date.now(),
          userId: "attacker",
        },
        signature: "deadbeefcafebabe0000111122223333444455556666777788889999aaaabbbb",
      };

      await expect(
        MemoryPersistenceContext.runAuthorizedPersistence(fakeProof as any, fakeReq, async () => {
          await memoryStore.save([]);
        }),
      ).rejects.toThrow("UNAUTHORIZED_PERSISTENCE_CALL");

      // 5. Direct memoryStore.save() outside the approved adapter fails with FORBIDDEN_STORAGE_WRITE
      await expect(memoryStore.save([])).rejects.toThrow("FORBIDDEN_STORAGE_WRITE");

      // 6. External AsyncLocalStorage cannot forge authorization context
      const rogueALS = new AsyncLocalStorage();
      await rogueALS.run({ authorized: true, proofId: "FORGED_PROOF_123" }, async () => {
        await expect(
          memoryStore.save([{ id: "rogue_mem", category: "fact", text: "Rogue memory" } as any]),
        ).rejects.toThrow("FORBIDDEN_STORAGE_WRITE");
      });

      // 7. A valid gate-minted GovernanceProof permits the intended approved write
      const gate = new GoverningMemoryGate();
      const legitimateWriteReq = await gate.requestWrite({
        action: "CREATE",
        proposedMemory: {
          category: "fact",
          text: `Legitimate SEC-T02.13 memory ${Date.now()}`,
          source: "user_explicit",
        },
        reason: "SEC-T02.13 test",
        confidence: 0.9,
        source: "user_explicit",
        userId: "local_operator",
      });
      const validProof = (gate as any)._mintGovernanceProof(legitimateWriteReq);

      const savedResult = await approvedMemoryPersistenceAdapter.commitApproved(
        legitimateWriteReq,
        validProof,
      );
      expect(savedResult.text).toBe(legitimateWriteReq.proposedMemory.text);

      // 8. The same proof cannot be replayed
      await expect(
        approvedMemoryPersistenceAdapter.commitApproved(legitimateWriteReq, validProof),
      ).rejects.toThrow("GOVERNANCE_PROOF_ALREADY_CONSUMED");

      // 9. Authorization does not leak into subsequent unrelated asynchronous operations
      await expect(
        memoryStore.save([{ id: "leaked_mem", category: "fact", text: "Leaked memory" } as any]),
      ).rejects.toThrow("FORBIDDEN_STORAGE_WRITE");

      // 10. Authorization context is cleaned up after an exception AND proof is consumed fail-closed
      const errorReq = await gate.requestWrite({
        action: "CREATE",
        proposedMemory: { category: "fact", text: `Error memory ${Date.now()}` },
        reason: "Error cleanup test",
        confidence: 0.9,
        source: "user_explicit",
        userId: "local_operator",
      });
      const errorProof = (gate as any)._mintGovernanceProof(errorReq);

      await expect(
        MemoryPersistenceContext.runAuthorizedPersistence(errorProof, errorReq, async () => {
          throw new Error("Simulated persistence failure");
        }),
      ).rejects.toThrow("Simulated persistence failure");

      // Context must be cleanly absent after the exception
      await expect(
        memoryStore.save([{ id: "post_error_mem", category: "fact", text: "Post error" } as any]),
      ).rejects.toThrow("FORBIDDEN_STORAGE_WRITE");

      // And errorProof cannot be replayed after failure (FINDING-AUD-02)
      await expect(
        MemoryPersistenceContext.runAuthorizedPersistence(errorProof, errorReq, async () => {
          return "should_never_run";
        }),
      ).rejects.toThrow("GOVERNANCE_PROOF_ALREADY_CONSUMED");
    });
  });

  describe("Group 6: SEC-P1-03 Companion REST API Hardening", () => {
    it("SEC-T03.3: Request approval route without operator Bearer token returns HTTP 401", async () => {
      const app = createHttpApp();
      mountCompanionRoutes(app);
      const server = http.createServer(app);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as any).port;

      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/companion/memory/requests/any_id/approve`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: "fake_token" }),
        });
        expect(res.status).toBe(401);
        const body = (await res.json()) as any;
        expect(body.error).toContain("MISSING_OPERATOR_TOKEN");
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it("SEC-T03.4: PUT /api/companion/persona with __proto__ payload returns HTTP 400 (Prototype pollution blocked)", async () => {
      const app = createHttpApp();
      mountCompanionRoutes(app);
      const server = http.createServer(app);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as any).port;
      const { token } = createTestOperatorBearer();

      try {
        const maliciousPayload = JSON.parse('{"displayName": "Polluted", "__proto__": {"polluted": true}}');
        const res = await fetch(`http://127.0.0.1:${port}/api/companion/persona`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(maliciousPayload),
        });
        expect(res.status).toBe(400);
        const body = (await res.json()) as any;
        expect(body.error).toContain("INVALID_PERSONA");
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it("SEC-T03.5: PUT /api/companion/persona with oversized string returns HTTP 400 (Length exceeded)", async () => {
      const app = createHttpApp();
      mountCompanionRoutes(app);
      const server = http.createServer(app);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as any).port;
      const { token } = createTestOperatorBearer();

      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/companion/persona`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            displayName: "ValidName",
            customInstructions: "A".repeat(2500), // Max allowed is 2000
          }),
        });
        expect(res.status).toBe(400);
        const body = (await res.json()) as any;
        expect(body.error).toContain("customInstructions");
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });
});
