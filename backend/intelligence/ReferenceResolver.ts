/**
 * MYRAA — Phase 19: Advanced Context Fusion Engine
 * Reference Resolver
 *
 * Resolves deictic, anaphoric, and pronoun references across Hindi, Hinglish, and English:
 *   - "isko", "isme", "isse", "iske andar", "ye", "yeh", "ye wala", "idhar", "ispe"
 *   - "this", "it", "that", "this one", "that one", "this file", "this code"
 *
 * Implements Multi-Turn Entity Tracking and Strict Ambiguity Gates:
 *   - Binds to active file, active code, active task, active application, or active browser page.
 *   - Stale context is rejected so outdated files are never mistakenly targeted.
 *   - When multiple candidates exist with no single focus: marks isAmbiguous=true,
 *     constructs clarification questions, and NEVER GUESSES.
 */

import type { FusedContext, ResolvedReference } from "./IntelligenceTypes.ts";
import { contextFreshnessManager, ContextFreshnessManager } from "./ContextFreshnessManager.ts";
import { contextConfidenceEngine, ContextConfidenceEngine } from "./ContextConfidenceEngine.ts";

export class ReferenceResolver {
  private _freshness: ContextFreshnessManager;
  private _confidence: ContextConfidenceEngine;

  constructor(freshness = contextFreshnessManager, confidence = contextConfidenceEngine) {
    this._freshness = freshness;
    this._confidence = confidence;
  }

  /**
   * Resolves references in a user utterance against the unified context.
   */
  public resolveReference(userInput: string, context: FusedContext, now = Date.now()): ResolvedReference {
    const raw = (userInput || "").trim();
    const lower = raw.toLowerCase();

    // 1. Detect deictic pronouns (compound phrases must precede single words)
    const deicticPattern =
      /\b(iske andar|ye wala|yeh wala|this one|that one|the current window|the file|the code|this app|isko|isme|isse|ispe|yeh|ye|idhar|this|it|that)\b/i;
    const match = lower.match(deicticPattern);
    const hasDeictic = Boolean(match);
    const rawPronoun = match ? match[1] : "";

    // 2. Check for explicit file / app / url mentions directly in utterance
    const explicitFile = this._extractExplicitFile(raw);
    const explicitApp = this._extractExplicitApp(raw);
    const explicitUrl = this._extractExplicitUrl(raw);

    if (explicitFile) {
      return {
        rawPronoun: explicitFile,
        resolvedEntity: explicitFile,
        resolvedType: "file",
        source: "voice",
        confidence: 1.0,
        confidenceTier: "HIGH",
        timestamp: now,
        isStale: false,
        isAmbiguous: false,
        candidateAlternatives: [],
      };
    }

    if (explicitApp) {
      return {
        rawPronoun: explicitApp,
        resolvedEntity: explicitApp,
        resolvedType: "app",
        source: "voice",
        confidence: 1.0,
        confidenceTier: "HIGH",
        timestamp: now,
        isStale: false,
        isAmbiguous: false,
        candidateAlternatives: [],
      };
    }

    if (explicitUrl) {
      return {
        rawPronoun: explicitUrl,
        resolvedEntity: explicitUrl,
        resolvedType: "url",
        source: "voice",
        confidence: 1.0,
        confidenceTier: "HIGH",
        timestamp: now,
        isStale: false,
        isAmbiguous: false,
        candidateAlternatives: [],
      };
    }

    // 3. Special Case: "Play karo" / "Isko play karo" referring to search result
    if (
      /\b(play|chala do|chalao|play karo)\b/i.test(lower) &&
      context.activeMedia?.searchResults &&
      context.activeMedia.searchResults.length > 0
    ) {
      const selected = context.activeMedia.selectedResult || context.activeMedia.searchResults[0];
      return {
        rawPronoun: rawPronoun || "play",
        resolvedEntity: selected.title,
        resolvedType: "media",
        source: "ui_state",
        confidence: 0.95,
        confidenceTier: "HIGH",
        timestamp: now,
        isStale: false,
        isAmbiguous: false,
        candidateAlternatives: context.activeMedia.searchResults.map((r) => r.title),
      };
    }

    // 4. Non-deictic utterance with no explicit reference
    if (!hasDeictic) {
      return {
        rawPronoun: "",
        resolvedEntity: null,
        resolvedType: null,
        source: "conversation",
        confidence: 1.0,
        confidenceTier: "HIGH",
        timestamp: now,
        isStale: false,
        isAmbiguous: false,
        candidateAlternatives: [],
      };
    }

    // 5. Deictic Reference Resolution Ladder:
    // Gather candidates from available fresh context sources
    const fileCandidates: string[] = [];
    const appCandidates: string[] = [];
    const urlCandidates: string[] = [];

    if (context.currentFile) fileCandidates.push(context.currentFile);
    if (context.currentTask?.relevantEntities?.files) {
      for (const f of context.currentTask.relevantEntities.files) {
        if (!fileCandidates.includes(f)) fileCandidates.push(f);
      }
    }
    // Cross-turn entity extraction from previous conversation
    if (fileCandidates.length === 0 && context.previousConversation?.length) {
      for (const turn of [...context.previousConversation].reverse()) {
        const found = this._extractExplicitFile(turn.text);
        if (found && !fileCandidates.includes(found)) {
          fileCandidates.push(found);
          break;
        }
      }
    }

    if (context.currentApplication) appCandidates.push(context.currentApplication);
    if (context.currentWebsite) urlCandidates.push(context.currentWebsite);

    // Intent clue check: does utterance imply code/editing vs closing/window vs website?
    const isCodeIntent = /\b(improve|fix|edit|bug|inspect|test|check|syntax|review|refactor|compile|run|dekho|dekhna)\b/i.test(
      lower
    );
    const isAppIntent = /\b(close|minimize|maximize|switch|band karo|hatao|kholo|open)\b/i.test(lower);
    const isBrowserIntent = /\b(scroll|click|summarize page|bookmark|reload|refresh)\b/i.test(lower);

    // Ambiguity Check: Multiple files with no active focus
    if ((isCodeIntent || !isAppIntent) && fileCandidates.length > 1 && !context.currentFile) {
      return {
        rawPronoun,
        resolvedEntity: null,
        resolvedType: "file",
        source: "file",
        confidence: 0.45,
        confidenceTier: "LOW",
        timestamp: now,
        isStale: false,
        isAmbiguous: true,
        candidateAlternatives: fileCandidates,
        clarificationPrompt: `Aap kaunsi file ke baare mein baat kar rahe hain? Mere paas ye options hain: ${fileCandidates.join(", ")}`,
      };
    }

    // Step A: Active File (if code intent or file is open)
    if (fileCandidates.length > 0 && (isCodeIntent || !isAppIntent)) {
      const target = fileCandidates[0];
      const isFresh = this._freshness.isFresh("file", context.timestamp, now);
      const conf = this._confidence.computeConfidence("file", context.timestamp, 0, now);
      return {
        rawPronoun,
        resolvedEntity: target,
        resolvedType: "file",
        source: "file",
        confidence: conf,
        confidenceTier: this._confidence.getTier(conf),
        timestamp: context.timestamp,
        isStale: !isFresh,
        isAmbiguous: false,
        candidateAlternatives: fileCandidates,
      };
    }

    // Step B: Active Application
    if (appCandidates.length > 0 && (isAppIntent || !isCodeIntent)) {
      const target = appCandidates[0];
      const isFresh = this._freshness.isFresh("application", context.timestamp, now);
      const conf = this._confidence.computeConfidence("application", context.timestamp, 0, now);
      return {
        rawPronoun,
        resolvedEntity: target,
        resolvedType: "app",
        source: "application",
        confidence: conf,
        confidenceTier: this._confidence.getTier(conf),
        timestamp: context.timestamp,
        isStale: !isFresh,
        isAmbiguous: false,
        candidateAlternatives: appCandidates,
      };
    }

    // Step C: Active Browser URL
    if (urlCandidates.length > 0 && (isBrowserIntent || !isCodeIntent)) {
      const target = urlCandidates[0];
      const isFresh = this._freshness.isFresh("browser", context.timestamp, now);
      const conf = this._confidence.computeConfidence("browser", context.timestamp, 0, now);
      return {
        rawPronoun,
        resolvedEntity: target,
        resolvedType: "url",
        source: "browser",
        confidence: conf,
        confidenceTier: this._confidence.getTier(conf),
        timestamp: context.timestamp,
        isStale: !isFresh,
        isAmbiguous: false,
        candidateAlternatives: urlCandidates,
      };
    }

    // Step D: Active Project
    if (context.currentProject) {
      return {
        rawPronoun,
        resolvedEntity: context.currentProject,
        resolvedType: "project",
        source: "project",
        confidence: 0.75,
        confidenceTier: "MEDIUM",
        timestamp: context.timestamp,
        isStale: false,
        isAmbiguous: false,
        candidateAlternatives: [context.currentProject],
      };
    }

    // Fallback: Ambiguous reference with no candidates
    return {
      rawPronoun,
      resolvedEntity: null,
      resolvedType: null,
      source: "conversation",
      confidence: 0.3,
      confidenceTier: "LOW",
      timestamp: now,
      isStale: false,
      isAmbiguous: true,
      candidateAlternatives: [],
      clarificationPrompt: "Aap kis cheez ('isko/isme') ke baare mein baat kar rahe hain? Kripya naam clear kijiye.",
    };
  }

  private _extractExplicitFile(raw: string): string | null {
    const fileMatches = raw.match(/[\w.-]+\.(ts|tsx|js|jsx|py|json|md|html|css|txt|log|yaml|yml)/gi);
    return fileMatches && fileMatches.length > 0 ? fileMatches[0] : null;
  }

  private _extractExplicitApp(raw: string): string | null {
    if (/\b(vs code|vscode)\b/i.test(raw)) return "vscode";
    if (/\b(file manager|filemanager|file explorer|explorer)\b/i.test(raw)) return "explorer";
    if (/\b(notepad)\b/i.test(raw)) return "notepad";
    if (/\b(chrome|google chrome)\b/i.test(raw)) return "chrome";
    if (/\b(edge|microsoft edge)\b/i.test(raw)) return "edge";
    if (/\b(cursor)\b/i.test(raw)) return "cursor";
    if (/\b(calculator|calc)\b/i.test(raw)) return "calculator";
    if (/\b(task manager|taskmanager)\b/i.test(raw)) return "task manager";
    if (/\b(terminal|powershell)\b/i.test(raw)) return "powershell";
    if (/\b(cmd|command prompt)\b/i.test(raw)) return "cmd";
    if (/\b(paint)\b/i.test(raw)) return "paint";
    if (/\b(settings)\b/i.test(raw)) return "settings";
    return null;
  }

  private _extractExplicitUrl(raw: string): string | null {
    const urlMatches = raw.match(/https?:\/\/[^\s]+/gi);
    return urlMatches && urlMatches.length > 0 ? urlMatches[0] : null;
  }
}

export const referenceResolver = new ReferenceResolver();
