package com.myraa.companion.capabilities

import org.json.JSONObject

/**
 * MobileProactiveModels
 * Phase 26 — Mobile Proactive Companion
 *
 * Data models and JSON serialization for Mobile Proactive Companion on Android.
 */

data class MobileProactiveEvent(
    val id: String,
    val title: String,
    val message: String,
    val category: String = "REMINDER",
    val priority: String = "DEFAULT",
    val timestamp: String = "",
    val actionUrl: String? = null,
    val voiceText: String? = null,
    val dedupKey: String? = null
) {
    fun toJsonObject(): JSONObject = JSONObject().apply {
        put("id", id)
        put("title", title)
        put("message", message)
        put("category", category)
        put("priority", priority)
        put("timestamp", timestamp)
        if (actionUrl != null) put("actionUrl", actionUrl)
        if (voiceText != null) put("voiceText", voiceText)
        if (dedupKey != null) put("dedupKey", dedupKey)
    }

    companion object {
        fun fromJson(json: JSONObject): MobileProactiveEvent {
            return MobileProactiveEvent(
                id = json.optString("id", json.optString("notificationId", "")),
                title = json.optString("title", "MYRAA Proactive Alert"),
                message = json.optString("message", ""),
                category = json.optString("category", "REMINDER").uppercase(),
                priority = json.optString("priority", "DEFAULT").uppercase(),
                timestamp = json.optString("timestamp", ""),
                actionUrl = json.optString("actionUrl").takeIf { it.isNotBlank() },
                voiceText = json.optString("voiceText").takeIf { it.isNotBlank() },
                dedupKey = json.optString("dedupKey").takeIf { it.isNotBlank() }
            )
        }
    }
}

data class MobileNotificationPreferences(
    val enabled: Boolean = true,
    val enabledCategories: Map<String, Boolean> = mapOf(
        "TASK" to true,
        "REMINDER" to true,
        "PROJECT" to true,
        "LONG_RUNNING_TASK" to true,
        "SECURITY" to true,
        "CONNECTION" to true
    ),
    val minPriority: String = "LOW",
    val quietHoursEnabled: Boolean = false,
    val quietHoursStart: String = "22:00",
    val quietHoursEnd: String = "08:00"
) {
    fun toJsonObject(): JSONObject = JSONObject().apply {
        put("enabled", enabled)
        val catsObj = JSONObject()
        enabledCategories.forEach { (k, v) -> catsObj.put(k, v) }
        put("enabledCategories", catsObj)
        put("minPriority", minPriority)
        put("quietHours", JSONObject().apply {
            put("enabled", quietHoursEnabled)
            put("start", quietHoursStart)
            put("end", quietHoursEnd)
        })
    }

    companion object {
        fun fromJson(json: JSONObject): MobileNotificationPreferences {
            val enabled = json.optBoolean("enabled", true)
            val minPriority = json.optString("minPriority", "LOW")

            val catsMap = mutableMapOf(
                "TASK" to true,
                "REMINDER" to true,
                "PROJECT" to true,
                "LONG_RUNNING_TASK" to true,
                "SECURITY" to true,
                "CONNECTION" to true
            )
            val catsObj = json.optJSONObject("enabledCategories")
            if (catsObj != null) {
                catsObj.keys().forEach { k ->
                    catsMap[k.uppercase()] = catsObj.optBoolean(k, true)
                }
            }

            val qhObj = json.optJSONObject("quietHours")
            val qhEnabled = qhObj?.optBoolean("enabled", false) ?: false
            val qhStart = qhObj?.optString("start", "22:00") ?: "22:00"
            val qhEnd = qhObj?.optString("end", "08:00") ?: "08:00"

            return MobileNotificationPreferences(
                enabled = enabled,
                enabledCategories = catsMap,
                minPriority = minPriority,
                quietHoursEnabled = qhEnabled,
                quietHoursStart = qhStart,
                quietHoursEnd = qhEnd
            )
        }
    }
}

data class MobileProactiveResult(
    val success: Boolean,
    val action: String,
    val delivered: Boolean = false,
    val queued: Boolean = false,
    val suppressedReason: String? = null,
    val error: String? = null,
    val errorCode: String? = null
) {
    fun toMap(): Map<String, Any?> = mapOf(
        "success" to success,
        "action" to action,
        "delivered" to delivered,
        "queued" to queued,
        "suppressedReason" to suppressedReason,
        "error" to error,
        "errorCode" to errorCode
    )
}
