/**
 * MYRAA — Phase 24: Personal Knowledge Graph
 * KnowledgeEntityResolver
 *
 * Implements entity resolution, canonicalization, alias matching,
 * contextual matching, collision detection, and safe merge proposals.
 *
 * Invariant: NEVER merge entities only because names are similar.
 * If confidence is low or multiple distinct entities collide, flags ambiguity.
 */

import type {
  KnowledgeNode,
  KnowledgeNodeType,
} from "./KnowledgeGraphTypes.ts";
import { KnowledgeNodeStore, knowledgeNodeStore } from "./KnowledgeNodeStore.ts";

export interface EntityResolutionResult {
  matchedNode: KnowledgeNode | null;
  canonicalName: string;
  confidence: number;
  matchType: "EXACT_CANONICAL" | "EXACT_ALIAS" | "PATTERN_MATCH" | "CONTEXTUAL" | "FUZZY" | "NONE";
  isAmbiguous: boolean;
  collidingNodes?: KnowledgeNode[];
  clarificationPrompt?: string;
}

export interface EntityResolutionContext {
  activeProject?: string;
  activeFile?: string;
  activeApp?: string;
  expectedType?: KnowledgeNodeType;
}

export class KnowledgeEntityResolver {
  private _nodeStore: KnowledgeNodeStore;

  constructor(nodeStore = knowledgeNodeStore) {
    this._nodeStore = nodeStore;
  }

  /**
   * Normalizes a raw name into a clean canonical token.
   */
  public canonicalize(rawName: string): string {
    if (!rawName || typeof rawName !== "string") return "";
    let s = rawName.trim();

    // Strip common leading articles/possessives
    s = s.replace(/^(the|my|mera|meri|our|hamara|hamari|a|an)\s+/i, "");
    // Strip common trailing descriptors if redundant
    s = s.replace(/\s+(project|app|assistant|repo|codebase)$/i, "");

    return s.trim();
  }

  /**
   * Resolves an entity reference against the Knowledge Graph.
   */
  public resolveEntity(
    rawText: string,
    context?: EntityResolutionContext
  ): EntityResolutionResult {
    const raw = (rawText || "").trim();
    if (!raw) {
      return {
        matchedNode: null,
        canonicalName: "",
        confidence: 0,
        matchType: "NONE",
        isAmbiguous: false,
      };
    }

    const canonical = this.canonicalize(raw);
    const normalizedKey = this._nodeStore.normalizeName(canonical);
    const normalizedRaw = this._nodeStore.normalizeName(raw);

    // ── 1. Exact Canonical Match ────────────────────────────────────────────
    const exactCanonical = this._nodeStore.findByCanonicalName(canonical);
    if (exactCanonical.length === 1) {
      return {
        matchedNode: exactCanonical[0],
        canonicalName: exactCanonical[0].canonicalName,
        confidence: 1.0,
        matchType: "EXACT_CANONICAL",
        isAmbiguous: false,
      };
    }
    if (exactCanonical.length > 1) {
      // Multiple entities with exact same canonical name (different types?)
      if (context?.expectedType) {
        const typeFiltered = exactCanonical.filter((n) => n.type === context.expectedType);
        if (typeFiltered.length === 1) {
          return {
            matchedNode: typeFiltered[0],
            canonicalName: typeFiltered[0].canonicalName,
            confidence: 0.95,
            matchType: "EXACT_CANONICAL",
            isAmbiguous: false,
          };
        }
      }
      return {
        matchedNode: null,
        canonicalName: canonical,
        confidence: 0.45,
        matchType: "EXACT_CANONICAL",
        isAmbiguous: true,
        collidingNodes: exactCanonical,
        clarificationPrompt: `Multiple entities named '${canonical}' found. Did you mean ${exactCanonical.map((n) => `${n.canonicalName} (${n.type})`).join(" or ")}?`,
      };
    }

    // ── 2. Exact Alias Match ────────────────────────────────────────────────
    const aliasMatches = [
      ...this._nodeStore.findByAlias(raw),
      ...this._nodeStore.findByAlias(canonical),
    ];
    const uniqueAliasMatches = Array.from(new Set(aliasMatches));
    if (uniqueAliasMatches.length === 1) {
      return {
        matchedNode: uniqueAliasMatches[0],
        canonicalName: uniqueAliasMatches[0].canonicalName,
        confidence: 0.95,
        matchType: "EXACT_ALIAS",
        isAmbiguous: false,
      };
    }
    if (uniqueAliasMatches.length > 1) {
      return {
        matchedNode: null,
        canonicalName: canonical,
        confidence: 0.45,
        matchType: "EXACT_ALIAS",
        isAmbiguous: true,
        collidingNodes: uniqueAliasMatches,
        clarificationPrompt: `The alias '${raw}' matches multiple entities: ${uniqueAliasMatches.map((n) => n.canonicalName).join(", ")}. Please clarify.`,
      };
    }

    // ── 3. Pattern / Known Product Variations ───────────────────────────────
    // Check known variations, e.g. "QYROX" vs "Qyrox AI"
    const allNodes = this._nodeStore.getAllNodes().filter((n) => n.status === "ACTIVE");
    const patternCandidates = allNodes.filter((node) => {
      if (context?.expectedType && node.type !== context.expectedType) {
        return false;
      }
      const nodeCanon = this._nodeStore.normalizeName(node.canonicalName);
      if (nodeCanon === normalizedKey || nodeCanon === normalizedRaw) {
        return true;
      }
      // For prefix matching, ensure both sides are non-trivial and expectedType matches
      if (context?.expectedType && nodeCanon.length > 3 && normalizedKey.length > 3) {
        return nodeCanon.startsWith(normalizedKey) || normalizedKey.startsWith(nodeCanon);
      }
      return false;
    });

    if (patternCandidates.length === 1) {
      return {
        matchedNode: patternCandidates[0],
        canonicalName: patternCandidates[0].canonicalName,
        confidence: 0.85,
        matchType: "PATTERN_MATCH",
        isAmbiguous: false,
      };
    }
    if (patternCandidates.length > 1) {
      return {
        matchedNode: null,
        canonicalName: canonical,
        confidence: 0.5,
        matchType: "PATTERN_MATCH",
        isAmbiguous: true,
        collidingNodes: patternCandidates,
        clarificationPrompt: `Multiple matching entities found: ${patternCandidates.map((n) => n.canonicalName).join(", ")}.`,
      };
    }

    // ── 4. Contextual Deictic Reference ─────────────────────────────────────
    if (
      context?.activeProject &&
      /\b(the project|mera project|this project|project|current project)\b/i.test(raw)
    ) {
      const projectNode = this._nodeStore.findByCanonicalName(context.activeProject)[0];
      if (projectNode) {
        return {
          matchedNode: projectNode,
          canonicalName: projectNode.canonicalName,
          confidence: 0.82,
          matchType: "CONTEXTUAL",
          isAmbiguous: false,
        };
      }
    }

    if (
      context?.activeFile &&
      /\b(the file|meri file|this file|current file)\b/i.test(raw)
    ) {
      const fileNodes = this._nodeStore.findByCanonicalName(context.activeFile);
      if (fileNodes.length > 0) {
        return {
          matchedNode: fileNodes[0],
          canonicalName: fileNodes[0].canonicalName,
          confidence: 0.82,
          matchType: "CONTEXTUAL",
          isAmbiguous: false,
        };
      }
    }

    // ── 5. Fuzzy Match (Levenshtein / Word containment) ─────────────────────
    const fuzzyCandidates = allNodes.filter((node) => {
      if (context?.expectedType && node.type !== context.expectedType) {
        return false;
      }
      if (node.type === "USER") {
        return false;
      }
      const nc = this._nodeStore.normalizeName(node.canonicalName);
      if (nc.length > 3 && normalizedKey.length > 3) {
        return nc.includes(normalizedKey) || normalizedKey.includes(nc);
      }
      return false;
    });

    if (fuzzyCandidates.length === 1) {
      return {
        matchedNode: fuzzyCandidates[0],
        canonicalName: fuzzyCandidates[0].canonicalName,
        confidence: 0.65,
        matchType: "FUZZY",
        isAmbiguous: false,
      };
    }

    return {
      matchedNode: null,
      canonicalName: canonical,
      confidence: 0.2,
      matchType: "NONE",
      isAmbiguous: false,
    };
  }

  /**
   * Proposes merging two nodes if they are determined to be the same entity.
   * Merges aliases, attributes, and provenance.
   */
  public proposeMerge(sourceNodeId: string, targetNodeId: string): Partial<KnowledgeNode> | null {
    if (sourceNodeId === targetNodeId) return null;
    const sourceNode = this._nodeStore.getNode(sourceNodeId);
    const targetNode = this._nodeStore.getNode(targetNodeId);
    if (!sourceNode || !targetNode) return null;

    // Must be of compatible types
    if (sourceNode.type !== targetNode.type) {
      return null;
    }

    const mergedAliases = Array.from(
      new Set([...targetNode.aliases, sourceNode.canonicalName, ...sourceNode.aliases])
    );

    const mergedAttributes = {
      ...sourceNode.attributes,
      ...targetNode.attributes,
    };

    const mergedProvenance = [...targetNode.provenance, ...sourceNode.provenance];

    return {
      id: targetNode.id,
      canonicalName: targetNode.canonicalName,
      type: targetNode.type,
      aliases: mergedAliases,
      attributes: mergedAttributes,
      provenance: mergedProvenance,
      confidence: Math.max(targetNode.confidence, sourceNode.confidence),
      importance: Math.max(targetNode.importance, sourceNode.importance),
      updatedAt: Date.now(),
    };
  }
}

export const knowledgeEntityResolver = new KnowledgeEntityResolver();
