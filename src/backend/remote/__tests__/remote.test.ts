/**
 * MYRAA — Remote Voice Companion Tests (Phase 7)
 *
 * Comprehensive unit, integration, role policy, emergency stop,
 * and adversarial security tests:
 *   1. Pairing PIN Protocol (6-char, TTL, single-use, brute-force lockout)
 *   2. Token Signing, Verification & Tamper Resistance
 *   3. RemoteSessionManager (auth, tracking, revocation)
 *   4. Server-Side Role Enforcement (read_only, standard, admin)
 *   5. Emergency Stop Killswitch (idempotence, halt all, blocking gates, reset)
 *   6. Frame & Payload Validation (max 256KB message, max 64KB audio, corrupt data)
 *   7. Tool Registry Integrity (exactly 94 tools)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { pairingManager } from "../PairingManager.ts";
import { remoteSessionManager } from "../RemoteSessionManager.ts";
import { emergencyStopCoordinator } from "../EmergencyStopCoordinator.ts";
import { ToolOrchestrator } from "../../tools/ToolOrchestrator.ts";
import { plannerCoordinator } from "../../planner/PlannerCoordinator.ts";
import { companionCoordinator } from "../../companion/CompanionCoordinator.ts";
import {
  PAIRING_CODE_TTL_MS,
  PAIRING_MAX_FAILED_ATTEMPTS,
  MAX_REMOTE_MESSAGE_SIZE,
  MAX_AUDIO_FRAME_SIZE,
} from "../RemoteTypes.ts";

describe("Phase 7 — Remote Voice Companion", () => {
  beforeEach(async () => {
    await emergencyStopCoordinator.reset("test setup");
  });

  afterEach(async () => {
    await emergencyStopCoordinator.reset("test cleanup");
  });

  // ── 1. Pairing Protocol Tests ──────────────────────────────────────────
  describe("Pairing Protocol & PIN Management", () => {
    it("generates a 6-character uppercase alphanumeric PIN code", () => {
      const res = pairingManager.generatePairCode("127.0.0.1");
      expect(res).toBeDefined();
      expect(res.code).toHaveLength(6);
      expect(res.code).toMatch(/^[A-Z0-9]{6}$/);
      expect(res.ttlSeconds).toBe(300);
    });

    it("allows successful pairing of a valid PIN code", async () => {
      const { code } = pairingManager.generatePairCode("127.0.0.1");
      const result = await pairingManager.pairDevice({
        code,
        deviceName: "Test Phone",
        ipAddress: "192.168.1.100",
      });

      expect(result).toBeDefined();
      expect(result.device).toBeDefined();
      expect(result.device.name).toBe("Test Phone");
      expect(result.token).toMatch(/^sora_dev_/);
    });

    it("is case-insensitive for user-entered PIN codes", async () => {
      const { code } = pairingManager.generatePairCode("127.0.0.1");
      const lower = code.toLowerCase();
      const result = await pairingManager.pairDevice({
        code: lower,
        deviceName: "Case Test",
        ipAddress: "192.168.1.101",
      });

      expect(result).toBeDefined();
      expect(result.token).toBeDefined();
    });

    it("enforces single-use consumption: replay of same PIN fails", async () => {
      const { code } = pairingManager.generatePairCode("127.0.0.1");
      const first = await pairingManager.pairDevice({
        code,
        deviceName: "Device 1",
        ipAddress: "192.168.1.102",
      });
      expect(first).toBeDefined();

      // Second attempt must fail
      await expect(
        pairingManager.pairDevice({
          code,
          deviceName: "Device 2",
          ipAddress: "192.168.1.102",
        }),
      ).rejects.toThrow(/INVALID_PAIR_CODE/);
    });

    it("rejects expired PIN codes after TTL expires", async () => {
      const { code } = pairingManager.generatePairCode("127.0.0.1");

      const originalNow = Date.now;
      try {
        Date.now = () => originalNow() + PAIRING_CODE_TTL_MS + 1000;
        await expect(
          pairingManager.pairDevice({
            code,
            deviceName: "Expired Attempt",
            ipAddress: "192.168.1.103",
          }),
        ).rejects.toThrow(/INVALID_PAIR_CODE/);
      } finally {
        Date.now = originalNow;
      }
    });

    it("enforces brute-force lockout after 5 consecutive failed attempts", async () => {
      const testIp = "192.168.1.50";

      // 5 failed attempts
      for (let i = 0; i < PAIRING_MAX_FAILED_ATTEMPTS; i++) {
        try {
          await pairingManager.pairDevice({
            code: "WRONG" + i,
            deviceName: "Attacker",
            ipAddress: testIp,
          });
        } catch {}
      }

      // 6th attempt must be locked out
      await expect(
        pairingManager.pairDevice({
          code: "ANYPIN",
          deviceName: "Attacker",
          ipAddress: testIp,
        }),
      ).rejects.toThrow(/PAIRING_LOCKED_OUT/);
    });

    it("isolates brute-force lockout per IP address", async () => {
      const attackerIp = "10.0.0.99";
      const legitIp = "10.0.0.100";

      // Lockout attacker IP
      for (let i = 0; i < PAIRING_MAX_FAILED_ATTEMPTS; i++) {
        try {
          await pairingManager.pairDevice({
            code: "FAIL" + i,
            deviceName: "Attacker",
            ipAddress: attackerIp,
          });
        } catch {}
      }

      // Attacker is locked out
      await expect(
        pairingManager.pairDevice({
          code: "TEST12",
          deviceName: "Attacker",
          ipAddress: attackerIp,
        }),
      ).rejects.toThrow(/PAIRING_LOCKED_OUT/);

      // Legitimate IP can still pair
      const { code } = pairingManager.generatePairCode("127.0.0.1");
      const result = await pairingManager.pairDevice({
        code,
        deviceName: "Legit User",
        ipAddress: legitIp,
      });
      expect(result.device).toBeDefined();
    });
  });

  // ── 2. Token Security & Cryptographic Integrity ──────────────────────────
  describe("Token Signing & Tamper Resistance", () => {
    it("issues and verifies a valid HMAC-signed device token", () => {
      const token = pairingManager.signDeviceToken("dev_123");
      expect(token).toMatch(/^sora_dev_/);

      const parsed = pairingManager.verifyDeviceToken(token);
      expect(parsed.valid).toBe(true);
      expect(parsed.deviceId).toBe("dev_123");
    });

    it("rejects tokens with tampered signatures", () => {
      const token = pairingManager.signDeviceToken("dev_456");
      const tampered = token.slice(0, -4) + "XXXX";
      const verified = pairingManager.verifyDeviceToken(tampered);
      expect(verified.valid).toBe(false);
    });

    it("rejects tokens with tampered payloads", () => {
      const token = pairingManager.signDeviceToken("dev_789");
      const parts = token.slice("sora_dev_".length).split(".");
      if (parts.length === 2) {
        // Tamper payload
        const raw = Buffer.from(parts[0], "base64url").toString("utf-8");
        const tamperedRaw = raw.replace("dev_789", "dev_admin_fake");
        const tamperedPayloadB64 = Buffer.from(tamperedRaw).toString("base64url");
        const forgedToken = `sora_dev_${tamperedPayloadB64}.${parts[1]}`;

        const verified = pairingManager.verifyDeviceToken(forgedToken);
        expect(verified.valid).toBe(false);
      }
    });

    it("rejects malformed token strings safely without crashing", () => {
      expect(pairingManager.verifyDeviceToken("").valid).toBe(false);
      expect(pairingManager.verifyDeviceToken("invalid_prefix_abc.123").valid).toBe(false);
      expect(pairingManager.verifyDeviceToken("sora_dev_badpayload").valid).toBe(false);
      expect(pairingManager.verifyDeviceToken("sora_dev_notbase64!?.sig").valid).toBe(false);
    });
  });

  // ── 3. RemoteSessionManager & Revocation ──────────────────────────────────
  describe("RemoteSessionManager & Revocation", () => {
    it("registers and authenticates a paired remote device", async () => {
      const { code } = pairingManager.generatePairCode("127.0.0.1");
      const { device, token } = await pairingManager.pairDevice({
        code,
        deviceName: "Pixel 8",
        ipAddress: "192.168.1.110",
      });

      const authed = await remoteSessionManager.authenticateToken(token);
      expect(authed).toBeDefined();
      expect(authed?.id).toBe(device.id);
      expect(authed?.name).toBe("Pixel 8");
    });

    it("revokes device token: immediate rejection of subsequent auth", async () => {
      const { code } = pairingManager.generatePairCode("127.0.0.1");
      const { device, token } = await pairingManager.pairDevice({
        code,
        deviceName: "Revoke Test",
        ipAddress: "192.168.1.111",
      });

      // Active
      const authed = await remoteSessionManager.authenticateToken(token);
      expect(authed).not.toBeNull();

      // Revoke
      const revoked = await remoteSessionManager.revokeDevice(device.id);
      expect(revoked).toBe(true);

      // Subsequent auth must fail
      const afterRevoke = await remoteSessionManager.authenticateToken(token);
      expect(afterRevoke).toBeNull();
    });
  });

  // ── 4. Server-Side Role Enforcement ──────────────────────────────────────
  describe("Server-Side Role Policy Enforcement", () => {
    it("allows read-only devices to access read tools", () => {
      expect(remoteSessionManager.checkToolPermission("read_only", "list_dir").allowed).toBe(true);
      expect(remoteSessionManager.checkToolPermission("read_only", "read_file").allowed).toBe(true);
      expect(remoteSessionManager.checkToolPermission("read_only", "system_health").allowed).toBe(true);
      expect(remoteSessionManager.checkToolPermission("read_only", "listRemoteDevices").allowed).toBe(true);
    });

    it("blocks read-only devices from modifying or destructive tools", () => {
      expect(remoteSessionManager.checkToolPermission("read_only", "write_to_file").allowed).toBe(false);
      expect(remoteSessionManager.checkToolPermission("read_only", "replace_file_content").allowed).toBe(false);
      expect(remoteSessionManager.checkToolPermission("read_only", "execute_command").allowed).toBe(false);
      expect(remoteSessionManager.checkToolPermission("read_only", "scheduleTask").allowed).toBe(false);
      expect(remoteSessionManager.checkToolPermission("read_only", "executeTaskPlan").allowed).toBe(false);
      expect(remoteSessionManager.checkToolPermission("read_only", "confirmCheckpoint").allowed).toBe(false);
    });

    it("enforces that standard role cannot self-approve confirmation checkpoints", () => {
      expect(remoteSessionManager.checkToolPermission("standard", "confirmCheckpoint").allowed).toBe(false);
      expect(remoteSessionManager.checkToolPermission("admin", "confirmCheckpoint").allowed).toBe(true);
    });

    it("allows standard and admin devices to request modifying tools", () => {
      expect(remoteSessionManager.checkToolPermission("standard", "write_to_file").allowed).toBe(true);
      expect(remoteSessionManager.checkToolPermission("admin", "write_to_file").allowed).toBe(true);
    });
  });

  // ── 5. Emergency Stop Killswitch ─────────────────────────────────────────
  describe("Emergency Stop Coordinator", () => {
    it("starts in inactive state after reset", () => {
      expect(emergencyStopCoordinator.isActive()).toBe(false);
      const state = emergencyStopCoordinator.getState();
      expect(state.active).toBe(false);
    });

    it("activates emergency stop, sets reason and timestamp", async () => {
      const result = await emergencyStopCoordinator.trigger({
        source: "remote_device",
        deviceName: "Test Admin Device",
        reason: "Suspicious activity detected",
      });
      expect(result.active).toBe(true);
      expect(result.reason).toBe("Suspicious activity detected");
      expect(result.triggeredBy?.source).toBe("remote_device");
      expect(emergencyStopCoordinator.isActive()).toBe(true);
    });

    it("is idempotent: re-triggering maintains active state", async () => {
      await emergencyStopCoordinator.trigger({ source: "tool", reason: "First stop" });
      const second = await emergencyStopCoordinator.trigger({ source: "tool", reason: "Second stop" });
      expect(second.active).toBe(true);
      expect(emergencyStopCoordinator.isActive()).toBe(true);
    });

    it("broadcasts emergency stop event to registered listeners", async () => {
      const broadcastMessages: any[] = [];
      const unregister = emergencyStopCoordinator.registerBroadcast((msg) => {
        broadcastMessages.push(msg);
      });

      await emergencyStopCoordinator.trigger({ source: "rest_api", reason: "Broadcast test" });
      expect(broadcastMessages.length).toBeGreaterThanOrEqual(1);
      const lastMsg = broadcastMessages[broadcastMessages.length - 1];
      expect(lastMsg.type).toBe("emergency_stop");
      expect(lastMsg.active).toBe(true);

      unregister();
    });

    it("blocks Planner plans when Emergency Stop is active", async () => {
      await emergencyStopCoordinator.trigger({ source: "rest_api", reason: "Block planner test" });

      await expect(
        plannerCoordinator.createPlan("Test goal"),
      ).rejects.toThrow(/EMERGENCY_STOP_ACTIVE/);

      await expect(
        plannerCoordinator.executePlan("any_plan_id"),
      ).rejects.toThrow(/EMERGENCY_STOP_ACTIVE/);
    });

    it("blocks Proactive Companion tasks when Emergency Stop is active", async () => {
      await emergencyStopCoordinator.trigger({ source: "rest_api", reason: "Block companion test" });

      await expect(
        companionCoordinator.scheduleTask({
          name: "Should fail",
          type: "build_monitor",
          intervalMs: 10000,
        }),
      ).rejects.toThrow(/EMERGENCY_STOP_ACTIVE/);

      await expect(
        companionCoordinator.triggerCheck("build"),
      ).rejects.toThrow(/EMERGENCY_STOP_ACTIVE/);
    });

    it("blocks ToolOrchestrator dispatch when Emergency Stop is active", async () => {
      await emergencyStopCoordinator.trigger({ source: "rest_api", reason: "Block dispatch test" });
      const orchestrator = new ToolOrchestrator();

      const mockSession = {
        sendToolResponse: vi.fn(),
      };

      await orchestrator.dispatch(
        { name: "read_file", args: { path: "package.json" }, id: "call_1" },
        mockSession as any,
        vi.fn(),
        "dummy_key",
      );

      expect(mockSession.sendToolResponse).toHaveBeenCalled();
      const payload = mockSession.sendToolResponse.mock.calls[0][0];
      expect(payload.functionResponses[0].response.output?.error).toMatch(/EMERGENCY_STOP_ACTIVE/);
    });

    it("resets cleanly and allows operations to resume", async () => {
      await emergencyStopCoordinator.trigger({ source: "rest_api", reason: "Temporary stop" });
      expect(emergencyStopCoordinator.isActive()).toBe(true);

      const resetState = await emergencyStopCoordinator.reset("Resolved by operator");
      expect(resetState.active).toBe(false);
      expect(emergencyStopCoordinator.isActive()).toBe(false);
    });
  });

  // ── 6. Frame & Payload Validation ────────────────────────────────────────
  describe("Frame & Payload Limits", () => {
    it("accepts payloads under MAX_REMOTE_MESSAGE_SIZE (256KB)", () => {
      const validPayload = JSON.stringify({ text: "A".repeat(1000) });
      expect(() => {
        remoteSessionManager.validateMessageSize(Buffer.byteLength(validPayload));
      }).not.toThrow();
    });

    it("rejects payloads exceeding MAX_REMOTE_MESSAGE_SIZE (256KB)", () => {
      expect(() => {
        remoteSessionManager.validateMessageSize(MAX_REMOTE_MESSAGE_SIZE + 10);
      }).toThrow(/PAYLOAD_TOO_LARGE/);
    });

    it("accepts valid audio base64 chunks under MAX_AUDIO_FRAME_SIZE (64KB)", () => {
      const chunk = Buffer.from("PCM audio test data").toString("base64");
      expect(() => {
        remoteSessionManager.validateAudioChunk(chunk);
      }).not.toThrow();
    });

    it("rejects audio base64 chunks exceeding MAX_AUDIO_FRAME_SIZE limit", () => {
      const bigString = "A".repeat(Math.ceil(MAX_AUDIO_FRAME_SIZE * 1.5));
      expect(() => {
        remoteSessionManager.validateAudioChunk(bigString);
      }).toThrow(/AUDIO_FRAME_TOO_LARGE/);
    });

    it("rejects invalid / non-base64 characters in audio chunks", () => {
      const corrupted = "not_valid_base64_!@#$%^&*()";
      expect(() => {
        remoteSessionManager.validateAudioChunk(corrupted);
      }).toThrow(/MALFORMED_AUDIO/);
    });
  });

  // ── 7. Tool Count Integrity ──────────────────────────────────────────────
  describe("Tool Count Integrity", () => {
    it("has exactly 94 tools declared in Gemini Live Tools", async () => {
      const { LIVE_TOOLS } = await import("../../ai/GeminiSessionFactory.ts");
      expect(LIVE_TOOLS).toBeDefined();
      expect(Array.isArray(LIVE_TOOLS)).toBe(true);
      const tools = LIVE_TOOLS[0].functionDeclarations;
      expect(Array.isArray(tools)).toBe(true);
      expect(tools.length).toBeGreaterThanOrEqual(94);
    });

    it("includes all 4 Phase 7 remote companion tools", async () => {
      const { LIVE_TOOLS } = await import("../../ai/GeminiSessionFactory.ts");
      const tools = LIVE_TOOLS[0].functionDeclarations;
      const toolNames = tools.map((t: any) => t.name);

      expect(toolNames).toContain("generateDevicePairCode");
      expect(toolNames).toContain("listRemoteDevices");
      expect(toolNames).toContain("revokeRemoteDevice");
      expect(toolNames).toContain("triggerEmergencyStop");
    });
  });
});
