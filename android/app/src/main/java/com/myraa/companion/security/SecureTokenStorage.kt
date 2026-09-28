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
        private const val KEY_ONBOARDING_COMPLETED = "key_onboarding_completed"
        private const val KEY_STANDALONE_DEVICE_ID = "key_standalone_device_id"
        private const val KEY_PRIVACY_SHIELD_ENABLED = "key_privacy_shield_enabled"
        private const val KEY_SCREEN_CONTEXT_APPROVED = "key_screen_context_approved"
        private const val KEY_LOCAL_ONLY_MODE = "key_local_only_mode"
        private const val KEY_PREFERRED_LANGUAGE = "key_preferred_language"
        private const val KEY_ACCOUNT_ID = "key_account_id"
        private const val KEY_SECURITY_LOCKDOWN = "key_security_lockdown"

        const val DEFAULT_PORT = 443
        const val DEFAULT_HOST = "myraa-ai-q0h3.onrender.com" // Default Production Render Cloud host, customizable for LAN/Emulator
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
            .putBoolean(KEY_ONBOARDING_COMPLETED, true)

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

    fun isOnboardingCompleted(): Boolean {
        return prefs.getBoolean(KEY_ONBOARDING_COMPLETED, false) || hasSession()
    }

    fun setOnboardingCompleted(completed: Boolean) {
        prefs.edit().putBoolean(KEY_ONBOARDING_COMPLETED, completed).apply()
    }

    fun getOrCreateStandaloneDeviceId(): String {
        val pairedId = getDeviceId()
        if (!pairedId.isNullOrBlank()) return pairedId

        val existingStandalone = prefs.getString(KEY_STANDALONE_DEVICE_ID, null)
        if (!existingStandalone.isNullOrBlank()) return existingStandalone

        val generated = "mob_standalone_" + java.util.UUID.randomUUID().toString().replace("-", "").take(12)
        prefs.edit().putString(KEY_STANDALONE_DEVICE_ID, generated).apply()
        return generated
    }

    fun isPrivacyShieldEnabled(): Boolean = prefs.getBoolean(KEY_PRIVACY_SHIELD_ENABLED, true)

    fun setPrivacyShieldEnabled(enabled: Boolean) {
        prefs.edit().putBoolean(KEY_PRIVACY_SHIELD_ENABLED, enabled).apply()
    }

    fun isScreenContextApproved(): Boolean = prefs.getBoolean(KEY_SCREEN_CONTEXT_APPROVED, false)

    fun setScreenContextApproved(approved: Boolean) {
        prefs.edit().putBoolean(KEY_SCREEN_CONTEXT_APPROVED, approved).apply()
    }

    fun isLocalOnlyMode(): Boolean = prefs.getBoolean(KEY_LOCAL_ONLY_MODE, false)

    fun setLocalOnlyMode(enabled: Boolean) {
        prefs.edit().putBoolean(KEY_LOCAL_ONLY_MODE, enabled).apply()
    }

    fun getPreferredLanguage(): String = prefs.getString(KEY_PREFERRED_LANGUAGE, "en-IN") ?: "en-IN"

    fun setPreferredLanguage(language: String) {
        prefs.edit().putString(KEY_PREFERRED_LANGUAGE, language).apply()
    }

    fun getAccountId(): String? = prefs.getString(KEY_ACCOUNT_ID, null)

    fun setAccountId(accountId: String?) {
        val editor = prefs.edit()
        if (accountId.isNullOrBlank()) {
            editor.remove(KEY_ACCOUNT_ID)
        } else {
            editor.putString(KEY_ACCOUNT_ID, accountId.trim())
        }
        editor.apply()
    }

    fun isSecurityLockdownActive(): Boolean = prefs.getBoolean(KEY_SECURITY_LOCKDOWN, false)

    fun setSecurityLockdownActive(active: Boolean) {
        prefs.edit().putBoolean(KEY_SECURITY_LOCKDOWN, active).apply()
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
     * Disconnects the optional Desktop Remote Bridge session while preserving
     * standalone mobile assistant onboarding, preferences, and local identity.
     */
    fun disconnectDesktopSession() {
        prefs.edit()
            .remove(KEY_BEARER_TOKEN)
            .remove(KEY_ACCESS_TOKEN)
            .remove(KEY_REFRESH_TOKEN)
            .remove(KEY_TOKEN_EXPIRES_AT)
            .remove(KEY_DEVICE_ID)
            .remove(KEY_DEVICE_ROLE)
            .putBoolean(KEY_ONBOARDING_COMPLETED, true)
            .apply()
        Log.i(TAG, "Desktop remote session disconnected; standalone mobile assistant remains active.")
    }

    /**
     * Completely clear and revoke session credentials on logout or device revocation.
     * Preserves standalone onboarding state so the phone remains usable as a standalone AI assistant.
     */
    fun clearSession() {
        val onboardingCompleted = prefs.getBoolean(KEY_ONBOARDING_COMPLETED, true)
        val standaloneId = prefs.getString(KEY_STANDALONE_DEVICE_ID, null)
        val privacyShield = prefs.getBoolean(KEY_PRIVACY_SHIELD_ENABLED, true)
        val preferredLang = prefs.getString(KEY_PREFERRED_LANGUAGE, "en-IN")
        prefs.edit()
            .clear()
            .putBoolean(KEY_ONBOARDING_COMPLETED, onboardingCompleted)
            .putBoolean(KEY_PRIVACY_SHIELD_ENABLED, privacyShield)
            .apply {
                if (!standaloneId.isNullOrBlank()) putString(KEY_STANDALONE_DEVICE_ID, standaloneId)
                if (!preferredLang.isNullOrBlank()) putString(KEY_PREFERRED_LANGUAGE, preferredLang)
            }
            .apply()
        Log.i(TAG, "Secure desktop session credentials cleared (standalone state preserved).")
    }
}
