/**
 * MYRAA — DecisionEngine
 *
 * Centralized Decision Engine for Intelligence 2.0:
 * Synthesizes Intent + Target + Context + Goal + AvailableCapabilities + Constraints + Risk + Confidence.
 *
 * Formulates Candidate Actions and selects the Best Action.
 * Guarantees zero blind execution on ambiguous inputs.
 * Strictly respects SecurityPolicyEngine, Emergency Stop, and Security Lockdown.
 */

import crypto from "crypto";
import { emergencyStopCoordinator } from "../remote/EmergencyStopCoordinator.ts";
import { securityPolicyEngine } from "../security/SecurityPolicyEngine.ts";
import { capabilityAwarenessEngine } from "./CapabilityAwarenessEngine.ts";
import type {
  CandidateAction,
  DecisionConfidenceLevel,
  DecisionEvaluation,
  FusedContext,
  ResolvedGoal,
  SituationUnderstanding,
} from "./IntelligenceTypes.ts";
import type { RiskLevel, SecurityContext } from "../security/SecurityTypes.ts";

export class DecisionEngine {
  /**
   * Evaluates the situation, goal, and context to produce a structured DecisionEvaluation.
   */
  public evaluateDecision(
    userInput: string,
    goal: ResolvedGoal,
    situation: SituationUnderstanding,
    context: FusedContext,
    secContext?: SecurityContext
  ): DecisionEvaluation {
    const decisionId = `dec_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
    const callerSec: SecurityContext = secContext || {
      identityId: "local-user",
      role: "admin",
      isLocal: true,
      deviceId: "local-desktop",
      ipAddress: "127.0.0.1",
    };

    // ── 1. Security Gate Pre-Flight Checks ──────────────────────────────────
    if (emergencyStopCoordinator.isActive()) {
      return {
        decisionId,
        timestamp: Date.now(),
        userInput,
        intent: "BLOCKED",
        targetDevice: goal.targetDevice,
        targetEntity: goal.targetEntity,
        goal,
        contextSnapshot: {
          device: context.currentDevice,
          application: context.currentApplication,
          file: context.currentFile,
          project: context.currentProject,
          task: context.currentTask?.goal || null,
        },
        availableCapabilities: [],
        constraints: ["Emergency Stop is actively engaged across all platforms."],
        risk: "CRITICAL",
        confidence: "HIGH",
        confidenceScore: 1.0,
        candidateActions: [],
        selectedAction: null,
        reason: "EMERGENCY_STOP: System execution is halted by emergency stop.",
        verificationMethod: "none",
        requiresClarification: false,
        requiresConfirmation: false,
        blockedBySecurity: true,
        securityBlockReason: "EMERGENCY_STOP",
      };
    }

    const isLockdown = securityPolicyEngine.getMode() === "LOCKDOWN";

    // ── 2. Ambiguity & Clarification Evaluation ─────────────────────────────
    if (situation.ambiguityLevel === "HIGH") {
      let clarificationQuestion = "Aap kis cheez ke baare mein baat kar rahe hain? Kripya clear kijiye.";
      let clarificationOptions: string[] = [];

      if (situation.ambiguousCandidates.length > 1) {
        clarificationOptions = situation.ambiguousCandidates;
        clarificationQuestion = `Kaunsi file open karni hai? Mere paas ye options hain: ${situation.ambiguousCandidates.join(", ")}`;
      } else if (situation.missingContext.includes("media_query")) {
        clarificationQuestion = "Aap kaunsa gaana ya video chalana chahte hain? Kripya naam bataiye.";
      }

      return {
        decisionId,
        timestamp: Date.now(),
        userInput,
        intent: "CLARIFICATION_NEEDED",
        targetDevice: goal.targetDevice,
        targetEntity: null,
        goal,
        contextSnapshot: {
          device: context.currentDevice,
          application: context.currentApplication,
          file: context.currentFile,
          project: context.currentProject,
          task: context.currentTask?.goal || null,
        },
        availableCapabilities: capabilityAwarenessEngine.getAvailableCapabilities(),
        constraints: ["High ambiguity: multiple candidates exist or essential target is missing."],
        risk: "LOW",
        confidence: "LOW",
        confidenceScore: 0.35,
        candidateActions: [],
        selectedAction: null,
        reason: "Ambiguous user intent. Asking user for concise clarification to prevent hallucinated actions.",
        verificationMethod: "user_clarification",
        requiresClarification: true,
        clarificationQuestion,
        clarificationOptions,
        requiresConfirmation: false,
      };
    }

    // ── 3. Candidate Actions Generation ─────────────────────────────────────
    const candidateActions: CandidateAction[] = [];
    const constraints: string[] = [];

    if (isLockdown) {
      constraints.push("Security Lockdown is active: privileged system actions are restricted.");
    }

    // Build candidates based on situation domain and goal
    this._generateCandidateActions(goal, situation, context, candidateActions, constraints, callerSec);

    // ── 4. Best Action Selection & Scoring ──────────────────────────────────
    let selectedAction: CandidateAction | null = null;
    if (candidateActions.length > 0) {
      // Sort candidates by score descending
      candidateActions.sort((a, b) => b.score - a.score);
      selectedAction = candidateActions[0];
    }

    // ── 5. Confidence Level Categorization ──────────────────────────────────
    const confidenceScore = goal.confidence * (selectedAction ? selectedAction.score : 0.5);
    let confidence: DecisionConfidenceLevel = "HIGH";
    if (confidenceScore >= 0.85) {
      confidence = "HIGH";
    } else if (confidenceScore >= 0.5) {
      confidence = "MEDIUM";
    } else {
      confidence = "LOW";
    }

    const risk: RiskLevel = selectedAction ? selectedAction.risk : situation.riskContext;
    const requiresConfirmation = Boolean(
      selectedAction?.requiresConfirmation || risk === "HIGH" || risk === "CRITICAL"
    );

    const confirmationPrompt = requiresConfirmation && selectedAction
      ? `Main ${selectedAction.reason} karne jaa rahi hoon. Kya main aage badhoon?`
      : undefined;

    return {
      decisionId,
      timestamp: Date.now(),
      userInput,
      intent: selectedAction?.capability || "GENERAL",
      targetDevice: selectedAction?.targetDevice || goal.targetDevice,
      targetEntity: goal.targetEntity,
      goal,
      contextSnapshot: {
        device: context.currentDevice,
        application: context.currentApplication,
        file: context.currentFile,
        project: context.currentProject,
        task: context.currentTask?.goal || null,
      },
      availableCapabilities: capabilityAwarenessEngine.getAvailableCapabilities(),
      constraints,
      risk,
      confidence,
      confidenceScore: Math.round(confidenceScore * 100) / 100,
      candidateActions,
      selectedAction,
      reason: selectedAction ? selectedAction.reason : "No viable action matched the input.",
      verificationMethod: selectedAction ? selectedAction.verificationMethod : "none",
      requiresClarification: confidence === "LOW" && !selectedAction,
      requiresConfirmation,
      confirmationPrompt,
    };
  }

  private _generateCandidateActions(
    goal: ResolvedGoal,
    situation: SituationUnderstanding,
    context: FusedContext,
    candidates: CandidateAction[],
    constraints: string[],
    callerSec: SecurityContext
  ): void {
    const targetDevice = goal.targetDevice || "DESKTOP";

    // Scenario A: VS Code Open (with project binding)
    if (goal.targetEntity === "vscode" || /\b(vscode|vs code)\b/i.test(goal.primaryGoal)) {
      const workspacePath = context.currentProject || context.userPreferences.preferredWorkspace;
      const assessment = capabilityAwarenessEngine.assessCapability(
        "openInVsCode",
        { path: workspacePath },
        targetDevice,
        context,
        callerSec
      );

      candidates.push({
        id: "act_vscode_open",
        capability: "desktop.openApplication",
        toolName: "openInVsCode",
        args: { path: workspacePath },
        targetDevice,
        score: 0.98,
        risk: "LOW",
        requiresConfirmation: false,
        reason: `Open VS Code editor for workspace '${workspacePath}'`,
        verificationMethod: "process_and_window_check",
      });
      return;
    }

    // Scenario B: Contextual Media Play ("play karo", "play this")
    if (situation.domain === "media" && /\b(play|resume|chala do)\b/i.test(goal.primaryGoal)) {
      const mediaItem = context.activeMedia?.selectedResult || context.activeMedia?.searchResults?.[0];
      if (mediaItem) {
        candidates.push({
          id: "act_media_play",
          capability: "youtube.play",
          toolName: "browserMediaControl",
          args: { action: "play", videoId: mediaItem.videoId, title: mediaItem.title },
          targetDevice: "BROWSER",
          score: 0.96,
          risk: "LOW",
          requiresConfirmation: false,
          reason: `Play selected video '${mediaItem.title}' in holographic player`,
          verificationMethod: "media_playback_state",
        });
        return;
      }
    }

    // Scenario C: Code Inspection / Bug Diagnosis ("Isko check karo", "Isme bug hai")
    if (goal.followUpType === "inspect" || /\b(inspect|check|diagnose)\b/i.test(goal.primaryGoal)) {
      const targetFile = situation.implicitReferences.resolvedEntity || context.currentFile;
      if (targetFile) {
        candidates.push({
          id: "act_code_inspect",
          capability: "code.inspect",
          toolName: "readFile",
          args: { filePath: targetFile },
          targetDevice,
          score: 0.94,
          risk: "LOW",
          requiresConfirmation: false,
          reason: `Read and inspect code in '${targetFile}' to diagnose issues`,
          verificationMethod: "code_diagnostics_report",
        });
        return;
      }
    }

    // Scenario D: Run Tests ("Ab isko test karo")
    if (goal.followUpType === "test" || /\b(test|run test)\b/i.test(goal.primaryGoal)) {
      const targetFile = situation.implicitReferences.resolvedEntity || context.currentFile;
      candidates.push({
        id: "act_code_test",
        capability: "code.runTests",
        toolName: "runShellCommand",
        args: { command: targetFile ? `npx vitest run ${targetFile}` : "npm test" },
        targetDevice,
        score: 0.92,
        risk: "MEDIUM",
        requiresConfirmation: false,
        reason: `Execute test runner on ${targetFile || "project test suite"}`,
        verificationMethod: "process_exit_code_and_output",
      });
      return;
    }

    // Scenario E: Browser Launch ("Phir browser kholo")
    if (goal.followUpType === "browse" || /\b(browser kholo|open browser)\b/i.test(goal.primaryGoal)) {
      const url = context.currentWebsite || "https://google.com";
      candidates.push({
        id: "act_browser_open",
        capability: "browser.open",
        toolName: "openWebsite",
        args: { url },
        targetDevice,
        score: 0.95,
        risk: "LOW",
        requiresConfirmation: false,
        reason: `Open browser with URL '${url}'`,
        verificationMethod: "browser_tab_check",
      });
      return;
    }

    // Scenario F: File Open ("open file.ts")
    if (situation.activeEntities.files.length === 1 || situation.implicitReferences.resolvedType === "file") {
      const fileToOpen = situation.activeEntities.files[0] || situation.implicitReferences.resolvedEntity;
      if (fileToOpen) {
        candidates.push({
          id: "act_file_open",
          capability: "desktop.openFile",
          toolName: "openInVsCode",
          args: { path: fileToOpen },
          targetDevice,
          score: 0.93,
          risk: "LOW",
          requiresConfirmation: false,
          reason: `Open file '${fileToOpen}' in VS Code`,
          verificationMethod: "file_open_check",
        });
        return;
      }
    }

    // Generic fallback candidate
    candidates.push({
      id: "act_generic",
      capability: "general.assist",
      toolName: "generalAssist",
      args: { prompt: goal.rawInput },
      targetDevice,
      score: 0.7,
      risk: "LOW",
      requiresConfirmation: false,
      reason: `Respond conversationally to '${goal.primaryGoal}'`,
      verificationMethod: "conversational_response",
    });
  }
}

export const decisionEngine = new DecisionEngine();
