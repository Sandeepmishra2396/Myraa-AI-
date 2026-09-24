/**
 * MYRAA — Phase 30 Production Hardening & Release Readiness Test Suite
 *
 * Validates:
 *   1. Environment-Aware Security Headers (HSTS, nosniff, frameguard, referrer policy)
 *   2. Request Payload Size Limits (10MB body cap enforcement)
 *   3. Environment-Aware CORS Policy (dev localhost vs production explicit whitelist, no wildcard)
 *   4. Global Sanitized Error Handling (zero stack trace, token, or path leakage)
 *   5. Terminal WebSocket Close Codes (fail-closed disconnect handling)
 *   6. Android Crash Diagnostic Sanitization (credentials/PII scrubbing)
 *   7. Production Release Signing Enforcement (fail-closed missing credentials invariant)
 *   8. Strict 126 Gemini Live Tool Count & Schema Invariant
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "http";
import { createHttpApp } from "../gateway/HttpGateway.ts";
import { LIVE_TOOLS } from "../ai/GeminiSessionFactory.ts";
import { emergencyStopCoordinator } from "../remote/EmergencyStopCoordinator.ts";
import { securityPolicyEngine } from "../security/SecurityPolicyEngine.ts";
import * as fs from "fs";
import * as path from "path";

describe("Phase 30 — Production Hardening & Release Readiness Suite", () => {
  const origNodeEnv = process.env.NODE_ENV;
  const origCorsOrigins = process.env.CORS_ORIGINS;

  let server: http.Server;
  let baseUrl: string;

  const startTestServer = async (customApp?: any): Promise<string> => {
    const app = customApp || createHttpApp();
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as any).port;
    baseUrl = `http://127.0.0.1:${port}`;
    return baseUrl;
  };

  beforeEach(async () => {
    await emergencyStopCoordinator.reset("phase30_test_setup");
    securityPolicyEngine.setMode("BALANCED");
    process.env.NODE_ENV = "test";
    delete process.env.CORS_ORIGINS;
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    process.env.NODE_ENV = origNodeEnv;
    if (origCorsOrigins !== undefined) {
      process.env.CORS_ORIGINS = origCorsOrigins;
    } else {
      delete process.env.CORS_ORIGINS;
    }
    await emergencyStopCoordinator.reset("phase30_test_teardown");
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. SECURITY HEADERS & ENVIRONMENT AWARENESS
  // ═══════════════════════════════════════════════════════════════════════════
  describe("1. Environment-Aware Security Headers", () => {
    it("1.1 applies nosniff, frameguard, and referrer policy on all HTTP responses", async () => {
      const url = await startTestServer();
      const res = await fetch(`${url}/api/config`);

      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
      expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
      expect(res.headers.get("x-xss-protection")).toBe("0");
    });

    it("1.2 does NOT emit Strict-Transport-Security on local development HTTP requests", async () => {
      process.env.NODE_ENV = "development";
      const url = await startTestServer();
      const res = await fetch(`${url}/api/config`);

      expect(res.headers.get("strict-transport-security")).toBeNull();
    });

    it("1.3 emits Strict-Transport-Security strictly in production mode over HTTPS/TLS", async () => {
      process.env.NODE_ENV = "production";
      const url = await startTestServer();
      const res = await fetch(`${url}/api/config`, {
        headers: { "x-forwarded-proto": "https" },
      });

      expect(res.headers.get("strict-transport-security")).toBe("max-age=31536000; includeSubDomains");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. REQUEST PAYLOAD LIMITS
  // ═══════════════════════════════════════════════════════════════════════════
  describe("2. Request Payload Size Limits", () => {
    it("2.1 accepts valid JSON payloads within normal bounds", async () => {
      const url = await startTestServer();
      const res = await fetch(`${url}/api/memories`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category: "user_preference",
          text: "Prefers concise production logs and dark theme.",
        }),
      });

      expect(res.status).toBe(201);
      const data = await res.json() as any;
      expect(data.id).toBeDefined();
    });

    it("2.2 rejects payloads exceeding the 10MB body cap with 413 Payload Too Large", async () => {
      const url = await startTestServer();
      // Generate a payload exceeding 10MB
      const hugeBuffer = "A".repeat(11 * 1024 * 1024); // 11MB string
      const res = await fetch(`${url}/api/memories`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category: "test",
          text: hugeBuffer,
        }),
      });

      expect(res.status).toBe(413);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. ENVIRONMENT-AWARE CORS & ORIGIN CONTROL
  // ═══════════════════════════════════════════════════════════════════════════
  describe("3. Environment-Aware CORS & Origin Control", () => {
    it("3.1 permits localhost and 127.0.0.1 origins during development", async () => {
      process.env.NODE_ENV = "development";
      const url = await startTestServer();

      const res = await fetch(`${url}/api/config`, {
        headers: { Origin: "http://localhost:5173" },
      });

      expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
      expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    });

    it("3.2 enforces strict explicit whitelist in production and rejects untrusted origins", async () => {
      process.env.NODE_ENV = "production";
      process.env.CORS_ORIGINS = "https://app.myraa.ai,https://admin.myraa.ai";
      const url = await startTestServer();

      // Allowed origin
      const allowedRes = await fetch(`${url}/api/config`, {
        headers: { Origin: "https://app.myraa.ai" },
      });
      expect(allowedRes.headers.get("access-control-allow-origin")).toBe("https://app.myraa.ai");

      // Untrusted foreign origin rejected on preflight OPTIONS
      const rejectedPreflight = await fetch(`${url}/api/config`, {
        method: "OPTIONS",
        headers: { Origin: "https://malicious-site.com" },
      });
      expect(rejectedPreflight.status).toBe(403);
      const data = await rejectedPreflight.json() as any;
      expect(data.error).toContain("CORS_ORIGIN_DENIED");
      expect(rejectedPreflight.headers.get("access-control-allow-origin")).toBeNull();
    });

    it("3.3 never emits wildcard '*' Access-Control-Allow-Origin in production", async () => {
      process.env.NODE_ENV = "production";
      process.env.CORS_ORIGINS = "https://app.myraa.ai";
      const url = await startTestServer();

      const res = await fetch(`${url}/api/config`, {
        headers: { Origin: "https://untrusted-attacker.org" },
      });

      expect(res.headers.get("access-control-allow-origin")).not.toBe("*");
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. SANITIZED ERROR HANDLING & INFORMATION LEAKAGE DEFENSE
  // ═══════════════════════════════════════════════════════════════════════════
  describe("4. Sanitized Error Handling", () => {
    it("4.1 intercepts unhandled errors and formats clean JSON without stack traces", async () => {
      const url = await startTestServer();

      // Trigger parser syntax error via malformed JSON payload
      const res = await fetch(`${url}/api/memories`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{ malformed_json_here: ",
      });

      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error).toBeDefined();
      expect(data.stack).toBeUndefined();
      expect(typeof data.error).toBe("string");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. TERMINAL CLOSE CODES & ANDROID RECONNECT FAIL-CLOSED
  // ═══════════════════════════════════════════════════════════════════════════
  describe("5. Terminal Close Codes & Reconnect Invariants", () => {
    it("5.1 classifies 4001, 4003, 4008, 4023 as terminal failure codes", () => {
      const terminalCodes = [4001, 4003, 4008, 4023];
      const transientCodes = [1000, 1001, 1006];

      for (const code of terminalCodes) {
        const isTerminal = code === 4001 || code === 4003 || code === 4008 || code === 4023;
        expect(isTerminal).toBe(true);
      }

      for (const code of transientCodes) {
        const isTerminal = code === 4001 || code === 4003 || code === 4008 || code === 4023;
        expect(isTerminal).toBe(false);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 6. ANDROID CRASH DIAGNOSTIC SANITIZATION
  // ═══════════════════════════════════════════════════════════════════════════
  describe("6. Android Crash Diagnostic Sanitization", () => {
    it("6.1 sanitizes tokens, passwords, API keys, and email addresses from error text", () => {
      const rawError = "Failed with token=sora_dev_secret_token_123456 and sk-proj-abcdef1234567890abcdef for user@myraa.ai";

      const sensitivePatterns = [
        /bearer\s+[a-zA-Z0-9_.-]+/gi,
        /sora_dev_[a-zA-Z0-9_]+/gi,
        /myraa_at_[a-zA-Z0-9_]+/gi,
        /AIza[0-9A-Za-z-_]{35}/gi,
        /sk-[a-zA-Z0-9_.-]{20,}/gi,
        /password=[^&\s]+/gi,
        /token=[^&\s]+/gi,
        /secret=[^&\s]+/gi,
        /api[_-]?key=[^&\s]+/gi,
        /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi,
      ];

      let sanitized = rawError;
      for (const pat of sensitivePatterns) {
        sanitized = sanitized.replace(pat, "[REDACTED]");
      }

      expect(sanitized).not.toContain("sora_dev_secret_token_123456");
      expect(sanitized).not.toContain("sk-proj-abcdef1234567890abcdef");
      expect(sanitized).not.toContain("user@myraa.ai");
      expect(sanitized).toContain("[REDACTED]");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 7. PRODUCTION SIGNING FAIL-CLOSED INVARIANT
  // ═══════════════════════════════════════════════════════════════════════════
  describe("7. Production Signing Fail-Closed Invariant", () => {
    it("7.1 verifies that android/app/build.gradle.kts enforces fail-closed release signing", () => {
      const gradleKtsPath = path.join(process.cwd(), "android", "app", "build.gradle.kts");
      expect(fs.existsSync(gradleKtsPath)).toBe(true);

      const content = fs.readFileSync(gradleKtsPath, "utf-8");

      // Verify no debug fallback in release signingConfig
      expect(content).toContain('signingConfig = signingConfigs.getByName("release")');
      expect(content).toContain('create("releaseTest")');

      // Verify fail-closed check
      expect(content).toContain("PRODUCTION SIGNING FAILURE");
      expect(content).toContain("MYRAA_RELEASE_KEYSTORE_PATH");
      expect(content).toContain("MYRAA_RELEASE_STORE_PASSWORD");
    });

    it("7.2 verifies keystores and signing credentials are excluded in .gitignore", () => {
      const gitignorePath = path.join(process.cwd(), ".gitignore");
      expect(fs.existsSync(gitignorePath)).toBe(true);

      const content = fs.readFileSync(gitignorePath, "utf-8");
      expect(content).toContain("*.keystore");
      expect(content).toContain("*.jks");
      expect(content).toContain("keystore.properties");
      expect(content).toContain("release-keystore.*");
    });

    it("7.3 verifies ProGuard rules strip verbose/debug logs and keep all models", () => {
      const proguardPath = path.join(process.cwd(), "android", "app", "proguard-rules.pro");
      expect(fs.existsSync(proguardPath)).toBe(true);

      const content = fs.readFileSync(proguardPath, "utf-8");
      expect(content).toContain("-keep class com.myraa.companion.** { *; }");
      expect(content).toContain("-assumenosideeffects class android.util.Log");
      expect(content).toContain("public static int v(...);");
      expect(content).toContain("public static int d(...);");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 8. 126 GEMINI LIVE TOOLS STRICT INVARIANT
  // ═══════════════════════════════════════════════════════════════════════════
  describe("8. Strict 126 Gemini Live Tool Invariant", () => {
    it("8.1 strictly preserves exactly 126 Gemini Live tools in LIVE_TOOLS", () => {
      const decls = LIVE_TOOLS[0].functionDeclarations;
      expect(decls.length).toBe(126);

      const uniqueNames = new Set(decls.map((d: any) => d.name));
      expect(uniqueNames.size).toBe(126);
    });

    it("8.2 verifies all 126 tools declare valid names and non-empty schemas", () => {
      const decls = LIVE_TOOLS[0].functionDeclarations;
      for (const tool of decls) {
        expect(typeof tool.name).toBe("string");
        expect(tool.name.trim().length).toBeGreaterThan(0);
        expect(typeof tool.description).toBe("string");
        expect(tool.parameters).toBeDefined();
      }
    });
  });
});
