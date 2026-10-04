/**
 * MYRAA — Phase 24: Personal Knowledge Graph
 * KnowledgeGraphTemporalEngine
 *
 * Evaluates temporal validity (CURRENT, HISTORICAL, PLANNED, EXPIRED, SUPERSEDED)
 * for nodes and edges using validFrom, validUntil, and lifecycle status.
 */

import type {
  KnowledgeNode,
  KnowledgeEdge,
  TemporalState,
} from "./KnowledgeGraphTypes.ts";

export interface TemporalEntity {
  validFrom?: number;
  validUntil?: number;
  status: "ACTIVE" | "SUPERSEDED" | "ARCHIVED";
}

export class KnowledgeGraphTemporalEngine {
  /**
   * Computes the temporal state of an entity at a given point in time.
   */
  public getTemporalState(entity: TemporalEntity, atTimestamp = Date.now()): TemporalState {
    if (entity.status === "SUPERSEDED") {
      return "SUPERSEDED";
    }

    if (entity.validUntil && atTimestamp > entity.validUntil) {
      return "EXPIRED";
    }

    if (entity.validFrom && atTimestamp < entity.validFrom) {
      return "PLANNED";
    }

    if (entity.status === "ACTIVE") {
      return "CURRENT";
    }

    return "HISTORICAL";
  }

  /**
   * Checks if an entity is currently active and valid.
   */
  public isCurrent(entity: TemporalEntity, atTimestamp = Date.now()): boolean {
    if (entity.status !== "ACTIVE") return false;
    if (entity.validFrom && atTimestamp < entity.validFrom) return false;
    if (entity.validUntil && atTimestamp > entity.validUntil) return false;
    return true;
  }

  /**
   * Checks if an entity is historical (superseded, archived, or expired).
   */
  public isHistorical(entity: TemporalEntity, atTimestamp = Date.now()): boolean {
    if (entity.status === "SUPERSEDED" || entity.status === "ARCHIVED") return true;
    if (entity.validUntil && atTimestamp > entity.validUntil) return true;
    return false;
  }

  /**
   * Filters an array of nodes or edges according to requested temporal state.
   */
  public filterByTemporalState<T extends TemporalEntity>(
    items: T[],
    state: TemporalState,
    atTimestamp = Date.now()
  ): T[] {
    switch (state) {
      case "CURRENT":
        return items.filter((item) => this.isCurrent(item, atTimestamp));
      case "HISTORICAL":
        return items.filter((item) => this.isHistorical(item, atTimestamp));
      case "PLANNED":
        return items.filter(
          (item) => item.validFrom !== undefined && atTimestamp < item.validFrom
        );
      case "SUPERSEDED":
        return items.filter((item) => item.status === "SUPERSEDED");
      case "EXPIRED":
        return items.filter(
          (item) => item.validUntil !== undefined && atTimestamp > item.validUntil
        );
      default:
        return items;
    }
  }
}

export const knowledgeGraphTemporalEngine = new KnowledgeGraphTemporalEngine();
