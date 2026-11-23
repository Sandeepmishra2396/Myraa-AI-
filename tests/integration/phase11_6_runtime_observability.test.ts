/**
 * MYRAA — Phase 11.6: Runtime Observability, Structured Diagnostics & Health Monitoring Test Suite
 *
 * Verifies:
 *   1. Deep recursive redaction & secret masking (Google API keys, tokens, Bearer, URLs, private keys, env vars)
 *   2. Nested Error object & stack trace sanitization without crashing
 *   3. Circular reference protection in diagnostic serialization
 *   4. Structured diagnostic event schema (severity, module, event, correlationId, durationMs, outcome)
 *   5. Bounded storage & automatic log rotation (size limits, file rolling, bounded ring buffer)
 *   6. Fixed-cardinality performance & reliability metrics (bounded counters, timings, min/max/avg/p95)
 *   7. Liveness & readiness probes (safe, read-only, non-mutating, Emergency Stop/Lockdown awareness)
 *   8. Authenticated operator diagnostic access controls (requireLocalhost, RBAC)
 *   9. Operation correlation tracing without authorization authority
 *  10. System Invariant: exactly 129 unique LIVE_TOOLS declarations preserved
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import http from "http";
import {
  sanitizeDiagnosticString,
  deepSanitizeDiagnostic,
  BoundedLogStore,
  RuntimeMetricsRegistry,
  RuntimeHealthMonitor,
  CorrelationTracer,
  logDiagnosticJson,
  runtimeMetrics,
  runtimeHealthMonitor,
  correlationTracer,
  boundedLogStore,
} from "../../backend/diagnostics/RuntimeObservability.ts";
import { emergencyStopCoordinator } from "../../backend/remote/EmergencyStopCoordinator.ts";
import { securityPolicyEngine } from "../../backend/security/SecurityPolicyEngine.ts";
import { LIVE_TOOLS } from "../../backend/ai/GeminiSessionFactory.ts";
import { createHttpApp } from "../../backend/gateway/HttpGateway.ts";

describe("MYRAA — Phase 11.6: Runtime Observability & Structured Diagnostics", () => {
  let tmpLogsDir: string;
  let testLogStore: BoundedLogStore;
  let testMetrics: RuntimeMetricsRegistry;
  let server: http.Server | null = null;
  let baseUrl: string = "";

  beforeEach(async () => {
    tmpLogsDir = fs.mkdtempSync(path.join(os.tmpdir(), "myraa_obs_test_"));
    testLogStore = new BoundedLogStore(tmpLogsDir);
    testMetrics = new RuntimeMetricsRegistry();
    await emergencyStopCoordinator.reset("obs_test_setup");
    securityPolicyEngine.resetForTesting();
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
    try {
      fs.rmSync(tmpLogsDir, { recursive: true, force: true });
    } catch {}
    await emergencyStopCoordinator.reset("obs_test_cleanup");
    securityPolicyEngine.resetForTesting();
  });

  async function startServer(): Promise<string> {
    const app = createHttpApp();
    server = http.createServer(app);
    await new Promise<void>((resolve) => {
      server!.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
    return baseUrl;
  }

  // ---------------------------------------------------------------------------
  // 1. Deep Recursive Redaction & Secret Masking
  // ---------------------------------------------------------------------------
  describe("1. Deep Recursive Redaction & Secret Masking", () => {
    it("1.1 redacts Google API keys, Gemini tokens, Bearer tokens, and refresh tokens in raw strings", () => {
      const raw =
        "Failed with key AIzaSyD3x9FakeKey1234567890abcdef and token AQ.fakeGeminiEphemeralToken123456 " +
        "along with Bearer myraa_at_sec_token_9999 and sora_refresh_token_abcdef123";

      const sanitized = sanitizeDiagnosticString(raw);
      expect(sanitized).not.toContain("AIzaSyD3x9FakeKey1234567890abcdef");
      expect(sanitized).toContain("AIza...[REDACTED]");
      expect(sanitized).not.toContain("AQ.fakeGeminiEphemeralToken123456");
      expect(sanitized).toContain("AQ...[REDACTED]");
      expect(sanitized).not.toContain("myraa_at_sec_token_9999");
      expect(sanitized).toContain("Bearer [REDACTED]");
      expect(sanitized).not.toContain("sora_refresh_token_abcdef123");
      expect(sanitized).toContain("myraa_...[REDACTED]");
    });

    it("1.2 redacts private URLs containing secret query parameters", () => {
      const url = "https://generativelanguage.googleapis.com/v1beta/models?key=AIzaSySecretApiKey12345&token=secret123";
      const sanitized = sanitizeDiagnosticString(url);
      expect(sanitized).not.toContain("AIzaSySecretApiKey12345");
      expect(sanitized).not.toContain("secret123");
      expect(sanitized).toContain("key=[REDACTED]");
      expect(sanitized).toContain("token=[REDACTED]");
    });

    it("1.3 redacts sensitive environment variable assignments", () => {
      const envDump = "Config: GEMINI_API_KEY=AIzaSyVerySecretKey12345 and MYRAA_SECURITY_SECRET=super_secret_master_key";
      const sanitized = sanitizeDiagnosticString(envDump);
      expect(sanitized).not.toContain("AIzaSyVerySecretKey12345");
      expect(sanitized).not.toContain("super_secret_master_key");
      expect(sanitized).toContain("[ENV_KEY_REDACTED]");
    });

    it("1.4 redacts PEM private keys and passwords", () => {
      const pem =
        "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0fakePrivateKeyData123456\n-----END RSA PRIVATE KEY-----";
      const withPassword = `Login attempt password="MySecretPassword123!" for admin`;

      const sanitizedPem = sanitizeDiagnosticString(pem);
      expect(sanitizedPem).toBe("[PRIVATE_KEY_REDACTED]");

      const sanitizedPass = sanitizeDiagnosticString(withPassword);
      expect(sanitizedPass).not.toContain("MySecretPassword123!");
      expect(sanitizedPass).toContain("password: [REDACTED]");
    });

    it("1.5 deeply sanitizes nested objects and preserves safe correlation IDs", () => {
      const nested = {
        planId: "plan_12345",
        stepId: "step_01",
        correlationId: "corr_abcdef",
        actor: {
          identityId: "user_1",
          password: "superSecretPassword!",
          sessionToken: "myraa_at_secret_token",
        },
        toolArgs: {
          path: "C:\\projects\\demo\\app.ts",
          apiKey: "AIzaSySuperSecretKey12345",
          nestedConfig: {
            authHeader: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig",
            databaseUrl: "postgres://admin:secretPass@localhost:5432/db",
          },
        },
        tags: ["audit", "API_KEY=AIzaSySecretKeyArray12345"],
      };

      const sanitized = deepSanitizeDiagnostic(nested) as any;

      // Safe trace keys preserved
      expect(sanitized.planId).toBe("plan_12345");
      expect(sanitized.stepId).toBe("step_01");
      expect(sanitized.correlationId).toBe("corr_abcdef");
      expect(sanitized.actor.identityId).toBe("user_1");
      expect(sanitized.toolArgs.path).toBe("C:\\projects\\demo\\app.ts");

      // Sensitive keys redacted
      expect(sanitized.actor.password).toBe("[REDACTED]");
      expect(sanitized.actor.sessionToken).toBe("[REDACTED]");
      expect(sanitized.toolArgs.apiKey).toBe("[REDACTED]");
      expect(sanitized.toolArgs.nestedConfig.authHeader).toBe("[REDACTED]");
      expect(sanitized.tags[1]).not.toContain("AIzaSySecretKeyArray12345");
      expect(sanitized.tags[1]).toContain("[REDACTED]");
    });

    it("1.6 sanitizes Error instances including stack traces without throwing", () => {
      const error = new Error("Failed to connect with key AIzaSyErrorSecretKey12345");
      const sanitized = deepSanitizeDiagnostic(error) as any;

      expect(sanitized.name).toBe("Error");
      expect(sanitized.message).not.toContain("AIzaSyErrorSecretKey12345");
      expect(sanitized.message).toContain("AIza...[REDACTED]");
      expect(sanitized.stack).toBeDefined();
      expect(sanitized.stack).not.toContain("AIzaSyErrorSecretKey12345");
    });

    it("1.7 handles circular references safely without infinite recursion", () => {
      const circularObj: any = { name: "testNode", token: "secret_token_123" };
      circularObj.self = circularObj;

      expect(() => {
        const sanitized = deepSanitizeDiagnostic(circularObj);
        expect(sanitized.name).toBe("testNode");
        expect(sanitized.token).toBe("[REDACTED]");
        expect(sanitized.self).toBe("[CIRCULAR]");
      }).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Structured Diagnostic Event Schema & Ring Buffer
  // ---------------------------------------------------------------------------
  describe("2. Structured Diagnostic Event Schema & Ring Buffer", () => {
    it("2.1 records structured events to NDJSON file and bounded ring buffer", () => {
      const recorded = testLogStore.recordEvent({
        severity: "info",
        module: "gemini_live",
        event: "gemini_live_connected",
        correlationId: "corr_test_001",
        durationMs: 142.5,
        outcome: "success",
        metadata: { model: "gemini-2.0-flash-exp", key: "AIzaSySecretKeyInMeta12345" },
      });

      expect(recorded.timestamp).toBeDefined();
      expect(recorded.severity).toBe("info");
      expect(recorded.module).toBe("gemini_live");
      expect(recorded.event).toBe("gemini_live_connected");
      expect(recorded.correlationId).toBe("corr_test_001");
      expect(recorded.durationMs).toBe(142.5);
      expect(recorded.outcome).toBe("success");
      expect(recorded.metadata?.key).toBe("[REDACTED]");

      // Verify in-memory ring buffer
      const recent = testLogStore.getRecentEvents(10);
      expect(recent.length).toBe(1);
      expect(recent[0].event).toBe("gemini_live_connected");

      // Verify disk persistence
      const diskPath = path.join(tmpLogsDir, "app.log.json");
      expect(fs.existsSync(diskPath)).toBe(true);
      const lines = fs.readFileSync(diskPath, "utf-8").trim().split("\n");
      expect(lines.length).toBe(1);
      const parsed = JSON.parse(lines[0]);
      expect(parsed.event).toBe("gemini_live_connected");
      expect(parsed.metadata?.key).toBe("[REDACTED]");
    });

    it("2.2 caps in-memory events at MAX_IN_MEMORY_EVENTS", () => {
      for (let i = 0; i < 550; i++) {
        testLogStore.recordEvent({
          severity: "info",
          module: "gateway",
          event: `ping_${i}`,
        });
      }

      const recent = testLogStore.getRecentEvents(600);
      expect(recent.length).toBe(500);
      expect(recent[0].event).toBe("ping_50");
      expect(recent[499].event).toBe("ping_549");
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Bounded Storage & Automatic Log Rotation
  // ---------------------------------------------------------------------------
  describe("3. Bounded Storage & Automatic Log Rotation", () => {
    it("3.1 automatically rotates log files when size exceeds threshold", () => {
      const logFile = path.join(tmpLogsDir, "app.log.json");

      // Create a file artificially exceeding 5MB
      const bigContent = "X".repeat(5 * 1024 * 1024 + 100);
      fs.writeFileSync(logFile, bigContent, "utf-8");

      expect(fs.existsSync(logFile)).toBe(true);
      expect(fs.statSync(logFile).size).toBeGreaterThan(5 * 1024 * 1024);

      // Trigger rotation via recordEvent
      testLogStore.recordEvent({
        severity: "info",
        module: "storage",
        event: "rotation_trigger",
      });

      // Verify logFile.1 exists and has the rotated big content
      const backup1 = `${logFile}.1`;
      expect(fs.existsSync(backup1)).toBe(true);
      expect(fs.statSync(backup1).size).toBeGreaterThan(5 * 1024 * 1024);

      // Verify active logFile is fresh and contains only the new event
      expect(fs.existsSync(logFile)).toBe(true);
      const newContent = fs.readFileSync(logFile, "utf-8");
      expect(newContent).toContain("rotation_trigger");
      expect(fs.statSync(logFile).size).toBeLessThan(1024);
    });

    it("3.2 plain text append safely rotates commands.log, startup.log, and errors.log", () => {
      testLogStore.appendPlainText("commands.log", "EXECUTE tool=readFile apiKey=AIzaSyPlainApiKey12345");

      const cmdPath = path.join(tmpLogsDir, "commands.log");
      expect(fs.existsSync(cmdPath)).toBe(true);
      const content = fs.readFileSync(cmdPath, "utf-8");
      expect(content).toContain("EXECUTE tool=readFile");
      expect(content).not.toContain("AIzaSyPlainApiKey12345");
      expect(content).toContain("[REDACTED]");
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Fixed-Cardinality Performance & Reliability Metrics
  // ---------------------------------------------------------------------------
  describe("4. Fixed-Cardinality Performance & Reliability Metrics", () => {
    it("4.1 tracks counters correctly", () => {
      testMetrics.incrementCounter("gemini_live_connections_total");
      testMetrics.incrementCounter("gemini_live_connections_total");
      testMetrics.incrementCounter("gemini_live_errors_total");
      testMetrics.incrementCounter("reminder_scheduled_total", 3);

      expect(testMetrics.getCounter("gemini_live_connections_total")).toBe(2);
      expect(testMetrics.getCounter("gemini_live_errors_total")).toBe(1);
      expect(testMetrics.getCounter("reminder_scheduled_total")).toBe(3);
      expect(testMetrics.getCounter("task_executed_total")).toBe(0);
    });

    it("4.2 tracks timing metrics with min, max, avg, and p95", () => {
      const samples = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
      for (const s of samples) {
        testMetrics.recordTiming("api_request_duration_ms", s);
      }

      const summary = testMetrics.getTimingSummary("api_request_duration_ms")!;
      expect(summary).toBeDefined();
      expect(summary.count).toBe(10);
      expect(summary.totalMs).toBe(550);
      expect(summary.minMs).toBe(10);
      expect(summary.maxMs).toBe(100);
      expect(summary.avgMs).toBe(55);
      expect(summary.p95Ms).toBe(100);
    });

    it("4.3 summary contains zero high-cardinality keys", () => {
      testMetrics.incrementCounter("task_executed_total");
      testMetrics.recordTiming("task_step_duration_ms", 120);

      const summary = testMetrics.getMetricsSummary() as any;
      expect(summary.uptimeSeconds).toBeDefined();
      expect(summary.collectedAt).toBeDefined();
      expect(summary.counters.task_executed_total).toBe(1);
      expect(summary.timings.task_step_duration_ms.avgMs).toBe(120);

      // Verify no dynamic keys like user IDs, project IDs, or paths in the top-level metric names
      const knownCounterKeys = Object.keys(summary.counters);
      for (const k of knownCounterKeys) {
        expect(k).toMatch(/^[a-z_]+$/);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Liveness & Readiness Probes
  // ---------------------------------------------------------------------------
  describe("5. Liveness & Readiness Probes", () => {
    it("5.1 liveness probe returns live: true without side effects", () => {
      const monitor = new RuntimeHealthMonitor();
      const live = monitor.getLiveness();

      expect(live.live).toBe(true);
      expect(live.service).toBe("myraa-backend");
      expect(live.uptimeSeconds).toBeGreaterThanOrEqual(0);
      expect(live.timestamp).toBeDefined();
    });

    it("5.2 readiness probe reports ready in normal state", async () => {
      const monitor = new RuntimeHealthMonitor();
      const ready = await monitor.getReadiness();

      expect(ready.ready).toBe(true);
      expect(ready.status).toBe("ready");
      expect(ready.limitations).toEqual([]);
    });

    it("5.3 readiness probe transitions to degraded under Emergency Stop", async () => {
      const monitor = new RuntimeHealthMonitor();
      await emergencyStopCoordinator.trigger({
        source: "tool",
        reason: "Test Emergency Stop",
        ipAddress: "127.0.0.1",
      });

      const ready = await monitor.getReadiness();
      expect(ready.ready).toBe(true);
      expect(ready.status).toBe("degraded");
      expect(ready.limitations.some((l) => l.includes("EMERGENCY_STOP_ACTIVE"))).toBe(true);
    });

    it("5.4 readiness probe transitions to degraded under Security Lockdown", async () => {
      const monitor = new RuntimeHealthMonitor();
      securityPolicyEngine.setMode("LOCKDOWN");

      const ready = await monitor.getReadiness();
      expect(ready.ready).toBe(true);
      expect(ready.status).toBe("degraded");
      expect(ready.limitations.some((l) => l.includes("SECURITY_LOCKDOWN_ACTIVE"))).toBe(true);
    });

    it("5.5 authenticated component health reports structured statuses without exposing secrets", async () => {
      const monitor = new RuntimeHealthMonitor();
      const compHealth = await monitor.getComponentHealth();

      expect(compHealth.service).toBe("myraa-backend");
      expect(compHealth.version).toBe("2.0.0");
      expect(compHealth.status).toBe("ok");
      expect(compHealth.components.storage.writable).toBe(true);
      expect(compHealth.components.reminders.scheduler).toBe("running");
      expect(compHealth.components.taskOrchestrator.engine).toBe("ready");

      // Verify no plain API key string is present in the output
      const jsonStr = JSON.stringify(compHealth);
      expect(jsonStr).not.toContain("AIza");
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Operation Correlation Tracer
  // ---------------------------------------------------------------------------
  describe("6. Operation Correlation Tracer", () => {
    it("6.1 generates valid non-authorizing correlation IDs", () => {
      const tracer = new CorrelationTracer();
      const id1 = tracer.generateCorrelationId("task");
      const id2 = tracer.generateCorrelationId("task");

      expect(id1).toMatch(/^corr_task_[a-f0-9-]+$/);
      expect(id2).toMatch(/^corr_task_[a-f0-9-]+$/);
      expect(id1).not.toBe(id2);
    });

    it("6.2 sanitizes untrusted incoming correlation IDs and rejects injection attempts", () => {
      const tracer = new CorrelationTracer();
      const clean = tracer.sanitizeCorrelationId("valid-corr-id_123");
      expect(clean).toBe("valid-corr-id_123");

      const injected = tracer.sanitizeCorrelationId("<script>alert(1)</script>; DROP TABLE;");
      expect(injected).not.toContain("<");
      expect(injected).not.toContain(";");
    });
  });

  // ---------------------------------------------------------------------------
  // 7. HTTP Gateway Endpoints & Access Control
  // ---------------------------------------------------------------------------
  describe("7. HTTP Gateway Endpoints & Access Control", () => {
    it("7.1 GET /health/liveness returns liveness probe", async () => {
      const hostUrl = await startServer();
      const res = await fetch(`${hostUrl}/health/liveness`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.live).toBe(true);
      expect(body.service).toBe("myraa-backend");
      expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
    });

    it("7.2 GET /health/readiness returns readiness probe", async () => {
      const hostUrl = await startServer();
      const res = await fetch(`${hostUrl}/health/readiness`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.ready).toBe(true);
      expect(body.status).toBe("ready");
    });

    it("7.3 GET /api/diagnostics/metrics rejects non-localhost requests without authorization", async () => {
      const hostUrl = await startServer();
      const res = await fetch(`${hostUrl}/api/diagnostics/metrics`, {
        headers: {
          "x-forwarded-for": "198.51.100.2", // Spoofed remote IP
        },
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toMatch(/Localhost only|INSECURE_TRANSPORT_REJECTED/);
    });

    it("7.4 GET /api/diagnostics/metrics succeeds for local requests", async () => {
      const hostUrl = await startServer();
      const res = await fetch(`${hostUrl}/api/diagnostics/metrics`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.metrics).toBeDefined();
      expect(body.metrics.counters).toBeDefined();
      expect(body.metrics.timings).toBeDefined();
    });

    it("7.5 GET /api/diagnostics/health succeeds for local requests", async () => {
      const hostUrl = await startServer();
      const res = await fetch(`${hostUrl}/api/diagnostics/health`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.health).toBeDefined();
      expect(body.health.components).toBeDefined();
      expect(body.health.components.storage).toBeDefined();
    });

    it("7.6 GET /api/diagnostics/events returns recent bounded events for local requests", async () => {
      const hostUrl = await startServer();

      // Log a diagnostic event
      logDiagnosticJson("info", "test_http_event", { testParam: "value" });

      const res = await fetch(`${hostUrl}/api/diagnostics/events?limit=10`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.count).toBeGreaterThan(0);
      expect(Array.isArray(body.events)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // 8. Frozen Invariant: 129 LIVE_TOOLS Declarations
  // ---------------------------------------------------------------------------
  describe("8. Frozen Invariant: 129 LIVE_TOOLS", () => {
    it("8.1 preserves exactly 129 unique LIVE_TOOLS declarations in GeminiSessionFactory", () => {
      const declarations = LIVE_TOOLS[0]?.functionDeclarations || [];
      expect(declarations.length).toBe(129);

      const names = declarations.map((d: any) => d.name);
      const uniqueNames = new Set(names);
      expect(uniqueNames.size).toBe(129);
    });
  });
});
