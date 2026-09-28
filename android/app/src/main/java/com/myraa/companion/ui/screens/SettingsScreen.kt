package com.myraa.companion.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.IconButton
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
import com.myraa.companion.ui.theme.EmergencyRed
import com.myraa.companion.ui.theme.MyraaCyan
import com.myraa.companion.ui.theme.MyraaDarkBg
import com.myraa.companion.ui.theme.MyraaSurface
import com.myraa.companion.ui.theme.MyraaSurfaceElevated
import com.myraa.companion.ui.theme.StatusGreen
import com.myraa.companion.ui.theme.TextMuted
import com.myraa.companion.ui.theme.TextPrimary
import com.myraa.companion.ui.theme.TextSecondary

@Composable
fun SettingsScreen(
    standaloneDeviceId: String = "mob_standalone",
    hasDesktopSession: Boolean = false,
    connectionStatus: ConnectionStatus = ConnectionStatus.DISCONNECTED,
    deviceId: String?,
    deviceName: String?,
    deviceRole: String,
    maskedToken: String?,
    serverHost: String,
    serverPort: Int,
    privacyShieldEnabled: Boolean = true,
    onPrivacyShieldChanged: (Boolean) -> Unit = {},
    screenContextApproved: Boolean = false,
    onScreenContextApprovedChanged: (Boolean) -> Unit = {},
    localOnlyMode: Boolean = false,
    onLocalOnlyModeChanged: (Boolean) -> Unit = {},
    securityLockdownActive: Boolean = false,
    onToggleSecurityLockdown: (Boolean) -> Unit = {},
    onConnectDesktop: () -> Unit = {},
    onLogout: () -> Unit,
    onRevokeDevice: () -> Unit,
    onNavigateBack: () -> Unit,
    modifier: Modifier = Modifier
) {
    var showRevokeDialog by remember { mutableStateOf(false) }
    val scrollState = rememberScrollState()

    Column(
        modifier = modifier
            .fillMaxSize()
            .background(MyraaDarkBg)
            .verticalScroll(scrollState)
            .padding(16.dp)
    ) {
        // Top Bar
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically
        ) {
            IconButton(onClick = onNavigateBack) {
                Text("←", color = TextPrimary, fontSize = 24.sp)
            }
            Text(
                text = "Settings & Devices",
                color = TextPrimary,
                fontSize = 18.sp,
                fontWeight = FontWeight.Bold,
                modifier = Modifier.padding(start = 8.dp)
            )
        }

        Spacer(modifier = Modifier.height(12.dp))

        // Section 1: Standalone Mobile AI Assistant & Privacy
        Text(
            text = "MYRAA MOBILE ASSISTANT (STANDALONE)",
            color = MyraaCyan,
            fontSize = 11.sp,
            fontWeight = FontWeight.Bold,
            letterSpacing = 1.sp,
            modifier = Modifier.padding(start = 4.dp, bottom = 6.dp)
        )

        Box(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(12.dp))
                .background(MyraaSurface)
                .padding(16.dp)
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                SettingsRow(label = "Assistant Mode", value = "Standalone Phone AI (Ready)")
                SettingsRow(label = "Phone ID", value = standaloneDeviceId, monospace = true)

                SettingsToggleRow(
                    label = "Privacy Shield (PII/OTP Redaction)",
                    checked = privacyShieldEnabled,
                    onCheckedChange = onPrivacyShieldChanged
                )
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
        }

        Spacer(modifier = Modifier.height(18.dp))

        // Section 2: Devices -> Optional Desktop Remote Bridge
        Text(
            text = "DEVICES • DESKTOP REMOTE BRIDGE (OPTIONAL)",
            color = MyraaCyan,
            fontSize = 11.sp,
            fontWeight = FontWeight.Bold,
            letterSpacing = 1.sp,
            modifier = Modifier.padding(start = 4.dp, bottom = 6.dp)
        )

        Box(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(12.dp))
                .background(MyraaSurface)
                .padding(16.dp)
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                val bridgeStatusText = when {
                    connectionStatus == ConnectionStatus.AUTHENTICATED -> "Connected to Desktop"
                    hasDesktopSession -> "Paired (Desktop Offline — Phone Standalone Active)"
                    else -> "Not Paired (Phone Standalone Active)"
                }
                SettingsRow(label = "Desktop Bridge Status", value = bridgeStatusText)
                SettingsRow(label = "Cloud / Host Endpoint", value = "$serverHost:$serverPort", monospace = true)

                if (hasDesktopSession) {
                    SettingsRow(label = "Paired Device Name", value = deviceName ?: "Android Companion")
                    SettingsRow(label = "Paired Device ID", value = deviceId ?: "None", monospace = true)
                    SettingsRow(label = "Assigned Role", value = deviceRole.uppercase())
                    SettingsRow(label = "Bearer Token", value = maskedToken ?: "None", monospace = true)
                    SettingsRow(
                        label = "WebSocket URL",
                        value = com.myraa.companion.networking.MyraaWebSocketClient.buildWsUrl(serverHost, serverPort),
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
        }

        Spacer(modifier = Modifier.height(18.dp))

        // Section 3: Security & Emergency Lockdown
        Text(
            text = "SECURITY & EMERGENCY CONTROLS",
            color = TextMuted,
            fontSize = 11.sp,
            fontWeight = FontWeight.Bold,
            letterSpacing = 1.sp,
            modifier = Modifier.padding(start = 4.dp, bottom = 6.dp)
        )

        Box(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(12.dp))
                .background(MyraaSurface)
                .padding(16.dp)
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
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
                        .height(44.dp)
                ) {
                    Text(
                        text = if (securityLockdownActive) "RECOVER FROM SECURITY LOCKDOWN" else "TRIGGER SECURITY LOCKDOWN",
                        color = if (securityLockdownActive) MyraaDarkBg else Color.White,
                        fontWeight = FontWeight.Bold,
                        fontSize = 12.sp
                    )
                }
            }
        }
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
