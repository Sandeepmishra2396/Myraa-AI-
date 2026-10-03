/**
 * MYRAA — Phase 24: Personal Knowledge Graph
 * KnowledgeGraphConflictResolver
 *
 * Detects and resolves conflicting knowledge relationships.
 * Enforces non-destructive supersession:
 *   - Old edge status marked SUPERSEDED with validUntil = now.
 *   - New edge created with status ACTIVE and validFrom = now.
 *   - Historical information remains fully queryable.
 */

import type {
  KnowledgeEdge,
  KnowledgeRelationType,
} from "./KnowledgeGraphTypes.ts";
import { KnowledgeEdgeStore, knowledgeEdgeStore } from "./KnowledgeEdgeStore.ts";

export interface ConflictResolutionReport {
  conflictDetected: boolean;
  supersededEdgeIds: string[];
  activeEdgeId?: string;
  rationale: string;
}

export class KnowledgeGraphConflictResolver {
  private _edgeStore: KnowledgeEdgeStore;

  // Mutual exclusion sets: pairs or categories of relation targets that cannot coexist
  private _singularRelationTypes = new Set<KnowledgeRelationType>([
    "PREFERS",
  ]);

  constructor(edgeStore = knowledgeEdgeStore) {
    this._edgeStore = edgeStore;
  }

  /**
   * Checks for and resolves conflicting relationships when a new edge is being established.
   */
  public resolveConflict(
    sourceNodeId: string,
    relationType: KnowledgeRelationType,
    newTargetNodeId: string
  ): ConflictResolutionReport {
    // If not a singular relation type, no automatic conflict
    if (!this._singularRelationTypes.has(relationType)) {
      return {
        conflictDetected: false,
        supersededEdgeIds: [],
        rationale: `Relation type '${relationType}' allows multiple coexisting targets.`,
      };
    }

    const activeOutgoing = this._edgeStore.getOutgoingEdges(sourceNodeId, "ACTIVE");
    const conflictingEdges: KnowledgeEdge[] = [];

    for (const edge of activeOutgoing) {
      if (edge.relationType === relationType && edge.targetNodeId !== newTargetNodeId) {
        conflictingEdges.push(edge);
      }
    }

    if (conflictingEdges.length === 0) {
      return {
        conflictDetected: false,
        supersededEdgeIds: [],
        rationale: "No existing conflicting active relationships found.",
      };
    }

    // Supersede older edges non-destructively
    const supersededEdgeIds: string[] = [];
    for (const oldEdge of conflictingEdges) {
      this._edgeStore.supersedeEdge(oldEdge.id);
      supersededEdgeIds.push(oldEdge.id);
    }

    return {
      conflictDetected: true,
      supersededEdgeIds,
      rationale: `Superseded ${conflictingEdges.length} older relationship(s) of type '${relationType}' in favor of target '${newTargetNodeId}'. Historical edges remain queryable.`,
    };
  }
}

export const knowledgeGraphConflictResolver = new KnowledgeGraphConflictResolver();
