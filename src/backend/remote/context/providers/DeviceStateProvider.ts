/**
 * DeviceStateProvider
 * Phase 22 — Mobile Context Intelligence
 *
 * Provides physical hardware, OS version, orientation, and screen state.
 */

import type { IContextProvider, DeviceStateContext } from "../MobileContextTypes.ts";
import { CONTEXT_UNKNOWN } from "../MobileContextTypes.ts";

export class DeviceStateProvider implements IContextProvider<DeviceStateContext> {
  readonly category = "device" as const;

  getContext(options?: { rawPayload?: unknown }): DeviceStateContext {
    const raw = (options?.rawPayload as Partial<DeviceStateContext>) || {};

    return {
      manufacturer: raw.manufacturer || CONTEXT_UNKNOWN,
      model: raw.model || CONTEXT_UNKNOWN,
      androidVersion: raw.androidVersion || CONTEXT_UNKNOWN,
      sdkInt: typeof raw.sdkInt === "number" ? raw.sdkInt : 0,
      orientation: raw.orientation || "portrait",
      isScreenOn: raw.isScreenOn !== false,
      isAvailable: raw.isAvailable !== false,
    };
  }
}
