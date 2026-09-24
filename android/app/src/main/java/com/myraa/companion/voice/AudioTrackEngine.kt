package com.myraa.companion.voice

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.util.Base64
import android.util.Log
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.atomic.AtomicBoolean

/**
 * AudioTrackEngine
 * Phase 16 — Android Companion Foundation
 *
 * Implements low-latency audio playback strictly matching MYRAA Gemini Live specs:
 *   - Sample Rate : 24,000 Hz
 *   - Bit Depth   : 16-bit Linear PCM
 *   - Channels    : Mono (ChannelOutMono)
 *   - Mode        : Streaming (MODE_STREAM)
 */
class AudioTrackEngine {

    companion object {
        private const val TAG = "AudioTrackEngine"
        const val SAMPLE_RATE_HZ = 24000
        private const val CHANNEL_CONFIG = AudioFormat.CHANNEL_OUT_MONO
        private const val AUDIO_FORMAT = AudioFormat.ENCODING_PCM_16BIT
    }

    private var audioTrack: AudioTrack? = null
    private var playbackThread: Thread? = null
    private val isPlayingActive = AtomicBoolean(false)
    private val audioQueue = LinkedBlockingQueue<ByteArray>()

    val isPlaying: Boolean
        get() = isPlayingActive.get()

    /** Check if there are unconsumed audio chunks in the playback queue */
    fun hasPendingAudio(): Boolean = audioQueue.isNotEmpty()

    /** Check if track is actively streaming audio or has pending buffers */
    fun isActivelyPlaying(): Boolean =
        isPlayingActive.get() && (audioQueue.isNotEmpty() || (audioTrack?.playState == AudioTrack.PLAYSTATE_PLAYING))

    @Synchronized
    fun start(): Boolean {
        if (isPlayingActive.get()) return true

        val minBufferSize = AudioTrack.getMinBufferSize(
            SAMPLE_RATE_HZ,
            CHANNEL_CONFIG,
            AUDIO_FORMAT
        )

        if (minBufferSize <= 0) {
            Log.e(TAG, "Invalid AudioTrack buffer size: $minBufferSize")
            return false
        }

        try {
            audioTrack = AudioTrack.Builder()
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build()
                )
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setSampleRate(SAMPLE_RATE_HZ)
                        .setChannelMask(CHANNEL_CONFIG)
                        .setEncoding(AUDIO_FORMAT)
                        .build()
                )
                .setBufferSizeInBytes(minBufferSize * 2)
                .setTransferMode(AudioTrack.MODE_STREAM)
                .build()

            if (audioTrack?.state != AudioTrack.STATE_INITIALIZED) {
                Log.e(TAG, "AudioTrack failed to initialize.")
                audioTrack?.release()
                audioTrack = null
                return false
            }

            audioTrack?.play()
            isPlayingActive.set(true)

            playbackThread = Thread({
                Log.i(TAG, "Playback streaming thread started.")
                while (isPlayingActive.get()) {
                    try {
                        val chunk = audioQueue.poll(200, java.util.concurrent.TimeUnit.MILLISECONDS)
                        if (chunk != null && isPlayingActive.get()) {
                            audioTrack?.write(chunk, 0, chunk.size)
                        }
                    } catch (_: InterruptedException) {
                        break
                    }
                }
                Log.i(TAG, "Playback streaming thread ended.")
            }, "MyraaAudioPlaybackThread")

            playbackThread?.start()
            return true
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start AudioTrack: ${e.message}")
            stop()
            return false
        }
    }

    /**
     * Enqueue a Base64-encoded 24kHz PCM16 chunk for streaming playback.
     */
    fun enqueueAudio(base64Chunk: String) {
        if (!isPlayingActive.get()) {
            start()
        }
        try {
            val pcmBytes = Base64.decode(base64Chunk, Base64.DEFAULT)
            audioQueue.offer(pcmBytes)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to decode PCM audio chunk: ${e.message}")
        }
    }

    /**
     * Flush and discard queued audio (e.g. when Gemini Live indicates interruption).
     */
    fun flush() {
        audioQueue.clear()
        try {
            audioTrack?.pause()
            audioTrack?.flush()
            audioTrack?.play()
        } catch (e: Exception) {
            Log.e(TAG, "Error flushing AudioTrack: ${e.message}")
        }
    }

    /**
     * Stop playback and release AudioTrack resources.
     */
    @Synchronized
    fun stop() {
        if (!isPlayingActive.get()) return
        isPlayingActive.set(false)
        audioQueue.clear()

        try {
            audioTrack?.pause()
            audioTrack?.flush()
            audioTrack?.stop()
            audioTrack?.release()
            playbackThread?.interrupt()
            playbackThread?.join(500)
        } catch (e: Exception) {
            Log.e(TAG, "Error stopping AudioTrack: ${e.message}")
        } finally {
            audioTrack = null
            playbackThread = null
        }
        Log.i(TAG, "AudioTrack stopped and released.")
    }
}
