/**
 * ActivityProvider
 * Phase 22 — Mobile Context Intelligence
 *
 * Provides current active Android activity / screen name context.
 * Strictly adheres to permission-compliant boundaries: returns UNKNOWN/NOT_AVAILABLE
 * if exact activity is not reliably detectable without invasive accessibility.
 */

import type { IContextProvider, ActivityContext } from "../MobileContextTypes.ts";
import { CONTEXT_UNKNOWN, CONTEXT_NOT_AVAILABLE } from "../MobileContextTypes.ts";

export class ActivityProvider implements IContextProvider<ActivityContext> {
  readonly category = "activity" as const;

  getContext(options?: { rawPayload?: unknown }): ActivityContext {
    const raw = (options?.rawPayload as Partial<ActivityContext>) || {};

    if (!raw.activityName || raw.activityName === CONTEXT_UNKNOWN || raw.activityName === CONTEXT_NOT_AVAILABLE) {
      return {
        activityName: CONTEXT_NOT_AVAILABLE,
        screenTitle: CONTEXT_NOT_AVAILABLE,
        state: "unknown",
        isAvailable: false,
      };
    }

    return {
      activityName: raw.activityName,
      screenTitle: raw.screenTitle || CONTEXT_NOT_AVAILABLE,
      state: raw.state || "resumed",
      isAvailable: raw.isAvailable !== false,
    };
  }
}
