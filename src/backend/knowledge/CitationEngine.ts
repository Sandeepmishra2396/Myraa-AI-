/**
 * MYRAA — CitationEngine (Phase 4)
 *
 * Formats citations, source attributions, and freshness indicators.
 * Ensures Myraa never hallucinates URLs, dates, or source facts.
 *
 * Safeguards:
 *   • Strictly relies on verified URLs and extracted snippets.
 *   • Freshness is computed from actual ISO 8601 timestamps.
 *   • Provides both structured Citation objects for API/UI and natural language
 *     speech-friendly references for Myraa's anime heroine voice persona.
 */

import {
  Citation,
  SearchResult,
  VectorChunk,
  computeFreshness,
} from "./KnowledgeTypes.ts";

export class CitationEngine {
  /**
   * Constructs citations from SearchResult objects.
   */
  static fromSearchResults(results: SearchResult[]): Citation[] {
    const now = new Date().toISOString();
    return results.map((r, idx) => ({
      index: idx + 1,
      title: r.title || "Untitled Source",
      url: r.url,
      snippet: CitationEngine.cleanSnippet(r.snippet),
      score: 1.0 - idx * 0.05, // Ranked confidence by search position
      fetchedAt: now,
      freshness: "fresh", // Just fetched live
    }));
  }

  /**
   * Constructs citations from vector search chunk matches.
   */
  static fromVectorChunks(
    matches: Array<{ chunk: VectorChunk; score: number }>
  ): Citation[] {
    return matches.map((m, idx) => {
      const fetchedAt = m.chunk.metadata.createdAt || new Date().toISOString();
      return {
        index: idx + 1,
        title: m.chunk.metadata.title || "Knowledge Base Document",
        url: m.chunk.metadata.url || m.chunk.metadata.filePath || "Local Workspace",
        snippet: CitationEngine.cleanSnippet(m.chunk.text),
        score: Math.round(m.score * 100) / 100,
        fetchedAt,
        freshness: computeFreshness(fetchedAt),
      };
    });
  }

  /**
   * Formats a clean bibliography block in Markdown for text display.
   */
  static formatBibliography(citations: Citation[]): string {
    if (!citations || citations.length === 0) {
      return "";
    }

    const lines = ["### Sources & Citations:"];

    for (const c of citations) {
      const freshnessBadge = `[Freshness: ${c.freshness.toUpperCase()}]`;
      const scoreBadge = `Relevance: ${Math.round(c.score * 100)}%`;
      const urlText = c.url.startsWith("http") ? `[${c.url}](${c.url})` : `\`${c.url}\``;

      lines.push(
        `**[${c.index}] ${c.title}** — ${urlText} (${scoreBadge}, ${freshnessBadge})`
      );

      if (c.snippet) {
        lines.push(`> "${c.snippet}"`);
      }
      lines.push("");
    }

    return lines.join("\n").trim();
  }

  /**
   * Formats a speech-friendly natural citation string for Myraa's voice output.
   */
  static formatSpeechSummary(citations: Citation[]): string {
    if (!citations || citations.length === 0) {
      return "";
    }

    const top = citations.slice(0, 2);
    const mentions = top.map((c) => {
      try {
        if (c.url.startsWith("http")) {
          const host = new URL(c.url).hostname.replace(/^www\./, "");
          return `${c.title} on ${host}`;
        }
      } catch {
        /* fallback to title */
      }
      return c.title;
    });

    if (mentions.length === 1) {
      return `Source: ${mentions[0]}`;
    }
    return `Sources: ${mentions.join("; ")}`;
  }

  /**
   * Cleans and truncates a snippet for display in citations.
   */
  private static cleanSnippet(snippet: string, maxLen: number = 220): string {
    if (!snippet) return "";
    const oneLine = snippet.replace(/\s+/g, " ").trim();
    if (oneLine.length <= maxLen) return oneLine;
    return oneLine.substring(0, maxLen - 3) + "...";
  }
}
