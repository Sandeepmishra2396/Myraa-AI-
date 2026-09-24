/**
 * MYRAA — Phase 10C Test Suite: Security Monitoring & Real-Time Alert System
 *
 * Comprehensive adversarial verification for:
 *   1. Security Event Stream: Normalization, Severity, and Zero-Leakage Ingestion
 *   2. Deterministic Security Monitor (IDS): Correlation & Threshold Detection
 *   3. Anti-Loop Guarantee: Alert notifications never loop back into monitor
 *   4. Real-Time Security Alert Manager: Multi-sink dispatch (UI, Voice, Desktop, Webhook)
 *   5. Automated Containment: Session revocation, Quarantining, and fail-closed LOCKDOWN
 *   6. Rest API Endpoints: Alerts, Events, Status, and Mode Management
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "http";
import {
  securityEventStream,
  securityMonitor,
  securityAlertManager,
  securityAuditLogger,
  securityPolicyEngine,
  identityAuthManager,
  DEFAULT_MONITOR_THRESHOLDS,
  LOCKDOWN_ALLOWLIST,
  type MonitoringEventType,
  type SecurityAlert,
} from "../index.ts";
import { createHttpApp } from "../../gateway/HttpGateway.ts";

describe("Phase 10C — MYRAA Security Monitoring & Real-Time Alert System", () => {
  beforeEach(() => {
    securityAuditLogger.resetForTesting();
    securityEventStream.resetForTesting();
    securityMonitor.resetForTesting();
    securityAlertManager.resetForTesting();
    securityPolicyEngine.resetForTesting();
    identityAuthManager.resetForTesting();
  });

  afterEach(() => {
    securityAlertManager.clearAlerts();
  });

  // ===========================================================================
  // 1. EVENT DETECTION & NORMALIZATION
  // ===========================================================================
  describe("1. Event Detection & Normalization", () => {
    const eventTypes: MonitoringEventType[] = [
      "LOGIN_FAILED",
      "UNKNOWN_DEVICE",
      "TOKEN_REUSE",
      "SUSPICIOUS_TOOL_CALL",
      "PROMPT_INJECTION_DETECTED",
      "UNTRUSTED_FILE",
      "PATH_TRAVERSAL_ATTEMPT",
      "COMMAND_BLOCKED",
      "UNUSUAL_NETWORK_REQUEST",
      "MULTIPLE_PERMISSION_FAILURES",
      "REMOTE_SESSION_ANOMALY",
      "DATA_ACCESS_ANOMALY",
      "SECURITY_POLICY_VIOLATION",
    ];

    it("normalizes and classifies every required monitoring event type with deterministic severity", () => {
      for (const eventType of eventTypes) {
        const event = securityEventStream.publish({
          eventType,
          actor: {
            identityId: "test_actor",
            role: "standard",
            ipAddress: "192.168.1.100",
          },
          summary: `Test event for ${eventType}`,
        });

        expect(event.id).toBeDefined();
        expect(event.eventType).toBe(eventType);
        expect(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).toContain(event.severity);
        expect(event.timestamp).toBeGreaterThan(0);
        expect(event.actor.isLocal).toBe(false);
      }

      // Check all 13 events are retained in recent buffer
      const recent = securityEventStream.getRecentEvents(50);
      expect(recent.length).toBe(13);
    });

    it("persists normalized events into the tamper-evident audit ledger with unbroken hash chain", () => {
      securityEventStream.publish({
        eventType: "LOGIN_FAILED",
        actor: { identityId: "user_a", role: "guest", ipAddress: "10.0.0.5" },
        summary: "Invalid password supplied",
      });

      securityEventStream.publish({
        eventType: "PROMPT_INJECTION_DETECTED",
        actor: { identityId: "external", role: "guest", ipAddress: "external" },
        summary: "DAN jailbreak detected",
      });

      const integrity = securityAuditLogger.verifyChainIntegrity();
      expect(integrity.valid).toBe(true);

      const logs = securityAuditLogger.getRecentEvents(10);
      expect(logs.length).toBeGreaterThanOrEqual(2);
      expect(logs[logs.length - 1].eventType).toBe("PROMPT_INJECTION_DETECTED");
    });
  });

  // ===========================================================================
  // 2. CORRELATION & THRESHOLD-BASED ANOMALY DETECTION
  // ===========================================================================
  describe("2. Correlation & Threshold-Based Anomaly Detection", () => {
    it("brute-force threshold: 1 or 2 failures do not trigger threat; 3rd failure triggers BRUTE_FORCE_BURST", () => {
      const threats: any[] = [];
      securityMonitor.onThreatDetected((t) => threats.push(t));

      // Attempt 1: Below threshold
      securityEventStream.publish({
        eventType: "LOGIN_FAILED",
        actor: { identityId: "admin", role: "guest", ipAddress: "203.0.113.19" },
        summary: "Failed password",
      });
      expect(threats.length).toBe(0);

      // Attempt 2: Still below threshold
      securityEventStream.publish({
        eventType: "LOGIN_FAILED",
        actor: { identityId: "admin", role: "guest", ipAddress: "203.0.113.19" },
        summary: "Failed password",
      });
      expect(threats.length).toBe(0);

      // Attempt 3: Hits threshold (3 within 60s)
      securityEventStream.publish({
        eventType: "LOGIN_FAILED",
        actor: { identityId: "admin", role: "guest", ipAddress: "203.0.113.19" },
        summary: "Failed password",
      });

      expect(threats.length).toBe(1);
      expect(threats[0].threatName).toBe("BRUTE_FORCE_BURST");
      expect(threats[0].severity).toBe("CRITICAL");
      expect(threats[0].occurrences).toBe(3);
      expect(threats[0].actor.ipAddress).toBe("203.0.113.19");
    });

    it("token reuse immediately triggers CREDENTIAL_REPLAY_ATTACK and revokes session", () => {
      // Create session in auth manager
      const { session } = identityAuthManager.createSession({
        deviceId: "dev_mobile_1",
        identityId: "sandeep",
        role: "admin",
        ipAddress: "192.168.1.50",
        userAgent: "Mobile Safari",
      });

      const threats: any[] = [];
      securityMonitor.onThreatDetected((t) => threats.push(t));

      // Trigger TOKEN_REUSE event
      securityEventStream.publish({
        eventType: "TOKEN_REUSE",
        actor: {
          identityId: "sandeep",
          role: "admin",
          ipAddress: "192.168.1.50",
          sessionId: session.sessionId,
          deviceId: "dev_mobile_1",
        },
        summary: "Token reuse detected on family fam_123",
      });

      expect(threats.length).toBe(1);
      expect(threats[0].threatName).toBe("CREDENTIAL_REPLAY_ATTACK");
      expect(threats[0].severity).toBe("CRITICAL");

      // Verify automated containment revoked the compromised session
      const refreshedSession = identityAuthManager.getSession(session.sessionId);
      expect(refreshedSession?.revoked).toBe(true);
    });

    it("directory traversal campaign: triggers DIRECTORY_TRAVERSAL_CAMPAIGN and initiates LOCKDOWN", () => {
      const threats: any[] = [];
      securityMonitor.onThreatDetected((t) => threats.push(t));

      // Attempt 1: Single attempt (threshold is 2)
      securityEventStream.publish({
        eventType: "PATH_TRAVERSAL_ATTEMPT",
        actor: { identityId: "remote_hacker", role: "guest", ipAddress: "198.51.100.22" },
        summary: "Directory traversal (..) detected in targetPath",
      });
      expect(threats.length).toBe(0);

      // Attempt 2: Reaches threshold (2 in 60s)
      securityEventStream.publish({
        eventType: "PATH_TRAVERSAL_ATTEMPT",
        actor: { identityId: "remote_hacker", role: "guest", ipAddress: "198.51.100.22" },
        summary: "Directory traversal (..) detected in targetPath",
      });

      expect(threats.length).toBe(1);
      expect(threats[0].threatName).toBe("DIRECTORY_TRAVERSAL_CAMPAIGN");
      expect(threats[0].severity).toBe("CRITICAL");

      // Verify automated containment activated fail-closed LOCKDOWN
      expect(securityPolicyEngine.getMode()).toBe("LOCKDOWN");
    });

    it("adversarial prompt-injection campaign: 2 injections within window triggers ADVERSARIAL_INJECTION_CAMPAIGN", () => {
      const threats: any[] = [];
      securityMonitor.onThreatDetected((t) => threats.push(t));

      securityEventStream.publish({
        eventType: "PROMPT_INJECTION_DETECTED",
        actor: { identityId: "untrusted_web", role: "guest", ipAddress: "127.0.0.1" },
        summary: "Instruction override detected",
      });
      expect(threats.length).toBe(0);

      securityEventStream.publish({
        eventType: "PROMPT_INJECTION_DETECTED",
        actor: { identityId: "untrusted_web", role: "guest", ipAddress: "127.0.0.1" },
        summary: "System prompt extraction detected",
      });

      expect(threats.length).toBe(1);
      expect(threats[0].threatName).toBe("ADVERSARIAL_INJECTION_CAMPAIGN");
      expect(threats[0].severity).toBe("CRITICAL");
    });

    it("malicious shell command execution attempt immediately triggers critical threat", () => {
      const threats: any[] = [];
      securityMonitor.onThreatDetected((t) => threats.push(t));

      securityEventStream.publish({
        eventType: "COMMAND_BLOCKED",
        severity: "CRITICAL",
        actor: { identityId: "caller_1", role: "admin", ipAddress: "127.0.0.1" },
        summary: "Blocked command: rm -rf /",
      });

      expect(threats.length).toBe(1);
      expect(threats[0].threatName).toBe("MALICIOUS_COMMAND_EXECUTION_ATTEMPT");
      expect(threats[0].severity).toBe("CRITICAL");
    });

    it("unknown device anomaly: triggers UNAUTHORIZED_DEVICE_ACCESS", () => {
      const threats: any[] = [];
      securityMonitor.onThreatDetected((t) => threats.push(t));

      securityEventStream.publish({
        eventType: "UNKNOWN_DEVICE",
        actor: {
          identityId: "rogue_device",
          role: "guest",
          ipAddress: "192.168.1.99",
          deviceId: "unknown_phone_uuid",
        },
        summary: "Unrecognized device attempted connection",
      });

      expect(threats.length).toBe(1);
      expect(threats[0].threatName).toBe("UNAUTHORIZED_DEVICE_ACCESS");
      expect(threats[0].severity).toBe("HIGH");
    });

    it("deterministic custom thresholds are respected", () => {
      // Set failedLoginsThreshold to 5 instead of 3
      securityMonitor.setThresholds({ failedLoginsThreshold: 5 });

      const threats: any[] = [];
      securityMonitor.onThreatDetected((t) => threats.push(t));

      // Fire 3 failed logins
      for (let i = 0; i < 3; i++) {
        securityEventStream.publish({
          eventType: "LOGIN_FAILED",
          actor: { identityId: "user_x", role: "guest", ipAddress: "10.10.10.10" },
          summary: "Wrong pass",
        });
      }
      expect(threats.length).toBe(0); // With threshold=5, 3 does not trigger!

      // 4th: Still 0
      securityEventStream.publish({
        eventType: "LOGIN_FAILED",
        actor: { identityId: "user_x", role: "guest", ipAddress: "10.10.10.10" },
        summary: "Wrong pass",
      });
      expect(threats.length).toBe(0);

      // 5th: Triggers threat exactly at 5
      securityEventStream.publish({
        eventType: "LOGIN_FAILED",
        actor: { identityId: "user_x", role: "guest", ipAddress: "10.10.10.10" },
        summary: "Wrong pass",
      });
      expect(threats.length).toBe(1);
      expect(threats[0].occurrences).toBe(5);
    });
  });

  // ===========================================================================
  // 3. ANTI-LOOP GUARANTEE
  // ===========================================================================
  describe("3. Anti-Loop Guarantee", () => {
    it("internal alert notifications never loop back into SecurityMonitor", () => {
      let monitorEvaluations = 0;
      securityEventStream.onEvent(() => {
        monitorEvaluations++;
      });

      // Directly publish an event flagged as an alert notification
      securityEventStream.publish({
        eventType: "SECURITY_POLICY_VIOLATION",
        isAlertNotification: true,
        actor: { identityId: "system", role: "admin", ipAddress: "127.0.0.1" },
        summary: "Notification of containment action",
      });

      // Directly evaluate on securityMonitor
      const threat = securityMonitor.evaluateEvent({
        id: "ev_alert_1",
        timestamp: Date.now(),
        eventType: "SECURITY_POLICY_VIOLATION",
        severity: "CRITICAL",
        actor: { identityId: "system", role: "admin", ipAddress: "127.0.0.1" },
        summary: "System alert notification",
        details: {},
        isAlertNotification: true,
      });

      // Guaranteed null — loop broken!
      expect(threat).toBeNull();
    });
  });

  // ===========================================================================
  // 4. REAL-TIME ALERT MANAGER & MULTI-SINK DISPATCH
  // ===========================================================================
  describe("4. Real-Time Alert Manager & Multi-Sink Dispatch", () => {
    it("dispatches alerts to UI, Voice, Desktop, and Webhook channels matching schema", () => {
      const uiAlerts: SecurityAlert[] = [];
      const voiceAlerts: any[] = [];
      const desktopAlerts: any[] = [];
      const webhookAlerts: SecurityAlert[] = [];

      securityAlertManager.on("ui_alert", (a) => uiAlerts.push(a));
      securityAlertManager.on("voice_alert", (v) => voiceAlerts.push(v));
      securityAlertManager.on("desktop_alert", (d) => desktopAlerts.push(d));
      securityAlertManager.registerNotificationHook((a) => {
        webhookAlerts.push(a);
      });

      // Trigger threat
      const alert = securityAlertManager.createAlertFromThreat({
        threatName: "BRUTE_FORCE_BURST",
        severity: "CRITICAL",
        triggerEvent: "LOGIN_FAILED",
        occurrences: 3,
        windowMs: 60_000,
        actor: {
          identityId: "admin",
          ipAddress: "192.0.2.1",
          sessionId: "sess_123",
          deviceId: "dev_unknown",
        },
        mitigationAction: "DEVICE_QUARANTINED",
        recommendedAction: "Lockout IP address and require re-authentication.",
        reason: "Detected 3 failed login attempts from IP 192.0.2.1.",
      });

      // Verify schema fields: Threat → Risk → Event → Action → Device/Session → Time → Recommended Action
      expect(alert.threat).toBe("BRUTE_FORCE_BURST");
      expect(alert.risk).toBe("CRITICAL");
      expect(alert.event).toBe("LOGIN_FAILED");
      expect(alert.action).toBe("DEVICE_QUARANTINED");
      expect(alert.deviceSession.ipAddress).toBe("192.0.2.1");
      expect(alert.deviceSession.sessionId).toBe("sess_123");
      expect(alert.deviceSession.deviceId).toBe("dev_unknown");
      expect(alert.timestamp).toBeGreaterThan(0);
      expect(alert.recommendedAction).toBeDefined();
      expect(alert.sanitizedSummary).toBeDefined();
      expect(alert.voiceAlertText).toContain("Sandeep");

      // Verify multi-sink delivery
      expect(uiAlerts.length).toBe(1);
      expect(voiceAlerts.length).toBe(1);
      expect(desktopAlerts.length).toBe(1);
      expect(webhookAlerts.length).toBe(1);

      // Verify dashboard retrieval
      const dashboardAlerts = securityAlertManager.getAlerts();
      expect(dashboardAlerts.length).toBe(1);
      expect(dashboardAlerts[0].alertId).toBe(alert.alertId);
    });

    it("WebSocket broadcast hook receives alert message payload", () => {
      let broadcasted: any = null;
      securityAlertManager.setWebSocketBroadcaster((msg) => {
        broadcasted = msg;
      });

      securityAlertManager.createAlertFromThreat({
        threatName: "UNAUTHORIZED_DEVICE_ACCESS",
        severity: "HIGH",
        triggerEvent: "UNKNOWN_DEVICE",
        occurrences: 1,
        windowMs: 0,
        actor: { identityId: "unknown", ipAddress: "192.168.1.25" },
        mitigationAction: "DEVICE_QUARANTINED",
        recommendedAction: "Verify physical device ownership.",
        reason: "Unknown device tried to connect.",
      });

      expect(broadcasted).toBeDefined();
      expect(broadcasted.type).toBe("security_alert");
      expect(broadcasted.alert.threat).toBe("UNAUTHORIZED_DEVICE_ACCESS");
    });

    it("supports alert acknowledgment via acknowledgeAlert", () => {
      const alert = securityAlertManager.createAlertFromThreat({
        threatName: "INSECURE_NETWORK_PROBING",
        severity: "HIGH",
        triggerEvent: "UNUSUAL_NETWORK_REQUEST",
        occurrences: 3,
        windowMs: 60000,
        actor: { identityId: "scanner", ipAddress: "198.51.100.99" },
        mitigationAction: "DEVICE_QUARANTINED",
        recommendedAction: "Block remote IP.",
        reason: "Multiple plain HTTP requests.",
      });

      expect(alert.acknowledged).toBe(false);

      const ok = securityAlertManager.acknowledgeAlert(alert.alertId);
      expect(ok).toBe(true);

      const unacknowledged = securityAlertManager.getAlerts(10, { unacknowledgedOnly: true });
      expect(unacknowledged.length).toBe(0);
    });
  });

  // ===========================================================================
  // 5. ZERO-LEAKAGE INVARIANT IN ALERTS
  // ===========================================================================
  describe("5. Zero-Leakage Invariant in Alerts", () => {
    it("guarantees alert summaries and voice notifications never contain raw API keys, tokens, or malicious commands", () => {
      const maliciousReason =
        "Actor supplied key AIzaSyTestLeakedKey9876543210 and token sora_tok_secret123456789 with command rm -rf /";

      const alert = securityAlertManager.createAlertFromThreat({
        threatName: "MALICIOUS_COMMAND_EXECUTION_ATTEMPT",
        severity: "CRITICAL",
        triggerEvent: "COMMAND_BLOCKED",
        occurrences: 1,
        windowMs: 0,
        actor: { identityId: "attacker", ipAddress: "10.0.0.1" },
        mitigationAction: "COMMAND_TERMINATED",
        recommendedAction: "Inspect actor credentials.",
        reason: maliciousReason,
      });

      // Plaintext secrets must NOT be present
      expect(alert.sanitizedSummary).not.toContain("AIzaSyTestLeakedKey9876543210");
      expect(alert.sanitizedSummary).not.toContain("sora_tok_secret123456789");
      expect(alert.sanitizedSummary).not.toContain("rm -rf /");

      expect(alert.voiceAlertText).not.toContain("AIzaSyTestLeakedKey9876543210");
      expect(alert.voiceAlertText).not.toContain("sora_tok_secret123456789");
      expect(alert.voiceAlertText).not.toContain("rm -rf /");
    });
  });

  // ===========================================================================
  // 6. FAIL-CLOSED LOCKDOWN BEHAVIOR
  // ===========================================================================
  describe("6. Fail-Closed LOCKDOWN Behavior", () => {
    it("blocks all tool executions in LOCKDOWN mode except allowlisted emergency recovery operations", async () => {
      securityPolicyEngine.setMode("LOCKDOWN");

      // Verify normal read-only or modifying tools are blocked
      const blocked1 = await securityPolicyEngine.evaluateRequest(
        "browserSearch",
        { query: "test" },
        { identityId: "admin", role: "admin", ipAddress: "127.0.0.1", isLocal: true },
      );
      expect(blocked1.allowed).toBe(false);
      expect(blocked1.decision).toBe("BLOCK");
      expect(blocked1.reason).toContain("SECURITY_LOCKDOWN");

      const blocked2 = await securityPolicyEngine.evaluateRequest(
        "runShellCommand",
        { command: "dir" },
        { identityId: "admin", role: "admin", ipAddress: "127.0.0.1", isLocal: true },
      );
      expect(blocked2.allowed).toBe(false);
      expect(blocked2.decision).toBe("BLOCK");

      // Verify explicitly allowlisted emergency operations are permitted
      for (const allowlistedTool of LOCKDOWN_ALLOWLIST) {
        const allowed = await securityPolicyEngine.evaluateRequest(
          allowlistedTool,
          {},
          { identityId: "admin", role: "admin", ipAddress: "127.0.0.1", isLocal: true },
        );
        expect(allowed.allowed).toBe(true);
        expect(allowed.decision).toBe("ALLOW");
      }
    });
  });

  // ===========================================================================
  // 7. REST API ENDPOINTS
  // ===========================================================================
  describe("7. REST API Endpoints", () => {
    it("GET /api/security/alerts returns list of sanitized alerts", async () => {
      securityAlertManager.createAlertFromThreat({
        threatName: "UNAUTHORIZED_DEVICE_ACCESS",
        severity: "HIGH",
        triggerEvent: "UNKNOWN_DEVICE",
        occurrences: 1,
        windowMs: 0,
        actor: { identityId: "rogue", ipAddress: "127.0.0.1" },
        mitigationAction: "DEVICE_QUARANTINED",
        recommendedAction: "Check pairing.",
        reason: "Device unauthorized.",
      });

      const app = createHttpApp();
      const server = http.createServer(app);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as any).port;

      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/security/alerts`);
        expect(res.status).toBe(200);
        const data = (await res.json()) as any;
        expect(data.success).toBe(true);
        expect(data.count).toBe(1);
        expect(data.alerts[0].threat).toBe("UNAUTHORIZED_DEVICE_ACCESS");
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it("POST /api/security/alerts/acknowledge acknowledges an alert by ID", async () => {
      const alert = securityAlertManager.createAlertFromThreat({
        threatName: "BRUTE_FORCE_BURST",
        severity: "CRITICAL",
        triggerEvent: "LOGIN_FAILED",
        occurrences: 3,
        windowMs: 60000,
        actor: { identityId: "bad_actor", ipAddress: "127.0.0.1" },
        mitigationAction: "DEVICE_QUARANTINED",
        recommendedAction: "Lockout IP.",
        reason: "3 failed logins.",
      });

      const app = createHttpApp();
      const server = http.createServer(app);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as any).port;

      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/security/alerts/acknowledge`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ alertId: alert.alertId }),
        });
        expect(res.status).toBe(200);
        const data = (await res.json()) as any;
        expect(data.success).toBe(true);
        expect(data.acknowledged).toBe(true);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it("GET /api/security/status returns monitoring health and threat counters", async () => {
      const app = createHttpApp();
      const server = http.createServer(app);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as any).port;

      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/security/status`);
        expect(res.status).toBe(200);
        const data = (await res.json()) as any;
        expect(data.success).toBe(true);
        expect(data.mode).toBe("BALANCED");
        expect(data.isLockdown).toBe(false);
        expect(data.auditChainIntact).toBe(true);
        expect(typeof data.activeAlertsCount).toBe("number");
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });
});
