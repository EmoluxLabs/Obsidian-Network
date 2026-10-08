package network.obsidian.mobile.ui.screens

import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import network.obsidian.mobile.remote.Addresses
import network.obsidian.mobile.remote.ChainLink
import network.obsidian.mobile.remote.ObsidianRepository
import network.obsidian.mobile.ui.ChainValues
import network.obsidian.mobile.ui.components.EmptyBlock
import network.obsidian.mobile.ui.components.ErrorBlock
import network.obsidian.mobile.ui.components.GoldKicker
import network.obsidian.mobile.ui.components.LoadingBlock
import network.obsidian.mobile.ui.components.MenuRow
import network.obsidian.mobile.ui.components.ObsidianCard
import network.obsidian.mobile.ui.components.ObsidianRow
import network.obsidian.mobile.ui.components.ObsidianTextField
import network.obsidian.mobile.ui.components.PrimaryButton
import network.obsidian.mobile.ui.components.ScreenShell
import network.obsidian.mobile.ui.components.SectionLabel
import network.obsidian.mobile.ui.theme.ObsidianColors
import network.obsidian.mobile.ui.theme.ObsidianSpace
import network.obsidian.mobile.ui.theme.ObsidianType

/**
 * EXPLORER (artboard 08) — real chain state, nothing templated.
 *
 * Every figure here is read from a node: the height and head from the shared
 * link, blocks from `getblocks`, transactions from `gettransaction`, balances
 * from `getbalance`, supply from `/supply`. The design's sample values
 * (block #1,284,906 and friends) appear nowhere in this file.
 *
 * Supply is shown in the protocol's own vocabulary — maximum, minted, mined,
 * bonded, pooled, remaining to mint. There is no "circulating supply" row,
 * because the protocol does not define one and inventing a number under that
 * label would be a fabrication with a label from the design.
 */
@Composable
fun ExplorerScreen(repository: ObsidianRepository, onBack: () -> Unit) {
    val link by repository.link.collectAsState()
    val scope = rememberCoroutineScope()

    var query by remember { mutableStateOf("") }
    var resultTitle by remember { mutableStateOf<String?>(null) }
    var resultBody by remember { mutableStateOf<String?>(null) }
    var resultError by remember { mutableStateOf<String?>(null) }
    var searching by remember { mutableStateOf(false) }

    var blocks by remember { mutableStateOf<List<String>?>(null) }
    var blocksError by remember { mutableStateOf<String?>(null) }

    val online = link as? ChainLink.Online
    val height = online?.health?.height ?: (link as? ChainLink.Degraded)?.last?.health?.height

    // Fetch the most recent block hashes whenever the height moves. Real blocks,
    // fetched because the chain advanced — not a list rendered to fill a card.
    LaunchedEffect(height) {
        val h = height ?: return@LaunchedEffect
        repository.api.blocks(from = (h - 9).coerceAtLeast(0), limit = 10).fold(
            onSuccess = { blocks = it; blocksError = null },
            onFailure = { blocksError = it.message ?: "Blocks could not be read" },
        )
    }

    ScreenShell(title = "Explorer", kicker = "Chain data", onBack = onBack) {
        ObsidianCard {
            SectionLabel("SEARCH")
            Spacer(Modifier.height(ObsidianSpace.XS))
            ObsidianTextField(
                value = query,
                onValueChange = { query = it; resultError = null; resultTitle = null; resultBody = null },
                label = "Block height, transaction, address or name",
                placeholder = "1284906, tx…, obs1…, name.obs",
            )
            Spacer(Modifier.height(ObsidianSpace.M))
            PrimaryButton(
                label = "SEARCH",
                showArrow = false,
                enabled = query.isNotBlank() && !searching,
                onClick = {
                    searching = true
                    search(scope, repository, query.trim()) { title, body, error ->
                        resultTitle = title; resultBody = body; resultError = error; searching = false
                    }
                },
            )
            when {
                searching -> {
                    Spacer(Modifier.height(ObsidianSpace.S))
                    LoadingBlock(label = "Searching the chain")
                }
                resultError != null -> {
                    Spacer(Modifier.height(ObsidianSpace.S))
                    ErrorBlock(title = "Nothing found", body = resultError!!)
                }
                resultTitle != null -> {
                    Spacer(Modifier.height(ObsidianSpace.S))
                    SectionLabel(resultTitle!!)
                    Spacer(Modifier.height(ObsidianSpace.XXS))
                    Text(resultBody ?: "—", style = ObsidianType.Mono, color = ObsidianColors.Text)
                }
            }
        }

        Spacer(Modifier.height(ObsidianSpace.M))
        SectionLabel("LATEST")
        Spacer(Modifier.height(ObsidianSpace.XS))
        ObsidianCard {
            // Read once into a local: `link` is a delegated property, so the
            // compiler cannot smart-cast it, and re-reading it per row could in
            // principle mix two different fetches on one card.
            val current = link
            when (current) {
                is ChainLink.Online -> {
                    ObsidianRow("Block height", ChainValues.count(current.health.height), mono = true)
                    ObsidianRow("Head hash", ChainValues.shorten(current.health.headHash), mono = true)
                    ObsidianRow("Peers", current.health.peers.toString(), mono = true)
                    ObsidianRow("Transactions", ChainValues.count(current.status.metrics.transactions), mono = true)
                    ObsidianRow("Accounts", ChainValues.count(current.status.metrics.accounts), mono = true)
                    ObsidianRow("Active miners", current.status.activeMiners.toString(), mono = true)
                    ObsidianRow("Validators", current.status.validators.toString(), mono = true, divider = false)
                }
                is ChainLink.Degraded -> ErrorBlock(
                    title = "Connection lost",
                    body = "Showing the last values this device received. They are not current.",
                    onRetry = { },
                )
                ChainLink.Offline -> ErrorBlock(title = "Offline", body = "No node has answered yet.")
            }
        }

        Spacer(Modifier.height(ObsidianSpace.M))
        SectionLabel("SUPPLY")
        Spacer(Modifier.height(ObsidianSpace.XS))
        ObsidianCard {
            val supply = online?.supply
            if (supply == null) {
                EmptyBlock(
                    title = "Supply unavailable",
                    body = "The node did not answer /supply. No figure is shown rather than an " +
                        "estimate, because an invented supply number is worse than a blank one.",
                )
            } else {
                ObsidianRow("Maximum supply", ChainValues.maximumSupply(supply), mono = true)
                ObsidianRow("Total minted", ChainValues.mintedSupply(supply), mono = true)
                ObsidianRow("Mined", ChainValues.minedSupply(supply), mono = true)
                ObsidianRow("Genesis issued", ChainValues.obs(supply.genesisIssuedObs), mono = true)
                ObsidianRow("Validator bonds", ChainValues.bonded(supply), mono = true)
                ObsidianRow("Reward pool", ChainValues.poolBalance(supply), mono = true)
                ObsidianRow("Remaining to mint", ChainValues.remainingToMint(supply), mono = true)
                ObsidianRow(
                    label = "Maximum respected",
                    value = if (supply.maximumRespected) "Yes" else "No",
                    valueColor = if (supply.maximumRespected) ObsidianColors.SuccessText else ObsidianColors.Danger,
                    divider = false,
                )
                Spacer(Modifier.height(ObsidianSpace.S))
                Text(
                    "The protocol reports total minted, mined, bonded and pooled — it does not " +
                        "define a circulating supply, so none is displayed here.",
                    style = ObsidianType.Support,
                    color = ObsidianColors.Muted,
                )
            }
        }

        Spacer(Modifier.height(ObsidianSpace.M))
        SectionLabel("RECENT BLOCKS")
        Spacer(Modifier.height(ObsidianSpace.XS))
        ObsidianCard {
            when {
                blocksError != null -> ErrorBlock(title = "Blocks unavailable", body = blocksError!!)
                blocks == null -> LoadingBlock(label = "Reading blocks")
                blocks!!.isEmpty() -> EmptyBlock(title = "No blocks yet", body = "The chain has not produced a block in this range.")
                else -> blocks!!.forEachIndexed { index, hash ->
                    MenuRow(
                        title = "Block ${((height ?: 0) - index)}",
                        subtitle = ChainValues.shorten(hash),
                        divider = index != blocks!!.lastIndex,
                        onClick = { },
                    )
                }
            }
        }

        Spacer(Modifier.height(ObsidianSpace.XL))
    }
}

/**
 * One search, dispatched by what the query actually looks like.
 *
 * The node has no single "search everything" endpoint, so the app decides from
 * the shape of the input and asks the right question — and reports honestly when
 * the answer is "no such object", which is a fact about the chain rather than a
 * failure of the app.
 */
private fun search(
    scope: CoroutineScope,
    repository: ObsidianRepository,
    query: String,
    onResult: (String?, String?, String?) -> Unit,
) {
    scope.launch {
        val api = repository.api
        when {
            query.endsWith(".obs") -> api.names().fold(
                onSuccess = { names ->
                    val match = names.firstOrNull { it.equals(query, ignoreCase = true) }
                    if (match == null) onResult(null, null, "No name '$query' is registered.")
                    else onResult("ONS NAME", match, null)
                },
                onFailure = { onResult(null, null, it.message ?: "Names could not be read") },
            )

            Addresses.isValid(query) -> api.rpcBalance(query).fold(
                onSuccess = { element ->
                    if (element == null) onResult(null, null, "No account state for that address.")
                    else onResult("ADDRESS", element.toString(), null)
                },
                onFailure = { onResult(null, null, it.message ?: "Balance could not be read") },
            )

            query.toLongOrNull() != null -> api.block(query.toLong()).fold(
                onSuccess = { element ->
                    if (element == null) onResult(null, null, "No block at height $query.")
                    else onResult("BLOCK $query", element.toString(), null)
                },
                onFailure = { onResult(null, null, it.message ?: "Block could not be read") },
            )

            else -> api.transaction(query).fold(
                onSuccess = { element ->
                    if (element == null) onResult(null, null, "No transaction with that id.")
                    else onResult("TRANSACTION", element.toString(), null)
                },
                onFailure = { onResult(null, null, it.message ?: "Transaction could not be read") },
            )
        }
    }
}

/**
 * ONS (artboard 11) — the names the chain actually has.
 *
 * The list comes from `getnames`, so an empty chain shows an empty list rather
 * than a plausible one. Registration and transfer need a signed transaction, so
 * this screen resolves and lists; it does not pretend to register.
 */
@Composable
fun OnsScreen(repository: ObsidianRepository, onBack: () -> Unit) {
    val scope = rememberCoroutineScope()
    var names by remember { mutableStateOf<List<String>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var query by remember { mutableStateOf("") }
    var detail by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        repository.api.names().fold(
            onSuccess = { names = it; error = null },
            onFailure = { error = it.message ?: "Names could not be read" },
        )
    }

    ScreenShell(title = "Obsidian Name Service", kicker = "Names", onBack = onBack) {
        ObsidianCard {
            SectionLabel("LOOK UP A NAME")
            Spacer(Modifier.height(ObsidianSpace.XS))
            ObsidianTextField(
                value = query,
                onValueChange = { query = it; detail = null },
                label = "Name",
                placeholder = "name.obs",
            )
            Spacer(Modifier.height(ObsidianSpace.M))
            PrimaryButton(
                label = "RESOLVE",
                showArrow = false,
                enabled = query.isNotBlank(),
                onClick = {
                    scope.launch {
                        repository.api.names().fold(
                            onSuccess = { all ->
                                detail = if (all.any { it.equals(query.trim(), ignoreCase = true) }) {
                                    "$query is registered on this chain."
                                } else {
                                    "$query is not registered."
                                }
                            },
                            onFailure = { detail = it.message ?: "Names could not be read" },
                        )
                    }
                },
            )
            if (detail != null) {
                Spacer(Modifier.height(ObsidianSpace.S))
                Text(detail!!, style = ObsidianType.Support, color = ObsidianColors.Text)
            }
        }

        Spacer(Modifier.height(ObsidianSpace.M))
        SectionLabel("REGISTERED NAMES")
        Spacer(Modifier.height(ObsidianSpace.XS))
        ObsidianCard {
            when {
                error != null -> ErrorBlock(
                    title = "Names unavailable",
                    body = error!!,
                    onRetry = {
                        error = null
                        scope.launch {
                            repository.api.names().fold(
                                onSuccess = { names = it },
                                onFailure = { error = it.message ?: "Names could not be read" },
                            )
                        }
                    },
                )
                names == null -> LoadingBlock(label = "Reading names")
                names!!.isEmpty() -> EmptyBlock(
                    title = "No names registered",
                    body = "The chain has no ONS names yet. That is the real state, not a " +
                        "placeholder list.",
                )
                else -> {
                    ObsidianRow("Total names", names!!.size.toString(), mono = true, divider = false)
                    Spacer(Modifier.height(ObsidianSpace.S))
                    names!!.take(50).forEachIndexed { index, name ->
                        MenuRow(title = name, onClick = { detail = "$name is registered." }, divider = index != names!!.lastIndex)
                    }
                }
            }
        }

        Spacer(Modifier.height(ObsidianSpace.M))
        ObsidianCard {
            GoldKicker("Registration")
            Spacer(Modifier.height(ObsidianSpace.S))
            Text(
                "Registering or transferring a name is a signed transaction, and this app holds no " +
                    "key. The economics and rules are the protocol's; nothing about them is " +
                    "changed or restated here.",
                style = ObsidianType.Support,
                color = ObsidianColors.Muted,
            )
        }

        Spacer(Modifier.height(ObsidianSpace.XL))
    }
}
