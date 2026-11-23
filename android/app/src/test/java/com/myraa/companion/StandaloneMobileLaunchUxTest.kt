package com.myraa.companion

import com.myraa.companion.capabilities.AndroidCapabilities
import com.myraa.companion.capabilities.StandaloneMobileAssistant
import com.myraa.companion.networking.ConnectionStatus
import com.myraa.companion.networking.MyraaApiClient
import com.myraa.companion.security.SecureTokenStorage
import com.myraa.companion.ui.Screen
import com.myraa.companion.ui.actions.ActionCatalog
import com.myraa.companion.ui.actions.ActionCategory
import com.myraa.companion.ui.errors.FeatureError
import com.myraa.companion.ui.errors.FeatureErrorSanitizer
import com.myraa.companion.ui.navigation.MainTab
import com.myraa.companion.ui.resolveInitialScreen
import com.myraa.companion.ui.status.FeatureStatus
import com.myraa.companion.ui.status.FeatureStatusEvaluator
import com.myraa.companion.ui.status.RealSystemSnapshot
import com.myraa.companion.ui.voice.VoiceVisualState
import com.myraa.companion.ui.voice.resolveVoiceVisualState
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Phase 13A & Phase 13A-WIN.5 — Standalone Android Launch UX, Feature Isolation & Manual QA Test Suite.
 * Covers Test Matrix A through L plus Phase 13A-WIN.5 UI Architecture & Diagnostic invariants.
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

    // ── Phase 13A-WIN.5 — UI Architecture Redesign & Feature Isolation Tests ────

    @Test
    fun testM_fivePrimaryNavigationTabsAndHomeQuickActionsLimit() {
        val tabs = MainTab.values()
        assertEquals(5, tabs.size)
        assertEquals(MainTab.HOME, tabs[0])
        assertEquals(MainTab.VOICE, tabs[1])
        assertEquals(MainTab.CHAT, tabs[2])
        assertEquals(MainTab.ACTIONS, tabs[3])
        assertEquals(MainTab.SETTINGS, tabs[4])

        // Home Quick Actions must be strictly limited to 7 actions + 1 "More ->" tile (8 total)
        assertEquals(7, ActionCatalog.HOME_QUICK_ACTION_IDS.size)
        assertEquals(7, ActionCatalog.getHomeQuickActions().size)
        assertTrue(ActionCatalog.ALL_ACTIONS.size >= 20)

        val mediaActions = ActionCatalog.ALL_ACTIONS.filter { it.category == ActionCategory.MEDIA }
        assertTrue(mediaActions.isNotEmpty())
        assertNotNull(ActionCatalog.findById("youtube"))
    }

    @Test
    fun testN_realSystemSnapshotDrivesTruthfulFeatureStatusBadges() {
        val readySnapshot = RealSystemSnapshot(
            isNetworkOnline = true,
            hasMicPermission = true,
            hasCalendarPermission = true,
            hasCameraPermission = true,
            screenContextApproved = false,
            privacyShieldEnabled = true,
            localOnlyMode = false,
            hasDesktopSession = false,
            connectionStatus = ConnectionStatus.DISCONNECTED,
            emergencyStopActive = false,
            securityLockdownActive = false,
            isVoiceActive = false
        )
        assertEquals(
            FeatureStatus.READY,
            FeatureStatusEvaluator.evaluateBaselineStatus("voice", readySnapshot)
        )
        assertEquals(
            FeatureStatus.PERMISSION_REQUIRED,
            FeatureStatusEvaluator.evaluateBaselineStatus("screenshot", readySnapshot)
        )
        assertEquals(
            FeatureStatus.REQUIRES_DESKTOP,
            FeatureStatusEvaluator.evaluateBaselineStatus("desktop_bridge", readySnapshot)
        )
        assertEquals(
            FeatureStatus.NOT_SUPPORTED,
            FeatureStatusEvaluator.evaluateBaselineStatus("flashlight", readySnapshot)
        )

        val micDeniedSnapshot = readySnapshot.copy(hasMicPermission = false)
        assertEquals(
            FeatureStatus.PERMISSION_REQUIRED,
            FeatureStatusEvaluator.evaluateBaselineStatus("voice", micDeniedSnapshot)
        )

        val offlineSnapshot = readySnapshot.copy(isNetworkOnline = false)
        assertEquals(
            FeatureStatus.OFFLINE,
            FeatureStatusEvaluator.evaluateBaselineStatus("voice", offlineSnapshot)
        )
    }

    @Test
    fun testO_featureErrorSanitizerRedactsSecretsAndTokens() {
        val raw = "Failed with Bearer sora_dev_987654321abcdef and key AIzaSyD-1234567890abcdef1234567890"
        val sanitized = FeatureErrorSanitizer.sanitize(raw)
        assertFalse(sanitized.contains("sora_dev_987654321abcdef"))
        assertFalse(sanitized.contains("AIzaSyD-1234567890abcdef1234567890"))
        assertTrue(sanitized.contains("[REDACTED_SECRET]"))

        val err = FeatureError(
            feature = "Voice",
            operation = "startVoiceSession",
            stage = "Auth",
            reason = raw
        )
        assertFalse(err.safeReason.contains("sora_dev_987654321abcdef"))
    }

    @Test
    fun testP_voiceVisualStateResolutionCoversAllSixStates() {
        assertEquals(
            VoiceVisualState.READY,
            resolveVoiceVisualState(
                isVoiceActive = false,
                isConnecting = false,
                isThinking = false,
                isModelSpeaking = false,
                hasError = false,
                isSystemHalted = false
            )
        )
        assertEquals(
            VoiceVisualState.CONNECTING,
            resolveVoiceVisualState(
                isVoiceActive = false,
                isConnecting = true,
                isThinking = false,
                isModelSpeaking = false,
                hasError = false,
                isSystemHalted = false
            )
        )
        assertEquals(
            VoiceVisualState.LISTENING,
            resolveVoiceVisualState(
                isVoiceActive = true,
                isConnecting = false,
                isThinking = false,
                isModelSpeaking = false,
                hasError = false,
                isSystemHalted = false
            )
        )
        assertEquals(
            VoiceVisualState.THINKING,
            resolveVoiceVisualState(
                isVoiceActive = true,
                isConnecting = false,
                isThinking = true,
                isModelSpeaking = false,
                hasError = false,
                isSystemHalted = false
            )
        )
        assertEquals(
            VoiceVisualState.SPEAKING,
            resolveVoiceVisualState(
                isVoiceActive = true,
                isConnecting = false,
                isThinking = false,
                isModelSpeaking = true,
                hasError = false,
                isSystemHalted = false
            )
        )
        assertEquals(
            VoiceVisualState.ERROR,
            resolveVoiceVisualState(
                isVoiceActive = false,
                isConnecting = false,
                isThinking = false,
                isModelSpeaking = false,
                hasError = true,
                isSystemHalted = false
            )
        )
    }
}
