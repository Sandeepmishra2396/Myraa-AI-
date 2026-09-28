package com.myraa.companion.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.myraa.companion.capabilities.AndroidCapabilityAdapter
import com.myraa.companion.capabilities.AndroidCapabilityRegistry
import com.myraa.companion.capabilities.StandaloneMobileAssistant
import com.myraa.companion.networking.ConnectionStatus
import com.myraa.companion.networking.EmergencyStopState
import com.myraa.companion.networking.MyraaApiClient
import com.myraa.companion.networking.MyraaWebSocketClient
import com.myraa.companion.networking.PairingResult
import com.myraa.companion.networking.TokenRefreshResult
import com.myraa.companion.networking.TranscriptItem
import com.myraa.companion.security.SecureTokenStorage
import com.myraa.companion.service.LiveAudioForegroundService
import com.myraa.companion.ui.screens.MainSessionScreen
import com.myraa.companion.ui.screens.MobileOnboardingScreen
import com.myraa.companion.ui.screens.PairingScreen
import com.myraa.companion.ui.screens.SettingsScreen
import com.myraa.companion.ui.theme.MyraaDarkBg
import com.myraa.companion.ui.theme.MyraaTheme
import com.myraa.companion.voice.VoiceSessionManager
import kotlinx.coroutines.launch

enum class Screen {
    ONBOARDING,
    SESSION,
    SETTINGS,
    PAIRING
}

/**
 * Pure launch screen resolver for MYRAA Mobile:
 * - First launch (onboarding not completed and no existing session): Screen.ONBOARDING
 * - Returning launch (onboarding completed or session exists): Screen.SESSION (Standalone Assistant)
 * - NEVER launches directly into Screen.PAIRING.
 */
fun resolveInitialScreen(onboardingCompleted: Boolean, hasDesktopSession: Boolean): Screen {
    return if (onboardingCompleted || hasDesktopSession) Screen.SESSION else Screen.ONBOARDING
}

/**
 * MainActivity
 * Phase 18 — Android Voice Assistant
 * Phase 13A — Standalone Mobile AI Assistant Launch UX
 *
 * Coordinates:
 *  - First-launch Standalone Mobile Onboarding -> Main Assistant (no Desktop pairing required)
 *  - Returning launch directly into Main MYRAA Mobile Assistant
 *  - Optional Desktop pairing only via Settings -> Devices -> Connect Desktop
 *  - Standalone phone capabilities + Gemini Live / Cloud HTTPS voice turns
 *  - Emergency Stop & Security Lockdown fail-closed enforcement
 */
class MainActivity : ComponentActivity() {

    private lateinit var tokenStorage: SecureTokenStorage
    private lateinit var apiClient: MyraaApiClient
    private lateinit var wsClient: MyraaWebSocketClient
    private lateinit var voiceSession: VoiceSessionManager
    private lateinit var capabilityAdapter: AndroidCapabilityAdapter
    private lateinit var capabilityRegistry: AndroidCapabilityRegistry
    private lateinit var standaloneAssistant: StandaloneMobileAssistant

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        tokenStorage = SecureTokenStorage(applicationContext)
        apiClient = MyraaApiClient()
        wsClient = MyraaWebSocketClient()
        voiceSession = VoiceSessionManager(wsClient)
        capabilityAdapter = AndroidCapabilityAdapter(applicationContext, voiceSession)
        capabilityRegistry = AndroidCapabilityRegistry(capabilityAdapter)
        wsClient.capabilityRegistry = capabilityRegistry
        standaloneAssistant = StandaloneMobileAssistant(capabilityRegistry, apiClient)

        setContent {
            MyraaTheme {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = MyraaDarkBg
                ) {
                    MyraaCompanionApp(
                        tokenStorage = tokenStorage,
                        apiClient = apiClient,
                        wsClient = wsClient,
                        voiceSession = voiceSession,
                        standaloneAssistant = standaloneAssistant,
                        activity = this
                    )
                }
            }
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        voiceSession.stopVoiceSession()
        wsClient.disconnect()
        LiveAudioForegroundService.stop(applicationContext)
    }
}

@Composable
fun MyraaCompanionApp(
    tokenStorage: SecureTokenStorage,
    apiClient: MyraaApiClient,
    wsClient: MyraaWebSocketClient,
    voiceSession: VoiceSessionManager,
    standaloneAssistant: StandaloneMobileAssistant,
    activity: ComponentActivity
) {
    val scope = rememberCoroutineScope()

    var currentScreen by remember {
        mutableStateOf(
            resolveInitialScreen(
                onboardingCompleted = tokenStorage.isOnboardingCompleted(),
                hasDesktopSession = tokenStorage.hasSession()
            )
        )
    }

    var hasDesktopSession by remember { mutableStateOf(tokenStorage.hasSession()) }
    var privacyShieldEnabled by remember { mutableStateOf(tokenStorage.isPrivacyShieldEnabled()) }
    var screenContextApproved by remember { mutableStateOf(tokenStorage.isScreenContextApproved()) }
    var localOnlyMode by remember { mutableStateOf(tokenStorage.isLocalOnlyMode()) }
    var securityLockdownActive by remember { mutableStateOf(tokenStorage.isSecurityLockdownActive()) }
    var selectedTarget by remember {
        mutableStateOf(StandaloneMobileAssistant.ExecutionTarget.MOBILE)
    }

    val connectionStatus by wsClient.connectionStatus.collectAsState()
    val isVoiceActive by voiceSession.isVoiceActive.collectAsState()
    val isMicMuted by voiceSession.isMicMuted.collectAsState()
    val isModelSpeaking by voiceSession.isModelSpeaking.collectAsState()
    val isUserSpeaking by voiceSession.isUserSpeaking.collectAsState()

    var emergencyStopState by remember {
        mutableStateOf(EmergencyStopState(active = false))
    }

    val transcripts = remember {
        mutableStateListOf(
            TranscriptItem(
                sender = TranscriptItem.Speaker.MYRAA,
                text = "MYRAA Mobile is ready on your phone (Standalone Mode). Start a voice session, tap a quick phone action, or ask anything below — no Desktop pairing required."
            )
        )
    }
    var pairingError by remember { mutableStateOf<String?>(null) }
    var isPairingLoading by remember { mutableStateOf(false) }

    var permissionRationale by remember { mutableStateOf<String?>(null) }
    var isPermanentlyDenied by remember { mutableStateOf(false) }
    var hasMicPermissionState by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(
                activity,
                Manifest.permission.RECORD_AUDIO
            ) == PackageManager.PERMISSION_GRANTED
        )
    }

    // Safe permission launcher with rationale and permanent denial handling
    val permissionLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestPermission()
    ) { isGranted ->
        hasMicPermissionState = isGranted
        if (isGranted) {
            permissionRationale = null
            isPermanentlyDenied = false
            if (currentScreen == Screen.SESSION) {
                val started = voiceSession.startVoiceSession()
                if (started) {
                    LiveAudioForegroundService.start(activity.applicationContext)
                }
            }
        } else {
            val shouldShowRationale = ActivityCompat.shouldShowRequestPermissionRationale(
                activity,
                Manifest.permission.RECORD_AUDIO
            )
            if (shouldShowRationale) {
                permissionRationale = "Microphone access is required for real-time bidirectional voice conversation with MYRAA. Please grant permission to continue."
                isPermanentlyDenied = false
            } else {
                permissionRationale = "Microphone permission has been permanently denied. Please enable it in Android Settings to talk with MYRAA."
                isPermanentlyDenied = true
            }
        }
    }

    // Connect optional Desktop WebSocket ONLY when an authenticated Desktop pairing session exists
    LaunchedEffect(currentScreen, hasDesktopSession) {
        if (currentScreen == Screen.SESSION && hasDesktopSession && tokenStorage.hasSession()) {
            val host = tokenStorage.getServerHost()
            val port = tokenStorage.getServerPort()

            // Wire automatic token rotation on WebSocket reconnect
            wsClient.tokenRefreshProvider = {
                val rf = tokenStorage.getRefreshToken()
                val devTok = tokenStorage.getBearerToken()
                if (tokenStorage.isAccessTokenExpired() && !rf.isNullOrBlank()) {
                    val refreshResult = apiClient.rotateSessionToken(rf, host, port, devTok)
                    when (refreshResult) {
                        is TokenRefreshResult.Success -> {
                            tokenStorage.saveSessionTokens(
                                accessToken = refreshResult.accessToken,
                                refreshToken = refreshResult.refreshToken,
                                expiresInSeconds = refreshResult.expiresInSeconds
                            )
                            refreshResult.accessToken
                        }
                        is TokenRefreshResult.Error -> {
                            if (refreshResult.isReplayDetected) {
                                tokenStorage.disconnectDesktopSession()
                                hasDesktopSession = false
                                null
                            } else {
                                devTok
                            }
                        }
                    }
                } else {
                    tokenStorage.getPreferredAuthToken() ?: devTok
                }
            }

            // Proactive token rotation before initial connection if expired
            val rf = tokenStorage.getRefreshToken()
            val devTok = tokenStorage.getBearerToken()
            if (tokenStorage.isAccessTokenExpired() && !rf.isNullOrBlank()) {
                val refreshResult = apiClient.rotateSessionToken(rf, host, port, devTok)
                when (refreshResult) {
                    is TokenRefreshResult.Success -> {
                        tokenStorage.saveSessionTokens(
                            accessToken = refreshResult.accessToken,
                            refreshToken = refreshResult.refreshToken,
                            expiresInSeconds = refreshResult.expiresInSeconds
                        )
                    }
                    is TokenRefreshResult.Error -> {
                        if (refreshResult.isReplayDetected) {
                            Toast.makeText(activity, "Desktop session expired or revoked. Continuing in Standalone Phone mode.", Toast.LENGTH_LONG).show()
                            tokenStorage.disconnectDesktopSession()
                            hasDesktopSession = false
                            return@LaunchedEffect
                        }
                    }
                }
            }

            val token = tokenStorage.getPreferredAuthToken() ?: tokenStorage.getBearerToken() ?: ""
            wsClient.connect(host, port, token)

            // Check server emergency stop state on load
            scope.launch {
                val state = apiClient.getEmergencyStopStatus(host, port)
                if (state != null) {
                    emergencyStopState = state
                    if (state.active) {
                        voiceSession.onEmergencyStop()
                        LiveAudioForegroundService.stop(activity.applicationContext)
                    }
                }
            }
        }
    }

    // Wire WebSocket callbacks
    DisposableEffect(wsClient) {
        wsClient.onTranscriptReceived = { item ->
            transcripts.add(item)
        }

        wsClient.onEmergencyStopChanged = { state ->
            emergencyStopState = state
            if (state.active) {
                voiceSession.onEmergencyStop()
                LiveAudioForegroundService.stop(activity.applicationContext)
            }
        }

        wsClient.onStatusMessage = { statusText ->
            transcripts.add(
                TranscriptItem(
                    sender = TranscriptItem.Speaker.SYSTEM,
                    text = statusText
                )
            )
        }

        onDispose {
            wsClient.onTranscriptReceived = null
            wsClient.onEmergencyStopChanged = null
            wsClient.onStatusMessage = null
        }
    }

    when (currentScreen) {
        Screen.ONBOARDING -> {
            MobileOnboardingScreen(
                initialLanguage = tokenStorage.getPreferredLanguage(),
                initialPrivacyShield = privacyShieldEnabled,
                initialScreenApproved = screenContextApproved,
                initialLocalOnly = localOnlyMode,
                initialAccountId = tokenStorage.getAccountId() ?: "",
                hasMicPermission = hasMicPermissionState,
                onRequestMicPermission = {
                    permissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
                },
                onCompleteOnboarding = { lang, shield, screenOk, localOnly, accountId ->
                    tokenStorage.setPreferredLanguage(lang)
                    tokenStorage.setPrivacyShieldEnabled(shield)
                    tokenStorage.setScreenContextApproved(screenOk)
                    tokenStorage.setLocalOnlyMode(localOnly)
                    tokenStorage.setAccountId(accountId)
                    tokenStorage.setOnboardingCompleted(true)

                    privacyShieldEnabled = shield
                    screenContextApproved = screenOk
                    localOnlyMode = localOnly
                    currentScreen = Screen.SESSION

                    val standaloneId = tokenStorage.getOrCreateStandaloneDeviceId()
                    val host = tokenStorage.getServerHost()
                    val port = tokenStorage.getServerPort()
                    scope.launch {
                        apiClient.completeMobileOnboarding(
                            host = host,
                            port = port,
                            deviceId = standaloneId,
                            accountId = accountId,
                            permissionsGranted = mapOf(
                                "microphone" to hasMicPermissionState,
                                "screenUnderstanding" to screenOk,
                                "privacyShield" to shield
                            )
                        )
                        apiClient.syncMobileSettings(
                            host = host,
                            port = port,
                            deviceId = standaloneId,
                            privacyShieldEnabled = shield,
                            localOnlyMode = localOnly,
                            preferredLanguage = lang
                        )
                    }
                },
                onSkipOnboarding = {
                    tokenStorage.setOnboardingCompleted(true)
                    currentScreen = Screen.SESSION
                }
            )
        }

        Screen.SESSION -> {
            MainSessionScreen(
                connectionStatus = connectionStatus,
                isDesktopPaired = hasDesktopSession,
                securityLockdownActive = securityLockdownActive,
                selectedTarget = selectedTarget,
                onSelectTarget = { target -> selectedTarget = target },
                isVoiceActive = isVoiceActive,
                isMicMuted = isMicMuted,
                isModelSpeaking = isModelSpeaking,
                isUserSpeaking = isUserSpeaking,
                permissionRationale = permissionRationale,
                isPermanentlyDenied = isPermanentlyDenied,
                emergencyStopState = emergencyStopState,
                transcripts = transcripts,
                // In standalone mode the phone owner can always reset local Emergency Stop; when paired, admin role or standalone reset applies
                canResetEmergencyStop = !hasDesktopSession || tokenStorage.getDeviceRole() == "admin",
                onToggleVoice = {
                    if (emergencyStopState.active || securityLockdownActive) {
                        Toast.makeText(activity, "Cannot start voice while Emergency Stop or Lockdown is active.", Toast.LENGTH_SHORT).show()
                        return@MainSessionScreen
                    }
                    if (isVoiceActive) {
                        voiceSession.stopVoiceSession()
                        LiveAudioForegroundService.stop(activity.applicationContext)
                    } else {
                        val hasMicPermission = ContextCompat.checkSelfPermission(
                            activity,
                            Manifest.permission.RECORD_AUDIO
                        ) == PackageManager.PERMISSION_GRANTED
                        hasMicPermissionState = hasMicPermission

                        if (hasMicPermission) {
                            permissionRationale = null
                            val started = voiceSession.startVoiceSession()
                            if (started) {
                                LiveAudioForegroundService.start(activity.applicationContext)
                                transcripts.add(
                                    TranscriptItem(
                                        sender = TranscriptItem.Speaker.SYSTEM,
                                        text = if (connectionStatus == ConnectionStatus.AUTHENTICATED) {
                                            "Voice session active (Standalone Phone AI + Desktop Bridge connected)."
                                        } else {
                                            "Standalone Phone Voice Session active — speak or tap a command below."
                                        }
                                    )
                                )
                            }
                        } else {
                            if (isPermanentlyDenied) {
                                permissionRationale = "Microphone permission has been disabled. Please open Settings to enable it."
                            } else {
                                permissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
                            }
                        }
                    }
                },
                onToggleMute = {
                    voiceSession.setMicMuted(!isMicMuted)
                },
                onRequestPermissionAgain = {
                    permissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
                },
                onOpenAppSettings = {
                    val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                        data = Uri.fromParts("package", activity.packageName, null)
                    }
                    activity.startActivity(intent)
                },
                onDismissPermissionRationale = {
                    permissionRationale = null
                },
                onSendText = { text ->
                    transcripts.add(
                        TranscriptItem(
                            sender = TranscriptItem.Speaker.USER,
                            text = text
                        )
                    )
                    scope.launch {
                        val outcome = standaloneAssistant.handleUserTurn(
                            input = text,
                            target = selectedTarget,
                            isDesktopConnected = connectionStatus == ConnectionStatus.AUTHENTICATED,
                            emergencyStopActive = emergencyStopState.active,
                            securityLockdownActive = securityLockdownActive,
                            screenContextApproved = screenContextApproved,
                            privacyShieldEnabled = privacyShieldEnabled,
                            localOnlyMode = localOnlyMode,
                            host = tokenStorage.getServerHost(),
                            port = tokenStorage.getServerPort(),
                            deviceId = tokenStorage.getOrCreateStandaloneDeviceId(),
                            language = tokenStorage.getPreferredLanguage(),
                            onForwardToDesktop = { desktopCmd ->
                                wsClient.sendTextMessage(desktopCmd)
                            }
                        )
                        transcripts.add(
                            TranscriptItem(
                                sender = if (outcome.blocked) TranscriptItem.Speaker.SYSTEM else TranscriptItem.Speaker.MYRAA,
                                text = outcome.responseText
                            )
                        )
                    }
                },
                onTriggerEmergencyStop = {
                    scope.launch {
                        val host = tokenStorage.getServerHost()
                        val port = tokenStorage.getServerPort()
                        val token = tokenStorage.getBearerToken()
                        emergencyStopState = EmergencyStopState(
                            active = true,
                            reason = "Triggered from mobile device"
                        )
                        voiceSession.onEmergencyStop()
                        LiveAudioForegroundService.stop(activity.applicationContext)
                        transcripts.add(
                            TranscriptItem(
                                sender = TranscriptItem.Speaker.SYSTEM,
                                text = "EMERGENCY STOP TRIGGERED — All voice and capability execution halted."
                            )
                        )
                        apiClient.triggerEmergencyStop("Triggered by Android user", token, host, port)
                    }
                },
                onResetEmergencyStop = {
                    scope.launch {
                        val host = tokenStorage.getServerHost()
                        val port = tokenStorage.getServerPort()
                        val token = tokenStorage.getBearerToken()
                        if (!hasDesktopSession || token.isNullOrBlank()) {
                            emergencyStopState = EmergencyStopState(active = false)
                            Toast.makeText(activity, "Standalone Emergency Stop reset", Toast.LENGTH_SHORT).show()
                        } else {
                            val success = apiClient.resetEmergencyStop(token, host, port)
                            if (success) {
                                emergencyStopState = EmergencyStopState(active = false)
                                Toast.makeText(activity, "Emergency Stop reset successfully", Toast.LENGTH_SHORT).show()
                            } else {
                                emergencyStopState = EmergencyStopState(active = false)
                                Toast.makeText(activity, "Local Emergency Stop reset", Toast.LENGTH_SHORT).show()
                            }
                        }
                    }
                },
                onOpenSettings = {
                    currentScreen = Screen.SETTINGS
                }
            )
        }

        Screen.SETTINGS -> {
            SettingsScreen(
                standaloneDeviceId = tokenStorage.getOrCreateStandaloneDeviceId(),
                hasDesktopSession = hasDesktopSession,
                connectionStatus = connectionStatus,
                deviceId = tokenStorage.getDeviceId(),
                deviceName = tokenStorage.getDeviceName(),
                deviceRole = tokenStorage.getDeviceRole(),
                maskedToken = tokenStorage.getMaskedToken(),
                serverHost = tokenStorage.getServerHost(),
                serverPort = tokenStorage.getServerPort(),
                privacyShieldEnabled = privacyShieldEnabled,
                onPrivacyShieldChanged = { enabled ->
                    privacyShieldEnabled = enabled
                    tokenStorage.setPrivacyShieldEnabled(enabled)
                },
                screenContextApproved = screenContextApproved,
                onScreenContextApprovedChanged = { approved ->
                    screenContextApproved = approved
                    tokenStorage.setScreenContextApproved(approved)
                },
                localOnlyMode = localOnlyMode,
                onLocalOnlyModeChanged = { enabled ->
                    localOnlyMode = enabled
                    tokenStorage.setLocalOnlyMode(enabled)
                },
                securityLockdownActive = securityLockdownActive,
                onToggleSecurityLockdown = { lockdown ->
                    securityLockdownActive = lockdown
                    tokenStorage.setSecurityLockdownActive(lockdown)
                    if (lockdown) {
                        voiceSession.onEmergencyStop()
                        LiveAudioForegroundService.stop(activity.applicationContext)
                        transcripts.add(
                            TranscriptItem(
                                sender = TranscriptItem.Speaker.SYSTEM,
                                text = "SECURITY LOCKDOWN ENABLED — All phone and remote capabilities are fail-closed."
                            )
                        )
                    } else {
                        transcripts.add(
                            TranscriptItem(
                                sender = TranscriptItem.Speaker.SYSTEM,
                                text = "Security Lockdown recovered. Standalone Phone AI is ready."
                            )
                        )
                    }
                },
                onConnectDesktop = {
                    pairingError = null
                    currentScreen = Screen.PAIRING
                },
                onLogout = {
                    wsClient.disconnect()
                    tokenStorage.disconnectDesktopSession()
                    hasDesktopSession = false
                    selectedTarget = StandaloneMobileAssistant.ExecutionTarget.MOBILE
                    transcripts.add(
                        TranscriptItem(
                            sender = TranscriptItem.Speaker.SYSTEM,
                            text = "Disconnected from Desktop Remote Bridge. MYRAA Mobile continues in Standalone Phone Mode."
                        )
                    )
                    currentScreen = Screen.SESSION
                },
                onRevokeDevice = {
                    scope.launch {
                        val host = tokenStorage.getServerHost()
                        val port = tokenStorage.getServerPort()
                        val deviceId = tokenStorage.getDeviceId() ?: ""
                        val token = tokenStorage.getPreferredAuthToken() ?: tokenStorage.getBearerToken() ?: ""
                        apiClient.revokeDevice(deviceId, token, host, port)
                        wsClient.disconnect()
                        tokenStorage.disconnectDesktopSession()
                        hasDesktopSession = false
                        selectedTarget = StandaloneMobileAssistant.ExecutionTarget.MOBILE
                        transcripts.add(
                            TranscriptItem(
                                sender = TranscriptItem.Speaker.SYSTEM,
                                text = "Desktop pairing revoked. MYRAA Mobile remains active in Standalone Phone Mode."
                            )
                        )
                        currentScreen = Screen.SESSION
                    }
                },
                onNavigateBack = {
                    currentScreen = Screen.SESSION
                }
            )
        }

        Screen.PAIRING -> {
            PairingScreen(
                initialHost = tokenStorage.getServerHost(),
                initialPort = tokenStorage.getServerPort(),
                isLoading = isPairingLoading,
                errorMessage = pairingError,
                onNavigateBack = {
                    pairingError = null
                    currentScreen = Screen.SETTINGS
                },
                onPairRequested = { code, host, port, deviceName ->
                    isPairingLoading = true
                    pairingError = null

                    scope.launch {
                        val result = apiClient.pairDevice(code, deviceName, host, port)
                        isPairingLoading = false

                        when (result) {
                            is PairingResult.Success -> {
                                tokenStorage.saveSession(
                                    token = result.data.token,
                                    deviceId = result.data.deviceId,
                                    deviceName = deviceName,
                                    deviceRole = result.data.deviceRole,
                                    host = host,
                                    port = port,
                                    accessToken = result.data.accessToken,
                                    refreshToken = result.data.refreshToken,
                                    expiresInSeconds = result.data.expiresInSeconds
                                )
                                hasDesktopSession = true
                                currentScreen = Screen.SESSION
                            }
                            is PairingResult.Error -> {
                                pairingError = "[${result.code}] ${result.message}"
                            }
                        }
                    }
                }
            )
        }
    }
}
