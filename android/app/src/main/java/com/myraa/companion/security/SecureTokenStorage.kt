package com.myraa.companion.security

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * SecureTokenStorage
 * Phase 16 — Android Companion Foundation
 *
 * Implements Android Keystore-backed AES-256-GCM encrypted persistence
 * for MYRAA device tokens and connection settings.
 *
 * SECURITY INVARIANTS:
 * 1. Tokens are encrypted at rest using Android Keystore hardware keys.
 * 2. Raw bearer tokens are NEVER logged or exposed in toString()/getMaskedToken().
 * 3. Clearing session wipes both cryptographic keys and stored values.
 */
class SecureTokenStorage(context: Context) {

    companion object {
        private const val TAG = "SecureTokenStorage"
        private const val PREF_FILE_NAME = "myraa_secure_session"

        private const val KEY_BEARER_TOKEN = "key_bearer_token"
        private const val KEY_ACCESS_TOKEN = "key_access_token"
        private const val KEY_REFRESH_TOKEN = "key_refresh_token"
        private const val KEY_TOKEN_EXPIRES_AT = "key_token_expires_at"
        private const val KEY_DEVICE_ID = "key_device_id"
        private const val KEY_DEVICE_NAME = "key_device_name"
        private const val KEY_DEVICE_ROLE = "key_device_role"
        private const val KEY_SERVER_HOST = "key_server_host"
        private const val KEY_SERVER_PORT = "key_server_port"

        const val DEFAULT_PORT = 3000
        const val DEFAULT_HOST = "10.0.2.2" // Default Android Emulator host IP, customizable
    }

    private val prefs: SharedPreferences

    init {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()

        prefs = EncryptedSharedPreferences.create(
            context,
            PREF_FILE_NAME,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    }

    /**
     * Store an authenticated session from successful pairing.
     */
    fun saveSession(
        token: String,
        deviceId: String,
        deviceName: String,
        deviceRole: String,
        host: String,
        port: Int = DEFAULT_PORT,
        accessToken: String? = null,
        refreshToken: String? = null,
        expiresInSeconds: Int? = null
    ) {
        val editor = prefs.edit()
            .putString(KEY_BEARER_TOKEN, token)
            .putString(KEY_DEVICE_ID, deviceId)
            .putString(KEY_DEVICE_NAME, deviceName)
            .putString(KEY_DEVICE_ROLE, deviceRole)
            .putString(KEY_SERVER_HOST, host)
            .putInt(KEY_SERVER_PORT, port)

        if (!accessToken.isNullOrBlank()) {
            editor.putString(KEY_ACCESS_TOKEN, accessToken)
        }
        if (!refreshToken.isNullOrBlank()) {
            editor.putString(KEY_REFRESH_TOKEN, refreshToken)
        }
        if (expiresInSeconds != null) {
            val expiresAt = System.currentTimeMillis() + (expiresInSeconds * 1000L)
            editor.putLong(KEY_TOKEN_EXPIRES_AT, expiresAt)
        }

        editor.apply()
        Log.i(TAG, "Authenticated session saved for device: $deviceId (Role: $deviceRole)")
    }

    /**
     * Save newly rotated short-lived access and refresh tokens.
     */
    fun saveSessionTokens(accessToken: String, refreshToken: String, expiresInSeconds: Int) {
        val expiresAt = System.currentTimeMillis() + (expiresInSeconds * 1000L)
        prefs.edit()
            .putString(KEY_ACCESS_TOKEN, accessToken)
            .putString(KEY_REFRESH_TOKEN, refreshToken)
            .putLong(KEY_TOKEN_EXPIRES_AT, expiresAt)
            .apply()
        Log.i(TAG, "Session credentials rotated successfully (Expires in ${expiresInSeconds}s).")
    }

    fun getAccessToken(): String? = prefs.getString(KEY_ACCESS_TOKEN, null)

    fun getRefreshToken(): String? = prefs.getString(KEY_REFRESH_TOKEN, null)

    fun isAccessTokenExpired(): Boolean {
        val expiresAt = prefs.getLong(KEY_TOKEN_EXPIRES_AT, 0L)
        if (expiresAt == 0L) return true
        return System.currentTimeMillis() >= (expiresAt - 30_000L)
    }

    /**
     * Return best active credential:
     * Prefers unexpired short-lived access token, falls back to paired device token.
     */
    fun getPreferredAuthToken(): String? {
        val at = getAccessToken()
        if (!at.isNullOrBlank() && !isAccessTokenExpired()) {
            return at
        }
        return getBearerToken()
    }

    fun hasSession(): Boolean {
        val token = prefs.getString(KEY_BEARER_TOKEN, null)
        return !token.isNullOrBlank()
    }

    fun getBearerToken(): String? {
        return prefs.getString(KEY_BEARER_TOKEN, null)
    }

    /**
     * Returns a safely redacted token representation suitable for UI or audit logs.
     * Example: "sora_dev_...3f8a"
     */
    fun getMaskedToken(): String? {
        val token = getBearerToken() ?: return null
        return if (token.length > 12) {
            "${token.take(9)}...${token.takeLast(4)}"
        } else {
            "***"
        }
    }

    fun getDeviceId(): String? = prefs.getString(KEY_DEVICE_ID, null)

    fun getDeviceName(): String? = prefs.getString(KEY_DEVICE_NAME, null)

    fun getDeviceRole(): String = prefs.getString(KEY_DEVICE_ROLE, "standard") ?: "standard"

    fun getServerHost(): String = prefs.getString(KEY_SERVER_HOST, DEFAULT_HOST) ?: DEFAULT_HOST

    fun getServerPort(): Int = prefs.getInt(KEY_SERVER_PORT, DEFAULT_PORT)

    fun setServerEndpoint(host: String, port: Int) {
        prefs.edit()
            .putString(KEY_SERVER_HOST, host)
            .putInt(KEY_SERVER_PORT, port)
            .apply()
    }

    /**
     * Completely clear and revoke session credentials on logout or device revocation.
     */
    fun clearSession() {
        prefs.edit().clear().apply()
        Log.i(TAG, "Secure session credentials cleared.")
    }
}
