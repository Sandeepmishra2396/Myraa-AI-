package com.myraa.companion

import com.myraa.companion.capabilities.AndroidCapabilities
import com.myraa.companion.capabilities.StandaloneMobileAssistant
import com.myraa.companion.networking.MyraaApiClient
import com.myraa.companion.security.SecureTokenStorage
import com.myraa.companion.ui.Screen
import com.myraa.companion.ui.resolveInitialScreen
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Phase 13A — Standalone Android Launch UX & Capability Verification Test Suite.
 * Covers Test Matrix A through L against the Release variant.
 */
class StandaloneMobileLaunchUxTest {

    private val apiClient = MyraaApiClient()
    private val assistant = StandaloneMobileAssistant(
        capabilityRegistry = null,
        apiClient = apiClient
    )

    @Test
    fun testA_freshInstallLaunchesOnboardingNotPairing() {
        val screen = resolveInitialScreen(
            onboardingCompleted = false,
            hasDesktopSession = false
        )
        assertEquals(Screen.ONBOARDING, screen)
        assertNotEquals("Fresh install must NEVER launch directly into PAIRING screen", Screen.PAIRING, screen)
    }

    @Test
    fun testB_returningLaunchOpensMainAssistantDirectlyWithoutPairing() {
        val screen = resolveInitialScreen(
            onboardingCompleted = true,
            hasDesktopSession = false
        )
        assertEquals(Screen.SESSION, screen)
        assertNotEquals(Screen.PAIRING, screen)
    }

    @Test
    fun testC_standaloneVoiceTurnWorksWithoutDesktopPairing() = runBlocking {
        val outcome = assistant.handleUserTurn(
            input = "Hello MYRAA, summarize my morning tasks",
            target = StandaloneMobileAssistant.ExecutionTarget.MOBILE,
            isDesktopConnected = false,
            emergencyStopActive = false,
            securityLockdownActive = false,
            localOnlyMode = false,
            host = SecureTokenStorage.DEFAULT_HOST,
            port = SecureTokenStorage.DEFAULT_PORT,
            deviceId = "mob_standalone_test_c"
        )
        assertTrue(outcome.success)
        assertFalse(outcome.blocked)
        assertFalse(outcome.requiresDesktopPairing)
        assertTrue(outcome.responseText.isNotBlank())
    }

    @Test
    fun testD_standalonePhoneCapabilitiesWorkWithoutDesktop() = runBlocking {
        // 1. Open supported app
        val openYoutube = assistant.handleUserTurn("Open YouTube", isDesktopConnected = false)
        assertTrue(openYoutube.success)
        assertEquals(AndroidCapabilities.OPEN_APP, openYoutube.capabilityExecuted)

        // 2. YouTube search / play
        val ytPlay = assistant.handleUserTurn("Play lofi hip hop on YouTube", isDesktopConnected = false)
        assertTrue(ytPlay.success)
        assertEquals(AndroidCapabilities.INTERACT_APP, ytPlay.capabilityExecuted)

        // 3. Open URL / Browser
        val openUrl = assistant.handleUserTurn("Open https://github.com", isDesktopConnected = false)
        assertTrue(openUrl.success)
        assertEquals(AndroidCapabilities.OPEN_URL, openUrl.capabilityExecuted)

        val openBrowser = assistant.handleUserTurn("Open browser", isDesktopConnected = false)
        assertTrue(openBrowser.success)
        assertEquals(AndroidCapabilities.OPEN_BROWSER, openBrowser.capabilityExecuted)

        // 4. Web search
        val webSearch = assistant.handleUserTurn("Search web for Android 15 AI", isDesktopConnected = false)
        assertTrue(webSearch.success)
        assertEquals(AndroidCapabilities.SEARCH_WEB, webSearch.capabilityExecuted)

        // 5. Alarms
        val alarm = assistant.handleUserTurn("Set alarm for 07:30", isDesktopConnected = false)
        assertTrue(alarm.success)
        assertEquals(AndroidCapabilities.SET_ALARM, alarm.capabilityExecuted)

        // 6. Timers
        val timer = assistant.handleUserTurn("Set timer for 5 minutes", isDesktopConnected = false)
        assertTrue(timer.success)
        assertEquals(AndroidCapabilities.SET_TIMER, timer.capabilityExecuted)

        // 7. Reminders
        val reminder = assistant.handleUserTurn("Remind me to call mom", isDesktopConnected = false)
        assertTrue(reminder.success)
        assertEquals(AndroidCapabilities.CREATE_REMINDER, reminder.capabilityExecuted)

        // 8. Calendar
        val calendar = assistant.handleUserTurn("Schedule meeting Team Sync", isDesktopConnected = false)
        assertTrue(calendar.success)
        assertEquals(AndroidCapabilities.CALENDAR, calendar.capabilityExecuted)

        // 9. Clipboard & Notes
        val clip = assistant.handleUserTurn("Copy to clipboard meeting link", isDesktopConnected = false)
        assertTrue(clip.success)
        assertEquals(AndroidCapabilities.CLIPBOARD, clip.capabilityExecuted)

        // 10. Media controls
        val media = assistant.handleUserTurn("Pause music", isDesktopConnected = false)
        assertTrue(media.success)
        assertEquals(AndroidCapabilities.MEDIA_CONTROLS, media.capabilityExecuted)

        // 11. Device status
        val status = assistant.handleUserTurn("Battery status", isDesktopConnected = false)
        assertTrue(status.success)
        assertEquals(AndroidCapabilities.DEVICE_STATUS, status.capabilityExecuted)
    }

    @Test
    fun testE_mobileContextAndScreenUnderstandingPermissionGate() = runBlocking {
        val ctxOutcome = assistant.handleUserTurn(
            input = "Mobile context",
            isDesktopConnected = false,
            screenContextApproved = false
        )
        assertTrue(ctxOutcome.success)
        assertEquals(AndroidCapabilities.MOBILE_CONTEXT, ctxOutcome.capabilityExecuted)

        // Without explicit screen permission -> blocked fail-closed
        val screenDenied = assistant.handleUserTurn(
            input = "What is on my screen",
            isDesktopConnected = false,
            screenContextApproved = false
        )
        assertFalse(screenDenied.success)
        assertTrue(screenDenied.blocked)
        assertEquals("SCREEN_PERMISSION_REQUIRED", screenDenied.errorCode)

        // With explicit screen permission -> allowed
        val screenAllowed = assistant.handleUserTurn(
            input = "What is on my screen",
            isDesktopConnected = false,
            screenContextApproved = true
        )
        assertTrue(screenAllowed.success)
        assertFalse(screenAllowed.blocked)
        assertEquals(AndroidCapabilities.MOBILE_SCREEN, screenAllowed.capabilityExecuted)
    }

    @Test
    fun testF_sharedMemoryWorksInStandaloneMode() = runBlocking {
        val saveMem = assistant.handleUserTurn(
            input = "Save note Check flight schedule at 6 PM",
            isDesktopConnected = false
        )
        assertTrue(saveMem.success)
        assertEquals(AndroidCapabilities.SHARED_MEMORY, saveMem.capabilityExecuted)

        val listMem = assistant.handleUserTurn(
            input = "List notes",
            isDesktopConnected = false
        )
        assertTrue(listMem.success)
        assertEquals(AndroidCapabilities.SHARED_MEMORY, listMem.capabilityExecuted)
    }

    @Test
    fun testH_pairedModeForwardsDesktopTargetedCommands() = runBlocking {
        var forwardedCommand: String? = null
        val outcome = assistant.handleUserTurn(
            input = "Open VS Code on my desktop",
            target = StandaloneMobileAssistant.ExecutionTarget.DESKTOP,
            isDesktopConnected = true,
            onForwardToDesktop = { cmd -> forwardedCommand = cmd }
        )
        assertTrue(outcome.success)
        assertFalse(outcome.blocked)
        assertEquals("Open VS Code on my desktop", forwardedCommand)
    }

    @Test
    fun testI_desktopDisconnectedModeContinuesPhoneStandaloneNormally() = runBlocking {
        val outcome = assistant.handleUserTurn(
            input = "Set timer for 10 minutes",
            target = StandaloneMobileAssistant.ExecutionTarget.MOBILE,
            isDesktopConnected = false
        )
        assertTrue(outcome.success)
        assertFalse(outcome.blocked)
        assertEquals(AndroidCapabilities.SET_TIMER, outcome.capabilityExecuted)
    }

    @Test
    fun testJ_explicitDesktopCommandWhileDisconnectedFailsClearlyNeverSilentlyFallsBack() = runBlocking {
        // Case 1: User selected DESKTOP target chip while Desktop is disconnected
        val targetDesktopOutcome = assistant.handleUserTurn(
            input = "Open YouTube",
            target = StandaloneMobileAssistant.ExecutionTarget.DESKTOP,
            isDesktopConnected = false
        )
        assertFalse(targetDesktopOutcome.success)
        assertTrue(targetDesktopOutcome.blocked)
        assertEquals("DESKTOP_BRIDGE_OFFLINE", targetDesktopOutcome.errorCode)

        // Case 2: User spoke an explicit desktop command while in MOBILE target mode and Desktop is offline
        val spokenDesktopOutcome = assistant.handleUserTurn(
            input = "Run PowerShell script on my desktop",
            target = StandaloneMobileAssistant.ExecutionTarget.MOBILE,
            isDesktopConnected = false
        )
        assertFalse(spokenDesktopOutcome.success)
        assertTrue(spokenDesktopOutcome.blocked)
        assertEquals("DESKTOP_BRIDGE_OFFLINE", spokenDesktopOutcome.errorCode)
    }

    @Test
    fun testK_emergencyStopAndSecurityLockdownFailClosed() = runBlocking {
        val estopOutcome = assistant.handleUserTurn(
            input = "Open YouTube",
            emergencyStopActive = true
        )
        assertFalse(estopOutcome.success)
        assertTrue(estopOutcome.blocked)
        assertEquals("EMERGENCY_STOP_ACTIVE", estopOutcome.errorCode)

        val lockdownOutcome = assistant.handleUserTurn(
            input = "Set alarm for 08:00",
            securityLockdownActive = true
        )
        assertFalse(lockdownOutcome.success)
        assertTrue(lockdownOutcome.blocked)
        assertEquals("SECURITY_LOCKDOWN_ACTIVE", lockdownOutcome.errorCode)
    }

    @Test
    fun testL_relaunchAfterOnboardingOrDisconnectOpensMainAssistant() {
        val relaunchUnpaired = resolveInitialScreen(onboardingCompleted = true, hasDesktopSession = false)
        val relaunchPaired = resolveInitialScreen(onboardingCompleted = true, hasDesktopSession = true)
        assertEquals(Screen.SESSION, relaunchUnpaired)
        assertEquals(Screen.SESSION, relaunchPaired)
        assertNotNull(relaunchUnpaired)
    }
}
