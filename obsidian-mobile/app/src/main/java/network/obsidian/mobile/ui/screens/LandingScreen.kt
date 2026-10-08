package network.obsidian.mobile.ui.screens

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AccountBalanceWallet
import androidx.compose.material.icons.outlined.Bolt
import androidx.compose.material.icons.outlined.Layers
import androidx.compose.material.icons.outlined.Menu
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.Shield
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.navigation.NavHostController
import network.obsidian.mobile.R
import network.obsidian.mobile.Routes
import network.obsidian.mobile.remote.ChainLink
import network.obsidian.mobile.ui.ChainValues
import network.obsidian.mobile.ui.components.GhostButton
import network.obsidian.mobile.ui.components.GoldKicker
import network.obsidian.mobile.ui.components.IconTile
import network.obsidian.mobile.ui.components.ObsidianCard
import network.obsidian.mobile.ui.components.ObsidianDarkCard
import network.obsidian.mobile.ui.components.ObsidianPill
import network.obsidian.mobile.ui.components.ObsidianRow
import network.obsidian.mobile.ui.components.PrimaryButton
import network.obsidian.mobile.ui.components.SecondaryButton
import network.obsidian.mobile.ui.components.SectionLabel
import network.obsidian.mobile.ui.components.StatusDot
import network.obsidian.mobile.ui.components.InlineStateBlock
import network.obsidian.mobile.ui.theme.ObsidianColors
import network.obsidian.mobile.ui.theme.ObsidianMetrics
import network.obsidian.mobile.ui.theme.ObsidianRadius
import network.obsidian.mobile.ui.theme.ObsidianSpace
import network.obsidian.mobile.ui.theme.ObsidianType

/**
 * Screen 01 · Landing.
 *
 * Layout, spacing and type are the artboard's. The values in the Network card
 * are not: the artboard shows "#1,284,906" as a placeholder, and this screen
 * reads the height from the node instead, showing a loading, offline or error
 * state when the node cannot answer rather than a number that looks true.
 */
@Composable
fun LandingScreen(navController: NavHostController) {
    val link by remember { network.obsidian.mobile.ObsidianApp.instance.repository.link }
        .collectAsState()

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(ObsidianColors.Canvas)
            .verticalScroll(rememberScrollState())
            .padding(horizontal = ObsidianSpace.Gutter),
    ) {
        LandingHeader(onMenu = { navController.navigate(Routes.MENU) })
        Spacer(Modifier.height(14.dp))
        HeroCopy()
        Spacer(Modifier.height(ObsidianSpace.XL))
        TimeRingCard()
        Spacer(Modifier.height(24.dp))
        LandingActions(
            onMining = { navController.navigate(Routes.MINING) },
            onWallet = { navController.navigate(Routes.CREATE_WALLET) },
            onExplorer = { navController.navigate(Routes.EXPLORER) },
        )
        Spacer(Modifier.height(28.dp))
        NetworkCard(link)
        Spacer(Modifier.height(ObsidianSpace.XXL))
        ParticipationSection()
        Spacer(Modifier.height(ObsidianSpace.XXL))
        LandingFooter(
            onOns = { navController.navigate(Routes.ONS) },
            onNode = { navController.navigate(Routes.EDGE_NODE) },
            onExplorer = { navController.navigate(Routes.EXPLORER) },
        )
        Spacer(Modifier.height(ObsidianSpace.XXL))
    }
}

@Composable
private fun LandingHeader(onMenu: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(ObsidianMetrics.HeaderHeight)
            .padding(top = 24.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Image(
                painter = painterResource(R.drawable.obsidian_logo),
                contentDescription = stringResource(R.string.app_name),
                modifier = Modifier
                    .size(ObsidianMetrics.LogoSize)
                    .clip(CircleShape),
                contentScale = ContentScale.Crop,
            )
            Spacer(Modifier.width(10.dp))
            Column {
                Text(stringResource(R.string.app_name), style = ObsidianType.Wordmark, color = ObsidianColors.Text)
                Text(
                    stringResource(R.string.brand_network),
                    style = ObsidianType.WordmarkSub,
                    color = ObsidianColors.Muted,
                )
            }
        }
        val interaction = remember { MutableInteractionSource() }
        Box(
            modifier = Modifier
                .size(ObsidianMetrics.MenuButtonSize)
                .background(ObsidianColors.Surface, RoundedCornerShape(ObsidianRadius.Tile))
                .border(
                    androidx.compose.foundation.BorderStroke(1.dp, ObsidianColors.Border),
                    RoundedCornerShape(ObsidianRadius.Tile),
                )
                .clickable(interactionSource = interaction, indication = null) { onMenu() },
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                Icons.Outlined.Menu,
                contentDescription = "Open menu",
                tint = ObsidianColors.Ink,
                modifier = Modifier.size(22.dp),
            )
        }
    }
}

@Composable
private fun HeroCopy() {
    Column {
        GoldKicker("LAYER-1 · PROOF OF TIME")
        Spacer(Modifier.height(14.dp))
        Text(
            stringResource(R.string.hero_headline),
            style = ObsidianType.Hero,
            color = ObsidianColors.Ink,
        )
        Spacer(Modifier.height(16.dp))
        Text(
            stringResource(R.string.hero_body),
            style = ObsidianType.Body,
            color = ObsidianColors.Muted,
        )
    }
}

/**
 * The hero visual: the concentric "time ring" of the artboard, drawn rather than
 * shipped as a bitmap, so it stays crisp and can later reflect real protocol
 * time without a new asset.
 */
@Composable
private fun TimeRingCard() {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(338.dp)
            .background(ObsidianColors.Surface, RoundedCornerShape(ObsidianRadius.Card))
            .border(
                androidx.compose.foundation.BorderStroke(1.dp, ObsidianColors.Border),
                RoundedCornerShape(ObsidianRadius.Card),
            ),
        contentAlignment = Alignment.Center,
    ) {
        androidx.compose.foundation.Canvas(modifier = Modifier.size(320.dp)) {
            val centre = Offset(size.width / 2f, size.height / 2f)
            val dashed = PathEffect.dashPathEffect(floatArrayOf(1f, 7.8f), 0f)
            // Outer dotted ring.
            drawCircle(
                color = ObsidianColors.Border,
                radius = 156f,
                center = centre,
                style = Stroke(width = 1f, pathEffect = dashed),
            )
            // Progress track, then the gold arc that represents elapsed time.
            drawCircle(color = ObsidianColors.Border, radius = 146f, center = centre, style = Stroke(width = 1.5f))
            drawArc(
                color = ObsidianColors.Gold,
                startAngle = -90f,
                sweepAngle = 79f,
                useCenter = false,
                topLeft = Offset(centre.x - 146f, centre.y - 146f),
                size = androidx.compose.ui.geometry.Size(292f, 292f),
                style = Stroke(width = 3f, cap = androidx.compose.ui.graphics.StrokeCap.Round),
            )
            drawCircle(
                color = ObsidianColors.Divider,
                radius = 128f,
                center = centre,
                style = Stroke(width = 1.5f, pathEffect = PathEffect.dashPathEffect(floatArrayOf(3f, 6f), 0f)),
            )
            drawCircle(color = ObsidianColors.Border, radius = 112f, center = centre, style = Stroke(width = 1f))
            // The travelling marker.
            drawCircle(color = ObsidianColors.Gold, radius = 5f, center = Offset(285f, 213f))
            drawCircle(
                color = ObsidianColors.Gold.copy(alpha = 0.35f),
                radius = 9f,
                center = Offset(285f, 213f),
                style = Stroke(width = 1.5f),
            )
            drawCircle(color = ObsidianColors.Ink, radius = 3f, center = Offset(160f, 14f))
        }
        Image(
            painter = painterResource(R.drawable.obsidian_logo),
            contentDescription = "Obsidian core",
            modifier = Modifier
                .size(196.dp)
                .clip(CircleShape),
            contentScale = ContentScale.Crop,
        )
        HeroChip(text = "OBSIDIAN CORE", alignStart = true)
        HeroChip(text = "TIME RING", alignStart = false, emphasised = true)
    }
}

@Composable
private fun androidx.compose.foundation.layout.BoxScope.HeroChip(text: String, alignStart: Boolean, emphasised: Boolean = false) {
    val modifier = if (alignStart) {
        Modifier
            .align(Alignment.BottomStart)
            .padding(16.dp)
    } else {
        Modifier
            .align(Alignment.TopEnd)
            .padding(16.dp)
    }
    Box(
        modifier = modifier
            .background(ObsidianColors.Canvas, RoundedCornerShape(ObsidianRadius.Pill))
            .border(
                androidx.compose.foundation.BorderStroke(1.dp, ObsidianColors.Border),
                RoundedCornerShape(ObsidianRadius.Pill),
            )
            .padding(horizontal = 12.dp, vertical = 7.dp),
    ) {
        Text(
            text,
            style = ObsidianType.Mono,
            color = if (emphasised) ObsidianColors.GoldText else ObsidianColors.Text,
        )
    }
}

@Composable
private fun LandingActions(onMining: () -> Unit, onWallet: () -> Unit, onExplorer: () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        PrimaryButton("START MINING", onClick = onMining, leading = Icons.Outlined.Bolt)
        SecondaryButton("CREATE WALLET", onClick = onWallet, leading = Icons.Outlined.AccountBalanceWallet)
        GhostButton("EXPLORER", onClick = onExplorer, leading = Icons.Outlined.Search)
    }
}

/**
 * The live network card. This is the one part of the artboard whose contents are
 * placeholders, so every value is either from the node or an explicit state.
 */
@Composable
private fun NetworkCard(link: ChainLink) {
    ObsidianCard {
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                StatusDot(color = if (link is ChainLink.Online) ObsidianColors.Success else ObsidianColors.Muted)
                Spacer(Modifier.width(9.dp))
                Text(
                    when (link) {
                        is ChainLink.Online -> "NETWORK LIVE"
                        is ChainLink.Degraded -> "CONNECTION LOST"
                        ChainLink.Offline -> "OFFLINE"
                    },
                    style = ObsidianType.Label,
                    color = ObsidianColors.Text,
                )
            }
            val network = (link as? ChainLink.Online)?.health?.network?.uppercase()
                ?: (link as? ChainLink.Degraded)?.last?.health?.network?.uppercase()
            ObsidianPill(network ?: "NO NODE", emphasised = true)
        }

        Spacer(Modifier.height(16.dp))
        Box(Modifier.fillMaxWidth().height(1.dp).background(ObsidianColors.Divider))

        when (link) {
            is ChainLink.Online -> {
                ObsidianRow(
                    label = "PROOF OF TIME",
                    value = if (link.health.status == "ok") "Active" else "Degraded",
                    valueColor = if (link.health.status == "ok") ObsidianColors.SuccessText else ObsidianColors.Danger,
                )
                ObsidianRow(
                    label = "BLOCK HEIGHT",
                    value = "#" + ChainValues.count(link.status.height),
                    mono = true,
                )
                ObsidianRow(
                    label = "NETWORK STATUS",
                    value = if (link.status.syncing) "Syncing" else "Operational",
                    divider = false,
                )
            }

            is ChainLink.Degraded -> {
                ObsidianRow(
                    label = "BLOCK HEIGHT",
                    value = "#" + ChainValues.count(link.last.status.height) + " (stale)",
                    mono = true,
                )
                ObsidianRow(label = "NETWORK STATUS", value = "Reconnecting", divider = false)
            }

            ChainLink.Offline -> InlineStateBlock(
                title = stringResource(R.string.state_offline),
                body = stringResource(R.string.state_offline_body),
            )
        }
    }
}

@Composable
private fun ParticipationSection() {
    Column {
        SectionLabel("BUILT FOR PARTICIPATION", color = ObsidianColors.GoldText)
        Spacer(Modifier.height(14.dp))
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            FeatureRow(
                icon = Icons.Outlined.Schedule,
                title = "MINE",
                body = stringResource(R.string.feature_mine),
            )
            FeatureRow(
                icon = Icons.Outlined.Shield,
                title = "SECURE",
                body = stringResource(R.string.feature_secure),
            )
            FeatureRow(
                icon = Icons.Outlined.Layers,
                title = "EXPLORE",
                body = stringResource(R.string.feature_explore),
            )
        }
    }
}

@Composable
private fun FeatureRow(icon: androidx.compose.ui.graphics.vector.ImageVector, title: String, body: String) {
    ObsidianCard(radius = ObsidianRadius.CardSmall, padding = 18.dp) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconTile(icon = icon)
            Spacer(Modifier.width(16.dp))
            Column {
                Text(title, style = ObsidianType.CardTitle, color = ObsidianColors.Text)
                Spacer(Modifier.height(4.dp))
                Text(body, style = ObsidianType.Support, color = ObsidianColors.Muted)
            }
        }
    }
}

@Composable
private fun LandingFooter(onOns: () -> Unit, onNode: () -> Unit, onExplorer: () -> Unit) {
    ObsidianDarkCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Image(
                painter = painterResource(R.drawable.obsidian_logo),
                contentDescription = null,
                modifier = Modifier
                    .size(40.dp)
                    .clip(CircleShape),
                contentScale = ContentScale.Crop,
            )
            Spacer(Modifier.width(12.dp))
            Text(
                "OBSIDIAN NETWORK",
                style = ObsidianType.Wordmark.copy(letterSpacing = 2.6.sp),
                color = ObsidianColors.Surface,
            )
        }
        Spacer(Modifier.height(16.dp))
        Text("Build. Validate. Decentralize.", style = ObsidianType.Statement, color = ObsidianColors.GoldLight)
        Spacer(Modifier.height(20.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(20.dp)) {
            FooterLink("ONS", onOns)
            FooterLink("NODE", onNode)
            FooterLink("EXPLORER", onExplorer)
        }
    }
}

@Composable
private fun FooterLink(label: String, onClick: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    Text(
        label,
        style = ObsidianType.Label,
        color = ObsidianColors.OnDarkMuted,
        modifier = Modifier.clickable(interactionSource = interaction, indication = null) { onClick() },
    )
}
