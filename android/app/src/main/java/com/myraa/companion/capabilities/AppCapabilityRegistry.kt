package com.myraa.companion.capabilities

import android.util.Log

/**
 * AppCapabilityRegistry
 * Phase 21 — Mobile App Interaction Layer
 *
 * Central catalog and validator for controlled app interactions.
 * Determines whether a requested (app, action) pair is supported and
 * routes to AppCapabilityAdapter for execution.
 *
 * SECURITY BOUNDARY:
 *  - Only interactions listed in SupportedApps.ALLOWED_ACTIONS are permitted.
 *  - Unsupported apps or unsupported actions always return NOT_SUPPORTED.
 *  - NO AccessibilityService, UI coordinate clicking, or DOM automation.
 */
class AppCapabilityRegistry(
    private val adapter: AppCapabilityAdapter
) {
    companion object {
        private const val TAG = "AppCapabilityRegistry"
    }

    /**
     * Execute an app interaction.
     *
     * @param rawApp    Raw app name (e.g. "Gmail", "google maps", "yt")
     * @param rawAction Raw action (e.g. "open", "compose", "search")
     * @param args      JSON-decoded argument map
     * @return          AppInteractionResult (success or structured NOT_SUPPORTED/error)
     */
    fun execute(rawApp: String, rawAction: String, args: Map<String, Any?>): AppInteractionResult {
        Log.i(TAG, "Executing app interaction: app='$rawApp' action='$rawAction'")

        // ── 1. Resolve app ID ──────────────────────────────────────────────
        val appId = SupportedApps.resolveApp(rawApp)
        if (appId == null) {
            Log.w(TAG, "Unsupported app requested: '$rawApp'")
            return AppInteractionResult.notSupported(
                app    = rawApp,
                action = rawAction,
                reason = "App '$rawApp' is not in the MYRAA supported app registry. " +
                         "Supported apps: Gmail, Google Maps, YouTube, Google Calendar, WhatsApp."
            )
        }

        // ── 2. Resolve action ──────────────────────────────────────────────
        val action = SupportedApps.resolveAction(appId, rawAction)
        if (action == null) {
            val allowed = SupportedApps.ALLOWED_ACTIONS[appId]?.joinToString(", ") ?: "none"
            Log.w(TAG, "Unsupported action '$rawAction' for app '$appId'")
            return AppInteractionResult.notSupported(
                app    = appId,
                action = rawAction,
                reason = "Action '$rawAction' is not supported for ${SupportedApps.DISPLAY_NAMES[appId]}. " +
                         "Supported actions: $allowed."
            )
        }

        Log.i(TAG, "Dispatching: app='$appId' action='$action'")

        // ── 3. Delegate to adapter ─────────────────────────────────────────
        return try {
            adapter.interactApp(appId, action, args)
        } catch (e: Exception) {
            Log.e(TAG, "Exception during app interaction '$appId/$action': ${e.message}", e)
            AppInteractionResult.executionError(appId, action, e.message ?: "Unknown error")
        }
    }

    /**
     * Check whether a given (app, action) pair is supported.
     * Used for capability introspection by the server side.
     */
    fun isSupported(rawApp: String, rawAction: String): Boolean {
        val appId  = SupportedApps.resolveApp(rawApp)   ?: return false
        val action = SupportedApps.resolveAction(appId, rawAction) ?: return false
        return true
    }

    /**
     * Return the list of supported apps and their allowed actions.
     * Informational only — never used for security decisions.
     */
    fun getSupportedAppDescriptors(): List<Map<String, Any>> {
        return SupportedApps.ALL.mapNotNull { appId ->
            val actions = SupportedApps.ALLOWED_ACTIONS[appId] ?: return@mapNotNull null
            val pkg     = SupportedApps.PACKAGE_MAP[appId]     ?: return@mapNotNull null
            mapOf(
                "appId"          to appId,
                "displayName"    to (SupportedApps.DISPLAY_NAMES[appId] ?: appId),
                "packageName"    to pkg,
                "allowedActions" to actions.toList()
            )
        }
    }
}
