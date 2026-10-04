/**
 * MobileContextSanitizer
 * Phase 22 — Mobile Context Intelligence
 *
 * Server-side privacy, DLP, and prompt-injection defense for mobile context:
 *   1. Redacts sensitive credentials (passwords, auth tokens, API keys, private keys).
 *   2. Redacts financial and identity tokens (payment cards, OTPs, PINs).
 *   3. Shields sensitive packages (banking, authenticators, password managers).
 *   4. Scans for prompt-injection patterns in untrusted mobile context strings.
 *   5. Wraps untrusted text with strict boundary delimiters.
 */

import { contentSanitizer } from "../../security/ContentSanitizer.ts";
import type {
  CurrentAppContext,
  NotificationContextItem,
  ScreenContextData,
} from "./MobileContextTypes.ts";

export const UNTRUSTED_MOBILE_CONTEXT_START = "<<<UNTRUSTED_MOBILE_CONTEXT>>>";
export const UNTRUSTED_MOBILE_CONTEXT_END = "<<</UNTRUSTED_MOBILE_CONTEXT>>>";

export class MobileContextSanitizer {
  private static readonly CREDENTIAL_PATTERNS = [
    /sora_dev_[A-Za-z0-9_\-]+/gi,
    /myraa_at_[A-Za-z0-9_\-]+/gi,
    /Bearer\s+[A-Za-z0-9_\-\.]+/gi,
    /sk-[A-Za-z0-9_\-]+/gi,
    /AIza[0-9A-Za-z_\-]+/gi,
    /password\s*[:=]\s*[^\s,;]+/gi,
    /secret\s*[:=]\s*[^\s,;]+/gi,
    /token\s*[:=]\s*[^\s,;]+/gi,
    /api[_-]?key\s*[:=]\s*[^\s,;]+/gi,
  ];

  private static readonly CARD_PATTERN =
    /\b(?:4[0-9]{3}[ -]?[0-9]{4}[ -]?[0-9]{4}[ -]?[0-9]{4}|5[1-5][0-9]{2}[ -]?[0-9]{4}[ -]?[0-9]{4}[ -]?[0-9]{4}|3[47][0-9]{2}[ -]?[0-9]{6}[ -]?[0-9]{5}|(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|3(?:0[0-5]|[68][0-9])[0-9]{11}|6(?:011|5[0-9]{2})[0-9]{12}|(?:2131|1800|35\d{3})\d{11}))\b/g;

  private static readonly OTP_PATTERN =
    /\b(?:otp|code|verification|pin|password)\s*[:=]?\s*([0-9]{4,8})\b/gi;

  private static readonly STANDALONE_PIN_PATTERN = /\b([0-9]{6})\b/g;

  private static readonly SENSITIVE_PACKAGES = new Set([
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

  /**
   * Checks if an application package is in the sensitive/banking/auth category.
   */
  static isSensitivePackage(packageName: string): boolean {
    if (!packageName) return false;
    const lower = packageName.toLowerCase().trim();
    if (this.SENSITIVE_PACKAGES.has(lower)) return true;
    return lower.includes("bank") || lower.includes("pay") || lower.includes("auth") || lower.includes("password");
  }

  /**
   * Sanitizes arbitrary text string (redacts credentials, cards, OTPs, defangs injections).
   */
  static sanitizeString(input: string | undefined): string {
    if (!input || typeof input !== "string") return "";
    let text = input;

    // 1. Redact credentials & API tokens
    for (const pat of this.CREDENTIAL_PATTERNS) {
      text = text.replace(pat, "[REDACTED_CREDENTIAL]");
    }

    // 2. Redact payment cards
    text = text.replace(this.CARD_PATTERN, "[REDACTED_CARD]");

    // 3. Redact explicit OTPs
    text = text.replace(this.OTP_PATTERN, (match) => {
      return match.replace(/[0-9]{4,8}/, "[REDACTED_OTP]");
    });

    // 4. Redact standalone 6-digit codes
    text = text.replace(this.STANDALONE_PIN_PATTERN, "[REDACTED_CODE]");

    // 5. Scan and defang prompt injection attempts
    const scan = contentSanitizer.scanForPromptInjection(text, {
      source: "mobile_context",
    });

    return scan.sanitizedText.trim();
  }

  /**
   * Sanitizes the current application context.
   */
  static sanitizeCurrentApp(app: CurrentAppContext): CurrentAppContext {
    if (this.isSensitivePackage(app.packageName)) {
      return {
        packageName: app.packageName,
        appName: "[SHIELDED_SENSITIVE_APP]",
        category: "sensitive",
        isSensitive: true,
        isAvailable: true,
      };
    }

    return {
      packageName: this.sanitizeString(app.packageName),
      appName: this.sanitizeString(app.appName),
      category: app.category || "general",
      isSensitive: false,
      isAvailable: app.isAvailable,
    };
  }

  /**
   * Sanitizes notification metadata to minimal necessary non-sensitive items.
   */
  static sanitizeNotifications(items: NotificationContextItem[]): NotificationContextItem[] {
    return items.map((item) => {
      if (this.isSensitivePackage(item.packageName)) {
        return {
          id: item.id,
          packageName: item.packageName,
          appName: "[SHIELDED]",
          category: "sensitive",
          title: "[SHIELDED]",
          sanitizedSnippet: "[CONTENT_SHIELDED_FOR_PRIVACY]",
          postTimeMs: item.postTimeMs,
          priority: item.priority,
        };
      }

      return {
        id: item.id,
        packageName: item.packageName,
        appName: this.sanitizeString(item.appName).slice(0, 40),
        category: item.category || "general",
        title: this.sanitizeString(item.title).slice(0, 80),
        sanitizedSnippet: this.sanitizeString(item.sanitizedSnippet).slice(0, 140),
        postTimeMs: item.postTimeMs,
        priority: item.priority,
      };
    });
  }

  /**
   * Sanitizes screen context and wraps with untrusted delimiter fence.
   */
  static sanitizeScreenContext(screen: ScreenContextData): ScreenContextData {
    if (!screen.isApproved || !screen.isAvailable || !screen.summary) {
      return { ...screen };
    }

    const clean = this.sanitizeString(screen.summary);
    return {
      isApproved: true,
      summary: clean,
      capturedAtMs: screen.capturedAtMs,
      isAvailable: true,
    };
  }

  /**
   * Wraps mobile context summary in safe boundary delimiter tags.
   */
  static fenceContext(text: string): string {
    return `${UNTRUSTED_MOBILE_CONTEXT_START}\n${text}\n${UNTRUSTED_MOBILE_CONTEXT_END}`;
  }
}
