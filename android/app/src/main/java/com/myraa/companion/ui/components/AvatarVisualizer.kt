package com.myraa.companion.ui.components

import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.myraa.companion.ui.theme.EmergencyRed
import com.myraa.companion.ui.theme.MyraaCyan
import com.myraa.companion.ui.theme.MyraaDarkBg
import com.myraa.companion.ui.theme.MyraaPurple

@Composable
fun AvatarVisualizer(
    isVoiceActive: Boolean,
    isEmergencyStop: Boolean,
    modifier: Modifier = Modifier
) {
    val infiniteTransition = rememberInfiniteTransition(label = "pulse")
    val pulseScale by infiniteTransition.animateFloat(
        initialValue = 0.95f,
        targetValue = if (isVoiceActive) 1.15f else 1.02f,
        animationSpec = infiniteRepeatable(
            animation = tween(if (isVoiceActive) 800 else 2000, easing = FastOutSlowInEasing),
            repeatMode = RepeatMode.Reverse
        ),
        label = "pulseScale"
    )

    val primaryColor = when {
        isEmergencyStop -> EmergencyRed
        isVoiceActive -> MyraaCyan
        else -> MyraaPurple
    }

    Box(
        modifier = modifier.size(160.dp),
        contentAlignment = Alignment.Center
    ) {
        Canvas(modifier = Modifier.size(160.dp * pulseScale)) {
            drawCircle(
                brush = Brush.radialGradient(
                    colors = listOf(
                        primaryColor.copy(alpha = 0.35f),
                        primaryColor.copy(alpha = 0.05f),
                        Color.Transparent
                    )
                ),
                radius = size.minDimension / 2
            )
            drawCircle(
                color = primaryColor.copy(alpha = 0.6f),
                radius = size.minDimension / 2.3f,
                style = Stroke(width = 3.dp.toPx())
            )
        }

        Box(
            modifier = Modifier
                .size(90.dp)
                .clip(CircleShape)
                .background(
                    Brush.linearGradient(
                        colors = if (isEmergencyStop) {
                            listOf(EmergencyRed, Color(0xFF5A0010))
                        } else {
                            listOf(MyraaPurple, MyraaCyan)
                        }
                    )
                ),
            contentAlignment = Alignment.Center
        ) {
            Text(
                text = if (isEmergencyStop) "HALT" else "M",
                color = MyraaDarkBg,
                fontSize = 32.sp,
                fontWeight = FontWeight.Bold,
                fontFamily = FontFamily.Monospace
            )
        }
    }
}
