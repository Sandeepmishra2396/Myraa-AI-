/**
 * MYRAA — Step 8: Advanced Browser Research Agent
 * DocumentationComparator
 *
 * Compares documentation requirements against actual project implementation.
 *
 * Flow:
 *   Documentation Sources (ResearchSources)
 *       ↓
 *   Requirement Extraction
 *       ↓
 *   Project File Discovery (ProjectResearchBridge)
 *       ↓
 *   Implementation Matching
 *       ↓
 *   ComparisonReport with MATCH / PARTIAL_MATCH / MISMATCH per requirement
 *
 * Evidence-backed: Every finding has a source location and documentation section.
 * MYRAA does not blindly declare MATCH — it shows the evidence for both sides.
 */

import crypto from "crypto";
import type {
  ResearchSource,
  ResearchClaim,
  DocumentationRequirement,
  ImplementationFinding,
  ComparisonReport,
  ComparisonStatus,
} from "./AdvancedResearchTypes.ts";
import { projectResearchBridge } from "./ProjectResearchBridge.ts";

export class DocumentationComparator {
  /**
   * Run a full documentation vs. implementation comparison.
   */
  public async compare(
    documentationSources: ResearchSource[],
    claims: ResearchClaim[],
    projectPath: string,
    focusArea?: string
  ): Promise<ComparisonReport> {
    const reportId = crypto.randomUUID();
    const generatedAt = Date.now();

    // 1. Extract documentation requirements from claims
    const requirements = this._extractRequirements(claims);

    // 2. Get project context
    const projectCtx = await projectResearchBridge.buildContext(
      projectPath,
      focusArea || requirements.map((r) => r.description).join(" ")
    );

    // 3. Compare each requirement against project files
    const findings: ImplementationFinding[] = [];

    for (const req of requirements) {
      const finding = this._matchRequirement(req, projectCtx?.relevantFiles || []);
      findings.push(finding);
    }

    // 4. Compute overall status
    const overallStatus = this._computeOverallStatus(findings);

    // 5. Identify critical mismatches
    const criticalMismatches = findings.filter(
      (f) =>
        f.requirement.isCritical &&
        (f.status === "MISMATCH" || f.status === "MISSING_REQUIREMENT")
    );

    const summary = this._buildSummary(findings, overallStatus);

    return {
      reportId,
      generatedAt,
      documentationSources,
      requirements,
      findings,
      overallStatus,
      summary,
      criticalMismatches,
    };
  }

  /**
   * Format the comparison report for display in the final research answer.
   */
  public formatReport(report: ComparisonReport): string {
    const lines: string[] = [];
    lines.push("## Documentation ↔ Implementation Comparison Report");
    lines.push("");
    lines.push(`**Overall Status:** ${report.overallStatus}`);
    lines.push(`**Report ID:** ${report.reportId.slice(0, 8)}`);
    lines.push(`**Generated:** ${new Date(report.generatedAt).toISOString()}`);
    lines.push("");
    lines.push("### Findings");
    lines.push("");

    for (const finding of report.findings) {
      lines.push(`#### Requirement: ${finding.requirement.description}`);
      lines.push(`- **Documentation Source:** ${finding.requirement.sourceUrl}`);
      lines.push(`- **Section:** ${finding.requirement.sourceSection}`);
      lines.push(`- **Evidence from Docs:** ${finding.requirement.evidenceFromDocs}`);
      lines.push("");
      lines.push(`**Your Implementation:** ${finding.implementationLocation}`);
      if (finding.implementationSnippet) {
        lines.push("```");
        lines.push(finding.implementationSnippet.slice(0, 300));
        lines.push("```");
      }
      lines.push("");
      lines.push(`**Comparison Status:** ${finding.status}`);
      lines.push(`**Explanation:** ${finding.explanation}`);
      if (finding.potentialIssue) {
        lines.push(`> ⚠️ **Potential Issue:** ${finding.potentialIssue}`);
      }
      lines.push("---");
    }

    if (report.criticalMismatches.length > 0) {
      lines.push("### ⚠️ Critical Mismatches");
      for (const m of report.criticalMismatches) {
        lines.push(`- **${m.requirement.description}**: ${m.explanation}`);
      }
    }

    lines.push("### Documentation Sources");
    for (const src of report.documentationSources) {
      lines.push(`- [${src.title}](${src.url}) — ${src.type}`);
    }

    return lines.join("\n");
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _extractRequirements(claims: ResearchClaim[]): DocumentationRequirement[] {
    // Filter for high-confidence, authoritative claims
    const authoritative = claims.filter(
      (c) =>
        c.reliability.sourceAuthority >= 0.80 &&
        c.confidence >= 0.60
    );

    return authoritative.map((c) => ({
      requirementId: crypto.randomUUID(),
      description: c.claim.slice(0, 150),
      evidenceFromDocs: c.evidence,
      sourceUrl: c.sourceUrl,
      sourceSection: c.sourceTitle,
      isCritical: c.reliability.sourceType === "OFFICIAL_DOCUMENTATION" && c.confidence > 0.75,
    }));
  }

  private _matchRequirement(
    req: DocumentationRequirement,
    projectFiles: Array<{ path: string; content: string; relevanceScore: number }>
  ): ImplementationFinding {
    // Look for key terms from the requirement in project files
    const reqTokens = req.description
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3)
      .slice(0, 5);

    let bestMatch: { path: string; snippet: string; matchRatio: number } | null = null;

    for (const file of projectFiles) {
      const fileLower = file.content.toLowerCase();
      const matchCount = reqTokens.filter((t) => fileLower.includes(t)).length;
      const matchRatio = matchCount / Math.max(1, reqTokens.length);

      if (matchRatio > 0.5 && (bestMatch === null || matchRatio > bestMatch.matchRatio)) {
        // Extract surrounding snippet
        const tokenIdx = reqTokens.find((t) => fileLower.includes(t));
        let snippet = "";
        if (tokenIdx) {
          const idx = fileLower.indexOf(tokenIdx);
          const start = Math.max(0, idx - 100);
          const end = Math.min(file.content.length, idx + 300);
          snippet = file.content.slice(start, end).trim();
        }
        bestMatch = { path: file.path, snippet, matchRatio };
      }
    }

    if (!bestMatch) {
      return {
        requirementId: req.requirementId,
        requirement: req,
        implementationLocation: "Not found in project files",
        implementationSnippet: "",
        status: "NOT_FOUND",
        explanation: `No implementation found matching requirement: "${req.description}"`,
        potentialIssue: req.isCritical
          ? "This is a critical documentation requirement that appears to be missing from the implementation."
          : undefined,
      };
    }

    // Determine match status
    let status: ComparisonStatus;
    if (bestMatch.matchRatio >= 0.80) {
      status = "MATCH";
    } else if (bestMatch.matchRatio >= 0.50) {
      status = "PARTIAL_MATCH";
    } else {
      status = "MISMATCH";
    }

    return {
      requirementId: req.requirementId,
      requirement: req,
      implementationLocation: bestMatch.path,
      implementationSnippet: bestMatch.snippet,
      status,
      explanation:
        status === "MATCH"
          ? `Implementation at ${bestMatch.path} matches the documentation requirement.`
          : status === "PARTIAL_MATCH"
          ? `Implementation at ${bestMatch.path} partially satisfies the requirement (${(bestMatch.matchRatio * 100).toFixed(0)}% match).`
          : `Implementation at ${bestMatch.path} does not fully satisfy the requirement.`,
      potentialIssue:
        status !== "MATCH"
          ? `Documentation requires: "${req.evidenceFromDocs.slice(0, 200)}". Review and update implementation.`
          : undefined,
    };
  }

  private _computeOverallStatus(findings: ImplementationFinding[]): ComparisonStatus {
    if (findings.length === 0) return "NOT_FOUND";
    const statuses = findings.map((f) => f.status);
    if (statuses.every((s) => s === "MATCH")) return "MATCH";
    if (statuses.some((s) => s === "MISMATCH" || s === "NOT_FOUND")) return "PARTIALLY_ALIGNED";
    if (statuses.some((s) => s === "MISSING_REQUIREMENT")) return "MISSING_REQUIREMENT";
    return "PARTIAL_MATCH";
  }

  private _buildSummary(findings: ImplementationFinding[], status: ComparisonStatus): string {
    const total = findings.length;
    const matched = findings.filter((f) => f.status === "MATCH").length;
    const partial = findings.filter((f) => f.status === "PARTIAL_MATCH").length;
    const missing = findings.filter((f) => f.status === "NOT_FOUND" || f.status === "MISSING_REQUIREMENT").length;

    return (
      `Overall status: ${status}. ` +
      `${matched}/${total} requirements matched, ` +
      `${partial} partial matches, ` +
      `${missing} missing or not found.`
    );
  }
}

export const documentationComparator = new DocumentationComparator();
