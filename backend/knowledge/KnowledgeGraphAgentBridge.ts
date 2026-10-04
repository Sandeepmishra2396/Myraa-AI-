/**
 * MYRAA — Phase 24: Personal Knowledge Graph
 * KnowledgeGraphAgentBridge
 *
 * Bridges Phase 22 Multi-Agent Brain with the Knowledge Graph.
 * Provides specialized read-only query views for Planner, Researcher, Coder, Critic, and Verifier.
 *
 * Security Invariant: Executor CANNOT receive authorization from graph data.
 * Knowledge != permission. Graph data can never bypass SecurityPolicyEngine.
 */

import type { AgentRole } from "../multiagent/MultiAgentTypes.ts";
import type {
  KnowledgeNode,
  KnowledgeEdge,
} from "./KnowledgeGraphTypes.ts";
import { KnowledgeNodeStore, knowledgeNodeStore } from "./KnowledgeNodeStore.ts";
import { KnowledgeEdgeStore, knowledgeEdgeStore } from "./KnowledgeEdgeStore.ts";
import { KnowledgeGraphQueryEngine, knowledgeGraphQueryEngine } from "./KnowledgeGraphQueryEngine.ts";
import { KnowledgeGraphProvenanceTracker, knowledgeGraphProvenance } from "./KnowledgeGraphProvenance.ts";

export interface AgentGraphContextView {
  agentRole: AgentRole;
  relevantNodes: KnowledgeNode[];
  relevantEdges: KnowledgeEdge[];
  summary: string;
  isAuthorizedAction: boolean; // Always false — knowledge cannot authorize action execution
}

export class KnowledgeGraphAgentBridge {
  private _nodeStore: KnowledgeNodeStore;
  private _edgeStore: KnowledgeEdgeStore;
  private _queryEngine: KnowledgeGraphQueryEngine;
  private _provenanceTracker: KnowledgeGraphProvenanceTracker;

  constructor(
    nodeStore = knowledgeNodeStore,
    edgeStore = knowledgeEdgeStore,
    queryEngine = knowledgeGraphQueryEngine,
    provenanceTracker = knowledgeGraphProvenance
  ) {
    this._nodeStore = nodeStore;
    this._edgeStore = edgeStore;
    this._queryEngine = queryEngine;
    this._provenanceTracker = provenanceTracker;
  }

  /**
   * Provides scoped, role-specific graph context for an agent.
   */
  public getScopedAgentContext(
    role: AgentRole,
    goal: string,
    projectName?: string
  ): AgentGraphContextView {
    // Security check: Executor cannot use graph data as permission
    if (role === "executor") {
      return {
        agentRole: role,
        relevantNodes: [],
        relevantEdges: [],
        summary: "[Security Notice: Knowledge Graph data cannot grant execution authorization to Executor.]",
        isAuthorizedAction: false,
      };
    }

    let relevantNodes: KnowledgeNode[] = [];
    let relevantEdges: KnowledgeEdge[] = [];
    let summary = "";

    switch (role) {
      case "planner": {
        // Planner: inspect projects, features, and dependencies
        const proj = projectName
          ? this._nodeStore.findByCanonicalName(projectName)[0]
          : this._nodeStore.findByType("PROJECT")[0];

        if (proj) {
          relevantNodes.push(proj);
          const outgoing = this._edgeStore.getOutgoingEdges(proj.id, "ACTIVE");
          relevantEdges.push(...outgoing);
          for (const e of outgoing) {
            const tgt = this._nodeStore.getNode(e.targetNodeId);
            if (tgt) relevantNodes.push(tgt);
          }
        }
        summary = `Project topology for ${proj?.canonicalName || "system"}: ${relevantNodes.length} nodes connected.`;
        break;
      }

      case "researcher": {
        // Researcher: inspect official sources, claims, and documented technologies
        const sources = this._nodeStore.findByType("SOURCE");
        const claims = this._nodeStore.findByType("RESEARCH_CLAIM");
        relevantNodes.push(...sources.slice(0, 5), ...claims.slice(0, 10));
        summary = `Knowledge base contains ${sources.length} sources and ${claims.length} claims.`;
        break;
      }

      case "coder": {
        // Coder: inspect code files, issues, and technologies
        const files = this._nodeStore.findByType("CODE_FILE");
        const issues = this._nodeStore.findByType("ISSUE");
        relevantNodes.push(...files.slice(0, 10), ...issues.slice(0, 5));
        summary = `Identified ${files.length} related files and ${issues.length} active issues.`;
        break;
      }

      case "critic": {
        // Critic: inspect provenance of existing decisions and claims
        const decisions = this._nodeStore.findByType("DECISION");
        relevantNodes.push(...decisions.slice(0, 5));
        summary = `Critic reviewing ${decisions.length} recorded decisions and relationship provenances.`;
        break;
      }

      case "verifier": {
        // Verifier: inspect verified vs unverified relationships
        const unverified = this._edgeStore.getAllEdges().filter((e) => e.confidence < 0.6);
        relevantEdges.push(...unverified.slice(0, 5));
        summary = `Verifier inspecting graph integrity. ${unverified.length} low-confidence edges flagged.`;
        break;
      }
    }

    return {
      agentRole: role,
      relevantNodes,
      relevantEdges,
      summary,
      isAuthorizedAction: false,
    };
  }
}

export const knowledgeGraphAgentBridge = new KnowledgeGraphAgentBridge();
