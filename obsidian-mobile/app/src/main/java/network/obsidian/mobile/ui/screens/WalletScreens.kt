package network.obsidian.mobile.ui.screens

import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import network.obsidian.mobile.identity.ProfileStore
import network.obsidian.mobile.identity.WatchProfile
import network.obsidian.mobile.remote.Addresses
import network.obsidian.mobile.remote.BalanceResponse
import network.obsidian.mobile.remote.ObsidianRepository
import network.obsidian.mobile.ui.ChainValues
import network.obsidian.mobile.ui.components.EmptyBlock
import network.obsidian.mobile.ui.components.ErrorBlock
import network.obsidian.mobile.ui.components.GoldKicker
import network.obsidian.mobile.ui.components.LoadingBlock
import network.obsidian.mobile.ui.components.ObsidianCard
import network.obsidian.mobile.ui.components.ObsidianRow
import network.obsidian.mobile.ui.components.ObsidianTextField
import network.obsidian.mobile.ui.components.PrimaryButton
import network.obsidian.mobile.ui.components.ScreenShell
import network.obsidian.mobile.ui.components.SecondaryButton
import network.obsidian.mobile.ui.components.SectionLabel
import network.obsidian.mobile.ui.theme.ObsidianColors
import network.obsidian.mobile.ui.theme.ObsidianSpace
import network.obsidian.mobile.ui.theme.ObsidianType

/*
 * The wallet is watch-only, and the screens say so.
 *
 * Obsidian's key generation and transaction signing live in the existing wallet
 * tooling. Reimplementing them on a phone would create a second cryptographic
 * authority competing with the protocol's own, which is a security regression
 * rather than a feature. What this app can do without a key is everything that
 * does not need one, and it does that for real: bech32 validation, balance and
 * nonce lookup, transaction retrieval, and displaying an address to receive to.
 *
 * Nothing here claims to have signed anything. A send screen that reported
 * success without a signature would be the worst kind of placeholder.
 */

/** CREATE WALLET / RECOVER WALLET, shared: attach this device to an address. */
@Composable
private fun AttachWalletScreen(
    title: String,
    kicker: String,
    store: ProfileStore,
    onDone: () -> Unit,
    onBack: () -> Unit,
    explanation: String,
) {
    var address by remember { mutableStateOf("") }
    var label by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var done by remember { mutableStateOf(false) }

    ScreenShell(title = title, kicker = kicker, onBack = onBack) {
        ObsidianCard {
            GoldKicker("Where keys live")
            Spacer(Modifier.height(ObsidianSpace.S))
            Text(explanation, style = ObsidianType.Support, color = ObsidianColors.Muted)
        }

        Spacer(Modifier.height(ObsidianSpace.M))
        if (done) {
            ObsidianCard {
                SectionLabel("ATTACHED")
                Spacer(Modifier.height(ObsidianSpace.S))
                ObsidianRow("Address", Addresses.shorten(address), mono = true, divider = false)
            }
            Spacer(Modifier.height(ObsidianSpace.M))
            PrimaryButton(label = "OPEN WALLET", showArrow = false, onClick = onDone)
            return@ScreenShell
        }

        ObsidianCard {
            ObsidianTextField(
                value = label,
                onValueChange = { label = it; error = null },
                label = "Profile label",
                placeholder = "Main wallet",
            )
            Spacer(Modifier.height(ObsidianSpace.M))
            ObsidianTextField(
                value = address,
                onValueChange = { address = it; error = null },
                label = "Obsidian address",
                placeholder = "obs1…",
                error = error,
            )
            Spacer(Modifier.height(ObsidianSpace.XS))
            Text(
                "Validated against the protocol's own bech32 checksum, so an address a node would " +
                    "reject is caught here rather than later.",
                style = ObsidianType.Support,
                color = ObsidianColors.Muted,
            )
            Spacer(Modifier.height(ObsidianSpace.M))
            PrimaryButton(
                label = "ATTACH ADDRESS",
                showArrow = false,
                onClick = {
                    error = null
                    when (val result = store.save(
                        WatchProfile(label, address, null, System.currentTimeMillis()),
                    )) {
                        is ProfileStore.SaveResult.Saved -> done = true
                        is ProfileStore.SaveResult.Rejected -> error = result.reason
                    }
                },
            )
        }
        Spacer(Modifier.height(ObsidianSpace.XL))
    }
}

@Composable
fun CreateWalletScreen(store: ProfileStore, onDone: () -> Unit, onBack: () -> Unit) {
    AttachWalletScreen(
        title = "Create wallet",
        kicker = "Watch profile",
        store = store,
        onDone = onDone,
        onBack = onBack,
        explanation = "Key generation happens in the existing Obsidian wallet tooling, and this app " +
            "does not duplicate it: a second key-derivation path on a phone would compete with the " +
            "protocol's own and would be harder to audit, not easier. What this screen does is " +
            "attach this device to the address that tooling produced, so the wallet here can show " +
            "its real balance and history.",
    )
}

@Composable
fun RecoverWalletScreen(store: ProfileStore, onDone: () -> Unit, onBack: () -> Unit) {
    AttachWalletScreen(
        title = "Recover wallet",
        kicker = "Watch profile",
        store = store,
        onDone = onDone,
        onBack = onBack,
        explanation = "Recovery in Obsidian is cryptographic, not administrative: the key material " +
            "is restored with the tooling that created it, and no server can do it for you. Once " +
            "the address is recovered there, attach it here and this device will follow its real " +
            "on-chain state.",
    )
}

/**
 * WALLET — balance, address, receive and transaction lookup for one address.
 *
 * Every number comes from the node at the moment it is read. There is no cached
 * balance presented as current, and a failed lookup shows the failure rather than
 * the last value that happened to arrive.
 */
@Composable
fun WalletScreen(
    store: ProfileStore,
    repository: ObsidianRepository,
    onBack: () -> Unit,
    onCreateWallet: () -> Unit,
) {
    val clipboard = LocalClipboardManager.current
    val scope = rememberCoroutineScope()
    val profile = remember { store.active() }

    var balance by remember { mutableStateOf<BalanceResponse?>(null) }
    var state by remember { mutableStateOf<Lookup>(Lookup.Idle) }
    var txId by remember { mutableStateOf("") }
    var txResult by remember { mutableStateOf<String?>(null) }
    var txError by remember { mutableStateOf<String?>(null) }
    var txLoading by remember { mutableStateOf(false) }

    ScreenShell(title = "Wallet", kicker = "Watch only", onBack = onBack) {
        if (profile == null) {
            EmptyBlock(
                title = "No wallet attached",
                body = "Attach an address to follow its real balance and history. Keys stay with " +
                    "the tooling that created them.",
            )
            Spacer(Modifier.height(ObsidianSpace.M))
            PrimaryButton(label = "ATTACH ADDRESS", showArrow = false, onClick = onCreateWallet)
            Spacer(Modifier.height(ObsidianSpace.XL))
            return@ScreenShell
        }

        ObsidianCard {
            SectionLabel("BALANCE")
            Spacer(Modifier.height(ObsidianSpace.S))
            when (state) {
                Lookup.Idle, Lookup.Loading -> LoadingBlock(label = "Reading balance")
                Lookup.Failed -> ErrorBlock(
                    title = "Could not read the balance",
                    body = "The node did not answer for this address.",
                    onRetry = { state = Lookup.Idle; loadBalance(scope, repository, profile.address) { r, s -> balance = r; state = s } },
                )
                Lookup.Done -> {
                    Text(
                        "${ChainValues.obs(balance?.balanceObs)} OBS",
                        style = ObsidianType.MonoLarge,
                        color = ObsidianColors.Ink,
                    )
                    Spacer(Modifier.height(ObsidianSpace.S))
                    ObsidianRow("Nonce", (balance?.nonce ?: 0).toString(), mono = true)
                    ObsidianRow("Bonded", ChainValues.obs(balance?.bondedObs), mono = true, divider = false)
                }
            }
            Spacer(Modifier.height(ObsidianSpace.S))
            SecondaryButton(
                label = "REFRESH BALANCE",
                showArrow = false,
                onClick = {
                    state = Lookup.Loading
                    loadBalance(scope, repository, profile.address) { r, s -> balance = r; state = s }
                },
            )
        }

        Spacer(Modifier.height(ObsidianSpace.M))
        SectionLabel("RECEIVE")
        Spacer(Modifier.height(ObsidianSpace.XS))
        ObsidianCard {
            Text(profile.address, style = ObsidianType.Mono, color = ObsidianColors.Text)
            Spacer(Modifier.height(ObsidianSpace.S))
            SecondaryButton(
                label = "COPY ADDRESS",
                showArrow = false,
                onClick = { clipboard.setText(AnnotatedString(profile.address)) },
            )
            Spacer(Modifier.height(ObsidianSpace.XS))
            Text(
                "This address is public chain state. Sharing it lets someone pay you and lets this " +
                    "app follow the result.",
                style = ObsidianType.Support,
                color = ObsidianColors.Muted,
            )
        }

        Spacer(Modifier.height(ObsidianSpace.M))
        SectionLabel("SEND")
        Spacer(Modifier.height(ObsidianSpace.XS))
        ObsidianCard {
            GoldKicker("Watch only")
            Spacer(Modifier.height(ObsidianSpace.S))
            Text(
                "This wallet holds no private key, so it cannot sign a transaction and will not " +
                    "pretend to. Signing happens in the existing Obsidian wallet tooling, which is " +
                    "the protocol's own cryptographic authority. What this app can do is look a " +
                    "transaction up once it exists, so you can confirm it was included.",
                style = ObsidianType.Support,
                color = ObsidianColors.Muted,
            )
        }

        Spacer(Modifier.height(ObsidianSpace.M))
        SectionLabel("TRANSACTION LOOKUP")
        Spacer(Modifier.height(ObsidianSpace.XS))
        ObsidianCard {
            ObsidianTextField(
                value = txId,
                onValueChange = { txId = it; txError = null; txResult = null },
                label = "Transaction id",
                placeholder = "tx hash",
            )
            Spacer(Modifier.height(ObsidianSpace.M))
            PrimaryButton(
                label = "LOOK UP",
                showArrow = false,
                enabled = txId.isNotBlank() && !txLoading,
                onClick = {
                    txLoading = true
                    loadTransaction(scope, repository, txId.trim()) { text, error ->
                        txResult = text
                        txError = error
                        txLoading = false
                    }
                },
            )
            if (txLoading) {
                Spacer(Modifier.height(ObsidianSpace.S))
                LoadingBlock(label = "Asking the node")
            }
            if (txError != null) {
                Spacer(Modifier.height(ObsidianSpace.S))
                ErrorBlock(title = "Not found", body = txError!!)
            }
            if (txResult != null) {
                Spacer(Modifier.height(ObsidianSpace.S))
                Text(txResult!!, style = ObsidianType.Mono, color = ObsidianColors.Text)
            }
        }

        Spacer(Modifier.height(ObsidianSpace.XL))
    }
}

private enum class Lookup { Idle, Loading, Done, Failed }

/**
 * Reads a balance off the main thread.
 *
 * The callback carries both the value and the outcome, because a screen that
 * cannot tell "not yet asked" from "asked and failed" will eventually show a
 * stale number as though it were current.
 */
private fun loadBalance(
    scope: CoroutineScope,
    repository: ObsidianRepository,
    address: String,
    onResult: (BalanceResponse?, Lookup) -> Unit,
) {
    scope.launch {
        repository.api.balance(address).fold(
            onSuccess = { onResult(it, Lookup.Done) },
            onFailure = { onResult(null, Lookup.Failed) },
        )
    }
}

private fun loadTransaction(
    scope: CoroutineScope,
    repository: ObsidianRepository,
    txId: String,
    onResult: (String?, String?) -> Unit,
) {
    scope.launch {
        repository.api.transaction(txId).fold(
            onSuccess = { element ->
                if (element == null) onResult(null, "The node has no transaction with that id.")
                else onResult(element.toString(), null)
            },
            onFailure = { onResult(null, it.message ?: "The node could not be reached.") },
        )
    }
}
