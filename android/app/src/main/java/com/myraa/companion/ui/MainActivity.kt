package com.myraa.companion.ui

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioManager
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.util.Log
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
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
import com.myraa.companion.ui.actions.ActionExecutionRecord
import com.myraa.companion.ui.actions.ActionItemDescriptor
import com.myraa.companion.ui.actions.ActionsScreen
import com.myraa.companion.ui.chat.ChatScreen
import com.myraa.companion.ui.errors.FeatureError
import com.myraa.companion.ui.home.HomeScreen
import com.myraa.companion.ui.navigation.MainTab
import com.myraa.companion.ui.navigation.MyraaBottomNavBar
import com.myraa.companion.ui.screens.MobileOnboardingScreen
import com.myraa.companion.ui.screens.PairingScreen
import com.myraa.companion.ui.screens.SettingsScreen
import com.myraa.companion.ui.settings.DiagnosticsModalDialog
import com.myraa.companion.ui.status.FeatureStatus
import com.myraa.companion.ui.status.FeatureStatusEvaluator
import com.myraa.companion.ui.theme.MyraaDarkBg
import com.myraa.companion.ui.theme.MyraaTheme
import com.myraa.companion.ui.voice.VoiceScreen
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
 * Phase 13A-WIN.5 — MYRAA Mobile UI Architecture Redesign (Feature Isolation + Manual QA UI)
 *
 * Coordinates:
 *  - First-launch Standalone Mobile Onboarding -> Main Assistant (no Desktop pairing required)
 *  - Returning launch directly into Main MYRAA Mobile Assistant
 *  - 5 Strictly Isolated Primary Tabs: HOME | VOICE | CHAT | ACTIONS | SETTINGS
 *  - Dedicated per-feature error cards and live diagnostics
 *  - Optional Desktop pairing only via Settings -> Devices -> Connect Desktop
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

    // Active tab among the 5 primary screens when currentScreen == Screen.SESSION
    var activeTab by remember { mutableStateOf(MainTab.HOME) }

    var hasDesktopSession by remember { mutableStateOf(tokenStorage.hasSession()) }
    var preferredLanguage by remember { mutableStateOf(tokenStorage.getPreferredLanguage()) }
    var privacyShieldEnabled by remember { mutableStateOf(tokenStorage.isPrivacyShieldEnabled()) }
    var screenContextApproved by remember { mutableStateOf(tokenStorage.isScreenContextApproved()) }
    var localOnlyMode by remember { mutableStateOf(tokenStorage.isLocalOnlyMode()) }
    var securityLockdownActive by remember { mutableStateOf(tokenStorage.isSecurityLockdownActive()) }
    var isSpeakerOn by remember { mutableStateOf(true) }
    var showDiagnosticsModal by remember { mutableStateOf(false) }
    var serverHostState by remember { mutableStateOf(tokenStorage.getServerHost()) }
    var serverPortState by remember { mutableStateOf(tokenStorage.getServerPort()) }

    val connectionStatus by wsClient.connectionStatus.collectAsState()
    val isVoiceActive by voiceSession.isVoiceActive.collectAsState()
    val isMicMuted by voiceSession.isMicMuted.collectAsState()
    val isModelSpeaking by voiceSession.isModelSpeaking.collectAsState()
    val isUserSpeaking by voiceSession.isUserSpeaking.collectAsState()
    val isSessionThinking by voiceSession.isThinking.collectAsState()

    var emergencyStopState by remember {
        mutableStateOf(EmergencyStopState(active = false))
    }

    // ── Strictly Isolated Feature State ────────────────────────────────────────
    // 1. VOICE Screen State (Isolated from Chat & Actions)
    val voiceTranscripts = remember { mutableStateListOf<TranscriptItem>() }
    var voiceError by remember { mutableStateOf<FeatureError?>(null) }
    var isVoiceConnecting by remember { mutableStateOf(false) }
    var isVoiceThinking by remember { mutableStateOf(false) }
    var permissionRationale by remember { mutableStateOf<String?>(null) }
    var isPermanentlyDenied by remember { mutableStateOf(false) }

    // 2. CHAT Screen State (Isolated from Voice & Actions)
    val chatMessages = remember {
        mutableStateListOf(
            TranscriptItem(
                sender = TranscriptItem.Speaker.MYRAA,
                text = "MYRAA Mobile Chat is ready. Type a question or command below."
            )
        )
    }
    var chatError by remember { mutableStateOf<FeatureError?>(null) }
    var isChatSending by remember { mutableStateOf(false) }
    var lastChatPrompt by remember { mutableStateOf("") }

    // 3. ACTIONS Screen & HOME Quick Action State (Isolated per Action ID)
    val actionRecords = remember { mutableStateMapOf<String, ActionExecutionRecord>() }
    var lastHomeQuickActionRecord by remember { mutableStateOf<ActionExecutionRecord?>(null) }

    // 4. Desktop Pairing Screen State
    var pairingError by remember { mutableStateOf<String?>(null) }
    var isPairingLoading by remember { mutableStateOf(false) }

    var hasMicPermissionState by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(
                activity,
                Manifest.permission.RECORD_AUDIO
            ) == PackageManager.PERMISSION_GRANTED
        )
    }

    // Observe Android lifecycle to auto-refresh mic permission when returning from Android Settings
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) {
                val hasMic = ContextCompat.checkSelfPermission(
                    activity,
                    Manifest.permission.RECORD_AUDIO
                ) == PackageManager.PERMISSION_GRANTED
                hasMicPermissionState = hasMic
                if (hasMic) {
                    permissionRationale = null
                    isPermanentlyDenied = false
                    if (voiceError?.status == FeatureStatus.PERMISSION_REQUIRED) {
                        voiceError = null
                    }
                }
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose {
            lifecycleOwner.lifecycle.removeObserver(observer)
        }
    }

    // Real-time system snapshot for truthful badges and diagnostics
    val systemSnapshot = FeatureStatusEvaluator.collectRealSnapshot(
        context = activity.applicationContext,
        screenContextApproved = screenContextApproved,
        privacyShieldEnabled = privacyShieldEnabled,
        localOnlyMode = localOnlyMode,
        hasDesktopSession = hasDesktopSession,
        connectionStatus = connectionStatus,
        emergencyStopActive = emergencyStopState.active,
        securityLockdownActive = securityLockdownActive,
        isVoiceActive = isVoiceActive
    )

    // Helper to start or stop voice session with full diagnostic error reporting
    val startOrToggleVoiceSession: () -> Unit = {
        val hasMic = ContextCompat.checkSelfPermission(
            activity,
            Manifest.permission.RECORD_AUDIO
        ) == PackageManager.PERMISSION_GRANTED
        hasMicPermissionState = hasMic

        if (isVoiceActive) {
            voiceSession.stopVoiceSession()
            LiveAudioForegroundService.stop(activity.applicationContext)
            isVoiceConnecting = false
            isVoiceThinking = false
        } else if (emergencyStopState.active || securityLockdownActive) {
            voiceError = FeatureError(
                feature = "Voice",
                errorTitle = "VOICE ERROR",
                operation = "startVoiceSession",
                stage = "Security Gate",
                reason = "Cannot start voice session while Emergency Stop or Security Lockdown is active."
            )
        } else if (!hasMic) {
            voiceError = FeatureError(
                feature = "Voice",
                errorTitle = "VOICE ERROR",
                operation = "startVoiceSession",
                stage = "Audio Input (Microphone Permission)",
                reason = "Microphone permission (RECORD_AUDIO) is required to capture voice.",
                status = FeatureStatus.PERMISSION_REQUIRED
            )
        } else if (!systemSnapshot.isNetworkOnline && !localOnlyMode) {
            voiceError = FeatureError(
                feature = "Voice",
                errorTitle = "VOICE ERROR",
                operation = "startVoiceSession",
                stage = "Network Connectivity",
                reason = "Phone is offline. Real-time Gemini Live voice requires an active network connection.",
                status = FeatureStatus.OFFLINE
            )
        } else if (localOnlyMode) {
            voiceError = FeatureError(
                feature = "Voice",
                errorTitle = "VOICE ERROR",
                operation = "startVoiceSession",
                stage = "Gemini Live Handshake",
                reason = "Local-Only Mode is enabled in Settings. Disable Local-Only Mode to connect to Gemini Live."
            )
        } else {
            voiceError = null
            permissionRationale = null
            isVoiceConnecting = true

            val host = tokenStorage.getServerHost()
            val port = tokenStorage.getServerPort()
            val devId = tokenStorage.getOrCreateStandaloneDeviceId()

            // In standalone mode or paired mode, connect WebSocket if not authenticated
            if (connectionStatus != ConnectionStatus.AUTHENTICATED && connectionStatus != ConnectionStatus.CONNECTING) {
                if (hasDesktopSession && tokenStorage.hasSession()) {
                    val token = tokenStorage.getPreferredAuthToken() ?: tokenStorage.getBearerToken() ?: ""
                    wsClient.connect(host, port, token)
                } else {
                    wsClient.connectStandalone(host, port, devId)
                }
            }

            val started = voiceSession.startVoiceSession(allowSoftwareFallback = false)
            isVoiceConnecting = false
            if (!started) {
                voiceError = FeatureError(
                    feature = "Voice",
                    errorTitle = "VOICE ERROR",
                    operation = "AudioRecord.startRecording",
                    stage = "Audio Input (16kHz PCM16)",
                    reason = "Hardware AudioRecord failed to initialize 16kHz PCM16 capture on this device."
                )
            } else {
                LiveAudioForegroundService.start(activity.applicationContext)
                val targetEndpoint = if (hasDesktopSession && tokenStorage.hasSession()) "/remote-live" else "/live"
                voiceTranscripts.add(
                    TranscriptItem(
                        sender = TranscriptItem.Speaker.SYSTEM,
                        text = "Live bidirectional PCM voice session active via $targetEndpoint WebSocket."
                    )
                )
            }
        }
    }

    // Send a spoken/simulated utterance inside Voice Screen
    val sendVoiceUtterance: (String) -> Unit = { utterance ->
        val trimmed = utterance.trim()
        if (trimmed.isNotEmpty()) {
            voiceError = null
            isVoiceThinking = true
            voiceTranscripts.add(
                TranscriptItem(
                    sender = TranscriptItem.Speaker.USER,
                    text = trimmed
                )
            )
            Log.i("MainActivity", "Voice utterance initiated: '$trimmed' (voiceActive=$isVoiceActive, wsStatus=$connectionStatus)")

            val mobileIntent = StandaloneMobileAssistant.parseMobileIntent(
                input = trimmed,
                screenContextApproved = screenContextApproved,
                privacyShieldEnabled = privacyShieldEnabled
            )

            if (mobileIntent != null) {
                // Local phone capability action
                scope.launch {
                    val outcome = standaloneAssistant.handleUserTurn(
                        input = trimmed,
                        target = StandaloneMobileAssistant.ExecutionTarget.MOBILE,
                        isDesktopConnected = connectionStatus == ConnectionStatus.AUTHENTICATED,
                        emergencyStopActive = emergencyStopState.active,
                        securityLockdownActive = securityLockdownActive,
                        screenContextApproved = screenContextApproved,
                        privacyShieldEnabled = privacyShieldEnabled,
                        localOnlyMode = localOnlyMode,
                        host = tokenStorage.getServerHost(),
                        port = tokenStorage.getServerPort(),
                        deviceId = tokenStorage.getOrCreateStandaloneDeviceId(),
                        language = preferredLanguage,
                        onForwardToDesktop = { desktopCmd ->
                            wsClient.sendTextMessage(desktopCmd)
                        }
                    )
                    isVoiceThinking = false
                    if (!outcome.success) {
                        voiceError = FeatureError(
                            feature = "Voice",
                            errorTitle = "VOICE ERROR",
                            operation = outcome.capabilityExecuted ?: "handleUserTurn",
                            stage = "Voice Utterance Execution",
                            reason = outcome.responseText
                        )
                    } else {
                        voiceTranscripts.add(
                            TranscriptItem(
                                sender = TranscriptItem.Speaker.MYRAA,
                                text = outcome.responseText
                            )
                        )
                    }
                }
            } else if (isVoiceActive && connectionStatus == ConnectionStatus.AUTHENTICATED) {
                // Live Gemini Live session: stream turn directly via WebSocket to generate spoken response audio
                val sent = wsClient.sendTextMessage(trimmed)
                Log.i("MainActivity", "Forwarded voice utterance to Gemini Live WebSocket: $sent")
                if (!sent) {
                    isVoiceThinking = false
                    voiceError = FeatureError(
                        feature = "Voice",
                        errorTitle = "VOICE ERROR",
                        operation = "wsClient.sendTextMessage",
                        stage = "Gemini Live Send",
                        reason = "Failed to dispatch utterance to active WebSocket."
                    )
                }
            } else {
                // Fallback to local assistant if WebSocket not authenticated
                scope.launch {
                    val outcome = standaloneAssistant.handleUserTurn(
                        input = trimmed,
                        target = StandaloneMobileAssistant.ExecutionTarget.MOBILE,
                        isDesktopConnected = connectionStatus == ConnectionStatus.AUTHENTICATED,
                        emergencyStopActive = emergencyStopState.active,
                        securityLockdownActive = securityLockdownActive,
                        screenContextApproved = screenContextApproved,
                        privacyShieldEnabled = privacyShieldEnabled,
                        localOnlyMode = localOnlyMode,
                        host = tokenStorage.getServerHost(),
                        port = tokenStorage.getServerPort(),
                        deviceId = tokenStorage.getOrCreateStandaloneDeviceId(),
                        language = preferredLanguage,
                        onForwardToDesktop = { desktopCmd ->
                            wsClient.sendTextMessage(desktopCmd)
                        }
                    )
                    isVoiceThinking = false
                    if (!outcome.success) {
                        voiceError = FeatureError(
                            feature = "Voice",
                            errorTitle = "VOICE ERROR",
                            operation = outcome.capabilityExecuted ?: "handleUserTurn",
                            stage = "Voice Utterance Execution",
                            reason = outcome.responseText
                        )
                    } else {
                        voiceTranscripts.add(
                            TranscriptItem(
                                sender = TranscriptItem.Speaker.MYRAA,
                                text = outcome.responseText
                            )
                        )
                    }
                }
            }
        }
    }

    // Safe permission launcher
    val permissionLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestPermission()
    ) { isGranted ->
        hasMicPermissionState = isGranted
        if (isGranted) {
            permissionRationale = null
            isPermanentlyDenied = false
            voiceError = null
            if (currentScreen == Screen.SESSION && activeTab == MainTab.VOICE) {
                startOrToggleVoiceSession()
            }
        } else {
            val shouldShowRationale = ActivityCompat.shouldShowRequestPermissionRationale(
                activity,
                Manifest.permission.RECORD_AUDIO
            )
            isPermanentlyDenied = !shouldShowRationale
            permissionRationale = if (shouldShowRationale) {
                "Microphone access is required for real-time bidirectional voice conversation with MYRAA. Please grant permission to continue."
            } else {
                "Microphone permission has been permanently denied. Please enable RECORD_AUDIO in Android Settings."
            }
            voiceError = FeatureError(
                feature = "Voice",
                errorTitle = "VOICE ERROR",
                operation = "requestPermission(RECORD_AUDIO)",
                stage = "Audio Input (Microphone Permission)",
                reason = permissionRationale ?: "Microphone permission denied",
                status = FeatureStatus.PERMISSION_REQUIRED
            )
        }
    }

    // Execute a single catalog action (used by both Home Quick Actions and Actions Screen [TEST] button)
    val executeCatalogAction: (ActionItemDescriptor, String, Boolean) -> Unit = { item, commandStr, isFromHome ->
        val runningRecord = ActionExecutionRecord(
            actionId = item.id,
            status = FeatureStatus.RUNNING,
            lastCommand = commandStr,
            error = null
        )
        actionRecords[item.id] = runningRecord
        if (isFromHome) {
            lastHomeQuickActionRecord = runningRecord
        }

        scope.launch {
            // 1. Check platform support (e.g. flashlight is NOT_SUPPORTED in current AndroidCapabilityRegistry)
            if (item.id == "flashlight") {
                val err = FeatureError(
                    feature = item.name,
                    errorTitle = item.errorHeader,
                    operation = commandStr,
                    stage = "AndroidCapabilityRegistry Lookup",
                    reason = "Flashlight / CameraManager Torch toggle is not implemented in AndroidCapabilityRegistry on this build.",
                    status = FeatureStatus.NOT_SUPPORTED
                )
                val rec = ActionExecutionRecord(
                    actionId = item.id,
                    status = FeatureStatus.NOT_SUPPORTED,
                    lastCommand = commandStr,
                    error = err
                )
                actionRecords[item.id] = rec
                if (isFromHome) lastHomeQuickActionRecord = rec
                return@launch
            }

            // 2. Check Desktop Bridge requirement
            if (item.requiresDesktop && connectionStatus != ConnectionStatus.AUTHENTICATED) {
                val err = FeatureError(
                    feature = item.name,
                    errorTitle = item.errorHeader,
                    operation = commandStr,
                    stage = "Desktop Bridge Gate",
                    reason = "Desktop Remote Bridge is not connected. Pair your PC in Settings → Devices → Connect Desktop.",
                    status = FeatureStatus.REQUIRES_DESKTOP
                )
                val rec = ActionExecutionRecord(
                    actionId = item.id,
                    status = FeatureStatus.REQUIRES_DESKTOP,
                    lastCommand = commandStr,
                    error = err
                )
                actionRecords[item.id] = rec
                if (isFromHome) lastHomeQuickActionRecord = rec
                return@launch
            }

            // 3. Execute via StandaloneMobileAssistant
            val target = if (item.requiresDesktop) {
                StandaloneMobileAssistant.ExecutionTarget.DESKTOP
            } else {
                StandaloneMobileAssistant.ExecutionTarget.MOBILE
            }
            val outcome = standaloneAssistant.handleUserTurn(
                input = commandStr,
                target = target,
                isDesktopConnected = connectionStatus == ConnectionStatus.AUTHENTICATED,
                emergencyStopActive = emergencyStopState.active,
                securityLockdownActive = securityLockdownActive,
                screenContextApproved = screenContextApproved,
                privacyShieldEnabled = privacyShieldEnabled,
                localOnlyMode = localOnlyMode,
                host = tokenStorage.getServerHost(),
                port = tokenStorage.getServerPort(),
                deviceId = tokenStorage.getOrCreateStandaloneDeviceId(),
                language = preferredLanguage,
                onForwardToDesktop = { desktopCmd ->
                    wsClient.sendTextMessage(desktopCmd)
                }
            )

            val rec = if (outcome.success) {
                ActionExecutionRecord(
                    actionId = item.id,
                    status = FeatureStatus.SUCCESS,
                    lastCommand = commandStr,
                    lastResultMessage = outcome.responseText,
                    error = null
                )
            } else {
                val mappedStatus = when (outcome.errorCode) {
                    "SCREEN_PERMISSION_REQUIRED" -> FeatureStatus.PERMISSION_REQUIRED
                    "DESKTOP_BRIDGE_OFFLINE" -> FeatureStatus.REQUIRES_DESKTOP
                    else -> FeatureStatus.FAILED
                }
                ActionExecutionRecord(
                    actionId = item.id,
                    status = mappedStatus,
                    lastCommand = commandStr,
                    lastResultMessage = outcome.responseText,
                    error = FeatureError(
                        feature = item.name,
                        errorTitle = item.errorHeader,
                        operation = outcome.capabilityExecuted ?: commandStr,
                        stage = outcome.errorCode ?: "Capability Execution",
                        reason = outcome.responseText,
                        status = mappedStatus
                    )
                )
            }
            actionRecords[item.id] = rec
            if (isFromHome) {
                lastHomeQuickActionRecord = rec
            }
        }
    }

    // Send a chat message on the isolated CHAT screen
    val sendChatMessage: (String) -> Unit = { text ->
        val trimmed = text.trim()
        if (trimmed.isNotEmpty()) {
            lastChatPrompt = trimmed
            chatError = null
            isChatSending = true

            chatMessages.add(
                TranscriptItem(
                    sender = TranscriptItem.Speaker.USER,
                    text = trimmed
                )
            )

            scope.launch {
                val outcome = standaloneAssistant.handleUserTurn(
                    input = trimmed,
                    target = StandaloneMobileAssistant.ExecutionTarget.MOBILE,
                    isDesktopConnected = connectionStatus == ConnectionStatus.AUTHENTICATED,
                    emergencyStopActive = emergencyStopState.active,
                    securityLockdownActive = securityLockdownActive,
                    screenContextApproved = screenContextApproved,
                    privacyShieldEnabled = privacyShieldEnabled,
                    localOnlyMode = localOnlyMode,
                    host = tokenStorage.getServerHost(),
                    port = tokenStorage.getServerPort(),
                    deviceId = tokenStorage.getOrCreateStandaloneDeviceId(),
                    language = preferredLanguage,
                    onForwardToDesktop = { desktopCmd ->
                        wsClient.sendTextMessage(desktopCmd)
                    }
                )
                isChatSending = false

                if (!outcome.success) {
                    chatError = FeatureError(
                        feature = "Chat",
                        errorTitle = "CHAT ERROR",
                        operation = outcome.capabilityExecuted ?: "handleUserTurn",
                        stage = outcome.errorCode ?: "Assistant Turn",
                        reason = outcome.responseText
                    )
                } else if (!localOnlyMode && outcome.capabilityExecuted == "standalone_local_assistant") {
                    // Cloud endpoint failed and fell back to local response — surface transparently
                    chatError = FeatureError(
                        feature = "Chat",
                        errorTitle = "CHAT ERROR",
                        operation = "submitStandaloneMobileVoice",
                        stage = "MYRAA Cloud HTTPS Turn",
                        reason = "Cloud AI endpoint (/api/ux/mobile/voice) did not respond; displayed offline local fallback."
                    )
                    chatMessages.add(
                        TranscriptItem(
                            sender = TranscriptItem.Speaker.MYRAA,
                            text = outcome.responseText
                        )
                    )
                } else {
                    chatMessages.add(
                        TranscriptItem(
                            sender = TranscriptItem.Speaker.MYRAA,
                            text = outcome.responseText
                        )
                    )
                }
            }
        }
    }

    // Emergency Stop helpers
    val triggerEmergencyStop: () -> Unit = {
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
            apiClient.triggerEmergencyStop("Triggered by Android user", token, host, port)
        }
    }

    val resetEmergencyStop: () -> Unit = {
        scope.launch {
            val host = tokenStorage.getServerHost()
            val port = tokenStorage.getServerPort()
            val token = tokenStorage.getBearerToken()
            if (!hasDesktopSession || token.isNullOrBlank()) {
                emergencyStopState = EmergencyStopState(active = false)
                Toast.makeText(activity, "Standalone Emergency Stop reset", Toast.LENGTH_SHORT).show()
            } else {
                apiClient.resetEmergencyStop(token, host, port)
                emergencyStopState = EmergencyStopState(active = false)
                Toast.makeText(activity, "Emergency Stop reset", Toast.LENGTH_SHORT).show()
            }
        }
    }

    // Connect optional Desktop WebSocket ONLY when an authenticated Desktop pairing session exists
    LaunchedEffect(currentScreen, hasDesktopSession) {
        if (currentScreen == Screen.SESSION && hasDesktopSession && tokenStorage.hasSession()) {
            val host = tokenStorage.getServerHost()
            val port = tokenStorage.getServerPort()

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

    // In Standalone Phone mode, connect WebSocket to /live when Voice screen is active or voice session started
    LaunchedEffect(currentScreen, activeTab, hasDesktopSession, isVoiceActive) {
        if (currentScreen == Screen.SESSION && !hasDesktopSession && (activeTab == MainTab.VOICE || isVoiceActive)) {
            if (connectionStatus != ConnectionStatus.AUTHENTICATED && connectionStatus != ConnectionStatus.CONNECTING) {
                val host = tokenStorage.getServerHost()
                val port = tokenStorage.getServerPort()
                val devId = tokenStorage.getOrCreateStandaloneDeviceId()
                wsClient.connectStandalone(host, port, devId)
            }
        }
    }

    val currentActiveTab by rememberUpdatedState(activeTab)
    val currentIsVoiceActive by rememberUpdatedState(isVoiceActive)

    // Wire WebSocket callbacks cleanly to isolated state
    DisposableEffect(wsClient) {
        val transcriptListener: (TranscriptItem) -> Unit = { item ->
            activity.runOnUiThread {
                if (currentIsVoiceActive || currentActiveTab == MainTab.VOICE || voiceSession.isVoiceActive.value) {
                    if (voiceTranscripts.none { it.id == item.id }) {
                        voiceTranscripts.add(item)
                    }
                } else {
                    if (chatMessages.none { it.id == item.id }) {
                        chatMessages.add(item)
                    }
                }
            }
        }
        wsClient.transcriptListeners.add(transcriptListener)

        val audioReceivedListener: (String) -> Unit = {
            activity.runOnUiThread {
                isVoiceThinking = false
            }
        }
        val turnCompleteListener: () -> Unit = {
            activity.runOnUiThread {
                isVoiceThinking = false
            }
        }
        wsClient.audioReceivedListeners.add(audioReceivedListener)
        wsClient.turnCompleteListeners.add(turnCompleteListener)

        wsClient.onError = { errorMsg ->
            activity.runOnUiThread {
                isVoiceThinking = false
                if (currentIsVoiceActive || currentActiveTab == MainTab.VOICE || voiceSession.isVoiceActive.value) {
                    voiceError = FeatureError(
                        feature = "Voice",
                        errorTitle = "VOICE ERROR",
                        operation = "MyraaWebSocketClient",
                        stage = "Gemini Live Stream",
                        reason = errorMsg,
                        status = FeatureStatus.FAILED
                    )
                }
            }
        }

        wsClient.onEmergencyStopChanged = { state ->
            activity.runOnUiThread {
                emergencyStopState = state
                if (state.active) {
                    voiceSession.onEmergencyStop()
                    LiveAudioForegroundService.stop(activity.applicationContext)
                    voiceError = FeatureError(
                        feature = "Voice",
                        errorTitle = "VOICE ERROR",
                        operation = "EmergencyStop",
                        stage = "Emergency Stop",
                        reason = state.reason ?: "Emergency Stop triggered"
                    )
                }
            }
        }

        wsClient.onStatusMessage = { statusText ->
            activity.runOnUiThread {
                voiceTranscripts.add(
                    TranscriptItem(
                        sender = TranscriptItem.Speaker.SYSTEM,
                        text = statusText
                    )
                )
            }
        }

        onDispose {
            wsClient.audioReceivedListeners.remove(audioReceivedListener)
            wsClient.turnCompleteListeners.remove(turnCompleteListener)
            wsClient.transcriptListeners.remove(transcriptListener)
            wsClient.onTranscriptReceived = null
            wsClient.onError = null
            wsClient.onEmergencyStopChanged = null
            wsClient.onStatusMessage = null
        }
    }

    if (showDiagnosticsModal) {
        DiagnosticsModalDialog(
            snapshot = systemSnapshot,
            actionRecords = actionRecords,
            voiceError = voiceError,
            chatError = chatError,
            onDismiss = { showDiagnosticsModal = false },
            onNavigateToActions = { activeTab = MainTab.ACTIONS }
        )
    }

    when (currentScreen) {
        Screen.ONBOARDING -> {
            MobileOnboardingScreen(
                initialLanguage = preferredLanguage,
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

                    preferredLanguage = lang
                    privacyShieldEnabled = shield
                    screenContextApproved = screenOk
                    localOnlyMode = localOnly
                    currentScreen = Screen.SESSION
                    activeTab = MainTab.HOME

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
                    activeTab = MainTab.HOME
                }
            )
        }

        Screen.SESSION -> {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .background(MyraaDarkBg)
                    .windowInsetsPadding(WindowInsets.statusBars)
            ) {
                // Active Primary Screen Area (Strictly 1 active tab at a time)
                Box(
                    modifier = Modifier
                        .weight(1f)
                        .fillMaxWidth()
                ) {
                    when (activeTab) {
                        MainTab.HOME -> {
                            HomeScreen(
                                systemSnapshot = systemSnapshot,
                                emergencyStopState = emergencyStopState,
                                canResetEmergencyStop = !hasDesktopSession || tokenStorage.getDeviceRole() == "admin",
                                lastHomeQuickActionRecord = lastHomeQuickActionRecord,
                                onStartVoiceClick = {
                                    activeTab = MainTab.VOICE
                                    if (!isVoiceActive) {
                                        val hasMic = ContextCompat.checkSelfPermission(
                                            activity,
                                            Manifest.permission.RECORD_AUDIO
                                        ) == PackageManager.PERMISSION_GRANTED
                                        hasMicPermissionState = hasMic
                                        if (!hasMic) {
                                            permissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
                                        }
                                    }
                                },
                                onOpenChatClick = {
                                    activeTab = MainTab.CHAT
                                },
                                onQuickActionClick = { actionItem ->
                                    executeCatalogAction(actionItem, actionItem.defaultTestCommand, true)
                                },
                                onDismissHomeQuickActionFeedback = {
                                    lastHomeQuickActionRecord = null
                                },
                                onMoreActionsClick = {
                                    activeTab = MainTab.ACTIONS
                                },
                                onOpenSettingsClick = {
                                    activeTab = MainTab.SETTINGS
                                },
                                onOpenDiagnosticsClick = {
                                    showDiagnosticsModal = true
                                },
                                onTriggerEmergencyStop = triggerEmergencyStop,
                                onResetEmergencyStop = resetEmergencyStop
                            )
                        }

                        MainTab.VOICE -> {
                            VoiceScreen(
                                systemSnapshot = systemSnapshot,
                                isVoiceActive = isVoiceActive,
                                isConnecting = isVoiceConnecting || connectionStatus == ConnectionStatus.CONNECTING,
                                isThinking = isVoiceThinking || isSessionThinking,
                                isMicMuted = isMicMuted,
                                isSpeakerOn = isSpeakerOn,
                                isModelSpeaking = isModelSpeaking,
                                isUserSpeaking = isUserSpeaking,
                                voiceTranscripts = voiceTranscripts,
                                voiceError = voiceError,
                                permissionRationale = permissionRationale,
                                isPermanentlyDenied = isPermanentlyDenied,
                                onNavigateBack = {
                                    activeTab = MainTab.HOME
                                },
                                onToggleVoiceStartStop = {
                                    val hasMic = ContextCompat.checkSelfPermission(
                                        activity,
                                        Manifest.permission.RECORD_AUDIO
                                    ) == PackageManager.PERMISSION_GRANTED
                                    hasMicPermissionState = hasMic
                                    if (!hasMic && !isVoiceActive) {
                                        voiceError = FeatureError(
                                            feature = "Voice",
                                            errorTitle = "VOICE ERROR",
                                            operation = "startVoiceSession",
                                            stage = "Audio Input (Microphone Permission)",
                                            reason = "Microphone permission (RECORD_AUDIO) is required.",
                                            status = FeatureStatus.PERMISSION_REQUIRED
                                        )
                                        permissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
                                    } else {
                                        startOrToggleVoiceSession()
                                    }
                                },
                                onEndVoiceSession = {
                                    voiceSession.stopVoiceSession()
                                    LiveAudioForegroundService.stop(activity.applicationContext)
                                    voiceError = null
                                    permissionRationale = null
                                },
                                onToggleMute = {
                                    voiceSession.setMicMuted(!isMicMuted)
                                },
                                onToggleSpeaker = {
                                    val nextSpeaker = !isSpeakerOn
                                    isSpeakerOn = nextSpeaker
                                    try {
                                        val audioMgr = activity.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
                                        @Suppress("DEPRECATION")
                                        audioMgr?.isSpeakerphoneOn = nextSpeaker
                                    } catch (_: Exception) {
                                    }
                                },
                                onSendVoiceUtterance = { utterance ->
                                    sendVoiceUtterance(utterance)
                                },
                                onRetryVoice = {
                                    voiceError = null
                                    startOrToggleVoiceSession()
                                },
                                onDismissVoiceError = {
                                    voiceError = null
                                    permissionRationale = null
                                },
                                onRequestMicPermission = {
                                    permissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
                                },
                                onOpenAppSettings = {
                                    val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                                        data = Uri.fromParts("package", activity.packageName, null)
                                    }
                                    activity.startActivity(intent)
                                },
                                onOpenDiagnostics = {
                                    showDiagnosticsModal = true
                                }
                            )
                        }

                        MainTab.CHAT -> {
                            ChatScreen(
                                systemSnapshot = systemSnapshot,
                                chatMessages = chatMessages,
                                isSending = isChatSending,
                                chatError = chatError,
                                onSendMessage = { message ->
                                    sendChatMessage(message)
                                },
                                onRetryLastMessage = {
                                    if (lastChatPrompt.isNotBlank()) {
                                        sendChatMessage(lastChatPrompt)
                                    }
                                },
                                onDismissChatError = {
                                    chatError = null
                                },
                                onClearChat = {
                                    chatMessages.clear()
                                    chatMessages.add(
                                        TranscriptItem(
                                            sender = TranscriptItem.Speaker.MYRAA,
                                            text = "Chat cleared. Ask MYRAA anything below."
                                        )
                                    )
                                    chatError = null
                                },
                                onNavigateToVoice = {
                                    activeTab = MainTab.VOICE
                                },
                                onNavigateBack = {
                                    activeTab = MainTab.HOME
                                },
                                onOpenDiagnostics = {
                                    showDiagnosticsModal = true
                                }
                            )
                        }

                        MainTab.ACTIONS -> {
                            ActionsScreen(
                                systemSnapshot = systemSnapshot,
                                actionRecords = actionRecords,
                                onExecuteAction = { item, customCmd ->
                                    executeCatalogAction(item, customCmd, false)
                                },
                                onDismissActionError = { actionId ->
                                    actionRecords[actionId]?.let { rec ->
                                        actionRecords[actionId] = rec.copy(error = null)
                                    }
                                },
                                onOpenDiagnostics = {
                                    showDiagnosticsModal = true
                                },
                                onOpenSettings = {
                                    activeTab = MainTab.SETTINGS
                                },
                                onConnectDesktop = {
                                    pairingError = null
                                    currentScreen = Screen.PAIRING
                                }
                            )
                        }

                        MainTab.SETTINGS -> {
                            SettingsScreen(
                                standaloneDeviceId = tokenStorage.getOrCreateStandaloneDeviceId(),
                                accountId = tokenStorage.getAccountId(),
                                preferredLanguage = preferredLanguage,
                                onPreferredLanguageChanged = { lang ->
                                    preferredLanguage = lang
                                    tokenStorage.setPreferredLanguage(lang)
                                },
                                hasMicPermission = hasMicPermissionState,
                                onRequestMicPermission = {
                                    permissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
                                },
                                onOpenSystemAppSettings = {
                                    try {
                                        val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                                            data = Uri.fromParts("package", activity.packageName, null)
                                        }
                                        activity.startActivity(intent)
                                    } catch (_: Exception) {
                                    }
                                },
                                hasDesktopSession = hasDesktopSession,
                                connectionStatus = connectionStatus,
                                deviceId = tokenStorage.getDeviceId(),
                                deviceName = tokenStorage.getDeviceName(),
                                deviceRole = tokenStorage.getDeviceRole(),
                                maskedToken = tokenStorage.getMaskedToken(),
                                serverHost = serverHostState,
                                serverPort = serverPortState,
                                onUpdateServerEndpoint = { newHost, newPort ->
                                    tokenStorage.setServerEndpoint(newHost, newPort)
                                    serverHostState = newHost
                                    serverPortState = newPort
                                    wsClient.disconnect()
                                    Toast.makeText(activity, "Endpoint updated to $newHost:$newPort", Toast.LENGTH_SHORT).show()
                                },
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
                                    }
                                },
                                emergencyStopState = emergencyStopState,
                                onTriggerEmergencyStop = triggerEmergencyStop,
                                onResetEmergencyStop = resetEmergencyStop,
                                onClearLocalHistory = {
                                    chatMessages.clear()
                                    chatMessages.add(
                                        TranscriptItem(
                                            sender = TranscriptItem.Speaker.MYRAA,
                                            text = "Conversation history cleared. Ask MYRAA anything below."
                                        )
                                    )
                                    voiceTranscripts.clear()
                                    chatError = null
                                    voiceError = null
                                    Toast.makeText(activity, "Conversation history cleared", Toast.LENGTH_SHORT).show()
                                },
                                onConnectDesktop = {
                                    pairingError = null
                                    currentScreen = Screen.PAIRING
                                },
                                onLogout = {
                                    wsClient.disconnect()
                                    tokenStorage.disconnectDesktopSession()
                                    hasDesktopSession = false
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
                                    }
                                },
                                onNavigateBack = {
                                    activeTab = MainTab.HOME
                                },
                                onOpenDiagnosticsModal = {
                                    showDiagnosticsModal = true
                                },
                                onOpenActionsScreen = {
                                    activeTab = MainTab.ACTIONS
                                },
                                systemSnapshot = systemSnapshot,
                                actionRecords = actionRecords,
                                voiceError = voiceError,
                                chatError = chatError
                            )
                        }
                    }
                }

                // Persistent Bottom Navigation Bar (Visible on all 5 primary tabs)
                MyraaBottomNavBar(
                    currentTab = activeTab,
                    onSelectTab = { tab -> activeTab = tab },
                    isVoiceActive = isVoiceActive,
                    hasUnreadError = voiceError != null || chatError != null || actionRecords.values.any { it.error != null }
                )
            }
        }

        Screen.SETTINGS -> {
            currentScreen = Screen.SESSION
            activeTab = MainTab.SETTINGS
        }

        Screen.PAIRING -> {
            PairingScreen(
                initialHost = tokenStorage.getServerHost(),
                initialPort = tokenStorage.getServerPort(),
                isLoading = isPairingLoading,
                errorMessage = pairingError,
                onNavigateBack = {
                    pairingError = null
                    currentScreen = Screen.SESSION
                    activeTab = MainTab.SETTINGS
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
                                activeTab = MainTab.SETTINGS
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
