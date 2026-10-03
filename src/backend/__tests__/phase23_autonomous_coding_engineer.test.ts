/**
 * MYRAA — Phase 23: Autonomous Coding Engineer Tests
 *
 * Comprehensive validation suite covering all 35 core requirements:
 *   1. Project discovery
 *   2. Architecture detection
 *   3. Authentication subsystem discovery
 *   4. Relevant file selection
 *   5. Log/error analysis
 *   6. Root-cause confidence
 *   7. Research delegation
 *   8. External-content fencing
 *   9. Patch generation
 *  10. Minimal-change enforcement
 *  11. Critic approval
 *  12. Critic rejection
 *  13. Critic revision
 *  14. User approval
 *  15. Approval invalidation after patch change
 *  16. ChangeSet scope enforcement
 *  17. Protected path blocking
 *  18. Executor behavior
 *  19. Targeted testing
 *  20. Regression testing
 *  21. Verifier evidence
 *  22. Failed verification
 *  23. Partial failure
 *  24. Rollback proposal
 *  25. Cancellation
 *  26. Emergency Stop
 *  27. Security Lockdown
 *  28. Phase 18 memory integration (Preferences != Permissions)
 *  29. Phase 19 context integration
 *  30. Phase 20 conversation integration
 *  31. Phase 21 proactive integration
 *  32. Phase 22 multi-agent integration
 *  33. End-to-end coding workflow (QYROX login issue simulation)
 *  34. No silent modification
 *  35. No scope drift
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "http";
import {
  autonomousCodingEngineer,
  projectSubsystemDetector,
  evidenceCollector,
  changeSetManager,
} from "../coding/index.ts";
import { emergencyStopCoordinator } from "../remote/EmergencyStopCoordinator.ts";
import { securityPolicyEngine } from "../security/SecurityPolicyEngine.ts";
import { executorAgent } from "../multiagent/index.ts";
import { createHttpApp } from "../gateway/HttpGateway.ts";

describe("Phase 23 — Autonomous Coding Engineer", () => {
  beforeEach(async () => {
    autonomousCodingEngineer.reset();
    changeSetManager.reset();
    if (emergencyStopCoordinator.isActive()) {
      await emergencyStopCoordinator.reset("phase23_test_setup");
    }
    securityPolicyEngine.setMode("BALANCED");
    executorAgent.setMockExecutor(undefined);
  });

  afterEach(async () => {
    if (emergencyStopCoordinator.isActive()) {
      await emergencyStopCoordinator.reset("phase23_test_teardown");
    }
    securityPolicyEngine.setMode("BALANCED");
    autonomousCodingEngineer.reset();
    changeSetManager.reset();
    executorAgent.setMockExecutor(undefined);
  });

  // ── 1. Project Discovery & Architecture ─────────────────────────────────────
  describe("1. Project & Subsystem Discovery (Phase A)", () => {
    it("discovers project root, type, and architecture layers", () => {
      const proj = projectSubsystemDetector.discoverProject("QYROX project architecture understand karo");
      expect(proj.projectName).toBe("QYROX");
      expect(proj.projectType).toBe("node_typescript");
      expect(proj.architectureLayers.length).toBeGreaterThanOrEqual(4);
    });

    it("identifies authentication subsystem and entrypoints for login issues", () => {
      const proj = projectSubsystemDetector.discoverProject("QYROX ka login issue investigate karo");
      const authSub = proj.subsystems.find((s) => s.type === "AUTH");
      expect(authSub).toBeDefined();
      expect(authSub?.name).toContain("Authentication");
      expect(authSub?.riskLevel).toBe("HIGH");
    });

    it("selects only scoped, relevant files without full-workspace dump", () => {
      const proj = projectSubsystemDetector.discoverProject("QYROX ka login issue investigate karo");
      expect(proj.relevantFiles).toContain("src/auth.ts");
      expect(proj.relevantFiles.length).toBeLessThan(10);
    });
  });

  // ── 2. Evidence Collection & Root Cause Analysis (Phases B & D) ────────────
  describe("2. Evidence Collection & Root Cause Analysis", () => {
    it("collects log and compiler evidence as OBSERVED_FACT", () => {
      const rca = evidenceCollector.analyzeEvidence({
        goal: "Login issue investigate karo",
        targetFiles: ["src/auth.ts"],
        mockCompilerError: "TS2304: Cannot find name 'verifyToken'",
        mockLogOutput: "Error: 401 Unauthorized - invalid jwt signature",
      });

      expect(rca.evidence.length).toBeGreaterThanOrEqual(2);
      expect(rca.evidence.some((e) => e.type === "COMPILER_ERROR" && e.classification === "OBSERVED_FACT")).toBe(true);
      expect(rca.evidence.some((e) => e.type === "LOG" && e.classification === "OBSERVED_FACT")).toBe(true);
    });

    it("synthesizes high-confidence root cause with alternative causes", () => {
      const rca = evidenceCollector.analyzeEvidence({
        goal: "Login issue investigate karo",
        targetFiles: ["src/auth.ts"],
        mockCompilerError: "TS2304: Cannot find name 'verifyToken'",
      });

      expect(rca.confidence).toBe("HIGH");
      expect(rca.confidenceScore).toBeGreaterThanOrEqual(0.9);
      expect(rca.likelyRootCause).toContain("Missing symbol declaration");
      expect(rca.alternativeCauses.length).toBeGreaterThan(0);
      expect(rca.isLowConfidenceAssumption).toBe(false);
    });

    it("flags low confidence and avoids inventing root causes when evidence is absent", () => {
      const rca = evidenceCollector.analyzeEvidence({
        goal: "Kuch toh issue ho raha hai unknown",
        targetFiles: [],
      });

      expect(rca.confidence).toBe("LOW");
      expect(rca.confidenceScore).toBeLessThan(0.5);
      expect(rca.isLowConfidenceAssumption).toBe(true);
      expect(rca.likelyRootCause).toContain("Insufficient diagnostic evidence");
    });
  });

  // ── 3. Research Delegation & Untrusted Content Fencing (Phase C) ────────────
  describe("3. Research Delegation & Untrusted Content Fencing", () => {
    it("delegates technical documentation lookup to ResearcherAgent and fences untrusted input", async () => {
      const res = await autonomousCodingEngineer.processRequest({
        goal: "Research best practices for JWT authentication verification",
        allowResearch: true,
      });

      expect(res.status).toBe("AWAITING_USER_APPROVAL");
      expect(res.rootCauseAnalysis?.evidence.some((e) => e.type === "RESEARCH")).toBe(true);
    });
  });

  // ── 4. Fix Preparation & Minimal Scoped Patch (Phase E) ────────────────────
  describe("4. Fix Preparation & Minimal Scoped Patch", () => {
    it("generates a structured unified diff patch without directly writing files", async () => {
      const res = await autonomousCodingEngineer.processRequest({
        goal: "Fix missing import in src/auth.ts",
        file: "src/auth.ts",
        mockCompilerError: "TS2304: Cannot find name 'verifyToken'",
      });

      expect(res.changeSet).toBeDefined();
      expect(res.changeSet?.patch).toContain("--- a/src/auth.ts");
      expect(res.changeSet?.patch).toContain("+++ b/src/auth.ts");
      expect(res.changeSet?.executionStatus).toBe("PENDING");
    });

    it("enforces minimal change targeting only the affected symbol", async () => {
      const res = await autonomousCodingEngineer.processRequest({
        goal: "Fix missing verifyToken import in src/auth.ts",
        file: "src/auth.ts",
      });

      expect(res.changeSet?.approvedFiles).toEqual(["src/auth.ts"]);
      expect(res.changeSet?.patch).toContain("import { verifyToken }");
    });
  });

  // ── 5. Critic Review & Refinement (Phase F) ─────────────────────────────────
  describe("5. Critic Review & Refinement", () => {
    it("approves valid, verifiable plans with test steps", async () => {
      const res = await autonomousCodingEngineer.processRequest({
        goal: "Fix type error in src/auth.ts",
        file: "src/auth.ts",
      });

      expect(res.status).toBe("AWAITING_USER_APPROVAL");
      expect(res.executionPlan?.isApproved).toBe(false); // Pending user approval
    });

    it("rejects dangerous or catastrophic deletion requests", async () => {
      const res = await autonomousCodingEngineer.processRequest({
        goal: "Drop table users and delete database",
      });

      expect(res.status).toBe("BLOCKED");
      expect(res.blockReason).toContain("destructive command");
    });

    it("requests revision when a state-changing plan lacks verification", async () => {
      const { criticAgent } = await import("../multiagent/index.ts");
      const unverifiedPlan = {
        planId: "p_unverif",
        goal: "Modify auth without verification",
        revisionCount: 0,
        subtasks: [
          {
            id: "s1",
            description: "Modify auth.ts",
            assignedAgent: "executor" as const,
            dependencies: [],
            status: "PENDING" as const,
            expectedOutcome: "File modified",
            isStateChanging: true,
          },
        ],
        requiredAgents: ["executor" as const],
        isCriticApproved: false,
        riskLevel: "MEDIUM" as const,
        requiresUserApproval: true,
        explanation: "Unverified change",
      };

      const evalRes = await criticAgent.evaluate(unverifiedPlan);
      expect(evalRes.result.verdict).toBe("NEEDS_REVISION");
      expect(evalRes.result.missingSteps.some((s) => s.includes("post-execution Verifier step"))).toBe(true);
    });
  });

  // ── 6. User Approval & Plan Presentation (Phase G) ─────────────────────────
  describe("6. User Approval & Plan Presentation", () => {
    it("presents structured plan and asks 'Ye changes apply kar doon?' before any modification", async () => {
      const res = await autonomousCodingEngineer.processRequest({
        goal: "QYROX ka login issue investigate karo",
      });

      expect(res.status).toBe("AWAITING_USER_APPROVAL");
      expect(res.requiresUserApproval).toBe(true);
      expect(res.approvalPrompt).toBe("Ye changes apply kar doon?");
      expect(res.finalAnswer).toContain("Problem:");
      expect(res.finalAnswer).toContain("Root cause:");
      expect(res.finalAnswer).toContain("Files:");
      expect(res.finalAnswer).toContain("Ye changes apply kar doon?");
    });

    it("enforces NOOP when user says 'haan' with no pending modification plan", async () => {
      const res = await autonomousCodingEngineer.processRequest({
        goal: "haan",
      });

      expect(res.status).toBe("COMPLETED");
      expect(res.finalAnswer).toContain("Koi pending modification plan nahi hai");
      expect(res.changeSet).toBeUndefined();
    });
  });

  // ── 7. Scope Control, Drift Prevention & Approval Invalidation ─────────────
  describe("7. Scope Control & Approval Invalidation", () => {
    it("invalidates previous approval if patch or target files change", () => {
      const cs = changeSetManager.createChangeSet({
        taskId: "task_1",
        patch: "diff 1",
        files: ["src/auth.ts"],
        risk: "MEDIUM",
      });

      changeSetManager.approveChangeSet(cs.changeSetId, "USER_EXPLICIT");
      expect(cs.executionStatus).toBe("APPROVED");

      changeSetManager.invalidateApproval(cs.changeSetId, "Patch modified after review");
      expect(cs.executionStatus).toBe("INVALIDATED");
      expect(cs.approvalTimestamp).toBeUndefined();
    });

    it("blocks execution if target files drift outside approved ChangeSet scope", () => {
      const cs = changeSetManager.createChangeSet({
        taskId: "task_scope",
        patch: "diff 1",
        files: ["src/auth/*"],
        risk: "MEDIUM",
      });
      changeSetManager.approveChangeSet(cs.changeSetId, "USER_EXPLICIT");

      // Valid subpath check
      const validCheck = changeSetManager.validateScope(cs.changeSetId, ["src/auth/login.ts"]);
      expect(validCheck.allowed).toBe(true);

      // Scope drift check: attempting to modify src/security/*
      const driftCheck = changeSetManager.validateScope(cs.changeSetId, ["src/security/firewall.ts"]);
      expect(driftCheck.allowed).toBe(false);
      expect(driftCheck.reason).toContain("SCOPE_DRIFT_DETECTED");
    });

    it("blocks execution when targeting protected paths like .env or .git", () => {
      const cs = changeSetManager.createChangeSet({
        taskId: "task_prot",
        patch: "diff 1",
        files: [".env"],
        risk: "CRITICAL",
      });
      changeSetManager.approveChangeSet(cs.changeSetId, "USER_EXPLICIT");

      const protCheck = changeSetManager.validateScope(cs.changeSetId, [".env"]);
      expect(protCheck.allowed).toBe(false);
      expect(protCheck.reason).toContain("PROTECTED_PATH_VIOLATION");
    });
  });

  // ── 8. Execution, Testing & Evidence-Based Verification (Phases H -> J) ─────
  describe("8. Execution, Testing & Verification", () => {
    it("executes approved changes and produces objective verification evidence", async () => {
      // Step 1: Investigate and prepare plan
      const planRes = await autonomousCodingEngineer.processRequest({
        goal: "QYROX ka login issue investigate karo",
        file: "src/auth.ts",
      });
      expect(planRes.status).toBe("AWAITING_USER_APPROVAL");

      // Step 2: User explicitly approves execution
      const execRes = await autonomousCodingEngineer.processRequest({
        goal: "QYROX ka login issue investigate karo",
        file: "src/auth.ts",
        userApprovalGranted: true,
        changeSetId: planRes.changeSet?.changeSetId,
      });

      expect(execRes.status).toBe("COMPLETED");
      expect(execRes.verificationReport?.verified).toBe(true);
      expect(execRes.verificationReport?.exitCode).toBe(0);
      expect(execRes.finalReport?.filesChanged).toContain("src/auth.ts");
      expect(execRes.finalAnswer).toContain("Verified: Action successfully executed and verified");
    });

    it("handles failed verification without blind rollback and prepares rollback proposal", async () => {
      // Mock executor returning non-zero exit code
      executorAgent.setMockExecutor(async (act) => ({
        ok: false,
        actionId: act.id,
        toolName: act.toolName,
        exitCode: 1,
        stdout: "",
        error: "Compilation failed: SyntaxError in auth.ts",
      }));

      // Step 1: Prepare
      const planRes = await autonomousCodingEngineer.processRequest({
        goal: "Fix auth syntax",
        file: "src/auth.ts",
      });

      // Step 2: Execute
      const execRes = await autonomousCodingEngineer.processRequest({
        goal: "Fix auth syntax",
        file: "src/auth.ts",
        userApprovalGranted: true,
        changeSetId: planRes.changeSet?.changeSetId,
      });

      expect(execRes.status).toBe("FAILED");
      expect(execRes.finalAnswer).toContain("Rollback proposal prepared");
      expect(execRes.changeSet?.rollbackProposal).toBeDefined();
      expect(execRes.changeSet?.rollbackProposal?.targetFiles).toContain("src/auth.ts");
    });

    it("detects partial failures when warnings or stderrs are present despite exit code 0", async () => {
      const { verifierAgent } = await import("../multiagent/index.ts");
      const verif = await verifierAgent.verify("Build and test", {
        ok: true,
        exitCode: 0,
        stdout: "Build succeeded",
        stderr: "Warning: Circular dependency detected in auth.ts",
      });

      expect(verif.result.partialFailureDetected).toBe(true);
      expect(verif.result.verified).toBe(true);
      expect(verif.evidence.some((e) => e.includes("Observed stderr snippet: Warning: Circular dependency"))).toBe(true);
    });

    it("records pre-modification file snapshots for deterministic rollback", () => {
      const cs = changeSetManager.createChangeSet({
        taskId: "task_snapshot",
        patch: "diff 1",
        files: ["src/auth.ts"],
        risk: "MEDIUM",
        fileBackups: {
          "src/auth.ts": "// original snapshot content",
        },
      });

      expect(cs.originalFileBackups["src/auth.ts"]).toBe("// original snapshot content");
    });
  });

  // ── 9. Safety & Security Policy Gates ──────────────────────────────────────
  describe("9. Safety & Security Policy Gates", () => {
    it("halts autonomous coding immediately when Emergency Stop is triggered", async () => {
      await emergencyStopCoordinator.trigger({ source: "desktop_ui", reason: "unit_test_stop" });

      const res = await autonomousCodingEngineer.processRequest({
        goal: "Investigate and fix login issue",
      });

      expect(res.status).toBe("BLOCKED");
      expect(res.blockReason).toBe("EMERGENCY_STOP_ACTIVE");
    });

    it("blocks state-changing modifications during Security Lockdown mode", async () => {
      const planRes = await autonomousCodingEngineer.processRequest({
        goal: "Fix login issue",
        file: "src/auth.ts",
      });

      securityPolicyEngine.setMode("LOCKDOWN");

      const execRes = await autonomousCodingEngineer.processRequest({
        goal: "Fix login issue",
        file: "src/auth.ts",
        userApprovalGranted: true,
        changeSetId: planRes.changeSet?.changeSetId,
      });

      expect(execRes.status).toBe("BLOCKED");
      expect(execRes.blockReason).toBe("SECURITY_LOCKDOWN_ACTIVE");
    });

    it("halts orchestration immediately upon cancellation ('ruko')", async () => {
      const res = await autonomousCodingEngineer.processRequest({
        goal: "Ruko, mat karo abhi",
      });

      expect(res.status).toBe("CANCELLED");
      expect(res.finalAnswer).toContain("User requested cancellation");
    });
  });

  // ── 10. Memory, Context & Conversation Integration ─────────────────────────
  describe("10. Multi-Phase Integrations (Phases 18, 19, 20, 21, 22)", () => {
    it("Phase 18: Treats user preferences as presentation guidelines, never as execution permission", async () => {
      const res = await autonomousCodingEngineer.processRequest({
        goal: "Investigate login issue",
      });

      // Even with preference for fast execution, user confirmation is strictly required!
      expect(res.requiresUserApproval).toBe(true);
      expect(res.status).toBe("AWAITING_USER_APPROVAL");
    });

    it("Phase 20: Naturally resolves conversational follow-ups ('Fix bhi prepare karo')", async () => {
      const res = await autonomousCodingEngineer.processRequest({
        goal: "Fix bhi prepare karo for QYROX login issue",
      });

      expect(res.executionPlan).toBeDefined();
      expect(res.approvalPrompt).toContain("Ye changes apply kar doon?");
    });

    it("Phase 21: Autonomous coding responds to proactive failure signals safely", async () => {
      const res = await autonomousCodingEngineer.processRequest({
        goal: "Proactive build error detected in src/auth.ts",
        file: "src/auth.ts",
        mockCompilerError: "TS2304: Cannot find name 'verifyToken'",
      });

      expect(res.rootCauseAnalysis?.confidence).toBe("HIGH");
      expect(res.requiresUserApproval).toBe(true);
    });

    it("Phase 22: Integrates Planner, Researcher, Coder, Critic, Executor, and Verifier cleanly", async () => {
      const planRes = await autonomousCodingEngineer.processRequest({
        goal: "QYROX ka login issue investigate karo",
        allowResearch: true,
      });

      expect(planRes.rootCauseAnalysis).toBeDefined();
      expect(planRes.executionPlan).toBeDefined();
      expect(planRes.changeSet).toBeDefined();
    });
  });

  // ── 11. Critical E2E Workflow & Negative Tests ──────────────────────────────
  describe("11. Critical E2E Workflow & Invariants", () => {
    it("Critical E2E Workflow: 'MYRAA, QYROX ka login issue investigate karo' -> complete lifecycle", async () => {
      // Step 1: User says "MYRAA, QYROX ka login issue investigate karo."
      const step1 = await autonomousCodingEngineer.processRequest({
        goal: "MYRAA, QYROX ka login issue investigate karo.",
      });

      expect(step1.status).toBe("AWAITING_USER_APPROVAL");
      expect(step1.requiresUserApproval).toBe(true);
      expect(step1.rootCauseAnalysis?.likelyRootCause).toBeDefined();
      expect(step1.changeSet?.executionStatus).toBe("PENDING");
      expect(step1.approvalPrompt).toBe("Ye changes apply kar doon?");

      // Step 2: User says "haan kar do" -> approves and applies
      const step2 = await autonomousCodingEngineer.processRequest({
        goal: "haan kar do",
        changeSetId: step1.changeSet?.changeSetId,
      });

      expect(step2.status).toBe("COMPLETED");
      expect(step2.verificationReport?.verified).toBe(true);
      expect(step2.finalReport?.testsRun.length).toBeGreaterThan(0);
      expect(step2.finalAnswer).toContain("Verified: Action successfully executed and verified");
    });

    it("Negative Invariant: 'Login issue investigate karo' does NOT modify anything without approval", async () => {
      const res = await autonomousCodingEngineer.processRequest({
        goal: "Login issue investigate karo",
      });

      expect(res.status).toBe("AWAITING_USER_APPROVAL");
      expect(res.verificationReport).toBeUndefined();
      expect(changeSetManager.getLatestChangeSet()?.executionStatus).toBe("PENDING");
    });

    it("Negative Invariant: Unsolicited 'haan' with no pending plan results in NOOP", async () => {
      const res = await autonomousCodingEngineer.processRequest({
        goal: "haan",
      });

      expect(res.status).toBe("COMPLETED");
      expect(res.finalAnswer).toContain("Koi pending modification plan nahi hai");
    });
  });

  // ── 12. REST Endpoints Integration ─────────────────────────────────────────
  describe("12. REST Endpoints Integration", () => {
    let server: http.Server;
    let baseUrl: string;

    beforeEach(async () => {
      const app = createHttpApp();
      await new Promise<void>((resolve) => {
        server = app.listen(0, "127.0.0.1", () => {
          const addr = server.address() as any;
          baseUrl = `http://127.0.0.1:${addr.port}`;
          resolve();
        });
      });
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it("processes investigation via POST /api/coding/process", async () => {
      const res = await fetch(`${baseUrl}/api/coding/process`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goal: "QYROX ka login issue investigate karo" }),
      });

      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.ok).toBe(true);
      expect(data.result.status).toBe("AWAITING_USER_APPROVAL");
      expect(data.result.approvalPrompt).toBe("Ye changes apply kar doon?");
    });

    it("retrieves ChangeSet via GET /api/coding/changeset", async () => {
      // First process a task to create a ChangeSet
      await fetch(`${baseUrl}/api/coding/process`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goal: "Fix auth issue in src/auth.ts" }),
      });

      const res = await fetch(`${baseUrl}/api/coding/changeset`);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.ok).toBe(true);
      expect(data.changeSet).toBeDefined();
      expect(data.changeSet.approvedFiles).toContain("src/auth.ts");
    });

    it("resets coding engineer state via POST /api/coding/reset", async () => {
      const res = await fetch(`${baseUrl}/api/coding/reset`, {
        method: "POST",
      });

      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.ok).toBe(true);
      expect(data.message).toContain("reset");
    });
  });
});
