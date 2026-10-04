/**
 * CurrentAppProvider
 * Phase 22 — Mobile Context Intelligence
 *
 * Detects current active foreground package and application name.
 * Respects sensitive app shielding and returns UNKNOWN/NOT_AVAILABLE if not reliably detectable.
 */

import type { IContextProvider, CurrentAppContext } from "../MobileContextTypes.ts";
import { CONTEXT_UNKNOWN, CONTEXT_NOT_AVAILABLE, CONTEXT_SENSITIVE_SHIELDED } from "../MobileContextTypes.ts";

export class CurrentAppProvider implements IContextProvider<CurrentAppContext> {
  readonly category = "app" as const;

  private sensitivePackages = new Set([
    "com.google.android.apps.nbu.paisa.user",
    "com.phonepe.app",
    "net.one97.paytm",
    "com.sbi.lotusintouch",
    "com.hdfcbank.android",
    "com.icicibank.mobile",
    "com.axis.mobile",
    "com.bitwarden",
    "com.onepassword.android",
    "com.lastpass.lpandroid",
    "com.dashlane",
    "com.google.android.apps.authenticator2",
    "com.authy.authy",
    "com.microsoft.authenticator",
  ]);

  getContext(options?: { rawPayload?: unknown }): CurrentAppContext {
    const raw = (options?.rawPayload as Partial<CurrentAppContext>) || {};

    if (!raw.packageName || raw.packageName === CONTEXT_UNKNOWN || raw.packageName === CONTEXT_NOT_AVAILABLE) {
      return {
        packageName: CONTEXT_UNKNOWN,
        appName: CONTEXT_UNKNOWN,
        category: "general",
        isSensitive: false,
        isAvailable: false,
      };
    }

    const pkgLower = raw.packageName.toLowerCase().trim();
    const isSensitive = this.sensitivePackages.has(pkgLower) ||
      pkgLower.includes("bank") ||
      pkgLower.includes("pay") ||
      pkgLower.includes("auth") ||
      pkgLower.includes("password");

    if (isSensitive) {
      return {
        packageName: raw.packageName,
        appName: CONTEXT_SENSITIVE_SHIELDED,
        category: "sensitive",
        isSensitive: true,
        isAvailable: true,
      };
    }

    return {
      packageName: raw.packageName,
      appName: raw.appName || raw.packageName,
      category: raw.category || "general",
      isSensitive: false,
      isAvailable: raw.isAvailable !== false,
    };
  }
}
