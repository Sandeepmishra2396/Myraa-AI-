package com.myraa.companion.capabilities

import android.content.Context
import android.util.Log
import org.json.JSONObject
import java.util.UUID

/**
 * SharedMemoryAdapter
 * Phase 24 — Shared MYRAA Memory
 *
 * Android-side capability adapter for Shared Memory operations:
 * - Sanitizes outgoing text via MobileContextSanitizer (preventing password/OTP leaks).
 * - Handles 'get', 'create', 'update', 'delete', 'search', 'sync' capability requests.
 * - Enqueues mutations to SharedMemoryQueue when offline for deterministic batch sync.
 */
class SharedMemoryAdapter(
    private val context: Context,
    private val memoryQueue: SharedMemoryQueue = SharedMemoryQueue()
) {
    companion object {
        private const val TAG = "SharedMemoryAdapter"
    }

    // In-memory cache of latest server-synced memories
    private val _cachedMemories = mutableListOf<SharedMemoryItem>()

    fun updateCache(memories: List<SharedMemoryItem>) {
        synchronized(_cachedMemories) {
            _cachedMemories.clear()
            _cachedMemories.addAll(memories)
        }
        Log.i(TAG, "Updated local memory cache: ${_cachedMemories.size} memories.")
    }

    fun getCachedMemories(): List<SharedMemoryItem> {
        synchronized(_cachedMemories) {
            return _cachedMemories.toList()
        }
    }

    fun getQueue(): SharedMemoryQueue = memoryQueue

    /**
     * Executes a shared memory capability call.
     */
    suspend fun execute(args: JSONObject): AndroidCapabilityResult {
        val action = args.optString("action", "get").lowercase()

        return try {
            when (action) {
                "get" -> {
                    val id = args.optString("id", "")
                    synchronized(_cachedMemories) {
                        if (id.isNotBlank()) {
                            val match = _cachedMemories.find { it.id == id }
                            if (match != null) {
                                AndroidCapabilityResult.success(SharedMemoryResult(true, "get", memory = match).toJsonObject())
                            } else {
                                AndroidCapabilityResult.failure("Memory '$id' not found in local cache.")
                            }
                        } else {
                            AndroidCapabilityResult.success(
                                SharedMemoryResult(true, "get", memories = _cachedMemories.toList()).toJsonObject()
                            )
                        }
                    }
                }

                "search" -> {
                    val query = args.optString("query", "").lowercase()
                    val category = args.optString("category", "").lowercase()

                    synchronized(_cachedMemories) {
                        val filtered = _cachedMemories.filter { mem ->
                            val matchesCat = category.isBlank() || mem.category.lowercase() == category
                            val matchesQ = query.isBlank() || mem.text.lowercase().contains(query) || (mem.key?.lowercase()?.contains(query) == true)
                            matchesCat && matchesQ
                        }
                        AndroidCapabilityResult.success(
                            SharedMemoryResult(true, "search", memories = filtered).toJsonObject()
                        )
                    }
                }

                "create" -> {
                    val category = args.optString("category", "fact")
                    val rawText = args.optString("text", "")
                    if (rawText.isBlank()) {
                        return AndroidCapabilityResult.failure("MISSING_REQUIRED_FIELDS: Memory text cannot be blank.")
                    }

                    // Local DLP sanitization
                    val sanitizedText = MobileContextSanitizer.sanitizeText(rawText)
                    val mutationId = args.optString("clientMutationId", UUID.randomUUID().toString())
                    val timestamp = args.optString("timestamp", java.time.Instant.now().toString())

                    val op = MemorySyncOperation(
                        clientMutationId = mutationId,
                        operationType = "CREATE",
                        category = category,
                        text = sanitizedText,
                        key = if (args.has("key")) args.getString("key") else null,
                        importance = args.optString("importance", "medium"),
                        confidence = args.optString("confidence", "medium"),
                        timestamp = timestamp
                    )

                    memoryQueue.enqueue(op)

                    val tempItem = SharedMemoryItem(
                        id = "temp_${UUID.randomUUID().toString().substring(0, 8)}",
                        category = category,
                        text = sanitizedText,
                        key = op.key,
                        importance = op.importance ?: "medium",
                        confidence = op.confidence ?: "medium",
                        source = "user_explicit",
                        deviceId = "android_companion",
                        deviceType = "android",
                        version = 1,
                        createdAt = timestamp,
                        updatedAt = timestamp,
                        clientMutationId = mutationId,
                        status = "active"
                    )

                    synchronized(_cachedMemories) {
                        _cachedMemories.add(tempItem)
                    }

                    AndroidCapabilityResult.success(
                        SharedMemoryResult(
                            success = true,
                            action = "create",
                            memory = tempItem,
                            appliedCount = 1
                        ).toJsonObject()
                    )
                }

                "update" -> {
                    val id = args.optString("id", "")
                    if (id.isBlank()) {
                        return AndroidCapabilityResult.failure("MISSING_MEMORY_ID: Update requires memory ID.")
                    }

                    val rawText = if (args.has("text")) args.getString("text") else null
                    val sanitizedText = rawText?.let { MobileContextSanitizer.sanitizeText(it) }
                    val mutationId = args.optString("clientMutationId", UUID.randomUUID().toString())
                    val timestamp = args.optString("timestamp", java.time.Instant.now().toString())
                    val clientVersion = if (args.has("clientVersion")) args.getInt("clientVersion") else 1

                    val op = MemorySyncOperation(
                        clientMutationId = mutationId,
                        operationType = "UPDATE",
                        memoryId = id,
                        category = if (args.has("category")) args.getString("category") else null,
                        text = sanitizedText,
                        key = if (args.has("key")) args.getString("key") else null,
                        importance = if (args.has("importance")) args.getString("importance") else null,
                        confidence = if (args.has("confidence")) args.getString("confidence") else null,
                        timestamp = timestamp,
                        clientVersion = clientVersion
                    )

                    memoryQueue.enqueue(op)

                    AndroidCapabilityResult.success(
                        SharedMemoryResult(
                            success = true,
                            action = "update",
                            appliedCount = 1
                        ).toJsonObject()
                    )
                }

                "delete" -> {
                    val id = args.optString("id", "")
                    if (id.isBlank()) {
                        return AndroidCapabilityResult.failure("MISSING_MEMORY_ID: Delete requires memory ID.")
                    }

                    val mutationId = args.optString("clientMutationId", UUID.randomUUID().toString())
                    val timestamp = args.optString("timestamp", java.time.Instant.now().toString())

                    val op = MemorySyncOperation(
                        clientMutationId = mutationId,
                        operationType = "DELETE",
                        memoryId = id,
                        timestamp = timestamp
                    )

                    memoryQueue.enqueue(op)

                    synchronized(_cachedMemories) {
                        _cachedMemories.removeAll { it.id == id }
                    }

                    AndroidCapabilityResult.success(
                        SharedMemoryResult(
                            success = true,
                            action = "delete",
                            appliedCount = 1
                        ).toJsonObject()
                    )
                }

                "sync" -> {
                    val pending = memoryQueue.peekAll()
                    AndroidCapabilityResult.success(
                        JSONObject().apply {
                            put("success", true)
                            put("action", "sync")
                            put("pendingCount", pending.size)
                        }
                    )
                }

                else -> AndroidCapabilityResult.failure("UNSUPPORTED_ACTION: Action '$action' is not supported.")
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error executing shared memory action: $action", e)
            AndroidCapabilityResult.failure("EXECUTION_ERROR: ${e.message}")
        }
    }
}
