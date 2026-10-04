/**
 * MYRAA — Phase 24: Personal Knowledge Graph
 * KnowledgeGraphExtractor
 *
 * Extracts structured entities and relationships from qualified user inputs,
 * Phase 18 CognitiveMemories, Phase 23 coding events, and Phase 8 research.
 *
 * Enforces Graph Hygiene:
 *   - Strictly rejects casual conversation, greetings, filler, temporary chatter.
 *   - Only qualified, meaningful signals produce nodes and edges.
 *   - Never silently invents facts.
 */

import crypto from "crypto";
import type {
  KnowledgeNode,
  KnowledgeEdge,
  KnowledgeNodeType,
  KnowledgeProvenance,
} from "./KnowledgeGraphTypes.ts";
import { KnowledgeNodeStore, knowledgeNodeStore } from "./KnowledgeNodeStore.ts";
import { KnowledgeRelationshipResolver, knowledgeRelationshipResolver } from "./KnowledgeRelationshipResolver.ts";
import { KnowledgeEntityResolver, knowledgeEntityResolver } from "./KnowledgeEntityResolver.ts";
import { LearningSignalDetector } from "../brain/LearningSignalDetector.ts";
import type { CognitiveMemory } from "../brain/CognitiveTypes.ts";

export interface ExtractionResult {
  nodesCreated: KnowledgeNode[];
  edgesCreated: KnowledgeEdge[];
  wasRejectedAsCasual: boolean;
  rejectionReason?: string;
}

export class KnowledgeGraphExtractor {
  private _nodeStore: KnowledgeNodeStore;
  private _relationshipResolver: KnowledgeRelationshipResolver;
  private _entityResolver: KnowledgeEntityResolver;
  private _signalDetector: LearningSignalDetector;

  // Patterns for casual chat that MUST NOT become permanent graph knowledge
  private static readonly CASUAL_CHAT_PATTERNS = [
    /^(hi|hello|hey|namaste|pranam|good\s+(morning|afternoon|evening|night)|wassup|yo)\b/i,
    /^(kya\s+haal|kaise\s+ho|how\s+are\s+you|what's\s+up|kya\s+chal\s+raha)\b/i,
    /^(ok|okay|theek\s+hai|accha|shukriya|thanks|thank\s+you|bye|alvida)\b/i,
    /\b(weather|mausam|barish|temperature|rain|time\s+kya\s+hua)\b/i,
    /^(tell\s+me\s+a\s+joke|kuch\s+batao|sing\s+a\s+song|what is the weather)\b/i,
  ];

  constructor(
    nodeStore = knowledgeNodeStore,
    relationshipResolver = knowledgeRelationshipResolver,
    entityResolver = knowledgeEntityResolver,
    signalDetector = new LearningSignalDetector()
  ) {
    this._nodeStore = nodeStore;
    this._relationshipResolver = relationshipResolver;
    this._entityResolver = entityResolver;
    this._signalDetector = signalDetector;
  }

  /**
   * Evaluates if a raw user utterance is casual chatter that should be ignored.
   */
  public isCasualChatter(utterance: string): boolean {
    const trimmed = (utterance || "").trim().toLowerCase();
    if (trimmed.length < 3) return true;

    for (const pattern of KnowledgeGraphExtractor.CASUAL_CHAT_PATTERNS) {
      if (pattern.test(trimmed)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Extracts graph knowledge from a raw user utterance.
   */
  public extractFromUtterance(utterance: string, timestamp = Date.now()): ExtractionResult {
    const trimmed = (utterance || "").trim();

    // ── Hygiene Check 1: Reject Casual Chatter ──────────────────────────────
    if (this.isCasualChatter(trimmed)) {
      return {
        nodesCreated: [],
        edgesCreated: [],
        wasRejectedAsCasual: true,
        rejectionReason: "Utterance classified as casual greeting, filler, or ephemeral inquiry.",
      };
    }

    const nodesCreated: KnowledgeNode[] = [];
    const edgesCreated: KnowledgeEdge[] = [];

    // Ensure USER node exists
    const userNode = this._ensureUserNode(timestamp);

    // ── 1. Pattern: "I am working on [Project]" / "Mera project [X] hai" ─────
    const workOnMatch = trimmed.match(/(?:i am working on|working on|mera project|main kaam kar raha hoon|kaam kar rahe hain)\s+([a-z0-9_\-\s]+?)(?:\.|$|hai)/i);
    if (workOnMatch) {
      const rawProj = workOnMatch[1].trim();
      if (rawProj.length > 1 && !this.isCasualChatter(rawProj)) {
        const projNode = this._getOrCreateNode(rawProj, "PROJECT", "EXPLICIT_USER", trimmed, timestamp);
        nodesCreated.push(projNode);

        const edge = this._relationshipResolver.resolveAndCreateRelationship({
          sourceNodeId: userNode.id,
          relationType: "WORKS_ON",
          targetNodeId: projNode.id,
          confidence: 0.95,
          provenance: [
            {
              source: "user_utterance",
              sourceType: "EXPLICIT_USER",
              timestamp,
              confidence: 0.95,
              supportingEvidence: trimmed,
            },
          ],
        });
        edgesCreated.push(edge);
      }
    }

    // ── 2. Pattern: "[Project] uses [Tech1] and [Tech2]" ─────────────────────
    const usesMatch = trimmed.match(/([a-z0-9_\-]+)\s+(?:uses|uses technology|par chalta hai|me use hota hai|me use karta hai)\s+([a-z0-9_\-,\s]+)/i);
    if (usesMatch) {
      const rawProj = usesMatch[1].trim();
      const rawTechs = usesMatch[2].split(/,|\band\b|\baur\b/i).map((t) => t.trim()).filter((t) => t.length > 1);

      if (rawProj && rawTechs.length > 0) {
        const projNode = this._getOrCreateNode(rawProj, "PROJECT", "EXPLICIT_USER", trimmed, timestamp);
        nodesCreated.push(projNode);

        for (const tech of rawTechs) {
          const techType = this._classifyTechType(tech);
          const techNode = this._getOrCreateNode(tech, techType, "EXPLICIT_USER", trimmed, timestamp);
          nodesCreated.push(techNode);

          const edge = this._relationshipResolver.resolveAndCreateRelationship({
            sourceNodeId: projNode.id,
            relationType: "USES_TECHNOLOGY",
            targetNodeId: techNode.id,
            confidence: 0.95,
            provenance: [
              {
                source: "user_utterance",
                sourceType: "EXPLICIT_USER",
                timestamp,
                confidence: 0.95,
                supportingEvidence: trimmed,
              },
            ],
          });
          edgesCreated.push(edge);
        }
      }
    }

    // ── 3. Pattern: "[Project] [Phase] has [Feature]" ────────────────────────
    const phaseFeatureMatch = trimmed.match(/([a-z0-9_\-]+)\s+(phase\s*\d+)\s+(?:has|contains|me hai|includes)\s+(?:the\s+)?([a-z0-9_\-\s]+)/i);
    if (phaseFeatureMatch) {
      const projName = phaseFeatureMatch[1].trim();
      const phaseName = phaseFeatureMatch[2].trim();
      const featureName = phaseFeatureMatch[3].trim();

      const projNode = this._getOrCreateNode(projName, "PROJECT", "EXPLICIT_USER", trimmed, timestamp);
      const phaseNode = this._getOrCreateNode(phaseName, "PHASE", "EXPLICIT_USER", trimmed, timestamp);
      const featureNode = this._getOrCreateNode(featureName, "FEATURE", "EXPLICIT_USER", trimmed, timestamp);
      nodesCreated.push(projNode, phaseNode, featureNode);

      const edge1 = this._relationshipResolver.resolveAndCreateRelationship({
        sourceNodeId: projNode.id,
        relationType: "HAS_PHASE",
        targetNodeId: phaseNode.id,
        confidence: 0.95,
        provenance: [{ source: "user_utterance", sourceType: "EXPLICIT_USER", timestamp, confidence: 0.95, supportingEvidence: trimmed }],
      });

      const edge2 = this._relationshipResolver.resolveAndCreateRelationship({
        sourceNodeId: phaseNode.id,
        relationType: "HAS_FEATURE",
        targetNodeId: featureNode.id,
        confidence: 0.95,
        provenance: [{ source: "user_utterance", sourceType: "EXPLICIT_USER", timestamp, confidence: 0.95, supportingEvidence: trimmed }],
      });

      edgesCreated.push(edge1, edge2);
    }

    // ── 4. Pattern: Preference statement "I prefer [X]" / "[X] pasand hai" ───
    const prefMatch = trimmed.match(/(?:i prefer|mujhe pasand hai|prefer karta hoon)\s+([a-z0-9_\-\s]+)/i);
    if (prefMatch) {
      const prefValue = prefMatch[1].trim();
      if (prefValue.length > 2) {
        const prefNode = this._getOrCreateNode(prefValue, "PREFERENCE", "EXPLICIT_USER", trimmed, timestamp);
        nodesCreated.push(prefNode);

        const edge = this._relationshipResolver.resolveAndCreateRelationship({
          sourceNodeId: userNode.id,
          relationType: "PREFERS",
          targetNodeId: prefNode.id,
          confidence: 0.95,
          provenance: [{ source: "user_utterance", sourceType: "EXPLICIT_USER", timestamp, confidence: 0.95, supportingEvidence: trimmed }],
        });
        edgesCreated.push(edge);
      }
    }

    return {
      nodesCreated,
      edgesCreated,
      wasRejectedAsCasual: false,
    };
  }

  /**
   * Ingests a qualified Phase 18 CognitiveMemory record into the Knowledge Graph.
   */
  public extractFromCognitiveMemory(memory: CognitiveMemory, timestamp = Date.now()): ExtractionResult {
    const userNode = this._ensureUserNode(timestamp);
    const nodesCreated: KnowledgeNode[] = [];
    const edgesCreated: KnowledgeEdge[] = [];

    // Map memory category to node & edge
    const canonicalName = memory.text || memory.key;
    const prefNode = this._getOrCreateNode(
      canonicalName,
      "PREFERENCE",
      memory.sourceSignal === "explicit_correction" ? "EXPLICIT_CORRECTION" : "EXPLICIT_USER",
      JSON.stringify(memory.value),
      timestamp,
      [memory.id]
    );
    nodesCreated.push(prefNode);

    const edge = this._relationshipResolver.resolveAndCreateRelationship({
      sourceNodeId: userNode.id,
      relationType: "PREFERS",
      targetNodeId: prefNode.id,
      confidence: memory.confidence,
      importance: memory.importance,
      provenance: [
        {
          source: `cognitive_memory:${memory.id}`,
          sourceType: memory.sourceSignal === "explicit_correction" ? "EXPLICIT_CORRECTION" : "EXPLICIT_USER",
          timestamp,
          confidence: memory.confidence,
          supportingEvidence: memory.text,
          sourceId: memory.id,
        },
      ],
      sourceMemoryIds: [memory.id],
    });
    edgesCreated.push(edge);

    return {
      nodesCreated,
      edgesCreated,
      wasRejectedAsCasual: false,
    };
  }

  // ---------------------------------------------------------------------------
  // Helper methods
  // ---------------------------------------------------------------------------

  private _ensureUserNode(timestamp: number): KnowledgeNode {
    const existing = this._nodeStore.findByType("USER");
    if (existing.length > 0) {
      return existing[0];
    }

    const userNode: KnowledgeNode = {
      id: `kg_node_user_${crypto.randomBytes(4).toString("hex")}`,
      type: "USER",
      canonicalName: "User",
      aliases: ["me", "myself", "I"],
      attributes: { role: "owner" },
      confidence: 1.0,
      importance: 5,
      createdAt: timestamp,
      updatedAt: timestamp,
      firstObservedAt: timestamp,
      lastObservedAt: timestamp,
      status: "ACTIVE",
      provenance: [
        {
          source: "system",
          sourceType: "SYSTEM_DEFAULT",
          timestamp,
          confidence: 1.0,
        },
      ],
      sourceMemoryIds: [],
      sourceContextIds: [],
      sourceTaskIds: [],
      sourceResearchIds: [],
    };

    return this._nodeStore.addNode(userNode);
  }

  private _getOrCreateNode(
    name: string,
    type: KnowledgeNodeType,
    provenanceSource: KnowledgeProvenance["sourceType"],
    evidence: string,
    timestamp: number,
    sourceMemoryIds: string[] = []
  ): KnowledgeNode {
    const resolved = this._entityResolver.resolveEntity(name, { expectedType: type });
    if (resolved.matchedNode) {
      return resolved.matchedNode;
    }

    const canonicalName = this._entityResolver.canonicalize(name);
    const node: KnowledgeNode = {
      id: `kg_node_${type.toLowerCase()}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
      type,
      canonicalName,
      aliases: [name],
      attributes: {},
      confidence: 0.95,
      importance: 3,
      createdAt: timestamp,
      updatedAt: timestamp,
      firstObservedAt: timestamp,
      lastObservedAt: timestamp,
      status: "ACTIVE",
      provenance: [
        {
          source: "extraction",
          sourceType: provenanceSource,
          timestamp,
          confidence: 0.95,
          supportingEvidence: evidence,
        },
      ],
      sourceMemoryIds,
      sourceContextIds: [],
      sourceTaskIds: [],
      sourceResearchIds: [],
    };

    return this._nodeStore.addNode(node);
  }

  private _classifyTechType(tech: string): KnowledgeNodeType {
    const lower = tech.toLowerCase();
    if (/\b(python|typescript|javascript|rust|go|java|c\+\+|c#|php|ruby)\b/i.test(lower)) {
      return "LANGUAGE";
    }
    if (/\b(flask|django|react|vue|express|fastapi|spring|nextjs|vite|tailwind)\b/i.test(lower)) {
      return "FRAMEWORK";
    }
    if (/\b(postgresql|postgres|mysql|sqlite|redis|mongodb|docker|git|vite)\b/i.test(lower)) {
      return "TECHNOLOGY";
    }
    return "TECHNOLOGY";
  }
}

export const knowledgeGraphExtractor = new KnowledgeGraphExtractor();
