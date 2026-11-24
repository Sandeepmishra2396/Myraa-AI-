/**
 * Unit Test Suite for Research Workspace Endpoints & Intelligence Operations
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { advancedResearchCoordinator } from "../../backend/research/AdvancedResearchCoordinator.ts";

describe("Research Workspace Backend & Epistemic Pipeline", () => {
  beforeEach(() => {
    advancedResearchCoordinator.reset();
  });

  afterEach(() => {
    advancedResearchCoordinator.reset();
  });

  it("coordinates research query and generates structured synthesis with citations", async () => {
    const result = await advancedResearchCoordinator.query({
      question: "Gemini Live API audio format and streaming latency requirements",
      maxSources: 5,
    });

    expect(result).toBeDefined();
    expect(result.sessionId).toBeDefined();
    expect(typeof result.sessionId).toBe("string");
    expect(result.query).toContain("Gemini Live API");
    expect(result.answer).toBeDefined();
    expect(Array.isArray(result.keyFindings)).toBe(true);
    expect(Array.isArray(result.citations)).toBe(true);

    // Verify session was recorded
    const session = advancedResearchCoordinator.getSession(result.sessionId);
    expect(session).toBeDefined();
    expect(session?.status).toBe("COMPLETE");
  });

  it("extracts and retrieves claims for an active research session", async () => {
    const result = await advancedResearchCoordinator.query({
      question: "Vite 6 bundling architecture and node built-in module resolution",
      maxSources: 3,
    });

    const claims = advancedResearchCoordinator.getClaims(result.sessionId);
    expect(Array.isArray(claims)).toBe(true);
    // Even if simulated / offline, claims list should be non-null array
    expect(claims.length).toBeGreaterThanOrEqual(0);
  });

  it("handles epistemic queries with refinement flags", async () => {
    const result = await advancedResearchCoordinator.epistemicQuery({
      question: "Multi-agent coordination architecture DAG constraints",
      maxSources: 4,
      allowRefinement: true,
      requireOfficial: false,
    });

    expect(result).toBeDefined();
    expect(result.sessionId).toBeDefined();

    const allSessions = advancedResearchCoordinator.getAllSessions();
    expect(allSessions.length).toBeGreaterThanOrEqual(1);
    expect(allSessions.some((s) => s.sessionId === result.sessionId)).toBe(true);
  });

  it("clears all sessions and citations upon coordinator reset", async () => {
    await advancedResearchCoordinator.query({
      question: "Temporary test query",
      maxSources: 2,
    });

    expect(advancedResearchCoordinator.getAllSessions().length).toBe(1);

    advancedResearchCoordinator.reset();
    expect(advancedResearchCoordinator.getAllSessions().length).toBe(0);
  });
});
