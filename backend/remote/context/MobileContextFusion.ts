/**
 * MobileContextFusion
 * Phase 22 — Mobile Context Intelligence
 *
 * Deterministically correlates and fuses context from all 9 providers:
 *   Current App + Activity + Approved Screen Context + Notifications +
 *   Device State + Network State + Battery + Conversation + Task
 *
 * STRICT INVARIANT: If context is unavailable, returns UNKNOWN / NOT_AVAILABLE.
 * NEVER GUESSES.
 */

import type { MobileContextSnapshot } from "./MobileContextTypes.ts";
import {
  CONTEXT_UNKNOWN,
  CONTEXT_NOT_AVAILABLE,
  CONTEXT_NOT_PERMITTED,
} from "./MobileContextTypes.ts";

export class MobileContextFusion {
  /**
   * Synthesizes all available, permissioned, and sanitized context components
   * into a natural, coherent summary for MYRAA Core.
   */
  static fuse(snapshot: Omit<MobileContextSnapshot, "fusedSummary">, query?: string): string {
    const segments: string[] = [];

    // 1. Current App & Activity
    if (snapshot.currentApp.isAvailable) {
      if (snapshot.currentApp.isSensitive) {
        segments.push("Current App: [Shielded Sensitive Application]");
      } else {
        const appDesc = snapshot.currentApp.appName || snapshot.currentApp.packageName;
        segments.push(`Current App: ${appDesc}`);
      }
    } else {
      segments.push(`Current App: ${CONTEXT_UNKNOWN}`);
    }

    if (snapshot.activity.isAvailable && snapshot.activity.activityName !== CONTEXT_NOT_AVAILABLE) {
      segments.push(`Screen/Activity: ${snapshot.activity.screenTitle || snapshot.activity.activityName}`);
    } else {
      segments.push(`Screen/Activity: ${CONTEXT_NOT_AVAILABLE}`);
    }

    // 2. User-Approved Screen Context
    if (snapshot.screenContext.isApproved && snapshot.screenContext.isAvailable && snapshot.screenContext.summary) {
      segments.push(`Visible Screen Content: "${snapshot.screenContext.summary}"`);
    } else if (snapshot.screenContext.isApproved) {
      segments.push("Visible Screen Content: [Approved, No Content Detected]");
    } else {
      segments.push("Visible Screen Content: [Unapproved/Disabled by User]");
    }

    // 3. Notifications (Top non-sensitive item if available)
    if (snapshot.notifications.length > 0) {
      const topNotif = snapshot.notifications[0];
      if (topNotif.category !== "sensitive" && topNotif.sanitizedSnippet) {
        segments.push(`Recent Notification (${topNotif.appName}): "${topNotif.sanitizedSnippet}"`);
      }
    }

    // 4. Battery & Network State
    if (snapshot.battery.isAvailable) {
      const charging = snapshot.battery.isCharging ? "charging" : "on battery";
      segments.push(`Battery: ${snapshot.battery.level}% (${charging})`);
    }

    if (snapshot.networkState.isAvailable) {
      const netType = snapshot.networkState.isConnected ? snapshot.networkState.type : "disconnected";
      segments.push(`Network: ${netType}`);
    }

    // 5. Hardware Device State
    if (snapshot.deviceState.isAvailable) {
      segments.push(`Device: ${snapshot.deviceState.manufacturer} ${snapshot.deviceState.model}`);
    }

    // 6. Active Task Context
    if (snapshot.task && (snapshot.task.taskName || snapshot.task.currentGoal)) {
      const taskLabel = snapshot.task.taskName || snapshot.task.currentGoal;
      segments.push(`Active Task: ${taskLabel}`);
    }

    // 7. Conversation Context / Grounding Query
    if (query || snapshot.conversation?.lastUserMessage) {
      const currentQuery = query || snapshot.conversation?.lastUserMessage || "";
      if (this.isContextInquiry(currentQuery)) {
        // Highlighting contextual anchor for "Ye kya hai?" / "What is this?"
        segments.push(`Query Focus: User is asking about current visual/active screen context ("${currentQuery}")`);
      }
    }

    return segments.join(" | ");
  }

  /**
   * Detects deictic queries referring directly to current visual or active screen state.
   * e.g., "Ye kya hai?", "What is this?", "What am I looking at?", "Explain this screen".
   */
  static isContextInquiry(query: string): boolean {
    const q = query.toLowerCase().trim();
    return (
      q.includes("ye kya hai") ||
      q.includes("yeh kya hai") ||
      q.includes("what is this") ||
      q.includes("what am i looking at") ||
      q.includes("tell me about this") ||
      q.includes("explain this screen") ||
      q.includes("what does this mean") ||
      q === "what's this" ||
      q === "ye kya h"
    );
  }
}
