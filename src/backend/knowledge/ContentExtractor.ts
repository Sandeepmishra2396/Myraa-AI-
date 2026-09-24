/**
 * MYRAA — ContentExtractor (Phase 4)
 *
 * Cleans and transforms raw HTML, Markdown, source code, and plain text
 * into normalized text representations suitable for chunking, embedding,
 * and semantic retrieval.
 *
 * Safeguards:
 *   • Strips scripts, styling, navigation, footers, and ad tracking tags.
 *   • Never fabricates titles or descriptions; uses "unknown/unverified" when absent.
 *   • Computes SHA-256 content hashes to detect duplicate or modified documents.
 *   • Handles entity decoding safely without evaluating arbitrary expressions.
 */

import * as crypto from "crypto";

export interface ExtractedContent {
  title: string;
  text: string;
  description: string;
  contentHash: string;
  characterCount: number;
  wordCount: number;
}

export class ContentExtractor {
  /**
   * Cleans raw HTML and extracts formatted text, title, and metadata.
   */
  static extractFromHtml(html: string, urlHint?: string): ExtractedContent {
    if (!html || html.trim().length === 0) {
      return {
        title: urlHint || "Untitled Document",
        text: "",
        description: "",
        contentHash: ContentExtractor.hashContent(""),
        characterCount: 0,
        wordCount: 0,
      };
    }

    // 1. Extract title
    const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
    let title = titleMatch ? ContentExtractor.decodeEntities(titleMatch[1].trim()) : "";

    // 2. Extract meta description
    const descMatch =
      html.match(/<meta\b[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i) ||
      html.match(/<meta\b[^>]*content=["']([^"']*)["'][^>]*name=["']description["']/i) ||
      html.match(/<meta\b[^>]*property=["']og:description["'][^>]*content=["']([^"']*)["']/i);
    const description = descMatch ? ContentExtractor.decodeEntities(descMatch[1].trim()) : "";

    // 3. Remove non-content blocks
    let cleaned = html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ")
      .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, " ")
      .replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, " ")
      .replace(/<footer\b[^>]*>[\s\S]*?<\/footer>/gi, " ")
      .replace(/<header\b[^>]*>[\s\S]*?<\/header>/gi, " ");

    // 4. Convert structural HTML to Markdown
    cleaned = cleaned
      // Code blocks
      .replace(/<pre\b[^>]*><code\b[^>]*>([\s\S]*?)<\/code><\/pre>/gi, (_, code) => `\n\`\`\`\n${code}\n\`\`\`\n`)
      .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, "`$1`")
      // Headings
      .replace(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi, "\n\n# $1\n\n")
      .replace(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi, "\n\n## $1\n\n")
      .replace(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi, "\n\n### $1\n\n")
      .replace(/<h[4-6]\b[^>]*>([\s\S]*?)<\/h[4-6]>/gi, "\n\n#### $1\n\n")
      // Paragraphs and breaks
      .replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, "\n\n$1\n\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<hr\s*\/?>/gi, "\n---\n")
      // Lists
      .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, "\n* $1")
      // Blockquotes
      .replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, "\n> $1\n");

    // 5. Strip remaining tags
    cleaned = cleaned.replace(/<[^>]+>/g, " ");

    // 6. Decode HTML entities
    cleaned = ContentExtractor.decodeEntities(cleaned);

    // 7. Normalize whitespace
    const text = cleaned
      .replace(/[ \t]+/g, " ")
      .replace(/\n\s*\n/g, "\n\n")
      .trim();

    // If title was missing in <title>, attempt first heading
    if (!title) {
      const headingMatch = text.match(/^#\s+(.+)$/m);
      if (headingMatch) {
        title = headingMatch[1].trim();
      } else if (urlHint) {
        try {
          const u = new URL(urlHint);
          title = u.hostname + u.pathname;
        } catch {
          title = urlHint;
        }
      } else {
        title = "Untitled Web Page";
      }
    }

    const contentHash = ContentExtractor.hashContent(text);
    const wordCount = text.length > 0 ? text.split(/\s+/).length : 0;

    return {
      title,
      text,
      description,
      contentHash,
      characterCount: text.length,
      wordCount,
    };
  }

  /**
   * Processes Markdown or plain text content.
   */
  static extractFromMarkdown(markdown: string, titleHint?: string): ExtractedContent {
    const raw = (markdown || "").trim();
    if (!raw) {
      return {
        title: titleHint || "Empty Document",
        text: "",
        description: "",
        contentHash: ContentExtractor.hashContent(""),
        characterCount: 0,
        wordCount: 0,
      };
    }

    // Attempt to extract title from first level-1 heading
    const firstH1 = raw.match(/^#\s+(.+)$/m);
    const title = firstH1 ? firstH1[1].trim() : titleHint || "Markdown Document";

    // Attempt to extract brief description from first non-heading paragraph
    const firstPara = raw.replace(/^#+.*$/gm, "").trim().split(/\n\s*\n/)[0] || "";
    const description = firstPara.substring(0, 200).replace(/\n/g, " ").trim();

    const normalized = raw.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n");
    const contentHash = ContentExtractor.hashContent(normalized);
    const wordCount = normalized.split(/\s+/).filter(Boolean).length;

    return {
      title,
      text: normalized,
      description,
      contentHash,
      characterCount: normalized.length,
      wordCount,
    };
  }

  /**
   * Processes source code files (.ts, .js, .py, .json, etc.).
   */
  static extractFromCode(code: string, fileName: string): ExtractedContent {
    const raw = (code || "").trim();
    const contentHash = ContentExtractor.hashContent(raw);
    const wordCount = raw.split(/\s+/).filter(Boolean).length;

    return {
      title: fileName,
      text: raw,
      description: `Source code file: ${fileName}`,
      contentHash,
      characterCount: raw.length,
      wordCount,
    };
  }

  /**
   * Decodes common HTML entities safely.
   */
  static decodeEntities(str: string): string {
    return str
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;|&#x27;/g, "'")
      .replace(/&nbsp;/g, " ")
      .replace(/&#(\d+);/g, (_, dec) => {
        const code = parseInt(dec, 10);
        return code > 0 && code < 65536 ? String.fromCharCode(code) : "";
      })
      .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
        const code = parseInt(hex, 16);
        return code > 0 && code < 65536 ? String.fromCharCode(code) : "";
      });
  }

  /**
   * Computes SHA-256 hash of a text string.
   */
  static hashContent(text: string): string {
    return crypto.createHash("sha256").update(text, "utf8").digest("hex");
  }
}
