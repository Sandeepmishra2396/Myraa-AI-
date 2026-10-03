/**
 * MYRAA — Phase 24: Personal Knowledge Graph
 * KnowledgeRelationshipResolver
 *
 * Validates, creates, and resolves relationships between knowledge nodes.
 * Enforces:
 *   - Controlled relationship types (rejects arbitrary strings).
 *   - Duplicate relationship prevention.
 *   - Relationship conflict resolution & non-destructive supersession.
 *   - Provenance attachment on every relationship.
 */

import crypto from "crypto";
import type {
  KnowledgeEdge,
  KnowledgeRelationType,
  KnowledgeProvenance,
} from "./KnowledgeGraphTypes.ts";
import { ALLOWED_RELATION_TYPES } from "./KnowledgeGraphTypes.ts";
import { KnowledgeEdgeStore, knowledgeEdgeStore } from "./KnowledgeEdgeStore.ts";

export interface CreateRelationshipParams {
  sourceNodeId: string;
  relationType: KnowledgeRelationType;
  targetNodeId: string;
  confidence?: number;
  importance?: number;
  weight?: number;
  provenance: KnowledgeProvenance[];
  validFrom?: number;
  validUntil?: number;
  sourceMemoryIds?: string[];
  sourceContextIds?: string[];
  sourceTaskIds?: string[];
  sourceResearchIds?: string[];
  isSingular?: boolean; // If true, supersedes other active edges of this relationType from sourceNodeId
}

export class KnowledgeRelationshipResolver {
  private _edgeStore: KnowledgeEdgeStore;

  // Relation types that are typically singular per source node (e.g. PREFERS for a specific slot)
  private _singularRelations = new Set<KnowledgeRelationType>(["PREFERS"]);

  constructor(edgeStore = knowledgeEdgeStore) {
    this._edgeStore = edgeStore;
  }

  /**
   * Validates if a string is a valid controlled relation type.
   */
  public isValidRelationType(type: string): type is KnowledgeRelationType {
    return ALLOWED_RELATION_TYPES.has(type as KnowledgeRelationType);
  }

  /**
   * Creates or updates a relationship edge with full provenance and duplicate checking.
   */
  public resolveAndCreateRelationship(params: CreateRelationshipParams): KnowledgeEdge {
    if (!this.isValidRelationType(params.relationType)) {
      throw new Error(
        `Rejected arbitrary relationship type '${params.relationType}'. Controlled types only.`
      );
    }

    if (params.sourceNodeId === params.targetNodeId) {
      throw new Error("Self-referential edges are disallowed in knowledge graph.");
    }

    const now = Date.now();

    // ── 1. Duplicate Edge Prevention ─────────────────────────────────────────
    const existingActive = this._edgeStore.findActiveEdge(
      params.sourceNodeId,
      params.relationType,
      params.targetNodeId
    );

    if (existingActive) {
      // Edge already exists: update provenance, confidence, and timestamp instead of creating duplicate
      const mergedProvenance = [...existingActive.provenance, ...params.provenance];
      const newConfidence = Math.max(existingActive.confidence, params.confidence ?? 0.85);

      const updated = this._edgeStore.updateEdge(existingActive.id, {
        confidence: newConfidence,
        provenance: mergedProvenance,
        updatedAt: now,
      });
      return updated || existingActive;
    }

    // ── 2. Singular Conflict & Supersession ──────────────────────────────────
    // If this relation is marked as singular (e.g. PREFERS A superseding PREFERS B for same slot)
    const isSingular = params.isSingular ?? this._singularRelations.has(params.relationType);
    if (isSingular) {
      const activeOutgoing = this._edgeStore.getOutgoingEdges(params.sourceNodeId, "ACTIVE");
      for (const oldEdge of activeOutgoing) {
        if (oldEdge.relationType === params.relationType && oldEdge.targetNodeId !== params.targetNodeId) {
          // Supersede the older conflicting relationship non-destructively
          this._edgeStore.supersedeEdge(oldEdge.id);
        }
      }
    }

    // ── 3. Create Fresh Active Edge ──────────────────────────────────────────
    const newEdge: KnowledgeEdge = {
      id: `kg_edge_${now}_${crypto.randomBytes(4).toString("hex")}`,
      sourceNodeId: params.sourceNodeId,
      targetNodeId: params.targetNodeId,
      relationType: params.relationType,
      confidence: params.confidence ?? 0.85,
      importance: params.importance ?? 3,
      weight: params.weight ?? 1.0,
      createdAt: now,
      updatedAt: now,
      validFrom: params.validFrom ?? now,
      validUntil: params.validUntil,
      status: "ACTIVE",
      provenance: params.provenance,
      sourceMemoryIds: params.sourceMemoryIds || [],
      sourceContextIds: params.sourceContextIds || [],
    };

    return this._edgeStore.addEdge(newEdge);
  }

  /**
   * Supersedes an existing edge by its ID when a replacement is created.
   */
  public supersedeRelationship(edgeId: string): KnowledgeEdge | null {
    return this._edgeStore.supersedeEdge(edgeId);
  }
}

export const knowledgeRelationshipResolver = new KnowledgeRelationshipResolver();
