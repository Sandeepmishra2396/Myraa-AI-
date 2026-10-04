/**
 * MYRAA — Intelligence ActionVerifier
 *
 * Integrates with orchestrator ActionVerifier and extends verification to:
 *   - Process exit codes & shell commands
 *   - Code inspection & diagnostics
 *   - Test suite runs
 *   - General capability results
 *
 * Strictly adheres to Core Principle 8: "Never claim success without evidence."
 */

import { actionVerifier as baseActionVerifier } from "../orchestrator/ActionVerifier.ts";
import type { ActionVerificationResult, TargetDevice } from "../orchestrator/OrchestratorTypes.ts";

export interface ShellCommandVerification {
  verified: boolean;
  exitCode: number;
  stdoutSnippet: string;
  failureReason?: string;
}

export interface CodeTestVerification {
  verified: boolean;
  passed: boolean;
  totalTests?: number;
  outputSnippet: string;
  failureReason?: string;
}

export class IntelligenceActionVerifier {
  public base = baseActionVerifier;

  /**
   * Verify shell command output.
   */
  public verifyShellCommand(
    command: string,
    result: { ok: boolean; exitCode?: number; stdout?: string; stderr?: string; error?: string }
  ): ShellCommandVerification {
    const exitCode = result.exitCode ?? (result.ok ? 0 : 1);
    const stdout = (result.stdout || "").slice(-500);
    const stderr = (result.stderr || "").slice(-500);

    const verified = result.ok && exitCode === 0;
    return {
      verified,
      exitCode,
      stdoutSnippet: stdout || stderr,
      failureReason: verified ? undefined : result.error || stderr || `Command exited with non-zero code ${exitCode}`,
    };
  }

  /**
   * Verify test execution result.
   */
  public verifyTestExecution(
    result: { passed: boolean; output?: string; error?: string }
  ): CodeTestVerification {
    const verified = Boolean(result.passed);
    const output = (result.output || "").slice(-500);
    return {
      verified,
      passed: result.passed,
      outputSnippet: output,
      failureReason: verified ? undefined : result.error || "Tests failed during execution",
    };
  }

  /**
   * Universal verification dispatcher.
   */
  public verifyCapabilityResult(
    capability: string,
    toolName: string,
    agentResult: { ok: boolean; result?: any; error?: string },
    targetDevice: TargetDevice = "DESKTOP"
  ): ActionVerificationResult {
    if (capability === "desktop.openApplication" || toolName === "openApplication" || toolName === "openInVsCode") {
      const appName = agentResult.result?.appName || "application";
      const ver = this.base.verifyOpenApplication(appName, agentResult, targetDevice);
      return {
        verified: ver.verified,
        capability,
        targetDevice,
        details: { pid: ver.pid, appName: ver.appName, launched: ver.launched },
        failureReason: ver.failureReason,
      };
    }

    if (capability === "desktop.openFile" || toolName === "openFile") {
      const filePath = agentResult.result?.filePath || "file";
      const ver = this.base.verifyOpenFile(filePath, "vscode", agentResult, targetDevice);
      return {
        verified: ver.verified,
        capability,
        targetDevice,
        details: { filePath: ver.filePath, opened: ver.opened },
        failureReason: ver.failureReason,
      };
    }

    if (capability === "youtube.play" || toolName === "browserMediaControl") {
      const title = agentResult.result?.title || "media";
      const ver = this.base.verifyYouTubePlay({ title, videoId: "" }, "play", targetDevice, agentResult.error);
      return {
        verified: ver.verified,
        capability,
        targetDevice,
        details: { title: ver.title, playing: ver.playing },
        failureReason: ver.failureReason,
      };
    }

    if (capability === "code.runTests" || toolName === "runShellCommand") {
      const res = agentResult.result || agentResult;
      const shellVer = this.verifyShellCommand(toolName, res);
      return {
        verified: shellVer.verified,
        capability,
        targetDevice,
        details: { exitCode: shellVer.exitCode, outputSnippet: shellVer.stdoutSnippet },
        failureReason: shellVer.failureReason,
      };
    }

    // Default verification: requires ok: true and absence of errors
    const isOk = Boolean(agentResult.ok && !agentResult.error && !agentResult.result?.error);
    return {
      verified: isOk,
      capability,
      targetDevice,
      details: { result: agentResult.result },
      failureReason: isOk ? undefined : agentResult.error || agentResult.result?.error || "Execution failed",
    };
  }
}

export const intelligenceActionVerifier = new IntelligenceActionVerifier();
