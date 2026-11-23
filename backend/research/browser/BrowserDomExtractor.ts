/**
 * MYRAA — Advanced Browser Intelligence Subsystem
 * BrowserDomExtractor.ts
 *
 * Extracts structured DOM content, tables, headings, links, and accessibility tree summaries.
 * Sanitizes all extracted text to neutralize prompt injection and script payloads.
 *
 * Invariant: All output is UNTRUSTED_EXTERNAL_CONTENT.
 */

import { contentSanitizer } from "../../security/ContentSanitizer.ts";
import type {
  BrowserExtractedContent,
  ExtractedTableData,
  ExtractedLinkData,
} from "./BrowserIntelligenceTypes.ts";

export class BrowserDomExtractor {
  /**
   * Extract structured content from raw HTML or text.
   */
  public extract(
    rawHtmlOrText: string,
    url: string,
    titleHint = ""
  ): BrowserExtractedContent {
    const capturedAt = Date.now();
    const raw = rawHtmlOrText || "";

    // 1. Scan for prompt injection upfront
    const injectionScan = contentSanitizer.scanForPromptInjection(raw, {
      source: "browser_page",
      identifier: url,
    });

    const isHtml = /<[a-z][\s\S]*>/i.test(raw);

    if (!isHtml) {
      // Plain text extraction
      const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
      const title = titleHint || lines[0] || url;
      const headings = lines.slice(0, 5).filter((l) => l.length < 80);

      return {
        url,
        title,
        visibleText: injectionScan.sanitizedText.slice(0, 50_000),
        headings,
        tables: [],
        links: [],
        accessibilityTree: this._buildPlainTextA11y(lines),
        capturedAt,
        sanitized: true,
        injectionDetected: injectionScan.hasInjectionAttempt,
      };
    }

    // 2. HTML Structured Extraction
    const title = this._extractTitle(raw) || titleHint || url;
    const headings = this._extractHeadings(raw);
    const tables = this._extractTables(raw);
    const links = this._extractLinks(raw, url);
    const visibleText = this._extractVisibleText(raw);
    const accessibilityTree = this._buildHtmlA11y(raw);

    // Sanitize visible text and tables
    const sanitizedText = contentSanitizer.scanForPromptInjection(visibleText, {
      source: "browser_visible_text",
      identifier: url,
    }).sanitizedText.slice(0, 50_000);

    return {
      url,
      title: title.slice(0, 200),
      visibleText: sanitizedText,
      headings: headings.slice(0, 20),
      tables: tables.slice(0, 10),
      links: links.slice(0, 30),
      accessibilityTree: accessibilityTree.slice(0, 10_000),
      capturedAt,
      sanitized: true,
      injectionDetected: injectionScan.hasInjectionAttempt,
    };
  }

  private _extractTitle(html: string): string {
    const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return m ? this._stripTags(m[1]).trim() : "";
  }

  private _extractHeadings(html: string): string[] {
    const headings: string[] = [];
    const re = /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi;
    let match: RegExpExecArray | null;
    while ((match = re.exec(html)) !== null) {
      const text = this._stripTags(match[1]).trim();
      if (text && !headings.includes(text)) {
        headings.push(text);
      }
    }
    return headings;
  }

  private _extractTables(html: string): ExtractedTableData[] {
    const tables: ExtractedTableData[] = [];
    const tableRegex = /<table[^>]*>([\s\S]*?)<\/table>/gi;
    let tableMatch: RegExpExecArray | null;

    while ((tableMatch = tableRegex.exec(html)) !== null) {
      const tableHtml = tableMatch[1];
      const captionMatch = tableHtml.match(/<caption[^>]*>([\s\S]*?)<\/caption>/i);
      const caption = captionMatch ? this._stripTags(captionMatch[1]).trim() : undefined;

      const headers: string[] = [];
      const thRegex = /<th[^>]*>([\s\S]*?)<\/th>/gi;
      let thMatch: RegExpExecArray | null;
      while ((thMatch = thRegex.exec(tableHtml)) !== null) {
        headers.push(this._stripTags(thMatch[1]).trim());
      }

      const rows: string[][] = [];
      const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
      let trMatch: RegExpExecArray | null;

      while ((trMatch = trRegex.exec(tableHtml)) !== null) {
        const trHtml = trMatch[1];
        const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
        const row: string[] = [];
        let tdMatch: RegExpExecArray | null;
        while ((tdMatch = tdRegex.exec(trHtml)) !== null) {
          row.push(this._stripTags(tdMatch[1]).trim());
        }
        if (row.length > 0) {
          rows.push(row);
        }
      }

      if (headers.length > 0 || rows.length > 0) {
        tables.push({
          caption,
          headers,
          rows: rows.slice(0, 50),
        });
      }
    }

    return tables;
  }

  private _extractLinks(html: string, baseUrl: string): ExtractedLinkData[] {
    const links: ExtractedLinkData[] = [];
    const re = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match: RegExpExecArray | null;

    while ((match = re.exec(html)) !== null) {
      let href = match[1].trim();
      const text = this._stripTags(match[2]).trim();

      if (!href || href.startsWith("#") || href.startsWith("javascript:")) continue;

      try {
        const resolved = new URL(href, baseUrl).toString();
        if (!links.some((l) => l.url === resolved) && text) {
          links.push({ text, url: resolved });
        }
      } catch {
        // invalid link
      }
    }
    return links;
  }

  private _extractVisibleText(html: string): string {
    // Strip scripts, styles, svg, and metadata
    let clean = html
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ")
      .replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, " ")
      .replace(/<head\b[^<]*(?:(?!<\/head>)<[^<]*)*<\/head>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ");

    clean = this._stripTags(clean);
    return clean.replace(/\s+/g, " ").trim();
  }

  private _buildHtmlA11y(html: string): string {
    const interactive: string[] = [];
    // Interactive buttons, links, inputs
    const re = /<(button|input|select|textarea|a)\b([^>]*)>([\s\S]*?)<\/\1>|<(input)\b([^>]*)>/gi;
    let m: RegExpExecArray | null;
    let count = 0;

    while ((m = re.exec(html)) !== null && count < 25) {
      const tag = (m[1] || m[4] || "").toLowerCase();
      const attrs = m[2] || m[5] || "";
      const text = this._stripTags(m[3] || "").trim();

      const typeMatch = attrs.match(/type=["']([^"']+)["']/i);
      const nameMatch = attrs.match(/name=["']([^"']+)["']/i);
      const roleMatch = attrs.match(/role=["']([^"']+)["']/i);
      const ariaLabelMatch = attrs.match(/aria-label=["']([^"']+)["']/i);

      const label = ariaLabelMatch?.[1] || text || nameMatch?.[1] || "";
      const role = roleMatch?.[1] || (tag === "a" ? "link" : tag === "button" ? "button" : typeMatch?.[1] || "field");

      if (label) {
        interactive.push(`[${role.toUpperCase()}] "${label.slice(0, 50)}"`);
        count++;
      }
    }

    return interactive.join("\n");
  }

  private _buildPlainTextA11y(lines: string[]): string {
    return lines.slice(0, 10).map((l, i) => `[TEXT_NODE ${i + 1}] ${l.slice(0, 60)}`).join("\n");
  }

  private _stripTags(str: string): string {
    return str.replace(/<[^>]+>/g, " ");
  }
}

export const browserDomExtractor = new BrowserDomExtractor();
