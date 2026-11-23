/**
 * MYRAA — Advanced Browser Intelligence Subsystem
 * DocumentComparator.ts
 *
 * Compares two or more structured documents (API specs, technical guides, documentation pages).
 *
 * Features:
 *   - Section-level matching and diffing (ADDED, REMOVED, MODIFIED, UNCHANGED).
 *   - Code block and API signature comparison.
 *   - Version and compatibility change detection (breaking changes, deprecations).
 *   - Conflicting claim identification and contradiction mapping.
 *   - Epistemic classification (FACT, INFERENCE, HYPOTHESIS, VERIFIED_CONCLUSION).
 *   - Traceable citations and provenance preservation.
 *   - Uncertainty reporting and unresolved evidence gap tracking.
 *
 * Invariant: Treats all document contents as UNTRUSTED_EXTERNAL_CONTENT.
 */

import crypto from "crypto";
import type {
  StructuredDocument,
  DocumentComparisonResult,
  SectionDifference,
  VersionCompatibilityDiff,
  ConflictingClaim,
  DocumentComparisonCitation,
  ExtractedCodeBlock,
} from "./BrowserIntelligenceTypes.ts";

/** Token similarity between two strings using Jaccard index */
function tokenSimilarity(a: string, b: string): number {
  const stopWords = new Set(["the", "a", "an", "is", "are", "it", "in", "to", "of", "and", "for", "with", "this", "that"]);
  const tokA = new Set(
    a
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !stopWords.has(w))
  );
  const tokB = new Set(
    b
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !stopWords.has(w))
  );

  const intersection = [...tokA].filter((t) => tokB.has(t)).length;
  const union = new Set([...tokA, ...tokB]).size;
  return union === 0 ? 0 : intersection / union;
}

export class DocumentComparator {
  /**
   * Compare two structured documents and produce an evidence-backed comparison result.
   */
  public compare(
    baseDoc: StructuredDocument,
    targetDoc: StructuredDocument,
    options?: { focusTopics?: string[]; compareBy?: "sections" | "apis" | "all" }
  ): DocumentComparisonResult {
    const comparisonId = `cmp_${crypto.randomBytes(4).toString("hex")}`;
    const comparedAt = Date.now();

    const matchingSections: string[] = [];
    const sectionDifferences: SectionDifference[] = [];
    const citations: DocumentComparisonCitation[] = [];
    const observedFacts: string[] = [];
    const inferences: string[] = [];
    const hypotheses: string[] = [];
    const verifiedConclusions: string[] = [];
    const unresolvedGaps: string[] = [];
    const uncertaintyList: string[] = [];

    // Check version metadata availability
    if (!baseDoc.detectedVersion) {
      uncertaintyList.push(`Version metadata not detected for base document '${baseDoc.title}'.`);
    }
    if (!targetDoc.detectedVersion) {
      uncertaintyList.push(`Version metadata not detected for target document '${targetDoc.title}'.`);
    }

    // 1. Section-Level Comparison
    const matchedTargetIndices = new Set<number>();

    for (const baseSec of baseDoc.sections) {
      let bestMatchIdx = -1;
      let highestSim = 0;

      for (let j = 0; j < targetDoc.sections.length; j++) {
        if (matchedTargetIndices.has(j)) continue;
        const targetSec = targetDoc.sections[j];

        // Heading similarity has highest weight
        const headingSim = tokenSimilarity(baseSec.heading, targetSec.heading);
        const contentSim = tokenSimilarity(baseSec.content.slice(0, 300), targetSec.content.slice(0, 300));
        const combinedScore = headingSim * 0.7 + contentSim * 0.3;

        if (combinedScore > highestSim && (headingSim >= 0.5 || combinedScore >= 0.6)) {
          highestSim = combinedScore;
          bestMatchIdx = j;
        }
      }

      if (bestMatchIdx >= 0) {
        matchedTargetIndices.add(bestMatchIdx);
        const targetSec = targetDoc.sections[bestMatchIdx];
        matchingSections.push(baseSec.heading);

        // Compare content similarity
        const contentSim = tokenSimilarity(baseSec.content, targetSec.content);
        const codeDiff = this._compareCodeBlocks(baseSec.codeBlocks, targetSec.codeBlocks);

        if (contentSim >= 0.85 && !codeDiff.hasChanged) {
          sectionDifferences.push({
            heading: baseSec.heading,
            changeType: "UNCHANGED",
            baseContent: baseSec.content.slice(0, 200),
            targetContent: targetSec.content.slice(0, 200),
            explanation: `Section '${baseSec.heading}' is essentially identical in both documents.`,
            epistemicLabel: "FACT",
          });
          observedFacts.push(`Section '${baseSec.heading}' matches across both versions.`);
        } else {
          // MODIFIED section
          const explanation = codeDiff.hasChanged
            ? `Section '${baseSec.heading}' was modified with altered code examples: ${codeDiff.summary}`
            : `Section '${baseSec.heading}' was updated with altered descriptive text (content similarity: ${(contentSim * 100).toFixed(0)}%).`;

          sectionDifferences.push({
            heading: baseSec.heading,
            changeType: "MODIFIED",
            baseContent: baseSec.content.slice(0, 300),
            targetContent: targetSec.content.slice(0, 300),
            baseCode: baseSec.codeBlocks,
            targetCode: targetSec.codeBlocks,
            explanation,
            epistemicLabel: codeDiff.hasChanged ? "VERIFIED_CONCLUSION" : "FACT",
          });

          if (codeDiff.hasChanged) {
            verifiedConclusions.push(`Code alteration verified in section '${baseSec.heading}': ${codeDiff.summary}`);
          } else {
            observedFacts.push(`Text update observed in section '${baseSec.heading}'.`);
          }
        }

        // Add citation for matched section
        citations.push({
          sourceUrl: baseDoc.url,
          documentTitle: baseDoc.title,
          sectionHeading: baseSec.heading,
          excerpt: baseSec.content.slice(0, 150) || baseSec.heading,
          timestamp: baseDoc.retrievedAt,
        });
        citations.push({
          sourceUrl: targetDoc.url,
          documentTitle: targetDoc.title,
          sectionHeading: targetSec.heading,
          excerpt: targetSec.content.slice(0, 150) || targetSec.heading,
          timestamp: targetDoc.retrievedAt,
        });
      } else {
        // Section was REMOVED in targetDoc
        sectionDifferences.push({
          heading: baseSec.heading,
          changeType: "REMOVED",
          baseContent: baseSec.content.slice(0, 300),
          explanation: `Section '${baseSec.heading}' exists in base document but was removed or restructured in target document.`,
          epistemicLabel: "FACT",
        });
        observedFacts.push(`Section '${baseSec.heading}' removed in '${targetDoc.title}'.`);
        unresolvedGaps.push(`Section '${baseSec.heading}' was removed; verify if a replacement API or section was introduced.`);

        citations.push({
          sourceUrl: baseDoc.url,
          documentTitle: baseDoc.title,
          sectionHeading: baseSec.heading,
          excerpt: baseSec.content.slice(0, 150) || baseSec.heading,
          timestamp: baseDoc.retrievedAt,
        });
      }
    }

    // Add remaining unmatched target sections as ADDED
    for (let j = 0; j < targetDoc.sections.length; j++) {
      if (!matchedTargetIndices.has(j)) {
        const addedSec = targetDoc.sections[j];
        sectionDifferences.push({
          heading: addedSec.heading,
          changeType: "ADDED",
          targetContent: addedSec.content.slice(0, 300),
          targetCode: addedSec.codeBlocks,
          explanation: `New section '${addedSec.heading}' was introduced in target document.`,
          epistemicLabel: "FACT",
        });
        observedFacts.push(`New section '${addedSec.heading}' introduced in '${targetDoc.title}'.`);

        citations.push({
          sourceUrl: targetDoc.url,
          documentTitle: targetDoc.title,
          sectionHeading: addedSec.heading,
          excerpt: addedSec.content.slice(0, 150) || addedSec.heading,
          timestamp: targetDoc.retrievedAt,
        });
      }
    }

    // 2. Version & Compatibility Analysis
    const versionCompatibilityDiffs = this._analyzeCompatibility(baseDoc, targetDoc);
    for (const vDiff of versionCompatibilityDiffs) {
      if (vDiff.isBreakingChange) {
        verifiedConclusions.push(`Breaking change: ${vDiff.description}`);
      } else {
        observedFacts.push(`Compatibility note: ${vDiff.description}`);
      }
    }

    // 3. Conflicting Claims & Contradiction Detection
    const conflictingClaims = this._detectConflictingClaims(baseDoc, targetDoc);
    for (const conflict of conflictingClaims) {
      if (conflict.severity === "HIGH") {
        unresolvedGaps.push(`Unresolved contradiction regarding '${conflict.topic}': Doc A states "${conflict.docAClaim}" vs Doc B "${conflict.docBClaim}".`);
      }
    }

    // 4. Inferences & Hypotheses
    if (baseDoc.detectedVersion && targetDoc.detectedVersion) {
      inferences.push(`Comparing from version ${baseDoc.detectedVersion} to ${targetDoc.detectedVersion}.`);
    } else {
      hypotheses.push("Documents may represent sequential releases or divergent implementations without explicit version tags.");
    }

    const modifiedCount = sectionDifferences.filter((s) => s.changeType === "MODIFIED").length;
    const addedCount = sectionDifferences.filter((s) => s.changeType === "ADDED").length;
    const removedCount = sectionDifferences.filter((s) => s.changeType === "REMOVED").length;
    const breakingCount = versionCompatibilityDiffs.filter((v) => v.isBreakingChange).length;

    // Synthesized summary
    const synthesizedSummary = [
      `Compared '${baseDoc.title}' (${baseDoc.detectedVersion || "unknown version"}) against '${targetDoc.title}' (${targetDoc.detectedVersion || "unknown version"}).`,
      `Found ${matchingSections.length} matching sections, ${modifiedCount} modified sections, ${addedCount} added sections, and ${removedCount} removed sections.`,
      breakingCount > 0 ? `Identified ${breakingCount} potential breaking change(s) or deprecations.` : "No breaking changes identified.",
      conflictingClaims.length > 0 ? `Detected ${conflictingClaims.length} conflicting claim(s).` : "No major contradictions found between versions.",
    ].join(" ");

    return {
      comparisonId,
      baseDocument: {
        id: baseDoc.id,
        url: baseDoc.url,
        title: baseDoc.title,
        version: baseDoc.detectedVersion,
      },
      targetDocument: {
        id: targetDoc.id,
        url: targetDoc.url,
        title: targetDoc.title,
        version: targetDoc.detectedVersion,
      },
      matchingSections,
      sectionDifferences,
      versionCompatibilityDiffs,
      conflictingClaims,
      unresolvedGaps,
      observedFacts: [...new Set(observedFacts)],
      inferences: [...new Set(inferences)],
      hypotheses: [...new Set(hypotheses)],
      verifiedConclusions: [...new Set(verifiedConclusions)],
      citations,
      uncertaintyNotes: uncertaintyList.length > 0 ? uncertaintyList.join(" ") : undefined,
      comparedAt,
      synthesizedSummary,
    };
  }

  // ---------------------------------------------------------------------------
  // Compatibility & Version Differences
  // ---------------------------------------------------------------------------

  private _analyzeCompatibility(
    baseDoc: StructuredDocument,
    targetDoc: StructuredDocument
  ): VersionCompatibilityDiff[] {
    const diffs: VersionCompatibilityDiff[] = [];

    // Scan targetDoc for deprecations
    const deprecationRegex = /(?:deprecated|deprecation|no longer supported|will be removed in)\s*[:\-—]?\s*([^.\n]+)/gi;
    let match: RegExpExecArray | null;

    while ((match = deprecationRegex.exec(targetDoc.visibleText)) !== null) {
      const desc = match[0].trim();
      diffs.push({
        featureOrApi: match[1]?.trim() || "Feature Deprecation",
        baseVersion: baseDoc.detectedVersion,
        targetVersion: targetDoc.detectedVersion,
        changeType: "DEPRECATED",
        description: `Deprecation notice in target document: "${desc.slice(0, 120)}"`,
        isBreakingChange: true,
        epistemicLabel: "FACT",
        sourceUrl: targetDoc.url,
      });
    }

    // Scan targetDoc for breaking change notices
    const breakingRegex = /(?:breaking change|breaking changes|migration guide|incompatible with)\s*[:\-—]?\s*([^.\n]+)/gi;
    while ((match = breakingRegex.exec(targetDoc.visibleText)) !== null) {
      const desc = match[0].trim();
      diffs.push({
        featureOrApi: match[1]?.trim() || "Breaking Change",
        baseVersion: baseDoc.detectedVersion,
        targetVersion: targetDoc.detectedVersion,
        changeType: "BEHAVIOR_CHANGED",
        description: `Breaking change notice: "${desc.slice(0, 120)}"`,
        isBreakingChange: true,
        epistemicLabel: "VERIFIED_CONCLUSION",
        sourceUrl: targetDoc.url,
      });
    }

    // Scan for removed methods / dropped features mentioned
    const removedRegex = /(?:removed|dropped support for)\s+([a-zA-Z0-9_\.]+\(\)|[a-zA-Z0-9_\.]+)/gi;
    while ((match = removedRegex.exec(targetDoc.visibleText)) !== null) {
      const feature = match[1]?.trim();
      if (feature && !diffs.some((d) => d.featureOrApi === feature)) {
        diffs.push({
          featureOrApi: feature,
          baseVersion: baseDoc.detectedVersion,
          targetVersion: targetDoc.detectedVersion,
          changeType: "REMOVED",
          description: `Feature or method '${feature}' was removed in target version.`,
          isBreakingChange: true,
          epistemicLabel: "FACT",
          sourceUrl: targetDoc.url,
        });
      }
    }

    return diffs.slice(0, 15);
  }

  // ---------------------------------------------------------------------------
  // Conflicting Claims Detection
  // ---------------------------------------------------------------------------

  private _detectConflictingClaims(
    baseDoc: StructuredDocument,
    targetDoc: StructuredDocument
  ): ConflictingClaim[] {
    const conflicts: ConflictingClaim[] = [];

    // Split documents into core sentences/statements
    const splitSentences = (text: string): string[] =>
      text
        .split(/(?<=[.!?])\s+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 20 && s.length < 200);

    const baseSentences = splitSentences(baseDoc.visibleText);
    const targetSentences = splitSentences(targetDoc.visibleText);

    // Contradiction indicators: (synchronous vs asynchronous, optional vs required, enabled vs disabled, etc.)
    const contradictionPairs = [
      { a: /\b(synchronous(ly)?|sync)\b/i, b: /\b(asynchronous(ly)?|async|returns a promise|non-blocking)\b/i, topic: "Execution Mode" },
      { a: /\boptional\b/i, b: /\brequired\b/i, topic: "Parameter Requirement" },
      { a: /\benabled(\s+by\s+default)?\b/i, b: /\bdisabled(\s+by\s+default)?\b/i, topic: "Default Configuration" },
      { a: /\bdeprecated\b/i, b: /\brecommended\b/i, topic: "Recommendation Status" },
      { a: /\bthread-safe\b/i, b: /\bnot\s+thread-safe\b/i, topic: "Concurrency Safety" },
      { a: /\b(blocks(\s+the\s+thread)?|blocking)\b/i, b: /\b(non-blocking|asynchronous(ly)?|async)\b/i, topic: "Threading Model" },
    ];

    for (const bSent of baseSentences) {
      for (const tSent of targetSentences) {
        // Must share topical context (similarity >= 0.45)
        const sim = tokenSimilarity(bSent, tSent);
        if (sim >= 0.35) {
          for (const pair of contradictionPairs) {
            if (
              (pair.a.test(bSent) && pair.b.test(tSent)) ||
              (pair.b.test(bSent) && pair.a.test(tSent))
            ) {
              const alreadyFound = conflicts.some((c) => c.topic === pair.topic);
              if (!alreadyFound) {
                conflicts.push({
                  topic: pair.topic,
                  docAClaim: bSent.slice(0, 120),
                  docASource: baseDoc.url,
                  docBClaim: tSent.slice(0, 120),
                  docBSource: targetDoc.url,
                  conflictType: "CONTRADICTION",
                  severity: "HIGH",
                  epistemicLabel: "FACT",
                });
              }
            }
          }
        }
      }
    }

    return conflicts.slice(0, 10);
  }

  // ---------------------------------------------------------------------------
  // Code Block Comparison Helper
  // ---------------------------------------------------------------------------

  private _compareCodeBlocks(
    baseCodes: ExtractedCodeBlock[] = [],
    targetCodes: ExtractedCodeBlock[] = []
  ): { hasChanged: boolean; summary: string } {
    if (baseCodes.length === 0 && targetCodes.length === 0) {
      return { hasChanged: false, summary: "No code blocks in either section." };
    }

    if (baseCodes.length !== targetCodes.length) {
      return {
        hasChanged: true,
        summary: `Code block count changed from ${baseCodes.length} to ${targetCodes.length}.`,
      };
    }

    for (let i = 0; i < baseCodes.length; i++) {
      const bCode = baseCodes[i].code.replace(/\s+/g, " ").trim();
      const tCode = targetCodes[i].code.replace(/\s+/g, " ").trim();
      if (bCode !== tCode) {
        return {
          hasChanged: true,
          summary: `Code implementation altered in example ${i + 1}.`,
        };
      }
    }

    return { hasChanged: false, summary: "Code blocks are identical." };
  }
}

export const documentComparator = new DocumentComparator();
