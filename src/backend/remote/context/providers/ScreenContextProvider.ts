/**
 * ScreenContextProvider
 * Phase 22 — Mobile Context Intelligence
 *
 * Strict user-approved screen context provider.
 * PRIVACY INVARIANT: Disabled by default. Screen context is NEVER collected
 * without explicit user permission/approval. Raw video/screen frames are never continuously stored.
 */

import type { IContextProvider, ScreenContextData } from "../MobileContextTypes.ts";
import { CONTEXT_NOT_PERMITTED, CONTEXT_NOT_AVAILABLE } from "../MobileContextTypes.ts";

export class ScreenContextProvider implements IContextProvider<ScreenContextData> {
  readonly category = "screen" as const;

  getContext(options?: {
    approved?: boolean;
    rawPayload?: unknown;
  }): ScreenContextData {
    const isApproved = options?.approved === true;

    if (!isApproved) {
      return {
        isApproved: false,
        summary: CONTEXT_NOT_PERMITTED,
        capturedAtMs: 0,
        isAvailable: false,
      };
    }

    const raw = (options?.rawPayload as Partial<ScreenContextData>) || {};
    const summary = raw.summary || (typeof options?.rawPayload === "string" ? options.rawPayload : undefined);

    if (!summary || summary === CONTEXT_NOT_AVAILABLE || summary === CONTEXT_NOT_PERMITTED) {
      return {
        isApproved: true,
        summary: CONTEXT_NOT_AVAILABLE,
        capturedAtMs: Date.now(),
        isAvailable: false,
      };
    }

    return {
      isApproved: true,
      summary: summary,
      capturedAtMs: raw.capturedAtMs || Date.now(),
      isAvailable: true,
    };
  }
}
