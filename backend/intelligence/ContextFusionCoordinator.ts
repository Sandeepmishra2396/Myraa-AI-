/**
 * MYRAA — Phase 19: Advanced Context Fusion Engine
 * Context Fusion Coordinator
 *
 * Master orchestrator for Phase 19 Advanced Context Fusion.
 * Unifies 12+ perception channels:
 *   Voice + Conversation + Current App + Active File + Project + Browser +
 *   Screen/Visual + Adaptive Brain + Task + Device + Time + Recent Actions + UI State
 *
 * Enforces:
 *   - Multi-source context aggregation
 *   - Freshness tracking & TTL decay
 *   - Source reliability & confidence scoring
 *   - Conflict detection & deterministic resolution
 *   - Deictic & anaphoric reference resolution ("isko", "isme", "ye")
 *   - Ambiguity detection (never guess when confidence is insufficient)
 *   - Context provenance audit trace
 *   - Seamless extension of Phase 17 ContextFusionEngine without duplicate logic
 */

import { contextFusionEngine, ContextFusionEngine } from "./ContextFusionEngine.ts";
import { contextSourceRegistry, ContextSourceRegistry } from "./ContextSourceRegistry.ts";
import { contextFreshnessManager, ContextFreshnessManager } from "./ContextFreshnessManager.ts";
import { contextConfidenceEngine, ContextConfidenceEngine } from "./ContextConfidenceEngine.ts";
import { contextConflictResolver, ContextConflictResolver } from "./ContextConflictResolver.ts";
import { referenceResolver, ReferenceResolver } from "./ReferenceResolver.ts";
import { contextProvenanceTracker, ContextProvenanceTracker } from "./ContextProvenanceTracker.ts";
import {
  ContextPriority,
  type ContextConflict,
  type ContextSourceType,
  type ResolvedReference,
  type UnifiedMyraaContext,
} from "./IntelligenceTypes.ts";
import type { TargetDevice } from "../orchestrator/OrchestratorTypes.ts";

export class ContextFusionCoordinator {
  public registry: ContextSourceRegistry;
  public freshness: ContextFreshnessManager;
  public confidence: ContextConfidenceEngine;
  public conflicts: ContextConflictResolver;
  public references: ReferenceResolver;
  public provenance: ContextProvenanceTracker;
  public baseFusion: ContextFusionEngine;

  constructor(
    registry = contextSourceRegistry,
    freshness = contextFreshnessManager,
    confidence = contextConfidenceEngine,
    conflicts = contextConflictResolver,
    references = referenceResolver,
    provenance = contextProvenanceTracker,
    baseFusion = contextFusionEngine
  ) {
    this.registry = registry;
    this.freshness = freshness;
    this.confidence = confidence;
    this.conflicts = conflicts;
    this.references = references;
    this.provenance = provenance;
    this.baseFusion = baseFusion;
  }

  /**
   * Main Context Fusion method: builds the unified MYRAA context combining all 12+ sources.
   */
  public async fuseUnifiedContext(
    contextId = "default",
    overrides?: Partial<UnifiedMyraaContext>,
    deviceHint?: TargetDevice,
    userInput?: string
  ): Promise<UnifiedMyraaContext> {
    const now = Date.now();

    // 1. Base Fusion from Phase 17 (Application, File, Project, Task, Conversation, Recent Actions, Preferences, Media)
    const base = this.baseFusion.fuseContext(
      overrides ? ({ ...overrides, contextId } as any) : contextId,
      deviceHint
    );

    // 2. Fetch Screen & Visual Context (Best-effort from Phase 8 Multimodal subsystems)
    let activeWindowInfo: UnifiedMyraaContext["activeWindow"] = null;
    let visualContext: UnifiedMyraaContext["visualContext"] = null;

    try {
      const { activeWindowTracker } = await import("../multimodal/ActiveWindowTracker.ts");
      const win = await activeWindowTracker.getActiveWindow();
      if (win) {
        activeWindowInfo = {
          title: win.title || "Desktop",
          processName: win.processName || "explorer",
          bounds: win.bounds,
          isSensitive: win.category === "sensitive",
          timestamp: now,
        };
      }
    } catch {
      /* visual window tracking is best-effort */
    }

    try {
      const { screenContextManager } = await import("../multimodal/ScreenContextManager.ts");
      const screenStatus = screenContextManager.getStatus();
      const latestSnapshot = screenContextManager.getLatestSnapshot();
      const lastCaptureAt = screenStatus.lastCaptureAt || latestSnapshot?.timestamp || 0;
      visualContext = {
        ocrTextSummary: undefined,
        hasRedSquiggles: false,
        detectedError: undefined,
        timestamp: lastCaptureAt,
        isStale: !this.freshness.isFresh("screen", lastCaptureAt, now),
      };
    } catch {
      /* screen context is best-effort */
    }

    // 3. Fetch Adaptive Personal Brain Context (from Phase 18)
    let brainContext: UnifiedMyraaContext["brainContext"] = null;
    try {
      const { cognitiveLearningCoordinator } = await import("../brain/index.ts");
      const activeMemories = await cognitiveLearningCoordinator.listPreferences({ status: "active" });
      const promptDirective = await cognitiveLearningCoordinator.getAdaptivePrompt();
      brainContext = {
        activeDirectives: promptDirective ? [promptDirective] : [],
        learnedPreferencesCount: activeMemories.length,
        recentCorrections: activeMemories.filter((m) => m.category === "correction").map((m) => m.text),
        timestamp: now,
      };
    } catch {
      /* brain context is best-effort */
    }

    // 4. Voice & Dialogue Stream Context
    const lastUserTurn = [...base.previousConversation].reverse().find((t) => t.role === "user");
    const lastModelTurn = [...base.previousConversation].reverse().find((t) => t.role === "model");

    const voiceState: UnifiedMyraaContext["voiceState"] = {
      isListening: true,
      lastVoiceUtterance: lastUserTurn?.text || "",
      lastModelResponse: lastModelTurn?.text || "",
      timestamp: lastUserTurn?.timestamp || now,
    };

    // 5. Browser Context
    const browserContext: UnifiedMyraaContext["browserContext"] = {
      url: base.currentWebsite,
      pageTitle: base.currentWebsite ? "Webpage" : null,
      timestamp: now,
      isStale: !this.freshness.isFresh("browser", base.timestamp, now),
    };

    // 6. Device State & Temporal Context
    const deviceState: UnifiedMyraaContext["deviceState"] = {
      deviceType: base.currentDevice,
      isLocal: base.currentDevice === "DESKTOP",
      localTime: new Date(now).toISOString(),
      timestamp: now,
    };

    // 7. Source Timestamps & Freshness Summary
    const sourceTimestamps: Partial<Record<ContextSourceType, number>> = {
      voice: voiceState.timestamp,
      conversation: base.timestamp,
      application: base.timestamp,
      file: base.timestamp,
      project: base.timestamp,
      browser: browserContext.timestamp,
      screen: visualContext?.timestamp || 0,
      brain: brainContext?.timestamp || now,
      task: base.currentTask?.updatedAt || 0,
      device: deviceState.timestamp,
      recent_actions: base.recentActions[0]?.timestamp || 0,
      ui_state: base.activeMedia ? base.timestamp : 0,
    };

    const freshnessSummary = this.freshness.evaluateFreshnessSummary(sourceTimestamps, now);

    // 8. Conflict Detection
    const conflictsDetected: ContextConflict[] = [];

    // Check conflict between currentApplication and activeWindow
    if (base.currentApplication && activeWindowInfo?.processName) {
      const appA = base.currentApplication.toLowerCase();
      const appB = activeWindowInfo.processName.toLowerCase();
      if (appA !== appB && !appB.includes(appA) && !appA.includes(appB)) {
        const conflict = this.conflicts.resolveConflict(
          "application",
          {
            value: base.currentApplication,
            source: "application",
            confidence: this.confidence.computeConfidence("application", base.timestamp, 0, now),
            timestamp: base.timestamp,
            priority: ContextPriority.CURRENT_APPLICATION_FILE_PROJECT,
          },
          {
            value: activeWindowInfo.processName,
            source: "screen",
            confidence: this.confidence.computeConfidence("screen", activeWindowInfo.timestamp, 0, now),
            timestamp: activeWindowInfo.timestamp,
            priority: ContextPriority.CURRENT_APPLICATION_FILE_PROJECT,
          }
        );
        conflictsDetected.push(conflict);
      }
    }

    // 9. Reference Resolution (if userInput provided)
    const resolvedReferences: Record<string, ResolvedReference> = {};
    if (userInput && userInput.trim().length > 0) {
      const ref = this.references.resolveReference(userInput, base, now);
      if (ref.rawPronoun || ref.resolvedEntity) {
        resolvedReferences[ref.rawPronoun || "reference"] = ref;
      }
    }

    // 10. Build Unified Context Object
    let unified: UnifiedMyraaContext = {
      ...base,
      voiceState,
      activeWindow: activeWindowInfo,
      visualContext,
      browserContext,
      brainContext,
      deviceState,
      freshnessSummary,
      conflictsDetected,
      resolvedReferences,
      provenanceChain: [
        {
          source: "application",
          field: "currentApplication",
          confidence: this.confidence.computeConfidence("application", base.timestamp, 0, now),
          timestamp: base.timestamp,
        },
        {
          source: "file",
          field: "currentFile",
          confidence: this.confidence.computeConfidence("file", base.timestamp, 0, now),
          timestamp: base.timestamp,
        },
        {
          source: "project",
          field: "currentProject",
          confidence: this.confidence.computeConfidence("project", base.timestamp, 0, now),
          timestamp: base.timestamp,
        },
        {
          source: "browser",
          field: "currentWebsite",
          confidence: this.confidence.computeConfidence("browser", browserContext.timestamp, 0, now),
          timestamp: browserContext.timestamp,
        },
      ],
    };

    if (overrides) {
      unified = {
        ...unified,
        ...overrides,
      };
    }

    // 11. Record Provenance
    this.provenance.recordProvenance({
      contextId,
      timestamp: now,
      contributingSources: [
        "voice",
        "conversation",
        "application",
        "file",
        "project",
        "browser",
        "screen",
        "brain",
        "task",
        "device",
        "recent_actions",
        "ui_state",
      ],
      conflicts: conflictsDetected,
      resolvedReferences,
      overallConfidence: this._calculateOverallConfidence(unified),
    });

    return unified;
  }

  /**
   * Helper to calculate aggregate context confidence.
   */
  private _calculateOverallConfidence(ctx: UnifiedMyraaContext): number {
    const scores = ctx.provenanceChain.map((p) => p.confidence).filter((c) => c > 0);
    if (scores.length === 0) return 0.8;
    const avg = scores.reduce((sum, s) => sum + s, 0) / scores.length;
    return Number(avg.toFixed(2));
  }
}

export const contextFusionCoordinator = new ContextFusionCoordinator();
