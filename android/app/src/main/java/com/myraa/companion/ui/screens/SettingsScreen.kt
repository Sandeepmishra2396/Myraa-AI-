package com.myraa.companion.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.myraa.companion.networking.ConnectionStatus
import com.myraa.companion.networking.EmergencyStopState
import com.myraa.companion.ui.actions.ActionExecutionRecord
import com.myraa.companion.ui.errors.FeatureError
import com.myraa.companion.ui.settings.FeatureStatusDiagnosticsSection
import com.myraa.companion.ui.status.RealSystemSnapshot
import com.myraa.companion.ui.theme.EmergencyRed
import com.myraa.companion.ui.theme.MyraaCyan
import com.myraa.companion.ui.theme.MyraaDarkBg
import com.myraa.companion.ui.theme.MyraaPurple
import com.myraa.companion.ui.theme.MyraaSurface
import com.myraa.companion.ui.theme.MyraaSurfaceElevated
import com.myraa.companion.ui.theme.StatusAmber
import com.myraa.companion.ui.theme.StatusGreen
import com.myraa.companion.ui.theme.TextMuted
import com.myraa.companion.ui.theme.TextPrimary
import com.myraa.companion.ui.theme.TextSecondary

/**
 * SettingsScreen (Section 5 & Section 6 — Phase 13A-WIN.5)
 *
 * Organized strictly into configuration sections:
 *  1. MYRAA (Profile, Assistant identity)
 *  2. ASSISTANT (Voice & Speech, AI Model, Language, Personality)
 *  3. PHONE (Permissions, Screen Context, Local Processing)
 *  4. PRIVACY & SECURITY (Privacy Shield, Data Controls, Emergency Controls)
 *  5. DEVICES (Desktop Bridge, Connected Devices)
 *  6. ABOUT (App Version, Build, Diagnostics, Legal)
 */
@Composable
fun SettingsScreen(
    standaloneDeviceId: String = "mob_standalone",
    accountId: String? = null,
    preferredLanguage: String = "en-IN",
    onPreferredLanguageChanged: (String) -> Unit = {},
    hasMicPermission: Boolean = true,
    onRequestMicPermission: () -> Unit = {},
    onOpenSystemAppSettings: () -> Unit = {},
    hasDesktopSession: Boolean = false,
    connectionStatus: ConnectionStatus = ConnectionStatus.DISCONNECTED,
    deviceId: String?,
    deviceName: String?,
    deviceRole: String,
    maskedToken: String?,
    serverHost: String,
    serverPort: Int,
    onUpdateServerEndpoint: (String, Int) -> Unit = { _, _ -> },
    privacyShieldEnabled: Boolean = true,
    onPrivacyShieldChanged: (Boolean) -> Unit = {},
    screenContextApproved: Boolean = false,
    onScreenContextApprovedChanged: (Boolean) -> Unit = {},
    localOnlyMode: Boolean = false,
    onLocalOnlyModeChanged: (Boolean) -> Unit = {},
    securityLockdownActive: Boolean = false,
    onToggleSecurityLockdown: (Boolean) -> Unit = {},
    emergencyStopState: EmergencyStopState = EmergencyStopState(active = false),
    onTriggerEmergencyStop: () -> Unit = {},
    onResetEmergencyStop: () -> Unit = {},
    onClearLocalHistory: () -> Unit = {},
    onConnectDesktop: () -> Unit = {},
    onLogout: () -> Unit,
    onRevokeDevice: () -> Unit,
    onNavigateBack: () -> Unit,
    onOpenDiagnosticsModal: () -> Unit = {},
    onOpenActionsScreen: () -> Unit = {},
    systemSnapshot: RealSystemSnapshot? = null,
    actionRecords: Map<String, ActionExecutionRecord> = emptyMap(),
    voiceError: FeatureError? = null,
    chatError: FeatureError? = null,
    modifier: Modifier = Modifier
) {
    var showRevokeDialog by remember { mutableStateOf(false) }
    var selectedPersonality by remember { mutableStateOf("Balanced Companion") }
    var showInlineDiagnostics by remember { mutableStateOf(true) }
    val scrollState = rememberScrollState()

    Column(
        modifier = modifier
            .fillMaxSize()
            .background(MyraaDarkBg)
            .verticalScroll(scrollState)
            .padding(horizontal = 16.dp, vertical = 12.dp)
    ) {
        // Top Header (matches Reference Image #5)
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = onNavigateBack) {
                    Text("←", color = TextPrimary, fontSize = 22.sp)
                }
                Column {
                    Text(
                        text = "Settings",
                        color = TextPrimary,
                        fontSize = 22.sp,
                        fontWeight = FontWeight.Bold
                    )
                    Text(
                        text = "Customize your MYRAA experience",
                        color = TextSecondary,
                        fontSize = 12.sp
                    )
                }
            }

            Button(
                onClick = onOpenDiagnosticsModal,
                colors = ButtonDefaults.buttonColors(containerColor = MyraaSurfaceElevated),
                shape = RoundedCornerShape(10.dp),
                modifier = Modifier.height(34.dp)
            ) {
                Text("Diagnostics", color = MyraaCyan, fontSize = 11.sp, fontWeight = FontWeight.Bold)
            }
        }

        Spacer(modifier = Modifier.height(14.dp))

        // ═════════════════════════════════════════════════════════════════════
        // SECTION 1: MYRAA (Profile & Assistant Identity)
        // ═════════════════════════════════════════════════════════════════════
        SettingsSectionHeader(title = "MYRAA")

        SettingsCard {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Box(
                    modifier = Modifier
                        .size(44.dp)
                        .clip(CircleShape)
                        .background(MyraaCyan.copy(alpha = 0.2f))
                        .border(1.5.dp, MyraaCyan, CircleShape),
                    contentAlignment = Alignment.Center
                ) {
                    Text(
                        text = "M",
                        color = MyraaCyan,
                        fontSize = 18.sp,
                        fontWeight = FontWeight.Bold,
                        fontFamily = FontFamily.Monospace
                    )
                }
                Spacer(modifier = Modifier.width(12.dp))
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = "MYRAA",
                        color = TextPrimary,
                        fontSize = 15.sp,
                        fontWeight = FontWeight.Bold
                    )
                    Text(
                        text = "Your Personal AI Assistant • Standalone Ready",
                        color = TextSecondary,
                        fontSize = 12.sp
                    )
                }
            }

            Spacer(modifier = Modifier.height(8.dp))
            SettingsRow(
                label = "Profile",
                value = accountId?.takeIf { it.isNotBlank() } ?: "Mobile Owner (Standalone)"
            )
            SettingsRow(
                label = "Assistant Identity",
                value = standaloneDeviceId,
                monospace = true
            )
        }

        Spacer(modifier = Modifier.height(16.dp))

        // ═════════════════════════════════════════════════════════════════════
        // SECTION 2: ASSISTANT (Voice & Speech, AI Model, Language, Personality)
        // ═════════════════════════════════════════════════════════════════════
        SettingsSectionHeader(title = "ASSISTANT")

        SettingsCard {
            SettingsRow(
                label = "Voice & Speech",
                value = "16kHz PCM16 Input • 24kHz Output"
            )
            SettingsRow(
                label = "AI Model",
                value = if (localOnlyMode) "On-Device Intent Engine" else "Gemini Live 2.5 Flash + Cloud HTTPS"
            )

            // Language Selector
            Column(modifier = Modifier.fillMaxWidth()) {
                Text(
                    text = "Language",
                    color = TextSecondary,
                    fontSize = 13.sp
                )
                Spacer(modifier = Modifier.height(6.dp))
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    listOf(
                        "en-IN" to "English (IN)",
                        "hinglish" to "Hinglish",
                        "hi-IN" to "Hindi"
                    ).forEach { (code, label) ->
                        val isSelected = preferredLanguage == code
                        Box(
                            modifier = Modifier
                                .weight(1f)
                                .clip(RoundedCornerShape(8.dp))
                                .background(
                                    if (isSelected) MyraaCyan.copy(alpha = 0.2f)
                                    else MyraaSurfaceElevated
                                )
                                .border(
                                    width = 1.dp,
                                    color = if (isSelected) MyraaCyan else Color.Transparent,
                                    shape = RoundedCornerShape(8.dp)
                                )
                                .clickable { onPreferredLanguageChanged(code) }
                                .padding(vertical = 7.dp),
                            contentAlignment = Alignment.Center
                        ) {
                            Text(
                                text = label,
                                color = if (isSelected) MyraaCyan else TextSecondary,
                                fontSize = 11.sp,
                                fontWeight = if (isSelected) FontWeight.Bold else FontWeight.Medium
                            )
                        }
                    }
                }
            }

            // Personality Selector
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable {
                        selectedPersonality = when (selectedPersonality) {
                            "Balanced Companion" -> "Concise & Direct"
                            "Concise & Direct" -> "Technical Pro"
                            else -> "Balanced Companion"
                        }
                    },
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(text = "Personality", color = TextSecondary, fontSize = 13.sp)
                Text(
                    text = "$selectedPersonality ▸",
                    color = MyraaCyan,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.SemiBold
                )
            }
        }

        Spacer(modifier = Modifier.height(16.dp))

        // ═════════════════════════════════════════════════════════════════════
        // SECTION 3: PHONE (Permissions, Screen Context, Local Processing)
        // ═════════════════════════════════════════════════════════════════════
        SettingsSectionHeader(title = "PHONE")

        SettingsCard {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = "Permissions (Microphone & Device)",
                        color = TextPrimary,
                        fontSize = 13.sp,
                        fontWeight = FontWeight.Medium
                    )
                    Text(
                        text = if (hasMicPermission) "Microphone Granted" else "Microphone Permission Required",
                        color = if (hasMicPermission) StatusGreen else StatusAmber,
                        fontSize = 11.sp
                    )
                }
                Button(
                    onClick = if (hasMicPermission) onOpenSystemAppSettings else onRequestMicPermission,
                    colors = ButtonDefaults.buttonColors(containerColor = MyraaSurfaceElevated),
                    shape = RoundedCornerShape(8.dp),
                    modifier = Modifier.height(32.dp)
                ) {
                    Text(
                        text = if (hasMicPermission) "App Perms" else "Grant Mic",
                        color = MyraaCyan,
                        fontSize = 11.sp,
                        fontWeight = FontWeight.Bold
                    )
                }
            }

            SettingsToggleRow(
                label = "Screen Context Understanding",
                checked = screenContextApproved,
                onCheckedChange = onScreenContextApprovedChanged
            )

            SettingsToggleRow(
                label = "Local-Only Processing Mode",
                checked = localOnlyMode,
                onCheckedChange = onLocalOnlyModeChanged
            )
        }

        Spacer(modifier = Modifier.height(16.dp))

        // ═════════════════════════════════════════════════════════════════════
        // SECTION 4: PRIVACY & SECURITY (Privacy Shield, Data Controls, Emergency Controls)
        // ═════════════════════════════════════════════════════════════════════
        SettingsSectionHeader(title = "PRIVACY & SECURITY")

        SettingsCard {
            SettingsToggleRow(
                label = "Privacy Shield (PII/OTP Redaction)",
                checked = privacyShieldEnabled,
                onCheckedChange = onPrivacyShieldChanged
            )

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = "Data Controls",
                        color = TextPrimary,
                        fontSize = 13.sp,
                        fontWeight = FontWeight.Medium
                    )
                    Text(
                        text = "Clear local conversation & action test logs",
                        color = TextMuted,
                        fontSize = 11.sp
                    )
                }
                Button(
                    onClick = onClearLocalHistory,
                    colors = ButtonDefaults.buttonColors(containerColor = MyraaSurfaceElevated),
                    shape = RoundedCornerShape(8.dp),
                    modifier = Modifier.height(32.dp)
                ) {
                    Text("Clear Logs", color = TextPrimary, fontSize = 11.sp)
                }
            }

            Spacer(modifier = Modifier.height(4.dp))

            SettingsRow(
                label = "Emergency Stop",
                value = if (emergencyStopState.active) "ACTIVE (HALTED)" else "READY"
            )
            Button(
                onClick = if (emergencyStopState.active) onResetEmergencyStop else onTriggerEmergencyStop,
                colors = ButtonDefaults.buttonColors(
                    containerColor = if (emergencyStopState.active) StatusGreen else EmergencyRed
                ),
                shape = RoundedCornerShape(10.dp),
                modifier = Modifier
                    .fillMaxWidth()
                    .height(42.dp)
            ) {
                Text(
                    text = if (emergencyStopState.active) "RESET EMERGENCY STOP" else "TRIGGER EMERGENCY STOP",
                    color = if (emergencyStopState.active) MyraaDarkBg else Color.White,
                    fontWeight = FontWeight.Bold,
                    fontSize = 12.sp
                )
            }

            SettingsRow(
                label = "Security Lockdown",
                value = if (securityLockdownActive) "LOCKED (FAIL-CLOSED)" else "NORMAL"
            )
            Button(
                onClick = { onToggleSecurityLockdown(!securityLockdownActive) },
                colors = ButtonDefaults.buttonColors(
                    containerColor = if (securityLockdownActive) StatusGreen else EmergencyRed.copy(alpha = 0.85f)
                ),
                shape = RoundedCornerShape(10.dp),
                modifier = Modifier
                    .fillMaxWidth()
                    .height(42.dp)
            ) {
                Text(
                    text = if (securityLockdownActive) "RECOVER FROM SECURITY LOCKDOWN" else "TRIGGER SECURITY LOCKDOWN",
                    color = if (securityLockdownActive) MyraaDarkBg else Color.White,
                    fontWeight = FontWeight.Bold,
                    fontSize = 12.sp
                )
            }
        }

        Spacer(modifier = Modifier.height(16.dp))

        // ═════════════════════════════════════════════════════════════════════
        // SECTION 5: DEVICES • DESKTOP REMOTE BRIDGE (OPTIONAL) (Section 6)
        // ═════════════════════════════════════════════════════════════════════
        SettingsSectionHeader(title = "DEVICES • DESKTOP REMOTE BRIDGE (OPTIONAL)")

        SettingsCard {
            val isConnected = connectionStatus == ConnectionStatus.AUTHENTICATED && hasDesktopSession

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = "DESKTOP BRIDGE",
                    color = MyraaCyan,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Bold,
                    fontFamily = FontFamily.Monospace
                )
                Box(
                    modifier = Modifier
                        .clip(RoundedCornerShape(6.dp))
                        .background(MyraaCyan.copy(alpha = 0.14f))
                        .padding(horizontal = 8.dp, vertical = 2.dp)
                ) {
                    Text(
                        text = "OPTIONAL",
                        color = MyraaCyan,
                        fontSize = 10.sp,
                        fontWeight = FontWeight.Bold
                    )
                }
            }

            SettingsRow(
                label = "Status",
                value = when {
                    isConnected -> "DESKTOP CONNECTED"
                    hasDesktopSession -> "PAIRED (DESKTOP OFFLINE)"
                    else -> "NOT CONNECTED"
                }
            )
            SettingsRow(
                label = "Phone",
                value = "STANDALONE ACTIVE"
            )
            SettingsRow(
                label = "Cloud / Host Endpoint",
                value = "$serverHost:$serverPort",
                monospace = true
            )

            var customHostInput by remember(serverHost) { mutableStateOf(serverHost) }
            var customPortInput by remember(serverPort) { mutableStateOf(serverPort.toString()) }

            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(vertical = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                OutlinedTextField(
                    value = customHostInput,
                    onValueChange = { customHostInput = it },
                    label = { Text("Server Host / IP", color = TextSecondary, fontSize = 10.sp) },
                    modifier = Modifier.weight(2f),
                    shape = RoundedCornerShape(8.dp),
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedTextColor = TextPrimary,
                        unfocusedTextColor = TextPrimary,
                        focusedBorderColor = MyraaCyan,
                        unfocusedBorderColor = Color(0xFF22273B),
                        focusedContainerColor = MyraaSurfaceElevated,
                        unfocusedContainerColor = MyraaSurfaceElevated
                    ),
                    singleLine = true
                )
                OutlinedTextField(
                    value = customPortInput,
                    onValueChange = { customPortInput = it },
                    label = { Text("Port", color = TextSecondary, fontSize = 10.sp) },
                    modifier = Modifier.weight(1f),
                    shape = RoundedCornerShape(8.dp),
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedTextColor = TextPrimary,
                        unfocusedTextColor = TextPrimary,
                        focusedBorderColor = MyraaCyan,
                        unfocusedBorderColor = Color(0xFF22273B),
                        focusedContainerColor = MyraaSurfaceElevated,
                        unfocusedContainerColor = MyraaSurfaceElevated
                    ),
                    singleLine = true
                )
            }

            Button(
                onClick = {
                    val portNum = customPortInput.toIntOrNull() ?: 3000
                    onUpdateServerEndpoint(customHostInput.trim(), portNum)
                },
                colors = ButtonDefaults.buttonColors(containerColor = MyraaCyan),
                shape = RoundedCornerShape(8.dp),
                modifier = Modifier
                    .fillMaxWidth()
                    .height(36.dp)
            ) {
                Text(
                    text = "SAVE & CONNECT ENDPOINT",
                    color = MyraaDarkBg,
                    fontSize = 11.sp,
                    fontWeight = FontWeight.Bold
                )
            }

            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(vertical = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp)
            ) {
                Button(
                    onClick = {
                        customHostInput = "10.238.228.93"
                        customPortInput = "3000"
                        onUpdateServerEndpoint("10.238.228.93", 3000)
                    },
                    colors = ButtonDefaults.buttonColors(
                        containerColor = if (serverHost == "10.238.228.93") MyraaCyan else MyraaSurfaceElevated
                    ),
                    shape = RoundedCornerShape(8.dp),
                    modifier = Modifier
                        .weight(1.1f)
                        .height(34.dp)
                ) {
                    Text(
                        text = "PC Hotspot",
                        color = if (serverHost == "10.238.228.93") MyraaDarkBg else TextPrimary,
                        fontSize = 9.sp,
                        fontWeight = FontWeight.Bold
                    )
                }

                Button(
                    onClick = {
                        customHostInput = "10.0.2.2"
                        customPortInput = "3000"
                        onUpdateServerEndpoint("10.0.2.2", 3000)
                    },
                    colors = ButtonDefaults.buttonColors(
                        containerColor = if (serverHost == "10.0.2.2") MyraaCyan else MyraaSurfaceElevated
                    ),
                    shape = RoundedCornerShape(8.dp),
                    modifier = Modifier
                        .weight(1f)
                        .height(34.dp)
                ) {
                    Text(
                        text = "Emulator",
                        color = if (serverHost == "10.0.2.2") MyraaDarkBg else TextPrimary,
                        fontSize = 9.sp,
                        fontWeight = FontWeight.Bold
                    )
                }

                Button(
                    onClick = {
                        customHostInput = com.myraa.companion.security.SecureTokenStorage.DEFAULT_HOST
                        customPortInput = com.myraa.companion.security.SecureTokenStorage.DEFAULT_PORT.toString()
                        onUpdateServerEndpoint(com.myraa.companion.security.SecureTokenStorage.DEFAULT_HOST, com.myraa.companion.security.SecureTokenStorage.DEFAULT_PORT)
                    },
                    colors = ButtonDefaults.buttonColors(
                        containerColor = if (serverHost == com.myraa.companion.security.SecureTokenStorage.DEFAULT_HOST) MyraaCyan else MyraaSurfaceElevated
                    ),
                    shape = RoundedCornerShape(8.dp),
                    modifier = Modifier
                        .weight(1f)
                        .height(34.dp)
                ) {
                    Text(
                        text = "Cloud Prod",
                        color = if (serverHost == com.myraa.companion.security.SecureTokenStorage.DEFAULT_HOST) MyraaDarkBg else TextPrimary,
                        fontSize = 9.sp,
                        fontWeight = FontWeight.Bold
                    )
                }
            }

            if (hasDesktopSession) {
                SettingsRow(
                    label = "Device",
                    value = deviceName ?: "MYRAA Desktop"
                )
                SettingsRow(
                    label = "Capabilities",
                    value = "Remote Desktop, Workflows, 126 Tools (${deviceRole.uppercase()})"
                )
                SettingsRow(
                    label = "Paired Device ID",
                    value = deviceId ?: "None",
                    monospace = true
                )
                SettingsRow(
                    label = "Bearer Token",
                    value = maskedToken ?: "None",
                    monospace = true
                )
            }

            Spacer(modifier = Modifier.height(4.dp))

            Button(
                onClick = onConnectDesktop,
                colors = ButtonDefaults.buttonColors(containerColor = MyraaCyan),
                shape = RoundedCornerShape(10.dp),
                modifier = Modifier
                    .fillMaxWidth()
                    .height(46.dp)
            ) {
                Text(
                    text = if (hasDesktopSession) "RE-PAIR / CONNECT DESKTOP" else "CONNECT DESKTOP",
                    color = MyraaDarkBg,
                    fontWeight = FontWeight.Bold,
                    fontSize = 14.sp
                )
            }

            if (hasDesktopSession) {
                Button(
                    onClick = onLogout,
                    colors = ButtonDefaults.buttonColors(containerColor = MyraaSurfaceElevated),
                    shape = RoundedCornerShape(10.dp),
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(44.dp)
                ) {
                    Text(
                        text = "DISCONNECT DESKTOP (KEEP STANDALONE)",
                        color = TextPrimary,
                        fontWeight = FontWeight.SemiBold,
                        fontSize = 12.sp
                    )
                }

                Button(
                    onClick = { showRevokeDialog = true },
                    colors = ButtonDefaults.buttonColors(containerColor = EmergencyRed.copy(alpha = 0.85f)),
                    shape = RoundedCornerShape(10.dp),
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(44.dp)
                ) {
                    Text(
                        text = "REVOKE DEVICE REGISTRATION",
                        color = Color.White,
                        fontWeight = FontWeight.Bold,
                        fontSize = 12.sp
                    )
                }
            }
        }

        Spacer(modifier = Modifier.height(16.dp))

        // ═════════════════════════════════════════════════════════════════════
        // SECTION 6: ABOUT & DIAGNOSTICS (App Version, Build, Diagnostics, Legal)
        // ═════════════════════════════════════════════════════════════════════
        SettingsSectionHeader(title = "ABOUT")

        SettingsCard {
            SettingsRow(label = "App Version", value = "1.0.2 (versionCode 3)")
            SettingsRow(label = "Build", value = "Phase 13A-WIN.5 (UI Redesign)", monospace = true)
            SettingsRow(label = "Legal", value = "Keystore AES-256-GCM • Fail-Closed Security")

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = "Manual Feature Testing Diagnostics",
                    color = TextSecondary,
                    fontSize = 13.sp
                )
                TextButton(onClick = { showInlineDiagnostics = !showInlineDiagnostics }) {
                    Text(
                        text = if (showInlineDiagnostics) "Hide Status ▲" else "Show Status ▼",
                        color = MyraaCyan,
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Bold
                    )
                }
            }
        }

        if (showInlineDiagnostics && systemSnapshot != null) {
            Spacer(modifier = Modifier.height(12.dp))
            FeatureStatusDiagnosticsSection(
                snapshot = systemSnapshot,
                actionRecords = actionRecords,
                voiceError = voiceError,
                chatError = chatError,
                onOpenActionsForManualTest = onOpenActionsScreen
            )
        }

        Spacer(modifier = Modifier.height(16.dp))
    }

    if (showRevokeDialog) {
        AlertDialog(
            onDismissRequest = { showRevokeDialog = false },
            title = { Text("Revoke Desktop Device Registration?") },
            text = {
                Text("This will notify MYRAA Core to invalidate this desktop bridge token. MYRAA Mobile will continue working as your standalone phone AI assistant.")
            },
            confirmButton = {
                Button(
                    onClick = {
                        showRevokeDialog = false
                        onRevokeDevice()
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = EmergencyRed)
                ) {
                    Text("REVOKE DESKTOP BRIDGE", color = Color.White)
                }
            },
            dismissButton = {
                TextButton(onClick = { showRevokeDialog = false }) {
                    Text("Cancel", color = TextSecondary)
                }
            },
            containerColor = MyraaSurface,
            titleContentColor = TextPrimary,
            textContentColor = TextSecondary
        )
    }
}

@Composable
private fun SettingsSectionHeader(title: String) {
    Text(
        text = title,
        color = MyraaCyan,
        fontSize = 11.sp,
        fontWeight = FontWeight.Bold,
        letterSpacing = 1.sp,
        modifier = Modifier.padding(start = 4.dp, bottom = 6.dp)
    )
}

@Composable
private fun SettingsCard(content: @Composable () -> Unit) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(MyraaSurface)
            .border(1.dp, Color(0xFF22273B), RoundedCornerShape(14.dp))
            .padding(16.dp)
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            content()
        }
    }
}

@Composable
fun SettingsRow(label: String, value: String, monospace: Boolean = false) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(text = label, color = TextSecondary, fontSize = 13.sp)
        Spacer(modifier = Modifier.width(8.dp))
        Text(
            text = value,
            color = TextPrimary,
            fontSize = 12.sp,
            fontWeight = FontWeight.Medium,
            fontFamily = if (monospace) FontFamily.Monospace else FontFamily.Default
        )
    }
}

@Composable
private fun SettingsToggleRow(
    label: String,
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(text = label, color = TextSecondary, fontSize = 13.sp, modifier = Modifier.weight(1f))
        Spacer(modifier = Modifier.width(8.dp))
        Switch(
            checked = checked,
            onCheckedChange = onCheckedChange,
            colors = SwitchDefaults.colors(
                checkedThumbColor = MyraaDarkBg,
                checkedTrackColor = MyraaCyan,
                uncheckedThumbColor = TextSecondary,
                uncheckedTrackColor = MyraaSurfaceElevated
            )
        )
    }
}
