/**
 * MYRAA — Phase 24: Personal Knowledge Graph
 * KnowledgeEdgeStore
 *
 * In-memory indexed store for KnowledgeEdges.
 * Enforces controlled relationship types, O(1) multi-key lookups
 * (sourceNodeId, targetNodeId, relationType, status, pair key),
 * and duplicate edge prevention.
 */

import type {
  KnowledgeEdge,
  KnowledgeRelationType,
  KnowledgeStatus,
} from "./KnowledgeGraphTypes.ts";
import { ALLOWED_RELATION_TYPES } from "./KnowledgeGraphTypes.ts";

export class KnowledgeEdgeStore {
  private _edges: Map<string, KnowledgeEdge> = new Map();

  // Indexes for O(1) lookups
  private _bySource: Map<string, Set<string>> = new Map();
  private _byTarget: Map<string, Set<string>> = new Map();
  private _byRelation: Map<KnowledgeRelationType, Set<string>> = new Map();
  private _byStatus: Map<KnowledgeStatus, Set<string>> = new Map();
  // Exact active pair index: `${sourceNodeId}:${relationType}:${targetNodeId}` -> edgeId
  private _byPairKey: Map<string, string> = new Map();

  constructor(initialEdges?: KnowledgeEdge[]) {
    if (initialEdges && initialEdges.length > 0) {
      for (const edge of initialEdges) {
        this.addEdge(edge);
      }
    }
  }

  /**
   * Generates a pair key for edge uniqueness check.
   */
  public getPairKey(sourceId: string, relationType: KnowledgeRelationType, targetId: string): string {
    return `${sourceId}:${relationType}:${targetId}`;
  }

  /**
   * Adds a new edge to the store, validating the relation type.
   */
  public addEdge(edge: KnowledgeEdge): KnowledgeEdge {
    // Validate relationship type
    if (!ALLOWED_RELATION_TYPES.has(edge.relationType)) {
      throw new Error(
        `Invalid relationship type: '${edge.relationType}'. Allowed types: ${Array.from(ALLOWED_RELATION_TYPES).join(", ")}`
      );
    }

    this._edges.set(edge.id, edge);
    this._indexEdge(edge);
    return edge;
  }

  /**
   * Retrieves an edge by ID.
   */
  public getEdge(id: string): KnowledgeEdge | undefined {
    return this._edges.get(id);
  }

  /**
   * Checks if an exact active edge already exists between source and target for a relation type.
   */
  public findActiveEdge(
    sourceNodeId: string,
    relationType: KnowledgeRelationType,
    targetNodeId: string
  ): KnowledgeEdge | undefined {
    const pairKey = this.getPairKey(sourceNodeId, relationType, targetNodeId);
    const edgeId = this._byPairKey.get(pairKey);
    if (!edgeId) return undefined;
    const edge = this._edges.get(edgeId);
    return edge && edge.status === "ACTIVE" ? edge : undefined;
  }

  /**
   * Retrieves all outgoing edges from a source node.
   */
  public getOutgoingEdges(sourceNodeId: string, status?: KnowledgeStatus): KnowledgeEdge[] {
    const ids = this._bySource.get(sourceNodeId);
    if (!ids) return [];
    return Array.from(ids)
      .map((id) => this._edges.get(id)!)
      .filter((e) => Boolean(e) && (!status || e.status === status));
  }

  /**
   * Retrieves all incoming edges to a target node.
   */
  public getIncomingEdges(targetNodeId: string, status?: KnowledgeStatus): KnowledgeEdge[] {
    const ids = this._byTarget.get(targetNodeId);
    if (!ids) return [];
    return Array.from(ids)
      .map((id) => this._edges.get(id)!)
      .filter((e) => Boolean(e) && (!status || e.status === status));
  }

  /**
   * Retrieves all connected edges (both incoming and outgoing).
   */
  public getAllConnectedEdges(nodeId: string, status?: KnowledgeStatus): KnowledgeEdge[] {
    const outgoing = this.getOutgoingEdges(nodeId, status);
    const incoming = this.getIncomingEdges(nodeId, status);
    const set = new Set([...outgoing, ...incoming]);
    return Array.from(set);
  }

  /**
   * Retrieves all edges of a given relation type.
   */
  public findByRelationType(relationType: KnowledgeRelationType, status?: KnowledgeStatus): KnowledgeEdge[] {
    const ids = this._byRelation.get(relationType);
    if (!ids) return [];
    return Array.from(ids)
      .map((id) => this._edges.get(id)!)
      .filter((e) => Boolean(e) && (!status || e.status === status));
  }

  /**
   * Retrieves all edges with a given status.
   */
  public findByStatus(status: KnowledgeStatus): KnowledgeEdge[] {
    const ids = this._byStatus.get(status);
    if (!ids) return [];
    return Array.from(ids)
      .map((id) => this._edges.get(id)!)
      .filter(Boolean);
  }

  /**
   * Updates an existing edge.
   */
  public updateEdge(id: string, updates: Partial<KnowledgeEdge>): KnowledgeEdge | null {
    const existing = this._edges.get(id);
    if (!existing) return null;

    this._deindexEdge(existing);

    const updatedEdge: KnowledgeEdge = {
      ...existing,
      ...updates,
      id: existing.id, // ID is immutable
      updatedAt: Date.now(),
    };

    this._edges.set(id, updatedEdge);
    this._indexEdge(updatedEdge);
    return updatedEdge;
  }

  /**
   * Marks an edge as superseded (replaces without destroying historical record).
   */
  public supersedeEdge(id: string): KnowledgeEdge | null {
    return this.updateEdge(id, {
      status: "SUPERSEDED",
      validUntil: Date.now(),
    });
  }

  /**
   * Marks an edge as archived.
   */
  public archiveEdge(id: string): KnowledgeEdge | null {
    return this.updateEdge(id, {
      status: "ARCHIVED",
      validUntil: Date.now(),
    });
  }

  /**
   * Returns all edges.
   */
  public getAllEdges(): KnowledgeEdge[] {
    return Array.from(this._edges.values());
  }

  /**
   * Total edge count.
   */
  public get count(): number {
    return this._edges.size;
  }

  /**
   * Clears all edges and indexes.
   */
  public clear(): void {
    this._edges.clear();
    this._bySource.clear();
    this._byTarget.clear();
    this._byRelation.clear();
    this._byStatus.clear();
    this._byPairKey.clear();
  }

  // ---------------------------------------------------------------------------
  // Index management
  // ---------------------------------------------------------------------------

  private _indexEdge(edge: KnowledgeEdge): void {
    this._addToIndex(this._bySource, edge.sourceNodeId, edge.id);
    this._addToIndex(this._byTarget, edge.targetNodeId, edge.id);
    this._addToIndex(this._byRelation, edge.relationType, edge.id);
    this._addToIndex(this._byStatus, edge.status, edge.id);

    if (edge.status === "ACTIVE") {
      const pairKey = this.getPairKey(edge.sourceNodeId, edge.relationType, edge.targetNodeId);
      this._byPairKey.set(pairKey, edge.id);
    }
  }

  private _deindexEdge(edge: KnowledgeEdge): void {
    this._removeFromIndex(this._bySource, edge.sourceNodeId, edge.id);
    this._removeFromIndex(this._byTarget, edge.targetNodeId, edge.id);
    this._removeFromIndex(this._byRelation, edge.relationType, edge.id);
    this._removeFromIndex(this._byStatus, edge.status, edge.id);

    const pairKey = this.getPairKey(edge.sourceNodeId, edge.relationType, edge.targetNodeId);
    if (this._byPairKey.get(pairKey) === edge.id) {
      this._byPairKey.delete(pairKey);
    }
  }

  private _addToIndex<K>(map: Map<K, Set<string>>, key: K, id: string): void {
    let set = map.get(key);
    if (!set) {
      set = new Set<string>();
      map.set(key, set);
    }
    set.add(id);
  }

  private _removeFromIndex<K>(map: Map<K, Set<string>>, key: K, id: string): void {
    const set = map.get(key);
    if (set) {
      set.delete(id);
      if (set.size === 0) {
        map.delete(key);
      }
    }
  }
}

export const knowledgeEdgeStore = new KnowledgeEdgeStore();
