package com.myraa.companion.capabilities

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import com.myraa.companion.R
import org.json.JSONObject

/**
 * MobileProactiveAdapter
 * Phase 26 — Mobile Proactive Companion
 *
 * Native Android notification adapter managing the 6 proactive channels:
 *   1. myraa_tasks (IMPORTANCE_DEFAULT)
 *   2. myraa_reminders (IMPORTANCE_HIGH)
 *   3. myraa_projects (IMPORTANCE_DEFAULT)
 *   4. myraa_long_running (IMPORTANCE_DEFAULT)
 *   5. myraa_security (IMPORTANCE_HIGH)
 *   6. myraa_connection (IMPORTANCE_LOW)
 *
 * Includes local defense-in-depth DLP screening, channel initialization,
 * and capability execution.
 */
class MobileProactiveAdapter(private val context: Context) {

    companion object {
        private const val TAG = "MobileProactiveAdapter"

        const val CHANNEL_TASKS = "myraa_tasks"
        const val CHANNEL_REMINDERS = "myraa_reminders"
        const val CHANNEL_PROJECTS = "myraa_projects"
        const val CHANNEL_LONG_RUNNING = "myraa_long_running"
        const val CHANNEL_SECURITY = "myraa_security"
        const val CHANNEL_CONNECTION = "myraa_connection"
    }

    private val notificationManager =
        context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

    private var localPreferences = MobileNotificationPreferences()

    init {
        createNotificationChannels()
    }

    private fun createNotificationChannels() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channels = listOf(
                NotificationChannel(
                    CHANNEL_TASKS,
                    "MYRAA Tasks",
                    NotificationManager.IMPORTANCE_DEFAULT
                ).apply {
                    description = "Upcoming and in-progress task updates from MYRAA"
                },
                NotificationChannel(
                    CHANNEL_REMINDERS,
                    "MYRAA Reminders",
                    NotificationManager.IMPORTANCE_HIGH
                ).apply {
                    description = "Scheduled and high-importance reminders"
                },
                NotificationChannel(
                    CHANNEL_PROJECTS,
                    "MYRAA Project Updates",
                    NotificationManager.IMPORTANCE_DEFAULT
                ).apply {
                    description = "Workspace, git, build, and deployment monitoring updates"
                },
                NotificationChannel(
                    CHANNEL_LONG_RUNNING,
                    "MYRAA Long-Running Tasks",
                    NotificationManager.IMPORTANCE_DEFAULT
                ).apply {
                    description = "Background task and batch job completion notifications"
                },
                NotificationChannel(
                    CHANNEL_SECURITY,
                    "MYRAA Security Alerts",
                    NotificationManager.IMPORTANCE_HIGH
                ).apply {
                    description = "Critical security events and threat containment alerts"
                },
                NotificationChannel(
                    CHANNEL_CONNECTION,
                    "MYRAA Connection Status",
                    NotificationManager.IMPORTANCE_LOW
                ).apply {
                    description = "Desktop-mobile connectivity and sync status alerts"
                }
            )

            channels.forEach { channel ->
                notificationManager.createNotificationChannel(channel)
            }
            Log.i(TAG, "Initialized 6 Phase 26 proactive notification channels.")
        }
    }

    fun getChannelId(category: String): String {
        return when (category.uppercase()) {
            "TASK" -> CHANNEL_TASKS
            "REMINDER" -> CHANNEL_REMINDERS
            "PROJECT" -> CHANNEL_PROJECTS
            "LONG_RUNNING_TASK" -> CHANNEL_LONG_RUNNING
            "SECURITY" -> CHANNEL_SECURITY
            "CONNECTION" -> CHANNEL_CONNECTION
            else -> CHANNEL_TASKS
        }
    }

    /**
     * Defense-in-depth DLP screening on Android client.
     */
    fun isDlpClean(text: String): Boolean {
        if (text.isBlank()) return true
        val patterns = listOf(
            "sora_dev_", "myraa_at_", "Bearer ", "AIza", "sk-",
            "-----BEGIN", "PRIVATE KEY"
        )
        for (pat in patterns) {
            if (text.contains(pat, ignoreCase = true)) return false
        }
        return true
    }

    /**
     * Posts a native proactive notification to the user's Android notification tray.
     */
    fun postProactiveNotification(event: MobileProactiveEvent): AndroidCapabilityResult {
        return try {
            // Local DLP screening
            val dlpText = "${event.title} ${event.message} ${event.voiceText ?: ""}"
            if (!isDlpClean(dlpText)) {
                Log.w(TAG, "Blocked notification posting due to local DLP violation.")
                return AndroidCapabilityResult.failure("DLP_SECRET_REJECTED: Secrets or credentials cannot appear in notifications.")
            }

            // Check client-side category preference
            val isCatEnabled = localPreferences.enabledCategories[event.category.uppercase()] ?: true
            if (!localPreferences.enabled || !isCatEnabled) {
                Log.d(TAG, "Notification suppressed by local preferences: category=${event.category}")
                return AndroidCapabilityResult.success(
                    mapOf("posted" to false, "suppressedReason" to "CATEGORY_DISABLED", "id" to event.id)
                )
            }

            val channelId = getChannelId(event.category)
            val compatPriority = when (event.priority.uppercase()) {
                "URGENT", "HIGH" -> NotificationCompat.PRIORITY_HIGH
                "LOW" -> NotificationCompat.PRIORITY_LOW
                else -> NotificationCompat.PRIORITY_DEFAULT
            }

            val notifId = if (event.id.isNotBlank()) Math.abs(event.id.hashCode()) else (1000 + (System.currentTimeMillis() % 9000).toInt())

            val builder = NotificationCompat.Builder(context, channelId)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle(event.title)
                .setContentText(event.message)
                .setStyle(NotificationCompat.BigTextStyle().bigText(event.message))
                .setPriority(compatPriority)
                .setAutoCancel(true)

            notificationManager.notify(notifId, builder.build())
            Log.i(TAG, "Posted proactive notification (id: $notifId, category: ${event.category}, channel: $channelId)")

            AndroidCapabilityResult.success(
                mapOf(
                    "posted" to true,
                    "notificationId" to event.id,
                    "localNotificationId" to notifId,
                    "channelId" to channelId,
                    "category" to event.category
                )
            )
        } catch (e: Exception) {
            Log.e(TAG, "Error posting proactive notification: ${e.message}", e)
            AndroidCapabilityResult.failure("Failed to post proactive notification: ${e.message}")
        }
    }

    /**
     * Executes mobileProactive actions from capability dispatcher.
     */
    fun execute(args: JSONObject): AndroidCapabilityResult {
        val action = args.optString("action", "post").lowercase().trim()
        return when (action) {
            "post", "test", "notify" -> {
                val event = MobileProactiveEvent.fromJson(args)
                postProactiveNotification(event)
            }
            "clear" -> {
                notificationManager.cancelAll()
                AndroidCapabilityResult.success(mapOf("cleared" to true))
            }
            "getpreferences" -> {
                AndroidCapabilityResult.success(mapOf("preferences" to localPreferences.toJsonObject().toString()))
            }
            "updatepreferences" -> {
                val prefsObj = args.optJSONObject("preferences")
                if (prefsObj != null) {
                    localPreferences = MobileNotificationPreferences.fromJson(prefsObj)
                }
                AndroidCapabilityResult.success(mapOf("updated" to true, "preferences" to localPreferences.toJsonObject().toString()))
            }
            else -> {
                AndroidCapabilityResult.failure("UNKNOWN_ACTION: Proactive action '$action' is not recognized.")
            }
        }
    }

    fun getLocalPreferences(): MobileNotificationPreferences = localPreferences

    fun setLocalPreferences(prefs: MobileNotificationPreferences) {
        this.localPreferences = prefs
    }
}
