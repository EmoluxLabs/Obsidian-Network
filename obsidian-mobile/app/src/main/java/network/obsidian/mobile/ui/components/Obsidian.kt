package network.obsidian.mobile.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ArrowForward
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import network.obsidian.mobile.ui.theme.ObsidianColors
import network.obsidian.mobile.ui.theme.ObsidianMetrics
import network.obsidian.mobile.ui.theme.ObsidianRadius
import network.obsidian.mobile.ui.theme.ObsidianSpace
import network.obsidian.mobile.ui.theme.ObsidianType

/**
 * The design's own primitives.
 *
 * These are not generic Material widgets with a colour applied. Each one
 * reproduces a specific construction that recurs across the 18 artboards — the
 * white card on a #E4E7EB hairline at radius 28, the 58px ink button with a gold
 * icon at each end, the uppercase 0.14em label, the mono pill — so a screen is
 * assembled from the design's parts instead of approximating them.
 */

/** White card on a hairline, with the design's soft shadow. */
@Composable
fun ObsidianCard(
    modifier: Modifier = Modifier,
    radius: Dp = ObsidianRadius.Card,
    padding: Dp = ObsidianSpace.L,
    content: @Composable ColumnScope.() -> Unit,
) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .shadow(
                elevation = 1.dp,
                shape = RoundedCornerShape(radius),
                ambientColor = ObsidianColors.Shadow.copy(alpha = 0.04f),
                spotColor = ObsidianColors.Shadow.copy(alpha = 0.04f),
            )
            .background(ObsidianColors.Surface, RoundedCornerShape(radius))
            .border(BorderStroke(1.dp, ObsidianColors.Border), RoundedCornerShape(radius))
            .padding(padding),
        content = content,
    )
}

/** The dark footer/hero card: ink background, radius 24, light text. */
@Composable
fun ObsidianDarkCard(
    modifier: Modifier = Modifier,
    content: @Composable ColumnScope.() -> Unit,
) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(ObsidianColors.Ink, RoundedCornerShape(24.dp))
            .padding(horizontal = 22.dp, vertical = 26.dp),
        content = content,
    )
}

/**
 * An uppercase label: 12px, weight 700, 0.14em tracking, muted.
 * This is the most repeated element in the whole design.
 */
@Composable
fun SectionLabel(text: String, modifier: Modifier = Modifier, color: Color = ObsidianColors.Muted) {
    Text(text = text.uppercase(), style = ObsidianType.Label, color = color, modifier = modifier)
}

/**
 * The gold kicker with its leading rule, from the Landing hero:
 * "— LAYER-1 · PROOF OF TIME".
 */
@Composable
fun GoldKicker(text: String, modifier: Modifier = Modifier) {
    Row(modifier = modifier, verticalAlignment = Alignment.CenterVertically) {
        Box(
            Modifier
                .width(18.dp)
                .height(2.dp)
                .background(ObsidianColors.Gold),
        )
        Spacer(Modifier.width(ObsidianSpace.XS))
        Text(text.uppercase(), style = ObsidianType.Kicker, color = ObsidianColors.GoldText)
    }
}

/** `.pill` — a borderless, fully-round status chip. Green by default; gold when
 *  [emphasised], matching the wallet screen's name pill. */
@Composable
fun ObsidianPill(
    text: String,
    modifier: Modifier = Modifier,
    emphasised: Boolean = false,
    textColor: Color? = null,
) {
    val fill = if (emphasised) ObsidianColors.GoldPillFill else ObsidianColors.SuccessPillFill
    val content = textColor
        ?: if (emphasised) ObsidianColors.GoldText else ObsidianColors.Success
    Box(
        modifier = modifier
            .background(fill, RoundedCornerShape(ObsidianRadius.Pill))
            .padding(horizontal = 9.dp, vertical = 4.dp),
    ) {
        Text(text, style = ObsidianType.Pill, color = content)
    }
}

/** The live/status dot with its soft halo. */
@Composable
fun StatusDot(color: Color = ObsidianColors.Success, modifier: Modifier = Modifier) {
    Box(
        modifier = modifier
            .size(ObsidianMetrics.StatusDot + 8.dp)
            .background(color.copy(alpha = 0.15f), CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        Box(Modifier.size(ObsidianMetrics.StatusDot).background(color, CircleShape))
    }
}

/**
 * A label/value row inside a card, separated by the design's #EEF0F3 hairline.
 * [value] is rendered in mono when [mono] is true, which is how the design
 * treats every number, hash and address.
 */
@Composable
fun ObsidianRow(
    label: String,
    value: String,
    modifier: Modifier = Modifier,
    mono: Boolean = false,
    valueColor: Color = ObsidianColors.Text,
    divider: Boolean = true,
    trailing: (@Composable () -> Unit)? = null,
) {
    Column(modifier = modifier.fillMaxWidth()) {
        Row(
            Modifier
                .fillMaxWidth()
                .padding(vertical = 14.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            SectionLabel(label)
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = value,
                    style = if (mono) ObsidianType.MonoValue else ObsidianType.Value,
                    color = valueColor,
                    textAlign = TextAlign.End,
                )
                if (trailing != null) {
                    Spacer(Modifier.width(ObsidianSpace.XS))
                    trailing()
                }
            }
        }
        if (divider) {
            Box(Modifier.fillMaxWidth().height(1.dp).background(ObsidianColors.Divider))
        }
    }
}

/**
 * The primary action: 58px, ink fill, radius 16, weight-800 label at 0.12em,
 * with a gold leading icon and a gold trailing arrow — exactly as the Landing
 * artboard builds START MINING.
 */
@Composable
fun PrimaryButton(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    leading: ImageVector? = null,
    showArrow: Boolean = true,
    enabled: Boolean = true,
) {
    ObsidianButton(
        label = label,
        onClick = onClick,
        modifier = modifier,
        height = ObsidianMetrics.PrimaryButtonHeight,
        fill = if (enabled) ObsidianColors.Ink else ObsidianColors.Ink.copy(alpha = 0.45f),
        border = null,
        labelColor = ObsidianColors.Surface,
        iconColor = ObsidianColors.Gold,
        arrowColor = ObsidianColors.Gold,
        leading = leading,
        showArrow = showArrow,
        enabled = enabled,
    )
}

/** White fill, 1.5px #D5D9DF outline, ink label — the design's second button. */
@Composable
fun SecondaryButton(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    leading: ImageVector? = null,
    showArrow: Boolean = true,
    enabled: Boolean = true,
) {
    ObsidianButton(
        label = label,
        onClick = onClick,
        modifier = modifier,
        height = ObsidianMetrics.SecondaryButtonHeight,
        fill = ObsidianColors.Surface,
        border = BorderStroke(1.5.dp, ObsidianColors.BorderStrong),
        labelColor = ObsidianColors.Ink,
        iconColor = ObsidianColors.Ink,
        arrowColor = ObsidianColors.Muted,
        leading = leading,
        showArrow = showArrow,
        enabled = enabled,
    )
}

/** Transparent fill, 1.5px #E4E7EB outline — the design's third button. */
@Composable
fun GhostButton(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    leading: ImageVector? = null,
    showArrow: Boolean = true,
    enabled: Boolean = true,
) {
    ObsidianButton(
        label = label,
        onClick = onClick,
        modifier = modifier,
        height = ObsidianMetrics.SecondaryButtonHeight,
        fill = Color.Transparent,
        border = BorderStroke(1.5.dp, ObsidianColors.Border),
        labelColor = ObsidianColors.Ink,
        iconColor = ObsidianColors.Ink,
        arrowColor = ObsidianColors.Muted,
        leading = leading,
        showArrow = showArrow,
        enabled = enabled,
    )
}

@Composable
private fun ObsidianButton(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier,
    height: Dp,
    fill: Color,
    border: BorderStroke?,
    labelColor: Color,
    iconColor: Color,
    arrowColor: Color,
    leading: ImageVector?,
    showArrow: Boolean,
    enabled: Boolean,
) {
    val shape = RoundedCornerShape(ObsidianRadius.Button)
    val interaction = remember { MutableInteractionSource() }
    var base = modifier
        .fillMaxWidth()
        .height(height)
        .clip(shape)
        .background(fill, shape)
    if (border != null) base = base.border(border, shape)
    if (enabled) base = base.clickable(interactionSource = interaction, indication = null) { onClick() }

    Row(
        modifier = base.padding(horizontal = 22.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (leading != null) {
                Icon(leading, contentDescription = null, tint = iconColor, modifier = Modifier.size(20.dp))
                Spacer(Modifier.width(ObsidianSpace.S))
            }
            Text(label.uppercase(), style = ObsidianType.Button, color = labelColor)
        }
        if (showArrow) {
            Icon(
                Icons.Outlined.ArrowForward,
                contentDescription = null,
                tint = arrowColor,
                modifier = Modifier.size(20.dp),
            )
        }
    }
}

/**
 * The 52px ink icon tile with a gold stroke icon, from the feature rows.
 */
@Composable
fun IconTile(
    icon: ImageVector,
    modifier: Modifier = Modifier,
    contentDescription: String? = null,
) {
    Box(
        modifier = modifier
            .size(40.dp)
            .background(ObsidianColors.Ink, RoundedCornerShape(ObsidianRadius.Code)),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = contentDescription, tint = ObsidianColors.Gold, modifier = Modifier.size(24.dp))
    }
}

/** A tappable list row: title, optional supporting line, optional value. */
@Composable
fun MenuRow(
    title: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    value: String? = null,
    icon: ImageVector? = null,
    valueColor: Color = ObsidianColors.Text,
    divider: Boolean = true,
) {
    val interaction = remember { MutableInteractionSource() }
    Column(
        modifier = modifier
            .fillMaxWidth()
            .clickable(interactionSource = interaction, indication = null) { onClick() }
            .padding(vertical = 14.dp),
    ) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.weight(1f)) {
                if (icon != null) {
                    Icon(icon, contentDescription = null, tint = ObsidianColors.Ink, modifier = Modifier.size(20.dp))
                    Spacer(Modifier.width(ObsidianSpace.S))
                }
                Column {
                    Text(title, style = ObsidianType.Value, color = ObsidianColors.Text)
                    if (subtitle != null) {
                        Spacer(Modifier.height(2.dp))
                        Text(subtitle, style = ObsidianType.Mono, color = ObsidianColors.Muted)
                    }
                }
            }
            if (value != null) Text(value, style = ObsidianType.Value, color = valueColor)
        }
        if (divider) {
            Spacer(Modifier.height(14.dp))
            Box(Modifier.fillMaxWidth().height(1.dp).background(ObsidianColors.Divider))
        }
    }
}

/** A text input built to the design: white fill, hairline, radius 16, 56px. */
@Composable
fun ObsidianTextField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    modifier: Modifier = Modifier,
    placeholder: String = "",
    error: String? = null,
    singleLine: Boolean = true,
    keyboardType: androidx.compose.ui.text.input.KeyboardType = androidx.compose.ui.text.input.KeyboardType.Text,
    visualTransformation: androidx.compose.ui.text.input.VisualTransformation =
        androidx.compose.ui.text.input.VisualTransformation.None,
    trailing: (@Composable () -> Unit)? = null,
) {
    Column(modifier = modifier.fillMaxWidth()) {
        SectionLabel(label)
        Spacer(Modifier.height(ObsidianSpace.XS))
        val shape = RoundedCornerShape(ObsidianRadius.Button)
        val stroke = if (error != null) ObsidianColors.Danger else ObsidianColors.Border
        Row(
            Modifier
                .fillMaxWidth()
                .height(56.dp)
                .background(ObsidianColors.Surface, shape)
                .border(BorderStroke(1.dp, stroke), shape)
                .padding(horizontal = 16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            androidx.compose.foundation.text.BasicTextField(
                value = value,
                onValueChange = onValueChange,
                singleLine = singleLine,
                modifier = Modifier.weight(1f),
                textStyle = ObsidianType.Body.copy(color = ObsidianColors.Text),
                cursorBrush = androidx.compose.ui.graphics.SolidColor(ObsidianColors.Gold),
                keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = keyboardType),
                visualTransformation = visualTransformation,
                decorationBox = { inner ->
                    if (value.isEmpty()) {
                        Text(placeholder, style = ObsidianType.Body, color = ObsidianColors.Muted.copy(alpha = 0.7f))
                    }
                    inner()
                },
            )
            if (trailing != null) {
                Spacer(Modifier.width(ObsidianSpace.XS))
                trailing()
            }
        }
        if (error != null) {
            Spacer(Modifier.height(6.dp))
            Text(error, style = ObsidianType.Mono, color = ObsidianColors.Danger)
        }
    }
}

/** A shared text style handle so screens never restate a size. */
val BodyStyle: TextStyle = ObsidianType.Body
