/**
 * MYRAA — Phase 19: Advanced Context Fusion Engine
 * Context Source Registry
 *
 * Catalogs and manages all multi-source perception channels with base reliability weights
 * and source-specific Time-To-Live (TTL) decay thresholds.
 */

import type { ContextSourceMetadata, ContextSourceType } from "./IntelligenceTypes.ts";

export class ContextSourceRegistry {
  private _sources: Map<ContextSourceType, ContextSourceMetadata> = new Map();

  constructor() {
    this._registerDefaultSources();
  }

  private _registerDefaultSources(): void {
    const defaults: ContextSourceMetadata[] = [
      {
        sourceId: "voice",
        name: "Voice & Speech Stream",
        reliability: 0.92,
        defaultTtlMs: 30 * 1000, // 30 seconds
      },
      {
        sourceId: "conversation",
        name: "Active Dialogue Turns",
        reliability: 0.88,
        defaultTtlMs: 10 * 60 * 1000, // 10 minutes
      },
      {
        sourceId: "application",
        name: "Foreground Application & Window",
        reliability: 0.92,
        defaultTtlMs: 5 * 60 * 1000, // 5 minutes
      },
      {
        sourceId: "file",
        name: "Active Code File & Editor Focus",
        reliability: 0.95,
        defaultTtlMs: 5 * 60 * 1000, // 5 minutes
      },
      {
        sourceId: "project",
        name: "Project Workspace & Git Tree",
        reliability: 0.9,
        defaultTtlMs: 30 * 60 * 1000, // 30 minutes
      },
      {
        sourceId: "browser",
        name: "Browser Webpage & Navigation",
        reliability: 0.85,
        defaultTtlMs: 3 * 60 * 1000, // 3 minutes
      },
      {
        sourceId: "screen",
        name: "Screen Visual Perception & OCR",
        reliability: 0.8,
        defaultTtlMs: 30 * 1000, // 30 seconds (fast decay)
      },
      {
        sourceId: "brain",
        name: "Adaptive Personal Brain & Preferences",
        reliability: 0.78,
        defaultTtlMs: 24 * 60 * 60 * 1000, // 24 hours
      },
      {
        sourceId: "task",
        name: "Active Execution Plan & Subtasks",
        reliability: 0.9,
        defaultTtlMs: 30 * 60 * 1000, // 30 minutes
      },
      {
        sourceId: "device",
        name: "Device Hardware & OS State",
        reliability: 0.95,
        defaultTtlMs: 10 * 60 * 1000, // 10 minutes
      },
      {
        sourceId: "recent_actions",
        name: "Recent Tool Execution History",
        reliability: 0.85,
        defaultTtlMs: 5 * 60 * 1000, // 5 minutes
      },
      {
        sourceId: "ui_state",
        name: "Hologram UI & Media Playback State",
        reliability: 0.9,
        defaultTtlMs: 60 * 1000, // 1 minute
      },
    ];

    for (const s of defaults) {
      this._sources.set(s.sourceId, s);
    }
  }

  public getSource(sourceId: ContextSourceType): ContextSourceMetadata {
    const existing = this._sources.get(sourceId);
    if (existing) return { ...existing };
    return {
      sourceId,
      name: String(sourceId),
      reliability: 0.75,
      defaultTtlMs: 5 * 60 * 1000,
    };
  }

  public getAllSources(): ContextSourceMetadata[] {
    return Array.from(this._sources.values()).map((s) => ({ ...s }));
  }

  public registerSource(metadata: ContextSourceMetadata): void {
    this._sources.set(metadata.sourceId, { ...metadata });
  }

  public getReliability(sourceId: ContextSourceType): number {
    return this.getSource(sourceId).reliability;
  }

  public getDefaultTtl(sourceId: ContextSourceType): number {
    return this.getSource(sourceId).defaultTtlMs;
  }
}

export const contextSourceRegistry = new ContextSourceRegistry();
