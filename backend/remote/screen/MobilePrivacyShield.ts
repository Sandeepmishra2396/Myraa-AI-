/**
 * MobilePrivacyShield
 * Phase 23 — Mobile Screen Understanding
 *
 * Strict fail-closed privacy shield for mobile screen inspection.
 * Reuses Phase 8 Multimodal Intelligence sensitive classification rules.
 *
 * Automatically shields and blocks:
 *   1. Banking / Payment apps (Google Pay, PhonePe, Paytm, Banking apps)
 *   2. Password managers (Bitwarden, 1Password, LastPass, Dashlane, KeePass)
 *   3. Authentication & OTP screens (Authenticators, 2FA, SMS OTPs)
 *   4. Screens with password/credential input fields
 *   5. Unknown or uncertain active contexts (FAILS CLOSED)
 */

import type {
  ScreenPrivacyShieldDecision,
  ScreenShieldReasonType,
} from "./MobileScreenTypes.ts";
import { SCREEN_SHIELD_REASONS } from "./MobileScreenTypes.ts";

export class MobilePrivacyShield {
  // Known sensitive banking & payment packages
  private static readonly BANKING_PACKAGES = new Set([
    "com.google.android.apps.nbu.paisa.user", // Google Pay (Tez)
    "com.phonepe.app",
    "net.one97.paytm",
    "com.sbi.lotusintouch",
    "com.hdfcbank.android",
    "com.icicibank.mobile",
    "com.axis.mobile",
    "com.kotak.bank",
    "com.bankofbaroda.mconnect",
    "com.pnb.pnbone",
  ]);

  // Known password managers
  private static readonly PASSWORD_MANAGERS = new Set([
    "com.bitwarden",
    "com.onepassword.android",
    "com.lastpass.lpandroid",
    "com.dashlane",
    "keepass2android.keepass2android",
    "com.nordpass.android",
  ]);

  // Known authenticator & 2FA apps
  private static readonly AUTH_PACKAGES = new Set([
    "com.google.android.apps.authenticator2",
    "com.authy.authy",
    "com.microsoft.authenticator",
    "com.duosecurity.duomobile",
  ]);

  /**
   * Evaluates whether the current mobile screen can be safely captured/understood.
   * If any sensitive pattern is matched or context is uncertain -> FAILS CLOSED.
   */
  static evaluate(params: {
    packageName?: string;
    appName?: string;
    activityName?: string;
    screenText?: string;
    isUncertain?: boolean;
    isAvailable?: boolean;
  }): ScreenPrivacyShieldDecision {
    // 1. Uncertain Context Gate (FAILS CLOSED)
    if (params.isUncertain === true || params.isAvailable === false) {
      return {
        isShielded: true,
        reason: SCREEN_SHIELD_REASONS.UNCERTAIN_CONTEXT,
        details: "Screen understanding shielded: active window or application state is uncertain or undetectable.",
      };
    }

    const pkg = (params.packageName || "").toLowerCase().trim();
    const appName = (params.appName || "").toLowerCase().trim();
    const activity = (params.activityName || "").toLowerCase().trim();
    const text = (params.screenText || "").toLowerCase();

    // 2. Banking & Payment App Detection
    if (
      this.BANKING_PACKAGES.has(pkg) ||
      pkg.includes("bank") ||
      pkg.includes("paytm") ||
      pkg.includes("phonepe") ||
      pkg.includes("paisa") ||
      appName.includes("bank") ||
      appName.includes("pay")
    ) {
      return {
        isShielded: true,
        reason: SCREEN_SHIELD_REASONS.BANKING_APP,
        details: `Screen understanding shielded: banking/payment application active (${params.packageName || "banking"}).`,
      };
    }

    // 3. Password Manager Detection
    if (
      this.PASSWORD_MANAGERS.has(pkg) ||
      pkg.includes("bitwarden") ||
      pkg.includes("1password") ||
      pkg.includes("lastpass") ||
      pkg.includes("keepass") ||
      appName.includes("password") ||
      activity.includes("vault") ||
      activity.includes("credential")
    ) {
      return {
        isShielded: true,
        reason: SCREEN_SHIELD_REASONS.PASSWORD_MANAGER,
        details: `Screen understanding shielded: password manager active (${params.packageName || "password manager"}).`,
      };
    }

    // 4. Authenticator & OTP Screen Detection
    if (
      this.AUTH_PACKAGES.has(pkg) ||
      pkg.includes("authenticator") ||
      pkg.includes("authy") ||
      activity.includes("otp") ||
      activity.includes("twofactor") ||
      activity.includes("auth") ||
      text.includes("enter verification code") ||
      text.includes("enter otp") ||
      text.includes("authenticator code")
    ) {
      return {
        isShielded: true,
        reason: SCREEN_SHIELD_REASONS.AUTH_OTP,
        details: `Screen understanding shielded: 2FA/authenticator/OTP context detected (${params.activityName || "auth"}).`,
      };
    }

    // 5. Explicit Credential Entry Screen Detection
    if (
      text.includes("enter your password") ||
      text.includes("confirm password") ||
      text.includes("enter pin") ||
      text.includes("security question")
    ) {
      return {
        isShielded: true,
        reason: SCREEN_SHIELD_REASONS.PASSWORD_MANAGER,
        details: "Screen understanding shielded: password/credential entry screen detected.",
      };
    }

    // Safe to inspect
    return {
      isShielded: false,
    };
  }
}
