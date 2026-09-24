package com.myraa.companion.capabilities

import org.json.JSONObject

/**
 * Structured result of an Android capability execution.
 */
data class AndroidCapabilityResult(
    val success: Boolean,
    val result: Any? = null,
    val error: String? = null
) {
    fun toMap(): Map<String, Any?> {
        val map = mutableMapOf<String, Any?>("success" to success)
        if (result != null) map["result"] = result
        if (error != null) map["error"] = error
        return map
    }

    fun toJsonObject(): JSONObject {
        val json = JSONObject()
        json.put("success", success)
        if (result != null) {
            json.put("result", result)
        }
        if (error != null) {
            json.put("error", error)
        }
        return json
    }

    companion object {
        fun success(result: Any? = null): AndroidCapabilityResult =
            AndroidCapabilityResult(success = true, result = result)

        fun failure(error: String): AndroidCapabilityResult =
            AndroidCapabilityResult(success = false, error = error)
    }
}

/**
 * Canonical names and aliases for the 11 Phase 19 Native Android Capabilities.
 */
object AndroidCapabilities {
    const val OPEN_APP = "openApp"
    const val OPEN_URL = "openUrl"
    const val OPEN_SETTINGS = "openSettings"
    const val SET_ALARM = "setAlarm"
    const val SET_TIMER = "setTimer"
    const val CREATE_REMINDER = "createReminder"
    const val CALENDAR = "calendar"
    const val NOTIFICATIONS = "notifications"
    const val MEDIA_CONTROLS = "mediaControls"
    const val CLIPBOARD = "clipboard"
    const val DEVICE_STATUS = "deviceStatus"

    // Phase 20 — Browser Capabilities
    const val OPEN_BROWSER = "openBrowser"
    const val SEARCH_WEB = "searchWeb"
    const val FIND_ON_PAGE = "findOnPage"
    const val NAVIGATE_BACK = "navigateBack"
    const val NAVIGATE_FORWARD = "navigateForward"

    // Phase 21 — Mobile App Interaction Layer
    const val INTERACT_APP = "interactApp"

    // Phase 22 — Mobile Context Intelligence
    const val MOBILE_CONTEXT = "mobileContext"

    // Phase 23 — Mobile Screen Understanding
    const val MOBILE_SCREEN = "mobileScreen"

    // Phase 24 — Shared MYRAA Memory
    const val SHARED_MEMORY = "sharedMemory"

    // Phase 25 — Cross-Device Handoff
    const val HANDOFF = "handoff"

    // Phase 26 — Mobile Proactive Companion
    const val MOBILE_PROACTIVE = "mobileProactive"

    val BROWSER_CAPABILITIES = setOf(
        OPEN_BROWSER,
        SEARCH_WEB,
        OPEN_URL,
        FIND_ON_PAGE,
        NAVIGATE_BACK,
        NAVIGATE_FORWARD
    )

    val ALL_CAPABILITIES = setOf(
        OPEN_APP,
        OPEN_URL,
        OPEN_SETTINGS,
        SET_ALARM,
        SET_TIMER,
        CREATE_REMINDER,
        CALENDAR,
        NOTIFICATIONS,
        MEDIA_CONTROLS,
        CLIPBOARD,
        DEVICE_STATUS,
        OPEN_BROWSER,
        SEARCH_WEB,
        FIND_ON_PAGE,
        NAVIGATE_BACK,
        NAVIGATE_FORWARD,
        // Phase 21
        INTERACT_APP,
        // Phase 22
        MOBILE_CONTEXT,
        // Phase 23
        MOBILE_SCREEN,
        // Phase 24
        SHARED_MEMORY,
        // Phase 25
        HANDOFF,
        // Phase 26
        MOBILE_PROACTIVE
    )

    /**
     * Maps desktop tools from the 126-tool registry to Android native capabilities
     * when executed in an Android companion session.
     */
    fun resolveCanonicalCapability(name: String): String {
        return when (name) {
            "openApplication" -> OPEN_APP
            "openWebsite" -> OPEN_URL
            "openBrowser", "desktopBrowserOpen" -> OPEN_BROWSER
            "searchWeb", "browserSearch", "searchGoogle", "desktopBrowserSearch" -> SEARCH_WEB
            "desktopBrowserNavigate", "browserOpen" -> OPEN_URL
            "findOnPage" -> FIND_ON_PAGE
            "navigateBack", "browserGoBack", "desktopBrowserGoBack" -> NAVIGATE_BACK
            "navigateForward", "desktopBrowserGoForward" -> NAVIGATE_FORWARD
            "systemInfo", "gpuInfo", "temperatureInfo" -> DEVICE_STATUS
            "setVolume", "volumeUp", "volumeDown", "muteToggle", "browserMediaControl" -> MEDIA_CONTROLS
            "getClipboard", "pasteClipboard", "copySelected", "clearClipboard" -> CLIPBOARD
            // Phase 21 — Mobile App Interaction Layer
            "interactApp", "appInteraction", "interactWithApp", "mobileAppAction",
            "openAppAction", "appAction" -> INTERACT_APP
            // Phase 22 — Mobile Context Intelligence
            "mobileContext", "getContextSnapshot", "getMobileContext", "deviceContext",
            "activeMobileContext" -> MOBILE_CONTEXT
            // Phase 23 — Mobile Screen Understanding
            "mobileScreen", "screenUnderstanding", "captureMobileScreen", "readMobileScreen",
            "understandScreen", "screenCapture" -> MOBILE_SCREEN
            // Phase 24 — Shared MYRAA Memory
            "sharedMemory", "memorySync", "syncMemory", "getSharedMemory", "saveSharedMemory" -> SHARED_MEMORY
            // Phase 25 — Cross-Device Handoff
            "handoff", "crossDeviceHandoff", "deviceHandoff", "resumeHandoff", "createHandoff" -> HANDOFF
            // Phase 26 — Mobile Proactive Companion
            "mobileProactive", "proactiveNotification", "notifyMobile", "dispatchProactiveNotification" -> MOBILE_PROACTIVE
            else -> name
        }
    }
}
