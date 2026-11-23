/**
 * MYRAA — Advanced Browser Intelligence & Adaptive Knowledge System
 * WorkflowEvidenceObserver.ts
 *
 * Stage 6: Observation and Evidence Collection layer for Workflow Pattern Detection.
 *
 * Core Guarantees:
 *   - Never infers success merely because a tool returned without an error.
 *   - Requires explicit, verified evidence for each step.
 *   - Aggressively sanitizes and scrubs credentials, passcodes, and sensitive tokens.
 *   - Rejects prompt injections, adversarial overrides, and untrusted webpage directives.
 *   - Strictly bounds observation capacity and enforces TTL pruning.
 */

import crypto from "crypto";
import { contentSanitizer } from "../../security/ContentSanitizer.ts";
import type {
  ObservedExecutionTrace,
  ObservedStepEvidence,
  SkillObservationInput,
  SkillProposalConfig,
} from "./SkillProposalTypes.ts";

export const DEFAULT_PROPOSAL_CONFIG: SkillProposalConfig = {
  minSuccessfulExecutions: 2,
  minDistinctSessions: 2,
  minSuccessRate: 0.8,
  maxStoredObservations: 500,
  maxActiveProposals: 100,
  approvalTtlMs: 3600 * 1000, // 1 hour
  observationTtlMs: 7 * 24 * 3600 * 1000, // 7 days
};

export class WorkflowEvidenceObserver {
  private _observations: ObservedExecutionTrace[] = [];
  private _config: SkillProposalConfig;

  // Sensitive patterns to scrub
  private readonly _sensitiveKeyRegex = /(password|passcode|secret|api[_-]?key|bearer|token|auth(orization)?|private[_-]?key|credential)/i;
  private readonly _sensitiveValueRegexes: RegExp[] = [
    /bearer\s+[a-zA-Z0-9_\-\.]{16,}/i,
    /eyJ[a-zA-Z0-9_\-]{10,}\.[a-zA-Z0-9_\-]{10,}\.[a-zA-Z0-9_\-]{10,}/, // JWT
    /ghp_[a-zA-Z0-9]{20,}/, // GitHub token
    /AIza[0-9A-Za-z-_]{35}/, // Google API key
    /-----BEGIN\s+(RSA|EC|OPENSSH|DSA)?\s*PRIVATE\s+KEY-----/,
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/, // Email
    /\b4[0-9]{12}(?:[0-9]{3})?\b|\b5[1-5][0-9]{14}\b/, // Visa / MC
  ];

  constructor(config: Partial<SkillProposalConfig> = {}) {
    this._config = { ...DEFAULT_PROPOSAL_CONFIG, ...config };
  }

  public resetForTesting(): void {
    this._observations = [];
  }

  public getConfig(): SkillProposalConfig {
    return { ...this._config };
  }

  public updateConfig(newConfig: Partial<SkillProposalConfig>): void {
    this._config = { ...this._config, ...newConfig };
  }

  public getObservations(): ObservedExecutionTrace[] {
    return [...this._observations];
  }

  /**
   * Records an execution trace after scrubbing sensitive data, scanning for prompt injections,
   * and verifying step evidence.
   */
  public recordTrace(input: SkillObservationInput): {
    accepted: boolean;
    traceId?: string;
    rejectionReason?: string;
  } {
    // 1. Validate inputs
    if (!input || !Array.isArray(input.steps) || input.steps.length === 0) {
      return { accepted: false, rejectionReason: "Trace must contain at least one step." };
    }

    if (!input.sessionId || typeof input.sessionId !== "string" || !input.sessionId.trim()) {
      return { accepted: false, rejectionReason: "Trace must provide a valid sessionId." };
    }

    const taskDesc = input.taskDescription || "Unlabeled task";

    // 2. Scan for prompt injection in task description
    const descScan = contentSanitizer.scanForPromptInjection(taskDesc);
    if (descScan.hasInjectionAttempt) {
      return {
        accepted: false,
        rejectionReason: `PROMPT_INJECTION_REJECTED: Task description contains adversarial payload (${descScan.matchedPatterns.join(", ")}).`,
      };
    }

    // 3. Process and scrub each step
    const scrubbedSteps: ObservedStepEvidence[] = [];
    let allStepsVerified = true;

    for (let i = 0; i < input.steps.length; i++) {
      const step = input.steps[i];
      if (!step.toolName || typeof step.toolName !== "string") {
        return { accepted: false, rejectionReason: `Step ${i} missing valid toolName.` };
      }

      // Check toolName for injection / forbidden patterns
      const toolScan = contentSanitizer.scanForPromptInjection(step.toolName);
      if (toolScan.hasInjectionAttempt) {
        return {
          accepted: false,
          rejectionReason: `PROMPT_INJECTION_REJECTED: Tool name contains injection payload (${step.toolName}).`,
        };
      }

      // Scrub parameters
      const { scrubbed: scrubbedParams, hasInjection: paramInjection } = this._scrubObject(step.parameters || {});
      if (paramInjection) {
        return {
          accepted: false,
          rejectionReason: `PROMPT_INJECTION_REJECTED: Step ${i} parameters contain adversarial payload.`,
        };
      }

      // Scrub output evidence
      const { scrubbed: scrubbedOutput, hasInjection: outputInjection } = this._scrubValue(step.outputEvidence);
      if (outputInjection) {
        return {
          accepted: false,
          rejectionReason: `PROMPT_INJECTION_REJECTED: Step ${i} output contains adversarial payload.`,
        };
      }

      // Verify evidence: success MUST NOT be assumed merely because no error was thrown
      const explicitSuccess = Boolean(step.succeeded);
      let verifiedOutcome = Boolean(step.verifiedOutcome);

      // If outputEvidence is empty/null/missing or indicates failure, outcome is NOT verified
      if (!step.outputEvidence || step.outputEvidence === "undefined" || (typeof step.outputEvidence === "object" && Object.keys(step.outputEvidence as object).length === 0)) {
        verifiedOutcome = false;
      }

      // If error message present in output, mark unverified
      if (typeof step.outputEvidence === "object" && step.outputEvidence !== null) {
        const outObj = step.outputEvidence as Record<string, unknown>;
        if (outObj.error || outObj.failed || outObj.status === "error" || outObj.ok === false) {
          verifiedOutcome = false;
        }
      }

      if (!explicitSuccess || !verifiedOutcome) {
        allStepsVerified = false;
      }

      scrubbedSteps.push({
        stepIndex: i,
        toolName: step.toolName.trim(),
        parameters: scrubbedParams as Record<string, unknown>,
        outputEvidence: scrubbedOutput,
        durationMs: typeof step.durationMs === "number" ? Math.max(0, step.durationMs) : 100,
        succeeded: explicitSuccess,
        verifiedOutcome,
        preconditionsMet: step.preconditionsMet !== false,
        postconditionsMet: step.postconditionsMet !== false,
        failureReason: step.failureReason,
        timestamp: Date.now(),
      });
    }

    const now = Date.now();
    const traceId = input.traceId || `tr_${now}_${crypto.randomBytes(4).toString("hex")}`;
    const trace: ObservedExecutionTrace = {
      traceId,
      sessionId: input.sessionId.trim(),
      taskDescription: taskDesc.trim(),
      steps: scrubbedSteps,
      overallSuccess: allStepsVerified,
      startedAt: now - scrubbedSteps.reduce((acc, s) => acc + s.durationMs, 0),
      completedAt: now,
      taskOrigin: input.taskOrigin || "workflow",
      contextTags: Array.isArray(input.contextTags) ? input.contextTags.map((t) => String(t)) : [],
    };

    // 4. Prune stale observations
    this._pruneStale(now);

    // 5. Enforce sliding window capacity (FIFO eviction)
    if (this._observations.length >= this._config.maxStoredObservations) {
      this._observations.splice(0, this._observations.length - this._config.maxStoredObservations + 1);
    }

    this._observations.push(trace);
    return { accepted: true, traceId };
  }

  /**
   * Generates a deterministic canonical workflow signature for an ordered sequence of steps.
   */
  public generateWorkflowSignature(steps: { toolName: string; parameters?: Record<string, unknown> }[]): string {
    const canonicalStepTokens = steps.map((s) => {
      const keys = s.parameters ? Object.keys(s.parameters).sort().join(",") : "";
      return `${s.toolName.toLowerCase()}[${keys}]`;
    });
    const raw = canonicalStepTokens.join("->");
    return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
  }

  /**
   * Groups recorded observations by their canonical workflow signature.
   */
  public getGroupedObservations(): Map<string, ObservedExecutionTrace[]> {
    const map = new Map<string, ObservedExecutionTrace[]>();
    for (const trace of this._observations) {
      const sig = this.generateWorkflowSignature(trace.steps);
      if (!map.has(sig)) {
        map.set(sig, []);
      }
      map.get(sig)!.push(trace);
    }
    return map;
  }

  private _pruneStale(now: number): void {
    const cutoff = now - this._config.observationTtlMs;
    this._observations = this._observations.filter((t) => t.completedAt >= cutoff);
  }

  private _scrubObject(obj: Record<string, unknown>): { scrubbed: Record<string, unknown>; hasInjection: boolean } {
    const result: Record<string, unknown> = {};
    let hasInjection = false;

    for (const [key, value] of Object.entries(obj)) {
      if (this._sensitiveKeyRegex.test(key)) {
        result[key] = "<REDACTED_SECRET>";
        continue;
      }

      const { scrubbed, hasInjection: valInjection } = this._scrubValue(value);
      if (valInjection) {
        hasInjection = true;
      }
      result[key] = scrubbed;
    }

    return { scrubbed: result, hasInjection };
  }

  private _scrubValue(value: unknown): { scrubbed: unknown; hasInjection: boolean } {
    if (typeof value === "string") {
      // Check for prompt injection
      const scan = contentSanitizer.scanForPromptInjection(value);
      if (scan.hasInjectionAttempt) {
        return { scrubbed: "<REDACTED_INJECTION>", hasInjection: true };
      }

      let scrubbedStr = value;
      for (const rx of this._sensitiveValueRegexes) {
        if (rx.test(scrubbedStr)) {
          scrubbedStr = scrubbedStr.replace(rx, "<REDACTED_SECRET>");
        }
      }
      return { scrubbed: scrubbedStr, hasInjection: false };
    }

    if (Array.isArray(value)) {
      let hasInj = false;
      const scrubbedArr = value.map((item) => {
        const res = this._scrubValue(item);
        if (res.hasInjection) hasInj = true;
        return res.scrubbed;
      });
      return { scrubbed: scrubbedArr, hasInjection: hasInj };
    }

    if (value !== null && typeof value === "object") {
      return this._scrubObject(value as Record<string, unknown>);
    }

    return { scrubbed: value, hasInjection: false };
  }
}

export const workflowEvidenceObserver = new WorkflowEvidenceObserver();
