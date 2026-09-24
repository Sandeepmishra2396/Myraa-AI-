package com.myraa.companion.voice

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Base64
import android.util.Log
import java.util.concurrent.atomic.AtomicBoolean

/**
 * AudioRecordEngine
 * Phase 16 — Android Companion Foundation
 *
 * Implements low-latency microphone capture strictly matching MYRAA Gemini Live specs:
 *   - Sample Rate : 16,000 Hz
 *   - Bit Depth   : 16-bit Linear PCM
 *   - Channels    : Mono (ChannelInMono)
 *   - Encoding    : Base64 NO_WRAP chunks
 */
class AudioRecordEngine {

    companion object {
        private const val TAG = "AudioRecordEngine"
        const val SAMPLE_RATE_HZ = 16000
        private const val CHANNEL_CONFIG = AudioFormat.CHANNEL_IN_MONO
        private const val AUDIO_FORMAT = AudioFormat.ENCODING_PCM_16BIT
        // 20ms chunk = 16000 * 0.02 * 2 bytes = 640 bytes
        const val CHUNK_SIZE_BYTES = 640
        // Speech amplitude threshold (out of 32767 for 16-bit PCM) for instant barge-in detection
        const val SPEECH_AMPLITUDE_THRESHOLD = 1500
    }

    private var audioRecord: AudioRecord? = null
    private var recordingThread: Thread? = null
    private val isRecordingActive = AtomicBoolean(false)

    /** Callback invoked when speech amplitude exceeds the barge-in threshold */
    var onSpeechDetected: ((peakAmplitude: Int) -> Unit)? = null

    val isRecording: Boolean
        get() = isRecordingActive.get()

    /**
     * Start recording microphone PCM audio and stream chunks via callback.
     */
    @SuppressLint("MissingPermission")
    @Synchronized
    fun startRecording(onAudioChunk: (base64Chunk: String) -> Unit): Boolean {
        if (isRecordingActive.get()) {
            Log.w(TAG, "Recording already active.")
            return true
        }

        val minBufferSize = AudioRecord.getMinBufferSize(
            SAMPLE_RATE_HZ,
            CHANNEL_CONFIG,
            AUDIO_FORMAT
        )

        if (minBufferSize == AudioRecord.ERROR || minBufferSize == AudioRecord.ERROR_BAD_VALUE) {
            Log.e(TAG, "Invalid buffer size for AudioRecord.")
            return false
        }

        val bufferSize = maxOf(minBufferSize, CHUNK_SIZE_BYTES * 4)

        try {
            audioRecord = AudioRecord(
                MediaRecorder.AudioSource.VOICE_COMMUNICATION,
                SAMPLE_RATE_HZ,
                CHANNEL_CONFIG,
                AUDIO_FORMAT,
                bufferSize
            )

            if (audioRecord?.state != AudioRecord.STATE_INITIALIZED) {
                Log.e(TAG, "AudioRecord failed to initialize.")
                audioRecord?.release()
                audioRecord = null
                return false
            }

            audioRecord?.startRecording()
            isRecordingActive.set(true)

            recordingThread = Thread({
                val buffer = ByteArray(CHUNK_SIZE_BYTES)
                Log.i(TAG, "Microphone capture thread started.")

                while (isRecordingActive.get()) {
                    val bytesRead = audioRecord?.read(buffer, 0, buffer.size) ?: -1
                    if (bytesRead > 0) {
                        val peak = calculatePeakAmplitude(buffer, bytesRead)
                        if (peak >= SPEECH_AMPLITUDE_THRESHOLD) {
                            onSpeechDetected?.invoke(peak)
                        }

                        val base64 = Base64.encodeToString(buffer, 0, bytesRead, Base64.NO_WRAP)
                        onAudioChunk(base64)
                    } else if (bytesRead < 0) {
                        Log.e(TAG, "AudioRecord read error: $bytesRead")
                        break
                    }
                }
                Log.i(TAG, "Microphone capture thread stopped.")
            }, "MyraaMicCaptureThread")

            recordingThread?.start()
            return true
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start AudioRecord: ${e.message}")
            stopRecording()
            return false
        }
    }

    /**
     * Stop microphone capture and release hardware resources.
     */
    @Synchronized
    fun stopRecording() {
        if (!isRecordingActive.get()) return
        isRecordingActive.set(false)

        try {
            audioRecord?.stop()
            audioRecord?.release()
            recordingThread?.join(500)
        } catch (e: Exception) {
            Log.e(TAG, "Error stopping AudioRecord: ${e.message}")
        } finally {
            audioRecord = null
            recordingThread = null
        }
        Log.i(TAG, "Audio capture stopped and released.")
    }

    /**
     * Compute peak amplitude from 16-bit linear PCM little-endian buffer.
     */
    private fun calculatePeakAmplitude(buffer: ByteArray, length: Int): Int {
        var max = 0
        for (i in 0 until length - 1 step 2) {
            val sample = (buffer[i].toInt() and 0xFF) or (buffer[i + 1].toInt() shl 8)
            val abs = kotlin.math.abs(sample.toShort().toInt())
            if (abs > max) max = abs
        }
        return max
    }
}
