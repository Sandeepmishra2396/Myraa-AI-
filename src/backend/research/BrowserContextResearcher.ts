/**
 * MYRAA — Step 8: Advanced Browser Research Agent
 * BrowserContextResearcher
 *
 * Connects browser page context to the research engine.
 * When the user says "check this page against my code", this module:
 *   1. Validates the browser context (URL, visible text)
 *   2. Sanitizes page content through ResearchSecurityGate
 *   3. Extracts documentation requirements from the page
 *   4. Passes to ProjectResearchBridge for code comparison
 *
 * Security: Browser page content = UNTRUSTED_EXTERNAL_CONTENT.
 * Page cannot instruct MYRAA to perform actions.
 */

import type {
  BrowserPageContext,
  ResearchSource,
  SourceType,
} from "./AdvancedResearchTypes.ts";
import { researchSecurityGate } from "./ResearchSecurityGate.ts";
import { sourceReliabilityEngine } from "./SourceReliabilityEngine.ts";
import { researchClaimExtractor } from "./ResearchClaimExtractor.ts";
import type { ResearchClaim } from "./AdvancedResearchTypes.ts";
import crypto from "crypto";

export interface BrowserContextResult {
  source: ResearchSource;
  claims: ResearchClaim[];
  pageTitle: string;
  pageUrl: string;
  headings: string[];
  injectionDetected: boolean;
}

export class BrowserContextResearcher {
  /**
   * Process a browser page context for research.
   * Sanitizes all page content before extraction.
   */
  public async processPageContext(ctx: BrowserPageContext): Promise<BrowserContextResult | null> {
    // 1. Validate URL
    const urlCheck = await researchSecurityGate.validateUrl(ctx.currentUrl);
    if (!urlCheck.safe) {
      console.warn(`[BrowserContextResearcher] Blocked URL from browser: ${ctx.currentUrl}`);
      return null;
    }

    // 2. Combine all visible text (heading + selected + visible)
    const rawContent = [
      ctx.pageTitle,
      ctx.pageHeadings.join("\n"),
      ctx.selectedText || "",
      ctx.visibleText,
      ctx.codeSnippets.join("\n"),
    ]
      .filter(Boolean)
      .join("\n\n");

    // 3. Security gate — sanitize browser content
    const secCheck = researchSecurityGate.sanitizeWebContent(rawContent, ctx.currentUrl);
    if (!secCheck.allowed || !secCheck.sanitizedContent) {
      return null;
    }

    // 4. Classify source type from URL
    const sourceType = this._classifyFromUrl(ctx.currentUrl);

    // 5. Compute reliability
    const reliability = sourceReliabilityEngine.score({
      url: ctx.currentUrl,
      sourceType,
      contentLength: secCheck.sanitizedContent.length,
    });

    // 6. Build ResearchSource from browser context
    const source: ResearchSource = {
      id: crypto.randomUUID(),
      url: ctx.currentUrl,
      title: ctx.pageTitle || ctx.currentUrl,
      type: sourceType,
      sanitizedContent: secCheck.sanitizedContent,
      fetchedAt: ctx.capturedAt,
      reliability,
      injectionDetected: secCheck.injectionDetected,
    };

    // 7. Extract claims from the page
    const claims = researchClaimExtractor.extract(source, ctx.pageTitle);

    return {
      source,
      claims,
      pageTitle: ctx.pageTitle,
      pageUrl: ctx.currentUrl,
      headings: ctx.pageHeadings,
      injectionDetected: secCheck.injectionDetected,
    };
  }

  /**
   * Extract code snippets from browser context and prepare for comparison.
   */
  public extractDocumentationCodeSnippets(ctx: BrowserPageContext): string[] {
    return ctx.codeSnippets
      .map((s) => {
        const { sanitizedClaim } = researchSecurityGate.validateClaim(s);
        return sanitizedClaim;
      })
      .filter((s) => s !== "[CLAIM_REJECTED_INJECTION_DETECTED]");
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _classifyFromUrl(url: string): SourceType {
    try {
      const { hostname } = new URL(url);
      const h = hostname.toLowerCase();
      if (
        h.includes("ai.google.dev") ||
        h.includes("developers.google.com") ||
        h.includes("developer.mozilla.org") ||
        h.includes("typescriptlang.org") ||
        h.includes("react.dev") ||
        h.includes("vitejs.dev")
      ) {
        return "OFFICIAL_DOCUMENTATION";
      }
      if (h.includes("github.com")) return "OFFICIAL_GITHUB";
      if (h.includes("stackoverflow.com") || h.includes("reddit.com")) return "COMMUNITY";
      return "TRUSTED_TECHNICAL_SOURCE";
    } catch {
      return "UNKNOWN";
    }
  }
}

export const browserContextResearcher = new BrowserContextResearcher();
