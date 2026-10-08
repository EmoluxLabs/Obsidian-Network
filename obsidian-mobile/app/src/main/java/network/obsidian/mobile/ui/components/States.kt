package network.obsidian.mobile.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CloudOff
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Inbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import network.obsidian.mobile.ui.theme.ObsidianColors
import network.obsidian.mobile.ui.theme.ObsidianSpace
import network.obsidian.mobile.ui.theme.ObsidianType

/**
 * The system states every major screen must be able to show (requirement 8).
 *
 * They are part of the design system, not an afterthought: same card, same type,
 * same button. A screen that cannot reach the chain shows one of these instead
 * of an empty area or — worse — a number from the last successful fetch
 * presented as though it were current.
 */

@Composable
fun LoadingBlock(modifier: Modifier = Modifier, label: String = "Loading…") {
    StateShell(modifier = modifier) {
        CircularProgressIndicator(
            modifier = Modifier.size(24.dp),
            color = ObsidianColors.Gold,
            strokeWidth = 2.dp,
        )
        Spacer(Modifier.height(ObsidianSpace.S))
        Text(label.uppercase(), style = ObsidianType.Label, color = ObsidianColors.Muted)
    }
}

@Composable
fun OfflineBlock(
    modifier: Modifier = Modifier,
    title: String = "You are offline",
    body: String = "No connection to an Obsidian node. Data shown may be stale.",
    onRetry: (() -> Unit)? = null,
) {
    StateShell(modifier = modifier, icon = Icons.Outlined.CloudOff, title = title, body = body, onRetry = onRetry)
}

@Composable
fun ErrorBlock(
    modifier: Modifier = Modifier,
    title: String = "Something went wrong",
    body: String = "",
    onRetry: (() -> Unit)? = null,
) {
    StateShell(modifier = modifier, icon = Icons.Outlined.ErrorOutline, title = title, body = body, onRetry = onRetry)
}

@Composable
fun EmptyBlock(
    modifier: Modifier = Modifier,
    title: String = "Nothing here yet",
    body: String = "",
) {
    StateShell(modifier = modifier, icon = Icons.Outlined.Inbox, title = title, body = body)
}

/**
 * The inline form used inside a card, where a full-width state would be too
 * heavy — the Landing network card uses this.
 */
@Composable
fun InlineStateBlock(
    title: String,
    body: String = "",
    modifier: Modifier = Modifier,
    onRetry: (() -> Unit)? = null,
) {
    Column(modifier = modifier.fillMaxWidth().padding(vertical = 18.dp)) {
        Text(title, style = ObsidianType.Value, color = ObsidianColors.Text)
        if (body.isNotBlank()) {
            Spacer(Modifier.height(6.dp))
            Text(body, style = ObsidianType.Support, color = ObsidianColors.Muted)
        }
        if (onRetry != null) {
            Spacer(Modifier.height(ObsidianSpace.S))
            GhostButton("RETRY", onClick = onRetry)
        }
    }
}

@Composable
private fun StateShell(
    modifier: Modifier = Modifier,
    icon: ImageVector? = null,
    title: String = "",
    body: String = "",
    onRetry: (() -> Unit)? = null,
    content: (@Composable () -> Unit)? = null,
) {
    Column(
        modifier = modifier.fillMaxWidth().padding(vertical = 32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        if (content != null) {
            content()
        } else {
            if (icon != null) {
                Icon(icon, contentDescription = null, tint = ObsidianColors.Muted, modifier = Modifier.size(28.dp))
                Spacer(Modifier.height(ObsidianSpace.S))
            }
            if (title.isNotBlank()) {
                Text(title, style = ObsidianType.Value, color = ObsidianColors.Text, textAlign = TextAlign.Center)
            }
            if (body.isNotBlank()) {
                Spacer(Modifier.height(6.dp))
                Text(
                    body,
                    style = ObsidianType.Support,
                    color = ObsidianColors.Muted,
                    textAlign = TextAlign.Center,
                )
            }
            if (onRetry != null) {
                Spacer(Modifier.height(ObsidianSpace.M))
                GhostButton("RETRY", onClick = onRetry)
            }
        }
    }
}
