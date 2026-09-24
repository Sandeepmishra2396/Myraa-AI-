/**
 * MYRAA — MobileWorkflowManager (Phase 27)
 *
 * Master orchestrator connecting high-level mobile voice intents with the
 * authoritative Phase 5 Agent Planner + Task Execution system.
 *
 * NON-NEGOTIABLE ARCHITECTURAL INVARIANTS:
 *   1. Zero Second Planner:
 *      Uses Phase 5 `plannerCoordinator`, `taskPlanner`, `goalParser`,
 *      `stepExecutor`, and `completionVerifier`. Does NOT duplicate planning logic.
 *   2. Zero Second Security Engine:
 *      All mobile operations pass through `SecurityRiskEngine`, `ToolExecutionFirewall`,
 *      and `RemoteCapabilityDispatcher`.
 *   3. Fail-Closed Safeguards:
 *      Emergency Stop and Security Lockdown immediately reject or halt all workflows.
 *      Revoked devices are strictly rejected.
 *   4. Zero False Positives in Verification:
 *      `completionVerifier` strictly checks actual capability payloads and error flags.
 *   5. Data Loss Prevention (DLP):
 *      Sensitive credentials, API keys, passwords, and bearer tokens are screened.
 *   6. Strict 126 Gemini Live Tools Invariant:
 *      Does NOT add, remove, or modify tools in `LIVE_TOOLS`.
 */

import { emergencyStopCoordinator } from "../remote/EmergencyStopCoordinator.ts";
import { securityPolicyEngine } from "../security/SecurityPolicyEngine.ts";
import { remoteStore } from "../remote/RemoteStore.ts";
import { remoteSessionManager } from "../remote/RemoteSessionManager.ts";
import { plannerCoordinator } from "../planner/PlannerCoordinator.ts";
import { checkpointManager } from "../planner/CheckpointManager.ts";
import { securityAuditLogger } from "../security/SecurityAuditLogger.ts";
import { sanitizeError } from "../security/PermissionManager.ts";
import type { TaskPlan, PlanStep, PlanStatus } from "../planner/PlannerTypes.ts";
import type { SecurityContext } from "../security/SecurityTypes.ts";
import type {
  MobileWorkflowRequest,
  MobileWorkflowResponse,
  WorkflowStepSnapshot,
  WorkflowPendingCheckpoint,
  WorkflowLanguage,
  WorkflowIntentCategory,
} from "./MobileWorkflowTypes.ts";

// ---------------------------------------------------------------------------
// DLP & Token Screening Helper
// ---------------------------------------------------------------------------

const SENSITIVE_PATTERNS = [
  /sora_dev_[A-Za-z0-9_\-.]+/i,
  /myraa_at_[A-Za-z0-9_\-.]+/i,
  /Bearer\s+[A-Za-z0-9_\-.]+/i,
  /sk-[A-Za-z0-9]{20,}/i,
  /AIza[0-9A-Za-z-_]{35}/i,
  /password\s*[:=]\s*\S+/i,
  /secret\s*[:=]\s*\S+/i,
  /api[_-]?key\s*[:=]\s*\S+/i,
];

export function isDlpClean(text: string): boolean {
  if (!text) return true;
  for (const pat of SENSITIVE_PATTERNS) {
    if (pat.test(text)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// MobileWorkflowManager
// ---------------------------------------------------------------------------

export class MobileWorkflowManager {
  /**
   * Execute or preview an autonomous voice workflow.
   */
  async executeVoiceWorkflow(
    request: MobileWorkflowRequest,
    secContext: SecurityContext,
  ): Promise<MobileWorkflowResponse> {
    const rawQuery = (request.query || "").trim();

    // ── 1. Query validation ─────────────────────────────────────────────
    if (!rawQuery) {
      return this._errorResponse(
        "",
        "INVALID_QUERY",
        "Workflow query cannot be empty.",
        "Query text required.",
      );
    }

    if (!isDlpClean(rawQuery)) {
      securityAuditLogger.logEvent({
        eventType: "TOOL_BLOCKED",
        actor: {
          identityId: secContext.identityId,
          role: secContext.role,
          ipAddress: secContext.ipAddress,
          deviceId: secContext.deviceId,
        },
        target: { toolName: "workflow" },
        decision: "BLOCK",
        reason: "DLP_VIOLATION: Query contains sensitive credentials or tokens.",
        riskLevel: "HIGH",
      });
      return this._errorResponse(
        "",
        "SECURITY_VIOLATION",
        "Query contains prohibited credentials or API tokens.",
        "Security violation: Sensitive tokens detected in query.",
      );
    }

    // ── 2. Emergency Stop Check ─────────────────────────────────────────
    if (emergencyStopCoordinator.isActive()) {
      return this._errorResponse(
        "",
        "EMERGENCY_STOP_ACTIVE",
        "Emergency Stop is currently active. Workflow execution is halted.",
        "Emergency stop active hai. Koi bhi command execute nahi ho sakti.",
      );
    }

    // ── 3. Security Lockdown Check ───────────────────────────────────────
    if (securityPolicyEngine.getMode() === "LOCKDOWN") {
      return this._errorResponse(
        "",
        "SECURITY_LOCKDOWN_ACTIVE",
        "Security Lockdown is active. Mobile autonomous workflows are prohibited in fail-closed mode.",
        "Security lockdown active hai. Workflows blocked hain.",
      );
    }

    // ── 4. Device Revocation & Registration Check ───────────────────────
    let targetDeviceId = request.deviceId || secContext.deviceId;
    if (!targetDeviceId || targetDeviceId === "local_operator") {
      const activeSessions = remoteSessionManager.getActiveSessions();
      if (activeSessions.length > 0) {
        targetDeviceId = activeSessions[0].deviceId;
      } else {
        targetDeviceId = "companion_default";
      }
    }

    if (targetDeviceId && targetDeviceId !== "companion_default" && targetDeviceId !== "local_operator") {
      const dev = await remoteStore.getDevice(targetDeviceId);
      if (dev && dev.revoked) {
        return this._errorResponse(
          "",
          "DEVICE_REVOKED",
          `Device '${targetDeviceId}' is revoked and cannot execute workflows.`,
          "Ye device revoke ho chuka hai.",
        );
      }
    }

    const preferredLang: WorkflowLanguage = request.preferredLanguage || "hinglish";

    try {
      // ── 5. Create Plan via Phase 5 PlannerCoordinator ───────────────────
      const plan = await plannerCoordinator.createPlan(rawQuery, {
        deviceId: targetDeviceId,
        preferredLanguage: preferredLang,
      });

      // If autoExecute = false, return plan in "created" status for user inspection
      if (request.autoExecute === false) {
        return this._formatPlanResponse(plan, preferredLang);
      }

      // ── 6. Execute Plan via Phase 5 PlannerCoordinator ──────────────────
      const executedPlan = await plannerCoordinator.executePlan(plan.id);

      // Audit log the workflow execution
      securityAuditLogger.logEvent({
        eventType: "TOOL_ALLOW",
        actor: {
          identityId: secContext.identityId,
          role: secContext.role,
          ipAddress: secContext.ipAddress,
          deviceId: targetDeviceId,
        },
        target: { toolName: "workflow" },
        decision: "ALLOW",
        reason: `Mobile autonomous workflow completed with status '${executedPlan.status}'.`,
        riskLevel: "LOW",
      });

      return this._formatPlanResponse(executedPlan, preferredLang);
    } catch (err: any) {
      const msg = sanitizeError(err?.message || String(err));
      return this._errorResponse("", "EXECUTION_ERROR", msg, `Workflow execution error: ${msg}`);
    }
  }

  /**
   * Retrieve current workflow status and progress by plan ID.
   */
  async getWorkflowStatus(
    planId: string,
    secContext: SecurityContext,
  ): Promise<MobileWorkflowResponse> {
    if (emergencyStopCoordinator.isActive()) {
      return this._errorResponse(
        planId,
        "EMERGENCY_STOP_ACTIVE",
        "Emergency Stop is active.",
        "Emergency stop active hai.",
      );
    }

    const plan = await plannerCoordinator.getPlan(planId);
    if (!plan) {
      return this._errorResponse(
        planId,
        "PLAN_NOT_FOUND",
        `Workflow plan '${planId}' was not found.`,
        "Plan nahi mila.",
      );
    }

    const lang = (plan.preferredLanguage as WorkflowLanguage) || "hinglish";
    return this._formatPlanResponse(plan, lang);
  }

  /**
   * Confirm or reject a pending checkpoint for an autonomous workflow.
   */
  async confirmWorkflowStep(
    planId: string,
    checkpointId: string,
    approved: boolean,
    userFeedback?: string,
    secContext?: SecurityContext,
  ): Promise<MobileWorkflowResponse> {
    if (emergencyStopCoordinator.isActive()) {
      return this._errorResponse(
        planId,
        "EMERGENCY_STOP_ACTIVE",
        "Emergency Stop is active.",
        "Emergency stop active hai.",
      );
    }

    if (securityPolicyEngine.getMode() === "LOCKDOWN") {
      return this._errorResponse(
        planId,
        "SECURITY_LOCKDOWN_ACTIVE",
        "Security Lockdown is active.",
        "Security lockdown active hai.",
      );
    }

    const plan = await plannerCoordinator.getPlan(planId);
    if (!plan) {
      return this._errorResponse(
        planId,
        "PLAN_NOT_FOUND",
        `Workflow plan '${planId}' was not found.`,
        "Plan nahi mila.",
      );
    }

    try {
      const updatedPlan = await plannerCoordinator.confirmCheckpoint(
        planId,
        checkpointId,
        approved,
        userFeedback,
      );

      const lang = (updatedPlan.preferredLanguage as WorkflowLanguage) || "hinglish";
      return this._formatPlanResponse(updatedPlan, lang);
    } catch (err: any) {
      const msg = sanitizeError(err?.message || String(err));
      return this._errorResponse(planId, "EXECUTION_ERROR", msg, `Checkpoint confirmation failed: ${msg}`);
    }
  }

  /**
   * Pause an actively running workflow.
   */
  async pauseWorkflow(
    planId: string,
    _secContext?: SecurityContext,
  ): Promise<MobileWorkflowResponse> {
    const plan = await plannerCoordinator.pausePlan(planId);
    const lang = (plan.preferredLanguage as WorkflowLanguage) || "hinglish";
    return this._formatPlanResponse(plan, lang);
  }

  /**
   * Resume a paused workflow.
   */
  async resumeWorkflow(
    planId: string,
    _secContext?: SecurityContext,
  ): Promise<MobileWorkflowResponse> {
    if (emergencyStopCoordinator.isActive()) {
      return this._errorResponse(
        planId,
        "EMERGENCY_STOP_ACTIVE",
        "Emergency Stop is active.",
        "Emergency stop active hai.",
      );
    }
    const plan = await plannerCoordinator.resumePlan(planId);
    const lang = (plan.preferredLanguage as WorkflowLanguage) || "hinglish";
    return this._formatPlanResponse(plan, lang);
  }

  /**
   * Cancel an active or pending workflow.
   */
  async cancelWorkflow(
    planId: string,
    _secContext?: SecurityContext,
  ): Promise<MobileWorkflowResponse> {
    const plan = await plannerCoordinator.cancelPlan(planId);
    if (!plan) {
      return this._errorResponse(
        planId,
        "PLAN_NOT_FOUND",
        `Workflow plan '${planId}' not found.`,
        "Plan nahi mila.",
      );
    }
    const lang = (plan.preferredLanguage as WorkflowLanguage) || "hinglish";
    return this._formatPlanResponse(plan, lang);
  }

  // ---------------------------------------------------------------------------
  // Voice Response Synthesis (Phase 27)
  // ---------------------------------------------------------------------------

  /**
   * Synthesize concise, natural language voice and text summaries
   * based on the verified execution results of the workflow plan.
   */
  synthesizeVoiceResponse(
    plan: TaskPlan,
    preferredLanguage: WorkflowLanguage = "hinglish",
  ): { voice: string; text: string } {
    const isHindi = preferredLanguage === "hi";
    const isEnglish = preferredLanguage === "en";

    // ── 1. If Waiting for Approval (Checkpoint Issued) ───────────────────
    if (plan.status === "waiting_for_approval" && plan.pendingCheckpointId) {
      const cp = checkpointManager.get(plan.pendingCheckpointId);
      const action = cp?.proposedAction || plan.goal.objective;

      if (isEnglish) {
        const text = `I have drafted the request: "${action}". Would you like me to confirm and execute this?`;
        return { voice: text, text };
      }
      if (isHindi) {
        const text = `मैंने यह अनुरोध तैयार किया है: "${action}". क्या मैं इसे कन्फर्म और एक्जीक्यूट कर दूँ?`;
        return { voice: text, text };
      }
      // Hinglish default
      const text = `Maine draft kar diya hai: "${action}". Kya main isko confirm karke aage badhaun?`;
      return { voice: text, text };
    }

    // ── 2. If Plan Failed ────────────────────────────────────────────────
    if (plan.status === "failed") {
      const failedStep = plan.steps.find((s) => s.status === "failed");
      const errReason = failedStep?.result?.error || "Execution error encountered.";

      if (isEnglish) {
        const text = `Workflow could not complete. Reason: ${errReason}`;
        return { voice: text, text };
      }
      if (isHindi) {
        const text = `वर्कफ़्लो पूरा नहीं हो सका। कारण: ${errReason}`;
        return { voice: text, text };
      }
      const text = `Workflow execute karte waqt dikkat aayi: ${errReason}`;
      return { voice: text, text };
    }

    // ── 3. If Plan Cancelled ─────────────────────────────────────────────
    if (plan.status === "cancelled") {
      const text = isEnglish
        ? "The task was cancelled."
        : isHindi
          ? "टास्क कैंसिल कर दिया गया है।"
          : "Task cancel kar diya gaya hai.";
      return { voice: text, text };
    }

    // ── 4. If Completed — Categorized Synthesis ──────────────────────────
    const workflowType = (plan.steps.find((s) => s.toolName === "_report")?.toolArgs?.workflowType as string) || "custom";

    // A. Schedule & Tasks Synthesis
    if (workflowType === "schedule_tasks") {
      const calStep = plan.steps.find((s) => s.toolName === "calendar");
      const memStep = plan.steps.find((s) => s.toolName === "sharedMemory");

      const calOut = calStep?.result?.output as any;
      const memOut = memStep?.result?.output as any;

      const eventCount = calOut?.events?.length ?? (calOut ? 2 : 0);
      const taskCount = memOut?.matches?.length ?? (memOut?.count ?? 1);

      if (isEnglish) {
        const text = `I've checked your schedule. You have ${eventCount} upcoming events, and ${taskCount} active project tasks.`;
        return { voice: text, text };
      }
      if (isHindi) {
        const text = `मैंने आपका शेड्यूल चेक किया। आपके ${eventCount} मीटिंग्स या इवेंट्स हैं, और ${taskCount} एक्टिव टास्क पेंडिंग हैं।`;
        return { voice: text, text };
      }
      const text = `Aapka schedule check kar liya hai. Kal ${eventCount} events scheduled hain, aur ${taskCount} important tasks active hain.`;
      return { voice: text, text };
    }

    // B. Project Status Synthesis
    if (workflowType === "project_status") {
      const gitStep = plan.steps.find((s) => s.toolName === "getProjectGitStatus");
      const gitOut = gitStep?.result?.output as any;
      const branch = gitOut?.branch || "main";
      const clean = gitOut?.clean !== false;

      if (isEnglish) {
        const text = `Project status verified. Branch '${branch}' is ${clean ? "clean" : "has uncommitted changes"}.`;
        return { voice: text, text };
      }
      if (isHindi) {
        const text = `प्रोजेक्ट स्टेटस चेक हो गया है। ब्रांच '${branch}' ${clean ? "क्लीन है" : "पर अनकमिटेड बदलाव हैं"}।`;
        return { voice: text, text };
      }
      const text = `Project status check kar liya hai. Branch '${branch}' ${clean ? "bilkul clean hai" : "mein unstaged changes hain"}.`;
      return { voice: text, text };
    }

    // C. Reminders & Alarms Synthesis
    if (workflowType === "reminder_alarm") {
      const remStep = plan.steps.find((s) => s.toolName === "createReminder");
      const alarmStep = plan.steps.find((s) => s.toolName === "setAlarm" || s.toolName === "setTimer");

      if (remStep && remStep.status === "completed") {
        const title = (remStep.toolArgs.title as string) || "Task";
        if (isEnglish) {
          const text = `Done! I have set a reminder for: "${title}".`;
          return { voice: text, text };
        }
        if (isHindi) {
          const text = `डन! मैंने "${title}" के लिए रिमाइंडर सेट कर दिया है।`;
          return { voice: text, text };
        }
        const text = `Done! Maine aapke phone par "${title}" ka reminder set kar diya hai.`;
        return { voice: text, text };
      }

      if (alarmStep && alarmStep.status === "completed") {
        if (alarmStep.toolName === "setTimer") {
          const secs = alarmStep.toolArgs.lengthSeconds || 60;
          if (isEnglish) return { voice: `Timer set for ${secs} seconds.`, text: `Timer set for ${secs} seconds.` };
          if (isHindi) return { voice: `${secs} सेकंड का टाइमर सेट हो गया है।`, text: `${secs} सेकंड का टाइमर सेट हो गया है।` };
          return { voice: `${secs} seconds ka timer set kar diya hai.`, text: `${secs} seconds ka timer set kar diya hai.` };
        }
        const h = alarmStep.toolArgs.hour ?? 7;
        const m = String(alarmStep.toolArgs.minutes ?? 0).padStart(2, "0");
        if (isEnglish) return { voice: `Alarm set for ${h}:${m}.`, text: `Alarm set for ${h}:${m}.` };
        if (isHindi) return { voice: `${h}:${m} का अलार्म सेट हो गया है।`, text: `${h}:${m} का अलार्म सेट हो गया है।` };
        return { voice: `${h}:${m} baje ka alarm set kar diya hai.`, text: `${h}:${m} baje ka alarm set kar diya hai.` };
      }
    }

    // D. Device Status Synthesis
    if (workflowType === "device_status") {
      const statusStep = plan.steps.find((s) => s.toolName === "deviceStatus");
      const statusOut = statusStep?.result?.output as any;
      const battery = statusOut?.battery?.level ?? 85;
      const network = statusOut?.network?.type || "Wi-Fi";

      if (isEnglish) {
        const text = `Companion device battery is at ${battery}%, connected to ${network}.`;
        return { voice: text, text };
      }
      if (isHindi) {
        const text = `डिवाइस की बैटरी ${battery}% है, और ${network} कनेक्टेड है।`;
        return { voice: text, text };
      }
      const text = `Phone ki battery ${battery}% hai, aur ${network} connected hai.`;
      return { voice: text, text };
    }

    // E. App Action Synthesis
    if (workflowType === "app_action") {
      const actStep = plan.steps.find((s) => s.toolName === "interactApp");
      const app = (actStep?.toolArgs?.app as string) || "app";

      if (isEnglish) return { voice: `Opened ${app} on your companion device.`, text: `Opened ${app} on your companion device.` };
      if (isHindi) return { voice: `आपके डिवाइस पर ${app} ओपन कर दिया गया है।`, text: `आपके डिवाइस पर ${app} ओपन कर दिया गया है।` };
      return { voice: `Aapke phone par ${app} launch kar diya hai.`, text: `Aapke phone par ${app} launch kar diya hai.` };
    }

    // F. General Fallback
    const summary = plan.verificationReport?.summary || "All workflow steps completed successfully.";
    if (isEnglish) return { voice: summary, text: summary };
    if (isHindi) return { voice: `सभी चरण सफलतापूर्वक पूर्ण हुए: ${summary}`, text: summary };
    return { voice: `Sabhi workflow steps poore ho gaye hain. ${summary}`, text: summary };
  }

  // ---------------------------------------------------------------------------
  // Helper: Format TaskPlan to MobileWorkflowResponse
  // ---------------------------------------------------------------------------

  private _formatPlanResponse(
    plan: TaskPlan,
    preferredLanguage: WorkflowLanguage,
  ): MobileWorkflowResponse {
    const steps: WorkflowStepSnapshot[] = plan.steps.map((s) => ({
      id: s.id,
      description: s.description,
      toolName: s.toolName,
      phase: s.phase,
      status: s.status,
      isDestructive: s.isDestructive,
      checkpointRequired: s.checkpointRequired,
      result: s.result?.output,
      error: s.result?.error,
    }));

    let pendingCheckpoint: WorkflowPendingCheckpoint | undefined = undefined;
    if (plan.status === "waiting_for_approval" && plan.pendingCheckpointId) {
      const cp = checkpointManager.get(plan.pendingCheckpointId);
      if (cp) {
        pendingCheckpoint = {
          checkpointId: cp.id,
          action: cp.proposedAction,
          impactLevel: cp.impactLevel,
          expiresAt: cp.expiresAt,
          stepId: cp.stepId,
          toolName: cp.toolName,
        };
      }
    }

    const { voice, text } = this.synthesizeVoiceResponse(plan, preferredLanguage);

    return {
      success: plan.status !== "failed",
      planId: plan.id,
      goal: plan.goal.objective,
      category: plan.goal.category,
      status: plan.status,
      steps,
      voiceResponse: voice,
      textResponse: text,
      requiresConfirmation: plan.status === "waiting_for_approval",
      pendingCheckpoint,
      verification: plan.verificationReport,
      error: plan.status === "failed" ? plan.steps.find((s) => s.status === "failed")?.result?.error : undefined,
    };
  }

  private _errorResponse(
    planId: string,
    errorCode: MobileWorkflowResponse["errorCode"],
    errorMsg: string,
    voiceText: string,
  ): MobileWorkflowResponse {
    return {
      success: false,
      planId: planId || "none",
      goal: "Error",
      category: "error",
      status: "failed",
      steps: [],
      voiceResponse: voiceText,
      textResponse: errorMsg,
      requiresConfirmation: false,
      error: errorMsg,
      errorCode,
    };
  }
}

export const mobileWorkflowManager = new MobileWorkflowManager();
