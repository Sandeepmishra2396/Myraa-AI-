/**
 * MYRAA — CrossDeviceHandoffManager (Phase 25)
 *
 * Central Cross-Device Handoff Manager:
 *   • Allows seamless transfer of conversations, tasks, workflows, and context
 *     between Desktop and Android.
 *   • Cryptographically secure single-use tokens (handoff_tok_..., default 10m TTL).
 *   • Single-use acceptance and replay protection.
 *   • Zero automatic execution of HIGH or CRITICAL actions upon resumption.
 *   • Canonical memory references only (Phase 24 shared memory is never duplicated).
 *   • Full DLP and secret screening (rejects API keys, tokens, passwords, OTPs, cards).
 *   • Fail-closed under Emergency Stop and Security Policy Lockdown.
 *   • Audit logging of every lifecycle transition through SecurityAuditLogger.
 */

import crypto from "crypto";
import type { SecurityContext } from "../security/SecurityTypes.ts";
import { emergencyStopCoordinator } from "../remote/EmergencyStopCoordinator.ts";
import { securityPolicyEngine } from "../security/SecurityPolicyEngine.ts";
import { securityAuditLogger } from "../security/SecurityAuditLogger.ts";
import { remoteSessionManager } from "../remote/RemoteSessionManager.ts";
import type { IHandoffStore } from "./HandoffStore.ts";
import { defaultHandoffStore } from "./HandoffStore.ts";
import type {
  HandoffSnapshot,
  CreateHandoffRequest,
  AcceptHandoffRequest,
  ResumeHandoffRequest,
  HandoffListFilter,
  HandoffOperationResult,
  HandoffPendingAction,
} from "./HandoffTypes.ts";

// ── DLP & Secret Detection Patterns ─────────────────────────────────────────

export const SENSITIVE_CREDENTIAL_PATTERNS: RegExp[] = [
  /\b(?:sora_dev_|myraa_at_)[0-9A-Za-z_\-]{16,}\b/i,
  /\bAIza[0-9A-Za-z_\-]{20,}\b/,
  /\bsk-[0-9A-Za-z_\-]{20,}\b/,
  /\bBearer\s+[A-Za-z0-9\-_.~+/]+=*\b/i,
  /-----BEGIN(?:\s+[A-Z]+)?\s+PRIVATE KEY-----/,
  /\b(?:password|passwd|pwd|secret)\s*[:=]\s*[^\s,;]{6,}\b/i,
  /\b(?:\d{4}[- ]?){3}\d{4}\b/, // 16-digit credit card pattern
  /\b(?:otp(?:\s+code)?|one[- ]time[- ]password|verification(?:\s*code)?|auth(?:\s*code)?|pin)\s*(?:is|:|=)?\s*\d{4,8}\b/i,
];

/**
 * Returns true if text contains no secrets, credentials, or sensitive tokens.
 */
export function isDlpClean(content: string): boolean {
  if (!content || typeof content !== "string") return true;
  for (const pattern of SENSITIVE_CREDENTIAL_PATTERNS) {
    if (pattern.test(content)) return false;
  }
  return true;
}

export type HandoffEventListener = (event: {
  action: "create" | "accept" | "resume" | "cancel" | "expire";
  handoffId: string;
  sourceDeviceId: string;
  targetDeviceId?: string;
  snapshot: HandoffSnapshot;
}) => void;

export class CrossDeviceHandoffManager {
  private store: IHandoffStore;
  private _listeners: Set<HandoffEventListener> = new Set();
  private _acceptedTokens: Set<string> = new Set(); // Replay protection cache

  constructor(store: IHandoffStore = defaultHandoffStore) {
    this.store = store;
  }

  /**
   * Reset store and in-memory caches for testing.
   */
  async clearCaches(): Promise<void> {
    await this.store.clear();
    this._listeners.clear();
    this._acceptedTokens.clear();
  }

  /**
   * Register a listener for real-time handoff sync events.
   */
  onHandoffEvent(listener: HandoffEventListener): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  // ── Pre-flight Security Gate ───────────────────────────────────────────────

  private _assertSecurityClearance(): void {
    if (emergencyStopCoordinator.isActive()) {
      throw new Error(
        "EMERGENCY_STOP_ACTIVE: Cross-device handoff is blocked. Emergency stop is active.",
      );
    }
    if (securityPolicyEngine.getMode() === "LOCKDOWN") {
      throw new Error(
        "SECURITY_LOCKDOWN_ACTIVE: Cross-device handoff is blocked during Security Lockdown.",
      );
    }
  }

  /**
   * Deeply screens all user-provided strings in CreateHandoffRequest for DLP compliance.
   */
  private _deepDlpScreen(req: CreateHandoffRequest): boolean {
    const textChunks: string[] = [];

    if (req.conversationContext) {
      if (req.conversationContext.lastUserQuery) textChunks.push(req.conversationContext.lastUserQuery);
      if (req.conversationContext.summary) textChunks.push(req.conversationContext.summary);
      if (Array.isArray(req.conversationContext.dialogueHistory)) {
        for (const turn of req.conversationContext.dialogueHistory) {
          if (turn.text) textChunks.push(turn.text);
        }
      }
    }

    if (req.taskPlanState) {
      if (req.taskPlanState.goal) textChunks.push(req.taskPlanState.goal);
      if (req.taskPlanState.currentStepDescription) textChunks.push(req.taskPlanState.currentStepDescription);
      if (Array.isArray(req.taskPlanState.pendingActions)) {
        for (const action of req.taskPlanState.pendingActions) {
          if (action.description) textChunks.push(action.description);
          if (action.toolArgs) textChunks.push(JSON.stringify(action.toolArgs));
        }
      }
    }

    if (req.projectContext) {
      if (req.projectContext.projectName) textChunks.push(req.projectContext.projectName);
      if (req.projectContext.relevantContextSnippet) textChunks.push(req.projectContext.relevantContextSnippet);
    }

    const fullString = textChunks.join(" ");
    return isDlpClean(fullString);
  }

  // ── 1. Create Handoff Snapshot ────────────────────────────────────────────

  /**
   * Create a new secure handoff snapshot with short-lived token.
   */
  async createHandoff(
    req: CreateHandoffRequest,
    secContext?: SecurityContext,
  ): Promise<HandoffOperationResult> {
    this._assertSecurityClearance();

    // DLP Screening
    if (!this._deepDlpScreen(req)) {
      securityAuditLogger.logEvent({
        eventType: "SECURITY_POLICY_VIOLATION",
        actor: {
          identityId: secContext?.identityId || "unknown",
          role: secContext?.role || "standard",
          ipAddress: secContext?.ipAddress,
          deviceId: secContext?.deviceId,
        },
        target: { toolName: "createHandoff" },
        decision: "BLOCK",
        reason: "DLP_SECRET_REJECTED: Secrets, credentials, or API keys detected in handoff payload.",
        riskLevel: "HIGH",
      });

      return {
        success: false,
        error: "DLP_SECRET_REJECTED: Secrets, credentials, or API keys cannot be included in handoff snapshots.",
        errorCode: "DLP_SECRET_REJECTED",
      };
    }

    const sourceDeviceId = secContext?.deviceId || "desktop_local";
    const sourceDeviceType = secContext?.isLocal ? "desktop" : "android";

    const ttlSeconds = Math.min(Math.max(req.ttlSeconds ?? 600, 60), 3600); // 1m - 60m, default 10m
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

    const handoffId = `handoff_${crypto.randomUUID()}`;
    const handoffToken = `handoff_tok_${crypto.randomBytes(24).toString("hex")}`;

    // Ensure sharedMemoryRefs contains only strings (canonical IDs), never full cloned records
    const safeMemoryRefs = Array.isArray(req.sharedMemoryRefs)
      ? req.sharedMemoryRefs.filter((ref): ref is string => typeof ref === "string" && ref.trim().length > 0)
      : [];

    const snapshot: HandoffSnapshot = {
      handoffId,
      handoffToken,
      status: "pending",
      sourceDevice: {
        deviceId: sourceDeviceId,
        deviceType: sourceDeviceType,
        deviceName: sourceDeviceType === "desktop" ? "Desktop Core" : "Android Companion",
      },
      targetDevice: req.targetDevice,
      conversationContext: req.conversationContext,
      taskPlanState: req.taskPlanState,
      projectContext: req.projectContext,
      sharedMemoryRefs: safeMemoryRefs,
      safeUiContext: req.safeUiContext,
      createdAt,
      expiresAt,
      version: 1,
    };

    const all = await this.store.load();
    all.push(snapshot);
    await this.store.save(all);

    securityAuditLogger.logEvent({
      eventType: "SESSION_CREATED",
      actor: {
        identityId: secContext?.identityId || sourceDeviceId,
        role: secContext?.role || "standard",
        ipAddress: secContext?.ipAddress,
        deviceId: sourceDeviceId,
      },
      target: { toolName: "createHandoff" },
      decision: "ALLOW",
      reason: `Cross-device handoff created: ${handoffId} (Target: ${req.targetDevice?.deviceId || "any"})`,
      riskLevel: "MEDIUM",
    });

    this._broadcastSync("create", snapshot);

    return {
      success: true,
      handoff: snapshot,
    };
  }

  // ── 2. List Available Handoffs ────────────────────────────────────────────

  /**
   * List available handoffs for a calling device, automatically pruning expired items.
   */
  async listAvailableHandoffs(
    filter: HandoffListFilter = {},
    secContext?: SecurityContext,
  ): Promise<HandoffSnapshot[]> {
    this._assertSecurityClearance();

    const callerDeviceId = secContext?.deviceId;
    const isLocal = secContext?.isLocal !== false;

    const all = await this.store.load();
    const now = Date.now();
    let updated = false;

    // Prune expired
    for (const h of all) {
      if (h.status === "pending" && new Date(h.expiresAt).getTime() < now) {
        h.status = "expired";
        updated = true;
      }
    }
    if (updated) {
      await this.store.save(all);
    }

    return all.filter((h) => {
      // Status filter
      if (filter.status) {
        if (h.status !== filter.status) return false;
      } else {
        // By default, list pending or accepted handoffs
        if (h.status !== "pending" && h.status !== "accepted") return false;
      }

      // Source device filter
      if (filter.sourceDeviceId && h.sourceDevice.deviceId !== filter.sourceDeviceId) {
        return false;
      }

      // Target device filter: if specific filter provided
      if (filter.targetDeviceId && h.targetDevice?.deviceId && h.targetDevice.deviceId !== filter.targetDeviceId) {
        return false;
      }

      // Access control: caller can see handoff if local operator or matching target/source
      if (!isLocal && callerDeviceId) {
        const isSource = h.sourceDevice.deviceId === callerDeviceId;
        const isTarget = !h.targetDevice?.deviceId || h.targetDevice.deviceId === callerDeviceId;
        const isTargetTypeMatch = !h.targetDevice?.deviceType || h.targetDevice.deviceType === "any" || h.targetDevice.deviceType === "android";
        if (!isSource && !(isTarget && isTargetTypeMatch)) {
          return false;
        }
      }

      return true;
    });
  }

  // ── 3. Get Handoff Details ────────────────────────────────────────────────

  /**
   * Retrieve a single handoff snapshot by ID.
   */
  async getHandoff(
    handoffId: string,
    secContext?: SecurityContext,
  ): Promise<HandoffSnapshot | undefined> {
    this._assertSecurityClearance();

    const all = await this.store.load();
    const handoff = all.find((h) => h.handoffId === handoffId);
    if (!handoff) return undefined;

    // Check expiration
    if (handoff.status === "pending" && new Date(handoff.expiresAt).getTime() < Date.now()) {
      handoff.status = "expired";
      await this.store.save(all);
    }

    // Access control
    if (secContext && !secContext.isLocal && secContext.deviceId) {
      const callerId = secContext.deviceId;
      const isSource = handoff.sourceDevice.deviceId === callerId;
      const isTarget = !handoff.targetDevice?.deviceId || handoff.targetDevice.deviceId === callerId;
      if (!isSource && !isTarget) {
        return undefined; // Hide unauthorized handoffs
      }
    }

    return handoff;
  }

  // ── 4. Accept Handoff (Single-Use Token Validation) ─────────────────────────

  /**
   * Accept a handoff snapshot on the target device. Enforces single-use token consumption.
   */
  async acceptHandoff(
    req: AcceptHandoffRequest,
    secContext?: SecurityContext,
  ): Promise<HandoffOperationResult> {
    this._assertSecurityClearance();

    const all = await this.store.load();
    const handoff = all.find((h) => h.handoffId === req.handoffId);

    if (!handoff) {
      return { success: false, error: `Handoff '${req.handoffId}' not found.`, errorCode: "NOT_FOUND" };
    }

    // Expiration check
    if (new Date(handoff.expiresAt).getTime() < Date.now()) {
      handoff.status = "expired";
      await this.store.save(all);
      return { success: false, error: "EXPIRED: Handoff has expired.", errorCode: "EXPIRED", handoff };
    }

    // Token verification
    if (handoff.handoffToken !== req.handoffToken) {
      securityAuditLogger.logEvent({
        eventType: "SECURITY_POLICY_VIOLATION",
        actor: {
          identityId: secContext?.identityId || "unknown",
          role: secContext?.role || "standard",
          ipAddress: secContext?.ipAddress,
          deviceId: secContext?.deviceId,
        },
        target: { toolName: "acceptHandoff" },
        decision: "BLOCK",
        reason: `INVALID_TOKEN: Token mismatch for handoff ${req.handoffId}.`,
        riskLevel: "HIGH",
      });
      return { success: false, error: "INVALID_TOKEN: Provided handoff token is invalid.", errorCode: "INVALID_TOKEN" };
    }

    // Replay / single-use check
    if (this._acceptedTokens.has(req.handoffToken) || handoff.status === "accepted") {
      return {
        success: false,
        error: "ALREADY_ACCEPTED: Handoff token has already been accepted (single-use constraint).",
        errorCode: "ALREADY_ACCEPTED",
        handoff,
      };
    }

    if (handoff.status === "resumed") {
      return {
        success: false,
        error: "ALREADY_RESUMED: Handoff has already been resumed.",
        errorCode: "ALREADY_RESUMED",
        handoff,
      };
    }

    if (handoff.status === "cancelled") {
      return {
        success: false,
        error: "CANCELLED: Handoff has been cancelled by the source device.",
        errorCode: "CANCELLED",
        handoff,
      };
    }

    // Target device authorization check
    if (secContext && !secContext.isLocal && secContext.deviceId && handoff.targetDevice?.deviceId) {
      if (handoff.targetDevice.deviceId !== secContext.deviceId) {
        return {
          success: false,
          error: `UNAUTHORIZED_DEVICE: This handoff is strictly intended for device '${handoff.targetDevice.deviceId}'.`,
          errorCode: "UNAUTHORIZED_DEVICE",
        };
      }
    }

    // Mark as accepted and record single-use token consumption
    handoff.status = "accepted";
    handoff.acceptedAt = new Date().toISOString();
    handoff.version++;
    this._acceptedTokens.add(req.handoffToken);

    await this.store.save(all);

    securityAuditLogger.logEvent({
      eventType: "TOOL_ALLOW",
      actor: {
        identityId: secContext?.identityId || "target_device",
        role: secContext?.role || "standard",
        ipAddress: secContext?.ipAddress,
        deviceId: secContext?.deviceId,
      },
      target: { toolName: "acceptHandoff" },
      decision: "ALLOW",
      reason: `Handoff ${handoff.handoffId} accepted by device ${secContext?.deviceId || "local"}.`,
      riskLevel: "MEDIUM",
    });

    this._broadcastSync("accept", handoff);

    return {
      success: true,
      handoff,
    };
  }

  // ── 5. Resume Handoff (Workflow Resumption & High-Risk Gating) ─────────────

  /**
   * Resumes an accepted handoff on the target device.
   * CRITICAL INVARIANT: High-risk or destructive actions NEVER execute automatically.
   */
  async resumeHandoff(
    req: ResumeHandoffRequest,
    secContext?: SecurityContext,
  ): Promise<HandoffOperationResult> {
    this._assertSecurityClearance();

    const all = await this.store.load();
    const handoff = all.find((h) => h.handoffId === req.handoffId);

    if (!handoff) {
      return { success: false, error: `Handoff '${req.handoffId}' not found.`, errorCode: "NOT_FOUND" };
    }

    // Expiration check
    if (new Date(handoff.expiresAt).getTime() < Date.now()) {
      handoff.status = "expired";
      await this.store.save(all);
      return { success: false, error: "EXPIRED: Handoff has expired.", errorCode: "EXPIRED", handoff };
    }

    // Token verification
    if (handoff.handoffToken !== req.handoffToken) {
      return { success: false, error: "INVALID_TOKEN: Provided handoff token is invalid.", errorCode: "INVALID_TOKEN" };
    }

    // Target device authorization check
    if (secContext && !secContext.isLocal && secContext.deviceId && handoff.targetDevice?.deviceId) {
      if (handoff.targetDevice.deviceId !== secContext.deviceId) {
        return {
          success: false,
          error: `UNAUTHORIZED_DEVICE: This handoff is strictly intended for device '${handoff.targetDevice.deviceId}'.`,
          errorCode: "UNAUTHORIZED_DEVICE",
        };
      }
    }

    // Duplicate resume prevention / Idempotency
    if (handoff.status === "resumed") {
      return {
        success: true,
        handoff,
        errorCode: undefined,
      };
    }

    if (handoff.status === "cancelled") {
      return {
        success: false,
        error: "CANCELLED: Cannot resume a cancelled handoff.",
        errorCode: "CANCELLED",
        handoff,
      };
    }

    // Analyze pending actions for HIGH or CRITICAL risk
    const pendingActions: HandoffPendingAction[] = handoff.taskPlanState?.pendingActions || [];
    const gatedActions: HandoffPendingAction[] = [];

    for (const action of pendingActions) {
      if (
        action.isDestructive ||
        action.checkpointRequired ||
        action.riskLevel === "HIGH" ||
        action.riskLevel === "CRITICAL"
      ) {
        gatedActions.push(action);
      }
    }

    const requiresConfirmation = gatedActions.length > 0;

    // Transition to resumed
    handoff.status = "resumed";
    handoff.resumedAt = new Date().toISOString();
    handoff.version++;

    await this.store.save(all);

    securityAuditLogger.logEvent({
      eventType: "TOOL_ALLOW",
      actor: {
        identityId: secContext?.identityId || "target_device",
        role: secContext?.role || "standard",
        ipAddress: secContext?.ipAddress,
        deviceId: secContext?.deviceId,
      },
      target: { toolName: "resumeHandoff" },
      decision: "ALLOW",
      reason: `Handoff ${handoff.handoffId} resumed. Gated actions: ${gatedActions.length}`,
      riskLevel: requiresConfirmation ? "HIGH" : "MEDIUM",
    });

    this._broadcastSync("resume", handoff);

    return {
      success: true,
      handoff,
      requiresConfirmation,
      gatedActions: requiresConfirmation ? gatedActions : undefined,
    };
  }

  // ── 6. Cancel / Revoke Handoff ─────────────────────────────────────────────

  /**
   * Cancel or revoke a pending or accepted handoff before resumption.
   */
  async cancelHandoff(
    handoffId: string,
    secContext?: SecurityContext,
  ): Promise<HandoffOperationResult> {
    this._assertSecurityClearance();

    const all = await this.store.load();
    const handoff = all.find((h) => h.handoffId === handoffId);

    if (!handoff) {
      return { success: false, error: `Handoff '${handoffId}' not found.`, errorCode: "NOT_FOUND" };
    }

    // Access control: only source device or local administrator can cancel
    if (secContext && !secContext.isLocal && secContext.deviceId) {
      if (handoff.sourceDevice.deviceId !== secContext.deviceId) {
        return {
          success: false,
          error: "UNAUTHORIZED_DEVICE: Only the initiating device or admin can cancel this handoff.",
          errorCode: "UNAUTHORIZED_DEVICE",
        };
      }
    }

    if (handoff.status === "resumed") {
      return {
        success: false,
        error: "ALREADY_RESUMED: Cannot cancel a handoff that has already been resumed.",
        errorCode: "ALREADY_RESUMED",
        handoff,
      };
    }

    handoff.status = "cancelled";
    handoff.cancelledAt = new Date().toISOString();
    handoff.version++;

    await this.store.save(all);

    securityAuditLogger.logEvent({
      eventType: "SESSION_REVOKED",
      actor: {
        identityId: secContext?.identityId || "operator",
        role: secContext?.role || "standard",
        ipAddress: secContext?.ipAddress,
        deviceId: secContext?.deviceId,
      },
      target: { toolName: "cancelHandoff" },
      decision: "ALLOW",
      reason: `Handoff ${handoffId} cancelled.`,
      riskLevel: "MEDIUM",
    });

    this._broadcastSync("cancel", handoff);

    return {
      success: true,
      handoff,
    };
  }

  // ── 7. Conflict / Stale State Detection ───────────────────────────────────

  /**
   * Deterministically evaluates whether a handoff's task state is stale compared to the current plan.
   */
  detectStaleState(
    handoff: HandoffSnapshot,
    currentSourcePlan?: { id?: string; version?: number; status?: string; activeStepId?: string },
  ): { isStale: boolean; reason?: string } {
    if (!currentSourcePlan) return { isStale: false };

    if (handoff.taskPlanState?.planId && currentSourcePlan.id && handoff.taskPlanState.planId !== currentSourcePlan.id) {
      return { isStale: true, reason: "Source plan ID no longer matches handoff snapshot plan." };
    }

    if (currentSourcePlan.status === "completed" || currentSourcePlan.status === "cancelled") {
      return {
        isStale: true,
        reason: `Source plan has already finished with status '${currentSourcePlan.status}'.`,
      };
    }

    return { isStale: false };
  }

  // ── 8. Real-time Broadcasting ─────────────────────────────────────────────

  private _broadcastSync(
    action: "create" | "accept" | "resume" | "cancel" | "expire",
    snapshot: HandoffSnapshot,
  ): void {
    // Notify in-process listeners
    for (const listener of this._listeners) {
      try {
        listener({
          action,
          handoffId: snapshot.handoffId,
          sourceDeviceId: snapshot.sourceDevice.deviceId,
          targetDeviceId: snapshot.targetDevice?.deviceId,
          snapshot,
        });
      } catch (err) {
        console.warn("[CrossDeviceHandoffManager] Error in listener callback:", err);
      }
    }

    // Broadcast WebSocket message to connected remote devices
    try {
      remoteSessionManager.broadcastToAllSessions({
        type: "handoff_notification",
        action,
        handoffId: snapshot.handoffId,
        sourceDevice: snapshot.sourceDevice,
        targetDevice: snapshot.targetDevice,
        status: snapshot.status,
        timestamp: Date.now(),
      });
    } catch {
      // Remote session manager might not be initialized in isolated unit test
    }
  }
}

export const crossDeviceHandoffManager = new CrossDeviceHandoffManager();
