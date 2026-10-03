/**
 * MYRAA — Phase 20: Advanced Natural Conversation Engine
 * FollowUpIntentResolver
 *
 * Resolves follow-up commands without forcing the user to repeat context:
 *   - "haan wahi wala" -> follow-up select
 *   - "isko optimize karo" -> follow-up inspect / modify on active file
 *   - "iska backend check karo" -> follow-up inspect on active project backend
 *   - "ab ispe test run karo" -> follow-up test
 *   - "ab isko close kar do" -> follow-up close
 *   - "nahi ye wala nahi" -> follow-up correction
 *   - "haan kar do" -> follow-up confirm
 *   - "nahi ruk jao" -> follow-up cancel
 */

import type { FollowUpResolution, ConversationState } from "./ConversationTypes.ts";

export class FollowUpIntentResolver {
  /**
   * Evaluates if user input represents a follow-up command.
   */
  public resolveFollowUp(
    userInput: string,
    state: ConversationState,
    candidates: string[] = []
  ): FollowUpResolution {
    const raw = (userInput || "").trim();
    const lower = raw.toLowerCase();

    // 1. Natural Confirmation: "haan", "kar do", "theek hai", "bilkul", "yes"
    if (
      /\b(haan|ha|yes|kar do|chalo kar do|theek hai|bilkul|proceed|confirm|go ahead)\b/i.test(lower) &&
      !/\b(nahi|not|cancel|mat|dont|don't)\b/i.test(lower)
    ) {
      if (state.pendingConfirmation) {
        return {
          isFollowUp: true,
          followUpType: "confirm",
          resolvedTarget: state.pendingConfirmation.actionId,
          resolvedTargetType: "action",
          confidence: 0.98,
          rationale: `Affirmative confirmation matching pending action '${state.pendingConfirmation.summary}'`,
          requiresClarification: false,
        };
      }
    }

    // 2. Natural Cancellation / Rejection: "nahi", "ruk jao", "cancel", "mat karo", "chhodo"
    if (/\b(nahi|ruk jao|ruko|cancel|mat karo|chhodo|stop|no|abort)\b/i.test(lower)) {
      if (state.pendingConfirmation) {
        return {
          isFollowUp: true,
          followUpType: "cancel",
          resolvedTarget: state.pendingConfirmation.actionId,
          resolvedTargetType: "action",
          confidence: 0.98,
          rationale: `Cancellation instruction targeting pending action '${state.pendingConfirmation.summary}'`,
          requiresClarification: false,
        };
      }
    }

    // 3. Entity Selection: "haan wahi wala", "wahi wala", "haan wahi", "that one", "yes that one", "ye wala"
    if (
      /\b(haan wahi wala|wahi wala|haan wahi|wahi|yes that one|that one|the same one|second wala|first wala)\b/i.test(
        lower
      )
    ) {
      const target = state.activeProject || state.activeEntity || state.activeFile;
      if (target) {
        return {
          isFollowUp: true,
          followUpType: "select",
          resolvedTarget: target,
          resolvedTargetType: state.activeProject ? "project" : state.activeFile ? "file" : "action",
          confidence: 0.95,
          rationale: `Selected previously focused entity '${target}' via conversational selection`,
          requiresClarification: false,
        };
      } else if (candidates.length === 1) {
        return {
          isFollowUp: true,
          followUpType: "select",
          resolvedTarget: candidates[0],
          resolvedTargetType: "project",
          confidence: 0.92,
          rationale: `Selected unambiguous candidate '${candidates[0]}'`,
          requiresClarification: false,
        };
      } else if (candidates.length > 1) {
        return {
          isFollowUp: true,
          followUpType: "select",
          resolvedTarget: null,
          resolvedTargetType: null,
          confidence: 0.45,
          rationale: "Ambiguous selection: multiple candidates exist with no focus",
          requiresClarification: true,
        };
      }
    }

    // 4. Follow-up Inspection: "iska backend check karo", "isko optimize karo", "isme bug check karo"
    if (
      /\b(iska backend check karo|backend check karo|iska backend|backend dekhna|backend inspect)\b/i.test(lower)
    ) {
      const project = state.activeProject || state.activeEntity;
      return {
        isFollowUp: true,
        followUpType: "inspect",
        resolvedTarget: project ? `${project}/backend` : "backend",
        resolvedTargetType: "project",
        confidence: project ? 0.94 : 0.7,
        rationale: `Follow-up backend inspection on active project '${project || "current context"}'`,
        requiresClarification: false,
      };
    }

    if (
      /\b(isko optimize karo|optimize karo|isko improve karo|improve karo|thoda optimize karo)\b/i.test(lower)
    ) {
      const file = state.activeFile || state.activeEntity;
      return {
        isFollowUp: true,
        followUpType: "inspect",
        resolvedTarget: file,
        resolvedTargetType: "file",
        confidence: file ? 0.95 : 0.6,
        rationale: `Follow-up optimization requested on active entity '${file || "current"}'`,
        requiresClarification: !file,
      };
    }

    if (
      /\b(isme bug hai|bug check karna|isme kya problem hai|check karo|dekhna)\b/i.test(lower) &&
      (state.activeFile || state.activeProject)
    ) {
      const entity = state.activeFile || state.activeProject;
      return {
        isFollowUp: true,
        followUpType: "inspect",
        resolvedTarget: entity,
        resolvedTargetType: state.activeFile ? "file" : "project",
        confidence: 0.92,
        rationale: `Follow-up diagnostics on active entity '${entity}'`,
        requiresClarification: false,
      };
    }

    // 5. Follow-up Test: "ab ispe test run karo", "ab test run karo", "test karo", "run tests"
    if (/\b(ab ispe test run karo|ab test run karo|test run karo|run tests?|isko test karo)\b/i.test(lower)) {
      const file = state.activeFile || state.activeEntity;
      return {
        isFollowUp: true,
        followUpType: "test",
        resolvedTarget: file,
        resolvedTargetType: "file",
        confidence: file ? 0.94 : 0.75,
        rationale: `Follow-up test execution on active target '${file || "current project"}'`,
        requiresClarification: false,
      };
    }

    // 6. Follow-up Run: "ab isko run karo", "ab run karo", "execute karo"
    if (/\b(ab isko run karo|ab run karo|execute karo|chala do)\b/i.test(lower)) {
      const file = state.activeFile || state.activeEntity;
      return {
        isFollowUp: true,
        followUpType: "run",
        resolvedTarget: file,
        resolvedTargetType: "file",
        confidence: file ? 0.93 : 0.7,
        rationale: `Follow-up execution on active target '${file || "current project"}'`,
        requiresClarification: false,
      };
    }

    // 7. Follow-up Close: "ab isko close kar do", "isko close karo", "close this"
    if (/\b(ab isko close kar do|isko close karo|band karo|close this|hata do)\b/i.test(lower)) {
      const app = state.activeApplication || "current";
      return {
        isFollowUp: true,
        followUpType: "close",
        resolvedTarget: app,
        resolvedTargetType: "app",
        confidence: state.activeApplication ? 0.95 : 0.8,
        rationale: `Follow-up application close on '${app}'`,
        requiresClarification: false,
      };
    }

    // 8. Follow-up Correction: "nahi ye wala nahi", "doosra wala"
    if (/\b(nahi ye wala nahi|ye wala nahi|doosra wala|wrong one|not this one)\b/i.test(lower)) {
      return {
        isFollowUp: true,
        followUpType: "select",
        resolvedTarget: null,
        resolvedTargetType: null,
        confidence: 0.88,
        rationale: "User rejected currently selected entity; prompt for desired alternative",
        requiresClarification: true,
      };
    }

    return {
      isFollowUp: false,
      followUpType: "none",
      resolvedTarget: null,
      resolvedTargetType: null,
      confidence: 0.0,
      rationale: "Utterance is a standalone or novel command",
      requiresClarification: false,
    };
  }
}

export const followUpIntentResolver = new FollowUpIntentResolver();
