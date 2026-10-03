/**
 * MYRAA — Phase 24: Personal Knowledge Graph
 * KnowledgeGraphCodingBridge
 *
 * Bridges Phase 23 Autonomous Coding Engineer with the Knowledge Graph.
 * Ingests project issues, affected files, ChangeSets, and verified fixes.
 *
 * Invariant: Only verified evidence can create VERIFIED_BY and FIXED_BY relationships.
 * Hypotheses must remain classified as INFERENCE with low confidence.
 */

import crypto from "crypto";
import type {
  KnowledgeNode,
  KnowledgeEdge,
} from "./KnowledgeGraphTypes.ts";
import { KnowledgeNodeStore, knowledgeNodeStore } from "./KnowledgeNodeStore.ts";
import { KnowledgeRelationshipResolver, knowledgeRelationshipResolver } from "./KnowledgeRelationshipResolver.ts";
import type {
  RootCauseAnalysis,
  ChangeSet,
  CodingVerificationReport,
} from "../coding/CodingEngineerTypes.ts";

export class KnowledgeGraphCodingBridge {
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
   * Ingests an engineering issue and root cause investigation.
   */
  public ingestInvestigation(
    projectName: string,
    rca: RootCauseAnalysis,
    issueTitle: string
  ): { issueNode: KnowledgeNode; edges: KnowledgeEdge[] } {
    const now = Date.now();
    const edges: KnowledgeEdge[] = [];

    // 1. Ensure project node exists
    let projNode = this._nodeStore.findByCanonicalName(projectName)[0];
    if (!projNode) {
      projNode = this._nodeStore.addNode({
        id: `kg_node_proj_${crypto.randomBytes(4).toString("hex")}`,
        type: "PROJECT",
        canonicalName: projectName,
        aliases: [],
        attributes: {},
        confidence: 0.95,
        importance: 4,
        createdAt: now,
        updatedAt: now,
        firstObservedAt: now,
        lastObservedAt: now,
        status: "ACTIVE",
        provenance: [{ source: "coding_investigation", sourceType: "CODING_INVESTIGATION", timestamp: now, confidence: 0.95 }],
        sourceMemoryIds: [],
        sourceContextIds: [],
        sourceTaskIds: [],
        sourceResearchIds: [],
      });
    }

    // 2. Create Issue node
    const isHypothesis = rca.isLowConfidenceAssumption || rca.confidence === "LOW";
    const issueNode = this._nodeStore.addNode({
      id: `kg_node_issue_${crypto.randomBytes(4).toString("hex")}`,
      type: "ISSUE",
      canonicalName: issueTitle,
      aliases: [],
      attributes: {
        problem: rca.problem,
        rootCause: rca.likelyRootCause,
        isHypothesis,
      },
      confidence: isHypothesis ? 0.45 : rca.confidenceScore || 0.85,
      importance: 4,
      createdAt: now,
      updatedAt: now,
      firstObservedAt: now,
      lastObservedAt: now,
      status: "ACTIVE",
      provenance: [
        {
          source: "root_cause_analysis",
          sourceType: isHypothesis ? "INFERENCE" : "CODING_INVESTIGATION",
          timestamp: now,
          confidence: isHypothesis ? 0.45 : rca.confidenceScore || 0.85,
          supportingEvidence: rca.likelyRootCause,
        },
      ],
      sourceMemoryIds: [],
      sourceContextIds: [],
      sourceTaskIds: [],
      sourceResearchIds: [],
    });

    // 3. Link Project -> HAS_ISSUE -> Issue
    const edge1 = this._relationshipResolver.resolveAndCreateRelationship({
      sourceNodeId: projNode.id,
      relationType: "HAS_ISSUE",
      targetNodeId: issueNode.id,
      confidence: issueNode.confidence,
      provenance: issueNode.provenance,
    });
    edges.push(edge1);

    // 4. Link Issue -> AFFECTS -> affected files
    for (const filePath of rca.affectedFiles) {
      const fileNode = this._nodeStore.addNode({
        id: `kg_node_file_${crypto.randomBytes(4).toString("hex")}`,
        type: "CODE_FILE",
        canonicalName: filePath,
        aliases: [],
        attributes: {},
        confidence: 0.95,
        importance: 3,
        createdAt: now,
        updatedAt: now,
        firstObservedAt: now,
        lastObservedAt: now,
        status: "ACTIVE",
        provenance: [{ source: "affected_files_analysis", sourceType: "CODING_INVESTIGATION", timestamp: now, confidence: 0.95 }],
        sourceMemoryIds: [],
        sourceContextIds: [],
        sourceTaskIds: [],
        sourceResearchIds: [],
      });

      const edgeAffects = this._relationshipResolver.resolveAndCreateRelationship({
        sourceNodeId: issueNode.id,
        relationType: "AFFECTS",
        targetNodeId: fileNode.id,
        confidence: 0.90,
        provenance: issueNode.provenance,
      });
      edges.push(edgeAffects);
    }

    return { issueNode, edges };
  }

  /**
   * Ingests a verified fix only after verification passes.
   */
  public ingestVerifiedFix(
    issueNodeId: string,
    changeSet: ChangeSet,
    report: CodingVerificationReport
  ): { changeSetNode?: KnowledgeNode; edges: KnowledgeEdge[] } {
    if (!report.verified || !report.testsPassed) {
      throw new Error("Cannot create VERIFIED/FIXED relationships for unverified or failing changes.");
    }

    const now = Date.now();
    const edges: KnowledgeEdge[] = [];

    // Create ChangeSet node
    const changeSetNode = this._nodeStore.addNode({
      id: `kg_node_cs_${crypto.randomBytes(4).toString("hex")}`,
      type: "DECISION",
      canonicalName: `ChangeSet ${changeSet.changeSetId.slice(0, 8)}`,
      aliases: [],
      attributes: {
        changeSetId: changeSet.changeSetId,
        approvedFiles: changeSet.approvedFiles,
      },
      confidence: 0.95,
      importance: 4,
      createdAt: now,
      updatedAt: now,
      firstObservedAt: now,
      lastObservedAt: now,
      status: "ACTIVE",
      provenance: [
        {
          source: `verification_report:${changeSet.changeSetId}`,
          sourceType: "VERIFIER_CONFIRMATION",
          timestamp: now,
          confidence: 0.95,
          supportingEvidence: `Tests passed: ${report.testsPassed}; Build passed: ${report.buildCheckPassed}`,
        },
      ],
      sourceMemoryIds: [],
      sourceContextIds: [],
      sourceTaskIds: [changeSet.taskId],
      sourceResearchIds: [],
    });

    // Link Issue -> FIXED_BY -> ChangeSet
    const fixedEdge = this._relationshipResolver.resolveAndCreateRelationship({
      sourceNodeId: issueNodeId,
      relationType: "FIXED_BY",
      targetNodeId: changeSetNode.id,
      confidence: 0.95,
      provenance: changeSetNode.provenance,
    });
    edges.push(fixedEdge);

    return { changeSetNode, edges };
  }
}

export const knowledgeGraphCodingBridge = new KnowledgeGraphCodingBridge();
