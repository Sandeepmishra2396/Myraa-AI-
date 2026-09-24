/**
 * BatteryProvider
 * Phase 22 — Mobile Context Intelligence
 *
 * Provides device battery level, charging state, and power status.
 */

import type { IContextProvider, BatteryContext } from "../MobileContextTypes.ts";

export class BatteryProvider implements IContextProvider<BatteryContext> {
  readonly category = "battery" as const;

  getContext(options?: { rawPayload?: unknown }): BatteryContext {
    const raw = (options?.rawPayload as Partial<BatteryContext>) || {};

    return {
      level: typeof raw.level === "number" ? raw.level : -1,
      isCharging: raw.isCharging === true,
      status: raw.status || (raw.isCharging ? "charging" : "discharging"),
      isAvailable: typeof raw.level === "number" && raw.level >= 0,
    };
  }
}
