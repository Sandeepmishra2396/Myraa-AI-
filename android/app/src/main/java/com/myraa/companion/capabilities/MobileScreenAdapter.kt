package com.myraa.companion.capabilities

import android.content.Context
import android.util.Log

/**
 * MobileScreenAdapter
 * Phase 23 — Mobile Screen Understanding
 *
 * Implements Android-side permission-gated screen understanding:
 *   1. Screen understanding is DISABLED BY DEFAULT. Requires explicit user approval.
 *   2. Privacy Shield check: Banking, payment, password managers, and authenticators fail closed.
 *   3. Uncertain context fails closed.
 *   4. Zero raw frame persistence: Processing exists purely in volatile memory.
 *   5. Local DLP redaction for passwords, tokens, cards, and OTPs.
 */
class MobileScreenAdapter(
    private val context: Context,
    private val contextAdapter: MobileContextAdapter = MobileContextAdapter(context)
) {
    companion object {
        private const val TAG = "MobileScreenAdapter"
    }

    /**
     * Executes permission-gated screen capture & understanding.
     */
    fun processScreenCapture(request: MobileScreenCaptureRequest): MobileScreenCaptureResult {
        // 1. Explicit User Approval Gate (Disabled by default)
        if (!request.approved) {
            return MobileScreenCaptureResult.notApproved()
        }

        // 2. Pre-flight Privacy Shield Check (Sensitive App & Uncertain Detection)
        val currentApp = contextAdapter.getCurrentApp()

        if (currentApp.isSensitive) {
            val pkg = currentApp.packageName.lowercase()
            val reason = when {
                pkg.contains("bank") || pkg.contains("paisa") || pkg.contains("paytm") || pkg.contains("phonepe") ->
                    ScreenShieldReason.BANKING_APP
                pkg.contains("pass") || pkg.contains("bitwarden") || pkg.contains("dashlane") ->
                    ScreenShieldReason.PASSWORD_MANAGER
                pkg.contains("auth") ->
                    ScreenShieldReason.AUTH_OTP
                else ->
                    ScreenShieldReason.SENSITIVE_APP
            }
            return MobileScreenCaptureResult.shielded(
                reason = reason,
                description = "Screen understanding automatically shielded: sensitive application active (${currentApp.packageName})."
            )
        }

        // Uncertain Context Check (Fails closed)
        if (!currentApp.isAvailable) {
            return MobileScreenCaptureResult.shielded(
                reason = ScreenShieldReason.UNCERTAIN_CONTEXT,
                description = "Screen understanding automatically shielded: foreground app state is uncertain or undetectable."
            )
        }

        // 3. Volatile In-Memory Processing & Local DLP Sanitization
        val rawText = request.screenSummary ?: ""
        if (rawText.isBlank()) {
            return MobileScreenCaptureResult.success(
                ocrSummary    = "[NO_TEXT_DETECTED]",
                visualSummary = "Active Application: ${currentApp.appName} (${currentApp.packageName})",
                fusedContext  = "Screen content: [No readable text] | App: ${currentApp.appName}"
            )
        }

        // Apply local DLP redaction
        val sanitized = MobileContextSanitizer.sanitizeText(rawText)

        // Structure OCR and Visual Summaries
        val ocrSummary = sanitized
        val visualSummary = "Active Application: ${currentApp.appName} | Screen Layout: General Activity"
        val fusedContext = "App: ${currentApp.appName} | Screen Content: \"$sanitized\""

        return MobileScreenCaptureResult.success(
            ocrSummary    = ocrSummary,
            visualSummary = visualSummary,
            fusedContext  = fusedContext
        )
    }
}
