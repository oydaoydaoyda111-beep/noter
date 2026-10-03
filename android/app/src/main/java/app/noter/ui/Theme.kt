package app.noter.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

/** Colors from the web app's `src/styles/tokens.css`; the app is dark-only, like the web app. */
object NoterColors {
    val background = Color(0xFF0E1215)
    val editorBackground = Color(0xFF191D21)
    val surface = Color(0xFF141B21)
    val surfaceRaised = Color(0xFF22282E)
    val dialog = Color(0xFF202830)
    val border = Color(0xFF262B30)
    val borderStrong = Color(0xFF30353A)
    val textPrimary = Color(0xFFE5E9ED)
    val textBody = Color(0xFFBBC2CA)
    val textSecondary = Color(0xFF9AA7B3)
    val editorText = Color(0xFFC1CAD3)
    val caret = Color(0xFFBDD6E4)
    val danger = Color(0xFFE6A19F)
    val positive = Color(0xFFA0CDB7)
    val onAccent = Color(0xFF1B2933)
}

@Composable
fun NoterTheme(accent: String, content: @Composable () -> Unit) {
    val primary = when (accent) {
        "green" -> Color(0xFFB0D4BA)
        "purple" -> Color(0xFFC5B6E4)
        else -> Color(0xFFADCBD8)
    }
    // --accent-dim composited over the editor background, so it stays opaque in Material components.
    val accentDim = when (accent) {
        "green" -> Color(0xFF263330)
        "purple" -> Color(0xFF2C2B37)
        else -> Color(0xFF252E35)
    }
    val colors = darkColorScheme(
        primary = primary,
        onPrimary = NoterColors.onAccent,
        primaryContainer = accentDim,
        onPrimaryContainer = primary,
        secondary = primary,
        onSecondary = NoterColors.onAccent,
        secondaryContainer = accentDim,
        onSecondaryContainer = primary,
        tertiary = primary,
        onTertiary = NoterColors.onAccent,
        background = NoterColors.editorBackground,
        onBackground = NoterColors.textPrimary,
        surface = NoterColors.editorBackground,
        onSurface = NoterColors.textPrimary,
        surfaceVariant = NoterColors.surfaceRaised,
        onSurfaceVariant = NoterColors.textSecondary,
        surfaceTint = Color.Transparent,
        surfaceDim = NoterColors.background,
        surfaceBright = NoterColors.surfaceRaised,
        surfaceContainerLowest = NoterColors.background,
        surfaceContainerLow = NoterColors.surface,
        surfaceContainer = NoterColors.surface,
        surfaceContainerHigh = NoterColors.dialog,
        surfaceContainerHighest = NoterColors.surfaceRaised,
        inverseSurface = NoterColors.textPrimary,
        inverseOnSurface = NoterColors.background,
        outline = NoterColors.borderStrong,
        outlineVariant = NoterColors.border,
        error = NoterColors.danger,
        onError = NoterColors.onAccent,
        scrim = Color(0x99000000),
    )
    MaterialTheme(colorScheme = colors, content = content)
}
