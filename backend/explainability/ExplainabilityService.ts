/**
 * MYRAA — ExplainabilityService (Stage 10.7)
 *
 * Core coordinator for read-only explainability:
 *   - Grounds all explanations strictly in verified audit, task, and reminder evidence
 *   - Enforces user identity, RBAC, and canonical project isolation
 *   - Distinguishes Decision, Reason, Evidence, Interpretation, and Unknown
 *   - Never claims execution success without verified evidence
 *   - Never mutates state or grants execution authority
 */

import crypto from "crypto";
import type { SecurityContext } from "../security/SecurityTypes.ts";
import type {
  Explanation,
  SecurityExplanationQuery,
  TaskExplanationQuery,
  ReminderExplanationQuery,
  CorrelationExplanationQuery,
  EvidenceRecord,
  CompletenessStatus,
  TaskReasonCategory,
} from "./ExplainabilityTypes.ts";
import { MAX_EXPLANATIONS_RETURNED } from "./ExplainabilityTypes.ts";
import { explainabilityFormatter, ExplainabilityFormatter } from "./ExplainabilityFormatter.ts";
import { explainabilityEvidenceReader, ExplainabilityEvidenceReader } from "./ExplainabilityEvidenceReader.ts";

export class ExplainabilityService {
  private _reader: ExplainabilityEvidenceReader;
  private _formatter: ExplainabilityFormatter;

  constructor(
    reader: ExplainabilityEvidenceReader = explainabilityEvidenceReader,
    formatter: ExplainabilityFormatter = explainabilityFormatter,
  ) {
    this._reader = reader;
    this._formatter = formatter;
  }

  // ---------------------------------------------------------------------------
  // 1. Security Decision Explanations
  // ---------------------------------------------------------------------------

  /**
   * Explains why an action was allowed, blocked, required confirmation, or failed.
   * Grounded strictly in audit logs and policy evaluation records.
   */
  async explainSecurityDecision(
    context: SecurityContext,
    query: SecurityExplanationQuery,
  ): Promise<Explanation> {
    this._assertAuthenticated(context);

    const explanationId = crypto.randomUUID();
    const now = new Date().toISOString();
    const correlationId = query.auditId || query.eventId || query.correlationId || "security_decision";

    // 1. Lookup specific audit record if ID provided
    if (query.auditId || query.eventId) {
      const targetId = (query.auditId || query.eventId)!;
      const event = await this._reader.getAuditEventById(targetId);

      if (!event) {
        return {
          explanationId,
          correlationId: targetId,
          timestamp: now,
          category: "security_decision",
          decision: "UNKNOWN",
          reasonCategory: "UNKNOWN_DECISION",
          humanReadableReason: `No audit record found for event ID '${targetId}'.`,
          interpretation: "The requested security event is not available in the active audit ledger or log file.",
          sourceComponent: "SecurityAuditLogger",
          completenessStatus: "unavailable",
          evidence: [],
          relatedReferences: { auditId: targetId },
          limitations: ["Audit record not found or has been aged out of the active log window."],
          unknowns: ["Actual security decision and recorded policy outcome are unknown."],
        };
      }

      // Strict user ownership check (Admin role can inspect workspace events)
      if (context.role !== "admin" && event.actor?.identityId && event.actor.identityId !== context.identityId) {
        throw new Error(
          `CROSS_USER_ACCESS_DENIED: User '${context.identityId}' cannot access security audit records belonging to user '${event.actor.identityId}'.`,
        );
      }

      // Classify reason and format
      const rawReason = event.reason || "";
      const reasonCategory = this._formatter.classifySecurityReason({
        decision: event.decision,
        eventType: event.eventType,
        reason: rawReason,
      });

      const { interpretation, safeNextSteps } = this._formatter.generateSecurityInterpretation(
        reasonCategory,
        {
          toolName: event.tool || event.target?.toolName,
          role: event.actor?.role,
          reason: rawReason,
        },
      );

      const rawEvidence = this._reader.auditEventToEvidence(event);
      const { result: sanitizedEvidence } = this._formatter.sanitizeForExplanation(rawEvidence);

      return {
        explanationId,
        correlationId: event.id || targetId,
        timestamp: now,
        category: "security_decision",
        decision: event.decision || "UNKNOWN",
        reasonCategory,
        humanReadableReason: this._formatter.sanitizeText(rawReason || "No explicit reason string recorded."),
        interpretation,
        sourceComponent: "SecurityPolicyEngine",
        completenessStatus: "complete",
        evidence: [sanitizedEvidence],
        relatedReferences: {
          auditId: event.id,
          toolName: event.tool || event.target?.toolName,
          sessionId: event.actor?.sessionId,
        },
        safeNextSteps,
        limitations: [],
      };
    }

    // 2. Query user's recent security decisions
    const userEvents = await this._reader.getAuditEventsForUser(context.identityId, {
      toolName: query.toolName,
      limit: 10,
    });

    if (userEvents.length === 0) {
      return {
        explanationId,
        correlationId,
        timestamp: now,
        category: "security_decision",
        decision: "UNKNOWN",
        reasonCategory: "UNKNOWN_DECISION",
        humanReadableReason: `No recorded security decisions found for user '${context.identityId}'${query.toolName ? ` and tool '${query.toolName}'` : ""}.`,
        interpretation: "No audit events matching the query criteria were recorded.",
        sourceComponent: "SecurityPolicyEngine",
        completenessStatus: "unavailable",
        evidence: [],
        relatedReferences: { toolName: query.toolName },
        limitations: ["No matching audit events available in the recent ledger."],
      };
    }

    const latest = userEvents[userEvents.length - 1];
    const reasonCategory = this._formatter.classifySecurityReason({
      decision: latest.decision,
      eventType: latest.eventType,
      reason: latest.reason,
    });

    const { interpretation, safeNextSteps } = this._formatter.generateSecurityInterpretation(
      reasonCategory,
      {
        toolName: latest.tool || latest.target?.toolName,
        role: latest.actor?.role,
        reason: latest.reason,
      },
    );

    const evidenceList: EvidenceRecord[] = userEvents.map((e) => {
      const ev = this._reader.auditEventToEvidence(e);
      return this._formatter.sanitizeForExplanation(ev).result;
    });

    return {
      explanationId,
      correlationId: latest.id || correlationId,
      timestamp: now,
      category: "security_decision",
      decision: latest.decision || "UNKNOWN",
      reasonCategory,
      humanReadableReason: this._formatter.sanitizeText(latest.reason || "Outcome recorded in audit ledger."),
      interpretation,
      sourceComponent: "SecurityPolicyEngine",
      completenessStatus: "complete",
      evidence: evidenceList,
      relatedReferences: {
        auditId: latest.id,
        toolName: latest.tool || latest.target?.toolName,
        sessionId: latest.actor?.sessionId,
      },
      safeNextSteps,
      limitations: [],
    };
  }

  // ---------------------------------------------------------------------------
  // 2. Task Orchestration Explanations
  // ---------------------------------------------------------------------------

  /**
   * Explains what happened during task planning, step execution, cancellation,
   * checkpoints, or recovery. Grounded strictly in plan and checkpoint records.
   */
  async explainTaskOrchestration(
    context: SecurityContext,
    query: TaskExplanationQuery,
  ): Promise<Explanation> {
    this._assertAuthenticated(context);

    const explanationId = crypto.randomUUID();
    const now = new Date().toISOString();
    const correlationId = query.planId;

    // Retrieve plan with canonical project isolation
    const plan = await this._reader.getTaskPlan(query.planId, query.projectId);

    if (!plan) {
      return {
        explanationId,
        correlationId,
        timestamp: now,
        category: "task_orchestration",
        decision: "UNKNOWN",
        reasonCategory: "PLAN_REJECTED",
        humanReadableReason: `Task plan '${query.planId}' was not found${query.projectId ? ` in project '${query.projectId}'` : ""}.`,
        interpretation: "The requested task plan does not exist or access was denied by project isolation boundaries.",
        sourceComponent: "TaskOrchestrator",
        completenessStatus: "unavailable",
        evidence: [],
        relatedReferences: { planId: query.planId, projectId: query.projectId },
        limitations: ["Plan not found in store or excluded by cross-project isolation."],
        unknowns: ["Plan structure and execution outcomes are unknown."],
      };
    }

    // Evaluate step-specific explanation if stepId provided
    if (query.stepId) {
      const step = plan.steps.find((s) => s.id === query.stepId);
      if (!step) {
        return {
          explanationId,
          correlationId,
          timestamp: now,
          category: "task_orchestration",
          decision: "UNKNOWN",
          reasonCategory: "STEP_FAILED",
          humanReadableReason: `Step '${query.stepId}' does not exist in plan '${plan.id}'.`,
          interpretation: "The requested step ID is not part of this task plan's step DAG.",
          sourceComponent: "TaskOrchestrator",
          completenessStatus: "unavailable",
          evidence: [],
          relatedReferences: { planId: plan.id, stepId: query.stepId },
          limitations: ["Step ID not found in plan steps."],
        };
      }

      let stepReasonCategory: TaskReasonCategory = "STEP_PENDING";
      const stepLimitations: string[] = [];
      if (step.status === "completed") stepReasonCategory = "STEP_COMPLETED";
      else if (step.status === "failed") stepReasonCategory = "STEP_FAILED";
      else if (step.status === "in_progress") stepReasonCategory = "STEP_RUNNING";
      else if (step.status === "waiting_for_approval") stepReasonCategory = "AWAITING_APPROVAL";
      else if (step.status === "acknowledged_unverified") {
        stepReasonCategory = "UNCERTAIN_SIDE_EFFECT";
        stepLimitations.push(
          "Step was acknowledged by operator to unblock plan execution, but external environmental side-effects were not independently proven.",
        );
      } else if (step.status === "outcome_unknown") {
        stepReasonCategory = "UNCERTAIN_SIDE_EFFECT";
        stepLimitations.push(
          "Step was interrupted in-flight; outcome is uncertain and has not been verified.",
        );
      }

      const { interpretation, safeNextSteps } = this._formatter.generateTaskInterpretation(
        stepReasonCategory,
        { planId: plan.id, stepId: step.id },
      );

      const evidence: EvidenceRecord = {
        evidenceId: `${plan.id}_${step.id}`,
        source: "plan_store",
        eventType: step.status,
        timestamp: plan.updatedAt || now,
        verified: true,
        fields: {
          stepId: step.id,
          description: this._formatter.sanitizeText(step.description),
          phase: step.phase,
          status: step.status,
          toolName: step.toolName,
          dependsOn: step.dependsOn,
          isDestructive: step.isDestructive,
          checkpointRequired: step.checkpointRequired,
        },
      };

      return {
        explanationId,
        correlationId: plan.id,
        timestamp: now,
        category: "task_orchestration",
        decision: step.status.toUpperCase(),
        reasonCategory: stepReasonCategory,
        humanReadableReason: `Step '${step.id}' is in status '${step.status}' (${step.phase} phase).`,
        interpretation,
        sourceComponent: "TaskOrchestrator",
        completenessStatus: "complete",
        evidence: [this._formatter.sanitizeForExplanation(evidence).result],
        relatedReferences: {
          planId: plan.id,
          stepId: step.id,
          projectId: plan.projectId,
        },
        safeNextSteps,
        limitations: stepLimitations,
      };
    }

    // Whole-plan explanation
    let planReasonCategory: any = "PLAN_CREATED";
    let humanReason = `Plan is currently in status '${plan.status}'.`;
    const limitations: string[] = [];

    if (plan.status === "cancelled") {
      planReasonCategory = "PLAN_CANCELLED";
      humanReason = plan.cancellationReason || "Plan was cancelled upon request.";
    } else if (plan.status === "waiting_for_approval") {
      planReasonCategory = "AWAITING_APPROVAL";
      humanReason = "Plan paused at safe boundary awaiting user approval.";
    } else if (plan.uncertainStepIds && plan.uncertainStepIds.length > 0) {
      planReasonCategory = "UNCERTAIN_SIDE_EFFECT";
      humanReason = `Plan has uncertain modifying steps requiring manual reconciliation: ${plan.uncertainStepIds.join(", ")}.`;
      limitations.push(
        "Important: Stage 10.5 invariant requires that forceReconciliation alone does NOT prove that actions succeeded; human inspection is mandatory.",
      );
    }

    const acknowledgedSteps = plan.steps.filter((s) => s.status === "acknowledged_unverified");
    if (acknowledgedSteps.length > 0) {
      limitations.push(
        `Operator acknowledged uncertainty for step(s) [${acknowledgedSteps
          .map((s) => s.id)
          .join(", ")}]; external environmental side-effects were not independently proven.`,
      );
    }

    const { interpretation, safeNextSteps } = this._formatter.generateTaskInterpretation(
      planReasonCategory,
      {
        planId: plan.id,
        uncertainStepIds: plan.uncertainStepIds,
      },
    );

    // Build evidence from checkpoints
    const evidenceList: EvidenceRecord[] = [];
    if (plan.checkpoints && plan.checkpoints.length > 0) {
      for (const cp of plan.checkpoints.slice(-MAX_EXPLANATIONS_RETURNED)) {
        const ev = this._reader.checkpointToEvidence(cp);
        evidenceList.push(this._formatter.sanitizeForExplanation(ev).result);
      }
    }

    return {
      explanationId,
      correlationId: plan.id,
      timestamp: now,
      category: "task_orchestration",
      decision: plan.status.toUpperCase(),
      reasonCategory: planReasonCategory,
      humanReadableReason: this._formatter.sanitizeText(humanReason),
      interpretation,
      sourceComponent: "TaskOrchestrator",
      completenessStatus: evidenceList.length > 0 ? "complete" : "partial",
      evidence: evidenceList,
      relatedReferences: {
        planId: plan.id,
        projectId: plan.projectId,
      },
      safeNextSteps,
      limitations,
      unknowns: evidenceList.length === 0 ? ["No durable checkpoints recorded for this plan yet."] : undefined,
    };
  }

  // ---------------------------------------------------------------------------
  // 3. Reminder Lifecycle Explanations
  // ---------------------------------------------------------------------------

  /**
   * Explains reminder status: proposal, explicit approval, scheduling, delivery,
   * or uncertain notification state. Grounded strictly in reminderStore.
   */
  async explainReminderLifecycle(
    context: SecurityContext,
    query: ReminderExplanationQuery,
  ): Promise<Explanation> {
    this._assertAuthenticated(context);

    const explanationId = crypto.randomUUID();
    const now = new Date().toISOString();
    const correlationId = query.reminderId;

    // Enforce strict user ownership
    const reminder = await this._reader.getReminderForUser(query.reminderId, context.identityId);

    if (!reminder) {
      return {
        explanationId,
        correlationId,
        timestamp: now,
        category: "reminder_lifecycle",
        decision: "UNKNOWN",
        reasonCategory: "PROPOSAL_CREATED",
        humanReadableReason: `Reminder '${query.reminderId}' was not found for user '${context.identityId}'.`,
        interpretation: "The reminder does not exist or access is restricted by user ownership boundaries.",
        sourceComponent: "ReminderService",
        completenessStatus: "unavailable",
        evidence: [],
        relatedReferences: { reminderId: query.reminderId, projectId: query.projectId },
        limitations: ["Reminder not found or user ownership does not match caller."],
        unknowns: ["Reminder scheduling and delivery history are unknown."],
      };
    }

    // Check project isolation if specified
    if (query.projectId && reminder.projectId && reminder.projectId !== query.projectId) {
      throw new Error(
        `CROSS_PROJECT_ACCESS_DENIED: Reminder '${reminder.id}' belongs to project '${reminder.projectId}', not '${query.projectId}'.`,
      );
    }

    let reminderReasonCategory: any = "REMINDER_SCHEDULED";
    let humanReason = `Reminder status is '${reminder.status}'.`;

    if (reminder.status === "proposed" || reminder.status === "awaiting_approval") {
      reminderReasonCategory = "AWAITING_APPROVAL";
      humanReason = "Reminder proposal requires explicit user approval before scheduling.";
    } else if (reminder.status === "delivered") {
      reminderReasonCategory = "NOTIFICATION_DELIVERED";
      humanReason = `Notification was delivered to the user at ${reminder.lastDeliveredAt || reminder.dueTime}.`;
    } else if (reminder.status === "delivery_unknown") {
      reminderReasonCategory = "DELIVERY_UNKNOWN";
      humanReason = "Notification hub returned indeterminate result; delivery could not be confirmed.";
    } else if (reminder.status === "failed") {
      reminderReasonCategory = "DELIVERY_FAILED";
      humanReason = "Reminder delivery failed or was suppressed.";
    } else if (reminder.approval?.revoked) {
      reminderReasonCategory = "APPROVAL_REVOKED";
      humanReason = `Approval was revoked: ${reminder.approval.revocationReason || "Reminder was modified."}`;
    }

    const { interpretation, safeNextSteps, limitations } = this._formatter.generateReminderInterpretation(
      reminderReasonCategory,
      {
        text: reminder.text,
        dueTime: reminder.dueTime,
      },
    );

    // Build evidence from occurrences
    const evidenceList: EvidenceRecord[] = [];
    for (const occ of reminder.occurrences) {
      const ev = this._reader.occurrenceToEvidence(reminder, occ);
      evidenceList.push(this._formatter.sanitizeForExplanation(ev).result);
    }

    return {
      explanationId,
      correlationId: reminder.id,
      timestamp: now,
      category: "reminder_lifecycle",
      decision: reminder.status.toUpperCase(),
      reasonCategory: reminderReasonCategory,
      humanReadableReason: this._formatter.sanitizeText(humanReason),
      interpretation,
      sourceComponent: "ReminderService",
      completenessStatus: "complete",
      evidence: evidenceList,
      relatedReferences: {
        reminderId: reminder.id,
        projectId: reminder.projectId,
        taskPlanId: reminder.taskPlanId,
      },
      safeNextSteps,
      limitations,
    };
  }

  // ---------------------------------------------------------------------------
  // 4. Correlation Explanations
  // ---------------------------------------------------------------------------

  /**
   * Explains an event across subsystems using an explicit correlation ID.
   * Matches audit records, plans, and reminders without timestamp guessing.
   */
  async explainByCorrelationId(
    context: SecurityContext,
    query: CorrelationExplanationQuery,
  ): Promise<Explanation> {
    this._assertAuthenticated(context);

    const explanationId = crypto.randomUUID();
    const now = new Date().toISOString();
    const correlationId = query.correlationId.trim();

    // 1. Check if correlationId corresponds directly to a TaskPlan
    const plan = await this._reader.getTaskPlan(correlationId, query.projectId);
    if (plan) {
      return this.explainTaskOrchestration(context, { planId: plan.id, projectId: query.projectId });
    }

    // 2. Check if correlationId corresponds directly to a Reminder
    const reminder = await this._reader.getReminderForUser(correlationId, context.identityId);
    if (reminder) {
      return this.explainReminderLifecycle(context, { reminderId: reminder.id, projectId: query.projectId });
    }

    // 3. Search audit events explicitly by correlationId
    const events = await this._reader.getAuditEventsByCorrelation(correlationId, query.limit);
    // Filter to user-authorized events
    const authorizedEvents = context.role === "admin"
      ? events
      : events.filter((e) => e.actor?.identityId === context.identityId);

    if (authorizedEvents.length === 0) {
      return {
        explanationId,
        correlationId,
        timestamp: now,
        category: "correlation",
        decision: "UNKNOWN",
        reasonCategory: "UNKNOWN_DECISION",
        humanReadableReason: `No verified evidence found for correlation ID '${correlationId}'.`,
        interpretation: "The correlation ID does not match any authorized audit, plan, or reminder records.",
        sourceComponent: "ExplainabilityService",
        completenessStatus: "unavailable",
        evidence: [],
        relatedReferences: {},
        limitations: ["No matching records located; cross-entity correlation requires explicit matching IDs."],
      };
    }

    const latest = authorizedEvents[authorizedEvents.length - 1];
    const reasonCategory = this._formatter.classifySecurityReason({
      decision: latest.decision,
      eventType: latest.eventType,
      reason: latest.reason,
    });

    const { interpretation, safeNextSteps } = this._formatter.generateSecurityInterpretation(
      reasonCategory,
      {
        toolName: latest.tool || latest.target?.toolName,
        role: latest.actor?.role,
        reason: latest.reason,
      },
    );

    const evidenceList = authorizedEvents.map((e) => {
      const ev = this._reader.auditEventToEvidence(e);
      return this._formatter.sanitizeForExplanation(ev).result;
    });

    return {
      explanationId,
      correlationId,
      timestamp: now,
      category: "correlation",
      decision: latest.decision || "CORRELATED",
      reasonCategory,
      humanReadableReason: this._formatter.sanitizeText(latest.reason || `Found ${authorizedEvents.length} correlated audit records.`),
      interpretation,
      sourceComponent: "ExplainabilityService",
      completenessStatus: "complete",
      evidence: evidenceList,
      relatedReferences: {
        auditId: latest.id,
        toolName: latest.tool || latest.target?.toolName,
      },
      safeNextSteps,
      limitations: [],
    };
  }

  private _assertAuthenticated(context: SecurityContext): void {
    if (!context || !context.identityId || typeof context.identityId !== "string" || !context.identityId.trim()) {
      throw new Error("UNAUTHORIZED: Valid caller identity required to request explanations.");
    }
  }
}

export const explainabilityService = new ExplainabilityService();
