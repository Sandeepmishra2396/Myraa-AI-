package com.myraa.companion.capabilities

import org.json.JSONObject

// ---------------------------------------------------------------------------
// Phase 21 — Mobile App Interaction Layer
// Data models and constants for controlled supported-app interactions.
// ---------------------------------------------------------------------------

/**
 * Supported app identifiers (canonical IDs).
 * These are the ONLY apps MYRAA may interact with in Phase 21.
 */
object SupportedApps {
    const val GMAIL     = "gmail"
    const val MAPS      = "maps"
    const val YOUTUBE   = "youtube"
    const val CALENDAR  = "calendar"
    const val WHATSAPP  = "whatsapp"

    /** Full set of supported app IDs for fast membership test. */
    val ALL = setOf(GMAIL, MAPS, YOUTUBE, CALENDAR, WHATSAPP)

    /** Package names per supported app. */
    val PACKAGE_MAP = mapOf(
        GMAIL     to "com.google.android.gm",
        MAPS      to "com.google.android.apps.maps",
        YOUTUBE   to "com.google.android.youtube",
        CALENDAR  to "com.google.android.calendar",
        WHATSAPP  to "com.whatsapp"
    )

    /** Allowed actions per supported app. */
    val ALLOWED_ACTIONS = mapOf(
        GMAIL     to setOf("launch", "compose", "view"),
        MAPS      to setOf("launch", "search", "directions", "navigation"),
        YOUTUBE   to setOf("launch", "search", "watch"),
        CALENDAR  to setOf("launch", "view", "insert_event"),
        WHATSAPP  to setOf("launch", "compose_message", "view")
    )

    /** Display names for voice responses. */
    val DISPLAY_NAMES = mapOf(
        GMAIL     to "Gmail",
        MAPS      to "Google Maps",
        YOUTUBE   to "YouTube",
        CALENDAR  to "Google Calendar",
        WHATSAPP  to "WhatsApp"
    )

    /** Risk level per app action. LOW = navigation/view, MEDIUM = write/send. */
    val ACTION_RISK = mapOf(
        "$GMAIL:launch"           to "LOW",
        "$GMAIL:view"             to "LOW",
        "$GMAIL:compose"          to "MEDIUM",
        "$MAPS:launch"            to "LOW",
        "$MAPS:search"            to "LOW",
        "$MAPS:directions"        to "LOW",
        "$MAPS:navigation"        to "LOW",
        "$YOUTUBE:launch"         to "LOW",
        "$YOUTUBE:search"         to "LOW",
        "$YOUTUBE:watch"          to "LOW",
        "$CALENDAR:launch"        to "LOW",
        "$CALENDAR:view"          to "LOW",
        "$CALENDAR:insert_event"  to "MEDIUM",
        "$WHATSAPP:launch"        to "LOW",
        "$WHATSAPP:view"          to "LOW",
        "$WHATSAPP:compose_message" to "MEDIUM"
    )

    /**
     * Canonical alias resolver.
     * Maps user-friendly/variant app names → canonical ID.
     */
    fun resolveApp(raw: String): String? {
        val normalized = raw.trim().lowercase()
        return when (normalized) {
            "gmail", "mail", "google mail", "email"                    -> GMAIL
            "maps", "google maps", "gmap", "gmaps"                     -> MAPS
            "youtube", "yt", "you tube"                                -> YOUTUBE
            "calendar", "google calendar", "gcal", "cal"               -> CALENDAR
            "whatsapp", "wa", "whats app", "whatsapp messenger"        -> WHATSAPP
            else -> null
        }
    }

    /**
     * Canonical action resolver.
     * Maps variant action strings → normalized action.
     */
    fun resolveAction(app: String, rawAction: String): String? {
        val normalized = rawAction.trim().lowercase()
        val allowed = ALLOWED_ACTIONS[app] ?: return null
        // Direct match
        if (normalized in allowed) return normalized
        // Alias matching
        val mapped = when (normalized) {
            "open", "start", "run"             -> "launch"
            "email", "new email", "send email",
            "new mail", "draft"                -> "compose"
            "inbox", "show"                    -> "view"
            "find", "query", "lookup"           -> "search"
            "nav", "navigate", "go to",
            "get directions", "route"           -> if (app == MAPS) "directions" else null
            "drive to", "navigate to"           -> if (app == MAPS) "navigation" else null
            "play", "open video"               -> if (app == YOUTUBE) "watch" else null
            "add event", "create event",
            "new event", "schedule"            -> if (app == CALENDAR) "insert_event" else null
            "message", "send message",
            "chat", "text"                     -> if (app == WHATSAPP) "compose_message" else null
            else                               -> null
        }
        return mapped?.takeIf { it in allowed }
    }
}

// ---------------------------------------------------------------------------
// Error codes for structured NOT_SUPPORTED and validation results
// ---------------------------------------------------------------------------

object AppInteractionErrorCodes {
    const val NOT_SUPPORTED       = "NOT_SUPPORTED"
    const val APP_NOT_INSTALLED   = "APP_NOT_INSTALLED"
    const val APP_NOT_FOUND       = "APP_NOT_FOUND"
    const val ARGUMENT_VIOLATION  = "ARGUMENT_VIOLATION"
    const val SECURITY_VIOLATION  = "SECURITY_VIOLATION"
    const val EXECUTION_ERROR     = "EXECUTION_ERROR"
}

// ---------------------------------------------------------------------------
// Result type for App Capability interactions
// ---------------------------------------------------------------------------

data class AppInteractionResult(
    val success: Boolean,
    val app: String,
    val action: String,
    val interactionType: String = "INTENT",
    val uriOrIntent: String? = null,
    val result: Any? = null,
    val error: String? = null,
    val errorCode: String? = null
) {
    fun toMap(): Map<String, Any?> {
        val map = mutableMapOf<String, Any?>(
            "success"         to success,
            "app"             to app,
            "action"          to action,
            "interactionType" to interactionType
        )
        if (uriOrIntent != null) map["uriOrIntent"] = uriOrIntent
        if (result != null)      map["result"]      = result
        if (error != null)       map["error"]       = error
        if (errorCode != null)   map["errorCode"]   = errorCode
        return map
    }

    fun toJsonObject(): JSONObject {
        val json = JSONObject()
        json.put("success", success)
        json.put("app", app)
        json.put("action", action)
        json.put("interactionType", interactionType)
        if (uriOrIntent != null) json.put("uriOrIntent", uriOrIntent)
        if (result != null)      json.put("result", result)
        if (error != null)       json.put("error", error)
        if (errorCode != null)   json.put("errorCode", errorCode)
        return json
    }

    companion object {
        fun success(app: String, action: String, interactionType: String = "INTENT", uriOrIntent: String? = null, result: Any? = null): AppInteractionResult =
            AppInteractionResult(success = true, app = app, action = action, interactionType = interactionType, uriOrIntent = uriOrIntent, result = result)

        fun notSupported(app: String, action: String, reason: String): AppInteractionResult =
            AppInteractionResult(
                success = false,
                app = app,
                action = action,
                error = "NOT_SUPPORTED: $reason",
                errorCode = AppInteractionErrorCodes.NOT_SUPPORTED
            )

        fun appNotInstalled(app: String, action: String, packageName: String): AppInteractionResult =
            AppInteractionResult(
                success = false,
                app = app,
                action = action,
                error = "APP_NOT_INSTALLED: ${SupportedApps.DISPLAY_NAMES[app] ?: app} (package: $packageName) is not installed on this device.",
                errorCode = AppInteractionErrorCodes.APP_NOT_INSTALLED
            )

        fun argumentViolation(app: String, action: String, reason: String): AppInteractionResult =
            AppInteractionResult(
                success = false,
                app = app,
                action = action,
                error = "ARGUMENT_VIOLATION: $reason",
                errorCode = AppInteractionErrorCodes.ARGUMENT_VIOLATION
            )

        fun securityViolation(app: String, action: String, reason: String): AppInteractionResult =
            AppInteractionResult(
                success = false,
                app = app,
                action = action,
                error = "SECURITY_VIOLATION: $reason",
                errorCode = AppInteractionErrorCodes.SECURITY_VIOLATION
            )

        fun executionError(app: String, action: String, message: String): AppInteractionResult =
            AppInteractionResult(
                success = false,
                app = app,
                action = action,
                error = "EXECUTION_ERROR: $message",
                errorCode = AppInteractionErrorCodes.EXECUTION_ERROR
            )
    }
}
