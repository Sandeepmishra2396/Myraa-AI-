package com.myraa.companion.capabilities

import org.json.JSONObject

// ---------------------------------------------------------------------------
// Phase 23 — Mobile Screen Understanding Data Models
// ---------------------------------------------------------------------------

/**
 * Standard reasons why a mobile screen capture/understanding request is shielded or blocked.
 */
object ScreenShieldReason {
    const val USER_NOT_APPROVED    = "USER_NOT_APPROVED"
    const val SENSITIVE_APP        = "SENSITIVE_APP"
    const val BANKING_APP          = "BANKING_APP"
    const val PASSWORD_MANAGER     = "PASSWORD_MANAGER"
    const val AUTH_OTP             = "AUTH_OTP"
    const val UNCERTAIN_CONTEXT    = "UNCERTAIN_CONTEXT"
    const val EMERGENCY_STOP       = "EMERGENCY_STOP"
    const val LOCKDOWN             = "LOCKDOWN"
    const val CAPTURE_FAILED       = "CAPTURE_FAILED"
}

/**
 * Structured request for mobile screen understanding.
 */
data class MobileScreenCaptureRequest(
    val approved: Boolean = false,
    val captureMode: String = "ocr", // "ocr", "visual", "full"
    val query: String? = null,
    val rawScreenBase64: String? = null,
    val screenSummary: String? = null
)

/**
 * Structured result returned from mobile screen understanding.
 * Guarantees zero raw protected frame retention.
 */
data class MobileScreenCaptureResult(
    val success: Boolean,
    val isApproved: Boolean,
    val isShielded: Boolean,
    val shieldReason: String? = null,
    val ocrSummary: String? = null,
    val visualSummary: String? = null,
    val fusedContext: String? = null,
    val timestamp: Long = System.currentTimeMillis(),
    val error: String? = null,
    val errorCode: String? = null
) {
    fun toMap(): Map<String, Any?> = mapOf(
        "success"       to success,
        "isApproved"    to isApproved,
        "isShielded"    to isShielded,
        "shieldReason"  to shieldReason,
        "ocrSummary"    to ocrSummary,
        "visualSummary" to visualSummary,
        "fusedContext"  to fusedContext,
        "timestamp"     to timestamp,
        "error"         to error,
        "errorCode"     to errorCode
    )

    fun toJsonObject(): JSONObject = JSONObject(toMap())

    companion object {
        fun notApproved(): MobileScreenCaptureResult = MobileScreenCaptureResult(
            success      = false,
            isApproved   = false,
            isShielded   = true,
            shieldReason = ScreenShieldReason.USER_NOT_APPROVED,
            error        = "Screen capture was not approved by user. Screen understanding is disabled by default.",
            errorCode    = "NOT_PERMITTED"
        )

        fun shielded(reason: String, description: String): MobileScreenCaptureResult = MobileScreenCaptureResult(
            success      = false,
            isApproved   = true,
            isShielded   = true,
            shieldReason = reason,
            error        = description,
            errorCode    = "SENSITIVE_SCREEN_SHIELDED"
        )

        fun success(
            ocrSummary: String?,
            visualSummary: String?,
            fusedContext: String?
        ): MobileScreenCaptureResult = MobileScreenCaptureResult(
            success       = true,
            isApproved    = true,
            isShielded    = false,
            ocrSummary    = ocrSummary,
            visualSummary = visualSummary,
            fusedContext  = fusedContext
        )

        fun failure(error: String, code: String = "EXECUTION_ERROR"): MobileScreenCaptureResult = MobileScreenCaptureResult(
            success      = false,
            isApproved   = false,
            isShielded   = false,
            error        = error,
            errorCode    = code
        )
    }
}
