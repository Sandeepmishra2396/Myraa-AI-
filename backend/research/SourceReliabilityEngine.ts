/**
 * MYRAA — Step 8: Advanced Browser Research Agent
 * SourceReliabilityEngine
 *
 * Scores a source across 6 dimensions:
 *   sourceAuthority, recency, specificity, directEvidence,
 *   corroboration, versionMatch
 *
 * Returns a SourceReliabilityScore with a composite 0.0–1.0 value.
 * Score determines how much weight each source's claims receive
 * during evidence synthesis and contradiction resolution.
 */

import type { SourceReliabilityScore, SourceType } from "./AdvancedResearchTypes.ts";

// Authority weights per source type (max 1.0)
const SOURCE_AUTHORITY_MAP: Record<SourceType, number> = {
  OFFICIAL_DOCUMENTATION: 0.95,
  OFFICIAL_API_REFERENCE: 0.92,
  OFFICIAL_GITHUB: 0.85,
  ACADEMIC: 0.80,
  TRUSTED_TECHNICAL_SOURCE: 0.65,
  COMMUNITY: 0.45,
  FORUM: 0.30,
  UNKNOWN: 0.20,
};

interface ScoringInput {
  url: string;
  sourceType: SourceType;
  contentLength: number;
  publishedAt?: string;
  projectVersion?: string;
  sourceVersion?: string;
  corroborationCount?: number;
  independence?: number;
  relevance?: number;
  isDuplicateOrSyndicated?: boolean;
  canonicalUrl?: string;
  queryKeywords?: string[];
  content?: string;
}

export class SourceReliabilityEngine {
  /**
   * Compute a full SourceReliabilityScore for a given source.
   */
  public score(input: ScoringInput): SourceReliabilityScore {
    const sourceAuthority = SOURCE_AUTHORITY_MAP[input.sourceType] ?? 0.20;

    const recency = this._scoreRecency(input.publishedAt);

    const specificity = this._scoreSpecificity(input.contentLength);

    const directEvidence = [
      "OFFICIAL_DOCUMENTATION",
      "OFFICIAL_API_REFERENCE",
      "OFFICIAL_GITHUB",
      "ACADEMIC",
    ].includes(input.sourceType);

    const corroboration = Math.min(1.0, (input.corroborationCount ?? 0) * 0.15);

    const versionMatch = this._checkVersionMatch(input.projectVersion, input.sourceVersion);

    // Independence: 1.0 for independent sources, 0.20 for syndicated/duplicates
    const isDuplicateOrSyndicated = Boolean(input.isDuplicateOrSyndicated);
    const independence = input.independence ?? (isDuplicateOrSyndicated ? 0.20 : 1.0);

    // Topical relevance
    const relevance = input.relevance ?? this._scoreRelevance(input.content || "", input.queryKeywords || []);

    // Composite: weighted average with independence factor
    let composite =
      sourceAuthority * 0.35 +
      recency * 0.20 +
      specificity * 0.15 +
      (directEvidence ? 0.15 : 0) +
      corroboration * 0.10 +
      (versionMatch ? 0.05 : 0);

    // Apply syndication / duplicate penalty if applicable
    if (isDuplicateOrSyndicated || independence < 0.6) {
      composite *= (0.5 + 0.5 * Math.max(0.1, independence));
    }

    return {
      sourceType: input.sourceType,
      sourceAuthority,
      recency,
      specificity,
      directEvidence,
      corroboration,
      versionMatch,
      composite: Math.min(1.0, composite),
      independence,
      relevance,
      isDuplicateOrSyndicated,
      canonicalUrl: input.canonicalUrl,
      publishedAt: input.publishedAt,
    };
  }

  /**
   * Update a source's corroboration count and recompute composite.
   */
  public updateCorroboration(
    existing: SourceReliabilityScore,
    corroborationCount: number
  ): SourceReliabilityScore {
    const corroboration = Math.min(1.0, corroborationCount * 0.15);
    let composite =
      existing.sourceAuthority * 0.35 +
      existing.recency * 0.20 +
      existing.specificity * 0.15 +
      (existing.directEvidence ? 0.15 : 0) +
      corroboration * 0.10 +
      (existing.versionMatch ? 0.05 : 0);

    const indep = existing.independence ?? 1.0;
    if (existing.isDuplicateOrSyndicated || indep < 0.6) {
      composite *= (0.5 + 0.5 * Math.max(0.1, indep));
    }

    return { ...existing, corroboration, composite: Math.min(1.0, composite) };
  }

  /**
   * Convenience getter for source authority by type.
   */
  public getAuthority(sourceType: SourceType): number {
    return SOURCE_AUTHORITY_MAP[sourceType] ?? 0.20;
  }

  /**
   * Convenience getter for freshness (recency) scoring.
   */
  public getFreshness(publishedAt?: string): number {
    return this._scoreRecency(publishedAt);
  }

  // ---------------------------------------------------------------------------
  // Private scoring helpers
  // ---------------------------------------------------------------------------

  private _scoreRecency(publishedAt?: string): number {
    if (!publishedAt) return 0.50; // Unknown recency → neutral

    try {
      const pubDate = new Date(publishedAt).getTime();
      if (isNaN(pubDate)) return 0.50;

      const ageMs = Date.now() - pubDate;
      const ageDays = ageMs / (1000 * 60 * 60 * 24);

      if (ageDays < 30) return 1.0;
      if (ageDays < 90) return 0.90;
      if (ageDays < 180) return 0.80;
      if (ageDays < 365) return 0.65;
      if (ageDays < 730) return 0.50;
      if (ageDays < 1460) return 0.35;
      return 0.20; // Older than 4 years
    } catch {
      return 0.50;
    }
  }

  private _scoreSpecificity(contentLength: number): number {
    // Very short content → likely summary/stub
    if (contentLength < 200) return 0.20;
    if (contentLength < 500) return 0.35;
    if (contentLength < 1500) return 0.55;
    if (contentLength < 5000) return 0.75;
    if (contentLength < 20000) return 0.90;
    return 1.0; // Comprehensive content
  }

  private _checkVersionMatch(projectVersion?: string, sourceVersion?: string): boolean {
    if (!projectVersion || !sourceVersion) return false;
    // Compare major.minor
    const pv = this._extractMajorMinor(projectVersion);
    const sv = this._extractMajorMinor(sourceVersion);
    return pv !== null && sv !== null && pv === sv;
  }

  private _extractMajorMinor(version: string): string | null {
    const match = version.match(/(\d+\.\d+)/);
    return match ? match[1] : null;
  }

  private _scoreRelevance(content: string, queryKeywords: string[]): number {
    if (!queryKeywords || queryKeywords.length === 0) return 0.85; // Default neutral-high
    if (!content) return 0.20;

    const lower = content.toLowerCase();
    const matchedCount = queryKeywords.filter((kw) => lower.includes(kw.toLowerCase())).length;
    const ratio = matchedCount / Math.max(1, queryKeywords.length);
    return Math.max(0.20, Math.min(1.0, 0.40 + ratio * 0.60));
  }
}

export const sourceReliabilityEngine = new SourceReliabilityEngine();
