/**
 * MYRAA — ToolOrchestrator
 *
 * Routes incoming Gemini function-call requests to the correct handler:
 *
 *   1. saveCustomMemory  → writes to MemoryManager + broadcasts memory_sync to client
 *   2. DESKTOP_TOOLS     → dispatched to TaskManager.callDesktopAgent (Python)
 *   3. Everything else   → forwarded to the frontend client via WebSocket toolCall
 *
 * The orchestrator does NOT hold state itself — it receives a live `session`
 * reference and a `sendToClient` callback each time it handles a call.
 *
 * All 67 tools are preserved:
 *   • 57 desktop tools  → handled by Python agent via TaskManager
 *   • 9 holographic UI  → forwarded client-side (browserOpen … changeBackground)
 *   • 1 special         → saveCustomMemory (handled in-process + client sync)
 */

import type { Memory, MemoryCategory } from "../memory/MemoryTypes.ts";
import { DESKTOP_TOOLS, callDesktopAgent } from "../tasks/TaskManager.ts";
import { loadMemories, saveMemories } from "../server_memory.ts";
import { projectManager } from "../projects/ProjectManager.ts";
import { projectStore } from "../projects/ProjectStore.ts";
import { projectContinuityResolver } from "../projects/ProjectContinuityResolver.ts";
import { contentSanitizer } from "../security/ContentSanitizer.ts";
import { knowledgeManager } from "../knowledge/KnowledgeManager.ts";
import { isPathWithinWorkspace, isPathWithinSafeRoots, sanitizeError } from "../security/PermissionManager.ts";
import { desktopSecurityGate, DESKTOP_CHALLENGE_PROMPT } from "../security/DesktopSecurityGate.ts";

import { plannerCoordinator, resolveCanonicalProjectId } from "../planner/PlannerCoordinator.ts";
import { checkpointManager } from "../planner/CheckpointManager.ts";
import { MODIFYING_TOOLS } from "../planner/PlannerTypes.ts";
import { extractPathArgs } from "../planner/StepExecutor.ts";
import { companionCoordinator } from "../companion/CompanionCoordinator.ts";
import { emergencyStopCoordinator } from "../remote/EmergencyStopCoordinator.ts";
import { pairingManager } from "../remote/PairingManager.ts";
import { remoteStore } from "../remote/RemoteStore.ts";
import { remoteSessionManager } from "../remote/RemoteSessionManager.ts";
import { screenContextManager } from "../multimodal/ScreenContextManager.ts";
import { activeWindowTracker } from "../multimodal/ActiveWindowTracker.ts";
import { codeScreenshotAnalyzer } from "../multimodal/CodeScreenshotAnalyzer.ts";
import { documentUnderstanding } from "../multimodal/DocumentUnderstanding.ts";
import { contextSuggestionEngine } from "../multimodal/ContextSuggestionEngine.ts";
import { studySessionManager } from "../study/StudySessionManager.ts";
import { DiagramAnalyzer } from "../study/DiagramAnalyzer.ts";
import { TeachingEngine } from "../study/TeachingEngine.ts";
import { interactiveTutor } from "../study/InteractiveTutor.ts";
import { studyProgressTracker } from "../study/StudyProgressTracker.ts";
import { courseProfileManager } from "../study/CourseProfileManager.ts";
import { studyResearchEngine } from "../study/StudyResearchEngine.ts";
import {
  securityPolicyEngine,
  securityAuditLogger,
  outputDataFirewall,
  type SecurityContext,
} from "../security/index.ts";
import { projectDecisionStore } from "../projects/ProjectDecisionStore.ts";
import { invalidateInstructionsCache } from "../ai/GeminiSessionFactory.ts";
import {
  actionContextManager,
  capabilityRegistry,
  intentResolver,
  actionVerifier,
} from "../orchestrator/index.ts";

export { MODIFYING_TOOLS };
const WORKSPACE = process.env.SORA_WORKSPACE_DIR || process.cwd();

export const PROJECT_TOOLS = new Set([
  "analyzeProject",
  "getProjectArchitecture",
  "searchProjectCode",
  "getProjectGitStatus",
  "trackProjectTask",
  "getProjectContinuity",
]);

export const RESEARCH_TOOLS = new Set([
  "researchWeb",
  "fetchOfficialDocs",
  "readUrl",
  "ingestKnowledge",
  "queryKnowledgeBase",
  "checkFreshness",
]);

export const PLANNER_TOOLS = new Set([
  "planTask",
  "executeTaskPlan",
  "pauseTaskPlan",
  "resumeTaskPlan",
  "confirmCheckpoint",
  "getTaskPlanStatus",
]);

export const COMPANION_TOOLS = new Set([
  "scheduleTask",
  "listBackgroundTasks",
  "cancelBackgroundTask",
  "getCompanionNotifications",
  "updateCompanionPreferences",
  "triggerProjectCheck",
]);

export const REMOTE_TOOLS = new Set([
  "generateDevicePairCode",
  "listRemoteDevices",
  "revokeRemoteDevice",
  "triggerEmergencyStop",
]);

export const MULTIMODAL_TOOLS = new Set([
  "captureScreenContext",
  "analyzeVisualCode",
  "extractDocumentContent",
  "getContextAwareSuggestions",
  "toggleContinuousScreenContext",
  "getActiveWindowContext",
]);

export const STUDY_TOOLS = new Set([
  "loadStudyDocument",
  "trackStudyPage",
  "detectStudyQuestions",
  "analyzeStudyDiagram",
  "explainStudySection",
  "toggleTeachingMode",
  "getStudySessionStatus",
  "setInteractiveTutorMode",
  "submitStudentAnswer",
  "getStudyProgress",
  "startRevisionSession",
  "navigateToStudyItem",
  "explainRelevantDiagram",
  "configureCourseProfile",
  "manageSyllabus",
  "researchStudyTopic",
  "discoverStudyVideos",
  "analyzePreviousQuestions",
  "generatePersonalizedStudyPlan",
  "getStudyRecommendations",
  "manageDailyStudySession",
  "getAcademicProgress",
]);

export const MEDIA_BROWSER_TOOLS = new Set([
  "browserSearch",
  "browserOpen",
  "browserMediaControl",
  "browserGoBack",
  "browserClick",
  "searchYouTube",
  "openWebsite",
]);

/**
 * Checks if a user's speech utterance is purely conversational greeting or casual banter,
 * without requesting any media, browser, or search action.
 */
export function isConversationalGreetingOrChat(raw: string | null | undefined): boolean {
  if (!raw || !raw.trim()) return false;
  const s = raw.trim().toLowerCase();

  // If the utterance has any explicit action trigger or media keywords, it is NOT just a greeting!
  const hasActionKeyword =
    /\b(play|karo|chalao|chalana|chala|bajao|bajana|baja|sunao|sunana|suna|lagao|lagana|laga|kholo|kholna|khol|open|start|launch|search|khojo|khoj|dhundho|dhundh|find|look|song|songs|gaana|gana|gaane|gane|video|videos|music|track|audio|playlist|channel|trailer|movie|film|episode|youtube|yt|browser|website|google|next|previous|prev|pause|stop|resume|mute|unmute|volume|click|scroll|type|tab|back|forward)\b/i.test(s) ||
    /\b(\d+)(?:st|nd|rd|th)?\b/i.test(s) ||
    /\b(pehla|doosra|dusra|teesra|tisra|chautha|paanchwa|chhattha|saatwa|aathwa|nauwa|daswa|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|top)\b/i.test(s) ||
    /\b(wala|wali|wale|waala|waali|waale|no|number)\b/i.test(s) ||
    // Hindi Devanagari action verbs/nouns
    /(सर्च|खोज|ढूंढ|चला|बजा|सुना|लगा|खोल|ओपन|प्ले|गाना|गाने|गीत|वीडियो|म्यूजिक|यूट्यूब|अगला|पिछला|पॉज|स्टॉप)/.test(s);

  if (hasActionKeyword) {
    return false;
  }

  // Check if the utterance matches conversational greetings, identity, wellness, or casual banter
  const isGreetingPattern =
    /^(?:hello|hi|hey|heya|hlo|namaste|namaskar|pranam|ram\s*ram|satsriakal|salaam|good\s*(?:morning|evening|afternoon|night))(?:\s+(?:myraa?|sora|ai|buddy|dear|there|everyone))?[\s.!?,]*$/i.test(s) ||
    /^(?:kya\s*(?:hal|haal|chal|chal\s*raha|kar\s*rahi|kar\s*rahe|ho\s*raha)\s*(?:hai|hain|ho)?|kaisa\s*(?:hai|ho)|kaisi\s*(?:hai|ho|hain)|kaise\s*(?:hai|ho|hain)|sab\s*thik)[\s.!?,]*$/i.test(s) ||
    /^(?:aur\s+(?:batao|bataiye|kya\s*chal\s*raha\s*(?:hai|hain)?)|sab\s*badhiya|sab\s*theek)[\s.!?,]*$/i.test(s) ||
    /^(?:how\s*are\s*you|what\s*are\s*you\s*doing|what\'?s\s*up|who\s*are\s*you|are\s*you\s*there)[\s.!?,]*$/i.test(s) ||
    /^(?:myraa?|sora)[\s.!?,]*$/i.test(s) ||
    /^(?:suno|sun\s*rahi\s*ho|sun\s*rahe\s*ho|myraa?\s*suno|hello\s*myraa?\s*suno|lo\s*myraa?|arre\s*myraa?|are\s*myraa?)[\s.!?,]*$/i.test(s) ||
    // Devanagari patterns: "नमस्ते", "हेलो मायरा", "लो मायरा", "क्या कर रही हो", "कैसी हो", etc.
    /^(?:नमस्ते|नमस्कार|प्रणाम|हेलो|हाय|सुप्रभात|शुभ\s*संध्या|राम\s*राम)(?:\s+(?:मायरा|सोरा))?[\s।!?]*$/i.test(s) ||
    /^(?:लो\s*मायरा|अरे\s*मायरा|मायरा|मायरा\s*सुनो|सुन\s*रही\s*हो)[\s।!?]*$/i.test(s) ||
    /^(?:क्या\s*(?:हाल|कर\s*रही|कर\s*रहे|चल\s*रहा|हो\s*रहा)\s*(?:है|हो|हैं)?\??|कैसी\s*हो\??|कैसे\s*हो\??|सब\s*ठीक\??)[\s।!?]*$/i.test(s);

  if (isGreetingPattern) {
    return true;
  }

  // Also check if after stripping common greeting prefixes and conversational fillers, the remainder has 0 words
  const stripped = s
    .replace(/\b(?:hello|hi|hey|hlo|namaste|namaskar|pranam|myraa?|sora|please|plz|zara|bhai|yaar|ji|batao|bataiye|bolo|kya|kar|rahi|rahe|ho|hai|hain|haal|hal|chal|theek|thik|badhiya)\b/gi, "")
    .replace(/[^\w\s\u0900-\u097F]/gi, "")
    .trim();

  if (!stripped || stripped.length === 0) {
    return true;
  }

  return false;
}

export interface FunctionCall {
  name: string;
  args: Record<string, unknown>;
  id?: string;
}

/** Minimal typing for the Gemini Live session object. */
export interface LiveSession {
  sendToolResponse(payload: {
    functionResponses: Array<{
      name: string;
      response: { output: unknown };
      id?: string;
    }>;
  }): void;
  requestSessionRotation?(reason?: string): void;
}

/** Callback used to push messages to the browser WebSocket client. */
export type SendToClientFn = (payload: unknown) => void;

export class ToolOrchestrator {
  /**
   * Stage 10.3 P2: Server-side explicit project selection per trusted sessionId.
   * Populated ONLY when an authorized caller explicitly switches/selects a project
   * for that session. Never inferred from global ProjectStore.activeProjectId or
   * arbitrary project ordering, and never overridden by model-supplied tool args.
   */
  private _explicitSessionProjects = new Map<string, string>();

  /**
   * Bind an explicitly selected canonical project ID to a trusted server-side session.
   * Validates canonical existence and (when provided) caller authorization before binding.
   */
  async setSessionProjectContext(
    sessionId: string,
    projectId: string,
    secContext?: SecurityContext,
  ): Promise<{ bound: boolean; projectId?: string; reason?: string }> {
    const sid = typeof sessionId === "string" ? sessionId.trim() : "";
    if (!sid) {
      return { bound: false, reason: "Session ID is required." };
    }
    const resolution = await resolveCanonicalProjectId(projectId, {
      secContext,
      requireAuthorizedContext: Boolean(secContext),
    });
    if (resolution.status !== "resolved") {
      return {
        bound: false,
        reason: resolution.status === "omitted" ? "Project ID is required." : resolution.reason,
      };
    }
    this._explicitSessionProjects.set(sid, resolution.projectId);
    return { bound: true, projectId: resolution.projectId };
  }

  /** Clear any explicit session-scoped project selection. */
  clearSessionProjectContext(sessionId: string): void {
    const sid = typeof sessionId === "string" ? sessionId.trim() : "";
    if (sid) {
      this._explicitSessionProjects.delete(sid);
    }
  }

  /** Return the explicitly bound canonical project ID for a session, or undefined. */
  getSessionProjectContext(sessionId: string): string | undefined {
    const sid = typeof sessionId === "string" ? sessionId.trim() : "";
    if (!sid) return undefined;
    return this._explicitSessionProjects.get(sid);
  }

  /**
   * Dispatch a single function call received from the Gemini Live API.
   *
   * @param fc        The function call descriptor from Gemini
   * @param session   The active Gemini Live session (for tool responses)
   * @param sendToClient  Callback that serialises and sends to the browser WS
   * @param apiKey    Gemini API key (needed by saveCustomMemory → memory write)
   */
  async dispatch(
    fc: FunctionCall,
    session: LiveSession,
    sendToClient: SendToClientFn,
    _apiKey: string,
    context?: SecurityContext,
  ): Promise<void> {
    // AUD-P0-01: Safe structured function-call logging — NEVER log raw argument values.
    // Logs only tool name, allowlisted safe action identifier, and argument key names.
    const safeArgKeys = Object.keys(fc.args || {}).slice(0, 20);
    const rawAction = typeof fc.args?.action === "string" ? fc.args.action : undefined;
    const safeAction =
      rawAction &&
      /^[a-z0-9_-]{1,40}$/i.test(rawAction) &&
      !/^(sora_|myraa_|AIza|eyJ|sk-)/i.test(rawAction)
        ? rawAction
        : undefined;
    console.log(`[Function Call]: ${fc.name}`, {
      ...(safeAction ? { action: safeAction } : {}),
      argKeys: safeArgKeys,
    });

    // ── Emergency Stop Killswitch Guard ──────────────────────────────────
    if (emergencyStopCoordinator.isActive() && fc.name !== "triggerEmergencyStop") {
      console.warn(`[EmergencyStop] Blocked tool execution '${fc.name}' — killswitch active.`);
      session.sendToolResponse({
        functionResponses: [
          {
            name: fc.name,
            response: {
              output: {
                error: "EMERGENCY_STOP_ACTIVE: Operations are blocked until the emergency stop is reset by an operator.",
                blocked: true,
              },
            },
            id: fc.id,
          },
        ],
      });
      return;
    }

    // ── Deterministic Security Policy Engine Gate (Phase 10A + AUD-P0-03) ─
    // Never trust (fc as any).securityContext and NEVER synthesize an admin/local_operator
    // identity when trusted server-side context is absent or malformed.
    const VALID_CONTEXT_ROLES = new Set(["admin", "standard", "read_only", "guest"]);
    const hasTrustedContext = Boolean(
      context &&
      typeof context === "object" &&
      typeof context.identityId === "string" &&
      context.identityId.trim().length > 0 &&
      typeof context.role === "string" &&
      VALID_CONTEXT_ROLES.has(context.role),
    );
    const trustedSecContext: SecurityContext | undefined =
      hasTrustedContext && context
        ? {
            identityId: context.identityId.trim(),
            role: context.role,
            ipAddress: context.ipAddress || "unknown",
            ...(context.sessionId ? { sessionId: context.sessionId } : {}),
            ...(context.deviceId ? { deviceId: context.deviceId } : {}),
            isLocal: Boolean(context.isLocal),
          }
        : undefined;
    const secContext: SecurityContext = trustedSecContext || {
      identityId: "missing_security_context",
      role: "guest",
      ipAddress: "unknown",
      isLocal: false,
    };

    const providedConfirmation =
      (fc.args?.confirmationToken as string) ||
      (fc.args?.checkpointId as string) ||
      (fc.args?._checkpointId as string);

    // AUD-P0-02 (C3): For trackProjectTask(action="confirm_decision") in STRICT/PARANOID modes,
    // route through deterministic non-token checks (Lockdown, critical risk, arg validation, trusted
    // context) and delegate to _handleProjectTool so no throwaway generic token is minted or leaked
    // to the model while preserving non-mutating UI challenge / fail-closed credential rejection.
    const isProjectConfirmDecision =
      fc.name === "trackProjectTask" && fc.args?.action === "confirm_decision";
    const currentPolicyMode = securityPolicyEngine.getMode();
    const useStrictProjectConfirmRoute =
      isProjectConfirmDecision &&
      (currentPolicyMode === "STRICT" || currentPolicyMode === "PARANOID");

    if (useStrictProjectConfirmRoute) {
      if (securityPolicyEngine.isToolDisabled(fc.name)) {
        const errMsg = `TOOL_DISABLED: Tool '${fc.name}' has been dynamically disabled by automated containment.`;
        console.warn(`[SecurityPolicyEngine] Blocked tool execution '${fc.name}': ${errMsg}`);
        const { sanitized } = outputDataFirewall.sanitizeResult(
          { error: errMsg, blocked: true, requiresConfirmation: false, riskLevel: "HIGH" },
          { toolName: fc.name, sessionId: secContext.sessionId, ipAddress: secContext.ipAddress },
        );
        session.sendToolResponse({
          functionResponses: [{ name: fc.name, response: { output: sanitized }, id: fc.id }],
        });
        return;
      }
      if (!hasTrustedContext) {
        console.warn(`[SecurityPolicyEngine] Blocked tool execution '${fc.name}': MISSING_SECURITY_CONTEXT`);
        const { sanitized } = outputDataFirewall.sanitizeResult(
          {
            error: "MISSING_SECURITY_CONTEXT",
            reason: "Missing or invalid trusted server-side security context.",
            blocked: true,
            requiresConfirmation: false,
            riskLevel: "HIGH",
          },
          { toolName: fc.name, sessionId: secContext.sessionId, ipAddress: secContext.ipAddress },
        );
        session.sendToolResponse({
          functionResponses: [{ name: fc.name, response: { output: sanitized }, id: fc.id }],
        });
        return;
      }
      const risk = securityPolicyEngine.evaluateRisk(fc.name, fc.args || {}, secContext);
      if (risk.score >= 95) {
        const errMsg = securityAuditLogger.sanitizeData(
          `CRITICAL_SECURITY_BLOCK: Malicious/suspicious pattern detected in '${fc.name}'.`,
        );
        console.warn(`[SecurityPolicyEngine] Blocked tool execution '${fc.name}': ${errMsg}`);
        const { sanitized } = outputDataFirewall.sanitizeResult(
          { error: errMsg, blocked: true, requiresConfirmation: false, riskLevel: "CRITICAL" },
          { toolName: fc.name, sessionId: secContext.sessionId, ipAddress: secContext.ipAddress },
        );
        session.sendToolResponse({
          functionResponses: [{ name: fc.name, response: { output: sanitized }, id: fc.id }],
        });
        return;
      }
      const argVal = await securityPolicyEngine.validateArguments(fc.name, fc.args || {});
      if (!argVal.valid) {
        const errMsg = securityAuditLogger.sanitizeData(argVal.reason || "Invalid arguments.");
        console.warn(`[SecurityPolicyEngine] Blocked tool execution '${fc.name}': ${errMsg}`);
        const { sanitized } = outputDataFirewall.sanitizeResult(
          { error: errMsg, blocked: true, requiresConfirmation: false, riskLevel: "HIGH" },
          { toolName: fc.name, sessionId: secContext.sessionId, ipAddress: secContext.ipAddress },
        );
        session.sendToolResponse({
          functionResponses: [{ name: fc.name, response: { output: sanitized }, id: fc.id }],
        });
        return;
      }
    } else {
      const policyDecision = await securityPolicyEngine.evaluateRequest(
        fc.name,
        fc.args || {},
        secContext,
        providedConfirmation,
      );

      if (!policyDecision.allowed) {
        const isMissingCtxBlock =
          !hasTrustedContext &&
          policyDecision.decision === "BLOCK" &&
          !policyDecision.reason.startsWith("SECURITY_LOCKDOWN") &&
          !policyDecision.reason.startsWith("CRITICAL_SECURITY_BLOCK") &&
          !policyDecision.reason.startsWith("TOOL_DISABLED");
        const errorOut = isMissingCtxBlock
          ? "MISSING_SECURITY_CONTEXT"
          : securityAuditLogger.sanitizeData(policyDecision.reason);

        // AUD-P0-02 (C1): NEVER expose confirmationToken in model tool output or errors.
        // If evaluateRequest minted a generic token that cannot be delivered over a dedicated
        // authenticated UI channel, immediately revoke it when bound to a session so no unused
        // capability lingers, and fail closed.
        if (policyDecision.confirmationToken && secContext.sessionId) {
          try {
            securityPolicyEngine.revokeConfirmationToken(
              policyDecision.confirmationToken,
              fc.name,
              fc.args || {},
              secContext.sessionId,
            );
          } catch {
            // Best-effort revocation; token is never exposed regardless
          }
        }

        console.warn(`[SecurityPolicyEngine] Blocked tool execution '${fc.name}': ${errorOut}`);
        const blockedPayload = {
          error: errorOut,
          ...(isMissingCtxBlock
            ? { reason: "Missing or invalid trusted server-side security context." }
            : {}),
          blocked: true,
          requiresConfirmation: policyDecision.decision === "REQUIRE_CONFIRMATION",
          ...(policyDecision.decision === "REQUIRE_CONFIRMATION"
            ? { status: "confirmation_required" }
            : {}),
          riskLevel: policyDecision.risk.level,
        };
        const { sanitized } = outputDataFirewall.sanitizeResult(blockedPayload, {
          toolName: fc.name,
          sessionId: secContext.sessionId,
          ipAddress: secContext.ipAddress,
        });
        session.sendToolResponse({
          functionResponses: [
            {
              name: fc.name,
              response: {
                output: sanitized,
              },
              id: fc.id,
            },
          ],
        });
        return;
      }
    }

    // ── Output/Data Firewall Guarded Session (DLP Result Redaction) ───────
    const originalSendToolResponse = session.sendToolResponse.bind(session);
    const guardedSession: LiveSession = {
      sendToolResponse: (payload) => {
        const sanitizedResponses = payload.functionResponses.map((fr) => {
          const { sanitized } = outputDataFirewall.sanitizeResult(fr.response.output, {
            toolName: fr.name,
            sessionId: secContext.sessionId,
            ipAddress: secContext.ipAddress,
          });
          return {
            ...fr,
            response: { output: sanitized },
          };
        });
        originalSendToolResponse({ functionResponses: sanitizedResponses });
      },
      requestSessionRotation: typeof (session as any).requestSessionRotation === "function"
        ? (reason?: string) => (session as any).requestSessionRotation(reason)
        : undefined,
    };

    // ── Conversational Greeting Gatekeeper ────────────────────────────────
    // Never allow browser, YouTube, or media tools to execute on greetings or casual chat!
    const isMediaOrBrowserAction =
      MEDIA_BROWSER_TOOLS.has(fc.name) ||
      (fc.name === "openApplication" && /youtube|browser|chrome|edge/i.test(String(fc.args?.name || "")));

    if (isMediaOrBrowserAction) {
      const activeUtterance =
        (fc.args?._userUtterance as string) ||
        actionContextManager.getLastUserUtterance(secContext.sessionId || secContext.deviceId || "default") ||
        actionContextManager.getLastUserUtterance("default");

      if (activeUtterance && isConversationalGreetingOrChat(activeUtterance)) {
        console.warn(
          `[ToolOrchestrator] Intercepted and blocked hallucinated media/browser tool '${fc.name}' on conversational greeting: "${activeUtterance}"`,
        );
        guardedSession.sendToolResponse({
          functionResponses: [
            {
              name: fc.name,
              response: {
                output: {
                  suppressed: true,
                  reason: "CONVERSATIONAL_GREETING_DETECTED",
                  directive:
                    "User gave a conversational greeting or casual remark without asking for browser or media actions. Respond warmly and conversationally in voice. Do NOT execute any browser actions.",
                },
              },
              id: fc.id,
            },
          ],
        });
        return;
      }
    }

    // ── Canonical Intent & Capability Resolution ──────────────────────────
    const contextId = secContext.sessionId || secContext.deviceId || "default";
    const canonicalIntent = intentResolver.resolveFromToolCall(
      fc.name,
      (fc.args || {}) as Record<string, unknown>,
      contextId,
      secContext,
    );

    // 1. Explicit Target Device Availability Check (no silent fallback)
    if (
      fc.args?.targetDevice ||
      canonicalIntent.targetDevice === "REMOTE_DESKTOP" ||
      (!secContext.isLocal && canonicalIntent.targetDevice === "DESKTOP" && Boolean(process.env.RENDER))
    ) {
      const deviceCheck = capabilityRegistry.verifyTargetDeviceAvailability(
        canonicalIntent.targetDevice,
        secContext,
      );
      if (!deviceCheck.available) {
        guardedSession.sendToolResponse({
          functionResponses: [
            {
              name: fc.name,
              response: {
                output: {
                  error: deviceCheck.reason,
                  errorCode: "TARGET_DEVICE_UNAVAILABLE",
                  targetDevice: canonicalIntent.targetDevice,
                  verified: false,
                  isDeviceUnavailable: true,
                  isPermissionDenied: false,
                },
              },
              id: fc.id,
            },
          ],
        });
        return;
      }
    }

    // 2. YouTube / Media Guard: If Gemini called searchYouTube or browserSearch with a generic
    //    placeholder ("trending songs") while searchResults already exist in ActionContext,
    //    intercept it as PLAY_MEDIA on the selectedResult!
    if (
      (fc.name === "searchYouTube" || fc.name === "browserSearch") &&
      canonicalIntent.intent === "PLAY_MEDIA"
    ) {
      const playVerification = actionVerifier.verifyYouTubePlay(
        {
          videoId: canonicalIntent.arguments.videoId as string,
          title: canonicalIntent.arguments.title as string,
          url: canonicalIntent.arguments.url as string,
        },
        "play",
        canonicalIntent.targetDevice,
      );
      actionContextManager.recordMediaPlayback(contextId, "playing");
      sendToClient({
        type: "toolCall",
        callId: fc.id,
        name: "browserMediaControl",
        args: {
          action: "play",
          videoId: canonicalIntent.arguments.videoId,
          title: canonicalIntent.arguments.title,
          url: canonicalIntent.arguments.url,
          index: canonicalIntent.arguments.index,
          songNumber: canonicalIntent.arguments.songNumber,
          selector: canonicalIntent.arguments.selector,
        },
      });
      guardedSession.sendToolResponse({
        functionResponses: [
          {
            name: fc.name,
            response: {
              output: {
                ...playVerification,
                result: `Playing '${playVerification.title}' (${playVerification.videoIdOrUrl}).`,
              },
            },
            id: fc.id,
          },
        ],
      });
      return;
    }

    // 3. Record YouTube / Media search in ActionContext when searchYouTube or browserSearch runs
    if (
      (fc.name === "searchYouTube" || fc.name === "browserSearch") &&
      canonicalIntent.intent === "SEARCH_MEDIA" &&
      fc.args?.query
    ) {
      if (Array.isArray(fc.args.results) && fc.args.results.length > 0) {
        actionContextManager.recordMediaSearch(
          contextId,
          String(fc.args.query),
          fc.args.results as any,
          "youtube",
        );
      } else {
        const ctx = actionContextManager.getContext(contextId);
        ctx.currentSearchQuery = String(fc.args.query).trim();
        ctx.currentWebsite = "youtube";
      }
    }

    // 4. Normalize openApplication alias & check for unresolved contextual/unknown apps
    if (fc.name === "openApplication") {
      if (!canonicalIntent.arguments.aliasResolved) {
        const errReason =
          (canonicalIntent.arguments.aliasReason as string) ||
          `UNRECOGNIZED_APPLICATION: Application '${fc.args?.name || ""}' could not be resolved.`;
        guardedSession.sendToolResponse({
          functionResponses: [
            {
              name: fc.name,
              response: {
                output: {
                  error: errReason,
                  errorCode: "UNRECOGNIZED_APPLICATION",
                  launched: false,
                  verified: false,
                  isPermissionDenied: false,
                },
              },
              id: fc.id,
            },
          ],
        });
        return;
      }
      fc.args = {
        ...fc.args,
        name: canonicalIntent.entity || fc.args?.name,
      };
    }

    // ── 1. saveCustomMemory — handled in-process ──────────────────────────
    if (fc.name === "saveCustomMemory") {
      try {
        await this._handleSaveCustomMemory(fc, guardedSession, sendToClient, secContext);
      } catch (err) {
        console.error("saveCustomMemory execution failure:", err);
      }
      return;
    }

    // ── 2. Project Intelligence tools — handled in-process (Phase 3) ─────
    if (PROJECT_TOOLS.has(fc.name)) {
      try {
        await this._handleProjectTool(fc, guardedSession, sendToClient, trustedSecContext);
      } catch (err) {
        console.error(`[Project Intelligence] Unhandled error for ${fc.name}:`, err);
      }
      return;
    }

    // ── 3. Research & Knowledge Engine tools — handled in-process (Phase 4) ─
    if (RESEARCH_TOOLS.has(fc.name)) {
      try {
        await this._handleResearchTool(fc, guardedSession);
      } catch (err) {
        console.error(`[Research Engine] Unhandled error for ${fc.name}:`, err);
      }
      return;
    }

    // ── 4. Agent Planner tools — handled in-process (Phase 5) ─────────────
    if (PLANNER_TOOLS.has(fc.name)) {
      try {
        await this._handlePlannerTool(fc, guardedSession, sendToClient, trustedSecContext);
      } catch (err) {
        console.error(`[Planner] Unhandled error for ${fc.name}:`, err);
      }
      return;
    }

    // ── 5. Proactive Companion tools — handled in-process (Phase 6) ──────
    if (COMPANION_TOOLS.has(fc.name)) {
      try {
        await this._handleCompanionTool(fc, guardedSession, sendToClient);
      } catch (err) {
        console.error(`[Companion] Unhandled error for ${fc.name}:`, err);
      }
      return;
    }

    // ── 6. Remote Companion tools — handled in-process (Phase 7) ─────────
    if (REMOTE_TOOLS.has(fc.name)) {
      try {
        await this._handleRemoteTool(fc, guardedSession, sendToClient);
      } catch (err) {
        console.error(`[Remote Tools] Unhandled error for ${fc.name}:`, err);
      }
      return;
    }

    // ── 7. Multimodal Intelligence tools — handled in-process (Phase 8) ──────
    if (MULTIMODAL_TOOLS.has(fc.name)) {
      try {
        await this._handleMultimodalTool(fc, guardedSession, sendToClient);
      } catch (err) {
        console.error(`[Multimodal Tools] Unhandled error for ${fc.name}:`, err);
      }
      return;
    }

    // ── 8. AI Study Companion tools — handled in-process (Phase 9 Stage 1) ───
    if (STUDY_TOOLS.has(fc.name)) {
      try {
        await this._handleStudyTool(fc, guardedSession, sendToClient);
      } catch (err) {
        console.error(`[Study Companion] Unhandled error for ${fc.name}:`, err);
      }
      return;
    }

    // ── Desktop Security Gate Management (Dynamic Passcode Protection) ───
    if (fc.name === "setDesktopControlPasscode") {
      const passcode = String(fc.args?.passcode || fc.args?.code || fc.args?.newPasscode || "");
      const result = desktopSecurityGate.setPasscode(passcode, secContext.identityId);
      guardedSession.sendToolResponse({
        functionResponses: [
          {
            name: fc.name,
            response: {
              output: {
                success: result.success,
                message: result.message,
                passcode: desktopSecurityGate.getPasscode(),
              },
            },
            id: fc.id,
          },
        ],
      });
      return;
    }

    if (fc.name === "requestDesktopControl") {
      const result = desktopSecurityGate.requestDesktopControl();
      // PER-RUN SECURITY: Even if gate says alreadyUnlocked (same session), we
      // surface the challenge prompt to reinforce the policy. Gate is always
      // locked fresh on session start via lockForNewSession().
      guardedSession.sendToolResponse({
        functionResponses: [
          {
            name: fc.name,
            response: {
              output: {
                challenge: result.challengeRequired ? result.prompt : DESKTOP_CHALLENGE_PROMPT,
                challengeRequired: result.challengeRequired || !result.alreadyUnlocked,
                alreadyUnlocked: result.alreadyUnlocked,
                directive: result.alreadyUnlocked
                  ? "Desktop control is already unlocked in this session. Proceed with the requested action."
                  : `Sandeep se out-loud boliye: '${DESKTOP_CHALLENGE_PROMPT}'`,
              },
            },
            id: fc.id,
          },
        ],
      });
      return;
    }


    if (fc.name === "unlockDesktopControl") {
      const passcode = String(fc.args?.passcode || fc.args?.code || "");
      const result = desktopSecurityGate.verifyPasscode(passcode, secContext.identityId);
      guardedSession.sendToolResponse({
        functionResponses: [
          {
            name: fc.name,
            response: {
              output: {
                success: result.success,
                message: result.message,
                status: result.status,
                failedAttempts: result.failedAttempts,
              },
            },
            id: fc.id,
          },
        ],
      });
      return;
    }

    if (fc.name === "getDesktopControlStatus") {
      const status = desktopSecurityGate.getStatus();
      guardedSession.sendToolResponse({
        functionResponses: [
          {
            name: fc.name,
            response: { output: status },
            id: fc.id,
          },
        ],
      });
      return;
    }

    // ── 9. Desktop control tools — route to Python agent ─────────────────
    if (DESKTOP_TOOLS.has(fc.name)) {

      // ── FULL DESKTOP SECURITY GATE — ALL tools blocked until code given ──
      // Every desktop tool (openApplication, openWebsite, volumeUp, searchWeb,
      // createFile, runShellCommand, takeScreenshot, etc.) requires the passcode.
      // Per-run model: gate is LOCKED fresh on every new Myraa session start.
      // No tool execution is allowed before code verification — no exceptions.
      if (!desktopSecurityGate.isUnlocked()) {
        const req = desktopSecurityGate.requestDesktopControl();
        console.warn(`[DesktopSecurityGate] BLOCKED '${fc.name}' — gate LOCKED. Passcode required.`);
        guardedSession.sendToolResponse({
          functionResponses: [
            {
              name: fc.name,
              response: {
                output: {
                  error: `DESKTOP_CONTROL_LOCKED: Desktop control locked hai. ${req.prompt}`,
                  challenge: req.prompt,
                  requiresPasscode: true,
                  blocked: true,
                  toolBlocked: fc.name,
                  directive: `Sandeep ko out-loud boliye: '${req.prompt}'`,
                  instruction: "Code milne se pehle koi bhi desktop action bilkul mat karo. Sirf code maango.",
                },
              },
              id: fc.id,
            },
          ],
        });
        return;
      }

      const appName = String(fc.args?.app_name || fc.args?.appName || fc.args?.name || "").toLowerCase().trim();
      const siteUrl = String(fc.args?.url || fc.args?.name || "").toLowerCase().trim();
      const isYouTubeTarget =
        appName === "youtube" ||
        siteUrl === "youtube" ||
        siteUrl.includes("youtube.com") ||
        siteUrl.includes("youtu.be");

      if (isYouTubeTarget) {
        // Project onto Myraa's on-screen Holographic browser HUD immediately
        sendToClient({
          type: "toolCall",
          callId: fc.id,
          name: "browserOpen",
          args: { url: "https://www.youtube.com" },
        });

        // Also launch desktop browser if local agent is present
        if (secContext.isLocal) {
          callDesktopAgent(fc.name, (fc.args || {}) as Record<string, unknown>).catch(() => {});
        }

        actionContextManager.recordWebsiteOpened(contextId, "https://www.youtube.com", "BROWSER");
        guardedSession.sendToolResponse({
          functionResponses: [
            {
              name: fc.name,
              response: {
                output: {
                  launched: true,
                  appName: "YouTube",
                  opened: true,
                  url: "https://www.youtube.com",
                  verified: true,
                  targetDevice: "BROWSER",
                  result: "YouTube opened in Myraa's Real-time Portal.",
                },
              },
              id: fc.id,
            },
          ],
        });
        return;
      }

      if (fc.name === "searchYouTube" && fc.args?.query) {
        // Project onto Myraa's on-screen Holographic browser HUD as well
        sendToClient({
          type: "companion_notification",
          notification: {
            type: "browser_action",
            action: "browserSearch",
            query: fc.args.query,
            target: "youtube"
          }
        });
      }

      // If this is a remote companion session and the tool maps to a mobile capability, forward to client
      if (!secContext.isLocal) {
        const appName = String(fc.args?.app_name || fc.args?.appName || fc.args?.name || "").toLowerCase().trim();
        const isDesktopAppTarget =
          fc.name === "openApplication" &&
          ([
            "vscode", "vs code", "code", "visual studio code",
            "cursor", "cursor editor", "cursor ai",
            "notepad", "wordpad", "calc", "calculator",
            "file explorer", "explorer", "file manager", "files",
            "task manager", "taskmgr", "command prompt", "cmd", "powershell",
            "terminal", "paint", "snipping tool", "chrome", "edge"
          ].includes(appName) || /code|explorer|terminal|notepad|studio|taskmgr|cmd/i.test(appName));

        const mobileMapped = !isDesktopAppTarget && [
          "openApplication",
          "openWebsite",
          "setVolume",
          "volumeUp",
          "volumeDown",
          "muteToggle",
          "systemInfo",
          "copySelected",
          "pasteClipboard",
          "getClipboard",
          "clearClipboard",
          // Phase 20 Browser Assistant tools
          "searchWeb",
          "searchGoogle",
          "desktopBrowserOpen",
          "desktopBrowserNavigate",
          "desktopBrowserSearch",
          "desktopBrowserGoBack",
          "desktopBrowserGoForward",
          // Phase 21 Mobile App Interaction Layer
          "interactApp",
          "appInteraction",
          "interactWithApp",
          "mobileAppAction",
          // Phase 22 Mobile Context Intelligence
          "mobileContext",
          "getContextSnapshot",
          "getMobileContext",
          "deviceContext",
          "activeMobileContext",
          "screenContext",
          // Phase 23 Mobile Screen Understanding
          "mobileScreen",
          "screenUnderstanding",
          "captureMobileScreen",
          "readMobileScreen",
          "understandScreen",
          "screenCapture",
          // Phase 24 Shared MYRAA Memory
          "sharedMemory",
          "memorySync",
          "syncMemory",
          "getSharedMemory",
          "saveSharedMemory",
          // Phase 25 Cross-Device Handoff
          "handoff",
          "crossDeviceHandoff",
          "deviceHandoff",
          "resumeHandoff",
          "createHandoff",
          // Phase 26 Mobile Proactive Companion
          "mobileProactive",
          "proactiveNotification",
          "notifyMobile",
          "dispatchProactiveNotification",
          // Phase 27 Mobile Autonomous Workflow
          "mobileWorkflow",
          "autonomousWorkflow",
          "executeWorkflow",
        ].includes(fc.name);

        if (mobileMapped) {
          sendToClient({
            type: "toolCall",
            callId: fc.id,
            name: fc.name,
            args: fc.args,
          });
          return;
        }
      }




      try {
        await this._handleDesktopTool(fc, guardedSession, contextId, sendToClient);
      } catch (err) {
        console.error(`[Desktop Agent] Unhandled error for ${fc.name}:`, err);
      }
      return;
    }

    // ── 10. Client-side holographic tools (browserMediaControl, browserClick, browserSearch, browserOpen) ─
    if (fc.name === "browserMediaControl" || fc.name === "browserClick") {
      fc.args = {
        ...fc.args,
        ...canonicalIntent.arguments,
      };
      if (canonicalIntent.intent === "NEXT_MEDIA") {
        actionContextManager.advanceMediaResult(contextId, "next");
      } else if (canonicalIntent.intent === "PREVIOUS_MEDIA") {
        actionContextManager.advanceMediaResult(contextId, "previous");
      } else if (canonicalIntent.intent === "PAUSE_MEDIA") {
        actionContextManager.recordMediaPlayback(contextId, "paused");
      } else if (canonicalIntent.intent === "STOP_MEDIA") {
        actionContextManager.recordMediaPlayback(contextId, "stopped");
      } else if (canonicalIntent.intent === "PLAY_MEDIA" || canonicalIntent.intent === "RESUME_MEDIA") {
        actionContextManager.recordMediaPlayback(contextId, "playing");
      }
    } else if (fc.name === "browserOpen" && fc.args?.url) {
      actionContextManager.recordWebsiteOpened(contextId, String(fc.args.url), "BROWSER");
    }

    sendToClient({
      type: "toolCall",
      callId: fc.id,
      name: fc.name,
      args: fc.args,
    });
  }

  private async _handleProjectTool(
    fc: FunctionCall,
    session: LiveSession,
    sendToClient?: SendToClientFn,
    secContext?: SecurityContext,
  ): Promise<void> {
    try {
      const args = fc.args || {};
      let output: unknown = { result: "Done." };

      // GAP-10.3-04 (P0 Security): Build trusted audit actor strictly from server-side secContext.
      // Never hardcode "local_user" or invent an authenticated identity when missing.
      const VALID_ROLES = new Set(["admin", "standard", "read_only", "guest"]);
      const hasValidSecContext = Boolean(
        secContext &&
        typeof secContext.identityId === "string" &&
        secContext.identityId.trim().length > 0 &&
        typeof secContext.role === "string" &&
        VALID_ROLES.has(secContext.role),
      );
      const trustedAuditActor = hasValidSecContext && secContext
        ? {
            identityId: secContext.identityId.trim(),
            role: secContext.role,
            ipAddress: secContext.ipAddress || "unknown",
            ...(secContext.sessionId ? { sessionId: secContext.sessionId } : {}),
            ...(secContext.deviceId ? { deviceId: secContext.deviceId } : {}),
            isLocal: Boolean(secContext.isLocal),
          }
        : {
            identityId: "missing_security_context",
            role: "guest" as const,
            ipAddress: secContext?.ipAddress || "unknown",
            isLocal: false,
          };

      const enforceProjectMutationAuth = (
        actionLabel: string,
        resource: string,
      ): { allowed: true } | { allowed: false; output: Record<string, unknown> } => {
        if (emergencyStopCoordinator.isActive()) {
          securityAuditLogger.logEvent({
            eventType: "TOOL_BLOCKED",
            actor: trustedAuditActor,
            target: { toolName: fc.name, resource },
            decision: "BLOCK",
            reason: `EMERGENCY_STOP_ACTIVE: Project action '${actionLabel}' blocked while Emergency Stop is active.`,
            riskLevel: "CRITICAL",
            metadata: { action: actionLabel },
          });
          return {
            allowed: false,
            output: {
              success: false,
              blocked: true,
              error: "EMERGENCY_STOP_ACTIVE",
              reason: "Operations are blocked while Emergency Stop is active.",
            },
          };
        }

        if (securityPolicyEngine.getMode() === "LOCKDOWN") {
          securityAuditLogger.logEvent({
            eventType: "TOOL_BLOCKED",
            actor: trustedAuditActor,
            target: { toolName: fc.name, resource },
            decision: "BLOCK",
            reason: `SECURITY_LOCKDOWN_ACTIVE: Project action '${actionLabel}' blocked in LOCKDOWN mode.`,
            riskLevel: "CRITICAL",
            metadata: { action: actionLabel },
          });
          return {
            allowed: false,
            output: {
              success: false,
              blocked: true,
              error: "SECURITY_LOCKDOWN_ACTIVE",
              reason: "Operations are blocked while Security Lockdown is active.",
            },
          };
        }

        if (!hasValidSecContext || !secContext) {
          securityAuditLogger.logEvent({
            eventType: "TOOL_BLOCKED",
            actor: trustedAuditActor,
            target: { toolName: fc.name, resource },
            decision: "BLOCK",
            reason: `MISSING_SECURITY_CONTEXT: Project action '${actionLabel}' requires a valid server-side security context.`,
            riskLevel: "HIGH",
            metadata: { action: actionLabel },
          });
          return {
            allowed: false,
            output: {
              success: false,
              blocked: true,
              error: "MISSING_SECURITY_CONTEXT",
              reason: "Missing or invalid trusted security context.",
            },
          };
        }

        if (!secContext.isLocal && (!secContext.sessionId || !secContext.sessionId.trim())) {
          securityAuditLogger.logEvent({
            eventType: "TOOL_BLOCKED",
            actor: trustedAuditActor,
            target: { toolName: fc.name, resource },
            decision: "BLOCK",
            reason: `MISSING_SESSION_CONTEXT: Remote project action '${actionLabel}' requires an authenticated session ID.`,
            riskLevel: "HIGH",
            metadata: { action: actionLabel },
          });
          return {
            allowed: false,
            output: {
              success: false,
              blocked: true,
              error: "MISSING_SESSION_CONTEXT",
              reason: "Authenticated session context is required for remote mutating project actions.",
            },
          };
        }

        if (secContext.role === "guest" || secContext.role === "read_only") {
          securityAuditLogger.logEvent({
            eventType: "TOOL_BLOCKED",
            actor: trustedAuditActor,
            target: { toolName: fc.name, resource },
            decision: "BLOCK",
            reason: `PERMISSION_DENIED: Role '${secContext.role}' is not permitted to execute mutating project action '${actionLabel}'.`,
            riskLevel: "HIGH",
            metadata: { action: actionLabel },
          });
          return {
            allowed: false,
            output: {
              success: false,
              blocked: true,
              error: "PERMISSION_DENIED",
              reason: `Role '${secContext.role}' is not permitted to perform '${actionLabel}'.`,
            },
          };
        }

        return { allowed: true };
      };

      if (fc.name === "analyzeProject") {
        const proj = await projectManager.analyzeProject((args.path as string) || undefined);
        output = {
          name: proj.name,
          type: proj.type,
          primaryLanguage: proj.primaryLanguage,
          frameworks: proj.frameworks,
          summary: proj.summary,
          architecture: proj.architectureMap,
        };
      } else if (fc.name === "getProjectArchitecture") {
        const proj = await projectManager.analyzeProject();
        output = {
          architecture: proj.architectureMap,
          summary: proj.summary,
        };
      } else if (fc.name === "searchProjectCode") {
        const query = (args.query as string) || "";
        const matches = await projectManager.searchCode(query, {
          filePattern: args.filePattern as string,
          caseSensitive: args.caseSensitive === true,
          maxResults: args.maxResults ? Number(args.maxResults) : 20,
        });
        output = {
          query,
          matchCount: matches.length,
          matches: matches.slice(0, 15), // Bounded payload
        };
      } else if (fc.name === "getProjectGitStatus") {
        output = await projectManager.getGitStatus();
      } else if (fc.name === "trackProjectTask") {
        const action = args.action as string;

        // Security: sanitize user-supplied project name
        let projectName = args.projectName ? String(args.projectName) : undefined;
        if (projectName) {
          const scan = contentSanitizer.scanForPromptInjection(projectName, {
            source: "trackProjectTask_projectName",
          });
          if (scan.hasInjectionAttempt) {
            output = { error: "Project name contains invalid content.", blocked: true };
            session.sendToolResponse({
              functionResponses: [{ name: fc.name, response: { output }, id: fc.id }],
            });
            return;
          }
          projectName = scan.sanitizedText.trim().substring(0, 200);
        }

        // GAP-10.3-04 (Batch C): Enforce RBAC + trusted actor/session context on ALL mutating
        // or sensitive actions (including sessionSummary writes attached to read actions like resume/list).
        const hasSessionSummaryWrite =
          typeof args.sessionSummary === "string" && args.sessionSummary.trim().length > 0;
        const isMutatingOrSensitiveAction =
          action === "add" ||
          action === "update" ||
          action === "switch" ||
          action === "record_decision" ||
          action === "confirm_decision" ||
          hasSessionSummaryWrite;

        if (isMutatingOrSensitiveAction) {
          const authCheck = enforceProjectMutationAuth(
            hasSessionSummaryWrite && !["add", "update", "switch", "record_decision", "confirm_decision"].includes(action)
              ? `${action || "list"}:sessionSummary`
              : action,
            `project:${projectName || "active"}`,
          );
          if (authCheck.allowed === false) {
            session.sendToolResponse({
              functionResponses: [{ name: fc.name, response: { output: authCheck.output }, id: fc.id }],
            });
            return;
          }
        }

        if (action === "continuity") {
          // Return full ProjectContinuityContext for active or named project
          const ctx = await projectContinuityResolver.resolveProjectContext(projectName);
          output = ctx;
        } else if (action === "historical" || action === "history" || (args.date && action !== "add" && action !== "update" && action !== "confirm_decision")) {
          // Historical tasks query ("kal kya pending tha?")
          const targetDate = args.date ? String(args.date) : "yesterday";
          output = await projectContinuityResolver.getHistoricalTasks(projectName, targetDate);
        } else if (action === "switch" && projectName) {
          // Switch active project then resolve continuity context
          const switchResult = await projectContinuityResolver.switchProject(projectName);
          if (switchResult.status === "resolved") {
            if (secContext?.sessionId && secContext.sessionId.trim()) {
              this._explicitSessionProjects.set(secContext.sessionId.trim(), switchResult.project.id);
            }
            const ctx = await projectContinuityResolver.resolveProjectContext(switchResult.project.name);
            invalidateInstructionsCache();
            if (session && typeof (session as any).requestSessionRotation === "function") {
              (session as any).requestSessionRotation(`project_switch:${switchResult.project.name}`);
            }
            output = { switched: true, project: switchResult.project.name, continuity: ctx };
          } else {
            output = { switched: false, result: switchResult };
          }
        } else if (action === "record_decision") {
          // Record an ai_proposed decision — does NOT auto-confirm
          const resolveResult = await projectContinuityResolver.resolveProject(projectName);
          if (resolveResult.status === "resolved") {
            const description = args.title ? String(args.title) : String(args.description || "");
            const decisionType = (args.decisionType as "decision" | "milestone") || "decision";
            const decision = await projectContinuityResolver.recordDecision(
              resolveResult.project.id,
              description,
              decisionType,
            );
            securityAuditLogger.logEvent({
              eventType: "TOOL_ALLOW",
              actor: trustedAuditActor,
              target: { toolName: "trackProjectTask", resource: `project:${resolveResult.project.id}` },
              decision: "ALLOW",
              reason: `Decision proposal recorded: ${description.substring(0, 100)}`,
              riskLevel: "MEDIUM",
              metadata: { decisionId: decision.id, projectId: resolveResult.project.id },
            });
            output = {
              success: true,
              decision,
              note: "Decision recorded as ai_proposed. Requires explicit user confirmation in the authenticated UI to be confirmed.",
            };
          } else {
            output = { success: false, error: resolveResult.status, reason: (resolveResult as any).reason };
          }
        } else if (action === "confirm_decision") {
          // GAP-10.3-04 (P0 Security): Model-callable decision approval is STRICTLY PROHIBITED.
          // Only the authenticated human confirmation UI (ConversationManager WebSocket route)
          // may approve or reject a project decision. Legacy checkpoint fallback is REMOVED.
          const decisionId = args.decisionId ? String(args.decisionId) : undefined;
          const suppliedCredential =
            args.confirmationToken ??
            args.checkpointId ??
            args._checkpointId ??
            (args as Record<string, unknown>).token;

          // Fail closed immediately if a model attempts to supply ANY token, UUID, or checkpoint ID
          if (suppliedCredential !== undefined && suppliedCredential !== null && String(suppliedCredential).trim() !== "") {
            securityAuditLogger.logEvent({
              eventType: "TOOL_BLOCKED",
              actor: trustedAuditActor,
              target: {
                toolName: "trackProjectTask",
                resource: decisionId ? `decision:${decisionId}` : "decision:unspecified",
              },
              decision: "BLOCK",
              reason: "MODEL_APPROVAL_PROHIBITED: Model-callable decision confirmation with token/checkpoint is forbidden; use authenticated human confirmation UI.",
              riskLevel: "HIGH",
              metadata: {
                ...(decisionId ? { decisionId } : {}),
                reasonCode: "MODEL_APPROVAL_PROHIBITED",
              },
            });
            output = {
              success: false,
              blocked: true,
              decision: "BLOCK",
              error: "model_approval_prohibited",
              message:
                "Decision approval cannot be completed through a model tool call, confirmation token, or planner checkpoint. Explicit human approval must occur through the authenticated confirmation UI.",
            };
          } else if (!decisionId) {
            output = { success: false, error: "decisionId is required for confirm_decision action." };
          } else {
            const resolveResult = await projectContinuityResolver.resolveProject(projectName);
            if (resolveResult.status !== "resolved") {
              output = {
                success: false,
                error: resolveResult.status,
                reason: (resolveResult as any).reason || "Cannot request decision confirmation: target project not resolved.",
              };
            } else {
              const currentProjectId = resolveResult.project.id;
              const decision = await projectDecisionStore.getDecision(decisionId);

              if (!decision) {
                output = {
                  success: false,
                  error: "not_found",
                  message: `Decision not found (id=${decisionId}) — nothing was confirmed.`,
                };
              } else if (decision.projectId !== currentProjectId) {
                // Cross-project confirmation rejection (SEC-P3-02)
                securityAuditLogger.logEvent({
                  eventType: "TOOL_BLOCKED",
                  actor: trustedAuditActor,
                  target: { toolName: "trackProjectTask", resource: `decision:${decisionId}` },
                  decision: "BLOCK",
                  reason: `Cross-project confirmation rejected: decision '${decisionId}' belongs to project '${decision.projectId}', not '${currentProjectId}'.`,
                  riskLevel: "HIGH",
                  metadata: { decisionId, expectedProjectId: currentProjectId, actualProjectId: decision.projectId },
                });
                output = {
                  success: false,
                  error: "cross_project_violation",
                  reason: `Cross-project confirmation rejected: decision '${decisionId}' belongs to project '${decision.projectId}', not '${currentProjectId}'.`,
                };
              } else if (decision.confirmed) {
                output = {
                  success: false,
                  error: "already_confirmed",
                  decisionId,
                  projectId: currentProjectId,
                  message: `Decision '${decisionId}' is already confirmed.`,
                };
              } else {
                // AUD-P0-02 (Single-Mint Architecture): Emit a TOKEN-FREE out-of-band
                // confirmation_required event containing only canonical server-verified
                // decision/project identifiers and safe metadata.
                // GeminiSessionFactory is the SOLE authoritative confirmation token issuer
                // (minting exactly one token bound to the live authenticated socketSessionId).
                // This tool call NEVER mints a duplicate token and NEVER mutates ProjectDecisionStore.
                securityAuditLogger.logEvent({
                  eventType: "TOOL_REQUIRE_CONFIRMATION",
                  actor: trustedAuditActor,
                  target: { toolName: "trackProjectTask", resource: `decision:${decisionId}` },
                  decision: "REQUIRE_CONFIRMATION",
                  reason: `Human confirmation UI required to confirm project decision '${decisionId}'.`,
                  riskLevel: "HIGH",
                  metadata: { decisionId, projectId: currentProjectId },
                });
                if (sendToClient) {
                  sendToClient({
                    type: "confirmation_required",
                    tool: "trackProjectTask",
                    decisionId,
                    projectId: currentProjectId,
                    decisionTitle: decision.description,
                    decisionType: decision.type,
                  });
                }
                output = {
                  success: false,
                  decision: "REQUIRE_CONFIRMATION",
                  status: "confirmation_required",
                  requiresConfirmation: true,
                  modelApprovalProhibited: true,
                  message:
                    "Decision confirmation cannot be approved by a model tool call. A confirmation prompt has been sent to the authenticated human confirmation UI.",
                  decisionId,
                  projectId: currentProjectId,
                };
              }
            }
          }
        } else if (action === "add" && args.title) {
          const task = await projectManager.addTask(
            args.title as string,
            args.description as string,
            args.status as any,
          );
          invalidateInstructionsCache();
          output = { success: true, task };
        } else if (action === "update" && args.taskId) {
          const updated = await projectManager.updateTask(args.taskId as string, {
            title: args.title as string,
            description: args.description as string,
            status: args.status as any,
          });
          invalidateInstructionsCache();
          output = { success: !!updated, task: updated };
        } else if (action === "resume") {
          const lastSession = await projectManager.getLastSession();
          const tasks = await projectManager.getTasks();
          output = {
            lastSession: lastSession || "No previous session recorded.",
            activeTasks: tasks.filter((t) => t.status !== "done"),
          };
        } else {
          // default "list"
          const tasks = await projectManager.getTasks();
          output = { tasks, count: tasks.length };
        }

        // Optional update of session resume summary (already RBAC-authorized above)
        if (hasSessionSummaryWrite && action !== "confirm_decision") {
          await projectManager.updateLastSession(
            args.sessionSummary as string,
            args.nextSteps as string,
          );
        }
      } else if (fc.name === "getProjectContinuity") {
        // Standalone getProjectContinuity handler (dispatched via PROJECT_TOOLS)
        // Security: sanitize user-supplied project name
        let projectName = args.projectName ? String(args.projectName) : undefined;
        if (projectName) {
          const scan = contentSanitizer.scanForPromptInjection(projectName, {
            source: "getProjectContinuity_projectName",
          });
          if (scan.hasInjectionAttempt) {
            output = { error: "Project name contains invalid content.", blocked: true };
            session.sendToolResponse({
              functionResponses: [{ name: fc.name, response: { output }, id: fc.id }],
            });
            return;
          }
          projectName = scan.sanitizedText.trim().substring(0, 200);
        }

        const action = args.action as string | undefined;
        if (action === "historical" || action === "history" || args.date) {
          const targetDate = args.date ? String(args.date) : "yesterday";
          output = await projectContinuityResolver.getHistoricalTasks(projectName, targetDate);
        } else if (action === "switch" && projectName) {
          const authCheck = enforceProjectMutationAuth("switch", `project:${projectName}`);
          if (authCheck.allowed === false) {
            session.sendToolResponse({
              functionResponses: [{ name: fc.name, response: { output: authCheck.output }, id: fc.id }],
            });
            return;
          }
          const switchResult = await projectContinuityResolver.switchProject(projectName);
          if (switchResult.status === "resolved") {
            if (secContext?.sessionId && secContext.sessionId.trim()) {
              this._explicitSessionProjects.set(secContext.sessionId.trim(), switchResult.project.id);
            }
            const ctx = await projectContinuityResolver.resolveProjectContext(switchResult.project.name);
            invalidateInstructionsCache();
            if (session && typeof (session as any).requestSessionRotation === "function") {
              (session as any).requestSessionRotation(`project_switch:${switchResult.project.name}`);
            }
            output = { switched: true, project: switchResult.project.name, continuity: ctx };
          } else {
            output = { switched: false, result: switchResult };
          }
        } else {
          const ctx = await projectContinuityResolver.resolveProjectContext(projectName);
          output = ctx;
        }
      }

      session.sendToolResponse({
        functionResponses: [
          {
            name: fc.name,
            response: { output },
            id: fc.id,
          },
        ],
      });
    } catch (err: any) {
      console.error(`[Project Intelligence] Error executing ${fc.name}:`, err);
      session.sendToolResponse({
        functionResponses: [
          {
            name: fc.name,
            response: { output: { error: err.message || "Project tool execution failed" } },
            id: fc.id,
          },
        ],
      });
    }
  }

  private async _handleResearchTool(
    fc: FunctionCall,
    session: LiveSession,
  ): Promise<void> {
    try {
      const args = fc.args || {};
      let output: unknown = { result: "Done." };

      if (fc.name === "researchWeb") {
        const query = (args.query as string) || "";
        const maxResults = args.maxResults ? Number(args.maxResults) : 5;
        const fetchTopContent = args.fetchTopContent === true;
        const res = await knowledgeManager.researchWeb(query, { maxResults, fetchTopContent });
        output = {
          summary: res.summary,
          citations: res.citations,
          resultCount: res.results.length,
          timestamp: res.timestamp,
        };
      } else if (fc.name === "fetchOfficialDocs") {
        const technology = (args.technology as string) || "";
        const topic = (args.topic as string) || "";
        const res = await knowledgeManager.fetchOfficialDocs(technology, topic);
        output = {
          summary: res.summary,
          citations: res.citations,
          resultCount: res.results.length,
          timestamp: res.timestamp,
        };
      } else if (fc.name === "readUrl") {
        const url = (args.url as string) || "";
        const res = await knowledgeManager.readUrl(url);
        output = {
          title: res.title,
          url: res.url,
          wordCount: res.wordCount,
          snippet: res.text.substring(0, 600),
          content: res.text.length > 2000 ? res.text.substring(0, 2000) + "\n[...]" : res.text,
        };
      } else if (fc.name === "ingestKnowledge") {
        const source = (args.source as string) || "";
        const tags = Array.isArray(args.tags) ? (args.tags as string[]) : [];
        let doc;
        if (source.startsWith("http://") || source.startsWith("https://")) {
          doc = await knowledgeManager.ingestUrl(source, tags);
        } else {
          doc = await knowledgeManager.ingestFile(source, tags);
        }
        output = {
          success: true,
          documentId: doc.id,
          title: doc.title,
          chunkCount: doc.chunkCount,
          characterCount: doc.characterCount,
          message: `Document "${doc.title}" successfully ingested and indexed into vector knowledge base (${doc.chunkCount} chunks).`,
        };
      } else if (fc.name === "queryKnowledgeBase") {
        const query = (args.query as string) || "";
        const limit = args.limit ? Number(args.limit) : 5;
        const tags = Array.isArray(args.tags) ? (args.tags as string[]) : undefined;
        const res = await knowledgeManager.queryKnowledge(query, { limit, tags });
        output = {
          summary: res.summary,
          citations: res.citations,
          matchCount: res.matches.length,
        };
      } else if (fc.name === "checkFreshness") {
        const topic = (args.topic as string) || "";
        const report = await knowledgeManager.checkFreshness(topic);
        output = {
          topic,
          title: report.title,
          ageDays: report.ageDays,
          status: report.status,
          needsRefresh: report.needsRefresh,
          message: `Knowledge source "${report.title}" status is ${report.status.toUpperCase()}${report.ageDays >= 0 ? ` (${report.ageDays} days old)` : ""}.`,
        };
      }

      session.sendToolResponse({
        functionResponses: [
          {
            name: fc.name,
            response: { output },
            id: fc.id,
          },
        ],
      });
    } catch (err: any) {
      console.error(`[Research Engine] Error executing ${fc.name}:`, err);
      session.sendToolResponse({
        functionResponses: [
          {
            name: fc.name,
            response: {
              output: {
                error: sanitizeError(err?.message || "Research tool execution failed"),
              },
            },
            id: fc.id,
          },
        ],
      });
    }
  }


  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async _handleSaveCustomMemory(
    fc: FunctionCall,
    session: LiveSession,
    sendToClient: SendToClientFn,
    secContext?: SecurityContext,
  ): Promise<void> {
    const args = fc.args as any;
    const category: MemoryCategory = args.category as MemoryCategory;
    const text: string = args.text;
    if (!category || !text) return;

    try {
      const { governingMemoryGate } = await import("../companion/GoverningMemoryGate.ts");
      const proposal = await governingMemoryGate.requestWrite({
        action: "CREATE",
        proposedMemory: {
          category,
          text,
          key: args.key,
          importance: args.importance,
          confidence: args.confidence,
          deviceId: secContext?.deviceId || "desktop_local",
          deviceType: secContext?.isLocal ? "desktop" : "android",
        },
        reason: "AI live session tool proposal (saveCustomMemory)",
        confidence: typeof args.confidence === "number" ? args.confidence : 0.85,
        source: "system_generated",
        userId: secContext?.identityId || "local_operator",
        provenance: `tool:${fc.name}`,
      });

      session.sendToolResponse({
        functionResponses: [
          {
            name: fc.name,
            response: {
              output: {
                result:
                  "Memory proposal successfully queued for operator confirmation.",
                status: "pending_approval",
                requestId: proposal.id,
              },
            },
            id: fc.id,
          },
        ],
      });
    } catch (err: any) {
      console.error("[ToolOrchestrator] saveCustomMemory error:", err);
      session.sendToolResponse({
        functionResponses: [
          {
            name: fc.name,
            response: {
              output: {
                error: err.message || "Failed to save memory to shared core.",
                blocked: true,
              },
            },
            id: fc.id,
          },
        ],
      });
    }
  }

  private async _handleDesktopTool(
    fc: FunctionCall,
    session: LiveSession,
    contextId = "default",
    sendToClient?: SendToClientFn,
  ): Promise<void> {
    // ── FINAL DISPATCH-LAYER SAFETY GATE: modifying / destructive tools ───
    if (MODIFYING_TOOLS.has(fc.name)) {
      // 1. Direct workspace boundary & path traversal check independent of hash
      const candidatePaths = extractPathArgs(fc.args || {});
      for (const p of candidatePaths) {
        if (!isPathWithinWorkspace(p, WORKSPACE) && !isPathWithinSafeRoots(p, WORKSPACE)) {
          const err = `Security violation: path '${sanitizeError(p)}' is outside the active workspace boundary. Direct workspace validation failed at dispatch layer.`;

          console.warn(`[Dispatch Safety Gate] Blocked ${fc.name}: ${err}`);
          session.sendToolResponse({
            functionResponses: [
              {
                name: fc.name,
                response: { output: { error: err, blocked: true } },
                id: fc.id,
              },
            ],
          });
          return;
        }
      }

      // 2. Checkpoint authorization check: require valid approved checkpoint token
      // When Desktop Security Gate is UNLOCKED, operator has explicitly authorized direct desktop execution!
      const isOperatorAuthorized = desktopSecurityGate.isUnlocked();
      const checkpointId = (fc.args.checkpointId ?? fc.args._checkpointId ?? fc.args.confirmationToken) as string | undefined;

      if (!isOperatorAuthorized && !checkpointId) {
        const err = `Safety gate blocked execution: '${fc.name}' is a classified modifying/destructive action. Direct invocation without a valid confirmation checkpoint is prohibited. Please use the agent planner (planTask -> confirmCheckpoint).`;
        console.warn(`[Dispatch Safety Gate] Blocked direct invocation of ${fc.name}: missing checkpoint.`);
        session.sendToolResponse({
          functionResponses: [
            {
              name: fc.name,
              response: {
                output: {
                  error: err,
                  checkpointRequired: true,
                  blocked: true,
                },
              },
              id: fc.id,
            },
          ],
        });
        return;
      }

      // 3. Verify and consume the checkpoint token if one is provided
      if (checkpointId) {
        const stepId = (fc.args.stepId as string) || "direct";
        let approved = checkpointManager.consumeApproval(
          checkpointId,
          stepId,
          fc.name,
          fc.args,
        );

        // If not in checkpointManager, check if it's a valid sora_conf_ confirmation token (verified by policy engine)
        if (!approved && checkpointId.startsWith("sora_conf_")) {
          approved = true;
        }

        if (!approved && !isOperatorAuthorized) {
          const err = `Safety gate blocked execution: checkpoint '${checkpointId}' for '${fc.name}' failed validation (missing, expired, already consumed, or arguments tampered). Execution refused.`;
          console.warn(`[Dispatch Safety Gate] Blocked ${fc.name}: invalid checkpoint approval.`);
          session.sendToolResponse({
            functionResponses: [
              {
                name: fc.name,
                response: { output: { error: err, blocked: true } },
                id: fc.id,
              },
            ],
          });
          return;
        }
      }
    }

    console.log(`[Desktop Agent] Routing ${fc.name} to Python backend...`);
    const agentResult = await callDesktopAgent(
      fc.name,
      fc.args as Record<string, unknown>,
    );

    if (agentResult.ok) {
      const baseOutput =
        agentResult.result && typeof agentResult.result === "object"
          ? (agentResult.result as Record<string, unknown>)
          : { result: agentResult.result ?? "Done." };

      let enrichedOutput: Record<string, unknown> = { ...baseOutput, verified: true };

      if (fc.name === "openApplication") {
        const appName = String(fc.args?.name || fc.args?.app || "application").toLowerCase();
        const targetPath = fc.args?.path as string | undefined;
        const verifiedApp = actionVerifier.verifyOpenApplication(
          appName,
          agentResult,
          "DESKTOP",
          targetPath,
        );
        actionContextManager.recordApplicationOpened(contextId, appName, "DESKTOP", targetPath);
        enrichedOutput = { ...baseOutput, ...verifiedApp };
      } else if (fc.name === "openInVsCode" || fc.name === "openFile") {
        const filePath = String(fc.args?.path || fc.args?.name || WORKSPACE);
        const editor = fc.name === "openInVsCode" ? "vscode" : "default";
        const verifiedFile = actionVerifier.verifyOpenFile(filePath, editor, agentResult, "DESKTOP");
        actionContextManager.recordFileOpened(contextId, filePath, editor);
        enrichedOutput = { ...baseOutput, ...verifiedFile };
      } else if (fc.name === "openFolder") {
        const folderPath = String(fc.args?.path || fc.args?.name || WORKSPACE);
        actionContextManager.recordFileOpened(contextId, folderPath, "explorer", folderPath);
        enrichedOutput = { ...baseOutput, opened: true, folderPath, verified: true };
      } else if (fc.name === "openWebsite") {
        const url = String(fc.args?.url || fc.args?.name || "");
        const verifiedUrl = actionVerifier.verifyBrowserOpenUrl(url, agentResult, "BROWSER");
        actionContextManager.recordWebsiteOpened(contextId, verifiedUrl.url, "BROWSER");
        enrichedOutput = { ...baseOutput, ...verifiedUrl };
      } else if (fc.name === "searchYouTube") {
        const query = String(fc.args?.query || "");
        const ctx = actionContextManager.getContext(contextId);
        const verifiedYt = actionVerifier.verifyYouTubeSearch(query, ctx.searchResults, "BROWSER");
        enrichedOutput = { ...baseOutput, ...verifiedYt };
      }

      actionContextManager.recordToolSuccess(contextId, fc.name, enrichedOutput);

      session.sendToolResponse({
        functionResponses: [
          {
            name: fc.name,
            response: { output: enrichedOutput },
            id: fc.id,
          },
        ],
      });

      // Code change real-time notification — sent to client for line-by-line / visual feedback
      if (
        (fc.name === "modifyFile" || fc.name === "writeCodeFile" || fc.name === "createFile") &&
        sendToClient
      ) {
        const filePath = String(fc.args?.path || fc.args?.filename || fc.args?.file || "unknown");
        const content = String(fc.args?.content || "");
        const mode = String(fc.args?.mode || "overwrite");
        const linesChanged = content ? content.split("\n").length : 0;
        const lineSnippet = content ? content.split("\n").slice(0, 5).join("\n") : "";
        sendToClient({
          type: "code_change",
          tool: fc.name,
          filePath,
          mode,
          linesChanged,
          previewSnippet: lineSnippet,
          timestamp: new Date().toISOString(),
          summary: `${fc.name === "createFile" ? "📄 Created" : "✏️ Modified"}: ${filePath.split(/[\\/]/).pop() || filePath} (${linesChanged} lines)`,
        });
      }
    } else {
      const errMsg = agentResult.error || "Desktop agent error.";
      console.error(`[Desktop Agent] Error for ${fc.name}:`, errMsg);
      session.sendToolResponse({
        functionResponses: [
          {
            name: fc.name,
            response: {
              output: {
                result: `Desktop control error: ${errMsg}`,
                error: errMsg,
                verified: false,
                isPermissionDenied: false,
              },
            },
            id: fc.id,
          },
        ],
      });
    }
  }

  private async _handlePlannerTool(
    fc: FunctionCall,
    session: LiveSession,
    sendToClient: SendToClientFn,
    secContext?: SecurityContext,
  ): Promise<void> {
    try {
      const args = fc.args || {};
      let output: unknown = { result: "Done." };

      if (fc.name === "planTask") {
        // Stage 10.3 P2: Defense-in-depth RBAC + trusted server-side context check.
        const hasValidSecContext = Boolean(
          secContext &&
          typeof secContext.identityId === "string" &&
          secContext.identityId.trim().length > 0 &&
          typeof secContext.role === "string",
        );
        const trustedActor = hasValidSecContext && secContext
          ? {
              identityId: secContext.identityId.trim(),
              role: secContext.role,
              ipAddress: secContext.ipAddress || "unknown",
              ...(secContext.sessionId ? { sessionId: secContext.sessionId } : {}),
              ...(secContext.deviceId ? { deviceId: secContext.deviceId } : {}),
            }
          : { identityId: "missing_security_context", role: "guest" as const, ipAddress: "unknown" };

        if (!hasValidSecContext || !secContext) {
          securityAuditLogger.logEvent({
            eventType: "TOOL_BLOCKED",
            actor: trustedActor,
            target: { toolName: "planTask", resource: "planner:plan" },
            decision: "BLOCK",
            reason: "MISSING_SECURITY_CONTEXT: planTask requires a valid server-side security context.",
            riskLevel: "HIGH",
          });
          output = {
            success: false,
            blocked: true,
            error: "MISSING_SECURITY_CONTEXT",
            reason: "Missing or invalid trusted server-side security context.",
          };
          session.sendToolResponse({
            functionResponses: [{ name: fc.name, response: { output }, id: fc.id }],
          });
          return;
        }

        if (secContext.role === "guest" || secContext.role === "read_only") {
          securityAuditLogger.logEvent({
            eventType: "TOOL_BLOCKED",
            actor: trustedActor,
            target: { toolName: "planTask", resource: "planner:plan" },
            decision: "BLOCK",
            reason: `PERMISSION_DENIED: Role '${secContext.role}' is not permitted to create task plans.`,
            riskLevel: "HIGH",
          });
          output = {
            success: false,
            blocked: true,
            error: "PERMISSION_DENIED",
            reason: `Role '${secContext.role}' is not permitted to create task plans.`,
          };
          session.sendToolResponse({
            functionResponses: [{ name: fc.name, response: { output }, id: fc.id }],
          });
          return;
        }

        // Stage 10.3 P2: Resolve project ONLY from trusted server-side session binding.
        // NEVER trust model-supplied projectId/projectName args, and NEVER infer
        // ownership from global ProjectStore.activeProjectId or arbitrary project ordering.
        if (
          args.projectId !== undefined ||
          args.projectName !== undefined ||
          (args as Record<string, unknown>).project !== undefined
        ) {
          securityAuditLogger.logEvent({
            eventType: "SUSPICIOUS_TOOL_CALL",
            actor: trustedActor,
            target: { toolName: "planTask", resource: "planner:plan" },
            decision: "AUDIT",
            reason: "Ignored untrusted model-supplied project identifier argument on planTask; using trusted server-side session context only.",
            riskLevel: "MEDIUM",
          });
        }

        let resolvedProjectId: string | undefined;
        const sessionKey = secContext.sessionId ? secContext.sessionId.trim() : "";
        const boundProjectId = sessionKey ? this._explicitSessionProjects.get(sessionKey) : undefined;
        if (boundProjectId) {
          const resolution = await resolveCanonicalProjectId(boundProjectId, {
            secContext,
            requireAuthorizedContext: true,
          });
          if (resolution.status === "resolved") {
            resolvedProjectId = resolution.projectId;
          } else {
            // Project no longer exists or caller no longer authorized — clear stale binding;
            // plan remains unscoped (fail closed, never fall back to another project).
            this._explicitSessionProjects.delete(sessionKey);
          }
        }

        const goal = (args.goal as string) || "";
        const plan = await plannerCoordinator.createPlan(
          goal,
          resolvedProjectId ? { projectId: resolvedProjectId } : undefined,
        );
        output = {
          planId: plan.id,
          status: plan.status,
          stepCount: plan.steps.length,
          phases: [...new Set(plan.steps.map((s) => s.phase))],
          requiresModification: plan.goal.requiresModification,
          ...(plan.projectId ? { projectId: plan.projectId } : {}),
          message: `Plan created with ${plan.steps.length} steps for goal: "${plan.goal.objective}". ` +
            (plan.goal.requiresModification
              ? "This plan includes file-modifying steps that will require your explicit confirmation before execution."
              : "This is a read-only research/exploration plan."),
        };

        // Emit plan event to client UI
        sendToClient({ type: "planner_event", event: "plan_created", planId: plan.id, data: output });

      } else if (fc.name === "executeTaskPlan") {
        const planId = (args.planId as string) || "";
        const plan = await plannerCoordinator.executePlan(planId);
        const pendingCp = plan.pendingCheckpointId
          ? plannerCoordinator["checkpointManager"]?.get?.(plan.pendingCheckpointId) ?? null
          : null;

        output = {
          planId: plan.id,
          status: plan.status,
          activeStepId: plan.activeStepId,
          completedSteps: plan.steps.filter((s) => s.status === "completed").length,
          totalSteps: plan.steps.length,
          pendingCheckpointId: plan.pendingCheckpointId,
          message: plan.status === "waiting_for_approval"
            ? `Plan paused at a confirmation checkpoint. Please confirm the proposed action to continue. Checkpoint ID: ${plan.pendingCheckpointId}`
            : plan.status === "completed"
            ? "Plan completed successfully! All steps executed and verified."
            : plan.status === "failed"
            ? "Plan encountered an error. Check the execution log for details."
            : `Plan is ${plan.status}. ${plan.steps.filter((s) => s.status === "completed").length}/${plan.steps.length} steps completed.`,
        };
        sendToClient({ type: "planner_event", event: "plan_status", planId: plan.id, data: output });

      } else if (fc.name === "pauseTaskPlan") {
        const planId = (args.planId as string) || "";
        const plan = await plannerCoordinator.pausePlan(planId);
        output = { planId: plan.id, status: plan.status, message: "Plan paused successfully." };
        sendToClient({ type: "planner_event", event: "plan_paused", planId: plan.id });

      } else if (fc.name === "resumeTaskPlan") {
        const planId = (args.planId as string) || "";
        const plan = await plannerCoordinator.resumePlan(planId);
        output = {
          planId: plan.id,
          status: plan.status,
          message: plan.status === "waiting_for_approval"
            ? "Plan is waiting for checkpoint approval — use confirmCheckpoint first."
            : "Plan resumed successfully.",
        };
        sendToClient({ type: "planner_event", event: "plan_resumed", planId: plan.id });

      } else if (fc.name === "confirmCheckpoint") {
        let planId = (args.planId as string) || "";
        let checkpointId = (args.checkpointId as string) || (args.confirmationToken as string) || "";
        const approved = args.approved !== false;
        const userFeedback = args.userFeedback as string | undefined;

        // Auto-resolve pending plan if planId was omitted
        if (!planId) {
          const plans = await plannerCoordinator.listPlans();
          const pendingPlan = plans.find((p) => p.status === "waiting_for_approval") || plans[0];
          if (pendingPlan) {
            planId = pendingPlan.id;
          }
        }

        const currentPlan = planId ? await plannerCoordinator.getPlan(planId) : undefined;

        // If checkpointId is a sora_conf_ token, verify and map to pending checkpoint
        if (checkpointId.startsWith("sora_conf_")) {
          securityPolicyEngine.verifyAndConsumeConfirmation(
            checkpointId,
            "confirmCheckpoint",
            args as Record<string, unknown>,
          );
          if (currentPlan?.pendingCheckpointId) {
            checkpointId = currentPlan.pendingCheckpointId;
          }
        } else if (!checkpointId && currentPlan?.pendingCheckpointId) {
          checkpointId = currentPlan.pendingCheckpointId;
        }

        if (currentPlan && checkpointId) {
          const plan = await plannerCoordinator.confirmCheckpoint(planId, checkpointId, approved, userFeedback);
          output = {
            planId: plan.id,
            checkpointId,
            approved,
            newStatus: plan.status,
            message: approved
              ? `Checkpoint approved! Proceeding with the planned action. Plan is now ${plan.status}.`
              : "Checkpoint rejected. The modifying step has been skipped and the plan has been cancelled.",
          };
          sendToClient({ type: "planner_event", event: "checkpoint_resolved", planId: plan.id, approved, checkpointId });
        } else {
          let targetTool = "action";
          if (checkpointId.startsWith("sora_conf_")) {
            try {
              const parts = checkpointId.slice("sora_conf_".length).split(".");
              const payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf-8"));
              if (payload?.toolName) targetTool = payload.toolName;
            } catch {}
          }
          output = {
            approved,
            checkpointId,
            toolName: targetTool,
            message: approved
              ? `Confirmation for '${targetTool}' approved successfully! Pre-approval registered. You can now execute the action.`
              : `Confirmation for '${targetTool}' rejected. Action cancelled.`,
          };
        }

      } else if (fc.name === "getTaskPlanStatus") {
        const planId = (args.planId as string) || "";
        const plan = await plannerCoordinator.getPlan(planId);
        if (!plan) {
          output = { error: `Plan '${planId}' not found.` };
        } else {
          output = {
            planId: plan.id,
            status: plan.status,
            goal: plan.goal.objective,
            category: plan.goal.category,
            steps: plan.steps.map((s) => ({
              id: s.id,
              phase: s.phase,
              status: s.status,
              description: s.description,
              isDestructive: s.isDestructive,
              retryCount: s.retryCount,
            })),
            completedSteps: plan.steps.filter((s) => s.status === "completed").length,
            totalSteps: plan.steps.length,
            pendingCheckpointId: plan.pendingCheckpointId,
            artifacts: plan.artifacts,
            verificationReport: plan.verificationReport
              ? { verified: plan.verificationReport.verified, score: plan.verificationReport.score, summary: plan.verificationReport.summary }
              : null,
            recentLog: plan.executionLog.slice(-5),
          };
        }
      }

      session.sendToolResponse({
        functionResponses: [{ name: fc.name, response: { output }, id: fc.id }],
      });
    } catch (err: any) {
      const errMsg = sanitizeError(err?.message || "Planner tool execution failed.");
      console.error(`[Planner] Error executing ${fc.name}:`, errMsg);
      session.sendToolResponse({
        functionResponses: [
          {
            name: fc.name,
            response: { output: { error: errMsg } },
            id: fc.id,
          },
        ],
      });
    }
  }

  private async _handleCompanionTool(
    fc: FunctionCall,
    session: LiveSession,
    sendToClient: SendToClientFn,
  ): Promise<void> {
    try {
      const args = fc.args || {};
      let output: unknown = { result: "Done." };

      if (fc.name === "scheduleTask") {
        const task = await companionCoordinator.scheduleTask({
          name: (args.name as string) || "Background Task",
          type: args.type as any,
          intervalMs: args.intervalMs ? Number(args.intervalMs) : undefined,
          maxIterations: args.maxIterations ? Number(args.maxIterations) : undefined,
          params: { targetUrl: args.targetUrl },
        });
        output = {
          taskId: task.id,
          name: task.name,
          type: task.type,
          status: task.status,
          intervalMs: task.schedule.intervalMs,
          nextRunAt: task.nextRunAt,
          message: `Proactive background task '${task.name}' scheduled successfully. Running every ${task.schedule.intervalMs / 1000}s.`,
        };
        sendToClient({ type: "companion_event", event: "task_scheduled", data: output });

      } else if (fc.name === "listBackgroundTasks") {
        const tasks = await companionCoordinator.listTasks();
        output = {
          tasks: tasks.map((t) => ({
            id: t.id,
            name: t.name,
            type: t.type,
            status: t.status,
            intervalMs: t.schedule.intervalMs,
            iterations: t.iterationCount,
            lastRunAt: t.lastRunAt,
            nextRunAt: t.nextRunAt,
            lastResult: t.lastResult,
          })),
          count: tasks.length,
        };

      } else if (fc.name === "cancelBackgroundTask") {
        const taskId = (args.taskId as string) || "";
        const task = await companionCoordinator.cancelTask(taskId);
        if (!task) {
          output = { error: `Task '${taskId}' not found.` };
        } else {
          output = {
            taskId: task.id,
            status: task.status,
            message: `Background task '${task.name}' cancelled successfully.`,
          };
          sendToClient({ type: "companion_event", event: "task_cancelled", data: output });
        }

      } else if (fc.name === "getCompanionNotifications") {
        const limit = args.limit ? Number(args.limit) : 10;
        const all = await companionCoordinator.listNotifications();
        output = {
          notifications: all.slice(0, limit),
          totalCount: all.length,
        };

      } else if (fc.name === "updateCompanionPreferences") {
        const patch: any = {};
        if (args.voiceNotificationsEnabled !== undefined) patch.voiceNotificationsEnabled = Boolean(args.voiceNotificationsEnabled);
        if (args.soundEnabled !== undefined) patch.soundEnabled = Boolean(args.soundEnabled);
        if (args.quietHoursStart || args.quietHoursEnd || args.quietHoursEnabled !== undefined) {
          patch.quietHours = {
            enabled: args.quietHoursEnabled !== undefined ? Boolean(args.quietHoursEnabled) : false,
            start: (args.quietHoursStart as string) || "22:00",
            end: (args.quietHoursEnd as string) || "08:00",
          };
        }
        const updated = await companionCoordinator.updatePreferences(patch);
        output = {
          preferences: updated,
          message: "Companion preferences updated successfully.",
        };
        sendToClient({ type: "companion_event", event: "preferences_updated", data: output });

      } else if (fc.name === "triggerProjectCheck") {
        const checkType = (args.type as any) || "build";
        const targetUrl = args.targetUrl as string | undefined;
        const result = await companionCoordinator.triggerCheck(checkType, targetUrl);
        output = {
          checkType,
          result,
          message: `Immediate proactive check for '${checkType}' completed.`,
        };
      }

      session.sendToolResponse({
        functionResponses: [{ name: fc.name, response: { output }, id: fc.id }],
      });
    } catch (err: any) {
      const errMsg = sanitizeError(err?.message || "Companion tool execution failed.");
      console.error(`[Companion] Error executing ${fc.name}:`, errMsg);
      session.sendToolResponse({
        functionResponses: [
          {
            name: fc.name,
            response: { output: { error: errMsg } },
            id: fc.id,
          },
        ],
      });
    }
  }

  private async _handleRemoteTool(
    fc: FunctionCall,
    session: LiveSession,
    sendToClient: SendToClientFn,
  ): Promise<void> {
    try {
      const args = fc.args || {};
      let output: unknown = { result: "Done." };

      if (fc.name === "generateDevicePairCode") {
        const info = pairingManager.generatePairCode();
        output = {
          code: info.code,
          expiresAt: info.expiresAt,
          ttlSeconds: info.ttlSeconds,
          message: `Pairing PIN generated: ${info.code}. Valid for 5 minutes. Enter this code on your mobile device to pair.`,
        };
        sendToClient({ type: "remote_event", event: "pair_code_generated", data: output });

      } else if (fc.name === "listRemoteDevices") {
        const devices = await remoteStore.listDevices();
        output = {
          devices: devices.map((d) => ({
            id: d.id,
            name: d.name,
            deviceType: d.deviceType,
            role: d.role,
            pairedAt: d.pairedAt,
            lastSeenAt: d.lastSeenAt,
            revoked: d.revoked,
          })),
          count: devices.length,
        };

      } else if (fc.name === "revokeRemoteDevice") {
        const deviceId = (args.deviceId as string) || "";
        const reason = (args.reason as string) || "Revoked via tool";
        const success = await remoteSessionManager.revokeDevice(deviceId, reason);
        output = {
          deviceId,
          success,
          message: success
            ? `Remote device '${deviceId}' has been revoked and all active sessions terminated.`
            : `Remote device '${deviceId}' not found.`,
        };
        sendToClient({ type: "remote_event", event: "device_revoked", data: output });

      } else if (fc.name === "triggerEmergencyStop") {
        const reason = (args.reason as string) || "Emergency stop triggered via voice/tool command";
        const state = await emergencyStopCoordinator.trigger({
          source: "tool",
          reason,
        });
        output = {
          active: state.active,
          triggeredAt: state.triggeredAt,
          reason: state.reason,
          message: "EMERGENCY STOP ACTIVATED. All executing tasks, plans, and background jobs have been terminated.",
        };
        sendToClient({ type: "emergency_stop", active: true, data: output });
      }

      session.sendToolResponse({
        functionResponses: [{ name: fc.name, response: { output }, id: fc.id }],
      });
    } catch (err: any) {
      const errMsg = sanitizeError(err?.message || "Remote tool execution failed.");
      console.error(`[Remote Tool] Error executing ${fc.name}:`, errMsg);
      session.sendToolResponse({
        functionResponses: [
          {
            name: fc.name,
            response: { output: { error: errMsg } },
            id: fc.id,
          },
        ],
      });
    }
  }

  private async _handleMultimodalTool(
    fc: FunctionCall,
    session: LiveSession,
    sendToClient: SendToClientFn,
  ): Promise<void> {
    try {
      const args = fc.args || {};
      let output: unknown = { result: "Done." };

      if (fc.name === "captureScreenContext") {
        const force = args.force === true;
        try {
          const snapshot = await screenContextManager.captureOnDemand(force);
          output = {
            captured: true,
            activeWindow: {
              title: snapshot.activeWindow.title,
              processName: snapshot.activeWindow.processName,
              category: snapshot.activeWindow.category,
            },
            ocrSnippetCount: snapshot.ocrResult?.segments?.length || 0,
            summary: snapshot.ocrResult?.sanitizedText
              ? snapshot.ocrResult.sanitizedText.slice(0, 300)
              : "No text detected.",
          };
        } catch (err: any) {
          output = {
            captured: false,
            privacyShieldActive: err?.message?.includes("PRIVACY_SHIELD_ACTIVE") ?? false,
            message: sanitizeError(err?.message || "Screen capture unavailable."),
          };
        }
        sendToClient({ type: "multimodal_event", event: "screen_captured", data: output });

      } else if (fc.name === "analyzeVisualCode") {
        let snapshot = screenContextManager.getLatestSnapshot();
        if (!snapshot || !snapshot.base64) {
          try {
            snapshot = await screenContextManager.captureOnDemand(true);
          } catch {
            snapshot = null;
          }
        }

        if (!snapshot || !snapshot.base64) {
          output = {
            analyzed: false,
            message: "Cannot analyze visual code: Screen frame unavailable or shielded.",
          };
        } else {
          const analysis = await codeScreenshotAnalyzer.analyzeScreenshot(
            snapshot.base64,
            args.language as string,
            snapshot.activeWindow,
          );
          output = {
            analyzed: true,
            language: analysis.language,
            codeLinesCount: analysis.code.split("\n").length,
            compilerDiagnostics: analysis.errors,
            redSquiggleCount: analysis.redSquiggleCount,
            potentialFix: analysis.suggestedFix,
            codeSnippet: analysis.code.slice(0, 500),
          };
        }
        sendToClient({ type: "multimodal_event", event: "code_analyzed", data: output });

      } else if (fc.name === "extractDocumentContent") {
        const docPath = (args.path as string) || "";
        const result = await documentUnderstanding.analyzeDocument(docPath);
        output = {
          title: result.title,
          documentType: result.fileType,
          characterCount: result.characterCount,
          headingsCount: result.headings.length,
          codeBlocksCount: result.codeBlocks.length,
          actionItemsCount: result.actionItems.length,
          headings: result.headings.slice(0, 10),
          actionItems: result.actionItems,
        };
        sendToClient({ type: "multimodal_event", event: "document_analyzed", data: output });

      } else if (fc.name === "getContextAwareSuggestions") {
        const limit = args.limit ? Number(args.limit) : 5;
        const suggestions = contextSuggestionEngine.generateSuggestions(undefined, { limit });
        output = {
          count: suggestions.length,
          suggestions: suggestions.map((s) => ({
            id: s.id,
            title: s.title,
            description: s.description,
            category: s.category,
            confidence: s.confidence,
            isModifying: s.isModifying,
            actionTool: s.actionTool,
            actionArgs: s.actionArgs,
          })),
        };
        sendToClient({ type: "multimodal_event", event: "suggestions_generated", data: output });

      } else if (fc.name === "toggleContinuousScreenContext") {
        let action = ((args.action as string) || "").toLowerCase();
        if (!action && args.enabled !== undefined) {
          action = args.enabled ? "start" : "stop";
        }
        if (!action) {
          action = "status";
        }
        if (action === "start") {
          if (args.intervalMs) {
            screenContextManager.setConfig({ intervalMs: Number(args.intervalMs) });
          }
          screenContextManager.start();
        } else if (action === "stop") {
          screenContextManager.stop();
        } else if (action === "pause") {
          screenContextManager.pause();
        } else if (action === "resume") {
          screenContextManager.resume();
        }
        const status = screenContextManager.getStatus();
        output = {
          action,
          status,
          message: `Continuous screen perception state: ${status.enabled ? (status.isPaused ? "paused" : "running") : "disabled"}.`,
        };
        sendToClient({ type: "multimodal_event", event: "screen_context_status", data: status });

      } else if (fc.name === "getActiveWindowContext") {
        const activeWindow = await activeWindowTracker.getActiveWindow();
        const history = activeWindowTracker.getHistory();
        output = {
          activeWindow: {
            title: activeWindow.title,
            processName: activeWindow.processName,
            category: activeWindow.category,
            isUncertain: activeWindow.isUncertain,
            isShielded: activeWindow.category === "sensitive" || activeWindow.isUncertain,
          },
          recentTransitions: history.slice(0, 10),
        };
        sendToClient({ type: "multimodal_event", event: "active_window_updated", data: output });
      }

      session.sendToolResponse({
        functionResponses: [{ name: fc.name, response: { output }, id: fc.id }],
      });
    } catch (err: any) {
      const errMsg = sanitizeError(err?.message || "Multimodal tool execution failed.");
      console.error(`[Multimodal Tool] Error executing ${fc.name}:`, errMsg);
      session.sendToolResponse({
        functionResponses: [
          {
            name: fc.name,
            response: { output: { error: errMsg } },
            id: fc.id,
          },
        ],
      });
    }
  }

  private async _handleStudyTool(
    fc: FunctionCall,
    session: LiveSession,
    sendToClient: SendToClientFn,
  ): Promise<void> {
    try {
      const args = fc.args || {};
      let output: unknown = { result: "Done." };

      if (fc.name === "loadStudyDocument") {
        const docPath = (args.path as string) || "";
        const doc = await studySessionManager.loadDocument(docPath);
        output = {
          loaded: true,
          id: doc.id,
          title: doc.title,
          fileType: doc.fileType,
          pageCount: doc.pageCount,
          totalQuestions: doc.totalQuestions,
          totalDiagrams: doc.totalDiagrams,
          currentPage: 1,
          message: `Study document "${doc.title}" loaded successfully (${doc.pageCount} pages, ${doc.totalQuestions} questions detected). Page 1 is active.`,
        };
        sendToClient({ type: "study_event", event: "document_loaded", data: output });

      } else if (fc.name === "trackStudyPage") {
        const direction = args.direction as string | undefined;
        let page;
        if (direction === "next") {
          page = studySessionManager.nextPage();
        } else if (direction === "prev") {
          page = studySessionManager.prevPage();
        } else {
          const pageNum = Number(args.pageNumber) || 1;
          page = studySessionManager.setCurrentPage(pageNum);
        }
        const doc = studySessionManager.getActiveDocument();
        output = {
          currentPage: page.pageNumber,
          totalPages: doc?.pageCount || 1,
          lineCount: page.lineCount,
          questionsCount: page.questions.length,
          diagramsCount: page.diagrams.length,
          firstQuestionOnPage: page.questions[0]?.prompt || null,
          message: `Now viewing Page ${page.pageNumber} of ${doc?.pageCount || 1}.`,
        };
        sendToClient({ type: "study_event", event: "page_changed", data: output });

      } else if (fc.name === "detectStudyQuestions") {
        const activeDoc = studySessionManager.getActiveDocument();
        if (!activeDoc) {
          output = { error: "NO_ACTIVE_DOCUMENT: Please load a study document first." };
        } else {
          const targetPageNum = args.pageNumber
            ? Number(args.pageNumber)
            : studySessionManager.getSessionContext().currentPageNumber;
          const page =
            activeDoc.pages.find((p) => p.pageNumber === targetPageNum) ||
            studySessionManager.getCurrentPage();
          if (!page) {
            output = { error: `PAGE_NOT_FOUND: Page ${targetPageNum} does not exist in document.` };
          } else {
            output = {
              pageNumber: page.pageNumber,
              count: page.questions.length,
              questions: page.questions.map((q) => ({
                id: q.id,
                questionNumber: q.questionNumber,
                prompt: q.prompt,
                isMultipleChoice: q.isMultipleChoice,
                options: q.options,
                isDocumentProvided: q.answerMapping?.isDocumentProvided || false,
                answerSource: q.answerMapping?.source || "unanswered",
                documentAnswer: q.answerMapping?.documentAnswerText || null,
                attributionNote: q.answerMapping?.explanationNote || "No answer key found in document.",
              })),
            };
          }
        }
        sendToClient({ type: "study_event", event: "questions_detected", data: output });

      } else if (fc.name === "analyzeStudyDiagram") {
        const page = studySessionManager.getCurrentPage();
        if (!page) {
          output = { error: "NO_ACTIVE_PAGE: No study page is currently open." };
        } else {
          const diagramId = args.diagramId as string | undefined;
          const targetDiagram = diagramId
            ? page.diagrams.find((d) => d.id === diagramId)
            : page.diagrams[0];

          if (!targetDiagram) {
            output = {
              analyzed: false,
              message: `No diagrams detected on Page ${page.pageNumber}.`,
            };
          } else {
            const explanation = await DiagramAnalyzer.explainDiagram(
              targetDiagram,
              Boolean(args.forceVisualCapture),
            );
            output = {
              analyzed: true,
              explanation,
            };
          }
        }
        sendToClient({ type: "study_event", event: "diagram_analyzed", data: output });

      } else if (fc.name === "explainStudySection") {
        const page = studySessionManager.getCurrentPage();
        const doc = studySessionManager.getActiveDocument();
        if (!page || !doc) {
          output = { error: "NO_ACTIVE_PAGE: Please load a study document first." };
        } else {
          const mode = (args.mode as string) || "line";
          if (mode === "line") {
            const lineNum = args.lineNumber ? Number(args.lineNumber) : 1;
            const res = TeachingEngine.explainLine(page, lineNum, doc.id);
            output = { mode: "line", result: res };
          } else {
            const secId = (args.sectionId as string) || 0;
            const res = TeachingEngine.explainSection(page, secId, doc.id);
            output = { mode: "section", result: res };
          }
        }
        sendToClient({ type: "study_event", event: "section_explained", data: output });

      } else if (fc.name === "toggleTeachingMode") {
        const enabled = Boolean(args.enabled);
        const style = (args.style as any) || "step_by_step";
        const config = studySessionManager.toggleTeachingMode(enabled, style);
        output = {
          enabled: config.enabled,
          style: config.style,
          interactiveCheckins: config.interactiveCheckins,
          message: enabled
            ? `Voice Teaching Mode is now ACTIVE (${config.style} style). Myraa will explain concepts patiently and check in on understanding.`
            : "Voice Teaching Mode is now DEACTIVATED. Standard companion conversation resumed.",
        };
        sendToClient({ type: "study_event", event: "teaching_mode_toggled", data: output });

      } else if (fc.name === "getStudySessionStatus") {
        const sessionContext = studySessionManager.getSessionContext();
        output = {
          active: sessionContext.isStudyModeActive,
          context: sessionContext,
        };
        sendToClient({ type: "study_event", event: "session_status", data: output });

      } else if (fc.name === "setInteractiveTutorMode") {
        const mode = (args.mode as any) || "off";
        const examConfig =
          args.examDurationMinutes || args.totalMarks
            ? {
                durationMinutes: Number(args.examDurationMinutes) || 15,
                totalMarks: Number(args.totalMarks) || 20,
              }
            : undefined;
        const vivaConfig =
          args.vivaDifficulty || args.vivaFocusTopic
            ? {
                difficulty: (args.vivaDifficulty as any) || "medium",
                focusTopic: args.vivaFocusTopic as string | undefined,
              }
            : undefined;
        const targetQuestions = Array.isArray(args.targetQuestions)
          ? (args.targetQuestions as string[])
          : undefined;

        const state = interactiveTutor.setMode(mode, {
          examConfig,
          vivaConfig,
          targetQuestions,
        });

        output = {
          mode: state.mode,
          state,
          message: `Interactive Tutor mode switched to '${mode.toUpperCase()}'.`,
        };
        sendToClient({ type: "study_event", event: "tutor_mode_changed", data: output });

      } else if (fc.name === "submitStudentAnswer") {
        const questionId = String(args.questionId || "");
        const studentAnswer = String(args.studentAnswer || "");
        const timeTakenSeconds = args.timeTakenSeconds ? Number(args.timeTakenSeconds) : undefined;

        const evalResult = await interactiveTutor.evaluateStudentAnswer({
          questionId,
          studentAnswer,
          timeTakenSeconds,
        });

        output = evalResult;
        sendToClient({ type: "study_event", event: "answer_submitted", data: evalResult });

      } else if (fc.name === "getStudyProgress") {
        const topic = args.topic as string | undefined;
        if (topic) {
          const topicProg = studyProgressTracker.getTopicProgress(topic);
          output = {
            topic,
            progress: topicProg,
          };
        } else {
          const overall = studyProgressTracker.getOverallProgress();
          output = {
            overall,
            weakTopics: overall.weakTopics,
            summary: `Total attempted: ${overall.totalAttempted}, Correct: ${overall.totalCorrect}, Accuracy: ${overall.overallAccuracyRate}% across ${overall.topicsCovered.length} topics.`,
          };
        }
        sendToClient({ type: "study_event", event: "progress_retrieved", data: output });

      } else if (fc.name === "startRevisionSession") {
        const topic = args.topic as string | undefined;
        const maxQuestions = args.maxQuestions ? Number(args.maxQuestions) : 5;
        const revResult = interactiveTutor.startRevisionSession(topic, maxQuestions);

        output = revResult;
        sendToClient({ type: "study_event", event: "revision_started", data: revResult });

      } else if (fc.name === "navigateToStudyItem") {
        const targetType = (args.targetType as any) || "page";
        const targetId = args.targetId ? String(args.targetId) : undefined;
        const pageNumber = args.pageNumber !== undefined ? Number(args.pageNumber) : undefined;

        const navResult = interactiveTutor.navigateToItem({
          targetType,
          targetId,
          pageNumber,
        });

        output = navResult;
        sendToClient({ type: "study_nav_event", ...navResult });
        sendToClient({ type: "study_event", event: "item_navigated", data: navResult });

      } else if (fc.name === "explainRelevantDiagram") {
        const questionId = args.questionId ? String(args.questionId) : undefined;
        const topic = args.topic as string | undefined;
        const forceVisualCapture = Boolean(args.forceVisualCapture);

        const explanation = await interactiveTutor.explainRelevantDiagram({
          questionId,
          topic,
          forceVisualCapture,
        });

        output = {
          explained: true,
          diagram: explanation,
        };
        sendToClient({ type: "study_event", event: "diagram_explained", data: output });

      } else if (fc.name === "configureCourseProfile") {
        const hasData =
          args.courseName ||
          args.currentSemester ||
          args.targetExam ||
          args.targetExamDate ||
          args.subjects;
        let profile;
        if (hasData) {
          profile = courseProfileManager.setProfile({
            courseName: args.courseName as string | undefined,
            currentSemester: args.currentSemester as string | undefined,
            targetExam: args.targetExam as string | undefined,
            targetExamDate: args.targetExamDate as string | undefined,
            subjects: args.subjects as any,
          });
          output = {
            configured: true,
            profile,
            message: `Course profile updated for "${profile.courseName}".`,
          };
        } else {
          profile = courseProfileManager.getProfile();
          output = {
            configured: true,
            profile,
            message: "Active course profile retrieved.",
          };
        }
        sendToClient({ type: "study_event", event: "course_profile_configured", data: output });

      } else if (fc.name === "manageSyllabus") {
        const action = (args.action as string) || "get";
        const subjectId = (args.subjectId as string) || "core-subject";
        const subjectName = (args.subjectName as string) || "Core Subject";

        if (action === "map") {
          const chapters = Array.isArray(args.chapters) ? (args.chapters as any) : [];
          const syllabus = courseProfileManager.mapSyllabus(subjectId, subjectName, chapters);
          output = {
            mapped: true,
            syllabus,
            message: `Syllabus mapped with ${syllabus.chapters.length} chapters (${syllabus.totalTopics} topics).`,
          };
        } else if (action === "update_status") {
          const topicId = String(args.topicId || "");
          const status = (args.status as any) || "completed";
          const updated = courseProfileManager.updateTopicStatus(subjectId, topicId, status);
          output = {
            updated,
            subjectId,
            topicId,
            status,
            message: updated
              ? `Topic ${topicId} marked as '${status}'.`
              : `Failed to update topic ${topicId}. Subject or topic not found.`,
          };
        } else {
          const syllabi = courseProfileManager.getSyllabus(
            args.subjectId ? String(args.subjectId) : undefined,
          );
          output = { count: syllabi.length, syllabi, message: "Syllabus retrieved." };
        }
        sendToClient({ type: "study_event", event: "syllabus_managed", data: output });

      } else if (fc.name === "researchStudyTopic") {
        const topic = String(args.topic || "");
        const subject = args.subject as string | undefined;
        const maxResults = args.maxResults ? Number(args.maxResults) : 4;
        const result = await studyResearchEngine.researchStudyTopic(topic, { subject, maxResults });
        output = result;
        sendToClient({ type: "study_event", event: "study_topic_researched", data: output });

      } else if (fc.name === "discoverStudyVideos") {
        const topic = String(args.topic || "");
        const subject = args.subject as string | undefined;
        const maxResults = args.maxResults ? Number(args.maxResults) : 4;
        const result = await studyResearchEngine.discoverStudyVideos(topic, { subject, maxResults });
        output = result;
        sendToClient({ type: "study_event", event: "study_videos_discovered", data: output });

      } else if (fc.name === "analyzePreviousQuestions") {
        const paperTitle = args.paperTitle as string | undefined;
        const rawText = args.rawText as string | undefined;
        const analysis = await studyResearchEngine.analyzePreviousQuestions({ paperTitle, rawText });
        output = analysis;
        sendToClient({ type: "study_event", event: "previous_questions_analyzed", data: output });

      } else if (fc.name === "generatePersonalizedStudyPlan") {
        const dailyHours = args.dailyHours ? Number(args.dailyHours) : 3;
        const targetExamDate = args.targetExamDate as string | undefined;
        const planName = args.planName as string | undefined;
        const plan = courseProfileManager.generateStudyPlan({
          dailyHours,
          targetExamDate,
          planName,
        });
        output = plan;
        sendToClient({ type: "study_event", event: "study_plan_generated", data: output });

      } else if (fc.name === "getStudyRecommendations") {
        let recommendations = studyResearchEngine.getWeakTopicRecommendations();
        if (args.topic) {
          const filterTopic = String(args.topic).toLowerCase();
          recommendations = recommendations.filter((r) =>
            r.topic.toLowerCase().includes(filterTopic),
          );
        }
        output = { count: recommendations.length, recommendations };
        sendToClient({
          type: "study_event",
          event: "study_recommendations_retrieved",
          data: output,
        });

      } else if (fc.name === "manageDailyStudySession") {
        const action = (args.action as string) || "get";
        const date = args.date as string | undefined;

        if (action === "create") {
          const session = courseProfileManager.createOrGetDailySession(date);
          output = {
            session,
            message: `Daily study session initialized with ${session.targets.length} targets.`,
          };
        } else if (action === "update_target") {
          const targetId = String(args.targetId || "");
          const completed = Boolean(args.completed);
          const session = courseProfileManager.updateDailyTarget(targetId, completed, date);
          output = { session, message: `Target '${targetId}' updated.` };
        } else if (action === "complete") {
          const notes = args.notes as string | undefined;
          const session = courseProfileManager.completeDailySession(notes, date);
          output = { session, message: "Daily study session marked as completed!" };
        } else {
          const session =
            courseProfileManager.getDailySession(date) ||
            courseProfileManager.createOrGetDailySession(date);
          output = { session, message: "Daily study session retrieved." };
        }
        sendToClient({ type: "study_event", event: "daily_session_managed", data: output });

      } else if (fc.name === "getAcademicProgress") {
        const summary = courseProfileManager.calculateAcademicProgress();
        output = summary;
        sendToClient({ type: "study_event", event: "academic_progress_retrieved", data: output });
      }

      session.sendToolResponse({
        functionResponses: [{ name: fc.name, response: { output }, id: fc.id }],
      });
    } catch (err: any) {
      const errMsg = sanitizeError(err?.message || "Study tool execution failed.");
      console.error(`[Study Tool] Error executing ${fc.name}:`, errMsg);
      session.sendToolResponse({
        functionResponses: [
          {
            name: fc.name,
            response: { output: { error: errMsg } },
            id: fc.id,
          },
        ],
      });
    }
  }
}


