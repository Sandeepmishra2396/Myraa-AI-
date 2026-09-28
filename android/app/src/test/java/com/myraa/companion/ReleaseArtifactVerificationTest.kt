package com.myraa.companion

import com.myraa.companion.networking.MyraaApiClient
import com.myraa.companion.networking.MyraaWebSocketClient
import com.myraa.companion.security.SecureTokenStorage
import okhttp3.OkHttpClient
import okhttp3.Request
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.TimeUnit

/**
 * Phase 12 — Android Release Artifact & Production Connectivity Verification Test.
 * Executed against the Release build variant via `testReleaseUnitTest`.
 */
class ReleaseArtifactVerificationTest {

    @Test
    fun verifyDefaultProductionHostAndPort() {
        assertEquals("myraa-ai-q0h3.onrender.com", SecureTokenStorage.DEFAULT_HOST)
        assertEquals(443, SecureTokenStorage.DEFAULT_PORT)
    }

    @Test
    fun verifyStrictHttpsBaseUrlEnforcement() {
        val prodUrl = MyraaApiClient.buildBaseUrl(
            SecureTokenStorage.DEFAULT_HOST,
            SecureTokenStorage.DEFAULT_PORT
        )
        assertEquals("https://myraa-ai-q0h3.onrender.com", prodUrl)
        assertTrue(prodUrl.startsWith("https://"))
        assertFalse(prodUrl.startsWith("http://"))

        // Even with custom port or host, must strictly enforce https://
        val customPortUrl = MyraaApiClient.buildBaseUrl("myraa-ai-q0h3.onrender.com", 8443)
        assertEquals("https://myraa-ai-q0h3.onrender.com:8443", customPortUrl)
        assertTrue(customPortUrl.startsWith("https://"))
    }

    @Test
    fun verifyStrictWssWebSocketUrlEnforcement() {
        val prodWsUrl = MyraaWebSocketClient.buildWsUrl(
            SecureTokenStorage.DEFAULT_HOST,
            SecureTokenStorage.DEFAULT_PORT
        )
        assertEquals("wss://myraa-ai-q0h3.onrender.com/remote-live", prodWsUrl)
        assertTrue(prodWsUrl.startsWith("wss://"))
        assertFalse(prodWsUrl.startsWith("ws://"))

        val customWsUrl = MyraaWebSocketClient.buildWsUrl("myraa-ai-q0h3.onrender.com", 8443, "/remote-live")
        assertEquals("wss://myraa-ai-q0h3.onrender.com:8443/remote-live", customWsUrl)
        assertTrue(customWsUrl.startsWith("wss://"))
    }

    @Test
    fun verifyLiveProductionBackendHttpsReachability() {
        val client = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(15, TimeUnit.SECONDS)
            .build()

        val baseUrl = MyraaApiClient.buildBaseUrl(
            SecureTokenStorage.DEFAULT_HOST,
            SecureTokenStorage.DEFAULT_PORT
        )
        val request = Request.Builder()
            .url("$baseUrl/health")
            .get()
            .build()

        client.newCall(request).execute().use { response ->
            assertEquals(200, response.code)
            val body = response.body?.string().orEmpty()
            assertTrue("Expected status ok in health response", body.contains("\"status\":\"ok\""))
            assertTrue("Expected production environment", body.contains("\"environment\":\"production\""))
        }
    }
}
