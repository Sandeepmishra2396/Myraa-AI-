/**
 * MYRAA — Phase 24: Personal Knowledge Graph
 * KnowledgeGraphProvenance
 *
 * Implements "Why do you know this?" provenance reporting.
 * Inspects the exact audit trail, sources, timestamps, and confidence
 * behind any node, edge, or derived fact in the Knowledge Graph.
 *
 * Invariant: NEVER fabricate provenance. If unknown, report as UNVERIFIED.
 */

import type {
  KnowledgeNode,
  KnowledgeEdge,
  KnowledgeProvenance,
  GraphDerivedFact,
} from "./KnowledgeGraphTypes.ts";

export interface ProvenanceExplanation {
  entityOrRelationship: string;
  sourceType: string;
  sourceDescription: string;
  timestamp: number;
  formattedDate: string;
  confidence: number;
  confidenceTier: "HIGH" | "MEDIUM" | "LOW";
  supportingEvidence?: string;
  explanation: string;
}

export class KnowledgeGraphProvenanceTracker {
  /**
   * Explains why MYRAA knows a particular node.
   */
  public explainNode(node: KnowledgeNode): ProvenanceExplanation {
    const primaryProv = node.provenance && node.provenance.length > 0
      ? node.provenance[node.provenance.length - 1]
      : null;

    if (!primaryProv) {
      return {
        entityOrRelationship: `${node.canonicalName} (${node.type})`,
        sourceType: "UNVERIFIED",
        sourceDescription: "No detailed provenance recorded",
        timestamp: node.createdAt,
        formattedDate: new Date(node.createdAt).toLocaleString(),
        confidence: node.confidence,
        confidenceTier: node.confidence >= 0.85 ? "HIGH" : node.confidence >= 0.5 ? "MEDIUM" : "LOW",
        explanation: `I have a record of ${node.canonicalName} (${node.type}), but the exact original source was not cataloged.`,
      };
    }

    const tier = primaryProv.confidence >= 0.85 ? "HIGH" : primaryProv.confidence >= 0.5 ? "MEDIUM" : "LOW";
    const dateStr = new Date(primaryProv.timestamp).toLocaleString();

    let explanation = `I know about ${node.canonicalName} (${node.type}) because it was `;
    switch (primaryProv.sourceType) {
      case "EXPLICIT_USER":
        explanation += `explicitly stated by you on ${dateStr}.`;
        break;
      case "EXPLICIT_CORRECTION":
        explanation += `provided in a direct correction on ${dateStr}.`;
        break;
      case "OBSERVED_PROJECT_DATA":
        explanation += `observed directly in your project configuration on ${dateStr}.`;
        break;
      case "CODING_INVESTIGATION":
        explanation += `discovered during a software engineering investigation on ${dateStr}.`;
        break;
      case "VERIFIER_CONFIRMATION":
        explanation += `verified by test and build evidence on ${dateStr}.`;
        break;
      case "RESEARCH_EVIDENCE":
        explanation += `extracted from authoritative documentation during technical research on ${dateStr}.`;
        break;
      case "OBSERVED_CONTEXT":
        explanation += `observed in your active desktop/workspace context on ${dateStr}.`;
        break;
      case "DERIVED_RELATIONSHIP":
        explanation += `derived from connected relationships in your knowledge graph on ${dateStr}.`;
        break;
      case "INFERENCE":
        explanation += `inferred as a hypothesis based on observed patterns on ${dateStr} (low confidence).`;
        break;
      default:
        explanation += `recorded from ${primaryProv.source} on ${dateStr}.`;
    }

    if (primaryProv.supportingEvidence) {
      explanation += ` Evidence: "${primaryProv.supportingEvidence}".`;
    }

    return {
      entityOrRelationship: `${node.canonicalName} (${node.type})`,
      sourceType: primaryProv.sourceType,
      sourceDescription: primaryProv.source,
      timestamp: primaryProv.timestamp,
      formattedDate: dateStr,
      confidence: primaryProv.confidence,
      confidenceTier: tier,
      supportingEvidence: primaryProv.supportingEvidence,
      explanation,
    };
  }

  /**
   * Explains why MYRAA knows a relationship between two nodes.
   */
  public explainEdge(
    edge: KnowledgeEdge,
    sourceNodeName: string,
    targetNodeName: string
  ): ProvenanceExplanation {
    const primaryProv = edge.provenance && edge.provenance.length > 0
      ? edge.provenance[edge.provenance.length - 1]
      : null;

    const relName = `${sourceNodeName} ${edge.relationType} ${targetNodeName}`;

    if (!primaryProv) {
      return {
        entityOrRelationship: relName,
        sourceType: "UNVERIFIED",
        sourceDescription: "No detailed provenance recorded",
        timestamp: edge.createdAt,
        formattedDate: new Date(edge.createdAt).toLocaleString(),
        confidence: edge.confidence,
        confidenceTier: edge.confidence >= 0.85 ? "HIGH" : edge.confidence >= 0.5 ? "MEDIUM" : "LOW",
        explanation: `I have a relationship '${relName}', but the exact original source was not cataloged.`,
      };
    }

    const tier = primaryProv.confidence >= 0.85 ? "HIGH" : primaryProv.confidence >= 0.5 ? "MEDIUM" : "LOW";
    const dateStr = new Date(primaryProv.timestamp).toLocaleString();

    let explanation = `I know that ${sourceNodeName} ${edge.relationType} ${targetNodeName} because `;
    switch (primaryProv.sourceType) {
      case "EXPLICIT_USER":
        explanation += `you explicitly mentioned it on ${dateStr}.`;
        break;
      case "EXPLICIT_CORRECTION":
        explanation += `it was clarified in a user correction on ${dateStr}.`;
        break;
      case "OBSERVED_PROJECT_DATA":
        explanation += `it was verified directly from project files and configuration on ${dateStr}.`;
        break;
      case "CODING_INVESTIGATION":
        explanation += `it was confirmed during an autonomous coding investigation on ${dateStr}.`;
        break;
      case "VERIFIER_CONFIRMATION":
        explanation += `it was verified by build/test execution output on ${dateStr}.`;
        break;
      case "RESEARCH_EVIDENCE":
        explanation += `it was cited in technical documentation on ${dateStr}.`;
        break;
      case "DERIVED_RELATIONSHIP":
        explanation += `it was derived through relationship reasoning in your knowledge graph on ${dateStr}.`;
        break;
      case "INFERENCE":
        explanation += `it was inferred as a probable connection on ${dateStr} (confidence: ${(edge.confidence * 100).toFixed(0)}%).`;
        break;
      default:
        explanation += `it was logged from ${primaryProv.source} on ${dateStr}.`;
    }

    if (primaryProv.supportingEvidence) {
      explanation += ` Evidence: "${primaryProv.supportingEvidence}".`;
    }

    return {
      entityOrRelationship: relName,
      sourceType: primaryProv.sourceType,
      sourceDescription: primaryProv.source,
      timestamp: primaryProv.timestamp,
      formattedDate: dateStr,
      confidence: primaryProv.confidence,
      confidenceTier: tier,
      supportingEvidence: primaryProv.supportingEvidence,
      explanation,
    };
  }

  /**
   * Explains a graph-derived fact.
   */
  public explainDerivedFact(fact: GraphDerivedFact): ProvenanceExplanation {
    return {
      entityOrRelationship: fact.fact,
      sourceType: "DERIVED_RELATIONSHIP",
      sourceDescription: `Graph traversal (${fact.reasoningType}) across nodes [${fact.sourceNodeIds.join(", ")}] and edges [${fact.sourceEdgeIds.join(", ")}]`,
      timestamp: Date.now(),
      formattedDate: new Date().toLocaleString(),
      confidence: fact.confidence,
      confidenceTier: fact.confidence >= 0.85 ? "HIGH" : fact.confidence >= 0.5 ? "MEDIUM" : "LOW",
      explanation: fact.provenanceExplanation,
    };
  }
}

export const knowledgeGraphProvenance = new KnowledgeGraphProvenanceTracker();
