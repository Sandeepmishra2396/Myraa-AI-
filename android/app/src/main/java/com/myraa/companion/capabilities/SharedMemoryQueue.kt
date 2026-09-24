package com.myraa.companion.capabilities

import java.util.Collections
import java.util.concurrent.ConcurrentLinkedQueue

/**
 * SharedMemoryQueue
 * Phase 24 — Shared MYRAA Memory
 *
 * Thread-safe offline mutation queue:
 * - Queues memory mutations when the Android companion is disconnected or offline.
 * - Guarantees sequential in-order drain when connectivity is restored.
 * - Idempotency is preserved across retries via clientMutationId.
 */
class SharedMemoryQueue {
    private val queue = ConcurrentLinkedQueue<MemorySyncOperation>()

    fun enqueue(operation: MemorySyncOperation) {
        queue.add(operation)
    }

    fun peekAll(): List<MemorySyncOperation> {
        return queue.toList()
    }

    fun drain(maxCount: Int = 100): List<MemorySyncOperation> {
        val batch = mutableListOf<MemorySyncOperation>()
        var count = 0
        while (count < maxCount) {
            val item = queue.poll() ?: break
            batch.add(item)
            count++
        }
        return batch
    }

    fun size(): Int = queue.size

    fun isEmpty(): Boolean = queue.isEmpty()

    fun clear() {
        queue.clear()
    }
}
