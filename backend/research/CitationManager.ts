/**
 * MYRAA — Step 8: Advanced Browser Research Agent
 * CitationManager
 *
 * Maintains the authoritative citation registry for a research session.
 * Every important claim in the final answer MUST have a citation entry.
 *
 * Invariant: No uncited fact is presented as established truth.
 * If a claim has no citation → it is labeled [UNCITED — requires verification].
 */

import crypto from "crypto";
import type {
  ResearchClaim,
  CitationEntry,
} from "./AdvancedResearchTypes.ts";

export class CitationManager {
  private _citations: Map<string, CitationEntry> = new Map();

  /**
   * Register a claim and create its citation entry.
   */
  public register(claim: ResearchClaim): CitationEntry {
    const existing = this._findByClaim(claim.id);
    if (existing) return existing;

    const entry: CitationEntry = {
      citationId: crypto.randomUUID(),
      claimId: claim.id,
      claim: claim.claim,
      evidence: claim.evidence,
      sourceUrl: claim.sourceUrl,
      sourceTitle: claim.sourceTitle,
      sourceType: claim.sourceType,
      relevantSection: this._extractSection(claim.evidence),
      publishedAt: claim.publishedAt,
      reliability: claim.reliability.composite,
    };

    this._citations.set(entry.citationId, entry);
    return entry;
  }

  /**
   * Register multiple claims at once and return all citation entries.
   */
  public registerAll(claims: ResearchClaim[]): CitationEntry[] {
    return claims.map((c) => this.register(c));
  }

  /**
   * Get a citation entry by its ID.
   */
  public get(citationId: string): CitationEntry | undefined {
    return this._citations.get(citationId);
  }

  /**
   * Get all registered citations, sorted by reliability (descending).
   */
  public getAll(): CitationEntry[] {
    return [...this._citations.values()].sort((a, b) => b.reliability - a.reliability);
  }

  /**
   * Format a citation for display in the final research report.
   */
  public format(entry: CitationEntry): string {
    const lines: string[] = [];
    lines.push(`**Citation [${entry.citationId.slice(0, 8)}]**`);
    lines.push(`Finding: ${entry.claim}`);
    lines.push(`Source: ${entry.sourceTitle} (${entry.sourceType})`);
    lines.push(`URL: ${entry.sourceUrl}`);
    if (entry.relevantSection) {
      lines.push(`Section: ${entry.relevantSection}`);
    }
    if (entry.publishedAt) {
      lines.push(`Published: ${entry.publishedAt}`);
    }
    lines.push(`Reliability: ${(entry.reliability * 100).toFixed(0)}%`);
    return lines.join("\n");
  }

  /**
   * Format the entire citation list as a bibliography section.
   */
  public formatBibliography(): string {
    const citations = this.getAll();
    if (citations.length === 0) {
      return "No citations registered.";
    }
    return citations.map((c, i) => `[${i + 1}] ${c.sourceTitle}\n    URL: ${c.sourceUrl}\n    Type: ${c.sourceType}`).join("\n\n");
  }

  /**
   * Clear all citations (for new session).
   */
  public reset(): void {
    this._citations.clear();
  }

  /**
   * Returns total citation count.
   */
  public get size(): number {
    return this._citations.size;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _findByClaim(claimId: string): CitationEntry | undefined {
    for (const entry of this._citations.values()) {
      if (entry.claimId === claimId) return entry;
    }
    return undefined;
  }

  private _extractSection(evidence: string): string | undefined {
    // Try to find a heading/section-like prefix
    const match = evidence.match(/^([A-Z][^.!?]{10,80}[.:])/);
    return match ? match[1] : undefined;
  }
}

export const citationManager = new CitationManager();
