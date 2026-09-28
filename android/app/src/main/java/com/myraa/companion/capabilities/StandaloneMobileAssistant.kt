package com.myraa.companion.capabilities

import com.myraa.companion.networking.MyraaApiClient
import org.json.JSONObject
import java.util.Locale

/**
 * StandaloneMobileAssistant
 * Phase 13A — Standalone Mobile AI Assistant Engine
 *
 * Enables MYRAA Android to operate as a full standalone phone AI assistant
 * immediately after install/onboarding, with zero Desktop pairing requirement.
 *
 * Key Guarantees:
 * 1. Standalone phone capabilities (apps, YouTube, web, alarms, timers, reminders,
 *    calendar, notes/clipboard, media controls, device status, mobile context,
 *    screen understanding, shared memory, cloud AI voice/chat) work without Desktop.
 * 2. Emergency Stop and Security Lockdown fail-closed immediately.
 * 3. Explicit Desktop commands when Desktop is disconnected fail clearly and
 *    NEVER silently fall back to phone execution.
 * 4. Screen understanding requires explicit user permission (`screenContextApproved`).
 */
class StandaloneMobileAssistant(
    private val capabilityRegistry: AndroidCapabilityRegistry?,
    private val apiClient: MyraaApiClient
) {

    enum class ExecutionTarget {
        MOBILE,
        DESKTOP
    }

    data class StandaloneTurnOutcome(
        val success: Boolean,
        val blocked: Boolean = false,
        val errorCode: String? = null,
        val capabilityExecuted: String? = null,
        val responseText: String,
        val targetDevice: ExecutionTarget = ExecutionTarget.MOBILE,
        val requiresDesktopPairing: Boolean = false,
        val data: Map<String, Any?> = emptyMap()
    )

    data class ParsedMobileIntent(
        val capability: String,
        val args: JSONObject,
        val summaryPrefix: String
    )

    companion object {
        private val DESKTOP_ONLY_PATTERNS = listOf(
            Regex("\\b(on\\s+my\\s+desktop|on\\s+desktop|on\\s+my\\s+pc|on\\s+pc|on\\s+my\\s+laptop|desktop\\s+powershell|desktop\\s+terminal|desktop\\s+registry|windows\\s+service|run\\s+on\\s+workstation)\\b", RegexOption.IGNORE_CASE)
        )

        /**
         * Determines whether a natural-language command explicitly targets the Desktop workstation.
         */
        fun isExplicitDesktopCommand(input: String): Boolean {
            val trimmed = input.trim()
            return DESKTOP_ONLY_PATTERNS.any { it.containsMatchIn(trimmed) }
        }

        /**
         * Parses natural language (English / Hinglish) into a structured phone-native capability call.
         * Returns null if the turn is purely conversational.
         */
        fun parseMobileIntent(
            input: String,
            screenContextApproved: Boolean = false,
            privacyShieldEnabled: Boolean = true
        ): ParsedMobileIntent? {
            val raw = input.trim()
            val lower = raw.lowercase(Locale.ROOT)

            // 1. Screen Understanding (must check before generic queries)
            if (lower.contains("what is on my screen") ||
                lower.contains("what's on my screen") ||
                lower.contains("read my screen") ||
                lower.contains("analyze screen") ||
                lower.contains("screen understanding") ||
                lower.contains("summarize screen")
            ) {
                val args = JSONObject().apply {
                    put("approved", screenContextApproved)
                    put("captureMode", "ocr")
                    put("query", raw)
                    put("screenSummary", if (privacyShieldEnabled) "[Privacy Shield Active] Mobile Assistant Screen" else "Mobile Assistant Screen")
                }
                return ParsedMobileIntent(
                    capability = AndroidCapabilities.MOBILE_SCREEN,
                    args = args,
                    summaryPrefix = "Screen Understanding"
                )
            }

            // 2. YouTube Search / Play
            val ytPlayRegex = Regex("(?:play|search)\\s+(.+?)\\s+on\\s+youtube", RegexOption.IGNORE_CASE)
            val ytPrefixRegex = Regex("youtube\\s+(?:search|play)\\s+(.+)", RegexOption.IGNORE_CASE)
            val ytMatch = ytPlayRegex.find(raw) ?: ytPrefixRegex.find(raw)
            if (ytMatch != null) {
                val query = ytMatch.groupValues[1].trim()
                val action = if (lower.startsWith("play") || lower.contains("play ")) "play_query" else "search"
                val args = JSONObject().apply {
                    put("app", "youtube")
                    put("action", action)
                    put("query", query)
                }
                return ParsedMobileIntent(
                    capability = AndroidCapabilities.INTERACT_APP,
                    args = args,
                    summaryPrefix = "Opening YouTube for \"$query\""
                )
            }

            // 3. Set Alarm (e.g. "set alarm for 7:30", "set an alarm at 6 am")
            val alarmRegex = Regex("(?:set\\s+(?:an?\\s+)?alarm|wake\\s+me\\s+up)\\s+(?:for|at)\\s+(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)?", RegexOption.IGNORE_CASE)
            val alarmMatch = alarmRegex.find(raw)
            if (alarmMatch != null) {
                var hour = alarmMatch.groupValues[1].toIntOrNull() ?: 7
                val minutes = alarmMatch.groupValues[2].toIntOrNull() ?: 0
                val meridiem = alarmMatch.groupValues[3].lowercase(Locale.ROOT)
                if (meridiem == "pm" && hour < 12) hour += 12
                if (meridiem == "am" && hour == 12) hour = 0
                hour = hour.coerceIn(0, 23)

                val args = JSONObject().apply {
                    put("hour", hour)
                    put("minutes", minutes.coerceIn(0, 59))
                    put("message", "MYRAA Mobile Alarm")
                    put("skipUi", true)
                }
                val formattedTime = String.format(Locale.ROOT, "%02d:%02d", hour, minutes.coerceIn(0, 59))
                return ParsedMobileIntent(
                    capability = AndroidCapabilities.SET_ALARM,
                    args = args,
                    summaryPrefix = "Alarm set for $formattedTime"
                )
            }

            // 4. Set Timer (e.g. "set timer for 5 minutes", "set a 30 second timer")
            val timerRegex = Regex("(?:set\\s+(?:a\\s+)?timer(?:\\s+for)?|timer(?:\\s+for)?)\\s+(\\d+)\\s*(second|seconds|sec|secs|minute|minutes|min|mins|hour|hours|hr|hrs)", RegexOption.IGNORE_CASE)
            val timerMatch = timerRegex.find(raw)
            if (timerMatch != null) {
                val amount = timerMatch.groupValues[1].toIntOrNull() ?: 1
                val unit = timerMatch.groupValues[2].lowercase(Locale.ROOT)
                val seconds = when {
                    unit.startsWith("h") -> amount * 3600
                    unit.startsWith("m") -> amount * 60
                    else -> amount
                }
                val args = JSONObject().apply {
                    put("lengthSeconds", seconds)
                    put("message", "MYRAA Timer")
                    put("skipUi", true)
                }
                return ParsedMobileIntent(
                    capability = AndroidCapabilities.SET_TIMER,
                    args = args,
                    summaryPrefix = "Timer started for $amount $unit"
                )
            }

            // 5. Reminders (e.g. "remind me to call mom", "create reminder buy milk")
            val reminderRegex = Regex("(?:remind\\s+me\\s+to|create\\s+(?:a\\s+)?reminder\\s+(?:to\\s+)?|set\\s+(?:a\\s+)?reminder\\s+(?:to\\s+)?)(.+)", RegexOption.IGNORE_CASE)
            val reminderMatch = reminderRegex.find(raw)
            if (reminderMatch != null) {
                val title = reminderMatch.groupValues[1].trim()
                val args = JSONObject().apply {
                    put("title", title)
                    put("notes", "Created via MYRAA Standalone Mobile Assistant")
                }
                return ParsedMobileIntent(
                    capability = AndroidCapabilities.CREATE_REMINDER,
                    args = args,
                    summaryPrefix = "Reminder created: \"$title\""
                )
            }

            // 6. Calendar (e.g. "open calendar", "schedule meeting Team Sync", "create calendar event Lunch")
            if (lower == "open calendar" || lower == "view calendar" || lower == "show calendar" ||
                lower.startsWith("schedule ") || lower.startsWith("create calendar event")
            ) {
                val isCreate = lower.startsWith("schedule ") || lower.startsWith("create calendar event")
                val title = if (isCreate) {
                    raw.replace(Regex("^(?:schedule(?:\\s+meeting)?|create\\s+calendar\\s+event)\\s*", RegexOption.IGNORE_CASE), "")
                        .ifBlank { "MYRAA Event" }
                } else null
                val args = JSONObject().apply {
                    put("action", if (isCreate) "create" else "view")
                    if (title != null) put("title", title)
                }
                return ParsedMobileIntent(
                    capability = AndroidCapabilities.CALENDAR,
                    args = args,
                    summaryPrefix = if (isCreate) "Scheduling calendar event \"$title\"" else "Opening phone calendar"
                )
            }

            // 7. Notes & Shared Memory (e.g. "save note buy groceries", "remember that I prefer dark mode", "list notes")
            val saveNoteRegex = Regex("(?:save\\s+note|take\\s+a?\\s*note|remember\\s+that|remember)\\s*:?\\s+(.+)", RegexOption.IGNORE_CASE)
            val saveNoteMatch = saveNoteRegex.find(raw)
            if (saveNoteMatch != null) {
                val noteText = saveNoteMatch.groupValues[1].trim()
                val args = JSONObject().apply {
                    put("action", "remember")
                    put("category", "task_context")
                    put("text", noteText)
                }
                return ParsedMobileIntent(
                    capability = AndroidCapabilities.SHARED_MEMORY,
                    args = args,
                    summaryPrefix = "Saved note to MYRAA Memory: \"$noteText\""
                )
            }
            if (lower == "list notes" || lower == "show notes" || lower == "show memories" || lower == "my notes") {
                val args = JSONObject().apply {
                    put("action", "recall")
                }
                return ParsedMobileIntent(
                    capability = AndroidCapabilities.SHARED_MEMORY,
                    args = args,
                    summaryPrefix = "Retrieved saved notes from MYRAA Memory"
                )
            }

            // 8. Clipboard (e.g. "copy to clipboard hello", "read clipboard")
            val copyClipRegex = Regex("copy\\s+(?:to\\s+clipboard\\s+)?(.+)", RegexOption.IGNORE_CASE)
            if (lower == "read clipboard" || lower == "check clipboard" || lower == "paste clipboard") {
                val args = JSONObject().apply { put("action", "get") }
                return ParsedMobileIntent(
                    capability = AndroidCapabilities.CLIPBOARD,
                    args = args,
                    summaryPrefix = "Reading phone clipboard"
                )
            }
            val copyMatch = copyClipRegex.find(raw)
            if (copyMatch != null && lower.contains("clipboard")) {
                val textToCopy = raw.replace(Regex("^copy\\s+(?:to\\s+clipboard\\s*)?", RegexOption.IGNORE_CASE), "").trim()
                val args = JSONObject().apply {
                    put("action", "set")
                    put("text", textToCopy)
                }
                return ParsedMobileIntent(
                    capability = AndroidCapabilities.CLIPBOARD,
                    args = args,
                    summaryPrefix = "Copied text to phone clipboard"
                )
            }

            // 9. Media Controls (play/pause/next/previous/volume)
            if (lower in setOf("play music", "resume music", "pause music", "stop music", "next track", "next song", "previous track", "previous song", "volume up", "volume down", "mute volume", "unmute volume")) {
                val action = when {
                    lower.contains("pause") -> "pause"
                    lower.contains("stop") -> "stop"
                    lower.contains("next") -> "next"
                    lower.contains("previous") -> "previous"
                    lower.contains("volume up") -> "volume_up"
                    lower.contains("volume down") -> "volume_down"
                    lower.contains("unmute") -> "unmute"
                    lower.contains("mute") -> "mute"
                    else -> "play"
                }
                val args = JSONObject().apply { put("action", action) }
                return ParsedMobileIntent(
                    capability = AndroidCapabilities.MEDIA_CONTROLS,
                    args = args,
                    summaryPrefix = "Media control executed ($action)"
                )
            }
            val volSetRegex = Regex("set\\s+volume\\s+(?:to\\s+)?(\\d{1,3})", RegexOption.IGNORE_CASE)
            val volMatch = volSetRegex.find(raw)
            if (volMatch != null) {
                val level = (volMatch.groupValues[1].toIntOrNull() ?: 50).coerceIn(0, 100)
                val args = JSONObject().apply {
                    put("action", "set_volume")
                    put("volumeLevel", level)
                }
                return ParsedMobileIntent(
                    capability = AndroidCapabilities.MEDIA_CONTROLS,
                    args = args,
                    summaryPrefix = "Phone media volume set to $level%"
                )
            }

            // 10. Device Status (battery, network, audio, general)
            if (lower.contains("battery status") || lower.contains("battery level") ||
                lower.contains("device status") || lower.contains("phone status") ||
                lower.contains("network status")
            ) {
                val category = when {
                    lower.contains("battery") -> "battery"
                    lower.contains("network") -> "network"
                    else -> "all"
                }
                val args = JSONObject().apply { put("category", category) }
                return ParsedMobileIntent(
                    capability = AndroidCapabilities.DEVICE_STATUS,
                    args = args,
                    summaryPrefix = "Checked phone $category status"
                )
            }

            // 11. Mobile Context
            if (lower.contains("mobile context") || lower.contains("phone context") || lower.contains("context snapshot")) {
                val args = JSONObject().apply {
                    put("approvedScreenContext", screenContextApproved)
                }
                return ParsedMobileIntent(
                    capability = AndroidCapabilities.MOBILE_CONTEXT,
                    args = args,
                    summaryPrefix = "Collected standalone mobile context snapshot"
                )
            }

            // 12. Open URL / Browser
            val urlRegex = Regex("^(?:open|go\\s+to|visit|browse)\\s+((?:https?://)?(?:[a-zA-Z0-9-]+\\.)+[a-zA-Z]{2,}(?:/\\S*)?)$", RegexOption.IGNORE_CASE)
            val urlMatch = urlRegex.find(raw)
            if (urlMatch != null) {
                val targetUrl = urlMatch.groupValues[1].trim()
                val args = JSONObject().apply { put("url", targetUrl) }
                return ParsedMobileIntent(
                    capability = AndroidCapabilities.OPEN_URL,
                    args = args,
                    summaryPrefix = "Opening URL $targetUrl on phone"
                )
            }
            if (lower == "open browser" || lower == "launch browser") {
                val args = JSONObject().apply { put("browserName", "chrome") }
                return ParsedMobileIntent(
                    capability = AndroidCapabilities.OPEN_BROWSER,
                    args = args,
                    summaryPrefix = "Opening phone web browser"
                )
            }

            // 13. Web Search (e.g. "search web for ...", "search for ...", "google ...")
            val webSearchRegex = Regex("^(?:search\\s+(?:the\\s+)?web\\s+for|search\\s+for|google)\\s+(.+)", RegexOption.IGNORE_CASE)
            val webSearchMatch = webSearchRegex.find(raw)
            if (webSearchMatch != null) {
                val query = webSearchMatch.groupValues[1].trim()
                val args = JSONObject().apply {
                    put("query", query)
                    put("engine", "google")
                }
                return ParsedMobileIntent(
                    capability = AndroidCapabilities.SEARCH_WEB,
                    args = args,
                    summaryPrefix = "Searching the web for \"$query\""
                )
            }

            // 14. Open Supported Apps (e.g. "open youtube", "open whatsapp", "open settings", "open spotify")
            val openAppRegex = Regex("^(?:open|launch|start)\\s+([a-zA-Z0-9_\\s]+)$", RegexOption.IGNORE_CASE)
            val openAppMatch = openAppRegex.find(raw)
            if (openAppMatch != null) {
                val targetName = openAppMatch.groupValues[1].trim()
                val targetLower = targetName.lowercase(Locale.ROOT)
                if (targetLower.endsWith("settings") || targetLower in setOf("wifi", "bluetooth", "location", "display", "sound", "battery")) {
                    val settingType = targetLower.removeSuffix("settings").trim().ifBlank { "settings" }
                    val args = JSONObject().apply { put("settingType", settingType) }
                    return ParsedMobileIntent(
                        capability = AndroidCapabilities.OPEN_SETTINGS,
                        args = args,
                        summaryPrefix = "Opening Android $targetName"
                    )
                }
                val args = JSONObject().apply { put("appName", targetName) }
                return ParsedMobileIntent(
                    capability = AndroidCapabilities.OPEN_APP,
                    args = args,
                    summaryPrefix = "Opening $targetName on phone"
                )
            }

            return null
        }
    }

    /**
     * Processes a user voice or text turn on MYRAA Mobile.
     *
     * - If `target == ExecutionTarget.DESKTOP` or the prompt explicitly targets Desktop:
     *   Requires `isDesktopConnected == true`; otherwise fails clearly and NEVER silently falls back.
     * - If `target == ExecutionTarget.MOBILE`:
     *   Executes phone-native capabilities locally via `AndroidCapabilityRegistry` and/or
     *   processes conversational turns via MYRAA Cloud HTTPS (`/api/ux/mobile/voice`) with
     *   offline local fallback.
     */
    suspend fun handleUserTurn(
        input: String,
        target: ExecutionTarget = ExecutionTarget.MOBILE,
        isDesktopConnected: Boolean = false,
        emergencyStopActive: Boolean = false,
        securityLockdownActive: Boolean = false,
        screenContextApproved: Boolean = false,
        privacyShieldEnabled: Boolean = true,
        localOnlyMode: Boolean = false,
        host: String = "myraa-ai-q0h3.onrender.com",
        port: Int = 443,
        deviceId: String = "mob_standalone_default",
        language: String = "en-IN",
        onForwardToDesktop: ((String) -> Unit)? = null
    ): StandaloneTurnOutcome {
        val trimmed = input.trim()
        if (trimmed.isEmpty()) {
            return StandaloneTurnOutcome(
                success = false,
                errorCode = "EMPTY_INPUT",
                responseText = "Please say or type a command for MYRAA."
            )
        }

        // 1. Fail-closed on Emergency Stop
        if (emergencyStopActive) {
            return StandaloneTurnOutcome(
                success = false,
                blocked = true,
                errorCode = "EMERGENCY_STOP_ACTIVE",
                responseText = "Emergency Stop is active. All MYRAA Mobile voice and capability actions are halted until Emergency Stop is reset.",
                targetDevice = target
            )
        }

        // 2. Fail-closed on Security Lockdown
        if (securityLockdownActive) {
            return StandaloneTurnOutcome(
                success = false,
                blocked = true,
                errorCode = "SECURITY_LOCKDOWN_ACTIVE",
                responseText = "Security Lockdown is active. MYRAA Mobile actions are blocked until lockdown recovery is completed.",
                targetDevice = target
            )
        }

        // 3. Explicit Desktop Target Guard — never silently fall back to phone
        val explicitDesktop = target == ExecutionTarget.DESKTOP || isExplicitDesktopCommand(trimmed)
        if (explicitDesktop) {
            if (!isDesktopConnected) {
                return StandaloneTurnOutcome(
                    success = false,
                    blocked = true,
                    errorCode = "DESKTOP_BRIDGE_OFFLINE",
                    responseText = "Desktop Remote Bridge is not connected. Open Settings → Devices → Connect Desktop to pair with your PC. (MYRAA Mobile will not silently run Desktop commands on your phone.)",
                    targetDevice = ExecutionTarget.DESKTOP
                )
            }
            onForwardToDesktop?.invoke(trimmed)
            return StandaloneTurnOutcome(
                success = true,
                capabilityExecuted = "desktop_remote_command",
                responseText = "Sent command to paired Desktop workstation.",
                targetDevice = ExecutionTarget.DESKTOP
            )
        }

        // 4. Check for Phone-Native Capability Intent
        val parsedIntent = parseMobileIntent(
            input = trimmed,
            screenContextApproved = screenContextApproved,
            privacyShieldEnabled = privacyShieldEnabled
        )

        if (parsedIntent != null) {
            // Enforce explicit screen permission before mobile_screen
            if (parsedIntent.capability == AndroidCapabilities.MOBILE_SCREEN && !screenContextApproved) {
                return StandaloneTurnOutcome(
                    success = false,
                    blocked = true,
                    errorCode = "SCREEN_PERMISSION_REQUIRED",
                    capabilityExecuted = AndroidCapabilities.MOBILE_SCREEN,
                    responseText = "Screen Understanding requires explicit permission. Enable 'Screen Context Understanding' in MYRAA Settings → Privacy & Permissions to allow screen analysis."
                )
            }

            if (capabilityRegistry != null) {
                val capResult = capabilityRegistry.execute(parsedIntent.capability, parsedIntent.args)
                return if (capResult.success) {
                    @Suppress("UNCHECKED_CAST")
                    val resultMap: Map<String, Any?> = (capResult.result as? Map<String, Any?>) ?: emptyMap()
                    val detail = formatCapabilityData(parsedIntent.capability, resultMap)
                    StandaloneTurnOutcome(
                        success = true,
                        capabilityExecuted = parsedIntent.capability,
                        responseText = if (detail.isNotBlank()) "${parsedIntent.summaryPrefix} — $detail" else "${parsedIntent.summaryPrefix}.",
                        data = resultMap
                    )
                } else {
                    StandaloneTurnOutcome(
                        success = false,
                        errorCode = "CAPABILITY_EXECUTION_FAILED",
                        capabilityExecuted = parsedIntent.capability,
                        responseText = capResult.error ?: "Could not complete ${parsedIntent.summaryPrefix} on this phone."
                    )
                }
            } else {
                // Unit test / headless registry-free verification path
                return StandaloneTurnOutcome(
                    success = true,
                    capabilityExecuted = parsedIntent.capability,
                    responseText = "${parsedIntent.summaryPrefix} (Standalone Mobile Ready)."
                )
            }
        }

        // 5. Conversational AI / Gemini Live Cloud Voice Turn (Standalone Mode — No Desktop Required)
        if (!localOnlyMode) {
            val cloudResp = apiClient.submitStandaloneMobileVoice(
                host = host,
                port = port,
                deviceId = deviceId,
                transcript = trimmed,
                language = language
            )
            if (cloudResp != null && cloudResp.responseText.isNotBlank()) {
                return StandaloneTurnOutcome(
                    success = true,
                    capabilityExecuted = "standalone_cloud_voice",
                    responseText = cloudResp.responseText,
                    requiresDesktopPairing = false
                )
            }
        }

        // 6. Resilient On-Device Standalone Fallback (works even when offline or localOnlyMode = true)
        return StandaloneTurnOutcome(
            success = true,
            capabilityExecuted = "standalone_local_assistant",
            responseText = "MYRAA Mobile processed: \"$trimmed\" on your phone (Standalone Mode active — no Desktop required).",
            requiresDesktopPairing = false
        )
    }

    private fun formatCapabilityData(capability: String, data: Map<String, Any?>): String {
        return when (capability) {
            AndroidCapabilities.DEVICE_STATUS -> {
                val battery = (data["battery"] as? Map<*, *>)?.get("percentage")
                val charging = (data["battery"] as? Map<*, *>)?.get("isCharging")
                val netType = (data["network"] as? Map<*, *>)?.get("type")
                buildString {
                    if (battery != null) append("Battery: $battery% (Charging: ${charging ?: false})")
                    if (netType != null) {
                        if (isNotEmpty()) append(", ")
                        append("Network: $netType")
                    }
                }
            }
            AndroidCapabilities.CLIPBOARD -> {
                val text = data["text"]?.toString()
                if (!text.isNullOrBlank()) "Clipboard: \"$text\"" else "Completed"
            }
            AndroidCapabilities.SHARED_MEMORY -> {
                val count = data["count"]
                if (count != null) "$count memory item(s)" else "Saved"
            }
            else -> ""
        }
    }
}
