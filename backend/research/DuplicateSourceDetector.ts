/**
 * MYRAA — Advanced Browser Intelligence & Adaptive Knowledge System
 * DuplicateSourceDetector.ts
 *
 * Detects duplicate, syndicated, and mirrored sources to prevent artificial consensus.
 *
 * Key Invariant:
 *   If 5 syndicated websites or blog aggregators copy-paste the exact same
 *   article, they represent ONE single source of evidence, NOT 5 corroborations.
 *   Syndicated copies must not artificially inflate consensus or allow a claim
 *   to be elevated to VERIFIED_CONCLUSION.
 */

import type {
  ResearchSource,
  DuplicateCluster,
  DuplicateDetectionReport,
} from "./AdvancedResearchTypes.ts";

/** Helper to extract domain from a URL */
export function extractDomain(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return url.toLowerCase();
  }
}

/** Tokenizer with stop word filtering and normalization */
function tokenize(text: string): Set<string> {
  const stopWords = new Set([
    "the", "a", "an", "is", "are", "was", "were", "it", "in", "on", "at",
    "to", "of", "for", "and", "or", "but", "with", "from", "that", "this",
    "by", "as", "be", "have", "has", "had", "do", "does", "did", "can",
  ]);
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w));
  return new Set(tokens);
}

/** Calculate Jaccard similarity between two token sets */
function jaccardSimilarity(setA: Set<string>, setB: Set<string>): number {
  if (setA.size === 0 && setB.size === 0) return 1.0;
  if (setA.size === 0 || setB.size === 0) return 0.0;
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// Generic web titles that must not be used alone to declare duplicate sources
const GENERIC_TITLE_PATTERNS: RegExp[] = [
  /^(api\s+reference|documentation|docs|getting\s+started|overview|introduction|welcome|home|faq|frequently\s+asked\s+questions)$/i,
  /^(release\s+notes|changelog|privacy\s+policy|terms\s+of\s+service|table\s+of\s+contents|index)$/i,
];

function isGenericTitle(title?: string): boolean {
  if (!title) return true;
  const clean = title.trim().toLowerCase();
  return clean.length < 5 || GENERIC_TITLE_PATTERNS.some((p) => p.test(clean));
}

// Strip standard web boilerplate from content before shingle comparison
function stripWebBoilerplate(text: string): string {
  return text
    .replace(/\b(all\s+rights\s+reserved|cookie\s+policy|privacy\s+policy|terms\s+of\s+(?:use|service))\b/gi, " ")
    .replace(/\b(sign\s+in|sign\s+up|subscribe\s+to\s+newsletter|accept\s+all\s+cookies|reject\s+cookies)\b/gi, " ")
    .replace(/\b(navigation\s+menu|search\s+docs|quick\s+links|skip\s+to\s+content)\b/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** N-gram shingle similarity for fine-grained text overlap */
function shingleSimilarity(textA: string, textB: string, shingleSize = 3): number {
  const cleanA = stripWebBoilerplate(textA);
  const cleanB = stripWebBoilerplate(textB);

  const wordsA = cleanA.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2);
  const wordsB = cleanB.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2);

  // Require sufficient substantive content for shingle comparison
  if (wordsA.length < 15 || wordsB.length < 15) {
    return jaccardSimilarity(new Set(wordsA), new Set(wordsB));
  }

  const shinglesA = new Set<string>();
  for (let i = 0; i <= wordsA.length - shingleSize; i++) {
    shinglesA.add(wordsA.slice(i, i + shingleSize).join(" "));
  }

  const shinglesB = new Set<string>();
  for (let i = 0; i <= wordsB.length - shingleSize; i++) {
    shinglesB.add(wordsB.slice(i, i + shingleSize).join(" "));
  }

  return jaccardSimilarity(shinglesA, shinglesB);
}

export class DuplicateSourceDetector {
  /**
   * Check if two sources are duplicate, syndicated, or mirrored.
   */
  public isDuplicate(
    sourceA: { url: string; sanitizedContent?: string; content?: string; title: string; canonicalUrl?: string },
    sourceB: { url: string; sanitizedContent?: string; content?: string; title: string; canonicalUrl?: string }
  ): { isDuplicate: boolean; similarity: number; reason: string } {
    // 1. Direct canonical URL match (must be a valid full HTTP/HTTPS URL)
    const canonA = sourceA.canonicalUrl?.toLowerCase();
    const canonB = sourceB.canonicalUrl?.toLowerCase();
    if (canonA && canonB && canonA === canonB && canonA.startsWith("http")) {
      return { isDuplicate: true, similarity: 1.0, reason: "IDENTICAL_CANONICAL_URL" };
    }
    if (canonA && canonA.startsWith("http") && canonA === sourceB.url.toLowerCase()) {
      return { isDuplicate: true, similarity: 1.0, reason: "SOURCE_A_POINTS_TO_SOURCE_B_CANONICAL" };
    }
    if (canonB && canonB.startsWith("http") && canonB === sourceA.url.toLowerCase()) {
      return { isDuplicate: true, similarity: 1.0, reason: "SOURCE_B_POINTS_TO_SOURCE_A_CANONICAL" };
    }

    // 2. Exact or normalized URL match
    const normA = sourceA.url.toLowerCase().replace(/[#?].*$/, "").replace(/\/+$/, "");
    const normB = sourceB.url.toLowerCase().replace(/[#?].*$/, "").replace(/\/+$/, "");
    if (normA === normB) {
      return { isDuplicate: true, similarity: 1.0, reason: "SAME_NORMALIZED_URL" };
    }

    // 3. Title match (must not be a generic boilerplate title like "API Reference" or "Overview")
    const titleA = sourceA.title?.trim().toLowerCase();
    const titleB = sourceB.title?.trim().toLowerCase();
    const isSpecificTitle = !isGenericTitle(titleA) && !isGenericTitle(titleB);
    const titleMatch = Boolean(isSpecificTitle && titleA && titleB && titleA.length > 15 && titleA === titleB);

    // 4. Content overlap
    const contentA = sourceA.sanitizedContent || sourceA.content || "";
    const contentB = sourceB.sanitizedContent || sourceB.content || "";

    if (contentA.length > 100 && contentB.length > 100) {
      const shingleSim = shingleSimilarity(contentA, contentB, 3);

      if (shingleSim >= 0.70) {
        return {
          isDuplicate: true,
          similarity: shingleSim,
          reason: titleMatch ? "SYNDICATED_IDENTICAL_TITLE_AND_CONTENT" : "HIGH_CONTENT_OVERLAP",
        };
      }

      if (titleMatch && shingleSim >= 0.50) {
        return {
          isDuplicate: true,
          similarity: shingleSim,
          reason: "SYNDICATED_TITLE_AND_PARTIAL_CONTENT",
        };
      }
    } else if (titleMatch && extractDomain(sourceA.url) === extractDomain(sourceB.url)) {
      // Short text only matches on title if originating from the same domain
      return { isDuplicate: true, similarity: 0.90, reason: "SAME_DOMAIN_IDENTICAL_TITLE" };
    }

    return { isDuplicate: false, similarity: 0.0, reason: "INDEPENDENT_SOURCE" };
  }

  /**
   * Analyze an array of ResearchSources, identify duplicate/syndicated clusters,
   * annotate sources with independence and duplicate flags, and generate a report.
   */
  public detectDuplicates(sources: ResearchSource[]): DuplicateDetectionReport {
    const clusters: DuplicateCluster[] = [];
    const visited = new Set<string>();

    for (let i = 0; i < sources.length; i++) {
      const srcA = sources[i];
      if (visited.has(srcA.id)) continue;

      const clusterDuplicates: ResearchSource[] = [];
      let maxSim = 0;
      let clusterReason = "";

      for (let j = i + 1; j < sources.length; j++) {
        const srcB = sources[j];
        if (visited.has(srcB.id)) continue;

        const check = this.isDuplicate(
          {
            url: srcA.url,
            sanitizedContent: srcA.sanitizedContent,
            title: srcA.title,
            canonicalUrl: srcA.reliability.canonicalUrl,
          },
          {
            url: srcB.url,
            sanitizedContent: srcB.sanitizedContent,
            title: srcB.title,
            canonicalUrl: srcB.reliability.canonicalUrl,
          }
        );

        if (check.isDuplicate) {
          clusterDuplicates.push(srcB);
          visited.add(srcB.id);
          maxSim = Math.max(maxSim, check.similarity);
          clusterReason = check.reason;
        }
      }

      if (clusterDuplicates.length > 0) {
        visited.add(srcA.id);
        const allInCluster = [srcA, ...clusterDuplicates];

        // Pick primary canonical source:
        // Highest authority, then official source, then highest reliability
        allInCluster.sort((a, b) => {
          if (b.reliability.sourceAuthority !== a.reliability.sourceAuthority) {
            return b.reliability.sourceAuthority - a.reliability.sourceAuthority;
          }
          return b.reliability.composite - a.reliability.composite;
        });

        const canonical = allInCluster[0];
        const duplicates = allInCluster.slice(1);

        // Mark canonical
        canonical.reliability.independence = 1.0;
        canonical.reliability.isDuplicateOrSyndicated = false;

        // Mark duplicates as syndicated / non-independent
        for (const dup of duplicates) {
          dup.reliability.isDuplicateOrSyndicated = true;
          dup.reliability.independence = 0.20; // Drastically lowered independence
          dup.reliability.canonicalUrl = canonical.url;
        }

        clusters.push({
          canonicalUrl: canonical.url,
          duplicateUrls: duplicates.map((d) => d.url),
          similarityScore: maxSim,
          isSyndicated: true,
          reason: clusterReason,
        });
      } else {
        // Unique source
        srcA.reliability.independence = srcA.reliability.independence ?? 1.0;
        srcA.reliability.isDuplicateOrSyndicated = false;
      }
    }

    const duplicateCount = clusters.reduce((acc, c) => acc + c.duplicateUrls.length, 0);

    return {
      clusters,
      uniqueSourceCount: sources.length - duplicateCount,
      duplicateSourceCount: duplicateCount,
      totalEvaluated: sources.length,
    };
  }

  /**
   * Filter an array of sources to only include distinct independent sources.
   * Duplicate syndicated sources are pruned.
   */
  public filterIndependentSources(sources: ResearchSource[]): ResearchSource[] {
    this.detectDuplicates(sources);
    return sources.filter((s) => !s.reliability.isDuplicateOrSyndicated);
  }
}

export const duplicateSourceDetector = new DuplicateSourceDetector();
