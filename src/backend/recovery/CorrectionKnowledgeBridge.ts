/**
 * MYRAA — Phase 25: Self-Correction & Failure Recovery Engine
 * CorrectionKnowledgeBridge
 *
 * Connects verified recovery outcomes to Phase 24 Personal Knowledge Graph.
 * Enforces rule: "Only verified paths and solutions can become durable knowledge."
 * Applies temporal supersession (SUPERSEDED -> CURRENT) to maintain historical accuracy.
 */

import { knowledgeGraphCoordinator } from "../knowledge/index.ts";
import type {
  RecoveryResult,
  FailureEvent,
  RecoveryCandidate,
} from "./SelfCorrectionTypes.ts";

export class CorrectionKnowledgeBridge {
  /**
   * Updates the Phase 24 Personal Knowledge Graph with a verified correction.
   */
  public async syncVerifiedCorrection(params: {
    failure: FailureEvent;
    candidate: RecoveryCandidate;
    result: RecoveryResult;
    verifiedPathOrValue: string;
  }): Promise<{ nodeId: string; edgeId?: string } | null> {
    // ── 1. Verification Gate ────────────────────────────────────────────────
    if (params.result.status !== "SUCCESS") {
      return null;
    }

    const resource = params.failure.targetResource || params.failure.operation;
    const verifiedVal = params.verifiedPathOrValue;

    try {
      // ── 2. Create or Retrieve Knowledge Node for the Resource ─────────────
      const resourceNode = await knowledgeGraphCoordinator.createNode({
        type: "TECHNOLOGY",
        canonicalName: resource,
        aliases: [resource.toLowerCase()],
        attributes: {
          lastVerifiedValue: verifiedVal,
          recoveryStrategy: params.candidate.strategyId,
          lastVerifiedAt: Date.now(),
        },
        confidence: 0.95,
        importance: 0.8,
        provenance: [
          {
            source: "Phase25_Recovery",
            sourceType: "VERIFIER_CONFIRMATION",
            timestamp: Date.now(),
            confidence: 0.95,
          },
        ],
      });

      // Ensure attributes are updated on the returned node
      resourceNode.attributes = {
        ...resourceNode.attributes,
        lastVerifiedValue: verifiedVal,
        recoveryStrategy: params.candidate.strategyId,
        lastVerifiedAt: Date.now(),
      };

      // ── 3. Create or Retrieve Value Node (e.g. Executable Path or Config) ──
      const valueNode = await knowledgeGraphCoordinator.createNode({
        type: "APPLICATION",
        canonicalName: verifiedVal,
        aliases: [],
        attributes: {
          verifiedPath: verifiedVal,
          associatedResource: resource,
        },
        confidence: 0.95,
        importance: 0.7,
        provenance: [
          {
            source: "Phase25_Recovery",
            sourceType: "VERIFIER_CONFIRMATION",
            timestamp: Date.now(),
            confidence: 0.95,
          },
        ],
      });

      // ── 4. Supersede Any Existing Outdated Relationship ────────────────────
      const existingEdges = knowledgeGraphCoordinator.edges.getOutgoingEdges(resourceNode.id);
      for (const edge of existingEdges) {
        if (
          edge.relationType === "USES" ||
          edge.relationType === "USES_TECHNOLOGY" ||
          edge.relationType === "DEPENDS_ON"
        ) {
          try {
            await knowledgeGraphCoordinator.edges.supersedeEdge(edge.id);
          } catch {
            // Ignore if edge already superseded
          }
        }
      }

      // ── 5. Create Controlled Relationship Edge (CURRENT) ───────────────────
      const edge = await knowledgeGraphCoordinator.createEdge({
        sourceNodeId: resourceNode.id,
        relationType: "DEPENDS_ON",
        targetNodeId: valueNode.id,
        confidence: 0.95,
        importance: 0.8,
        provenance: [
          {
            source: "Phase25_Recovery",
            sourceType: "VERIFIER_CONFIRMATION",
            timestamp: Date.now(),
            confidence: 0.95,
          },
        ],
      });

      return {
        nodeId: resourceNode.id,
        edgeId: edge.id,
      };
    } catch (err) {
      console.warn("[CorrectionKnowledgeBridge] Could not sync to Knowledge Graph:", err);
      return null;
    }
  }
}

export const correctionKnowledgeBridge = new CorrectionKnowledgeBridge();
