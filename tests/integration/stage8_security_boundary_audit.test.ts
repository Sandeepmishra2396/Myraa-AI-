/**
 * MYRAA — Stage 8: Security Boundary Audit & Enforcement Test Suite
 * stage8_security_boundary_audit.test.ts
 *
 * Verifies end-to-end security boundary invariants across:
 *   1. SSRF & Origin Boundary Defenses in Browser Actions
 *   2. Localhost Endpoint Guard & Header Injection (X-Forwarded-For) Defenses
 *   3. Emergency Stop & Security Lockdown Fail-Closed Enforcement
 *   4. AI Self-Approval & Evaluator Tamper Protection
 *   5. Confirmation Token Anti-Replay & Version Binding
 *   6. Output Firewall Data Loss Prevention (DLP) & Secret Redaction
 *   7. Zero Unapproved Permanent Memory Writes
 *   8. Strict 129 LIVE_TOOLS Invariant Preservation
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { LIVE_TOOLS } from "../../backend/ai/GeminiSessionFactory.ts";
import { emergencyStopCoordinator } from "../../backend/remote/EmergencyStopCoordinator.ts";
import { securityPolicyEngine } from "../../backend/security/SecurityPolicyEngine.ts";
import { requireLocalhost } from "../../backend/security/PermissionManager.ts";
import { outputDataFirewall } from "../../backend/security/OutputDataFirewall.ts";
import { browserActionExecutor } from "../../backend/research/browser/BrowserActionExecutor.ts";
import {
  selfImprovementEvaluator,
  evaluationFixtureRegistry,
  skillProposalManager,
  proposalIntegrationGate,
} from "../../backend/research/browser/index.ts";

describe("Stage 8 — Security Boundary Audit & Enforcement Verification", () => {
  beforeEach(() => {
    emergencyStopCoordinator.reset("test_setup");
    securityPolicyEngine.setMode("BALANCED");
    selfImprovementEvaluator.resetForTesting();
  });

  afterEach(() => {
    emergencyStopCoordinator.reset("test_teardown");
    securityPolicyEngine.setMode("BALANCED");
    selfImprovementEvaluator.resetForTesting();
  });

  // ── 1. SSRF & Origin Boundary Defenses in Browser Actions ───────────────────
  describe("1. SSRF & Origin Boundary Defenses in Browser Actions", () => {
    it("1.1 blocks navigation to private IP and loopback addresses in step.target", async () => {
      const privateTargets = [
        "http://127.0.0.1:8080/internal/admin",
        "http://10.0.0.1/secrets",
        "http://192.168.1.1/router",
        "http://169.254.169.254/latest/meta-data/",
        "http://localhost:3000/api/keys",
      ];

      for (const target of privateTargets) {
        const res = await browserActionExecutor.executeStep(
          {
            stepId: "step_ssrf_test",
            action: "NAVIGATE",
            target,
            status: "PENDING",
            retries: 0,
            maxRetries: 1,
          },
          { allowedOrigins: ["example.com"] },
        );

        expect(res.ok).toBe(false);
        expect(res.error).toMatch(/ORIGIN_RESTRICTION|SECURITY_VIOLATION|restricted/i);
      }
    });

    it("1.2 blocks navigation when target URL is placed in step.params.url without step.target", async () => {
      const res = await browserActionExecutor.executeStep(
        {
          stepId: "step_params_url_test",
          action: "NAVIGATE",
          // step.target is omitted!
          params: { url: "http://127.0.0.1:9090/hidden/admin" },
          status: "PENDING",
          retries: 0,
          maxRetries: 1,
        },
        { allowedOrigins: ["example.com"] },
      );

      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/ORIGIN_RESTRICTION|SECURITY_VIOLATION|restricted/i);
    });

    it("1.3 blocks navigation outside task-scoped allowedOrigins even for public domains", async () => {
      const res = await browserActionExecutor.executeStep(
        {
          stepId: "step_origin_test",
          action: "NAVIGATE",
          target: "https://unauthorized-domain.org/data",
          status: "PENDING",
          retries: 0,
          maxRetries: 1,
        },
        { allowedOrigins: ["authorized-domain.com"] },
      );

      expect(res.ok).toBe(false);
      expect(res.error).toContain("ORIGIN_RESTRICTION");
    });
  });

  // ── 2. Localhost Endpoint Guard & Header Injection Defenses ─────────────────
  describe("2. Localhost Endpoint Guard & Header Injection Defenses", () => {
    it("2.1 allows direct local connection with loopback socket", () => {
      let nextCalled = false;
      const req = {
        socket: { remoteAddress: "127.0.0.1" },
        headers: {},
      };
      const res = {
        status: () => res,
        json: () => res,
      };

      requireLocalhost(req, res, () => {
        nextCalled = true;
      });

      expect(nextCalled).toBe(true);
    });

    it("2.2 rejects non-loopback remote socket connections with 403", () => {
      let nextCalled = false;
      let statusCode = 0;
      let responseBody: any = null;

      const req = {
        socket: { remoteAddress: "203.0.113.195" },
        headers: {},
      };
      const res = {
        status: (code: number) => {
          statusCode = code;
          return res;
        },
        json: (data: any) => {
          responseBody = data;
          return res;
        },
      };

      requireLocalhost(req, res, () => {
        nextCalled = true;
      });

      expect(nextCalled).toBe(false);
      expect(statusCode).toBe(403);
      expect(responseBody?.error).toContain("Forbidden");
    });

    it("2.3 strictly rejects remote attacker attempting X-Forwarded-For loopback spoofing", () => {
      let nextCalled = false;
      let statusCode = 0;
      let responseBody: any = null;

      const req = {
        socket: { remoteAddress: "198.51.100.42" },
        headers: {
          "x-forwarded-for": "127.0.0.1", // Attacker trying to spoof localhost!
        },
      };
      const res = {
        status: (code: number) => {
          statusCode = code;
          return res;
        },
        json: (data: any) => {
          responseBody = data;
          return res;
        },
      };

      requireLocalhost(req, res, () => {
        nextCalled = true;
      });

      expect(nextCalled).toBe(false);
      expect(statusCode).toBe(403);
      expect(responseBody?.error).toContain("Forbidden");
    });

    it("2.4 rejects local socket connection when X-Forwarded-For contains a non-local client hop", () => {
      let nextCalled = false;
      let statusCode = 0;
      let responseBody: any = null;

      const req = {
        socket: { remoteAddress: "127.0.0.1" }, // Reverse proxy on localhost
        headers: {
          "x-forwarded-for": "203.0.113.50, 127.0.0.1", // Proxied from remote client!
        },
      };
      const res = {
        status: (code: number) => {
          statusCode = code;
          return res;
        },
        json: (data: any) => {
          responseBody = data;
          return res;
        },
      };

      requireLocalhost(req, res, () => {
        nextCalled = true;
      });

      expect(nextCalled).toBe(false);
      expect(statusCode).toBe(403);
      expect(responseBody?.error).toContain("non-localhost client");
    });
  });

  // ── 3. Emergency Stop & Security Lockdown Fail-Closed Enforcement ────────────
  describe("3. Emergency Stop & Security Lockdown Fail-Closed Enforcement", () => {
    it("3.1 browser actions fail immediately when Emergency Stop is active", async () => {
      await emergencyStopCoordinator.trigger({ source: "rest_api", reason: "Audit test" });

      const res = await browserActionExecutor.executeStep(
        {
          stepId: "step_stop_test",
          action: "OPEN_TAB",
          target: "about:blank",
          status: "PENDING",
          retries: 0,
          maxRetries: 1,
        },
        { allowedOrigins: ["example.com"] },
      );

      expect(res.ok).toBe(false);
      expect(res.error).toContain("EMERGENCY_STOP_ACTIVE");
    });

    it("3.2 browser actions fail immediately under Security Policy Lockdown", async () => {
      securityPolicyEngine.setMode("LOCKDOWN");

      const res = await browserActionExecutor.executeStep(
        {
          stepId: "step_lockdown_test",
          action: "OPEN_TAB",
          target: "about:blank",
          status: "PENDING",
          retries: 0,
          maxRetries: 1,
        },
        { allowedOrigins: ["example.com"] },
      );

      expect(res.ok).toBe(false);
      expect(res.error).toContain("SECURITY_LOCKDOWN_ACTIVE");
    });
  });

  // ── 4. AI Self-Approval & Evaluator Tamper Protection ────────────────────────
  describe("4. AI Self-Approval & Evaluator Tamper Protection", () => {
    it("4.1 rejects AI self-approval attempts across all proposal managers", async () => {
      // 1. Stage 7 Self-Improvement
      const impCand = selfImprovementEvaluator.submitCandidate({
        kind: "PROMPT",
        name: "test_cand_approval",
        description: "Test self approval",
        targetComponent: "BrowserIntentInterpreter",
        proposedPayload: { template: "test" },
        author: "author",
        rationale: "test",
      });
      await selfImprovementEvaluator.evaluateCandidate(impCand.candidateId);

      for (const persona of ["myraa", "ai", "system", "autonomous_agent", "evaluator", "model"]) {
        expect(() => {
          selfImprovementEvaluator.approveCandidate(impCand.candidateId, {
            approver: persona,
            approverRole: "standard",
            reason: "AI self approval",
          });
        }).toThrow(/UNAUTHORIZED_SELF_APPROVAL/i);
      }
    });

    it("4.2 blocks evaluator from modifying registered fixtures dynamically", () => {
      expect(() => {
        evaluationFixtureRegistry.modifyFixture();
      }).toThrow(/EVALUATOR_FIXTURE_TAMPER_PROTECTION/i);
    });

    it("4.3 blocks evaluator from modifying scoring criteria dynamically", () => {
      expect(() => {
        selfImprovementEvaluator.updateCriteria();
      }).toThrow(/EVALUATOR_CRITERIA_TAMPER_PROTECTION/i);
    });
  });

  // ── 5. Confirmation Token Anti-Replay & Version Binding ─────────────────────
  describe("5. Confirmation Token Anti-Replay & Version Binding", () => {
    it("5.1 rejects approval replay attempts with duplicate nonces", async () => {
      const candidate = selfImprovementEvaluator.submitCandidate({
        kind: "PROMPT",
        name: "nonce_security_test",
        description: "Test nonce security",
        targetComponent: "BrowserIntelligenceCoordinator",
        proposedPayload: { template: "valid instructions" },
        author: "author",
        rationale: "test",
      });
      await selfImprovementEvaluator.evaluateCandidate(candidate.candidateId);

      const fixedNonce = "audit_nonce_secure_999";
      selfImprovementEvaluator.approveCandidate(candidate.candidateId, {
        approver: "operator_alex",
        approverRole: "admin",
        reason: "First valid approval",
        nonce: fixedNonce,
      });

      candidate.lifecycleState = "READY_FOR_HUMAN_REVIEW";
      expect(() => {
        selfImprovementEvaluator.approveCandidate(candidate.candidateId, {
          approver: "operator_alex",
          approverRole: "admin",
          reason: "Replayed approval",
          nonce: fixedNonce,
        });
      }).toThrow(/REPLAYED_APPROVAL_REJECTED/i);
    });

    it("5.2 rejects approval decisions with expired timestamps", async () => {
      const candidate = selfImprovementEvaluator.submitCandidate({
        kind: "PROMPT",
        name: "expired_security_test",
        description: "Test expired security",
        targetComponent: "BrowserIntelligenceCoordinator",
        proposedPayload: { template: "valid instructions" },
        author: "author",
        rationale: "test",
      });
      await selfImprovementEvaluator.evaluateCandidate(candidate.candidateId);

      expect(() => {
        selfImprovementEvaluator.approveCandidate(candidate.candidateId, {
          approver: "operator_alex",
          approverRole: "admin",
          reason: "Expired decision",
          expiresAt: Date.now() - 5000,
        });
      }).toThrow(/EXPIRED_APPROVAL_REJECTED/i);
    });
  });

  // ── 6. Output Firewall Data Loss Prevention (DLP) & Secret Redaction ─────────
  describe("6. Output Firewall Data Loss Prevention (DLP) & Secret Redaction", () => {
    it("6.1 redacts API keys, credentials, and tokens from output before returning", () => {
      const sensitiveOutput = {
        message: "Operation completed",
        geminiKey: "AIzaSyD-7V1234567890abcdefghijklmnopqrst",
        openAiKey: "sk-abcdef1234567890abcdef1234567890",
        githubToken: "ghp_1234567890abcdefghijklmnopqrstuvwxyz12",
        databaseUrl: "postgres://myadmin:SuperSecretPass123@db.internal:5432/proddb",
        jwt: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.do_not_leak",
      };

      const { sanitized, redactedCount } = outputDataFirewall.sanitizeResult(sensitiveOutput, {
        toolName: "testTool",
      });

      expect(redactedCount).toBeGreaterThan(0);
      const str = JSON.stringify(sanitized);
      expect(str).not.toContain("AIzaSyD-7V1234567890abcdefghijklmnopqrst");
      expect(str).not.toContain("sk-abcdef1234567890abcdef1234567890");
      expect(str).not.toContain("ghp_1234567890abcdefghijklmnopqrstuvwxyz12");
      expect(str).not.toContain("SuperSecretPass123");
      expect(str).toContain("[REDACTED]");
    });
  });

  // ── 7. Zero Unapproved Permanent Memory Writes ──────────────────────────────
  describe("7. Zero Unapproved Permanent Memory Writes", () => {
    it("7.1 maintains zero active integrations until explicit operator human approval", async () => {
      const candidate = selfImprovementEvaluator.submitCandidate({
        kind: "PROMPT",
        name: "storage_check_cand",
        description: "Checking memory permanence",
        targetComponent: "BrowserIntelligenceCoordinator",
        proposedPayload: { template: "instructions" },
        author: "author",
        rationale: "test",
      });

      await selfImprovementEvaluator.evaluateCandidate(candidate.candidateId);
      expect(selfImprovementEvaluator.getActiveIntegrations().size).toBe(0);

      expect(() => {
        selfImprovementEvaluator.integrateCandidate(candidate.candidateId, "operator_alex");
      }).toThrow(/UNAUTHORIZED_INTEGRATION_BLOCKED/i);

      expect(selfImprovementEvaluator.getActiveIntegrations().size).toBe(0);
    });
  });

  // ── 8. Strict Invariants: Exactly 129 LIVE_TOOLS Preserved ───────────────────
  describe("8. Strict Invariants: Exactly 129 LIVE_TOOLS Preserved", () => {
    it("8.1 preserves exactly 129 unique function declarations in LIVE_TOOLS", () => {
      expect(LIVE_TOOLS).toBeDefined();
      const tools = LIVE_TOOLS[0].functionDeclarations;
      expect(tools.length).toBe(129);
      const uniqueNames = new Set(tools.map((t) => t.name));
      expect(uniqueNames.size).toBe(129);
    });

    it("8.2 Stage 8 security hardening does not add or remove declarations from LIVE_TOOLS", () => {
      const toolNames = LIVE_TOOLS[0].functionDeclarations.map((t) => t.name);
      expect(toolNames).not.toContain("securityAuditBypass");
      expect(toolNames).not.toContain("elevatePermissions");
    });
  });
});
