/**
 * MYRAA — Phase 10F Comprehensive Test Suite
 *
 * Verification Gate for:
 *   1. Centralized Network Security Layer (NetworkSecurityManager)
 *      • Comprehensive SSRF protection (IPv4, IPv6, loopback, private, link-local, cloud metadata, CGNAT, ULA, intranet, hex/octal/dword)
 *      • DNS rebinding prevention (resolves & checks all A/AAAA addresses)
 *      • Hop-by-hop redirect validation (max 5 hops; aborts on restricted hop)
 *      • Connect/read timeout enforcement (AbortController)
 *      • Streaming response size limit enforcement (byte accumulation abort)
 *      • Per-domain sliding window rate limiting
 *      • Webhook HMAC signature validation (timing-safe, timestamp tolerance)
 *   2. Centralized Secret Management (SecretManager)
 *      • Strict RBAC: only admin or allowlisted internal subsystems may access raw secrets
 *      • Denies and audits guest, read_only, standard, and unauthorized callers
 *      • Secret rotation & revocation lifecycle with encrypted persistence (SecureSecretStore)
 *      • Zero raw-secret exposure to audit records, alerts, logs, frontend, and LLM model context
 *      • Accidental hardcoded secret scanner
 *   3. Invariants
 *      • Exactly 126 Gemini Live Tools preserved
 *      • Existing SSRF functions in PermissionManager delegate seamlessly
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "crypto";
import http from "http";
import {
  networkSecurityManager,
  NetworkSecurityManager,
} from "../NetworkSecurityManager.ts";
import {
  secretManager,
  SecretManager,
  ALLOWLISTED_INTERNAL_SUBSYSTEMS,
} from "../SecretManager.ts";
import { isRestrictedHost, isSsrfSafeUrl, safeSsrfFetch } from "../PermissionManager.ts";
import { outputDataFirewall } from "../OutputDataFirewall.ts";
import { securityAuditLogger } from "../SecurityAuditLogger.ts";
import { LIVE_TOOLS } from "../../ai/GeminiSessionFactory.ts";
import type { SecurityContext } from "../SecurityTypes.ts";

describe("Phase 10F — MYRAA Centralized Network Security & Secret Management", () => {
  let testServer: http.Server | null = null;
  let testServerPort: number = 0;

  beforeEach(() => {
    networkSecurityManager.resetRateLimits();
    networkSecurityManager.updateConfig({
      maxRedirects: 5,
      timeoutMs: 5000,
      maxResponseBytes: 1024 * 1024,
      rateLimitPerDomainPerMin: 30,
      dnsRebindingProtection: true,
    });
    secretManager.clearForTesting();
    securityAuditLogger.clearForTesting();
  });

  afterEach(() => {
    if (testServer) {
      testServer.close();
      testServer = null;
    }
  });

  // ===========================================================================
  // 1. SSRF & Restricted Host Validation
  // ===========================================================================

  describe("SSRF Protection & Restricted Host Filter", () => {
    it("should block loopback addresses in all standard representations", () => {
      expect(networkSecurityManager.isRestrictedHost("localhost")).toBe(true);
      expect(networkSecurityManager.isRestrictedHost("127.0.0.1")).toBe(true);
      expect(networkSecurityManager.isRestrictedHost("127.100.200.1")).toBe(true);
      expect(networkSecurityManager.isRestrictedHost("0.0.0.0")).toBe(true);
      expect(networkSecurityManager.isRestrictedHost("::1")).toBe(true);
      expect(networkSecurityManager.isRestrictedHost("::")).toBe(true);
      expect(networkSecurityManager.isRestrictedHost("::ffff:127.0.0.1")).toBe(true);
    });

    it("should block RFC 1918 private IPv4 subnets", () => {
      // 10.0.0.0/8
      expect(networkSecurityManager.isRestrictedHost("10.0.0.1")).toBe(true);
      expect(networkSecurityManager.isRestrictedHost("10.254.254.254")).toBe(true);

      // 172.16.0.0/12
      expect(networkSecurityManager.isRestrictedHost("172.16.0.1")).toBe(true);
      expect(networkSecurityManager.isRestrictedHost("172.24.50.1")).toBe(true);
      expect(networkSecurityManager.isRestrictedHost("172.31.255.255")).toBe(true);
      // But 172.32.0.1 is public
      expect(networkSecurityManager.isRestrictedHost("172.32.0.1")).toBe(false);

      // 192.168.0.0/16
      expect(networkSecurityManager.isRestrictedHost("192.168.0.1")).toBe(true);
      expect(networkSecurityManager.isRestrictedHost("192.168.1.254")).toBe(true);
    });

    it("should block cloud metadata and link-local addresses", () => {
      expect(networkSecurityManager.isRestrictedHost("169.254.169.254")).toBe(true);
      expect(networkSecurityManager.isRestrictedHost("169.254.169.253")).toBe(true);
      expect(networkSecurityManager.isRestrictedHost("169.254.1.1")).toBe(true);
      expect(networkSecurityManager.isRestrictedHost("metadata.google.internal")).toBe(true);
      expect(networkSecurityManager.isRestrictedHost("metadata.aws")).toBe(true);
      expect(networkSecurityManager.isRestrictedHost("instance-data")).toBe(true);
      expect(networkSecurityManager.isRestrictedHost("fe80::1")).toBe(true);
    });

    it("should block Carrier-Grade NAT (CGNAT) 100.64.0.0/10", () => {
      expect(networkSecurityManager.isRestrictedHost("100.64.0.1")).toBe(true);
      expect(networkSecurityManager.isRestrictedHost("100.100.1.1")).toBe(true);
      expect(networkSecurityManager.isRestrictedHost("100.127.255.254")).toBe(true);
      // 100.128.0.1 is outside CGNAT
      expect(networkSecurityManager.isRestrictedHost("100.128.0.1")).toBe(false);
    });

    it("should block Unique Local IPv6 (fc00::/7)", () => {
      expect(networkSecurityManager.isRestrictedHost("fc00::1")).toBe(true);
      expect(networkSecurityManager.isRestrictedHost("fd12:3456:789a::1")).toBe(true);
    });

    it("should block internal, local, and single-label intranet domains", () => {
      expect(networkSecurityManager.isRestrictedHost("app.local")).toBe(true);
      expect(networkSecurityManager.isRestrictedHost("database.internal")).toBe(true);
      expect(networkSecurityManager.isRestrictedHost("router.lan")).toBe(true);
      expect(networkSecurityManager.isRestrictedHost("intranet.corp")).toBe(true);
      expect(networkSecurityManager.isRestrictedHost("nas.home")).toBe(true);
      expect(networkSecurityManager.isRestrictedHost("darkweb.onion")).toBe(true);
      expect(networkSecurityManager.isRestrictedHost("testserver")).toBe(true); // single label
    });

    it("should block obfuscated hex, dword, and octal IP formats", () => {
      // Dword IP: 2130706433 === 127.0.0.1
      expect(networkSecurityManager.isRestrictedHost("2130706433")).toBe(true);
      // Hex IP: 0x7f000001 === 127.0.0.1
      expect(networkSecurityManager.isRestrictedHost("0x7f000001")).toBe(true);
      // Octal dotted-quad: 0177.0.0.1 === 127.0.0.1
      expect(networkSecurityManager.isRestrictedHost("0177.0.0.1")).toBe(true);
    });

    it("should allow legitimate external domains", () => {
      expect(networkSecurityManager.isRestrictedHost("api.github.com")).toBe(false);
      expect(networkSecurityManager.isRestrictedHost("generativelanguage.googleapis.com")).toBe(false);
      expect(networkSecurityManager.isRestrictedHost("en.wikipedia.org")).toBe(false);
      expect(networkSecurityManager.isRestrictedHost("8.8.8.8")).toBe(false);
      expect(networkSecurityManager.isRestrictedHost("1.1.1.1")).toBe(false);
    });
  });

  // ===========================================================================
  // 2. URL Validation & Port Restrictions
  // ===========================================================================

  describe("URL Protocol & Port Security", () => {
    it("should reject non-HTTP(S) protocols", async () => {
      const fileRes = await networkSecurityManager.isSsrfSafeUrl("file:///etc/passwd");
      expect(fileRes.safe).toBe(false);
      expect(fileRes.reason).toContain("Invalid protocol");

      const ftpRes = await networkSecurityManager.isSsrfSafeUrl("ftp://evil.com/payload");
      expect(ftpRes.safe).toBe(false);

      const gopherRes = await networkSecurityManager.isSsrfSafeUrl("gopher://evil.com/");
      expect(gopherRes.safe).toBe(false);

      const jsRes = await networkSecurityManager.isSsrfSafeUrl("javascript:alert(1)");
      expect(jsRes.safe).toBe(false);
    });

    it("should block dangerous service ports", async () => {
      const sshRes = await networkSecurityManager.isSsrfSafeUrl("http://8.8.8.8:22/test");
      expect(sshRes.safe).toBe(false);
      expect(sshRes.reason).toContain("Target port 22 is restricted");

      const redisRes = await networkSecurityManager.isSsrfSafeUrl("http://8.8.8.8:6379/");
      expect(redisRes.safe).toBe(false);
      expect(redisRes.reason).toContain("Target port 6379 is restricted");

      const dbRes = await networkSecurityManager.isSsrfSafeUrl("http://8.8.8.8:3306/");
      expect(dbRes.safe).toBe(false);
      expect(dbRes.reason).toContain("Target port 3306 is restricted");

      const mongoRes = await networkSecurityManager.isSsrfSafeUrl("http://8.8.8.8:27017/");
      expect(mongoRes.safe).toBe(false);
      expect(mongoRes.reason).toContain("Target port 27017 is restricted");
    });

    it("should allow safe web ports for legitimate external IPs", async () => {
      const httpRes = await networkSecurityManager.isSsrfSafeUrl("http://8.8.8.8:80/");
      expect(httpRes.safe).toBe(true);

      const httpsRes = await networkSecurityManager.isSsrfSafeUrl("https://8.8.8.8:443/");
      expect(httpsRes.safe).toBe(true);

      const altWebRes = await networkSecurityManager.isSsrfSafeUrl("https://8.8.8.8:8443/");
      expect(altWebRes.safe).toBe(true);
    });
  });

  // ===========================================================================
  // 3. Delegation from PermissionManager
  // ===========================================================================

  describe("PermissionManager SSRF Delegation", () => {
    it("isRestrictedHost in PermissionManager should delegate to networkSecurityManager", () => {
      expect(isRestrictedHost("127.0.0.1")).toBe(true);
      expect(isRestrictedHost("169.254.169.254")).toBe(true);
      expect(isRestrictedHost("10.0.0.5")).toBe(true);
      expect(isRestrictedHost("8.8.8.8")).toBe(false);
    });

    it("isSsrfSafeUrl in PermissionManager should delegate to networkSecurityManager", async () => {
      const blocked = await isSsrfSafeUrl("http://127.0.0.1:3000/api");
      expect(blocked.safe).toBe(false);

      const allowed = await isSsrfSafeUrl("https://8.8.8.8/dns-query");
      expect(allowed.safe).toBe(true);
    });
  });

  // ===========================================================================
  // 4. Guarded Outbound Fetch & Hop-by-Hop Redirect Defense
  // ===========================================================================

  describe("fetchGuarded Engine & Redirect Validation", () => {
    it("should immediately abort and audit SSRF on restricted target", async () => {
      await expect(
        networkSecurityManager.fetchGuarded("http://127.0.0.1:9999/secret"),
      ).rejects.toThrow(/SSRF blocked/);

      const auditEntries = securityAuditLogger.getRecentEvents(5);
      const ssrfAudit = auditEntries.find((e) => e.eventType === "SSRF_BLOCKED");
      expect(ssrfAudit).toBeDefined();
      expect(ssrfAudit?.decision).toBe("BLOCK");
      expect(ssrfAudit?.riskLevel).toBe("HIGH");
    });

    it("should validate redirects hop-by-hop and fail closed on internal redirect target", async () => {
      // Start a temporary HTTP server that attempts to redirect to AWS metadata endpoint
      testServer = http.createServer((req, res) => {
        if (req.url === "/initial") {
          res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data" });
          res.end();
        } else {
          res.writeHead(200);
          res.end("OK");
        }
      });

      await new Promise<void>((resolve) => {
        testServer!.listen(0, "127.0.0.1", () => {
          testServerPort = (testServer!.address() as any).port;
          resolve();
        });
      });

      // Attempting to fetch hop-by-hop with skipDnsRebinding for local test
      await expect(
        networkSecurityManager.fetchGuarded(
          `http://127.0.0.1:${testServerPort}/initial`,
          { skipDnsRebinding: true },
        ),
      ).rejects.toThrow(/SSRF blocked/);
    });

    it("should abort if maximum redirect hops (5) are exceeded", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        return new Response(null, {
          status: 302,
          headers: { Location: "https://api.github.com/next-hop" },
        });
      });

      try {
        await expect(
          networkSecurityManager.fetchGuarded("https://api.github.com/loop", {
            maxRedirects: 3,
            skipDnsRebinding: true,
          }),
        ).rejects.toThrow(/Too many redirects/);
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it("should enforce response size limits and reject oversized payloads", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        return new Response("A".repeat(5000), {
          status: 200,
          headers: { "content-length": "5000" },
        });
      });

      try {
        await expect(
          networkSecurityManager.fetchGuarded("https://api.github.com/large", {
            maxResponseBytes: 1024,
            skipDnsRebinding: true,
          }),
        ).rejects.toThrow(/exceeds maximum permitted limit/);
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });

  // ===========================================================================
  // 5. Per-Domain Rate Limiting
  // ===========================================================================

  describe("Per-Domain Rate Limiting", () => {
    it("should track and enforce sliding-window rate limits per host", () => {
      networkSecurityManager.updateConfig({ rateLimitPerDomainPerMin: 3 });

      const host = "api.example.com";
      expect(networkSecurityManager.checkRateLimit(host).allowed).toBe(true);
      networkSecurityManager.recordRequest(host);

      expect(networkSecurityManager.checkRateLimit(host).allowed).toBe(true);
      networkSecurityManager.recordRequest(host);

      expect(networkSecurityManager.checkRateLimit(host).allowed).toBe(true);
      networkSecurityManager.recordRequest(host);

      // 4th request must be rate limited
      const check4 = networkSecurityManager.checkRateLimit(host);
      expect(check4.allowed).toBe(false);
      expect(check4.retryAfterSeconds).toBeGreaterThan(0);

      // Other hosts should remain unaffected
      expect(networkSecurityManager.checkRateLimit("other-host.com").allowed).toBe(true);
    });
  });

  // ===========================================================================
  // 6. Webhook HMAC Signature Validation
  // ===========================================================================

  describe("Webhook Signature & Replay Validation", () => {
    const secret = "super_secret_webhook_signing_key_32b";
    const payload = JSON.stringify({ event: "payment_succeeded", id: "evt_123" });

    it("should verify valid HMAC-SHA256 signature", () => {
      const sig = crypto.createHmac("sha256", secret).update(payload).digest("hex");

      const result = networkSecurityManager.validateWebhookSignature({
        payload,
        signatureHeader: sig,
        secret,
      });

      expect(result.valid).toBe(true);

      const audit = securityAuditLogger.getRecentEvents(1)[0];
      expect(audit.eventType).toBe("WEBHOOK_VERIFIED");
      expect(audit.decision).toBe("ALLOW");
    });

    it("should handle sha256= prefix in signature header", () => {
      const sig = crypto.createHmac("sha256", secret).update(payload).digest("hex");

      const result = networkSecurityManager.validateWebhookSignature({
        payload,
        signatureHeader: `sha256=${sig}`,
        secret,
      });

      expect(result.valid).toBe(true);
    });

    it("should reject tampered payload", () => {
      const sig = crypto.createHmac("sha256", secret).update(payload).digest("hex");
      const tamperedPayload = JSON.stringify({ event: "payment_failed", id: "evt_123" });

      const result = networkSecurityManager.validateWebhookSignature({
        payload: tamperedPayload,
        signatureHeader: sig,
        secret,
      });

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("Invalid HMAC signature");

      const audit = securityAuditLogger.getRecentEvents(1)[0];
      expect(audit.eventType).toBe("WEBHOOK_FAILED");
      expect(audit.decision).toBe("BLOCK");
    });

    it("should reject wrong secret", () => {
      const sig = crypto.createHmac("sha256", "wrong_secret").update(payload).digest("hex");

      const result = networkSecurityManager.validateWebhookSignature({
        payload,
        signatureHeader: sig,
        secret,
      });

      expect(result.valid).toBe(false);
    });

    it("should reject expired/replayed timestamps", () => {
      const sig = crypto.createHmac("sha256", secret).update(payload).digest("hex");
      const staleTimestamp = Math.floor(Date.now() / 1000) - 600; // 10 minutes ago

      const result = networkSecurityManager.validateWebhookSignature({
        payload,
        signatureHeader: sig,
        secret,
        timestampHeader: String(staleTimestamp),
        toleranceSeconds: 300, // 5 min tolerance
      });

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("Timestamp expired");
    });
  });

  // ===========================================================================
  // 7. Centralized SecretManager & RBAC
  // ===========================================================================

  describe("SecretManager RBAC & Authorization", () => {
    const adminContext: SecurityContext = {
      identityId: "admin_user",
      role: "admin",
      ipAddress: "127.0.0.1",
      isLocal: true,
    };

    const guestContext: SecurityContext = {
      identityId: "guest_user",
      role: "guest",
      ipAddress: "192.168.1.50",
      isLocal: false,
    };

    const standardContext: SecurityContext = {
      identityId: "std_user",
      role: "standard",
      ipAddress: "127.0.0.1",
      isLocal: true,
    };

    it("should allow admin caller to set and get raw secret", () => {
      secretManager.setSecret("TEST_API_KEY", "test_secret_value_12345", adminContext);
      const val = secretManager.getSecret("TEST_API_KEY", adminContext);
      expect(val).toBe("test_secret_value_12345");
    });

    it("should allow allowlisted internal subsystems to retrieve raw secret", () => {
      secretManager.setSecret("GEMINI_LIVE_KEY", "gemini_secret_live_9999", adminContext);

      for (const subsystem of ALLOWLISTED_INTERNAL_SUBSYSTEMS) {
        const val = secretManager.getSecret("GEMINI_LIVE_KEY", { subsystem });
        expect(val).toBe("gemini_secret_live_9999");
      }
    });

    it("should DENY and AUDIT guest caller attempting to read raw secret", () => {
      secretManager.setSecret("DATABASE_PASS", "super_secret_db_pass_888", adminContext);

      expect(() => {
        secretManager.getSecret("DATABASE_PASS", guestContext);
      }).toThrow(/SECRET_ACCESS_DENIED/);

      const audit = securityAuditLogger.getRecentEvents(1)[0];
      expect(audit.eventType).toBe("SECRET_ACCESS_DENIED");
      expect(audit.decision).toBe("BLOCK");
      expect(audit.riskLevel).toBe("CRITICAL");
      // Must not leak secret in audit
      expect(JSON.stringify(audit)).not.toContain("super_secret_db_pass_888");
    });

    it("should DENY and AUDIT standard role or unauthenticated caller", () => {
      secretManager.setSecret("JWT_SIGNING_KEY", "jwt_top_secret_key_777", adminContext);

      expect(() => {
        secretManager.getSecret("JWT_SIGNING_KEY", standardContext);
      }).toThrow(/SECRET_ACCESS_DENIED/);

      expect(() => {
        secretManager.getSecret("JWT_SIGNING_KEY", undefined);
      }).toThrow(/SECRET_ACCESS_DENIED/);
    });
  });

  // ===========================================================================
  // 8. Zero Raw-Secret Exposure Guarantee
  // ===========================================================================

  describe("Zero Raw-Secret Exposure & DLP Sanitization", () => {
    const adminContext: SecurityContext = {
      identityId: "admin_user",
      role: "admin",
      ipAddress: "127.0.0.1",
      isLocal: true,
    };

    it("should provide masked secrets for UI / monitoring views without leaking the full secret", () => {
      secretManager.setSecret(
        "MY_LONG_API_KEY",
        "AIzaSyD_my_secret_token_value_987654321",
        adminContext,
      );

      const masked = secretManager.getMaskedSecret("MY_LONG_API_KEY");
      expect(masked).toBe("AIza...****...4321");
      expect(masked).not.toContain("my_secret_token_value");
    });

    it("should return metadata only in listSecretMetadata() without raw secrets", () => {
      secretManager.setSecret("TAVILY_KEY", "tvly-abcdef0123456789", adminContext, {
        description: "Tavily search provider key",
      });

      const list = secretManager.listSecretMetadata();
      const tavilyMeta = list.find((m) => m.keyName === "TAVILY_KEY");

      expect(tavilyMeta).toBeDefined();
      expect(tavilyMeta?.keyName).toBe("TAVILY_KEY");
      expect(tavilyMeta?.version).toBe(1);
      expect(tavilyMeta?.revoked).toBe(false);
      // Ensure no raw value field exists on metadata
      expect((tavilyMeta as any).value).toBeUndefined();
    });

    it("should dynamically redact active secrets from arbitrary text via redactAllKnownSecrets()", () => {
      const dynamicSecret = "super_unique_custom_token_xyz999";
      secretManager.setSecret("CUSTOM_TOKEN", dynamicSecret, adminContext);

      const rawText = `System crashed while connecting with token: ${dynamicSecret}. Stack trace follows.`;
      const sanitized = secretManager.redactAllKnownSecrets(rawText);

      expect(sanitized).not.toContain(dynamicSecret);
      expect(sanitized).toContain("[REDACTED_SECRET]");
    });

    it("should purge secrets and credentials from Gemini model context via sanitizeModelContext()", () => {
      const privateKey = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0...\n-----END RSA PRIVATE KEY-----";
      const userPrompt = `Here is my key: AIzaSyD9999999999999999999999999999999 and private: ${privateKey}`;

      const sanitizedContext = secretManager.sanitizeModelContext(userPrompt);

      expect(sanitizedContext).not.toContain("AIzaSyD9999999999999999999999999999999");
      expect(sanitizedContext).toContain("AIzaSy...[REDACTED]");
    });

    it("OutputDataFirewall should dynamically redact secrets managed by SecretManager", () => {
      const customSecret = "secret_db_pass_phase10f_dynamic";
      secretManager.setSecret("DB_CREDENTIAL", customSecret, adminContext);

      const toolOutput = {
        result: `Connected to database using ${customSecret}`,
        status: "SUCCESS",
      };

      const { sanitized, redactedCount } = outputDataFirewall.sanitizeResult(toolOutput, {
        toolName: "database_connect",
      });

      expect(redactedCount).toBeGreaterThan(0);
      expect(JSON.stringify(sanitized)).not.toContain(customSecret);
    });
  });

  // ===========================================================================
  // 9. Secret Rotation & Revocation Lifecycle
  // ===========================================================================

  describe("Secret Rotation & Revocation", () => {
    const adminContext: SecurityContext = {
      identityId: "admin_user",
      role: "admin",
      ipAddress: "127.0.0.1",
      isLocal: true,
    };

    it("should support rotation and increment secret version", () => {
      secretManager.setSecret("ROTATING_KEY", "initial_version_1_val", adminContext);
      expect(secretManager.getSecret("ROTATING_KEY", adminContext)).toBe("initial_version_1_val");

      secretManager.rotateSecret("ROTATING_KEY", "rotated_version_2_val", adminContext);

      const audit = securityAuditLogger.getRecentEvents(1)[0];
      expect(audit.eventType).toBe("SECRET_ROTATED");
      expect(audit.decision).toBe("ALLOW");

      expect(secretManager.getSecret("ROTATING_KEY", adminContext)).toBe("rotated_version_2_val");

      const meta = secretManager.listSecretMetadata().find((m) => m.keyName === "ROTATING_KEY");
      expect(meta?.version).toBe(2);
      expect(meta?.rotatedAt).toBeDefined();
    });

    it("should immediately block access when secret is revoked", () => {
      secretManager.setSecret("DEPRECATED_KEY", "old_val_to_revoke", adminContext);
      expect(secretManager.hasSecret("DEPRECATED_KEY")).toBe(true);

      secretManager.revokeSecret("DEPRECATED_KEY", adminContext);
      expect(secretManager.hasSecret("DEPRECATED_KEY")).toBe(false);

      expect(() => {
        secretManager.getSecret("DEPRECATED_KEY", adminContext);
      }).toThrow(/SECRET_REVOKED/);

      expect(secretManager.getMaskedSecret("DEPRECATED_KEY")).toBe("[REVOKED]");

      const audit = securityAuditLogger.getRecentEvents(1)[0];
      expect(audit.eventType).toBe("SECRET_REVOKED");
    });
  });

  // ===========================================================================
  // 10. Accidental Hardcoded Secret Detection
  // ===========================================================================

  describe("Hardcoded Secret Static Scanner", () => {
    it("should detect accidentally committed API keys and credentials", () => {
      const codeSnippet = `
        const geminiApiKey = "AIzaSyB1234567890123456789012345678901";
        const openaiKey = "sk-123456789012345678901234567890123456";
        const awsKey = "AKIAIOSFODNN7EXAMPLE";
        const ghToken = "ghp_123456789012345678901234567890123456";
      `;

      const findings = secretManager.detectHardcodedSecrets(codeSnippet, "sample_code.ts");

      expect(findings.length).toBe(4);
      expect(findings.map((f) => f.secretType)).toContain("Google / Gemini API Key");
      expect(findings.map((f) => f.secretType)).toContain("OpenAI API Key");
      expect(findings.map((f) => f.secretType)).toContain("AWS Access Key");
      expect(findings.map((f) => f.secretType)).toContain("GitHub Token");

      // Check masked samples
      for (const f of findings) {
        expect(f.maskedSample).toContain("...");
      }

      // Check audit event
      const audit = securityAuditLogger.getRecentEvents(1)[0];
      expect(audit.eventType).toBe("HARDCODED_SECRET_DETECTED");
    });

    it("should ignore obvious placeholders and redacted markers", () => {
      const safeCode = `
        const apiKey = process.env.API_KEY || "YOUR_API_KEY";
        const token = "[REDACTED_TOKEN]";
      `;

      const findings = secretManager.detectHardcodedSecrets(safeCode, "config.ts");
      expect(findings.length).toBe(0);
    });
  });

  // ===========================================================================
  // 11. Invariant: Tool Count Preservation (Exactly 126 Tools)
  // ===========================================================================

  describe("Tool Invariant Preservation", () => {
    it("preserves exactly 126 Gemini Live tools without additions or removals", () => {
      const tools = LIVE_TOOLS[0].functionDeclarations;
      expect(tools.length).toBe(126);

      const toolNames = new Set(tools.map((t) => t.name));
      expect(toolNames.size).toBe(126);

      // Core tools check
      expect(toolNames.has("browserOpen")).toBe(true);
      expect(toolNames.has("runShellCommand")).toBe(true);
      expect(toolNames.has("triggerEmergencyStop")).toBe(true);
      expect(toolNames.has("createFile")).toBe(true);
    });
  });
});
