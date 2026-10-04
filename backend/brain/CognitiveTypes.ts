/**
 * MYRAA — Phase 18: Adaptive Personal Brain
 * Cognitive Types & Interfaces
 *
 * Defines the core types for MYRAA's Personal Cognitive Learning Layer.
 * Enables autonomous preference learning, correction detection, communication style adaptation,
 * command pattern frequency tracking, contradiction resolution, and TTL expiration without retraining
 * the base Gemini model.
 */

/**
 * High-level categories for learned cognitive memories.
 */
export type CognitiveCategory =
  | "preference"             // General preferences
  | "correction"             // Direct user corrections / rules
  | "communication_style"    // Tone, verbosity, language code-switching
  | "command_pattern"        // Frequently used commands and workflows
  | "coding_preference"      // Indentation, frameworks, linters, test tools
  | "workflow_preference"    // Default editors, workspaces, auto-confirmations
  | "ui_preference";         // Themes, layout densities, display options

/**
 * Origin of the learning signal.
 */
export type LearningSignalSource =
  | "explicit_correction"    // User explicitly corrected MYRAA ("Mujhe ye format pasand nahi hai", "Ye mat karo")
  | "explicit_statement"     // User stated a direct preference ("I prefer tabs", "Dark mode pasand hai")
  | "observed_pattern"       // Observed repeated actions (e.g. executed >= 3 times)
  | "user_feedback"          // Subtle feedback or preference hint
  | "system_configured";     // System default / seeded rule

/**
 * Status lifecycle of a cognitive memory.
 */
export type CognitiveMemoryStatus =
  | "active"                 // Currently valid and applied to context
  | "superseded"             // Replaced by a newer or higher-confidence preference
  | "expired"                // Temporary preference whose TTL has elapsed
  | "archived";              // Explicitly archived or retired

/**
 * Confidence level category.
 */
export type ConfidenceTier = "low" | "medium" | "high";

/**
 * Evaluates the confidence tier from a numeric score (0.0 to 1.0).
 */
export function getConfidenceTier(confidence: number): ConfidenceTier {
  if (confidence >= 0.8) return "high";
  if (confidence >= 0.5) return "medium";
  return "low";
}

/**
 * Canonical Cognitive Memory Record.
 * Stored in DATA_DIR/cognitive_memories.json.
 */
export interface CognitiveMemory {
  /** Unique ID, e.g. "cog_1696291200000_abc12" */
  id: string;

  /** Category of the learned memory */
  category: CognitiveCategory;

  /**
   * Dot-notated key anchor for deduplication and domain indexing,
   * e.g. "coding.indentation", "comm.verbosity", "ui.theme", "workflow.preferred_editor"
   */
  key: string;

  /** Structured value, e.g. "2_spaces", "concise", "dark", "vscode", true */
  value: any;

  /** Human-readable explanation of the preference */
  text: string;

  /**
   * Confidence score from 0.0 to 1.0.
   * Low-confidence memories (< 0.5) must NOT be treated as facts or injected into strict decision overrides.
   */
  confidence: number;

  /**
   * Importance level from 1 to 5.
   * 1 = low/transient, 3 = normal, 5 = critical permanent rule.
   */
  importance: number;

  /** Origin of this memory */
  sourceSignal: LearningSignalSource;

  /** Current lifecycle status */
  status: CognitiveMemoryStatus;

  /** ISO8601 creation timestamp */
  createdAt: string;

  /** ISO8601 last updated timestamp */
  updatedAt: string;

  /** Optional ISO8601 expiration timestamp. If absent, memory is permanent until superseded. */
  expiresAt?: string;

  /** ISO8601 timestamp of last retrieval or reinforcement */
  lastUsedAt?: string;

  /** Number of times this memory was retrieved or matched */
  usageCount: number;

  /** Number of times this memory was re-stated or reinforced by the user */
  reinforcementCount: number;

  /** If superseded, the ID of the memory that replaced it */
  supersededBy?: string;

  /** Audit trail of why/when this memory was updated or superseded */
  contradictionHistory?: string[];

  /** Raw utterance or trigger that originally created this memory */
  rawSignal?: string;
}

/**
 * Structured Learning Signal extracted from user input.
 */
export interface LearningSignal {
  type:
    | "correction"
    | "preference_statement"
    | "style_feedback"
    | "command_execution"
    | "negative_feedback"
    | "positive_feedback";
  rawUtterance: string;
  category: CognitiveCategory;
  key: string;
  value: any;
  confidence: number;
  importance: number;
  isTemporary: boolean;
  ttlMs?: number;
  explanation: string;
}

/**
 * Result of contradiction resolution between memories.
 */
export interface ContradictionResolution {
  hasContradiction: boolean;
  conflictType?: "exact_key" | "category_clash" | "domain_opposition";
  conflictingMemoryId?: string;
  winningMemoryId?: string;
  reason: string;
  supersededMemory?: CognitiveMemory;
}

/**
 * Result of deduplication check against existing memory.
 */
export interface DeduplicationCheckResult {
  isDuplicate: boolean;
  action: "create" | "reinforce" | "contradict" | "ignore";
  existingMemory?: CognitiveMemory;
  similarityScore: number;
}

/**
 * Command frequency tracking record.
 * Stored in DATA_DIR/command_patterns.json.
 */
export interface CommandPatternRecord {
  patternKey: string;
  toolName: string;
  target: string;
  frequency: number;
  firstSeenAt: string;
  lastExecutedAt: string;
  contextHints?: Record<string, any>;
}

/**
 * Effective preference resolution result.
 */
export interface ResolvedPreference<T = any> {
  value: T;
  source: "explicit_override" | "learned_preference" | "default";
  isExplicitOverride: boolean;
  confidence: number;
  memoryId?: string;
  rationale: string;
}
