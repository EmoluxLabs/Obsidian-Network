package network.obsidian.mobile.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import network.obsidian.mobile.ui.theme.ObsidianColors
import network.obsidian.mobile.ui.theme.ObsidianMetrics
import network.obsidian.mobile.ui.theme.ObsidianSpace
import network.obsidian.mobile.ui.theme.ObsidianType

/**
 * The page frame every screen after the Landing uses.
 *
 * Lifted out so the 390px artboard's structure — 20px gutters, a 76px header, the
 * gold kicker over an uppercase title — is stated once and cannot drift between
 * screens. A screen supplies its body; it does not re-derive the chrome.
 */
@Composable
fun ScreenShell(
    title: String,
    modifier: Modifier = Modifier,
    kicker: String? = null,
    onBack: (() -> Unit)? = null,
    headerTrailing: (@Composable () -> Unit)? = null,
    contentPadding: PaddingValues = PaddingValues(bottom = ObsidianSpace.NavClearance),
    content: @Composable androidx.compose.foundation.layout.ColumnScope.() -> Unit,
) {
    Column(
        modifier = modifier
            .fillMaxSize()
            .background(ObsidianColors.Canvas)
            .statusBarsPadding(),
    ) {
        ScreenHeader(title = title, kicker = kicker, onBack = onBack, trailing = headerTrailing)
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = ObsidianSpace.Gutter)
                .navigationBarsPadding()
                .padding(contentPadding),
            content = content,
        )
    }
}

@Composable
private fun ScreenHeader(
    title: String,
    kicker: String?,
    onBack: (() -> Unit)?,
    trailing: (@Composable () -> Unit)?,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(ObsidianMetrics.HeaderHeight)
            .padding(horizontal = ObsidianSpace.Gutter),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.weight(1f)) {
            if (onBack != null) {
                val interaction = remember { MutableInteractionSource() }
                Box(
                    modifier = Modifier
                        .size(ObsidianMetrics.MenuButtonSize)
                        .clip(CircleShape)
                        .background(ObsidianColors.Surface)
                        .clickable(interactionSource = interaction, indication = null) { onBack() },
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        Icons.AutoMirrored.Outlined.ArrowBack,
                        contentDescription = "Back",
                        tint = ObsidianColors.Ink,
                        modifier = Modifier.size(20.dp),
                    )
                }
                Spacer(Modifier.size(ObsidianSpace.S))
            }
            Column {
                if (kicker != null) {
                    GoldKicker(kicker)
                    Spacer(Modifier.height(2.dp))
                }
                Text(title.uppercase(), style = ObsidianType.CardTitle, color = ObsidianColors.Ink)
            }
        }
        if (trailing != null) trailing()
    }
}

/**
 * The security guarantee panel: the four statements that must be visible wherever
 * the Edge Node is described.
 *
 * Kept in one place so the wording cannot vary between screens — a user comparing
 * two places should read the same promise twice.
 */
@Composable
fun GuaranteePanel(
    modifier: Modifier = Modifier,
    items: List<Pair<String, String>>,
    accent: Color = ObsidianColors.Gold,
) {
    ObsidianCard(modifier = modifier, radius = network.obsidian.mobile.ui.theme.ObsidianRadius.Card) {
        SectionLabel("WHAT THIS NEVER DOES")
        Spacer(Modifier.height(ObsidianSpace.S))
        items.forEachIndexed { index, (label, body) ->
            Row(Modifier.fillMaxWidth().padding(vertical = 10.dp)) {
                Box(
                    Modifier
                        .padding(top = 6.dp)
                        .size(6.dp)
                        .background(accent, CircleShape),
                )
                Spacer(Modifier.width(ObsidianSpace.S))
                Column(Modifier.weight(1f)) {
                    Text(label, style = ObsidianType.Value, color = ObsidianColors.Text)
                    Spacer(Modifier.height(2.dp))
                    Text(body, style = ObsidianType.Support, color = ObsidianColors.Muted)
                }
            }
            if (index != items.lastIndex) {
                Box(Modifier.fillMaxWidth().height(1.dp).background(ObsidianColors.Divider))
            }
        }
    }
}
