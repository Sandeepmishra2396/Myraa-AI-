/**
 * MYRAA — Phase 18: Adaptive Personal Brain
 * Contradiction Resolver
 *
 * Deterministically detects and resolves conflicting user preferences.
 *
 * Invariant Precedence Hierarchy:
 *   1. Explicit current user instruction in active turn ALWAYS overrides learned preference.
 *   2. More recent explicit preference (newer timestamp) supersedes older conflicting preference.
 *   3. Higher confidence overrides lower confidence.
 *   4. Higher importance overrides lower importance.
 *
 * Preserves audit history by marking superseded memories with status="superseded"
 * and tracking supersededBy ID rather than destructive deletion.
 */

import type { CognitiveMemory, ContradictionResolution, ResolvedPreference } from "./CognitiveTypes.ts";

export class ContradictionResolver {
  /**
   * Resolves a contradiction between a new candidate memory and an existing active memory.
   * Returns ContradictionResolution indicating which memory wins and why.
   */
  public resolveContradiction(
    candidate: CognitiveMemory,
    existing: CognitiveMemory
  ): ContradictionResolution {
    const candidateTime = new Date(candidate.createdAt).getTime();
    const existingTime = new Date(existing.createdAt).getTime();

    // 1. Recency check: Newer explicit user input takes precedence
    if (candidateTime > existingTime) {
      // Candidate is newer. Check if existing has strictly higher confidence/importance
      // that was user-explicit while candidate was merely an observed pattern.
      if (
        existing.sourceSignal === "explicit_correction" &&
        candidate.sourceSignal === "observed_pattern"
      ) {
        return {
          hasContradiction: true,
          conflictType: "exact_key",
          conflictingMemoryId: candidate.id,
          winningMemoryId: existing.id,
          reason: `Existing explicit correction '${existing.text}' overrides unconfirmed observed pattern '${candidate.text}'.`,
          supersededMemory: candidate,
        };
      }

      return {
        hasContradiction: true,
        conflictType: "exact_key",
        conflictingMemoryId: existing.id,
        winningMemoryId: candidate.id,
        reason: `Newer explicit preference '${candidate.text}' supersedes older preference '${existing.text}'.`,
        supersededMemory: existing,
      };
    }

    // 2. If candidate is not newer, compare confidence
    if (candidate.confidence > existing.confidence) {
      return {
        hasContradiction: true,
        conflictType: "exact_key",
        conflictingMemoryId: existing.id,
        winningMemoryId: candidate.id,
        reason: `Candidate with higher confidence (${candidate.confidence}) supersedes existing (${existing.confidence}).`,
        supersededMemory: existing,
      };
    } else if (existing.confidence > candidate.confidence) {
      return {
        hasContradiction: true,
        conflictType: "exact_key",
        conflictingMemoryId: candidate.id,
        winningMemoryId: existing.id,
        reason: `Existing memory with higher confidence (${existing.confidence}) retained over candidate (${candidate.confidence}).`,
        supersededMemory: candidate,
      };
    }

    // 3. Compare importance
    if (candidate.importance > existing.importance) {
      return {
        hasContradiction: true,
        conflictType: "exact_key",
        conflictingMemoryId: existing.id,
        winningMemoryId: candidate.id,
        reason: `Candidate with higher importance (${candidate.importance}) supersedes existing (${existing.importance}).`,
        supersededMemory: existing,
      };
    } else if (existing.importance > candidate.importance) {
      return {
        hasContradiction: true,
        conflictType: "exact_key",
        conflictingMemoryId: candidate.id,
        winningMemoryId: existing.id,
        reason: `Existing memory with higher importance (${existing.importance}) retained over candidate (${candidate.importance}).`,
        supersededMemory: candidate,
      };
    }

    // Default tie-breaker: candidate wins
    return {
      hasContradiction: true,
      conflictType: "exact_key",
      conflictingMemoryId: existing.id,
      winningMemoryId: candidate.id,
      reason: `Tied scores; recent input adopted as updated preference.`,
      supersededMemory: existing,
    };
  }

  /**
   * Marks a memory as superseded by a newer winner.
   */
  public markSuperseded(memory: CognitiveMemory, winnerId: string, reason: string): CognitiveMemory {
    const history = memory.contradictionHistory || [];
    history.push(`[${new Date().toISOString()}] Superseded by ${winnerId}: ${reason}`);

    return {
      ...memory,
      status: "superseded",
      supersededBy: winnerId,
      updatedAt: new Date().toISOString(),
      contradictionHistory: history,
    };
  }

  /**
   * Enforces Runtime Precedence:
   * "Explicit current user instruction always overrides learned preference."
   *
   * Checks if current utterance explicitly specifies a value for the given preference domain.
   */
  public resolveRuntimePrecedence<T>(
    key: string,
    defaultValue: T,
    learnedMemory: CognitiveMemory | null | undefined,
    currentUtterance?: string
  ): ResolvedPreference<T> {
    const text = (currentUtterance || "").toLowerCase().trim();

    // Check domain-specific explicit overrides in the current utterance
    if (text.length > 0) {
      // 1. Preferred Editor
      if (key === "workflow.preferred_editor") {
        if (/\b(cursor|notepad|sublime|vim|neovim|intellij|webstorm)\b/i.test(text)) {
          const match = text.match(/\b(cursor|notepad|sublime|vim|neovim|intellij|webstorm)\b/i);
          const overrideVal = match ? (match[1].toLowerCase() as unknown as T) : defaultValue;
          return {
            value: overrideVal,
            source: "explicit_override",
            isExplicitOverride: true,
            confidence: 1.0,
            rationale: `Explicit instruction in current turn specified '${String(overrideVal)}', overriding learned preference.`,
          };
        }
        if (/\b(vscode|vs code|code)\b/i.test(text)) {
          return {
            value: "vscode" as unknown as T,
            source: "explicit_override",
            isExplicitOverride: true,
            confidence: 1.0,
            rationale: "Explicit instruction in current turn specified 'vscode'.",
          };
        }
      }

      // 2. Indentation
      if (key === "coding.indentation") {
        if (/\b(tabs|tab)\b/i.test(text)) {
          return {
            value: "tabs" as unknown as T,
            source: "explicit_override",
            isExplicitOverride: true,
            confidence: 1.0,
            rationale: "Explicit instruction in current turn specified 'tabs'.",
          };
        }
        if (/\b(2 spaces?|two spaces?)\b/i.test(text)) {
          return {
            value: "2_spaces" as unknown as T,
            source: "explicit_override",
            isExplicitOverride: true,
            confidence: 1.0,
            rationale: "Explicit instruction in current turn specified '2_spaces'.",
          };
        }
        if (/\b(4 spaces?|four spaces?)\b/i.test(text)) {
          return {
            value: "4_spaces" as unknown as T,
            source: "explicit_override",
            isExplicitOverride: true,
            confidence: 1.0,
            rationale: "Explicit instruction in current turn specified '4_spaces'.",
          };
        }
      }

      // 3. Language
      if (key === "comm.language") {
        if (/\b(hindi|हिन्दी)\b/i.test(text) && !/english/i.test(text)) {
          return {
            value: "hindi" as unknown as T,
            source: "explicit_override",
            isExplicitOverride: true,
            confidence: 1.0,
            rationale: "Explicit instruction in current turn requested Hindi.",
          };
        }
        if (/\b(english)\b/i.test(text) && !/hindi/i.test(text)) {
          return {
            value: "english" as unknown as T,
            source: "explicit_override",
            isExplicitOverride: true,
            confidence: 1.0,
            rationale: "Explicit instruction in current turn requested English.",
          };
        }
        if (/\b(hinglish)\b/i.test(text)) {
          return {
            value: "hinglish" as unknown as T,
            source: "explicit_override",
            isExplicitOverride: true,
            confidence: 1.0,
            rationale: "Explicit instruction in current turn requested Hinglish.",
          };
        }
      }

      // 4. Verbosity
      if (key === "comm.verbosity") {
        if (/\b(short|chhota|brief|concise|ek line)\b/i.test(text)) {
          return {
            value: "concise" as unknown as T,
            source: "explicit_override",
            isExplicitOverride: true,
            confidence: 1.0,
            rationale: "Explicit instruction in current turn requested concise response.",
          };
        }
        if (/\b(detail|in-depth|samjhao|explain|thorough)\b/i.test(text)) {
          return {
            value: "detailed" as unknown as T,
            source: "explicit_override",
            isExplicitOverride: true,
            confidence: 1.0,
            rationale: "Explicit instruction in current turn requested detailed response.",
          };
        }
      }

      // 5. UI Theme
      if (key === "ui.theme") {
        if (/\b(dark mode|dark theme)\b/i.test(text)) {
          return {
            value: "dark" as unknown as T,
            source: "explicit_override",
            isExplicitOverride: true,
            confidence: 1.0,
            rationale: "Explicit instruction in current turn specified dark mode.",
          };
        }
        if (/\b(light mode|light theme)\b/i.test(text)) {
          return {
            value: "light" as unknown as T,
            source: "explicit_override",
            isExplicitOverride: true,
            confidence: 1.0,
            rationale: "Explicit instruction in current turn specified light mode.",
          };
        }
      }
    }

    // No explicit override in current turn. Fall back to active learned memory if valid
    if (learnedMemory && learnedMemory.status === "active") {
      // Check expiration
      if (learnedMemory.expiresAt) {
        const expTime = new Date(learnedMemory.expiresAt).getTime();
        if (Date.now() > expTime) {
          // Expired! Fall back to default
          return {
            value: defaultValue,
            source: "default",
            isExplicitOverride: false,
            confidence: 0.5,
            rationale: `Learned memory '${learnedMemory.key}' has expired (TTL passed). Used default.`,
          };
        }
      }

      // Check minimum confidence threshold: low-confidence (<0.5) cannot be treated as fact
      if (learnedMemory.confidence >= 0.5) {
        return {
          value: learnedMemory.value as T,
          source: "learned_preference",
          isExplicitOverride: false,
          confidence: learnedMemory.confidence,
          memoryId: learnedMemory.id,
          rationale: `Applied learned preference from memory '${learnedMemory.id}' (confidence: ${learnedMemory.confidence}).`,
        };
      }
    }

    // Fall back to default value
    return {
      value: defaultValue,
      source: "default",
      isExplicitOverride: false,
      confidence: 0.5,
      rationale: `No explicit override or active learned preference; applied default value '${String(defaultValue)}'.`,
    };
  }
}

export const contradictionResolver = new ContradictionResolver();
