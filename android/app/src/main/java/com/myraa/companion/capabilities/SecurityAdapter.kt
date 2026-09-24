package com.myraa.companion.capabilities

import android.content.Context
import android.util.Log
import com.myraa.companion.networking.MyraaApiClient
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * SecurityAdapter
 * Phase 28 — Mobile Emergency & Security Layer
 *
 * Client-side adapter for triggering and observing emergency and security controls
 * from the Android companion app.
 */
class SecurityAdapter(
    private val context: Context,
    private val apiClient: MyraaApiClient = MyraaApiClient()
) {
    companion object {
        private const val TAG = "SecurityAdapter"
    }

    suspend fun getSecurityStatus(
        host: String,
        port: Int,
        bearerToken: String
    ): SecurityStatusData? = withContext(Dispatchers.IO) {
        try {
            apiClient.getSecurityStatus(host, port, bearerToken)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to get security status: ${e.message}")
            null
        }
    }

    suspend fun triggerEmergencyStop(
        host: String,
        port: Int,
        bearerToken: String,
        reason: String? = null
    ): Boolean = withContext(Dispatchers.IO) {
        try {
            apiClient.triggerEmergencyStop(
                reason = reason ?: "Emergency stop triggered from mobile UI",
                bearerToken = bearerToken,
                host = host,
                port = port
            )
        } catch (e: Exception) {
            Log.e(TAG, "Failed to trigger emergency stop: ${e.message}")
            false
        }
    }

    suspend fun triggerLockdown(
        host: String,
        port: Int,
        bearerToken: String,
        reason: String? = null
    ): SecurityControlOutcome? = withContext(Dispatchers.IO) {
        try {
            apiClient.triggerLockdown(host, port, bearerToken, reason)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to trigger lockdown: ${e.message}")
            null
        }
    }

    suspend fun recoverFromLockdown(
        host: String,
        port: Int,
        bearerToken: String
    ): SecurityControlOutcome? = withContext(Dispatchers.IO) {
        try {
            apiClient.recoverFromLockdown(host, port, bearerToken)
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
    ): SecurityControlOutcome? = withContext(Dispatchers.IO) {
        try {
            apiClient.enableLostDevice(host, port, bearerToken, deviceId, reason)
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
    ): SecurityControlOutcome? = withContext(Dispatchers.IO) {
        try {
            apiClient.recoverLostDevice(host, port, bearerToken, deviceId)
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
    ): SecurityControlOutcome? = withContext(Dispatchers.IO) {
        try {
            apiClient.logoutAllDevices(host, port, bearerToken, reason)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to logout all devices: ${e.message}")
            null
        }
    }

    suspend fun getActiveSessions(
        host: String,
        port: Int,
        bearerToken: String
    ): List<ActiveSessionItem> = withContext(Dispatchers.IO) {
        try {
            apiClient.getActiveSessions(host, port, bearerToken)
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
    ): SecurityControlOutcome? = withContext(Dispatchers.IO) {
        try {
            apiClient.terminateSession(host, port, bearerToken, sessionId, reason)
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
    ): SecurityControlOutcome? = withContext(Dispatchers.IO) {
        try {
            apiClient.terminateAllSessions(host, port, bearerToken, reason)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to terminate all sessions: ${e.message}")
            null
        }
    }

    fun getContext(): Context = context
}
