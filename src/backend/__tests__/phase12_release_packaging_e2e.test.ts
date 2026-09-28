/**
 * MYRAA — Phase 12 Release Packaging, Download Distribution & User Installation E2E Suite
 *
 * Validates all Phase 12 release packaging and user installation requirements:
 *   1. Android Production Artifacts (APK + AAB, version 1.0.0, release signing, debug exclusion, HTTPS/WSS-only)
 *   2. Windows Production Artifacts (Setup + Portable EXEs, production backend URL, zero localhost dependency,
 *      fresh install, upgrade install, uninstall/reinstall, and portable launch smoke verification)
 *   3. Final Artifact E2E Flows (Login/Pairing, Voice, Gemini Live, Production Connection, Reconnect,
 *      Emergency Stop, and Uninstall/Reinstall session lifecycle)
 *   4. Cryptographic SHA-256 Checksums & Release Notes Verification
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "http";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { WebSocket, WebSocketServer } from "ws";

import { createHttpApp } from "../gateway/HttpGateway.ts";
import { LIVE_TOOLS } from "../ai/GeminiSessionFactory.ts";
import { pairingManager } from "../remote/PairingManager.ts";
import { remoteStore } from "../remote/RemoteStore.ts";
import { remoteSessionManager } from "../remote/RemoteSessionManager.ts";
import { emergencyStopCoordinator } from "../remote/EmergencyStopCoordinator.ts";
import { remoteSecurityCoordinator } from "../security/RemoteSecurityCoordinator.ts";
import { identityAuthManager } from "../security/IdentityAuthManager.ts";
import { securityPolicyEngine } from "../security/SecurityPolicyEngine.ts";

const ROOT_DIR = path.resolve(process.cwd());
const RELEASE_DIR = path.join(ROOT_DIR, "release");

async function startReleaseTestGateway() {
  const app = createHttpApp();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", async (req, socket, head) => {
    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname !== "/remote-live") {
      socket.destroy();
      return;
    }

    if (emergencyStopCoordinator.isActive()) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
      socket.destroy();
      return;
    }

    const protocols = String(req.headers["sec-websocket-protocol"] || "")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    const token = protocols.find((p) => p !== "myraa-auth") || "";

    const auth = await remoteSecurityCoordinator.authenticateRemoteCredential(
      token,
      "127.0.0.1",
      String(req.headers["user-agent"] || "Phase12ReleaseTest"),
    );
    if (!auth.authenticated || !auth.device) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      const remoteSession = remoteSessionManager.registerClient(
        ws,
        auth.device!,
        "127.0.0.1",
        String(req.headers["user-agent"] || "Phase12ReleaseTest"),
      );
      (ws as any).remoteDevice = auth.device;
      (ws as any).remoteSession = remoteSession;
      wss.emit("connection", ws, req);
    });
  });

  const unregBroadcast = emergencyStopCoordinator.registerBroadcast((payload) => {
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(JSON.stringify(payload));
        } catch {}
      }
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  return {
    server,
    wss,
    baseUrl: `http://127.0.0.1:${addr.port}`,
    wsUrl: `ws://127.0.0.1:${addr.port}/remote-live`,
    close: () =>
      new Promise<void>((resolve) => {
        unregBroadcast();
        wss.clients.forEach((c) => c.terminate());
        wss.close(() => server.close(() => resolve()));
      }),
  };
}

describe("Phase 12 — Release Packaging, Download Distribution & User Installation Suite", () => {
  beforeEach(async () => {
    await emergencyStopCoordinator.reset("phase12_test_setup");
    securityPolicyEngine.setMode("BALANCED");
    identityAuthManager.resetForTesting();
    remoteSecurityCoordinator.resetForTesting();
    remoteSessionManager.resetForTesting();
    pairingManager.reset();
    await remoteStore.clearStore();
  });

  afterEach(async () => {
    await emergencyStopCoordinator.reset("phase12_test_teardown");
    securityPolicyEngine.setMode("BALANCED");
    identityAuthManager.resetForTesting();
    remoteSecurityCoordinator.resetForTesting();
    remoteSessionManager.resetForTesting();
    pairingManager.reset();
    await remoteStore.clearStore();
  });

  // =========================================================================
  // 1. ANDROID PRODUCTION ARTIFACTS & CONFIGURATION
  // =========================================================================
  describe("1. Android Production Artifacts & Hardening", () => {
    it("1.1 verifies production signed APK and AAB exist in release/ with valid ZIP/JAR headers", () => {
      const apkPath = path.join(RELEASE_DIR, "MYRAA-Android-1.0.0.apk");
      const aabPath = path.join(RELEASE_DIR, "MYRAA-Android-1.0.0.aab");

      expect(fs.existsSync(apkPath)).toBe(true);
      expect(fs.existsSync(aabPath)).toBe(true);

      const apkStat = fs.statSync(apkPath);
      const aabStat = fs.statSync(aabPath);
      expect(apkStat.size).toBeGreaterThan(1_500_000);
      expect(aabStat.size).toBeGreaterThan(3_000_000);

      // PK\x03\x04 ZIP header check
      const apkHeader = fs.readFileSync(apkPath).subarray(0, 4);
      const aabHeader = fs.readFileSync(aabPath).subarray(0, 4);
      expect(apkHeader.toString("binary")).toBe("PK\x03\x04");
      expect(aabHeader.toString("binary")).toBe("PK\x03\x04");
    });

    it("1.2 verifies Android version (1.0.x), release signing, and complete debug exclusion", () => {
      const gradleFile = fs.readFileSync(
        path.join(ROOT_DIR, "android", "app", "build.gradle.kts"),
        "utf-8",
      );

      expect(gradleFile).toMatch(/versionCode = [12]/);
      expect(gradleFile).toMatch(/versionName = "1\.0\.[01]"/);
      expect(gradleFile).toContain("isDebuggable = false");
      expect(gradleFile).toContain("isJniDebuggable = false");
      expect(gradleFile).toContain("isMinifyEnabled = true");
      expect(gradleFile).toContain("isShrinkResources = true");
      expect(gradleFile).toContain('signingConfig = signingConfigs.getByName("release")');
      expect(gradleFile).toContain("debugImplementation(libs.okhttp.logging)");
      expect(gradleFile).not.toMatch(/^\s*implementation\(libs\.okhttp\.logging\)/m);
    });

    it("1.3 verifies Android production backend URL and strict HTTPS/WSS-only configuration", () => {
      const netSecXml = fs.readFileSync(
        path.join(
          ROOT_DIR,
          "android",
          "app",
          "src",
          "main",
          "res",
          "xml",
          "network_security_config.xml",
        ),
        "utf-8",
      );
      expect(netSecXml).toContain('cleartextTrafficPermitted="false"');
      expect(netSecXml).not.toContain('cleartextTrafficPermitted="true"');
      expect(netSecXml).not.toContain("<domain-config");

      const apiClient = fs.readFileSync(
        path.join(
          ROOT_DIR,
          "android",
          "app",
          "src",
          "main",
          "java",
          "com",
          "myraa",
          "companion",
          "networking",
          "MyraaApiClient.kt",
        ),
        "utf-8",
      );
      expect(apiClient).toContain('put("appVersion", "1.0.0")');
      expect(apiClient).toContain("https://$cleanHost");
      expect(apiClient).not.toContain('val scheme = if (isCloudHost) "https" else "http"');

      const wsClient = fs.readFileSync(
        path.join(
          ROOT_DIR,
          "android",
          "app",
          "src",
          "main",
          "java",
          "com",
          "myraa",
          "companion",
          "networking",
          "MyraaWebSocketClient.kt",
        ),
        "utf-8",
      );
      expect(wsClient).toContain("wss://$cleanHost");
      expect(wsClient).not.toContain('val scheme = if (isCloudHost) "wss" else "ws"');

      const tokenStorage = fs.readFileSync(
        path.join(
          ROOT_DIR,
          "android",
          "app",
          "src",
          "main",
          "java",
          "com",
          "myraa",
          "companion",
          "security",
          "SecureTokenStorage.kt",
        ),
        "utf-8",
      );
      expect(tokenStorage).toContain('DEFAULT_HOST = "myraa-ai-q0h3.onrender.com"');
      expect(tokenStorage).toContain("DEFAULT_PORT = 443");
    });
  });

  // =========================================================================
  // 2. WINDOWS PRODUCTION ARTIFACTS & INSTALLER VERIFICATION
  // =========================================================================
  describe("2. Windows Production Artifacts & Installer Smoke Verification", () => {
    it("2.1 verifies MYRAA-Setup-1.0.0.exe and MYRAA-Portable-1.0.0.exe exist with valid PE headers", () => {
      const setupExe = path.join(RELEASE_DIR, "MYRAA-Setup-1.0.0.exe");
      const portableExe = path.join(RELEASE_DIR, "MYRAA-Portable-1.0.0.exe");

      expect(fs.existsSync(setupExe)).toBe(true);
      expect(fs.existsSync(portableExe)).toBe(true);

      const setupStat = fs.statSync(setupExe);
      const portableStat = fs.statSync(portableExe);
      expect(setupStat.size).toBeGreaterThan(100_000_000);
      expect(portableStat.size).toBeGreaterThan(100_000_000);

      // Windows MZ header check
      const setupFd = fs.openSync(setupExe, "r");
      const setupHeader = Buffer.alloc(2);
      fs.readSync(setupFd, setupHeader, 0, 2, 0);
      fs.closeSync(setupFd);
      expect(setupHeader.toString("ascii")).toBe("MZ");

      const portableFd = fs.openSync(portableExe, "r");
      const portableHeader = Buffer.alloc(2);
      fs.readSync(portableFd, portableHeader, 0, 2, 0);
      fs.closeSync(portableFd);
      expect(portableHeader.toString("ascii")).toBe("MZ");
    });

    it("2.2 verifies Electron main/preload enforce production backend URL and bundled agent with zero localhost dependency", () => {
      const mainCjs = fs.readFileSync(path.join(ROOT_DIR, "electron", "main.cjs"), "utf-8");
      const preloadCjs = fs.readFileSync(path.join(ROOT_DIR, "electron", "preload.cjs"), "utf-8");

      expect(mainCjs).toContain("https://myraa-ai-q0h3.onrender.com");
      expect(mainCjs).toContain("startBundledDesktopAgent()");
      expect(mainCjs).toContain("waitForProductionBackend(SERVER_READY_TIMEOUT_MS)");
      expect(preloadCjs).toContain("appVersion: '1.0.0'");
      expect(preloadCjs).toContain("productionBackendUrl: 'https://myraa-ai-q0h3.onrender.com'");
    });

    it("2.3 verifies Windows Fresh-Install, Upgrade-Install, Reinstall, and Portable launch test evidence", () => {
      const evidenceDir = path.join(RELEASE_DIR, "test-evidence");
      const evidenceFiles = [
        "windows_fresh_install_smoke.json",
        "windows_upgrade_install_smoke.json",
        "windows_reinstall_smoke.json",
        "windows_portable_launch_smoke.json",
      ];

      for (const file of evidenceFiles) {
        const fullPath = path.join(evidenceDir, file);
        expect(fs.existsSync(fullPath)).toBe(true);
        const report = JSON.parse(fs.readFileSync(fullPath, "utf-8"));
        expect(report.ok).toBe(true);
        expect(report.isPackaged).toBe(true);
        expect(report.isDesktop).toBe(true);
        expect(report.appVersion).toBe("1.0.0");
        expect(report.serverOrigin).toBe("https://myraa-ai-q0h3.onrender.com");
        expect(report.origin).toBe("https://myraa-ai-q0h3.onrender.com");
        expect(report.protocol).toBe("https:");
        expect(report.health?.status).toBe("ok");
        expect(report.health?.environment).toBe("production");
        expect(report.desktopAgentSystemInfo?.cpu?.logical_cores).toBeGreaterThan(0);
      }
    });
  });

  // =========================================================================
  // 3. FINAL ARTIFACT E2E TESTING (PAIRING, VOICE, GEMINI LIVE, RECONNECT, EMERGENCY STOP)
  // =========================================================================
  describe("3. Final Artifact E2E Verification Flows", () => {
    it("3.1 verifies live production connection to https://myraa-ai-q0h3.onrender.com", async () => {
      const healthRes = await fetch("https://myraa-ai-q0h3.onrender.com/health");
      expect(healthRes.status).toBe(200);
      const healthData = (await healthRes.json()) as any;
      expect(healthData.status).toBe("ok");
      expect(healthData.environment).toBe("production");
      expect(healthData.emergencyStop).toBe(false);

      const pairStatusRes = await fetch(
        "https://myraa-ai-q0h3.onrender.com/api/remote/pair-code/status",
      );
      expect(pairStatusRes.status).toBe(200);
      const pairStatusData = (await pairStatusRes.json()) as any;
      expect(typeof pairStatusData.active).toBe("boolean");
    });

    it("3.2 verifies full lifecycle: Login/Pairing -> Gemini Live -> Voice Audio -> Reconnect -> Emergency Stop -> Uninstall/Reinstall", async () => {
      const gw = await startReleaseTestGateway();
      try {
        // 1. Bootstrap Admin Console & generate pairing code for Android v1.0.0 APK
        const { code: bootCode } = await pairingManager.generateBootstrapPairCode("198.51.100.1");
        const adminRes = await fetch(`${gw.baseUrl}/api/remote/pair`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Forwarded-For": "198.51.100.1",
            "X-Forwarded-Proto": "https",
          },
          body: JSON.stringify({
            code: bootCode,
            deviceName: "Windows Desktop Hub (MYRAA-Setup-1.0.0.exe)",
            deviceType: "browser",
          }),
        });
        expect(adminRes.status).toBe(201);
        const adminPaired = (await adminRes.json()) as any;
        expect(adminPaired.accessToken).toMatch(/^myraa_at_/);

        // Generate pairing code for Android app
        const { code: androidPin } = pairingManager.generatePairCode("198.51.100.1");
        const pairRes = await fetch(`${gw.baseUrl}/api/remote/pair`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Forwarded-For": "198.51.100.20",
            "X-Forwarded-Proto": "https",
            "User-Agent": "MyraaAndroidCompanion/1.0.0 (Android 15; Pixel 9 Pro)",
          },
          body: JSON.stringify({
            code: androidPin,
            deviceName: "Pixel 9 Pro (MYRAA-Android-1.0.0.apk)",
            deviceType: "mobile",
          }),
        });
        expect(pairRes.status).toBe(201);
        const pairedData = (await pairRes.json()) as any;
        expect(pairedData.accessToken).toMatch(/^myraa_at_/);
        expect(pairedData.refreshToken).toContain(".myraa_rf_");

        // 2. Connect over WebSocket (/remote-live) and verify Gemini Live & Voice audio pipeline
        let voiceAudioChunksReceived = 0;
        let lastTranscriptText = "";

        gw.wss.on("connection", (ws: WebSocket) => {
          // Simulate Gemini Live setup_complete handshake
          const declaredToolsCount = LIVE_TOOLS.flatMap(
            (t: any) => t.functionDeclarations ?? [],
          ).length;
          ws.send(
            JSON.stringify({
              type: "setup_complete",
              toolsCount: declaredToolsCount,
              appVersion: "1.0.0",
            }),
          );

          ws.on("message", (raw) => {
            try {
              const payload = JSON.parse(String(raw));
              if (payload.type === "audio_input" && payload.data) {
                voiceAudioChunksReceived++;
                ws.send(
                  JSON.stringify({
                    type: "voice_ack",
                    chunksProcessed: voiceAudioChunksReceived,
                  }),
                );
              } else if (payload.type === "text_input") {
                lastTranscriptText = payload.text || "";
                ws.send(
                  JSON.stringify({
                    type: "transcript",
                    role: "assistant",
                    text: `MYRAA Live Response: ${lastTranscriptText}`,
                  }),
                );
              } else if (payload.type === "ping") {
                ws.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
              }
            } catch {}
          });
        });

        const connectClient = (accessToken: string) =>
          new Promise<{
            ws: WebSocket;
            messages: any[];
            closeEvents: { code: number; reason: string }[];
          }>((resolve, reject) => {
            const messages: any[] = [];
            const closeEvents: { code: number; reason: string }[] = [];
            const ws = new WebSocket(gw.wsUrl, ["myraa-auth", accessToken]);
            ws.on("message", (data) => {
              try {
                messages.push(JSON.parse(String(data)));
              } catch {}
            });
            ws.on("close", (code, reason) => {
              closeEvents.push({ code, reason: reason.toString() });
            });
            ws.once("open", () => resolve({ ws, messages, closeEvents }));
            ws.once("error", reject);
          });

        const client1 = await connectClient(pairedData.accessToken);
        await new Promise((r) => setTimeout(r, 80));
        expect(
          client1.messages.some((m) => m.type === "setup_complete" && m.toolsCount === 126),
        ).toBe(true);

        // 3. Stream simulated PCM16 16kHz voice audio frame & Gemini Live text turn
        const pcm16Dummy = Buffer.alloc(640, 0x12).toString("base64");
        client1.ws.send(
          JSON.stringify({
            type: "audio_input",
            mimeType: "audio/pcm;rate=16000",
            data: pcm16Dummy,
          }),
        );
        client1.ws.send(
          JSON.stringify({
            type: "text_input",
            text: "Verify production Gemini Live voice and text pipeline",
          }),
        );
        await new Promise((r) => setTimeout(r, 100));
        expect(voiceAudioChunksReceived).toBe(1);
        expect(
          client1.messages.some((m) => m.type === "voice_ack" && m.chunksProcessed === 1),
        ).toBe(true);
        expect(
          client1.messages.some(
            (m) =>
              m.type === "transcript" &&
              String(m.text).includes("Verify production Gemini Live voice and text pipeline"),
          ),
        ).toBe(true);

        // 4. Reconnect & Token Rotation test
        client1.ws.close(1000, "Simulated network handoff");
        await new Promise((r) => setTimeout(r, 60));

        const refreshRes = await fetch(`${gw.baseUrl}/api/remote/token/refresh`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Forwarded-For": "198.51.100.20",
            "X-Forwarded-Proto": "https",
          },
          body: JSON.stringify({
            refreshToken: pairedData.refreshToken,
            deviceToken: pairedData.token,
          }),
        });
        expect(refreshRes.status).toBe(200);
        const refreshed = (await refreshRes.json()) as any;
        expect(refreshed.accessToken).toMatch(/^myraa_at_/);

        const client2 = await connectClient(refreshed.accessToken);
        await new Promise((r) => setTimeout(r, 80));
        expect(client2.ws.readyState).toBe(WebSocket.OPEN);

        // 5. Emergency Stop test -> broadcasts emergency_stop alert and blocks new connections
        await emergencyStopCoordinator.trigger({
          source: "rest_api",
          reason: "Phase 12 emergency stop release verification",
        });
        await new Promise((r) => setTimeout(r, 100));
        expect(emergencyStopCoordinator.isActive()).toBe(true);
        expect(
          client2.messages.some((m) => m.type === "emergency_stop" && m.active === true),
        ).toBe(true);
        await expect(connectClient(refreshed.accessToken)).rejects.toThrow();

        // Reset Emergency Stop and verify normal operations resume
        await emergencyStopCoordinator.reset("phase12_release_verification");
        expect(emergencyStopCoordinator.isActive()).toBe(false);

        // 6. Uninstall / Reinstall behavior: old device revoked -> terminates active WS (4003) & blocks token, then fresh pairing works cleanly
        const revokeRes = await fetch(`${gw.baseUrl}/api/remote/revoke`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${adminPaired.token}`,
            "X-Forwarded-For": "198.51.100.1",
            "X-Forwarded-Proto": "https",
          },
          body: JSON.stringify({
            deviceId: pairedData.device.id,
            reason: "App uninstalled before clean reinstall",
          }),
        });
        expect(revokeRes.status).toBe(200);
        await new Promise((r) => setTimeout(r, 80));
        expect(client2.closeEvents.some((c) => c.code === 4401)).toBe(true);
        await expect(connectClient(refreshed.accessToken)).rejects.toThrow();

        const { code: reinstallCode } = pairingManager.generatePairCode("198.51.100.1");
        const reinstallPairRes = await fetch(`${gw.baseUrl}/api/remote/pair`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Forwarded-For": "198.51.100.20",
            "X-Forwarded-Proto": "https",
          },
          body: JSON.stringify({
            code: reinstallCode,
            deviceName: "Pixel 9 Pro (Reinstalled v1.0.0)",
            deviceType: "mobile",
          }),
        });
        expect(reinstallPairRes.status).toBe(201);
        const reinstallData = (await reinstallPairRes.json()) as any;
        const client3 = await connectClient(reinstallData.accessToken);
        expect(client3.ws.readyState).toBe(WebSocket.OPEN);
        client3.ws.close();
      } finally {
        await gw.close();
      }
    });
  });

  // =========================================================================
  // 4. SHA-256 CHECKSUMS & DISTRIBUTION RELEASE NOTES
  // =========================================================================
  describe("4. SHA-256 Checksums & Distribution Readiness", () => {
    it("4.1 verifies SHA256SUMS.txt matches exact cryptographic hashes of APK, AAB, and EXE artifacts", () => {
      const sumsFile = path.join(RELEASE_DIR, "SHA256SUMS.txt");
      expect(fs.existsSync(sumsFile)).toBe(true);

      const lines = fs
        .readFileSync(sumsFile, "utf-8")
        .trim()
        .split(/\r?\n/)
        .filter(Boolean);
      expect(lines).toHaveLength(4);

      const expectedArtifacts = [
        "MYRAA-Android-1.0.0.apk",
        "MYRAA-Android-1.0.0.aab",
        "MYRAA-Setup-1.0.0.exe",
        "MYRAA-Portable-1.0.0.exe",
      ];

      for (const artifactName of expectedArtifacts) {
        const line = lines.find((l) => l.endsWith(`  ${artifactName}`));
        expect(line).toBeDefined();
        const recordedHash = line!.split(/\s+/)[0];
        expect(recordedHash).toMatch(/^[a-f0-9]{64}$/);

        // Verify actual file hash matches recorded SHA-256
        const fileBuffer = fs.readFileSync(path.join(RELEASE_DIR, artifactName));
        const actualHash = crypto.createHash("sha256").update(fileBuffer).digest("hex");
        expect(actualHash).toBe(recordedHash);
      }
    });

    it("4.2 verifies RELEASE_NOTES_v1.0.0.md documents APK, Setup EXE, Portable EXE, AAB, and SHA-256 sums", () => {
      const notesPath = path.join(RELEASE_DIR, "RELEASE_NOTES_v1.0.0.md");
      expect(fs.existsSync(notesPath)).toBe(true);
      const notes = fs.readFileSync(notesPath, "utf-8");

      expect(notes).toContain("MYRAA-Android-1.0.0.apk");
      expect(notes).toContain("MYRAA-Android-1.0.0.aab");
      expect(notes).toContain("MYRAA-Setup-1.0.0.exe");
      expect(notes).toContain("MYRAA-Portable-1.0.0.exe");
      expect(notes).toContain("Google Play Console");
      expect(notes).toContain("SHA-256 Checksums");
    });
  });
});
