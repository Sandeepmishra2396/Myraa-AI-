package com.myraa.companion.capabilities

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.CalendarContract
import android.provider.CalendarContract.Events
import android.util.Log
import java.net.URLEncoder
import java.util.regex.Pattern

/**
 * AppCapabilityAdapter
 * Phase 21 — Mobile App Interaction Layer
 *
 * Executes controlled interactions with MYRAA-supported Android apps via:
 *   1. Official Android Intents (ACTION_SENDTO, ACTION_VIEW, ACTION_INSERT, ACTION_MAIN)
 *   2. Documented Deep Links (geo:, google.navigation:, mailto:, YouTube URLs,
 *      WhatsApp wa.me/api URLs)
 *   3. Deterministic NOT_SUPPORTED for any action that would require
 *      AccessibilityService, DOM automation, or arbitrary screen interaction.
 *
 * SECURITY INVARIANTS (ABSOLUTE):
 *   • NO AccessibilityService usage
 *   • NO coordinate-based UI clicking, tapping, or scrolling
 *   • NO DOM/WebView JavaScript evaluation on external apps
 *   • NO private API or reverse-engineered app internals
 *   • NO extraction of emails, messages, contacts, or credentials
 *   • Unsupported actions always return NOT_SUPPORTED with a descriptive reason.
 *   • Shell metacharacter injection: all user-supplied strings are strictly encoded.
 *   • Credential patterns are scanned and blocked before any intent is fired.
 */
class AppCapabilityAdapter(private val context: Context) {

    companion object {
        private const val TAG = "AppCapabilityAdapter"

        // Maximum field lengths to prevent abuse
        private const val MAX_QUERY_LEN  = 500
        private const val MAX_SUBJECT_LEN = 500
        private const val MAX_BODY_LEN   = 2000
        private const val MAX_TEXT_LEN   = 2000

        // Credential patterns — must never appear in Intent arguments
        private val CREDENTIAL_PATTERNS = listOf(
            "sora_dev_", "myraa_at_", "Bearer ", "sk-", "AIza",
            "password=", "token=", "secret=", "api_key="
        )

        // Simple email regex (RFC 5322-ish, non-exhaustive but sufficient for user input)
        private val EMAIL_REGEX = Pattern.compile(
            "^[A-Za-z0-9+_.-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}$"
        )

        // E.164 phone loosely: optional + then 7-15 digits / spaces / dashes
        private val PHONE_REGEX = Pattern.compile(
            "^\\+?[0-9][0-9 \\-]{6,18}[0-9]$"
        )

        // Navigation modes for Google Maps
        private val ALLOWED_NAV_MODES = setOf("d", "w", "b", "two-wheel")
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Dispatch entry point
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Execute an app interaction.
     * Called by [AppCapabilityRegistry] after validating (app, action) pair.
     */
    fun interactApp(app: String, action: String, args: Map<String, Any?>): AppInteractionResult {
        return when (app) {
            SupportedApps.GMAIL    -> executeGmail(action, args)
            SupportedApps.MAPS     -> executeMaps(action, args)
            SupportedApps.YOUTUBE  -> executeYouTube(action, args)
            SupportedApps.CALENDAR -> executeCalendar(action, args)
            SupportedApps.WHATSAPP -> executeWhatsApp(action, args)
            else -> AppInteractionResult.notSupported(
                app    = app,
                action = action,
                reason = "App '$app' is not in the controlled execution registry."
            )
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Gmail
    // ─────────────────────────────────────────────────────────────────────────

    private fun executeGmail(action: String, args: Map<String, Any?>): AppInteractionResult {
        val pkg = SupportedApps.PACKAGE_MAP[SupportedApps.GMAIL]!!
        return when (action) {

            "launch", "view" -> {
                launchApp(SupportedApps.GMAIL, pkg)
                    ?: AppInteractionResult.appNotInstalled(SupportedApps.GMAIL, action, pkg)
            }

            "compose" -> {
                val recipient = args["recipient"]?.toString()?.trim()
                val subject   = args["subject"]?.toString()?.trim()
                val body      = args["body"]?.toString()?.trim()
                    ?: args["text"]?.toString()?.trim()

                // Validate recipient
                if (!recipient.isNullOrBlank() && !EMAIL_REGEX.matcher(recipient).matches()) {
                    return AppInteractionResult.argumentViolation(
                        SupportedApps.GMAIL, action,
                        "Invalid email address format: '$recipient'."
                    )
                }

                // Credential scan
                val allText = listOf(recipient, subject, body).filterNotNull().joinToString(" ")
                credentialScan(SupportedApps.GMAIL, action, allText)?.let { return it }

                // Length guards
                if ((subject?.length ?: 0) > MAX_SUBJECT_LEN)
                    return AppInteractionResult.argumentViolation(SupportedApps.GMAIL, action, "Subject exceeds $MAX_SUBJECT_LEN characters.")
                if ((body?.length ?: 0) > MAX_BODY_LEN)
                    return AppInteractionResult.argumentViolation(SupportedApps.GMAIL, action, "Email body exceeds $MAX_BODY_LEN characters.")

                try {
                    val mailtoUri = "mailto:${recipient?.let { URLEncoder.encode(it, "UTF-8").replace("+", "%20") } ?: ""}"
                    val intent = Intent(Intent.ACTION_SENDTO, Uri.parse(mailtoUri)).apply {
                        if (!subject.isNullOrBlank()) putExtra(Intent.EXTRA_SUBJECT, subject)
                        if (!body.isNullOrBlank())    putExtra(Intent.EXTRA_TEXT, body)
                        setPackage(pkg)
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                    context.startActivity(intent)
                    AppInteractionResult.success(
                        app             = SupportedApps.GMAIL,
                        action          = action,
                        interactionType = "INTENT",
                        uriOrIntent     = "ACTION_SENDTO:mailto:${recipient ?: ""}",
                        result          = mapOf(
                            "launched"  to true,
                            "recipient" to (recipient ?: ""),
                            "subject"   to (subject ?: "")
                        )
                    )
                } catch (e: Exception) {
                    Log.e(TAG, "Gmail compose error: ${e.message}", e)
                    AppInteractionResult.executionError(SupportedApps.GMAIL, action, e.message ?: "Intent launch failed")
                }
            }

            else -> AppInteractionResult.notSupported(SupportedApps.GMAIL, action,
                "Action '$action' is not supported for Gmail. Use: launch, compose, view.")
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Google Maps
    // ─────────────────────────────────────────────────────────────────────────

    private fun executeMaps(action: String, args: Map<String, Any?>): AppInteractionResult {
        val pkg = SupportedApps.PACKAGE_MAP[SupportedApps.MAPS]!!
        return when (action) {

            "launch" -> {
                launchApp(SupportedApps.MAPS, pkg)
                    ?: AppInteractionResult.appNotInstalled(SupportedApps.MAPS, action, pkg)
            }

            "search" -> {
                val query = args["query"]?.toString()?.trim()
                    ?: return AppInteractionResult.argumentViolation(SupportedApps.MAPS, action, "Missing required argument: 'query'.")
                if (query.isBlank()) return AppInteractionResult.argumentViolation(SupportedApps.MAPS, action, "Query cannot be empty.")
                if (query.length > MAX_QUERY_LEN) return AppInteractionResult.argumentViolation(SupportedApps.MAPS, action, "Query exceeds $MAX_QUERY_LEN characters.")
                credentialScan(SupportedApps.MAPS, action, query)?.let { return it }

                val encoded = URLEncoder.encode(query, "UTF-8")
                val uri     = "geo:0,0?q=$encoded"
                try {
                    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(uri)).apply {
                        setPackage(pkg)
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                    context.startActivity(intent)
                    AppInteractionResult.success(
                        SupportedApps.MAPS, action, "DEEP_LINK", uri,
                        mapOf("launched" to true, "query" to query)
                    )
                } catch (e: Exception) {
                    Log.e(TAG, "Maps search error: ${e.message}", e)
                    AppInteractionResult.executionError(SupportedApps.MAPS, action, e.message ?: "Intent launch failed")
                }
            }

            "directions" -> {
                val destination = args["destination"]?.toString()?.trim()
                    ?: return AppInteractionResult.argumentViolation(SupportedApps.MAPS, action, "Missing required argument: 'destination'.")
                if (destination.isBlank()) return AppInteractionResult.argumentViolation(SupportedApps.MAPS, action, "Destination cannot be empty.")
                if (destination.length > MAX_QUERY_LEN) return AppInteractionResult.argumentViolation(SupportedApps.MAPS, action, "Destination exceeds $MAX_QUERY_LEN characters.")
                credentialScan(SupportedApps.MAPS, action, destination)?.let { return it }

                val rawMode = args["mode"]?.toString()?.trim()?.lowercase() ?: "d"
                val mode = if (rawMode in ALLOWED_NAV_MODES) rawMode else "d"
                val encoded = URLEncoder.encode(destination, "UTF-8")
                val uri = "google.navigation:q=$encoded&mode=$mode"

                try {
                    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(uri)).apply {
                        setPackage(pkg)
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                    context.startActivity(intent)
                    AppInteractionResult.success(
                        SupportedApps.MAPS, action, "DEEP_LINK", uri,
                        mapOf("launched" to true, "destination" to destination, "mode" to mode)
                    )
                } catch (e: Exception) {
                    Log.e(TAG, "Maps directions error: ${e.message}", e)
                    AppInteractionResult.executionError(SupportedApps.MAPS, action, e.message ?: "Intent launch failed")
                }
            }

            "navigation" -> {
                // Alias for directions with mode "d" (driving)
                return executeMaps("directions", args + mapOf("mode" to (args["mode"]?.toString() ?: "d")))
            }

            else -> AppInteractionResult.notSupported(SupportedApps.MAPS, action,
                "Action '$action' is not supported for Google Maps. Use: launch, search, directions, navigation.")
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // YouTube
    // ─────────────────────────────────────────────────────────────────────────

    private fun executeYouTube(action: String, args: Map<String, Any?>): AppInteractionResult {
        val pkg = SupportedApps.PACKAGE_MAP[SupportedApps.YOUTUBE]!!
        return when (action) {

            "launch" -> {
                launchApp(SupportedApps.YOUTUBE, pkg)
                    ?: AppInteractionResult.appNotInstalled(SupportedApps.YOUTUBE, action, pkg)
            }

            "search" -> {
                val query = args["query"]?.toString()?.trim()
                    ?: return AppInteractionResult.argumentViolation(SupportedApps.YOUTUBE, action, "Missing required argument: 'query'.")
                if (query.isBlank()) return AppInteractionResult.argumentViolation(SupportedApps.YOUTUBE, action, "Query cannot be empty.")
                if (query.length > MAX_QUERY_LEN) return AppInteractionResult.argumentViolation(SupportedApps.YOUTUBE, action, "Query exceeds $MAX_QUERY_LEN characters.")
                credentialScan(SupportedApps.YOUTUBE, action, query)?.let { return it }

                val encoded = URLEncoder.encode(query, "UTF-8")
                val searchUrl = "https://www.youtube.com/results?search_query=$encoded"
                try {
                    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(searchUrl)).apply {
                        setPackage(pkg)
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                    context.startActivity(intent)
                    AppInteractionResult.success(
                        SupportedApps.YOUTUBE, action, "DEEP_LINK", searchUrl,
                        mapOf("launched" to true, "query" to query, "url" to searchUrl)
                    )
                } catch (e: Exception) {
                    Log.e(TAG, "YouTube search error: ${e.message}", e)
                    AppInteractionResult.executionError(SupportedApps.YOUTUBE, action, e.message ?: "Intent launch failed")
                }
            }

            "watch" -> {
                val videoId = args["videoId"]?.toString()?.trim()
                    ?: return AppInteractionResult.argumentViolation(SupportedApps.YOUTUBE, action, "Missing required argument: 'videoId'.")
                if (videoId.isBlank()) return AppInteractionResult.argumentViolation(SupportedApps.YOUTUBE, action, "videoId cannot be empty.")
                // Video IDs are alphanumeric + _ -, 11 chars
                if (!videoId.matches(Regex("[A-Za-z0-9_\\-]{1,20}"))) {
                    return AppInteractionResult.argumentViolation(SupportedApps.YOUTUBE, action, "Invalid YouTube video ID format: '$videoId'.")
                }
                credentialScan(SupportedApps.YOUTUBE, action, videoId)?.let { return it }

                val watchUrl = "https://www.youtube.com/watch?v=$videoId"
                try {
                    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(watchUrl)).apply {
                        setPackage(pkg)
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                    context.startActivity(intent)
                    AppInteractionResult.success(
                        SupportedApps.YOUTUBE, action, "DEEP_LINK", watchUrl,
                        mapOf("launched" to true, "videoId" to videoId, "url" to watchUrl)
                    )
                } catch (e: Exception) {
                    Log.e(TAG, "YouTube watch error: ${e.message}", e)
                    AppInteractionResult.executionError(SupportedApps.YOUTUBE, action, e.message ?: "Intent launch failed")
                }
            }

            else -> AppInteractionResult.notSupported(SupportedApps.YOUTUBE, action,
                "Action '$action' is not supported for YouTube. Use: launch, search, watch.")
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Google Calendar
    // ─────────────────────────────────────────────────────────────────────────

    private fun executeCalendar(action: String, args: Map<String, Any?>): AppInteractionResult {
        val pkg = SupportedApps.PACKAGE_MAP[SupportedApps.CALENDAR]!!
        return when (action) {

            "launch" -> {
                launchApp(SupportedApps.CALENDAR, pkg)
                    ?: AppInteractionResult.appNotInstalled(SupportedApps.CALENDAR, action, pkg)
            }

            "view" -> {
                try {
                    val intent = Intent(Intent.ACTION_VIEW, CalendarContract.CONTENT_URI).apply {
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        setPackage(pkg)
                    }
                    context.startActivity(intent)
                    AppInteractionResult.success(
                        SupportedApps.CALENDAR, action, "INTENT",
                        "CalendarContract.CONTENT_URI",
                        mapOf("launched" to true)
                    )
                } catch (e: Exception) {
                    // Fall back to basic launch
                    Log.w(TAG, "Calendar view fallback to launch: ${e.message}")
                    launchApp(SupportedApps.CALENDAR, pkg)
                        ?: AppInteractionResult.appNotInstalled(SupportedApps.CALENDAR, action, pkg)
                }
            }

            "insert_event" -> {
                val title = args["title"]?.toString()?.trim()
                    ?: return AppInteractionResult.argumentViolation(SupportedApps.CALENDAR, action, "Missing required argument: 'title'.")
                if (title.isBlank()) return AppInteractionResult.argumentViolation(SupportedApps.CALENDAR, action, "Event title cannot be empty.")
                if (title.length > MAX_SUBJECT_LEN) return AppInteractionResult.argumentViolation(SupportedApps.CALENDAR, action, "Event title exceeds $MAX_SUBJECT_LEN characters.")

                val description  = args["description"]?.toString()?.trim()
                val startTimeMs  = args["startTimeMs"]?.toString()?.toLongOrNull()
                val endTimeMs    = args["endTimeMs"]?.toString()?.toLongOrNull()

                val allText = listOf(title, description).filterNotNull().joinToString(" ")
                credentialScan(SupportedApps.CALENDAR, action, allText)?.let { return it }

                if ((description?.length ?: 0) > MAX_BODY_LEN)
                    return AppInteractionResult.argumentViolation(SupportedApps.CALENDAR, action, "Description exceeds $MAX_BODY_LEN characters.")

                try {
                    val intent = Intent(Intent.ACTION_INSERT, Events.CONTENT_URI).apply {
                        putExtra(CalendarContract.Events.TITLE, title)
                        if (!description.isNullOrBlank())
                            putExtra(CalendarContract.Events.DESCRIPTION, description)
                        if (startTimeMs != null)
                            putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, startTimeMs)
                        if (endTimeMs != null)
                            putExtra(CalendarContract.EXTRA_EVENT_END_TIME, endTimeMs)
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        setPackage(pkg)
                    }
                    context.startActivity(intent)
                    AppInteractionResult.success(
                        SupportedApps.CALENDAR, action, "INTENT",
                        "ACTION_INSERT:Events.CONTENT_URI",
                        mapOf(
                            "launched"    to true,
                            "title"       to title,
                            "startTimeMs" to (startTimeMs ?: 0L),
                            "endTimeMs"   to (endTimeMs ?: 0L)
                        )
                    )
                } catch (e: Exception) {
                    Log.e(TAG, "Calendar insert_event error: ${e.message}", e)
                    AppInteractionResult.executionError(SupportedApps.CALENDAR, action, e.message ?: "Intent launch failed")
                }
            }

            else -> AppInteractionResult.notSupported(SupportedApps.CALENDAR, action,
                "Action '$action' is not supported for Google Calendar. Use: launch, view, insert_event.")
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // WhatsApp
    // ─────────────────────────────────────────────────────────────────────────

    private fun executeWhatsApp(action: String, args: Map<String, Any?>): AppInteractionResult {
        val pkg = SupportedApps.PACKAGE_MAP[SupportedApps.WHATSAPP]!!
        return when (action) {

            "launch", "view" -> {
                launchApp(SupportedApps.WHATSAPP, pkg)
                    ?: AppInteractionResult.appNotInstalled(SupportedApps.WHATSAPP, action, pkg)
            }

            "compose_message" -> {
                val phone = args["phone"]?.toString()?.trim()
                    ?: return AppInteractionResult.argumentViolation(SupportedApps.WHATSAPP, action, "Missing required argument: 'phone'.")
                val text  = args["text"]?.toString()?.trim()

                // Validate phone number
                val cleanPhone = phone.replace("[\\s\\-]".toRegex(), "")
                if (!PHONE_REGEX.matcher(cleanPhone).matches()) {
                    return AppInteractionResult.argumentViolation(
                        SupportedApps.WHATSAPP, action,
                        "Invalid phone number format: '$phone'. Expected E.164 or local format with country code."
                    )
                }

                // Length guard
                if ((text?.length ?: 0) > MAX_TEXT_LEN)
                    return AppInteractionResult.argumentViolation(SupportedApps.WHATSAPP, action, "Message text exceeds $MAX_TEXT_LEN characters.")

                // Credential scan
                val allText = listOf(phone, text).filterNotNull().joinToString(" ")
                credentialScan(SupportedApps.WHATSAPP, action, allText)?.let { return it }

                // Digits only for the API URL
                val digitsOnly = cleanPhone.replace("+", "")
                val encodedText = if (!text.isNullOrBlank()) URLEncoder.encode(text, "UTF-8") else null
                val waUrl = if (encodedText != null)
                    "https://api.whatsapp.com/send?phone=$digitsOnly&text=$encodedText"
                else
                    "https://api.whatsapp.com/send?phone=$digitsOnly"

                try {
                    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(waUrl)).apply {
                        setPackage(pkg)
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                    context.startActivity(intent)
                    AppInteractionResult.success(
                        SupportedApps.WHATSAPP, action, "DEEP_LINK", waUrl,
                        mapOf(
                            "launched"  to true,
                            "phone"     to phone,
                            "hasText"   to !text.isNullOrBlank()
                        )
                    )
                } catch (e: Exception) {
                    Log.e(TAG, "WhatsApp compose_message error: ${e.message}", e)
                    AppInteractionResult.executionError(SupportedApps.WHATSAPP, action, e.message ?: "Intent launch failed")
                }
            }

            else -> AppInteractionResult.notSupported(SupportedApps.WHATSAPP, action,
                "Action '$action' is not supported for WhatsApp. Use: launch, compose_message, view.")
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internal helpers
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Launch an app by package name via the standard PackageManager launch intent.
     * Returns null (not an error result) if the app is not installed.
     */
    private fun launchApp(appId: String, packageName: String): AppInteractionResult? {
        return try {
            val pm     = context.packageManager
            val intent = pm.getLaunchIntentForPackage(packageName)
                ?: return null  // Not installed — caller decides the error
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
            AppInteractionResult.success(
                app             = appId,
                action          = "launch",
                interactionType = "INTENT",
                uriOrIntent     = "getLaunchIntentForPackage:$packageName",
                result          = mapOf("launched" to true, "package" to packageName)
            )
        } catch (e: Exception) {
            Log.e(TAG, "launchApp error for package '$packageName': ${e.message}", e)
            null
        }
    }

    /**
     * Scan text for credential patterns that must never appear in Intent arguments.
     * Returns a security violation result if any pattern is found, null otherwise.
     */
    private fun credentialScan(app: String, action: String, text: String): AppInteractionResult? {
        for (pattern in CREDENTIAL_PATTERNS) {
            if (text.contains(pattern, ignoreCase = true)) {
                Log.w(TAG, "Credential pattern '$pattern' detected in app interaction '$app/$action'")
                return AppInteractionResult.securityViolation(
                    app, action,
                    "Arguments contain a prohibited credential or token pattern. Sensitive credentials cannot be sent via app interactions."
                )
            }
        }
        return null
    }
}
