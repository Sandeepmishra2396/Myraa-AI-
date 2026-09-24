package com.myraa.companion.networking

/**
 * NetworkModels
 * Phase 16 — Android Companion Foundation
 *
 * Data models strictly aligned with Phase 15 AndroidContract.ts.
 */

data class DeviceMeta(
    val model: String,
    val androidVersion: String,
    val appVersion: String
)

data class PairingRequest(
    val code: String,
    val deviceName: String,
    val deviceType: String = "mobile",
    val deviceMeta: DeviceMeta
)

data class PairingSuccess(
    val token: String,
    val deviceRole: String,
    val deviceId: String,
    val expiresAt: String? = null,
    val accessToken: String? = null,
    val refreshToken: String? = null,
    val expiresInSeconds: Int? = null
)

sealed class PairingResult {
    data class Success(val data: PairingSuccess) : PairingResult()
    data class Error(val code: String, val message: String) : PairingResult()
}

sealed class TokenRefreshResult {
    data class Success(
        val accessToken: String,
        val refreshToken: String,
        val expiresInSeconds: Int
    ) : TokenRefreshResult()
    data class Error(
        val error: String,
        val isReplayDetected: Boolean
    ) : TokenRefreshResult()
}

data class EmergencyStopState(
    val active: Boolean,
    val triggeredAt: String? = null,
    val reason: String? = null,
    val resetAt: String? = null
)

enum class ConnectionStatus {
    DISCONNECTED,
    CONNECTING,
    AUTHENTICATED,
    RECONNECTING,
    ERROR
}

data class TranscriptItem(
    val id: String = java.util.UUID.randomUUID().toString(),
    val sender: Speaker,
    val text: String,
    val timestampMs: Long = System.currentTimeMillis()
) {
    enum class Speaker {
        USER,
        MYRAA,
        SYSTEM
    }
}
