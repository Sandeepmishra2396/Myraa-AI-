/**
 * MYRAA — StepExecutor (Phase 5)
 *
 * Executes individual plan steps by dispatching to MYRAA's existing tool
 * infrastructure (Project Intelligence, Knowledge Engine, Desktop Agent).
 *
 * CRITICAL SAFETY RULES enforced here:
 *   1. Any step with `isDestructive: true` MUST have a valid, non-consumed,
 *      non-expired, argument-hash-verified checkpoint token before execution.
 *      If the checkpoint is absent or invalid, execution is REFUSED.
 *   2. Sentinel tools (`_checkpoint`, `_report`) are never dispatched externally.
 *   3. File-path arguments are validated against the workspace boundary via
 *      `isPathWithinWorkspace()` before reaching the desktop agent.
 *   4. All retries are delegated to `RecoveryEngine` — destructive steps
 *      receive maxRetries = 0 and never enter the retry loop.
 *   5. Execution timeout is enforced by `Promise.race` with a configurable limit.
 */

import type {
  PlanStep,
  StepExecutionResult,
  RetryPolicy,
} from "./PlannerTypes.ts";
import { DEFAULT_RETRY_POLICY, MODIFYING_TOOLS } from "./PlannerTypes.ts";
import { checkpointManager } from "./CheckpointManager.ts";
import { resultEvaluator } from "./ResultEvaluator.ts";
import { recoveryEngine } from "./RecoveryEngine.ts";
import { callDesktopAgent, DESKTOP_TOOLS } from "../tasks/TaskManager.ts";
import { projectManager } from "../projects/ProjectManager.ts";
import { knowledgeManager } from "../knowledge/KnowledgeManager.ts";
import { isPathWithinWorkspace, sanitizeError } from "../security/PermissionManager.ts";

const WORKSPACE = process.env.SORA_WORKSPACE_DIR || process.cwd();

const PATH_KEYS = [
  "path",
  "filePath",
  "targetFile",
  "file",
  "source",
  "dest",
  "outputFile",
  "directory",
  "folder",
  "filename",
];

export function extractPathArgs(args: Record<string, unknown>): string[] {
  const paths: string[] = [];
  for (const key of PATH_KEYS) {
    const val = args[key];
    if (typeof val === "string" && val.trim().length > 0) {
      paths.push(val.trim());
    }
  }
  return paths;
}

// ---------------------------------------------------------------------------
// Internal tool dispatcher
// ---------------------------------------------------------------------------

async function dispatchTool(
  toolName: string,
  toolArgs: Record<string, unknown>,
): Promise<unknown> {
  const args = toolArgs as any;

  // ── Project Intelligence tools ─────────────────────────────────────────
  if (toolName === "analyzeProject") {
    return projectManager.analyzeProject((args.path as string) || undefined);
  }
  if (toolName === "getProjectArchitecture") {
    const proj = await projectManager.analyzeProject();
    return { architecture: proj.architectureMap, summary: proj.summary };
  }
  if (toolName === "searchProjectCode") {
    return projectManager.searchCode(args.query as string, {
      filePattern: args.filePattern as string,
      caseSensitive: args.caseSensitive === true,
      maxResults: args.maxResults ? Number(args.maxResults) : 15,
    });
  }
  if (toolName === "getProjectGitStatus") {
    return projectManager.getGitStatus();
  }
  if (toolName === "trackProjectTask") {
    return { result: "Task tracking skipped in planner context." };
  }

  // ── Research / Knowledge tools ─────────────────────────────────────────
  if (toolName === "researchWeb") {
    const res = await knowledgeManager.researchWeb(args.query as string, {
      maxResults: args.maxResults ? Number(args.maxResults) : 5,
      fetchTopContent: args.fetchTopContent === true,
    });
    return { summary: res.summary, citations: res.citations, resultCount: res.results.length };
  }
  if (toolName === "fetchOfficialDocs") {
    const res = await knowledgeManager.fetchOfficialDocs(
      args.technology as string,
      args.topic as string,
    );
    return { summary: res.summary, citations: res.citations, resultCount: res.results.length };
  }
  if (toolName === "readUrl") {
    const res = await knowledgeManager.readUrl(args.url as string);
    return { title: res.title, url: res.url, snippet: res.text.substring(0, 800) };
  }
  if (toolName === "queryKnowledgeBase") {
    const res = await knowledgeManager.queryKnowledge(args.query as string, {
      limit: args.limit ? Number(args.limit) : 5,
    });
    return { summary: res.summary, matchCount: res.matches.length };
  }

  // ── Desktop agent tools (including file operations) ────────────────────
  if (DESKTOP_TOOLS.has(toolName)) {
    // Extra workspace boundary check for file-path arguments
    const candidatePaths = extractPathArgs(toolArgs);
    for (const p of candidatePaths) {
      if (!isPathWithinWorkspace(p, WORKSPACE)) {
        throw new Error(
          `Access denied: path '${sanitizeError(p)}' is outside the active workspace boundary.`,
        );
      }
    }
    const result = await callDesktopAgent(toolName, toolArgs);
    if (!result.ok) throw new Error(result.error || `Desktop agent error for ${toolName}.`);
    return result.result ?? { result: "Done." };
  }

  // ── Autonomous Mobile & Cross-Device Workflow tools (Phase 27) ─────────
  if (toolName === "verifyWorkflow") {
    return { ok: true, verified: true, expectedCapabilities: args.expectedCapabilities || [] };
  }

  if (toolName === "sharedMemory") {
    const { sharedMemoryManager } = await import("../memory/SharedMemoryManager.ts");
    const secContext = args.secContext || {
      identityId: (args.deviceId as string) || "local_operator",
      role: "admin",
      ipAddress: "127.0.0.1",
      deviceId: (args.deviceId as string) || "local_operator",
      isLocal: !args.deviceId,
    };
    if (args.action === "search") {
      const results = await sharedMemoryManager.searchMemories({ query: String(args.query || "") }, secContext);
      return { matches: results, count: results.length };
    }
    if (args.action === "create" || args.action === "save") {
      return sharedMemoryManager.createMemory(args.item as any, secContext);
    }
    const list = await sharedMemoryManager.listMemories({}, secContext);
    return { memories: list, count: list.length };
  }

  if (toolName === "mobileProactive") {
    const { mobileProactiveManager } = await import("../companion/mobile/MobileProactiveManager.ts");
    const secContext = args.secContext || {
      identityId: (args.deviceId as string) || "local_operator",
      role: "admin",
      ipAddress: "127.0.0.1",
      deviceId: (args.deviceId as string) || "local_operator",
      isLocal: !args.deviceId,
    };
    return mobileProactiveManager.dispatchProactiveEvent(args as any, secContext);
  }

  const MOBILE_CAPABILITIES = new Set([
    "calendar",
    "createReminder",
    "setAlarm",
    "setTimer",
    "notifications",
    "deviceStatus",
    "mobileContext",
    "mobileScreen",
    "interactApp",
    "openBrowser",
    "searchWeb",
    "findOnPage",
    "navigateBack",
    "navigateForward",
    "openApp",
    "openUrl",
    "openSettings",
    "mediaControls",
    "clipboard",
  ]);

  if (MOBILE_CAPABILITIES.has(toolName)) {
    const { remoteCapabilityDispatcher } = await import("../remote/RemoteCapabilityDispatcher.ts");
    const { remoteSessionManager } = await import("../remote/RemoteSessionManager.ts");

    let deviceId = (args.deviceId as string) || "";
    if (!deviceId) {
      const active = remoteSessionManager.getActiveSessions();
      if (active.length > 0) {
        deviceId = active[0].deviceId;
      } else {
        deviceId = "companion_default";
      }
    }

    const secContext = args.secContext || {
      identityId: deviceId,
      role: "standard",
      ipAddress: "127.0.0.1",
      deviceId,
      isLocal: false,
    };

    const res = await remoteCapabilityDispatcher.dispatchCapability(
      deviceId,
      toolName,
      toolArgs,
      secContext,
      args.confirmationToken as string | undefined,
    );
    if (!res.ok) {
      throw new Error(res.error || `Execution failed for capability '${toolName}'.`);
    }
    return res.result ?? { success: true };
  }

  throw new Error(`Unknown tool: '${toolName}'. Cannot dispatch.`);
}

// ---------------------------------------------------------------------------
// StepExecutor
// ---------------------------------------------------------------------------

export class StepExecutor {
  /**
   * Execute a single plan step.
   *
   * For DESTRUCTIVE / MODIFYING steps:
   *   - Direct path-traversal / workspace check runs FIRST independently of argsHash.
   *     A valid hash can NEVER authorize an unsafe path outside the workspace.
   *   - Classified modifying tools are automatically gated even if isDestructive is false.
   *   - Requires a valid `checkpointId` on the step.
   *   - Calls `checkpointManager.consumeApproval()` before invoking the tool.
   *   - If the checkpoint is missing, expired, already consumed, or has mismatched
   *     args → throws immediately without calling the tool.
   *
   * For SAFE/IDEMPOTENT steps:
   *   - Direct path check still applies to any target paths.
   *   - No checkpoint is required.
   *   - Automatically retries up to `step.maxRetries` with exponential backoff.
   *
   * Returns a complete `StepExecutionResult` (never throws externally).
   */
  async executeStep(
    step: PlanStep,
    policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  ): Promise<StepExecutionResult> {
    // Sentinel steps are handled by coordinator — should never reach here
    if (step.toolName === "_checkpoint" || step.toolName === "_report") {
      return this._sentinelResult(step, "Sentinel step — handled by coordinator.");
    }

    // ── 1. DIRECT PATH & WORKSPACE VALIDATION (INDEPENDENT OF ARGSHASH) ──────────
    // MANDATORY SECURITY INVARIANT: A valid hash must NEVER authorize an unsafe path.
    const candidatePaths = extractPathArgs(step.toolArgs);
    for (const p of candidatePaths) {
      if (!isPathWithinWorkspace(p, WORKSPACE)) {
        return this._blockedResult(
          step,
          `Security violation: path '${sanitizeError(p)}' is outside the active workspace boundary. Direct workspace validation failed independent of hash authorization.`,
        );
      }
    }

    // ── 2. SAFETY GATE: destructive / modifying step checkpoint verification ─────
    const isModifying =
      step.isDestructive ||
      step.checkpointRequired ||
      MODIFYING_TOOLS.has(step.toolName);

    if (isModifying) {
      if (!step.checkpointId) {
        return this._blockedResult(step, "No checkpoint token found for destructive step — execution refused.");
      }
      const approved = checkpointManager.consumeApproval(
        step.checkpointId,
        step.id,
        step.toolName,
        step.toolArgs,
      );
      if (!approved) {
        return this._blockedResult(
          step,
          `Checkpoint '${step.checkpointId}' for step '${step.id}' failed validation ` +
            "(missing / expired / consumed / tampered args). Execution refused.",
        );
      }
    }

    // ── Execute (with timeout and retry for safe steps) ─────────────────
    const triedTools: string[] = [step.toolName];
    let currentTool = step.toolName;
    let currentArgs = { ...step.toolArgs };
    let lastError = "";

    for (let attempt = 0; attempt <= step.maxRetries; attempt++) {
      if (attempt > 0) {
        // Destructive steps must never reach attempt > 0
        if (step.isDestructive) {
          break;
        }
        const { shouldRetry, delayMs } = recoveryEngine.shouldRetry(
          { ...step, retryCount: attempt - 1 },
          policy,
        );
        if (!shouldRetry) break;
        await recoveryEngine.sleep(delayMs, policy.timeoutMs);
      }

      const start = Date.now();
      try {
        const output = await this._withTimeout(
          dispatchTool(currentTool, currentArgs),
          policy.timeoutMs,
        );
        const elapsedMs = Date.now() - start;
        const evaluation = resultEvaluator.evaluate(step, { output, elapsedMs });

        const result: StepExecutionResult = { output, elapsedMs, evaluation };

        if (evaluation.suggestedAction === "proceed" || evaluation.suggestedAction === "retry") {
          if (evaluation.status === "success" || evaluation.status === "partial") {
            return result;
          }
        }

        if (evaluation.suggestedAction === "fallback" && evaluation.fallbackTool) {
          const fb = recoveryEngine.selectFallback(step, triedTools);
          if (fb && !step.isDestructive) {
            triedTools.push(fb);
            currentTool = fb;
            continue;
          }
        }

        return result;
      } catch (err: any) {
        lastError = sanitizeError(err?.message || String(err));
      }
    }

    // All retries exhausted
    const elapsedMs = 0;
    const evaluation = resultEvaluator.evaluate(step, { output: null, error: lastError, elapsedMs });
    return { output: null, elapsedMs, error: lastError, evaluation };
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private async _withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Tool execution timed out after ${timeoutMs}ms.`)), timeoutMs),
      ),
    ]);
  }

  private _sentinelResult(step: PlanStep, message: string): StepExecutionResult {
    return {
      output: { result: message },
      elapsedMs: 0,
      evaluation: { status: "success", score: 1, reason: message, suggestedAction: "proceed" },
    };
  }

  private _blockedResult(step: PlanStep, message: string): StepExecutionResult {
    return {
      output: null,
      elapsedMs: 0,
      error: message,
      evaluation: { status: "critical_failure", score: 0, reason: message, suggestedAction: "abort" },
    };
  }
}

/** Shared singleton. Tests may instantiate their own. */
export const stepExecutor = new StepExecutor();
