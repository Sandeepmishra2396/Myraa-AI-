package com.myraa.companion.networking

import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * MyraaWebSocketClient
 * Phase 16 — Android Companion Foundation
 *
 * Full-duplex WebSocket client connected to MYRAA Core /remote-live endpoint.
 *
 * SPECIFICATION:
 * - Endpoint: ws(s)://$host:$port/remote-live
 * - Auth Header: Sec-WebSocket-Protocol: myraa-auth, <sora_dev_...token>
 * - Audio Streaming:
 *     Upload (16kHz PCM16):   {"audio": "<base64>"}
 *     Download (24kHz PCM16): {"audio": "<base64>"}
 * - Automatic reconnection with exponential backoff
 */
class MyraaWebSocketClient(
    private val client: OkHttpClient = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS) // Keep alive
        .build()
) {

    companion object {
        private const val TAG = "MyraaWSClient"
        private const val PROTOCOL_PREFIX = "myraa-auth, "
        private const val INITIAL_RECONNECT_DELAY_MS = 1000L
        private const val MAX_RECONNECT_DELAY_MS = 16000L
    }

    private val scope = CoroutineScope(Dispatchers.IO + Job())
    private var webSocket: WebSocket? = null
    private var reconnectJob: Job? = null
    private var isManualDisconnect = AtomicBoolean(false)
    private var reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS

    private var currentHost: String = ""
    private var currentPort: Int = 3000
    private var currentToken: String = ""

    private val _connectionStatus = MutableStateFlow(ConnectionStatus.DISCONNECTED)
    val connectionStatus: StateFlow<ConnectionStatus> = _connectionStatus.asStateFlow()

    // Callbacks
    var onAudioReceived: ((base64Pcm24k: String) -> Unit)? = null
    var onTranscriptReceived: ((TranscriptItem) -> Unit)? = null
    var onEmergencyStopChanged: ((EmergencyStopState) -> Unit)? = null
    var onStatusMessage: ((String) -> Unit)? = null
    var onInterrupted: (() -> Unit)? = null
    var onTurnComplete: (() -> Unit)? = null
    var tokenRefreshProvider: (suspend () -> String?)? = null
    var capabilityRegistry: com.myraa.companion.capabilities.AndroidCapabilityRegistry? = null
    var onCapabilityExecuted: ((name: String, success: Boolean, details: String?) -> Unit)? = null
    var onMemorySyncReceived: ((memories: List<com.myraa.companion.capabilities.SharedMemoryItem>) -> Unit)? = null
    var onHandoffNotification: ((handoffId: String, action: String, status: String) -> Unit)? = null
    var onProactiveNotificationReceived: ((event: com.myraa.companion.capabilities.MobileProactiveEvent) -> Unit)? = null

    /**
     * Connect to /remote-live with Keystore bearer token.
     */
    fun connect(host: String, port: Int, bearerToken: String) {
        if (bearerToken.isBlank()) {
            Log.e(TAG, "Cannot connect: bearer token is empty")
            _connectionStatus.value = ConnectionStatus.ERROR
            return
        }

        currentHost = host
        currentPort = port
        currentToken = bearerToken
        isManualDisconnect.set(false)
        reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS

        initiateConnection()
    }

    private fun initiateConnection() {
        _connectionStatus.value = ConnectionStatus.CONNECTING
        val wsUrl = "ws://$currentHost:$currentPort/remote-live"
        Log.i(TAG, "Initiating WebSocket connection to: $wsUrl")

        val request = Request.Builder()
            .url(wsUrl)
            .header("Sec-WebSocket-Protocol", "$PROTOCOL_PREFIX$currentToken")
            .build()

        webSocket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(ws: WebSocket, response: Response) {
                Log.i(TAG, "WebSocket connected & authenticated successfully.")
                _connectionStatus.value = ConnectionStatus.AUTHENTICATED
                reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS
                onStatusMessage?.invoke("Connected to MYRAA Core")
            }

            override fun onMessage(ws: WebSocket, text: String) {
                handleIncomingMessage(text)
            }

            override fun onClosing(ws: WebSocket, code: Int, reason: String) {
                Log.w(TAG, "WebSocket closing (code: $code, reason: $reason)")
                ws.close(1000, null)
            }

            override fun onClosed(ws: WebSocket, code: Int, reason: String) {
                Log.i(TAG, "WebSocket closed (code: $code, reason: $reason)")
                val isTerminal = code in listOf(4001, 4003, 4008, 4023)
                if (!isManualDisconnect.get() && !isTerminal) {
                    scheduleReconnect()
                } else {
                    if (isTerminal) {
                        Log.w(TAG, "Terminal close code received: $code ($reason). Halting reconnect fail-closed.")
                        onStatusMessage?.invoke("Security restriction: $reason (Code $code)")
                    }
                    _connectionStatus.value = ConnectionStatus.DISCONNECTED
                }
            }

            override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) {
                val httpCode = response?.code ?: 0
                Log.e(TAG, "WebSocket failure: ${t.message} (code: $httpCode)")
                val isTerminalHttp = httpCode in listOf(401, 403, 423)
                if (!isManualDisconnect.get() && !isTerminalHttp) {
                    scheduleReconnect()
                } else {
                    if (isTerminalHttp) {
                        Log.w(TAG, "Terminal HTTP handshake error: $httpCode. Halting reconnect fail-closed.")
                        onStatusMessage?.invoke("Authentication failed (HTTP $httpCode)")
                    }
                    _connectionStatus.value = ConnectionStatus.ERROR
                }
            }
        })
    }

    private fun handleIncomingMessage(text: String) {
        try {
            val json = JSONObject(text)
            val msgType = json.optString("type", "")

            // 1. Check for audio chunk: handles both {"audio": "<base64>"} and {"type": "audio", "audio": "<base64>"}
            if (json.has("audio") && (msgType.isEmpty() || msgType == "audio")) {
                val base64 = json.getString("audio")
                onAudioReceived?.invoke(base64)
                return
            }

            // 2. Check for typed messages
            when (msgType) {
                "interrupted" -> {
                    onStatusMessage?.invoke("MYRAA interrupted")
                    onInterrupted?.invoke()
                }
                "turnComplete" -> {
                    onTurnComplete?.invoke()
                }
                "userTranscript" -> {
                    val transcript = json.optString("text", "")
                    if (transcript.isNotBlank()) {
                        onTranscriptReceived?.invoke(
                            TranscriptItem(
                                sender = TranscriptItem.Speaker.USER,
                                text = transcript
                            )
                        )
                    }
                }
                "modelTranscript" -> {
                    val transcript = json.optString("text", "")
                    if (transcript.isNotBlank()) {
                        onTranscriptReceived?.invoke(
                            TranscriptItem(
                                sender = TranscriptItem.Speaker.MYRAA,
                                text = transcript
                            )
                        )
                    }
                }
                "modelTurn" -> {
                    val transcript = json.optString("text", "")
                    if (transcript.isNotBlank()) {
                        onTranscriptReceived?.invoke(
                            TranscriptItem(
                                sender = TranscriptItem.Speaker.MYRAA,
                                text = transcript
                            )
                        )
                    }
                }
                "userTurn" -> {
                    val transcript = json.optString("text", "")
                    if (transcript.isNotBlank()) {
                        onTranscriptReceived?.invoke(
                            TranscriptItem(
                                sender = TranscriptItem.Speaker.USER,
                                text = transcript
                            )
                        )
                    }
                }
                "emergency_stop" -> {
                    val stateObj = json.optJSONObject("state")
                    val active = stateObj?.optBoolean("active", false) ?: false
                    val reason = stateObj?.optString("reason", "")
                    onEmergencyStopChanged?.invoke(
                        EmergencyStopState(
                            active = active,
                            reason = reason
                        )
                    )
                }
                "memory_sync", "shared_memory_event" -> {
                    val memArr = json.optJSONArray("memories")
                    if (memArr != null) {
                        val list = mutableListOf<com.myraa.companion.capabilities.SharedMemoryItem>()
                        for (i in 0 until memArr.length()) {
                            val item = memArr.optJSONObject(i)
                            if (item != null) {
                                list.add(com.myraa.companion.capabilities.SharedMemoryItem.fromJson(item))
                            }
                        }
                        capabilityRegistry?.getMemoryAdapter()?.updateCache(list)
                        onMemorySyncReceived?.invoke(list)
                        Log.i(TAG, "Processed memory_sync with ${list.size} memories")
                    }
                }
                "handoff_notification", "handoff_sync" -> {
                    val handoffId = json.optString("handoffId", "")
                    val action = json.optString("action", "")
                    val status = json.optString("status", "")
                    Log.i(TAG, "Processed handoff_notification: id=$handoffId, action=$action, status=$status")
                    onHandoffNotification?.invoke(handoffId, action, status)
                }
                "proactive_notification", "companion_notification" -> {
                    val notifObj = json.optJSONObject("notification") ?: json
                    val event = com.myraa.companion.capabilities.MobileProactiveEvent.fromJson(notifObj)
                    capabilityRegistry?.getMobileProactiveAdapter()?.postProactiveNotification(event)
                    onProactiveNotificationReceived?.invoke(event)
                    Log.i(TAG, "Processed proactive_notification: id=${event.id}, category=${event.category}")
                }
                "toolCall" -> {
                    val callId = json.optString("callId").takeIf { it.isNotBlank() }
                        ?: json.optString("id", "")
                    val name = json.optString("name", "")
                    val argsObj = json.optJSONObject("args") ?: JSONObject()

                    Log.i(TAG, "Received toolCall: id='$callId', name='$name'")
                    scope.launch {
                        val result = capabilityRegistry?.execute(name, argsObj)
                            ?: com.myraa.companion.capabilities.AndroidCapabilityResult.failure("No Android capability registry configured.")

                        val responseJson = JSONObject().apply {
                            put("type", "toolResponse")
                            put("id", callId)
                            put("name", name)
                            put("output", result.toJsonObject())
                        }
                        webSocket?.send(responseJson.toString())
                        Log.i(TAG, "Sent toolResponse for '$name' (success=${result.success})")

                        onCapabilityExecuted?.invoke(
                            name,
                            result.success,
                            if (result.success) result.result?.toString() else result.error
                        )
                    }
                }
                "status" -> {
                    val status = json.optString("status", "")
                    onStatusMessage?.invoke(status)
                }
                "error" -> {
                    val errMsg = json.optString("error", "Unknown server error")
                    onStatusMessage?.invoke("Error: $errMsg")
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error parsing incoming WebSocket frame: ${e.message}")
        }
    }

    /**
     * Send a client-side tool execution result back to MYRAA Core.
     */
    fun sendToolResponse(callId: String, name: String, output: JSONObject): Boolean {
        if (_connectionStatus.value != ConnectionStatus.AUTHENTICATED) return false
        val frame = JSONObject().apply {
            put("type", "toolResponse")
            put("id", callId)
            put("name", name)
            put("output", output)
        }
        return webSocket?.send(frame.toString()) ?: false
    }

    /**
     * Stream captured microphone 16kHz PCM16 chunk to MYRAA.
     */
    fun sendAudioFrame(pcm16Base64: String): Boolean {
        if (_connectionStatus.value != ConnectionStatus.AUTHENTICATED) return false
        val frame = JSONObject().apply {
            put("audio", pcm16Base64)
        }
        return webSocket?.send(frame.toString()) ?: false
    }

    /**
     * Send a text message turn to Gemini Live via MYRAA Core.
     */
    fun sendTextMessage(text: String): Boolean {
        if (_connectionStatus.value != ConnectionStatus.AUTHENTICATED) return false
        val frame = JSONObject().apply {
            put("type", "text")
            put("text", text)
        }
        return webSocket?.send(frame.toString()) ?: false
    }

    private fun scheduleReconnect() {
        if (isManualDisconnect.get()) return
        _connectionStatus.value = ConnectionStatus.RECONNECTING
        reconnectJob?.cancel()

        reconnectJob = scope.launch {
            val jitter = kotlin.random.Random.nextLong(0, 500)
            val totalDelay = reconnectDelayMs + jitter
            Log.i(TAG, "Scheduling reconnect in ${totalDelay}ms (base=${reconnectDelayMs}ms, jitter=${jitter}ms)...")
            delay(totalDelay)
            reconnectDelayMs = (reconnectDelayMs * 2).coerceAtMost(MAX_RECONNECT_DELAY_MS)
            if (!isManualDisconnect.get()) {
                try {
                    val freshToken = tokenRefreshProvider?.invoke()
                    if (!freshToken.isNullOrBlank()) {
                        currentToken = freshToken
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "Token refresh provider error during reconnect: ${e.message}")
                }
                initiateConnection()
            }
        }
    }

    /**
     * Disconnect cleanly and cancel any reconnection attempts.
     */
    fun disconnect() {
        isManualDisconnect.set(true)
        reconnectJob?.cancel()
        webSocket?.close(1000, "User disconnected")
        webSocket = null
        _connectionStatus.value = ConnectionStatus.DISCONNECTED
        Log.i(TAG, "WebSocket disconnected manually.")
    }
}
