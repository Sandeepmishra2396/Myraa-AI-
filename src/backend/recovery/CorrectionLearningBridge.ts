/**
 * MYRAA — Phase 25: Self-Correction & Failure Recovery Engine
 * CorrectionLearningBridge
 *
 * Connects verified recovery outcomes to Phase 18 Adaptive Personal Brain.
 * Enforces rule: "Learn only from verified corrections."
 * Never stores failed guesses, unverified assumptions, or transient failures.
 * Scopes corrections appropriately (GLOBAL, PROJECT, WORKSPACE, APPLICATION, TASK, SESSION).
 */

import crypto from "crypto";
import { cognitiveMemoryStore } from "../brain/CognitiveMemoryStore.ts";
import type { CognitiveMemory } from "../brain/CognitiveTypes.ts";
import type {
  CorrectionRecord,
  CorrectionScope,
  RecoveryResult,
  FailureEvent,
  RecoveryCandidate,
} from "./SelfCorrectionTypes.ts";

export class CorrectionLearningBridge {
  private _corrections: Map<string, CorrectionRecord> = new Map();

  /**
   * Evaluates a recovery result and records durable learned knowledge ONLY if verified.
   */
  public async learnVerifiedCorrection(params: {
    failure: FailureEvent;
    candidate: RecoveryCandidate;
    result: RecoveryResult;
    scope?: CorrectionScope;
    verifiedValue: unknown;
  }): Promise<CorrectionRecord | null> {
    // ── 1. Gate: Learn ONLY from verified SUCCESS ───────────────────────────
    if (params.result.status !== "SUCCESS") {
      // Do NOT learn unverified, partial, or failed outcomes!
      return null;
    }

    const scope: CorrectionScope = params.scope || this._determineScope(params.failure);
    const correctionId = `corr_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
    const targetResource = params.failure.targetResource || params.failure.operation;

    const evidenceSnippet = params.result.evidence
      .filter((e) => e.verified)
      .map((e) => `${e.checkType}=${e.observedValue}`)
      .join("; ");

    const record: CorrectionRecord = {
      correctionId,
      failurePattern: `${params.failure.errorType} on ${targetResource}`,
      previousStrategy: params.failure.operation,
      failureEvidence: params.failure.errorMessage || "Operation failed",
      successfulAlternative: params.candidate.strategyId,
      verificationEvidence: evidenceSnippet || "Verified successfully",
      confidence: 0.95,
      scope,
      targetResource,
      verifiedValue: params.verifiedValue,
      timestamp: Date.now(),
    };

    this._corrections.set(correctionId, record);

    // ── 2. Persist to Phase 18 Cognitive Memory Store ───────────────────────
    try {
      const memoryKey = `correction.${scope.toLowerCase()}.${targetResource.replace(/[^a-zA-Z0-9_.-]/g, "_")}`;
      const nowStr = new Date().toISOString();
      const memRecord: CognitiveMemory = {
        id: `cog_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`,
        category: "coding_preference",
        key: memoryKey,
        value: params.verifiedValue,
        text: `Verified recovery for ${targetResource}: ${params.candidate.strategyId}`,
        confidence: 0.95,
        importance: 4,
        sourceSignal: "explicit_correction",
        status: "active",
        createdAt: nowStr,
        updatedAt: nowStr,
        usageCount: 1,
        reinforcementCount: 1,
      };

      await cognitiveMemoryStore.saveMemory(memRecord);
    } catch (err) {
      console.warn("[CorrectionLearningBridge] Could not update Phase 18 CognitiveMemoryStore:", err);
    }

    return record;
  }

  /**
   * Retrieves a learned correction for a specific resource and scope.
   */
  public getLearnedCorrection(targetResource: string): CorrectionRecord | undefined {
    for (const record of this._corrections.values()) {
      if (record.targetResource.toLowerCase() === targetResource.toLowerCase()) {
        return record;
      }
    }
    return undefined;
  }

  /**
   * Lists all learned corrections.
   */
  public getAllCorrections(): CorrectionRecord[] {
    return Array.from(this._corrections.values());
  }

  /**
   * Clears in-memory corrections.
   */
  public clear(): void {
    this._corrections.clear();
  }

  /**
   * Automatically determines the appropriate scope for a learned correction.
   */
  private _determineScope(failure: FailureEvent): CorrectionScope {
    const res = (failure.targetResource || "").toLowerCase();
    if (res.includes("node_modules") || res.includes("package.json") || res.includes(".venv") || res.includes("project")) {
      return "PROJECT";
    }
    if (res.includes("vscode") || res.includes("code.exe") || res.includes("git.exe") || res.includes("chrome")) {
      return "APPLICATION";
    }
    if (failure.taskId) {
      return "TASK";
    }
    return "GLOBAL";
  }
}

export const correctionLearningBridge = new CorrectionLearningBridge();
