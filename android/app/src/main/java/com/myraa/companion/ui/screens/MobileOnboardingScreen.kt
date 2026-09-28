package com.myraa.companion.ui.screens

import android.os.Build
import androidx.compose.foundation.background
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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
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
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.myraa.companion.ui.components.AvatarVisualizer
import com.myraa.companion.ui.theme.MyraaCyan
import com.myraa.companion.ui.theme.MyraaDarkBg
import com.myraa.companion.ui.theme.MyraaPurple
import com.myraa.companion.ui.theme.MyraaSurface
import com.myraa.companion.ui.theme.MyraaSurfaceElevated
import com.myraa.companion.ui.theme.StatusGreen
import com.myraa.companion.ui.theme.TextMuted
import com.myraa.companion.ui.theme.TextPrimary
import com.myraa.companion.ui.theme.TextSecondary

/**
 * MobileOnboardingScreen
 * Phase 13A — Standalone Mobile AI Assistant Onboarding
 *
 * Presented on first launch of MYRAA Android APK.
 * Configures voice, permissions, privacy shield, and optional account identity,
 * then launches directly into the standalone MYRAA Mobile assistant without
 * requiring any Desktop pairing PIN or PC connection.
 */
@Composable
fun MobileOnboardingScreen(
    initialLanguage: String = "en-IN",
    initialPrivacyShield: Boolean = true,
    initialScreenApproved: Boolean = false,
    initialLocalOnly: Boolean = false,
    initialAccountId: String = "",
    hasMicPermission: Boolean = false,
    onRequestMicPermission: () -> Unit,
    onCompleteOnboarding: (
        preferredLanguage: String,
        privacyShieldEnabled: Boolean,
        screenContextApproved: Boolean,
        localOnlyMode: Boolean,
        accountId: String?
    ) -> Unit,
    onSkipOnboarding: () -> Unit,
    modifier: Modifier = Modifier
) {
    var selectedLanguage by remember { mutableStateOf(initialLanguage) }
    var privacyShieldEnabled by remember { mutableStateOf(initialPrivacyShield) }
    var screenContextApproved by remember { mutableStateOf(initialScreenApproved) }
    var localOnlyMode by remember { mutableStateOf(initialLocalOnly) }
    var accountId by remember { mutableStateOf(initialAccountId) }
    val scrollState = rememberScrollState()

    Column(
        modifier = modifier
            .fillMaxSize()
            .background(MyraaDarkBg)
            .verticalScroll(scrollState)
            .padding(horizontal = 20.dp, vertical = 16.dp),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        // Top Header with Skip
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Box(
                modifier = Modifier
                    .clip(RoundedCornerShape(8.dp))
                    .background(StatusGreen.copy(alpha = 0.15f))
                    .padding(horizontal = 10.dp, vertical = 4.dp)
            ) {
                Text(
                    text = "STANDALONE PHONE AI",
                    color = StatusGreen,
                    fontSize = 11.sp,
                    fontWeight = FontWeight.Bold,
                    fontFamily = FontFamily.Monospace
                )
            }

            TextButton(onClick = onSkipOnboarding) {
                Text(
                    text = "SKIP SETUP →",
                    color = MyraaCyan,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Bold
                )
            }
        }

        Spacer(modifier = Modifier.height(8.dp))

        AvatarVisualizer(
            isVoiceActive = false,
            isEmergencyStop = false
        )

        Spacer(modifier = Modifier.height(10.dp))

        Text(
            text = "Welcome to MYRAA Mobile",
            color = MyraaCyan,
            fontSize = 24.sp,
            fontWeight = FontWeight.Bold,
            fontFamily = FontFamily.Monospace,
            textAlign = TextAlign.Center
        )

        Spacer(modifier = Modifier.height(4.dp))

        Text(
            text = "Your full standalone phone AI assistant for voice, apps, YouTube, web, alarms, reminders & memory. No Desktop pairing required.",
            color = TextSecondary,
            fontSize = 13.sp,
            textAlign = TextAlign.Center,
            lineHeight = 18.sp
        )

        Spacer(modifier = Modifier.height(16.dp))

        // Step 1: Voice & Microphone Setup
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(12.dp))
                .background(MyraaSurface)
                .padding(14.dp)
        ) {
            Column {
                Text(
                    text = "1. VOICE & LANGUAGE",
                    color = MyraaCyan,
                    fontSize = 11.sp,
                    fontWeight = FontWeight.Bold,
                    letterSpacing = 1.sp
                )
                Spacer(modifier = Modifier.height(8.dp))
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            text = "Microphone Access",
                            color = TextPrimary,
                            fontSize = 13.sp,
                            fontWeight = FontWeight.SemiBold
                        )
                        Text(
                            text = if (hasMicPermission) "Granted — Ready for Gemini Live Voice" else "Optional now — Grant for hands-free voice",
                            color = if (hasMicPermission) StatusGreen else TextMuted,
                            fontSize = 11.sp
                        )
                    }
                    Button(
                        onClick = onRequestMicPermission,
                        colors = ButtonDefaults.buttonColors(
                            containerColor = if (hasMicPermission) StatusGreen.copy(alpha = 0.25f) else MyraaSurfaceElevated
                        ),
                        shape = RoundedCornerShape(16.dp),
                        modifier = Modifier.height(34.dp)
                    ) {
                        Text(
                            text = if (hasMicPermission) "ENABLED ✓" else "ALLOW MIC",
                            color = if (hasMicPermission) StatusGreen else MyraaCyan,
                            fontSize = 11.sp,
                            fontWeight = FontWeight.Bold
                        )
                    }
                }

                Spacer(modifier = Modifier.height(10.dp))

                Text(
                    text = "Preferred Voice Language",
                    color = TextSecondary,
                    fontSize = 12.sp
                )
                Spacer(modifier = Modifier.height(6.dp))
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    listOf("en-IN" to "English (IN)", "hinglish" to "Hinglish", "hi-IN" to "Hindi").forEach { (code, label) ->
                        val isSelected = selectedLanguage == code
                        Box(
                            modifier = Modifier
                                .weight(1f)
                                .clip(RoundedCornerShape(8.dp))
                                .background(if (isSelected) MyraaCyan.copy(alpha = 0.2f) else MyraaSurfaceElevated)
                                .clickable { selectedLanguage = code }
                                .padding(vertical = 8.dp),
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
        }

        Spacer(modifier = Modifier.height(12.dp))

        // Step 2: Privacy & Phone Capabilities
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(12.dp))
                .background(MyraaSurface)
                .padding(14.dp)
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    text = "2. PRIVACY & CAPABILITY PERMISSIONS",
                    color = MyraaCyan,
                    fontSize = 11.sp,
                    fontWeight = FontWeight.Bold,
                    letterSpacing = 1.sp
                )

                OnboardingToggleRow(
                    title = "Privacy Shield (PII & OTP Redaction)",
                    subtitle = "Automatically masks OTPs, passwords, banking & sensitive tokens",
                    checked = privacyShieldEnabled,
                    onCheckedChange = { privacyShieldEnabled = it }
                )

                OnboardingToggleRow(
                    title = "Screen Context Understanding",
                    subtitle = "Allow MYRAA to summarize on-screen content when you ask",
                    checked = screenContextApproved,
                    onCheckedChange = { screenContextApproved = it }
                )

                OnboardingToggleRow(
                    title = "Local-Only Processing Mode",
                    subtitle = "Keep all phone commands on-device without cloud AI turns",
                    checked = localOnlyMode,
                    onCheckedChange = { localOnlyMode = it }
                )
            }
        }

        Spacer(modifier = Modifier.height(12.dp))

        // Step 3: Optional Account / Profile Setup
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(12.dp))
                .background(MyraaSurface)
                .padding(14.dp)
        ) {
            Column {
                Text(
                    text = "3. PROFILE / ACCOUNT (OPTIONAL)",
                    color = MyraaCyan,
                    fontSize = 11.sp,
                    fontWeight = FontWeight.Bold,
                    letterSpacing = 1.sp
                )
                Spacer(modifier = Modifier.height(6.dp))
                OutlinedTextField(
                    value = accountId,
                    onValueChange = { accountId = it },
                    label = { Text("Your Name or Account ID (Optional)") },
                    placeholder = { Text("e.g. ${Build.MANUFACTURER} ${Build.MODEL} User") },
                    singleLine = true,
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedBorderColor = MyraaCyan,
                        unfocusedBorderColor = Color(0xFF2A2D40),
                        focusedTextColor = TextPrimary,
                        unfocusedTextColor = TextPrimary,
                        focusedLabelColor = MyraaCyan,
                        unfocusedLabelColor = TextMuted
                    ),
                    modifier = Modifier.fillMaxWidth()
                )
            }
        }

        Spacer(modifier = Modifier.height(18.dp))

        Button(
            onClick = {
                onCompleteOnboarding(
                    selectedLanguage,
                    privacyShieldEnabled,
                    screenContextApproved,
                    localOnlyMode,
                    accountId.takeIf { it.isNotBlank() }
                )
            },
            colors = ButtonDefaults.buttonColors(containerColor = MyraaCyan),
            shape = RoundedCornerShape(12.dp),
            modifier = Modifier
                .fillMaxWidth()
                .height(52.dp)
        ) {
            Text(
                text = "START USING MYRAA",
                color = MyraaDarkBg,
                fontWeight = FontWeight.Bold,
                fontSize = 15.sp,
                letterSpacing = 1.sp
            )
        }

        Spacer(modifier = Modifier.height(8.dp))

        Text(
            text = "Optional Desktop PC pairing is available anytime in Settings → Devices → Connect Desktop.",
            color = TextMuted,
            fontSize = 11.sp,
            textAlign = TextAlign.Center
        )
    }
}

@Composable
private fun OnboardingToggleRow(
    title: String,
    subtitle: String,
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = title,
                color = TextPrimary,
                fontSize = 13.sp,
                fontWeight = FontWeight.Medium
            )
            Text(
                text = subtitle,
                color = TextMuted,
                fontSize = 11.sp,
                lineHeight = 14.sp
            )
        }
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
