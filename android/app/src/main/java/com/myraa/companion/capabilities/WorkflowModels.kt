package com.myraa.companion.capabilities

import org.json.JSONArray
import org.json.JSONObject

/**
 * WorkflowModels
 * Phase 27 — Mobile Autonomous Workflow Engine
 *
 * Data contracts and JSON serialization for autonomous workflows on Android companion.
 */

data class WorkflowStepItem(
    val id: String,
    val description: String,
    val toolName: String,
    val phase: String,
    val status: String,
    val isDestructive: Boolean = false,
    val checkpointRequired: Boolean = false,
    val result: String? = null,
    val error: String? = null
) {
    fun toJsonObject(): JSONObject = JSONObject().apply {
        put("id", id)
        put("description", description)
        put("toolName", toolName)
        put("phase", phase)
        put("status", status)
        put("isDestructive", isDestructive)
        put("checkpointRequired", checkpointRequired)
        if (result != null) put("result", result)
        if (error != null) put("error", error)
    }

    companion object {
        fun fromJson(json: JSONObject): WorkflowStepItem {
            return WorkflowStepItem(
                id = json.optString("id", ""),
                description = json.optString("description", ""),
                toolName = json.optString("toolName", ""),
                phase = json.optString("phase", "inspect"),
                status = json.optString("status", "pending"),
                isDestructive = json.optBoolean("isDestructive", false),
                checkpointRequired = json.optBoolean("checkpointRequired", false),
                result = json.opt("result")?.toString(),
                error = json.optString("error").takeIf { it.isNotBlank() }
            )
        }
    }
}

data class WorkflowPendingCheckpointItem(
    val checkpointId: String,
    val action: String,
    val impactLevel: String = "medium",
    val expiresAt: String = "",
    val stepId: String = "",
    val toolName: String = ""
) {
    fun toJsonObject(): JSONObject = JSONObject().apply {
        put("checkpointId", checkpointId)
        put("action", action)
        put("impactLevel", impactLevel)
        put("expiresAt", expiresAt)
        put("stepId", stepId)
        put("toolName", toolName)
    }

    companion object {
        fun fromJson(json: JSONObject): WorkflowPendingCheckpointItem {
            return WorkflowPendingCheckpointItem(
                checkpointId = json.optString("checkpointId", ""),
                action = json.optString("action", ""),
                impactLevel = json.optString("impactLevel", "medium"),
                expiresAt = json.optString("expiresAt", ""),
                stepId = json.optString("stepId", ""),
                toolName = json.optString("toolName", "")
            )
        }
    }
}

data class WorkflowResponse(
    val success: Boolean,
    val planId: String,
    val goal: String,
    val category: String,
    val status: String,
    val steps: List<WorkflowStepItem> = emptyList(),
    val voiceResponse: String = "",
    val textResponse: String = "",
    val requiresConfirmation: Boolean = false,
    val pendingCheckpoint: WorkflowPendingCheckpointItem? = null,
    val error: String? = null,
    val errorCode: String? = null
) {
    fun toJsonObject(): JSONObject = JSONObject().apply {
        put("success", success)
        put("planId", planId)
        put("goal", goal)
        put("category", category)
        put("status", status)
        val arr = JSONArray()
        steps.forEach { arr.put(it.toJsonObject()) }
        put("steps", arr)
        put("voiceResponse", voiceResponse)
        put("textResponse", textResponse)
        put("requiresConfirmation", requiresConfirmation)
        if (pendingCheckpoint != null) put("pendingCheckpoint", pendingCheckpoint.toJsonObject())
        if (error != null) put("error", error)
        if (errorCode != null) put("errorCode", errorCode)
    }

    companion object {
        fun fromJson(json: JSONObject): WorkflowResponse {
            val stepsList = mutableListOf<WorkflowStepItem>()
            val stepsArr = json.optJSONArray("steps")
            if (stepsArr != null) {
                for (i in 0 until stepsArr.length()) {
                    val stepObj = stepsArr.optJSONObject(i)
                    if (stepObj != null) {
                        stepsList.add(WorkflowStepItem.fromJson(stepObj))
                    }
                }
            }

            val cpObj = json.optJSONObject("pendingCheckpoint")
            val checkpoint = if (cpObj != null) WorkflowPendingCheckpointItem.fromJson(cpObj) else null

            return WorkflowResponse(
                success = json.optBoolean("success", false),
                planId = json.optString("planId", ""),
                goal = json.optString("goal", ""),
                category = json.optString("category", "workflow"),
                status = json.optString("status", "completed"),
                steps = stepsList,
                voiceResponse = json.optString("voiceResponse", ""),
                textResponse = json.optString("textResponse", ""),
                requiresConfirmation = json.optBoolean("requiresConfirmation", false),
                pendingCheckpoint = checkpoint,
                error = json.optString("error").takeIf { it.isNotBlank() },
                errorCode = json.optString("errorCode").takeIf { it.isNotBlank() }
            )
        }
    }
}
