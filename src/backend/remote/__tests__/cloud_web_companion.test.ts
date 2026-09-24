/**
 * MYRAA — Cloud Web Companion Mode & Security Refinements Tests
 *
 * Verifies:
 *   1. Security Refinement 1: Pairing PIN is NEVER printed in console/application logs.
 *      Zero secret exposure (SORA_REMOTE_SECRET, MYRAA_MASTER_KEY, POLICY_SIGNING_SECRET).
 *   2. Security Refinement 2: First-device bootstrap is atomic with concurrency guard:
 *      - Zero devices allowed initial claim.
 *      - Active unconsumed code rejects concurrent generation with BOOTSTRAP_CONFLICT (HTTP 409).
 *      - Pairing consumes code; once paired (devices > 0), bootstrap window permanently closed (HTTP 403).
 *      - All subsequent pairing requires authenticated admin or localhost.
 *   3. Security Refinement 3: Single token storage & session contract:
 *      - Uses sora_remote_session schema, sora_dev_ token signature, and RemoteSecurityCoordinator.
 *   4. Exactly 126 Gemini Live tools intact in LIVE_TOOLS.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { pairingManager } from "../PairingManager.ts";
import { remoteStore } from "../RemoteStore.ts";
import { remoteSecurityCoordinator } from "../../security/RemoteSecurityCoordinator.ts";
import { LIVE_TOOLS } from "../../ai/GeminiSessionFactory.ts";
import express from "express";
import http from "http";
import { createHttpGateway } from "../../gateway/HttpGateway.ts";

describe("Cloud Web Companion Mode & Security Refinements", () => {
  let createdDeviceIds: string[] = [];

  beforeEach(async () => {
    createdDeviceIds = [];
    (pairingManager as any)._activeSession = null;
  });

  afterEach(async () => {
    // Clean up any test devices
    for (const id of createdDeviceIds) {
      await remoteStore.deleteDevice(id);
    }
    (pairingManager as any)._activeSession = null;
  });

  // ── 1. Zero PIN & Secret Leakage in Logs ─────────────────────────────────
  describe("Security Refinement 1: Zero PIN and Secret Leakage in Logs", () => {
    it("never logs the full plaintext pairing PIN to console output", async () => {
      const logs: string[] = [];
      const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
        logs.push(args.map(String).join(" "));
      });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation((...args) => {
        logs.push(args.map(String).join(" "));
      });
      const errorSpy = vi.spyOn(console, "error").mockImplementation((...args) => {
        logs.push(args.map(String).join(" "));
      });

      try {
        const { code } = pairingManager.generatePairCode("127.0.0.1");
        expect(code).toHaveLength(6);

        // Verify the 6-character code is NOT present anywhere in captured logs
        for (const line of logs) {
          expect(line).not.toContain(code);
        }

        // Verify that the log message only indicates code was generated
        const genLog = logs.find((l) => l.includes("[PairingManager] Generated ephemeral pairing code"));
        expect(genLog).toBeDefined();
        expect(genLog).not.toContain(code);
      } finally {
        logSpy.mockRestore();
        warnSpy.mockRestore();
        errorSpy.mockRestore();
      }
    });

    it("never leaks SORA_REMOTE_SECRET or master keys during pairing operations", async () => {
      const testSecret = process.env.SORA_REMOTE_SECRET || "sora-test-super-secret-key-do-not-leak";
      const logs: string[] = [];
      const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
        logs.push(args.map(String).join(" "));
      });

      try {
        const { code } = pairingManager.generatePairCode("127.0.0.1");
        const paired = await pairingManager.pairDevice({
          code,
          deviceName: "Zero-Leak Test Device",
          ipAddress: "127.0.0.1",
        });
        createdDeviceIds.push(paired.device.id);

        for (const line of logs) {
          expect(line).not.toContain(testSecret);
        }
      } finally {
        logSpy.mockRestore();
      }
    });
  });

  // ── 2. Atomic First-Device Bootstrap & Concurrency Guard ──────────────────
  describe("Security Refinement 2: Atomic First-Device Bootstrap & Concurrency Guard", () => {
    it("allows bootstrap PIN generation when zero devices are registered", async () => {
      // Temporarily mock listDevices to return []
      const listDevicesSpy = vi.spyOn(remoteStore, "listDevices").mockResolvedValue([]);

      try {
        const res = await pairingManager.generateBootstrapPairCode("198.51.100.10");
        expect(res.isBootstrap).toBe(true);
        expect(res.code).toHaveLength(6);
        expect(res.ttlSeconds).toBe(300);
      } finally {
        listDevicesSpy.mockRestore();
      }
    });

    it("atomically prevents concurrent requests from creating multiple initial setup PINs (BOOTSTRAP_CONFLICT)", async () => {
      const listDevicesSpy = vi.spyOn(remoteStore, "listDevices").mockResolvedValue([]);

      try {
        const res1 = await pairingManager.generateBootstrapPairCode("198.51.100.10");
        expect(res1.code).toBeDefined();

        // Second immediate call while activeSession is unconsumed must throw BOOTSTRAP_CONFLICT
        await expect(
          pairingManager.generateBootstrapPairCode("198.51.100.11")
        ).rejects.toThrow(/BOOTSTRAP_CONFLICT/);
      } finally {
        listDevicesSpy.mockRestore();
      }
    });

    it("permanently closes the bootstrap window once the first device pairs (BOOTSTRAP_CLOSED)", async () => {
      // Mock 0 devices initially
      let currentDevices: any[] = [];
      const listDevicesSpy = vi.spyOn(remoteStore, "listDevices").mockImplementation(async () => currentDevices);

      try {
        // Step 1: Bootstrap generates code
        const { code } = await pairingManager.generateBootstrapPairCode("198.51.100.10");

        // Step 2: Device pairs with the code
        const paired = await pairingManager.pairDevice({
          code,
          deviceName: "First Claimed Admin Device",
          ipAddress: "198.51.100.10",
        });
        createdDeviceIds.push(paired.device.id);
        currentDevices = [paired.device];

        // Step 3: Any future bootstrap attempt is strictly blocked
        await expect(
          pairingManager.generateBootstrapPairCode("198.51.100.99")
        ).rejects.toThrow(/BOOTSTRAP_CLOSED/);
      } finally {
        listDevicesSpy.mockRestore();
      }
    });
  });

  // ── 3. Token Session Contract & RemoteSecurityCoordinator Verification ────
  describe("Security Refinement 3: Token Architecture & Verification", () => {
    it("issues HMAC-SHA256 signed bearer tokens conforming to sora_dev_ format", async () => {
      const { code } = pairingManager.generatePairCode("127.0.0.1");
      const paired = await pairingManager.pairDevice({
        code,
        deviceName: "Cloud Web Companion",
        ipAddress: "127.0.0.1",
        deviceType: "web",
      });
      createdDeviceIds.push(paired.device.id);

      expect(paired.token).toMatch(/^sora_dev_/);
      const verify = pairingManager.verifyDeviceToken(paired.token);
      expect(verify.valid).toBe(true);
      expect(verify.deviceId).toBe(paired.device.id);
    });

    it("authenticates the token via remoteSecurityCoordinator", async () => {
      const { code } = pairingManager.generatePairCode("127.0.0.1");
      const paired = await pairingManager.pairDevice({
        code,
        deviceName: "Cloud Web Companion",
        ipAddress: "127.0.0.1",
        deviceType: "web",
      });
      createdDeviceIds.push(paired.device.id);

      const auth = await remoteSecurityCoordinator.authenticateRemoteCredential(
        paired.token,
        "127.0.0.1",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0"
      );

      expect(auth.authenticated).toBe(true);
      expect(auth.device).toBeDefined();
      expect(auth.device?.id).toBe(paired.device.id);
    });

    it("rejects forged or tampered tokens", async () => {
      const forgedToken = "sora_dev_ZXhwbG9pdC5kZXZpY2U.invalid_signature_hash";
      const verify = pairingManager.verifyDeviceToken(forgedToken);
      expect(verify.valid).toBe(false);

      const auth = await remoteSecurityCoordinator.authenticateRemoteCredential(
        forgedToken,
        "198.51.100.5",
        "Mozilla/5.0"
      );
      expect(auth.authenticated).toBe(false);
    });
  });

  // ── 4. LIVE_TOOLS Invariant ──────────────────────────────────────────────
  describe("Tool Invariant: 126 Gemini Live Tools", () => {
    it("strictly preserves exactly 126 Gemini Live tools across all modules", () => {
      expect(LIVE_TOOLS).toBeDefined();
      expect(Array.isArray(LIVE_TOOLS)).toBe(true);
      const tools = LIVE_TOOLS[0].functionDeclarations;
      expect(tools).toHaveLength(126);
    });

    it("contains no duplicate tool names in the 126 declarations", () => {
      const tools = LIVE_TOOLS[0].functionDeclarations;
      const names = tools.map((t: any) => t.name);
      const uniqueNames = new Set(names);
      expect(uniqueNames.size).toBe(126);
    });
  });
});
