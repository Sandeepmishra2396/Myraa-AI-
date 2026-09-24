package com.myraa.companion.networking

import android.os.Build
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * MyraaApiClient
 * Phase 16 — Android Companion Foundation
 *
 * Handles HTTP REST interactions with MYRAA Core:
 *  - 6-character PIN Device Pairing (POST /api/remote/pair)
 *  - Remote Device Revocation (POST /api/remote/revoke)
 *  - Emergency Stop Trigger/Reset (POST /api/remote/emergency-stop)
 */
class MyraaApiClient(
    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.SECONDS)
        .writeTimeout(10, TimeUnit.SECONDS)
        .build()
) {

    companion object {
        private const val TAG = "MyraaApiClient"
        private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
    }

    /**
     * Pair device with MYRAA desktop using 6-character alphanumeric PIN.
     */
    suspend fun pairDevice(
        code: String,
        deviceName: String,
        host: String,
        port: Int
    ): PairingResult = withContext(Dispatchers.IO) {
        val url = "http://$host:$port/api/remote/pair"

        val meta = JSONObject().apply {
            put("model", "${Build.MANUFACTURER} ${Build.MODEL}")
            put("androidVersion", Build.VERSION.RELEASE)
            put("appVersion", "0.16.0")
        }

        val bodyJson = JSONObject().apply {
            put("code", code.trim().uppercase())
            put("deviceName", deviceName)
            put("deviceType", "mobile")
            put("deviceMeta", meta)
        }

        val request = Request.Builder()
            .url(url)
            .post(bodyJson.toString().toRequestBody(JSON_MEDIA_TYPE))
            .build()

        try {
            client.newCall(request).execute().use { response ->
                val responseStr = response.body?.string() ?: ""
                if (!response.isSuccessful) {
                    val errMsg = try {
                        val json = JSONObject(responseStr)
                        json.optString("message", "HTTP Error ${response.code}")
                    } catch (_: Exception) {
                        "HTTP Error ${response.code}"
                    }
                    Log.w(TAG, "Pairing failed: $errMsg (Code: ${response.code})")
                    return@withContext PairingResult.Error(code = "HTTP_${response.code}", message = errMsg)
                }

                val json = JSONObject(responseStr)
                if (json.optBoolean("success", false)) {
                    val token = json.getString("token")
                    val role = json.optString("deviceRole", "standard")
                    val deviceId = json.getString("deviceId")
                    val expiresAt = if (json.has("expiresAt") && !json.isNull("expiresAt")) json.getString("expiresAt") else null
                    val accessToken = if (json.has("accessToken") && !json.isNull("accessToken")) json.getString("accessToken") else null
                    val refreshToken = if (json.has("refreshToken") && !json.isNull("refreshToken")) json.getString("refreshToken") else null
                    val expiresInSeconds = if (json.has("expiresInSeconds") && !json.isNull("expiresInSeconds")) json.getInt("expiresInSeconds") else null

                    Log.i(TAG, "Pairing successful for device $deviceId with role $role")
                    PairingResult.Success(
                        PairingSuccess(
                            token = token,
                            deviceRole = role,
                            deviceId = deviceId,
                            expiresAt = expiresAt,
                            accessToken = accessToken,
                            refreshToken = refreshToken,
                            expiresInSeconds = expiresInSeconds
                        )
                    )
                } else {
                    val error = json.optString("error", "UNKNOWN_ERROR")
                    val message = json.optString("message", "Pairing rejected by server")
                    PairingResult.Error(code = error, message = message)
                }
            }
        } catch (e: IOException) {
            Log.e(TAG, "Network error during pairing: ${e.message}")
            PairingResult.Error("NETWORK_ERROR", e.localizedMessage ?: "Failed to connect to MYRAA server")
        } catch (e: Exception) {
            Log.e(TAG, "Unexpected error during pairing: ${e.message}")
            PairingResult.Error("INTERNAL_ERROR", e.localizedMessage ?: "Unexpected error during pairing")
        }
    }

    /**
     * Revoke device session on MYRAA Core.
     */
    suspend fun revokeDevice(
        deviceId: String,
        bearerToken: String,
        host: String,
        port: Int
    ): Boolean = withContext(Dispatchers.IO) {
        val url = "http://$host:$port/api/remote/revoke"
        val bodyJson = JSONObject().apply {
            put("deviceId", deviceId)
            put("reason", "Revoked by user from Android Companion")
        }

        val request = Request.Builder()
            .url(url)
            .header("Authorization", "Bearer $bearerToken")
            .post(bodyJson.toString().toRequestBody(JSON_MEDIA_TYPE))
            .build()

        try {
            client.newCall(request).execute().use { response ->
                Log.i(TAG, "Revoke request response code: ${response.code}")
                response.isSuccessful
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error revoking device: ${e.message}")
            false
        }
    }

    /**
     * Rotate short-lived session access and refresh tokens.
     */
    suspend fun rotateSessionToken(
        compositeRefreshToken: String,
        host: String,
        port: Int
    ): TokenRefreshResult = withContext(Dispatchers.IO) {
        val url = "http://$host:$port/api/remote/token/refresh"
        val bodyJson = JSONObject().apply {
            put("refreshToken", compositeRefreshToken)
        }

        val request = Request.Builder()
            .url(url)
            .post(bodyJson.toString().toRequestBody(JSON_MEDIA_TYPE))
            .build()

        try {
            client.newCall(request).execute().use { response ->
                val responseStr = response.body?.string() ?: ""
                val isReplay = response.code == 403 || responseStr.contains("REPLAY")

                if (!response.isSuccessful) {
                    val errMsg = try {
                        val json = JSONObject(responseStr)
                        json.optString("error", "Refresh failed with HTTP ${response.code}")
                    } catch (_: Exception) {
                        "Refresh failed with HTTP ${response.code}"
                    }
                    Log.w(TAG, "Token refresh rejected: $errMsg (Replay detected: $isReplay)")
                    return@withContext TokenRefreshResult.Error(errMsg, isReplay)
                }

                val json = JSONObject(responseStr)
                val at = json.getString("accessToken")
                val rf = json.getString("refreshToken")
                val exp = json.optInt("expiresInSeconds", 900)

                Log.i(TAG, "Token refresh successful. New session valid for ${exp}s.")
                TokenRefreshResult.Success(at, rf, exp)
            }
        } catch (e: Exception) {
            Log.e(TAG, "Network error during token refresh: ${e.message}")
            TokenRefreshResult.Error(e.localizedMessage ?: "Network error during token refresh", false)
        }
    }

    /**
     * Trigger Emergency Stop killswitch on MYRAA Core.
     */
    suspend fun triggerEmergencyStop(
        reason: String,
        bearerToken: String?,
        host: String,
        port: Int
    ): Boolean = withContext(Dispatchers.IO) {
        val url = "http://$host:$port/api/remote/emergency-stop"
        val bodyJson = JSONObject().apply {
            put("reason", reason)
        }

        val builder = Request.Builder()
            .url(url)
            .post(bodyJson.toString().toRequestBody(JSON_MEDIA_TYPE))

        if (!bearerToken.isNullOrBlank()) {
            builder.header("Authorization", "Bearer $bearerToken")
        }

        try {
            client.newCall(builder.build()).execute().use { response ->
                Log.w(TAG, "Emergency Stop triggered from Android! Response: ${response.code}")
                response.isSuccessful
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to trigger Emergency Stop: ${e.message}")
            false
        }
    }

    /**
     * Reset Emergency Stop on MYRAA Core (Requires admin role).
     */
    suspend fun resetEmergencyStop(
        bearerToken: String,
        host: String,
        port: Int
    ): Boolean = withContext(Dispatchers.IO) {
        val url = "http://$host:$port/api/remote/emergency-stop/reset"
        val bodyJson = JSONObject().apply {
            put("reason", "Reset by authorized Android Companion operator")
        }

        val request = Request.Builder()
            .url(url)
            .header("Authorization", "Bearer $bearerToken")
            .post(bodyJson.toString().toRequestBody(JSON_MEDIA_TYPE))
            .build()

        try {
            client.newCall(request).execute().use { response ->
                Log.i(TAG, "Emergency Stop reset requested. Response: ${response.code}")
                response.isSuccessful
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to reset Emergency Stop: ${e.message}")
            false
        }
    }

    /**
     * Query current Emergency Stop state.
     */
    suspend fun getEmergencyStopStatus(
        host: String,
        port: Int
    ): EmergencyStopState? = withContext(Dispatchers.IO) {
        val url = "http://$host:$port/api/remote/emergency-stop"
        val request = Request.Builder().url(url).get().build()

        try {
            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) return@withContext null
                val str = response.body?.string() ?: return@withContext null
                val json = JSONObject(str)
                EmergencyStopState(
                    active = json.optBoolean("active", false),
                    triggeredAt = if (json.has("triggeredAt") && !json.isNull("triggeredAt")) json.getString("triggeredAt") else null,
                    reason = if (json.has("reason") && !json.isNull("reason")) json.getString("reason") else null,
                    resetAt = if (json.has("resetAt") && !json.isNull("resetAt")) json.getString("resetAt") else null
                )
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to fetch Emergency Stop status: ${e.message}")
            null
        }
    }

    /**
     * Fetch canonical shared memories from Core.
     */
    suspend fun getSharedMemories(
        host: String,
        port: Int,
        bearerToken: String,
        category: String? = null
    ): List<com.myraa.companion.capabilities.SharedMemoryItem> = withContext(Dispatchers.IO) {
        val queryPart = if (category != null) "?category=$category" else ""
        val url = "http://$host:$port/api/remote/memory$queryPart"
        val request = Request.Builder()
            .url(url)
            .header("Authorization", "Bearer $bearerToken")
            .get()
            .build()

        try {
            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) return@withContext emptyList()
                val str = response.body?.string() ?: return@withContext emptyList()
                val arr = org.json.JSONArray(str)
                val list = mutableListOf<com.myraa.companion.capabilities.SharedMemoryItem>()
                for (i in 0 until arr.length()) {
                    val obj = arr.optJSONObject(i)
                    if (obj != null) {
                        list.add(com.myraa.companion.capabilities.SharedMemoryItem.fromJson(obj))
                    }
                }
                list
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to fetch shared memories: ${e.message}")
            emptyList()
        }
    }

    /**
     * Create a shared memory in Core.
     */
    suspend fun createSharedMemory(
        host: String,
        port: Int,
        bearerToken: String,
        category: String,
        text: String,
        key: String? = null,
        importance: String = "medium",
        confidence: String = "medium"
    ): com.myraa.companion.capabilities.SharedMemoryItem? = withContext(Dispatchers.IO) {
        val url = "http://$host:$port/api/remote/memory"
        val bodyJson = JSONObject().apply {
            put("category", category)
            put("text", text)
            if (key != null) put("key", key)
            put("importance", importance)
            put("confidence", confidence)
            put("source", "user_explicit")
        }

        val request = Request.Builder()
            .url(url)
            .header("Authorization", "Bearer $bearerToken")
            .post(bodyJson.toString().toRequestBody(JSON_MEDIA_TYPE))
            .build()

        try {
            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) return@withContext null
                val str = response.body?.string() ?: return@withContext null
                val obj = JSONObject(str)
                com.myraa.companion.capabilities.SharedMemoryItem.fromJson(obj)
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to create shared memory: ${e.message}")
            null
        }
    }

    /**
     * Push batch offline mutations to Core and retrieve synchronized snapshot.
     */
    suspend fun syncSharedMemoryBatch(
        host: String,
        port: Int,
        bearerToken: String,
        batch: com.myraa.companion.capabilities.MemorySyncBatchRequest
    ): com.myraa.companion.capabilities.MemorySyncBatchResponse? = withContext(Dispatchers.IO) {
        val url = "http://$host:$port/api/remote/memory/sync"
        val request = Request.Builder()
            .url(url)
            .header("Authorization", "Bearer $bearerToken")
            .post(batch.toJsonObject().toString().toRequestBody(JSON_MEDIA_TYPE))
            .build()

        try {
            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) return@withContext null
                val str = response.body?.string() ?: return@withContext null
                val obj = JSONObject(str)
                com.myraa.companion.capabilities.MemorySyncBatchResponse.fromJson(obj)
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to sync shared memory batch: ${e.message}")
            null
        }
    }

    /**
     * Fetch available cross-device handoffs from Core.
     */
    suspend fun getAvailableHandoffs(
        host: String,
        port: Int,
        bearerToken: String
    ): List<com.myraa.companion.capabilities.HandoffSnapshotItem> = withContext(Dispatchers.IO) {
        val url = "http://$host:$port/api/remote/handoff"
        val request = Request.Builder()
            .url(url)
            .header("Authorization", "Bearer $bearerToken")
            .get()
            .build()

        try {
            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) return@withContext emptyList()
                val str = response.body?.string() ?: return@withContext emptyList()
                val arr = org.json.JSONArray(str)
                val list = mutableListOf<com.myraa.companion.capabilities.HandoffSnapshotItem>()
                for (i in 0 until arr.length()) {
                    list.add(com.myraa.companion.capabilities.HandoffSnapshotItem.fromJson(arr.getJSONObject(i)))
                }
                list
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to fetch available handoffs: ${e.message}")
            emptyList()
        }
    }

    /**
     * Accept a cross-device handoff.
     */
    suspend fun acceptHandoff(
        host: String,
        port: Int,
        bearerToken: String,
        handoffId: String,
        token: String
    ): Boolean = withContext(Dispatchers.IO) {
        val url = "http://$host:$port/api/remote/handoff/$handoffId/accept"
        val bodyJson = JSONObject().apply {
            put("token", token)
        }
        val request = Request.Builder()
            .url(url)
            .header("Authorization", "Bearer $bearerToken")
            .post(bodyJson.toString().toRequestBody(JSON_MEDIA_TYPE))
            .build()

        try {
            client.newCall(request).execute().use { response ->
                response.isSuccessful
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to accept handoff: ${e.message}")
            false
        }
    }

    /**
     * Resume a cross-device handoff task/conversation.
     */
    suspend fun resumeHandoff(
        host: String,
        port: Int,
        bearerToken: String,
        handoffId: String,
        token: String,
        confirmResume: Boolean = false
    ): Boolean = withContext(Dispatchers.IO) {
        val url = "http://$host:$port/api/remote/handoff/$handoffId/resume"
        val bodyJson = JSONObject().apply {
            put("token", token)
            put("confirmResume", confirmResume)
        }
        val request = Request.Builder()
            .url(url)
            .header("Authorization", "Bearer $bearerToken")
            .post(bodyJson.toString().toRequestBody(JSON_MEDIA_TYPE))
            .build()

        try {
            client.newCall(request).execute().use { response ->
                response.isSuccessful
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to resume handoff: ${e.message}")
            false
        }
    }

    // ---------------------------------------------------------------------------
    // Phase 26 — Mobile Proactive Companion API
    // ---------------------------------------------------------------------------

    /**
     * Subscribe Android companion to receive proactive notifications.
     */
    suspend fun subscribeProactive(
        host: String,
        port: Int,
        bearerToken: String,
        deviceId: String,
        preferences: JSONObject? = null
    ): Boolean = withContext(Dispatchers.IO) {
        val url = "http://$host:$port/api/remote/proactive/subscribe"
        val bodyJson = JSONObject().apply {
            put("deviceId", deviceId)
            if (preferences != null) put("preferences", preferences)
        }
        val request = Request.Builder()
            .url(url)
            .header("Authorization", "Bearer $bearerToken")
            .post(bodyJson.toString().toRequestBody(JSON_MEDIA_TYPE))
            .build()

        try {
            client.newCall(request).execute().use { response ->
                response.isSuccessful
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to subscribe to proactive notifications: ${e.message}")
            false
        }
    }

    /**
     * Fetch device proactive notification preferences from server.
     */
    suspend fun getProactivePreferences(
        host: String,
        port: Int,
        bearerToken: String,
        deviceId: String
    ): JSONObject? = withContext(Dispatchers.IO) {
        val url = "http://$host:$port/api/remote/proactive/preferences?deviceId=$deviceId"
        val request = Request.Builder()
            .url(url)
            .header("Authorization", "Bearer $bearerToken")
            .get()
            .build()

        try {
            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) return@use null
                val raw = response.body?.string() ?: return@use null
                JSONObject(raw).optJSONObject("preferences")
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to fetch proactive preferences: ${e.message}")
            null
        }
    }

    /**
     * Update device proactive notification preferences on server.
     */
    suspend fun updateProactivePreferences(
        host: String,
        port: Int,
        bearerToken: String,
        patch: JSONObject
    ): Boolean = withContext(Dispatchers.IO) {
        val url = "http://$host:$port/api/remote/proactive/preferences"
        val request = Request.Builder()
            .url(url)
            .header("Authorization", "Bearer $bearerToken")
            .put(patch.toString().toRequestBody(JSON_MEDIA_TYPE))
            .build()

        try {
            client.newCall(request).execute().use { response ->
                response.isSuccessful
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to update proactive preferences: ${e.message}")
            false
        }
    }

    /**
     * Drain pending queued proactive notifications from server.
     */
    suspend fun drainPendingProactiveNotifications(
        host: String,
        port: Int,
        bearerToken: String,
        deviceId: String
    ): List<com.myraa.companion.capabilities.MobileProactiveEvent> = withContext(Dispatchers.IO) {
        val url = "http://$host:$port/api/remote/proactive/pending?deviceId=$deviceId"
        val request = Request.Builder()
            .url(url)
            .header("Authorization", "Bearer $bearerToken")
            .get()
            .build()

        try {
            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) return@use emptyList()
                val raw = response.body?.string() ?: return@use emptyList()
                val json = JSONObject(raw)
                val notifArray = json.optJSONArray("notifications") ?: return@use emptyList()
                val resultList = mutableListOf<com.myraa.companion.capabilities.MobileProactiveEvent>()
                for (i in 0 until notifArray.length()) {
                    val notifObj = notifArray.optJSONObject(i)
                    if (notifObj != null) {
                        resultList.add(com.myraa.companion.capabilities.MobileProactiveEvent.fromJson(notifObj))
                    }
                }
                resultList
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to drain pending proactive notifications: ${e.message}")
            emptyList()
        }
    }

    /**
     * Phase 27 — Execute voice autonomous workflow on MYRAA Core.
     */
    suspend fun executeWorkflow(
        host: String,
        port: Int,
        bearerToken: String,
        query: String,
        preferredLanguage: String = "hinglish",
        autoExecute: Boolean = true
    ): com.myraa.companion.capabilities.WorkflowResponse? = withContext(Dispatchers.IO) {
        val url = "http://$host:$port/api/remote/workflow/execute"
        val bodyJson = JSONObject().apply {
            put("query", query)
            put("preferredLanguage", preferredLanguage)
            put("autoExecute", autoExecute)
        }
        val request = Request.Builder()
            .url(url)
            .header("Authorization", "Bearer $bearerToken")
            .post(bodyJson.toString().toRequestBody(JSON_MEDIA_TYPE))
            .build()

        try {
            client.newCall(request).execute().use { response ->
                val raw = response.body?.string() ?: return@use null
                val json = JSONObject(raw)
                com.myraa.companion.capabilities.WorkflowResponse.fromJson(json)
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to execute workflow: ${e.message}")
            null
        }
    }

    /**
     * Phase 27 — Get status of autonomous workflow plan.
     */
    suspend fun getWorkflowStatus(
        host: String,
        port: Int,
        bearerToken: String,
        planId: String
    ): com.myraa.companion.capabilities.WorkflowResponse? = withContext(Dispatchers.IO) {
        val url = "http://$host:$port/api/remote/workflow/$planId"
        val request = Request.Builder()
            .url(url)
            .header("Authorization", "Bearer $bearerToken")
            .get()
            .build()

        try {
            client.newCall(request).execute().use { response ->
                val raw = response.body?.string() ?: return@use null
                val json = JSONObject(raw)
                com.myraa.companion.capabilities.WorkflowResponse.fromJson(json)
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to get workflow status: ${e.message}")
            null
        }
    }

    /**
     * Phase 27 — Confirm or reject pending workflow checkpoint.
     */
    suspend fun confirmWorkflowCheckpoint(
        host: String,
        port: Int,
        bearerToken: String,
        planId: String,
        checkpointId: String,
        approved: Boolean,
        userFeedback: String? = null
    ): com.myraa.companion.capabilities.WorkflowResponse? = withContext(Dispatchers.IO) {
        val url = "http://$host:$port/api/remote/workflow/$planId/confirm"
        val bodyJson = JSONObject().apply {
            put("checkpointId", checkpointId)
            put("approved", approved)
            if (userFeedback != null) put("userFeedback", userFeedback)
        }
        val request = Request.Builder()
            .url(url)
            .header("Authorization", "Bearer $bearerToken")
            .post(bodyJson.toString().toRequestBody(JSON_MEDIA_TYPE))
            .build()

        try {
            client.newCall(request).execute().use { response ->
                val raw = response.body?.string() ?: return@use null
                val json = JSONObject(raw)
                com.myraa.companion.capabilities.WorkflowResponse.fromJson(json)
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to confirm workflow checkpoint: ${e.message}")
            null
        }
    }

    // ── Phase 28 — Mobile Emergency & Security Methods ─────────────────────

    suspend fun getSecurityStatus(
        host: String,
        port: Int,
        bearerToken: String
    ): com.myraa.companion.capabilities.SecurityStatusData? = withContext(Dispatchers.IO) {
        val url = "http://$host:$port/api/remote/security/status"
        val request = Request.Builder()
            .url(url)
            .header("Authorization", "Bearer $bearerToken")
            .get()
            .build()

        try {
            client.newCall(request).execute().use { response ->
                val raw = response.body?.string() ?: return@use null
                val json = JSONObject(raw)
                val statusObj = json.optJSONObject("status") ?: json
                com.myraa.companion.capabilities.SecurityStatusData.fromJson(statusObj)
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to get security status: ${e.message}")
            null
        }
    }

    suspend fun triggerLockdown(
        host: String,
        port: Int,
        bearerToken: String,
        reason: String? = null
    ): com.myraa.companion.capabilities.SecurityControlOutcome? = withContext(Dispatchers.IO) {
        val url = "http://$host:$port/api/remote/security/lockdown"
        val bodyJson = JSONObject().apply {
            if (reason != null) put("reason", reason)
        }
        val request = Request.Builder()
            .url(url)
            .header("Authorization", "Bearer $bearerToken")
            .post(bodyJson.toString().toRequestBody(JSON_MEDIA_TYPE))
            .build()

        try {
            client.newCall(request).execute().use { response ->
                val raw = response.body?.string() ?: return@use null
                com.myraa.companion.capabilities.SecurityControlOutcome.fromJson(JSONObject(raw))
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to trigger lockdown: ${e.message}")
            null
        }
    }

    suspend fun recoverFromLockdown(
        host: String,
        port: Int,
        bearerToken: String
    ): com.myraa.companion.capabilities.SecurityControlOutcome? = withContext(Dispatchers.IO) {
        val url = "http://$host:$port/api/remote/security/lockdown/recover"
        val request = Request.Builder()
            .url(url)
            .header("Authorization", "Bearer $bearerToken")
            .post(JSONObject().toString().toRequestBody(JSON_MEDIA_TYPE))
            .build()

        try {
            client.newCall(request).execute().use { response ->
                val raw = response.body?.string() ?: return@use null
                com.myraa.companion.capabilities.SecurityControlOutcome.fromJson(JSONObject(raw))
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to recover from lockdown: ${e.message}")
            null
        }
    }

    suspend fun enableLostDevice(
        host: String,
        port: Int,
        bearerToken: String,
        deviceId: String,
        reason: String? = null
    ): com.myraa.companion.capabilities.SecurityControlOutcome? = withContext(Dispatchers.IO) {
        val url = "http://$host:$port/api/remote/security/lost-device/enable"
        val bodyJson = JSONObject().apply {
            put("deviceId", deviceId)
            if (reason != null) put("reason", reason)
        }
        val request = Request.Builder()
            .url(url)
            .header("Authorization", "Bearer $bearerToken")
            .post(bodyJson.toString().toRequestBody(JSON_MEDIA_TYPE))
            .build()

        try {
            client.newCall(request).execute().use { response ->
                val raw = response.body?.string() ?: return@use null
                com.myraa.companion.capabilities.SecurityControlOutcome.fromJson(JSONObject(raw))
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to enable lost-device mode: ${e.message}")
            null
        }
    }

    suspend fun recoverLostDevice(
        host: String,
        port: Int,
        bearerToken: String,
        deviceId: String
    ): com.myraa.companion.capabilities.SecurityControlOutcome? = withContext(Dispatchers.IO) {
        val url = "http://$host:$port/api/remote/security/lost-device/recover"
        val bodyJson = JSONObject().apply {
            put("deviceId", deviceId)
        }
        val request = Request.Builder()
            .url(url)
            .header("Authorization", "Bearer $bearerToken")
            .post(bodyJson.toString().toRequestBody(JSON_MEDIA_TYPE))
            .build()

        try {
            client.newCall(request).execute().use { response ->
                val raw = response.body?.string() ?: return@use null
                com.myraa.companion.capabilities.SecurityControlOutcome.fromJson(JSONObject(raw))
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to recover lost device: ${e.message}")
            null
        }
    }

    suspend fun logoutAllDevices(
        host: String,
        port: Int,
        bearerToken: String,
        reason: String? = null
    ): com.myraa.companion.capabilities.SecurityControlOutcome? = withContext(Dispatchers.IO) {
        val url = "http://$host:$port/api/remote/security/logout-all"
        val bodyJson = JSONObject().apply {
            if (reason != null) put("reason", reason)
        }
        val request = Request.Builder()
            .url(url)
            .header("Authorization", "Bearer $bearerToken")
            .post(bodyJson.toString().toRequestBody(JSON_MEDIA_TYPE))
            .build()

        try {
            client.newCall(request).execute().use { response ->
                val raw = response.body?.string() ?: return@use null
                com.myraa.companion.capabilities.SecurityControlOutcome.fromJson(JSONObject(raw))
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to logout all devices: ${e.message}")
            null
        }
    }

    suspend fun getActiveSessions(
        host: String,
        port: Int,
        bearerToken: String
    ): List<com.myraa.companion.capabilities.ActiveSessionItem> = withContext(Dispatchers.IO) {
        val url = "http://$host:$port/api/remote/security/sessions"
        val request = Request.Builder()
            .url(url)
            .header("Authorization", "Bearer $bearerToken")
            .get()
            .build()

        try {
            client.newCall(request).execute().use { response ->
                val raw = response.body?.string() ?: return@use emptyList()
                val json = JSONObject(raw)
                val arr = json.optJSONArray("sessions") ?: return@use emptyList()
                val list = mutableListOf<com.myraa.companion.capabilities.ActiveSessionItem>()
                for (i in 0 until arr.length()) {
                    val obj = arr.optJSONObject(i)
                    if (obj != null) {
                        list.add(com.myraa.companion.capabilities.ActiveSessionItem.fromJson(obj))
                    }
                }
                list
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to get active sessions: ${e.message}")
            emptyList()
        }
    }

    suspend fun terminateSession(
        host: String,
        port: Int,
        bearerToken: String,
        sessionId: String,
        reason: String? = null
    ): com.myraa.companion.capabilities.SecurityControlOutcome? = withContext(Dispatchers.IO) {
        val url = "http://$host:$port/api/remote/security/sessions/$sessionId"
        val bodyJson = JSONObject().apply {
            if (reason != null) put("reason", reason)
        }
        val request = Request.Builder()
            .url(url)
            .header("Authorization", "Bearer $bearerToken")
            .delete(bodyJson.toString().toRequestBody(JSON_MEDIA_TYPE))
            .build()

        try {
            client.newCall(request).execute().use { response ->
                val raw = response.body?.string() ?: return@use null
                com.myraa.companion.capabilities.SecurityControlOutcome.fromJson(JSONObject(raw))
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to terminate session: ${e.message}")
            null
        }
    }

    suspend fun terminateAllSessions(
        host: String,
        port: Int,
        bearerToken: String,
        reason: String? = null
    ): com.myraa.companion.capabilities.SecurityControlOutcome? = withContext(Dispatchers.IO) {
        val url = "http://$host:$port/api/remote/security/sessions"
        val bodyJson = JSONObject().apply {
            if (reason != null) put("reason", reason)
        }
        val request = Request.Builder()
            .url(url)
            .header("Authorization", "Bearer $bearerToken")
            .delete(bodyJson.toString().toRequestBody(JSON_MEDIA_TYPE))
            .build()

        try {
            client.newCall(request).execute().use { response ->
                val raw = response.body?.string() ?: return@use null
                com.myraa.companion.capabilities.SecurityControlOutcome.fromJson(JSONObject(raw))
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to terminate all sessions: ${e.message}")
            null
        }
    }
}

