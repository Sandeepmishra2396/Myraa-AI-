/**
 * MYRAA — Phase 20: Advanced Natural Conversation Engine
 * ConversationalReferenceResolver
 *
 * Implements multi-turn deictic reference resolution following the strict priority ladder:
 *   Current explicit user instruction
 *   > Current conversational turn
 *   > Active conversation entity
 *   > Previous turn entity
 *   > Active task
 *   > UnifiedMyraaContext
 *   > Recent successful action
 *   > Adaptive Personal Brain
 *
 * Pronouns resolved:
 *   - "ye", "woh", "isko", "usko", "isme", "usme", "yahi", "wahi", "ye wala", "woh wala", "iska", "uska"
 *   - "this", "that", "this one", "that one", "it", "its"
 *
 * Ambiguity Guardrail:
 *   When multiple candidates exist with similar confidence (score delta <= 0.05):
 *   NEVER GUESS. Asks a short natural clarification.
 */

import type { ConversationState, ConversationalReferenceResult } from "./ConversationTypes.ts";
import type { UnifiedMyraaContext } from "../intelligence/IntelligenceTypes.ts";
import { conversationEntityTracker, ConversationEntityTracker } from "./ConversationEntityTracker.ts";

export class ConversationalReferenceResolver {
  private _entityTracker: ConversationEntityTracker;

  constructor(entityTracker = conversationEntityTracker) {
    this._entityTracker = entityTracker;
  }

  /**
   * Resolves reference in utterance against multi-turn conversation state and unified context.
   */
  public resolveReference(
    userInput: string,
    state: ConversationState,
    unifiedContext?: UnifiedMyraaContext,
    now = Date.now()
  ): ConversationalReferenceResult {
    const raw = (userInput || "").trim();
    const lower = raw.toLowerCase();

    // 1. Detect deictic / anaphoric pronoun
    const deicticPattern =
      /\b(woh wala|wo wala|ye wala|yeh wala|wahi wala|yahi wala|this one|that one|the same one|iska|uska|isko|usko|isme|usme|yahi|wahi|woh|wo|ye|yeh|this|that|it|its)\b/i;
    const match = lower.match(deicticPattern);
    const hasDeictic = Boolean(match);
    const rawPronoun = match ? match[1] : "";

    // ── Tier 1: Current Explicit User Instruction ──────────────────────────
    const explicitFile = this._extractExplicitFile(raw);
    if (explicitFile) {
      return {
        rawPronoun: explicitFile,
        resolvedEntity: explicitFile,
        resolvedType: "file",
        confidence: 1.0,
        sourceTier: "EXPLICIT_USER_INSTRUCTION",
        isAmbiguous: false,
        candidateAlternatives: [],
        isStale: false,
      };
    }

    const explicitApp = this._extractExplicitApp(raw);
    if (explicitApp) {
      return {
        rawPronoun: explicitApp,
        resolvedEntity: explicitApp,
        resolvedType: "app",
        confidence: 1.0,
        sourceTier: "EXPLICIT_USER_INSTRUCTION",
        isAmbiguous: false,
        candidateAlternatives: [],
        isStale: false,
      };
    }

    if (!hasDeictic) {
      return {
        rawPronoun: "",
        resolvedEntity: null,
        resolvedType: null,
        confidence: 1.0,
        sourceTier: "NONE",
        isAmbiguous: false,
        candidateAlternatives: [],
        isStale: false,
      };
    }

    // Check if conversational state is stale
    const isStateExpired = state.isStale || (now - state.conversationTimestamp > state.stateExpiration);

    // ── Tier 2 & 3: Active Conversation Entity (if not expired) ─────────────
    if (!isStateExpired) {
      // Check intent hint to prefer file vs project vs app
      const isFileIntent = /\b(optimize|improve|fix|edit|inspect|test|check|syntax|review|run)\b/i.test(lower);
      const isProjectIntent = /\b(project|workspace|backend|frontend|repo|repository)\b/i.test(lower);
      const isAppIntent = /\b(close|minimize|maximize|switch|band karo|hatao)\b/i.test(lower);

      if (isProjectIntent && state.activeProject) {
        return {
          rawPronoun,
          resolvedEntity: state.activeProject,
          resolvedType: "project",
          confidence: 0.95,
          sourceTier: "ACTIVE_CONVERSATION_ENTITY",
          isAmbiguous: false,
          candidateAlternatives: [],
          isStale: false,
        };
      }

      if ((isFileIntent || !isAppIntent) && state.activeFile) {
        return {
          rawPronoun,
          resolvedEntity: state.activeFile,
          resolvedType: "file",
          confidence: 0.95,
          sourceTier: "ACTIVE_CONVERSATION_ENTITY",
          isAmbiguous: false,
          candidateAlternatives: [],
          isStale: false,
        };
      }

      if (isAppIntent && state.activeApplication) {
        return {
          rawPronoun,
          resolvedEntity: state.activeApplication,
          resolvedType: "app",
          confidence: 0.95,
          sourceTier: "ACTIVE_CONVERSATION_ENTITY",
          isAmbiguous: false,
          candidateAlternatives: [],
          isStale: false,
        };
      }

      if (state.activeEntity) {
        return {
          rawPronoun,
          resolvedEntity: state.activeEntity,
          resolvedType: state.activeFile === state.activeEntity ? "file" : state.activeProject === state.activeEntity ? "project" : "file",
          confidence: 0.92,
          sourceTier: "ACTIVE_CONVERSATION_ENTITY",
          isAmbiguous: false,
          candidateAlternatives: [],
          isStale: false,
        };
      }
    }

    // ── Tier 4: Previous Turn Entity (Tracked by ConversationEntityTracker) ─
    const recentEntities = this._entityTracker.getActiveEntities(state.conversationId);
    if (!isStateExpired && recentEntities.length > 0) {
      // Check if multiple candidates of same type exist
      const recentFiles = recentEntities.filter((e) => e.entityType === "file");
      const recentProjects = recentEntities.filter((e) => e.entityType === "project");

      if (recentFiles.length > 1 && !state.activeFile) {
        const topDelta = Math.abs(recentFiles[0].confidence - recentFiles[1].confidence);
        if (topDelta <= 0.05) {
          // Ambiguous tie: NEVER GUESS!
          const candidates = recentFiles.map((f) => f.name);
          return {
            rawPronoun,
            resolvedEntity: null,
            resolvedType: "file",
            confidence: 0.45,
            sourceTier: "PREVIOUS_TURN_ENTITY",
            isAmbiguous: true,
            candidateAlternatives: candidates,
            clarificationPrompt: `Aap kaunsi file ki baat kar rahe hain? Mere paas ye options hain: ${candidates.join(", ")}`,
            isStale: false,
          };
        }
      }

      if (recentFiles.length === 1) {
        return {
          rawPronoun,
          resolvedEntity: recentFiles[0].name,
          resolvedType: "file",
          confidence: 0.9,
          sourceTier: "PREVIOUS_TURN_ENTITY",
          isAmbiguous: false,
          candidateAlternatives: [],
          isStale: false,
        };
      }

      if (recentProjects.length === 1) {
        return {
          rawPronoun,
          resolvedEntity: recentProjects[0].name,
          resolvedType: "project",
          confidence: 0.9,
          sourceTier: "PREVIOUS_TURN_ENTITY",
          isAmbiguous: false,
          candidateAlternatives: [],
          isStale: false,
        };
      }
    }

    // ── Tier 5: Active Task ─────────────────────────────────────────────────
    const task = state.activeTask || unifiedContext?.currentTask;
    if (task?.relevantEntities?.files?.length) {
      if (task.relevantEntities.files.length === 1) {
        return {
          rawPronoun,
          resolvedEntity: task.relevantEntities.files[0],
          resolvedType: "file",
          confidence: 0.88,
          sourceTier: "ACTIVE_TASK",
          isAmbiguous: false,
          candidateAlternatives: [],
          isStale: false,
        };
      } else if (task.relevantEntities.files.length > 1) {
        return {
          rawPronoun,
          resolvedEntity: null,
          resolvedType: "file",
          confidence: 0.45,
          sourceTier: "ACTIVE_TASK",
          isAmbiguous: true,
          candidateAlternatives: [...task.relevantEntities.files],
          clarificationPrompt: `Kaunsi file par kaam karna hai? [${task.relevantEntities.files.join(", ")}]`,
          isStale: false,
        };
      }
    }

    // ── Tier 6: UnifiedMyraaContext ─────────────────────────────────────────
    if (unifiedContext) {
      if (unifiedContext.currentFile) {
        return {
          rawPronoun,
          resolvedEntity: unifiedContext.currentFile,
          resolvedType: "file",
          confidence: 0.85,
          sourceTier: "UNIFIED_MYRAA_CONTEXT",
          isAmbiguous: false,
          candidateAlternatives: [],
          isStale: false,
        };
      }

      if (unifiedContext.currentApplication) {
        return {
          rawPronoun,
          resolvedEntity: unifiedContext.currentApplication,
          resolvedType: "app",
          confidence: 0.82,
          sourceTier: "UNIFIED_MYRAA_CONTEXT",
          isAmbiguous: false,
          candidateAlternatives: [],
          isStale: false,
        };
      }

      if (unifiedContext.currentProject) {
        return {
          rawPronoun,
          resolvedEntity: unifiedContext.currentProject,
          resolvedType: "project",
          confidence: 0.8,
          sourceTier: "UNIFIED_MYRAA_CONTEXT",
          isAmbiguous: false,
          candidateAlternatives: [],
          isStale: false,
        };
      }
    }

    // ── Tier 7: Recent Successful Action ────────────────────────────────────
    if (state.recentAssistantActions.length > 0) {
      const lastAction = state.recentAssistantActions[0];
      return {
        rawPronoun,
        resolvedEntity: lastAction,
        resolvedType: "action",
        confidence: 0.7,
        sourceTier: "RECENT_SUCCESSFUL_ACTION",
        isAmbiguous: false,
        candidateAlternatives: [],
        isStale: isStateExpired,
      };
    }

    // Unresolvable reference
    return {
      rawPronoun,
      resolvedEntity: null,
      resolvedType: null,
      confidence: 0.3,
      sourceTier: "NONE",
      isAmbiguous: true,
      candidateAlternatives: [],
      clarificationPrompt: "Aap kis entity ya file ke baare mein baat kar rahe hain? Kripya clear kijiye.",
      isStale: isStateExpired,
    };
  }

  private _extractExplicitFile(raw: string): string | null {
    const match = raw.match(/[\w.-]+\.(ts|tsx|js|jsx|py|json|md|html|css|txt|log|yaml|yml)/i);
    return match ? match[0] : null;
  }

  private _extractExplicitApp(raw: string): string | null {
    if (/\b(vs code|vscode)\b/i.test(raw)) return "vscode";
    if (/\b(file manager|filemanager|file explorer|explorer)\b/i.test(raw)) return "explorer";
    if (/\b(notepad)\b/i.test(raw)) return "notepad";
    if (/\b(chrome|google chrome)\b/i.test(raw)) return "chrome";
    if (/\b(terminal|powershell)\b/i.test(raw)) return "powershell";
    return null;
  }
}

export const conversationalReferenceResolver = new ConversationalReferenceResolver();
