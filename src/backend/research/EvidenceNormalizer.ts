/**
 * MYRAA — Step 8: Advanced Browser Research Agent
 * EvidenceNormalizer
 *
 * Normalizes evidence text before claim extraction:
 *   - Collapses excessive whitespace
 *   - Removes non-printable characters
 *   - Strips HTML remnants that survived basic stripping
 *   - Normalizes Unicode (smart quotes, dashes, etc.)
 *   - Trims to reasonable length
 *
 * This runs AFTER security sanitization, not instead of it.
 */

export class EvidenceNormalizer {
  /**
   * Normalize raw evidence text for consistent claim extraction.
   */
  public normalize(raw: string): string {
    if (!raw || typeof raw !== "string") return "";

    return raw
      // Remove HTML entities that survived stripping
      .replace(/&[a-z]{2,6};/gi, " ")
      .replace(/&#\d+;/g, " ")
      // Remove zero-width and non-printable characters
      .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF]/g, "")
      // Normalize smart quotes
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      // Normalize dashes
      .replace(/[\u2013\u2014\u2015]/g, "-")
      // Collapse whitespace
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  /**
   * Extract only the most relevant portion of a long evidence text
   * given a search topic.
   */
  public extractRelevantPortion(text: string, topic: string, maxLength = 3000): string {
    const normalized = this.normalize(text);
    if (normalized.length <= maxLength) return normalized;

    const topicWords = topic.toLowerCase().split(/\s+/).filter((w) => w.length > 3);

    // Find the position with the highest density of topic words
    const windowSize = maxLength;
    let bestStart = 0;
    let bestScore = 0;

    for (let i = 0; i < normalized.length - windowSize; i += 200) {
      const window = normalized.slice(i, i + windowSize).toLowerCase();
      const score = topicWords.reduce((acc, w) => acc + (window.split(w).length - 1), 0);
      if (score > bestScore) {
        bestScore = score;
        bestStart = i;
      }
    }

    return normalized.slice(bestStart, bestStart + maxLength) + "…";
  }
}

export const evidenceNormalizer = new EvidenceNormalizer();
