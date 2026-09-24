package com.myraa.companion.capabilities

import org.json.JSONArray
import org.json.JSONObject

/**
 * SharedMemoryModels
 * Phase 24 — Shared MYRAA Memory
 *
 * Data models and JSON serialization for cross-device shared memory:
 * - SharedMemoryItem: Canonical memory representation with device and sync metadata
 * - MemorySyncOperation: Individual offline mutation queued on Android
 * - MemorySyncBatchRequest: Batch of offline mutations sent to server
 * - MemorySyncBatchResponse: Server acknowledgement and updated canonical memory list
 * - SharedMemoryResult: Standard capability result envelope
 */

data class SharedMemoryItem(
    val id: String,
    val category: String,
    val text: String,
    val key: String? = null,
    val importance: String = "medium",
    val confidence: String = "medium",
    val source: String = "conversation_extracted",
    val deviceId: String? = null,
    val deviceType: String? = "android",
    val version: Int = 1,
    val createdAt: String = "",
    val updatedAt: String = "",
    val lastSyncedAt: String? = null,
    val clientMutationId: String? = null,
    val status: String = "active"
) {
    fun toJsonObject(): JSONObject = JSONObject().apply {
        put("id", id)
        put("category", category)
        put("text", text)
        if (key != null) put("key", key)
        put("importance", importance)
        put("confidence", confidence)
        put("source", source)
        if (deviceId != null) put("deviceId", deviceId)
        if (deviceType != null) put("deviceType", deviceType)
        put("version", version)
        put("createdAt", createdAt)
        put("updatedAt", updatedAt)
        if (lastSyncedAt != null) put("lastSyncedAt", lastSyncedAt)
        if (clientMutationId != null) put("clientMutationId", clientMutationId)
        put("status", status)
    }

    companion object {
        fun fromJson(json: JSONObject): SharedMemoryItem {
            return SharedMemoryItem(
                id = json.optString("id", ""),
                category = json.optString("category", "fact"),
                text = json.optString("text", ""),
                key = if (json.has("key") && !json.isNull("key")) json.getString("key") else null,
                importance = json.optString("importance", "medium"),
                confidence = json.optString("confidence", "medium"),
                source = json.optString("source", "conversation_extracted"),
                deviceId = if (json.has("deviceId") && !json.isNull("deviceId")) json.getString("deviceId") else null,
                deviceType = json.optString("deviceType", "android"),
                version = json.optInt("version", 1),
                createdAt = json.optString("createdAt", ""),
                updatedAt = json.optString("updatedAt", ""),
                lastSyncedAt = if (json.has("lastSyncedAt") && !json.isNull("lastSyncedAt")) json.getString("lastSyncedAt") else null,
                clientMutationId = if (json.has("clientMutationId") && !json.isNull("clientMutationId")) json.getString("clientMutationId") else null,
                status = json.optString("status", "active")
            )
        }
    }
}

data class MemorySyncOperation(
    val clientMutationId: String,
    val operationType: String, // "CREATE", "UPDATE", "DELETE"
    val memoryId: String? = null,
    val category: String? = null,
    val text: String? = null,
    val key: String? = null,
    val importance: String? = null,
    val confidence: String? = null,
    val source: String? = null,
    val timestamp: String,
    val clientVersion: Int? = null
) {
    fun toJsonObject(): JSONObject = JSONObject().apply {
        put("clientMutationId", clientMutationId)
        put("mutationType", operationType)
        if (memoryId != null) put("memoryId", memoryId)
        put("timestamp", timestamp)
        if (clientVersion != null) put("clientVersion", clientVersion)

        val dataObj = JSONObject()
        if (category != null) dataObj.put("category", category)
        if (text != null) dataObj.put("text", text)
        if (key != null) dataObj.put("key", key)
        if (importance != null) dataObj.put("importance", importance)
        if (confidence != null) dataObj.put("confidence", confidence)
        if (source != null) dataObj.put("source", source)

        if (dataObj.length() > 0) {
            put("data", dataObj)
        }
    }

    companion object {
        fun fromJson(json: JSONObject): MemorySyncOperation {
            val dataObj = json.optJSONObject("data")
            return MemorySyncOperation(
                clientMutationId = json.optString("clientMutationId", ""),
                operationType = json.optString("mutationType", json.optString("operationType", "CREATE")),
                memoryId = if (json.has("memoryId") && !json.isNull("memoryId")) json.getString("memoryId") else null,
                category = dataObj?.optString("category"),
                text = dataObj?.optString("text"),
                key = dataObj?.optString("key"),
                importance = dataObj?.optString("importance"),
                confidence = dataObj?.optString("confidence"),
                source = dataObj?.optString("source"),
                timestamp = json.optString("timestamp", ""),
                clientVersion = if (json.has("clientVersion") && !json.isNull("clientVersion")) json.getInt("clientVersion") else null
            )
        }
    }
}

data class MemorySyncBatchRequest(
    val deviceId: String,
    val deviceType: String = "android",
    val mutations: List<MemorySyncOperation>,
    val lastSyncTimestamp: String? = null
) {
    fun toJsonObject(): JSONObject = JSONObject().apply {
        put("deviceId", deviceId)
        put("deviceType", deviceType)
        val arr = JSONArray()
        for (m in mutations) {
            arr.put(m.toJsonObject())
        }
        put("mutations", arr)
        if (lastSyncTimestamp != null) put("lastSyncTimestamp", lastSyncTimestamp)
    }
}

data class MemorySyncBatchResponse(
    val success: Boolean,
    val appliedCount: Int,
    val conflictsResolved: Int,
    val memories: List<SharedMemoryItem>,
    val serverTimestamp: String,
    val errors: List<String> = emptyList()
) {
    companion object {
        fun fromJson(json: JSONObject): MemorySyncBatchResponse {
            val memoriesList = mutableListOf<SharedMemoryItem>()
            val memArr = json.optJSONArray("memories")
            if (memArr != null) {
                for (i in 0 until memArr.length()) {
                    val item = memArr.optJSONObject(i)
                    if (item != null) {
                        memoriesList.add(SharedMemoryItem.fromJson(item))
                    }
                }
            }

            val errList = mutableListOf<String>()
            val errArr = json.optJSONArray("rejectedMutations")
            if (errArr != null) {
                for (i in 0 until errArr.length()) {
                    val errObj = errArr.optJSONObject(i)
                    val reason = errObj?.optString("reason", "Unknown error") ?: "Unknown error"
                    errList.add(reason)
                }
            }

            return MemorySyncBatchResponse(
                success = json.optBoolean("success", false),
                appliedCount = json.optInt("appliedCount", 0),
                conflictsResolved = json.optInt("conflictsResolved", 0),
                memories = memoriesList,
                serverTimestamp = json.optString("serverTimestamp", ""),
                errors = errList
            )
        }
    }
}

data class SharedMemoryResult(
    val success: Boolean,
    val action: String,
    val memory: SharedMemoryItem? = null,
    val memories: List<SharedMemoryItem> = emptyList(),
    val appliedCount: Int = 0,
    val conflictsResolved: Int = 0,
    val error: String? = null
) {
    fun toJsonObject(): JSONObject = JSONObject().apply {
        put("success", success)
        put("action", action)
        if (memory != null) put("memory", memory.toJsonObject())
        if (memories.isNotEmpty()) {
            val arr = JSONArray()
            for (m in memories) arr.put(m.toJsonObject())
            put("memories", arr)
        }
        if (appliedCount > 0) put("appliedCount", appliedCount)
        if (conflictsResolved > 0) put("conflictsResolved", conflictsResolved)
        if (error != null) put("error", error)
    }
}
