/**
 * MYRAA — Step 8: Advanced Browser Research Agent
 * AdvancedResearchCoordinator
 *
 * Master coordinator for the Advanced Browser Research Agent.
 * Orchestrates the full research pipeline:
 *
 *   User Question
 *       ↓ ResearchQueryPlanner
 *   Query Plan
 *       ↓ ResearchSecurityGate (URL validation)
 *       ↓ MultiSourceSearchEngine (SSRF-safe fetch)
 *   Raw Sources
 *       ↓ SourceFetcher + ResearchSecurityGate (content sanitization)
 *   Sanitized Sources
 *       ↓ EvidenceNormalizer
 *       ↓ ResearchClaimExtractor
 *   Extracted Claims
 *       ↓ CrossCheckEngine (corroboration + deduplication)
 *       ↓ ContradictionDetector
 *   Evidence Analysis
 *       ↓ [Optional] BrowserContextResearcher
 *       ↓ [Optional] ProjectResearchBridge + DocumentationComparator
 *       ↓ ResearchSynthesisEngine
 *   Final SynthesizedResearchResult with Citations
 *
 * Security: Above ALL agents. Research cannot bypass SecurityPolicyEngine.
 * This module is localhost/core only — not accessible from Android/Electron/Remote.
 */

import crypto from "crypto";
import type {
  ResearchQueryRequest,
  ResearchCompareRequest,
  ResearchBrowserContextRequest,
  SynthesizedResearchResult,
  ResearchSession,
  ComparisonReport,
} from "./AdvancedResearchTypes.ts";
import { researchQueryPlanner } from "./ResearchQueryPlanner.ts";
import { multiSourceSearchEngine } from "./MultiSourceSearchEngine.ts";
import { researchClaimExtractor } from "./ResearchClaimExtractor.ts";
import { evidenceNormalizer } from "./EvidenceNormalizer.ts";
import { crossCheckEngine } from "./CrossCheckEngine.ts";
import { contradictionDetector } from "./ContradictionDetector.ts";
import { researchSynthesisEngine } from "./ResearchSynthesisEngine.ts";
import { browserContextResearcher } from "./BrowserContextResearcher.ts";
import { projectResearchBridge } from "./ProjectResearchBridge.ts";
import { documentationComparator } from "./DocumentationComparator.ts";
import { citationManager } from "./CitationManager.ts";
import { securityAuditLogger } from "../security/SecurityAuditLogger.ts";
import { multiAgentContextManager } from "../multiagent/MultiAgentContextManager.ts";

// Active session store (in-memory, single-instance)
const _sessions = new Map<string, ResearchSession>();

export class AdvancedResearchCoordinator {
  /**
   * Execute a full research query workflow.
   */
  public async query(req: ResearchQueryRequest): Promise<SynthesizedResearchResult> {
    const sessionId = crypto.randomUUID();

    // 1. Sanitize input
    const sanitizedQuestion = multiAgentContextManager.sanitizeUntrustedInput(req.question);

    securityAuditLogger.logEvent({
      eventType: "TOOL_ALLOW",
      actor: { identityId: "research_coordinator", role: "standard", ipAddress: "127.0.0.1" },
      target: { toolName: "advancedResearchCoordinator", resource: sessionId },
      riskLevel: "LOW",
      decision: "ALLOW",
      reason: `Research query started: session=${sessionId}`,
    });

    // 2. Plan queries
    const queryPlan = researchQueryPlanner.plan(sanitizedQuestion);

    // 3. Create session
    const session: ResearchSession = {
      sessionId,
      startedAt: Date.now(),
      query: sanitizedQuestion,
      queryPlan,
      sources: [],
      claims: [],
      contradictions: [],
      status: "ACTIVE",
    };

    // 4. Optional: process browser context
    if (req.browserContext) {
      const browserResult = await browserContextResearcher.processPageContext(req.browserContext);
      if (browserResult) {
        session.sources.push(browserResult.source);
        session.claims.push(...browserResult.claims);
        session.browserContext = req.browserContext;
      }
    }

    // 5. Multi-source search
    try {
      const fetchedSources = await multiSourceSearchEngine.search(
        queryPlan,
        req.maxSources ?? 5
      );
      session.sources.push(...fetchedSources);

      // 6. Extract + normalize claims from each source
      for (const source of fetchedSources) {
        const normalized = evidenceNormalizer.extractRelevantPortion(
          source.sanitizedContent,
          sanitizedQuestion
        );
        const sourceWithNormalized = { ...source, sanitizedContent: normalized };
        const claims = researchClaimExtractor.extract(sourceWithNormalized, sanitizedQuestion);
        const relevant = researchClaimExtractor.filterByRelevance(claims, sanitizedQuestion);
        session.claims.push(...relevant);
      }
    } catch (err: any) {
      securityAuditLogger.logEvent({
        eventType: "SECURITY_POLICY_VIOLATION",
        actor: { identityId: "research_coordinator", role: "standard", ipAddress: "127.0.0.1" },
        target: { toolName: "multiSourceSearchEngine", resource: sessionId },
        riskLevel: "MEDIUM",
        decision: "BLOCK",
        reason: `Research search error: ${err?.message}`,
      });
    }

    // 7. Cross-check + deduplicate
    let processedClaims = crossCheckEngine.crossCheck(session.claims);
    processedClaims = crossCheckEngine.deduplicate(processedClaims);
    session.claims = processedClaims;

    // 8. Detect contradictions
    session.contradictions = contradictionDetector.detect(session.claims);

    // 9. Optional: build project context
    let projectContext;
    if (req.projectPath) {
      projectContext = await projectResearchBridge.buildContext(
        req.projectPath,
        sanitizedQuestion
      ) || undefined;
      session.projectContext = projectContext;
    }

    // 10. Synthesize final result
    const result = researchSynthesisEngine.synthesize({
      sessionId,
      query: sanitizedQuestion,
      claims: session.claims,
      contradictions: session.contradictions,
      sources: session.sources,
      projectContext,
    });

    session.status = "COMPLETE";
    _sessions.set(sessionId, session);

    securityAuditLogger.logEvent({
      eventType: "TOOL_ALLOW",
      actor: { identityId: "research_coordinator", role: "standard", ipAddress: "127.0.0.1" },
      target: { toolName: "advancedResearchCoordinator", resource: sessionId },
      riskLevel: "LOW",
      decision: "ALLOW",
      reason: `Research query completed: session=${sessionId}, claims=${session.claims.length}, contradictions=${session.contradictions.length}`,
    });

    return result;
  }

  /**
   * Compare documentation against project implementation.
   */
  public async compare(req: ResearchCompareRequest): Promise<ComparisonReport> {
    const sessionId = crypto.randomUUID();
    const sanitizedUrl = multiAgentContextManager.sanitizeUntrustedInput(req.documentationUrl);

    // Run a research query on the doc URL
    const result = await this.query({
      question: `Documentation requirements from ${sanitizedUrl} for ${req.focusArea || "implementation"}`,
      projectPath: req.projectPath,
      maxSources: 3,
    });

    // Run documentation comparison
    const session = _sessions.get(result.sessionId);
    const report = await documentationComparator.compare(
      session?.sources || [],
      session?.claims || [],
      req.projectPath,
      req.focusArea
    );

    // Attach comparison report to result
    result.comparisonReport = report;

    return report;
  }

  /**
   * Research from browser context — user has a page open and wants analysis.
   */
  public async fromBrowserContext(
    req: ResearchBrowserContextRequest
  ): Promise<SynthesizedResearchResult> {
    return this.query({
      question: req.question || `Analyze: ${req.browserContext.pageTitle}`,
      browserContext: req.browserContext,
      projectPath: req.projectPath,
    });
  }

  /**
   * Get active session status.
   */
  public getSession(sessionId: string): ResearchSession | undefined {
    return _sessions.get(sessionId);
  }

  /**
   * Get all claims for a session.
   */
  public getClaims(sessionId: string) {
    return _sessions.get(sessionId)?.claims || [];
  }

  /**
   * Get citations for a session.
   */
  public getCitations() {
    return citationManager.getAll();
  }

  /**
   * Reset the coordinator and clear active sessions.
   */
  public reset(): void {
    _sessions.clear();
    citationManager.reset();
  }

  /**
   * Get all session summaries.
   */
  public getAllSessions(): ResearchSession[] {
    return [..._sessions.values()];
  }
}

export const advancedResearchCoordinator = new AdvancedResearchCoordinator();
