package com.myraa.companion.capabilities

import org.json.JSONArray
import org.json.JSONObject

/**
 * HandoffModels
 * Phase 25 — Cross-Device Handoff
 *
 * Data models and JSON serialization for Cross-Device Handoff between Desktop and Android.
 */

data class HandoffSnapshotItem(
    val handoffId: String,
    val handoffToken: String,
    val status: String,
    val sourceDeviceId: String,
    val sourceDeviceType: String,
    val targetDeviceId: String? = null,
    val conversationSummary: String? = null,
    val lastUserQuery: String? = null,
    val taskPlanGoal: String? = null,
    val projectName: String? = null,
    val sharedMemoryRefs: List<String> = emptyList(),
    val createdAt: String = "",
    val expiresAt: String = "",
    val version: Int = 1
) {
    fun toJsonObject(): JSONObject = JSONObject().apply {
        put("handoffId", handoffId)
        put("handoffToken", handoffToken)
        put("status", status)
        put("sourceDevice", JSONObject().apply {
            put("deviceId", sourceDeviceId)
            put("deviceType", sourceDeviceType)
        })
        if (targetDeviceId != null) {
            put("targetDevice", JSONObject().apply {
                put("deviceId", targetDeviceId)
            })
        }
        if (conversationSummary != null || lastUserQuery != null) {
            put("conversationContext", JSONObject().apply {
                if (conversationSummary != null) put("summary", conversationSummary)
                if (lastUserQuery != null) put("lastUserQuery", lastUserQuery)
            })
        }
        if (taskPlanGoal != null) {
            put("taskPlanState", JSONObject().apply {
                put("goal", taskPlanGoal)
            })
        }
        if (projectName != null) {
            put("projectContext", JSONObject().apply {
                put("projectName", projectName)
            })
        }
        val refsArr = JSONArray()
        sharedMemoryRefs.forEach { refsArr.put(it) }
        put("sharedMemoryRefs", refsArr)
        put("createdAt", createdAt)
        put("expiresAt", expiresAt)
        put("version", version)
    }

    companion object {
        fun fromJson(json: JSONObject): HandoffSnapshotItem {
            val source = json.optJSONObject("sourceDevice")
            val target = json.optJSONObject("targetDevice")
            val conv = json.optJSONObject("conversationContext")
            val task = json.optJSONObject("taskPlanState")
            val proj = json.optJSONObject("projectContext")

            val memoryRefs = mutableListOf<String>()
            val refsArr = json.optJSONArray("sharedMemoryRefs")
            if (refsArr != null) {
                for (i in 0 until refsArr.length()) {
                    memoryRefs.add(refsArr.optString(i))
                }
            }

            return HandoffSnapshotItem(
                handoffId = json.optString("handoffId", ""),
                handoffToken = json.optString("handoffToken", ""),
                status = json.optString("status", "pending"),
                sourceDeviceId = source?.optString("deviceId") ?: "unknown",
                sourceDeviceType = source?.optString("deviceType") ?: "unknown",
                targetDeviceId = target?.optString("deviceId")?.takeIf { it.isNotEmpty() },
                conversationSummary = conv?.optString("summary")?.takeIf { it.isNotEmpty() },
                lastUserQuery = conv?.optString("lastUserQuery")?.takeIf { it.isNotEmpty() },
                taskPlanGoal = task?.optString("goal")?.takeIf { it.isNotEmpty() },
                projectName = proj?.optString("projectName")?.takeIf { it.isNotEmpty() },
                sharedMemoryRefs = memoryRefs,
                createdAt = json.optString("createdAt", ""),
                expiresAt = json.optString("expiresAt", ""),
                version = json.optInt("version", 1)
            )
        }
    }
}

data class HandoffResult(
    val success: Boolean,
    val action: String,
    val handoff: HandoffSnapshotItem? = null,
    val handoffs: List<HandoffSnapshotItem>? = null,
    val requiresConfirmation: Boolean = false,
    val gatedActionsCount: Int = 0,
    val error: String? = null,
    val errorCode: String? = null
) {
    fun toJsonObject(): JSONObject = JSONObject().apply {
        put("success", success)
        put("action", action)
        if (handoff != null) put("handoff", handoff.toJsonObject())
        if (handoffs != null) {
            val arr = JSONArray()
            handoffs.forEach { arr.put(it.toJsonObject()) }
            put("handoffs", arr)
        }
        put("requiresConfirmation", requiresConfirmation)
        put("gatedActionsCount", gatedActionsCount)
        if (error != null) put("error", error)
        if (errorCode != null) put("errorCode", errorCode)
    }

    companion object {
        fun success(
            action: String,
            handoff: HandoffSnapshotItem? = null,
            handoffs: List<HandoffSnapshotItem>? = null,
            requiresConfirmation: Boolean = false,
            gatedActionsCount: Int = 0
        ): HandoffResult = HandoffResult(
            success = true,
            action = action,
            handoff = handoff,
            handoffs = handoffs,
            requiresConfirmation = requiresConfirmation,
            gatedActionsCount = gatedActionsCount
        )

        fun failure(action: String, error: String, errorCode: String? = null): HandoffResult =
            HandoffResult(success = false, action = action, error = error, errorCode = errorCode)
    }
}
