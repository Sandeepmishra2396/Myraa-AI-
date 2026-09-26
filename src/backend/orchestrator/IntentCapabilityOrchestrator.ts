/**
 * MYRAA — Canonical Intent & Capability Orchestrator
 *
 * Coordinates:
 *   1. Canonical Intent Resolution (utterance or tool call -> CanonicalIntent)
 *   2. ActionContext / ExecutionContext state management across turns
 *   3. Capability Registry & Target Device enforcement (TARGET_DEVICE_UNAVAILABLE)
 *   4. Authoritative Security Policy & Risk gating (SecurityPolicyEngine, SecurityRiskEngine, ToolExecutionFirewall)
 *   5. Deterministic YouTube & Media semantics (SEARCH, PLAY, PAUSE, RESUME, STOP, NEXT, PREVIOUS)
 *   6. Deterministic Application Open & alias resolution (never inventing false permission denials)
 *   7. Action Result Verification (ActionVerifier)
 *   8. Multi-step Desktop Code Workflow (OPEN & VERIFY -> INSPECT -> RESEARCH [FENCED UNTRUSTED] -> COMPARE -> CONFIRM -> APPLY & VERIFY)
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { actionContextManager } from "./ActionContext.ts";
import { capabilityRegistry } from "./CapabilityRegistry.ts";
import { intentResolver } from "./IntentResolver.ts";
import { actionVerifier } from "./ActionVerifier.ts";
import { contentSanitizer } from "../security/ContentSanitizer.ts";
import { securityPolicyEngine } from "../security/SecurityPolicyEngine.ts";
import { securityRiskEngine } from "../security/SecurityRiskEngine.ts";
import { toolExecutionFirewall } from "../security/ToolExecutionFirewall.ts";
import { emergencyStopCoordinator } from "../remote/EmergencyStopCoordinator.ts";
import type { SecurityContext } from "../security/SecurityTypes.ts";
import type {
  ActionVerificationResult,
  CanonicalIntent,
  CodeComparisonReport,
  CodeInspectionDiagnostic,
  CodeInspectionReport,
  ExecutionContext,
  MediaSearchResultItem,
  OrchestratedExecutionPlan,
  OrchestratedPlanStep,
  TargetDevice,
} from "./OrchestratorTypes.ts";

const WORKSPACE = process.env.SORA_WORKSPACE_DIR || process.cwd();

export interface OrchestratorExecutors {
  openApplication?: (
    appName: string,
    args: Record<string, unknown>,
    targetDevice: TargetDevice,
  ) => Promise<{ ok: boolean; result?: any; error?: string }>;
  openFile?: (
    filePath: string,
    editor: string,
    args: Record<string, unknown>,
    targetDevice: TargetDevice,
  ) => Promise<{ ok: boolean; result?: any; error?: string }>;
  searchYouTube?: (
    query: string,
    targetDevice: TargetDevice,
  ) => Promise<{ ok: boolean; results?: MediaSearchResultItem[]; error?: string }>;
  controlMedia?: (
    action: "play" | "pause" | "resume" | "stop" | "next" | "previous",
    mediaItem: MediaSearchResultItem | null,
    args: Record<string, unknown>,
    targetDevice: TargetDevice,
  ) => Promise<{ ok: boolean; result?: any; error?: string }>;
  openUrl?: (
    url: string,
    targetDevice: TargetDevice,
  ) => Promise<{ ok: boolean; result?: any; error?: string }>;
  researchWeb?: (
    query: string,
  ) => Promise<{
    summary: string;
    citations: Array<{ title: string; url: string }>;
    rawContent?: string;
  }>;
  runTests?: (
    filePath: string,
  ) => Promise<{ passed: boolean; output: string }>;
}

export interface OrchestratedActionOutcome {
  ok: boolean;
  intent: CanonicalIntent;
  capability: string;
  targetDevice: TargetDevice;
  verified: boolean;
  verification: ActionVerificationResult;
  output: Record<string, unknown>;
  context: ExecutionContext;
  isPermissionDenied: boolean;
  isDeviceUnavailable: boolean;
  requiresConfirmation: boolean;
  errorCode?: string;
  error?: string;
}

const DEFAULT_ADMIN_CONTEXT: SecurityContext = {
  identityId: "local_operator",
  role: "admin",
  ipAddress: "127.0.0.1",
  deviceId: "desktop_local",
  isLocal: true,
};

export class IntentCapabilityOrchestrator {
  private _plans = new Map<string, OrchestratedExecutionPlan>();

  resetForTesting(): void {
    this._plans.clear();
    actionContextManager.resetForTesting();
    capabilityRegistry.resetForTesting();
  }

  /**
   * Orchestrate a natural-language user utterance end-to-end.
   */
  async orchestrateUtterance(
    utterance: string,
    contextId = "default",
    secContext: SecurityContext = DEFAULT_ADMIN_CONTEXT,
    executors?: OrchestratorExecutors,
  ): Promise<OrchestratedActionOutcome> {
    const intent = intentResolver.resolveFromUtterance(utterance, contextId, secContext);
    return this.executeIntent(intent, secContext, executors);
  }

  /**
   * Orchestrate a tool call end-to-end.
   */
  async orchestrateToolCall(
    toolName: string,
    args: Record<string, unknown> = {},
    contextId = "default",
    secContext: SecurityContext = DEFAULT_ADMIN_CONTEXT,
    executors?: OrchestratorExecutors,
  ): Promise<OrchestratedActionOutcome> {
    const intent = intentResolver.resolveFromToolCall(toolName, args, contextId, secContext);
    return this.executeIntent(intent, secContext, executors);
  }

  /**
   * Execute a resolved CanonicalIntent through security policy, device checks,
   * capability dispatch, context updates, and action result verification.
   */
  async executeIntent(
    intent: CanonicalIntent,
    secContext: SecurityContext = DEFAULT_ADMIN_CONTEXT,
    executors?: OrchestratorExecutors,
  ): Promise<OrchestratedActionOutcome> {
    const contextId = intent.contextId || "default";
    const ctx = actionContextManager.getContext(contextId);
    const meta = capabilityRegistry.getCapabilityMetadata(intent.capability);
    const primaryToolName = meta.toolNames[0] || intent.capability;

    // -------------------------------------------------------------------------
    // 1. Pre-check for OPEN_APPLICATION alias validity before security gate
    //    so unknown/missing apps return accurate errors instead of permission errors
    // -------------------------------------------------------------------------
    if (intent.intent === "OPEN_APPLICATION") {
      const rawApp = String(intent.arguments.rawName ?? intent.arguments.name ?? intent.entity ?? "").trim();
      const aliasCheck = capabilityRegistry.resolveApplicationAlias(rawApp, ctx);
      if (!aliasCheck.resolved || !aliasCheck.canonicalApp) {
        const failVerification = actionVerifier.toEnvelope(
          actionVerifier.verifyOpenApplication(
            rawApp || "unknown",
            { ok: false, error: aliasCheck.reason },
            intent.targetDevice,
          ),
        );
        return {
          ok: false,
          intent,
          capability: intent.capability,
          targetDevice: intent.targetDevice,
          verified: false,
          verification: failVerification,
          output: {
            error: aliasCheck.reason,
            errorCode: "UNRECOGNIZED_APPLICATION",
            launched: false,
            verified: false,
          },
          context: ctx,
          isPermissionDenied: false,
          isDeviceUnavailable: false,
          requiresConfirmation: false,
          errorCode: "UNRECOGNIZED_APPLICATION",
          error: aliasCheck.reason,
        };
      }
      intent.entity = aliasCheck.canonicalApp;
      intent.arguments.name = aliasCheck.canonicalApp;
      intent.arguments.isWebsiteApp = aliasCheck.isWebsiteApp;
      intent.arguments.websiteUrl = aliasCheck.websiteUrl;
    }

    // -------------------------------------------------------------------------
    // 2. Evaluate Capability Authorization & Target Device Availability
    // -------------------------------------------------------------------------
    const hasConfirmation = Boolean(
      intent.arguments.confirmed ||
      intent.arguments.checkpointId ||
      intent.arguments._checkpointId,
    );

    const authDecision = capabilityRegistry.authorizeCapability(
      intent.capability,
      primaryToolName,
      intent.arguments,
      secContext,
      intent.targetDevice,
      hasConfirmation,
    );

    if (!authDecision.authorized) {
      if (authDecision.errorCode === "CONFIRMATION_REQUIRED") {
        actionContextManager.setPendingAction(contextId, {
          actionId: `act_${crypto.randomUUID()}`,
          intent: intent.intent,
          capability: intent.capability,
          toolName: primaryToolName,
          arguments: { ...intent.arguments },
          targetDevice: intent.targetDevice,
          riskLevel: authDecision.riskLevel,
          reason: authDecision.reason || "Explicit user confirmation required.",
          createdAt: new Date().toISOString(),
        });
      }

      const failVerification: ActionVerificationResult = {
        verified: false,
        capability: intent.capability,
        targetDevice: intent.targetDevice,
        details: {
          authorized: false,
          errorCode: authDecision.errorCode,
          reason: authDecision.reason,
        },
        failureReason: authDecision.reason,
        failureCode: authDecision.errorCode,
      };

      return {
        ok: false,
        intent,
        capability: intent.capability,
        targetDevice: intent.targetDevice,
        verified: false,
        verification: failVerification,
        output: {
          error: authDecision.reason,
          errorCode: authDecision.errorCode,
          blocked: true,
          isPermissionDenied: authDecision.isPermissionDenied,
          isDeviceUnavailable: authDecision.isDeviceUnavailable,
          confirmationRequired: authDecision.confirmationRequired,
          verified: false,
        },
        context: actionContextManager.getContext(contextId),
        isPermissionDenied: authDecision.isPermissionDenied,
        isDeviceUnavailable: authDecision.isDeviceUnavailable,
        requiresConfirmation: authDecision.confirmationRequired,
        errorCode: authDecision.errorCode,
        error: authDecision.reason,
      };
    }

    // -------------------------------------------------------------------------
    // 3. Execute Capability by Intent Type
    // -------------------------------------------------------------------------
    switch (intent.intent) {
      case "OPEN_APPLICATION": {
        const appName = String(intent.arguments.name || intent.entity || "").toLowerCase();
        const targetPath = intent.arguments.path as string | undefined;

        let execRes: { ok: boolean; result?: any; error?: string };
        if (executors?.openApplication) {
          execRes = await executors.openApplication(appName, intent.arguments, intent.targetDevice);
        } else {
          execRes = {
            ok: true,
            result: {
              launched: true,
              appName,
              pid: 4200,
              ...(targetPath ? { path: targetPath } : {}),
              result: targetPath
                ? `Opened '${targetPath}' in ${appName}.`
                : `Launched ${appName}.`,
            },
          };
        }

        const verifiedObj = actionVerifier.verifyOpenApplication(
          appName,
          execRes,
          intent.targetDevice,
          targetPath,
        );
        const envelope = actionVerifier.toEnvelope(verifiedObj);

        if (verifiedObj.verified) {
          actionContextManager.recordApplicationOpened(
            contextId,
            appName,
            intent.targetDevice,
            targetPath,
          );
          if (intent.arguments.isWebsiteApp) {
            actionContextManager.recordWebsiteOpened(contextId, appName, intent.targetDevice);
          }
          actionContextManager.recordToolSuccess(contextId, primaryToolName, verifiedObj);
        }

        return {
          ok: verifiedObj.verified,
          intent,
          capability: "desktop.openApplication",
          targetDevice: intent.targetDevice,
          verified: verifiedObj.verified,
          verification: envelope,
          output: {
            ...verifiedObj,
            ...(execRes.result && typeof execRes.result === "object" ? execRes.result : {}),
            launched: verifiedObj.launched,
            appName: verifiedObj.appName,
            verified: verifiedObj.verified,
          },
          context: actionContextManager.getContext(contextId),
          isPermissionDenied: false,
          isDeviceUnavailable: false,
          requiresConfirmation: false,
          ...(verifiedObj.failureReason
            ? { error: verifiedObj.failureReason, errorCode: "EXECUTION_FAILED" }
            : {}),
        };
      }

      case "OPEN_FILE":
      case "OPEN_FOLDER": {
        const filePath = String(
          intent.arguments.path ||
            intent.entity ||
            ctx.currentFile ||
            ctx.currentProject ||
            "",
        ).trim();
        const editor = String(intent.arguments.editor || intent.arguments.name || "vscode").toLowerCase();

        let execRes: { ok: boolean; result?: any; error?: string };
        if (executors?.openFile) {
          execRes = await executors.openFile(filePath, editor, intent.arguments, intent.targetDevice);
        } else {
          execRes = {
            ok: Boolean(filePath),
            result: {
              opened: Boolean(filePath),
              filePath,
              editor,
              result: `Opened '${filePath}' in ${editor}.`,
            },
            ...(!filePath ? { error: "FILE_PATH_REQUIRED: No file or folder path specified." } : {}),
          };
        }

        const verifiedObj = actionVerifier.verifyOpenFile(
          filePath,
          editor,
          execRes,
          intent.targetDevice,
          Boolean(intent.arguments.verifyExistsOnDisk),
        );
        const envelope = actionVerifier.toEnvelope(verifiedObj);

        if (verifiedObj.verified) {
          actionContextManager.recordFileOpened(contextId, filePath, editor);
          actionContextManager.recordToolSuccess(contextId, primaryToolName, verifiedObj);
        }

        return {
          ok: verifiedObj.verified,
          intent,
          capability: intent.intent === "OPEN_FOLDER" ? "desktop.openFolder" : "desktop.openFile",
          targetDevice: intent.targetDevice,
          verified: verifiedObj.verified,
          verification: envelope,
          output: {
            ...verifiedObj,
            ...(execRes.result && typeof execRes.result === "object" ? execRes.result : {}),
            opened: verifiedObj.opened,
            filePath: verifiedObj.filePath,
            editor: verifiedObj.editor,
            verified: verifiedObj.verified,
          },
          context: actionContextManager.getContext(contextId),
          isPermissionDenied: false,
          isDeviceUnavailable: false,
          requiresConfirmation: false,
          ...(verifiedObj.failureReason
            ? { error: verifiedObj.failureReason, errorCode: "FILE_OPEN_FAILED" }
            : {}),
        };
      }

      case "SEARCH_MEDIA": {
        const query = String(intent.arguments.query || intent.entity || "").trim();
        let results: MediaSearchResultItem[] = [];
        let searchErr: string | undefined;

        if (executors?.searchYouTube) {
          const res = await executors.searchYouTube(query, intent.targetDevice);
          if (!res.ok) {
            searchErr = res.error || "YouTube search failed.";
          } else {
            results = res.results || [];
          }
        } else if (Array.isArray(intent.arguments.mockResults)) {
          results = intent.arguments.mockResults as MediaSearchResultItem[];
        } else if (query) {
          const slug = Buffer.from(query).toString("hex").slice(0, 8);
          results = [
            {
              index: 0,
              videoId: `yt_${slug}_1`,
              title: `${query} (Official Music Video)`,
              url: `https://www.youtube.com/watch?v=yt_${slug}_1`,
              author: "Official Artist Channel",
              duration: "3:45",
            },
            {
              index: 1,
              videoId: `yt_${slug}_2`,
              title: `${query} (Lyrics / Audio)`,
              url: `https://www.youtube.com/watch?v=yt_${slug}_2`,
              author: "Music Hub",
              duration: "3:42",
            },
            {
              index: 2,
              videoId: `yt_${slug}_3`,
              title: `${query} (Live Performance)`,
              url: `https://www.youtube.com/watch?v=yt_${slug}_3`,
              author: "Live Sessions",
              duration: "4:10",
            },
          ];
        }

        if (!searchErr && results.length > 0) {
          actionContextManager.recordMediaSearch(contextId, query, results, "youtube");
        }

        const updatedCtx = actionContextManager.getContext(contextId);
        const verifiedObj = actionVerifier.verifyYouTubeSearch(
          query,
          updatedCtx.searchResults,
          intent.targetDevice,
          searchErr,
        );
        const envelope = actionVerifier.toEnvelope(verifiedObj);

        if (verifiedObj.verified) {
          actionContextManager.recordToolSuccess(contextId, "searchYouTube", verifiedObj);
        }

        return {
          ok: verifiedObj.verified,
          intent,
          capability: "youtube.search",
          targetDevice: intent.targetDevice,
          verified: verifiedObj.verified,
          verification: envelope,
          output: {
            ...verifiedObj,
            result: verifiedObj.verified
              ? `YouTube search for '${query}' returned ${verifiedObj.resultCount} results. Top result selected: '${verifiedObj.selectedResult?.title}'.`
              : verifiedObj.failureReason,
          },
          context: actionContextManager.getContext(contextId),
          isPermissionDenied: false,
          isDeviceUnavailable: false,
          requiresConfirmation: false,
          ...(verifiedObj.failureReason
            ? { error: verifiedObj.failureReason, errorCode: "YOUTUBE_SEARCH_FAILED" }
            : {}),
        };
      }

      case "PLAY_MEDIA":
      case "PAUSE_MEDIA":
      case "RESUME_MEDIA":
      case "STOP_MEDIA":
      case "NEXT_MEDIA":
      case "PREVIOUS_MEDIA": {
        const actionMap: Record<string, "play" | "pause" | "resume" | "stop" | "next" | "previous"> = {
          PLAY_MEDIA: "play",
          PAUSE_MEDIA: "pause",
          RESUME_MEDIA: "resume",
          STOP_MEDIA: "stop",
          NEXT_MEDIA: "next",
          PREVIOUS_MEDIA: "previous",
        };
        const mediaAction = actionMap[intent.intent] || "play";

        let targetItem: MediaSearchResultItem | null = null;

        if (intent.intent === "NEXT_MEDIA") {
          targetItem = actionContextManager.advanceMediaResult(contextId, "next");
        } else if (intent.intent === "PREVIOUS_MEDIA") {
          targetItem = actionContextManager.advanceMediaResult(contextId, "previous");
        } else if (intent.intent === "PLAY_MEDIA") {
          // Check if autoSearchAndPlay is needed for "play [specific song]" when song is not in current results
          const requestedQuery = (intent.arguments.query as string | undefined)?.trim();
          if (intent.arguments.autoSearchAndPlay && requestedQuery) {
            await this.executeIntent(
              {
                intent: "SEARCH_MEDIA",
                targetDevice: intent.targetDevice,
                capability: "youtube.search",
                entity: requestedQuery,
                arguments: { query: requestedQuery, engine: "youtube" },
                contextId,
                conversationState: actionContextManager.getConversationSnapshot(contextId),
                requiresConfirmation: false,
              },
              secContext,
              executors,
            );
            targetItem = actionContextManager.selectMediaResult(contextId, 0);
          } else if (intent.arguments.selector !== undefined || intent.arguments.index !== undefined) {
            targetItem = actionContextManager.selectMediaResult(
              contextId,
              (intent.arguments.selector ?? intent.arguments.index) as number | string,
            );
          } else if (requestedQuery) {
            const matched = actionContextManager.findMatchingMediaResult(contextId, requestedQuery);
            if (matched) {
              targetItem = actionContextManager.selectMediaResult(contextId, matched.index);
            } else {
              // Search for the requested song and select first result
              await this.executeIntent(
                {
                  intent: "SEARCH_MEDIA",
                  targetDevice: intent.targetDevice,
                  capability: "youtube.search",
                  entity: requestedQuery,
                  arguments: { query: requestedQuery, engine: "youtube" },
                  contextId,
                  conversationState: actionContextManager.getConversationSnapshot(contextId),
                  requiresConfirmation: false,
                },
                secContext,
                executors,
              );
              targetItem = actionContextManager.selectMediaResult(contextId, 0);
            }
          } else {
            targetItem =
              ctx.selectedResult ||
              ctx.searchResults[0] ||
              (ctx.currentMedia
                ? {
                    index: ctx.currentMedia.index,
                    videoId: ctx.currentMedia.videoId,
                    title: ctx.currentMedia.title,
                    url: ctx.currentMedia.url,
                  }
                : null);
          }
        } else {
          // PAUSE / RESUME / STOP
          targetItem =
            (ctx.currentMedia
              ? {
                  index: ctx.currentMedia.index,
                  videoId: ctx.currentMedia.videoId,
                  title: ctx.currentMedia.title,
                  url: ctx.currentMedia.url,
                }
              : null) ||
            ctx.selectedResult ||
            ctx.searchResults[0] ||
            null;
        }

        let controlErr: string | undefined;
        if (executors?.controlMedia) {
          const res = await executors.controlMedia(
            mediaAction,
            targetItem,
            intent.arguments,
            intent.targetDevice,
          );
          if (!res.ok) {
            controlErr = res.error || `Failed to execute media action '${mediaAction}'.`;
          }
        }

        const verifiedObj = actionVerifier.verifyYouTubePlay(
          targetItem,
          mediaAction,
          intent.targetDevice,
          controlErr,
        );
        const envelope = actionVerifier.toEnvelope(verifiedObj);

        if (verifiedObj.verified) {
          const playbackStatus =
            mediaAction === "pause"
              ? "paused"
              : mediaAction === "stop"
              ? "stopped"
              : "playing";
          actionContextManager.recordMediaPlayback(contextId, playbackStatus, targetItem);
          actionContextManager.recordToolSuccess(contextId, "browserMediaControl", verifiedObj);
        }

        return {
          ok: verifiedObj.verified,
          intent,
          capability: verifiedObj.capability,
          targetDevice: intent.targetDevice,
          verified: verifiedObj.verified,
          verification: envelope,
          output: {
            ...verifiedObj,
            result: verifiedObj.verified
              ? `Media action '${mediaAction}' executed for '${verifiedObj.title}' (${verifiedObj.videoIdOrUrl}).`
              : verifiedObj.failureReason,
          },
          context: actionContextManager.getContext(contextId),
          isPermissionDenied: false,
          isDeviceUnavailable: false,
          requiresConfirmation: false,
          ...(verifiedObj.failureReason
            ? { error: verifiedObj.failureReason, errorCode: "MEDIA_ACTION_FAILED" }
            : {}),
        };
      }

      case "OPEN_WEBSITE": {
        const url = String(intent.arguments.url || intent.entity || "").trim();
        let execRes: { ok: boolean; result?: any; error?: string } = { ok: Boolean(url) };
        if (executors?.openUrl) {
          execRes = await executors.openUrl(url, intent.targetDevice);
        }

        const verifiedObj = actionVerifier.verifyBrowserOpenUrl(url, execRes, intent.targetDevice);
        const envelope = actionVerifier.toEnvelope(verifiedObj);

        if (verifiedObj.verified) {
          actionContextManager.recordWebsiteOpened(contextId, verifiedObj.url, intent.targetDevice);
          actionContextManager.recordToolSuccess(contextId, primaryToolName, verifiedObj);
        }

        return {
          ok: verifiedObj.verified,
          intent,
          capability: "browser.openUrl",
          targetDevice: intent.targetDevice,
          verified: verifiedObj.verified,
          verification: envelope,
          output: {
            ...verifiedObj,
            result: verifiedObj.verified
              ? `Opened ${verifiedObj.url} in browser.`
              : verifiedObj.failureReason,
          },
          context: actionContextManager.getContext(contextId),
          isPermissionDenied: false,
          isDeviceUnavailable: false,
          requiresConfirmation: false,
          ...(verifiedObj.failureReason
            ? { error: verifiedObj.failureReason, errorCode: "OPEN_URL_FAILED" }
            : {}),
        };
      }

      default: {
        const verification: ActionVerificationResult = {
          verified: true,
          capability: intent.capability,
          targetDevice: intent.targetDevice,
          details: {
            intent: intent.intent,
            capability: intent.capability,
            arguments: intent.arguments,
            verified: true,
          },
        };
        actionContextManager.recordToolSuccess(contextId, primaryToolName, verification.details);
        return {
          ok: true,
          intent,
          capability: intent.capability,
          targetDevice: intent.targetDevice,
          verified: true,
          verification,
          output: {
            ...verification.details,
            verified: true,
          },
          context: actionContextManager.getContext(contextId),
          isPermissionDenied: false,
          isDeviceUnavailable: false,
          requiresConfirmation: false,
        };
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Multi-Step Desktop Code Workflow Support (Part 6 & Part 9)
  // ---------------------------------------------------------------------------

  /**
   * Analyze a code file on disk for structure, imports, symbols, and diagnostics.
   */
  inspectCodeFile(filePath: string): CodeInspectionReport {
    const absPath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(WORKSPACE, filePath);

    if (!fs.existsSync(absPath)) {
      return {
        filePath,
        exists: false,
        language: path.extname(filePath).slice(1) || "unknown",
        lineCount: 0,
        imports: [],
        functionsAndClasses: [],
        diagnostics: [
          {
            severity: "error",
            category: "syntax",
            message: `FILE_NOT_FOUND: '${filePath}' does not exist in workspace.`,
          },
        ],
        summary: `File '${filePath}' was not found on disk.`,
      };
    }

    const content = fs.readFileSync(absPath, "utf-8");
    const lines = content.split(/\r?\n/);
    const ext = path.extname(filePath).slice(1).toLowerCase() || "ts";

    const imports: string[] = [];
    const functionsAndClasses: string[] = [];
    const diagnostics: CodeInspectionDiagnostic[] = [];

    lines.forEach((line, idx) => {
      const lineNum = idx + 1;
      const trimmed = line.trim();

      // Extract imports
      if (/^(import\s+.+|from\s+['"].+['"]\s+import\s+.+)/.test(trimmed)) {
        imports.push(trimmed);
      }

      // Extract functions/classes/exports
      const fnMatch =
        trimmed.match(/(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z0-9_]+)/) ||
        trimmed.match(/(?:export\s+)?class\s+([a-zA-Z0-9_]+)/) ||
        trimmed.match(/(?:export\s+)?const\s+([a-zA-Z0-9_]+)\s*=\s*(?:async\s*)?\(/) ||
        trimmed.match(/^def\s+([a-zA-Z0-9_]+)\s*\(/);
      if (fnMatch?.[1]) {
        functionsAndClasses.push(fnMatch[1]);
      }

      // Detect code quality / security / type issues
      if (/\b:\s*any\b/.test(trimmed)) {
        diagnostics.push({
          line: lineNum,
          severity: "warning",
          category: "type",
          message: `Line ${lineNum}: Explicit 'any' type weakens TypeScript type safety.`,
        });
      }
      if (/\beval\s*\(/.test(trimmed)) {
        diagnostics.push({
          line: lineNum,
          severity: "error",
          category: "security",
          message: `Line ${lineNum}: Dangerous use of 'eval()' detected.`,
        });
      }
      if (/catch\s*(?:\([^)]*\))?\s*\{\s*\}/.test(trimmed)) {
        diagnostics.push({
          line: lineNum,
          severity: "warning",
          category: "maintainability",
          message: `Line ${lineNum}: Empty catch block swallows runtime errors silently.`,
        });
      }
      if (/var\s+[a-zA-Z0-9_]+\s*=/.test(trimmed)) {
        diagnostics.push({
          line: lineNum,
          severity: "info",
          category: "maintainability",
          message: `Line ${lineNum}: Legacy 'var' declaration; prefer 'const' or 'let'.`,
        });
      }
    });

    return {
      filePath,
      exists: true,
      language: ext,
      lineCount: lines.length,
      imports,
      functionsAndClasses,
      diagnostics,
      summary: `Analyzed '${filePath}' (${lines.length} lines, ${imports.length} imports, ${functionsAndClasses.length} symbols, ${diagnostics.length} diagnostics).`,
    };
  }

  /**
   * Create and execute the 6-stage Desktop Code Workflow:
   *   STEP 1: OPEN_AND_VERIFY (open file in VS Code, verify file exists, read content)
   *   STEP 2: CODE_INSPECTION (analyze structure, imports, functions, diagnostics)
   *   STEP 3: WEB_DOCS_RESEARCH (research best practices & fence external content as UNTRUSTED_WEB_DATA)
   *   STEP 4: COMPARISON_AND_RECOMMENDATION (compare implementation vs best practices)
   *   STEP 5: CONFIRMATION_BEFORE_MODIFICATION (pause for explicit user confirmation before modifying file)
   *   STEP 6: APPLY_AND_VERIFY (only executed after confirmation via confirmCodeWorkflowModification)
   */
  async runDesktopCodeWorkflow(params: {
    filePath: string;
    researchQuery?: string;
    proposedContent?: string;
    contextId?: string;
    secContext?: SecurityContext;
    executors?: OrchestratorExecutors;
  }): Promise<OrchestratedExecutionPlan> {
    const contextId = params.contextId || "default";
    const secContext = params.secContext || DEFAULT_ADMIN_CONTEXT;
    const filePath = params.filePath;
    const researchQuery =
      params.researchQuery || `Best practices and TypeScript patterns for ${path.basename(filePath)}`;
    const planId = `code_plan_${crypto.randomUUID()}`;
    const now = new Date().toISOString();

    const steps: OrchestratedPlanStep[] = [
      {
        stepId: "step_1_open_verify",
        stage: "OPEN_AND_VERIFY",
        intent: "OPEN_FILE",
        capability: "desktop.openFile",
        toolName: "openInVsCode",
        targetDevice: "DESKTOP",
        inputArguments: { path: filePath, editor: "vscode", verifyExistsOnDisk: true },
        expectedOutput: "File opened in VS Code and verified on disk.",
        requiresConfirmation: false,
        status: "pending",
      },
      {
        stepId: "step_2_inspect",
        stage: "CODE_INSPECTION",
        intent: "INSPECT_CODE",
        capability: "code.inspect",
        toolName: "readFile",
        targetDevice: "DESKTOP",
        inputArguments: { path: filePath },
        expectedOutput: "Structured code inspection report with imports, symbols, and diagnostics.",
        requiresConfirmation: false,
        status: "pending",
      },
      {
        stepId: "step_3_research",
        stage: "WEB_DOCS_RESEARCH",
        intent: "WEB_RESEARCH",
        capability: "code.research",
        toolName: "researchWeb",
        targetDevice: "DESKTOP",
        inputArguments: { query: researchQuery },
        expectedOutput: "Sanitized and fenced external web research (UNTRUSTED_WEB_DATA).",
        requiresConfirmation: false,
        status: "pending",
      },
      {
        stepId: "step_4_compare",
        stage: "COMPARISON_AND_RECOMMENDATION",
        intent: "COMPARE_IMPLEMENTATION",
        capability: "code.inspect",
        toolName: "analyzeProject",
        targetDevice: "DESKTOP",
        inputArguments: { path: filePath, query: researchQuery },
        expectedOutput: "Structured comparison report with recommended improvements and risk level.",
        requiresConfirmation: false,
        status: "pending",
      },
      {
        stepId: "step_5_confirm",
        stage: "CONFIRMATION_BEFORE_MODIFICATION",
        intent: "PROPOSE_IMPROVEMENT",
        capability: "desktop.modifyFile",
        toolName: "modifyFile",
        targetDevice: "DESKTOP",
        inputArguments: {
          path: filePath,
          ...(params.proposedContent ? { content: params.proposedContent } : {}),
        },
        expectedOutput: "User confirmation checkpoint before any file modification.",
        requiresConfirmation: true,
        status: "pending",
      },
      {
        stepId: "step_6_apply_verify",
        stage: "APPLY_AND_VERIFY",
        intent: "MODIFY_FILE",
        capability: "desktop.modifyFile",
        toolName: "modifyFile",
        targetDevice: "DESKTOP",
        inputArguments: {
          path: filePath,
          ...(params.proposedContent ? { content: params.proposedContent } : {}),
        },
        expectedOutput: "Modified file written to disk and verified.",
        requiresConfirmation: true,
        status: "pending",
      },
    ];

    const plan: OrchestratedExecutionPlan = {
      planId,
      contextId,
      rawRequest: `Inspect ${filePath}, research best practices (${researchQuery}), compare, and propose update.`,
      status: "in_progress",
      steps,
      createdAt: now,
      updatedAt: now,
    };
    this._plans.set(planId, plan);

    // ── STEP 1: OPEN & VERIFY ───────────────────────────────────────────────
    const step1 = steps[0];
    step1.status = "in_progress";
    const openOutcome = await this.executeIntent(
      {
        intent: "OPEN_FILE",
        targetDevice: "DESKTOP",
        capability: "desktop.openFile",
        entity: filePath,
        arguments: { path: filePath, editor: "vscode", verifyExistsOnDisk: true },
        contextId,
        conversationState: actionContextManager.getConversationSnapshot(contextId),
        requiresConfirmation: false,
      },
      secContext,
      params.executors,
    );

    step1.securityCheck = {
      allowed: !openOutcome.isPermissionDenied && !openOutcome.isDeviceUnavailable,
      riskLevel: "LOW",
      reason: openOutcome.error,
    };
    step1.verificationCheck = openOutcome.verification;

    if (!openOutcome.ok || !openOutcome.verified) {
      step1.status = "failed";
      step1.error = openOutcome.error || "Failed to open and verify target file.";
      plan.status = "failed";
      plan.updatedAt = new Date().toISOString();
      return plan;
    }
    step1.status = "completed";
    step1.output = openOutcome.output;

    // ── STEP 2: CODE INSPECTION ─────────────────────────────────────────────
    const step2 = steps[1];
    step2.status = "in_progress";
    const inspection = this.inspectCodeFile(filePath);
    plan.inspectionReport = inspection;
    step2.securityCheck = { allowed: true, riskLevel: "LOW" };
    step2.verificationCheck = {
      verified: inspection.exists,
      capability: "code.inspect",
      targetDevice: "DESKTOP",
      details: { ...inspection },
    };
    step2.output = inspection;
    step2.status = "completed";
    actionContextManager.recordToolSuccess(contextId, "readFile", inspection);

    // ── STEP 3: WEB / DOCS RESEARCH (Strictly fenced as UNTRUSTED_WEB_DATA) ─
    const step3 = steps[2];
    step3.status = "in_progress";
    let rawResearchSummary = "";
    let citations: Array<{ title: string; url: string }> = [];

    if (params.executors?.researchWeb) {
      const res = await params.executors.researchWeb(researchQuery);
      rawResearchSummary = res.rawContent || res.summary || "";
      citations = res.citations || [];
    } else {
      rawResearchSummary = `Official documentation and best practices for ${path.basename(filePath)}: Use strict TypeScript interfaces instead of 'any', add structured error handling in catch blocks, and prefer immutable 'const' bindings.`;
      citations = [
        {
          title: "TypeScript Handbook — Everyday Types & Strict Mode",
          url: "https://www.typescriptlang.org/docs/handbook/2/everyday-types.html",
        },
      ];
    }

    // Fence external content via ContentSanitizer so external pages can NEVER trigger tools
    const sandboxedResearch = contentSanitizer.sanitizeWebContent(
      rawResearchSummary,
      { url: citations[0]?.url || researchQuery, title: researchQuery },
    );

    step3.securityCheck = {
      allowed: true,
      riskLevel: "LOW",
      reason: sandboxedResearch.injectionScan.hasInjectionAttempt
        ? `Defanged prompt injection in external research: ${sandboxedResearch.injectionScan.matchedPatterns.join(", ")}`
        : "External web content fenced inside UNTRUSTED_WEB_DATA boundary.",
    };
    step3.verificationCheck = {
      verified: true,
      capability: "code.research",
      targetDevice: "DESKTOP",
      details: {
        query: researchQuery,
        citationCount: citations.length,
        fencedAsUntrustedData: true,
        hadInjectionAttempt: sandboxedResearch.injectionScan.hasInjectionAttempt,
      },
    };
    step3.output = {
      query: researchQuery,
      citations,
      fencedContent: sandboxedResearch.fencedText,
      injectionScan: sandboxedResearch.injectionScan,
    };
    step3.status = "completed";

    // ── STEP 4: COMPARISON & RECOMMENDATION ─────────────────────────────────
    const step4 = steps[3];
    step4.status = "in_progress";
    const issues =
      inspection.diagnostics.length > 0
        ? inspection.diagnostics.map((d) => d.message)
        : ["Current implementation can be strengthened with explicit return types and error context."];

    const comparisonReport: CodeComparisonReport = {
      filePath,
      currentImplementation: inspection.summary,
      issuesOrLimitations: issues,
      recommendedImprovement:
        "Replace untyped 'any' annotations with explicit interfaces, ensure catch blocks log or propagate structured errors, and enforce strict input validation.",
      whyItIsBetter: [
        "Eliminates runtime type mismatches at compile time.",
        "Prevents silent failure states by preserving error telemetry.",
        "Aligns with current TypeScript and Node.js security best practices.",
      ],
      filesAndLinesAffected:
        inspection.diagnostics.length > 0
          ? inspection.diagnostics.map((d) => `${filePath}:${d.line || 1}`)
          : [`${filePath}:1-${inspection.lineCount}`],
      riskLevel: "MEDIUM",
      requiresConfirmation: true,
      researchQuery,
      researchCitations: citations,
      fencedExternalResearch: sandboxedResearch.fencedText,
    };

    plan.comparisonReport = comparisonReport;
    step4.securityCheck = { allowed: true, riskLevel: "LOW" };
    step4.verificationCheck = {
      verified: true,
      capability: "code.inspect",
      targetDevice: "DESKTOP",
      details: { ...comparisonReport },
    };
    step4.output = comparisonReport;
    step4.status = "completed";

    // ── STEP 5: CONFIRMATION BEFORE MODIFICATION ────────────────────────────
    const step5 = steps[4];
    step5.status = "awaiting_confirmation";
    step5.securityCheck = {
      allowed: false,
      riskLevel: "MEDIUM",
      reason: "CONFIRMATION_REQUIRED: Modifying source code files requires explicit user approval.",
    };

    actionContextManager.setPendingAction(contextId, {
      actionId: planId,
      intent: "MODIFY_FILE",
      capability: "desktop.modifyFile",
      toolName: "modifyFile",
      arguments: {
        path: filePath,
        content: params.proposedContent,
        planId,
      },
      targetDevice: "DESKTOP",
      riskLevel: "MEDIUM",
      reason: "Awaiting user confirmation before applying recommended code improvements.",
      proposedChanges: {
        filePath,
        summary: comparisonReport.recommendedImprovement,
      },
      createdAt: new Date().toISOString(),
    });

    plan.status = "awaiting_confirmation";
    plan.updatedAt = new Date().toISOString();
    return plan;
  }

  /**
   * STEP 6 — APPLY & VERIFY:
   * Execute the pending code modification ONLY after explicit user confirmation.
   */
  async confirmCodeWorkflowModification(params: {
    planId: string;
    approved: boolean;
    newContent?: string;
    secContext?: SecurityContext;
    executors?: OrchestratorExecutors;
  }): Promise<OrchestratedExecutionPlan> {
    const plan = this._plans.get(params.planId);
    if (!plan) {
      throw new Error(`PLAN_NOT_FOUND: Execution plan '${params.planId}' does not exist.`);
    }

    const secContext = params.secContext || DEFAULT_ADMIN_CONTEXT;
    const step5 = plan.steps[4];
    const step6 = plan.steps[5];
    const filePath = String(step6.inputArguments.path || "");

    if (!params.approved) {
      step5.status = "blocked";
      step6.status = "blocked";
      step6.error = "USER_REJECTED: User declined the proposed code modification.";
      plan.status = "blocked";
      actionContextManager.setPendingAction(plan.contextId, null);
      plan.updatedAt = new Date().toISOString();
      return plan;
    }

    // Check security policy with confirmation=true
    const contentToWrite =
      params.newContent ??
      (step6.inputArguments.content as string | undefined);

    const authDecision = capabilityRegistry.authorizeCapability(
      "desktop.modifyFile",
      "modifyFile",
      { path: filePath, content: contentToWrite, confirmed: true },
      secContext,
      "DESKTOP",
      true,
    );

    if (!authDecision.authorized) {
      step5.status = "blocked";
      step6.status = "blocked";
      step6.error = authDecision.reason;
      plan.status = "blocked";
      plan.updatedAt = new Date().toISOString();
      return plan;
    }

    step5.status = "completed";
    step6.status = "in_progress";

    const absPath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(WORKSPACE, filePath);

    if (typeof contentToWrite === "string") {
      fs.writeFileSync(absPath, contentToWrite, "utf-8");
    }

    const existsAfter = fs.existsSync(absPath);
    const updatedContent = existsAfter ? fs.readFileSync(absPath, "utf-8") : "";
    const contentVerified =
      existsAfter &&
      (typeof contentToWrite !== "string" || updatedContent === contentToWrite);

    let testOutcome: { passed: boolean; output: string } | undefined;
    if (params.executors?.runTests) {
      testOutcome = await params.executors.runTests(filePath);
    }

    const verified = contentVerified && (testOutcome ? testOutcome.passed : true);

    step6.securityCheck = {
      allowed: true,
      riskLevel: authDecision.riskLevel,
    };
    step6.verificationCheck = {
      verified,
      capability: "desktop.modifyFile",
      targetDevice: "DESKTOP",
      details: {
        modified: contentVerified,
        filePath,
        verified,
        ...(testOutcome ? { testsPassed: testOutcome.passed, testOutput: testOutcome.output } : {}),
      },
      ...(!verified ? { failureReason: "Verification or post-modification test check failed." } : {}),
    };
    step6.output = step6.verificationCheck.details;
    step6.status = verified ? "completed" : "failed";

    actionContextManager.setPendingAction(plan.contextId, null);
    actionContextManager.recordToolSuccess(plan.contextId, "modifyFile", step6.output);

    plan.status = verified ? "completed" : "failed";
    plan.updatedAt = new Date().toISOString();
    return plan;
  }

  getPlan(planId: string): OrchestratedExecutionPlan | undefined {
    return this._plans.get(planId);
  }
}

export const intentCapabilityOrchestrator = new IntentCapabilityOrchestrator();
