package com.myraa.companion.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.myraa.companion.networking.EmergencyStopState
import com.myraa.companion.ui.theme.EmergencyRed
import com.myraa.companion.ui.theme.EmergencyRedDark

@Composable
fun EmergencyStopBanner(
    state: EmergencyStopState,
    onTrigger: () -> Unit,
    onReset: () -> Unit,
    canReset: Boolean,
    modifier: Modifier = Modifier
) {
    if (state.active) {
        Column(
            modifier = modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(12.dp))
                .background(EmergencyRedDark)
                .padding(14.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Text(
                text = "EMERGENCY STOP ACTIVE",
                color = Color.White,
                fontWeight = FontWeight.Bold,
                fontSize = 15.sp,
                letterSpacing = 1.sp
            )
            if (!state.reason.isNullOrBlank()) {
                Spacer(modifier = Modifier.height(4.dp))
                Text(
                    text = state.reason,
                    color = Color(0xFFFFCDD2),
                    fontSize = 12.sp
                )
            }
            if (canReset) {
                Spacer(modifier = Modifier.height(8.dp))
                Button(
                    onClick = onReset,
                    colors = ButtonDefaults.buttonColors(containerColor = EmergencyRed),
                    shape = RoundedCornerShape(8.dp)
                ) {
                    Text("RESET EMERGENCY STOP", color = Color.White, fontWeight = FontWeight.Bold)
                }
            }
        }
    } else {
        Button(
            onClick = onTrigger,
            colors = ButtonDefaults.buttonColors(containerColor = EmergencyRed),
            shape = RoundedCornerShape(12.dp),
            modifier = modifier.fillMaxWidth()
        ) {
            Row(
                horizontalArrangement = Arrangement.Center,
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.padding(vertical = 4.dp)
            ) {
                Text(
                    text = "EMERGENCY STOP",
                    color = Color.White,
                    fontWeight = FontWeight.Bold,
                    fontSize = 14.sp,
                    letterSpacing = 1.sp
                )
            }
        }
    }
}
