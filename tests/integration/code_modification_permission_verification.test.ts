/**
 * MYRAA — Verification Suite: Code Modification & VS Code Permission Token Flow
 *
 * Verifies:
 *  1. SecurityRiskEngine:
 *     - confirmCheckpoint and executeTaskPlan do not block prematurely
 *     - runShellCommand with dev tools evaluates properly to HIGH risk
 *  2. SecurityPolicyEngine:
 *     - confirmCheckpoint is treated as an administrative gate and allowed
 *     - When Desktop Security Gate is unlocked ("Mummy Ka Beta"), modifyFile, writeCodeFile,
 *       createFile, executeTaskPlan, and planTask are permitted without requiring a token
 *     - Confirmation tokens with Windows paths, slash variations, and whitespace are verified
 *       without false CONFIRMATION_ARGS_TAMPERED or CONFIRMATION_TOOL_MISMATCH
 *  3. ToolOrchestrator & CheckpointManager:
 *     - confirmCheckpoint resolves checkpoints with both planner UUIDs and sora_conf_ tokens
 *     - modifying tools execute cleanly when desktop gate is unlocked
 *  4. StepExecutor:
 *     - file operations across safe roots (e.g. D:/Daily New Coding Game) pass path validation
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "path";
import { securityRiskEngine } from "../../backend/security/SecurityRiskEngine.ts";
import { securityPolicyEngine } from "../../backend/security/SecurityPolicyEngine.ts";
import { desktopSecurityGate } from "../../backend/security/DesktopSecurityGate.ts";
import { checkpointManager } from "../../backend/planner/CheckpointManager.ts";
import { plannerCoordinator } from "../../backend/planner/PlannerCoordinator.ts";
import { stepExecutor } from "../../backend/planner/StepExecutor.ts";
import { ToolOrchestrator } from "../../backend/tools/ToolOrchestrator.ts";
import type { SecurityContext } from "../../backend/security/SecurityTypes.ts";
import type { LiveSession, FunctionCall } from "../../backend/tools/ToolOrchestrator.ts";

describe("Code Modification & VS Code Permission Token Flow", () => {
  const localAdminContext: SecurityContext = {
    identityId: "local_operator",
    role: "admin",
    ipAddress: "127.0.0.1",
    isLocal: true,
  };

  beforeEach(() => {
    desktopSecurityGate.reset();
    securityPolicyEngine.resetForTesting();
  });

  afterEach(() => {
    desktopSecurityGate.reset();
    securityPolicyEngine.resetForTesting();
  });

  describe("1. SecurityRiskEngine classification", () => {
    it("does not classify confirmCheckpoint as HIGH_RISK requiring a confirmation token", () => {
      const risk = securityRiskEngine.calculateRisk("confirmCheckpoint", {}, localAdminContext);
      expect(risk.requiresConfirmation).toBe(false);
      expect(risk.level).not.toBe("CRITICAL");
    });

    it("evaluates executeTaskPlan without demanding premature blocker confirmation", () => {
      const risk = securityRiskEngine.calculateRisk("executeTaskPlan", { planId: "test_plan" }, localAdminContext);
      expect(risk.level).toBe("MEDIUM");
    });

    it("evaluates runShellCommand with standard build tools as HIGH risk", () => {
      const risk = securityRiskEngine.calculateRisk("runShellCommand", { command: "npm test" }, localAdminContext);
      expect(risk.level).toBe("HIGH");
      expect(risk.requiresConfirmation).toBe(true);
    });
  });

  describe("2. SecurityPolicyEngine & Desktop Gate Unlocking", () => {
    it("immediately allows confirmCheckpoint without requiring a confirmation token", async () => {
      const decision = await securityPolicyEngine.evaluateRequest(
        "confirmCheckpoint",
        { planId: "plan_123", checkpointId: "cp_123", approved: true },
        localAdminContext,
      );
      expect(decision.allowed).toBe(true);
      expect(decision.decision).toBe("ALLOW");
    });

    it("pre-authorizes modifyFile and writeCodeFile when Desktop Security Gate is UNLOCKED ('Mummy Ka Beta')", async () => {
      desktopSecurityGate.verifyPasscode("Mummy Ka Beta", "local_operator");
      expect(desktopSecurityGate.isUnlocked()).toBe(true);

      const modifyDecision = await securityPolicyEngine.evaluateRequest(
        "modifyFile",
        { path: "D:/Daily New Coding Game/Car Racing Game/Car_Racing_Game.py", content: "# advanced", mode: "overwrite" },
        localAdminContext,
      );
      expect(modifyDecision.allowed).toBe(true);
      expect(modifyDecision.decision).toBe("ALLOW");

      const writeDecision = await securityPolicyEngine.evaluateRequest(
        "writeCodeFile",
        { path: "D:/Daily New Coding Game/Car Racing Game/helper.py", content: "# helper" },
        localAdminContext,
      );
      expect(writeDecision.allowed).toBe(true);
      expect(writeDecision.decision).toBe("ALLOW");
    });

    it("pre-authorizes executeTaskPlan and planTask when Desktop Security Gate is UNLOCKED", async () => {
      desktopSecurityGate.verifyPasscode("Mummy Ka Beta", "local_operator");
      expect(desktopSecurityGate.isUnlocked()).toBe(true);

      const execDecision = await securityPolicyEngine.evaluateRequest(
        "executeTaskPlan",
        { planId: "plan_test_456" },
        localAdminContext,
      );
      expect(execDecision.allowed).toBe(true);
    });
  });

  describe("3. Resilient Token Hashing & Argument Normalization", () => {
    it("verifies and consumes a confirmation token even with path slash differences (\\ vs /)", () => {
      const initialArgs = { path: "D:\\Daily New Coding Game\\game.py", content: "print('v1')\r\n" };
      const token = securityPolicyEngine.generateConfirmationToken("modifyFile", initialArgs, "session_test");
      expect(token.startsWith("sora_conf_")).toBe(true);

      // Verify using forward slash and normalized newline
      const retryArgs = { path: "D:/Daily New Coding Game/game.py", content: "print('v1')\n" };
      const verifyRes = securityPolicyEngine.verifyAndConsumeConfirmation(token, "modifyFile", retryArgs);
      expect(verifyRes.valid).toBe(true);
    });

    it("allows executeTaskPlan token to be presented to confirmCheckpoint without tool mismatch error", () => {
      const token = securityPolicyEngine.generateConfirmationToken("executeTaskPlan", { planId: "plan_123" }, "session_test");
      const verifyRes = securityPolicyEngine.verifyAndConsumeConfirmation(token, "confirmCheckpoint", { planId: "plan_123" });
      expect(verifyRes.valid).toBe(true);
    });

    it("prevents token replay after consumption", () => {
      const initialArgs = { path: "D:/code/test.py", content: "code" };
      const token = securityPolicyEngine.generateConfirmationToken("modifyFile", initialArgs, "session_test");
      const first = securityPolicyEngine.verifyAndConsumeConfirmation(token, "modifyFile", initialArgs);
      expect(first.valid).toBe(true);

      const second = securityPolicyEngine.verifyAndConsumeConfirmation(token, "modifyFile", initialArgs);
      expect(second.valid).toBe(false);
      expect(second.reason).toContain("CONFIRMATION_TOKEN_REPLAY");
    });
  });

  describe("4. StepExecutor Safe Roots", () => {
    it("allows execution across Windows drives and safe roots outside repository directory", async () => {
      // make a safe step targeting D: drive
      const safeStep = {
        id: "step_safe_drive",
        phase: "inspect" as const,
        status: "pending" as const,
        description: "List files on drive",
        toolName: "listFiles",
        toolArgs: { path: "D:/Daily New Coding Game" },
        argsHash: "dummy",
        dependsOn: [],
        isDestructive: false,
        checkpointRequired: false,
        retryCount: 0,
        maxRetries: 0,
      };

      const result = await stepExecutor.executeStep(safeStep);
      // Result should not be blocked for path traversal / workspace boundary violation
      if (result.error) {
        expect(result.error).not.toMatch(/outside the active workspace boundary/i);
      }
    });
  });

  describe("5. ToolOrchestrator confirmCheckpoint Resolution", () => {
    it("resolves confirmCheckpoint cleanly with sora_conf_ token", async () => {
      const orchestrator = new ToolOrchestrator();
      let toolResponseOutput: any = null;

      const mockSession: LiveSession = {
        sendToolResponse: (payload) => {
          toolResponseOutput = payload.functionResponses[0]?.response?.output;
        },
      };

      const token = securityPolicyEngine.generateConfirmationToken("modifyFile", { path: "D:/test.py" });
      const fc: FunctionCall = {
        id: "call_1",
        name: "confirmCheckpoint",
        args: {
          checkpointId: token,
          approved: true,
        },
      };

      await orchestrator.dispatch(fc, mockSession, () => {}, "test-key", localAdminContext);
      expect(toolResponseOutput).toBeDefined();
      expect(toolResponseOutput.approved).toBe(true);
      expect(toolResponseOutput.error).toBeUndefined();
    });
  });

  describe("6. Package Installation & Shell Command Permission Flow (pip install, etc.)", () => {
    it("allows pip install directly when Desktop Security Gate is unlocked", async () => {
      desktopSecurityGate.verifyPasscode("Mummy Ka Beta");
      const decision = await securityPolicyEngine.evaluateRequest(
        "runShellCommand",
        { command: "pip install pygame" },
        localAdminContext,
      );
      expect(decision.allowed).toBe(true);
      expect(decision.decision).toBe("ALLOW");
      desktopSecurityGate.reset();
    });

    it("requires confirmation when Desktop Gate is locked and generates sora_conf_ token", async () => {
      desktopSecurityGate.reset();
      const decision = await securityPolicyEngine.evaluateRequest(
        "runShellCommand",
        { command: "pip install pygame" },
        localAdminContext,
      );
      expect(decision.allowed).toBe(false);
      expect(decision.decision).toBe("REQUIRE_CONFIRMATION");
      expect(decision.confirmationToken).toMatch(/^sora_conf_/);
    });

    it("confirmCheckpoint confirms runShellCommand token and pre-approves subsequent execution", async () => {
      desktopSecurityGate.reset();
      const token = securityPolicyEngine.generateConfirmationToken(
        "runShellCommand",
        { command: "pip install pygame" },
        "local",
      );

      // 1. confirmCheckpoint receives the token
      const verifyRes = securityPolicyEngine.verifyAndConsumeConfirmation(
        token,
        "confirmCheckpoint",
        { checkpointId: token, approved: true },
        "local",
      );
      expect(verifyRes.valid).toBe(true);
      expect(verifyRes.reason).toBeUndefined();

      // 2. Subsequent runShellCommand without token succeeds via pre-approval
      const nextDecision = await securityPolicyEngine.evaluateRequest(
        "runShellCommand",
        { command: "pip install pygame" },
        localAdminContext,
      );
      expect(nextDecision.allowed).toBe(true);
      expect(nextDecision.decision).toBe("ALLOW");
    });

    it("allows runShellCommand directly with confirmationToken parameter", async () => {
      desktopSecurityGate.reset();
      const token = securityPolicyEngine.generateConfirmationToken(
        "runShellCommand",
        { command: "pip install pygame" },
        "local",
      );

      const decision = await securityPolicyEngine.evaluateRequest(
        "runShellCommand",
        { command: "pip install pygame", confirmationToken: token },
        localAdminContext,
        token,
      );
      expect(decision.allowed).toBe(true);
      expect(decision.decision).toBe("ALLOW");
    });
  });
});
