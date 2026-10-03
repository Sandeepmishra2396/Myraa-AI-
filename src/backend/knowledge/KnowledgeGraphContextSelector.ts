/**
 * MYRAA — Phase 24: Personal Knowledge Graph
 * KnowledgeGraphContextSelector
 *
 * Selects only the compact, highly-relevant subgraph for injection into
 * Gemini prompts or UnifiedMyraaContext.
 *
 * Invariant: Never dumps the entire graph into prompts.
 * Strictly respects token/character budgets (default max 1500 chars).
 */

import type {
  KnowledgeNode,
  KnowledgeEdge,
} from "./KnowledgeGraphTypes.ts";
import { KnowledgeNodeStore, knowledgeNodeStore } from "./KnowledgeNodeStore.ts";
import { KnowledgeEdgeStore, knowledgeEdgeStore } from "./KnowledgeEdgeStore.ts";
import { KnowledgeEntityResolver, knowledgeEntityResolver } from "./KnowledgeEntityResolver.ts";
import { KnowledgeGraphTraversalEngine, knowledgeGraphTraversalEngine } from "./KnowledgeGraphTraversalEngine.ts";

export interface SubgraphSelectionResult {
  focusedNodes: KnowledgeNode[];
  subgraphEdges: KnowledgeEdge[];
  contextString: string;
  charCount: number;
  entitiesReferenced: string[];
}

export class KnowledgeGraphContextSelector {
  private _nodeStore: KnowledgeNodeStore;
  private _edgeStore: KnowledgeEdgeStore;
  private _entityResolver: KnowledgeEntityResolver;
  private _traversalEngine: KnowledgeGraphTraversalEngine;

  public static readonly DEFAULT_MAX_CHARS = 1500;

  constructor(
    nodeStore = knowledgeNodeStore,
    edgeStore = knowledgeEdgeStore,
    entityResolver = knowledgeEntityResolver,
    traversalEngine = knowledgeGraphTraversalEngine
  ) {
    this._nodeStore = nodeStore;
    this._edgeStore = edgeStore;
    this._entityResolver = entityResolver;
    this._traversalEngine = traversalEngine;
  }

  /**
   * Selects a relevant subgraph based on a user prompt or active entities.
   */
  public selectRelevantSubgraph(params: {
    queryText: string;
    activeProject?: string;
    activeFile?: string;
    maxChars?: number;
  }): SubgraphSelectionResult {
    const maxChars = params.maxChars ?? KnowledgeGraphContextSelector.DEFAULT_MAX_CHARS;
    const query = params.queryText.toLowerCase();

    // 1. Identify anchor nodes from query & context
    const anchorNodeIds = new Set<string>();

    // Check query for explicit entity references
    const resolution = this._entityResolver.resolveEntity(params.queryText, {
      activeProject: params.activeProject,
      activeFile: params.activeFile,
    });
    if (resolution.matchedNode) {
      anchorNodeIds.add(resolution.matchedNode.id);
    }

    // Search for entities mentioned in query words
    const allActiveNodes = this._nodeStore.findByStatus("ACTIVE");
    for (const node of allActiveNodes) {
      const canon = node.canonicalName.toLowerCase();
      if (canon.length > 2 && query.includes(canon)) {
        anchorNodeIds.add(node.id);
      }
      for (const alias of node.aliases || []) {
        const al = alias.toLowerCase();
        if (al.length > 2 && query.includes(al)) {
          anchorNodeIds.add(node.id);
        }
      }
    }

    // If context project exists and nothing found yet, anchor on project
    if (anchorNodeIds.size === 0 && params.activeProject) {
      const projNodes = this._nodeStore.findByCanonicalName(params.activeProject);
      if (projNodes.length > 0) {
        anchorNodeIds.add(projNodes[0].id);
      }
    }

    // If still no anchors found, return empty context
    if (anchorNodeIds.size === 0) {
      return {
        focusedNodes: [],
        subgraphEdges: [],
        contextString: "",
        charCount: 0,
        entitiesReferenced: [],
      };
    }

    // 2. Traverse 1-2 hops around anchor nodes
    const collectedNodes = new Map<string, KnowledgeNode>();
    const collectedEdges = new Map<string, KnowledgeEdge>();

    for (const anchorId of anchorNodeIds) {
      const traversal = this._traversalEngine.traverse({
        startNodeId: anchorId,
        maxDepth: 2, // Tight 2-hop neighborhood
        direction: "BOTH",
        maxNodes: 15,
        status: "ACTIVE",
      });

      for (const node of traversal.visitedNodes) {
        collectedNodes.set(node.id, node);
      }
      for (const edge of traversal.traversedEdges) {
        collectedEdges.set(edge.id, edge);
      }
    }

    // 3. Format formatted relationship statements within char budget
    const statements: string[] = [];
    let currentLength = 0;

    for (const edge of collectedEdges.values()) {
      const src = collectedNodes.get(edge.sourceNodeId);
      const tgt = collectedNodes.get(edge.targetNodeId);
      if (!src || !tgt) continue;

      const statement = `- ${src.canonicalName} ${edge.relationType} ${tgt.canonicalName}`;
      if (currentLength + statement.length + 1 > maxChars) {
        break;
      }
      statements.push(statement);
      currentLength += statement.length + 1;
    }

    const contextString = statements.length > 0
      ? `[Personal Knowledge Graph Context]\n${statements.join("\n")}`
      : "";

    const entitiesReferenced = Array.from(collectedNodes.values()).map((n) => n.canonicalName);

    return {
      focusedNodes: Array.from(collectedNodes.values()),
      subgraphEdges: Array.from(collectedEdges.values()),
      contextString,
      charCount: contextString.length,
      entitiesReferenced,
    };
  }
}

export const knowledgeGraphContextSelector = new KnowledgeGraphContextSelector();
