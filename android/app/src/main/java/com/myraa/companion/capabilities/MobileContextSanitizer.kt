package com.myraa.companion.capabilities

import java.util.regex.Pattern

/**
 * MobileContextSanitizer
 * Phase 22 — Mobile Context Intelligence
 *
 * Enforces strict privacy and security on Android context collection:
 *   1. Wipes passwords, OTPs, verification codes, tokens, and secret keys.
 *   2. Identifies sensitive apps (banking, payment, password manager, auth) and shields them completely.
 *   3. Enforces minimal necessary metadata limits on notifications.
 *   4. Tags external content as UNTRUSTED DATA.
 */
object MobileContextSanitizer {

    // Sensitive package identifiers that MUST be shielded completely
    private val SENSITIVE_PACKAGES = setOf(
        "com.google.android.apps.nbu.paisa.user", // Google Pay (Tez)
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
        "com.microsoft.authenticator"
    )

    // Token / credential pattern signatures
    private val CREDENTIAL_PATTERNS = listOf(
        Pattern.compile("sora_dev_[A-Za-z0-9_\\-]+", Pattern.CASE_INSENSITIVE),
        Pattern.compile("myraa_at_[A-Za-z0-9_\\-]+", Pattern.CASE_INSENSITIVE),
        Pattern.compile("Bearer\\s+[A-Za-z0-9_\\-\\.]+", Pattern.CASE_INSENSITIVE),
        Pattern.compile("sk-[A-Za-z0-9_\\-]+", Pattern.CASE_INSENSITIVE),
        Pattern.compile("AIza[0-9A-Za-z_\\-]+", Pattern.CASE_INSENSITIVE),
        Pattern.compile("password\\s*[:=]\\s*[^\\s,;]+", Pattern.CASE_INSENSITIVE),
        Pattern.compile("secret\\s*[:=]\\s*[^\\s,;]+", Pattern.CASE_INSENSITIVE),
        Pattern.compile("token\\s*[:=]\\s*[^\\s,;]+", Pattern.CASE_INSENSITIVE)
    )

    // Credit card number pattern (13 to 19 digits, with optional spaces/dashes)
    private val CARD_PATTERN = Pattern.compile(
        "\\b(?:4[0-9]{3}[ -]?[0-9]{4}[ -]?[0-9]{4}[ -]?[0-9]{4}|5[1-5][0-9]{2}[ -]?[0-9]{4}[ -]?[0-9]{4}[ -]?[0-9]{4}|3[47][0-9]{2}[ -]?[0-9]{6}[ -]?[0-9]{5}|(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|3(?:0[0-5]|[68][0-9])[0-9]{11}|6(?:011|5[0-9]{2})[0-9]{12}|(?:2131|1800|35\\d{3})\\d{11}))\\b"
    )

    // OTP pattern: 4-8 digits near words like "otp", "code", "verification", "pin"
    private val OTP_PATTERN = Pattern.compile(
        "\\b(?:otp|code|verification|pin|password)\\s*[:=]?\\s*([0-9]{4,8})\\b",
        Pattern.CASE_INSENSITIVE
    )

    // Standalone 6-digit numeric sequences
    private val STANDALONE_OTP_PATTERN = Pattern.compile(
        "\\b([0-9]{6})\\b"
    )

    /**
     * Checks if a package belongs to the sensitive/banking/auth category.
     */
    fun isSensitivePackage(packageName: String): Boolean {
        val lower = packageName.lowercase().trim()
        if (lower in SENSITIVE_PACKAGES) return true
        if (lower.contains("bank") || lower.contains("pay") || lower.contains("auth") || lower.contains("password")) {
            return true
        }
        return false
    }

    /**
     * Sanitizes arbitrary text by redacting credentials, cards, and OTPs.
     */
    fun sanitizeText(input: String?): String {
        if (input.isNullOrBlank()) return ""
        var text: String = input

        // 1. Redact credentials and tokens
        for (pattern in CREDENTIAL_PATTERNS) {
            text = pattern.matcher(text).replaceAll("[REDACTED_CREDENTIAL]")
        }

        // 2. Redact payment cards
        text = CARD_PATTERN.matcher(text).replaceAll("[REDACTED_CARD]")

        // 3. Redact explicit OTP patterns
        val otpMatcher = OTP_PATTERN.matcher(text)
        val sb = StringBuffer()
        while (otpMatcher.find()) {
            val matched = otpMatcher.group()
            val sanitized = matched.replace(Regex("[0-9]{4,8}"), "[REDACTED_OTP]")
            otpMatcher.appendReplacement(sb, MatcherQuoteReplacement(sanitized))
        }
        otpMatcher.appendTail(sb)
        text = sb.toString()

        // 4. Standalone 6-digit PINs/codes
        text = STANDALONE_OTP_PATTERN.matcher(text).replaceAll("[REDACTED_CODE]")

        return text.trim()
    }

    private fun MatcherQuoteReplacement(s: String): String {
        return java.util.regex.Matcher.quoteReplacement(s)
    }

    /**
     * Sanitizes notification metadata to the minimum necessary non-sensitive snippet.
     * Enforces strict length limits (max 80 chars title, 140 chars snippet).
     */
    fun sanitizeNotification(
        id: String,
        packageName: String,
        appName: String,
        category: String,
        rawTitle: String?,
        rawText: String?,
        postTimeMs: Long,
        priority: String
    ): NotificationContextItem {
        // If from a sensitive package, shield entirely
        if (isSensitivePackage(packageName)) {
            return NotificationContextItem(
                id               = id,
                packageName      = packageName,
                appName          = appName,
                category         = "sensitive",
                title            = "[SHIELDED]",
                sanitizedSnippet = "[CONTENT_SHIELDED_FOR_PRIVACY]",
                postTimeMs       = postTimeMs,
                priority         = priority
            )
        }

        val cleanTitle = sanitizeText(rawTitle).take(80)
        val cleanSnippet = sanitizeText(rawText).take(140)

        return NotificationContextItem(
            id               = id,
            packageName      = packageName,
            appName          = appName,
            category         = category,
            title            = cleanTitle,
            sanitizedSnippet = cleanSnippet,
            postTimeMs       = postTimeMs,
            priority         = priority
        )
    }
}
