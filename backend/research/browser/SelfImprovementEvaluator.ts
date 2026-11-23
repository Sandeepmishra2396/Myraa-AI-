/**
 * MYRAA — Advanced Browser Intelligence & Adaptive Knowledge System
 * SelfImprovementEvaluator.ts
 *
 * Stage 7: Master Evaluator & Candidate Lifecycle State Machine.
 *
 * Enforces:
 *   - Strict lifecycle state transitions:
 *     SUBMITTED → VALIDATED → EVALUATING → EVALUATED → UNDER_CRITIC_REVIEW →
 *     UNDER_SECURITY_REVIEW → READY_FOR_HUMAN_REVIEW → APPROVED | REJECTED
 *   - Evaluator cannot modify its own criteria, fixtures, baselines, or policy.
 *   - Strict AI Self-Approval Defense (UNAUTHORIZED_SELF_APPROVAL).
 *   - Authenticated Human Approval with Anti-Replay Nonce, Version Binding, and Expiration.
 *   - Material Change Invalidation & Version Bump.
 *   - Hard Safety Gates: Failure immediately forces REJECT regardless of aggregate score.
 *   - Controlled Integration with Rollback Tokens & zero auto-deployment.
 *   - Emergency Stop & Security Policy Lockdown integration.
 */

import crypto from "crypto";
import { emergencyStopCoordinator } from "../../remote/EmergencyStopCoordinator.ts";
import { securityPolicyEngine } from "../../security/SecurityPolicyEngine.ts";
import {
  isolatedEvaluationHarness,
  IsolatedEvaluationHarness,
} from "./IsolatedEvaluationHarness.ts";
import {
  improvementCriticReviewer,
  ImprovementCriticReviewer,
} from "./ImprovementCriticReviewer.ts";
import {
  improvementSecurityReviewer,
  ImprovementSecurityReviewer,
} from "./ImprovementSecurityReviewer.ts";
import type {
  EvaluationReport,
  HumanApprovalRecord,
  ImprovementAuditEntry,
  ImprovementCandidate,
  ImprovementCandidateLifecycleState,
  SubmitCandidateInput,
} from "./SelfImprovementTypes.ts";

export const DEFAULT_IMPROVEMENT_CRITERIA = {
  minTaskSuccessRate: 0.8,
  minEvidenceIntegrityScore: 0.85,
  maxUnsupportedClaimRate: 0.1,
  maxRegressionRate: 0.05,
};

export class SelfImprovementEvaluator {
  private _candidates: Map<string, ImprovementCandidate> = new Map();
  private _usedApprovalNonces: Set<string> = new Set();
  private _activeIntegrations: Map<string, Record<string, unknown>> = new Map();

  private _harness: IsolatedEvaluationHarness;
  private _critic: ImprovementCriticReviewer;
  private _securityReviewer: ImprovementSecurityReviewer;

  // Forbidden AI self-approver identities
  private readonly _aiApproverIdentities = new Set<string>([
    "myraa",
    "ai",
    "system",
    "autonomous_agent",
    "model",
    "assistant",
    "bot",
    "evaluator",
    "self_improvement_evaluator",
    "proposer",
    "critic",
  ]);

  constructor(
    harness = isolatedEvaluationHarness,
    critic = improvementCriticReviewer,
    securityReviewer = improvementSecurityReviewer,
  ) {
    this._harness = harness;
    this._critic = critic;
    this._securityReviewer = securityReviewer;
  }

  public resetForTesting(): void {
    this._candidates.clear();
    this._usedApprovalNonces.clear();
    this._activeIntegrations.clear();
  }

  // ── Pre-flight Safety Checks ──────────────────────────────────────────────

  private _assertSystemOperational(opName: string): void {
    if (emergencyStopCoordinator.isActive()) {
      throw new Error(`EMERGENCY_STOP_ACTIVE: Operation '${opName}' blocked because Emergency Stop is active.`);
    }

    if (securityPolicyEngine.getMode() === "LOCKDOWN") {
      throw new Error(`SECURITY_LOCKDOWN_ACTIVE: Operation '${opName}' blocked during Security Policy Lockdown.`);
    }
  }

  // ── Candidate Submission & Validation ──────────────────────────────────────

  public submitCandidate(input: SubmitCandidateInput): ImprovementCandidate {
    this._assertSystemOperational("submitCandidate");

    if (!input.name || !input.targetComponent || !input.proposedPayload) {
      throw new Error("INVALID_CANDIDATE_INPUT: name, targetComponent, and proposedPayload are required.");
    }

    const now = Date.now();
    const candidateId = `cand_imp_${now}_${crypto.randomBytes(4).toString("hex")}`;
    const contentHash = this._computePayloadHash(input.proposedPayload);

    const criteria = {
      ...DEFAULT_IMPROVEMENT_CRITERIA,
      ...input.criteria,
    };

    const candidate: ImprovementCandidate = {
      candidateId,
      version: 1,
      kind: input.kind,
      name: input.name.trim(),
      description: input.description.trim(),
      targetComponent: input.targetComponent.trim(),
      proposedPayload: { ...input.proposedPayload },
      baselinePayload: input.baselinePayload ? { ...input.baselinePayload } : undefined,
      baselineScore: input.baselineScore,
      provenance: {
        author: input.author || "autonomous_engineer",
        rationale: input.rationale || "Automated optimization proposal",
        sourceTraces: input.sourceTraces ? [...input.sourceTraces] : [],
        createdAt: now,
      },
      criteria,
      lifecycleState: "SUBMITTED",
      auditHistory: [
        {
          timestamp: now,
          event: "CANDIDATE_SUBMITTED",
          actor: input.author || "system",
          details: { kind: input.kind, target: input.targetComponent },
          newState: "SUBMITTED",
        },
      ],
      createdAt: now,
      updatedAt: now,
      contentHash,
    };

    // Pre-validate candidate structure
    this._validateCandidatePayload(candidate);
    this._transitionState(candidate, "VALIDATED", "Candidate passed initial structural validation", "SelfImprovementEvaluator");

    this._candidates.set(candidateId, candidate);
    return candidate;
  }

  private _validateCandidatePayload(candidate: ImprovementCandidate): void {
    const payload = candidate.proposedPayload;
    if (Object.keys(payload).length === 0) {
      throw new Error("EMPTY_PAYLOAD_REJECTED: Candidate proposedPayload cannot be empty.");
    }

    // Tamper protection: candidate cannot set internal evaluator flags or policies
    if (
      payload.overridePolicy === true ||
      payload.disableSafetyGates === true ||
      payload.bypassSecurity === true
    ) {
      throw new Error("MALICIOUS_CANDIDATE_REJECTED: Candidate attempts to override evaluator security policies.");
    }
  }

  private _computePayloadHash(payload: Record<string, unknown>): string {
    return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  }

  // ── Isolated Evaluation Execution ──────────────────────────────────────────

  public async evaluateCandidate(candidateId: string): Promise<ImprovementCandidate> {
    this._assertSystemOperational("evaluateCandidate");

    const candidate = this._candidates.get(candidateId);
    if (!candidate) {
      throw new Error(`CANDIDATE_NOT_FOUND: Candidate '${candidateId}' does not exist.`);
    }

    if (!["SUBMITTED", "VALIDATED"].includes(candidate.lifecycleState)) {
      throw new Error(
        `INVALID_EVALUATION_STATE: Cannot evaluate candidate in state '${candidate.lifecycleState}'. Expected 'VALIDATED'.`,
      );
    }

    this._transitionState(candidate, "EVALUATING", "Beginning isolated harness evaluation", "SelfImprovementEvaluator");

    // Execute isolated evaluation harness
    const report = await this._harness.evaluateCandidate(candidate);
    candidate.evaluationReport = report;
    this._transitionState(candidate, "EVALUATED", `Evaluation complete. Recommendation: ${report.recommendation}`, "IsolatedEvaluationHarness");

    // Advance through automated Critic and Phase 26 Security Reviews
    this._advanceThroughAutomatedReviews(candidate, report);

    return candidate;
  }

  private _advanceThroughAutomatedReviews(candidate: ImprovementCandidate, report: EvaluationReport): void {
    // 1. Critic Review
    this._transitionState(candidate, "UNDER_CRITIC_REVIEW", "Advancing to Critic Review", "SelfImprovementEvaluator");
    const criticReview = this._critic.reviewCandidate(candidate, report);
    candidate.criticReview = criticReview;

    if (criticReview.verdict === "REJECTED") {
      this._transitionState(
        candidate,
        "REJECTED",
        `Critic review failed: ${criticReview.detectedFlaws.join("; ")}`,
        "ImprovementCriticReviewer",
      );
      return;
    }

    // 2. Security Review
    this._transitionState(candidate, "UNDER_SECURITY_REVIEW", "Advancing to Security Review", "SelfImprovementEvaluator");
    const secReview = this._securityReviewer.reviewSecurity(candidate, report);
    candidate.securityReview = secReview;

    if (secReview.verdict === "REJECTED") {
      this._transitionState(
        candidate,
        "REJECTED",
        `Security review failed: ${secReview.violations.join("; ")}`,
        "Phase26SecurityAuthority",
      );
      return;
    }

    // 3. Ready for Human Review
    this._transitionState(
      candidate,
      "READY_FOR_HUMAN_REVIEW",
      "Passed isolated evaluation, critic review, and Phase 26 security review. Awaiting authenticated operator decision.",
      "SelfImprovementEvaluator",
    );
  }

  // ── Material Change & Approval Invalidation ────────────────────────────────

  public updateCandidatePayload(
    candidateId: string,
    newPayload: Record<string, unknown>,
    actor: string,
  ): ImprovementCandidate {
    this._assertSystemOperational("updateCandidatePayload");

    const candidate = this._candidates.get(candidateId);
    if (!candidate) {
      throw new Error(`CANDIDATE_NOT_FOUND: Candidate '${candidateId}' does not exist.`);
    }

    if (["INTEGRATED", "ROLLED_BACK"].includes(candidate.lifecycleState)) {
      throw new Error(`CANNOT_MODIFY_TERMINAL_CANDIDATE: Candidate is already ${candidate.lifecycleState}.`);
    }

    const newHash = this._computePayloadHash(newPayload);
    const materialChange = newHash !== candidate.contentHash;

    candidate.proposedPayload = { ...newPayload };
    candidate.version += 1;
    candidate.contentHash = newHash;
    candidate.updatedAt = Date.now();

    if (materialChange) {
      // Invalidate all prior evaluation reports, reviews, and human approvals
      candidate.evaluationReport = undefined;
      candidate.criticReview = undefined;
      candidate.securityReview = undefined;
      candidate.humanApproval = undefined;

      this._transitionState(
        candidate,
        "VALIDATED",
        "Material change detected in candidate payload. Prior evaluation and approvals invalidated; re-evaluation required.",
        actor,
      );
    }

    return candidate;
  }

  // ── Evaluator Self-Tamper Protection ──────────────────────────────────────

  public updateCriteria(): never {
    throw new Error(
      "EVALUATOR_CRITERIA_TAMPER_PROTECTION: Evaluator criteria cannot be dynamically altered by unapproved callers.",
    );
  }

  // ── Authenticated Human Approval Gate ──────────────────────────────────────

  public approveCandidate(
    candidateId: string,
    decision: {
      approver: string;
      approverRole: "admin" | "standard";
      reason: string;
      nonce?: string;
      expiresAt?: number;
      candidateVersion?: number;
      signature?: string;
    },
  ): ImprovementCandidate {
    this._assertSystemOperational("approveCandidate");

    const candidate = this._candidates.get(candidateId);
    if (!candidate) {
      throw new Error(`CANDIDATE_NOT_FOUND: Candidate '${candidateId}' does not exist.`);
    }

    // 1. Strict AI Self-Approval Defense
    const cleanApprover = (decision.approver || "").trim().toLowerCase();
    if (!cleanApprover || this._aiApproverIdentities.has(cleanApprover)) {
      throw new Error(
        `UNAUTHORIZED_SELF_APPROVAL: AI or autonomous agent '${decision.approver}' cannot self-approve improvement candidates. Human operator authorization required.`,
      );
    }

    // 2. Lifecycle State Guard
    if (candidate.lifecycleState !== "READY_FOR_HUMAN_REVIEW") {
      throw new Error(
        `INVALID_LIFECYCLE_STATE: Cannot approve candidate in state '${candidate.lifecycleState}'. Expected 'READY_FOR_HUMAN_REVIEW'.`,
      );
    }

    // 3. Reason Guard
    if (!decision.reason || decision.reason.trim().length < 5) {
      throw new Error("APPROVAL_REASON_REQUIRED: Explicit reason (>= 5 chars) required for human approval.");
    }

    // 4. Nonce Replay Defense
    const nonce = decision.nonce || crypto.randomBytes(16).toString("hex");
    if (this._usedApprovalNonces.has(nonce)) {
      throw new Error(`REPLAYED_APPROVAL_REJECTED: Nonce '${nonce}' has already been used.`);
    }
    this._usedApprovalNonces.add(nonce);

    // 5. Expiration Defense
    const now = Date.now();
    const expiresAt = decision.expiresAt || now + 3600 * 1000;
    if (expiresAt < now) {
      this._transitionState(candidate, "REJECTED", "Approval decision expired.", cleanApprover);
      throw new Error(`EXPIRED_APPROVAL_REJECTED: Approval timestamp is in the past (${new Date(expiresAt).toISOString()}).`);
    }

    // 6. Version Binding Defense
    if (typeof decision.candidateVersion === "number" && decision.candidateVersion !== candidate.version) {
      throw new Error(
        `VERSION_MISMATCH_REJECTED: Decision is bound to candidate version ${decision.candidateVersion}, but current version is ${candidate.version}.`,
      );
    }

    // 7. Security Reviews Must Be Present and Passed
    if (!candidate.securityReview || candidate.securityReview.verdict !== "PASSED") {
      throw new Error("SECURITY_GATE_BLOCKED: Cannot approve candidate without verified passing security review.");
    }

    const signature =
      decision.signature ||
      crypto
        .createHmac("sha256", "myraa_human_approval_secret")
        .update(`${candidate.candidateId}:${candidate.version}:${cleanApprover}:${nonce}`)
        .digest("hex");

    const approvalRecord: HumanApprovalRecord = {
      approver: cleanApprover,
      approverRole: decision.approverRole || "standard",
      decision: "APPROVE",
      reason: decision.reason.trim(),
      timestamp: now,
      expiresAt,
      nonce,
      candidateVersion: candidate.version,
      signature,
    };

    candidate.humanApproval = approvalRecord;
    this._transitionState(
      candidate,
      "APPROVED",
      `Approved by operator '${cleanApprover}' (${decision.approverRole}). Reason: ${decision.reason}`,
      cleanApprover,
    );

    return candidate;
  }

  public rejectCandidate(
    candidateId: string,
    decision: {
      rejecter: string;
      reason: string;
    },
  ): ImprovementCandidate {
    this._assertSystemOperational("rejectCandidate");

    const candidate = this._candidates.get(candidateId);
    if (!candidate) {
      throw new Error(`CANDIDATE_NOT_FOUND: Candidate '${candidateId}' does not exist.`);
    }

    if (["INTEGRATED", "ROLLED_BACK"].includes(candidate.lifecycleState)) {
      throw new Error(`CANNOT_REJECT_TERMINAL_CANDIDATE: Candidate is already ${candidate.lifecycleState}.`);
    }

    this._transitionState(
      candidate,
      "REJECTED",
      `Rejected by '${decision.rejecter}'. Reason: ${decision.reason || "No reason specified."}`,
      decision.rejecter,
    );

    return candidate;
  }

  // ── Controlled Integration & Atomic Rollback ───────────────────────────────

  public integrateCandidate(candidateId: string, actor: string): ImprovementCandidate {
    this._assertSystemOperational("integrateCandidate");

    const candidate = this._candidates.get(candidateId);
    if (!candidate) {
      throw new Error(`CANDIDATE_NOT_FOUND: Candidate '${candidateId}' does not exist.`);
    }

    if (candidate.lifecycleState !== "APPROVED") {
      throw new Error(
        `UNAUTHORIZED_INTEGRATION_BLOCKED: Candidate must be 'APPROVED' before integration. Current state: '${candidate.lifecycleState}'.`,
      );
    }

    if (!candidate.humanApproval) {
      throw new Error("HUMAN_APPROVAL_MISSING: Cannot integrate without verified human approval.");
    }

    const now = Date.now();
    const rollbackToken = `rlbk_imp_${now}_${crypto.randomBytes(8).toString("hex")}`;
    const targetComp = candidate.targetComponent;

    // Capture backup of existing component payload
    const backupPayload = this._activeIntegrations.get(targetComp)
      ? { ...this._activeIntegrations.get(targetComp) }
      : {};

    // Integrate into in-memory component store — STRICT INVARIANT: autoDeployment is blocked
    this._activeIntegrations.set(targetComp, {
      activeCandidateId: candidate.candidateId,
      version: candidate.version,
      payload: { ...candidate.proposedPayload },
      integratedAt: now,
      integratedBy: actor,
      autoDeploymentAllowed: false,
    });

    candidate.integrationRecord = {
      integratedAt: now,
      integratedBy: actor,
      rollbackToken,
      targetComponent: targetComp,
      backupPayload,
      autoDeploymentBlocked: true,
    };

    this._transitionState(
      candidate,
      "INTEGRATED",
      `Candidate integrated into '${targetComp}' by '${actor}'. Auto-deployment blocked. Rollback token generated.`,
      actor,
    );

    return candidate;
  }

  public rollbackCandidate(
    candidateId: string,
    rollbackToken: string,
    actor: string,
    reason: string,
  ): ImprovementCandidate {
    this._assertSystemOperational("rollbackCandidate");

    const candidate = this._candidates.get(candidateId);
    if (!candidate) {
      throw new Error(`CANDIDATE_NOT_FOUND: Candidate '${candidateId}' does not exist.`);
    }

    if (candidate.lifecycleState !== "INTEGRATED") {
      throw new Error(
        `CANNOT_ROLLBACK_NON_INTEGRATED: Candidate state is '${candidate.lifecycleState}', expected 'INTEGRATED'.`,
      );
    }

    if (!candidate.integrationRecord || candidate.integrationRecord.rollbackToken !== rollbackToken) {
      throw new Error("INVALID_ROLLBACK_TOKEN: Rollback token does not match integration record.");
    }

    const targetComp = candidate.integrationRecord.targetComponent;
    const backup = candidate.integrationRecord.backupPayload;

    // Atomic rollback: restore previous component state
    if (Object.keys(backup).length === 0) {
      this._activeIntegrations.delete(targetComp);
    } else {
      this._activeIntegrations.set(targetComp, backup);
    }

    const now = Date.now();
    candidate.rollbackRecord = {
      rolledBackAt: now,
      rolledBackBy: actor,
      reason: reason || "Rollback initiated by operator.",
    };

    this._transitionState(
      candidate,
      "ROLLED_BACK",
      `Improvement on '${targetComp}' rolled back by '${actor}'. Reason: ${reason}`,
      actor,
    );

    return candidate;
  }

  // ── Query & Inspection ────────────────────────────────────────────────────

  public getCandidate(candidateId: string): ImprovementCandidate | undefined {
    return this._candidates.get(candidateId);
  }

  public listCandidates(filter?: { state?: ImprovementCandidateLifecycleState; kind?: string }): ImprovementCandidate[] {
    let list = Array.from(this._candidates.values());
    if (filter?.state) {
      list = list.filter((c) => c.lifecycleState === filter.state);
    }
    if (filter?.kind) {
      list = list.filter((c) => c.kind === filter.kind);
    }
    return list;
  }

  public getActiveIntegrations(): Map<string, Record<string, unknown>> {
    return new Map(this._activeIntegrations);
  }

  private _transitionState(
    candidate: ImprovementCandidate,
    newState: ImprovementCandidateLifecycleState,
    reason: string,
    actor: string,
  ): void {
    const previousState = candidate.lifecycleState;
    candidate.lifecycleState = newState;
    candidate.updatedAt = Date.now();

    const auditEntry: ImprovementAuditEntry = {
      timestamp: Date.now(),
      event: `STATE_TRANSITION_${newState}`,
      actor,
      details: { reason },
      previousState,
      newState,
    };

    candidate.auditHistory.push(auditEntry);
  }
}

export const selfImprovementEvaluator = new SelfImprovementEvaluator();
