/**
 * Phase 10D — MYRAA Automatic Threat Containment & Tamper Detection Tests
 *
 * Verifies:
 *   1. Automatic Containment Pipeline:
 *      Threat Detected → Block Operation → Revoke Session → Disable Affected Tool → Terminate Remote Connection → Preserve Evidence → Alert User
 *   2. Idempotent Containment (no redundant actions / no loops)
 *   3. Independence of SECURITY_LOCKDOWN vs. Emergency Stop
 *   4. Dynamic Tool Disabling & Enforcement
 *   5. Remote Connection Termination
 *   6. Immutable Forensic Evidence & Zero Secret Leakage (DLP + non-instructional context)
 *   7. Tamper Detection: Modified files, Deleted files, Scoped Unexpected files
 *   8. Safeguard 1: Baseline HMAC Signature Verification on Startup (fails closed on invalid signature)
 *   9. Safeguard 2: Scoped unexpected file detection (zero false-positives on test/temp files)
 *  10. Safeguard 3: Controlled liftContainment() and rebaseline() via admin + local/step-up authorization
 *  11. Safeguard 4: Immutable/sanitized forensic evidence
 *  12. Baseline Immutability (tampered files never auto-accepted)
 *  13. Anti-Loop Containment Guarantee
 *  14. REST Endpoints for Containments and Integrity
 *  15. Exact 126 Gemini Live Tools Preservation
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "http";
import crypto from "crypto";
import {
  threatContainmentManager,
  ThreatContainmentManager,
} from "../ThreatContainmentManager.ts";
import {
  integrityMonitor,
  IntegrityMonitor,
} from "../IntegrityMonitor.ts";
import { securityPolicyEngine, LOCKDOWN_ALLOWLIST, POLICY_SIGNING_SECRET } from "../SecurityPolicyEngine.ts";
import { identityAuthManager } from "../IdentityAuthManager.ts";
import { securityAuditLogger } from "../SecurityAuditLogger.ts";
import { securityEventStream } from "../SecurityEventStream.ts";
import { securityMonitor } from "../SecurityMonitor.ts";
import { securityAlertManager } from "../SecurityAlertManager.ts";
import { remoteSessionManager } from "../../remote/RemoteSessionManager.ts";
import { emergencyStopCoordinator } from "../../remote/EmergencyStopCoordinator.ts";
import { createHttpApp } from "../../gateway/HttpGateway.ts";
import { LIVE_TOOLS } from "../../ai/GeminiSessionFactory.ts";
import type { SecurityContext, ThreatReport, BaselineManifest } from "../SecurityTypes.ts";

describe("Phase 10D — MYRAA Automatic Threat Containment & Tamper Detection", () => {
  const localAdminContext: SecurityContext = {
    identityId: "admin_sandeep",
    role: "admin",
    ipAddress: "127.0.0.1",
    isLocal: true,
  };

  const remoteAdminContext: SecurityContext = {
    identityId: "admin_remote",
    role: "admin",
    ipAddress: "192.168.1.55",
    isLocal: false,
    sessionId: "sess_remote_admin",
  };

  const guestContext: SecurityContext = {
    identityId: "guest_user",
    role: "guest",
    ipAddress: "10.0.0.99",
    isLocal: false,
  };

  beforeEach(() => {
    identityAuthManager.resetForTesting();
    securityPolicyEngine.resetForTesting();
    securityAuditLogger.resetForTesting();
    securityMonitor.resetForTesting();
    securityAlertManager.resetForTesting();
    threatContainmentManager.resetForTesting();
    integrityMonitor.resetForTesting();
  });

  afterEach(async () => {
    await emergencyStopCoordinator.reset("test cleanup");
  });

  // ===========================================================================
  // 1. AUTOMATIC THREAT CONTAINMENT PIPELINE
  // ===========================================================================
  describe("1. Automatic Threat Containment Pipeline", () => {
    it("executes the full deterministic containment sequence for high-confidence threats", async () => {
      // 1. Setup active session in IdentityAuthManager
      const { session } = identityAuthManager.createSession({
        deviceId: "dev_laptop",
        identityId: "attacker_user",
        role: "standard",
        ipAddress: "198.51.100.42",
      });

      // 2. Setup mock remote WebSocket connection
      let wsClosed = false;
      let closeCode = 0;
      let sentMessages: string[] = [];
      const mockWs = {
        send: (msg: string) => sentMessages.push(msg),
        close: (code: number) => {
          wsClosed = true;
          closeCode = code;
        },
        on: () => {},
      };

      remoteSessionManager.registerClient(
        mockWs,
        {
          id: "dev_laptop",
          name: "Laptop",
          deviceType: "desktop_client",
          role: "standard",
          tokenHash: "h",
          pairedAt: new Date().toISOString(),
          lastSeenAt: new Date().toISOString(),
          revoked: false,
        },
        "198.51.100.42",
        "TestAgent",
      );

      // 3. Trigger HIGH-confidence threat
      const threat: ThreatReport = {
        threatName: "DIRECTORY_TRAVERSAL_CAMPAIGN",
        severity: "CRITICAL",
        triggerEvent: "PATH_TRAVERSAL_ATTEMPT",
        occurrences: 2,
        windowMs: 60_000,
        actor: {
          identityId: "attacker_user",
          ipAddress: "198.51.100.42",
          sessionId: session.sessionId,
          deviceId: "dev_laptop",
        },
        target: {
          toolName: "readFile",
          resource: "../../etc/passwd",
        },
        mitigationAction: "LOCKDOWN_INITIATED",
        recommendedAction: "Quarantine actor and lock down workspace.",
        reason: "Detected repeated path traversal attempts",
      };

      const record = await threatContainmentManager.containThreat(threat);

      // Verify Containment Pipeline:
      // Threat Detected → Block Operation → Revoke Session → Disable Affected Tool → Terminate Remote Connection → Preserve Evidence → Alert User
      expect(record.active).toBe(true);
      expect(record.actionsTaken).toContain("BLOCK_OPERATION");
      expect(record.actionsTaken).toContain("REVOKE_SESSION");
      expect(record.actionsTaken).toContain("DISABLE_TOOL");
      expect(record.actionsTaken).toContain("TERMINATE_REMOTE");
      expect(record.actionsTaken).toContain("INITIATE_LOCKDOWN");
      expect(record.actionsTaken).toContain("PRESERVE_EVIDENCE");
      expect(record.actionsTaken).toContain("ALERT_USER");

      // Verify Session Revoked
      const revokedSession = identityAuthManager.getSession(session.sessionId);
      expect(revokedSession?.revoked).toBe(true);

      // Verify Affected Tool Disabled
      expect(securityPolicyEngine.isToolDisabled("readFile")).toBe(true);

      // Verify Remote Connection Terminated
      expect(wsClosed).toBe(true);
      expect(closeCode).toBe(4403);

      // Verify Security Lockdown Mode
      expect(securityPolicyEngine.getMode()).toBe("LOCKDOWN");

      // Verify Forensic Evidence Created
      expect(record.evidenceId).toBeDefined();
      const evidence = threatContainmentManager.getEvidence(record.evidenceId);
      expect(evidence).toBeDefined();
      expect(evidence?.threatName).toBe("DIRECTORY_TRAVERSAL_CAMPAIGN");
      expect(evidence?.evidenceHash).toBeDefined();

      // Verify Audit Event
      const recentAudits = securityAuditLogger.getRecentEvents(10);
      expect(recentAudits.some((a) => a.eventType === "CONTAINMENT_TRIGGERED")).toBe(true);
    });

    it("containment is strictly idempotent: duplicate triggers return existing record without repeated side-effects", async () => {
      const threat: ThreatReport = {
        threatName: "MALICIOUS_COMMAND_EXECUTION_ATTEMPT",
        severity: "CRITICAL",
        triggerEvent: "COMMAND_BLOCKED",
        occurrences: 1,
        windowMs: 0,
        actor: {
          identityId: "hacker",
          ipAddress: "203.0.113.11",
        },
        target: { toolName: "runShellCommand" },
        mitigationAction: "COMMAND_TERMINATED",
        recommendedAction: "Audit commands.",
        reason: "Blocked destructive shell command",
      };

      const record1 = await threatContainmentManager.containThreat(threat);
      const record2 = await threatContainmentManager.containThreat(threat);

      expect(record1.containmentId).toBe(record2.containmentId);
      expect(threatContainmentManager.getAllContainments().length).toBe(1);
    });
  });

  // ===========================================================================
  // 2. SECURITY_LOCKDOWN VS. EMERGENCY STOP INDEPENDENCE
  // ===========================================================================
  describe("2. SECURITY_LOCKDOWN vs. Emergency Stop Independence", () => {
    it("SECURITY_LOCKDOWN mode operates independently from Emergency Stop", async () => {
      expect(emergencyStopCoordinator.isActive()).toBe(false);
      expect(securityPolicyEngine.getMode()).toBe("BALANCED");

      // 1. Activate SECURITY_LOCKDOWN
      securityPolicyEngine.setMode("LOCKDOWN");
      expect(securityPolicyEngine.getMode()).toBe("LOCKDOWN");
      // Emergency Stop must remain inactive!
      expect(emergencyStopCoordinator.isActive()).toBe(false);

      // 2. Trigger Emergency Stop independently
      await emergencyStopCoordinator.trigger({ source: "tool", reason: "User hit big red button" });
      expect(emergencyStopCoordinator.isActive()).toBe(true);
      expect(securityPolicyEngine.getMode()).toBe("LOCKDOWN");

      // 3. Reset Emergency Stop: Lockdown must remain active!
      await emergencyStopCoordinator.reset("Operator cleared emergency stop");
      expect(emergencyStopCoordinator.isActive()).toBe(false);
      expect(securityPolicyEngine.getMode()).toBe("LOCKDOWN");

      // 4. Reset Lockdown: Emergency Stop must remain inactive!
      securityPolicyEngine.resetLockdown(localAdminContext);
      expect(securityPolicyEngine.getMode()).toBe("BALANCED");
      expect(emergencyStopCoordinator.isActive()).toBe(false);
    });

    it("explicitly allowlisted emergency tools remain executable during SECURITY_LOCKDOWN", async () => {
      securityPolicyEngine.setMode("LOCKDOWN");

      // Regular modifying or shell tool is fail-closed blocked
      const shellBlocked = await securityPolicyEngine.evaluateRequest(
        "runShellCommand",
        { command: "dir" },
        localAdminContext,
      );
      expect(shellBlocked.allowed).toBe(false);
      expect(shellBlocked.decision).toBe("BLOCK");

      // Regular read tool is fail-closed blocked
      const readBlocked = await securityPolicyEngine.evaluateRequest(
        "browserSearch",
        { query: "news" },
        localAdminContext,
      );
      expect(readBlocked.allowed).toBe(false);

      // Allowlisted emergency operations are permitted
      for (const allowedTool of LOCKDOWN_ALLOWLIST) {
        const allowed = await securityPolicyEngine.evaluateRequest(
          allowedTool,
          {},
          localAdminContext,
        );
        expect(allowed.allowed).toBe(true);
        expect(allowed.decision).toBe("ALLOW");
      }
    });
  });

  // ===========================================================================
  // 3. DYNAMIC TOOL DISABLING & RESTORATION
  // ===========================================================================
  describe("3. Dynamic Tool Disabling & Enforcement", () => {
    it("dynamically disables an individual tool and blocks execution requests", async () => {
      // Normal execution is allowed for admin
      const before = await securityPolicyEngine.evaluateRequest(
        "list_dir",
        { path: "." },
        localAdminContext,
      );
      expect(before.allowed).toBe(true);

      // Dynamically disable list_dir
      securityPolicyEngine.disableTool("list_dir", "Suspected enumeration attack");
      expect(securityPolicyEngine.isToolDisabled("list_dir")).toBe(true);

      // Subsequent execution is blocked
      const blocked = await securityPolicyEngine.evaluateRequest(
        "list_dir",
        { path: "." },
        localAdminContext,
      );
      expect(blocked.allowed).toBe(false);
      expect(blocked.decision).toBe("BLOCK");
      expect(blocked.reason).toContain("TOOL_DISABLED");

      // Other tools remain enabled
      const systemHealth = await securityPolicyEngine.evaluateRequest(
        "system_health",
        {},
        localAdminContext,
      );
      expect(systemHealth.allowed).toBe(true);

      // Re-enabling restores access
      const reEnabled = securityPolicyEngine.enableTool("list_dir", "admin");
      expect(reEnabled).toBe(true);
      expect(securityPolicyEngine.isToolDisabled("list_dir")).toBe(false);

      const after = await securityPolicyEngine.evaluateRequest(
        "list_dir",
        { path: "." },
        localAdminContext,
      );
      expect(after.allowed).toBe(true);
    });
  });

  // ===========================================================================
  // 4. FORENSIC EVIDENCE & ZERO-LEAKAGE INVARIANT (SAFEGUARD 4)
  // ===========================================================================
  describe("4. Forensic Evidence & Zero-Leakage Invariant (Safeguard 4)", () => {
    it("preserves immutable, sanitized forensic evidence and purges secrets", async () => {
      const sensitiveReason =
        "Actor supplied key AIzaSyLeakedSecretKey123456789 and Bearer myraa_at_jwt.secret.token with command rm -rf /";

      const threat: ThreatReport = {
        threatName: "MALICIOUS_COMMAND_EXECUTION_ATTEMPT",
        severity: "CRITICAL",
        triggerEvent: "COMMAND_BLOCKED",
        occurrences: 1,
        windowMs: 0,
        actor: { identityId: "infiltrator", ipAddress: "10.0.0.1" },
        target: { toolName: "runShellCommand" },
        mitigationAction: "COMMAND_TERMINATED",
        recommendedAction: "Review audit.",
        reason: sensitiveReason,
      };

      const record = await threatContainmentManager.containThreat(threat);
      const evidence = threatContainmentManager.getEvidence(record.evidenceId);

      expect(evidence).toBeDefined();
      expect(evidence?.immutable).toBe(true);
      expect(Object.isFrozen(evidence)).toBe(true);

      // Secrets must NOT be present in sanitizedDetails
      const detailsStr = JSON.stringify(evidence?.sanitizedDetails);
      expect(detailsStr).not.toContain("AIzaSyLeakedSecretKey123456789");
      expect(detailsStr).not.toContain("myraa_at_jwt.secret.token");

      // Evidence must be tagged as passive non-instructional data
      expect(evidence?.sanitizedDetails.isUntrustedData).toBe(true);
      expect(evidence?.sanitizedDetails.securityDirective).toBeDefined();

      // Verify SHA-256 evidence hash integrity
      expect(evidence?.evidenceHash).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  // ===========================================================================
  // 5. TAMPER DETECTION & INTEGRITY MONITOR
  // ===========================================================================
  describe("5. Tamper Detection & Integrity Monitor", () => {
    it("detects modification in a monitored file and activates lockdown", async () => {
      const baseline = integrityMonitor.getBaselineManifest();
      expect(baseline).toBeDefined();
      expect(baseline?.files).toBeDefined();

      // Pick a monitored file from baseline
      const targetFile = "src/backend/security/SecurityPolicyEngine.ts";
      expect(baseline?.files[targetFile]).toBeDefined();

      // Simulate tamper by injecting a modified hash into baseline
      const tamperedManifest: BaselineManifest = {
        ...baseline!,
        files: {
          ...baseline!.files,
          [targetFile]: { sha256: "0".repeat(64), size: 99999 }, // Fake hash
        },
      };
      // Re-sign with secret so signature itself is valid, but hash will mismatch real file
      tamperedManifest.signature = (integrityMonitor as any)._signFiles(tamperedManifest.files);
      integrityMonitor.setBaselineManifest(tamperedManifest);

      // Verify integrity
      const report = await integrityMonitor.verifyIntegrity({ quarantineOnTamper: true });
      expect(report.tampered).toBe(true);
      expect(report.violations.some((v) => v.filePath === targetFile && v.type === "MODIFIED")).toBe(true);

      // Automated containment must have activated LOCKDOWN
      expect(securityPolicyEngine.getMode()).toBe("LOCKDOWN");

      // Audit logger must record TAMPER_DETECTED
      const audits = securityAuditLogger.getRecentEvents(5);
      expect(audits.some((a) => a.eventType === "TAMPER_DETECTED")).toBe(true);
    });

    it("detects deletion of a monitored file", async () => {
      const baseline = integrityMonitor.getBaselineManifest();
      const fakeFile = "src/backend/security/NonExistentFileToDelete.ts";

      const tamperedManifest: BaselineManifest = {
        ...baseline!,
        files: {
          ...baseline!.files,
          [fakeFile]: { sha256: "a".repeat(64), size: 100 },
        },
      };
      tamperedManifest.signature = (integrityMonitor as any)._signFiles(tamperedManifest.files);
      integrityMonitor.setBaselineManifest(tamperedManifest);

      const report = await integrityMonitor.verifyIntegrity({ quarantineOnTamper: false });
      expect(report.tampered).toBe(true);
      expect(report.violations.some((v) => v.filePath === fakeFile && v.type === "DELETED")).toBe(true);
    });

    it("SAFEGUARD 1: refuses to trust baseline with invalid/tampered HMAC signature and fails closed", async () => {
      const baseline = integrityMonitor.getBaselineManifest();
      const forgedManifest: BaselineManifest = {
        ...baseline!,
        signature: "forged_invalid_signature_hex_1234567890abcdef",
      };
      integrityMonitor.setBaselineManifest(forgedManifest);

      const report = await integrityMonitor.verifyIntegrity({ quarantineOnTamper: true });
      expect(report.tampered).toBe(true);
      expect(report.baselineSignatureValid).toBe(false);
      expect(report.violations.some((v) => v.type === "SIGNATURE_INVALID")).toBe(true);
      expect(securityPolicyEngine.getMode()).toBe("LOCKDOWN");
    });

    it("SAFEGUARD 2: scopes UNEXPECTED_FILE detection to code files in security directory without false positives", async () => {
      const baseline = integrityMonitor.getBaselineManifest();
      const report = await integrityMonitor.verifyIntegrity({ quarantineOnTamper: false });

      // Clean workspace must have 0 violations (no false positives on tests or temp files)
      expect(report.tampered).toBe(false);
      expect(report.violations.length).toBe(0);
    });

    it("SAFEGUARD 3: rebaseline() requires admin + local/step-up authorization and updates HMAC signature", async () => {
      // 1. Guest attempt must be REJECTED
      const guestResult = await integrityMonitor.rebaseline(guestContext);
      expect(guestResult.success).toBe(false);
      expect(guestResult.reason).toContain("PERMISSION_DENIED");

      // 2. Remote admin without step-up must be REJECTED
      const remoteNoStepUp = await integrityMonitor.rebaseline(remoteAdminContext);
      expect(remoteNoStepUp.success).toBe(false);
      expect(remoteNoStepUp.reason).toContain("STEP_UP_REQUIRED");

      // 3. Local admin attempt SUCCEEDS
      const localResult = await integrityMonitor.rebaseline(localAdminContext);
      expect(localResult.success).toBe(true);
      expect(localResult.manifest).toBeDefined();
      expect(localResult.manifest?.signature).toBeDefined();

      // Audit logger must record BASELINE_UPDATED
      const audits = securityAuditLogger.getRecentEvents(5);
      expect(audits.some((a) => a.eventType === "BASELINE_UPDATED")).toBe(true);
    });

    it("tampered file is NEVER automatically accepted into baseline on verification", async () => {
      const originalBaseline = integrityMonitor.getBaselineManifest();
      const targetFile = "src/backend/security/SecurityPolicyEngine.ts";
      const originalHash = originalBaseline?.files[targetFile]?.sha256;

      // Run verification
      await integrityMonitor.verifyIntegrity({ quarantineOnTamper: false });

      // Baseline remains unchanged
      const baselineAfter = integrityMonitor.getBaselineManifest();
      expect(baselineAfter?.files[targetFile]?.sha256).toBe(originalHash);
    });
  });

  // ===========================================================================
  // 6. CONTROLLED CONTAINMENT LIFTING (SAFEGUARD 3)
  // ===========================================================================
  describe("6. Controlled Containment Lifting (Safeguard 3)", () => {
    it("strictly enforces admin authorization to lift containment and restore security mode", async () => {
      // 1. Trigger threat and containment
      const threat: ThreatReport = {
        threatName: "DIRECTORY_TRAVERSAL_CAMPAIGN",
        severity: "CRITICAL",
        triggerEvent: "PATH_TRAVERSAL_ATTEMPT",
        occurrences: 2,
        windowMs: 60000,
        actor: { identityId: "bad_actor", ipAddress: "1.2.3.4" },
        target: { toolName: "writeFile" },
        mitigationAction: "LOCKDOWN_INITIATED",
        recommendedAction: "Review path.",
        reason: "Directory traversal",
      };

      const record = await threatContainmentManager.containThreat(threat);
      expect(record.active).toBe(true);
      expect(securityPolicyEngine.getMode()).toBe("LOCKDOWN");
      expect(securityPolicyEngine.isToolDisabled("writeFile")).toBe(true);

      // 2. Guest attempt to lift containment is REJECTED
      const guestLift = await threatContainmentManager.liftContainment(record.containmentId, guestContext);
      expect(guestLift.success).toBe(false);
      expect(guestLift.reason).toContain("PERMISSION_DENIED");
      expect(securityPolicyEngine.getMode()).toBe("LOCKDOWN");

      // 3. Remote admin without step-up is REJECTED
      const remoteLiftNoStepUp = await threatContainmentManager.liftContainment(
        record.containmentId,
        remoteAdminContext,
      );
      expect(remoteLiftNoStepUp.success).toBe(false);
      expect(remoteLiftNoStepUp.reason).toContain("STEP_UP_REQUIRED");

      // 4. Authorized local admin lifts containment
      const adminLift = await threatContainmentManager.liftContainment(
        record.containmentId,
        localAdminContext,
      );
      expect(adminLift.success).toBe(true);

      // Tool re-enabled
      expect(securityPolicyEngine.isToolDisabled("writeFile")).toBe(false);

      // Lockdown restored to BALANCED
      expect(securityPolicyEngine.getMode()).toBe("BALANCED");

      // Containment record marked inactive
      expect(threatContainmentManager.getActiveContainments().length).toBe(0);

      // Audit logged
      const audits = securityAuditLogger.getRecentEvents(5);
      expect(audits.some((a) => a.eventType === "CONTAINMENT_LIFTED")).toBe(true);
    });
  });

  // ===========================================================================
  // 7. ANTI-LOOP GUARANTEE
  // ===========================================================================
  describe("7. Anti-Loop Guarantee", () => {
    it("containment actions never trigger recursive monitoring feedback loops", async () => {
      let threatDetectionCount = 0;
      securityMonitor.onThreatDetected(() => {
        threatDetectionCount++;
      });

      // Trigger threat
      await threatContainmentManager.containThreat({
        threatName: "MALICIOUS_COMMAND_EXECUTION_ATTEMPT",
        severity: "CRITICAL",
        triggerEvent: "COMMAND_BLOCKED",
        occurrences: 1,
        windowMs: 0,
        actor: { identityId: "attacker", ipAddress: "10.0.0.1" },
        target: { toolName: "runShellCommand" },
        mitigationAction: "COMMAND_TERMINATED",
        recommendedAction: "Check actor.",
        reason: "Blocked shell command",
      });

      // Exactly 0 threats should be triggered from the internal containment events
      expect(threatDetectionCount).toBe(0);
    });
  });

  // ===========================================================================
  // 8. REST API ENDPOINTS
  // ===========================================================================
  describe("8. REST API Endpoints", () => {
    it("GET /api/security/containments returns active and historical containments", async () => {
      await threatContainmentManager.containThreat({
        threatName: "DIRECTORY_TRAVERSAL_CAMPAIGN",
        severity: "CRITICAL",
        triggerEvent: "PATH_TRAVERSAL_ATTEMPT",
        occurrences: 2,
        windowMs: 60000,
        actor: { identityId: "hacker", ipAddress: "127.0.0.1" },
        target: { toolName: "readFile" },
        mitigationAction: "LOCKDOWN_INITIATED",
        recommendedAction: "Review paths.",
        reason: "Traversal",
      });

      const app = createHttpApp();
      const server = http.createServer(app);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as any).port;

      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/security/containments`);
        expect(res.status).toBe(200);
        const data = (await res.json()) as any;
        expect(data.success).toBe(true);
        expect(data.activeCount).toBe(1);
        expect(data.active[0].threatName).toBe("DIRECTORY_TRAVERSAL_CAMPAIGN");
        expect(data.disabledTools.length).toBeGreaterThanOrEqual(1);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it("POST /api/security/containments/lift lifts containment via REST", async () => {
      const record = await threatContainmentManager.containThreat({
        threatName: "DIRECTORY_TRAVERSAL_CAMPAIGN",
        severity: "CRITICAL",
        triggerEvent: "PATH_TRAVERSAL_ATTEMPT",
        occurrences: 2,
        windowMs: 60000,
        actor: { identityId: "bad_ip", ipAddress: "127.0.0.1" },
        target: { toolName: "readFile" },
        mitigationAction: "LOCKDOWN_INITIATED",
        recommendedAction: "Review paths.",
        reason: "Traversal",
      });

      const app = createHttpApp();
      const server = http.createServer(app);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as any).port;

      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/security/containments/lift`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ containmentId: record.containmentId }),
        });
        expect(res.status).toBe(200);
        const data = (await res.json()) as any;
        expect(data.success).toBe(true);
        expect(data.containmentId).toBe(record.containmentId);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it("GET /api/security/integrity and POST /api/security/integrity/verify report integrity status", async () => {
      const app = createHttpApp();
      const server = http.createServer(app);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as any).port;

      try {
        // GET status
        const getRes = await fetch(`http://127.0.0.1:${port}/api/security/integrity`);
        expect(getRes.status).toBe(200);
        const getData = (await getRes.json()) as any;
        expect(getData.success).toBe(true);
        expect(getData.baselineValid).toBe(true);
        expect(getData.monitoredFileCount).toBeGreaterThan(0);

        // POST verify
        const verifyRes = await fetch(`http://127.0.0.1:${port}/api/security/integrity/verify`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ quarantineOnTamper: false }),
        });
        expect(verifyRes.status).toBe(200);
        const verifyData = (await verifyRes.json()) as any;
        expect(verifyData.success).toBe(true);
        expect(verifyData.report.tampered).toBe(false);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  // ===========================================================================
  // 9. TOOL COUNT INTEGRITY (EXACTLY 126 TOOLS)
  // ===========================================================================
  describe("9. Tool Count Integrity", () => {
    it("preserves exactly 126 Gemini Live tools across all modules", () => {
      const tools = LIVE_TOOLS[0].functionDeclarations;
      expect(tools.length).toBe(126);
    });
  });
});
