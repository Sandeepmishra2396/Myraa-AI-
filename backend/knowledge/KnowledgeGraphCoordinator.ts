/**
 * MYRAA — Phase 24: Personal Knowledge Graph
 * KnowledgeGraphCoordinator
 *
 * Master coordinator unifying all Personal Knowledge Graph engines, stores,
 * resolvers, and bridges. Enforces security gates, Emergency Stop,
 * Security Lockdown, audit logging, and secret redaction.
 */

import type {
  KnowledgeNode,
  KnowledgeEdge,
  GraphQueryOptions,
  GraphQueryResult,
  TraversalOptions,
  TraversalResult,
  KnowledgeGraphSnapshot,
  GraphStats,
  KnowledgeNodeType,
  KnowledgeRelationType,
  KnowledgeProvenance,
} from "./KnowledgeGraphTypes.ts";
import { KnowledgeGraphStore, knowledgeGraphStore } from "./KnowledgeGraphStore.ts";
import { KnowledgeNodeStore } from "./KnowledgeNodeStore.ts";
import { KnowledgeEdgeStore } from "./KnowledgeEdgeStore.ts";
import { KnowledgeEntityResolver, knowledgeEntityResolver } from "./KnowledgeEntityResolver.ts";
import { KnowledgeRelationshipResolver, knowledgeRelationshipResolver } from "./KnowledgeRelationshipResolver.ts";
import { KnowledgeGraphExtractor, knowledgeGraphExtractor, ExtractionResult } from "./KnowledgeGraphExtractor.ts";
import { KnowledgeGraphQueryEngine, knowledgeGraphQueryEngine } from "./KnowledgeGraphQueryEngine.ts";
import { KnowledgeGraphTraversalEngine, knowledgeGraphTraversalEngine } from "./KnowledgeGraphTraversalEngine.ts";
import { KnowledgeGraphProvenanceTracker, knowledgeGraphProvenance, ProvenanceExplanation } from "./KnowledgeGraphProvenance.ts";
import { KnowledgeGraphMemoryBridge, knowledgeGraphMemoryBridge } from "./KnowledgeGraphMemoryBridge.ts";
import { KnowledgeGraphContextBridge, knowledgeGraphContextBridge } from "./KnowledgeGraphContextBridge.ts";
import { KnowledgeGraphResearchBridge, knowledgeGraphResearchBridge } from "./KnowledgeGraphResearchBridge.ts";
import { KnowledgeGraphCodingBridge, knowledgeGraphCodingBridge } from "./KnowledgeGraphCodingBridge.ts";
import { KnowledgeGraphAgentBridge, knowledgeGraphAgentBridge } from "./KnowledgeGraphAgentBridge.ts";
import { KnowledgeGraphConflictResolver, knowledgeGraphConflictResolver } from "./KnowledgeGraphConflictResolver.ts";
import { securityAuditLogger } from "../security/SecurityAuditLogger.ts";
import { multiAgentContextManager } from "../multiagent/MultiAgentContextManager.ts";

export class KnowledgeGraphCoordinator {
  public readonly store: KnowledgeGraphStore;
  public readonly nodes: KnowledgeNodeStore;
  public readonly edges: KnowledgeEdgeStore;
  public readonly entityResolver: KnowledgeEntityResolver;
  public readonly relationshipResolver: KnowledgeRelationshipResolver;
  public readonly extractor: KnowledgeGraphExtractor;
  public readonly queryEngine: KnowledgeGraphQueryEngine;
  public readonly traversalEngine: KnowledgeGraphTraversalEngine;
  public readonly provenanceTracker: KnowledgeGraphProvenanceTracker;
  public readonly memoryBridge: KnowledgeGraphMemoryBridge;
  public readonly contextBridge: KnowledgeGraphContextBridge;
  public readonly researchBridge: KnowledgeGraphResearchBridge;
  public readonly codingBridge: KnowledgeGraphCodingBridge;
  public readonly agentBridge: KnowledgeGraphAgentBridge;
  public readonly conflictResolver: KnowledgeGraphConflictResolver;

  constructor(
    store = knowledgeGraphStore,
    entityResolver = knowledgeEntityResolver,
    relationshipResolver = knowledgeRelationshipResolver,
    extractor = knowledgeGraphExtractor,
    queryEngine = knowledgeGraphQueryEngine,
    traversalEngine = knowledgeGraphTraversalEngine,
    provenanceTracker = knowledgeGraphProvenance,
    memoryBridge = knowledgeGraphMemoryBridge,
    contextBridge = knowledgeGraphContextBridge,
    researchBridge = knowledgeGraphResearchBridge,
    codingBridge = knowledgeGraphCodingBridge,
    agentBridge = knowledgeGraphAgentBridge,
    conflictResolver = knowledgeGraphConflictResolver
  ) {
    this.store = store;
    this.nodes = store.nodes;
    this.edges = store.edges;
    this.entityResolver = entityResolver;
    this.relationshipResolver = relationshipResolver;
    this.extractor = extractor;
    this.queryEngine = queryEngine;
    this.traversalEngine = traversalEngine;
    this.provenanceTracker = provenanceTracker;
    this.memoryBridge = memoryBridge;
    this.contextBridge = contextBridge;
    this.researchBridge = researchBridge;
    this.codingBridge = codingBridge;
    this.agentBridge = agentBridge;
    this.conflictResolver = conflictResolver;
  }

  /**
   * Initializes the knowledge graph coordinator, loading persistence from disk.
   */
  public async initialize(): Promise<{ nodeCount: number; edgeCount: number }> {
    const res = await this.store.load();
    securityAuditLogger.logEvent({
      eventType: "TOOL_ALLOW",
      actor: { identityId: "knowledge_coordinator", role: "standard", ipAddress: "127.0.0.1" },
      target: { toolName: "KnowledgeGraphCoordinator", resource: "initialize" },
      riskLevel: "LOW",
      decision: "ALLOW",
      reason: `Knowledge graph loaded with ${res.nodeCount} nodes and ${res.edgeCount} edges.`,
    });
    return res;
  }

  /**
   * Processes a user utterance, extracting qualified entities and relationships.
   */
  public async processUtterance(utterance: string): Promise<ExtractionResult> {
    this.store.assertMutationPermitted("PROCESS_UTTERANCE");

    // Redact any secrets in utterance before processing
    const cleanUtterance = multiAgentContextManager.redactSecrets(utterance);
    const result = this.extractor.extractFromUtterance(cleanUtterance);

    if (result.nodesCreated.length > 0 || result.edgesCreated.length > 0) {
      await this.store.persist();
      securityAuditLogger.logEvent({
        eventType: "TOOL_ALLOW",
        actor: { identityId: "user", role: "standard", ipAddress: "127.0.0.1" },
        target: { toolName: "KnowledgeGraphExtractor" },
        riskLevel: "LOW",
        decision: "ALLOW",
        reason: `Created ${result.nodesCreated.length} nodes and ${result.edgesCreated.length} edges from utterance.`,
      });
    }

    return result;
  }

  /**
   * Queries the Knowledge Graph.
   */
  public query(options: GraphQueryOptions): GraphQueryResult {
    return this.queryEngine.query(options);
  }

  /**
   * Traverses from a start node up to a bounded depth.
   */
  public traverse(options: TraversalOptions): TraversalResult {
    return this.traversalEngine.traverse(options);
  }

  /**
   * Creates a new KnowledgeNode with security assertions and persistence.
   */
  public async createNode(params: {
    type: KnowledgeNodeType;
    canonicalName: string;
    aliases?: string[];
    attributes?: Record<string, unknown>;
    confidence?: number;
    importance?: number;
    provenance: KnowledgeProvenance[];
  }): Promise<KnowledgeNode> {
    this.store.assertMutationPermitted("CREATE_NODE");

    const now = Date.now();
    const cleanName = this.entityResolver.canonicalize(params.canonicalName);

    // Check if node with same canonical name and type exists
    const existing = this.nodes.findByCanonicalName(cleanName).filter((n) => n.type === params.type && n.status === "ACTIVE");
    if (existing.length > 0) {
      // Return existing or update aliases
      const node = existing[0];
      if (params.aliases) {
        for (const a of params.aliases) {
          this.nodes.addAlias(node.id, a);
        }
      }
      return this.nodes.getNode(node.id)!;
    }

    const node: KnowledgeNode = {
      id: `kg_node_${params.type.toLowerCase()}_${now}_${Math.random().toString(36).slice(2, 7)}`,
      type: params.type,
      canonicalName: cleanName,
      aliases: params.aliases || [],
      attributes: params.attributes || {},
      confidence: params.confidence ?? 0.85,
      importance: params.importance ?? 3,
      createdAt: now,
      updatedAt: now,
      firstObservedAt: now,
      lastObservedAt: now,
      status: "ACTIVE",
      provenance: params.provenance,
      sourceMemoryIds: [],
      sourceContextIds: [],
      sourceTaskIds: [],
      sourceResearchIds: [],
    };

    const saved = this.nodes.addNode(node);
    await this.store.persist();
    return saved;
  }

  /**
   * Creates a new KnowledgeEdge with conflict resolution, security assertions, and persistence.
   */
  public async createEdge(params: {
    sourceNodeId: string;
    relationType: KnowledgeRelationType;
    targetNodeId: string;
    confidence?: number;
    importance?: number;
    weight?: number;
    provenance: KnowledgeProvenance[];
  }): Promise<KnowledgeEdge> {
    this.store.assertMutationPermitted("CREATE_EDGE");

    // Resolve any singular conflict
    this.conflictResolver.resolveConflict(params.sourceNodeId, params.relationType, params.targetNodeId);

    const edge = this.relationshipResolver.resolveAndCreateRelationship({
      sourceNodeId: params.sourceNodeId,
      relationType: params.relationType,
      targetNodeId: params.targetNodeId,
      confidence: params.confidence,
      importance: params.importance,
      weight: params.weight,
      provenance: params.provenance,
    });

    await this.store.persist();
    return edge;
  }

  /**
   * Explains provenance for a node or relationship ("Why do you know this?").
   */
  public explainKnowledge(id: string): ProvenanceExplanation {
    const node = this.nodes.getNode(id);
    if (node) {
      return this.provenanceTracker.explainNode(node);
    }

    const edge = this.edges.getEdge(id);
    if (edge) {
      const src = this.nodes.getNode(edge.sourceNodeId)?.canonicalName || edge.sourceNodeId;
      const tgt = this.nodes.getNode(edge.targetNodeId)?.canonicalName || edge.targetNodeId;
      return this.provenanceTracker.explainEdge(edge, src, tgt);
    }

    return {
      entityOrRelationship: id,
      sourceType: "NOT_FOUND",
      sourceDescription: "Entity or relationship not found in knowledge graph",
      timestamp: Date.now(),
      formattedDate: new Date().toLocaleString(),
      confidence: 0,
      confidenceTier: "LOW",
      explanation: `I have no record of entity or relationship '${id}' in my knowledge graph.`,
    };
  }

  /**
   * Synchronizes memories from Phase 18 CognitiveMemoryStore.
   */
  public async refreshFromMemory(): Promise<{ syncedCount: number; supersededCount: number }> {
    this.store.assertMutationPermitted("REFRESH_MEMORY");
    const res = await this.memoryBridge.syncFromCognitiveMemories();
    await this.store.persist();
    return res;
  }

  /**
   * Creates a snapshot of the current knowledge graph.
   */
  public createSnapshot(reason?: string): KnowledgeGraphSnapshot {
    return this.store.createSnapshot(reason);
  }

  /**
   * Restores the knowledge graph to a previous snapshot state.
   */
  public async restoreSnapshot(snapshot: KnowledgeGraphSnapshot): Promise<boolean> {
    return this.store.restoreSnapshot(snapshot);
  }

  /**
   * Returns comprehensive statistics.
   */
  public getStats(): GraphStats {
    return this.store.getStats();
  }

  /**
   * Resets the knowledge graph.
   */
  public async reset(): Promise<void> {
    await this.store.reset();
  }
}

export const knowledgeGraphCoordinator = new KnowledgeGraphCoordinator();
