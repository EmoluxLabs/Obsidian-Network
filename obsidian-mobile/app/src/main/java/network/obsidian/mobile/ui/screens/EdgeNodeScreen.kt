package network.obsidian.mobile.ui.screens

import android.content.Intent
import android.provider.Settings
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import network.obsidian.mobile.R
import network.obsidian.mobile.edgenode.EdgeNodeAuthority
import network.obsidian.mobile.edgenode.EdgeNodePhase
import network.obsidian.mobile.edgenode.EdgeNodeService
import network.obsidian.mobile.edgenode.EdgeNodeState
import network.obsidian.mobile.edgenode.EdgeNodeTelemetry
import network.obsidian.mobile.ui.components.GoldKicker
import network.obsidian.mobile.ui.components.GuaranteePanel
import network.obsidian.mobile.ui.components.ObsidianCard
import network.obsidian.mobile.ui.components.ObsidianRow
import network.obsidian.mobile.ui.components.PrimaryButton
import network.obsidian.mobile.ui.components.ScreenShell
import network.obsidian.mobile.ui.components.SecondaryButton
import network.obsidian.mobile.ui.components.SectionLabel
import network.obsidian.mobile.ui.components.StatusDot
import network.obsidian.mobile.ui.theme.ObsidianColors
import network.obsidian.mobile.ui.theme.ObsidianSpace
import network.obsidian.mobile.ui.theme.ObsidianType
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * The Obsidian Edge Node screen (artboards 12, Disabled and Enabled).
 *
 * Every value here comes from the running controller. Nothing is estimated: if
 * the node has not verified a head, the count reads 0 rather than a plausible
 * number, and the reason it has not — offline, rejected, never started — is stated
 * in the design's own words.
 *
 * The screen exists to make the guarantees visible, because an Edge Node that a
 * user cannot inspect is indistinguishable from one that votes.
 */
@Composable
fun EdgeNodeScreen(nodeUrl: String, onBack: () -> Unit) {
    val state by EdgeNodeState.observable.collectAsState()
    val enabled by EdgeNodeTelemetry.enabled.collectAsState()
    val participating by EdgeNodeTelemetry.participating.collectAsState()
    val verified by EdgeNodeTelemetry.blocksVerified.collectAsState()
    val rejected by EdgeNodeTelemetry.headsRejected.collectAsState()
    val lastActivity by EdgeNodeTelemetry.lastActivityAt.collectAsState()
    val context = LocalContext.current

    // Computed, not asserted: authority derives from a validator bond, and an
    // Edge Node posts none, so these are zero for the same reason a bond of
    // 20,000 OBS would make them non-zero.
    val authority = EdgeNodeAuthority.forEdgeNode()

    ScreenShell(
        title = "Edge Node",
        kicker = "Network support",
        onBack = onBack,
    ) {
        StatusCard(state = state, participating = participating)

        Spacer(Modifier.height(ObsidianSpace.M))
        SectionLabel("CONTROLS")
        Spacer(Modifier.height(ObsidianSpace.XS))
        ObsidianCard {
            if (enabled) {
                SecondaryButton(
                    label = "DISABLE EDGE NODE",
                    showArrow = false,
                    onClick = {
                        EdgeNodeService.stop(context)
                        EdgeNodeTelemetry.enabled.value = false
                        EdgeNodeTelemetry.reset()
                        EdgeNodeState.current.value = EdgeNodeState.Stopped
                    },
                )
                Spacer(Modifier.height(ObsidianSpace.S))
                Text(
                    "Disabling stops the service immediately. It does not restart on its own: " +
                        "Obsidian Mobile requests no boot permission, so only you can start it again.",
                    style = ObsidianType.Support,
                    color = ObsidianColors.Muted,
                )
            } else {
                PrimaryButton(
                    label = "ENABLE EDGE NODE",
                    showArrow = false,
                    onClick = { EdgeNodeService.start(context, nodeUrl) },
                )
                Spacer(Modifier.height(ObsidianSpace.S))
                Text(
                    "Runs in the foreground with a notification you can see. It pauses when " +
                        "Android suspends it and resumes when connectivity returns.",
                    style = ObsidianType.Support,
                    color = ObsidianColors.Muted,
                )
            }
        }

        Spacer(Modifier.height(ObsidianSpace.M))
        SectionLabel("ACTIVITY")
        Spacer(Modifier.height(ObsidianSpace.XS))
        ObsidianCard {
            ObsidianRow("Heads verified", verified.toString(), mono = true, valueColor = ObsidianColors.SuccessText)
            ObsidianRow(
                label = "Heads rejected",
                value = rejected.toString(),
                mono = true,
                valueColor = if (rejected > 0) ObsidianColors.Danger else ObsidianColors.Text,
            )
            ObsidianRow(
                label = "Last activity",
                value = if (lastActivity == 0L) "None yet" else formatTimestamp(lastActivity),
                mono = lastActivity != 0L,
            )
            ObsidianRow(
                label = "Background activity",
                value = when {
                    !enabled -> "Not running"
                    participating -> "Exchanging data"
                    else -> "Suspended"
                },
                divider = false,
            )
        }

        Spacer(Modifier.height(ObsidianSpace.M))
        SectionLabel("WHAT IT CONTRIBUTES")
        Spacer(Modifier.height(ObsidianSpace.XS))
        ObsidianCard {
            ObsidianRow("Voting power", authority.votingPower.toString(), mono = true)
            ObsidianRow("Consensus weight", authority.consensusWeight.toPlainString(), mono = true)
            ObsidianRow("Node Runner earnings", "0 OBS", mono = true)
            ObsidianRow("Can produce blocks", if (authority.canProduceBlocks) "Yes" else "No")
            ObsidianRow("Can finalize", if (authority.canFinalize) "Yes" else "No", divider = false)
            Spacer(Modifier.height(ObsidianSpace.S))
            Text(
                "Ten thousand Edge Nodes hold exactly the authority one does: none. Running more " +
                    "of them adds propagation, not influence.",
                style = ObsidianType.Support,
                color = ObsidianColors.Muted,
            )
        }

        Spacer(Modifier.height(ObsidianSpace.M))
        GuaranteePanel(
            items = listOf(
                "Not a validator" to "It never produces or finalizes a block, and holds no consensus authority.",
                "No voting power" to "Voting weight comes from a 20,000 OBS bond in chain state. It posts no bond.",
                "No Node Runner earnings" to "It earns nothing for running and appears in no payout calculation.",
                "No wallet access" to "It holds no private key or seed phrase and cannot sign or spend.",
            ),
        )

        Spacer(Modifier.height(ObsidianSpace.M))
        ObsidianCard {
            GoldKicker("Node Runner vs Edge Node")
            Spacer(Modifier.height(ObsidianSpace.S))
            Text(
                "A Node Runner is a bonded validator: it posts 20,000 OBS, produces blocks and earns " +
                    "from the Mining Pool. An Edge Node does none of those things. They are different " +
                    "roles and this screen is only ever the second one.",
                style = ObsidianType.Support,
                color = ObsidianColors.Muted,
            )
        }

        Spacer(Modifier.height(ObsidianSpace.M))
        SectionLabel("BATTERY & DATA")
        Spacer(Modifier.height(ObsidianSpace.XS))
        ObsidianCard {
            Text(
                "The Edge Node polls one endpoint every 30 seconds and requests no wake lock, so it " +
                    "pauses rather than holding the CPU awake. Android may still restrict it in the " +
                    "background; that is expected and it resumes when permitted.",
                style = ObsidianType.Support,
                color = ObsidianColors.Muted,
            )
            Spacer(Modifier.height(ObsidianSpace.S))
            SecondaryButton(
                label = "OPEN APP SETTINGS",
                showArrow = false,
                onClick = {
                    runCatching {
                        context.startActivity(
                            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                                data = android.net.Uri.fromParts("package", context.packageName, null)
                            },
                        )
                    }
                },
            )
        }

        Spacer(Modifier.height(ObsidianSpace.XL))
    }
}

@Composable
private fun StatusCard(state: EdgeNodeState, participating: Boolean) {
    val (label, colour) = when (state.phase) {
        EdgeNodePhase.Running -> "Live" to ObsidianColors.Success
        EdgeNodePhase.Starting -> "Connecting" to ObsidianColors.Gold
        EdgeNodePhase.Offline -> "Offline" to ObsidianColors.Muted
        EdgeNodePhase.Rejected -> "Invalid data" to ObsidianColors.Danger
        EdgeNodePhase.Stopped, EdgeNodePhase.Disabled -> "Disabled" to ObsidianColors.Muted
    }
    ObsidianCard {
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            SectionLabel("Status")
            Row(verticalAlignment = Alignment.CenterVertically) {
                StatusDot(color = colour)
                Spacer(Modifier.width(ObsidianSpace.XS))
                Text(label.uppercase(), style = ObsidianType.Label, color = colour)
            }
        }
        Spacer(Modifier.height(ObsidianSpace.S))
        Text(state.describe("Edge Node"), style = ObsidianType.Body, color = ObsidianColors.Text)

        if (state is EdgeNodeState.Running) {
            Spacer(Modifier.height(ObsidianSpace.S))
            ObsidianRow("Block height", state.height.toString(), mono = true)
            ObsidianRow("Peers seen", state.peers.toString(), mono = true)
            ObsidianRow("Network", state.network.ifBlank { "—" })
            ObsidianRow("Protocol", state.protocolVersion.ifBlank { "—" }, mono = true)
            ObsidianRow("Head hash", state.headHash, mono = true, divider = false)
            if (state.syncing) {
                Spacer(Modifier.height(ObsidianSpace.XS))
                Text(
                    "The node is still syncing. Heights shown are its own reported progress.",
                    style = ObsidianType.Support,
                    color = ObsidianColors.Muted,
                )
            }
        }
        if (state is EdgeNodeState.Rejected) {
            Spacer(Modifier.height(ObsidianSpace.XS))
            Text(
                "Data from the node failed verification and was not relayed. Nothing was " +
                    "forwarded on its behalf.",
                style = ObsidianType.Support,
                color = ObsidianColors.Muted,
            )
        }
        if (!participating && state.phase == EdgeNodePhase.Offline) {
            Spacer(Modifier.height(ObsidianSpace.XS))
            Text(
                "No connectivity. The Edge Node is paused and will resume by itself when the " +
                    "device is back online.",
                style = ObsidianType.Support,
                color = ObsidianColors.Muted,
            )
        }
    }
}

private fun formatTimestamp(epochMillis: Long): String =
    SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date(epochMillis))
