/**
 * MYRAA — Phase 24: Personal Knowledge Graph
 * KnowledgeGraphTypes
 *
 * Core type system for MYRAA's structured, relationship-aware Personal Knowledge Graph.
 * Sits as a relationship layer above Phase 18 Memory and Phase 19 Context.
 *
 * Invariant: Never stores raw secrets, tokens, or credentials in node attributes or edges.
 */

// ---------------------------------------------------------------------------
// 1. Node Types
// ---------------------------------------------------------------------------

export type KnowledgeNodeType =
  | "USER"
  | "PERSON"
  | "PROJECT"
  | "SUBPROJECT"
  | "PHASE"
  | "FEATURE"
  | "TASK"
  | "GOAL"
  | "SKILL"
  | "TECHNOLOGY"
  | "LANGUAGE"
  | "FRAMEWORK"
  | "TOOL"
  | "PREFERENCE"
  | "WORKFLOW"
  | "COMMAND_PATTERN"
  | "TOPIC"
  | "KNOWLEDGE"
  | "DOCUMENT"
  | "SOURCE"
  | "RESEARCH_CLAIM"
  | "ISSUE"
  | "ERROR"
  | "CODE_FILE"
  | "CODE_SYMBOL"
  | "AGENT"
  | "DECISION"
  | "EVENT"
  | "APPLICATION"
  | "DEVICE";

// ---------------------------------------------------------------------------
// 2. Controlled Relationship Types
// ---------------------------------------------------------------------------

export type KnowledgeRelationType =
  | "OWNS"
  | "WORKS_ON"
  | "CREATED"
  | "BUILT"
  | "CONTAINS"
  | "PART_OF"
  | "HAS_PHASE"
  | "HAS_FEATURE"
  | "HAS_TASK"
  | "HAS_GOAL"
  | "HAS_ISSUE"
  | "HAS_SKILL"
  | "HAS_PREFERENCE"
  | "PREFERS"
  | "USES"
  | "USES_TECHNOLOGY"
  | "USES_FRAMEWORK"
  | "USES_TOOL"
  | "DEPENDS_ON"
  | "RELATED_TO"
  | "LEARNING"
  | "LEARNED"
  | "INTERESTED_IN"
  | "WORKFLOW_FOR"
  | "COMMAND_FOR"
  | "CAUSED_BY"
  | "FIXED_BY"
  | "INVESTIGATED_BY"
  | "VERIFIED_BY"
  | "DOCUMENTED_BY"
  | "SUPPORTED_BY"
  | "CONTRADICTS"
  | "SUPERSEDES"
  | "SIMILAR_TO"
  | "DERIVED_FROM"
  | "MENTIONED_IN"
  | "OBSERVED_IN"
  | "BLOCKED_BY"
  | "COMPLETED_BY"
  | "RELATED_TO_PHASE"
  | "APPLIES_TO"
  | "COMPARES_WITH"
  | "AFFECTS"
  | "INVOLVES"
  | "FREQUENTLY_WORKS_ON";

export const ALLOWED_RELATION_TYPES = new Set<KnowledgeRelationType>([
  "OWNS",
  "WORKS_ON",
  "CREATED",
  "BUILT",
  "CONTAINS",
  "PART_OF",
  "HAS_PHASE",
  "HAS_FEATURE",
  "HAS_TASK",
  "HAS_GOAL",
  "HAS_ISSUE",
  "HAS_SKILL",
  "HAS_PREFERENCE",
  "PREFERS",
  "USES",
  "USES_TECHNOLOGY",
  "USES_FRAMEWORK",
  "USES_TOOL",
  "DEPENDS_ON",
  "RELATED_TO",
  "LEARNING",
  "LEARNED",
  "INTERESTED_IN",
  "WORKFLOW_FOR",
  "COMMAND_FOR",
  "CAUSED_BY",
  "FIXED_BY",
  "INVESTIGATED_BY",
  "VERIFIED_BY",
  "DOCUMENTED_BY",
  "SUPPORTED_BY",
  "CONTRADICTS",
  "SUPERSEDES",
  "SIMILAR_TO",
  "DERIVED_FROM",
  "MENTIONED_IN",
  "OBSERVED_IN",
  "BLOCKED_BY",
  "COMPLETED_BY",
  "RELATED_TO_PHASE",
  "APPLIES_TO",
  "COMPARES_WITH",
  "AFFECTS",
  "INVOLVES",
  "FREQUENTLY_WORKS_ON",
]);

// ---------------------------------------------------------------------------
// 3. Status & Lifecycle
// ---------------------------------------------------------------------------

export type KnowledgeStatus = "ACTIVE" | "SUPERSEDED" | "ARCHIVED";

export type TemporalState = "CURRENT" | "HISTORICAL" | "PLANNED" | "EXPIRED" | "SUPERSEDED";

// ---------------------------------------------------------------------------
// 4. Provenance & Evidence Types
// ---------------------------------------------------------------------------

export type KnowledgeProvenanceSourceType =
  | "EXPLICIT_USER"
  | "EXPLICIT_CORRECTION"
  | "OBSERVED_PROJECT_DATA"
  | "OBSERVED_CONTEXT"
  | "RESEARCH_EVIDENCE"
  | "CODING_INVESTIGATION"
  | "VERIFIER_CONFIRMATION"
  | "INFERENCE"
  | "DERIVED_RELATIONSHIP"
  | "SYSTEM_DEFAULT";

export interface KnowledgeProvenance {
  source: string;
  sourceType: KnowledgeProvenanceSourceType;
  timestamp: number;
  confidence: number;
  supportingEvidence?: string;
  sourceId?: string;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 5. Knowledge Node
// ---------------------------------------------------------------------------

export interface KnowledgeNode {
  id: string;
  type: KnowledgeNodeType;
  canonicalName: string;
  aliases: string[];
  attributes: Record<string, unknown>;
  confidence: number;
  importance: number;
  createdAt: number;
  updatedAt: number;
  firstObservedAt: number;
  lastObservedAt: number;
  validFrom?: number;
  validUntil?: number;
  status: KnowledgeStatus;
  provenance: KnowledgeProvenance[];
  sourceMemoryIds: string[];
  sourceContextIds: string[];
  sourceTaskIds: string[];
  sourceResearchIds: string[];
}

// ---------------------------------------------------------------------------
// 6. Knowledge Edge
// ---------------------------------------------------------------------------

export interface KnowledgeEdge {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  relationType: KnowledgeRelationType;
  confidence: number;
  importance: number;
  weight: number;
  createdAt: number;
  updatedAt: number;
  validFrom?: number;
  validUntil?: number;
  status: KnowledgeStatus;
  provenance: KnowledgeProvenance[];
  sourceMemoryIds: string[];
  sourceContextIds: string[];
}

// ---------------------------------------------------------------------------
// 7. Graph-Derived Fact
// ---------------------------------------------------------------------------

export interface GraphDerivedFact {
  fact: string;
  sourceNodeIds: string[];
  sourceEdgeIds: string[];
  reasoningType: "DIRECT_RELATION" | "TRANSITIVE_TRAVERSAL" | "TEMPORAL_STATE" | "AGGREGATE";
  confidence: number;
  provenanceExplanation: string;
}

// ---------------------------------------------------------------------------
// 8. Query & Traversal Types
// ---------------------------------------------------------------------------

export interface GraphQueryFilter {
  types?: KnowledgeNodeType[];
  relationTypes?: KnowledgeRelationType[];
  status?: KnowledgeStatus;
  temporal?: TemporalState;
  minConfidence?: number;
  atTimestamp?: number;
  project?: string;
  tag?: string;
}

export interface GraphQueryOptions {
  query?: string;
  nodeTypes?: KnowledgeNodeType[];
  relationTypes?: KnowledgeRelationType[];
  filter?: GraphQueryFilter;
  maxResults?: number;
  includeSuperseded?: boolean;
}

export interface GraphQueryResult {
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
  derivedFacts: GraphDerivedFact[];
  explanation: string;
  totalNodesMatched: number;
  totalEdgesMatched: number;
}

export interface TraversalOptions {
  startNodeId: string;
  maxDepth?: number; // Default 3, max 6
  direction?: "OUTGOING" | "INCOMING" | "BOTH";
  relationTypes?: KnowledgeRelationType[];
  nodeTypes?: KnowledgeNodeType[];
  status?: KnowledgeStatus;
  maxNodes?: number;
}

export interface TraversalStep {
  fromNode: KnowledgeNode;
  edge: KnowledgeEdge;
  toNode: KnowledgeNode;
  depth: number;
}

export interface TraversalResult {
  startNode: KnowledgeNode | null;
  visitedNodes: KnowledgeNode[];
  traversedEdges: KnowledgeEdge[];
  steps: TraversalStep[];
  maxDepthReached: number;
  hasCycles: boolean;
}

// ---------------------------------------------------------------------------
// 9. Snapshot & Stats
// ---------------------------------------------------------------------------

export interface KnowledgeGraphSnapshot {
  snapshotId: string;
  timestamp: number;
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
  metadata: {
    nodeCount: number;
    edgeCount: number;
    reason?: string;
  };
}

export interface GraphStats {
  nodeCount: number;
  edgeCount: number;
  activeNodes: number;
  activeEdges: number;
  supersededNodes: number;
  supersededEdges: number;
  nodesByType: Record<string, number>;
  edgesByRelation: Record<string, number>;
  avgConfidence: number;
  lastUpdated: number;
}
