/**
 * MYRAA — WebSearchEngine (Phase 4)
 *
 * Performs live web searches via DuckDuckGo HTML parser with comprehensive SSRF protection.
 * Unwraps true destination URLs and extracts clean titles and snippets.
 *
 * Safeguards & Reliability:
 *   • SSRF Protection: All outgoing requests pass through safeSsrfFetch, and
 *     unwrapped destination URLs are checked with isSsrfSafeUrl.
 *   • Timeout Enforcement: AbortController with FETCH_TIMEOUT_MS (10 seconds).
 *   • Non-Fabrication Guarantee:
 *     - Titles, URLs, and snippets are taken verbatim from actual search results.
 *     - publicationDate is set to "unknown/unverified" when not explicitly present.
 *   • Result bounds: Capped at MAX_SEARCH_RESULTS (10).
 *   • Graceful Error Handling: Returns [] on network or DNS errors without crashing.
 */

import {
  safeSsrfFetch,
  isSsrfSafeUrl,
} from "../security/PermissionManager.ts";
import {
  SearchResult,
  MAX_SEARCH_RESULTS,
  FETCH_TIMEOUT_MS,
} from "./KnowledgeTypes.ts";
import { ContentExtractor } from "./ContentExtractor.ts";

export class WebSearchEngine {
  /**
   * Searches DuckDuckGo HTML for a query and extracts clean SearchResults.
   */
  static async search(query: string, maxResults: number = 5): Promise<SearchResult[]> {
    const cleanQuery = (query || "").trim();
    if (!cleanQuery) {
      return [];
    }

    const limit = Math.min(Math.max(1, maxResults), MAX_SEARCH_RESULTS);
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(cleanQuery)}`;

    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);

      const response = await safeSsrfFetch(searchUrl, {
        signal: ctrl.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });

      clearTimeout(timer);

      if (!response.ok) {
        console.warn(`[WebSearchEngine] DuckDuckGo returned status ${response.status}`);
        return [];
      }

      const html = await response.text();
      return await WebSearchEngine.parseDuckDuckGoHtml(html, limit);
    } catch (err: any) {
      console.warn(`[WebSearchEngine] Search failed for query "${cleanQuery}":`, err?.message || err);
      return [];
    }
  }

  /**
   * Parses DuckDuckGo HTML results and extracts verified links and snippets.
   */
  private static async parseDuckDuckGoHtml(html: string, limit: number): Promise<SearchResult[]> {
    const results: SearchResult[] = [];

    // DuckDuckGo HTML structure:
    // <h2 class="result__title">...<a class="result__a" href="//duckduckgo.com/l/?uddg=URL...">Title</a>...</h2>
    // <a class="result__snippet" ...>Snippet text...</a>
    const resultBlockRegex = /<div\b[^>]*class=["'][^"']*result\b[^"']*["'][^>]*>([\s\S]*?)<\/div\s*>/gi;
    let blockMatch: RegExpExecArray | null;

    while ((blockMatch = resultBlockRegex.exec(html)) !== null && results.length < limit) {
      const block = blockMatch[1];

      // Extract title and URL
      const linkMatch = block.match(/<a\b[^>]*class=["'][^"']*result__a\b[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
      if (!linkMatch) continue;

      const rawHref = linkMatch[1];
      const rawTitle = linkMatch[2];

      const resolvedUrl = WebSearchEngine.unwrapDuckDuckGoUrl(rawHref);
      if (!resolvedUrl) continue;

      // Verify destination URL against SSRF rules
      const ssrfCheck = await isSsrfSafeUrl(resolvedUrl);
      if (!ssrfCheck.safe) {
        continue;
      }

      const title = ContentExtractor.decodeEntities(rawTitle.replace(/<[^>]+>/g, "").trim());

      // Extract snippet
      const snippetMatch = block.match(/<a\b[^>]*class=["'][^"']*result__snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/i);
      const snippet = snippetMatch
        ? ContentExtractor.decodeEntities(snippetMatch[1].replace(/<[^>]+>/g, "").trim())
        : "";

      if (title && resolvedUrl) {
        results.push({
          title,
          url: resolvedUrl,
          snippet,
          publishedDate: "unknown/unverified", // Never fabricated
          source: "DuckDuckGo",
        });
      }
    }

    // Fallback parser if standard block regex yielded no results
    if (results.length === 0) {
      const linkRegex = /<a\b[^>]*class=["'][^"']*result__url\b[^"']*["'][^>]*href=["']([^"']+)["']/gi;
      let match: RegExpExecArray | null;
      while ((match = linkRegex.exec(html)) !== null && results.length < limit) {
        const unwrapped = WebSearchEngine.unwrapDuckDuckGoUrl(match[1]);
        if (unwrapped) {
          const ssrfCheck = await isSsrfSafeUrl(unwrapped);
          if (ssrfCheck.safe) {
            results.push({
              title: unwrapped,
              url: unwrapped,
              snippet: "",
              publishedDate: "unknown/unverified",
              source: "DuckDuckGo",
            });
          }
        }
      }
    }

    return results;
  }

  /**
   * Unwraps the real target URL from DuckDuckGo redirect link.
   * Format: //duckduckgo.com/l/?uddg=https%3A%2F%2Freact.dev%2Fblog...
   */
  static unwrapDuckDuckGoUrl(rawHref: string): string | null {
    try {
      let href = rawHref;
      if (href.startsWith("//")) {
        href = "https:" + href;
      }

      if (href.includes("uddg=")) {
        const u = new URL(href);
        const uddg = u.searchParams.get("uddg");
        if (uddg) {
          return decodeURIComponent(uddg);
        }
      }

      if (href.startsWith("http://") || href.startsWith("https://")) {
        return href;
      }
      return null;
    } catch {
      return null;
    }
  }
}
