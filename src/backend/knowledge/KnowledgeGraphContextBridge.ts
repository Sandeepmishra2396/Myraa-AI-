/**
 * MYRAA — Phase 24: Personal Knowledge Graph
 * KnowledgeGraphContextBridge
 *
 * Bridges Phase 19 Unified Context Fusion & Phase 20 Conversation with Knowledge Graph.
 * Enforces the strict priority ladder:
 *   1. Explicit current instruction
 *   2. Current turn
 *   3. Active conversation entity
 *   4. Active task
 *   5. Unified Context
 *   6. Knowledge Graph
 *   7. Adaptive Brain
 *   8. Historical memory
 *
 * Invariant: Knowledge Graph supplements context. It NEVER overrides a fresh explicit instruction.
 */

import type { UnifiedMyraaContext } from "../intelligence/IntelligenceTypes.ts";
import { KnowledgeGraphContextSelector, knowledgeGraphContextSelector } from "./KnowledgeGraphContextSelector.ts";
import { KnowledgeNodeStore, knowledgeNodeStore } from "./KnowledgeNodeStore.ts";
import { KnowledgeEdgeStore, knowledgeEdgeStore } from "./KnowledgeEdgeStore.ts";

export interface GraphEnrichedContext {
  graphContextSummary: string;
  relevantNodeCount: number;
  relevantEdgeCount: number;
}

export class KnowledgeGraphContextBridge {
  private _contextSelector: KnowledgeGraphContextSelector;
  private _nodeStore: KnowledgeNodeStore;
  private _edgeStore: KnowledgeEdgeStore;

  constructor(
    contextSelector = knowledgeGraphContextSelector,
    nodeStore = knowledgeNodeStore,
    edgeStore = knowledgeEdgeStore
  ) {
    this._contextSelector = contextSelector;
    this._nodeStore = nodeStore;
    this._edgeStore = edgeStore;
  }

  /**
   * Enriches a UnifiedMyraaContext with targeted Knowledge Graph relationships.
   */
  public enrichUnifiedContext(
    context: UnifiedMyraaContext,
    userQuery: string
  ): GraphEnrichedContext {
    const activeProject = context.currentProject || undefined;
    const activeFile = context.currentFile || undefined;

    const selection = this._contextSelector.selectRelevantSubgraph({
      queryText: userQuery,
      activeProject,
      activeFile,
      maxChars: 1200,
    });

    if (selection.contextString && context.brainContext) {
      // Append graph context without overriding explicit directives
      context.brainContext.activeDirectives.push(selection.contextString);
    }

    return {
      graphContextSummary: selection.contextString,
      relevantNodeCount: selection.focusedNodes.length,
      relevantEdgeCount: selection.subgraphEdges.length,
    };
  }

  /**
   * Resolves conversational references ("isme", "isko") using knowledge graph relationships.
   */
  public resolveDeicticReference(
    activeEntityName: string,
    targetConcept: string
  ): { resolvedEntity: string | null; confidence: number; isAmbiguous: boolean; clarification?: string } {
    const parentNodes = this._nodeStore.findByCanonicalName(activeEntityName);
    if (parentNodes.length === 0) {
      return { resolvedEntity: null, confidence: 0.3, isAmbiguous: false };
    }

    const parentNode = parentNodes[0];
    const outgoing = this._edgeStore.getOutgoingEdges(parentNode.id, "ACTIVE");

    // Look for edges pointing to the target concept
    const conceptLower = targetConcept.toLowerCase();
    const matchingNodes = outgoing
      .map((e) => this._nodeStore.getNode(e.targetNodeId))
      .filter((n): n is NonNullable<typeof n> => Boolean(n) && n.canonicalName.toLowerCase().includes(conceptLower));

    if (matchingNodes.length === 1) {
      return {
        resolvedEntity: matchingNodes[0].canonicalName,
        confidence: 0.88,
        isAmbiguous: false,
      };
    }

    if (matchingNodes.length > 1) {
      return {
        resolvedEntity: null,
        confidence: 0.45,
        isAmbiguous: true,
        clarification: `Multiple related items found for '${targetConcept}' in ${activeEntityName}: ${matchingNodes.map((n) => n.canonicalName).join(", ")}. Please clarify.`,
      };
    }

    return { resolvedEntity: null, confidence: 0.3, isAmbiguous: false };
  }
}

export const knowledgeGraphContextBridge = new KnowledgeGraphContextBridge();
