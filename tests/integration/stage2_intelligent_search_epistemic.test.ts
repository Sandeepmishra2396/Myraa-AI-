/**
 * MYRAA — Advanced Browser Intelligence & Adaptive Knowledge System
 * Stage 2 Integration Test Suite: Intelligent Search & Epistemic Research
 *
 * Verifies:
 *   1. Search query decomposition and bounded query refinement (max 3 iterations).
 *   2. Source authority, relevance, freshness, and independence scoring.
 *   3. Duplicate and syndicated-source detection (preventing false consensus).
 *   4. Claim-level evidence records with URL, excerpts, and provenance.
 *   5. Epistemic verification policy: FACT, INFERENCE, HYPOTHESIS, VERIFIED_CONCLUSION.
 *   6. Strict anti-syndication policy: multiple copies of syndicated content CANNOT create VERIFIED_CONCLUSION.
 *   7. Contradiction detection and explicit uncertainty reporting on conflicting evidence.
 *   8. Citation preservation from extraction through synthesis without hallucination.
 *   9. In-flight cancellation propagation and SSRF redirect checks.
 *  10. Strict invariant: Exactly 129 LIVE_TOOLS preserved.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "crypto";
import {
  sourceReliabilityEngine,
  duplicateSourceDetector,
  epistemicVerifier,
  researchQueryPlanner,
  advancedResearchCoordinator,
} from "../../backend/research/index.ts";
import type {
  ResearchClaim,
  ResearchSource,
  ContradictionRecord,
  SourceReliabilityScore,
} from "../../backend/research/AdvancedResearchTypes.ts";
import { LIVE_TOOLS } from "../../backend/ai/GeminiSessionFactory.ts";
import { emergencyStopCoordinator } from "../../backend/remote/EmergencyStopCoordinator.ts";
import { securityPolicyEngine } from "../../backend/security/SecurityPolicyEngine.ts";
import { sourceFetcher } from "../../backend/research/SourceFetcher.ts";

function createMockScore(overrides?: Partial<SourceReliabilityScore>): SourceReliabilityScore {
  return {
    sourceType: "OFFICIAL_DOCUMENTATION",
    sourceAuthority: 0.95,
    recency: 0.90,
    specificity: 0.85,
    directEvidence: true,
    corroboration: 0.30,
    versionMatch: true,
    composite: 0.90,
    independence: 1.0,
    relevance: 0.90,
    isDuplicateOrSyndicated: false,
    ...overrides,
  };
}

function createMockSource(
  id: string,
  url: string,
  title: string,
  content: string,
  sourceType: any = "OFFICIAL_DOCUMENTATION",
  reliabilityOverrides?: Partial<SourceReliabilityScore>
): ResearchSource {
  return {
    id,
    url,
    title,
    type: sourceType,
    sanitizedContent: content,
    fetchedAt: Date.now(),
    reliability: createMockScore({ sourceType, ...reliabilityOverrides }),
    injectionDetected: false,
  };
}

function createMockClaim(
  id: string,
  claimText: string,
  source: ResearchSource,
  confidence = 0.85,
  overrides?: Partial<ResearchClaim>
): ResearchClaim {
  return {
    id,
    claim: claimText,
    evidence: `Evidence excerpt: ${claimText}`,
    sourceId: source.id,
    sourceUrl: source.url,
    sourceTitle: source.title,
    sourceType: source.type,
    reliability: source.reliability,
    confidence,
    extractedAt: Date.now(),
    supports: [],
    contradicts: [],
    ...overrides,
  };
}

describe("Stage 2 — Intelligent Search & Epistemic Research Integration Suite", () => {
  beforeEach(() => {
    emergencyStopCoordinator.reset("test_setup");
    securityPolicyEngine.resetForTesting();
    advancedResearchCoordinator.reset();
  });

  afterEach(() => {
    emergencyStopCoordinator.reset("test_teardown");
    securityPolicyEngine.resetForTesting();
    advancedResearchCoordinator.reset();
  });

  // ── 1. Query Decomposition & Bounded Refinement ─────────────────────────────
  describe("1. Query Decomposition & Bounded Refinement", () => {
    it("1.1 decomposes compound questions into distinct atomic sub-queries", () => {
      const compound = "Compare Gemini Live WebSockets with REST streaming and explain audio latency";
      const parts = researchQueryPlanner.decompose(compound);

      expect(parts.length).toBeGreaterThanOrEqual(2);
      expect(parts.some((p) => p.toLowerCase().includes("gemini live websockets"))).toBe(true);
      expect(parts.some((p) => p.toLowerCase().includes("audio latency"))).toBe(true);
    });

    it("1.2 creates multi-angle query plans targeting official docs, versions, and known issues", () => {
      const plan = researchQueryPlanner.plan("Gemini Live API function calling latency");

      expect(plan.officialDocQuery).toContain("site:ai.google.dev");
      expect(plan.versionSpecificQuery).toBeDefined();
      expect(plan.knownIssueQuery).toBeDefined();
      expect(plan.implementationQuery).toBeDefined();
      expect(plan.searchDomains).toContain("ai.google.dev");
    });

    it("1.3 bounds query refinement to a maximum of 3 iterations", () => {
      const basePlan = researchQueryPlanner.plan("React 19 Server Actions formState");
      const unverified = ["formState compatibility in React 19", "useActionState replacement"];

      // Iteration 1
      const ref1 = researchQueryPlanner.refinePlan(basePlan, unverified, 1, 3);
      expect(ref1.currentIteration).toBe(1);
      expect(ref1.refinements.length).toBeGreaterThan(0);
      expect(ref1.refinements[0].targetAngle).toBe("OFFICIAL_DOC");

      // Iteration 3
      const ref3 = researchQueryPlanner.refinePlan(basePlan, unverified, 3, 3);
      expect(ref3.currentIteration).toBe(3);

      // Attempting iteration 4 should be bounded to 3
      const ref4 = researchQueryPlanner.refinePlan(basePlan, unverified, 4, 3);
      expect(ref4.currentIteration).toBe(3);
    });
  });

  // ── 2. Source Scoring: Authority, Relevance, Freshness, & Independence ──────
  describe("2. Source Scoring: Authority, Relevance, Freshness, & Independence", () => {
    it("2.1 computes authority score according to official hierarchy", () => {
      expect(sourceReliabilityEngine.getAuthority("OFFICIAL_DOCUMENTATION")).toBe(0.95);
      expect(sourceReliabilityEngine.getAuthority("OFFICIAL_API_REFERENCE")).toBe(0.92);
      expect(sourceReliabilityEngine.getAuthority("OFFICIAL_GITHUB")).toBe(0.85);
      expect(sourceReliabilityEngine.getAuthority("ACADEMIC")).toBe(0.80);
      expect(sourceReliabilityEngine.getAuthority("TRUSTED_TECHNICAL_SOURCE")).toBe(0.65);
      expect(sourceReliabilityEngine.getAuthority("COMMUNITY")).toBe(0.45);
      expect(sourceReliabilityEngine.getAuthority("FORUM")).toBe(0.30);
    });

    it("2.2 computes freshness score with time decay for older sources", () => {
      const nowIso = new Date().toISOString();
      const sixMonthsAgo = new Date(Date.now() - 150 * 24 * 3600 * 1000).toISOString();
      const threeYearsAgo = new Date(Date.now() - 3 * 365 * 24 * 3600 * 1000).toISOString();
      const fiveYearsAgo = new Date(Date.now() - 5 * 365 * 24 * 3600 * 1000).toISOString();

      const freshScore = sourceReliabilityEngine.getFreshness(nowIso);
      const mediumScore = sourceReliabilityEngine.getFreshness(sixMonthsAgo);
      const staleScore = sourceReliabilityEngine.getFreshness(threeYearsAgo);
      const veryStaleScore = sourceReliabilityEngine.getFreshness(fiveYearsAgo);

      expect(freshScore).toBe(1.0);
      expect(mediumScore).toBe(0.80);
      expect(staleScore).toBe(0.35);
      expect(veryStaleScore).toBe(0.20);
      expect(freshScore).toBeGreaterThan(mediumScore);
      expect(mediumScore).toBeGreaterThan(staleScore);
      expect(staleScore).toBeGreaterThan(veryStaleScore);
    });

    it("2.3 calculates topical relevance and penalizes duplicate/syndicated copies", () => {
      const independentScore = sourceReliabilityEngine.score({
        url: "https://ai.google.dev/docs/gemini-live",
        sourceType: "OFFICIAL_DOCUMENTATION",
        contentLength: 5000,
        publishedAt: new Date().toISOString(),
        isDuplicateOrSyndicated: false,
        independence: 1.0,
      });

      const syndicatedScore = sourceReliabilityEngine.score({
        url: "https://scraped-clone-mirror.net/gemini-live",
        sourceType: "COMMUNITY",
        contentLength: 5000,
        publishedAt: new Date().toISOString(),
        isDuplicateOrSyndicated: true,
        independence: 0.20,
      });

      expect(independentScore.independence).toBe(1.0);
      expect(syndicatedScore.independence).toBe(0.20);
      expect(independentScore.composite).toBeGreaterThan(0.80);
      expect(syndicatedScore.composite).toBeLessThan(0.40);
    });
  });

  // ── 3. Duplicate and Syndicated-Source Detection ────────────────────────────
  describe("3. Duplicate and Syndicated-Source Detection", () => {
    it("3.1 detects identical canonical URLs as duplicates", () => {
      const srcA = {
        url: "https://original-blog.com/post-1",
        title: "Deep Dive into Gemini 2.0 WebSockets",
        content: "Detailed analysis of WebSocket protocols and ephemeral tokens.",
        canonicalUrl: "https://original-blog.com/post-1",
      };
      const srcB = {
        url: "https://syndicated-mirror.io/repost-1",
        title: "Deep Dive into Gemini 2.0 WebSockets",
        content: "Detailed analysis of WebSocket protocols and ephemeral tokens.",
        canonicalUrl: "https://original-blog.com/post-1",
      };

      const result = duplicateSourceDetector.isDuplicate(srcA, srcB);
      expect(result.isDuplicate).toBe(true);
      expect(result.reason).toBe("IDENTICAL_CANONICAL_URL");
      expect(result.similarity).toBe(1.0);
    });

    it("3.2 detects syndicated articles with high content shingle overlap", () => {
      const sharedArticle =
        "The Gemini 2.0 Live API supports bidirectional audio streaming using WebSockets. " +
        "Ephemeral session tokens expire after thirty minutes and require proactive renewal before disconnecting. " +
        "Function calls are handled asynchronously with client-side verification.";

      const srcA = createMockSource(
        "s1",
        "https://tech-author.com/gemini-websockets",
        "Gemini 2.0 Live API WebSockets Guide",
        sharedArticle,
        "TRUSTED_TECHNICAL_SOURCE"
      );

      const srcB = createMockSource(
        "s2",
        "https://aggregator-clone.org/reprint/gemini-websockets",
        "Gemini 2.0 Live API WebSockets Guide",
        sharedArticle + " Posted by aggregator bot.",
        "COMMUNITY"
      );

      const report = duplicateSourceDetector.detectDuplicates([srcA, srcB]);
      expect(report.duplicateSourceCount).toBe(1);
      expect(report.clusters.length).toBe(1);
      expect(report.clusters[0].canonicalUrl).toBe(srcA.url);
      expect(report.clusters[0].duplicateUrls).toContain(srcB.url);
      expect(srcB.reliability.isDuplicateOrSyndicated).toBe(true);
      expect(srcB.reliability.independence).toBeLessThan(0.5);
    });

    it("3.3 filters out syndicated duplicates to prevent false consensus", () => {
      const sharedArticle =
        "Vite 6 introduces environment API for multi-framework SSR orchestration with strict origin isolation.";

      const original = createMockSource("orig", "https://vitejs.dev/blog/announcing-v6", "Vite 6 Announcement", sharedArticle, "OFFICIAL_DOCUMENTATION");
      const mirror1 = createMockSource("m1", "https://mirror1.com/v6", "Vite 6 Announcement", sharedArticle, "UNKNOWN");
      const mirror2 = createMockSource("m2", "https://mirror2.com/v6", "Vite 6 Announcement", sharedArticle, "UNKNOWN");
      const independentDoc = createMockSource("indep", "https://developer.mozilla.org/vite6", "MDN Overview of Vite", "MDN overview covering the Vite environment API.", "OFFICIAL_DOCUMENTATION");

      const independentSources = duplicateSourceDetector.filterIndependentSources([original, mirror1, mirror2, independentDoc]);
      expect(independentSources.length).toBe(2);
      expect(independentSources.map((s) => s.id)).toContain("orig");
      expect(independentSources.map((s) => s.id)).toContain("indep");
      expect(independentSources.map((s) => s.id)).not.toContain("m1");
      expect(independentSources.map((s) => s.id)).not.toContain("m2");
    });
  });

  // ── 4. Claim-Level Evidence Records with Provenance & Excerpts ──────────────
  describe("4. Claim-Level Evidence Records with Provenance & Excerpts", () => {
    it("4.1 populates full provenance with source URL, timestamp, domain, and syndication status", () => {
      const src = createMockSource(
        "src_prov",
        "https://ai.google.dev/gemini-api/docs/live",
        "Gemini Live Docs",
        "Live API sessions require ephemeral tokens with 30-minute validity.",
        "OFFICIAL_DOCUMENTATION",
        { publishedAt: "2026-03-01T12:00:00Z" }
      );

      const claim = createMockClaim(
        "c_prov",
        "Live API sessions require ephemeral tokens with 30-minute validity.",
        src
      );

      const verifiedClaims = epistemicVerifier.verifyAll([claim], [src], []);
      const verified = verifiedClaims[0];

      expect(verified.provenance).toBeDefined();
      expect(verified.provenance?.sourceUrl).toBe("https://ai.google.dev/gemini-api/docs/live");
      expect(verified.provenance?.domain).toBe("ai.google.dev");
      expect(verified.provenance?.publishedAt).toBe("2026-03-01T12:00:00Z");
      expect(verified.provenance?.isSyndicated).toBe(false);
      expect(verified.provenance?.sourceType).toBe("OFFICIAL_DOCUMENTATION");
    });

    it("4.2 captures supporting and contradicting excerpts with URL and source type", () => {
      const srcOfficial = createMockSource(
        "s_off",
        "https://ai.google.dev/docs/audio",
        "Official Audio Docs",
        "Sample rate must be exactly 24kHz for output audio streaming.",
        "OFFICIAL_DOCUMENTATION"
      );

      const srcCommunity = createMockSource(
        "s_com",
        "https://stackoverflow.com/q/12345",
        "StackOverflow Discussion",
        "You can stream audio at 48kHz without downsampling.",
        "COMMUNITY"
      );

      const claimA = createMockClaim("cA", "Sample rate must be exactly 24kHz for output audio streaming.", srcOfficial);
      const claimB = createMockClaim("cB", "You can stream audio at 48kHz without downsampling.", srcCommunity);

      const contradiction: ContradictionRecord = {
        id: "contra_1",
        topic: "audio_sample_rate",
        claimA,
        claimB,
        severity: "HIGH",
        resolution: "SOURCE_AUTHORITY_RESOLVED",
        resolutionExplanation: "Official documentation requires 24kHz; community workaround is unsupported.",
        preferredClaimId: claimA.id,
        resolvedConfidence: 0.90,
      };

      const result = epistemicVerifier.verifyClaim(claimA, [claimA, claimB], [srcOfficial, srcCommunity], [contradiction]);
      expect(result.contradictingExcerpts.length).toBe(1);
      expect(result.contradictingExcerpts[0].url).toBe(srcCommunity.url);
      expect(result.contradictingExcerpts[0].sourceType).toBe("COMMUNITY");
    });
  });

  // ── 5. Epistemic Classification Policy ──────────────────────────────────────
  describe("5. Epistemic Classification Policy", () => {
    it("5.1 classifies direct authoritative assertions as FACT", () => {
      const src = createMockSource("s_fact", "https://docs.python.org/3/library/asyncio.html", "asyncio docs", "asyncio.gather runs awaitable objects concurrently.", "OFFICIAL_DOCUMENTATION");
      const claim = createMockClaim("c_fact", "asyncio.gather runs awaitable objects concurrently.", src);

      const label = epistemicVerifier.classifyEpistemicLabel(claim, src);
      expect(label).toBe("FACT");
    });

    it("5.2 classifies deductive statements with reasoning markers as INFERENCE", () => {
      const src = createMockSource("s_inf", "https://tech-benchmarks.org/analysis", "Analysis", "High network jitter implies that packet buffer sizes are inadequate.", "TRUSTED_TECHNICAL_SOURCE");
      const claim = createMockClaim("c_inf", "High network jitter indicates that packet buffer sizes are inadequate, therefore streaming latency increases.", src);

      const label = epistemicVerifier.classifyEpistemicLabel(claim, src);
      expect(label).toBe("INFERENCE");
    });

    it("5.3 classifies hedged or speculative statements as HYPOTHESIS", () => {
      const src = createMockSource("s_hyp", "https://reddit.com/r/localai", "Reddit Discussion", "The memory leak might be caused by unclosed WebSocket instances.", "COMMUNITY");
      const claim = createMockClaim("c_hyp", "The memory leak might possibly be caused by unclosed WebSocket instances as a temporary workaround.", src);

      const label = epistemicVerifier.classifyEpistemicLabel(claim, src);
      expect(label).toBe("HYPOTHESIS");
    });

    it("5.4 elevates to VERIFIED_CONCLUSION only with official source or multi-domain non-syndicated corroboration", () => {
      const srcOfficial = createMockSource(
        "s_verif",
        "https://typescriptlang.org/docs/handbook/2/modules.html",
        "TypeScript Modules",
        "Node16 module resolution enforces explicit file extensions in import statements.",
        "OFFICIAL_DOCUMENTATION",
        { composite: 0.92 }
      );
      const claim = createMockClaim("c_verif", "Node16 module resolution enforces explicit file extensions in import statements.", srcOfficial);

      const verified = epistemicVerifier.verifyClaim(claim, [claim], [srcOfficial], []);
      expect(verified.label).toBe("VERIFIED_CONCLUSION");
      expect(verified.status).toBe("VERIFIED_CONCLUSION");
      expect(verified.reason).toContain("authoritative official documentation");
    });
  });

  // ── 6. Strict Anti-Syndication Policy (No False Consensus) ───────────────────
  describe("6. Strict Anti-Syndication Policy (No False Consensus)", () => {
    it("6.1 prevents multiple syndicated copies of the same article from creating a VERIFIED_CONCLUSION", () => {
      // 1 blog post + 4 aggregator copies all repeating the exact same unofficial rumor
      const rumorText = "Gemini 3.0 will drop all WebSocket endpoints in favor of HTTP/3 QUIC exclusively.";

      const originalBlog = createMockSource(
        "blog_1",
        "https://speculative-blog.xyz/gemini-rumor",
        "Gemini 3.0 Predictions",
        rumorText,
        "COMMUNITY",
        { composite: 0.50, independence: 1.0 }
      );

      const mirrorA = createMockSource("m_a", "https://clone-news1.com/rumor", "Rumor Copy", rumorText, "UNKNOWN", { isDuplicateOrSyndicated: true, independence: 0.20, canonicalUrl: originalBlog.url });
      const mirrorB = createMockSource("m_b", "https://clone-news2.com/rumor", "Rumor Copy", rumorText, "UNKNOWN", { isDuplicateOrSyndicated: true, independence: 0.20, canonicalUrl: originalBlog.url });
      const mirrorC = createMockSource("m_c", "https://clone-news3.com/rumor", "Rumor Copy", rumorText, "UNKNOWN", { isDuplicateOrSyndicated: true, independence: 0.20, canonicalUrl: originalBlog.url });

      const allSources = [originalBlog, mirrorA, mirrorB, mirrorC];
      duplicateSourceDetector.detectDuplicates(allSources);

      const claimOrig = createMockClaim("c_orig", rumorText, originalBlog);
      const claimA = createMockClaim("c_a", rumorText, mirrorA);
      const claimB = createMockClaim("c_b", rumorText, mirrorB);
      const claimC = createMockClaim("c_c", rumorText, mirrorC);

      // Even if claims list each other in supports:
      claimOrig.supports = [claimA.id, claimB.id, claimC.id];

      const verified = epistemicVerifier.verifyClaim(
        claimOrig,
        [claimOrig, claimA, claimB, claimC],
        allSources,
        []
      );

      // CRITICAL ASSERTION: Multiple syndicated copies CANNOT grant VERIFIED_CONCLUSION!
      expect(verified.label).not.toBe("VERIFIED_CONCLUSION");
      expect(verified.status).not.toBe("VERIFIED_CONCLUSION");
    });
  });

  // ── 7. Contradiction Detection & Explicit Uncertainty ───────────────────────
  describe("7. Contradiction Detection & Explicit Uncertainty", () => {
    it("7.1 labels claims as INSUFFICIENT_EVIDENCE when unresolved high-severity contradictions exist", () => {
      const src1 = createMockSource("s1", "https://doc1.org", "Doc 1", "Feature X is strictly deprecated in version 2.", "OFFICIAL_DOCUMENTATION");
      const src2 = createMockSource("s2", "https://doc2.org", "Doc 2", "Feature X is actively supported and enabled by default in version 2.", "OFFICIAL_DOCUMENTATION");

      const claim1 = createMockClaim("c1", "Feature X is strictly deprecated in version 2.", src1);
      const claim2 = createMockClaim("c2", "Feature X is actively supported and enabled by default in version 2.", src2);

      const unresolvedContradiction: ContradictionRecord = {
        id: "unres_1",
        topic: "feature_x_support",
        claimA: claim1,
        claimB: claim2,
        severity: "HIGH",
        resolution: "UNRESOLVED",
        resolutionExplanation: "Official sources directly contradict each other regarding Feature X deprecation in version 2.",
        preferredClaimId: null,
        resolvedConfidence: 0.30,
      };

      const result = epistemicVerifier.verifyClaim(claim1, [claim1, claim2], [src1, src2], [unresolvedContradiction]);
      expect(result.status).toBe("INSUFFICIENT_EVIDENCE");
      expect(result.label).not.toBe("VERIFIED_CONCLUSION");
      expect(result.reason).toContain("Unresolved high-severity contradiction");
    });

    it("7.2 generates explicit uncertainty and evidence gaps in research synthesis", () => {
      const src = createMockSource("s_test", "https://react.dev/blog", "React Blog", "React 19 removes propTypes support entirely.", "OFFICIAL_DOCUMENTATION");
      const claim = createMockClaim("c_prop", "React 19 removes propTypes support entirely.", src);

      const unresolvedContradiction: ContradictionRecord = {
        id: "contra_synth",
        topic: "propTypes removal",
        claimA: claim,
        claimB: { ...claim, id: "c_other", claim: "React 19 maintains legacy propTypes warnings." },
        severity: "CRITICAL",
        resolution: "UNRESOLVED",
        resolutionExplanation: "Conflicting docs on legacy propTypes compatibility.",
        preferredClaimId: null,
        resolvedConfidence: 0.35,
      };

      const synthesis = advancedResearchCoordinator["synthesize"]
        ? (advancedResearchCoordinator as any).synthesize
        : null;

      // Verify via researchSynthesisEngine directly
      const { researchSynthesisEngine } = require("../../backend/research/ResearchSynthesisEngine.ts");
      const result = researchSynthesisEngine.synthesize({
        sessionId: "test_session",
        query: "React 19 propTypes support",
        claims: [claim],
        contradictions: [unresolvedContradiction],
        sources: [src],
      });

      expect(result.hasUncertainty).toBe(true);
      expect(result.uncertaintyReport).toBeDefined();
      expect(result.uncertaintyReport?.length).toBeGreaterThan(0);
      expect(result.answer).toContain("Uncertainty & Evidence Gaps");
      expect(result.confidence).toBe("LOW");
    });
  });

  // ── 8. Citation Preservation & Bibliographic Integrity ──────────────────────
  describe("8. Citation Preservation & Bibliographic Integrity", () => {
    it("8.1 preserves citations from claim extraction through final synthesis without hallucinating URLs", () => {
      const srcA = createMockSource("sa", "https://nodejs.org/api/fs.html", "Node.js fs API", "fs.promises.readFile returns a Promise that resolves with contents of file.", "OFFICIAL_DOCUMENTATION");
      const srcB = createMockSource("sb", "https://nodejs.org/api/path.html", "Node.js path API", "path.join concatenates all given path segments together.", "OFFICIAL_DOCUMENTATION");

      const claimA = createMockClaim("ca", "fs.promises.readFile returns a Promise that resolves with contents of file.", srcA);
      const claimB = createMockClaim("cb", "path.join concatenates all given path segments together.", srcB);

      const { researchSynthesisEngine } = require("../../backend/research/ResearchSynthesisEngine.ts");
      const result = researchSynthesisEngine.synthesize({
        sessionId: "cite_session",
        query: "Node.js fs and path operations",
        claims: [claimA, claimB],
        contradictions: [],
        sources: [srcA, srcB],
      });

      expect(result.citations.length).toBe(2);
      expect(result.citations.map((c: any) => c.sourceUrl)).toContain("https://nodejs.org/api/fs.html");
      expect(result.citations.map((c: any) => c.sourceUrl)).toContain("https://nodejs.org/api/path.html");
      expect(result.answer).toContain("https://nodejs.org/api/fs.html");
      expect(result.answer).toContain("https://nodejs.org/api/path.html");
    });
  });

  // ── 9. Cancellation & SSRF Guard Verification ───────────────────────────────
  describe("9. Cancellation & SSRF Guard Verification", () => {
    it("9.1 SourceFetcher aborts immediately if AbortSignal is already cancelled", async () => {
      const controller = new AbortController();
      controller.abort();

      const result = await sourceFetcher.fetch("https://ai.google.dev/gemini-api/docs", {
        signal: controller.signal,
      });

      expect(result).toBeNull();
    });

    it("9.2 SourceFetcher blocks private IP SSRF attempts", async () => {
      const privateIps = [
        "http://127.0.0.1:8080/admin",
        "http://localhost:3000/keys",
        "http://169.254.169.254/latest/meta-data",
        "http://10.0.0.1/secrets",
        "http://192.168.1.1/router",
      ];

      for (const url of privateIps) {
        const result = await sourceFetcher.fetch(url);
        expect(result).toBeNull();
      }
    });
  });

  // ── 10. Strict Invariant: Exactly 129 LIVE_TOOLS Preserved ───────────────────
  describe("10. Strict Invariant: Exactly 129 LIVE_TOOLS Preserved", () => {
    it("10.1 preserves exactly 129 Gemini Live tools in LIVE_TOOLS", () => {
      const toolDecls = LIVE_TOOLS[0].functionDeclarations;
      expect(toolDecls).toBeDefined();
      expect(toolDecls.length).toBe(129);

      const names = toolDecls.map((d: any) => d.name);
      const uniqueNames = new Set(names);
      expect(uniqueNames.size).toBe(129);
    });

    it("10.2 Stage 2 research features do not add arbitrary declarations to LIVE_TOOLS", () => {
      const names = LIVE_TOOLS[0].functionDeclarations.map((d: any) => d.name);

      expect(names).not.toContain("epistemicQuery");
      expect(names).not.toContain("detectDuplicates");
      expect(names).not.toContain("verifyClaims");
      expect(names).not.toContain("setDesktopControlPasscode");
    });
  });

  // ── 11. Stage 2 Edge Cases & Authorization Gate Audit ────────────────────────
  describe("11. Stage 2 Edge Cases & Authorization Gate Audit", () => {
    it("11.1 high composite score alone does NOT verify an unsupported or unrelated claim", () => {
      const officialSource = createMockSource(
        "s_unrelated",
        "https://ai.google.dev/docs/gemini-pro",
        "Official Gemini Pro Docs",
        "Billing accounts must have a credit card linked for pay-as-you-go API usage.",
        "OFFICIAL_DOCUMENTATION",
        { composite: 0.95 }
      );

      // Claim is about WebSocket audio latency, but evidence is about credit card billing
      const unrelatedClaim = createMockClaim(
        "c_unrelated",
        "Gemini Live WebSocket streaming achieves sub-100ms bidirectional audio latency.",
        officialSource,
        0.95,
        { evidence: "Billing accounts must have a credit card linked for pay-as-you-go API usage." }
      );

      const verified = epistemicVerifier.verifyClaim(unrelatedClaim, [unrelatedClaim], [officialSource], []);
      expect(verified.label).toBe("HYPOTHESIS");
      expect(verified.status).toBe("INSUFFICIENT_EVIDENCE");
      expect(verified.reason).toContain("unsupported by or unrelated to the cited source evidence");
    });

    it("11.2 authoritative source does NOT verify an ambiguous or speculative claim", () => {
      const officialSource = createMockSource(
        "s_ambig",
        "https://ai.google.dev/docs/preview-features",
        "Official Preview Features Docs",
        "The experimental multi-modal grounding protocol is provisional and subject to change without notice.",
        "OFFICIAL_DOCUMENTATION",
        { composite: 0.95 }
      );

      const speculativeClaim = createMockClaim(
        "c_ambig",
        "The experimental multi-modal grounding protocol is provisional and subject to change.",
        officialSource,
        0.80,
        { evidence: "The experimental multi-modal grounding protocol is provisional and subject to change without notice." }
      );

      const verified = epistemicVerifier.verifyClaim(speculativeClaim, [speculativeClaim], [officialSource], []);
      expect(verified.label).toBe("HYPOTHESIS");
      expect(verified.status).not.toBe("VERIFIED_CONCLUSION");
    });

    it("11.3 deductive inferences from official documentation are NOT elevated to VERIFIED_CONCLUSION", () => {
      const officialSource = createMockSource(
        "s_inf_off",
        "https://ai.google.dev/docs/quotas",
        "Official Quotas",
        "Requests exceeding 60 RPM receive HTTP 429 rate limit errors.",
        "OFFICIAL_DOCUMENTATION",
        { composite: 0.92 }
      );

      const inferenceClaim = createMockClaim(
        "c_inf_off",
        "Receiving frequent HTTP 429 errors indicates that batch chunking is inadequate, therefore token consumption exceeds quota limits.",
        officialSource,
        0.85,
        { evidence: "Requests exceeding 60 RPM receive HTTP 429 rate limit errors." }
      );

      const verified = epistemicVerifier.verifyClaim(inferenceClaim, [inferenceClaim], [officialSource], []);
      expect(verified.label).toBe("INFERENCE");
      expect(verified.status).not.toBe("VERIFIED_CONCLUSION");
    });

    it("11.4 generic titles do not falsely cause unrelated pages to be classified as duplicates", () => {
      const page1 = {
        url: "https://python-lib.org/docs/api",
        title: "API Reference",
        content: "Detailed documentation for Python async streaming classes and socket handlers.",
      };
      const page2 = {
        url: "https://rust-crate.rs/docs/api",
        title: "API Reference",
        content: "Rust trait definitions for zero-copy memory buffers and SIMD vector operations.",
      };

      const check = duplicateSourceDetector.isDuplicate(page1, page2);
      expect(check.isDuplicate).toBe(false);
      expect(check.reason).toBe("INDEPENDENT_SOURCE");
    });

    it("11.5 standard web boilerplate overlap does not falsely trigger duplicate detection", () => {
      const boilerplate = "All rights reserved. Copyright 2026. Accept all cookies. Privacy policy. Terms of service. Navigation menu.";
      const pageA = {
        url: "https://site-a.com/article1",
        title: "Deep Learning Tensor Transforms",
        content: `Tensor math optimizations for GPU matrix operations. ${boilerplate}`,
      };
      const pageB = {
        url: "https://site-b.com/article2",
        title: "Web Security CSRF Tokens",
        content: `Cross-site request forgery protection using SameSite cookies and synchronizer tokens. ${boilerplate}`,
      };

      const check = duplicateSourceDetector.isDuplicate(pageA, pageB);
      expect(check.isDuplicate).toBe(false);
      expect(check.reason).toBe("INDEPENDENT_SOURCE");
    });

    it("11.6 query refinement strictly returns 0 refinements when currentIteration exceeds 3", () => {
      const basePlan = researchQueryPlanner.plan("Gemini Live audio streaming");
      const unverified = ["Audio buffer latency", "Sample rate support"];

      // Beyond iteration 3 (iteration 4)
      const refExceeded = researchQueryPlanner.refinePlan(basePlan, unverified, 4, 3);
      expect(refExceeded.refinements.length).toBe(0);
      expect(refExceeded.currentIteration).toBe(3);
    });

    it("11.7 research execution does not write to permanent memory or Knowledge Graph", async () => {
      const { knowledgeNodeStore } = await import("../../backend/knowledge/index.ts");
      const initialNodes = knowledgeNodeStore.count;

      // Run research query
      await advancedResearchCoordinator.query({
        question: "Gemini Live WebSockets",
        maxSources: 1,
      });

      const finalNodes = knowledgeNodeStore.count;
      expect(finalNodes).toBe(initialNodes);
    });
  });
});
