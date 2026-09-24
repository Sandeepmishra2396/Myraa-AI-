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
import com.myraa.companion.networking.EmergencyStopState
import com.myraa.companion.networking.MyraaApiClient
import com.myraa.companion.networking.MyraaWebSocketClient
import com.myraa.companion.networking.PairingResult
import com.myraa.companion.networking.TokenRefreshResult
import com.myraa.companion.networking.TranscriptItem
import com.myraa.companion.security.SecureTokenStorage
import com.myraa.companion.service.LiveAudioForegroundService
import com.myraa.companion.ui.screens.MainSessionScreen
import com.myraa.companion.ui.screens.PairingScreen
import com.myraa.companion.ui.screens.SettingsScreen
import com.myraa.companion.ui.theme.MyraaDarkBg
import com.myraa.companion.ui.theme.MyraaTheme
import com.myraa.companion.voice.VoiceSessionManager
import kotlinx.coroutines.launch

enum class Screen {
    PAIRING,
    SESSION,
    SETTINGS
}

/**
 * MainActivity
 * Phase 18 — Android Voice Assistant
 *
 * Coordinates:
 *  - Authentication state & secure token rotation
 *  - Robust RECORD_AUDIO permission flow with UI rationale and Settings fallback
 *  - Bidirectional voice loop with barge-in and turn interruption
 *  - Foreground microphone service synchronization
 *  - Emergency Stop voice shutdown
 */
class MainActivity : ComponentActivity() {

    private lateinit var tokenStorage: SecureTokenStorage
    private lateinit var apiClient: MyraaApiClient
    private lateinit var wsClient: MyraaWebSocketClient
    private lateinit var voiceSession: VoiceSessionManager
    private lateinit var capabilityAdapter: com.myraa.companion.capabilities.AndroidCapabilityAdapter
    private lateinit var capabilityRegistry: com.myraa.companion.capabilities.AndroidCapabilityRegistry

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        tokenStorage = SecureTokenStorage(applicationContext)
        apiClient = MyraaApiClient()
        wsClient = MyraaWebSocketClient()
        voiceSession = VoiceSessionManager(wsClient)
        capabilityAdapter = com.myraa.companion.capabilities.AndroidCapabilityAdapter(applicationContext, voiceSession)
        capabilityRegistry = com.myraa.companion.capabilities.AndroidCapabilityRegistry(capabilityAdapter)
        wsClient.capabilityRegistry = capabilityRegistry

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
    activity: ComponentActivity
) {
    val scope = rememberCoroutineScope()

    var currentScreen by remember {
        mutableStateOf(if (tokenStorage.hasSession()) Screen.SESSION else Screen.PAIRING)
    }

    val connectionStatus by wsClient.connectionStatus.collectAsState()
    val isVoiceActive by voiceSession.isVoiceActive.collectAsState()
    val isMicMuted by voiceSession.isMicMuted.collectAsState()
    val isModelSpeaking by voiceSession.isModelSpeaking.collectAsState()
    val isUserSpeaking by voiceSession.isUserSpeaking.collectAsState()

    var emergencyStopState by remember {
        mutableStateOf(EmergencyStopState(active = false))
    }

    val transcripts = remember { mutableStateListOf<TranscriptItem>() }
    var pairingError by remember { mutableStateOf<String?>(null) }
    var isPairingLoading by remember { mutableStateOf(false) }

    var permissionRationale by remember { mutableStateOf<String?>(null) }
    var isPermanentlyDenied by remember { mutableStateOf(false) }

    // Safe permission launcher with rationale and permanent denial handling
    val permissionLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestPermission()
    ) { isGranted ->
        if (isGranted) {
            permissionRationale = null
            isPermanentlyDenied = false
            val started = voiceSession.startVoiceSession()
            if (started) {
                LiveAudioForegroundService.start(activity.applicationContext)
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

    // Connect WebSocket when authenticated session exists
    LaunchedEffect(currentScreen) {
        if (currentScreen == Screen.SESSION && tokenStorage.hasSession()) {
            val host = tokenStorage.getServerHost()
            val port = tokenStorage.getServerPort()

            // Wire automatic token rotation on WebSocket reconnect
            wsClient.tokenRefreshProvider = {
                val rf = tokenStorage.getRefreshToken()
                if (tokenStorage.isAccessTokenExpired() && !rf.isNullOrBlank()) {
                    val refreshResult = apiClient.rotateSessionToken(rf, host, port)
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
                                tokenStorage.clearSession()
                                currentScreen = Screen.PAIRING
                            }
                            null
                        }
                    }
                } else {
                    tokenStorage.getPreferredAuthToken()
                }
            }

            // Proactive token rotation before initial connection if expired
            val rf = tokenStorage.getRefreshToken()
            if (tokenStorage.isAccessTokenExpired() && !rf.isNullOrBlank()) {
                val refreshResult = apiClient.rotateSessionToken(rf, host, port)
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
                            Toast.makeText(activity, "Security violation: Replay attack detected. Session terminated.", Toast.LENGTH_LONG).show()
                            tokenStorage.clearSession()
                            currentScreen = Screen.PAIRING
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
        Screen.PAIRING -> {
            PairingScreen(
                initialHost = tokenStorage.getServerHost(),
                initialPort = tokenStorage.getServerPort(),
                isLoading = isPairingLoading,
                errorMessage = pairingError,
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

        Screen.SESSION -> {
            MainSessionScreen(
                connectionStatus = connectionStatus,
                isVoiceActive = isVoiceActive,
                isMicMuted = isMicMuted,
                isModelSpeaking = isModelSpeaking,
                isUserSpeaking = isUserSpeaking,
                permissionRationale = permissionRationale,
                isPermanentlyDenied = isPermanentlyDenied,
                emergencyStopState = emergencyStopState,
                transcripts = transcripts,
                canResetEmergencyStop = tokenStorage.getDeviceRole() == "admin",
                onToggleVoice = {
                    if (isVoiceActive) {
                        voiceSession.stopVoiceSession()
                        LiveAudioForegroundService.stop(activity.applicationContext)
                    } else {
                        val hasMicPermission = ContextCompat.checkSelfPermission(
                            activity,
                            Manifest.permission.RECORD_AUDIO
                        ) == PackageManager.PERMISSION_GRANTED

                        if (hasMicPermission) {
                            permissionRationale = null
                            val started = voiceSession.startVoiceSession()
                            if (started) {
                                LiveAudioForegroundService.start(activity.applicationContext)
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
                    wsClient.sendTextMessage(text)
                    transcripts.add(
                        TranscriptItem(
                            sender = TranscriptItem.Speaker.USER,
                            text = text
                        )
                    )
                },
                onTriggerEmergencyStop = {
                    scope.launch {
                        val host = tokenStorage.getServerHost()
                        val port = tokenStorage.getServerPort()
                        val token = tokenStorage.getBearerToken()
                        apiClient.triggerEmergencyStop("Triggered by Android user", token, host, port)
                        emergencyStopState = EmergencyStopState(
                            active = true,
                            reason = "Triggered from mobile device"
                        )
                        voiceSession.onEmergencyStop()
                        LiveAudioForegroundService.stop(activity.applicationContext)
                    }
                },
                onResetEmergencyStop = {
                    scope.launch {
                        val host = tokenStorage.getServerHost()
                        val port = tokenStorage.getServerPort()
                        val token = tokenStorage.getBearerToken() ?: ""
                        val success = apiClient.resetEmergencyStop(token, host, port)
                        if (success) {
                            emergencyStopState = EmergencyStopState(active = false)
                            Toast.makeText(activity, "Emergency Stop reset successfully", Toast.LENGTH_SHORT).show()
                        } else {
                            Toast.makeText(activity, "Failed to reset Emergency Stop (admin role required)", Toast.LENGTH_SHORT).show()
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
                deviceId = tokenStorage.getDeviceId(),
                deviceName = tokenStorage.getDeviceName(),
                deviceRole = tokenStorage.getDeviceRole(),
                maskedToken = tokenStorage.getMaskedToken(),
                serverHost = tokenStorage.getServerHost(),
                serverPort = tokenStorage.getServerPort(),
                onLogout = {
                    voiceSession.stopVoiceSession()
                    LiveAudioForegroundService.stop(activity.applicationContext)
                    wsClient.disconnect()
                    tokenStorage.clearSession()
                    transcripts.clear()
                    currentScreen = Screen.PAIRING
                },
                onRevokeDevice = {
                    scope.launch {
                        val host = tokenStorage.getServerHost()
                        val port = tokenStorage.getServerPort()
                        val deviceId = tokenStorage.getDeviceId() ?: ""
                        val token = tokenStorage.getPreferredAuthToken() ?: tokenStorage.getBearerToken() ?: ""
                        apiClient.revokeDevice(deviceId, token, host, port)
                        voiceSession.stopVoiceSession()
                        LiveAudioForegroundService.stop(activity.applicationContext)
                        wsClient.disconnect()
                        tokenStorage.clearSession()
                        transcripts.clear()
                        currentScreen = Screen.PAIRING
                    }
                },
                onNavigateBack = {
                    currentScreen = Screen.SESSION
                }
            )
        }
    }
}
