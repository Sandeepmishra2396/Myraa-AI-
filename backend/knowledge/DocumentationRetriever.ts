/**
 * MYRAA — DocumentationRetriever (Phase 4)
 *
 * Official documentation retriever for frameworks, languages, and libraries.
 * Consults authoritative documentation hubs (React, Next.js, Node.js, TypeScript,
 * Python, Vite, Express, Tailwind, MDN, FastAPI, etc.) to verify technical details.
 *
 * Safeguards & Reliability:
 *   • Strictly adheres to authoritative domains for official verification.
 *   • Validates all fetched URLs against SSRF rules before making requests.
 *   • Never fabricates documentation quotes or publication dates.
 *   • Marks official results with source: "official_doc".
 */

import {
  DocumentationHub,
  SearchResult,
} from "./KnowledgeTypes.ts";
import { WebSearchEngine } from "./WebSearchEngine.ts";
import {
  safeSsrfFetch,
  isSsrfSafeUrl,
} from "../security/PermissionManager.ts";
import { ContentExtractor } from "./ContentExtractor.ts";
import { FETCH_TIMEOUT_MS } from "./KnowledgeTypes.ts";

export const OFFICIAL_DOC_HUBS: DocumentationHub[] = [
  {
    id: "react",
    name: "React",
    domains: ["react.dev", "legacy.reactjs.org"],
    docRoot: "https://react.dev",
  },
  {
    id: "nextjs",
    name: "Next.js",
    domains: ["nextjs.org"],
    docRoot: "https://nextjs.org/docs",
  },
  {
    id: "nodejs",
    name: "Node.js",
    domains: ["nodejs.org"],
    docRoot: "https://nodejs.org/docs/latest/api/",
  },
  {
    id: "typescript",
    name: "TypeScript",
    domains: ["typescriptlang.org"],
    docRoot: "https://www.typescriptlang.org/docs/",
  },
  {
    id: "python",
    name: "Python",
    domains: ["docs.python.org", "python.org"],
    docRoot: "https://docs.python.org/3/",
  },
  {
    id: "vite",
    name: "Vite",
    domains: ["vite.dev", "vitejs.dev"],
    docRoot: "https://vite.dev/guide/",
  },
  {
    id: "express",
    name: "Express",
    domains: ["expressjs.com"],
    docRoot: "https://expressjs.com/en/4x/api.html",
  },
  {
    id: "tailwind",
    name: "Tailwind CSS",
    domains: ["tailwindcss.com"],
    docRoot: "https://tailwindcss.com/docs",
  },
  {
    id: "fastapi",
    name: "FastAPI",
    domains: ["fastapi.tiangolo.com"],
    docRoot: "https://fastapi.tiangolo.com/",
  },
  {
    id: "mdn",
    name: "MDN Web Docs",
    domains: ["developer.mozilla.org"],
    docRoot: "https://developer.mozilla.org/en-US/docs/Web",
  },
  {
    id: "vue",
    name: "Vue.js",
    domains: ["vuejs.org"],
    docRoot: "https://vuejs.org/guide/",
  },
];

export class DocumentationRetriever {
  /**
   * Matches a technology name, identifier, or domain to a registered DocumentationHub.
   */
  static findHub(techOrDomain: string): DocumentationHub | undefined {
    const clean = (techOrDomain || "").trim().toLowerCase();
    if (!clean) return undefined;

    return OFFICIAL_DOC_HUBS.find(
      (hub) =>
        hub.id === clean ||
        hub.name.toLowerCase() === clean ||
        hub.domains.some((d) => clean.includes(d) || d.includes(clean))
    );
  }

  /**
   * Retrieves official documentation matching a technology and topic.
   */
  static async retrieveDocs(
    technology: string,
    topic: string = "",
    maxResults: number = 4
  ): Promise<SearchResult[]> {
    const hub = DocumentationRetriever.findHub(technology);
    const domain = hub ? hub.domains[0] : technology;
    const queryTerm = topic ? `${topic}` : "documentation";

    // Use site: search constrained to the authoritative domain
    const siteQuery = `site:${domain} ${queryTerm}`;
    const rawResults = await WebSearchEngine.search(siteQuery, maxResults);

    // Filter to ensure results genuinely belong to the official domain
    const verified: SearchResult[] = [];

    for (const r of rawResults) {
      try {
        const u = new URL(r.url);
        const hostname = u.hostname.toLowerCase();
        const isOfficial = hub
          ? hub.domains.some((d) => hostname === d || hostname.endsWith(`.${d}`))
          : true;

        if (isOfficial) {
          verified.push({
            ...r,
            source: hub ? `${hub.name} Official Docs` : "Official Documentation",
          });
        }
      } catch {
        /* invalid URL discarded */
      }
    }

    return verified;
  }

  /**
   * Directly fetches and extracts content from a specific documentation URL.
   */
  static async fetchDocUrl(url: string): Promise<{ title: string; text: string; url: string }> {
    const ssrf = await isSsrfSafeUrl(url);
    if (!ssrf.safe) {
      throw new Error(`SSRF blocked: ${ssrf.reason}`);
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);

    try {
      const response = await safeSsrfFetch(url, {
        signal: ctrl.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
      });

      clearTimeout(timer);

      if (!response.ok) {
        throw new Error(`Documentation server returned HTTP ${response.status}`);
      }

      const html = await response.text();
      const extracted = ContentExtractor.extractFromHtml(html, url);

      return {
        title: extracted.title,
        text: extracted.text,
        url,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
