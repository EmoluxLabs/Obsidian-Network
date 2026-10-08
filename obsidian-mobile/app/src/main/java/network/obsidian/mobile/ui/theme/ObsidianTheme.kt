package network.obsidian.mobile.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable

/**
 * The Obsidian theme.
 *
 * The supplied design is light-only: every one of the 18 artboards is the
 * #F6F7F9 canvas with white cards and #0B0D10 ink. There is no dark artboard, so
 * this does not invent one — a device in dark mode still gets the design the
 * client asked for. Adding a dark palette would mean inventing colours the
 * design never specified, which is exactly the drift this file exists to stop.
 */
private val ObsidianColorScheme = lightColorScheme(
    primary = ObsidianColors.Ink,
    onPrimary = ObsidianColors.Surface,
    primaryContainer = ObsidianColors.Ink,
    onPrimaryContainer = ObsidianColors.Surface,
    secondary = ObsidianColors.Gold,
    onSecondary = ObsidianColors.Ink,
    secondaryContainer = ObsidianColors.GoldPillFill,
    onSecondaryContainer = ObsidianColors.GoldText,
    tertiary = ObsidianColors.Success,
    onTertiary = ObsidianColors.Surface,
    background = ObsidianColors.Canvas,
    onBackground = ObsidianColors.Text,
    surface = ObsidianColors.Surface,
    onSurface = ObsidianColors.Text,
    surfaceVariant = ObsidianColors.Canvas,
    onSurfaceVariant = ObsidianColors.Muted,
    outline = ObsidianColors.Border,
    outlineVariant = ObsidianColors.Divider,
    error = ObsidianColors.Danger,
    onError = ObsidianColors.Surface,
    errorContainer = ObsidianColors.DangerFill,
    onErrorContainer = ObsidianColors.Danger,
)

private val ObsidianTypography = Typography(
    displayLarge = ObsidianType.Hero,
    headlineMedium = ObsidianType.Statement,
    titleLarge = ObsidianType.CardTitle,
    titleMedium = ObsidianType.Value,
    bodyLarge = ObsidianType.Body,
    bodyMedium = ObsidianType.Support,
    labelLarge = ObsidianType.Button,
    labelMedium = ObsidianType.Label,
    labelSmall = ObsidianType.Kicker,
)

@Composable
fun ObsidianTheme(content: @Composable () -> Unit) {
    // Deliberately does not branch on the system dark-mode setting: see above.
    MaterialTheme(
        colorScheme = ObsidianColorScheme,
        typography = ObsidianTypography,
        content = content,
    )
}
