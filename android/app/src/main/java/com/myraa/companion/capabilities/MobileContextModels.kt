package com.myraa.companion.capabilities

import org.json.JSONArray
import org.json.JSONObject

// ---------------------------------------------------------------------------
// Phase 22 — Mobile Context Intelligence Data Models
// Defines typed context structures, permissions, and snapshot containers.
// ---------------------------------------------------------------------------

/**
 * Standard status indicator for unavailable or unpermissioned context fields.
 * NEVER GUESS: Return UNKNOWN or NOT_AVAILABLE if not reliably detectable.
 */
object ContextConstants {
    const val UNKNOWN = "UNKNOWN"
    const val NOT_AVAILABLE = "NOT_AVAILABLE"
    const val NOT_PERMITTED = "NOT_PERMITTED"
    const val SENSITIVE_SHIELDED = "SENSITIVE_SHIELDED"
}

/**
 * Supported context category identifiers for selective querying.
 */
object MobileContextCategories {
    const val APP           = "app"
    const val ACTIVITY      = "activity"
    const val NOTIFICATIONS = "notifications"
    const val DEVICE        = "device"
    const val NETWORK       = "network"
    const val BATTERY       = "battery"
    const val SCREEN        = "screen"
    const val CONVERSATION  = "conversation"
    const val TASK          = "task"

    val ALL = setOf(
        APP, ACTIVITY, NOTIFICATIONS, DEVICE,
        NETWORK, BATTERY, SCREEN, CONVERSATION, TASK
    )
}

/**
 * Current foreground application context.
 */
data class CurrentAppContext(
    val packageName: String = ContextConstants.UNKNOWN,
    val appName: String = ContextConstants.UNKNOWN,
    val category: String = "general",
    val isSensitive: Boolean = false,
    val isAvailable: Boolean = true
) {
    fun toMap(): Map<String, Any?> = mapOf(
        "packageName" to packageName,
        "appName"     to appName,
        "category"    to category,
        "isSensitive" to isSensitive,
        "isAvailable" to isAvailable
    )

    fun toJsonObject(): JSONObject = JSONObject(toMap())

    companion object {
        fun unavailable(): CurrentAppContext = CurrentAppContext(
            packageName = ContextConstants.NOT_AVAILABLE,
            appName     = ContextConstants.NOT_AVAILABLE,
            isAvailable = false
        )

        fun shielded(pkg: String): CurrentAppContext = CurrentAppContext(
            packageName = pkg,
            appName     = ContextConstants.SENSITIVE_SHIELDED,
            category    = "sensitive",
            isSensitive = true,
            isAvailable = true
        )
    }
}

/**
 * Current visible activity / screen context.
 */
data class ActivityContext(
    val activityName: String = ContextConstants.UNKNOWN,
    val screenTitle: String = ContextConstants.UNKNOWN,
    val state: String = "resumed",
    val isAvailable: Boolean = true
) {
    fun toMap(): Map<String, Any?> = mapOf(
        "activityName" to activityName,
        "screenTitle"  to screenTitle,
        "state"        to state,
        "isAvailable"  to isAvailable
    )

    fun toJsonObject(): JSONObject = JSONObject(toMap())

    companion object {
        fun unavailable(): ActivityContext = ActivityContext(
            activityName = ContextConstants.NOT_AVAILABLE,
            screenTitle  = ContextConstants.NOT_AVAILABLE,
            isAvailable  = false
        )
    }
}

/**
 * Minimal sanitized notification metadata.
 * Restricts collection strictly to non-sensitive structural summary.
 */
data class NotificationContextItem(
    val id: String,
    val packageName: String,
    val appName: String,
    val category: String = "general",
    val title: String = "",
    val sanitizedSnippet: String = "",
    val postTimeMs: Long = 0L,
    val priority: String = "normal"
) {
    fun toMap(): Map<String, Any?> = mapOf(
        "id"               to id,
        "packageName"      to packageName,
        "appName"          to appName,
        "category"         to category,
        "title"            to title,
        "sanitizedSnippet" to sanitizedSnippet,
        "postTimeMs"       to postTimeMs,
        "priority"         to priority
    )

    fun toJsonObject(): JSONObject = JSONObject(toMap())
}

/**
 * Hardware, OS, and physical device state.
 */
data class DeviceStateContext(
    val manufacturer: String = ContextConstants.UNKNOWN,
    val model: String = ContextConstants.UNKNOWN,
    val androidVersion: String = ContextConstants.UNKNOWN,
    val sdkInt: Int = 0,
    val orientation: String = "portrait",
    val isScreenOn: Boolean = true,
    val isAvailable: Boolean = true
) {
    fun toMap(): Map<String, Any?> = mapOf(
        "manufacturer"   to manufacturer,
        "model"          to model,
        "androidVersion" to androidVersion,
        "sdkInt"         to sdkInt,
        "orientation"    to orientation,
        "isScreenOn"     to isScreenOn,
        "isAvailable"    to isAvailable
    )

    fun toJsonObject(): JSONObject = JSONObject(toMap())
}

/**
 * Active network connectivity state.
 */
data class NetworkStateContext(
    val isConnected: Boolean = false,
    val type: String = "none", // wifi, cellular, ethernet, none
    val isMetered: Boolean = false,
    val wifiSsid: String? = null,
    val isAvailable: Boolean = true
) {
    fun toMap(): Map<String, Any?> = mapOf(
        "isConnected" to isConnected,
        "type"        to type,
        "isMetered"   to isMetered,
        "wifiSsid"    to (wifiSsid ?: ContextConstants.NOT_AVAILABLE),
        "isAvailable" to isAvailable
    )

    fun toJsonObject(): JSONObject = JSONObject(toMap())
}

/**
 * Battery and charging status.
 */
data class BatteryContext(
    val level: Int = -1,
    val isCharging: Boolean = false,
    val status: String = "discharging", // charging, full, discharging, not_charging
    val isAvailable: Boolean = true
) {
    fun toMap(): Map<String, Any?> = mapOf(
        "level"       to level,
        "isCharging"  to isCharging,
        "status"      to status,
        "isAvailable" to isAvailable
    )

    fun toJsonObject(): JSONObject = JSONObject(toMap())
}

/**
 * User-approved screen context.
 * Strict privacy boundary: Disabled by default. Only populated if user explicitly approves.
 */
data class ScreenContextData(
    val isApproved: Boolean = false,
    val summary: String? = null,
    val capturedAtMs: Long = 0L,
    val isAvailable: Boolean = false
) {
    fun toMap(): Map<String, Any?> = mapOf(
        "isApproved"   to isApproved,
        "summary"      to (summary ?: ContextConstants.NOT_PERMITTED),
        "capturedAtMs" to capturedAtMs,
        "isAvailable"  to isAvailable
    )

    fun toJsonObject(): JSONObject = JSONObject(toMap())

    companion object {
        fun disabled(): ScreenContextData = ScreenContextData(
            isApproved  = false,
            summary     = null,
            isAvailable = false
        )
    }
}

/**
 * Complete consolidated mobile context snapshot.
 */
data class MobileContextSnapshot(
    val timestamp: Long = System.currentTimeMillis(),
    val deviceId: String = "unknown",
    val currentApp: CurrentAppContext = CurrentAppContext.unavailable(),
    val activity: ActivityContext = ActivityContext.unavailable(),
    val notifications: List<NotificationContextItem> = emptyList(),
    val deviceState: DeviceStateContext = DeviceStateContext(),
    val networkState: NetworkStateContext = NetworkStateContext(),
    val battery: BatteryContext = BatteryContext(),
    val screenContext: ScreenContextData = ScreenContextData.disabled(),
    val permissionsGranted: List<String> = emptyList(),
    val fusedSummary: String = "",
    val isSanitized: Boolean = true
) {
    fun toMap(): Map<String, Any?> = mapOf(
        "timestamp"          to timestamp,
        "deviceId"           to deviceId,
        "currentApp"         to currentApp.toMap(),
        "activity"           to activity.toMap(),
        "notifications"      to notifications.map { it.toMap() },
        "deviceState"        to deviceState.toMap(),
        "networkState"       to networkState.toMap(),
        "battery"            to battery.toMap(),
        "screenContext"      to screenContext.toMap(),
        "permissionsGranted" to permissionsGranted,
        "fusedSummary"       to fusedSummary,
        "isSanitized"        to isSanitized
    )

    fun toJsonObject(): JSONObject {
        val json = JSONObject()
        json.put("timestamp", timestamp)
        json.put("deviceId", deviceId)
        json.put("currentApp", currentApp.toJsonObject())
        json.put("activity", activity.toJsonObject())

        val notifArray = JSONArray()
        for (item in notifications) {
            notifArray.put(item.toJsonObject())
        }
        json.put("notifications", notifArray)

        json.put("deviceState", deviceState.toJsonObject())
        json.put("networkState", networkState.toJsonObject())
        json.put("battery", battery.toJsonObject())
        json.put("screenContext", screenContext.toJsonObject())

        val permsArray = JSONArray()
        for (perm in permissionsGranted) {
            permsArray.put(perm)
        }
        json.put("permissionsGranted", permsArray)
        json.put("fusedSummary", fusedSummary)
        json.put("isSanitized", isSanitized)
        return json
    }
}
