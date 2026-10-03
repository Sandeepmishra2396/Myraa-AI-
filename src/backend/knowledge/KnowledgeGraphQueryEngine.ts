/**
 * MYRAA — Phase 24: Personal Knowledge Graph
 * KnowledgeGraphQueryEngine
 *
 * Relationship-aware Query & Graph-Derived Reasoning Engine.
 * Answers questions about connected entities, technologies, issues,
 * preferences, research claims, temporal changes, and "Why do you know this?".
 */

import type {
  KnowledgeNode,
  KnowledgeEdge,
  GraphQueryOptions,
  GraphQueryResult,
  GraphDerivedFact,
  KnowledgeRelationType,
} from "./KnowledgeGraphTypes.ts";
import { KnowledgeNodeStore, knowledgeNodeStore } from "./KnowledgeNodeStore.ts";
import { KnowledgeEdgeStore, knowledgeEdgeStore } from "./KnowledgeEdgeStore.ts";
import { KnowledgeEntityResolver, knowledgeEntityResolver } from "./KnowledgeEntityResolver.ts";
import { KnowledgeGraphTemporalEngine, knowledgeGraphTemporalEngine } from "./KnowledgeGraphTemporalEngine.ts";
import { KnowledgeGraphProvenanceTracker, knowledgeGraphProvenance } from "./KnowledgeGraphProvenance.ts";

export class KnowledgeGraphQueryEngine {
  private _nodeStore: KnowledgeNodeStore;
  private _edgeStore: KnowledgeEdgeStore;
  private _entityResolver: KnowledgeEntityResolver;
  private _temporalEngine: KnowledgeGraphTemporalEngine;
  private _provenanceTracker: KnowledgeGraphProvenanceTracker;

  constructor(
    nodeStore = knowledgeNodeStore,
    edgeStore = knowledgeEdgeStore,
    entityResolver = knowledgeEntityResolver,
    temporalEngine = knowledgeGraphTemporalEngine,
    provenanceTracker = knowledgeGraphProvenance
  ) {
    this._nodeStore = nodeStore;
    this._edgeStore = edgeStore;
    this._entityResolver = entityResolver;
    this._temporalEngine = temporalEngine;
    this._provenanceTracker = provenanceTracker;
  }

  /**
   * Executes a structured or natural-language query across the Knowledge Graph.
   */
  public query(options: GraphQueryOptions): GraphQueryResult {
    const rawQuery = (options.query || "").trim();
    const lowerQuery = rawQuery.toLowerCase();

    // ── Pattern 1: "What projects am I working on?" ────────────────────────
    if (/what projects (am i|are we) working on|mere projects|active projects/i.test(lowerQuery)) {
      return this._queryUserProjects(options);
    }

    // ── Pattern 2: "Which technologies does [X] use?" / "What does [X] use?" ─
    const techMatch = lowerQuery.match(/(?:which technologies|what technologies|what tech|kya use karta hai).*?\b(?:does\s+)?([a-z0-9_\-\s]+?)(?:\s+use|\s+uses)?\??$/i) ||
      lowerQuery.match(/technologies (?:of|in|for) ([a-z0-9_\-\s]+)/i);
    if (techMatch) {
      const entityName = techMatch[1].trim();
      return this._queryEntityTechnologies(entityName, options);
    }

    // ── Pattern 3: "What issues / errors are connected to [X]?" ─────────────
    const issueMatch = lowerQuery.match(/(?:what issues|what errors|kya issues|kya problem).*?\b(?:connected to|in|for)?\s*([a-z0-9_\-\s]+)\??$/i);
    if (issueMatch) {
      const entityName = issueMatch[1].trim();
      return this._queryEntityIssues(entityName, options);
    }

    // ── Pattern 4: "What features belong to [X]?" ───────────────────────────
    const featureMatch = lowerQuery.match(/(?:what features|kya features|features of).*?\b([a-z0-9_\-\s]+)\??$/i);
    if (featureMatch) {
      const entityName = featureMatch[1].trim();
      return this._queryEntityFeatures(entityName, options);
    }

    // ── Pattern 5: "Which projects use [Technology]?" ───────────────────────
    const projByTechMatch = lowerQuery.match(/(?:which projects|konse projects).*?\b(?:use|uses)\s+([a-z0-9_\-\s]+)\??$/i);
    if (projByTechMatch) {
      const techName = projByTechMatch[1].trim();
      return this._queryProjectsUsingTechnology(techName, options);
    }

    // ── Pattern 6: "What preferences apply to [Domain]?" ────────────────────
    const prefMatch = lowerQuery.match(/(?:what preferences|kya preferences).*?\b(?:apply to|for|in)\s+([a-z0-9_\-\s]+)\??$/i);
    if (prefMatch) {
      const domain = prefMatch[1].trim();
      return this._queryPreferencesByDomain(domain, options);
    }

    // ── Pattern 7: "Why do you know this?" / Provenance Explanation ─────────
    if (/why do you know|kaise pata|tumhe kaise pata|how do you know|source of this/i.test(lowerQuery)) {
      return this._queryProvenanceExplanation(rawQuery, options);
    }

    // ── Pattern 8: "What changed?" / Historical vs Current State ────────────
    if (/what changed|kya change hua|changes|history|previous state/i.test(lowerQuery)) {
      return this._queryTemporalChanges(options);
    }

    // ── Generic Structured Filter Fallback ──────────────────────────────────
    return this._queryGeneric(options);
  }

  // ---------------------------------------------------------------------------
  // Specialized Handlers
  // ---------------------------------------------------------------------------

  private _queryUserProjects(options: GraphQueryOptions): GraphQueryResult {
    // Look for USER node
    const userNodes = this._nodeStore.findByType("USER");
    const userNode = userNodes[0];

    const nodes: KnowledgeNode[] = [];
    const edges: KnowledgeEdge[] = [];
    const derivedFacts: GraphDerivedFact[] = [];

    if (userNode) {
      const outgoing = this._edgeStore.getOutgoingEdges(userNode.id, "ACTIVE");
      for (const e of outgoing) {
        if (e.relationType === "WORKS_ON" || e.relationType === "OWNS" || e.relationType === "CREATED") {
          const target = this._nodeStore.getNode(e.targetNodeId);
          if (target && target.type === "PROJECT") {
            nodes.push(target);
            edges.push(e);
            derivedFacts.push({
              fact: `You are working on project: ${target.canonicalName}`,
              sourceNodeIds: [userNode.id, target.id],
              sourceEdgeIds: [e.id],
              reasoningType: "DIRECT_RELATION",
              confidence: e.confidence,
              provenanceExplanation: `Direct relationship (${userNode.canonicalName} ${e.relationType} ${target.canonicalName}) recorded in your knowledge graph.`,
            });
          }
        }
      }
    }

    // Also include projects found directly if user edge wasn't set yet
    if (nodes.length === 0) {
      const allProjects = this._nodeStore.findByType("PROJECT").filter((p) => p.status === "ACTIVE");
      nodes.push(...allProjects);
    }

    const explanation = nodes.length > 0
      ? `You are working on ${nodes.length} project(s): ${nodes.map((n) => n.canonicalName).join(", ")}.`
      : "No active projects found in your knowledge graph.";

    return {
      nodes,
      edges,
      derivedFacts,
      explanation,
      totalNodesMatched: nodes.length,
      totalEdgesMatched: edges.length,
    };
  }

  private _queryEntityTechnologies(entityName: string, options: GraphQueryOptions): GraphQueryResult {
    const resolution = this._entityResolver.resolveEntity(entityName);
    if (!resolution.matchedNode) {
      return {
        nodes: [],
        edges: [],
        derivedFacts: [],
        explanation: `Entity '${entityName}' was not found in your knowledge graph.`,
        totalNodesMatched: 0,
        totalEdgesMatched: 0,
      };
    }

    const targetNode = resolution.matchedNode;
    const outgoing = this._edgeStore.getOutgoingEdges(targetNode.id, "ACTIVE");

    const techRelations = new Set<KnowledgeRelationType>([
      "USES",
      "USES_TECHNOLOGY",
      "USES_FRAMEWORK",
      "USES_TOOL",
    ]);

    const nodes: KnowledgeNode[] = [];
    const edges: KnowledgeEdge[] = [];
    const derivedFacts: GraphDerivedFact[] = [];

    for (const e of outgoing) {
      if (techRelations.has(e.relationType)) {
        const techNode = this._nodeStore.getNode(e.targetNodeId);
        if (techNode) {
          nodes.push(techNode);
          edges.push(e);
          derivedFacts.push({
            fact: `${targetNode.canonicalName} uses ${techNode.canonicalName} (${techNode.type.toLowerCase()})`,
            sourceNodeIds: [targetNode.id, techNode.id],
            sourceEdgeIds: [e.id],
            reasoningType: "DIRECT_RELATION",
            confidence: e.confidence,
            provenanceExplanation: `${targetNode.canonicalName} has a direct ${e.relationType} link to ${techNode.canonicalName}.`,
          });
        }
      }
    }

    const explanation = nodes.length > 0
      ? `${targetNode.canonicalName} uses: ${nodes.map((n) => n.canonicalName).join(", ")}.`
      : `${targetNode.canonicalName} has no recorded technologies in the knowledge graph.`;

    return {
      nodes,
      edges,
      derivedFacts,
      explanation,
      totalNodesMatched: nodes.length,
      totalEdgesMatched: edges.length,
    };
  }

  private _queryEntityIssues(entityName: string, options: GraphQueryOptions): GraphQueryResult {
    const resolution = this._entityResolver.resolveEntity(entityName);
    if (!resolution.matchedNode) {
      return {
        nodes: [],
        edges: [],
        derivedFacts: [],
        explanation: `Entity '${entityName}' was not found.`,
        totalNodesMatched: 0,
        totalEdgesMatched: 0,
      };
    }

    const targetNode = resolution.matchedNode;
    const outgoing = this._edgeStore.getOutgoingEdges(targetNode.id, "ACTIVE");

    const nodes: KnowledgeNode[] = [];
    const edges: KnowledgeEdge[] = [];
    const derivedFacts: GraphDerivedFact[] = [];

    for (const e of outgoing) {
      if (e.relationType === "HAS_ISSUE") {
        const issueNode = this._nodeStore.getNode(e.targetNodeId);
        if (issueNode) {
          nodes.push(issueNode);
          edges.push(e);
          derivedFacts.push({
            fact: `Issue on ${targetNode.canonicalName}: ${issueNode.canonicalName}`,
            sourceNodeIds: [targetNode.id, issueNode.id],
            sourceEdgeIds: [e.id],
            reasoningType: "DIRECT_RELATION",
            confidence: e.confidence,
            provenanceExplanation: `${targetNode.canonicalName} HAS_ISSUE ${issueNode.canonicalName}.`,
          });
        }
      }
    }

    const explanation = nodes.length > 0
      ? `Found ${nodes.length} issue(s) connected to ${targetNode.canonicalName}: ${nodes.map((n) => n.canonicalName).join(", ")}.`
      : `No active issues recorded for ${targetNode.canonicalName}.`;

    return {
      nodes,
      edges,
      derivedFacts,
      explanation,
      totalNodesMatched: nodes.length,
      totalEdgesMatched: edges.length,
    };
  }

  private _queryEntityFeatures(entityName: string, options: GraphQueryOptions): GraphQueryResult {
    const resolution = this._entityResolver.resolveEntity(entityName);
    if (!resolution.matchedNode) {
      return {
        nodes: [],
        edges: [],
        derivedFacts: [],
        explanation: `Entity '${entityName}' was not found.`,
        totalNodesMatched: 0,
        totalEdgesMatched: 0,
      };
    }

    const targetNode = resolution.matchedNode;
    const outgoing = this._edgeStore.getOutgoingEdges(targetNode.id, "ACTIVE");

    const nodes: KnowledgeNode[] = [];
    const edges: KnowledgeEdge[] = [];
    const derivedFacts: GraphDerivedFact[] = [];

    for (const e of outgoing) {
      if (e.relationType === "HAS_FEATURE" || e.relationType === "HAS_PHASE") {
        const featureNode = this._nodeStore.getNode(e.targetNodeId);
        if (featureNode) {
          nodes.push(featureNode);
          edges.push(e);
        }
      }
    }

    const explanation = nodes.length > 0
      ? `${targetNode.canonicalName} has features: ${nodes.map((n) => n.canonicalName).join(", ")}.`
      : `No features recorded for ${targetNode.canonicalName}.`;

    return {
      nodes,
      edges,
      derivedFacts,
      explanation,
      totalNodesMatched: nodes.length,
      totalEdgesMatched: edges.length,
    };
  }

  private _queryProjectsUsingTechnology(techName: string, options: GraphQueryOptions): GraphQueryResult {
    const resolution = this._entityResolver.resolveEntity(techName);
    const techNode = resolution.matchedNode;

    const nodes: KnowledgeNode[] = [];
    const edges: KnowledgeEdge[] = [];
    const derivedFacts: GraphDerivedFact[] = [];

    if (techNode) {
      const incoming = this._edgeStore.getIncomingEdges(techNode.id, "ACTIVE");
      for (const e of incoming) {
        if (e.relationType === "USES" || e.relationType === "USES_TECHNOLOGY" || e.relationType === "USES_FRAMEWORK") {
          const projectNode = this._nodeStore.getNode(e.sourceNodeId);
          if (projectNode && projectNode.type === "PROJECT") {
            nodes.push(projectNode);
            edges.push(e);
            derivedFacts.push({
              fact: `${projectNode.canonicalName} uses ${techNode.canonicalName}`,
              sourceNodeIds: [projectNode.id, techNode.id],
              sourceEdgeIds: [e.id],
              reasoningType: "DIRECT_RELATION",
              confidence: e.confidence,
              provenanceExplanation: `${projectNode.canonicalName} ${e.relationType} ${techNode.canonicalName}`,
            });
          }
        }
      }
    }

    const explanation = nodes.length > 0
      ? `Projects using ${techName}: ${nodes.map((n) => n.canonicalName).join(", ")}.`
      : `No projects found using ${techName}.`;

    return {
      nodes,
      edges,
      derivedFacts,
      explanation,
      totalNodesMatched: nodes.length,
      totalEdgesMatched: edges.length,
    };
  }

  private _queryPreferencesByDomain(domain: string, options: GraphQueryOptions): GraphQueryResult {
    const allPreferences = this._nodeStore.findByType("PREFERENCE").filter((p) => p.status === "ACTIVE");
    const domainNorm = domain.toLowerCase();

    const matched = allPreferences.filter((p) => {
      const canon = p.canonicalName.toLowerCase();
      const cat = (p.attributes?.category as string || "").toLowerCase();
      return canon.includes(domainNorm) || cat.includes(domainNorm);
    });

    const explanation = matched.length > 0
      ? `Preferences for ${domain}: ${matched.map((m) => `${m.canonicalName}: ${JSON.stringify(m.attributes?.value ?? "")}`).join("; ")}.`
      : `No preferences recorded for ${domain}.`;

    return {
      nodes: matched,
      edges: [],
      derivedFacts: [],
      explanation,
      totalNodesMatched: matched.length,
      totalEdgesMatched: 0,
    };
  }

  private _queryProvenanceExplanation(query: string, options: GraphQueryOptions): GraphQueryResult {
    // Try to extract entity mentioned in "Why do you know X?"
    const words = query.split(/\s+/).filter((w) => w.length > 3);
    for (const w of words) {
      const res = this._entityResolver.resolveEntity(w);
      if (res.matchedNode) {
        const provExp = this._provenanceTracker.explainNode(res.matchedNode);
        return {
          nodes: [res.matchedNode],
          edges: [],
          derivedFacts: [],
          explanation: provExp.explanation,
          totalNodesMatched: 1,
          totalEdgesMatched: 0,
        };
      }
    }

    return {
      nodes: [],
      edges: [],
      derivedFacts: [],
      explanation: "Please specify which entity or relationship you'd like me to explain.",
      totalNodesMatched: 0,
      totalEdgesMatched: 0,
    };
  }

  private _queryTemporalChanges(options: GraphQueryOptions): GraphQueryResult {
    const supersededEdges = this._edgeStore.findByStatus("SUPERSEDED");
    const derivedFacts: GraphDerivedFact[] = [];
    const nodes: KnowledgeNode[] = [];

    for (const edge of supersededEdges) {
      const src = this._nodeStore.getNode(edge.sourceNodeId);
      const tgt = this._nodeStore.getNode(edge.targetNodeId);
      if (src && tgt) {
        nodes.push(src, tgt);
        derivedFacts.push({
          fact: `${src.canonicalName} previously had ${edge.relationType} ${tgt.canonicalName} (superseded)`,
          sourceNodeIds: [src.id, tgt.id],
          sourceEdgeIds: [edge.id],
          reasoningType: "TEMPORAL_STATE",
          confidence: edge.confidence,
          provenanceExplanation: `Edge ${edge.id} was superseded.`,
        });
      }
    }

    const explanation = derivedFacts.length > 0
      ? `Historical updates found: ${derivedFacts.map((f) => f.fact).join("; ")}.`
      : "No recent superseded or modified relationships recorded in the graph.";

    return {
      nodes: Array.from(new Set(nodes)),
      edges: supersededEdges,
      derivedFacts,
      explanation,
      totalNodesMatched: nodes.length,
      totalEdgesMatched: supersededEdges.length,
    };
  }

  private _queryGeneric(options: GraphQueryOptions): GraphQueryResult {
    let nodes = this._nodeStore.getAllNodes();

    if (options.nodeTypes && options.nodeTypes.length > 0) {
      const typeSet = new Set(options.nodeTypes);
      nodes = nodes.filter((n) => typeSet.has(n.type));
    }

    if (options.filter?.status) {
      nodes = nodes.filter((n) => n.status === options.filter!.status);
    } else if (!options.includeSuperseded) {
      nodes = nodes.filter((n) => n.status === "ACTIVE");
    }

    if (options.maxResults) {
      nodes = nodes.slice(0, options.maxResults);
    }

    return {
      nodes,
      edges: [],
      derivedFacts: [],
      explanation: `Found ${nodes.length} matching nodes.`,
      totalNodesMatched: nodes.length,
      totalEdgesMatched: 0,
    };
  }
}

export const knowledgeGraphQueryEngine = new KnowledgeGraphQueryEngine();
