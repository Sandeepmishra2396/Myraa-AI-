/**
 * MYRAA — Knowledge Subsystem Public API
 *
 * Exposes:
 *   1. Phase 24 Personal Knowledge Graph (Coordinator, Engines, Stores, Types)
 *   2. Phase 4 Document RAG & Vector Engine (KnowledgeManager, KnowledgeTypes)
 */

// Phase 24 — Personal Knowledge Graph
export {
  knowledgeGraphCoordinator,
  KnowledgeGraphCoordinator,
} from "./KnowledgeGraphCoordinator.ts";

export {
  knowledgeGraphStore,
  KnowledgeGraphStore,
} from "./KnowledgeGraphStore.ts";

export {
  knowledgeNodeStore,
  KnowledgeNodeStore,
} from "./KnowledgeNodeStore.ts";

export {
  knowledgeEdgeStore,
  KnowledgeEdgeStore,
} from "./KnowledgeEdgeStore.ts";

export {
  knowledgeEntityResolver,
  KnowledgeEntityResolver,
} from "./KnowledgeEntityResolver.ts";

export {
  knowledgeRelationshipResolver,
  KnowledgeRelationshipResolver,
} from "./KnowledgeRelationshipResolver.ts";

export {
  knowledgeGraphExtractor,
  KnowledgeGraphExtractor,
} from "./KnowledgeGraphExtractor.ts";

export {
  knowledgeGraphQueryEngine,
  KnowledgeGraphQueryEngine,
} from "./KnowledgeGraphQueryEngine.ts";

export {
  knowledgeGraphTraversalEngine,
  KnowledgeGraphTraversalEngine,
} from "./KnowledgeGraphTraversalEngine.ts";

export {
  knowledgeGraphContextSelector,
  KnowledgeGraphContextSelector,
} from "./KnowledgeGraphContextSelector.ts";

export {
  knowledgeGraphProvenance,
  KnowledgeGraphProvenanceTracker,
} from "./KnowledgeGraphProvenance.ts";

export {
  knowledgeGraphConfidenceEngine,
  KnowledgeGraphConfidenceEngine,
} from "./KnowledgeGraphConfidenceEngine.ts";

export {
  knowledgeGraphTemporalEngine,
  KnowledgeGraphTemporalEngine,
} from "./KnowledgeGraphTemporalEngine.ts";

export {
  knowledgeGraphConflictResolver,
  KnowledgeGraphConflictResolver,
} from "./KnowledgeGraphConflictResolver.ts";

export {
  knowledgeGraphMemoryBridge,
  KnowledgeGraphMemoryBridge,
} from "./KnowledgeGraphMemoryBridge.ts";

export {
  knowledgeGraphContextBridge,
  KnowledgeGraphContextBridge,
} from "./KnowledgeGraphContextBridge.ts";

export {
  knowledgeGraphResearchBridge,
  KnowledgeGraphResearchBridge,
} from "./KnowledgeGraphResearchBridge.ts";

export {
  knowledgeGraphCodingBridge,
  KnowledgeGraphCodingBridge,
} from "./KnowledgeGraphCodingBridge.ts";

export {
  knowledgeGraphAgentBridge,
  KnowledgeGraphAgentBridge,
} from "./KnowledgeGraphAgentBridge.ts";

export type {
  KnowledgeNode,
  KnowledgeEdge,
  KnowledgeNodeType,
  KnowledgeRelationType,
  KnowledgeStatus,
  TemporalState,
  KnowledgeProvenance,
  KnowledgeProvenanceSourceType,
  GraphDerivedFact,
  GraphQueryOptions,
  GraphQueryResult,
  TraversalOptions,
  TraversalResult,
  TraversalStep,
  KnowledgeGraphSnapshot,
  GraphStats,
} from "./KnowledgeGraphTypes.ts";

// Phase 4 — Document RAG
export { KnowledgeManager } from "./KnowledgeManager.ts";
