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

import type { ResearchQueryPlan } from "./AdvancedResearchTypes.ts";
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

  private _matchTemplate(lower: string): QueryTemplate | null {
    for (const t of QUERY_TEMPLATES) {
      if (t.keywords.test(lower)) return t;
    }
    return null;
  }
}

export const researchQueryPlanner = new ResearchQueryPlanner();
