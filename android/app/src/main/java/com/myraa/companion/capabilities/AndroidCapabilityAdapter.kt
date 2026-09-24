package com.myraa.companion.capabilities

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.BatteryManager
import android.os.Build
import android.os.Environment
import android.os.StatFs
import android.provider.AlarmClock
import android.provider.CalendarContract
import android.provider.MediaStore
import android.provider.Settings
import android.util.Log
import android.view.KeyEvent
import androidx.core.app.NotificationCompat
import com.myraa.companion.R
import com.myraa.companion.voice.VoiceSessionManager
import java.net.URLEncoder

/**
 * AndroidCapabilityAdapter
 * Phase 19 — Android Native Capability Engine
 *
 * Implements native Android platform capabilities defined by Phase 15 contracts:
 *  1. openApp         (Intent.ACTION_MAIN / PackageManager / Allowlisted Apps)
 *  2. openUrl         (Intent.ACTION_VIEW with strict HTTP/HTTPS validation)
 *  3. openSettings    (Settings.ACTION_* intents)
 *  4. setAlarm        (AlarmClock.ACTION_SET_ALARM)
 *  5. setTimer        (AlarmClock.ACTION_SET_TIMER)
 *  6. createReminder  (CalendarContract.Events / Reminders intent)
 *  7. calendar        (CalendarContract event creation / view)
 *  8. notifications   (NotificationManager / NotificationCompat.Builder)
 *  9. mediaControls   (AudioManager stream volume & media key events)
 *  10. clipboard      (ClipboardManager explicit read/write/clear without secret leakage)
 *  11. deviceStatus   (Read-only Battery, Network, Storage, Device Build info)
 */
class AndroidCapabilityAdapter(
    private val context: Context,
    val voiceSession: VoiceSessionManager? = null
) {
    /** Exposes the Android Context to sibling capability adapters. */
    fun getContext(): Context = context

    companion object {
        private const val TAG = "AndroidCapabilityAdapter"
        private const val NOTIFICATION_CHANNEL_ID = "myraa_companion_notifications"
        private const val NOTIFICATION_CHANNEL_NAME = "MYRAA Companion Notifications"

        // Common app package mappings
        private val COMMON_APP_PACKAGES = mapOf(
            "gmail" to "com.google.android.gm",
            "mail" to "com.google.android.gm",
            "chrome" to "com.android.chrome",
            "browser" to "com.android.chrome",
            "youtube" to "com.google.android.youtube",
            "maps" to "com.google.android.apps.maps",
            "google maps" to "com.google.android.apps.maps",
            "calendar" to "com.google.android.calendar",
            "clock" to "com.google.android.deskclock",
            "alarm" to "com.google.android.deskclock",
            "calculator" to "com.google.android.calculator",
            "settings" to "com.android.settings",
            "camera" to "com.android.camera",
            "photos" to "com.google.android.apps.photos",
            "whatsapp" to "com.whatsapp",
            "telegram" to "org.telegram.messenger",
            "spotify" to "com.spotify.music"
        )
    }

    init {
        createNotificationChannel()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val notificationManager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            val channel = NotificationChannel(
                NOTIFICATION_CHANNEL_ID,
                NOTIFICATION_CHANNEL_NAME,
                NotificationManager.IMPORTANCE_DEFAULT
            ).apply {
                description = "Notifications posted by MYRAA Companion"
            }
            notificationManager.createNotificationChannel(channel)
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 1. openApp
    // ─────────────────────────────────────────────────────────────────────────
    fun openApp(appName: String?, packageName: String? = null): AndroidCapabilityResult {
        return try {
            val pm = context.packageManager
            var targetPackage = packageName

            if (targetPackage.isNullOrBlank() && !appName.isNullOrBlank()) {
                val normalizedName = appName.trim().lowercase()
                targetPackage = COMMON_APP_PACKAGES[normalizedName]

                // Fallback: check if appName itself looks like a package or is found in installed packages
                if (targetPackage == null) {
                    if (appName.contains(".")) {
                        targetPackage = appName.trim()
                    } else {
                        val installed = pm.getInstalledApplications(0)
                        val match = installed.firstOrNull { appInfo ->
                            pm.getApplicationLabel(appInfo).toString().equals(appName.trim(), ignoreCase = true)
                        }
                        targetPackage = match?.packageName
                    }
                }
            }

            if (targetPackage.isNullOrBlank()) {
                return AndroidCapabilityResult.failure("Could not resolve package name for app: '${appName ?: "unknown"}'")
            }

            val launchIntent = pm.getLaunchIntentForPackage(targetPackage)
            if (launchIntent != null) {
                launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                context.startActivity(launchIntent)
                AndroidCapabilityResult.success(mapOf("launched" to true, "package" to targetPackage, "app" to (appName ?: targetPackage)))
            } else {
                AndroidCapabilityResult.failure("App '$targetPackage' is not installed or cannot be launched.")
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error executing openApp: ${e.message}", e)
            AndroidCapabilityResult.failure("Failed to launch app: ${e.message}")
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 2. openUrl
    // ─────────────────────────────────────────────────────────────────────────
    fun openUrl(url: String): AndroidCapabilityResult {
        return try {
            val cleanUrl = url.trim()
            if (!cleanUrl.startsWith("http://", ignoreCase = true) && !cleanUrl.startsWith("https://", ignoreCase = true)) {
                return AndroidCapabilityResult.failure("SECURITY_VIOLATION: Only http:// and https:// URLs are allowed.")
            }

            val uri = Uri.parse(cleanUrl)
            val host = uri.host?.lowercase() ?: ""
            if (host == "localhost" || host.startsWith("127.") || host.startsWith("10.") ||
                host.startsWith("192.168.") || host.startsWith("169.254.") || host.startsWith("172.16.") ||
                host.startsWith("172.17.") || host.startsWith("172.18.") || host.startsWith("172.19.") ||
                host.startsWith("172.2") || host.startsWith("172.30.") || host.startsWith("172.31.") ||
                host == "::1" || host == "[::1]") {
                return AndroidCapabilityResult.failure("SECURITY_VIOLATION: Loopback and private network URLs are prohibited.")
            }

            val intent = Intent(Intent.ACTION_VIEW, uri).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(intent)
            AndroidCapabilityResult.success(mapOf("opened" to true, "url" to cleanUrl))
        } catch (e: Exception) {
            Log.e(TAG, "Error executing openUrl: ${e.message}", e)
            AndroidCapabilityResult.failure("Failed to open URL: ${e.message}")
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 3. openSettings
    // ─────────────────────────────────────────────────────────────────────────
    fun openSettings(settingType: String? = null): AndroidCapabilityResult {
        return try {
            val action = when (settingType?.lowercase()?.trim()) {
                "wifi" -> Settings.ACTION_WIFI_SETTINGS
                "bluetooth" -> Settings.ACTION_BLUETOOTH_SETTINGS
                "sound", "volume", "audio" -> Settings.ACTION_SOUND_SETTINGS
                "display", "brightness" -> Settings.ACTION_DISPLAY_SETTINGS
                "battery" -> Intent.ACTION_POWER_USAGE_SUMMARY
                "apps", "applications" -> Settings.ACTION_APPLICATION_SETTINGS
                "storage" -> Settings.ACTION_INTERNAL_STORAGE_SETTINGS
                "location" -> Settings.ACTION_LOCATION_SOURCE_SETTINGS
                "security" -> Settings.ACTION_SECURITY_SETTINGS
                else -> Settings.ACTION_SETTINGS
            }

            val intent = Intent(action).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(intent)
            AndroidCapabilityResult.success(mapOf("opened" to true, "setting" to (settingType ?: "general"), "action" to action))
        } catch (e: Exception) {
            Log.e(TAG, "Error executing openSettings: ${e.message}", e)
            AndroidCapabilityResult.failure("Failed to open settings: ${e.message}")
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 4. setAlarm
    // ─────────────────────────────────────────────────────────────────────────
    fun setAlarm(hour: Int, minutes: Int, message: String? = null, skipUi: Boolean = true): AndroidCapabilityResult {
        return try {
            if (hour !in 0..23 || minutes !in 0..59) {
                return AndroidCapabilityResult.failure("Invalid alarm time: hour must be 0-23, minutes must be 0-59 (got $hour:$minutes)")
            }

            val label = message ?: "MYRAA Alarm"
            val intent = Intent(AlarmClock.ACTION_SET_ALARM).apply {
                putExtra(AlarmClock.EXTRA_HOUR, hour)
                putExtra(AlarmClock.EXTRA_MINUTES, minutes)
                putExtra(AlarmClock.EXTRA_MESSAGE, label)
                putExtra(AlarmClock.EXTRA_SKIP_UI, skipUi)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(intent)
            AndroidCapabilityResult.success(mapOf("scheduled" to true, "hour" to hour, "minutes" to minutes, "label" to label))
        } catch (e: Exception) {
            Log.e(TAG, "Error executing setAlarm: ${e.message}", e)
            AndroidCapabilityResult.failure("Failed to set alarm: ${e.message}")
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 5. setTimer
    // ─────────────────────────────────────────────────────────────────────────
    fun setTimer(lengthSeconds: Int, message: String? = null, skipUi: Boolean = true): AndroidCapabilityResult {
        return try {
            if (lengthSeconds <= 0) {
                return AndroidCapabilityResult.failure("Invalid timer duration: lengthSeconds must be positive (got $lengthSeconds)")
            }

            val label = message ?: "MYRAA Timer"
            val intent = Intent(AlarmClock.ACTION_SET_TIMER).apply {
                putExtra(AlarmClock.EXTRA_LENGTH, lengthSeconds)
                putExtra(AlarmClock.EXTRA_MESSAGE, label)
                putExtra(AlarmClock.EXTRA_SKIP_UI, skipUi)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(intent)
            AndroidCapabilityResult.success(mapOf("scheduled" to true, "lengthSeconds" to lengthSeconds, "label" to label))
        } catch (e: Exception) {
            Log.e(TAG, "Error executing setTimer: ${e.message}", e)
            AndroidCapabilityResult.failure("Failed to set timer: ${e.message}")
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 6. createReminder
    // ─────────────────────────────────────────────────────────────────────────
    fun createReminder(title: String, notes: String? = null, timeMs: Long? = null): AndroidCapabilityResult {
        return try {
            if (title.isBlank()) {
                return AndroidCapabilityResult.failure("Reminder title cannot be empty.")
            }

            val targetTime = timeMs ?: (System.currentTimeMillis() + 3600000) // Default 1 hour from now
            val intent = Intent(Intent.ACTION_INSERT).apply {
                data = CalendarContract.Events.CONTENT_URI
                putExtra(CalendarContract.Events.TITLE, title)
                if (!notes.isNullOrBlank()) {
                    putExtra(CalendarContract.Events.DESCRIPTION, notes)
                }
                putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, targetTime)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(intent)
            AndroidCapabilityResult.success(mapOf("created" to true, "title" to title, "timeMs" to targetTime))
        } catch (e: Exception) {
            Log.e(TAG, "Error executing createReminder: ${e.message}", e)
            AndroidCapabilityResult.failure("Failed to create reminder: ${e.message}")
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 7. calendar
    // ─────────────────────────────────────────────────────────────────────────
    fun calendar(
        action: String = "view",
        title: String? = null,
        startTimeMs: Long? = null,
        endTimeMs: Long? = null,
        description: String? = null
    ): AndroidCapabilityResult {
        return try {
            when (action.lowercase().trim()) {
                "insert", "create", "add" -> {
                    if (title.isNullOrBlank()) {
                        return AndroidCapabilityResult.failure("Event title is required to create a calendar event.")
                    }
                    val start = startTimeMs ?: System.currentTimeMillis()
                    val end = endTimeMs ?: (start + 3600000)
                    val intent = Intent(Intent.ACTION_INSERT).apply {
                        data = CalendarContract.Events.CONTENT_URI
                        putExtra(CalendarContract.Events.TITLE, title)
                        putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, start)
                        putExtra(CalendarContract.EXTRA_EVENT_END_TIME, end)
                        if (!description.isNullOrBlank()) {
                            putExtra(CalendarContract.Events.DESCRIPTION, description)
                        }
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                    context.startActivity(intent)
                    AndroidCapabilityResult.success(mapOf("action" to "insert", "title" to title, "startTime" to start, "endTime" to end))
                }
                else -> {
                    // View calendar at specified time or current time
                    val start = startTimeMs ?: System.currentTimeMillis()
                    val builder = CalendarContract.CONTENT_URI.buildUpon().appendPath("time").appendPath(start.toString())
                    val intent = Intent(Intent.ACTION_VIEW).apply {
                        data = builder.build()
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                    context.startActivity(intent)
                    AndroidCapabilityResult.success(mapOf("action" to "view", "timeMs" to start))
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error executing calendar: ${e.message}", e)
            AndroidCapabilityResult.failure("Failed to execute calendar action: ${e.message}")
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 8. notifications
    // ─────────────────────────────────────────────────────────────────────────
    fun notifications(
        action: String = "post",
        title: String? = null,
        message: String? = null,
        notificationId: Int? = null
    ): AndroidCapabilityResult {
        return try {
            val notificationManager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            val id = notificationId ?: 1001

            when (action.lowercase().trim()) {
                "cancel", "dismiss", "clear" -> {
                    notificationManager.cancel(id)
                    AndroidCapabilityResult.success(mapOf("cancelled" to true, "notificationId" to id))
                }
                else -> {
                    val notifTitle = title ?: "MYRAA Assistant"
                    val notifBody = message ?: "Notification from MYRAA"

                    // Security check: Never expose raw credentials in notifications
                    if (notifBody.contains("sora_dev_") || notifBody.contains("myraa_at_") || notifBody.contains("Bearer ")) {
                        return AndroidCapabilityResult.failure("SECURITY_VIOLATION: Attempted to post sensitive tokens in notification.")
                    }

                    val builder = NotificationCompat.Builder(context, NOTIFICATION_CHANNEL_ID)
                        .setSmallIcon(R.mipmap.ic_launcher)
                        .setContentTitle(notifTitle)
                        .setContentText(notifBody)
                        .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                        .setAutoCancel(true)

                    notificationManager.notify(id, builder.build())
                    AndroidCapabilityResult.success(mapOf("posted" to true, "id" to id, "title" to notifTitle))
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error executing notifications: ${e.message}", e)
            AndroidCapabilityResult.failure("Failed to handle notification: ${e.message}")
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 9. mediaControls
    // ─────────────────────────────────────────────────────────────────────────
    fun mediaControls(action: String, volumeLevel: Int? = null): AndroidCapabilityResult {
        return try {
            val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
            val currentVol = audioManager.getStreamVolume(AudioManager.STREAM_MUSIC)
            val maxVol = audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC)

            when (action.lowercase().trim()) {
                "volume_up", "volumeup" -> {
                    audioManager.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_RAISE, 0)
                    val newVol = audioManager.getStreamVolume(AudioManager.STREAM_MUSIC)
                    AndroidCapabilityResult.success(mapOf("action" to "volume_up", "volume" to newVol, "maxVolume" to maxVol))
                }
                "volume_down", "volumedown" -> {
                    audioManager.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_LOWER, 0)
                    val newVol = audioManager.getStreamVolume(AudioManager.STREAM_MUSIC)
                    AndroidCapabilityResult.success(mapOf("action" to "volume_down", "volume" to newVol, "maxVolume" to maxVol))
                }
                "set_volume", "setvolume" -> {
                    val targetLevel = volumeLevel ?: 50
                    val clamped = (targetLevel.coerceIn(0, 100) * maxVol / 100)
                    audioManager.setStreamVolume(AudioManager.STREAM_MUSIC, clamped, 0)
                    AndroidCapabilityResult.success(mapOf("action" to "set_volume", "volume" to clamped, "maxVolume" to maxVol, "percent" to targetLevel))
                }
                "mute", "unmute", "mutetoggle" -> {
                    audioManager.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_TOGGLE_MUTE, 0)
                    AndroidCapabilityResult.success(mapOf("action" to "mute_toggle"))
                }
                "play", "pause", "play_pause" -> {
                    val eventDown = KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE)
                    val eventUp = KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE)
                    audioManager.dispatchMediaKeyEvent(eventDown)
                    audioManager.dispatchMediaKeyEvent(eventUp)
                    AndroidCapabilityResult.success(mapOf("action" to "play_pause"))
                }
                "next", "skip" -> {
                    val eventDown = KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_MEDIA_NEXT)
                    val eventUp = KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_MEDIA_NEXT)
                    audioManager.dispatchMediaKeyEvent(eventDown)
                    audioManager.dispatchMediaKeyEvent(eventUp)
                    AndroidCapabilityResult.success(mapOf("action" to "next"))
                }
                "previous", "prev" -> {
                    val eventDown = KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_MEDIA_PREVIOUS)
                    val eventUp = KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_MEDIA_PREVIOUS)
                    audioManager.dispatchMediaKeyEvent(eventDown)
                    audioManager.dispatchMediaKeyEvent(eventUp)
                    AndroidCapabilityResult.success(mapOf("action" to "previous"))
                }
                else -> {
                    AndroidCapabilityResult.failure("Unknown mediaControls action: '$action'. Supported: volume_up, volume_down, set_volume, mute, play_pause, next, previous.")
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error executing mediaControls: ${e.message}", e)
            AndroidCapabilityResult.failure("Failed to execute media control: ${e.message}")
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 10. clipboard
    // ─────────────────────────────────────────────────────────────────────────
    fun clipboard(action: String, text: String? = null): AndroidCapabilityResult {
        return try {
            val clipboardManager = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager

            when (action.lowercase().trim()) {
                "set", "copy", "write" -> {
                    val content = text ?: ""
                    // Security guard: Never copy secrets or tokens into clipboard
                    if (content.contains("sora_dev_") || content.contains("myraa_at_") || content.contains("Bearer ")) {
                        return AndroidCapabilityResult.failure("SECURITY_VIOLATION: Sensitive credentials cannot be copied to clipboard.")
                    }
                    val clip = ClipData.newPlainText("MYRAA", content)
                    clipboardManager.setPrimaryClip(clip)
                    AndroidCapabilityResult.success(mapOf("action" to "set", "length" to content.length))
                }
                "get", "read", "paste" -> {
                    val clip = clipboardManager.primaryClip
                    if (clip != null && clip.itemCount > 0) {
                        val clipText = clip.getItemAt(0).text?.toString() ?: ""
                        // Sanitize returned clipboard text if it contains sensitive patterns
                        val sanitized = if (clipText.contains("sora_dev_") || clipText.contains("myraa_at_")) "[REDACTED_CREDENTIAL]" else clipText
                        AndroidCapabilityResult.success(mapOf("action" to "get", "text" to sanitized))
                    } else {
                        AndroidCapabilityResult.success(mapOf("action" to "get", "text" to ""))
                    }
                }
                "clear" -> {
                    clipboardManager.setPrimaryClip(ClipData.newPlainText("", ""))
                    AndroidCapabilityResult.success(mapOf("action" to "clear"))
                }
                else -> {
                    AndroidCapabilityResult.failure("Unknown clipboard action: '$action'. Supported: set, get, clear.")
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error executing clipboard: ${e.message}", e)
            AndroidCapabilityResult.failure("Failed to execute clipboard action: ${e.message}")
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 11. deviceStatus (Read-Only)
    // ─────────────────────────────────────────────────────────────────────────
    data class BatteryInfo(val level: Int, val isCharging: Boolean)
    data class NetworkInfo(val isConnected: Boolean, val isWifi: Boolean, val isCellular: Boolean)
    data class StorageInfo(val totalBytes: Long, val availableBytes: Long)
    data class DeviceInfo(val manufacturer: String, val model: String, val androidVersion: String, val sdkInt: Int)

    fun getBatteryStatus(): BatteryInfo {
        val filter = IntentFilter(Intent.ACTION_BATTERY_CHANGED)
        val batteryStatus: Intent? = context.registerReceiver(null, filter)
        val level = batteryStatus?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val scale = batteryStatus?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
        val status = batteryStatus?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
        val batteryPct = if (level >= 0 && scale > 0) (level * 100 / scale) else -1
        val isCharging = status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL
        return BatteryInfo(level = batteryPct, isCharging = isCharging)
    }

    fun getNetworkStatus(): NetworkInfo {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val network = cm.activeNetwork
        val caps = cm.getNetworkCapabilities(network)
        val isConnected = caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
        val isWifi = caps?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true
        val isCellular = caps?.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) == true
        return NetworkInfo(isConnected = isConnected, isWifi = isWifi, isCellular = isCellular)
    }

    fun getStorageInfo(): StorageInfo {
        val stat = StatFs(Environment.getDataDirectory().path)
        val total = stat.blockSizeLong * stat.blockCountLong
        val available = stat.blockSizeLong * stat.availableBlocksLong
        return StorageInfo(totalBytes = total, availableBytes = available)
    }

    fun getDeviceInfo(): DeviceInfo {
        return DeviceInfo(
            manufacturer = Build.MANUFACTURER,
            model = Build.MODEL,
            androidVersion = Build.VERSION.RELEASE,
            sdkInt = Build.VERSION.SDK_INT
        )
    }

    fun deviceStatus(category: String? = null): AndroidCapabilityResult {
        return try {
            val cat = category?.lowercase()?.trim() ?: "all"
            val map = mutableMapOf<String, Any>()

            if (cat == "all" || cat == "battery") {
                val battery = getBatteryStatus()
                map["battery"] = mapOf("level" to battery.level, "isCharging" to battery.isCharging)
            }
            if (cat == "all" || cat == "network") {
                val network = getNetworkStatus()
                map["network"] = mapOf("isConnected" to network.isConnected, "isWifi" to network.isWifi, "isCellular" to network.isCellular)
            }
            if (cat == "all" || cat == "storage") {
                val storage = getStorageInfo()
                map["storage"] = mapOf("totalBytes" to storage.totalBytes, "availableBytes" to storage.availableBytes)
            }
            if (cat == "all" || cat == "device" || cat == "system") {
                val device = getDeviceInfo()
                map["device"] = mapOf(
                    "manufacturer" to device.manufacturer,
                    "model" to device.model,
                    "androidVersion" to device.androidVersion,
                    "sdkInt" to device.sdkInt
                )
            }

            AndroidCapabilityResult.success(map)
        } catch (e: Exception) {
            Log.e(TAG, "Error executing deviceStatus: ${e.message}", e)
            AndroidCapabilityResult.failure("Failed to read device status: ${e.message}")
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Phase 20 — Browser Capabilities
    // ─────────────────────────────────────────────────────────────────────────

    // Known browser packages for explicit launching
    private val KNOWN_BROWSER_PACKAGES = mapOf(
        "chrome" to "com.android.chrome",
        "google chrome" to "com.android.chrome",
        "firefox" to "org.mozilla.firefox",
        "edge" to "com.microsoft.emmx",
        "microsoft edge" to "com.microsoft.emmx",
        "brave" to "com.brave.browser",
        "opera" to "com.opera.browser",
        "samsung" to "com.sec.android.app.sbrowser"
    )

    /**
     * 12. openBrowser
     * Launches the default or specified browser with an optional target URL.
     */
    fun openBrowser(browserName: String? = null, url: String? = null): AndroidCapabilityResult {
        return try {
            val cleanUrl = url?.trim()
            val targetPackage = browserName?.lowercase()?.trim()?.let { KNOWN_BROWSER_PACKAGES[it] ?: it }

            if (!cleanUrl.isNullOrBlank()) {
                if (!cleanUrl.startsWith("http://", ignoreCase = true) && !cleanUrl.startsWith("https://", ignoreCase = true)) {
                    return AndroidCapabilityResult.failure("SECURITY_VIOLATION: Only http:// and https:// URLs are allowed.")
                }

                val uri = Uri.parse(cleanUrl)
                val host = uri.host?.lowercase() ?: ""
                if (host == "localhost" || host.startsWith("127.") || host.startsWith("10.") ||
                    host.startsWith("192.168.") || host.startsWith("169.254.") || host.startsWith("172.16.") ||
                    host.startsWith("172.17.") || host.startsWith("172.18.") || host.startsWith("172.19.") ||
                    host.startsWith("172.2") || host.startsWith("172.30.") || host.startsWith("172.31.") ||
                    host == "::1" || host == "[::1]") {
                    return AndroidCapabilityResult.failure("SECURITY_VIOLATION: Loopback and private network URLs are prohibited.")
                }

                val intent = Intent(Intent.ACTION_VIEW, uri).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    if (!targetPackage.isNullOrBlank()) {
                        setPackage(targetPackage)
                    }
                }
                context.startActivity(intent)
                AndroidCapabilityResult.success(mapOf("opened" to true, "browser" to (browserName ?: "default"), "url" to cleanUrl))
            } else {
                val launchIntent = if (!targetPackage.isNullOrBlank()) {
                    context.packageManager.getLaunchIntentForPackage(targetPackage)
                } else {
                    Intent(Intent.ACTION_MAIN).apply {
                        addCategory(Intent.CATEGORY_APP_BROWSER)
                    }
                }

                if (launchIntent != null) {
                    launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    context.startActivity(launchIntent)
                    AndroidCapabilityResult.success(mapOf("opened" to true, "browser" to (browserName ?: "default")))
                } else {
                    // Fallback to generic browser intent
                    val browserIntent = Intent(Intent.ACTION_VIEW, Uri.parse("https://www.google.com")).apply {
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                    context.startActivity(browserIntent)
                    AndroidCapabilityResult.success(mapOf("opened" to true, "browser" to "default", "fallback" to true))
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error executing openBrowser: ${e.message}", e)
            AndroidCapabilityResult.failure("Failed to open browser: ${e.message}")
        }
    }

    /**
     * 13. searchWeb
     * Constructs a safe, validated search query and opens it via default/specified search provider.
     */
    fun searchWeb(query: String, engine: String? = null): AndroidCapabilityResult {
        return try {
            val cleanQuery = query.trim()
            if (cleanQuery.isBlank()) {
                return AndroidCapabilityResult.failure("ARGUMENT_VIOLATION: Search query cannot be empty.")
            }
            if (cleanQuery.length > 500) {
                return AndroidCapabilityResult.failure("ARGUMENT_VIOLATION: Search query exceeds maximum length of 500 characters.")
            }
            if (cleanQuery.contains(";") || cleanQuery.contains("|") || cleanQuery.contains("`") || cleanQuery.contains("$")) {
                return AndroidCapabilityResult.failure("SECURITY_VIOLATION: Search query contains prohibited characters.")
            }

            val encoded = URLEncoder.encode(cleanQuery, "UTF-8")
            val targetEngine = (engine ?: "google").lowercase().trim()
            val searchUrl = when (targetEngine) {
                "duckduckgo" -> "https://duckduckgo.com/?q=$encoded"
                "bing" -> "https://www.bing.com/search?q=$encoded"
                "youtube" -> "https://www.youtube.com/results?search_query=$encoded"
                "ecosia" -> "https://www.ecosia.org/search?q=$encoded"
                else -> "https://www.google.com/search?q=$encoded"
            }

            val intent = Intent(Intent.ACTION_VIEW, Uri.parse(searchUrl)).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(intent)
            AndroidCapabilityResult.success(mapOf("searched" to true, "query" to cleanQuery, "engine" to targetEngine, "url" to searchUrl))
        } catch (e: Exception) {
            Log.e(TAG, "Error executing searchWeb: ${e.message}", e)
            AndroidCapabilityResult.failure("Failed to execute searchWeb: ${e.message}")
        }
    }

    /**
     * 14. findOnPage
     * Strict boundary: Unsupported on external Android browsers without invasive AccessibilityService
     * or DOM manipulation. Returns controlled typed NOT_SUPPORTED result.
     */
    fun findOnPage(query: String): AndroidCapabilityResult {
        val cleanQuery = query.trim()
        if (cleanQuery.isBlank()) {
            return AndroidCapabilityResult.failure("ARGUMENT_VIOLATION: Find query cannot be empty.")
        }
        return AndroidCapabilityResult.failure(
            "NOT_SUPPORTED: In-page text search is not supported on external Android browsers without unrestricted AccessibilityService or DOM automation, which is restricted for security."
        )
    }

    /**
     * 15. navigateBack
     * Strict boundary: Unsupported on external Android browsers without invasive AccessibilityService.
     * Returns controlled typed NOT_SUPPORTED result.
     */
    fun navigateBack(steps: Int = 1): AndroidCapabilityResult {
        return AndroidCapabilityResult.failure(
            "NOT_SUPPORTED: Browser history back navigation is not supported on external Android browsers without unrestricted AccessibilityService automation, which is restricted for security."
        )
    }

    /**
     * 16. navigateForward
     * Strict boundary: Unsupported on external Android browsers without invasive AccessibilityService.
     * Returns controlled typed NOT_SUPPORTED result.
     */
    fun navigateForward(steps: Int = 1): AndroidCapabilityResult {
        return AndroidCapabilityResult.failure(
            "NOT_SUPPORTED: Browser history forward navigation is not supported on external Android browsers without unrestricted AccessibilityService automation, which is restricted for security."
        )
    }
}
