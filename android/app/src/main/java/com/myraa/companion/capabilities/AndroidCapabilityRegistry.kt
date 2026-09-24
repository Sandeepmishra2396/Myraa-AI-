package com.myraa.companion.capabilities

import android.util.Log
import org.json.JSONObject

/**
 * AndroidCapabilityRegistry
 * Phase 19 — Android Native Capability Engine
 * Phase 21 — Mobile App Interaction Layer (added AppCapabilityAdapter routing)
 *
 * Central dispatcher routing capability requests received from MYRAA Core
 * to the corresponding native methods on AndroidCapabilityAdapter
 * or AppCapabilityAdapter.
 */
class AndroidCapabilityRegistry(
    private val adapter: AndroidCapabilityAdapter,
    private val appAdapter: AppCapabilityAdapter = AppCapabilityAdapter(adapter.getContext()),
    private val contextAdapter: MobileContextAdapter = MobileContextAdapter(adapter.getContext()),
    private val screenAdapter: MobileScreenAdapter = MobileScreenAdapter(adapter.getContext(), contextAdapter),
    private val memoryAdapter: SharedMemoryAdapter = SharedMemoryAdapter(adapter.getContext()),
    private val handoffAdapter: HandoffAdapter = HandoffAdapter(adapter.getContext()),
    private val proactiveAdapter: MobileProactiveAdapter = MobileProactiveAdapter(adapter.getContext())
) {
    companion object {
        private const val TAG = "AndroidCapRegistry"
    }

    /**
     * Executes a requested capability with given JSON arguments.
     * Argument extraction and type validation happen here before calling the adapter.
     */
    fun execute(capabilityName: String, args: JSONObject): AndroidCapabilityResult {
        val canonical = AndroidCapabilities.resolveCanonicalCapability(capabilityName)
        Log.i(TAG, "Dispatching capability '$capabilityName' (canonical: '$canonical') with args: $args")

        return try {
            when (canonical) {
                AndroidCapabilities.OPEN_APP -> {
                    val appName = args.optString("appName").takeIf { it.isNotBlank() }
                        ?: args.optString("app").takeIf { it.isNotBlank() }
                        ?: args.optString("name").takeIf { it.isNotBlank() }
                    val packageName = args.optString("packageName").takeIf { it.isNotBlank() }
                        ?: args.optString("package").takeIf { it.isNotBlank() }

                    if (appName == null && packageName == null) {
                        AndroidCapabilityResult.failure("Missing required argument: 'appName' or 'packageName'.")
                    } else {
                        adapter.openApp(appName, packageName)
                    }
                }

                AndroidCapabilities.OPEN_URL -> {
                    val url = args.optString("url").takeIf { it.isNotBlank() }
                        ?: args.optString("link").takeIf { it.isNotBlank() }

                    if (url == null) {
                        AndroidCapabilityResult.failure("Missing required argument: 'url'.")
                    } else {
                        adapter.openUrl(url)
                    }
                }

                AndroidCapabilities.OPEN_SETTINGS -> {
                    val settingType = args.optString("settingType").takeIf { it.isNotBlank() }
                        ?: args.optString("setting").takeIf { it.isNotBlank() }
                        ?: args.optString("type").takeIf { it.isNotBlank() }
                    adapter.openSettings(settingType)
                }

                AndroidCapabilities.SET_ALARM -> {
                    val hour = if (args.has("hour")) args.getInt("hour") else -1
                    val minutes = if (args.has("minutes")) args.getInt("minutes") else if (args.has("minute")) args.getInt("minute") else 0
                    val message = args.optString("message").takeIf { it.isNotBlank() }
                        ?: args.optString("label").takeIf { it.isNotBlank() }
                    val skipUi = args.optBoolean("skipUi", true)

                    if (hour < 0) {
                        AndroidCapabilityResult.failure("Missing or invalid required argument: 'hour' (0-23).")
                    } else {
                        adapter.setAlarm(hour, minutes, message, skipUi)
                    }
                }

                AndroidCapabilities.SET_TIMER -> {
                    val lengthSeconds = if (args.has("lengthSeconds")) {
                        args.getInt("lengthSeconds")
                    } else if (args.has("seconds")) {
                        args.getInt("seconds")
                    } else if (args.has("minutes")) {
                        args.getInt("minutes") * 60
                    } else {
                        -1
                    }
                    val message = args.optString("message").takeIf { it.isNotBlank() }
                        ?: args.optString("label").takeIf { it.isNotBlank() }
                    val skipUi = args.optBoolean("skipUi", true)

                    if (lengthSeconds <= 0) {
                        AndroidCapabilityResult.failure("Missing or invalid required argument: 'lengthSeconds' (must be > 0).")
                    } else {
                        adapter.setTimer(lengthSeconds, message, skipUi)
                    }
                }

                AndroidCapabilities.CREATE_REMINDER -> {
                    val title = args.optString("title").takeIf { it.isNotBlank() }
                        ?: args.optString("message").takeIf { it.isNotBlank() }
                        ?: args.optString("text").takeIf { it.isNotBlank() }
                    val notes = args.optString("notes").takeIf { it.isNotBlank() }
                        ?: args.optString("description").takeIf { it.isNotBlank() }
                    val timeMs = if (args.has("timeMs")) args.getLong("timeMs") else null

                    if (title == null) {
                        AndroidCapabilityResult.failure("Missing required argument: 'title'.")
                    } else {
                        adapter.createReminder(title, notes, timeMs)
                    }
                }

                AndroidCapabilities.CALENDAR -> {
                    val action = args.optString("action", "view")
                    val title = args.optString("title").takeIf { it.isNotBlank() }
                    val startTimeMs = if (args.has("startTimeMs")) args.getLong("startTimeMs") else null
                    val endTimeMs = if (args.has("endTimeMs")) args.getLong("endTimeMs") else null
                    val description = args.optString("description").takeIf { it.isNotBlank() }
                    adapter.calendar(action, title, startTimeMs, endTimeMs, description)
                }

                AndroidCapabilities.NOTIFICATIONS -> {
                    val action = args.optString("action", "post")
                    val title = args.optString("title").takeIf { it.isNotBlank() }
                    val message = args.optString("message").takeIf { it.isNotBlank() }
                        ?: args.optString("body").takeIf { it.isNotBlank() }
                    val notificationId = if (args.has("notificationId")) args.getInt("notificationId") else null
                    adapter.notifications(action, title, message, notificationId)
                }

                AndroidCapabilities.MEDIA_CONTROLS -> {
                    val action = args.optString("action").takeIf { it.isNotBlank() }
                        ?: if (args.has("volumeLevel") || args.has("level") || args.has("value")) "set_volume" else "play_pause"
                    val volumeLevel = if (args.has("volumeLevel")) {
                        args.getInt("volumeLevel")
                    } else if (args.has("level")) {
                        args.getInt("level")
                    } else if (args.has("value")) {
                        args.getInt("value")
                    } else null
                    adapter.mediaControls(action, volumeLevel)
                }

                AndroidCapabilities.CLIPBOARD -> {
                    val action = args.optString("action").takeIf { it.isNotBlank() } ?: "get"
                    val text = args.optString("text").takeIf { it.isNotBlank() }
                        ?: args.optString("content").takeIf { it.isNotBlank() }
                    adapter.clipboard(action, text)
                }

                AndroidCapabilities.DEVICE_STATUS -> {
                    val category = args.optString("category").takeIf { it.isNotBlank() }
                        ?: args.optString("type").takeIf { it.isNotBlank() }
                    adapter.deviceStatus(category)
                }

                AndroidCapabilities.OPEN_BROWSER -> {
                    val browserName = args.optString("browserName").takeIf { it.isNotBlank() }
                        ?: args.optString("browser").takeIf { it.isNotBlank() }
                    val url = args.optString("url").takeIf { it.isNotBlank() }
                        ?: args.optString("link").takeIf { it.isNotBlank() }
                    adapter.openBrowser(browserName, url)
                }

                AndroidCapabilities.SEARCH_WEB -> {
                    val query = args.optString("query").takeIf { it.isNotBlank() }
                        ?: args.optString("search").takeIf { it.isNotBlank() }
                        ?: args.optString("term").takeIf { it.isNotBlank() }
                        ?: args.optString("q").takeIf { it.isNotBlank() }
                    val engine = args.optString("engine").takeIf { it.isNotBlank() }
                        ?: args.optString("provider").takeIf { it.isNotBlank() }

                    if (query == null) {
                        AndroidCapabilityResult.failure("Missing required argument: 'query'.")
                    } else {
                        adapter.searchWeb(query, engine)
                    }
                }

                AndroidCapabilities.FIND_ON_PAGE -> {
                    val query = args.optString("query").takeIf { it.isNotBlank() }
                        ?: args.optString("text").takeIf { it.isNotBlank() }
                        ?: args.optString("term").takeIf { it.isNotBlank() }

                    if (query == null) {
                        AndroidCapabilityResult.failure("Missing required argument: 'query'.")
                    } else {
                        adapter.findOnPage(query)
                    }
                }

                AndroidCapabilities.NAVIGATE_BACK -> {
                    val steps = if (args.has("steps")) args.getInt("steps") else 1
                    adapter.navigateBack(steps)
                }

                AndroidCapabilities.NAVIGATE_FORWARD -> {
                    val steps = if (args.has("steps")) args.getInt("steps") else 1
                    adapter.navigateForward(steps)
                }

                AndroidCapabilities.INTERACT_APP -> {
                    // Phase 21 — Mobile App Interaction Layer
                    // Extract app name and action, delegate to AppCapabilityAdapter
                    val rawApp    = args.optString("app").takeIf { it.isNotBlank() }
                        ?: args.optString("appName").takeIf { it.isNotBlank() }
                        ?: args.optString("application").takeIf { it.isNotBlank() }
                    val rawAction = args.optString("action").takeIf { it.isNotBlank() }
                        ?: args.optString("operation").takeIf { it.isNotBlank() }
                        ?: "launch"

                    if (rawApp == null) {
                        AndroidCapabilityResult.failure("ARGUMENT_VIOLATION: Missing required argument 'app' for interactApp.")
                    } else {
                        // Convert JSONObject args to Map<String, Any?> for AppCapabilityAdapter
                        val argsMap = mutableMapOf<String, Any?>()
                        for (key in args.keys()) {
                            argsMap[key] = args.opt(key)
                        }
                        val appResult = appAdapter.interactApp(rawApp, rawAction, argsMap)
                        // Bridge AppInteractionResult to AndroidCapabilityResult
                        if (appResult.success) {
                            AndroidCapabilityResult.success(appResult.toMap())
                        } else {
                            AndroidCapabilityResult.failure(
                                appResult.error ?: "App interaction failed for '$rawApp/$rawAction'."
                            )
                        }
                    }
                }

                AndroidCapabilities.MOBILE_CONTEXT -> {
                    // Phase 22 — Mobile Context Intelligence
                    val catsSet = mutableSetOf<String>()
                    val catsJsonArray = args.optJSONArray("categories")
                    if (catsJsonArray != null) {
                        for (i in 0 until catsJsonArray.length()) {
                            val cat = catsJsonArray.optString(i)
                            if (cat.isNotBlank()) catsSet.add(cat.trim().lowercase())
                        }
                    }

                    val approvedScreen = args.optBoolean("approvedScreenContext", false)
                        || args.optBoolean("screenApproved", false)
                        || args.optBoolean("approveScreen", false)
                    val rawScreenText = if (args.has("screenSummary")) {
                        args.optString("screenSummary")
                    } else if (args.has("rawScreenText")) {
                        args.optString("rawScreenText")
                    } else {
                        null
                    }

                    val snapshot = contextAdapter.collectSnapshot(
                        categories = if (catsSet.isNotEmpty()) catsSet else null,
                        approvedScreenContext = approvedScreen,
                        rawScreenText = rawScreenText
                    )
                    AndroidCapabilityResult.success(snapshot.toMap())
                }

                AndroidCapabilities.MOBILE_SCREEN -> {
                    // Phase 23 — Mobile Screen Understanding
                    val approved = args.optBoolean("approved", false)
                        || args.optBoolean("approvedScreenContext", false)
                        || args.optBoolean("screenApproved", false)
                    val mode = args.optString("captureMode", "ocr")
                    val query = if (args.has("query")) args.optString("query") else null
                    val summary = if (args.has("screenSummary")) {
                        args.optString("screenSummary")
                    } else if (args.has("rawScreenText")) {
                        args.optString("rawScreenText")
                    } else {
                        null
                    }

                    val req = MobileScreenCaptureRequest(
                        approved = approved,
                        captureMode = mode,
                        query = query,
                        screenSummary = summary
                    )

                    val screenResult = screenAdapter.processScreenCapture(req)
                    if (screenResult.success) {
                        AndroidCapabilityResult.success(screenResult.toMap())
                    } else {
                        AndroidCapabilityResult.failure(
                            screenResult.error ?: "Screen understanding failed: ${screenResult.shieldReason ?: "UNKNOWN"}"
                        )
                    }
                }

                AndroidCapabilities.SHARED_MEMORY -> {
                    kotlinx.coroutines.runBlocking {
                        memoryAdapter.execute(args)
                    }
                }

                AndroidCapabilities.HANDOFF -> {
                    kotlinx.coroutines.runBlocking {
                        handoffAdapter.execute(args)
                    }
                }

                AndroidCapabilities.MOBILE_PROACTIVE -> {
                    proactiveAdapter.execute(args)
                }

                else -> {
                    AndroidCapabilityResult.failure("UNKNOWN_CAPABILITY: '$capabilityName' is not a registered Android native capability.")
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Exception during capability '$capabilityName' execution: ${e.message}", e)
            AndroidCapabilityResult.failure("Internal capability execution error: ${e.message}")
        }
    }

    fun getMemoryAdapter(): SharedMemoryAdapter = memoryAdapter
    fun getHandoffAdapter(): HandoffAdapter = handoffAdapter
    fun getMobileProactiveAdapter(): MobileProactiveAdapter = proactiveAdapter
}

