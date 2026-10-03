/**
 * MYRAA — Phase 24: Personal Knowledge Graph
 * KnowledgeNodeStore
 *
 * In-memory indexed store for KnowledgeNodes.
 * Provides multi-key indexing (id, canonicalName, alias, type, status),
 * duplicate prevention, secret redaction, and atomic updates.
 */

import type {
  KnowledgeNode,
  KnowledgeNodeType,
  KnowledgeStatus,
} from "./KnowledgeGraphTypes.ts";
import { multiAgentContextManager } from "../multiagent/MultiAgentContextManager.ts";

export class KnowledgeNodeStore {
  private _nodes: Map<string, KnowledgeNode> = new Map();

  // Indexes for O(1) lookups
  private _byCanonicalName: Map<string, Set<string>> = new Map();
  private _byAlias: Map<string, Set<string>> = new Map();
  private _byType: Map<KnowledgeNodeType, Set<string>> = new Map();
  private _byStatus: Map<KnowledgeStatus, Set<string>> = new Map();

  constructor(initialNodes?: KnowledgeNode[]) {
    if (initialNodes && initialNodes.length > 0) {
      for (const node of initialNodes) {
        this.addNode(node);
      }
    }
  }

  /**
   * Normalizes an entity name for indexing and comparison.
   */
  public normalizeName(name: string): string {
    return (name || "")
      .trim()
      .toLowerCase()
      .replace(/[\s\-_]+/g, " ");
  }

  /**
   * Redacts sensitive credentials or secrets from attributes before storage.
   */
  private _sanitizeAttributes(attrs: Record<string, unknown>): Record<string, unknown> {
    const serialized = JSON.stringify(attrs);
    const redacted = multiAgentContextManager.redactSecrets(serialized);
    try {
      return JSON.parse(redacted);
    } catch {
      return {};
    }
  }

  /**
   * Adds a new node to the store and updates all indexes.
   */
  public addNode(node: KnowledgeNode): KnowledgeNode {
    // Redact secrets in attributes
    const cleanAttributes = this._sanitizeAttributes(node.attributes || {});
    const cleanNode: KnowledgeNode = {
      ...node,
      attributes: cleanAttributes,
      aliases: (node.aliases || []).map((a) => a.trim()),
    };

    this._nodes.set(cleanNode.id, cleanNode);
    this._indexNode(cleanNode);
    return cleanNode;
  }

  /**
   * Retrieves a node by ID.
   */
  public getNode(id: string): KnowledgeNode | undefined {
    return this._nodes.get(id);
  }

  /**
   * Checks if a node exists.
   */
  public hasNode(id: string): boolean {
    return this._nodes.has(id);
  }

  /**
   * Finds nodes matching a canonical name (exact normalized match).
   */
  public findByCanonicalName(name: string): KnowledgeNode[] {
    const key = this.normalizeName(name);
    const ids = this._byCanonicalName.get(key);
    if (!ids) return [];
    return Array.from(ids)
      .map((id) => this._nodes.get(id)!)
      .filter(Boolean);
  }

  /**
   * Finds nodes matching an alias (exact normalized match).
   */
  public findByAlias(alias: string): KnowledgeNode[] {
    const key = this.normalizeName(alias);
    const ids = this._byAlias.get(key);
    if (!ids) return [];
    return Array.from(ids)
      .map((id) => this._nodes.get(id)!)
      .filter(Boolean);
  }

  /**
   * Finds nodes by type.
   */
  public findByType(type: KnowledgeNodeType): KnowledgeNode[] {
    const ids = this._byType.get(type);
    if (!ids) return [];
    return Array.from(ids)
      .map((id) => this._nodes.get(id)!)
      .filter(Boolean);
  }

  /**
   * Finds nodes by status (e.g. ACTIVE, SUPERSEDED, ARCHIVED).
   */
  public findByStatus(status: KnowledgeStatus): KnowledgeNode[] {
    const ids = this._byStatus.get(status);
    if (!ids) return [];
    return Array.from(ids)
      .map((id) => this._nodes.get(id)!)
      .filter(Boolean);
  }

  /**
   * Updates an existing node in the store.
   */
  public updateNode(id: string, updates: Partial<KnowledgeNode>): KnowledgeNode | null {
    const existing = this._nodes.get(id);
    if (!existing) return null;

    this._deindexNode(existing);

    const cleanAttributes = updates.attributes
      ? this._sanitizeAttributes({ ...existing.attributes, ...updates.attributes })
      : existing.attributes;

    const updatedNode: KnowledgeNode = {
      ...existing,
      ...updates,
      attributes: cleanAttributes,
      id: existing.id, // ID is immutable
      updatedAt: Date.now(),
    };

    this._nodes.set(id, updatedNode);
    this._indexNode(updatedNode);
    return updatedNode;
  }

  /**
   * Marks a node as superseded (non-destructive retirement).
   */
  public supersedeNode(id: string): KnowledgeNode | null {
    return this.updateNode(id, {
      status: "SUPERSEDED",
      validUntil: Date.now(),
    });
  }

  /**
   * Marks a node as archived.
   */
  public archiveNode(id: string): KnowledgeNode | null {
    return this.updateNode(id, {
      status: "ARCHIVED",
      validUntil: Date.now(),
    });
  }

  /**
   * Adds an alias to an existing node.
   */
  public addAlias(id: string, alias: string): KnowledgeNode | null {
    const existing = this._nodes.get(id);
    if (!existing) return null;
    const trimmed = alias.trim();
    if (!trimmed || existing.aliases.some((a) => this.normalizeName(a) === this.normalizeName(trimmed))) {
      return existing;
    }
    const updatedAliases = [...existing.aliases, trimmed];
    return this.updateNode(id, { aliases: updatedAliases });
  }

  /**
   * Returns all stored nodes.
   */
  public getAllNodes(): KnowledgeNode[] {
    return Array.from(this._nodes.values());
  }

  /**
   * Returns total count of nodes.
   */
  public get count(): number {
    return this._nodes.size;
  }

  /**
   * Clears all nodes and indexes.
   */
  public clear(): void {
    this._nodes.clear();
    this._byCanonicalName.clear();
    this._byAlias.clear();
    this._byType.clear();
    this._byStatus.clear();
  }

  // ---------------------------------------------------------------------------
  // Index management
  // ---------------------------------------------------------------------------

  private _indexNode(node: KnowledgeNode): void {
    const canonicalKey = this.normalizeName(node.canonicalName);
    this._addToIndex(this._byCanonicalName, canonicalKey, node.id);

    for (const alias of node.aliases || []) {
      const aliasKey = this.normalizeName(alias);
      this._addToIndex(this._byAlias, aliasKey, node.id);
    }

    this._addToIndex(this._byType, node.type, node.id);
    this._addToIndex(this._byStatus, node.status, node.id);
  }

  private _deindexNode(node: KnowledgeNode): void {
    const canonicalKey = this.normalizeName(node.canonicalName);
    this._removeFromIndex(this._byCanonicalName, canonicalKey, node.id);

    for (const alias of node.aliases || []) {
      const aliasKey = this.normalizeName(alias);
      this._removeFromIndex(this._byAlias, aliasKey, node.id);
    }

    this._removeFromIndex(this._byType, node.type, node.id);
    this._removeFromIndex(this._byStatus, node.status, node.id);
  }

  private _addToIndex<K>(map: Map<K, Set<string>>, key: K, id: string): void {
    let set = map.get(key);
    if (!set) {
      set = new Set<string>();
      map.set(key, set);
    }
    set.add(id);
  }

  private _removeFromIndex<K>(map: Map<K, Set<string>>, key: K, id: string): void {
    const set = map.get(key);
    if (set) {
      set.delete(id);
      if (set.size === 0) {
        map.delete(key);
      }
    }
  }
}

export const knowledgeNodeStore = new KnowledgeNodeStore();
