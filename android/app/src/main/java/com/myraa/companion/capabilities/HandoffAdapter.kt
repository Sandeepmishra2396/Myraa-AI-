package com.myraa.companion.capabilities

import android.content.Context
import android.util.Log
import org.json.JSONObject
import java.util.UUID

/**
 * HandoffAdapter
 * Phase 25 — Cross-Device Handoff
 *
 * Android capability handler for Cross-Device Handoff operations:
 * - Sanitizes outgoing context to prevent DLP/secret leaks.
 * - Manages local active handoffs cache.
 * - Handles create, list, get, accept, resume, and cancel capability commands.
 */
class HandoffAdapter(
    private val context: Context
) {
    companion object {
        private const val TAG = "HandoffAdapter"
    }

    // In-memory cache of active handoffs
    private val _cachedHandoffs = mutableListOf<HandoffSnapshotItem>()

    fun updateCache(handoffs: List<HandoffSnapshotItem>) {
        synchronized(_cachedHandoffs) {
            _cachedHandoffs.clear()
            _cachedHandoffs.addAll(handoffs)
        }
        Log.i(TAG, "Updated local handoff cache: ${_cachedHandoffs.size} handoffs.")
    }

    fun getCachedHandoffs(): List<HandoffSnapshotItem> {
        synchronized(_cachedHandoffs) {
            return _cachedHandoffs.toList()
        }
    }

    /**
     * Executes a cross-device handoff capability call from MYRAA Core or local UI.
     */
    suspend fun execute(args: JSONObject): AndroidCapabilityResult {
        val action = args.optString("action", "list").lowercase()

        return try {
            when (action) {
                "create" -> {
                    val targetDeviceId = args.optString("targetDeviceId").takeIf { it.isNotBlank() }
                    val convContext = args.optJSONObject("conversationContext")
                    val taskContext = args.optJSONObject("taskPlanState")
                    val projContext = args.optJSONObject("projectContext")

                    val summary = convContext?.optString("summary")?.takeIf { it.isNotEmpty() }
                    val lastQuery = convContext?.optString("lastUserQuery")?.takeIf { it.isNotEmpty() }
                    val goal = taskContext?.optString("goal")?.takeIf { it.isNotEmpty() }
                    val projectName = projContext?.optString("projectName")?.takeIf { it.isNotEmpty() }

                    // Local DLP check
                    val textToScreen = listOfNotNull(summary, lastQuery, goal, projectName).joinToString(" ")
                    if (containsCredentials(textToScreen)) {
                        return AndroidCapabilityResult.failure("DLP_SECRET_REJECTED: Sensitive credentials or tokens cannot be included in handoff.")
                    }

                    val handoffId = "handoff_${UUID.randomUUID()}"
                    val handoffToken = "handoff_tok_${UUID.randomUUID()}"

                    val item = HandoffSnapshotItem(
                        handoffId = handoffId,
                        handoffToken = handoffToken,
                        status = "pending",
                        sourceDeviceId = "android_device",
                        sourceDeviceType = "android",
                        targetDeviceId = targetDeviceId,
                        conversationSummary = summary,
                        lastUserQuery = lastQuery,
                        taskPlanGoal = goal,
                        projectName = projectName,
                        createdAt = System.currentTimeMillis().toString(),
                        expiresAt = (System.currentTimeMillis() + 600_000).toString(),
                        version = 1
                    )

                    synchronized(_cachedHandoffs) {
                        _cachedHandoffs.add(item)
                    }

                    AndroidCapabilityResult.success(
                        HandoffResult.success("create", handoff = item).toJsonObject()
                    )
                }

                "list" -> {
                    synchronized(_cachedHandoffs) {
                        AndroidCapabilityResult.success(
                            HandoffResult.success("list", handoffs = _cachedHandoffs.toList()).toJsonObject()
                        )
                    }
                }

                "get" -> {
                    val id = args.optString("handoffId", "")
                    synchronized(_cachedHandoffs) {
                        val match = _cachedHandoffs.find { it.handoffId == id }
                        if (match != null) {
                            AndroidCapabilityResult.success(
                                HandoffResult.success("get", handoff = match).toJsonObject()
                            )
                        } else {
                            AndroidCapabilityResult.failure("Handoff '$id' not found in local cache.")
                        }
                    }
                }

                "accept" -> {
                    val id = args.optString("handoffId", "")
                    val token = args.optString("handoffToken", "")
                    synchronized(_cachedHandoffs) {
                        val match = _cachedHandoffs.find { it.handoffId == id }
                        if (match == null) {
                            return AndroidCapabilityResult.failure("Handoff '$id' not found.")
                        }
                        if (match.handoffToken != token) {
                            return AndroidCapabilityResult.failure("INVALID_TOKEN: Handoff token mismatch.")
                        }
                        if (match.status == "accepted") {
                            return AndroidCapabilityResult.failure("ALREADY_ACCEPTED: Handoff already accepted.")
                        }
                        val updated = match.copy(status = "accepted", version = match.version + 1)
                        val idx = _cachedHandoffs.indexOf(match)
                        _cachedHandoffs[idx] = updated
                        AndroidCapabilityResult.success(
                            HandoffResult.success("accept", handoff = updated).toJsonObject()
                        )
                    }
                }

                "resume" -> {
                    val id = args.optString("handoffId", "")
                    val token = args.optString("handoffToken", "")
                    synchronized(_cachedHandoffs) {
                        val match = _cachedHandoffs.find { it.handoffId == id }
                        if (match == null) {
                            return AndroidCapabilityResult.failure("Handoff '$id' not found.")
                        }
                        if (match.handoffToken != token) {
                            return AndroidCapabilityResult.failure("INVALID_TOKEN: Handoff token mismatch.")
                        }
                        val updated = match.copy(status = "resumed", version = match.version + 1)
                        val idx = _cachedHandoffs.indexOf(match)
                        _cachedHandoffs[idx] = updated

                        AndroidCapabilityResult.success(
                            HandoffResult.success("resume", handoff = updated).toJsonObject()
                        )
                    }
                }

                "cancel" -> {
                    val id = args.optString("handoffId", "")
                    synchronized(_cachedHandoffs) {
                        val match = _cachedHandoffs.find { it.handoffId == id }
                        if (match == null) {
                            return AndroidCapabilityResult.failure("Handoff '$id' not found.")
                        }
                        val updated = match.copy(status = "cancelled", version = match.version + 1)
                        val idx = _cachedHandoffs.indexOf(match)
                        _cachedHandoffs[idx] = updated
                        AndroidCapabilityResult.success(
                            HandoffResult.success("cancel", handoff = updated).toJsonObject()
                        )
                    }
                }

                else -> {
                    AndroidCapabilityResult.failure("Unsupported handoff action: '$action'.")
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error executing handoff capability: ${e.message}", e)
            AndroidCapabilityResult.failure("Handoff execution failed: ${e.message}")
        }
    }

    private fun containsCredentials(text: String): Boolean {
        if (text.isBlank()) return false
        val patterns = listOf(
            Regex("\\b(?:sora_dev_|myraa_at_)[0-9A-Za-z_\\-]{16,}\\b", RegexOption.IGNORE_CASE),
            Regex("\\bAIza[0-9A-Za-z_\\-]{20,}\\b"),
            Regex("\\bsk-[0-9A-Za-z_\\-]{20,}\\b"),
            Regex("\\bBearer\\s+[A-Za-z0-9\\-_.~+/]+=*\\b", RegexOption.IGNORE_CASE),
            Regex("-----BEGIN(?:\\s+[A-Z]+)?\\s+PRIVATE KEY-----"),
            Regex("\\b(?:password|passwd|pwd|secret)\\s*[:=]\\s*[^\\s,;]{6,}\\b", RegexOption.IGNORE_CASE),
            Regex("\\b(?:\\d{4}[- ]?){3}\\d{4}\\b"),
            Regex("\\b(?:otp(?:\\s+code)?|one[- ]time[- ]password|verification(?:\\s*code)?|auth(?:\\s*code)?|pin)\\s*(?:is|:|=)?\\s*\\d{4,8}\\b", RegexOption.IGNORE_CASE)
        )
        return patterns.any { it.containsMatchIn(text) }
    }
}
