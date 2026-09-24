package com.myraa.companion.capabilities

import android.app.ActivityManager
import android.app.AppOpsManager
import android.app.usage.UsageStatsManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.res.Configuration
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager
import android.os.Process
import android.util.Log

/**
 * MobileContextAdapter
 * Phase 22 — Mobile Context Intelligence
 *
 * Gathers Android-side context using ONLY publicly available, permission-compliant mechanisms.
 * If exact foreground activity or app is not reliably detectable, returns UNKNOWN / NOT_AVAILABLE.
 * Never guesses.
 */
class MobileContextAdapter(private val context: Context) {

    companion object {
        private const val TAG = "MobileContextAdapter"
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 1. CurrentAppProvider
    // ─────────────────────────────────────────────────────────────────────────

    fun getCurrentApp(): CurrentAppContext {
        return try {
            val appOps = context.getSystemService(Context.APP_OPS_SERVICE) as? AppOpsManager
            val mode = appOps?.unsafeCheckOpNoThrow(
                AppOpsManager.OPSTR_GET_USAGE_STATS,
                Process.myUid(),
                context.packageName
            )

            if (mode == AppOpsManager.MODE_ALLOWED) {
                val usm = context.getSystemService(Context.USAGE_STATS_SERVICE) as? UsageStatsManager
                val endTime = System.currentTimeMillis()
                val startTime = endTime - 1000 * 60 * 5 // Last 5 minutes
                val stats = usm?.queryUsageStats(UsageStatsManager.INTERVAL_DAILY, startTime, endTime)

                if (!stats.isNullOrEmpty()) {
                    val recent = stats.maxByOrNull { it.lastTimeUsed }
                    val pkg = recent?.packageName

                    if (!pkg.isNullOrBlank()) {
                        // Check if sensitive
                        if (MobileContextSanitizer.isSensitivePackage(pkg)) {
                            return CurrentAppContext.shielded(pkg)
                        }

                        val pm = context.packageManager
                        val appName = try {
                            val appInfo = pm.getApplicationInfo(pkg, 0)
                            pm.getApplicationLabel(appInfo).toString()
                        } catch (e: Exception) {
                            pkg
                        }

                        return CurrentAppContext(
                            packageName = pkg,
                            appName     = appName,
                            category    = "general",
                            isSensitive = false,
                            isAvailable = true
                        )
                    }
                }
            }

            // Fallback: Check running tasks/processes if accessible
            val am = context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
            val runningProcesses = am?.runningAppProcesses
            val foregroundProc = runningProcesses?.firstOrNull {
                it.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
            }

            if (foregroundProc != null && foregroundProc.processName.isNotBlank()) {
                val procPkg = foregroundProc.processName
                if (MobileContextSanitizer.isSensitivePackage(procPkg)) {
                    return CurrentAppContext.shielded(procPkg)
                }
                return CurrentAppContext(
                    packageName = procPkg,
                    appName     = procPkg,
                    category    = "general",
                    isSensitive = false,
                    isAvailable = true
                )
            }

            // Permission-compliant: Do NOT guess if not reliably available
            CurrentAppContext.unavailable()
        } catch (e: Exception) {
            Log.w(TAG, "getCurrentApp failed: ${e.message}")
            CurrentAppContext.unavailable()
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 2. ActivityProvider
    // ─────────────────────────────────────────────────────────────────────────

    fun getActivityContext(currentApp: CurrentAppContext): ActivityContext {
        // Without AccessibilityService (prohibited), exact internal activity of 3rd party apps
        // is not publicly available on modern Android (API 29+).
        // Return UNKNOWN / NOT_AVAILABLE rather than guessing.
        if (!currentApp.isAvailable || currentApp.isSensitive) {
            return ActivityContext.unavailable()
        }

        return ActivityContext(
            activityName = ContextConstants.UNKNOWN,
            screenTitle  = ContextConstants.NOT_AVAILABLE,
            state        = "active",
            isAvailable  = false
        )
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 3. NotificationContextProvider (Minimum necessary sanitized metadata)
    // ─────────────────────────────────────────────────────────────────────────

    fun getNotifications(): List<NotificationContextItem> {
        // Return empty list safely; notification listener requires special system service.
        // Sanitizer is invoked when notifications are ingested or streamed.
        return emptyList()
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 4. DeviceStateProvider
    // ─────────────────────────────────────────────────────────────────────────

    fun getDeviceState(): DeviceStateContext {
        return try {
            val pm = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
            val isScreenOn = pm?.isInteractive ?: true
            val orientation = if (context.resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE) {
                "landscape"
            } else {
                "portrait"
            }

            DeviceStateContext(
                manufacturer   = Build.MANUFACTURER,
                model          = Build.MODEL,
                androidVersion = Build.VERSION.RELEASE,
                sdkInt         = Build.VERSION.SDK_INT,
                orientation    = orientation,
                isScreenOn     = isScreenOn,
                isAvailable    = true
            )
        } catch (e: Exception) {
            Log.w(TAG, "getDeviceState failed: ${e.message}")
            DeviceStateContext()
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 5. NetworkStateProvider
    // ─────────────────────────────────────────────────────────────────────────

    fun getNetworkState(): NetworkStateContext {
        return try {
            val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
            val network = cm?.activeNetwork
            val caps = cm?.getNetworkCapabilities(network)

            val isConnected = caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            val isWifi = caps?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true
            val isCellular = caps?.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) == true
            val isMetered = caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) == false

            val type = when {
                isWifi -> "wifi"
                isCellular -> "cellular"
                isConnected -> "ethernet"
                else -> "none"
            }

            NetworkStateContext(
                isConnected = isConnected,
                type        = type,
                isMetered   = isMetered,
                wifiSsid    = null, // SSID requires fine location permission; omit for privacy
                isAvailable = true
            )
        } catch (e: Exception) {
            Log.w(TAG, "getNetworkState failed: ${e.message}")
            NetworkStateContext()
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 6. BatteryProvider
    // ─────────────────────────────────────────────────────────────────────────

    fun getBatteryState(): BatteryContext {
        return try {
            val filter = IntentFilter(Intent.ACTION_BATTERY_CHANGED)
            val batteryStatus: Intent? = context.registerReceiver(null, filter)
            val level = batteryStatus?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
            val scale = batteryStatus?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
            val status = batteryStatus?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
            val batteryPct = if (level >= 0 && scale > 0) (level * 100 / scale) else -1
            val isCharging = status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL

            val statusStr = when (status) {
                BatteryManager.BATTERY_STATUS_CHARGING     -> "charging"
                BatteryManager.BATTERY_STATUS_FULL         -> "full"
                BatteryManager.BATTERY_STATUS_DISCHARGING  -> "discharging"
                BatteryManager.BATTERY_STATUS_NOT_CHARGING -> "not_charging"
                else                                      -> "unknown"
            }

            BatteryContext(
                level       = batteryPct,
                isCharging  = isCharging,
                status      = statusStr,
                isAvailable = true
            )
        } catch (e: Exception) {
            Log.w(TAG, "getBatteryState failed: ${e.message}")
            BatteryContext()
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 7. ScreenContextProvider (Strict user-approval gate)
    // ─────────────────────────────────────────────────────────────────────────

    fun getScreenContext(approved: Boolean, rawScreenText: String? = null): ScreenContextData {
        if (!approved) {
            // Screen context is disabled by default and requires explicit user approval
            return ScreenContextData.disabled()
        }

        if (rawScreenText.isNullOrBlank()) {
            return ScreenContextData(
                isApproved   = true,
                summary      = ContextConstants.NOT_AVAILABLE,
                capturedAtMs = System.currentTimeMillis(),
                isAvailable  = false
            )
        }

        val sanitized = MobileContextSanitizer.sanitizeText(rawScreenText)
        return ScreenContextData(
            isApproved   = true,
            summary      = sanitized,
            capturedAtMs = System.currentTimeMillis(),
            isAvailable  = true
        )
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Snapshot Collection & Context Fusion
    // ─────────────────────────────────────────────────────────────────────────

    fun collectSnapshot(
        categories: Set<String>? = null,
        approvedScreenContext: Boolean = false,
        rawScreenText: String? = null
    ): MobileContextSnapshot {
        val cats = categories ?: MobileContextCategories.ALL
        val grantedPerms = mutableListOf<String>()

        val app = if (MobileContextCategories.APP in cats) {
            grantedPerms.add(MobileContextCategories.APP)
            getCurrentApp()
        } else {
            CurrentAppContext.unavailable()
        }

        val activity = if (MobileContextCategories.ACTIVITY in cats) {
            grantedPerms.add(MobileContextCategories.ACTIVITY)
            getActivityContext(app)
        } else {
            ActivityContext.unavailable()
        }

        val notifs = if (MobileContextCategories.NOTIFICATIONS in cats) {
            grantedPerms.add(MobileContextCategories.NOTIFICATIONS)
            getNotifications()
        } else {
            emptyList()
        }

        val device = if (MobileContextCategories.DEVICE in cats) {
            grantedPerms.add(MobileContextCategories.DEVICE)
            getDeviceState()
        } else {
            DeviceStateContext(isAvailable = false)
        }

        val network = if (MobileContextCategories.NETWORK in cats) {
            grantedPerms.add(MobileContextCategories.NETWORK)
            getNetworkState()
        } else {
            NetworkStateContext(isAvailable = false)
        }

        val battery = if (MobileContextCategories.BATTERY in cats) {
            grantedPerms.add(MobileContextCategories.BATTERY)
            getBatteryState()
        } else {
            BatteryContext(isAvailable = false)
        }

        val screen = if (MobileContextCategories.SCREEN in cats) {
            grantedPerms.add(MobileContextCategories.SCREEN)
            getScreenContext(approvedScreenContext, rawScreenText)
        } else {
            ScreenContextData.disabled()
        }

        // Deterministic Context Fusion
        val fused = buildFusedSummary(app, activity, notifs, device, network, battery, screen)

        return MobileContextSnapshot(
            timestamp          = System.currentTimeMillis(),
            deviceId           = Build.MODEL,
            currentApp         = app,
            activity           = activity,
            notifications      = notifs,
            deviceState        = device,
            networkState       = network,
            battery            = battery,
            screenContext      = screen,
            permissionsGranted = grantedPerms,
            fusedSummary       = fused,
            isSanitized        = true
        )
    }

    private fun buildFusedSummary(
        app: CurrentAppContext,
        activity: ActivityContext,
        notifications: List<NotificationContextItem>,
        device: DeviceStateContext,
        network: NetworkStateContext,
        battery: BatteryContext,
        screen: ScreenContextData
    ): String {
        val parts = mutableListOf<String>()

        if (app.isAvailable) {
            if (app.isSensitive) {
                parts.add("App: [Sensitive/Shielded]")
            } else {
                parts.add("App: ${app.appName} (${app.packageName})")
            }
        } else {
            parts.add("App: ${ContextConstants.UNKNOWN}")
        }

        if (activity.isAvailable) {
            parts.add("Activity: ${activity.activityName}")
        } else {
            parts.add("Activity: ${ContextConstants.NOT_AVAILABLE}")
        }

        if (screen.isApproved && screen.isAvailable && !screen.summary.isNullOrBlank()) {
            parts.add("Screen: \"${screen.summary}\"")
        } else if (screen.isApproved) {
            parts.add("Screen: [Approved, No Content]")
        } else {
            parts.add("Screen: [Unapproved/Disabled]")
        }

        if (battery.isAvailable) {
            val chg = if (battery.isCharging) "charging" else "discharging"
            parts.add("Battery: ${battery.level}% ($chg)")
        }

        if (network.isAvailable) {
            val netStr = if (network.isConnected) "${network.type}" else "disconnected"
            parts.add("Network: $netStr")
        }

        if (device.isAvailable) {
            parts.add("Device: ${device.manufacturer} ${device.model} (Android ${device.androidVersion})")
        }

        return parts.joinToString(" | ")
    }
}
