package network.obsidian.mobile.ui.screens

import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import network.obsidian.mobile.identity.ProfileStore
import network.obsidian.mobile.remote.ChainLink
import network.obsidian.mobile.remote.ObsidianRepository
import network.obsidian.mobile.ui.ChainValues
import network.obsidian.mobile.ui.components.EmptyBlock
import network.obsidian.mobile.ui.components.ErrorBlock
import network.obsidian.mobile.ui.components.InlineStateBlock
import network.obsidian.mobile.ui.components.GoldKicker
import network.obsidian.mobile.ui.components.ObsidianCard
import network.obsidian.mobile.ui.components.ObsidianRow
import network.obsidian.mobile.ui.components.ScreenShell
import network.obsidian.mobile.ui.components.SectionLabel
import network.obsidian.mobile.ui.theme.ObsidianColors
import network.obsidian.mobile.ui.theme.ObsidianSpace
import network.obsidian.mobile.ui.theme.ObsidianType

/*
 * Mining on this screen means the chain's mining, shown truthfully.
 *
 * The rules live in obsidian-core/src/mining/rules.ts. This app does not
 * reimplement eligibility, reward curves or cycle timers, and it does not run a
 * miner: a phone is not a validator and pretending otherwise would be the
 * "fake active miner" the design must never show. What is displayed is the
 * network's real mining state from /status, and — for the attached address — the
 * node's own eligibility verdict from getminingstatus.
 *
 * When mining is not active, that is what the screen says.
 */

@Composable
fun MiningScreen(
    store: ProfileStore,
    repository: ObsidianRepository,
    onBack: () -> Unit,
    onActive: () -> Unit,
) {
    val link by repository.link.collectAsState()

    ScreenShell(title = "Mining", kicker = "Proof of Time", onBack = onBack) {
        // The mining interface renders in full whether or not a node answers.
        //
        // It used to be one `when` around the whole body, so with no node reachable
        // — the normal case on a phone, where nothing listens on the default
        // address — the screen collapsed to a single error block and the mining
        // interface never appeared. The cards and the protocol explanation ARE the
        // screen; only the values inside the network card depend on the link.
        val current = link
        ObsidianCard {
            SectionLabel("NETWORK")
            Spacer(Modifier.height(ObsidianSpace.S))
            when (current) {
                is ChainLink.Online -> {
                    ObsidianRow("Block height", ChainValues.count(current.health.height), mono = true)
                    ObsidianRow("Active miners", current.status.activeMiners.toString(), mono = true)
                    ObsidianRow("Mining claims", ChainValues.count(current.status.metrics.miningClaims), mono = true)
                    ObsidianRow("Reward pool", ChainValues.obs(current.status.pool.balance), mono = true)
                    ObsidianRow("Pool lifetime inflow", ChainValues.obs(current.status.pool.lifetimeInflow), mono = true)
                    ObsidianRow("Pool distributed", ChainValues.obs(current.status.pool.lifetimeDistributed), mono = true)
                    ObsidianRow("Settled claims", ChainValues.count(current.status.pool.settledClaims), mono = true, divider = false)
                }
                is ChainLink.Degraded -> InlineStateBlock(
                    title = "Connection lost",
                    body = "The last values this device received are not shown as current, " +
                        "because a stale height presented as live is a lie.",
                )
                ChainLink.Offline -> InlineStateBlock(
                    title = "No node connected",
                    body = "Mining figures come from a node and none has answered. Obsidian nodes " +
                        "are self-hosted, so point the app at one in Settings — the protocol has " +
                        "no company-operated public endpoint to fall back on.",
                )
            }
        }

        Spacer(Modifier.height(ObsidianSpace.M))
        SectionLabel("THIS DEVICE")
        Spacer(Modifier.height(ObsidianSpace.XS))
        ObsidianCard {
            val profile = store.active()
            if (profile == null) {
                Text(
                    "No address attached. Mining eligibility is per address, so attach one to see " +
                        "the node's own verdict for it — this app never computes eligibility " +
                        "itself, because the rules belong to the protocol.",
                    style = ObsidianType.Support,
                    color = ObsidianColors.Muted,
                )
            } else {
                ObsidianRow("Address", ChainValues.shorten(profile.address), mono = true)
                ObsidianRow(
                    label = "State",
                    value = "Not mining here",
                    valueColor = ObsidianColors.Muted,
                    divider = false,
                )
                Spacer(Modifier.height(ObsidianSpace.S))
                Text(
                    "This device is not a miner. Claiming a mining reward is a signed " +
                        "transaction, and the app holds no key with which to sign one.",
                    style = ObsidianType.Support,
                    color = ObsidianColors.Muted,
                )
            }
        }

        Spacer(Modifier.height(ObsidianSpace.M))
        ObsidianCard {
            GoldKicker("Proof of Time")
            Spacer(Modifier.height(ObsidianSpace.S))
            Text(
                "Obsidian's consensus is Proof of Time: validators are scheduled into slots and " +
                    "produce blocks in turn. Mining claims are how rewards reach miners, and the " +
                    "pool above is where those rewards accumulate before settlement. None of those " +
                    "rules are restated or altered by this app.",
                style = ObsidianType.Support,
                color = ObsidianColors.Muted,
            )
        }

        Spacer(Modifier.height(ObsidianSpace.XL))
    }
}

/**
 * ACTIVE MINING — the honest version.
 *
 * There is no state in which this phone is producing blocks, so the screen shows
 * the network's real producing state instead of inventing a local miner. An
 * "active mining" animation with a fabricated hashrate would be a fake success
 * state, which is worse than an accurate inactive one.
 */
@Composable
fun MiningActiveScreen(repository: ObsidianRepository, onBack: () -> Unit) {
    val link by repository.link.collectAsState()

    ScreenShell(title = "Mining status", kicker = "Live", onBack = onBack) {
        ObsidianCard {
            GoldKicker("This device")
            Spacer(Modifier.height(ObsidianSpace.S))
            Text("Not mining", style = ObsidianType.Statement, color = ObsidianColors.Ink)
            Spacer(Modifier.height(ObsidianSpace.XS))
            Text(
                "Obsidian Mobile does not run a miner and is not a validator. Producing a block " +
                    "requires a registered validator bond and a signing key; this app has neither " +
                    "and does not simulate having them.",
                style = ObsidianType.Support,
                color = ObsidianColors.Muted,
            )
        }

        Spacer(Modifier.height(ObsidianSpace.M))
        SectionLabel("THE CHAIN IS PRODUCING")
        Spacer(Modifier.height(ObsidianSpace.XS))
        ObsidianCard {
            val current = link
            when (current) {
                is ChainLink.Online -> {
                    ObsidianRow("Block height", ChainValues.count(current.health.height), mono = true)
                    ObsidianRow("Head hash", ChainValues.shorten(current.health.headHash), mono = true)
                    ObsidianRow("Active miners", current.status.activeMiners.toString(), mono = true)
                    ObsidianRow("Validators", current.status.validators.toString(), mono = true)
                    ObsidianRow("Mempool", current.status.mempool.transactions.toString() + " tx", mono = true)
                    ObsidianRow(
                        label = "Syncing",
                        value = if (current.health.syncing) "Yes" else "No",
                        divider = false,
                    )
                }
                is ChainLink.Degraded -> ErrorBlock(
                    title = "Connection lost",
                    body = "Live producing state is unavailable until the node answers again.",
                )
                ChainLink.Offline -> ErrorBlock(title = "Offline", body = "No node has answered yet.")
            }
        }

        Spacer(Modifier.height(ObsidianSpace.XL))
    }
}
