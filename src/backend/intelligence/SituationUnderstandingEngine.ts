/**
 * MYRAA — SituationUnderstandingEngine
 *
 * Performs deep semantic situation understanding:
 *   1. Deictic / Anaphoric reference resolution ("isko", "isme", "ye wala", "this file", "that", "play karo")
 *   2. Active entity binding across files, applications, media items, and tasks
 *   3. Ambiguity detection (HIGH ambiguity when multiple candidates exist with no focus)
 *   4. Domain classification ("code", "media", "web", "desktop", "system", "task", "general")
 */

import { ContextPriority, type FusedContext, type SituationUnderstanding } from "./IntelligenceTypes.ts";
import type { RiskLevel } from "../security/SecurityTypes.ts";

export class SituationUnderstandingEngine {
  /**
   * Evaluates the current situation given raw user input and fused context.
   */
  public analyzeSituation(userInput: string, context: FusedContext): SituationUnderstanding {
    const raw = (userInput || "").trim();
    const lower = raw.toLowerCase();

    // 1. Domain Detection
    const domain = this._detectDomain(lower, context);

    // 2. Identify active entities in context and utterance
    const activeEntities = this._extractActiveEntities(raw, context);

    // 3. Pronoun / Deictic Reference Resolution ("isko", "isme", "ye wala", "play karo", etc.)
    const implicitReferences = this._resolveImplicitReferences(lower, context, activeEntities);

    // 4. Ambiguity Detection
    const { ambiguityLevel, ambiguousCandidates, missingContext } = this._detectAmbiguity(
      lower,
      context,
      implicitReferences,
      activeEntities
    );

    // 5. Risk Context
    const riskContext = this._determineRiskContext(lower, domain, context);

    return {
      domain,
      activeEntities,
      implicitReferences,
      ambiguityLevel,
      ambiguousCandidates,
      missingContext,
      riskContext,
    };
  }

  private _detectDomain(lower: string, context: FusedContext): SituationUnderstanding["domain"] {
    if (
      /\b(play|song|gaana|music|video|youtube|pause|resume|next song|volume|sound|chala do)\b/i.test(lower) ||
      context.activeMedia?.status === "playing"
    ) {
      return "media";
    }

    if (
      /\b(app|application|window|notepad|calculator|terminal|powershell|cmd|task manager|taskmanager|file manager|filemanager|file explorer|explorer|paint|settings|close window|minimize)\b/i.test(
        lower
      )
    ) {
      return "desktop";
    }

    if (
      /\b(code|bug|error|test|syntax|function|script|compile|debug|inspect|review|refactor|vs code|vscode|editor|python|ts|js)\b/i.test(
        lower
      ) ||
      (/\bfile\b/i.test(lower) && !/\b(file manager|filemanager|file explorer)\b/i.test(lower)) ||
      Boolean(context.currentFile) ||
      Boolean(context.currentTask)
    ) {
      return "code";
    }

    if (/\b(browser|google|website|search|url|link|page|chrome|web|open site)\b/i.test(lower)) {
      return "web";
    }

    if (/\b(shutdown|restart|reboot|lock|power|battery|cpu|ram|temp|gpu|kill)\b/i.test(lower)) {
      return "system";
    }

    return "general";
  }

  private _extractActiveEntities(raw: string, context: FusedContext): SituationUnderstanding["activeEntities"] {
    const files: string[] = [];
    const apps: string[] = [];
    const urls: string[] = [];
    const queries: string[] = [];

    // Context entities
    if (context.currentFile) files.push(context.currentFile);
    if (context.currentTask?.relevantEntities?.files) {
      for (const f of context.currentTask.relevantEntities.files) {
        if (!files.includes(f)) files.push(f);
      }
    }

    if (context.currentApplication) apps.push(context.currentApplication);
    if (context.currentWebsite) urls.push(context.currentWebsite);

    // Extract file mentions from user utterance
    const fileMatches = raw.match(/[\w.-]+\.(ts|tsx|js|jsx|py|json|md|html|css|txt|log|yaml|yml)/gi);
    if (fileMatches) {
      for (const f of fileMatches) {
        if (!files.includes(f)) files.unshift(f); // Explicit instruction gets top position
      }
    }

    // Extract URL mentions
    const urlMatches = raw.match(/https?:\/\/[^\s]+/gi);
    if (urlMatches) {
      for (const u of urlMatches) {
        if (!urls.includes(u)) urls.unshift(u);
      }
    }

    // Extract App mentions
    if (/\b(vs code|vscode|code)\b/i.test(raw)) apps.unshift("vscode");
    if (/\b(file manager|filemanager|file explorer|windows explorer|explorer|files|this pc|my computer)\b/i.test(raw))
      apps.unshift("explorer");
    if (/\b(notepad)\b/i.test(raw)) apps.unshift("notepad");
    if (/\b(chrome|google chrome)\b/i.test(raw)) apps.unshift("chrome");
    if (/\b(edge|ms edge|microsoft edge|msedge)\b/i.test(raw)) apps.unshift("edge");
    if (/\b(cursor)\b/i.test(raw)) apps.unshift("cursor");
    if (/\b(calculator|calc)\b/i.test(raw)) apps.unshift("calculator");
    if (/\b(task manager|taskmanager|taskmgr)\b/i.test(raw)) apps.unshift("task manager");
    if (/\b(terminal|powershell|wt)\b/i.test(raw)) apps.unshift("powershell");
    if (/\b(cmd|command prompt)\b/i.test(raw)) apps.unshift("cmd");
    if (/\b(paint|mspaint)\b/i.test(raw)) apps.unshift("paint");
    if (/\b(settings|system settings)\b/i.test(raw)) apps.unshift("settings");

    return {
      files,
      apps,
      urls,
      queries,
      selectedMedia: context.activeMedia?.selectedResult || context.activeMedia?.searchResults?.[0] || null,
      focusedEntity: files[0] || apps[0] || urls[0] || null,
    };
  }

  private _resolveImplicitReferences(
    lower: string,
    context: FusedContext,
    entities: SituationUnderstanding["activeEntities"]
  ): SituationUnderstanding["implicitReferences"] {
    const deicticRegex = /\b(isko|isme|isse|ye|yeh|ye wala|yeh wala|this|it|that|this one|that one|the file|the code|the result)\b/i;
    const hasDeicticReference = deicticRegex.test(lower);
    const match = lower.match(deicticRegex);
    const rawPronoun = match ? match[1] : undefined;

    // Special Case: "play karo", "isko play karo", "play that one" -> binds to media search result
    if (/\b(play|chala do|chalao|play karo)\b/i.test(lower) && context.activeMedia?.searchResults && context.activeMedia.searchResults.length > 0) {
      const selected = context.activeMedia.selectedResult || context.activeMedia.searchResults[0];
      return {
        hasDeicticReference: true,
        rawPronoun: rawPronoun || "play",
        resolvedEntity: selected.title,
        resolvedType: "media",
        sourcePriority: ContextPriority.CURRENT_TASK_CONTEXT,
        confidence: 0.95,
      };
    }

    if (!hasDeicticReference) {
      return {
        hasDeicticReference: false,
        resolvedEntity: null,
        resolvedType: null,
        sourcePriority: ContextPriority.EXPLICIT_CURRENT_INSTRUCTION,
        confidence: 1.0,
      };
    }

    // Reference Resolution Ladder:
    // 1. Current File / Code
    if (entities.files.length === 1 || context.currentFile) {
      const resolved = context.currentFile || entities.files[0];
      return {
        hasDeicticReference: true,
        rawPronoun,
        resolvedEntity: resolved,
        resolvedType: "file",
        sourcePriority: ContextPriority.CURRENT_APPLICATION_FILE_PROJECT,
        confidence: 0.92,
      };
    }

    // 2. Active Task target
    if (context.currentTask?.relevantEntities?.files?.[0]) {
      return {
        hasDeicticReference: true,
        rawPronoun,
        resolvedEntity: context.currentTask.relevantEntities.files[0],
        resolvedType: "file",
        sourcePriority: ContextPriority.CURRENT_TASK_CONTEXT,
        confidence: 0.88,
      };
    }

    // 3. Current Application
    if (entities.apps.length > 0 || context.currentApplication) {
      const app = context.currentApplication || entities.apps[0];
      return {
        hasDeicticReference: true,
        rawPronoun,
        resolvedEntity: app,
        resolvedType: "app",
        sourcePriority: ContextPriority.CURRENT_APPLICATION_FILE_PROJECT,
        confidence: 0.85,
      };
    }

    // 4. Current Project
    if (context.currentProject) {
      return {
        hasDeicticReference: true,
        rawPronoun,
        resolvedEntity: context.currentProject,
        resolvedType: "project",
        sourcePriority: ContextPriority.CURRENT_APPLICATION_FILE_PROJECT,
        confidence: 0.8,
      };
    }

    return {
      hasDeicticReference: true,
      rawPronoun,
      resolvedEntity: null,
      resolvedType: null,
      sourcePriority: ContextPriority.RECENT_CONVERSATION,
      confidence: 0.4,
    };
  }

  private _detectAmbiguity(
    lower: string,
    context: FusedContext,
    implicit: SituationUnderstanding["implicitReferences"],
    entities: SituationUnderstanding["activeEntities"]
  ): {
    ambiguityLevel: "NONE" | "LOW" | "MEDIUM" | "HIGH";
    ambiguousCandidates: string[];
    missingContext: string[];
  } {
    const ambiguousCandidates: string[] = [];
    const missingContext: string[] = [];

    // Ambiguity Case 1: "open that file" / "file kholo" with multiple files and no clear current file
    const asksForFile = /\b(file kholo|open that file|open the file|wo file kholo)\b/i.test(lower);
    if (asksForFile && !context.currentFile && entities.files.length > 1) {
      return {
        ambiguityLevel: "HIGH",
        ambiguousCandidates: [...entities.files],
        missingContext: ["file_selection"],
      };
    }

    // Ambiguity Case 2: Deictic reference used ("isko", "isme") but cannot be resolved to any file/app/task
    if (implicit.hasDeicticReference && !implicit.resolvedEntity && !context.currentFile && !context.currentApplication) {
      return {
        ambiguityLevel: "HIGH",
        ambiguousCandidates: [],
        missingContext: ["target_entity"],
      };
    }

    // Ambiguity Case 3: "Play karo" when no media was searched or playing
    if (/\b(play karo|play this|chala do)\b/i.test(lower) && (!context.activeMedia || (context.activeMedia.searchResults?.length ?? 0) === 0)) {
      missingContext.push("media_query");
      return {
        ambiguityLevel: "MEDIUM",
        ambiguousCandidates: [],
        missingContext,
      };
    }

    return {
      ambiguityLevel: "NONE",
      ambiguousCandidates,
      missingContext,
    };
  }

  private _determineRiskContext(lower: string, domain: string, context: FusedContext): RiskLevel {
    if (/\b(delete|remove|destroy|kill|rmdir|rm -rf|drop database|format|shutdown|restart)\b/i.test(lower)) {
      return "CRITICAL";
    }
    if (/\b(modify|change|edit|overwrite|update code|patch|write|install|pip install|npm install)\b/i.test(lower)) {
      return "HIGH";
    }
    if (/\b(open|launch|kholo|chalao|play|read|search|inspect|test|check|verify|list|status)\b/i.test(lower)) {
      return "LOW";
    }
    return "LOW";
  }
}

export const situationUnderstandingEngine = new SituationUnderstandingEngine();
