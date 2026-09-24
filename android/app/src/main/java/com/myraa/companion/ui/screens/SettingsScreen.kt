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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.IconButton
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
import com.myraa.companion.ui.theme.EmergencyRed
import com.myraa.companion.ui.theme.MyraaCyan
import com.myraa.companion.ui.theme.MyraaDarkBg
import com.myraa.companion.ui.theme.MyraaSurface
import com.myraa.companion.ui.theme.MyraaSurfaceElevated
import com.myraa.companion.ui.theme.TextMuted
import com.myraa.companion.ui.theme.TextPrimary
import com.myraa.companion.ui.theme.TextSecondary

@Composable
fun SettingsScreen(
    deviceId: String?,
    deviceName: String?,
    deviceRole: String,
    maskedToken: String?,
    serverHost: String,
    serverPort: Int,
    onLogout: () -> Unit,
    onRevokeDevice: () -> Unit,
    onNavigateBack: () -> Unit,
    modifier: Modifier = Modifier
) {
    var showRevokeDialog by remember { mutableStateOf(false) }

    Column(
        modifier = modifier
            .fillMaxSize()
            .background(MyraaDarkBg)
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
                text = "Settings & Device",
                color = TextPrimary,
                fontSize = 18.sp,
                fontWeight = FontWeight.Bold,
                modifier = Modifier.padding(start = 8.dp)
            )
        }

        Spacer(modifier = Modifier.height(16.dp))

        // Device Credentials Card
        Text(
            text = "AUTHENTICATED DEVICE",
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
                SettingsRow(label = "Device Name", value = deviceName ?: "Unknown")
                SettingsRow(label = "Device ID", value = deviceId ?: "None", monospace = true)
                SettingsRow(label = "Assigned Role", value = deviceRole.uppercase())
                SettingsRow(label = "Bearer Token", value = maskedToken ?: "None", monospace = true)
            }
        }

        Spacer(modifier = Modifier.height(20.dp))

        // Connection Target Card
        Text(
            text = "MYRAA CORE WORKSTATION",
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
                SettingsRow(label = "Host IP", value = serverHost)
                SettingsRow(label = "Port", value = serverPort.toString())
                SettingsRow(label = "WebSocket URL", value = "ws://$serverHost:$serverPort/remote-live", monospace = true)
            }
        }

        Spacer(modifier = Modifier.weight(1f))

        // Action Buttons
        Button(
            onClick = onLogout,
            colors = ButtonDefaults.buttonColors(containerColor = MyraaSurfaceElevated),
            shape = RoundedCornerShape(10.dp),
            modifier = Modifier
                .fillMaxWidth()
                .height(48.dp)
        ) {
            Text("LOGOUT (DISCONNECT LOCAL SESSION)", color = TextPrimary, fontWeight = FontWeight.SemiBold)
        }

        Spacer(modifier = Modifier.height(10.dp))

        Button(
            onClick = { showRevokeDialog = true },
            colors = ButtonDefaults.buttonColors(containerColor = EmergencyRed.copy(alpha = 0.85f)),
            shape = RoundedCornerShape(10.dp),
            modifier = Modifier
                .fillMaxWidth()
                .height(48.dp)
        ) {
            Text("REVOKE DEVICE REGISTRATION", color = Color.White, fontWeight = FontWeight.Bold)
        }
    }

    if (showRevokeDialog) {
        AlertDialog(
            onDismissRequest = { showRevokeDialog = false },
            title = { Text("Revoke Device Registration?") },
            text = {
                Text("This will notify MYRAA Core to permanently invalidate this device token and remove this mobile client from paired devices.")
            },
            confirmButton = {
                Button(
                    onClick = {
                        showRevokeDialog = false
                        onRevokeDevice()
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = EmergencyRed)
                ) {
                    Text("REVOKE & LOGOUT", color = Color.White)
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
        Text(
            text = value,
            color = TextPrimary,
            fontSize = 13.sp,
            fontWeight = FontWeight.Medium,
            fontFamily = if (monospace) FontFamily.Monospace else FontFamily.Default
        )
    }
}
