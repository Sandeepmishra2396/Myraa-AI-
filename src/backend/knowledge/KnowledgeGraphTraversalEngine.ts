/**
 * MYRAA — Phase 24: Personal Knowledge Graph
 * KnowledgeGraphTraversalEngine
 *
 * Implements safe, bounded graph traversal.
 * Enforces:
 *   - Default max depth = 3, Hard max depth = 6.
 *   - Strict cycle detection (no infinite loops).
 *   - Max node expansion limits (prevents memory exhaustion).
 *   - Directional control (OUTGOING, INCOMING, BOTH).
 */

import type {
  KnowledgeNode,
  KnowledgeEdge,
  TraversalOptions,
  TraversalResult,
  TraversalStep,
} from "./KnowledgeGraphTypes.ts";
import { KnowledgeNodeStore, knowledgeNodeStore } from "./KnowledgeNodeStore.ts";
import { KnowledgeEdgeStore, knowledgeEdgeStore } from "./KnowledgeEdgeStore.ts";

export class KnowledgeGraphTraversalEngine {
  private _nodeStore: KnowledgeNodeStore;
  private _edgeStore: KnowledgeEdgeStore;

  public static readonly DEFAULT_MAX_DEPTH = 3;
  public static readonly HARD_MAX_DEPTH = 6;
  public static readonly DEFAULT_MAX_NODES = 50;
  public static readonly HARD_MAX_NODES = 100;

  constructor(nodeStore = knowledgeNodeStore, edgeStore = knowledgeEdgeStore) {
    this._nodeStore = nodeStore;
    this._edgeStore = edgeStore;
  }

  /**
   * Traverses the graph from a start node up to a bounded depth.
   */
  public traverse(options: TraversalOptions): TraversalResult {
    const startNode = this._nodeStore.getNode(options.startNodeId);
    if (!startNode) {
      return {
        startNode: null,
        visitedNodes: [],
        traversedEdges: [],
        steps: [],
        maxDepthReached: 0,
        hasCycles: false,
      };
    }

    const maxDepth = Math.min(
      KnowledgeGraphTraversalEngine.HARD_MAX_DEPTH,
      Math.max(1, options.maxDepth ?? KnowledgeGraphTraversalEngine.DEFAULT_MAX_DEPTH)
    );

    const maxNodes = Math.min(
      KnowledgeGraphTraversalEngine.HARD_MAX_NODES,
      Math.max(1, options.maxNodes ?? KnowledgeGraphTraversalEngine.DEFAULT_MAX_NODES)
    );

    const direction = options.direction || "OUTGOING";
    const statusFilter = options.status || "ACTIVE";
    const allowedRelations = options.relationTypes ? new Set(options.relationTypes) : null;
    const allowedNodeTypes = options.nodeTypes ? new Set(options.nodeTypes) : null;

    const visitedNodeIds = new Set<string>([startNode.id]);
    const visitedEdgeIds = new Set<string>();
    const steps: TraversalStep[] = [];
    const traversedEdges: KnowledgeEdge[] = [];
    let maxDepthReached = 0;
    let hasCycles = false;

    // BFS Queue: [nodeId, currentDepth]
    const queue: Array<{ nodeId: string; depth: number }> = [{ nodeId: startNode.id, depth: 0 }];

    while (queue.length > 0 && visitedNodeIds.size < maxNodes) {
      const current = queue.shift()!;
      if (current.depth >= maxDepth) continue;

      const currentNode = this._nodeStore.getNode(current.nodeId);
      if (!currentNode) continue;

      // Collect candidate edges based on direction
      const candidateEdges: KnowledgeEdge[] = [];

      if (direction === "OUTGOING" || direction === "BOTH") {
        candidateEdges.push(...this._edgeStore.getOutgoingEdges(current.nodeId, statusFilter));
      }
      if (direction === "INCOMING" || direction === "BOTH") {
        candidateEdges.push(...this._edgeStore.getIncomingEdges(current.nodeId, statusFilter));
      }

      for (const edge of candidateEdges) {
        if (visitedEdgeIds.has(edge.id)) continue;

        // Filter by relation type if specified
        if (allowedRelations && !allowedRelations.has(edge.relationType)) continue;

        // Determine the neighbor node ID
        const neighborId = edge.sourceNodeId === current.nodeId ? edge.targetNodeId : edge.sourceNodeId;
        const neighborNode = this._nodeStore.getNode(neighborId);
        if (!neighborNode) continue;

        // Filter by neighbor node type if specified
        if (allowedNodeTypes && !allowedNodeTypes.has(neighborNode.type)) continue;

        // Cycle check
        if (visitedNodeIds.has(neighborId)) {
          hasCycles = true;
        }

        visitedEdgeIds.add(edge.id);
        traversedEdges.push(edge);

        const nextDepth = current.depth + 1;
        if (nextDepth > maxDepthReached) {
          maxDepthReached = nextDepth;
        }

        steps.push({
          fromNode: currentNode,
          edge,
          toNode: neighborNode,
          depth: nextDepth,
        });

        // Enqueue if not yet visited and node limit not reached
        if (!visitedNodeIds.has(neighborId) && visitedNodeIds.size < maxNodes) {
          visitedNodeIds.add(neighborId);
          queue.push({ nodeId: neighborId, depth: nextDepth });
        }
      }
    }

    const visitedNodes = Array.from(visitedNodeIds)
      .map((id) => this._nodeStore.getNode(id)!)
      .filter(Boolean);

    return {
      startNode,
      visitedNodes,
      traversedEdges,
      steps,
      maxDepthReached,
      hasCycles,
    };
  }
}

export const knowledgeGraphTraversalEngine = new KnowledgeGraphTraversalEngine();
