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
} from "../../backend/server_paths.ts";
import {
  LIVE_MODEL,
  LIVE_TOOLS,
  classifyGeminiLiveCloseError,
  sanitizeGeminiErrorReason,
} from "../../backend/ai/GeminiSessionFactory.ts";
import { ConversationManager } from "../../backend/conversation/ConversationManager.ts";
import { createHttpApp } from "../../backend/gateway/HttpGateway.ts";
import { sanitizeError } from "../../backend/security/PermissionManager.ts";
import { secretManager } from "../../backend/security/SecretManager.ts";

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
  it("9. uses the exact model 'gemini-3.1-flash-live-preview' and preserves all 129 tools", () => {
    expect(LIVE_MODEL).toBe("gemini-3.1-flash-live-preview");
    expect(LIVE_TOOLS[0].functionDeclarations.length).toBe(129);
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

// =============================================================================
// Stage 10.4.2 Closure: Local /live WebSocket Session Identity & Confirmation
// =============================================================================

describe("Stage 10.4.2 Local /live WebSocket Session Identity & Confirmation Suite", () => {
  let originalKey: string | undefined;

  beforeEach(async () => {
    originalKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = "AIzaSyTestKeyForLiveAuthSuite0000000001";
    const { localLiveSessionRegistry } = await import("../../backend/server.ts");
    localLiveSessionRegistry.resetForTesting();
    const { securityPolicyEngine } = await import("../../backend/security/SecurityPolicyEngine.ts");
    securityPolicyEngine.resetForTesting();
    securityPolicyEngine.setMode("BALANCED");
    const { emergencyStopCoordinator } = await import("../../backend/remote/EmergencyStopCoordinator.ts");
    await emergencyStopCoordinator.reset("test_setup");
  });

  afterEach(async () => {
    const { localLiveSessionRegistry } = await import("../../backend/server.ts");
    localLiveSessionRegistry.resetForTesting();
    const { securityPolicyEngine } = await import("../../backend/security/SecurityPolicyEngine.ts");
    securityPolicyEngine.resetForTesting();
    securityPolicyEngine.setMode("BALANCED");
    const { emergencyStopCoordinator } = await import("../../backend/remote/EmergencyStopCoordinator.ts");
    await emergencyStopCoordinator.reset("test_cleanup");
    if (originalKey !== undefined) process.env.GEMINI_API_KEY = originalKey;
    else delete process.env.GEMINI_API_KEY;
    vi.restoreAllMocks();
  });

  function createMockWebSocket() {
    const sentFrames: any[] = [];
    const eventHandlers: Record<string, Array<(...args: any[]) => any>> = {};
    const ws: any = {
      readyState: 1,
      remoteDevice: null,
      send: (data: string) => {
        try {
          sentFrames.push(JSON.parse(data));
        } catch {
          sentFrames.push(data);
        }
      },
      on: (event: string, cb: (...args: any[]) => any) => {
        if (!eventHandlers[event]) eventHandlers[event] = [];
        eventHandlers[event].push(cb);
      },
      close: vi.fn(() => {
        ws.readyState = 3;
        for (const h of eventHandlers["close"] || []) {
          try { h(1000, "Normal Closure"); } catch {}
        }
      }),
    };
    const dispatchMessage = async (payload: unknown) => {
      const raw = Buffer.from(JSON.stringify(payload));
      for (const h of eventHandlers["message"] || []) {
        await h(raw);
      }
    };
    const dispatchClose = () => {
      ws.readyState = 3;
      for (const h of eventHandlers["close"] || []) {
        h(1000, "Client closed");
      }
    };
    return { ws, sentFrames, dispatchMessage, dispatchClose };
  }

  // --- Local connection identity (Scenarios 1–5) ---

  it("Scenario 1: each accepted local /live socket receives a non-empty server-generated session ID", async () => {
    const { validateLocalLiveUpgrade, localLiveSessionRegistry } = await import("../../backend/server.ts");
    const { ws } = createMockWebSocket();
    const upgradeRes = validateLocalLiveUpgrade(
      { headers: { origin: "http://127.0.0.1:3000" }, socket: { remoteAddress: "127.0.0.1" } },
      { remoteAddress: "127.0.0.1" },
      "/live",
    );
    expect(upgradeRes.trusted).toBe(true);
    if (!upgradeRes.trusted) return;

    localLiveSessionRegistry.markTrustedUpgrade(ws, { ipAddress: upgradeRes.ipAddress, userAgent: upgradeRes.userAgent });
    const ctx = localLiveSessionRegistry.establishLocalSession(ws);

    expect(ctx).not.toBeNull();
    expect(ctx!.sessionId).toBeDefined();
    expect(typeof ctx!.sessionId).toBe("string");
    expect(ctx!.sessionId.startsWith("local_sess_")).toBe(true);
    expect(ctx!.sessionId.length).toBeGreaterThan(20);
    expect(ws.remoteSession).toBe(ctx);
    expect(ws.remoteSessionId).toBe(ctx!.sessionId);
    expect(ws.sessionId).toBe(ctx!.sessionId);
    expect(localLiveSessionRegistry.isActiveSession(ctx!.sessionId)).toBe(true);
  });

  it("Scenario 2: two independent socket connections receive different session IDs", async () => {
    const { localLiveSessionRegistry } = await import("../../backend/server.ts");
    const sock1 = createMockWebSocket();
    const sock2 = createMockWebSocket();

    localLiveSessionRegistry.markTrustedUpgrade(sock1.ws, { ipAddress: "127.0.0.1", userAgent: "Client-1" });
    localLiveSessionRegistry.markTrustedUpgrade(sock2.ws, { ipAddress: "127.0.0.1", userAgent: "Client-2" });

    const ctx1 = localLiveSessionRegistry.establishLocalSession(sock1.ws);
    const ctx2 = localLiveSessionRegistry.establishLocalSession(sock2.ws);

    expect(ctx1!.sessionId).not.toBe(ctx2!.sessionId);
    expect(localLiveSessionRegistry.getActiveCount()).toBe(2);
  });

  it("Scenario 3: client-supplied fake session IDs in query, headers, or socket properties are ignored and stripped", async () => {
    const { validateLocalLiveUpgrade, localLiveSessionRegistry } = await import("../../backend/server.ts");
    const { ws } = createMockWebSocket();
    ws.sessionId = "attacker_pre_injected_sessionId";
    ws.remoteSessionId = "attacker_pre_injected_remoteSessionId";
    ws.remoteSession = { sessionId: "attacker_spoofed_session", role: "admin" };

    const upgradeRes = validateLocalLiveUpgrade(
      {
        url: "/live?sessionId=evil_query_session&remoteSessionId=evil_remote_query",
        headers: {
          origin: "http://localhost:3000",
          "x-session-id": "evil_header_session",
          "x-forwarded-session": "evil_forwarded_session",
        },
        socket: { remoteAddress: "127.0.0.1" },
      },
      { remoteAddress: "127.0.0.1" },
      "/live",
    );
    expect(upgradeRes.trusted).toBe(true);
    if (!upgradeRes.trusted) return;

    localLiveSessionRegistry.markTrustedUpgrade(ws, { ipAddress: upgradeRes.ipAddress, userAgent: upgradeRes.userAgent });
    const ctx = localLiveSessionRegistry.establishLocalSession(ws);

    expect(ctx!.sessionId).not.toBe("attacker_pre_injected_sessionId");
    expect(ctx!.sessionId).not.toBe("evil_query_session");
    expect(ctx!.sessionId).not.toBe("evil_header_session");
    expect(ctx!.sessionId.startsWith("local_sess_")).toBe(true);
    expect(ws.sessionId).toBe(ctx!.sessionId);
    expect(ws.remoteSessionId).toBe(ctx!.sessionId);
    expect(ws.remoteSession.sessionId).toBe(ctx!.sessionId);
  });

  it("Scenario 4: missing or invalid server-side identity fails closed with MISSING_SESSION_CONTEXT", async () => {
    const { localLiveSessionRegistry } = await import("../../backend/server.ts");
    const { ConversationManager } = await import("../../backend/conversation/ConversationManager.ts");
    const { securityPolicyEngine } = await import("../../backend/security/SecurityPolicyEngine.ts");

    const unverified = createMockWebSocket();
    unverified.ws.remoteSessionId = "unauthorized_sid";

    const established = localLiveSessionRegistry.establishLocalSession(unverified.ws);
    expect(established).toBeNull();
    expect(unverified.ws.remoteSession).toBeUndefined();
    expect(unverified.ws.remoteSessionId).toBeUndefined();

    const mockFactory: any = { createSession: vi.fn(async () => ({ sendRealtimeInput: vi.fn(), close: vi.fn() })) };
    const cm = new ConversationManager(mockFactory);
    await cm.handleConnection(unverified.ws);

    const token = securityPolicyEngine.generateConfirmationToken(
      "trackProjectTask",
      { action: "confirm_decision", decisionId: "dec-unverified-4", projectId: "proj-4" },
      "unauthorized_sid",
    );

    unverified.sentFrames.length = 0;
    await unverified.dispatchMessage({
      type: "confirm_decision",
      decisionId: "dec-unverified-4",
      projectId: "proj-4",
      confirmationToken: token,
    });
    expect(
      unverified.sentFrames.some(
        (m) => m.type === "decision_confirmation_failed" && m.error === "MISSING_SESSION_CONTEXT",
      ),
    ).toBe(true);
  });

  it("Scenario 5: disconnect retires the old socket identity and strips session context", async () => {
    const { localLiveSessionRegistry } = await import("../../backend/server.ts");
    const sock = createMockWebSocket();
    localLiveSessionRegistry.markTrustedUpgrade(sock.ws, { ipAddress: "127.0.0.1", userAgent: "Client-5" });
    const ctx = localLiveSessionRegistry.establishLocalSession(sock.ws)!;

    expect(localLiveSessionRegistry.isActiveSession(ctx.sessionId)).toBe(true);
    expect(localLiveSessionRegistry.isRetiredSession(ctx.sessionId)).toBe(false);

    const cleaned = localLiveSessionRegistry.cleanupLocalSession(sock.ws);
    expect(cleaned).toBe(true);
    expect(localLiveSessionRegistry.isActiveSession(ctx.sessionId)).toBe(false);
    expect(localLiveSessionRegistry.isRetiredSession(ctx.sessionId)).toBe(true);
    expect(sock.ws.remoteSession).toBeUndefined();
    expect(sock.ws.remoteSessionId).toBeUndefined();
    expect(sock.ws.sessionId).toBeUndefined();
  });

  // --- Confirmation security (Scenarios 6–12) ---

  it("Scenario 6 & 7: token generated for socket A is accepted only by socket A; socket B cannot reuse it (cross-socket replay)", async () => {
    const { localLiveSessionRegistry } = await import("../../backend/server.ts");
    const { ConversationManager } = await import("../../backend/conversation/ConversationManager.ts");
    const { securityPolicyEngine } = await import("../../backend/security/SecurityPolicyEngine.ts");
    const { projectDecisionStore } = await import("../../backend/projects/ProjectDecisionStore.ts");

    const sockA = createMockWebSocket();
    const sockB = createMockWebSocket();
    localLiveSessionRegistry.markTrustedUpgrade(sockA.ws, { ipAddress: "127.0.0.1", userAgent: "Client-A" });
    localLiveSessionRegistry.markTrustedUpgrade(sockB.ws, { ipAddress: "127.0.0.1", userAgent: "Client-B" });

    const ctxA = localLiveSessionRegistry.establishLocalSession(sockA.ws)!;
    const ctxB = localLiveSessionRegistry.establishLocalSession(sockB.ws)!;

    const dec = {
      id: "dec-x-socket-6",
      projectId: "proj-x-socket",
      description: "Cross socket isolation decision",
      timestamp: new Date().toISOString(),
      type: "decision" as const,
      source: "ai_proposed" as const,
      confirmed: false,
    };
    await projectDecisionStore.saveDecision(dec);

    const tokenForA = securityPolicyEngine.generateConfirmationToken(
      "trackProjectTask",
      { action: "confirm_decision", decisionId: dec.id, projectId: dec.projectId },
      ctxA.sessionId,
    );

    const mockFactory: any = { createSession: vi.fn(async () => ({ sendRealtimeInput: vi.fn(), close: vi.fn() })) };
    const cm = new ConversationManager(mockFactory);
    await cm.handleConnection(sockA.ws);
    await cm.handleConnection(sockB.ws);

    // Socket B attempts to use Socket A's token -> MUST FAIL with SESSION_MISMATCH
    sockB.sentFrames.length = 0;
    await sockB.dispatchMessage({
      type: "confirm_decision",
      decisionId: dec.id,
      projectId: dec.projectId,
      confirmationToken: tokenForA,
    });
    expect(
      sockB.sentFrames.some(
        (m) => m.type === "decision_confirmation_failed" && String(m.error).includes("SESSION_MISMATCH"),
      ),
    ).toBe(true);

    // Socket A uses Socket A's token -> SUCCEEDS
    sockA.sentFrames.length = 0;
    await sockA.dispatchMessage({
      type: "confirm_decision",
      decisionId: dec.id,
      projectId: dec.projectId,
      confirmationToken: tokenForA,
    });
    expect(sockA.sentFrames.some((m) => m.type === "decision_confirmed" && m.success === true)).toBe(true);

    await projectDecisionStore.deleteDecision(dec.id);
  });

  it("Scenario 8, 9 & 10: legitimate confirmation works; legitimate rejection revokes token; rejected token cannot be approved", async () => {
    const { localLiveSessionRegistry } = await import("../../backend/server.ts");
    const { ConversationManager } = await import("../../backend/conversation/ConversationManager.ts");
    const { securityPolicyEngine } = await import("../../backend/security/SecurityPolicyEngine.ts");
    const { projectDecisionStore } = await import("../../backend/projects/ProjectDecisionStore.ts");

    const sock = createMockWebSocket();
    localLiveSessionRegistry.markTrustedUpgrade(sock.ws, { ipAddress: "127.0.0.1", userAgent: "Client-8" });
    const ctx = localLiveSessionRegistry.establishLocalSession(sock.ws)!;

    const decConfirm = {
      id: "dec-legit-confirm-8",
      projectId: "proj-legit-8",
      description: "Legitimate confirm",
      timestamp: new Date().toISOString(),
      type: "decision" as const,
      source: "ai_proposed" as const,
      confirmed: false,
    };
    const decReject = {
      id: "dec-legit-reject-9",
      projectId: "proj-legit-8",
      description: "Legitimate reject",
      timestamp: new Date().toISOString(),
      type: "decision" as const,
      source: "ai_proposed" as const,
      confirmed: false,
    };
    await projectDecisionStore.saveDecision(decConfirm);
    await projectDecisionStore.saveDecision(decReject);

    const tokenConfirm = securityPolicyEngine.generateConfirmationToken(
      "trackProjectTask",
      { action: "confirm_decision", decisionId: decConfirm.id, projectId: decConfirm.projectId },
      ctx.sessionId,
    );
    const tokenReject = securityPolicyEngine.generateConfirmationToken(
      "trackProjectTask",
      { action: "confirm_decision", decisionId: decReject.id, projectId: decReject.projectId },
      ctx.sessionId,
    );

    const mockFactory: any = { createSession: vi.fn(async () => ({ sendRealtimeInput: vi.fn(), close: vi.fn() })) };
    const cm = new ConversationManager(mockFactory);
    await cm.handleConnection(sock.ws);

    // 8. Legitimate confirmation
    sock.sentFrames.length = 0;
    await sock.dispatchMessage({
      type: "confirm_decision",
      decisionId: decConfirm.id,
      projectId: decConfirm.projectId,
      confirmationToken: tokenConfirm,
    });
    expect(sock.sentFrames.some((m) => m.type === "decision_confirmed" && m.success === true)).toBe(true);
    expect((await projectDecisionStore.getDecision(decConfirm.id))?.confirmed).toBe(true);

    // 9. Legitimate rejection revokes token
    sock.sentFrames.length = 0;
    await sock.dispatchMessage({
      type: "reject_decision",
      decisionId: decReject.id,
      projectId: decReject.projectId,
      confirmationToken: tokenReject,
    });
    expect(sock.sentFrames.some((m) => m.type === "decision_rejected" && m.revoked === true)).toBe(true);

    // 10. Rejected token cannot subsequently be approved (fails closed)
    sock.sentFrames.length = 0;
    await sock.dispatchMessage({
      type: "confirm_decision",
      decisionId: decReject.id,
      projectId: decReject.projectId,
      confirmationToken: tokenReject,
    });
    expect(
      sock.sentFrames.some(
        (m) => m.type === "decision_confirmation_failed" && String(m.error).includes("CONFIRMATION_TOKEN_REPLAY"),
      ),
    ).toBe(true);

    await projectDecisionStore.deleteDecision(decConfirm.id);
    await projectDecisionStore.deleteDecision(decReject.id);
  });

  it("Scenario 11: reconnected socket cannot reuse previous connection's session-bound token", async () => {
    const { localLiveSessionRegistry } = await import("../../backend/server.ts");
    const { ConversationManager } = await import("../../backend/conversation/ConversationManager.ts");
    const { securityPolicyEngine } = await import("../../backend/security/SecurityPolicyEngine.ts");
    const { projectDecisionStore } = await import("../../backend/projects/ProjectDecisionStore.ts");

    const sockOld = createMockWebSocket();
    localLiveSessionRegistry.markTrustedUpgrade(sockOld.ws, { ipAddress: "127.0.0.1", userAgent: "Client-11" });
    const ctxOld = localLiveSessionRegistry.establishLocalSession(sockOld.ws)!;

    const dec = {
      id: "dec-reconnect-11",
      projectId: "proj-reconnect-11",
      description: "Reconnect token reuse test",
      timestamp: new Date().toISOString(),
      type: "decision" as const,
      source: "ai_proposed" as const,
      confirmed: false,
    };
    await projectDecisionStore.saveDecision(dec);

    const oldToken = securityPolicyEngine.generateConfirmationToken(
      "trackProjectTask",
      { action: "confirm_decision", decisionId: dec.id, projectId: dec.projectId },
      ctxOld.sessionId,
    );

    // Old socket disconnects
    localLiveSessionRegistry.cleanupLocalSession(sockOld.ws);

    // Client reconnects fresh
    const sockNew = createMockWebSocket();
    localLiveSessionRegistry.markTrustedUpgrade(sockNew.ws, { ipAddress: "127.0.0.1", userAgent: "Client-11-New" });
    const ctxNew = localLiveSessionRegistry.establishLocalSession(sockNew.ws)!;
    expect(ctxNew.sessionId).not.toBe(ctxOld.sessionId);

    const mockFactory: any = { createSession: vi.fn(async () => ({ sendRealtimeInput: vi.fn(), close: vi.fn() })) };
    const cm = new ConversationManager(mockFactory);
    await cm.handleConnection(sockNew.ws);

    sockNew.sentFrames.length = 0;
    await sockNew.dispatchMessage({
      type: "confirm_decision",
      decisionId: dec.id,
      projectId: dec.projectId,
      confirmationToken: oldToken,
    });
    expect(
      sockNew.sentFrames.some(
        (m) => m.type === "decision_confirmation_failed" && String(m.error).includes("SESSION_MISMATCH"),
      ),
    ).toBe(true);

    await projectDecisionStore.deleteDecision(dec.id);
  });

  it("Scenario 12: Emergency Stop and Security Lockdown block both confirmation and rejection on local /live socket", async () => {
    const { localLiveSessionRegistry } = await import("../../backend/server.ts");
    const { ConversationManager } = await import("../../backend/conversation/ConversationManager.ts");
    const { securityPolicyEngine } = await import("../../backend/security/SecurityPolicyEngine.ts");
    const { emergencyStopCoordinator } = await import("../../backend/remote/EmergencyStopCoordinator.ts");
    const { projectDecisionStore } = await import("../../backend/projects/ProjectDecisionStore.ts");

    const sock = createMockWebSocket();
    localLiveSessionRegistry.markTrustedUpgrade(sock.ws, { ipAddress: "127.0.0.1", userAgent: "Client-12" });
    const ctx = localLiveSessionRegistry.establishLocalSession(sock.ws)!;

    const dec = {
      id: "dec-block-12",
      projectId: "proj-block-12",
      description: "E-Stop and Lockdown gate decision",
      timestamp: new Date().toISOString(),
      type: "decision" as const,
      source: "ai_proposed" as const,
      confirmed: false,
    };
    await projectDecisionStore.saveDecision(dec);

    const token = securityPolicyEngine.generateConfirmationToken(
      "trackProjectTask",
      { action: "confirm_decision", decisionId: dec.id, projectId: dec.projectId },
      ctx.sessionId,
    );

    const mockFactory: any = { createSession: vi.fn(async () => ({ sendRealtimeInput: vi.fn(), close: vi.fn() })) };
    const cm = new ConversationManager(mockFactory);
    await cm.handleConnection(sock.ws);

    // 1. Emergency Stop blocks confirm & reject
    await emergencyStopCoordinator.trigger({ source: "desktop_ui", reason: "Test E-Stop" });
    sock.sentFrames.length = 0;
    await sock.dispatchMessage({
      type: "confirm_decision",
      decisionId: dec.id,
      projectId: dec.projectId,
      confirmationToken: token,
    });
    expect(sock.sentFrames.some((m) => m.type === "decision_confirmation_failed" && m.error === "EMERGENCY_STOP_ACTIVE")).toBe(true);

    sock.sentFrames.length = 0;
    await sock.dispatchMessage({
      type: "reject_decision",
      decisionId: dec.id,
      projectId: dec.projectId,
      confirmationToken: token,
    });
    expect(sock.sentFrames.some((m) => m.type === "decision_rejection_failed" && m.error === "EMERGENCY_STOP_ACTIVE")).toBe(true);

    await emergencyStopCoordinator.reset("test");

    // 2. Security Lockdown blocks confirm & reject
    securityPolicyEngine.setMode("LOCKDOWN");
    sock.sentFrames.length = 0;
    await sock.dispatchMessage({
      type: "confirm_decision",
      decisionId: dec.id,
      projectId: dec.projectId,
      confirmationToken: token,
    });
    expect(sock.sentFrames.some((m) => m.type === "decision_confirmation_failed" && m.error === "SECURITY_LOCKDOWN_ACTIVE")).toBe(true);

    sock.sentFrames.length = 0;
    await sock.dispatchMessage({
      type: "reject_decision",
      decisionId: dec.id,
      projectId: dec.projectId,
      confirmationToken: token,
    });
    expect(sock.sentFrames.some((m) => m.type === "decision_rejection_failed" && m.error === "SECURITY_LOCKDOWN_ACTIVE")).toBe(true);

    securityPolicyEngine.setMode("BALANCED");
    await projectDecisionStore.deleteDecision(dec.id);
  });

  // --- Compatibility (Scenarios 13–15) ---

  it("Scenario 13: existing /remote-live identity propagation remains unchanged and isolated from local registry", async () => {
    const { localLiveSessionRegistry } = await import("../../backend/server.ts");
    const { remoteSessionManager } = await import("../../backend/remote/RemoteSessionManager.ts");

    const remoteSock = createMockWebSocket();
    const pairedDev = {
      id: "dev-rem-13",
      name: "Remote Companion",
      deviceType: "mobile" as const,
      role: "standard" as const,
      roleExplicit: true,
      tokenHash: "abc",
      pairedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      lastIp: "192.0.2.1",
      userAgent: "Android",
      revoked: false,
    };

    remoteSessionManager.registerClient(remoteSock.ws, pairedDev, "192.0.2.1", "Android");

    expect(remoteSock.ws.remoteSession).toBeDefined();
    expect(remoteSock.ws.remoteSessionId).toBeDefined();
    expect(remoteSock.ws.remoteSession.deviceId).toBe("dev-rem-13");
    // Must NOT be present in localLiveSessionRegistry
    expect(localLiveSessionRegistry.isActiveSession(remoteSock.ws.remoteSessionId)).toBe(false);
  });

  it("Scenario 14 & 15: upstream Gemini session recreation preserves the client socket identity and confirmation binding", async () => {
    const { localLiveSessionRegistry } = await import("../../backend/server.ts");
    const { ConversationManager } = await import("../../backend/conversation/ConversationManager.ts");
    const { securityPolicyEngine } = await import("../../backend/security/SecurityPolicyEngine.ts");
    const { projectDecisionStore } = await import("../../backend/projects/ProjectDecisionStore.ts");

    const sock = createMockWebSocket();
    localLiveSessionRegistry.markTrustedUpgrade(sock.ws, { ipAddress: "127.0.0.1", userAgent: "Client-14" });
    const localSess = localLiveSessionRegistry.establishLocalSession(sock.ws)!;

    let rotateTrigger: (() => Promise<void>) | null = null;
    const mockFactory: any = {
      createSession: vi.fn(async (params: any) => {
        rotateTrigger = params.onRotate;
        return {
          sendRealtimeInput: vi.fn(),
          sendClientContent: vi.fn(),
          close: vi.fn(),
        };
      }),
    };
    const cm = new ConversationManager(mockFactory);
    await cm.handleConnection(sock.ws);

    // Initial upstream creation occurred
    expect(mockFactory.createSession).toHaveBeenCalledTimes(1);
    const initialSessionId = sock.ws.remoteSessionId;
    expect(initialSessionId).toBe(localSess.sessionId);

    // Simulate upstream Gemini rotation / recreation
    expect(rotateTrigger).not.toBeNull();
    await rotateTrigger!();

    // Upstream session was recreated, but client WebSocket session identity is strictly preserved
    expect(mockFactory.createSession).toHaveBeenCalledTimes(2);
    expect(sock.ws.remoteSessionId).toBe(initialSessionId);
    expect(sock.ws.remoteSession.sessionId).toBe(initialSessionId);

    // A confirmation token minted for this socket remains valid and verifiable after rotation
    const dec = {
      id: "dec-rot-14",
      projectId: "proj-rot-14",
      description: "Rotation resilience decision",
      timestamp: new Date().toISOString(),
      type: "decision" as const,
      source: "ai_proposed" as const,
      confirmed: false,
    };
    await projectDecisionStore.saveDecision(dec);

    const token = securityPolicyEngine.generateConfirmationToken(
      "trackProjectTask",
      { action: "confirm_decision", decisionId: dec.id, projectId: dec.projectId },
      initialSessionId,
    );

    sock.sentFrames.length = 0;
    await sock.dispatchMessage({
      type: "confirm_decision",
      decisionId: dec.id,
      projectId: dec.projectId,
      confirmationToken: token,
    });
    expect(sock.sentFrames.some((m) => m.type === "decision_confirmed" && m.success === true)).toBe(true);
    expect((await projectDecisionStore.getDecision(dec.id))?.confirmed).toBe(true);

    await projectDecisionStore.deleteDecision(dec.id);
  });
});
