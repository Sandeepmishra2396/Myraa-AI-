/**
 * Phase 13A-WIN.7 — Local Desktop First-Run API Key Configuration Test Suite
 *
 * Verifies the local desktop onboarding and credential storage architecture:
 *   A. DESKTOP_LOCAL resolves dynamic local backend
 *   B. CLOUD_WEB resolves Render cloud production URL
 *   C. Local API-key mutation succeeds through local backend loopback
 *   D. Cloud API-key mutation remains strictly forbidden (HTTP 403)
 *   E. Render URL is never used by local secret mutation
 *   F. Secret is stored encrypted at rest via SecureSecretStore (AES-256-GCM)
 *   G. Secret does not appear in logs or diagnostics
 *   H. Process restart cleanly restores local credential from encrypted store
 *   I. Invalid credentials (OAuth ya29, placeholders, short keys) are rejected safely
 *   J. Runtime mode cannot be spoofed from renderer/headers to bypass production security
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import http from "http";
import fs from "fs";
import path from "path";
import {
  resolveApiKeyWithMetadata,
  getGeminiApiKey,
  hasGeminiApiKey,
  setGeminiApiKey,
  clearGeminiApiKey,
  logKeyResolution,
  SECRETS_FILE,
  dataFile,
} from "../../backend/server_paths.ts";
import { secureSecretStore } from "../../backend/security/DataProtectionService.ts";
import { sanitizeError } from "../../backend/security/PermissionManager.ts";
import {
  getRuntimeMode,
  isDesktopLocal,
  isCloudWeb,
  getBackendBaseUrl,
  getCloudBackendUrl,
  CLOUD_PRODUCTION_URL,
} from "../../platform/runtimeMode.ts";
import { createHttpApp } from "../../backend/gateway/HttpGateway.ts";

describe("Phase 13A-WIN.7 — Local Desktop First-Run API Key Configuration", () => {
  const origEnv = { ...process.env };
  const origWindow = (global as any).window;
  let server: http.Server | null = null;
  let baseUrl = "";
  const TEST_VALID_KEY = "AIzaSyWin7LocalDesktopValidCredential0001";

  beforeEach(async () => {
    // Clean up test secrets before each test
    try {
      clearGeminiApiKey();
    } catch {}
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GOOGLE_GENAI_API_KEY;
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
    // Restore environment and window
    process.env = { ...origEnv };
    if (origWindow === undefined) {
      delete (global as any).window;
    } else {
      (global as any).window = origWindow;
    }
    try {
      clearGeminiApiKey();
    } catch {}
  });

  // ---------------------------------------------------------------------------
  // A. DESKTOP_LOCAL resolves local backend
  // ---------------------------------------------------------------------------
  it("A. DESKTOP_LOCAL resolves dynamic local backend URL from Electron preload", () => {
    (global as any).window = {
      electronAPI: {
        isDesktop: true,
        runtimeMode: "DESKTOP_LOCAL",
        localBackendUrl: "http://127.0.0.1:3014",
        localBackendPort: 3014,
      },
      location: {
        origin: "http://127.0.0.1:3014",
        hostname: "127.0.0.1",
      },
    };

    expect(getRuntimeMode()).toBe("DESKTOP_LOCAL");
    expect(isDesktopLocal()).toBe(true);
    expect(isCloudWeb()).toBe(false);
    expect(getBackendBaseUrl()).toBe("http://127.0.0.1:3014");
  });

  // ---------------------------------------------------------------------------
  // B. CLOUD_WEB resolves Render
  // ---------------------------------------------------------------------------
  it("B. CLOUD_WEB resolves Render production backend URL in web browser", () => {
    (global as any).window = {
      location: {
        origin: "https://myraa-ai-q0h3.onrender.com",
        hostname: "myraa-ai-q0h3.onrender.com",
      },
    };

    expect(getRuntimeMode()).toBe("CLOUD_WEB");
    expect(isCloudWeb()).toBe(true);
    expect(isDesktopLocal()).toBe(false);
    expect(getCloudBackendUrl()).toBe(CLOUD_PRODUCTION_URL);
  });

  // ---------------------------------------------------------------------------
  // C. Local API-key mutation succeeds through local backend
  // ---------------------------------------------------------------------------
  it("C. local API-key mutation succeeds through local backend loopback in Electron desktop mode", async () => {
    process.env.NODE_ENV = "production";
    process.env.SORA_LAUNCHED_BY = "electron";
    process.env.MYRAA_LOCAL_DESKTOP = "true";

    const app = createHttpApp();
    server = http.createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as any).port;
    baseUrl = `http://127.0.0.1:${port}`;

    // 1. Initial state: no key
    const configBefore = await fetch(`${baseUrl}/api/config`).then((r) => r.json());
    expect(configBefore.hasApiKey).toBe(false);

    // 2. Submit valid key
    const postRes = await fetch(`${baseUrl}/api/config/apikey`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: TEST_VALID_KEY }),
    });

    expect(postRes.status).toBe(200);
    const postData = await postRes.json();
    expect(postData.ok).toBe(true);
    expect(postData.hasApiKey).toBe(true);
    expect(postData.credentialClass).toBe("API_KEY");

    // 3. Post-mutation config check
    const configAfter = await fetch(`${baseUrl}/api/config`).then((r) => r.json());
    expect(configAfter.hasApiKey).toBe(true);
    expect(configAfter.prefix).toBe("AIza");
    expect(configAfter.masked).toBe("AIza...[REDACTED]");
    expect(configAfter.source).toBe("secure_secrets.enc");
  });

  // ---------------------------------------------------------------------------
  // D. Cloud API-key mutation remains forbidden
  // ---------------------------------------------------------------------------
  it("D. cloud API-key mutation remains strictly forbidden (HTTP 403) on Render / cloud production", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.SORA_LAUNCHED_BY;
    delete process.env.MYRAA_LOCAL_DESKTOP;
    process.env.GEMINI_API_KEY = "AIzaSyCloudProductionServerConfiguredKey01";

    const app = createHttpApp();
    server = http.createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as any).port;
    baseUrl = `http://127.0.0.1:${port}`;

    // Attempting POST
    const postRes = await fetch(`${baseUrl}/api/config/apikey`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "AIzaSyMaliciousMutationAttemptKey000" }),
    });
    expect(postRes.status).toBe(403);
    const postBody = await postRes.json();
    expect(postBody.error).toBe(
      "Forbidden: API key mutation via HTTP is disabled in production. Secrets must be configured strictly in the server environment.",
    );

    // Attempting DELETE
    const delRes = await fetch(`${baseUrl}/api/config/apikey`, { method: "DELETE" });
    expect(delRes.status).toBe(403);
    const delBody = await delRes.json();
    expect(delBody.error).toBe(
      "Forbidden: API key mutation via HTTP is disabled in production. Secrets must be configured strictly in the server environment.",
    );
  });

  // ---------------------------------------------------------------------------
  // E. Render URL is never used by local secret mutation
  // ---------------------------------------------------------------------------
  it("E. Render URL is never used by local secret mutation", () => {
    (global as any).window = {
      electronAPI: {
        isDesktop: true,
        runtimeMode: "DESKTOP_LOCAL",
        localBackendUrl: "http://127.0.0.1:3002",
        localBackendPort: 3002,
        productionBackendUrl: CLOUD_PRODUCTION_URL,
      },
      location: {
        origin: "http://127.0.0.1:3002",
      },
    };

    const targetUrl = getBackendBaseUrl();
    expect(targetUrl).toBe("http://127.0.0.1:3002");
    expect(targetUrl).not.toBe(CLOUD_PRODUCTION_URL);
    expect(targetUrl.startsWith("http://127.0.0.1")).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // F. Secret is encrypted at rest (SecureSecretStore)
  // ---------------------------------------------------------------------------
  it("F. stores credential encrypted at rest via SecureSecretStore (AES-256-GCM) with no plaintext JSON leakage", () => {
    process.env.NODE_ENV = "production";
    process.env.SORA_LAUNCHED_BY = "electron";
    process.env.MYRAA_LOCAL_DESKTOP = "true";

    const secretKey = "AQ.TestEncryptedSecretStorageKeyAtRest0000000001";
    setGeminiApiKey(secretKey);

    // Verify key is in SecureSecretStore
    const retrieved = secureSecretStore.getSecret("GEMINI_API_KEY");
    expect(retrieved).toBe(secretKey);

    // Verify encrypted file exists on disk
    const encFile = dataFile("secure_secrets.enc");
    expect(fs.existsSync(encFile)).toBe(true);
    const encContent = fs.readFileSync(encFile, "utf-8").trim();
    expect(encContent.startsWith("v1:enc:")).toBe(true);

    // Verify raw secret does NOT appear unencrypted in ciphertext file
    expect(encContent).not.toContain(secretKey);

    // Verify secrets.json does NOT contain plaintext key
    if (fs.existsSync(SECRETS_FILE)) {
      const jsonContent = fs.readFileSync(SECRETS_FILE, "utf-8");
      expect(jsonContent).not.toContain(secretKey);
    }
  });

  // ---------------------------------------------------------------------------
  // G. Secret does not appear in logs or diagnostics
  // ---------------------------------------------------------------------------
  it("G. secret never appears in logs, diagnostics, or error strings", () => {
    process.env.NODE_ENV = "production";
    process.env.SORA_LAUNCHED_BY = "electron";
    process.env.MYRAA_LOCAL_DESKTOP = "true";

    const sensitiveKey = "AIzaSySensitiveLoggingSafetyTestKey00000001";
    setGeminiApiKey(sensitiveKey);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      logKeyResolution();
      const output = [...logSpy.mock.calls.flat(), ...warnSpy.mock.calls.flat()].join(" ");
      expect(output).not.toContain(sensitiveKey);
      expect(output).toContain("prefix=AIza");
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    }

    // Verify sanitizer redacts secret in errors
    const errorMsg = `Database connection failed for key: ${sensitiveKey}`;
    const sanitized = sanitizeError(errorMsg);
    expect(sanitized).not.toContain(sensitiveKey);
    expect(sanitized).toContain("AIzaSy...[REDACTED]");
  });

  // ---------------------------------------------------------------------------
  // H. Restart restores local credential
  // ---------------------------------------------------------------------------
  it("H. restart restores local credential from encrypted persistence", () => {
    process.env.NODE_ENV = "production";
    process.env.SORA_LAUNCHED_BY = "electron";
    process.env.MYRAA_LOCAL_DESKTOP = "true";

    const originalKey = "AQ.RestartResilienceEncryptedCredentialTest0001";
    setGeminiApiKey(originalKey);

    // Simulate process termination / restart: clear in-memory env
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;

    // Fresh resolution simulates a newly started server process
    const restoredMeta = resolveApiKeyWithMetadata();
    expect(restoredMeta.isValid).toBe(true);
    expect(restoredMeta.source).toBe("secure_secrets.enc");
    expect(restoredMeta.credentialClass).toBe("AI_STUDIO_AUTH_KEY");
    expect(restoredMeta.prefix).toBe("AQ.");
    expect(hasGeminiApiKey()).toBe(true);
    expect(getGeminiApiKey()).toBe(originalKey);
  });

  // ---------------------------------------------------------------------------
  // I. Invalid credential is rejected safely
  // ---------------------------------------------------------------------------
  it("I. rejects invalid credentials (OAuth ya29, placeholders, short keys) with HTTP 400 without leaking secrets", async () => {
    process.env.NODE_ENV = "production";
    process.env.SORA_LAUNCHED_BY = "electron";
    process.env.MYRAA_LOCAL_DESKTOP = "true";

    const app = createHttpApp();
    server = http.createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as any).port;
    baseUrl = `http://127.0.0.1:${port}`;

    // 1. Raw OAuth token rejection
    const oauthRes = await fetch(`${baseUrl}/api/config/apikey`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "ya29.a0ARrdaM_InvalidOAuthToken123456789" }),
    });
    expect(oauthRes.status).toBe(400);
    const oauthBody = await oauthRes.json();
    expect(oauthBody.error).toContain("OAuth access tokens (ya29.*) are not supported");

    // 2. Template placeholder rejection
    const placeholderRes = await fetch(`${baseUrl}/api/config/apikey`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "YOUR_GEMINI_API_KEY_HERE" }),
    });
    expect(placeholderRes.status).toBe(400);

    // 3. Short key rejection
    const shortRes = await fetch(`${baseUrl}/api/config/apikey`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "AIza123" }),
    });
    expect(shortRes.status).toBe(400);
  });

  // ---------------------------------------------------------------------------
  // J. Runtime mode cannot be spoofed from renderer
  // ---------------------------------------------------------------------------
  it("J. client cannot spoof runtime mode or bypass production security via HTTP headers", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.SORA_LAUNCHED_BY;
    delete process.env.MYRAA_LOCAL_DESKTOP;

    const app = createHttpApp();
    server = http.createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as any).port;
    baseUrl = `http://127.0.0.1:${port}`;

    // Attempting to spoof desktop runtime via request headers
    const spoofedRes = await fetch(`${baseUrl}/api/config/apikey`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Runtime-Mode": "DESKTOP_LOCAL",
        "SORA_LAUNCHED_BY": "electron",
        "MYRAA_LOCAL_DESKTOP": "true",
      },
      body: JSON.stringify({ apiKey: TEST_VALID_KEY }),
    });

    expect(spoofedRes.status).toBe(403);
    const body = await spoofedRes.json();
    expect(body.error).toContain("Forbidden: API key mutation via HTTP is disabled in production.");
  });
});
