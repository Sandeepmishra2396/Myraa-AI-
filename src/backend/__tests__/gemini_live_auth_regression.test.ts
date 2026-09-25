/**
 * MYRAA — Gemini Live Authentication & Credential Classification Regression Suite
 *
 * Covers all 11 required verification scenarios:
 *   1. Valid Gemini API key (AIza*)
 *   2. Invalid Gemini API key (placeholder / too short)
 *   3. Missing credential (source = "none")
 *   4. Expired/invalid OAuth credential (ya29.*) rejected cleanly
 *   5. AQ.* credential classification (AI_STUDIO_AUTH_KEY) & mtime priority
 *   6. Zero credential leakage in logs / error strings / SecretManager
 *   7. Gemini Live Code 1008 authentication failure classification
 *   8. Backend remains alive after Gemini auth failure
 *   9. Correct model invariant (gemini-3.1-flash-live-preview)
 *  10. Cloud authentication path remains unchanged (Render / production)
 *  11. Desktop authentication path works (packaged Electron with SORA_LAUNCHED_BY=electron)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import http from "http";
import {
  classifyCredential,
  inspectKey,
  isValidGeminiApiKey,
  resolveApiKeyWithMetadata,
  setGeminiApiKey,
  logKeyResolution,
  SECRETS_FILE,
} from "../../../server_paths.ts";
import {
  LIVE_MODEL,
  LIVE_TOOLS,
  classifyGeminiLiveCloseError,
  sanitizeGeminiErrorReason,
} from "../ai/GeminiSessionFactory.ts";
import { ConversationManager } from "../conversation/ConversationManager.ts";
import { createHttpApp } from "../gateway/HttpGateway.ts";
import { sanitizeError } from "../security/PermissionManager.ts";
import { secretManager } from "../security/SecretManager.ts";

describe("Gemini Live Authentication & Credential Handling Regression Suite", () => {
  const origEnv = {
    NODE_ENV: process.env.NODE_ENV,
    SORA_LAUNCHED_BY: process.env.SORA_LAUNCHED_BY,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
    GOOGLE_GENAI_API_KEY: process.env.GOOGLE_GENAI_API_KEY,
    API_KEY: process.env.API_KEY,
  };

  let savedSecretsFileContent: string | null = null;
  let savedSecretsMtime: Date | null = null;
  let server: http.Server | null = null;

  beforeEach(() => {
    if (fs.existsSync(SECRETS_FILE)) {
      savedSecretsFileContent = fs.readFileSync(SECRETS_FILE, "utf8");
      savedSecretsMtime = fs.statSync(SECRETS_FILE).mtime;
    } else {
      savedSecretsFileContent = null;
      savedSecretsMtime = null;
    }
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }

    // Restore environment variables
    for (const [k, v] of Object.entries(origEnv)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }

    // Restore SECRETS_FILE to its exact original state and mtime
    if (savedSecretsFileContent !== null) {
      fs.writeFileSync(SECRETS_FILE, savedSecretsFileContent, "utf8");
      if (savedSecretsMtime) {
        try {
          fs.utimesSync(SECRETS_FILE, savedSecretsMtime, savedSecretsMtime);
        } catch {
          // ignore utimes errors
        }
      }
    }
  });

  // 1. Valid Gemini API key
  it("1. classifies and accepts a valid standard Gemini API key (AIza*)", () => {
    const mockValidKey = "AIzaSyTestValidKeyForUnitTesting0000001";
    expect(classifyCredential(mockValidKey)).toBe("API_KEY");
    expect(isValidGeminiApiKey(mockValidKey)).toBe(true);

    const inspected = inspectKey(mockValidKey);
    expect(inspected.credentialClass).toBe("API_KEY");
    expect(inspected.prefix).toBe("AIza");
    expect(inspected.length).toBe(mockValidKey.length);
    expect(inspected.isPlaceholder).toBe(false);
    expect(inspected.masked).toBe("AIza...[REDACTED]");
  });

  // 2. Invalid Gemini API key
  it("2. rejects invalid, short, and placeholder Gemini API keys", () => {
    expect(classifyCredential("short_key")).toBe("INVALID");
    expect(isValidGeminiApiKey("short_key")).toBe(false);

    expect(classifyCredential("YOUR_GEMINI_API_KEY")).toBe("PLACEHOLDER");
    expect(isValidGeminiApiKey("YOUR_GEMINI_API_KEY")).toBe(false);

    expect(classifyCredential("MY_GEMINI_API_KEY")).toBe("PLACEHOLDER");
    expect(isValidGeminiApiKey("MY_GEMINI_API_KEY")).toBe(false);
  });

  // 3. Missing credential
  it("3. handles missing credential cleanly with source='none' and credentialClass='NONE'", () => {
    process.env.NODE_ENV = "production";
    delete process.env.SORA_LAUNCHED_BY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GOOGLE_GENAI_API_KEY;
    delete process.env.API_KEY;

    const resolved = resolveApiKeyWithMetadata();
    expect(resolved.key).toBeUndefined();
    expect(resolved.source).toBe("none");
    expect(resolved.isValid).toBe(false);
    expect(resolved.credentialClass).toBe("NONE");
    expect(resolved.masked).toBe("none");
  });

  // 4. Expired/invalid OAuth credential
  it("4. classifies raw OAuth access tokens (ya29.*) as OAUTH_ACCESS_TOKEN and rejects them for Gemini Live API key auth", async () => {
    const mockOAuthToken = "ya29.a0AcM612xMockOAuthAccessTokenForTestingOnly999999";
    expect(classifyCredential(mockOAuthToken)).toBe("OAUTH_ACCESS_TOKEN");
    expect(isValidGeminiApiKey(mockOAuthToken)).toBe(false);
    expect(() => setGeminiApiKey(mockOAuthToken)).toThrow(
      /Gemini API credential is invalid or expired/i,
    );

    process.env.NODE_ENV = "production";
    process.env.SORA_LAUNCHED_BY = "electron";
    const app = createHttpApp();
    server = http.createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as any).port;

    const res = await fetch(`http://127.0.0.1:${port}/api/config/apikey`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: mockOAuthToken }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error).toContain("Gemini API credential is invalid or expired");
    expect(body.error).toContain("ya29.*");
  });

  // 5. AQ.* credential classification
  it("5. classifies AQ.* credentials as AI_STUDIO_AUTH_KEY and supports them cleanly", () => {
    const mockAqKey = "AQ.MockAiStudioAuthorizationKeyForTestingOnly00000001";
    expect(classifyCredential(mockAqKey)).toBe("AI_STUDIO_AUTH_KEY");
    expect(isValidGeminiApiKey(mockAqKey)).toBe(true);

    const inspected = inspectKey(mockAqKey);
    expect(inspected.credentialClass).toBe("AI_STUDIO_AUTH_KEY");
    expect(inspected.prefix).toBe("AQ.");
    expect(inspected.length).toBe(53);
    expect(inspected.masked).toBe("AQ....[REDACTED]");
  });

  // 6. No credential leakage in logs
  it("6. never leaks raw credentials in inspectKey, logKeyResolution, sanitizeError, sanitizeGeminiErrorReason, or SecretManager", () => {
    const secretAiKey = "AIzaSySecretLeakageTestKey9876543210abcdef";
    const secretAqKey = "AQ.SecretAiStudioAuthKeyLeakageTest9876543210abcdef12";
    const secretOAuth = "ya29.a0SecretOAuthAccessTokenLeakageTest9876543210abc";

    // inspectKey must never expose suffix characters
    expect(inspectKey(secretAiKey).masked).not.toContain("abcdef");
    expect(inspectKey(secretAqKey).masked).not.toContain("abcdef12");

    // logKeyResolution must never print secret material
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      process.env.NODE_ENV = "production";
      delete process.env.SORA_LAUNCHED_BY;
      process.env.GEMINI_API_KEY = secretAqKey;
      logKeyResolution();
      const allLogs = [...logSpy.mock.calls.flat(), ...warnSpy.mock.calls.flat()].join(" ");
      expect(allLogs).not.toContain(secretAqKey);
      expect(allLogs).not.toContain("abcdef12");
      expect(allLogs).toContain("credentialClass=AI_STUDIO_AUTH_KEY");
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    }

    // sanitizeError & sanitizeGeminiErrorReason
    const rawErr = `Failed connecting with key=${secretAiKey} or ${secretAqKey} or ${secretOAuth}`;
    const s1 = sanitizeError(rawErr);
    const s2 = sanitizeGeminiErrorReason(rawErr);
    for (const s of [s1, s2]) {
      expect(s).not.toContain(secretAiKey);
      expect(s).not.toContain(secretAqKey);
      expect(s).not.toContain(secretOAuth);
    }

    // SecretManager.sanitizeModelContext
    const ctx = secretManager.sanitizeModelContext(rawErr);
    expect(ctx).not.toContain(secretAiKey);
    expect(ctx).not.toContain(secretAqKey);
    expect(ctx).not.toContain(secretOAuth);
  });

  // 7. Gemini Live authentication failure (Code 1008)
  it("7. classifies WebSocket close code 1008 invalid authentication credentials into a clear user-facing message", () => {
    process.env.NODE_ENV = "production";
    process.env.SORA_LAUNCHED_BY = "electron";

    const truncated1008Reason =
      "Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication c";
    const classified = classifyGeminiLiveCloseError(1008, truncated1008Reason);

    expect(classified.isAuthFailure).toBe(true);
    expect(classified.categorizedError).toBe(
      "Gemini API credential is invalid or expired. Please configure a valid Gemini credential in Settings.",
    );
  });

  // 8. Backend remains alive after Gemini auth failure
  it("8. keeps the backend alive and cleanly notifies the WebSocket client when Gemini authentication fails", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.SORA_LAUNCHED_BY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GOOGLE_GENAI_API_KEY;
    delete process.env.API_KEY;

    const sentMessages: any[] = [];
    let closed = false;
    const mockWs: any = {
      readyState: 1,
      OPEN: 1,
      send: (msg: string) => sentMessages.push(JSON.parse(msg)),
      close: () => {
        closed = true;
      },
      on: () => {},
    };

    const manager = new ConversationManager();

    await expect(manager.handleConnection(mockWs)).resolves.toBeUndefined();
    expect(closed).toBe(true);
    expect(sentMessages.some((m) => m.type === "error")).toBe(true);
  });

  // 9. Correct model
  it("9. uses the exact model 'gemini-3.1-flash-live-preview' and preserves all 126 tools", () => {
    expect(LIVE_MODEL).toBe("gemini-3.1-flash-live-preview");
    expect(LIVE_TOOLS[0].functionDeclarations.length).toBe(126);
  });

  // 10. Cloud authentication path remains unchanged
  it("10. preserves cloud production authentication path (uses GEMINI_API_KEY env var and blocks HTTP key mutation with 403)", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.SORA_LAUNCHED_BY;
    process.env.GEMINI_API_KEY = "AIzaSyCloudProductionEnvKeyTest000000001";

    const meta = resolveApiKeyWithMetadata();
    expect(meta.source).toBe("GEMINI_API_KEY");
    expect(meta.isValid).toBe(true);
    expect(meta.credentialClass).toBe("API_KEY");

    const app = createHttpApp();
    server = http.createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as any).port;

    const res = await fetch(`http://127.0.0.1:${port}/api/config/apikey`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "AIzaSyAttemptedOverrideKey0000000000001" }),
    });
    expect(res.status).toBe(403);
  });

  // 11. Desktop authentication path works
  it("11. supports packaged Electron desktop mode (NODE_ENV=production + SORA_LAUNCHED_BY=electron) reading secrets.json", () => {
    process.env.NODE_ENV = "production";
    process.env.SORA_LAUNCHED_BY = "electron";
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GOOGLE_GENAI_API_KEY;
    delete process.env.API_KEY;

    const mockDesktopKey = "AIzaSyPackagedDesktopModeTestKey00000001";
    fs.writeFileSync(
      SECRETS_FILE,
      JSON.stringify({ geminiApiKey: mockDesktopKey }, null, 2),
      "utf8",
    );
    // Ensure mtime is newest
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(SECRETS_FILE, future, future);

    const meta = resolveApiKeyWithMetadata();
    expect(meta.source).toBe("secrets.json");
    expect(meta.isValid).toBe(true);
    expect(meta.credentialClass).toBe("API_KEY");
    expect(meta.prefix).toBe("AIza");
  });
});
