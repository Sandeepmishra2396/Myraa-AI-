/**
 * MYRAA — Step 8: Advanced Browser Research Agent
 * SourceFetcher
 *
 * Fetches web pages safely via safeSsrfFetch (existing SSRF-guarded fetcher).
 * All fetched content passes through ResearchSecurityGate before storage.
 *
 * Security invariants:
 *   - Every URL is SSRF-validated before fetching.
 *   - All content is sandbox-wrapped as UNTRUSTED_WEB_DATA.
 *   - No content is executed, parsed as instructions, or relayed as code.
 *   - Timeout: 10 seconds hard limit per fetch.
 *   - Max response size: 500KB before truncation.
 */

import crypto from "crypto";
import { safeSsrfFetch } from "../security/PermissionManager.ts";
import { researchSecurityGate } from "./ResearchSecurityGate.ts";
import { sourceReliabilityEngine } from "./SourceReliabilityEngine.ts";
import type { ResearchSource, SourceType } from "./AdvancedResearchTypes.ts";

const FETCH_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 500_000; // 500 KB

export class SourceFetcher {
  /**
   * Validates, fetches, and sandboxes content from a URL.
   * Returns a fully sanitized ResearchSource or null on failure.
   */
  public async fetch(url: string, opts?: { signal?: AbortSignal }): Promise<ResearchSource | null> {
    // 0. Check cancellation upfront
    if (opts?.signal?.aborted) {
      return null;
    }

    // 1. Security gate — validate URL
    const urlCheck = await researchSecurityGate.validateUrl(url);
    if (!urlCheck.safe) {
      console.warn(`[SourceFetcher] Blocked URL: ${url} — ${urlCheck.reason}`);
      return null;
    }

    // 2. Fetch with SSRF-guarded fetcher + timeout
    let rawText = "";
    let title = url;
    try {
      const controller = new AbortController();
      if (opts?.signal) {
        opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
      }
      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      const response = await safeSsrfFetch(url, { signal: controller.signal } as RequestInit);
      clearTimeout(timeoutId);

      if (!response.ok) {
        console.warn(`[SourceFetcher] HTTP ${response.status} for ${url}`);
        return null;
      }

      const contentType = response.headers.get("content-type") || "";
      // Only process text-based responses
      if (!contentType.includes("text") && !contentType.includes("json")) {
        console.warn(`[SourceFetcher] Skipping non-text content-type: ${contentType}`);
        return null;
      }

      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > MAX_RESPONSE_BYTES) {
        rawText = new TextDecoder().decode(buffer.slice(0, MAX_RESPONSE_BYTES));
        rawText += "\n[FETCH_TRUNCATED_MAX_SIZE_REACHED]";
      } else {
        rawText = new TextDecoder().decode(buffer);
      }

      // Extract title from HTML
      const titleMatch = rawText.match(/<title[^>]*>([^<]{1,200})<\/title>/i);
      if (titleMatch) title = titleMatch[1].trim();

      // Extract publication timestamp from HTML metadata
      var publishedAt = this._extractPublishedDate(rawText);

      // Extract canonical URL if present
      var canonicalUrl = this._extractCanonicalUrl(rawText, url);
    } catch (err: any) {
      if (err?.name === "AbortError") {
        console.warn(`[SourceFetcher] Timeout fetching: ${url}`);
      } else {
        console.warn(`[SourceFetcher] Fetch error for ${url}: ${err?.message}`);
      }
      return null;
    }

    // 3. Strip HTML tags (basic text extraction)
    const plainText = this._stripHtml(rawText);

    // 4. Security gate — sanitize content
    const secCheck = researchSecurityGate.sanitizeWebContent(plainText, url);
    if (!secCheck.allowed || !secCheck.sanitizedContent) {
      return null;
    }

    // 5. Classify source type
    const sourceType = this._classifySource(url);

    // 6. Compute reliability
    const reliability = sourceReliabilityEngine.score({
      url,
      sourceType,
      contentLength: secCheck.sanitizedContent.length,
      publishedAt,
      canonicalUrl,
    });

    return {
      id: crypto.randomUUID(),
      url,
      title,
      type: sourceType,
      sanitizedContent: secCheck.sanitizedContent,
      fetchedAt: Date.now(),
      reliability,
      injectionDetected: secCheck.injectionDetected,
    };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private _extractPublishedDate(html: string): string | undefined {
    try {
      // 1. Meta tags for publication date
      const metaPatterns = [
        /<meta[^>]+property=["'](?:article:published_time|og:published_time)["'][^>]+content=["']([^"']+)["']/i,
        /<meta[^>]+content=["']([^"']+)["'][^>]+property=["'](?:article:published_time|og:published_time)["']/i,
        /<meta[^>]+name=["'](?:pubdate|publishdate|date|dc\.date|citation_publication_date)["'][^>]+content=["']([^"']+)["']/i,
        /<meta[^>]+content=["']([^"']+)["'][^>]+name=["'](?:pubdate|publishdate|date|dc\.date|citation_publication_date)["']/i,
      ];
      for (const pattern of metaPatterns) {
        const match = html.match(pattern);
        if (match && match[1]) {
          const parsed = new Date(match[1]);
          if (!isNaN(parsed.getTime())) {
            return parsed.toISOString();
          }
        }
      }

      // 2. <time datetime="..."> tag
      const timeMatch = html.match(/<time[^>]+datetime=["']([^"']+)["']/i);
      if (timeMatch && timeMatch[1]) {
        const parsed = new Date(timeMatch[1]);
        if (!isNaN(parsed.getTime())) {
          return parsed.toISOString();
        }
      }

      // 3. JSON-LD datePublished or dateModified
      const jsonLdMatch = html.match(/"datePublished"\s*:\s*["']([^"']+)["']/i) ||
                          html.match(/"dateModified"\s*:\s*["']([^"']+)["']/i);
      if (jsonLdMatch && jsonLdMatch[1]) {
        const parsed = new Date(jsonLdMatch[1]);
        if (!isNaN(parsed.getTime())) {
          return parsed.toISOString();
        }
      }
    } catch {
      // Ignore parse failure, return undefined
    }
    return undefined;
  }

  private _extractCanonicalUrl(html: string, originalUrl: string): string | undefined {
    try {
      const match = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i) ||
                    html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i);
      if (match && match[1]) {
        const href = match[1].trim();
        if (href.startsWith("http://") || href.startsWith("https://")) {
          return href;
        }
        // Relative canonical URL
        return new URL(href, originalUrl).toString();
      }
    } catch {
      // Ignore canonical URL resolution failure
    }
    return undefined;
  }

  private _stripHtml(html: string): string {
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]{1,500}>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  private _classifySource(url: string): SourceType {
    try {
      const { hostname } = new URL(url);
      const h = hostname.toLowerCase();

      if (
        h.includes("ai.google.dev") ||
        h.includes("developers.google.com") ||
        h.includes("cloud.google.com") ||
        h.includes("docs.python.org") ||
        h.includes("typescriptlang.org") ||
        h.includes("react.dev") ||
        h.includes("vitejs.dev") ||
        h.includes("expressjs.com") ||
        h.includes("developer.mozilla.org")
      ) {
        return "OFFICIAL_DOCUMENTATION";
      }

      if (
        h.includes("api.github.com") ||
        h.includes("raw.githubusercontent.com") ||
        h.includes("pkg.go.dev") ||
        h.includes("docs.rs")
      ) {
        return "OFFICIAL_API_REFERENCE";
      }

      if (h.includes("github.com")) {
        return "OFFICIAL_GITHUB";
      }

      if (
        h.includes("arxiv.org") ||
        h.includes("scholar.google") ||
        h.includes("dl.acm.org") ||
        h.includes("ieee.org")
      ) {
        return "ACADEMIC";
      }

      if (
        h.includes("medium.com") ||
        h.includes("dev.to") ||
        h.includes("css-tricks.com") ||
        h.includes("smashingmagazine.com") ||
        h.includes("kentcdodds.com")
      ) {
        return "TRUSTED_TECHNICAL_SOURCE";
      }

      if (h.includes("stackoverflow.com") || h.includes("reddit.com")) {
        return "COMMUNITY";
      }

      if (h.includes("forum") || h.includes("discuss")) {
        return "FORUM";
      }

      return "UNKNOWN";
    } catch {
      return "UNKNOWN";
    }
  }
}

export const sourceFetcher = new SourceFetcher();
