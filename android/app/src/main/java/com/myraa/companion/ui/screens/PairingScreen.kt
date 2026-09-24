package com.myraa.companion.ui.screens

import android.os.Build
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
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
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.myraa.companion.ui.components.AvatarVisualizer
import com.myraa.companion.ui.theme.EmergencyRed
import com.myraa.companion.ui.theme.MyraaCyan
import com.myraa.companion.ui.theme.MyraaDarkBg
import com.myraa.companion.ui.theme.MyraaPurple
import com.myraa.companion.ui.theme.MyraaSurface
import com.myraa.companion.ui.theme.TextMuted
import com.myraa.companion.ui.theme.TextPrimary
import com.myraa.companion.ui.theme.TextSecondary

@Composable
fun PairingScreen(
    initialHost: String,
    initialPort: Int,
    isLoading: Boolean,
    errorMessage: String?,
    onPairRequested: (code: String, host: String, port: Int, deviceName: String) -> Unit,
    modifier: Modifier = Modifier
) {
    var pinCode by remember { mutableStateOf("") }
    var host by remember { mutableStateOf(initialHost) }
    var portStr by remember { mutableStateOf(initialPort.toString()) }
    var deviceName by remember { mutableStateOf("${Build.MANUFACTURER} ${Build.MODEL}") }

    Box(
        modifier = modifier
            .fillMaxSize()
            .background(MyraaDarkBg)
            .padding(24.dp),
        contentAlignment = Alignment.Center
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
            modifier = Modifier.fillMaxWidth()
        ) {
            AvatarVisualizer(
                isVoiceActive = false,
                isEmergencyStop = false
            )

            Spacer(modifier = Modifier.height(16.dp))

            Text(
                text = "MYRAA",
                color = MyraaCyan,
                fontSize = 28.sp,
                fontWeight = FontWeight.Bold,
                letterSpacing = 2.sp,
                fontFamily = FontFamily.Monospace
            )

            Text(
                text = "Mobile Companion Pairing",
                color = TextSecondary,
                fontSize = 14.sp
            )

            Spacer(modifier = Modifier.height(24.dp))

            // PIN Code Field
            OutlinedTextField(
                value = pinCode,
                onValueChange = {
                    if (it.length <= 6) pinCode = it.uppercase()
                },
                label = { Text("6-CHARACTER PIN CODE") },
                placeholder = { Text("e.g. SR8492") },
                singleLine = true,
                maxLines = 1,
                keyboardOptions = KeyboardOptions(
                    capitalization = KeyboardCapitalization.Characters,
                    keyboardType = KeyboardType.Ascii,
                    imeAction = ImeAction.Done
                ),
                keyboardActions = KeyboardActions(
                    onDone = {
                        val port = portStr.toIntOrNull() ?: initialPort
                        if (pinCode.length == 6) {
                            onPairRequested(pinCode, host, port, deviceName)
                        }
                    }
                ),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = MyraaCyan,
                    unfocusedBorderColor = MyraaPurple,
                    focusedTextColor = TextPrimary,
                    unfocusedTextColor = TextPrimary,
                    focusedLabelColor = MyraaCyan,
                    unfocusedLabelColor = TextMuted,
                    cursorColor = MyraaCyan
                ),
                modifier = Modifier.fillMaxWidth()
            )

            Spacer(modifier = Modifier.height(12.dp))

            // Host & Port Row
            Row(modifier = Modifier.fillMaxWidth()) {
                OutlinedTextField(
                    value = host,
                    onValueChange = { host = it },
                    label = { Text("Host IP") },
                    singleLine = true,
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedBorderColor = MyraaCyan,
                        unfocusedBorderColor = Color(0xFF2A2D40),
                        focusedTextColor = TextPrimary,
                        unfocusedTextColor = TextPrimary,
                        focusedLabelColor = MyraaCyan,
                        unfocusedLabelColor = TextMuted
                    ),
                    modifier = Modifier.weight(2f)
                )

                Spacer(modifier = Modifier.width(8.dp))

                OutlinedTextField(
                    value = portStr,
                    onValueChange = { portStr = it },
                    label = { Text("Port") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedBorderColor = MyraaCyan,
                        unfocusedBorderColor = Color(0xFF2A2D40),
                        focusedTextColor = TextPrimary,
                        unfocusedTextColor = TextPrimary,
                        focusedLabelColor = MyraaCyan,
                        unfocusedLabelColor = TextMuted
                    ),
                    modifier = Modifier.weight(1f)
                )
            }

            Spacer(modifier = Modifier.height(12.dp))

            // Device Name
            OutlinedTextField(
                value = deviceName,
                onValueChange = { deviceName = it },
                label = { Text("Device Name") },
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

            if (!errorMessage.isNullOrBlank()) {
                Spacer(modifier = Modifier.height(12.dp))
                Text(
                    text = errorMessage,
                    color = EmergencyRed,
                    fontSize = 13.sp,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth()
                )
            }

            Spacer(modifier = Modifier.height(20.dp))

            Button(
                onClick = {
                    val port = portStr.toIntOrNull() ?: initialPort
                    onPairRequested(pinCode, host, port, deviceName)
                },
                enabled = pinCode.isNotBlank() && !isLoading,
                colors = ButtonDefaults.buttonColors(
                    containerColor = MyraaCyan,
                    disabledContainerColor = Color(0xFF1E2833)
                ),
                shape = RoundedCornerShape(12.dp),
                modifier = Modifier
                    .fillMaxWidth()
                    .height(50.dp)
            ) {
                if (isLoading) {
                    CircularProgressIndicator(
                        color = MyraaDarkBg,
                        modifier = Modifier.size(24.dp),
                        strokeWidth = 2.5.dp
                    )
                } else {
                    Text(
                        text = "CONNECT & PAIR",
                        color = MyraaDarkBg,
                        fontWeight = FontWeight.Bold,
                        fontSize = 15.sp,
                        letterSpacing = 1.sp
                    )
                }
            }

            Spacer(modifier = Modifier.height(16.dp))

            Text(
                text = "Generate a pairing PIN on Desktop MYRAA via Settings or REST endpoint.",
                color = TextMuted,
                fontSize = 12.sp,
                textAlign = TextAlign.Center
            )
        }
    }
}
