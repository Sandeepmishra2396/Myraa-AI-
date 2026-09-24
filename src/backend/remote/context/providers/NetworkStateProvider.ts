/**
 * NetworkStateProvider
 * Phase 22 — Mobile Context Intelligence
 *
 * Provides active network connectivity state (wifi, cellular, ethernet, none) and metering status.
 */

import type { IContextProvider, NetworkStateContext } from "../MobileContextTypes.ts";

export class NetworkStateProvider implements IContextProvider<NetworkStateContext> {
  readonly category = "network" as const;

  getContext(options?: { rawPayload?: unknown }): NetworkStateContext {
    const raw = (options?.rawPayload as Partial<NetworkStateContext>) || {};

    return {
      isConnected: raw.isConnected === true,
      type: raw.type || (raw.isConnected ? "unknown" : "none"),
      isMetered: raw.isMetered === true,
      wifiSsid: raw.wifiSsid || undefined,
      isAvailable: raw.isAvailable !== false,
    };
  }
}
