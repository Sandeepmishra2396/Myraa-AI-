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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
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
import com.myraa.companion.networking.TranscriptItem
import com.myraa.companion.ui.components.AvatarVisualizer
import com.myraa.companion.ui.components.EmergencyStopBanner
import com.myraa.companion.ui.theme.EmergencyRed
import com.myraa.companion.ui.theme.MyraaCyan
import com.myraa.companion.ui.theme.MyraaDarkBg
import com.myraa.companion.ui.theme.MyraaPink
import com.myraa.companion.ui.theme.MyraaPurple
import com.myraa.companion.ui.theme.MyraaSurface
import com.myraa.companion.ui.theme.MyraaSurfaceElevated
import com.myraa.companion.ui.theme.StatusAmber
import com.myraa.companion.ui.theme.StatusGreen
import com.myraa.companion.ui.theme.TextMuted
import com.myraa.companion.ui.theme.TextPrimary
import com.myraa.companion.ui.theme.TextSecondary

@Composable
fun MainSessionScreen(
    connectionStatus: ConnectionStatus,
    isVoiceActive: Boolean,
    isMicMuted: Boolean,
    isModelSpeaking: Boolean = false,
    isUserSpeaking: Boolean = false,
    permissionRationale: String? = null,
    isPermanentlyDenied: Boolean = false,
    emergencyStopState: EmergencyStopState,
    transcripts: List<TranscriptItem>,
    canResetEmergencyStop: Boolean,
    onToggleVoice: () -> Unit,
    onToggleMute: () -> Unit,
    onSendText: (String) -> Unit,
    onRequestPermissionAgain: () -> Unit = {},
    onOpenAppSettings: () -> Unit = {},
    onDismissPermissionRationale: () -> Unit = {},
    onTriggerEmergencyStop: () -> Unit,
    onResetEmergencyStop: () -> Unit,
    onOpenSettings: () -> Unit,
    modifier: Modifier = Modifier
) {
    val listState = rememberLazyListState()
    var inputText by remember { mutableStateOf("") }

    // Auto-scroll transcript when new items arrive
    LaunchedEffect(transcripts.size) {
        if (transcripts.isNotEmpty()) {
            listState.animateScrollToItem(transcripts.size - 1)
        }
    }

    Column(
        modifier = modifier
            .fillMaxSize()
            .background(MyraaDarkBg)
            .padding(horizontal = 16.dp, vertical = 12.dp)
    ) {
        // Top Bar
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(vertical = 4.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = "MYRAA",
                    color = MyraaCyan,
                    fontWeight = FontWeight.Bold,
                    fontSize = 20.sp,
                    fontFamily = FontFamily.Monospace
                )
                Spacer(modifier = Modifier.width(8.dp))
                ConnectionBadge(status = connectionStatus)
            }

            IconButton(onClick = onOpenSettings) {
                Text(
                    text = "⚙",
                    color = TextSecondary,
                    fontSize = 22.sp
                )
            }
        }

        Spacer(modifier = Modifier.height(8.dp))

        // Emergency Stop Banner / Button
        EmergencyStopBanner(
            state = emergencyStopState,
            onTrigger = onTriggerEmergencyStop,
            onReset = onResetEmergencyStop,
            canReset = canResetEmergencyStop
        )

        // Permission Rationale Banner (if user denied RECORD_AUDIO)
        if (permissionRationale != null) {
            Spacer(modifier = Modifier.height(8.dp))
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(12.dp))
                    .background(EmergencyRed.copy(alpha = 0.15f))
                    .padding(12.dp)
            ) {
                Column {
                    Text(
                        text = "Microphone Permission Required",
                        color = EmergencyRed,
                        fontSize = 13.sp,
                        fontWeight = FontWeight.Bold
                    )
                    Spacer(modifier = Modifier.height(4.dp))
                    Text(
                        text = permissionRationale,
                        color = TextPrimary,
                        fontSize = 12.sp,
                        lineHeight = 16.sp
                    )
                    Spacer(modifier = Modifier.height(8.dp))
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.End
                    ) {
                        Button(
                            onClick = onDismissPermissionRationale,
                            colors = ButtonDefaults.buttonColors(containerColor = MyraaSurfaceElevated),
                            shape = RoundedCornerShape(16.dp),
                            modifier = Modifier.height(34.dp)
                        ) {
                            Text("DISMISS", color = TextSecondary, fontSize = 11.sp)
                        }
                        Spacer(modifier = Modifier.width(8.dp))
                        Button(
                            onClick = if (isPermanentlyDenied) onOpenAppSettings else onRequestPermissionAgain,
                            colors = ButtonDefaults.buttonColors(containerColor = MyraaCyan),
                            shape = RoundedCornerShape(16.dp),
                            modifier = Modifier.height(34.dp)
                        ) {
                            Text(
                                text = if (isPermanentlyDenied) "OPEN SETTINGS" else "GRANT ACCESS",
                                color = MyraaDarkBg,
                                fontSize = 11.sp,
                                fontWeight = FontWeight.Bold
                            )
                        }
                    }
                }
            }
        }

        Spacer(modifier = Modifier.height(8.dp))

        // Avatar Visualizer
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .padding(vertical = 4.dp),
            contentAlignment = Alignment.Center
        ) {
            AvatarVisualizer(
                isVoiceActive = isVoiceActive && !isMicMuted,
                isEmergencyStop = emergencyStopState.active
            )
        }

        // Live Voice State Indicator (Barge-in / Speaking / Listening)
        if (isVoiceActive) {
            val (pillColor, pillText) = when {
                isMicMuted -> StatusAmber to "MIC MUTED"
                isUserSpeaking -> MyraaCyan to "USER SPEAKING..."
                isModelSpeaking -> MyraaPurple to "MYRAA SPEAKING..."
                else -> StatusGreen to "LISTENING..."
            }
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(vertical = 4.dp),
                horizontalArrangement = Arrangement.Center
            ) {
                Box(
                    modifier = Modifier
                        .clip(RoundedCornerShape(12.dp))
                        .background(pillColor.copy(alpha = 0.15f))
                        .padding(horizontal = 12.dp, vertical = 4.dp)
                ) {
                    Text(
                        text = pillText,
                        color = pillColor,
                        fontSize = 11.sp,
                        fontWeight = FontWeight.Bold,
                        letterSpacing = 1.sp
                    )
                }
            }
        }

        Spacer(modifier = Modifier.height(8.dp))

        // Voice Controls
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Button(
                onClick = onToggleVoice,
                colors = ButtonDefaults.buttonColors(
                    containerColor = if (isVoiceActive) EmergencyRed else MyraaCyan
                ),
                shape = RoundedCornerShape(24.dp),
                enabled = connectionStatus == ConnectionStatus.AUTHENTICATED && !emergencyStopState.active,
                modifier = Modifier.height(46.dp)
            ) {
                Text(
                    text = if (isVoiceActive) "END VOICE SESSION" else "START VOICE SESSION",
                    color = if (isVoiceActive) Color.White else MyraaDarkBg,
                    fontWeight = FontWeight.Bold,
                    fontSize = 13.sp
                )
            }

            if (isVoiceActive) {
                Spacer(modifier = Modifier.width(12.dp))
                Button(
                    onClick = onToggleMute,
                    colors = ButtonDefaults.buttonColors(
                        containerColor = if (isMicMuted) StatusAmber else MyraaSurfaceElevated
                    ),
                    shape = RoundedCornerShape(24.dp),
                    modifier = Modifier.height(46.dp)
                ) {
                    Text(
                        text = if (isMicMuted) "UNMUTE" else "MUTE",
                        color = TextPrimary,
                        fontWeight = FontWeight.SemiBold,
                        fontSize = 13.sp
                    )
                }
            }
        }

        Spacer(modifier = Modifier.height(12.dp))

        // Transcript Header
        Text(
            text = "LIVE TRANSCRIPT",
            color = TextMuted,
            fontSize = 11.sp,
            fontWeight = FontWeight.Bold,
            letterSpacing = 1.sp,
            modifier = Modifier.padding(start = 4.dp, bottom = 4.dp)
        )

        // Transcript Stream Box
        Box(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth()
                .clip(RoundedCornerShape(12.dp))
                .background(MyraaSurface)
                .padding(10.dp)
        ) {
            if (transcripts.isEmpty()) {
                Box(
                    modifier = Modifier.fillMaxSize(),
                    contentAlignment = Alignment.Center
                ) {
                    Text(
                        text = if (isVoiceActive) "Listening... speak into your microphone" else "Start a voice session or send text below",
                        color = TextMuted,
                        fontSize = 13.sp
                    )
                }
            } else {
                LazyColumn(
                    state = listState,
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                    modifier = Modifier.fillMaxSize()
                ) {
                    items(transcripts, key = { it.id }) { item ->
                        TranscriptBubble(item = item)
                    }
                }
            }
        }

        Spacer(modifier = Modifier.height(8.dp))

        // Quick Text Command Bar
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically
        ) {
            OutlinedTextField(
                value = inputText,
                onValueChange = { inputText = it },
                placeholder = { Text("Send text to MYRAA...", fontSize = 13.sp) },
                singleLine = true,
                enabled = connectionStatus == ConnectionStatus.AUTHENTICATED && !emergencyStopState.active,
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = MyraaCyan,
                    unfocusedBorderColor = Color(0xFF2A2D40),
                    focusedTextColor = TextPrimary,
                    unfocusedTextColor = TextPrimary,
                    cursorColor = MyraaCyan
                ),
                shape = RoundedCornerShape(20.dp),
                modifier = Modifier.weight(1f)
            )

            Spacer(modifier = Modifier.width(8.dp))

            Button(
                onClick = {
                    if (inputText.isNotBlank()) {
                        onSendText(inputText.trim())
                        inputText = ""
                    }
                },
                enabled = inputText.isNotBlank() && connectionStatus == ConnectionStatus.AUTHENTICATED,
                colors = ButtonDefaults.buttonColors(containerColor = MyraaPurple),
                shape = CircleShape,
                modifier = Modifier.size(44.dp)
            ) {
                Text("➤", color = TextPrimary, fontSize = 16.sp)
            }
        }
    }
}

@Composable
fun ConnectionBadge(status: ConnectionStatus) {
    val (color, label) = when (status) {
        ConnectionStatus.AUTHENTICATED -> StatusGreen to "Connected"
        ConnectionStatus.CONNECTING -> StatusAmber to "Connecting"
        ConnectionStatus.RECONNECTING -> StatusAmber to "Reconnecting"
        ConnectionStatus.DISCONNECTED -> TextMuted to "Disconnected"
        ConnectionStatus.ERROR -> EmergencyRed to "Error"
    }

    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .clip(RoundedCornerShape(8.dp))
            .background(color.copy(alpha = 0.15f))
            .padding(horizontal = 8.dp, vertical = 3.dp)
    ) {
        Box(
            modifier = Modifier
                .size(6.dp)
                .clip(CircleShape)
                .background(color)
        )
        Spacer(modifier = Modifier.width(5.dp))
        Text(
            text = label,
            color = color,
            fontSize = 11.sp,
            fontWeight = FontWeight.Medium
        )
    }
}

@Composable
fun TranscriptBubble(item: TranscriptItem) {
    val isUser = item.sender == TranscriptItem.Speaker.USER
    val alignment = if (isUser) Alignment.End else Alignment.Start
    val bgColor = if (isUser) MyraaPurple.copy(alpha = 0.25f) else Color(0xFF1E2235)
    val labelColor = if (isUser) MyraaPink else MyraaCyan

    Column(
        horizontalAlignment = alignment,
        modifier = Modifier.fillMaxWidth()
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = if (isUser) "YOU" else "MYRAA",
                color = labelColor,
                fontSize = 10.sp,
                fontWeight = FontWeight.Bold,
                fontFamily = FontFamily.Monospace
            )
        }
        Spacer(modifier = Modifier.height(2.dp))
        Box(
            modifier = Modifier
                .clip(RoundedCornerShape(10.dp))
                .background(bgColor)
                .padding(horizontal = 12.dp, vertical = 8.dp)
        ) {
            Text(
                text = item.text,
                color = TextPrimary,
                fontSize = 13.sp,
                lineHeight = 18.sp
            )
        }
    }
}
