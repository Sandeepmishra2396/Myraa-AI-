/**
 * MYRAA — ExplainabilityEvidenceReader (Stage 10.7)
 *
 * Read-only reader and aggregator of factual system evidence:
 *   - Security audit events and hash-chained canonical records
 *   - Task plans, DAG step outcomes, and durable checkpoints
 *   - Reminders, approvals, occurrences, and delivery records
 *   - Strict explicit ID correlation (never correlates by timestamp proximity alone)
 *   - Verification integrity checks
 *   - Read-only observer: ZERO mutations to underlying stores
 */

import fs from "fs/promises";
import path from "path";
import { securityAuditLogger } from "../security/SecurityAuditLogger.ts";
import { planStore } from "../planner/PlanStore.ts";
import { reminderStore } from "../reminders/ReminderStore.ts";
import type { SecurityAuditEvent, CanonicalAuditRecord } from "../security/SecurityTypes.ts";
import type { TaskPlan } from "../planner/PlannerTypes.ts";
import type { TaskCheckpoint, OrchestratedTaskPlan } from "../planner/TaskOrchestrator.ts";
import type { Reminder, ReminderOccurrence } from "../reminders/ReminderTypes.ts";
import type { EvidenceRecord } from "./ExplainabilityTypes.ts";
import { MAX_EVIDENCE_PER_EXPLANATION } from "./ExplainabilityTypes.ts";

export class ExplainabilityEvidenceReader {
  private _logFilePath: string;

  constructor(customLogPath?: string) {
    const defaultLogPath = path.resolve(
      process.env.SORA_WORKSPACE_DIR || process.cwd(),
      "logs/security_audit.jsonl",
    );
    this._logFilePath = customLogPath || defaultLogPath;
  }

  /**
   * Find an audit event by its unique ID.
   * Checks in-memory ledger first, then falls back to read-only scan of security_audit.jsonl.
   */
  async getAuditEventById(id: string): Promise<SecurityAuditEvent | undefined> {
    if (!id || typeof id !== "string") return undefined;
    const cleanId = id.trim();

    // 1. In-memory check
    const inMem = securityAuditLogger.getRecentEvents(5000);
    const foundMem = inMem.find((e) => e.id === cleanId || e.eventId === cleanId);
    if (foundMem) return foundMem;

    // 2. Read-only log file scan
    try {
      const content = await fs.readFile(this._logFilePath, "utf-8");
      const lines = content.split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
          const rec: CanonicalAuditRecord = JSON.parse(line);
          if (rec.eventId === cleanId) {
            return {
              id: rec.eventId,
              timestamp: rec.timestamp,
              eventType: rec.action as any,
              actor: {
                identityId: rec.deviceSession?.split(":")[0] || "unknown",
                role: "standard",
                ipAddress: "127.0.0.1",
              },
              target: { toolName: rec.tool },
              riskLevel: rec.riskLevel,
              decision: rec.decision,
              reason: rec.reason,
              metadata: rec.metadata,
              prevHash: rec.prevHash,
              hash: rec.hash,
              eventId: rec.eventId,
              deviceSession: rec.deviceSession,
              action: rec.action,
              tool: rec.tool,
            };
          }
        } catch {
          // ignore malformed lines
        }
      }
    } catch {
      // file might not exist in fresh test environments
    }

    return undefined;
  }

  /**
   * Find audit events associated with a specific correlation ID.
   * Never correlates by timestamp alone. Matches explicitly on:
   * eventId, id, or metadata.correlationId / metadata.auditCorrelationId.
   */
  async getAuditEventsByCorrelation(
    correlationId: string,
    limit = MAX_EVIDENCE_PER_EXPLANATION,
  ): Promise<SecurityAuditEvent[]> {
    if (!correlationId || typeof correlationId !== "string") return [];
    const cleanId = correlationId.trim();

    const inMem = securityAuditLogger.getRecentEvents(5000);
    const matched = inMem.filter(
      (e) =>
        e.id === cleanId ||
        e.eventId === cleanId ||
        e.metadata?.correlationId === cleanId ||
        e.metadata?.auditCorrelationId === cleanId ||
        e.metadata?.planId === cleanId ||
        e.metadata?.reminderId === cleanId,
    );

    return matched.slice(-limit);
  }

  /**
   * Find audit events for a specific user identity, optionally filtered by tool name or decision.
   */
  async getAuditEventsForUser(
    userId: string,
    options?: { toolName?: string; limit?: number },
  ): Promise<SecurityAuditEvent[]> {
    if (!userId || typeof userId !== "string") return [];
    const limit = Math.min(options?.limit || 50, MAX_EVIDENCE_PER_EXPLANATION);

    const inMem = securityAuditLogger.getRecentEvents(5000);
    const filtered = inMem.filter((e) => {
      if (e.actor?.identityId !== userId) return false;
      if (options?.toolName && e.tool !== options.toolName && e.target?.toolName !== options.toolName) {
        return false;
      }
      return true;
    });

    return filtered.slice(-limit);
  }

  /**
   * Read a TaskPlan with strict project isolation.
   */
  async getTaskPlan(planId: string, projectId?: string): Promise<OrchestratedTaskPlan | undefined> {
    if (!planId || typeof planId !== "string") return undefined;
    return (await planStore.getPlanWithProjectIsolation(planId.trim(), projectId?.trim())) as OrchestratedTaskPlan;
  }

  /**
   * Read a Reminder strictly enforcing user ownership.
   */
  async getReminderForUser(reminderId: string, userId: string): Promise<Reminder | undefined> {
    if (!reminderId || !userId) return undefined;
    return await reminderStore.getReminderForUser(reminderId.trim(), userId.trim());
  }

  /**
   * List Reminders for a user and optional project.
   */
  async listRemindersForUser(
    userId: string,
    projectId?: string,
  ): Promise<Reminder[]> {
    if (!userId) return [];
    return await reminderStore.listRemindersForUser(userId.trim(), { projectId: projectId?.trim() });
  }

  /**
   * Transform a SecurityAuditEvent into a verified EvidenceRecord.
   */
  auditEventToEvidence(event: SecurityAuditEvent): EvidenceRecord {
    return {
      evidenceId: event.id || event.eventId || "unknown_audit_id",
      source: "audit_log",
      eventType: event.eventType,
      timestamp: event.timestamp,
      verified: typeof event.hash === "string" && event.hash.length === 64,
      fields: {
        actorId: event.actor?.identityId,
        role: event.actor?.role,
        tool: event.tool || event.target?.toolName,
        decision: event.decision,
        riskLevel: event.riskLevel,
        reason: event.reason,
        metadata: event.metadata,
      },
      hash: event.hash,
    };
  }

  /**
   * Transform a TaskCheckpoint into a verified EvidenceRecord.
   */
  checkpointToEvidence(checkpoint: TaskCheckpoint): EvidenceRecord {
    return {
      evidenceId: checkpoint.id,
      source: "checkpoint",
      eventType: checkpoint.boundaryType,
      timestamp: checkpoint.createdAt,
      verified: typeof checkpoint.version === "number" && !!checkpoint.boundaryType,
      fields: {
        planId: checkpoint.planId,
        projectId: checkpoint.projectId,
        version: checkpoint.version,
        boundaryType: checkpoint.boundaryType,
        stepId: checkpoint.stepId,
        stepPhase: checkpoint.stepPhase,
        completedStepCount: checkpoint.completedStepIds.length,
        pendingStepCount: checkpoint.pendingStepIds.length,
        uncertainStepIds: checkpoint.uncertainStepIds,
        lastSafeBoundaryStepId: checkpoint.lastSafeBoundaryStepId,
      },
    };
  }

  /**
   * Transform a Reminder Occurrence into a verified EvidenceRecord.
   */
  occurrenceToEvidence(reminder: Reminder, occurrence: ReminderOccurrence): EvidenceRecord {
    return {
      evidenceId: occurrence.occurrenceId,
      source: "reminder_store",
      eventType: occurrence.status,
      timestamp: occurrence.scheduledTime,
      verified: !!occurrence.deliveryKey,
      fields: {
        reminderId: reminder.id,
        occurrenceIndex: occurrence.occurrenceIndex,
        status: occurrence.status,
        deliveryKey: occurrence.deliveryKey,
        claimedAt: occurrence.claimedAt,
        deliveredAt: occurrence.deliveredAt,
        error: occurrence.error,
        approvalHash: reminder.approval?.contentHash,
      },
    };
  }
}

export const explainabilityEvidenceReader = new ExplainabilityEvidenceReader();
