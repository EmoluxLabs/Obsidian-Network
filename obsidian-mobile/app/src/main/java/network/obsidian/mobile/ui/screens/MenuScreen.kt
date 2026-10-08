package network.obsidian.mobile.ui.screens

import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AccountBalanceWallet
import androidx.compose.material.icons.outlined.Dns
import androidx.compose.material.icons.outlined.Home
import androidx.compose.material.icons.outlined.Hub
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material.icons.outlined.Bolt
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.TravelExplore
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import network.obsidian.mobile.remote.ChainLink
import network.obsidian.mobile.remote.ObsidianRepository
import network.obsidian.mobile.ui.ChainValues
import network.obsidian.mobile.ui.components.MenuRow
import network.obsidian.mobile.ui.components.ObsidianCard
import network.obsidian.mobile.ui.components.ObsidianRow
import network.obsidian.mobile.ui.components.ScreenShell
import network.obsidian.mobile.ui.components.SectionLabel
import network.obsidian.mobile.ui.theme.ObsidianColors
import network.obsidian.mobile.ui.theme.ObsidianSpace
import network.obsidian.mobile.ui.theme.ObsidianType
import androidx.compose.material3.Text

/**
 * The main menu (artboard 02).
 *
 * Every row navigates somewhere real. The network card at the top reads the same
 * shared link every other screen uses, so the height shown here and the height
 * shown in Explorer cannot disagree.
 */
@Composable
fun MenuScreen(
    repository: ObsidianRepository,
    onNavigate: (String) -> Unit,
    onBack: () -> Unit,
) {
    val link by repository.link.collectAsState()
    val nodeUrl by repository.nodeUrl.collectAsState()

    ScreenShell(title = "Menu", kicker = "Obsidian", onBack = onBack) {
        ObsidianCard {
            SectionLabel("NETWORK")
            Spacer(Modifier.height(ObsidianSpace.S))
            when (val current = link) {
                is ChainLink.Online -> {
                    ObsidianRow("Block height", ChainValues.count(current.health.height), mono = true)
                    ObsidianRow("Peers", current.health.peers.toString(), mono = true)
                    ObsidianRow("Network", current.health.network.ifBlank { "—" })
                    ObsidianRow(
                        "Status",
                        if (current.health.syncing) "Syncing" else "Live",
                        valueColor = if (current.health.syncing) ObsidianColors.GoldText else ObsidianColors.SuccessText,
                        divider = false,
                    )
                }
                is ChainLink.Degraded -> {
                    ObsidianRow("Block height", ChainValues.count(current.last.health.height), mono = true)
                    ObsidianRow(
                        label = "Status",
                        value = "Connection lost",
                        valueColor = ObsidianColors.Danger,
                        divider = false,
                    )
                }
                ChainLink.Offline -> {
                    ObsidianRow("Status", "Offline", valueColor = ObsidianColors.Muted, divider = false)
                }
            }
            Spacer(Modifier.height(ObsidianSpace.XS))
            Text(
                "Node: $nodeUrl",
                style = ObsidianType.Mono,
                color = ObsidianColors.Muted,
            )
        }

        Spacer(Modifier.height(ObsidianSpace.M))
        SectionLabel("OBSIDIAN")
        Spacer(Modifier.height(ObsidianSpace.XS))
        ObsidianCard {
            MenuRow("Home", onClick = { onNavigate(network.obsidian.mobile.Routes.LANDING) }, icon = Icons.Outlined.Home)
            MenuRow("Account", onClick = { onNavigate(network.obsidian.mobile.Routes.ACCOUNT) }, icon = Icons.Outlined.Person)
            MenuRow("Wallet", onClick = { onNavigate(network.obsidian.mobile.Routes.WALLET) }, icon = Icons.Outlined.AccountBalanceWallet)
            MenuRow("Mining", onClick = { onNavigate(network.obsidian.mobile.Routes.MINING) }, icon = Icons.Outlined.Bolt, divider = false)
        }

        Spacer(Modifier.height(ObsidianSpace.M))
        SectionLabel("NETWORK")
        Spacer(Modifier.height(ObsidianSpace.XS))
        ObsidianCard {
            MenuRow("Explorer", onClick = { onNavigate(network.obsidian.mobile.Routes.EXPLORER) }, icon = Icons.Outlined.Search)
            MenuRow("Obsidian Name Service", onClick = { onNavigate(network.obsidian.mobile.Routes.ONS) }, icon = Icons.Outlined.TravelExplore)
            MenuRow("Edge Node", onClick = { onNavigate(network.obsidian.mobile.Routes.EDGE_NODE) }, icon = Icons.Outlined.Hub, divider = false)
        }

        Spacer(Modifier.height(ObsidianSpace.M))
        SectionLabel("DEVICE")
        Spacer(Modifier.height(ObsidianSpace.XS))
        ObsidianCard {
            MenuRow("Settings", onClick = { onNavigate(network.obsidian.mobile.Routes.SETTINGS) }, icon = Icons.Outlined.Settings)
            MenuRow("Node & API", onClick = { onNavigate(network.obsidian.mobile.Routes.SETTINGS) }, icon = Icons.Outlined.Dns, divider = false)
        }

        Spacer(Modifier.height(ObsidianSpace.XL))
    }
}

/**
 * Settings.
 *
 * Every control here changes something real. The node address is the one setting
 * that genuinely matters: it is the node every screen reads from, so changing it
 * drops the link to Offline rather than letting the old chain's numbers linger on
 * screen as though they were the new node's.
 */
@Composable
fun SettingsScreen(repository: ObsidianRepository, onBack: () -> Unit) {
    var nodeUrl by remember { mutableStateOf(repository.nodeUrl.value) }
    var saved by remember { mutableStateOf<String?>(null) }
    val current by repository.nodeUrl.collectAsState()
    val link by repository.link.collectAsState()
    val edgeEnabled by network.obsidian.mobile.edgenode.EdgeNodeTelemetry.enabled.collectAsState()

    ScreenShell(title = "Settings", kicker = "Device", onBack = onBack) {
        SectionLabel("NODE")
        Spacer(Modifier.height(ObsidianSpace.XS))
        ObsidianCard {
            network.obsidian.mobile.ui.components.ObsidianTextField(
                value = nodeUrl,
                onValueChange = {
                    nodeUrl = it
                    saved = null
                },
                label = "Node address",
                placeholder = ObsidianRepository.DEFAULT_NODE_URL,
            )
            Spacer(Modifier.height(ObsidianSpace.S))
            if (saved != null) {
                Text(saved!!, style = ObsidianType.Support, color = ObsidianColors.SuccessText)
                Spacer(Modifier.height(ObsidianSpace.XS))
            }
            network.obsidian.mobile.ui.components.PrimaryButton(
                label = "USE THIS NODE",
                showArrow = false,
                onClick = {
                    val trimmed = nodeUrl.trim()
                    if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
                        saved = "Enter a full address starting http:// or https://"
                    } else {
                        repository.setNodeUrl(trimmed)
                        saved = "Now reading from $trimmed"
                    }
                },
            )
            Spacer(Modifier.height(ObsidianSpace.S))
            Text(
                "Changing the node discards the cached chain state and starts again, so a height " +
                    "on screen is always the node you are actually connected to.",
                style = ObsidianType.Support,
                color = ObsidianColors.Muted,
            )
        }

        Spacer(Modifier.height(ObsidianSpace.M))
        SectionLabel("CONNECTION")
        Spacer(Modifier.height(ObsidianSpace.XS))
        ObsidianCard {
            ObsidianRow("Connected node", current, mono = true)
            ObsidianRow(
                "Link",
                when (link) {
                    is ChainLink.Online -> "Online"
                    is ChainLink.Degraded -> "Connection lost"
                    ChainLink.Offline -> "Offline"
                },
                valueColor = when (link) {
                    is ChainLink.Online -> ObsidianColors.SuccessText
                    is ChainLink.Degraded -> ObsidianColors.Danger
                    ChainLink.Offline -> ObsidianColors.Muted
                },
            )
            ObsidianRow("Refresh interval", "${ObsidianRepository.DEFAULT_POLL_MILLIS / 1000}s", mono = true, divider = false)
            Spacer(Modifier.height(ObsidianSpace.XS))
            Text(
                "One poller serves every screen, so opening several screens does not multiply the " +
                    "requests the phone makes.",
                style = ObsidianType.Support,
                color = ObsidianColors.Muted,
            )
        }

        Spacer(Modifier.height(ObsidianSpace.M))
        SectionLabel("EDGE NODE")
        Spacer(Modifier.height(ObsidianSpace.XS))
        ObsidianCard {
            ObsidianRow("Status", if (edgeEnabled) "Enabled" else "Disabled", divider = false)
            Spacer(Modifier.height(ObsidianSpace.S))
            Text(
                "The Edge Node verifies and relays. It is started and stopped from its own screen, " +
                    "never from a switch here, because turning it on starts a foreground service " +
                    "the user should choose deliberately.",
                style = ObsidianType.Support,
                color = ObsidianColors.Muted,
            )
        }

        Spacer(Modifier.height(ObsidianSpace.M))
        SectionLabel("ABOUT")
        Spacer(Modifier.height(ObsidianSpace.XS))
        ObsidianCard {
            ObsidianRow("Application", "Obsidian Mobile")
            ObsidianRow("Protocol version", (link as? ChainLink.Online)?.health?.protocolVersion?.ifBlank { "—" } ?: "—", mono = true)
            ObsidianRow("Chain id", ((link as? ChainLink.Online)?.health?.chainId ?: 0).toString(), mono = true)
            ObsidianRow("Custody", "Non-custodial", divider = false)
            Spacer(Modifier.height(ObsidianSpace.XS))
            Text(
                "Obsidian Mobile holds no private key. It reads chain state and relays transactions " +
                    "that were signed elsewhere.",
                style = ObsidianType.Support,
                color = ObsidianColors.Muted,
            )
        }

        Spacer(Modifier.height(ObsidianSpace.XL))
    }
}
