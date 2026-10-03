/**
 * MYRAA — Phase 19: Advanced Context Fusion Engine
 * Context Provenance Tracker
 *
 * Maintains an immutable, sanitized audit record of every context fusion event:
 *   - Contributing sources
 *   - Discovered conflicts & deterministic resolutions
 *   - Resolved deictic references & confidence scores
 *   - Zero credential / sensitive token leakage
 */

import crypto from "crypto";
import { sanitizeError } from "../security/PermissionManager.ts";
import type { ContextProvenanceRecord } from "./IntelligenceTypes.ts";

const MAX_PROVENANCE_HISTORY = 200;

export class ContextProvenanceTracker {
  private _history: ContextProvenanceRecord[] = [];

  /**
   * Records a context provenance event.
   */
  public recordProvenance(
    record: Omit<ContextProvenanceRecord, "provenanceId" | "sanitized">
  ): ContextProvenanceRecord {
    const provenanceId = `prov_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;

    // Sanitize any potential sensitive text in conflict rationales or candidates
    const sanitizedConflicts = record.conflicts.map((c) => ({
      ...c,
      primaryCandidate: {
        ...c.primaryCandidate,
        value: sanitizeError(c.primaryCandidate.value),
      },
      conflictingCandidate: {
        ...c.conflictingCandidate,
        value: sanitizeError(c.conflictingCandidate.value),
      },
      winningValue: c.winningValue ? sanitizeError(c.winningValue) : null,
      rationale: sanitizeError(c.rationale),
    }));

    const sanitizedReferences: typeof record.resolvedReferences = {};
    for (const [k, ref] of Object.entries(record.resolvedReferences)) {
      sanitizedReferences[k] = {
        ...ref,
        resolvedEntity: ref.resolvedEntity ? sanitizeError(ref.resolvedEntity) : null,
        clarificationPrompt: ref.clarificationPrompt ? sanitizeError(ref.clarificationPrompt) : undefined,
      };
    }

    const entry: ContextProvenanceRecord = {
      provenanceId,
      contextId: record.contextId,
      timestamp: record.timestamp,
      contributingSources: [...record.contributingSources],
      conflicts: sanitizedConflicts,
      resolvedReferences: sanitizedReferences,
      overallConfidence: record.overallConfidence,
      sanitized: true,
    };

    this._history.unshift(entry);
    if (this._history.length > MAX_PROVENANCE_HISTORY) {
      this._history.pop();
    }

    return entry;
  }

  /**
   * Fetches a provenance record by ID.
   */
  public getProvenance(provenanceId: string): ContextProvenanceRecord | undefined {
    return this._history.find((p) => p.provenanceId === provenanceId);
  }

  /**
   * Lists recent provenance records.
   */
  public listRecentProvenance(limit = 50): ContextProvenanceRecord[] {
    return this._history.slice(0, Math.min(limit, this._history.length));
  }

  /**
   * Clears the provenance history.
   */
  public clear(): void {
    this._history = [];
  }
}

export const contextProvenanceTracker = new ContextProvenanceTracker();
