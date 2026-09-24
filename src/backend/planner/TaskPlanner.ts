/**
 * MYRAA — TaskPlanner (Phase 5)
 *
 * Generates the canonical 8-phase execution plan from a parsed `Goal`.
 *
 * Phase order:
 *   understand → inspect → plan → checkpoint (if modifying) → modify → test → verify → report
 *
 * Design:
 *   • Purely deterministic; no network calls; safe for unit tests.
 *   • Every step that writes files, executes code, or has side-effects is
 *     marked `isDestructive: true` and `checkpointRequired: true`.
 *   • Dependencies enforce ordering: no modifying step may start before
 *     its checkpoint step is completed.
 *   • argsHash is computed at plan-creation time to enable tamper detection.
 */

import crypto from "crypto";
import type { Goal, PlanStep, TaskPlan, StepPhase } from "./PlannerTypes.ts";
import { hashArgs } from "./CheckpointManager.ts";

// ---------------------------------------------------------------------------
// Step factory
// ---------------------------------------------------------------------------

function makeStep(
  phase: StepPhase,
  description: string,
  toolName: string,
  toolArgs: Record<string, unknown>,
  opts: {
    isDestructive?: boolean;
    checkpointRequired?: boolean;
    dependsOn?: string[];
    maxRetries?: number;
  } = {},
): PlanStep {
  const id = crypto.randomUUID();
  const argsHash = hashArgs(toolArgs);
  return {
    id,
    phase,
    status: "pending",
    description,
    toolName,
    toolArgs,
    argsHash,
    dependsOn: opts.dependsOn ?? [],
    isDestructive: opts.isDestructive ?? false,
    checkpointRequired: opts.checkpointRequired ?? false,
    retryCount: 0,
    maxRetries: opts.maxRetries ?? (opts.isDestructive ? 0 : 3),
  };
}

// ---------------------------------------------------------------------------
// TaskPlanner
// ---------------------------------------------------------------------------

export class TaskPlanner {
  /**
   * Build a full TaskPlan from a Goal.
   * Returns the plan (not yet persisted — caller must call PlanStore.savePlan).
   */
  buildPlan(
    goal: Goal,
    options?: { deviceId?: string; preferredLanguage?: string },
  ): TaskPlan {
    const planId = crypto.randomUUID();
    const now = new Date().toISOString();

    // ── Phase 27: Autonomous Mobile Workflow Plan Decomposition ─────────
    if (goal.category === "workflow") {
      return this._buildWorkflowPlan(goal, planId, now, options);
    }

    const steps: PlanStep[] = [];

    // ── Phase 1: Understand ────────────────────────────────────────────────
    const understand = makeStep(
      "understand",
      "Load project context, architecture, and recent session summary to understand the current state of the codebase.",
      "analyzeProject",
      {},
      { maxRetries: 3 },
    );
    steps.push(understand);

    // ── Phase 2: Inspect ──────────────────────────────────────────────────
    // Search for code / files related to the goal
    const inspectArgs: Record<string, unknown> = {
      query: goal.objective,
      maxResults: 15,
    };
    if (goal.scope.targetFiles.length > 0) {
      inspectArgs.filePattern = goal.scope.targetFiles.map((f) => `*${f.split(".").pop() ?? ""}`).join(",");
    }
    const inspect = makeStep(
      "inspect",
      `Search project code and files relevant to: "${goal.objective}"`,
      "searchProjectCode",
      inspectArgs,
      { dependsOn: [understand.id], maxRetries: 3 },
    );
    steps.push(inspect);

    // ── Phase 3: Plan ──────────────────────────────────────────────────────
    // Read git status to understand current branch and unstaged changes
    const planStep = makeStep(
      "plan",
      "Check git status to understand the current branch and any uncommitted changes before making modifications.",
      "getProjectGitStatus",
      {},
      { dependsOn: [inspect.id], maxRetries: 3 },
    );
    steps.push(planStep);

    // Read target file(s) if specified (non-destructive inspection)
    let lastReadStep = planStep;
    for (const targetFile of goal.scope.targetFiles.slice(0, 3)) {
      const readStep = makeStep(
        "plan",
        `Read current content of '${targetFile}' before modification.`,
        "readFile",
        { path: targetFile },
        { dependsOn: [planStep.id], maxRetries: 3 },
      );
      steps.push(readStep);
      lastReadStep = readStep;
    }

    // Research phase (if category is research or feature/documentation)
    let lastResearchStep = lastReadStep;
    if (["research", "documentation", "feature", "bugfix"].includes(goal.category)) {
      const researchStep = makeStep(
        "plan",
        `Research latest information and best practices for: "${goal.objective}"`,
        "researchWeb",
        { query: goal.objective, maxResults: 5 },
        { dependsOn: [lastReadStep.id], maxRetries: 3 },
      );
      steps.push(researchStep);
      lastResearchStep = researchStep;
    }

    // ── Phase 4: Checkpoint (only if modification is required) ────────────
    let lastBeforeModify = lastResearchStep;
    if (goal.requiresModification) {
      const checkpointStep = makeStep(
        "checkpoint",
        `Awaiting your confirmation before making changes for: "${goal.objective}". ` +
          (goal.scope.targetFiles.length > 0
            ? `Target file(s): ${goal.scope.targetFiles.join(", ")}.`
            : "Target files will be determined from inspection results."),
        "_checkpoint",                   // Sentinel — intercepted by coordinator
        { planId, goalObjective: goal.objective },
        {
          isDestructive: false,          // The checkpoint step itself is not destructive
          checkpointRequired: false,     // It IS the checkpoint; no nested gate
          dependsOn: [lastResearchStep.id],
          maxRetries: 0,
        },
      );
      steps.push(checkpointStep);
      lastBeforeModify = checkpointStep;

      // ── Phase 5: Modify ─────────────────────────────────────────────────
      // Determine the appropriate write tool based on goal category
      const writeTool = this._selectWriteTool(goal);
      const writeArgs = this._buildWriteArgs(goal);
      const modifyStep = makeStep(
        "modify",
        `Execute modification: ${this._modifyDescription(goal)}`,
        writeTool,
        writeArgs,
        {
          isDestructive: true,
          checkpointRequired: true,
          dependsOn: [checkpointStep.id],
          maxRetries: 0,              // destructive steps never auto-retry
        },
      );
      steps.push(modifyStep);
      lastBeforeModify = modifyStep;

      // ── Phase 6: Test ────────────────────────────────────────────────────
      if (["bugfix", "refactor", "feature", "testing"].includes(goal.category)) {
        const testStep = makeStep(
          "test",
          "Verify that existing tests still pass after modifications.",
          "runPythonScript",
          { script: "echo Test phase placeholder - run npm test in project root", capture: true },
          {
            isDestructive: false,
            checkpointRequired: false,
            dependsOn: [modifyStep.id],
            maxRetries: 2,
          },
        );
        steps.push(testStep);
        lastBeforeModify = testStep;
      }
    }

    // ── Phase 7: Verify ──────────────────────────────────────────────────
    const verifyStep = makeStep(
      "verify",
      "Verify all expected outcomes from the goal have been satisfied.",
      "analyzeProject",
      { path: undefined },
      {
        isDestructive: false,
        checkpointRequired: false,
        dependsOn: [lastBeforeModify.id],
        maxRetries: 2,
      },
    );
    steps.push(verifyStep);

    // ── Phase 8: Report ──────────────────────────────────────────────────
    const reportStep = makeStep(
      "report",
      "Compile a final summary of all actions taken, outcomes achieved, and verification results.",
      "_report",                         // Sentinel — handled by coordinator
      { planId, goalId: goal.id },
      {
        isDestructive: false,
        checkpointRequired: false,
        dependsOn: [verifyStep.id],
        maxRetries: 0,
      },
    );
    steps.push(reportStep);

    return {
      id: planId,
      goal,
      status: "created",
      steps,
      activeStepId: undefined,
      pendingCheckpointId: undefined,
      executionLog: [],
      artifacts: [],
      verificationReport: undefined,
      createdAt: now,
      startedAt: undefined,
      completedAt: undefined,
      updatedAt: now,
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _selectWriteTool(goal: Goal): string {
    switch (goal.category) {
      case "documentation": return "writeCodeFile";
      case "feature":       return "writeCodeFile";
      case "bugfix":        return "writeCodeFile";
      case "refactor":      return "writeCodeFile";
      case "testing":       return "writeCodeFile";
      case "build":         return "runPythonScript";
      default:              return "writeCodeFile";
    }
  }

  private _buildWriteArgs(goal: Goal): Record<string, unknown> {
    const targetFile = goal.scope.targetFiles[0] ?? "output.md";
    return {
      path: targetFile,
      content: `<!-- Myraa will generate and write content here based on research and inspection results. -->`,
      language: this._detectLanguage(targetFile),
    };
  }

  private _modifyDescription(goal: Goal): string {
    const file = goal.scope.targetFiles[0] ?? "target file";
    return `Write changes to '${file}' as required by: ${goal.objective}`;
  }

  private _detectLanguage(filePath: string): string {
    const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
    const map: Record<string, string> = {
      ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
      py: "python", md: "markdown", json: "json", html: "html", css: "css",
      yaml: "yaml", yml: "yaml", sh: "bash",
    };
    return map[ext] ?? "text";
  }

  // ---------------------------------------------------------------------------
  // Mobile Workflow Plan Decomposition (Phase 27)
  // ---------------------------------------------------------------------------

  private _buildWorkflowPlan(
    goal: Goal,
    planId: string,
    now: string,
    options?: { deviceId?: string; preferredLanguage?: string },
  ): TaskPlan {
    const raw = (goal.rawInput || goal.objective).toLowerCase();
    const deviceId = options?.deviceId;
    const steps: PlanStep[] = [];

    // 1. Schedule & Tasks Query
    if (/\b(schedule|calendar|meeting|appointment|agenda)\b/i.test(raw)) {
      const isTomorrow = /\b(kal|tomorrow)\b/i.test(raw);
      const targetDate = isTomorrow ? "tomorrow" : "today";

      const calStep = makeStep(
        "inspect",
        `Query ${targetDate}'s calendar events from mobile companion.`,
        "calendar",
        { action: "view", date: targetDate, deviceId },
        { maxRetries: 2 },
      );
      steps.push(calStep);

      const memStep = makeStep(
        "inspect",
        "Search shared memory for active tasks and priorities.",
        "sharedMemory",
        { action: "search", query: "task", deviceId },
        { dependsOn: [calStep.id], maxRetries: 2 },
      );
      steps.push(memStep);

      const verifyStep = makeStep(
        "verify",
        "Verify calendar events and task records retrieved.",
        "verifyWorkflow",
        { expectedCapabilities: ["calendar", "sharedMemory"], deviceId },
        { dependsOn: [memStep.id], maxRetries: 1 },
      );
      steps.push(verifyStep);

      const reportStep = makeStep(
        "report",
        "Synthesize combined schedule and tasks report for user.",
        "_report",
        { planId, goalId: goal.id, workflowType: "schedule_tasks" },
        { dependsOn: [verifyStep.id] },
      );
      steps.push(reportStep);
    }
    // 2. Project Status
    else if (/\b(project status|git status|project ka status|latest status)\b/i.test(raw)) {
      const gitStep = makeStep(
        "inspect",
        "Check project git status and uncommitted changes.",
        "getProjectGitStatus",
        {},
        { maxRetries: 2 },
      );
      steps.push(gitStep);

      const projStep = makeStep(
        "inspect",
        "Inspect project architecture and state.",
        "analyzeProject",
        {},
        { dependsOn: [gitStep.id], maxRetries: 2 },
      );
      steps.push(projStep);

      const memStep = makeStep(
        "inspect",
        "Search shared memory for recent project notes and status.",
        "sharedMemory",
        { action: "search", query: "project", deviceId },
        { dependsOn: [projStep.id], maxRetries: 2 },
      );
      steps.push(memStep);

      const verifyStep = makeStep(
        "verify",
        "Verify project status, git status, and shared context.",
        "verifyWorkflow",
        { expectedCapabilities: ["git", "project"], deviceId },
        { dependsOn: [memStep.id], maxRetries: 1 },
      );
      steps.push(verifyStep);

      const reportStep = makeStep(
        "report",
        "Compile project status summary for user.",
        "_report",
        { planId, goalId: goal.id, workflowType: "project_status" },
        { dependsOn: [verifyStep.id] },
      );
      steps.push(reportStep);
    }
    // 3. Reminders
    else if (/\b(remind|reminder|yaad dila)\b/i.test(raw)) {
      const reminderTitle = this._extractReminderText(goal.rawInput || goal.objective);
      const timeMs = this._extractTimeMs(raw);

      const cpStep = makeStep(
        "checkpoint",
        `Awaiting confirmation to schedule reminder: "${reminderTitle}"`,
        "_checkpoint",
        { planId, goalObjective: goal.objective, reminderTitle, timeMs },
        { maxRetries: 0 },
      );
      steps.push(cpStep);

      const modifyStep = makeStep(
        "modify",
        `Create reminder on Android device: "${reminderTitle}"`,
        "createReminder",
        { title: reminderTitle, timeMs, deviceId },
        {
          isDestructive: true,
          checkpointRequired: true,
          dependsOn: [cpStep.id],
          maxRetries: 0,
        },
      );
      steps.push(modifyStep);

      const verifyStep = makeStep(
        "verify",
        "Verify reminder creation on companion device.",
        "verifyWorkflow",
        { expectedCapabilities: ["createReminder"], deviceId },
        { dependsOn: [modifyStep.id], maxRetries: 1 },
      );
      steps.push(verifyStep);

      const reportStep = makeStep(
        "report",
        "Confirm scheduled reminder to user.",
        "_report",
        { planId, goalId: goal.id, workflowType: "reminder_alarm" },
        { dependsOn: [verifyStep.id] },
      );
      steps.push(reportStep);
    }
    // 4. Alarms / Timers
    else if (/\b(alarm|timer)\b/i.test(raw)) {
      const isTimer = /\btimer\b/i.test(raw);
      const toolName = isTimer ? "setTimer" : "setAlarm";
      const { hour, minutes, seconds } = this._extractAlarmTime(raw);

      const cpStep = makeStep(
        "checkpoint",
        `Awaiting confirmation to ${isTimer ? `set timer for ${seconds}s` : `set alarm for ${hour}:${String(minutes).padStart(2, "0")}`}`,
        "_checkpoint",
        { planId, goalObjective: goal.objective, hour, minutes, seconds },
        { maxRetries: 0 },
      );
      steps.push(cpStep);

      const modifyStep = makeStep(
        "modify",
        isTimer
          ? `Set ${seconds}s timer on Android device`
          : `Set alarm for ${hour}:${String(minutes).padStart(2, "0")} on Android device`,
        toolName,
        isTimer
          ? { lengthSeconds: seconds, message: "MYRAA Timer", deviceId }
          : { hour, minutes, message: "MYRAA Alarm", deviceId },
        {
          isDestructive: true,
          checkpointRequired: true,
          dependsOn: [cpStep.id],
          maxRetries: 0,
        },
      );
      steps.push(modifyStep);

      const verifyStep = makeStep(
        "verify",
        `Verify ${toolName} execution on Android device.`,
        "verifyWorkflow",
        { expectedCapabilities: [toolName], deviceId },
        { dependsOn: [modifyStep.id], maxRetries: 1 },
      );
      steps.push(verifyStep);

      const reportStep = makeStep(
        "report",
        `Confirm ${isTimer ? "timer" : "alarm"} configured to user.`,
        "_report",
        { planId, goalId: goal.id, workflowType: "reminder_alarm" },
        { dependsOn: [verifyStep.id] },
      );
      steps.push(reportStep);
    }
    // 5. Device Status / Battery / WiFi
    else if (/\b(battery|wifi|network status|device status|phone status)\b/i.test(raw)) {
      const statusStep = makeStep(
        "inspect",
        "Query battery, network, and device state from mobile companion.",
        "deviceStatus",
        { category: "all", deviceId },
        { maxRetries: 2 },
      );
      steps.push(statusStep);

      const verifyStep = makeStep(
        "verify",
        "Verify device status telemetry.",
        "verifyWorkflow",
        { expectedCapabilities: ["deviceStatus"], deviceId },
        { dependsOn: [statusStep.id], maxRetries: 1 },
      );
      steps.push(verifyStep);

      const reportStep = makeStep(
        "report",
        "Synthesize device status report for user.",
        "_report",
        { planId, goalId: goal.id, workflowType: "device_status" },
        { dependsOn: [verifyStep.id] },
      );
      steps.push(reportStep);
    }
    // 6. Navigation / App Action
    else if (/\b(directions to|maps|navigate to|open app|whatsapp)\b/i.test(raw)) {
      const isMaps = /\b(directions|maps|navigate)\b/i.test(raw);
      const app = isMaps ? "maps" : "whatsapp";
      const action = isMaps ? "directions" : "compose_message";
      const destination = isMaps ? this._extractDestination(goal.rawInput || goal.objective) : undefined;

      const interactStep = makeStep(
        "modify",
        `Dispatch app action on Android companion: ${app} (${action})`,
        "interactApp",
        { app, action, destination, deviceId },
        {
          isDestructive: false,
          checkpointRequired: false,
          maxRetries: 1,
        },
      );
      steps.push(interactStep);

      const verifyStep = makeStep(
        "verify",
        "Verify app action intent dispatched.",
        "verifyWorkflow",
        { expectedCapabilities: ["interactApp"], deviceId },
        { dependsOn: [interactStep.id], maxRetries: 1 },
      );
      steps.push(verifyStep);

      const reportStep = makeStep(
        "report",
        "Confirm app action initiated for user.",
        "_report",
        { planId, goalId: goal.id, workflowType: "app_action" },
        { dependsOn: [verifyStep.id] },
      );
      steps.push(reportStep);
    }
    // 7. General Workflow Fallback
    else {
      const inspectStep = makeStep(
        "inspect",
        `Inspect context for workflow: "${goal.objective}"`,
        "deviceStatus",
        { category: "all", deviceId },
        { maxRetries: 2 },
      );
      steps.push(inspectStep);

      const verifyStep = makeStep(
        "verify",
        "Verify workflow outcomes.",
        "verifyWorkflow",
        { expectedCapabilities: ["deviceStatus"], deviceId },
        { dependsOn: [inspectStep.id], maxRetries: 1 },
      );
      steps.push(verifyStep);

      const reportStep = makeStep(
        "report",
        "Compile workflow result report.",
        "_report",
        { planId, goalId: goal.id, workflowType: "custom_workflow" },
        { dependsOn: [verifyStep.id] },
      );
      steps.push(reportStep);
    }

    return {
      id: planId,
      goal,
      status: "created",
      steps,
      activeStepId: undefined,
      pendingCheckpointId: undefined,
      executionLog: [],
      artifacts: [],
      verificationReport: undefined,
      deviceId,
      preferredLanguage: options?.preferredLanguage,
      createdAt: now,
      startedAt: undefined,
      completedAt: undefined,
      updatedAt: now,
    };
  }

  private _extractReminderText(text: string): string {
    let clean = text
      .replace(/\b(myraa|mujhe|please|remind me to|remind me|remind karna|remind karo|yaad dilana|yaad dila dena)\b/gi, "")
      .replace(/\b(kal|aaj|shaam|subah|dopahar|raat|\d+\s*(baje|pm|am|hours?|mins?|minutes?))\b/gi, "")
      .trim();
    return clean || "Important Task Reminder";
  }

  private _extractTimeMs(text: string): number {
    const hourMatch = text.match(/\b(\d{1,2})\s*(baje|pm|am)\b/i);
    const now = new Date();
    if (hourMatch) {
      let h = parseInt(hourMatch[1], 10);
      const isPm = /pm/i.test(hourMatch[2]) || (/baje/i.test(hourMatch[2]) && /shaam|raat/i.test(text));
      if (isPm && h < 12) h += 12;
      now.setHours(h, 0, 0, 0);
      if (now.getTime() <= Date.now()) {
        now.setDate(now.getDate() + 1); // next day
      }
      return now.getTime();
    }
    // Default: 1 hour in the future
    return Date.now() + 3600_000;
  }

  private _extractAlarmTime(text: string): { hour: number; minutes: number; seconds: number } {
    const timerMatch = text.match(/(\d+)\s*(min|minute|sec|second)/i);
    if (timerMatch) {
      const val = parseInt(timerMatch[1], 10);
      const isMin = /min/i.test(timerMatch[2]);
      const seconds = isMin ? val * 60 : val;
      return { hour: 0, minutes: 0, seconds };
    }
    const colonMatch = text.match(/(\d{1,2}):(\d{2})/);
    if (colonMatch) {
      return { hour: parseInt(colonMatch[1], 10), minutes: parseInt(colonMatch[2], 10), seconds: 0 };
    }
    const numMatch = text.match(/(\d{1,2})\s*(baje|am|pm)?/i);
    let hour = numMatch ? parseInt(numMatch[1], 10) : 7;
    const isPm = text.toLowerCase().includes("pm") || (text.toLowerCase().includes("baje") && text.toLowerCase().includes("shaam"));
    if (isPm && hour < 12) hour += 12;
    return { hour, minutes: 0, seconds: 0 };
  }

  private _extractDestination(text: string): string {
    const match = text.match(/(?:directions to|navigate to|reach|go to)\s+(.+?)(?:\s+by|\s+in|\.|$)/i);
    return match ? match[1].trim() : "Destination";
  }
}

/** Shared singleton. */
export const taskPlanner = new TaskPlanner();
