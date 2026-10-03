/**
 * MYRAA — Phase 18: Adaptive Personal Brain
 * Cognitive Learning Coordinator
 *
 * Master Orchestrator for the Personal Cognitive Learning Layer.
 * Unites signal detection, preference extraction, deduplication, contradiction resolution,
 * persistent storage, and context prompt synthesis.
 *
 * Enforces all Phase 18 Invariants:
 *   - Explicit current instruction ALWAYS overrides learned preference.
 *   - Conflicting preferences resolve deterministically.
 *   - Temporary preferences expire cleanly (TTL).
 *   - Low-confidence assumptions (<0.5) are NEVER treated as facts.
 *   - Never silently invent memories.
 */

import {
  cognitiveMemoryStore,
  CognitiveMemoryStore,
} from "./CognitiveMemoryStore.ts";
import {
  learningSignalDetector,
  LearningSignalDetector,
} from "./LearningSignalDetector.ts";
import {
  preferenceExtractor,
  PreferenceExtractor,
} from "./PreferenceExtractor.ts";
import {
  deduplicationEngine,
  DeduplicationEngine,
} from "./DeduplicationEngine.ts";
import {
  contradictionResolver,
  ContradictionResolver,
} from "./ContradictionResolver.ts";
import {
  adaptivePromptSynthesizer,
  AdaptivePromptSynthesizer,
} from "./AdaptivePromptSynthesizer.ts";
import type {
  CognitiveCategory,
  CognitiveMemory,
  CognitiveMemoryStatus,
  CommandPatternRecord,
  LearningSignal,
  ResolvedPreference,
} from "./CognitiveTypes.ts";

export class CognitiveLearningCoordinator {
  private _store: CognitiveMemoryStore;
  private _detector: LearningSignalDetector;
  private _extractor: PreferenceExtractor;
  private _dedup: DeduplicationEngine;
  private _resolver: ContradictionResolver;
  private _synthesizer: AdaptivePromptSynthesizer;

  constructor(
    store = cognitiveMemoryStore,
    detector = learningSignalDetector,
    extractor = preferenceExtractor,
    dedup = deduplicationEngine,
    resolver = contradictionResolver,
    synthesizer = adaptivePromptSynthesizer
  ) {
    this._store = store;
    this._detector = detector;
    this._extractor = extractor;
    this._dedup = dedup;
    this._resolver = resolver;
    this._synthesizer = synthesizer;
  }

  /**
   * Main entrypoint for processing user conversation or feedback turns.
   * Detects learning signals, extracts candidate memory, checks duplicates and contradictions,
   * and persists the resulting adaptation.
   */
  public async processUserInput(
    utterance: string,
    _contextId = "default"
  ): Promise<{
    signal: LearningSignal | null;
    memory: CognitiveMemory | null;
    action: "created" | "reinforced" | "superseded" | "ignored";
  }> {
    // 1. Detect learning signal
    const signal = this._detector.detectSignal(utterance);
    if (!signal) {
      return { signal: null, memory: null, action: "ignored" };
    }

    // 2. Extract candidate cognitive memory
    const candidate = this._extractor.extractMemory(signal);

    // 3. Load existing memories and evaluate duplicates/contradictions
    const existing = await this._store.loadMemories();
    const check = this._dedup.checkDuplicate(candidate, existing);

    // Case A: Duplicate / Reinforcement
    if (check.action === "reinforce" && check.existingMemory) {
      const reinforced = this._dedup.reinforceMemory(check.existingMemory, candidate);
      await this._store.saveMemory(reinforced);
      return { signal, memory: reinforced, action: "reinforced" };
    }

    // Case B: Contradiction with existing active memory
    if (check.action === "contradict" && check.existingMemory) {
      const resolution = this._resolver.resolveContradiction(candidate, check.existingMemory);
      if (resolution.winningMemoryId === candidate.id) {
        // Candidate won! Supersede existing memory and save candidate
        await this._store.supersedeMemory(
          check.existingMemory.id,
          candidate.id,
          resolution.reason
        );
        const saved = await this._store.saveMemory(candidate);
        return { signal, memory: saved, action: "superseded" };
      } else {
        // Existing memory held precedence (e.g. existing was explicit correction, candidate was weak)
        return { signal, memory: check.existingMemory, action: "ignored" };
      }
    }

    // Case C: Brand new memory candidate
    const saved = await this._store.saveMemory(candidate);
    return { signal, memory: saved, action: "created" };
  }

  /**
   * Records a command execution and updates the command frequency patterns.
   */
  public async recordCommand(
    toolName: string,
    target: string,
    contextHints?: Record<string, any>
  ): Promise<CommandPatternRecord> {
    return this._store.recordCommandPattern(toolName, target, contextHints);
  }

  /**
   * Resolves effective preference value for a given key, strictly respecting runtime precedence:
   * Explicit current instruction > Learned preference > Default value.
   */
  public async resolveEffectivePreference<T>(
    key: string,
    defaultValue: T,
    currentUtterance?: string
  ): Promise<ResolvedPreference<T>> {
    const memory = await this._store.getActiveMemoryByKey(key);
    const resolved = this._resolver.resolveRuntimePrecedence(
      key,
      defaultValue,
      memory,
      currentUtterance
    );

    if (resolved.source === "learned_preference" && memory) {
      await this._store.recordUsage(memory.id);
    }

    return resolved;
  }

  /**
   * Retrieves the adaptive system prompt directive block for Gemini Live and conversation sessions.
   */
  public async getAdaptivePrompt(maxChars = 800, minConfidence = 0.6): Promise<string> {
    return this._synthesizer.synthesizePrompt(maxChars, minConfidence);
  }

  /**
   * Lists learned cognitive memories with optional filtering.
   */
  public async listPreferences(filter?: {
    category?: CognitiveCategory;
    status?: CognitiveMemoryStatus;
    minConfidence?: number;
  }): Promise<CognitiveMemory[]> {
    return this._store.listMemories(filter);
  }

  /**
   * Deletes a specific learned preference.
   */
  public async deletePreference(id: string): Promise<boolean> {
    return this._store.deleteMemory(id);
  }

  /**
   * Retrieves frequently used command patterns.
   */
  public async getFrequentCommands(minFrequency = 3): Promise<CommandPatternRecord[]> {
    return this._store.getFrequentCommandPatterns(minFrequency);
  }

  /**
   * Clear all memories and command patterns.
   */
  public async clearAll(): Promise<void> {
    await this._store.clear();
    await this._store.clearCommandPatterns();
  }
}

export const cognitiveLearningCoordinator = new CognitiveLearningCoordinator();
