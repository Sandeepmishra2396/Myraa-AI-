/**
 * MYRAA — GoalParser (Phase 5)
 *
 * Deconstructs a natural language user utterance into a structured `Goal`.
 *
 * Design:
 *   • Works entirely with deterministic NLP (keyword matching, pattern lists).
 *   • No network calls, no Gemini API invocations — safe for offline use and unit tests.
 *   • Never fabricates target files, scope, or expected outcomes beyond what
 *     can be inferred from the input text.
 */

import crypto from "crypto";
import type { Goal, GoalCategory, GoalScope, GoalExpectedOutcome } from "./PlannerTypes.ts";

// ---------------------------------------------------------------------------
// Category heuristics (keyword → category priority list)
// ---------------------------------------------------------------------------

const CATEGORY_KEYWORDS: Array<{ keywords: RegExp; category: GoalCategory }> = [
  // Mobile / voice workflow intent recognition (Phase 27)
  {
    keywords: /\b(schedule|calendar|meeting|appointment|remind|reminder|yaad dila|alarm|timer|project status|git status|project ka status|latest status|battery status|wifi status|device status|phone status|directions to)\b/i,
    category: "workflow",
  },
  { keywords: /\b(readme|documentation|doc|comment|jsdoc|wiki|changelog)\b/i, category: "documentation" },
  { keywords: /\b(bug|fix|error|crash|exception|issue|patch|resolve)\b/i,     category: "bugfix" },
  { keywords: /\b(refactor|restructure|clean|reorganize|rename|move)\b/i,     category: "refactor" },
  { keywords: /\b(test|spec|unit|e2e|coverage|vitest|jest)\b/i,               category: "testing" },
  { keywords: /\b(feature|add|implement|create|build|develop|write)\b/i,      category: "feature" },
  { keywords: /\b(research|search|find|look ?up|investigate|explore|latest)\b/i, category: "research" },
  { keywords: /\b(analyz|inspect|understand|explain|describe|architecture)\b/i, category: "exploration" },
  { keywords: /\b(build|compile|bundle|package|deploy|publish)\b/i,            category: "build" },
];

// ---------------------------------------------------------------------------
// Destructive-action heuristics
// ---------------------------------------------------------------------------

const MODIFYING_KEYWORDS =
  /\b(update|write|create|modify|change|edit|add|remove|delete|refactor|fix|rename|move|implement|generate|overwrite|replace|patch|build|run|execute|install|deploy)\b/i;

// ---------------------------------------------------------------------------
// Target-file extraction (naive: look for *.ext or known filenames)
// ---------------------------------------------------------------------------

const FILE_PATTERN = /([A-Za-z0-9_\-./\\]+\.(ts|tsx|js|jsx|json|md|txt|py|html|css|yaml|yml|toml|sh|bat))/g;

function extractTargetFiles(text: string): string[] {
  const matches = [...text.matchAll(FILE_PATTERN)].map((m) => m[1]);
  // Deduplicate while preserving order
  const seen = new Set<string>();
  return matches.filter((f) => { if (seen.has(f)) return false; seen.add(f); return true; });
}

// ---------------------------------------------------------------------------
// Symbol extraction (PascalCase or camelCase words that look like identifiers)
// ---------------------------------------------------------------------------

const SYMBOL_PATTERN = /\b([A-Z][a-zA-Z0-9]{2,}(?:Manager|Store|Service|Component|Controller|Engine|Factory|Handler|Router|Middleware|Hook|Context|Provider))\b/g;

function extractSymbols(text: string): string[] {
  const matches = [...text.matchAll(SYMBOL_PATTERN)].map((m) => m[1]);
  const seen = new Set<string>();
  return matches.filter((s) => { if (seen.has(s)) return false; seen.add(s); return true; });
}

// ---------------------------------------------------------------------------
// Expected-outcome generation from category + input
// ---------------------------------------------------------------------------

function buildExpectedOutcomes(category: GoalCategory, input: string): GoalExpectedOutcome[] {
  const base: GoalExpectedOutcome[] = [];

  switch (category) {
    case "documentation":
      base.push({
        description: "Target documentation file is updated with current content.",
        verificationHint: "Check that the target file exists, is non-empty, and contains the described sections.",
      });
      break;
    case "bugfix":
      base.push(
        {
          description: "The identified bug is patched in the affected file(s).",
          verificationHint: "Read the modified file and confirm the fix is present.",
        },
        {
          description: "No new TypeScript or lint errors are introduced.",
          verificationHint: "Run `npm run lint` and confirm exit code 0.",
        },
      );
      break;
    case "refactor":
      base.push(
        {
          description: "Code is restructured according to the requested changes.",
          verificationHint: "Read the modified file(s) and confirm the refactoring is applied.",
        },
        {
          description: "Existing tests continue to pass after refactoring.",
          verificationHint: "Run `npm test` and confirm all tests pass.",
        },
      );
      break;
    case "feature":
      base.push(
        {
          description: "New feature code is written and saved to the appropriate file.",
          verificationHint: "Read the target file and confirm the feature code is present.",
        },
        {
          description: "Feature integrates without breaking existing functionality.",
          verificationHint: "Run `npm run lint` and `npm test` and confirm 0 errors.",
        },
      );
      break;
    case "research":
      base.push({
        description: "Research findings are gathered from live sources with citations.",
        verificationHint: "Verify that at least 3 cited sources are returned and the summary is non-empty.",
      });
      break;
    case "exploration":
      base.push({
        description: "Architectural analysis or code structure summary is produced.",
        verificationHint: "Confirm that layers, entry points, and key components are described.",
      });
      break;
    case "build":
      base.push({
        description: "Build completes without errors.",
        verificationHint: "Run `npm run build` and confirm exit code 0.",
      });
      break;
    case "testing":
      base.push({
        description: "Tests are written and all pass.",
        verificationHint: "Run `npm test` and confirm all tests pass with 0 failures.",
      });
      break;
    case "workflow":
      base.push({
        description: "Autonomous workflow steps completed and outcomes verified.",
        verificationHint: "Check that capability execution results are non-empty and error-free.",
      });
      break;
    default:
      base.push({
        description: "The requested goal is completed successfully.",
        verificationHint: "Confirm the goal's primary outcome is observable.",
      });
  }

  return base;
}

// ---------------------------------------------------------------------------
// GoalParser
// ---------------------------------------------------------------------------

export class GoalParser {
  /**
   * Parse a natural language goal string into a structured `Goal`.
   * Never throws — returns a valid Goal even for ambiguous or very short input.
   */
  parse(rawInput: string): Goal {
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const text = (rawInput || "").trim();

    // 1. Detect category
    let category: GoalCategory = "general";
    for (const { keywords, category: cat } of CATEGORY_KEYWORDS) {
      if (keywords.test(text)) {
        category = cat;
        break;
      }
    }

    // 2. Determine if modifying / destructive
    const requiresModification = MODIFYING_KEYWORDS.test(text);

    // 3. Extract target files and symbols
    const targetFiles = extractTargetFiles(text);
    const symbols = extractSymbols(text);
    const maxModifiableFiles = Math.max(5, targetFiles.length * 2 + 3);

    const scope: GoalScope = { targetFiles, symbols, maxModifiableFiles };

    // 4. Build objective summary (truncate input to reasonable length)
    const objective =
      text.length <= 120
        ? text
        : text.substring(0, 117) + "…";

    // 5. Build expected outcomes
    const expectedOutcomes = buildExpectedOutcomes(category, text);

    return {
      id,
      rawInput: text,
      objective,
      category,
      scope,
      expectedOutcomes,
      requiresModification,
      createdAt,
    };
  }
}

/** Shared singleton. Tests can instantiate their own. */
export const goalParser = new GoalParser();
