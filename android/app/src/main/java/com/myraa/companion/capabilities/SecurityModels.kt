package com.myraa.companion.capabilities

import org.json.JSONArray
import org.json.JSONObject

/**
 * SecurityModels
 * Phase 28 — Mobile Emergency & Security Layer
 *
 * Data contracts and JSON serialization for Android Security & Emergency controls.
 */

data class SuspiciousEventItem(
    val eventCategory: String,
    val severityLabel: String,
    val approximateTime: String,
    val count: Int,
    val description: String
) {
    fun toJsonObject(): JSONObject = JSONObject().apply {
        put("eventCategory", eventCategory)
        put("severityLabel", severityLabel)
        put("approximateTime", approximateTime)
        put("count", count)
        put("description", description)
    }

    companion object {
        fun fromJson(json: JSONObject): SuspiciousEventItem {
            return SuspiciousEventItem(
                eventCategory = json.optString("eventCategory", "SUSPICIOUS_ACTIVITY"),
                severityLabel = json.optString("severityLabel", "MEDIUM"),
                approximateTime = json.optString("approximateTime", ""),
                count = json.optInt("count", 1),
                description = json.optString("description", "")
            )
        }
    }
}

data class ActiveSessionItem(
    val sessionId: String,
    val deviceName: String,
    val deviceType: String,
    val role: String,
    val connectedAt: String,
    val maskedIp: String
) {
    fun toJsonObject(): JSONObject = JSONObject().apply {
        put("sessionId", sessionId)
        put("deviceName", deviceName)
        put("deviceType", deviceType)
        put("role", role)
        put("connectedAt", connectedAt)
        put("maskedIp", maskedIp)
    }

    companion object {
        fun fromJson(json: JSONObject): ActiveSessionItem {
            return ActiveSessionItem(
                sessionId = json.optString("sessionId", ""),
                deviceName = json.optString("deviceName", ""),
                deviceType = json.optString("deviceType", "mobile"),
                role = json.optString("role", "standard"),
                connectedAt = json.optString("connectedAt", ""),
                maskedIp = json.optString("maskedIp", "masked")
            )
        }
    }
}

data class SecurityStatusData(
    val emergencyStopActive: Boolean,
    val emergencyStopTriggeredAt: String? = null,
    val emergencyStopSource: String? = null,
    val lockdownActive: Boolean = false,
    val thisDeviceLostMode: Boolean = false,
    val activeSessionCount: Int = 0,
    val recentSuspiciousEvents: List<SuspiciousEventItem> = emptyList(),
    val snapshotAt: String = ""
) {
    companion object {
        fun fromJson(json: JSONObject): SecurityStatusData {
            val eventsList = mutableListOf<SuspiciousEventItem>()
            val eventsArr = json.optJSONArray("recentSuspiciousEvents")
            if (eventsArr != null) {
                for (i in 0 until eventsArr.length()) {
                    val obj = eventsArr.optJSONObject(i)
                    if (obj != null) {
                        eventsList.add(SuspiciousEventItem.fromJson(obj))
                    }
                }
            }

            return SecurityStatusData(
                emergencyStopActive = json.optBoolean("emergencyStopActive", false),
                emergencyStopTriggeredAt = json.optString("emergencyStopTriggeredAt").takeIf { it.isNotBlank() },
                emergencyStopSource = json.optString("emergencyStopSource").takeIf { it.isNotBlank() },
                lockdownActive = json.optBoolean("lockdownActive", false),
                thisDeviceLostMode = json.optBoolean("thisDeviceLostMode", false),
                activeSessionCount = json.optInt("activeSessionCount", 0),
                recentSuspiciousEvents = eventsList,
                snapshotAt = json.optString("snapshotAt", "")
            )
        }
    }
}

data class SecurityControlOutcome(
    val success: Boolean,
    val errorCode: String? = null,
    val message: String,
    val status: SecurityStatusData? = null
) {
    companion object {
        fun fromJson(json: JSONObject): SecurityControlOutcome {
            val statusObj = json.optJSONObject("status")
            return SecurityControlOutcome(
                success = json.optBoolean("success", false),
                errorCode = json.optString("errorCode").takeIf { it.isNotBlank() },
                message = json.optString("message", json.optString("error", "")),
                status = if (statusObj != null) SecurityStatusData.fromJson(statusObj) else null
            )
        }
    }
}
