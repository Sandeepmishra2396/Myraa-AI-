/**
 * MYRAA — GoalResolver
 *
 * Identifies the high-level goal, sub-goals, and follow-up intent from user utterance
 * and situation understanding.
 */

import crypto from "crypto";
import type { FusedContext, ResolvedGoal, SituationUnderstanding } from "./IntelligenceTypes.ts";
import type { TargetDevice } from "../orchestrator/OrchestratorTypes.ts";

export class GoalResolver {
  /**
   * Resolves structured goal from user input, situation understanding, and fused context.
   */
  public resolveGoal(
    userInput: string,
    situation: SituationUnderstanding,
    context: FusedContext
  ): ResolvedGoal {
    const raw = (userInput || "").trim();
    const lower = raw.toLowerCase();
    const goalId = `goal_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;

    let primaryGoal = "";
    const subGoals: string[] = [];
    let expectedOutcome = "";
    let isImplicit = false;
    let isFollowUp = false;
    let followUpType: ResolvedGoal["followUpType"] = null;
    let confidence = 0.9;
    let targetEntity: string | null = situation.implicitReferences.resolvedEntity || situation.activeEntities.focusedEntity || null;
    let targetDevice: TargetDevice = context.currentDevice || "DESKTOP";

    // 1. Follow-up Command Detection
    if (/\b(ab isko test karo|test karo|run tests?|isko test karo)\b/i.test(lower)) {
      isFollowUp = true;
      followUpType = "test";
      primaryGoal = `Run test suite on active file/code (${targetEntity || "current project"})`;
      expectedOutcome = "Verification of test execution output and status";
      confidence = targetEntity ? 0.95 : 0.7;
    } else if (/\b(phir browser kholo|browser kholo|open browser)\b/i.test(lower)) {
      isFollowUp = true;
      followUpType = "browse";
      primaryGoal = "Launch browser with active URL or default home page";
      expectedOutcome = "Browser application running and visible";
      targetDevice = "DESKTOP";
      confidence = 0.92;
    } else if (/\b(isme kya problem hai|kya issue hai|isme bug hai|check karo|dekhna)\b/i.test(lower)) {
      isFollowUp = true;
      followUpType = "inspect";
      primaryGoal = `Inspect and diagnose issues in ${targetEntity || "active code/file"}`;
      subGoals.push("Scan code for syntax errors and logic bugs");
      subGoals.push("Explain diagnostics to user before modifying");
      expectedOutcome = "Code diagnostics report and proposed fix";
      confidence = targetEntity ? 0.92 : 0.65;
    } else if (/\b(ye wala use karo|use this one|select this)\b/i.test(lower)) {
      isFollowUp = true;
      followUpType = "select";
      primaryGoal = `Select candidate entity '${targetEntity || "active selection"}'`;
      expectedOutcome = "Entity selected for subsequent workflow step";
      confidence = 0.9;
    } else if (/\b(ab run karo|run karo|execute karo|chala do)\b/i.test(lower) && situation.domain === "code") {
      isFollowUp = true;
      followUpType = "run";
      primaryGoal = `Execute script / code for '${targetEntity || "active project"}'`;
      expectedOutcome = "Process execution output captured and verified";
      confidence = targetEntity ? 0.93 : 0.7;
    }
    // 2. Media Intent: "Play karo", "Pause karo", "Next", "Search"
    else if (/\b(play karo|play|chala do|resume karo)\b/i.test(lower) && situation.domain === "media") {
      primaryGoal = `Play selected media item '${situation.implicitReferences.resolvedEntity || "active media"}'`;
      expectedOutcome = "Audio/video player starts playback";
      confidence = situation.implicitReferences.resolvedEntity || context.activeMedia ? 0.96 : 0.6;
    } else if (/\b(pause karo|pause|ruko)\b/i.test(lower) && situation.domain === "media") {
      primaryGoal = "Pause active media playback";
      expectedOutcome = "Media playback paused";
      confidence = 0.95;
    }
    // 3. Application Open: "Bhai VS Code kholo", "File Manager kholo", "Notepad kholo"
    else if (/\b(vs code|vscode|code editor)\b/i.test(lower) && /\b(kholo|open|launch|start)\b/i.test(lower)) {
      targetEntity = "vscode";
      primaryGoal = `Open VS Code editor${context.currentProject ? ` in workspace '${context.currentProject}'` : ""}`;
      expectedOutcome = "VS Code editor window open and focused";
      confidence = 0.98;
    } else if (
      /\b(file manager|filemanager|file explorer|explorer|files|this pc|my computer)\b/i.test(lower) &&
      /\b(kholo|open|launch|start)\b/i.test(lower)
    ) {
      targetEntity = "explorer";
      primaryGoal = "Open Windows File Explorer";
      expectedOutcome = "File Explorer window open and focused";
      confidence = 0.98;
    } else if (/\b(kholo|open|launch)\b/i.test(lower) && situation.activeEntities.apps.length > 0) {
      const app = situation.activeEntities.apps[0];
      targetEntity = app;
      primaryGoal = `Open application '${app}'`;
      expectedOutcome = `Application '${app}' running`;
      confidence = 0.95;
    }
    // 4. File Open / Check: "Isko check karo", "open file.ts"
    else if (/\b(check karo|dekho|inspect)\b/i.test(lower)) {
      isImplicit = situation.implicitReferences.hasDeicticReference;
      primaryGoal = `Inspect and verify '${targetEntity || "current context"}'`;
      expectedOutcome = "Inspection diagnostics report provided";
      confidence = targetEntity ? 0.9 : 0.55;
    } else {
      primaryGoal = raw;
      expectedOutcome = "Command executed successfully";
      confidence = 0.8;
    }

    // Degrade confidence if situation is highly ambiguous
    if (situation.ambiguityLevel === "HIGH") {
      confidence = Math.min(confidence, 0.45);
    } else if (situation.ambiguityLevel === "LOW") {
      confidence = Math.min(confidence, 0.75);
    }

    return {
      goalId,
      rawInput: raw,
      primaryGoal,
      subGoals,
      expectedOutcome,
      isImplicit,
      referenceResolved: Boolean(targetEntity),
      targetEntity,
      targetDevice,
      confidence,
      isFollowUp,
      followUpType,
    };
  }
}

export const goalResolver = new GoalResolver();
