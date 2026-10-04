/**
 * MYRAA — Phase 22: Multi-Agent Brain
 * MultiAgentTypes
 *
 * Core type system for the secure, coordinated multi-agent architecture:
 *   PLANNER ── RESEARCHER ── CODER ── CRITIC ── EXECUTOR ── VERIFIER
 * Sits under the authoritative, non-agent Security Policy & Risk Gate.
 */

import type { RiskLevel } from "../security/SecurityTypes.ts";
import type { TargetDevice } from "../orchestrator/OrchestratorTypes.ts";

// ---------------------------------------------------------------------------
// 1. Roles & Lifecycle Statuses
// ---------------------------------------------------------------------------

export type AgentRole =
  | "planner"
  | "researcher"
  | "coder"
  | "critic"
  | "executor"
  | "verifier";

export type AgentStatus =
  | "PENDING"
  | "RUNNING"
  | "SUCCESS"
  | "FAILED"
  | "REJECTED"
  | "NEEDS_REVISION"
  | "BLOCKED"
  | "CANCELLED";

export type AgentConfidence = "HIGH" | "MEDIUM" | "LOW";

// ---------------------------------------------------------------------------
// 2. Structured Agent Message & Result Protocol (Principle 13: Structured Results)
// ---------------------------------------------------------------------------

export interface AgentMessage {
  messageId: string;
  fromAgent: AgentRole | "user" | "orchestrator";
  toAgent: AgentRole | "orchestrator" | "user";
  content: string;
  payload?: Record<string, unknown>;
  timestamp: number;
}

export interface MultiAgentProposedAction {
  id: string;
  capability: string;
  toolName: string;
  args: Record<string, unknown>;
  summary: string;
  isStateChanging: boolean;
  riskLevel: RiskLevel;
  targetDevice: TargetDevice;
  proposedPatch?: string;
}

export interface AgentResult<T = unknown> {
  agentId: AgentRole;
  taskId: string;
  timestamp: number;
  inputContext: Record<string, unknown>;
  objective: string;
  result: T;
  evidence: string[];
  confidence: AgentConfidence;
  confidenceScore: number; // 0.0 - 1.0
  riskLevel: RiskLevel;
  proposedActions: MultiAgentProposedAction[];
  dependencies: string[];
  status: AgentStatus;
  provenance: Record<string, unknown>;
  error?: string;
}

// ---------------------------------------------------------------------------
// 3. Subtasks & Execution Plan
// ---------------------------------------------------------------------------

export interface MultiAgentSubtask {
  id: string;
  description: string;
  assignedAgent: AgentRole;
  dependencies: string[];
  status: AgentStatus;
  expectedOutcome: string;
  isStateChanging: boolean;
  action?: MultiAgentProposedAction;
  result?: AgentResult;
}

export interface MultiAgentExecutionPlan {
  planId: string;
  goal: string;
  subtasks: MultiAgentSubtask[];
  requiredAgents: AgentRole[];
  revisionCount: number;
  isCriticApproved: boolean;
  requiresUserApproval: boolean;
  riskLevel: RiskLevel;
  explanation: string;
}

// ---------------------------------------------------------------------------
// 4. Critic Evaluation Model
// ---------------------------------------------------------------------------

export type CriticVerdict = "APPROVED" | "REJECTED" | "NEEDS_REVISION";

export interface CriticEvaluation {
  verdict: CriticVerdict;
  reasons: string[];
  critique: string;
  missingSteps: string[];
  securityConcerns: string[];
  unsupportedConclusions: string[];
  suggestedRevisions: string[];
}

// ---------------------------------------------------------------------------
// 5. Orchestration Request & Result Models
// ---------------------------------------------------------------------------

export interface MultiAgentOrchestrationRequest {
  goal: string;
  contextId?: string;
  project?: string | null;
  file?: string | null;
  userApprovalGranted?: boolean;
  timeoutMs?: number;
  maxRevisionCycles?: number;
}

export interface SanitizedAgentTrace {
  traceId: string;
  step: number;
  agentId: AgentRole | "security" | "orchestrator";
  action: string;
  status: AgentStatus | "OK" | "BLOCKED";
  sanitizedSummary: string;
  timestamp: number;
  executionMs?: number;
}

export interface MultiAgentOrchestrationResult {
  orchestrationId: string;
  goal: string;
  status: "COMPLETED" | "PARTIAL_SUCCESS" | "BLOCKED" | "CANCELLED" | "FAILED";
  agentResults: Partial<Record<AgentRole, AgentResult>>;
  finalAnswer: string;
  executedActions: string[];
  verificationEvidence: string[];
  criticVerdict: CriticVerdict;
  executionTimeMs: number;
  traces: SanitizedAgentTrace[];
  requiresUserApproval: boolean;
  approvalPrompt?: string;
  blockReason?: string;
}

// ---------------------------------------------------------------------------
// 6. Invariant Constants
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_REVISION_CYCLES = 3;
export const DEFAULT_MAX_AGENT_CALLS = 15;
export const DEFAULT_MAX_EXECUTION_TIME_MS = 30_000; // 30s timeout
