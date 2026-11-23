/**
 * MYRAA — Step 8: Advanced Browser Research Agent
 * ResearchSynthesisEngine
 *
 * Synthesizes all gathered evidence into a final, structured research result:
 *   1. Collects and ranks claims by confidence × reliability
 *   2. Groups claims into key findings
 *   3. Acknowledges contradictions honestly
 *   4. Registers all citations
 *   5. Builds the final answer with every important claim cited
 *
 * Invariant:
 *   - No uncited claim is presented as established truth
 *   - Contradictions are reported explicitly, not silently resolved
 *   - Low-confidence findings are labeled as such
 */

import type {
  ResearchClaim,
  ContradictionRecord,
  ResearchSource,
  SynthesizedResearchResult,
  CitationEntry,
  ProjectResearchContext,
} from "./AdvancedResearchTypes.ts";
import { citationManager } from "./CitationManager.ts";

export class ResearchSynthesisEngine {
  /**
   * Synthesize a final research result from all collected evidence.
   */
  public synthesize(opts: {
    sessionId: string;
    query: string;
    claims: ResearchClaim[];
    contradictions: ContradictionRecord[];
    sources: ResearchSource[];
    projectContext?: ProjectResearchContext;
    duplicateClusters?: import("./AdvancedResearchTypes.ts").DuplicateCluster[];
  }): SynthesizedResearchResult {
    const { sessionId, query, claims, contradictions, sources, projectContext, duplicateClusters } = opts;

    // 1. Filter and rank claims
    const rankedClaims = this._rankClaims(claims);

    // 2. Register citations for top claims (preserving provenance and timestamps)
    citationManager.reset();
    const topClaims = rankedClaims.slice(0, 15);
    const citations: CitationEntry[] = citationManager.registerAll(topClaims);

    // 3. Epistemic Categorization
    const verifiedConclusions = rankedClaims.filter(
      (c) => c.epistemicLabel === "VERIFIED_CONCLUSION" || c.verificationStatus === "VERIFIED_CONCLUSION"
    );
    const facts = rankedClaims.filter(
      (c) => c.epistemicLabel === "FACT" && c.verificationStatus !== "VERIFIED_CONCLUSION"
    );
    const inferences = rankedClaims.filter((c) => c.epistemicLabel === "INFERENCE");
    const hypotheses = rankedClaims.filter((c) => c.epistemicLabel === "HYPOTHESIS");

    // 4. Uncertainty and Evidence Gaps Analysis
    const uncertainties: import("./AdvancedResearchTypes.ts").EpistemicUncertaintyNote[] = [];
    const uncertaintyReport: string[] = [];

    for (const c of contradictions) {
      if (c.resolution === "UNRESOLVED") {
        const note = {
          topic: c.topic,
          reason: `Unresolved contradiction between ${c.claimA.sourceType} and ${c.claimB.sourceType}: ${c.resolutionExplanation}`,
          conflictingClaims: [c.claimA.id, c.claimB.id],
          severity: (c.severity === "CRITICAL" || c.severity === "HIGH" ? "HIGH" : "MEDIUM") as "HIGH" | "MEDIUM" | "LOW",
        };
        uncertainties.push(note);
        uncertaintyReport.push(`[${c.severity}] ${note.reason}`);
      }
    }

    const insufficientClaims = rankedClaims.filter((c) => c.verificationStatus === "INSUFFICIENT_EVIDENCE");
    for (const ic of insufficientClaims) {
      uncertainties.push({
        topic: ic.claim.slice(0, 50),
        reason: ic.verificationReason || "Insufficient evidence or low source reliability.",
        severity: "MEDIUM",
      });
      uncertaintyReport.push(`Insufficient Evidence for "${ic.claim.slice(0, 50)}": ${ic.verificationReason || "Low reliability"}`);
    }

    const hasUncertainty = uncertainties.length > 0;

    // 5. Group into key findings for backward compatibility
    const keyFindings = this._groupFindings(topClaims, citations);

    // 6. Compute overall confidence
    const avgConfidence =
      rankedClaims.length > 0
        ? rankedClaims.reduce((sum, c) => sum + c.confidence, 0) / rankedClaims.length
        : 0;

    const confidence: SynthesizedResearchResult["confidence"] =
      hasUncertainty ? "LOW" : avgConfidence >= 0.75 ? "HIGH" : avgConfidence >= 0.50 ? "MEDIUM" : "LOW";

    const epistemicSummary: import("./AdvancedResearchTypes.ts").EpistemicSummary = {
      verifiedConclusions,
      facts,
      inferences,
      hypotheses,
      uncertainties,
    };

    // 7. Build rich epistemic answer text
    const answer = this._buildEpistemicAnswer({
      query,
      verifiedConclusions,
      facts,
      inferences,
      hypotheses,
      uncertainties,
      contradictions,
      citations,
      avgConfidence,
      keyFindings,
    });

    // 8. Collect security flags
    const securityFlags: string[] = [];
    for (const src of sources) {
      if (src.injectionDetected) {
        securityFlags.push(`INJECTION_DETECTED_IN_SOURCE: ${src.url}`);
      }
    }

    return {
      sessionId,
      query,
      answer,
      confidence,
      confidenceScore: avgConfidence,
      keyFindings,
      contradictions,
      citations,
      generatedAt: Date.now(),
      securityFlags,
      epistemicSummary,
      hasUncertainty,
      uncertaintyReport,
      duplicateClusters,
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _rankClaims(claims: ResearchClaim[]): ResearchClaim[] {
    return [...claims]
      .sort((a, b) => {
        // Primary: confidence × reliability composite
        const scoreA = a.confidence * a.reliability.composite;
        const scoreB = b.confidence * b.reliability.composite;
        if (Math.abs(scoreA - scoreB) > 0.05) return scoreB - scoreA;
        // Secondary: source authority
        return b.reliability.sourceAuthority - a.reliability.sourceAuthority;
      })
      .filter((c) => c.confidence > 0.25); // Reject very low confidence claims
  }

  private _groupFindings(
    claims: ResearchClaim[],
    citations: CitationEntry[]
  ): SynthesizedResearchResult["keyFindings"] {
    // Simple grouping: group by source authority tier
    const high = claims.filter((c) => c.reliability.sourceAuthority >= 0.85);
    const medium = claims.filter(
      (c) => c.reliability.sourceAuthority >= 0.55 && c.reliability.sourceAuthority < 0.85
    );
    const community = claims.filter((c) => c.reliability.sourceAuthority < 0.55);

    const findings: SynthesizedResearchResult["keyFindings"] = [];

    if (high.length > 0) {
      const claimIds = high.map((c) => c.id);
      const citation = citations.find((ct) => claimIds.includes(ct.claimId));
      findings.push({
        finding: high[0].claim,
        supportingClaims: claimIds,
        citationSummary: citation
          ? `[${citation.sourceTitle}](${citation.sourceUrl}) — ${citation.sourceType}`
          : "Official documentation",
      });
    }

    if (medium.length > 0) {
      const claimIds = medium.map((c) => c.id);
      const citation = citations.find((ct) => claimIds.includes(ct.claimId));
      findings.push({
        finding: medium[0].claim,
        supportingClaims: claimIds,
        citationSummary: citation
          ? `[${citation.sourceTitle}](${citation.sourceUrl}) — ${citation.sourceType}`
          : "Technical source",
      });
    }

    if (community.length > 0 && community[0].confidence > 0.40) {
      const claimIds = community.map((c) => c.id);
      const citation = citations.find((ct) => claimIds.includes(ct.claimId));
      findings.push({
        finding: `Community insight (verify independently): ${community[0].claim}`,
        supportingClaims: claimIds,
        citationSummary: citation
          ? `[${citation.sourceTitle}](${citation.sourceUrl}) — ${citation.sourceType} ⚠️ Lower reliability`
          : "Community source — verify independently",
      });
    }

    return findings;
  }

  private _buildAnswer(
    query: string,
    keyFindings: SynthesizedResearchResult["keyFindings"],
    contradictions: ContradictionRecord[],
    citations: CitationEntry[],
    avgConfidence: number
  ): string {
    const lines: string[] = [];

    lines.push(`## Research Result: ${query}`);
    lines.push("");
    lines.push(
      `**Overall Confidence:** ${avgConfidence >= 0.75 ? "HIGH" : avgConfidence >= 0.50 ? "MEDIUM" : "LOW"} (${(avgConfidence * 100).toFixed(0)}%)`
    );
    lines.push("");

    if (keyFindings.length === 0) {
      lines.push("No sufficiently reliable findings could be extracted from the sources.");
    } else {
      lines.push("### Key Findings");
      lines.push("");
      for (let i = 0; i < keyFindings.length; i++) {
        const f = keyFindings[i];
        lines.push(`**${i + 1}. ${f.finding}**`);
        lines.push(`> *Source: ${f.citationSummary}*`);
        lines.push("");
      }
    }

    // Report contradictions
    if (contradictions.length > 0) {
      lines.push("### ⚔️ Contradictions Detected");
      lines.push("");
      for (const c of contradictions) {
        lines.push(`**Topic:** ${c.topic}`);
        lines.push(`- Source A: "${c.claimA.claim.slice(0, 200)}" *(${c.claimA.sourceType})*`);
        lines.push(`- Source B: "${c.claimB.claim.slice(0, 200)}" *(${c.claimB.sourceType})*`);
        lines.push(`- **Severity:** ${c.severity}`);
        lines.push(`- **Resolution:** ${c.resolution}`);
        lines.push(`- **Explanation:** ${c.resolutionExplanation}`);
        if (c.resolution === "UNRESOLVED") {
          lines.push(`> ⚠️ Confidence: LOW — Manual verification required. No guessing.`);
        }
        lines.push("");
      }
    }

    // Citations bibliography
    if (citations.length > 0) {
      lines.push("### Citations");
      lines.push("");
      lines.push(citationManager.formatBibliography());
    }

    return lines.join("\n");
  }

  private _buildEpistemicAnswer(opts: {
    query: string;
    verifiedConclusions: ResearchClaim[];
    facts: ResearchClaim[];
    inferences: ResearchClaim[];
    hypotheses: ResearchClaim[];
    uncertainties: import("./AdvancedResearchTypes.ts").EpistemicUncertaintyNote[];
    contradictions: ContradictionRecord[];
    citations: CitationEntry[];
    avgConfidence: number;
    keyFindings: SynthesizedResearchResult["keyFindings"];
  }): string {
    const {
      query,
      verifiedConclusions,
      facts,
      inferences,
      hypotheses,
      uncertainties,
      contradictions,
      citations,
      avgConfidence,
    } = opts;

    const lines: string[] = [];
    lines.push(`## Research Result: ${query}`);
    lines.push("");
    lines.push(
      `**Overall Confidence:** ${avgConfidence >= 0.75 && uncertainties.length === 0 ? "HIGH" : avgConfidence >= 0.50 ? "MEDIUM" : "LOW"} (${(avgConfidence * 100).toFixed(0)}%)`
    );
    lines.push("");

    // 1. Verified Conclusions
    if (verifiedConclusions.length > 0) {
      lines.push("### 🎯 Verified Conclusions");
      lines.push("");
      for (let i = 0; i < verifiedConclusions.length; i++) {
        const c = verifiedConclusions[i];
        const cit = citations.find((ct) => ct.claimId === c.id);
        lines.push(`**${i + 1}. ${c.claim}**`);
        if (c.verificationReason) {
          lines.push(`> *Verification:* ${c.verificationReason}`);
        }
        if (cit) {
          lines.push(`> *Source:* [${cit.sourceTitle}](${cit.sourceUrl}) (${cit.sourceType})`);
        }
        lines.push("");
      }
    }

    // 2. Observed Facts
    if (facts.length > 0) {
      lines.push("### 📌 Observed Facts");
      lines.push("");
      for (let i = 0; i < facts.length; i++) {
        const c = facts[i];
        const cit = citations.find((ct) => ct.claimId === c.id);
        lines.push(`- **${c.claim}**`);
        if (cit) {
          lines.push(`  *Source:* [${cit.sourceTitle}](${cit.sourceUrl})`);
        }
      }
      lines.push("");
    }

    // 3. Inferences
    if (inferences.length > 0) {
      lines.push("### 💡 Inferences & Logical Deductions");
      lines.push("");
      for (let i = 0; i < inferences.length; i++) {
        const c = inferences[i];
        lines.push(`- ${c.claim}`);
      }
      lines.push("");
    }

    // 4. Hypotheses
    if (hypotheses.length > 0) {
      lines.push("### 🔬 Hypotheses & Open Questions");
      lines.push("");
      for (let i = 0; i < hypotheses.length; i++) {
        const c = hypotheses[i];
        lines.push(`- ⚠️ *Hypothesis (Unconfirmed):* ${c.claim}`);
      }
      lines.push("");
    }

    // 5. Uncertainties and Evidence Gaps
    if (uncertainties.length > 0) {
      lines.push("### ⚠️ Uncertainty & Evidence Gaps");
      lines.push("");
      for (const u of uncertainties) {
        lines.push(`- **[${u.severity}] ${u.topic}**: ${u.reason}`);
      }
      lines.push("");
    }

    // 6. Contradictions
    if (contradictions.length > 0) {
      lines.push("### ⚔️ Contradictions Detected");
      lines.push("");
      for (const c of contradictions) {
        lines.push(`**Topic:** ${c.topic}`);
        lines.push(`- Source A: "${c.claimA.claim.slice(0, 200)}" *(${c.claimA.sourceType})*`);
        lines.push(`- Source B: "${c.claimB.claim.slice(0, 200)}" *(${c.claimB.sourceType})*`);
        lines.push(`- **Severity:** ${c.severity}`);
        lines.push(`- **Resolution:** ${c.resolution}`);
        lines.push(`- **Explanation:** ${c.resolutionExplanation}`);
        if (c.resolution === "UNRESOLVED") {
          lines.push(`> ⚠️ Confidence: LOW — Manual verification required. No guessing.`);
        }
        lines.push("");
      }
    }

    // 7. Citations
    if (citations.length > 0) {
      lines.push("### Citations");
      lines.push("");
      lines.push(citationManager.formatBibliography());
    }

    return lines.join("\n");
  }
}

export const researchSynthesisEngine = new ResearchSynthesisEngine();
