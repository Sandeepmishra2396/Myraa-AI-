/**
 * MYRAA — Step 8: Advanced Browser Research Agent
 * ResearchQueryPlanner
 *
 * Decomposes a user question into a structured multi-angle query plan:
 *   Primary, Secondary, Official Doc, Version-Specific, Known-Issue,
 *   and Implementation queries.
 *
 * Security: All query generation is local — no external calls here.
 */

import type {
  ResearchQueryPlan,
  QueryRefinementStep,
  RefinedQueryPlan,
} from "./AdvancedResearchTypes.ts";
import { multiAgentContextManager } from "../multiagent/MultiAgentContextManager.ts";

// ---------------------------------------------------------------------------
// Domain-specific query templates
// ---------------------------------------------------------------------------

interface QueryTemplate {
  keywords: RegExp;
  officialDomain: string;
  versionKeywords: string[];
  knownIssueKeywords: string[];
}

const QUERY_TEMPLATES: QueryTemplate[] = [
  {
    keywords: /gemini\s*(live|api|sdk|flash|pro|ultra)/i,
    officialDomain: "ai.google.dev",
    versionKeywords: ["gemini-2.0", "gemini-1.5", "gemini-2.5", "genai sdk version"],
    knownIssueKeywords: ["gemini live issue", "gemini api error", "gemini sdk bug"],
  },
  {
    keywords: /\b(react|nextjs|next\.js)\b/i,
    officialDomain: "react.dev",
    versionKeywords: ["react 18", "react 19", "react version"],
    knownIssueKeywords: ["react known issue", "react breaking change"],
  },
  {
    keywords: /\b(typescript|tsc)\b/i,
    officialDomain: "typescriptlang.org",
    versionKeywords: ["typescript 5", "tsc version"],
    knownIssueKeywords: ["typescript error", "typescript breaking change"],
  },
  {
    keywords: /\b(vite|esbuild)\b/i,
    officialDomain: "vitejs.dev",
    versionKeywords: ["vite 5", "vite 6"],
    knownIssueKeywords: ["vite issue", "vite plugin error"],
  },
  {
    keywords: /\b(express|fastapi|flask)\b/i,
    officialDomain: "expressjs.com",
    versionKeywords: ["express 4", "express 5"],
    knownIssueKeywords: ["express middleware issue", "express breaking change"],
  },
];

// ---------------------------------------------------------------------------
// ResearchQueryPlanner
// ---------------------------------------------------------------------------

export class ResearchQueryPlanner {
  /**
   * Decompose a user question into a structured, multi-angle query plan.
   * Sanitizes input before any processing to prevent injection.
   */
  public plan(rawQuestion: string): ResearchQueryPlan {
    const sanitized = multiAgentContextManager.sanitizeUntrustedInput(rawQuestion);
    const lower = sanitized.toLowerCase();

    const template = this._matchTemplate(lower);

    const primaryQuery = sanitized;

    const secondaryQueries: string[] = [
      `${sanitized} example`,
      `${sanitized} best practices`,
      `how to ${sanitized}`,
      `${sanitized} tutorial`,
    ];

    const officialDocQuery = template
      ? `site:${template.officialDomain} ${sanitized}`
      : `${sanitized} official documentation`;

    const versionSpecificQuery = template
      ? `${sanitized} ${template.versionKeywords[0]}`
      : `${sanitized} version compatibility`;

    const knownIssueQuery = template
      ? `${sanitized} ${template.knownIssueKeywords[0]}`
      : `${sanitized} known issues problems`;

    const implementationQuery = `${sanitized} implementation code example typescript`;

    const searchDomains: string[] = [
      "ai.google.dev",
      "developers.google.com",
      "github.com",
      "stackoverflow.com",
      "developer.mozilla.org",
    ];
    if (template) {
      searchDomains.unshift(template.officialDomain);
    }

    const wordCount = sanitized.split(/\s+/).length;
    const estimatedComplexity: ResearchQueryPlan["estimatedComplexity"] =
      wordCount <= 5 ? "SIMPLE" : wordCount <= 15 ? "MODERATE" : "COMPLEX";

    return {
      originalQuestion: sanitized,
      primaryQuery,
      secondaryQueries,
      officialDocQuery,
      versionSpecificQuery,
      knownIssueQuery,
      implementationQuery,
      searchDomains: [...new Set(searchDomains)],
      estimatedComplexity,
    };
  }

  /**
   * Decompose a compound query into distinct atomic sub-queries.
   */
  public decompose(question: string): string[] {
    const sanitized = multiAgentContextManager.sanitizeUntrustedInput(question);

    // Check for comparison or conjunction splits
    const splitRegex = /\s+(?:and also|and then|as well as|\bvs\.?\b|\bversus\b|compared to|and)\s+/i;
    const parts = sanitized.split(splitRegex).map((p) => p.trim()).filter((p) => p.length > 5);

    if (parts.length > 1) {
      return parts;
    }

    // Check for question mark / sentence splits
    const sentenceParts = sanitized.split(/[?.!]\s+/).map((p) => p.trim()).filter((p) => p.length > 8);
    if (sentenceParts.length > 1) {
      return sentenceParts;
    }

    return [sanitized];
  }

  /**
   * Perform bounded query refinement when evidence is missing, conflicting, or unverified.
   * Hard bounded to at most 3 refinement iterations to avoid infinite search loops.
   */
  public refinePlan(
    plan: ResearchQueryPlan,
    unverifiedTopics: string[],
    currentIteration = 1,
    maxIterations = 3
  ): RefinedQueryPlan {
    const refinements: QueryRefinementStep[] = [];
    const boundedIteration = Math.min(currentIteration, maxIterations);

    // Strictly halt refinement if currentIteration exceeds maxIterations
    if (currentIteration <= maxIterations && unverifiedTopics.length > 0) {
      for (const topic of unverifiedTopics.slice(0, 3)) {
        // 1. Official Documentation Target
        refinements.push({
          iteration: boundedIteration,
          originalQuery: plan.primaryQuery,
          refinedQuery: `${topic} official documentation API reference`,
          targetAngle: "OFFICIAL_DOC",
          reason: `Targeting authoritative source for unverified topic "${topic.slice(0, 40)}"`,
        });

        // 2. Version Specific / Breaking Changes Target
        refinements.push({
          iteration: boundedIteration,
          originalQuery: plan.primaryQuery,
          refinedQuery: `${topic} version compatibility changelog breaking changes`,
          targetAngle: "VERSION_SPECIFIC",
          reason: `Resolving version dependency or compatibility gap for "${topic.slice(0, 40)}"`,
        });

        // 3. Known Issues / Error Messages Target
        refinements.push({
          iteration: boundedIteration,
          originalQuery: plan.primaryQuery,
          refinedQuery: `${topic} known issue bug error workaround`,
          targetAngle: "KNOWN_ISSUE",
          reason: `Investigating conflicting evidence or potential bug/limitation for "${topic.slice(0, 40)}"`,
        });
      }
    }

    return {
      ...plan,
      refinements,
      currentIteration: boundedIteration,
      maxIterations,
    };
  }

  private _matchTemplate(lower: string): QueryTemplate | null {
    for (const t of QUERY_TEMPLATES) {
      if (t.keywords.test(lower)) return t;
    }
    return null;
  }
}

export const researchQueryPlanner = new ResearchQueryPlanner();

