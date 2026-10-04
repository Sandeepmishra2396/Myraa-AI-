/**
 * MYRAA — Step 8: Advanced Browser Research Agent
 * MultiSourceSearchEngine
 *
 * Executes a ResearchQueryPlan against multiple URL sources:
 *   1. Generates search URLs from the query plan
 *   2. Uses safeSsrfFetch for SSRF-safe HTTP fetching
 *   3. Returns fetched ResearchSources (already sanitized by SourceFetcher)
 *
 * Note: This uses the existing /api/web-proxy route pattern + safeSsrfFetch.
 * It does NOT open real browser windows — that would require Electron/Puppeteer.
 * For full browser automation, use BrowserContextResearcher via Electron.
 */

import type { ResearchQueryPlan, ResearchSource } from "./AdvancedResearchTypes.ts";
import { sourceFetcher } from "./SourceFetcher.ts";

// Pre-approved search/documentation endpoints (SSRF-safe, not user-supplied IPs)
const SEARCH_ENDPOINTS: Record<string, string> = {
  // Google AI documentation
  "ai.google.dev": "https://ai.google.dev/gemini-api/docs",
  "developers.google.com": "https://developers.google.com/",
  // MDN
  "developer.mozilla.org": "https://developer.mozilla.org/en-US/docs/Web/API",
  // TypeScript
  "typescriptlang.org": "https://www.typescriptlang.org/docs/",
  // React
  "react.dev": "https://react.dev/reference/react",
  // Vite
  "vitejs.dev": "https://vitejs.dev/guide/",
};

export class MultiSourceSearchEngine {
  /**
   * Execute a research query plan and fetch sources.
   * Returns deduplicated, security-validated ResearchSources.
   */
  public async search(
    plan: ResearchQueryPlan,
    maxSources = 5
  ): Promise<ResearchSource[]> {
    const urlsToFetch = this._generateUrls(plan, maxSources);
    const sources: ResearchSource[] = [];
    const seenUrls = new Set<string>();

    // Fetch in parallel (max 5 concurrent)
    const fetchPromises = urlsToFetch.slice(0, maxSources).map(async (url) => {
      if (seenUrls.has(url)) return null;
      seenUrls.add(url);
      try {
        return await sourceFetcher.fetch(url);
      } catch {
        return null;
      }
    });

    const results = await Promise.allSettled(fetchPromises);
    for (const result of results) {
      if (result.status === "fulfilled" && result.value) {
        sources.push(result.value);
      }
    }

    // Sort by reliability (highest first)
    return sources.sort((a, b) => b.reliability.composite - a.reliability.composite);
  }

  // ---------------------------------------------------------------------------
  // URL generation from query plan
  // ---------------------------------------------------------------------------

  private _generateUrls(plan: ResearchQueryPlan, maxSources: number): string[] {
    const urls: string[] = [];

    // Priority 1: Official documentation domains matching the query
    for (const domain of plan.searchDomains) {
      const base = SEARCH_ENDPOINTS[domain];
      if (base) {
        urls.push(base);
        if (urls.length >= maxSources) return urls;
      }
    }

    // Priority 2: Official doc query using DuckDuckGo HTML (no JS required, SSRF-safe)
    // We fetch the DuckDuckGo HTML results page — no API key needed
    const duckDuckGoBase = "https://html.duckduckgo.com/html/?q=";
    const queries = [
      plan.officialDocQuery,
      plan.primaryQuery,
      plan.versionSpecificQuery,
    ];

    for (const q of queries) {
      const encoded = encodeURIComponent(q.slice(0, 200));
      urls.push(`${duckDuckGoBase}${encoded}`);
      if (urls.length >= maxSources + 3) break; // Fetch a few extra, filter by reliability
    }

    return urls;
  }
}

export const multiSourceSearchEngine = new MultiSourceSearchEngine();
