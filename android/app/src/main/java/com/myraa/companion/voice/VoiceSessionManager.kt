package com.myraa.companion.voice

import android.util.Log
import com.myraa.companion.networking.MyraaWebSocketClient
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * VoiceSessionManager
 * Phase 18 — Android Voice Assistant
 *
 * Coordinates the full bidirectional live voice loop:
 *   Mic (16kHz PCM16, 20ms chunks) -> WebSocket -> Gemini Live
 *   Gemini Live -> WebSocket -> AudioTrack (24kHz PCM16 streaming)
 *
 * Implements:
 *   - Native client-side barge-in detection (instant local cutoff <20ms)
 *   - Gemini Live server interruption synchronization ({ "type": "interrupted" })
 *   - Speech state tracking (isUserSpeaking, isModelSpeaking)
 *   - Immediate audio flushing to eliminate stale responses
 *   - Emergency Stop voice shutdown
 */
class VoiceSessionManager(
    private val wsClient: MyraaWebSocketClient,
    private val recordEngine: AudioRecordEngine = AudioRecordEngine(),
    private val trackEngine: AudioTrackEngine = AudioTrackEngine()
) {

    companion object {
        private const val TAG = "VoiceSessionManager"
    }

    private val _isVoiceActive = MutableStateFlow(false)
    val isVoiceActive: StateFlow<Boolean> = _isVoiceActive.asStateFlow()

    private val _isMicMuted = MutableStateFlow(false)
    val isMicMuted: StateFlow<Boolean> = _isMicMuted.asStateFlow()

    private val _isModelSpeaking = MutableStateFlow(false)
    val isModelSpeaking: StateFlow<Boolean> = _isModelSpeaking.asStateFlow()

    private val _isUserSpeaking = MutableStateFlow(false)
    val isUserSpeaking: StateFlow<Boolean> = _isUserSpeaking.asStateFlow()

    init {
        // 1. Route incoming 24kHz PCM chunks from WebSocket directly to AudioTrackEngine
        wsClient.onAudioReceived = { base64Pcm24k ->
            if (_isVoiceActive.value) {
                _isModelSpeaking.value = true
                trackEngine.enqueueAudio(base64Pcm24k)
            }
        }

        // 2. Handle server-side Gemini Live turn interruption
        wsClient.onInterrupted = {
            onInterrupted()
        }

        // 3. Handle model turn completion
        wsClient.onTurnComplete = {
            _isModelSpeaking.value = false
            Log.i(TAG, "Gemini Live model turn complete.")
        }

        // 4. Client-side barge-in: local speech detection triggers instant cutoff
        recordEngine.onSpeechDetected = { peakAmplitude ->
            if (_isVoiceActive.value && !_isMicMuted.value) {
                _isUserSpeaking.value = true
                // If model audio is playing or queued, immediately flush playback
                if (trackEngine.hasPendingAudio() || trackEngine.isPlaying) {
                    Log.i(TAG, "Barge-in speech detected (peak=$peakAmplitude): flushing playback.")
                    trackEngine.flush()
                    _isModelSpeaking.value = false
                }
            }
        }
    }

    /**
     * Start live voice session.
     */
    fun startVoiceSession(): Boolean {
        if (_isVoiceActive.value) return true

        trackEngine.start()

        val recordStarted = recordEngine.startRecording { base64Pcm16k ->
            if (!_isMicMuted.value && _isVoiceActive.value) {
                wsClient.sendAudioFrame(base64Pcm16k)
            }
        }

        if (recordStarted) {
            _isVoiceActive.value = true
            Log.i(TAG, "Live voice session activated.")
            return true
        } else {
            Log.e(TAG, "Failed to start microphone capture.")
            trackEngine.stop()
            return false
        }
    }

    /**
     * Stop active voice session.
     */
    fun stopVoiceSession() {
        if (!_isVoiceActive.value) return
        _isVoiceActive.value = false
        _isModelSpeaking.value = false
        _isUserSpeaking.value = false
        recordEngine.stopRecording()
        trackEngine.stop()
        Log.i(TAG, "Live voice session stopped.")
    }

    /**
     * Toggle microphone mute state without dropping session.
     */
    fun setMicMuted(muted: Boolean) {
        _isMicMuted.value = muted
        if (muted) {
            _isUserSpeaking.value = false
        }
        Log.i(TAG, "Microphone mute set to: $muted")
    }

    /**
     * Flush playback on Gemini turn interruption.
     */
    fun onInterrupted() {
        trackEngine.flush()
        _isModelSpeaking.value = false
        Log.i(TAG, "Voice playback flushed on model interruption.")
    }

    /**
     * Reset user speaking flag (e.g. after speech ends).
     */
    fun onUserSpeechEnded() {
        _isUserSpeaking.value = false
    }

    /**
     * Emergency Stop: immediately shut down all voice capture and playback.
     */
    fun onEmergencyStop() {
        Log.w(TAG, "Emergency Stop triggered: halting voice session.")
        stopVoiceSession()
        trackEngine.flush()
    }
}
