/**
 * MYRAA — Advanced Browser Intelligence Subsystem
 * DocumentExtractor.ts
 *
 * Extracts rich structured content from technical documentation pages, API references,
 * markdown specifications, and HTML guides.
 *
 * Features:
 *   - Hierarchical section outline extraction (h1..h3, markdown headers).
 *   - Code block discovery with language detection and enclosing section tracking.
 *   - Table extraction (HTML tables and Markdown tables).
 *   - Automatic version metadata detection (semver, url path, meta tags, headers).
 *   - Compatibility and deprecation notice extraction.
 *   - Prompt injection defense & content defanging (UNTRUSTED_EXTERNAL_CONTENT).
 *   - Safe size bounding and malformed content resilience.
 */

import crypto from "crypto";
import { contentSanitizer } from "../../security/ContentSanitizer.ts";
import type {
  StructuredDocument,
  DocumentSection,
  ExtractedCodeBlock,
  ExtractedTableData,
} from "./BrowserIntelligenceTypes.ts";

export const MAX_EXTRACT_BYTES = 25 * 1024 * 1024; // 25 MB max
export const MAX_TEXT_LENGTH = 100_000;            // 100k chars visible text cap
export const MAX_CODE_BLOCKS = 60;
export const MAX_TABLES = 25;
export const MAX_SECTIONS = 80;

export class DocumentExtractor {
  /**
   * Extract a StructuredDocument from raw HTML, Markdown, or plain text.
   */
  public extract(
    rawContent: string,
    url = "https://document.internal",
    titleHint = "",
    versionHint?: string
  ): StructuredDocument {
    const retrievedAt = Date.now();
    const id = `doc_${crypto.randomBytes(4).toString("hex")}`;

    if (!rawContent || typeof rawContent !== "string") {
      return {
        id,
        url,
        title: titleHint || url,
        sections: [],
        tables: [],
        codeBlocks: [],
        headings: [],
        visibleText: "",
        retrievedAt,
        sanitized: true,
        injectionDetected: false,
      };
    }

    // 1. Safe Size Bounds
    if (rawContent.length > MAX_EXTRACT_BYTES) {
      throw new Error(`FILE_TOO_LARGE: Document exceeds maximum allowable size of 25MB.`);
    }

    const boundedContent = rawContent.length > MAX_TEXT_LENGTH * 3
      ? rawContent.slice(0, MAX_TEXT_LENGTH * 3)
      : rawContent;

    // 2. Scan & Defang Prompt Injection
    const injectionScan = contentSanitizer.scanForPromptInjection(boundedContent, {
      source: "document_extractor",
      identifier: url,
    });
    const sanitizedRaw = injectionScan.sanitizedText;
    const injectionDetected = injectionScan.hasInjectionAttempt;

    // 3. Format Detection
    const hasMarkdownStructure = /^(?:---[\s\S]*?---\s*)?#{1,6}\s+|```|\|[-:]+\|/m.test(sanitizedRaw);
    const hasHtmlStructure = /<!doctype\s+html|<\/?(?:html|head|body|section|article|nav|main)\b/i.test(sanitizedRaw);

    const isHtml = hasHtmlStructure || (!hasMarkdownStructure && /<\/?(?:div|p|span|table|h[1-6]|ul|ol|li)\b[^>]*>/i.test(sanitizedRaw));
    const isMarkdown = !isHtml && hasMarkdownStructure;

    let title = titleHint;
    let sections: DocumentSection[] = [];
    let codeBlocks: ExtractedCodeBlock[] = [];
    let tables: ExtractedTableData[] = [];
    let headings: string[] = [];
    let visibleText = "";

    if (isHtml) {
      title = this._extractHtmlTitle(sanitizedRaw) || titleHint || url;
      codeBlocks = this._extractHtmlCodeBlocks(sanitizedRaw);
      tables = this._extractHtmlTables(sanitizedRaw);
      const sectionData = this._extractHtmlSections(sanitizedRaw, codeBlocks, tables);
      sections = sectionData.sections;
      headings = sectionData.headings;
      visibleText = this._extractHtmlVisibleText(sanitizedRaw);
    } else if (isMarkdown) {
      title = this._extractMarkdownTitle(sanitizedRaw) || titleHint || url;
      codeBlocks = this._extractMarkdownCodeBlocks(sanitizedRaw);
      tables = this._extractMarkdownTables(sanitizedRaw);
      const sectionData = this._extractMarkdownSections(sanitizedRaw, codeBlocks, tables);
      sections = sectionData.sections;
      headings = sectionData.headings;
      visibleText = this._extractMarkdownVisibleText(sanitizedRaw);
    } else {
      // Plain text
      title = titleHint || sanitizedRaw.split("\n")[0]?.slice(0, 80) || url;
      visibleText = sanitizedRaw.slice(0, MAX_TEXT_LENGTH);
      sections = [
        {
          id: "sec_overview",
          heading: "Overview",
          level: 1,
          content: visibleText,
          codeBlocks: [],
          tables: [],
        },
      ];
      headings = ["Overview"];
    }

    // 4. Version Detection (using extracted document title)
    const detectedVersion = versionHint || this._detectVersion(sanitizedRaw, url, title);

    // Attach metadata
    const metadata: Record<string, string> = {};
    if (detectedVersion) metadata.version = detectedVersion;
    if (url) metadata.sourceUrl = url;

    return {
      id,
      url,
      title: title.slice(0, 200).trim(),
      detectedVersion,
      sections: sections.slice(0, MAX_SECTIONS),
      tables: tables.slice(0, MAX_TABLES),
      codeBlocks: codeBlocks.slice(0, MAX_CODE_BLOCKS),
      headings: headings.slice(0, 40),
      visibleText: visibleText.slice(0, MAX_TEXT_LENGTH).trim(),
      retrievedAt,
      sanitized: true,
      injectionDetected,
      metadata,
    };
  }

  // ---------------------------------------------------------------------------
  // Version Detection
  // ---------------------------------------------------------------------------

  private _detectVersion(content: string, url: string, title: string): string | undefined {
    // 1. Check HTML meta tags (most explicit machine-readable version identifier)
    const metaMatch =
      content.match(/<meta[^>]+(?:name|property)=["'](?:doc:version|version|release)["'][^>]+content=["']([^"']+)["']/i) ||
      content.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["'](?:doc:version|version|release)["']/i);
    if (metaMatch && metaMatch[1]) {
      return metaMatch[1].trim();
    }

    // 2. Check title (e.g. "React v19.0 Documentation", "Framework API Reference v3.2.0")
    const titleVersionMatch = title.match(/(?:v|version|ver)[.:\s]*([0-9]+\.[0-9]+(?:\.[0-9]+)?)/i);
    if (titleVersionMatch && titleVersionMatch[1]) {
      return titleVersionMatch[1];
    }

    // 3. Check URL path (e.g. /v1/, /v2.0/, /v14.3.0/, /1.2/)
    const urlVersionMatch = url.match(/(?:\/v|\/)([0-9]+\.[0-9]+(?:\.[0-9]+)?(?:-[a-z0-9.]+)?)(?:\/|$|\?)/i);
    if (urlVersionMatch && urlVersionMatch[1]) {
      return urlVersionMatch[1];
    }

    // 4. Check front header snippet (top 1500 chars)
    const headerSnippet = content.slice(0, 1500);
    const headerVersionMatch = headerSnippet.match(/(?:version|release|current release|v)[.:\s]+([0-9]+\.[0-9]+(?:\.[0-9]+)?)/i);
    if (headerVersionMatch && headerVersionMatch[1]) {
      return headerVersionMatch[1].trim();
    }

    return undefined;
  }

  // ---------------------------------------------------------------------------
  // HTML Extraction Helpers
  // ---------------------------------------------------------------------------

  private _extractHtmlTitle(html: string): string {
    const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (m) return this._decodeHtmlEntities(this._stripTags(m[1])).trim();
    const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    if (h1) return this._decodeHtmlEntities(this._stripTags(h1[1])).trim();
    return "";
  }

  private _extractHtmlCodeBlocks(html: string): ExtractedCodeBlock[] {
    const blocks: ExtractedCodeBlock[] = [];
    const re = /<pre[^>]*><code(?:\s+class=["'](?:language-)?([a-zA-Z0-9_\-]+)["'])?[^>]*>([\s\S]*?)<\/code><\/pre>|<pre[^>]*>([\s\S]*?)<\/pre>/gi;
    let match: RegExpExecArray | null;

    while ((match = re.exec(html)) !== null && blocks.length < MAX_CODE_BLOCKS) {
      const language = match[1]?.toLowerCase() || undefined;
      const rawCode = match[2] !== undefined ? match[2] : match[3];
      const cleanCode = this._decodeHtmlEntities(this._stripTags(rawCode)).trim();

      if (cleanCode.length > 5) {
        const lineCount = cleanCode.split("\n").length;
        blocks.push({
          code: cleanCode.slice(0, 5000),
          language,
          lineCount,
        });
      }
    }

    return blocks;
  }

  private _extractHtmlTables(html: string): ExtractedTableData[] {
    const tables: ExtractedTableData[] = [];
    const tableRegex = /<table[^>]*>([\s\S]*?)<\/table>/gi;
    let match: RegExpExecArray | null;

    while ((match = tableRegex.exec(html)) !== null && tables.length < MAX_TABLES) {
      const tableHtml = match[1];
      const capMatch = tableHtml.match(/<caption[^>]*>([\s\S]*?)<\/caption>/i);
      const caption = capMatch ? this._decodeHtmlEntities(this._stripTags(capMatch[1])).trim() : undefined;

      const headers: string[] = [];
      const thRegex = /<th[^>]*>([\s\S]*?)<\/th>/gi;
      let thMatch: RegExpExecArray | null;
      while ((thMatch = thRegex.exec(tableHtml)) !== null) {
        headers.push(this._decodeHtmlEntities(this._stripTags(thMatch[1])).trim());
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
          row.push(this._decodeHtmlEntities(this._stripTags(tdMatch[1])).trim());
        }
        if (row.length > 0) rows.push(row);
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

  private _extractHtmlSections(
    html: string,
    allCodeBlocks: ExtractedCodeBlock[],
    allTables: ExtractedTableData[]
  ): { sections: DocumentSection[]; headings: string[] } {
    const sections: DocumentSection[] = [];
    const headings: string[] = [];

    // Find all h1, h2, h3 tags with positions
    const headingRe = /<(h[1-3])[^>]*>([\s\S]*?)<\/\1>/gi;
    const matches: Array<{ tag: string; text: string; index: number; length: number }> = [];
    let hMatch: RegExpExecArray | null;

    while ((hMatch = headingRe.exec(html)) !== null) {
      const text = this._decodeHtmlEntities(this._stripTags(hMatch[2])).trim();
      if (text) {
        matches.push({
          tag: hMatch[1].toLowerCase(),
          text,
          index: hMatch.index,
          length: hMatch[0].length,
        });
        if (!headings.includes(text)) headings.push(text);
      }
    }

    if (matches.length === 0) {
      // Single overall section
      const text = this._extractHtmlVisibleText(html);
      sections.push({
        id: "sec_root",
        heading: "Overview",
        level: 1,
        content: text,
        codeBlocks: allCodeBlocks,
        tables: allTables,
      });
      headings.push("Overview");
      return { sections, headings };
    }

    for (let i = 0; i < matches.length; i++) {
      const current = matches[i];
      const startIdx = current.index + current.length;
      const endIdx = i + 1 < matches.length ? matches[i + 1].index : html.length;
      const chunkHtml = html.slice(startIdx, endIdx);
      const chunkText = this._extractHtmlVisibleText(chunkHtml);

      // Associate code blocks inside this chunk
      const sectionCodes = allCodeBlocks.filter((c) => chunkHtml.includes(c.code.slice(0, 30)));
      // Associate tables inside this chunk
      const sectionTables = allTables.filter((t) => t.caption && chunkHtml.includes(t.caption));

      const level = parseInt(current.tag.replace("h", ""), 10) || 2;
      sections.push({
        id: `sec_${i + 1}_${current.text.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 24)}`,
        heading: current.text,
        level,
        content: chunkText,
        codeBlocks: sectionCodes,
        tables: sectionTables,
      });
    }

    return { sections, headings };
  }

  private _extractHtmlVisibleText(html: string): string {
    let clean = html
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ")
      .replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, " ")
      .replace(/<head\b[^<]*(?:(?!<\/head>)<[^<]*)*<\/head>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ");

    clean = this._stripTags(clean);
    return this._decodeHtmlEntities(clean).replace(/\s+/g, " ").trim();
  }

  // ---------------------------------------------------------------------------
  // Markdown Extraction Helpers
  // ---------------------------------------------------------------------------

  private _extractMarkdownTitle(md: string): string {
    const h1 = md.match(/^#\s+(.+)$/m);
    return h1 ? h1[1].trim() : "";
  }

  private _extractMarkdownCodeBlocks(md: string): ExtractedCodeBlock[] {
    const blocks: ExtractedCodeBlock[] = [];
    const re = /```([a-zA-Z0-9_\-]+)?\n([\s\S]*?)```/g;
    let match: RegExpExecArray | null;

    while ((match = re.exec(md)) !== null && blocks.length < MAX_CODE_BLOCKS) {
      const language = match[1]?.toLowerCase();
      const code = match[2]?.trim();
      if (code && code.length > 5) {
        blocks.push({
          code: code.slice(0, 5000),
          language,
          lineCount: code.split("\n").length,
        });
      }
    }

    return blocks;
  }

  private _extractMarkdownTables(md: string): ExtractedTableData[] {
    const tables: ExtractedTableData[] = [];
    const lines = md.split("\n");
    let inTable = false;
    let currentHeaders: string[] = [];
    let currentRows: string[][] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith("|") && line.endsWith("|")) {
        const cells = line
          .slice(1, -1)
          .split("|")
          .map((c) => c.trim());

        if (!inTable) {
          // Check if next line is separator
          if (i + 1 < lines.length && /^\|[-:\s|]+\|$/.test(lines[i + 1].trim())) {
            inTable = true;
            currentHeaders = cells;
            currentRows = [];
            i++; // skip separator line
            continue;
          }
        } else {
          currentRows.push(cells);
        }
      } else if (inTable) {
        if (currentHeaders.length > 0 || currentRows.length > 0) {
          tables.push({
            headers: currentHeaders,
            rows: currentRows.slice(0, 50),
          });
        }
        inTable = false;
        currentHeaders = [];
        currentRows = [];
      }
    }

    if (inTable && (currentHeaders.length > 0 || currentRows.length > 0)) {
      tables.push({
        headers: currentHeaders,
        rows: currentRows.slice(0, 50),
      });
    }

    return tables;
  }

  private _extractMarkdownSections(
    md: string,
    allCodeBlocks: ExtractedCodeBlock[],
    allTables: ExtractedTableData[]
  ): { sections: DocumentSection[]; headings: string[] } {
    const sections: DocumentSection[] = [];
    const headings: string[] = [];
    const lines = md.split("\n");

    interface MdHeading {
      level: number;
      text: string;
      lineIdx: number;
    }

    const headingList: MdHeading[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      const m = line.match(/^(#{1,4})\s+(.+)$/);
      if (m) {
        const level = m[1].length;
        const text = m[2].trim();
        headingList.push({ level, text, lineIdx: i });
        if (!headings.includes(text)) headings.push(text);
      }
    }

    if (headingList.length === 0) {
      sections.push({
        id: "sec_root",
        heading: "Overview",
        level: 1,
        content: this._extractMarkdownVisibleText(md),
        codeBlocks: allCodeBlocks,
        tables: allTables,
      });
      headings.push("Overview");
      return { sections, headings };
    }

    for (let i = 0; i < headingList.length; i++) {
      const curr = headingList[i];
      const startLine = curr.lineIdx + 1;
      const endLine = i + 1 < headingList.length ? headingList[i + 1].lineIdx : lines.length;
      const chunkMd = lines.slice(startLine, endLine).join("\n");
      const chunkText = this._extractMarkdownVisibleText(chunkMd);

      const sectionCodes = allCodeBlocks.filter((c) => chunkMd.includes(c.code.slice(0, 30)));

      sections.push({
        id: `sec_${i + 1}_${curr.text.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 24)}`,
        heading: curr.text,
        level: curr.level,
        content: chunkText,
        codeBlocks: sectionCodes,
        tables: [],
      });
    }

    return { sections, headings };
  }

  private _extractMarkdownVisibleText(md: string): string {
    // Strip code fences
    let clean = md.replace(/```[\s\S]*?```/g, " ");
    // Strip image / link syntax but keep label
    clean = clean.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
    clean = clean.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
    // Strip headers
    clean = clean.replace(/^#{1,6}\s+/gm, "");
    return clean.replace(/\s+/g, " ").trim();
  }

  // ---------------------------------------------------------------------------
  // Utility Sanitization
  // ---------------------------------------------------------------------------

  private _stripTags(str: string): string {
    return str.replace(/<[^>]+>/g, " ");
  }

  private _decodeHtmlEntities(str: string): string {
    return str
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, " ");
  }
}

export const documentExtractor = new DocumentExtractor();
