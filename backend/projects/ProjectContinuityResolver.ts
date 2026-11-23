/**
 * MYRAA — ProjectContinuityResolver (Phase 10.3 Project Continuity Engine)
 *
 * Deterministic project-context resolution service.
 *
 * Responsibilities:
 *   1. Resolve project identity (explicit name → active project → not_found)
 *   2. Retrieve project metadata from projectStore
 *   3. Retrieve task/plan data from planStore
 *   4. Retrieve decisions/milestones from projectDecisionStore
 *   5. Normalize into ProjectContinuityContext
 *   6. Expose historical query support with explicit limitation disclosure
 *
 * Security:
 *   - All user-supplied project names are scanned via contentSanitizer
 *   - Read operations NEVER mutate state
 *   - ai_proposed decisions are NOT auto-confirmed
 *   - Emergency Stop check: writes blocked when emergencyStopCoordinator.isActive()
 *   - Cross-project access prevented by strict projectId filtering
 *
 * Error policy:
 *   - resolveProjectContext() is best-effort — returns { error, reason } on failure
 *   - All errors are logged with [ProjectContinuity] prefix, never silently swallowed
 */

import { randomBytes } from "crypto";
import { projectStore, ProjectStore } from "./ProjectStore.ts";
import { planStore, PlanStore } from "../planner/PlanStore.ts";
import { projectDecisionStore, ProjectDecisionStore } from "./ProjectDecisionStore.ts";
import {
  contentSanitizer,
  UNTRUSTED_DOC_START,
  UNTRUSTED_DOC_END,
  UNTRUSTED_CONTENT_DIRECTIVE,
} from "../security/ContentSanitizer.ts";
import { emergencyStopCoordinator } from "../remote/EmergencyStopCoordinator.ts";
import { invalidateInstructionsCache } from "../ai/GeminiSessionFactory.ts";
import type {
  ProjectContext,
  ProjectDecision,
  ProjectResolutionResult,
  PendingTaskSummary,
  ProjectContinuityContext,
  HistoricalTaskSummary,
  HistoricalTasksResult,
} from "./ProjectTypes.ts";
import type { TaskPlan } from "../planner/PlannerTypes.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CALENDAR_DATE_ONLY_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Formats a Date into YYYY-MM-DD using local calendar components without shifting
 * local midnight through UTC ISO conversion (GAP-10.3-05).
 */
export function formatLocalCalendarDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function generateId(): string {
  return randomBytes(5).toString("hex");
}

const EMBEDDED_DELIMITER_REGEX = /<<<\s*\/?\s*UNTRUSTED[^>]*>>>|<<<\/[^>]*>>>/gi;

/**
 * Sanitizes untrusted project metadata (project name, goal, task title, decision/milestone
 * descriptions) before interpolation into system instructions (GAP-10.3-03).
 *
 * Defense-in-depth:
 *   1. Neutralizes embedded opening/closing untrusted delimiter tags so content cannot
 *      break out of <<<UNTRUSTED_DOCUMENT_DATA>>> boundaries.
 *   2. Collapses control newlines to prevent section/header spoofing inside cards.
 *   3. Defangs prompt-injection patterns via ContentSanitizer (and logs audit events).
 *   4. Preserves legitimate user project text untouched.
 */
export function sanitizeProjectContextField(
  raw: string | undefined | null,
  source: string,
  maxLen?: number,
): string {
  if (!raw || typeof raw !== "string") return "";
  const noDelimiters = raw
    .replace(EMBEDDED_DELIMITER_REGEX, "[DELIMITER_REDACTED]")
    .replace(/[\r\n]+/g, " ")
    .trim();
  const scan = contentSanitizer.scanForPromptInjection(noDelimiters, { source });
  let safe = scan.sanitizedText.replace(EMBEDDED_DELIMITER_REGEX, "[DELIMITER_REDACTED]").trim();
  if (maxLen !== undefined && safe.length > maxLen) {
    safe = safe.substring(0, maxLen);
  }
  return safe;
}

function sanitizeNameInput(nameHint: string): { safe: string; blocked: boolean } {
  const scan = contentSanitizer.scanForPromptInjection(String(nameHint), {
    source: "ProjectContinuityResolver_nameHint",
  });
  if (scan.hasInjectionAttempt) {
    console.warn(
      `[ProjectContinuity] Injection attempt detected in project name input. Patterns: ${scan.matchedPatterns.join(", ")}`,
    );
    return { safe: "", blocked: true };
  }
  return { safe: scan.sanitizedText.trim().substring(0, 200), blocked: false };
}

// ---------------------------------------------------------------------------
// ProjectContinuityResolver
// ---------------------------------------------------------------------------

export class ProjectContinuityResolver {
  private decisionStore: ProjectDecisionStore;
  private projectStore: ProjectStore;
  private planStore: PlanStore;

  constructor(
    customDecisionStore?: ProjectDecisionStore,
    customProjectStore?: ProjectStore,
    customPlanStore?: PlanStore,
  ) {
    this.decisionStore = customDecisionStore ?? projectDecisionStore;
    this.projectStore = customProjectStore ?? projectStore;
    this.planStore = customPlanStore ?? planStore;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Project Resolution
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Deterministically resolves which project to operate on.
   *
   * Precedence:
   *   1. nameHint exact match by name (case-insensitive)
   *   2. nameHint partial match — if multiple matches, return ambiguous
   *   3. Active project from projectStore
   *   4. If none → not_found
   *
   * Security: sanitizes nameHint via contentSanitizer before use.
   */
  async resolveProject(nameHint?: string): Promise<ProjectResolutionResult> {
    try {
      const storeData = await this.projectStore.load();
      const allProjects = storeData.projects;

      if (nameHint && nameHint.trim()) {
        const { safe, blocked } = sanitizeNameInput(nameHint);
        if (blocked) {
          return {
            status: "unavailable",
            reason: "Project name contains invalid content and was blocked by the security scanner.",
          };
        }
        if (!safe) {
          return { status: "not_found", reason: "Project name was empty after sanitization." };
        }

        // 1. Exact match (case-insensitive)
        const needle = safe.toLowerCase();
        const exactMatch = allProjects.find(
          (p) =>
            p.name.toLowerCase() === needle ||
            p.id.toLowerCase() === needle,
        );
        if (exactMatch) {
          return { status: "resolved", project: exactMatch };
        }

        // 2. Partial match
        const partialMatches = allProjects.filter(
          (p) =>
            p.name.toLowerCase().includes(needle) ||
            p.id.toLowerCase().includes(needle),
        );

        if (partialMatches.length === 1) {
          return { status: "resolved", project: partialMatches[0] };
        }
        if (partialMatches.length > 1) {
          return {
            status: "ambiguous",
            candidates: partialMatches.map((p) => ({ id: p.id, name: p.name })),
            reason: `Multiple projects match '${safe}'. Please specify which project by exact name.`,
          };
        }

        return {
          status: "not_found",
          reason: `No project found matching '${safe}'.`,
        };
      }

      // 3. Active project fallback
      const active = await this.projectStore.getActiveProject();
      if (active) {
        return { status: "resolved", project: active };
      }

      return {
        status: "not_found",
        reason: "No active project set and no project name provided.",
      };
    } catch (err: any) {
      console.error("[ProjectContinuity] resolveProject error:", err);
      return {
        status: "unavailable",
        reason: `Project store unavailable: ${err.message || "unknown error"}`,
      };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Full Context Assembly
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Assembles a complete ProjectContinuityContext for the resolved project.
   * This method is stateless — it reads fresh from all stores on every call.
   * Returns { error, reason } on failure rather than throwing.
   */
  async resolveProjectContext(
    nameHint?: string,
  ): Promise<ProjectContinuityContext | { error: string; reason: string }> {
    try {
      const resolution = await this.resolveProject(nameHint);

      if (resolution.status !== "resolved") {
        const reason =
          resolution.status === "ambiguous"
            ? resolution.reason
            : resolution.status === "not_found"
              ? resolution.reason
              : resolution.reason;
        return { error: resolution.status, reason };
      }

      const project = resolution.project;

      // ── Pending tasks from project context ────────────────────────────────
      const pendingTasks: PendingTaskSummary[] = (project.tasks || [])
        .filter((t) => t.status !== "done")
        .map((t) => ({
          taskId: t.id,
          title: t.title,
          status: t.status,
        }));

      // ── Plan data from planStore (strictly projectId-scoped — GAP-10.3-01) ──
      // Never infer project ownership from global active state or arbitrary plan ordering.
      // Plans lacking an explicit matching projectId are excluded from project context.
      let planSummary: ProjectContinuityContext["planSummary"] | undefined;
      let goal: ProjectContinuityContext["goal"] | undefined;
      let currentStatus: ProjectContinuityContext["currentStatus"] | undefined;

      try {
        const rawPlans =
          typeof this.planStore.listPlansByProject === "function"
            ? await this.planStore.listPlansByProject(project.id)
            : await this.planStore.listPlans();
        // Defense-in-depth: re-verify strict projectId equality even if custom planStore was injected
        const projectPlans = rawPlans.filter(
          (p) =>
            typeof p.projectId === "string" &&
            p.projectId.trim() !== "" &&
            p.projectId === project.id,
        );

        if (projectPlans.length > 0) {
          const activePlans = projectPlans.filter(
            (p) => p.status === "running" || p.status === "created" || p.status === "waiting_for_approval",
          );
          const recentGoals = projectPlans
            .slice(0, 5)
            .map((p) => p.goal?.objective)
            .filter((g): g is string => !!g);

          planSummary = {
            activePlans: activePlans.length,
            recentGoals,
          };

          // Extract goal from most recent active or last completed plan belonging to THIS project
          const primaryPlan: TaskPlan | undefined =
            activePlans[0] ?? projectPlans.find((p) => p.status === "completed") ?? projectPlans[0];

          if (primaryPlan?.goal) {
            goal = {
              objective: primaryPlan.goal.objective,
              expectedOutcome: primaryPlan.goal.expectedOutcomes?.[0]?.description,
              scope: primaryPlan.goal.scope?.targetFiles?.join(", ") || undefined,
            };

            const lastStep = primaryPlan.steps?.filter((s) => s.status === "completed").slice(-1)[0];
            if (lastStep || primaryPlan.activeStepId) {
              currentStatus = {
                phase: lastStep?.phase,
                progress:
                  primaryPlan.steps?.length > 0
                    ? `${primaryPlan.steps.filter((s) => s.status === "completed").length}/${primaryPlan.steps.length} steps`
                    : undefined,
                lastUpdated: primaryPlan.updatedAt,
                source: "plan",
              };
            }
          }
        }
      } catch (planErr: any) {
        console.error("[ProjectContinuity] Could not load plans:", planErr);
        // Not fatal — continue without plan data
      }

      // Add last session to current status if no plan status
      if (!currentStatus && project.lastSession) {
        currentStatus = {
          lastUpdated: project.lastSession.timestamp,
          source: "last_session",
          progress: project.lastSession.nextSteps,
        };
      }

      // ── Decisions & milestones from projectDecisionStore ──────────────────
      let recentDecisions: ProjectDecision[] = [];
      let completedMilestones: ProjectDecision[] = [];

      try {
        const allDecisions = await this.decisionStore.listByProject(project.id);
        recentDecisions = allDecisions
          .filter((d) => d.type === "decision")
          .slice(0, 10);
        completedMilestones = allDecisions
          .filter((d) => d.type === "milestone" && d.confirmed)
          .slice(0, 10);
      } catch (decErr: any) {
        console.error("[ProjectContinuity] Could not load decisions:", decErr);
        // Not fatal — continue without decision data
      }

      // ── Historical limitation disclosure ──────────────────────────────────
      let historicalLimitation: string | undefined;
      if (recentDecisions.length === 0 && completedMilestones.length === 0 && pendingTasks.length === 0) {
        historicalLimitation =
          "No historical decisions, milestones, or pending tasks found for this project. " +
          "Historical data is limited to what has been explicitly recorded via the project tracking tools.";
      }

      const ctx: ProjectContinuityContext = {
        resolvedAt: new Date().toISOString(),
        project: {
          id: project.id,
          name: project.name,
          description: project.summary?.substring(0, 300),
          status: "active",
        },
        goal,
        currentStatus,
        pendingTasks,
        recentDecisions,
        completedMilestones,
        historicalLimitation,
        planSummary,
      };

      return ctx;
    } catch (err: any) {
      console.error("[ProjectContinuity] resolveProjectContext error:", err);
      return {
        error: "resolution_error",
        reason: err.message || "Unknown error during context resolution.",
      };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Historical Task Query (Section 7)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Retrieves pending and completed tasks for a specific historical date (e.g. "yesterday" / "kal").
   *
   * SEC-P3-R1.2-01 REMEDIATION:
   * Tasks in projects.json only maintain mutable `createdAt` and `updatedAt` timestamps.
   * Without an immutable transition log, it is impossible to reconstruct whether a task was
   * pending, in_progress, or completed on a historical date (Scenarios A through E).
   *
   * Behavioral rules:
   *   1. Filter tasks where createdAt <= endOfDay (only tasks that existed on or before the target date).
   *   2. Exclude tasks created AFTER the target date (createdMs > endMs).
   *   3. Do NOT guess past completion or "in_progress" status using mutable updatedAt.
   *   4. Return tasksCreatedOnOrBeforeDate with `historicalStatus: "unknown"`, preserving their
   *      currentStatus and creation timestamp.
   *   5. Disclose historical limitation explicitly:
   *      - When tasks existed:
   *        "MYRAA does not have sufficient historical task-status records to establish which tasks were pending on <date>. I can identify currently recorded tasks, but I cannot reliably reconstruct their status on that date."
   *      - When no tasks existed:
   *        "No historical tasks recorded on or before <date> for project '<project.name>'. MYRAA does not invent pending tasks when historical records are unavailable."
   *   6. Populate pendingOnDate with tasks created on/before date whose current status is not "done",
   *      and completedOnDate with tasks created on/before date whose current status is "done", for
   *      backward compatibility while keeping historicalStatus="unknown".
   */
  async getHistoricalTasks(
    nameHint?: string,
    targetDateInput?: string | Date,
  ): Promise<HistoricalTasksResult | { error: string; reason: string }> {
    const resolution = await this.resolveProject(nameHint);
    if (resolution.status !== "resolved") {
      return { error: resolution.status, reason: resolution.reason };
    }

    const project = resolution.project;

    // Resolve target date range (default to yesterday in local time)
    let targetDate: Date;
    if (targetDateInput instanceof Date) {
      if (isNaN(targetDateInput.getTime())) {
        return { error: "invalid_date", reason: "Unable to parse invalid Date instance." };
      }
      targetDate = targetDateInput;
    } else if (typeof targetDateInput === "string" && targetDateInput.trim()) {
      const trimmed = targetDateInput.trim();
      const lower = trimmed.toLowerCase();
      if (lower === "yesterday" || lower === "kal") {
        targetDate = new Date();
        targetDate.setDate(targetDate.getDate() - 1);
      } else {
        const calMatch = CALENDAR_DATE_ONLY_REGEX.exec(trimmed);
        if (calMatch) {
          const year = Number(calMatch[1]);
          const month = Number(calMatch[2]);
          const day = Number(calMatch[3]);
          const parsedLocal = new Date(year, month - 1, day);
          if (
            isNaN(parsedLocal.getTime()) ||
            parsedLocal.getFullYear() !== year ||
            parsedLocal.getMonth() !== month - 1 ||
            parsedLocal.getDate() !== day
          ) {
            return { error: "invalid_date", reason: `Unable to parse target date '${targetDateInput}'.` };
          }
          targetDate = parsedLocal;
        } else {
          targetDate = new Date(trimmed);
          if (isNaN(targetDate.getTime())) {
            return { error: "invalid_date", reason: `Unable to parse target date '${targetDateInput}'.` };
          }
        }
      }
    } else {
      targetDate = new Date();
      targetDate.setDate(targetDate.getDate() - 1);
    }

    const startOfDay = new Date(targetDate);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(targetDate);
    endOfDay.setHours(23, 59, 59, 999);

    const endMs = endOfDay.getTime();
    const dateStr = formatLocalCalendarDate(startOfDay);

    const tasks = project.tasks || [];
    const tasksCreatedOnOrBeforeDate: HistoricalTaskSummary[] = [];
    const pendingOnDate: PendingTaskSummary[] = [];
    const completedOnDate: PendingTaskSummary[] = [];

    for (const t of tasks) {
      const createdMs = t.createdAt ? new Date(t.createdAt).getTime() : 0;

      // Rule: If created after target date, it did NOT exist yet on target date
      if (createdMs > endMs) {
        continue;
      }

      tasksCreatedOnOrBeforeDate.push({
        taskId: t.id,
        title: t.title,
        currentStatus: t.status,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        historicalStatus: "unknown",
      });

      if (t.status === "done") {
        completedOnDate.push({
          taskId: t.id,
          title: t.title,
          status: "done",
        });
      } else {
        pendingOnDate.push({
          taskId: t.id,
          title: t.title,
          status: t.status,
        });
      }
    }

    const hasHistoricalEvidence = tasksCreatedOnOrBeforeDate.length > 0;
    const historicalLimitation = hasHistoricalEvidence
      ? `MYRAA does not have sufficient historical task-status records to establish which tasks were pending on ${dateStr}. I can identify currently recorded tasks, but I cannot reliably reconstruct their status on that date.`
      : `No historical tasks recorded on or before ${dateStr} for project '${project.name}'. MYRAA does not invent pending tasks when historical records are unavailable.`;

    return {
      project: { id: project.id, name: project.name },
      targetDate: dateStr,
      tasksCreatedOnOrBeforeDate,
      historicalStatus: "unknown",
      historicalLimitation,
      pendingOnDate,
      completedOnDate,
      hasHistoricalEvidence,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Decision Recording (Write Governance)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Records an ai_proposed decision for a project.
   * Decisions are NEVER auto-confirmed — they require explicit user confirmation
   * via confirmDecision().
   *
   * Blocked if emergencyStopCoordinator.isActive().
   */
  async recordDecision(
    projectId: string,
    description: string,
    type: "decision" | "milestone" = "decision",
  ): Promise<ProjectDecision> {
    if (emergencyStopCoordinator.isActive()) {
      throw new Error("[ProjectContinuity] Write blocked: Emergency Stop is active.");
    }

    const now = new Date().toISOString();
    const decision: ProjectDecision = {
      id: generateId(),
      projectId,
      description: description.substring(0, 1000), // bounded
      timestamp: now,
      type,
      source: "ai_proposed",
      confirmed: false, // NEVER auto-confirmed
    };

    await this.decisionStore.saveDecision(decision);
    console.log(
      `[ProjectContinuity] Recorded ai_proposed ${type} (id=${decision.id}) for project ${projectId}.`,
    );
    return decision;
  }

  /**
   * Marks a decision as confirmed under project ownership validation.
   * This should ONLY be called after explicit user confirmation.
   * Returns undefined if the decision does not exist.
   *
   * Blocked if emergencyStopCoordinator.isActive().
   */
  async confirmDecision(
    decisionId: string,
    expectedProjectId?: string,
  ): Promise<ProjectDecision | undefined> {
    if (emergencyStopCoordinator.isActive()) {
      throw new Error("[ProjectContinuity] Write blocked: Emergency Stop is active.");
    }

    let targetProjectId = expectedProjectId;
    if (!targetProjectId) {
      const existing = await this.decisionStore.getDecision(decisionId);
      if (!existing) {
        console.warn(`[ProjectContinuity] confirmDecision: decision not found (id=${decisionId}).`);
        return undefined;
      }
      targetProjectId = existing.projectId;
    }

    const updated = await this.decisionStore.confirmDecision(decisionId, targetProjectId);

    if (updated) {
      console.log(
        `[ProjectContinuity] Decision confirmed (id=${decisionId}) for project ${updated.projectId}.`,
      );
      invalidateInstructionsCache();
    } else {
      console.warn(`[ProjectContinuity] confirmDecision: decision not found (id=${decisionId}).`);
    }

    return updated;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Project Switching
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Switches the active project and returns the continuity context for the new project.
   * Context isolation: resolveProjectContext() is stateless — no cross-project leak.
   */
  async switchProject(nameOrId: string): Promise<ProjectResolutionResult> {
    const { safe, blocked } = sanitizeNameInput(nameOrId);
    if (blocked) {
      return {
        status: "unavailable",
        reason: "Project name contains invalid content and was blocked by the security scanner.",
      };
    }

    const resolution = await this.resolveProject(safe);
    if (resolution.status !== "resolved") {
      return resolution;
    }

    try {
      await this.projectStore.setActiveProject(resolution.project.id);
      invalidateInstructionsCache();
      console.log(
        `[ProjectContinuity] Switched active project to '${resolution.project.name}' (id=${resolution.project.id}).`,
      );
    } catch (err: any) {
      console.error("[ProjectContinuity] switchProject failed to setActiveProject:", err);
      return {
        status: "unavailable",
        reason: `Failed to switch project: ${err.message || "unknown error"}`,
      };
    }

    return resolution;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Continuity Card Builder (for ContextManager injection)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Builds a bounded text card from a ProjectContinuityContext for system prompt injection.
   * Delimited within untrusted document boundaries to prevent prompt injection.
   * Strictly respects charBudget.
   */
  buildContinuityCard(ctx: ProjectContinuityContext, charBudget = 800): string {
    const safeProjectId = sanitizeProjectContextField(ctx.project.id, "continuityCard_projectId", 100);
    const safeProjectName = sanitizeProjectContextField(ctx.project.name, "continuityCard_projectName", 120);
    const safeResolvedAt = sanitizeProjectContextField(ctx.resolvedAt, "continuityCard_resolvedAt", 40);

    const fullHeader = `\n\n=== PROJECT CONTINUITY (Phase 10.3) ===\n${UNTRUSTED_DOC_START}\n[PROJECT_CONTEXT: ${safeProjectId}]\n${UNTRUSTED_CONTENT_DIRECTIVE}\n`;
    const fullFooter = `\n${UNTRUSTED_DOC_END}\n==========================================\n`;

    let content = `Project: ${safeProjectName} | Resolved: ${safeResolvedAt}\n`;

    if (ctx.goal) {
      const safeObj = sanitizeProjectContextField(ctx.goal.objective, "continuityCard_goalObjective", 200);
      content += `Current Goal: ${safeObj}\n`;
      if (ctx.goal.expectedOutcome) {
        const safeOutcome = sanitizeProjectContextField(
          ctx.goal.expectedOutcome,
          "continuityCard_goalOutcome",
          160,
        );
        content += `Expected Outcome: ${safeOutcome}\n`;
      }
    }

    if (ctx.currentStatus) {
      if (ctx.currentStatus.progress) {
        const safeProgress = sanitizeProjectContextField(
          ctx.currentStatus.progress,
          "continuityCard_statusProgress",
          120,
        );
        content += `Progress: ${safeProgress}`;
        if (ctx.currentStatus.phase) {
          const safePhase = sanitizeProjectContextField(
            ctx.currentStatus.phase,
            "continuityCard_statusPhase",
            40,
          );
          content += ` [${safePhase}]`;
        }
        content += `\n`;
      }
    }

    if (ctx.pendingTasks.length > 0) {
      content += `Pending Tasks (${ctx.pendingTasks.length}):\n`;
      for (const t of ctx.pendingTasks.slice(0, 3)) {
        const safeTitle = sanitizeProjectContextField(t.title, "continuityCard_taskTitle", 120);
        content += `  - [${String(t.status).toUpperCase()}] ${safeTitle}\n`;
      }
    }

    if (ctx.recentDecisions.length > 0) {
      content += `Recent Decisions:\n`;
      for (const d of ctx.recentDecisions.slice(0, 2)) {
        const confirmed = d.confirmed ? "✓" : "proposed";
        const safeDesc = sanitizeProjectContextField(d.description, "continuityCard_decision", 80);
        content += `  - [${confirmed}] ${safeDesc}\n`;
      }
    }

    if (ctx.completedMilestones.length > 0) {
      content += `Completed Milestones:\n`;
      for (const m of ctx.completedMilestones.slice(0, 2)) {
        const safeDesc = sanitizeProjectContextField(m.description, "continuityCard_milestone", 80);
        content += `  - ✓ ${safeDesc}\n`;
      }
    }

    if (ctx.historicalLimitation) {
      const safeNote = sanitizeProjectContextField(
        ctx.historicalLimitation,
        "continuityCard_historicalLimitation",
        120,
      );
      content += `Note: ${safeNote}\n`;
    }

    const fullCard = `${fullHeader}${content}${fullFooter}`;
    if (fullCard.length <= charBudget) {
      return fullCard;
    }

    // Check if budget is smaller than header + footer + truncation suffix (e.g. 200 chars)
    if (charBudget < fullHeader.length + fullFooter.length + 10) {
      const compactHeader = `\n\n=== PROJECT CONTINUITY ===\n${UNTRUSTED_DOC_START}\n`;
      const compactFooter = `\n${UNTRUSTED_DOC_END}\n`;
      const avail = charBudget - compactHeader.length - compactFooter.length;
      const suffix = "\n[...]";
      const cutLen = Math.max(0, avail - suffix.length);
      const compactContent = content.substring(0, cutLen) + suffix;
      return `${compactHeader}${compactContent}${compactFooter}`;
    }

    const avail = charBudget - fullHeader.length - fullFooter.length;
    const suffix = "\n[...]";
    const cutLen = Math.max(0, avail - suffix.length);
    const truncatedContent = content.substring(0, cutLen) + suffix;
    return `${fullHeader}${truncatedContent}${fullFooter}`;
  }
}

/** Module-level singleton. */
export const projectContinuityResolver = new ProjectContinuityResolver();
