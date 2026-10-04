/**
 * MYRAA — Phase 24: Personal Knowledge Graph
 * KnowledgeGraphResearchBridge
 *
 * Bridges Phase 8 Advanced Browser Research with the Knowledge Graph.
 * Ingests validated research claims, official sources, and code comparisons.
 *
 * Invariant: External content remains UNTRUSTED_EXTERNAL_CONTENT.
 * Claims are stored as knowledge facts, never as system instructions.
 */

import crypto from "crypto";
import type {
  KnowledgeNode,
  KnowledgeEdge,
} from "./KnowledgeGraphTypes.ts";
import { KnowledgeNodeStore, knowledgeNodeStore } from "./KnowledgeNodeStore.ts";
import { KnowledgeRelationshipResolver, knowledgeRelationshipResolver } from "./KnowledgeRelationshipResolver.ts";
import type {
  ResearchClaim,
  ResearchSource,
  ComparisonReport,
} from "../research/AdvancedResearchTypes.ts";

export class KnowledgeGraphResearchBridge {
  private _nodeStore: KnowledgeNodeStore;
  private _relationshipResolver: KnowledgeRelationshipResolver;

  constructor(
    nodeStore = knowledgeNodeStore,
    relationshipResolver = knowledgeRelationshipResolver
  ) {
    this._nodeStore = nodeStore;
    this._relationshipResolver = relationshipResolver;
  }

  /**
   * Ingests a validated research claim and links it to its documentation source.
   */
  public ingestResearchClaim(
    claim: ResearchClaim,
    source?: ResearchSource
  ): { claimNode: KnowledgeNode; sourceNode?: KnowledgeNode; edge?: KnowledgeEdge } {
    const now = Date.now();

    // 1. Create or get Claim Node
    const claimNode: KnowledgeNode = {
      id: `kg_node_claim_${crypto.randomBytes(4).toString("hex")}`,
      type: "RESEARCH_CLAIM",
      canonicalName: claim.claim.slice(0, 100),
      aliases: [],
      attributes: {
        evidence: claim.evidence,
        sourceUrl: claim.sourceUrl,
        version: claim.version,
        publishedAt: claim.publishedAt,
      },
      confidence: claim.confidence,
      importance: 3,
      createdAt: now,
      updatedAt: now,
      firstObservedAt: claim.extractedAt || now,
      lastObservedAt: now,
      status: "ACTIVE",
      provenance: [
        {
          source: claim.sourceUrl,
          sourceType: "RESEARCH_EVIDENCE",
          timestamp: now,
          confidence: claim.confidence,
          supportingEvidence: claim.evidence,
          sourceId: claim.id,
        },
      ],
      sourceMemoryIds: [],
      sourceContextIds: [],
      sourceTaskIds: [],
      sourceResearchIds: [claim.id],
    };

    const storedClaimNode = this._nodeStore.addNode(claimNode);

    // 2. Create Source Node if provided
    let storedSourceNode: KnowledgeNode | undefined;
    let edge: KnowledgeEdge | undefined;

    if (source) {
      const sourceNode: KnowledgeNode = {
        id: `kg_node_source_${crypto.randomBytes(4).toString("hex")}`,
        type: "SOURCE",
        canonicalName: source.title || source.url,
        aliases: [source.url],
        attributes: {
          url: source.url,
          sourceType: source.type,
          reliability: source.reliability.composite,
        },
        confidence: source.reliability.composite,
        importance: 4,
        createdAt: now,
        updatedAt: now,
        firstObservedAt: source.fetchedAt || now,
        lastObservedAt: now,
        status: "ACTIVE",
        provenance: [
          {
            source: source.url,
            sourceType: "RESEARCH_EVIDENCE",
            timestamp: now,
            confidence: source.reliability.composite,
          },
        ],
        sourceMemoryIds: [],
        sourceContextIds: [],
        sourceTaskIds: [],
        sourceResearchIds: [source.id],
      };

      storedSourceNode = this._nodeStore.addNode(sourceNode);

      // Link Claim -> SUPPORTED_BY -> Source
      edge = this._relationshipResolver.resolveAndCreateRelationship({
        sourceNodeId: storedClaimNode.id,
        relationType: "SUPPORTED_BY",
        targetNodeId: storedSourceNode.id,
        confidence: claim.confidence,
        provenance: [
          {
            source: source.url,
            sourceType: "RESEARCH_EVIDENCE",
            timestamp: now,
            confidence: claim.confidence,
            supportingEvidence: `Claim supported by official source ${source.title}`,
          },
        ],
        sourceResearchIds: [claim.id],
      });
    }

    return {
      claimNode: storedClaimNode,
      sourceNode: storedSourceNode,
      edge,
    };
  }

  /**
   * Ingests a comparison report linking research requirements to project implementation files.
   */
  public ingestComparisonReport(
    report: ComparisonReport,
    projectName: string
  ): { nodesCreated: number; edgesCreated: number } {
    let nodesCreated = 0;
    let edgesCreated = 0;
    const now = Date.now();

    const projNodes = this._nodeStore.findByCanonicalName(projectName);
    const projNode = projNodes[0];

    for (const finding of report.findings) {
      if (finding.implementationLocation && finding.implementationLocation !== "Not found in project files") {
        // Create code file node
        const fileNode: KnowledgeNode = {
          id: `kg_node_file_${crypto.randomBytes(4).toString("hex")}`,
          type: "CODE_FILE",
          canonicalName: finding.implementationLocation,
          aliases: [],
          attributes: { snippet: finding.implementationSnippet },
          confidence: 0.90,
          importance: 3,
          createdAt: now,
          updatedAt: now,
          firstObservedAt: now,
          lastObservedAt: now,
          status: "ACTIVE",
          provenance: [
            {
              source: `docs_comparison:${report.reportId}`,
              sourceType: "OBSERVED_PROJECT_DATA",
              timestamp: now,
              confidence: 0.90,
              supportingEvidence: finding.explanation,
            },
          ],
          sourceMemoryIds: [],
          sourceContextIds: [],
          sourceTaskIds: [],
          sourceResearchIds: [finding.requirementId],
        };

        const storedFile = this._nodeStore.addNode(fileNode);
        nodesCreated++;

        if (projNode) {
          this._relationshipResolver.resolveAndCreateRelationship({
            sourceNodeId: projNode.id,
            relationType: "CONTAINS",
            targetNodeId: storedFile.id,
            confidence: 0.95,
            provenance: [
              {
                source: "project_structure",
                sourceType: "OBSERVED_PROJECT_DATA",
                timestamp: now,
                confidence: 0.95,
              },
            ],
          });
          edgesCreated++;
        }
      }
    }

    return { nodesCreated, edgesCreated };
  }
}

export const knowledgeGraphResearchBridge = new KnowledgeGraphResearchBridge();
