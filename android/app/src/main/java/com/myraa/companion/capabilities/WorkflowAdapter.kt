package com.myraa.companion.capabilities

import android.content.Context
import android.util.Log
import com.myraa.companion.networking.MyraaApiClient
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * WorkflowAdapter
 * Phase 27 — Mobile Autonomous Workflow Engine
 *
 * Client-side adapter for triggering and confirming autonomous workflows
 * from the Android companion app.
 */
class WorkflowAdapter(
    private val context: Context,
    private val apiClient: MyraaApiClient = MyraaApiClient()
) {
    companion object {
        private const val TAG = "WorkflowAdapter"
    }

    suspend fun executeVoiceWorkflow(
        host: String,
        port: Int,
        bearerToken: String,
        query: String,
        preferredLanguage: String = "hinglish",
        autoExecute: Boolean = true
    ): WorkflowResponse? = withContext(Dispatchers.IO) {
        try {
            apiClient.executeWorkflow(
                host = host,
                port = port,
                bearerToken = bearerToken,
                query = query,
                preferredLanguage = preferredLanguage,
                autoExecute = autoExecute
            )
        } catch (e: Exception) {
            Log.e(TAG, "Failed to execute voice workflow: ${e.message}")
            null
        }
    }

    suspend fun confirmWorkflowStep(
        host: String,
        port: Int,
        bearerToken: String,
        planId: String,
        checkpointId: String,
        approved: Boolean,
        userFeedback: String? = null
    ): WorkflowResponse? = withContext(Dispatchers.IO) {
        try {
            apiClient.confirmWorkflowCheckpoint(
                host = host,
                port = port,
                bearerToken = bearerToken,
                planId = planId,
                checkpointId = checkpointId,
                approved = approved,
                userFeedback = userFeedback
            )
        } catch (e: Exception) {
            Log.e(TAG, "Failed to confirm workflow checkpoint: ${e.message}")
            null
        }
    }

    fun getContext(): Context = context
}
