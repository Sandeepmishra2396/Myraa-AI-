/**
 * MYRAA — Phase 24: Personal Knowledge Graph
 * KnowledgeGraphStore
 *
 * Unified store coordinating KnowledgeNodeStore and KnowledgeEdgeStore.
 * Provides atomic persistence to DATA_DIR/knowledge_graph.json,
 * Emergency Stop write halting, Security Lockdown mutation gating,
 * snapshot/restore mechanisms, and graph statistics.
 */

import * as fs from "fs";
import * as path from "path";
import crypto from "crypto";
import { dataFile, DATA_DIR } from "../server_paths.ts";
import type {
  KnowledgeNode,
  KnowledgeEdge,
  KnowledgeGraphSnapshot,
  GraphStats,
} from "./KnowledgeGraphTypes.ts";
import { KnowledgeNodeStore, knowledgeNodeStore } from "./KnowledgeNodeStore.ts";
import { KnowledgeEdgeStore, knowledgeEdgeStore } from "./KnowledgeEdgeStore.ts";
import { emergencyStopCoordinator } from "../remote/EmergencyStopCoordinator.ts";
import { securityPolicyEngine } from "../security/SecurityPolicyEngine.ts";

export class KnowledgeGraphStore {
  public readonly nodes: KnowledgeNodeStore;
  public readonly edges: KnowledgeEdgeStore;

  private _storageFilePath: string;
  private _isLoaded = false;
  private _snapshots: Map<string, KnowledgeGraphSnapshot> = new Map();

  constructor(
    storageFile = dataFile("knowledge_graph.json"),
    nodeStore = knowledgeNodeStore,
    edgeStore = knowledgeEdgeStore
  ) {
    this._storageFilePath = storageFile;
    this.nodes = nodeStore;
    this.edges = edgeStore;
  }

  /**
   * Loads the graph from disk if not already loaded.
   */
  public async load(): Promise<{ nodeCount: number; edgeCount: number }> {
    if (this._isLoaded) {
      return { nodeCount: this.nodes.count, edgeCount: this.edges.count };
    }

    try {
      if (!fs.existsSync(this._storageFilePath)) {
        this._isLoaded = true;
        return { nodeCount: 0, edgeCount: 0 };
      }

      let content = fs.readFileSync(this._storageFilePath, "utf8");
      if (content.charCodeAt(0) === 0xfeff) {
        content = content.slice(1);
      }

      if (!content.trim()) {
        this._isLoaded = true;
        return { nodeCount: 0, edgeCount: 0 };
      }

      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === "object") {
        if (Array.isArray(parsed.nodes)) {
          for (const n of parsed.nodes) {
            this.nodes.addNode(n);
          }
        }
        if (Array.isArray(parsed.edges)) {
          for (const e of parsed.edges) {
            try {
              this.edges.addEdge(e);
            } catch {
              // Ignore edges with corrupted relation types
            }
          }
        }
      }

      this._isLoaded = true;
      return { nodeCount: this.nodes.count, edgeCount: this.edges.count };
    } catch (err) {
      console.warn(`[KnowledgeGraphStore] Failed to read ${this._storageFilePath}, starting fresh:`, err);
      this._isLoaded = true;
      return { nodeCount: 0, edgeCount: 0 };
    }
  }

  /**
   * Atomically persists current graph state to disk.
   * Respects Emergency Stop.
   */
  public async persist(): Promise<boolean> {
    if (emergencyStopCoordinator.isActive()) {
      console.warn("[KnowledgeGraphStore] Persist blocked: Emergency Stop is active.");
      return false;
    }

    try {
      const payload = {
        version: "24.0.0",
        updatedAt: Date.now(),
        nodes: this.nodes.getAllNodes(),
        edges: this.edges.getAllEdges(),
      };

      const dir = path.dirname(this._storageFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const tempFile = `${this._storageFilePath}.tmp.${Date.now()}`;
      fs.writeFileSync(tempFile, JSON.stringify(payload, null, 2), "utf8");
      fs.renameSync(tempFile, this._storageFilePath);
      return true;
    } catch (err) {
      console.error(`[KnowledgeGraphStore] Failed to persist graph to ${this._storageFilePath}:`, err);
      return false;
    }
  }

  /**
   * Asserts whether a mutation operation is permitted by security policies.
   */
  public assertMutationPermitted(operation = "MUTATE_GRAPH"): void {
    if (emergencyStopCoordinator.isActive()) {
      throw new Error(`[EmergencyStop] Graph operation '${operation}' blocked: Emergency killswitch is active.`);
    }

    if (securityPolicyEngine.getMode() === "LOCKDOWN") {
      throw new Error(`[SecurityLockdown] Graph operation '${operation}' blocked: Security lockdown mode is active.`);
    }
  }

  /**
   * Creates a snapshot of the current graph state.
   */
  public createSnapshot(reason = "manual_snapshot"): KnowledgeGraphSnapshot {
    const snapshotId = `kg_snap_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
    const allNodes = this.nodes.getAllNodes().map((n) => JSON.parse(JSON.stringify(n)));
    const allEdges = this.edges.getAllEdges().map((e) => JSON.parse(JSON.stringify(e)));

    const snapshot: KnowledgeGraphSnapshot = {
      snapshotId,
      timestamp: Date.now(),
      nodes: allNodes,
      edges: allEdges,
      metadata: {
        nodeCount: allNodes.length,
        edgeCount: allEdges.length,
        reason,
      },
    };

    this._snapshots.set(snapshotId, snapshot);
    return snapshot;
  }

  /**
   * Restores graph state from a previously captured snapshot.
   */
  public async restoreSnapshot(snapshot: KnowledgeGraphSnapshot): Promise<boolean> {
    this.assertMutationPermitted("RESTORE_SNAPSHOT");

    this.nodes.clear();
    this.edges.clear();

    for (const node of snapshot.nodes) {
      this.nodes.addNode(node);
    }
    for (const edge of snapshot.edges) {
      try {
        this.edges.addEdge(edge);
      } catch {
        /* skip invalid */
      }
    }

    await this.persist();
    return true;
  }

  /**
   * Retrieves a snapshot by ID.
   */
  public getSnapshot(snapshotId: string): KnowledgeGraphSnapshot | undefined {
    return this._snapshots.get(snapshotId);
  }

  /**
   * Computes comprehensive graph statistics.
   */
  public getStats(): GraphStats {
    const allNodes = this.nodes.getAllNodes();
    const allEdges = this.edges.getAllEdges();

    const nodesByType: Record<string, number> = {};
    for (const n of allNodes) {
      nodesByType[n.type] = (nodesByType[n.type] || 0) + 1;
    }

    const edgesByRelation: Record<string, number> = {};
    for (const e of allEdges) {
      edgesByRelation[e.relationType] = (edgesByRelation[e.relationType] || 0) + 1;
    }

    const activeNodes = allNodes.filter((n) => n.status === "ACTIVE").length;
    const supersededNodes = allNodes.filter((n) => n.status === "SUPERSEDED").length;
    const activeEdges = allEdges.filter((e) => e.status === "ACTIVE").length;
    const supersededEdges = allEdges.filter((e) => e.status === "SUPERSEDED").length;

    const totalConfidence = allNodes.reduce((sum, n) => sum + (n.confidence || 0), 0);
    const avgConfidence = allNodes.length > 0 ? totalConfidence / allNodes.length : 0;

    return {
      nodeCount: allNodes.length,
      edgeCount: allEdges.length,
      activeNodes,
      activeEdges,
      supersededNodes,
      supersededEdges,
      nodesByType,
      edgesByRelation,
      avgConfidence: Number(avgConfidence.toFixed(2)),
      lastUpdated: Date.now(),
    };
  }

  /**
   * Resets the entire graph (used in tests or manual reset).
   */
  public async reset(): Promise<void> {
    this.assertMutationPermitted("RESET_GRAPH");
    this.nodes.clear();
    this.edges.clear();
    this._snapshots.clear();
    await this.persist();
  }
}

export const knowledgeGraphStore = new KnowledgeGraphStore();
