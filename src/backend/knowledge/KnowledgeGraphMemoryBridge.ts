/**
 * MYRAA — Phase 24: Personal Knowledge Graph
 * KnowledgeGraphMemoryBridge
 *
 * Bridges Phase 18 Cognitive Memory Layer with the Personal Knowledge Graph.
 * Ensures qualified memories flow into the graph, while supersessions and expirations
 * in Phase 18 propagate non-destructively to graph edges.
 */

import { CognitiveMemoryStore, cognitiveMemoryStore } from "../brain/CognitiveMemoryStore.ts";
import { KnowledgeGraphExtractor, knowledgeGraphExtractor } from "./KnowledgeGraphExtractor.ts";
import { KnowledgeNodeStore, knowledgeNodeStore } from "./KnowledgeNodeStore.ts";
import { KnowledgeEdgeStore, knowledgeEdgeStore } from "./KnowledgeEdgeStore.ts";

export class KnowledgeGraphMemoryBridge {
  private _memoryStore: CognitiveMemoryStore;
  private _extractor: KnowledgeGraphExtractor;
  private _nodeStore: KnowledgeNodeStore;
  private _edgeStore: KnowledgeEdgeStore;

  constructor(
    memoryStore = cognitiveMemoryStore,
    extractor = knowledgeGraphExtractor,
    nodeStore = knowledgeNodeStore,
    edgeStore = knowledgeEdgeStore
  ) {
    this._memoryStore = memoryStore;
    this._extractor = extractor;
    this._nodeStore = nodeStore;
    this._edgeStore = edgeStore;
  }

  /**
   * Synchronizes all qualified active cognitive memories into the knowledge graph.
   */
  public async syncFromCognitiveMemories(): Promise<{ syncedCount: number; supersededCount: number }> {
    const memories = await this._memoryStore.loadMemories();
    let syncedCount = 0;
    let supersededCount = 0;

    for (const mem of memories) {
      if (mem.status === "active") {
        this._extractor.extractFromCognitiveMemory(mem);
        syncedCount++;
      } else if (mem.status === "superseded" || mem.status === "expired") {
        // Find edges originating from this memory ID and mark them superseded
        const allEdges = this._edgeStore.getAllEdges();
        for (const edge of allEdges) {
          if (edge.sourceMemoryIds && edge.sourceMemoryIds.includes(mem.id) && edge.status === "ACTIVE") {
            this._edgeStore.supersedeEdge(edge.id);
            supersededCount++;
          }
        }
      }
    }

    return { syncedCount, supersededCount };
  }
}

export const knowledgeGraphMemoryBridge = new KnowledgeGraphMemoryBridge();
