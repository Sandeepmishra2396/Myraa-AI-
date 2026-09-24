package com.myraa.companion.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable

private val DarkColorScheme = darkColorScheme(
    primary = MyraaCyan,
    secondary = MyraaPurple,
    tertiary = MyraaPink,
    background = MyraaDarkBg,
    surface = MyraaSurface,
    surfaceVariant = MyraaSurfaceElevated,
    onPrimary = MyraaDarkBg,
    onSecondary = TextPrimary,
    onBackground = TextPrimary,
    onSurface = TextPrimary,
    error = EmergencyRed
)

@Composable
fun MyraaTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = DarkColorScheme,
        content = content
    )
}
