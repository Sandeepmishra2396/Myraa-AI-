/**
 * MYRAA — Step 8: Advanced Browser Research Agent
 * ResearchClaimExtractor
 *
 * Extracts structured ResearchClaims from sanitized source content.
 * Each claim is:
 *   - A single verifiable statement
 *   - Linked to its source (id, url, type)
 *   - Scored with confidence based on source reliability
 *   - Security-validated before storage
 *
 * INVARIANT: No raw webpage text is stored — only structured claims.
 */

import crypto from "crypto";
import type {
  ResearchClaim,
  ResearchSource,
} from "./AdvancedResearchTypes.ts";
import { researchSecurityGate } from "./ResearchSecurityGate.ts";

// Sentence splitter with basic NLP heuristics
function splitIntoSentences(text: string): string[] {
  return text
    .replace(/([.!?])\s+(?=[A-Z])/g, "$1\n")
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 20 && s.length < 1500); // Reasonable claim length
}

// Patterns that indicate a claim is actionable/verifiable
const CLAIM_SIGNAL_PATTERNS: RegExp[] = [
  /\brecommend(s|ed)?\b/i,
  /\bshould\b/i,
  /\bmust\b/i,
  /\brequire(s|d)?\b/i,
  /\bsupport(s|ed)?\b/i,
  /\bnot\s+support(ed)?\b/i,
  /\bonly\s+(works?|available)\b/i,
  /\bdeprecated?\b/i,
  /\bbreaking\s+change\b/i,
  /\bnew\s+in\s+version\b/i,
  /\bimplementation\b/i,
  /\bexample\b/i,
  /\busage\b/i,
  /\bapi\s+(returns?|takes?|accepts?|expects?)\b/i,
];

// Version extraction pattern
const VERSION_PATTERN = /(?:v|version\s*)(\d+\.\d+(?:\.\d+)?)/i;

export class ResearchClaimExtractor {
  /**
   * Extract structured claims from a sanitized research source.
   * Returns an array of ResearchClaims — empty if source is too short or invalid.
   */
  public extract(source: ResearchSource, topic: string): ResearchClaim[] {
    const claims: ResearchClaim[] = [];
    const content = source.sanitizedContent;

    if (!content || content.length < 100) return claims;

    // Split into candidate sentences
    const sentences = splitIntoSentences(content);

    for (const sentence of sentences) {
      // Only extract sentences with clear claim signals
      const isSignificant = CLAIM_SIGNAL_PATTERNS.some((p) => p.test(sentence));
      if (!isSignificant) continue;

      // Security validate the claim text
      const { valid, sanitizedClaim } = researchSecurityGate.validateClaim(sentence);
      if (!valid) continue;

      // Extract version mention
      const versionMatch = sentence.match(VERSION_PATTERN);
      const version = versionMatch ? versionMatch[1] : undefined;

      // Confidence is based on source reliability + specificity
      const confidence = Math.min(
        1.0,
        source.reliability.composite * 0.7 + source.reliability.specificity * 0.3
      );

      const claim: ResearchClaim = {
        id: crypto.randomUUID(),
        claim: sanitizedClaim,
        evidence: sanitizedClaim, // Evidence is the claim itself from a trusted source
        sourceId: source.id,
        sourceUrl: source.url,
        sourceTitle: source.title,
        sourceType: source.type,
        reliability: source.reliability,
        confidence,
        version,
        publishedAt: undefined, // Could be enhanced with DOM date extraction
        extractedAt: Date.now(),
        supports: [],
        contradicts: [],
      };

      claims.push(claim);

      // Cap at 20 claims per source to prevent flooding
      if (claims.length >= 20) break;
    }

    return claims;
  }

  /**
   * Filter claims to those most relevant to the research topic.
   */
  public filterByRelevance(claims: ResearchClaim[], topic: string): ResearchClaim[] {
    const topicWords = topic
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3);

    return claims
      .map((c) => {
        const claimLower = c.claim.toLowerCase();
        const matchCount = topicWords.filter((w) => claimLower.includes(w)).length;
        return { claim: c, score: matchCount / Math.max(1, topicWords.length) };
      })
      .filter(({ score }) => score > 0.1)
      .sort((a, b) => b.score - a.score)
      .map(({ claim }) => claim);
  }
}

export const researchClaimExtractor = new ResearchClaimExtractor();
