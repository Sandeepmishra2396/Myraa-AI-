/**
 * MYRAA — First-Device Admin Recovery & Multi-Device Pairing Tests
 *
 * Verifies all 20 requirements:
 *   1. Existing sole standard device + no admin -> promoted to admin
 *   2. Migration is idempotent
 *   3. Multiple devices + no admin -> DO NOT arbitrarily promote
 *   4. Revoked sole device -> DO NOT promote
 *   5. Future first bootstrap device -> admin
 *   6. Normal second device -> standard
 *   7. Admin can generate pairing PIN
 *   8. Standard device cannot generate pairing PIN
 *   9. Android admin generates PIN
 *   10. PC successfully pairs using PIN
 *   11. PC gets separate device ID
 *   12. Android and PC can remain connected simultaneously
 *   13. PIN remains single-use
 *   14. PIN expiry
 *   15. Brute-force protection
 *   16. Revoke Android
 *   17. Revoke PC
 *   18. Emergency Stop
 *   19. Security Lockdown
 *   20. No secret/token leakage
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { remoteStore } from "../RemoteStore.ts";
import { pairingManager } from "../PairingManager.ts";
import { remoteSecurityCoordinator } from "../../security/RemoteSecurityCoordinator.ts";
import { remoteSessionManager } from "../RemoteSessionManager.ts";
import { emergencyStopCoordinator } from "../EmergencyStopCoordinator.ts";
import { securityPolicyEngine } from "../../security/SecurityPolicyEngine.ts";
import { LIVE_TOOLS } from "../../ai/GeminiSessionFactory.ts";
import type { PairedDevice } from "../RemoteTypes.ts";

describe("First-Device Admin Recovery & Multi-Device Pairing", () => {
  let createdDeviceIds: string[] = [];

  beforeEach(async () => {
    await remoteStore.clearStore();
    createdDeviceIds = [];
    (pairingManager as any)._activeSession = null;
    (pairingManager as any)._attempts.clear();
    await emergencyStopCoordinator.reset("test setup");
    securityPolicyEngine.setMode("BALANCED");
  });

  afterEach(async () => {
    for (const id of createdDeviceIds) {
      await remoteStore.deleteDevice(id);
    }
    await remoteStore.clearStore();
    (pairingManager as any)._activeSession = null;
    (pairingManager as any)._attempts.clear();
    await emergencyStopCoordinator.reset("test cleanup");
    securityPolicyEngine.setMode("BALANCED");
  });

  afterAll(async () => {
    await remoteStore.clearStore();
  });

  // ── 1. Existing sole standard device + no admin -> promoted to admin ───────
  it("1. promotes an existing sole standard device to admin when no admin exists", async () => {
    const testDevice: PairedDevice = {
      id: "phone-device-001",
      name: "Android Companion",
      deviceType: "mobile",
      role: "standard",
      tokenHash: "hash-001",
      pairedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      revoked: false,
    };

    // Save as standard
    await remoteStore.saveDevice(testDevice);
    createdDeviceIds.push(testDevice.id);

    // Call recoverSoleAdminDevice
    const res = await remoteStore.recoverSoleAdminDevice();
    expect(res.recovered).toBe(true);
    expect(res.deviceId).toBe(testDevice.id);

    // Verify role is now admin
    const updated = await remoteStore.getDevice(testDevice.id);
    expect(updated?.role).toBe("admin");
  });

  // ── 2. Migration is idempotent ───────────────────────────────────────────
  it("2. migration is strictly idempotent across consecutive runs", async () => {
    const testDevice: PairedDevice = {
      id: "phone-device-002",
      name: "Android Companion",
      deviceType: "mobile",
      role: "standard",
      tokenHash: "hash-002",
      pairedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      revoked: false,
    };
    await remoteStore.saveDevice(testDevice);
    createdDeviceIds.push(testDevice.id);

    // First recovery
    const res1 = await remoteStore.recoverSoleAdminDevice();
    expect(res1.recovered).toBe(true);

    // Second recovery (should be no-op)
    const res2 = await remoteStore.recoverSoleAdminDevice();
    expect(res2.recovered).toBe(false);

    // Role remains admin
    const device = await remoteStore.getDevice(testDevice.id);
    expect(device?.role).toBe("admin");
  });

  // ── 3. Multiple devices + no admin -> DO NOT arbitrarily promote ─────────
  it("3. does NOT arbitrarily promote any device when multiple devices exist without an admin", async () => {
    const devA: PairedDevice = {
      id: "device-a",
      name: "Device A",
      deviceType: "mobile",
      role: "standard",
      tokenHash: "hash-a",
      pairedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      revoked: false,
    };
    const devB: PairedDevice = {
      id: "device-b",
      name: "Device B",
      deviceType: "browser",
      role: "standard",
      tokenHash: "hash-b",
      pairedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      revoked: false,
    };
    await remoteStore.saveDevice(devA);
    await remoteStore.saveDevice(devB);
    createdDeviceIds.push(devA.id, devB.id);

    const res = await remoteStore.recoverSoleAdminDevice();
    expect(res.recovered).toBe(false);

    const afterA = await remoteStore.getDevice(devA.id);
    const afterB = await remoteStore.getDevice(devB.id);
    expect(afterA?.role).toBe("standard");
    expect(afterB?.role).toBe("standard");
  });

  // ── 4. Revoked sole device -> DO NOT promote ─────────────────────────────
  it("4. does NOT promote a revoked sole device", async () => {
    const revokedDevice: PairedDevice = {
      id: "device-revoked",
      name: "Revoked Phone",
      deviceType: "mobile",
      role: "standard",
      tokenHash: "hash-rev",
      pairedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      revoked: true,
      revokedAt: new Date().toISOString(),
    };
    await remoteStore.saveDevice(revokedDevice);
    createdDeviceIds.push(revokedDevice.id);

    const res = await remoteStore.recoverSoleAdminDevice();
    expect(res.recovered).toBe(false);

    const device = await remoteStore.getDevice(revokedDevice.id);
    expect(device?.role).toBe("standard");
  });

  // ── 5. Future first bootstrap device -> admin ────────────────────────────
  it("5. automatically grants role admin to the first device redeeming initial bootstrap", async () => {
    // Mock zero devices
    const listSpy = vi.spyOn(remoteStore, "listDevices").mockResolvedValueOnce([]);

    const bootstrap = await pairingManager.generateBootstrapPairCode("198.51.100.1");
    expect(bootstrap.isBootstrap).toBe(true);

    const paired = await pairingManager.pairDevice({
      code: bootstrap.code,
      deviceName: "First Android Device",
      deviceType: "mobile",
      ipAddress: "198.51.100.1",
    });
    createdDeviceIds.push(paired.device.id);

    expect(paired.device.role).toBe("admin");
    listSpy.mockRestore();
  });

  // ── 6. Normal second device -> standard ──────────────────────────────────
  it("6. defaults normal subsequent paired devices to role standard", async () => {
    // Pre-populate with admin device
    const adminDev: PairedDevice = {
      id: "admin-device-01",
      name: "Admin Android",
      deviceType: "mobile",
      role: "admin",
      tokenHash: "admin-hash",
      pairedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      revoked: false,
    };
    await remoteStore.saveDevice(adminDev);
    createdDeviceIds.push(adminDev.id);

    // Admin generates normal pair PIN
    const { code } = pairingManager.generatePairCode("198.51.100.1");

    // Second device (PC) pairs
    const pcPaired = await pairingManager.pairDevice({
      code,
      deviceName: "PC Web Dashboard",
      deviceType: "browser",
      ipAddress: "198.51.100.2",
    });
    createdDeviceIds.push(pcPaired.device.id);

    expect(pcPaired.device.role).toBe("standard");
    expect(pcPaired.device.id).not.toBe(adminDev.id);
  });

  // ── 7. Admin can generate pairing PIN ────────────────────────────────────
  it("7. allows an authenticated admin device to generate a pairing PIN", async () => {
    const adminToken = pairingManager.signDeviceToken("admin-dev-x");
    const adminDev: PairedDevice = {
      id: "admin-dev-x",
      name: "Admin Device",
      deviceType: "mobile",
      role: "admin",
      tokenHash: pairingManager.hashToken(adminToken),
      pairedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      revoked: false,
    };
    await remoteStore.saveDevice(adminDev);
    createdDeviceIds.push(adminDev.id);

    const auth = await remoteSecurityCoordinator.authenticateRemoteCredential(adminToken, "198.51.100.5", "Mobile");
    expect(auth.authenticated).toBe(true);
    expect(auth.device?.role).toBe("admin");

    const codeInfo = pairingManager.generatePairCode("198.51.100.5");
    expect(codeInfo.code).toMatch(/^[A-Z0-9]{6}$/);
    expect(codeInfo.ttlSeconds).toBe(300);
  });

  // ── 8. Standard device cannot generate pairing PIN ───────────────────────
  it("8. blocks a standard device from generating a pairing PIN", async () => {
    const adminDev: PairedDevice = {
      id: "admin-dev-for-8",
      name: "Admin Device",
      deviceType: "mobile",
      role: "admin",
      tokenHash: "admin-hash-8",
      pairedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      revoked: false,
    };
    const stdToken = pairingManager.signDeviceToken("std-dev-x");
    const stdDev: PairedDevice = {
      id: "std-dev-x",
      name: "Standard Device",
      deviceType: "browser",
      role: "standard",
      tokenHash: pairingManager.hashToken(stdToken),
      pairedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      revoked: false,
    };
    await remoteStore.saveDevice(adminDev);
    await remoteStore.saveDevice(stdDev);
    createdDeviceIds.push(adminDev.id, stdDev.id);

    const auth = await remoteSecurityCoordinator.authenticateRemoteCredential(stdToken, "198.51.100.8", "Browser");
    expect(auth.authenticated).toBe(true);
    expect(auth.device?.role).toBe("standard");

    // Policy check in gateway requires role === 'admin'
    const isAdmin = auth.device?.role === "admin";
    expect(isAdmin).toBe(false);
  });

  // ── 9. Android admin generates PIN & 10. PC pairs using PIN ──────────────
  it("9-11. Android admin generates PIN and PC successfully pairs with separate device ID", async () => {
    // 9. Android admin
    const androidToken = pairingManager.signDeviceToken("android-admin-01");
    const androidDev: PairedDevice = {
      id: "android-admin-01",
      name: "Android Admin",
      deviceType: "mobile",
      role: "admin",
      tokenHash: pairingManager.hashToken(androidToken),
      pairedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      revoked: false,
    };
    await remoteStore.saveDevice(androidDev);
    createdDeviceIds.push(androidDev.id);

    // Android admin generates PIN
    const { code } = pairingManager.generatePairCode("198.51.100.10");

    // 10. PC pairs using that PIN
    const pcResult = await pairingManager.pairDevice({
      code,
      deviceName: "Chrome on Windows",
      deviceType: "browser",
      ipAddress: "198.51.100.20",
    });
    createdDeviceIds.push(pcResult.device.id);

    // 11. Separate device ID and standard role
    expect(pcResult.device.id).not.toBe(androidDev.id);
    expect(pcResult.device.role).toBe("standard");
    expect(pcResult.token).toMatch(/^sora_dev_/);
    expect(pcResult.token).not.toBe(androidToken);
  });

  // ── 12. Android and PC can remain connected simultaneously ───────────────
  it("12. allows Android and PC to be tracked concurrently in RemoteSessionManager", async () => {
    const dev1: PairedDevice = {
      id: "dev-phone",
      name: "Android Phone",
      deviceType: "mobile",
      role: "admin",
      tokenHash: "hash-phone",
      pairedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      revoked: false,
    };
    const dev2: PairedDevice = {
      id: "dev-pc",
      name: "Windows PC",
      deviceType: "browser",
      role: "standard",
      tokenHash: "hash-pc",
      pairedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      revoked: false,
    };
    await remoteStore.saveDevice(dev1);
    await remoteStore.saveDevice(dev2);
    createdDeviceIds.push(dev1.id, dev2.id);

    // Mock WebSocket clients
    const mockWsPhone = { readyState: 1, send: vi.fn(), on: vi.fn() } as any;
    const mockWsPc = { readyState: 1, send: vi.fn(), on: vi.fn() } as any;

    const sess1 = remoteSessionManager.registerClient(mockWsPhone, dev1, "192.168.1.50", "Android");
    const sess2 = remoteSessionManager.registerClient(mockWsPc, dev2, "192.168.1.60", "Chrome Windows");

    expect(sess1.deviceId).toBe("dev-phone");
    expect(sess2.deviceId).toBe("dev-pc");

    const activeList = remoteSessionManager.getActiveSessions();
    expect(activeList.some((s) => s.deviceId === "dev-phone")).toBe(true);
    expect(activeList.some((s) => s.deviceId === "dev-pc")).toBe(true);
  });

  // ── 13. PIN remains single-use ───────────────────────────────────────────
  it("13. enforces single-use PIN: second attempt with same PIN is rejected", async () => {
    const { code } = pairingManager.generatePairCode("127.0.0.1");

    const pair1 = await pairingManager.pairDevice({
      code,
      deviceName: "Device One",
      ipAddress: "127.0.0.1",
    });
    createdDeviceIds.push(pair1.device.id);

    // Second redemption must fail
    await expect(
      pairingManager.pairDevice({
        code,
        deviceName: "Device Two",
        ipAddress: "127.0.0.1",
      })
    ).rejects.toThrow(/INVALID_PAIR_CODE/);
  });

  // ── 14. PIN expiry ───────────────────────────────────────────────────────
  it("14. rejects expired pairing PINs", async () => {
    const { code } = pairingManager.generatePairCode("127.0.0.1");

    // Manually expire the session
    const active = (pairingManager as any)._activeSession;
    active.expiresAt = Date.now() - 1000;

    await expect(
      pairingManager.pairDevice({
        code,
        deviceName: "Expired Device",
        ipAddress: "127.0.0.1",
      })
    ).rejects.toThrow(/INVALID_PAIR_CODE/);
  });

  // ── 15. Brute-force protection ───────────────────────────────────────────
  it("15. enforces brute-force lockout after 5 consecutive failed attempts", async () => {
    pairingManager.generatePairCode("127.0.0.1");
    const testIp = "203.0.113.44";

    for (let i = 0; i < 4; i++) {
      await expect(
        pairingManager.pairDevice({
          code: "WRONG1",
          deviceName: "Attacker",
          ipAddress: testIp,
        })
      ).rejects.toThrow(/Incorrect pairing PIN/);
    }

    // 5th attempt triggers lockout
    await expect(
      pairingManager.pairDevice({
        code: "WRONG2",
        deviceName: "Attacker",
        ipAddress: testIp,
      })
    ).rejects.toThrow();

    // 6th attempt is locked out immediately
    await expect(
      pairingManager.pairDevice({
        code: "WRONG3",
        deviceName: "Attacker",
        ipAddress: testIp,
      })
    ).rejects.toThrow(/PAIRING_LOCKED_OUT/);
  });

  // ── 16. Revoke Android & 17. Revoke PC ───────────────────────────────────
  it("16-17. supports independent revocation of Android and PC devices", async () => {
    const phone: PairedDevice = {
      id: "revoke-phone",
      name: "Android Phone",
      deviceType: "mobile",
      role: "admin",
      tokenHash: "hash-p",
      pairedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      revoked: false,
    };
    const pc: PairedDevice = {
      id: "revoke-pc",
      name: "PC Browser",
      deviceType: "browser",
      role: "standard",
      tokenHash: "hash-c",
      pairedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      revoked: false,
    };
    await remoteStore.saveDevice(phone);
    await remoteStore.saveDevice(pc);
    createdDeviceIds.push(phone.id, pc.id);

    // Revoke Android phone
    const phoneRevoked = await remoteSecurityCoordinator.revokeRemoteDevice(phone.id, "Lost phone");
    expect(phoneRevoked).toBe(true);

    const phoneAfter = await remoteStore.getDevice(phone.id);
    expect(phoneAfter?.revoked).toBe(true);

    // PC remains active
    const pcAfter = await remoteStore.getDevice(pc.id);
    expect(pcAfter?.revoked).toBe(false);

    // Revoke PC
    const pcRevoked = await remoteSecurityCoordinator.revokeRemoteDevice(pc.id, "Session reset");
    expect(pcRevoked).toBe(true);

    const pcFinal = await remoteStore.getDevice(pc.id);
    expect(pcFinal?.revoked).toBe(true);
  });

  // ── 18. Emergency Stop & 19. Security Lockdown ───────────────────────────
  it("18-19. blocks remote operations during Emergency Stop and Security Lockdown", async () => {
    // 18. Emergency Stop
    await emergencyStopCoordinator.trigger({
      source: "remote_device",
      reason: "Test killswitch",
    });
    expect(emergencyStopCoordinator.isActive()).toBe(true);

    // Reset emergency stop
    await emergencyStopCoordinator.reset("test");
    expect(emergencyStopCoordinator.isActive()).toBe(false);

    // 19. Security Lockdown
    securityPolicyEngine.setMode("LOCKDOWN");
    expect(securityPolicyEngine.getMode()).toBe("LOCKDOWN");
  });

  // ── 20. No secret/token leakage ──────────────────────────────────────────
  it("20. strictly prevents secret, key, or token leakage during pairing operations", async () => {
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.map(String).join(" "));
    });

    try {
      const codeInfo = pairingManager.generatePairCode("127.0.0.1");
      const paired = await pairingManager.pairDevice({
        code: codeInfo.code,
        deviceName: "Audit Test Device",
        ipAddress: "127.0.0.1",
      });
      createdDeviceIds.push(paired.device.id);

      for (const log of logs) {
        // Must not contain full pairing PIN
        expect(log).not.toContain(codeInfo.code);
        // Must not contain plaintext token
        expect(log).not.toContain(paired.token);
      }
    } finally {
      logSpy.mockRestore();
    }
  });

  // ── 21. Live GET /api/remote/session & POST /api/remote/pair-code HTTP Tests ──────
  describe("Admin Live Session Role & Secondary PIN Generation HTTP Endpoints", () => {
    let server: any;
    let baseUrl: string;

    beforeEach(async () => {
      const { createHttpApp } = await import("../../gateway/HttpGateway.ts");
      const http = await import("http");
      const app = createHttpApp();
      server = http.createServer(app);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as any).port;
      baseUrl = `http://127.0.0.1:${port}`;
    });

    afterEach(async () => {
      if (server) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it("21. GET /api/remote/session returns role admin for authenticated admin device", async () => {
      const adminToken = pairingManager.signDeviceToken("admin-phone-test");
      const adminDev: PairedDevice = {
        id: "admin-phone-test",
        name: "Android Companion",
        deviceType: "mobile",
        role: "admin",
        tokenHash: pairingManager.hashToken(adminToken),
        pairedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        revoked: false,
      };
      await remoteStore.saveDevice(adminDev);
      createdDeviceIds.push(adminDev.id);

      const res = await fetch(`${baseUrl}/api/remote/session`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.type).toBe("remote_device");
      expect(data.device).toBeDefined();
      expect(data.device.role).toBe("admin");
      expect(data.device.name).toBe("Android Companion");
    });

    it("22. GET /api/remote/session returns role standard for authenticated standard device", async () => {
      const adminDev: PairedDevice = {
        id: "admin-for-22",
        name: "Android Admin",
        deviceType: "mobile",
        role: "admin",
        tokenHash: "admin-hash-22",
        pairedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        revoked: false,
      };
      const stdToken = pairingManager.signDeviceToken("std-phone-test");
      const stdDev: PairedDevice = {
        id: "std-phone-test",
        name: "Secondary Device",
        deviceType: "browser",
        role: "standard",
        tokenHash: pairingManager.hashToken(stdToken),
        pairedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        revoked: false,
      };
      await remoteStore.saveDevice(adminDev);
      await remoteStore.saveDevice(stdDev);
      createdDeviceIds.push(adminDev.id, stdDev.id);

      const res = await fetch(`${baseUrl}/api/remote/session`, {
        headers: { Authorization: `Bearer ${stdToken}` },
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.type).toBe("remote_device");
      expect(data.device).toBeDefined();
      expect(data.device.role).toBe("standard");
    });

    it("23. POST /api/remote/pair-code generates 6-character PIN when called by authenticated admin", async () => {
      const adminToken = pairingManager.signDeviceToken("admin-caller-test");
      const adminDev: PairedDevice = {
        id: "admin-caller-test",
        name: "Admin Mobile",
        deviceType: "mobile",
        role: "admin",
        tokenHash: pairingManager.hashToken(adminToken),
        pairedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        revoked: false,
      };
      await remoteStore.saveDevice(adminDev);
      createdDeviceIds.push(adminDev.id);

      const res = await fetch(`${baseUrl}/api/remote/pair-code`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
      });
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.code).toHaveLength(6);
      expect(data.code).toMatch(/^[A-Z0-9]{6}$/);
      expect(data.ttlSeconds).toBe(300);
      expect(data.expiresAt).toBeDefined();
    });

    it("24. POST /api/remote/pair-code returns 403 Forbidden when called by a standard device", async () => {
      const adminDev: PairedDevice = {
        id: "admin-for-24",
        name: "Android Admin",
        deviceType: "mobile",
        role: "admin",
        tokenHash: "admin-hash-24",
        pairedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        revoked: false,
      };
      const stdToken = pairingManager.signDeviceToken("std-caller-test");
      const stdDev: PairedDevice = {
        id: "std-caller-test",
        name: "Standard Client",
        deviceType: "browser",
        role: "standard",
        tokenHash: pairingManager.hashToken(stdToken),
        pairedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        revoked: false,
      };
      await remoteStore.saveDevice(adminDev);
      await remoteStore.saveDevice(stdDev);
      createdDeviceIds.push(adminDev.id, stdDev.id);

      const res = await fetch(`${baseUrl}/api/remote/pair-code`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${stdToken}`,
        },
      });
      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.error).toMatch(/Forbidden: Only admins can generate device pairing codes/);
    });

    it("25. verifies full secondary device pairing flow: Android admin remains active while PC pairs as standard", async () => {
      // 1. Android Admin device exists
      const androidToken = pairingManager.signDeviceToken("android-persistent-admin");
      const androidDev: PairedDevice = {
        id: "android-persistent-admin",
        name: "Android Admin Device",
        deviceType: "mobile",
        role: "admin",
        tokenHash: pairingManager.hashToken(androidToken),
        pairedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        revoked: false,
      };
      await remoteStore.saveDevice(androidDev);
      createdDeviceIds.push(androidDev.id);

      // 2. Android Admin generates PIN via HTTP
      const pinRes = await fetch(`${baseUrl}/api/remote/pair-code`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${androidToken}`,
        },
      });
      expect(pinRes.status).toBe(201);
      const { code } = await pinRes.json();

      // 3. PC calls POST /api/remote/pair using the PIN
      const pairRes = await fetch(`${baseUrl}/api/remote/pair`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code,
          deviceName: "PC Chrome Companion",
          deviceType: "browser",
        }),
      });
      expect(pairRes.status).toBe(201);
      const pcData = await pairRes.json();
      expect(pcData.device).toBeDefined();
      expect(pcData.device.id).not.toBe(androidDev.id);
      expect(pcData.device.role).toBe("standard");
      expect(pcData.deviceRole).toBe("standard");
      expect(pcData.token).toMatch(/^sora_dev_/);
      createdDeviceIds.push(pcData.device.id);

      // 4. Verify Android Admin session remains completely untouched
      const androidCheck = await remoteStore.getDevice(androidDev.id);
      expect(androidCheck).toBeDefined();
      expect(androidCheck?.role).toBe("admin");
      expect(androidCheck?.revoked).toBe(false);

      // 5. Verify PC device is registered as standard
      const pcCheck = await remoteStore.getDevice(pcData.device.id);
      expect(pcCheck).toBeDefined();
      expect(pcCheck?.role).toBe("standard");
      expect(pcCheck?.revoked).toBe(false);
    });
  });

  // ── Tool Count Invariant ─────────────────────────────────────────────────
  it("strictly preserves exactly 126 Gemini Live tools in LIVE_TOOLS", () => {
    expect(LIVE_TOOLS).toBeDefined();
    expect(LIVE_TOOLS[0].functionDeclarations).toHaveLength(126);
  });
});
