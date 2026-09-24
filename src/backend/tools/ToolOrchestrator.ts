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

import type { Memory, MemoryCategory } from "../../lib/memoryTypes.ts";
import { DESKTOP_TOOLS, callDesktopAgent } from "../tasks/TaskManager.ts";
import { loadMemories, saveMemories } from "../../../server_memory.ts";
import { projectManager } from "../projects/ProjectManager.ts";
import { knowledgeManager } from "../knowledge/KnowledgeManager.ts";
import { isPathWithinWorkspace, sanitizeError } from "../security/PermissionManager.ts";
import { plannerCoordinator } from "../planner/PlannerCoordinator.ts";
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
  outputDataFirewall,
  type SecurityContext,
} from "../security/index.ts";

export { MODIFYING_TOOLS };
const WORKSPACE = process.env.SORA_WORKSPACE_DIR || process.cwd();

export const PROJECT_TOOLS = new Set([
  "analyzeProject",
  "getProjectArchitecture",
  "searchProjectCode",
  "getProjectGitStatus",
  "trackProjectTask",
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
}

/** Callback used to push messages to the browser WebSocket client. */
export type SendToClientFn = (payload: unknown) => void;

export class ToolOrchestrator {
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
    console.log(`[Function Call]: ${fc.name}`, fc.args);

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

    // ── Deterministic Security Policy Engine Gate (Phase 10A) ───────────
    const secContext: SecurityContext = context || (fc as any).securityContext || {
      identityId: "local_operator",
      role: "admin",
      ipAddress: "127.0.0.1",
      isLocal: true,
    };

    const providedConfirmation =
      (fc.args?.confirmationToken as string) ||
      (fc.args?.checkpointId as string) ||
      (fc.args?._checkpointId as string);

    const policyDecision = await securityPolicyEngine.evaluateRequest(
      fc.name,
      fc.args || {},
      secContext,
      providedConfirmation,
    );

    if (!policyDecision.allowed) {
      console.warn(`[SecurityPolicyEngine] Blocked tool execution '${fc.name}': ${policyDecision.reason}`);
      session.sendToolResponse({
        functionResponses: [
          {
            name: fc.name,
            response: {
              output: {
                error: policyDecision.reason,
                blocked: true,
                requiresConfirmation: policyDecision.decision === "REQUIRE_CONFIRMATION",
                confirmationToken: policyDecision.confirmationToken,
                riskLevel: policyDecision.risk.level,
              },
            },
            id: fc.id,
          },
        ],
      });
      return;
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
    };

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
        await this._handleProjectTool(fc, guardedSession);
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
        await this._handlePlannerTool(fc, guardedSession, sendToClient);
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

    // ── 9. Desktop control tools — route to Python agent ─────────────────
    if (DESKTOP_TOOLS.has(fc.name)) {
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
        await this._handleDesktopTool(fc, guardedSession);
      } catch (err) {
        console.error(`[Desktop Agent] Unhandled error for ${fc.name}:`, err);
      }
      return;
    }

    // ── 4. Client-side holographic tools — forward to browser ────────────
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
  ): Promise<void> {
    try {
      const args = fc.args || {};
      let output: unknown = { result: "Done." };

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
        if (action === "add" && args.title) {
          const task = await projectManager.addTask(
            args.title as string,
            args.description as string,
            args.status as any,
          );
          output = { success: true, task };
        } else if (action === "update" && args.taskId) {
          const updated = await projectManager.updateTask(args.taskId as string, {
            title: args.title as string,
            description: args.description as string,
            status: args.status as any,
          });
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

        // Optional update of session resume summary
        if (args.sessionSummary) {
          await projectManager.updateLastSession(
            args.sessionSummary as string,
            args.nextSteps as string,
          );
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
      const { sharedMemoryManager } = await import("../memory/SharedMemoryManager.ts");
      const created = await sharedMemoryManager.createMemory(
        {
          category,
          text,
          key: args.key,
          importance: args.importance,
          confidence: args.confidence,
          deviceId: secContext?.deviceId || "desktop_local",
          deviceType: secContext?.isLocal ? "desktop" : "android",
        },
        secContext,
      );

      const all = await sharedMemoryManager.listMemories();
      sendToClient({ type: "memory_sync", memories: all });

      session.sendToolResponse({
        functionResponses: [
          {
            name: fc.name,
            response: {
              output: {
                result:
                  "Memory successfully captured and persisted in connections core.",
                memoryId: created.id,
                version: created.version,
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
  ): Promise<void> {
    // ── FINAL DISPATCH-LAYER SAFETY GATE: modifying / destructive tools ───
    if (MODIFYING_TOOLS.has(fc.name)) {
      // 1. Direct workspace boundary & path traversal check independent of hash
      const candidatePaths = extractPathArgs(fc.args || {});
      for (const p of candidatePaths) {
        if (!isPathWithinWorkspace(p, WORKSPACE)) {
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
      const checkpointId = (fc.args.checkpointId ?? fc.args._checkpointId) as string | undefined;
      if (!checkpointId) {
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

      // 3. Verify and consume the checkpoint token
      const stepId = (fc.args.stepId as string) || "direct";
      const approved = checkpointManager.consumeApproval(
        checkpointId,
        stepId,
        fc.name,
        fc.args,
      );
      if (!approved) {
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

    console.log(`[Desktop Agent] Routing ${fc.name} to Python backend...`);
    const agentResult = await callDesktopAgent(
      fc.name,
      fc.args as Record<string, unknown>,
    );

    if (agentResult.ok) {
      const output = agentResult.result ?? { result: "Done." };
      session.sendToolResponse({
        functionResponses: [
          {
            name: fc.name,
            response: { output },
            id: fc.id,
          },
        ],
      });
    } else {
      const errMsg = agentResult.error || "Desktop agent error.";
      console.error(`[Desktop Agent] Error for ${fc.name}:`, errMsg);
      session.sendToolResponse({
        functionResponses: [
          {
            name: fc.name,
            response: {
              output: { result: `Desktop control error: ${errMsg}` },
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
  ): Promise<void> {
    try {
      const args = fc.args || {};
      let output: unknown = { result: "Done." };

      if (fc.name === "planTask") {
        const goal = (args.goal as string) || "";
        const plan = await plannerCoordinator.createPlan(goal);
        output = {
          planId: plan.id,
          status: plan.status,
          stepCount: plan.steps.length,
          phases: [...new Set(plan.steps.map((s) => s.phase))],
          requiresModification: plan.goal.requiresModification,
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
        const planId = (args.planId as string) || "";
        const checkpointId = (args.checkpointId as string) || "";
        const approved = args.approved === true;
        const userFeedback = args.userFeedback as string | undefined;
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


